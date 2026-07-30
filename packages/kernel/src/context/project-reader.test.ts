import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProjectFs, ProjectReader, defaultProjectFs } from "./project-reader.js";

/** A ProjectFs spy that counts every real access — the SEC-012 instrument: untrusted reads must
 *  perform ZERO real fs calls. */
function spyFs(seed: {
  dirs?: Record<string, string[]>;
  files?: Record<string, string>;
  versions?: Record<string, string>;
}): ProjectFs & { calls: number } {
  const fs = {
    calls: 0,
    listDir(p: string): string[] {
      fs.calls++;
      return seed.dirs?.[p] ?? [];
    },
    readFile(p: string): string | undefined {
      fs.calls++;
      return seed.files?.[p];
    },
    probeVersion(tool: string): string | undefined {
      fs.calls++;
      return seed.versions?.[tool];
    },
    realpath(p: string): string | undefined {
      fs.calls++;
      return p; // identity realpath for the spy
    },
  };
  return fs;
}

describe("ProjectReader — the single trust-gated project-metadata fs chokepoint (SEC-012)", () => {
  it("untrusted: every read returns empty AND performs zero real fs calls (the guard is structural)", () => {
    const fs = spyFs({ dirs: { "/ws": ["secret.env"] }, files: { "/ws/AGENTS.md": "evil" } });
    const r = new ProjectReader(fs, { trusted: false });

    expect(r.listDir("/ws")).toEqual([]);
    expect(r.readFile("/ws/AGENTS.md")).toBeUndefined();
    expect(r.probeVersion("node")).toBeUndefined();
    expect(r.realpath("/ws")).toBeUndefined();

    expect(fs.calls).toBe(0); // the real fs was NEVER touched before trust
    expect(r.accesses.every((a) => !a.served)).toBe(true);
    expect(r.accesses.map((a) => a.op)).toEqual([
      "listDir",
      "readFile",
      "probeVersion",
      "realpath",
    ]);
  });

  it("trusted: delegates to the real fs and records the reads it served", () => {
    const fs = spyFs({
      dirs: { "/ws": ["src/", "package.json"] },
      files: { "/ws/AGENTS.md": "be kind" },
      versions: { node: "v20.20.1" },
    });
    const r = new ProjectReader(fs, { trusted: true });

    expect(r.listDir("/ws")).toEqual(["src/", "package.json"]);
    expect(r.readFile("/ws/AGENTS.md")).toBe("be kind");
    expect(r.probeVersion("node")).toBe("v20.20.1");
    expect(r.realpath("/ws")).toBe("/ws"); // identity spy → delegates

    expect(fs.calls).toBe(4);
    expect(r.accesses.every((a) => a.served)).toBe(true);
  });

  it("exposes its trust decision", () => {
    expect(new ProjectReader(spyFs({}), { trusted: true }).trusted).toBe(true);
    expect(new ProjectReader(spyFs({}), { trusted: false }).trusted).toBe(false);
  });
});

describe("defaultProjectFs (real fs adapter, fail-soft)", () => {
  it("lists a real dir and reads a real file", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-pr-"));
    writeFileSync(join(dir, "AGENTS.md"), "# rules");
    const fs = defaultProjectFs();
    // fast, deterministic real-fs ops only (no subprocess) — version probing lives in its own test
    // below so this one can never flake on a subprocess spawn under load.
    expect(fs.listDir(dir)).toContain("AGENTS.md");
    expect(fs.readFile(join(dir, "AGENTS.md"))).toBe("# rules");
    expect(fs.realpath(join(dir, "AGENTS.md"))).toContain("AGENTS.md"); // resolves a real path
  });

  it("probeVersion: configurable timeout — 1ms → fail-soft undefined; generous → a real version (de-flaked)", () => {
    // ROOT CAUSE of the intermittent CI failure this fixes: the probe spawned `<tool> --version` with a
    // HARD-CODED 2s timeout. Under heavy parallel load (v8 coverage + the vitest forks pool) a fresh
    // `node` spawn can exceed 2s wall-clock, so `execFileSync` throws → fail-soft `undefined` → the old
    // strict success assertion spuriously failed (`.toMatch` on undefined). The timeout is now injectable.
    // A sub-spawn-time timeout (1ms) is ALWAYS exceeded (process creation ≫ 1ms) → deterministic fail-soft.
    expect(defaultProjectFs({ probeTimeoutMs: 1 }).probeVersion("node")).toBeUndefined();
    // A generous ceiling makes a real `node --version` spawn deterministic even under load (node returns
    // in ~50ms; 60s is never hit) — NOT weakened: still a REAL spawn that must return a real version.
    expect(defaultProjectFs({ probeTimeoutMs: 60_000 }).probeVersion("node")).toMatch(/\d+\.\d+/);
  });

  it("degrades fail-soft: missing dir → [], missing file → undefined, missing tool/path → undefined", () => {
    const fs = defaultProjectFs();
    expect(fs.listDir("/no/such/dir/at/all")).toEqual([]);
    expect(fs.readFile("/no/such/file/at/all")).toBeUndefined();
    expect(fs.probeVersion("keel-nonexistent-tool-xyz")).toBeUndefined();
    expect(fs.realpath("/no/such/path/at/all")).toBeUndefined();
  });
});
