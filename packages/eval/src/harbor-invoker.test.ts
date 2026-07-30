import { fileURLToPath } from "node:url";
import type { Dirent } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HarborParseError,
  buildHarborRunArgs,
  defaultHarborSpawn,
  makeHarborInvoker,
  parseHarborJobDir,
  parseHarborTrialDir,
  readTrialMatrixStats,
} from "./harbor-invoker.js";
import type { HarborRunOpts } from "./harbor-invoker.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/harbor-job", import.meta.url));

const OPTS: HarborRunOpts = {
  dataset: "terminal-bench/terminal-bench-2-1",
  agentImportPath: "keel_harbor_agent.agent:KeelAgent",
  model: "anthropic/claude-sonnet-4-6",
  taskNames: ["terminal-bench/build-cython-ext", "terminal-bench/cobol-modernization"],
  binaryUrl: "http://host.docker.internal:8077/keel-linux-x64",
  binarySha256: "a".repeat(64),
  maxTokens: 150_000,
  jobName: "benchmark-run-1",
};

const EVAL_DIRECT_EXEC_ACK =
  "KEEL_EVAL_DIRECT_EXEC=i-understand-this-disables-the-warden-eval-only";

describe("buildHarborRunArgs — the `harbor run` argv (pure)", () => {
  it("builds dataset/agent/model + one -i per task + the keel --ae env", () => {
    const args = buildHarborRunArgs(OPTS);
    expect(args[0]).toBe("run");
    expect(args).toEqual(
      expect.arrayContaining(["--dataset", "terminal-bench/terminal-bench-2-1"]),
    );
    expect(args).toEqual(
      expect.arrayContaining(["--agent-import-path", "keel_harbor_agent.agent:KeelAgent"]),
    );
    expect(args).toEqual(expect.arrayContaining(["-m", "anthropic/claude-sonnet-4-6"]));
    // one -i per task, prefixed names preserved
    expect(args).toEqual(expect.arrayContaining(["-i", "terminal-bench/build-cython-ext"]));
    expect(args).toEqual(expect.arrayContaining(["-i", "terminal-bench/cobol-modernization"]));
    // the three keel env vars forwarded via --ae
    expect(args).toEqual(expect.arrayContaining(["--ae", "KEEL_MAX_TOKENS=150000"]));
    expect(args).toEqual(
      expect.arrayContaining([
        "--ae",
        "KEEL_BINARY_URL=http://host.docker.internal:8077/keel-linux-x64",
      ]),
    );
    expect(args).toEqual(expect.arrayContaining(["--ae", `KEEL_BINARY_SHA256=${"a".repeat(64)}`]));
    // KEEL_HOME defaults to a path Harbor SYNCS back (under /logs/agent) so the ledger reaches the host
    expect(args).toEqual(expect.arrayContaining(["--ae", "KEEL_HOME=/logs/agent/keelhome"]));
    // non-interactive, one attempt, one container at a time, predictable job dir
    expect(args).toContain("-y");
    expect(args).toEqual(expect.arrayContaining(["-k", "1"]));
    expect(args).toEqual(expect.arrayContaining(["-n", "1"]));
    expect(args).toEqual(expect.arrayContaining(["--job-name", "benchmark-run-1"]));
  });

  it("emits KEEL_MAX_GROSS_TOKENS / KEEL_MAX_OUTPUT_TOKENS only when set (matrix variants B/C)", () => {
    // unset → neither appears (a plain run is byte-identical to before)
    const a = buildHarborRunArgs(OPTS);
    expect(a.join(" ")).not.toMatch(/KEEL_MAX_GROSS_TOKENS|KEEL_MAX_OUTPUT_TOKENS/);
    // set → each rides its own --ae pair
    const bc = buildHarborRunArgs({ ...OPTS, maxGrossTokens: 1_200_000, maxOutputTokens: 80_000 });
    expect(bc).toEqual(expect.arrayContaining(["--ae", "KEEL_MAX_GROSS_TOKENS=1200000"]));
    expect(bc).toEqual(expect.arrayContaining(["--ae", "KEEL_MAX_OUTPUT_TOKENS=80000"]));
  });

  // OPTS minus KEEL_MAX_TOKENS (the gross-only / uncapped shapes — `maxTokens` is now optional).
  const grossOnly = (extra: Partial<HarborRunOpts>): HarborRunOpts => ({
    dataset: OPTS.dataset,
    agentImportPath: OPTS.agentImportPath,
    model: OPTS.model,
    taskNames: OPTS.taskNames,
    binaryUrl: OPTS.binaryUrl,
    binarySha256: OPTS.binarySha256,
    jobName: OPTS.jobName,
    ...extra,
  });

  it("variant A (gross-only): emits KEEL_MAX_GROSS_TOKENS and does NOT emit KEEL_MAX_TOKENS", () => {
    // The raw control: KEEL_MAX_TOKENS (effective) is omitted, so the binary caps on raw input+output
    // with no cache discount. This is the fix for the A-is-not-actually-a-raw-baseline bug.
    const args = buildHarborRunArgs(grossOnly({ maxGrossTokens: 400_000 }));
    expect(args).toEqual(expect.arrayContaining(["--ae", "KEEL_MAX_GROSS_TOKENS=400000"]));
    expect(args.join(" ")).not.toMatch(/KEEL_MAX_TOKENS=/);
  });

  it("refuses an UNCAPPED run (neither effective nor gross cap) — fail-closed money-safety", () => {
    expect(() => buildHarborRunArgs(grossOnly({}))).toThrow(/uncapped/i);
  });

  it("refuses malformed binary provenance before constructing Harbor argv", () => {
    for (const binarySha256 of ["", "A".repeat(64), "a".repeat(63), `${"a".repeat(63)}g`]) {
      expect(() => buildHarborRunArgs({ ...OPTS, binarySha256 })).toThrow(
        /binary sha-256.*64 lowercase hexadecimal/i,
      );
    }
  });

  it("emits the KEEL_COMPACTION arm env only when set (Epic 1.6c compaction ablation arm)", () => {
    // compaction-OFF arm (the default): no compaction env — byte-identical to the prior argv
    expect(buildHarborRunArgs(OPTS).join(" ")).not.toMatch(/KEEL_COMPACTION/);
    // compaction-ON arm: KEEL_COMPACTION=1 + the optional context-window/recent knobs ride --ae pairs
    const on = buildHarborRunArgs({
      ...OPTS,
      compaction: true,
      contextWindow: 200_000,
      compactionRecent: 6,
    });
    expect(on).toEqual(expect.arrayContaining(["--ae", "KEEL_COMPACTION=1"]));
    expect(on).toEqual(expect.arrayContaining(["--ae", "KEEL_CONTEXT_WINDOW=200000"]));
    expect(on).toEqual(expect.arrayContaining(["--ae", "KEEL_COMPACTION_RECENT=6"]));
    // compaction:true with the knobs omitted → only the toggle (kernel defaults apply)
    const onDefault = buildHarborRunArgs({ ...OPTS, compaction: true });
    expect(onDefault).toEqual(expect.arrayContaining(["--ae", "KEEL_COMPACTION=1"]));
    expect(onDefault.join(" ")).not.toMatch(/KEEL_CONTEXT_WINDOW|KEEL_COMPACTION_RECENT/);
  });

  it("emits KEEL_MAX_TURNS only when set (the shared matrix turn cap, ER-038)", () => {
    // unset → no turn-cap env (a plain run is byte-identical to before)
    expect(buildHarborRunArgs(OPTS).join(" ")).not.toMatch(/KEEL_MAX_TURNS/);
    // set → rides its own --ae pair so the in-container loop can raise the turn cap
    expect(buildHarborRunArgs({ ...OPTS, maxTurns: 120 })).toEqual(
      expect.arrayContaining(["--ae", "KEEL_MAX_TURNS=120"]),
    );
  });

  it("emits reviewed interactive-console product config only when explicitly supplied", () => {
    expect(buildHarborRunArgs(OPTS).join(" ")).not.toMatch(/KEEL_WARDEN_INTERACTIVE_CONSOLE/);
    expect(buildHarborRunArgs(OPTS).join(" ")).not.toMatch(/KEEL_WARDEN_SANDBOX=srt/);
    expect(buildHarborRunArgs(OPTS).join(" ")).not.toMatch(/KEEL_EVAL_DIRECT_EXEC/);

    const withConsole = buildHarborRunArgs({
      ...OPTS,
      interactiveConsoleConfigB64: "eyJiYWNrZW5kIjp7fX0=",
    });
    expect(withConsole).toEqual(expect.arrayContaining(["--ae", "KEEL_WARDEN_SANDBOX=srt"]));
    expect(withConsole).toEqual(expect.arrayContaining(["--ae", EVAL_DIRECT_EXEC_ACK]));
    expect(withConsole).toEqual(
      expect.arrayContaining([
        "--ae",
        "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64=eyJiYWNrZW5kIjp7fX0=",
      ]),
    );
    expect(withConsole.join(" ")).not.toMatch(/KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG=/);

    expect(() =>
      buildHarborRunArgs({
        ...OPTS,
        interactiveConsoleConfig: "{}",
        interactiveConsoleConfigB64: "e30=",
      }),
    ).toThrow(/set only one interactive console config/u);
  });

  it("emits parent-reviewed interactive-console grant env only for eligible singleton QEMU batches", () => {
    expect(() =>
      buildHarborRunArgs({
        ...OPTS,
        interactiveConsoleGrantB64: "eyJncmFudCI6dHJ1ZX0=",
      }),
    ).toThrow(/interactive console grant requires interactive console config/u);

    expect(() =>
      buildHarborRunArgs({
        ...OPTS,
        interactiveConsoleConfigB64: "eyJiYWNrZW5kIjp7fX0=",
        interactiveConsoleGrantB64: "eyJncmFudCI6dHJ1ZX0=",
      }),
    ).toThrow(/interactive console grant requires terminal-bench QEMU singleton eligibility/u);

    expect(() =>
      buildHarborRunArgs({
        ...OPTS,
        taskNames: ["terminal-bench/build-cython-ext", "terminal-bench/qemu-startup"],
        interactiveConsoleConfigB64: "eyJiYWNrZW5kIjp7fX0=",
        interactiveConsoleGrantB64: "eyJncmFudCI6dHJ1ZX0=",
        interactiveConsoleGrantEligibility: {
          kind: "terminal-bench-qemu-singleton",
          taskName: "qemu-startup",
        },
      }),
    ).toThrow(/interactive console grant requires a singleton QEMU task batch/u);

    expect(() =>
      buildHarborRunArgs({
        ...OPTS,
        taskNames: ["terminal-bench/build-cython-ext"],
        interactiveConsoleConfigB64: "eyJiYWNrZW5kIjp7fX0=",
        interactiveConsoleGrantB64: "eyJncmFudCI6dHJ1ZX0=",
        interactiveConsoleGrantEligibility: {
          kind: "terminal-bench-qemu-singleton",
          taskName: "qemu-startup",
        },
      }),
    ).toThrow(/interactive console grant eligibility does not match task/u);

    expect(() =>
      buildHarborRunArgs({
        ...OPTS,
        taskNames: ["terminal-bench/qemu-startup"],
        nAttempts: 2,
        interactiveConsoleConfigB64: "eyJiYWNrZW5kIjp7fX0=",
        interactiveConsoleGrantB64: "eyJncmFudCI6dHJ1ZX0=",
        interactiveConsoleGrantEligibility: {
          kind: "terminal-bench-qemu-singleton",
          taskName: "qemu-startup",
        },
      }),
    ).toThrow(/interactive console grant requires exactly one attempt/u);

    const withGrant = buildHarborRunArgs({
      ...OPTS,
      taskNames: ["terminal-bench/qemu-startup"],
      interactiveConsoleConfigB64: "eyJiYWNrZW5kIjp7fX0=",
      interactiveConsoleGrantB64: "eyJncmFudCI6dHJ1ZX0=",
      interactiveConsoleSessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      interactiveConsoleGrantEligibility: {
        kind: "terminal-bench-qemu-singleton",
        taskName: "qemu-startup",
      },
    });
    expect(withGrant).toEqual(expect.arrayContaining(["--ae", "KEEL_WARDEN_SANDBOX=srt"]));
    expect(withGrant).toEqual(
      expect.arrayContaining([
        "--ae",
        "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64=eyJiYWNrZW5kIjp7fX0=",
      ]),
    );
    expect(withGrant).toEqual(
      expect.arrayContaining([
        "--ae",
        "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64=eyJncmFudCI6dHJ1ZX0=",
      ]),
    );
    expect(withGrant).toEqual(
      expect.arrayContaining(["--ae", "KEEL_RUN_SESSION_ID=ses_01ARZ3NDEKTSV4RRFFQ69G5FAV"]),
    );
    expect(withGrant).toEqual(expect.arrayContaining(["--ae", "HOME=/logs/agent"]));
    expect(withGrant).toEqual(expect.arrayContaining(["--ae", EVAL_DIRECT_EXEC_ACK]));
  });

  it("requires a valid pinned run session id whenever a parent-reviewed console grant is emitted", () => {
    expect(() =>
      buildHarborRunArgs({
        ...OPTS,
        taskNames: ["terminal-bench/qemu-startup"],
        interactiveConsoleConfigB64: "eyJiYWNrZW5kIjp7fX0=",
        interactiveConsoleGrantB64: "eyJncmFudCI6dHJ1ZX0=",
        interactiveConsoleGrantEligibility: {
          kind: "terminal-bench-qemu-singleton",
          taskName: "qemu-startup",
        },
      }),
    ).toThrow(/interactive console grant requires KEEL_RUN_SESSION_ID/u);

    expect(() =>
      buildHarborRunArgs({
        ...OPTS,
        taskNames: ["terminal-bench/qemu-startup"],
        interactiveConsoleConfigB64: "eyJiYWNrZW5kIjp7fX0=",
        interactiveConsoleGrantB64: "eyJncmFudCI6dHJ1ZX0=",
        interactiveConsoleSessionId: "not-a-session-id",
        interactiveConsoleGrantEligibility: {
          kind: "terminal-bench-qemu-singleton",
          taskName: "qemu-startup",
        },
      }),
    ).toThrow(/interactive console session id must be ses_<ULID>/u);
  });

  it("emits pre-stop verification env only when explicitly configured", () => {
    expect(buildHarborRunArgs(OPTS).join(" ")).not.toMatch(/KEEL_PRESTOP_CHECK|KEEL_VERIFY=1/);

    const args = buildHarborRunArgs({
      ...OPTS,
      preStopCheckCommand: "python -m pytest -q",
      preStopCheckTimeoutMs: 300_000,
      preStopCheckMaxOutputBytes: 8192,
    });
    expect(args).toEqual(expect.arrayContaining(["--ae", "KEEL_VERIFY=1"]));
    expect(args).toEqual(expect.arrayContaining(["--ae", "KEEL_VERIFY_MODE=prestop"]));
    expect(args).toEqual(
      expect.arrayContaining(["--ae", "KEEL_PRESTOP_CHECK_CMD=python -m pytest -q"]),
    );
    expect(args).toEqual(expect.arrayContaining(["--ae", "KEEL_PRESTOP_CHECK_TIMEOUT_MS=300000"]));
    expect(args).toEqual(
      expect.arrayContaining(["--ae", "KEEL_PRESTOP_CHECK_MAX_OUTPUT_BYTES=8192"]),
    );
  });

  it("a turn cap alone is NOT a money cap — still refuses an uncapped (no-token) run", () => {
    // The turn cap bounds runway, not dollars; the money-safety refusal must still require a token cap.
    expect(() => buildHarborRunArgs(grossOnly({ maxTurns: 120 }))).toThrow(/uncapped/i);
  });

  it("honors explicit KEEL_HOME / concurrency / attempts / jobsDir overrides", () => {
    const args = buildHarborRunArgs({
      ...OPTS,
      keelHome: "/logs/agent/kh",
      nConcurrent: 2,
      nAttempts: 3,
      jobsDir: "/abs/jobs",
    });
    expect(args).toEqual(expect.arrayContaining(["--ae", "KEEL_HOME=/logs/agent/kh"]));
    expect(args).toEqual(expect.arrayContaining(["-n", "2"]));
    expect(args).toEqual(expect.arrayContaining(["-k", "3"]));
    expect(args).toEqual(expect.arrayContaining(["--jobs-dir", "/abs/jobs"]));
  });
});

