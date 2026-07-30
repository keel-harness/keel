import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestTrajectory, readTrajectory, writeTrajectory } from "./store.js";
import type { TrajectoryT } from "./trajectory.js";

const TRAJ: TrajectoryT = {
  schemaVersion: 1,
  runId: "run_0001",
  task: "tb2-task-01",
  suite: "terminal-bench-2",
  model: "<PINNED_MODEL_ID>",
  startedAt: "2026-06-12T00:00:00.000Z",
  events: [{ type: "message", role: "user", content: "go" }],
  outcome: "resolved",
  totals: { turns: 0, toolCalls: 0, wallClockMs: 0, inputTokens: 0, outputTokens: 0 },
};

let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "keel-traj-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("trajectory store", () => {
  it("persists to a versioned <suite>/<runId>/<task>.json layout and reloads identically", async () => {
    const file = await writeTrajectory(base, TRAJ);
    expect(file.endsWith(join("terminal-bench-2", "run_0001", "tb2-task-01.json"))).toBe(true);
    expect(await readTrajectory(file)).toEqual(TRAJ);
  });

  it("refuses to persist a malformed trajectory (validate before write)", async () => {
    const bad: unknown = { ...TRAJ, schemaVersion: 99 };
    await expect(writeTrajectory(base, bad as TrajectoryT)).rejects.toThrow();
  });

  it("rejects a corrupted trajectory file on read", async () => {
    const file = await writeTrajectory(base, TRAJ);
    await writeFile(file, "{ not valid json", "utf8"); // corrupt the persisted file on disk
    await expect(readTrajectory(file)).rejects.toThrow();
  });

  it("fails closed when a path segment would escape the store root (traversal)", async () => {
    // `suite: ".."` resolves to base's PARENT dir; deep `..` in `task` climbs above base — both escape
    await expect(writeTrajectory(base, { ...TRAJ, suite: ".." })).rejects.toThrow(
      /trajectory store/,
    );
    await expect(writeTrajectory(base, { ...TRAJ, task: "../../../../escape" })).rejects.toThrow(
      /trajectory store/,
    );
  });

  it("rejects in-bounds path separators in segment ids (C: silent-nesting / collision prevention)", async () => {
    // task containing `/` would silently create a nested directory instead of a flat segment
    await expect(writeTrajectory(base, { ...TRAJ, task: "sub/dir/leaf" })).rejects.toThrow(
      /trajectory store/,
    );
    // A pair that differs only by where a `/` falls would collide to the same file path —
    // assert the separator-containing case is rejected rather than silently overwriting
    await expect(writeTrajectory(base, { ...TRAJ, runId: "b/c", task: "x" })).rejects.toThrow(
      /trajectory store/,
    );
    await expect(
      writeTrajectory(base, { ...TRAJ, suite: "a/b", runId: "c", task: "x" }),
    ).rejects.toThrow(/trajectory store/);
  });

  it("rejects control/whitespace characters in segment ids (N: NUL/control-byte prevention)", async () => {
    // A space in a segment id is a whitespace character and must be rejected by the store itself,
    // not silently passed to the syscall.
    await expect(writeTrajectory(base, { ...TRAJ, task: "t x" })).rejects.toThrow(
      /trajectory store/,
    );
    // NUL byte
    await expect(writeTrajectory(base, { ...TRAJ, task: "t\x00x" })).rejects.toThrow(
      /trajectory store/,
    );
    // Tab
    await expect(writeTrajectory(base, { ...TRAJ, runId: "run\t0001" })).rejects.toThrow(
      /trajectory store/,
    );
  });

  it("rejects a symlinked segment that would escape the store root (C: symlink containment)", async () => {
    // Create an outside temp dir that a symlink inside the store would point to.
    const outside = await mkdtemp(join(tmpdir(), "keel-outside-"));
    try {
      let symlinkCreated = false;
      try {
        await symlink(outside, join(base, "evilsuite"));
        symlinkCreated = true;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") {
          // Symlink creation is not permitted on this system (rare CI restriction) — skip.
          console.log(`[store symlink test] skipped — symlink() not permitted (${code})`);
          return;
        }
        throw err;
      }
      if (symlinkCreated) {
        // Writing to `suite: "evilsuite"` must be rejected: the resolved path would land outside
        // the realpath of `base`, violating containment.
        await expect(writeTrajectory(base, { ...TRAJ, suite: "evilsuite" })).rejects.toThrow(
          /trajectory store/,
        );
        // Confirm nothing was written in the outside dir.
        const { readdir } = await import("node:fs/promises");
        const entries = await readdir(outside);
        expect(entries).toHaveLength(0);
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a leaf-file symlink that would escape the store root (C1: leaf containment)", async () => {
    // C1: writeTrajectory previously realpath-checked only directory components, not the leaf file
    // itself. A pre-planted symlink at <base>/<suite>/<runId>/<task>.json pointing outside the store
    // root was FOLLOWED by writeFile, writing trajectory data outside the store. This test proves the
    // fix: the leaf must be lstat-checked and refused when it is a symbolic link.
    const { readFile, stat } = await import("node:fs/promises");

    // Use a unique task name to avoid colliding with the round-trip test's already-written file.
    const leafTraj = { ...TRAJ, task: "leaf-symlink-escape-probe" };

    // Create an outside temp file that the leaf symlink will point to.
    const outsideDir = await mkdtemp(join(tmpdir(), "keel-outside-leaf-"));
    const outsideTarget = join(outsideDir, "stolen.json");
    // Write a sentinel so we can assert it is NOT overwritten.
    await writeFile(outsideTarget, "OUTSIDE_SENTINEL", "utf8");

    try {
      // Plant the parent directories so the leaf symlink path is valid on disk.
      const { mkdir: fsMkdir } = await import("node:fs/promises");
      const leafDir = join(base, leafTraj.suite, leafTraj.runId);
      await fsMkdir(leafDir, { recursive: true });
      const leafPath = join(leafDir, `${leafTraj.task}.json`);

      let symlinkCreated = false;
      try {
        await symlink(outsideTarget, leafPath);
        symlinkCreated = true;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") {
          // Symlink creation is not permitted on this system (rare CI restriction) — skip.
          console.log(`[store leaf-symlink test] skipped — symlink() not permitted (${code})`);
          return;
        }
        throw err;
      }

      if (symlinkCreated) {
        // writeTrajectory must REJECT: the leaf path is a symlink pointing outside the store root.
        await expect(writeTrajectory(base, leafTraj)).rejects.toThrow(/trajectory store/);

        // The outside sentinel file must be UNCHANGED — nothing was written through the symlink.
        const outsideContent = await readFile(outsideTarget, "utf8");
        expect(outsideContent).toBe("OUTSIDE_SENTINEL");

        // The leaf symlink itself must still be a symlink (not replaced by the trajectory data).
        const leafStat = await stat(leafPath); // stat follows symlinks
        expect(leafStat.isFile()).toBe(true); // the target exists (sentinel)
        const { lstat } = await import("node:fs/promises");
        const leafLstat = await lstat(leafPath); // lstat does NOT follow
        expect(leafLstat.isSymbolicLink()).toBe(true); // still a symlink — we didn't write through it
      }
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("SEC-014 / QR-4 — trajectory store redacts secrets at the write chokepoint", () => {
  const KEY = "sk-ant-api03-abcDEF123456789_ghijklmnop-qrstuvwxyz0123456789AA";

  it("a planted API key in a trajectory never reaches the persisted file (and stays valid JSON)", async () => {
    const planted: TrajectoryT = {
      ...TRAJ,
      runId: "redaction-probe",
      events: [
        { type: "message", role: "user", content: "run env" },
        // A TB-2 container has ANTHROPIC_API_KEY in its env; a tool that echoes the env would leak it
        // into the trajectory. The store must redact it before it lands on the host.
        { type: "tool-result", id: "call_1", ok: true, content: `ANTHROPIC_API_KEY=${KEY}` },
      ],
    };
    const file = await writeTrajectory(base, planted);
    const raw = await readFile(file, "utf8");
    // The raw bytes on disk contain the key NOWHERE, but an honest marker is present.
    expect(raw).not.toContain(KEY);
    expect(raw).toContain("[redacted:anthropic-key]");
    // The redacted file is still valid, reloadable JSON with the marker in place of the key.
    const reloaded = await readTrajectory(file);
    const toolResult = reloaded.events.find((e) => e.type === "tool-result");
    expect(toolResult).toBeDefined();
    expect(JSON.stringify(reloaded)).not.toContain(KEY);
    expect((toolResult as { content: string }).content).toContain("[redacted:anthropic-key]");
  });

  it("preserves faithful high-entropy task content (entropyNet:false — the §2.3 analysis substrate)", async () => {
    // A secret-themed TB-2 task (e.g. crack-7z-hash) legitimately surfaces a long high-entropy blob in
    // its tool output. The trajectory store must NOT corrupt it (the loop analyzes it) — while STILL
    // redacting the host's known-format ANTHROPIC_API_KEY in the same trajectory.
    const hash = "Zx9Kp2Lm7Qw4Nv8Rt3Yb6Hc1Jf5Gd0Sa2We4Tr6Uy8Io0Pl3aB7cD"; // 54-char artifact-like blob
    const planted: TrajectoryT = {
      ...TRAJ,
      runId: "fidelity-probe",
      events: [
        { type: "tool-result", id: "c1", ok: true, content: `recovered hash: ${hash}` },
        { type: "tool-result", id: "c2", ok: true, content: `env: ANTHROPIC_API_KEY=${KEY}` },
      ],
    };
    const file = await writeTrajectory(base, planted);
    const reloaded = await readTrajectory(file);
    const hashEvt = reloaded.events.find(
      (e) => e.type === "tool-result" && e.content.includes("hash"),
    );
    // faithful task content preserved (not corrupted into [redacted:high-entropy])
    expect((hashEvt as { content: string }).content).toContain(hash);
    // host credential still redacted (the format catalog runs regardless of the entropy net)
    expect(JSON.stringify(reloaded)).not.toContain(KEY);
    expect(JSON.stringify(reloaded)).toContain("[redacted:anthropic-key]");
  });

  it("a clean trajectory round-trips unchanged (redaction is a no-op on non-secret content)", async () => {
    const file = await writeTrajectory(base, { ...TRAJ, runId: "clean-roundtrip" });
    expect(await readTrajectory(file)).toEqual({ ...TRAJ, runId: "clean-roundtrip" });
  });

  it("F1 integrity: a secret abutting an escaped newline stays valid JSON (no split escape)", async () => {
    // structured-redaction regression: redacting an already-serialized line split a JSON escape at a secret abutting `\n`,
    // producing a line a strict parser silently drops. Redacting the value before serialize is safe.
    const planted: TrajectoryT = {
      ...TRAJ,
      runId: "f1-escape-probe",
      events: [
        // a key directly after a newline (the escape boundary), repeated across many "grep hits"
        {
          type: "tool-result",
          id: "c1",
          ok: true,
          content: Array.from({ length: 50 }, () => `hit:\n${KEY}`).join(""),
        },
      ],
    };
    const file = await writeTrajectory(base, planted);
    const raw = await readFile(file, "utf8");
    // the whole file parses under a strict parser, and the key is gone
    expect(() => {
      JSON.parse(raw);
    }).not.toThrow();
    expect(raw).not.toContain(KEY);
    expect(raw).toContain("[redacted:anthropic-key]");
  });

  it("ingestTrajectory validates raw container JSON and redacts on write (host-side ingest)", async () => {
    const planted: TrajectoryT = {
      ...TRAJ,
      runId: "ingest-probe",
      events: [{ type: "tool-result", id: "c1", ok: true, content: `key=${KEY}` }],
    };
    const file = await ingestTrajectory(base, JSON.stringify(planted));
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain(KEY);
    expect(raw).toContain("[redacted:anthropic-key]");
  });

  it("ingestTrajectory rejects non-JSON container output with a clear error", async () => {
    await expect(ingestTrajectory(base, "not json at all")).rejects.toThrow(/not valid JSON/);
  });

  it("ingestTrajectory rejects a structurally-invalid trajectory (schema validation)", async () => {
    await expect(ingestTrajectory(base, JSON.stringify({ schemaVersion: 99 }))).rejects.toThrow();
  });
});