describe("parseHarborTrialDir — one trial dir → outcome", () => {
  it("reads the BARE task id, resolves from reward.txt, and pulls usage from the synced ledger", async () => {
    const o = await parseHarborTrialDir(join(FIXTURE, "build-cython-ext__EQQgwvi"));
    expect(o.taskId).toBe("build-cython-ext"); // org prefix stripped (task_id.name)
    expect(o.resolved).toBe(false); // reward.txt = 0
    expect(o.usage).toEqual({ inputTokens: 138_000, outputTokens: 13_000 });
    expect(o.trial).toBe("build-cython-ext__EQQgwvi");
  });

  it("marks a reward>0 trial resolved", async () => {
    const o = await parseHarborTrialDir(join(FIXTURE, "demo-solved__SYNTH01"));
    expect(o.taskId).toBe("demo-solved");
    expect(o.resolved).toBe(true);
    expect(o.usage).toEqual({ inputTokens: 42_000, outputTokens: 3_500 });
  });

  it("fails closed when a trial has no synced ledger (unknown cost must not be silently $0)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keel-noledger-"));
    try {
      await mkdir(join(dir, "verifier"), { recursive: true });
      await writeFile(
        join(dir, "result.json"),
        JSON.stringify({ task_id: { name: "x" }, trial_name: "x__t" }),
      );
      await writeFile(join(dir, "verifier", "reward.txt"), "0");
      await expect(parseHarborTrialDir(dir)).rejects.toBeInstanceOf(HarborParseError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on a missing result.json, missing reward.txt, or non-numeric reward", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keel-trial-"));
    try {
      // missing result.json
      await expect(parseHarborTrialDir(dir)).rejects.toThrow(/missing result\.json/);
      // result present, reward.txt missing
      await writeFile(
        join(dir, "result.json"),
        JSON.stringify({ task_id: { name: "x" }, trial_name: "x__t" }),
      );
      await expect(parseHarborTrialDir(dir)).rejects.toThrow(/reward\.txt/);
      // non-numeric reward
      await mkdir(join(dir, "verifier"), { recursive: true });
      await writeFile(join(dir, "verifier", "reward.txt"), "not-a-number");
      await expect(parseHarborTrialDir(dir)).rejects.toThrow(/non-numeric reward/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a torn ledger line and still finds the run_status usage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keel-torn-"));
    try {
      await mkdir(join(dir, "verifier"), { recursive: true });
      await mkdir(join(dir, "agent", "keelhome", "sessions"), { recursive: true });
      await writeFile(
        join(dir, "result.json"),
        JSON.stringify({ task_id: { name: "x" }, trial_name: "x__t" }),
      );
      await writeFile(join(dir, "verifier", "reward.txt"), "0");
      await writeFile(
        join(dir, "agent", "keelhome", "sessions", "ses_x.jsonl"),
        `{ this is not valid json\n{"type":"run_status","usage":{"inputTokens":7,"outputTokens":2}}\n`,
      );
      const o = await parseHarborTrialDir(dir);
      expect(o.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sums bounded-loop run_status deltas instead of treating the final zero delta as total usage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keel-loop-usage-"));
    try {
      await mkdir(join(dir, "verifier"), { recursive: true });
      await mkdir(join(dir, "agent", "keelhome", "sessions"), { recursive: true });
      await writeFile(
        join(dir, "result.json"),
        JSON.stringify({ task_id: { name: "x" }, trial_name: "x__t" }),
      );
      await writeFile(join(dir, "verifier", "reward.txt"), "0");
      await writeFile(
        join(dir, "agent", "keelhome", "sessions", "ses_x.jsonl"),
        [
          `{"type":"run_status","reason":"model-stop","usage":{"inputTokens":40,"outputTokens":1}}`,
          `{"type":"run_status","reason":"model-stop","usage":{"inputTokens":20,"outputTokens":2,"cachedInputTokens":10,"cacheCreationInputTokens":1}}`,
          `{"type":"run_status","reason":"budget","usage":{"inputTokens":0,"outputTokens":0}}`,
        ].join("\n"),
      );
      const o = await parseHarborTrialDir(dir);
      expect(o.usage).toEqual({
        inputTokens: 60,
        outputTokens: 3,
        cachedInputTokens: 10,
        cacheCreationInputTokens: 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseHarborJobDir — the whole job → outcomes", () => {
  it("parses every trial dir (ground truth), skipping non-trial entries", async () => {
    const out = await parseHarborJobDir(FIXTURE);
    expect(out.tasks).toHaveLength(2);
    const byId = Object.fromEntries(out.tasks.map((t) => [t.taskId, t]));
    expect(byId["build-cython-ext"]?.resolved).toBe(false);
    expect(byId["demo-solved"]?.resolved).toBe(true);
  });

  it("returns trials in deterministic (sorted-by-dir-name) order regardless of readdir order (EVAL-3)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keel-jobord-"));
    try {
      // Create trial dirs in reverse-alpha order; the persisted `tasks[]` must come back sorted so the
      // committed artifact is byte-reproducible across filesystems (not filesystem-readdir-dependent).
      for (const name of ["trial-c", "trial-a", "trial-b"]) {
        await mkdir(join(dir, name, "verifier"), { recursive: true });
        await mkdir(join(dir, name, "agent", "keelhome", "sessions"), { recursive: true });
        await writeFile(
          join(dir, name, "result.json"),
          JSON.stringify({ task_id: { name }, trial_name: `${name}__t` }),
        );
        await writeFile(join(dir, name, "verifier", "reward.txt"), "0");
        await writeFile(
          join(dir, name, "agent", "keelhome", "sessions", "ses.jsonl"),
          `{"type":"run_status","ts":"2026-06-17T00:00:10.000Z","reason":"budget","usage":{"inputTokens":10,"outputTokens":1}}`,
        );
      }
      // Inject a readdir that yields the entries in REVERSE order, so the assertion proves the parser
      // sorts — not that the filesystem happened to return them sorted (which masked this on APFS).
      const reversedReaddir = async (p: string): Promise<Dirent[]> =>
        [...(await fsPromises.readdir(p, { withFileTypes: true }))].reverse();
      const out = await parseHarborJobDir(dir, reversedReaddir);
      expect(out.tasks.map((t) => t.taskId)).toEqual(["trial-a", "trial-b", "trial-c"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips non-trial entries (files + dirs without result.json) and fails closed on an empty job", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keel-job-"));
    try {
      await writeFile(join(dir, "job.log"), "noise"); // a file → skipped
      await mkdir(join(dir, "not-a-trial"), { recursive: true }); // a dir without result.json → skipped
      await expect(parseHarborJobDir(dir)).rejects.toThrow(/no trial dirs/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("readTrialMatrixStats — instrumentation from the synced ledger (ER-038)", () => {
  async function ledgerTrial(lines: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "keel-mstats-"));
    await mkdir(join(dir, "agent", "keelhome", "sessions"), { recursive: true });
    await writeFile(join(dir, "agent", "keelhome", "sessions", "ses.jsonl"), lines);
    return dir;
  }

  it("reads cached tokens + the stop reason + counts turns/toolCalls/wallTime", async () => {
    const dir = await ledgerTrial(
      [
        `{"type":"user","ts":"2026-06-17T00:00:00.000Z","content":"go"}`,
        `{"type":"assistant","ts":"2026-06-17T00:00:05.000Z","toolCalls":[{"id":"a"},{"id":"b"}]}`,
        `{"type":"tool_result","ts":"2026-06-17T00:00:06.000Z"}`,
        `{"type":"assistant","ts":"2026-06-17T00:00:09.000Z","toolCalls":[{"id":"c"}]}`,
        `{"type":"run_status","ts":"2026-06-17T00:00:10.000Z","reason":"budget","usage":{"inputTokens":405000,"outputTokens":5000,"cachedInputTokens":380000}}`,
      ].join("\n"),
    );
    try {
      const s = await readTrialMatrixStats(dir);
      expect(s.usage).toEqual({
        inputTokens: 405000,
        outputTokens: 5000,
        cachedInputTokens: 380000,
      });
      expect(s.reason).toBe("budget");
      expect(s.turns).toBe(2); // two assistant events
      expect(s.toolCalls).toBe(3); // 2 + 1 tool calls
      expect(s.wallTimeMs).toBe(10_000); // 00:00:10 − 00:00:00
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sums bounded-loop usage deltas while retaining the final stop reason", async () => {
    const dir = await ledgerTrial(
      [
        `{"type":"run_status","ts":"2026-06-17T00:00:01.000Z","reason":"model-stop","usage":{"inputTokens":40,"outputTokens":1}}`,
        `{"type":"run_status","ts":"2026-06-17T00:00:02.000Z","reason":"model-stop","usage":{"inputTokens":20,"outputTokens":2}}`,
        `{"type":"run_status","ts":"2026-06-17T00:00:03.000Z","reason":"budget","usage":{"inputTokens":0,"outputTokens":0}}`,
      ].join("\n"),
    );
    try {
      const s = await readTrialMatrixStats(dir);
      expect(s.usage).toEqual({
        inputTokens: 60,
        outputTokens: 3,
      });
      expect(s.reason).toBe("budget");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("NEVER throws on a missing ledger — returns zero usage + null reason so the runner can class it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keel-mstats-empty-"));
    try {
      const s = await readTrialMatrixStats(dir);
      expect(s.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(s.reason).toBeNull();
      expect(s.turns).toBe(0);
      expect(s.wallTimeMs).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("makeHarborInvoker — spawn (injected) → parse the job dir", () => {
  it("runs the built args via the injected spawn, then parses the resulting job dir", async () => {
    // jobsDir/jobName resolves to the fixture dir; a fake spawn stands in for the real `harbor run`.
    const spawn = vi.fn(async (_args: readonly string[]): Promise<void> => undefined);
    const invoker = makeHarborInvoker(
      {
        ...OPTS,
        jobsDir: fileURLToPath(new URL("./__fixtures__", import.meta.url)),
        jobName: "harbor-job",
      },
      spawn,
    );
    const out = await invoker();
    expect(spawn).toHaveBeenCalledTimes(1);
    // the spawn received the built argv (contains the dataset + a task -i)
    expect(spawn.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(["run", "--dataset"]));
    expect(out.tasks).toHaveLength(2);
  });
});

describe("defaultHarborSpawn — the subprocess edge (against true/false)", () => {
  it("resolves when the process exits 0", async () => {
    await expect(defaultHarborSpawn(undefined, "true")([])).resolves.toBeUndefined();
  });
  it("rejects with a non-zero exit code", async () => {
    await expect(defaultHarborSpawn(undefined, "false")([])).rejects.toThrow(/exited 1/);
  });
  it("rejects when the binary cannot be spawned", async () => {
    await expect(
      defaultHarborSpawn(undefined, "keel-no-such-binary-xyz")([]),
    ).rejects.toBeInstanceOf(Error);
  });
});
