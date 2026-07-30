import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultEvalConfig } from "./config.default.js";
import type { TokenPricing } from "./cost-cap.js";
import type { MatrixTrialStats } from "./harbor-invoker.js";
import { DEFAULT_MATRIX_VARIANTS, readMatrixRun, type MatrixVariant } from "./matrix.js";
import type { GuardedBenchmarkRequest } from "./runner.js";
import {
  defaultBatchExecutor,
  dryRunMatrix,
  estimateBatchUB,
  estimateMatchesGuard,
  parseJobDirMatrixRecords,
  planMatrix,
  runMatrix,
  worstCaseTokenCap,
  type MatrixRunnerConfig,
} from "./matrix-runner.js";

// Sonnet 4.6 — cacheReadPerMTok 0.30 = 0.1× input, consistent with cacheReadWeight 0.1 (Epic 1.14
// price↔weight guard; an inconsistent pair makes planMatrix fail closed).
const PRICING: TokenPricing = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 };
const TASKS = Array.from({ length: 9 }, (_, i) => `terminal-bench/task-${String(i)}`);
const variant = (id: "A" | "B" | "C") => DEFAULT_MATRIX_VARIANTS.find((v) => v.id === id)!;

function cfg(over: Partial<MatrixRunnerConfig> = {}): MatrixRunnerConfig {
  return {
    variants: DEFAULT_MATRIX_VARIANTS,
    taskNames: TASKS,
    subset: "matrix-test", // a custom (non-pinned) subset → unconstrained by the EVAL-1 binding
    model: "anthropic/claude-sonnet-4-6",
    suite: "terminal-bench-2",
    cacheReadWeight: 0.1,
    dataset: "terminal-bench/terminal-bench-2-1",
    agentImportPath: "keel_harbor_agent.agent:KeelAgent",
    binaryUrl: "http://host.docker.internal:8077/keel-linux-x64",
    binarySha256: "b".repeat(64),
    jobsDir: "/abs/jobs",
    outDir: "/abs/out",
    pricing: PRICING,
    perRunUSD: 25,
    ranAt: "2026-06-17T00:00:00.000Z",
    ...over,
  };
}

describe("estimateBatchUB — matches the guard's own UB formula", () => {
  it("computes the documented per-task UBs (A 400k → $3.12 · B/C gross 1.2M → $9.36)", () => {
    expect(estimateBatchUB(400_000, 1, PRICING)).toBeCloseTo(3.12, 2);
    expect(estimateBatchUB(1_200_000, 1, PRICING)).toBeCloseTo(9.36, 2);
  });
  it("equals estimateBenchmarkCostUB for the same inputs (preflight never under-estimates the guard)", () => {
    const req: GuardedBenchmarkRequest = {
      config: defaultEvalConfig,
      ledgerPath: "/x",
      descriptor: { runId: "r", suite: "s", model: "m" },
      taskIds: ["t1", "t2"],
      perTaskTokenCap: 1_200_000,
      pricing: PRICING,
    };
    expect(estimateMatchesGuard(req)).toBe(true);
  });
});

describe("worstCaseTokenCap — the gross bound used for the estimate", () => {
  it("uses the gross backstop when set, else the effective cap; throws on no token cap", () => {
    expect(worstCaseTokenCap({ maxGrossTokens: 400_000 })).toBe(400_000); // A
    expect(worstCaseTokenCap({ maxTokens: 400_000, maxGrossTokens: 1_200_000 })).toBe(1_200_000); // B/C
    expect(worstCaseTokenCap({ maxTokens: 400_000 })).toBe(400_000);
    expect(() => worstCaseTokenCap({ maxOutputTokens: 80_000 })).toThrow(/no token cap/i);
  });
});

describe("planMatrix — variant expansion + batch planning + preflight", () => {
  it("expands all three variants", () => {
    const plan = planMatrix(cfg());
    expect(plan.variants.map((v) => v.variant.id)).toEqual(["A", "B", "C"]);
    expect(plan.totalEstimateUSD).toBeGreaterThan(0);
  });

  it("batches B/C to ≤2 tasks/invocation and A larger — each batch strictly under the $25/run guard", () => {
    const plan = planMatrix(cfg());
    const byId = Object.fromEntries(plan.variants.map((v) => [v.variant.id, v]));
    // B & C: gross 1.2M → $9.36/task → ≤2 tasks/batch (2×$9.36=$18.72 < $25); 9 tasks → 5 batches.
    for (const id of ["B", "C"] as const) {
      for (const b of byId[id]!.batches) {
        expect(b.taskNames.length).toBeLessThanOrEqual(2);
        expect(b.estimateUSD).toBeLessThan(25);
      }
      expect(byId[id]!.batches).toHaveLength(5);
    }
    // A: 400k → $3.12/task → 8/batch under $25; 9 tasks → 2 batches (8 + 1), far fewer than B/C's 5.
    expect(byId["A"]!.batches).toHaveLength(2);
    expect(byId["A"]!.batches[0]!.taskNames.length).toBe(8);
    for (const b of byId["A"]!.batches) expect(b.estimateUSD).toBeLessThan(25);
    // every task is covered exactly once per variant
    for (const v of plan.variants) {
      expect(v.batches.flatMap((b) => b.taskNames).sort()).toEqual([...TASKS].sort());
    }
  });

  it("fail-closed: a variant with NO explicit cap is refused (requirement 7)", () => {
    const bare: MatrixVariant = { id: "A", label: "bare", description: "no caps" };
    expect(() => planMatrix(cfg({ variants: [bare] }))).toThrow(/declares no cap/i);
  });

  it("fail-closed: a single task whose UB exceeds the per-run guard cannot be batched", () => {
    // perRunUSD $5 < B's $9.36/task → unbatchable → refuse.
    expect(() => planMatrix(cfg({ variants: [variant("B")], perRunUSD: 5 }))).toThrow(
      /not under the \$5\/run guard/i,
    );
  });

  it("reduces the batch size when the floor would land exactly ON the guard (strictly under)", () => {
    // perRunUSD = the EXACT 2-task estimate → floor gives 2, whose estimate == perRunUSD (not < it),
    // so the planner steps down to 1 task/batch. 9 tasks → 9 batches.
    const perRunUSD = estimateBatchUB(1_200_000, 2, PRICING);
    const plan = planMatrix(cfg({ variants: [variant("B")], perRunUSD }));
    expect(plan.variants[0]!.batches).toHaveLength(9);
    for (const b of plan.variants[0]!.batches) expect(b.estimateUSD).toBeLessThan(perRunUSD);
  });
});

describe("planMatrix — permanent assumed-vs-actual guard (Epic 1.14)", () => {
  it("fails closed when the cap's cacheReadWeight drifts from the real price ratio", () => {
    // weight says cached costs 0.1×, but pricing omits the cache-read rate → implied ratio 1.0. The cap
    // would no longer track real billing — exactly the self-deception behind the ~4× ledger inflation.
    expect(() => planMatrix(cfg({ pricing: { inputPerMTok: 3, outputPerMTok: 15 } }))).toThrow(
      /drift|weight/i,
    );
    expect(() => dryRunMatrix(cfg({ cacheReadWeight: 0.2 }))).toThrow(/drift|weight/i); // 0.2 ≠ $0.30/$3.00
  });

  it("passes when weight and price ratio agree (0.1 == $0.30/$3.00)", () => {
    expect(() => planMatrix(cfg())).not.toThrow();
  });
});

describe("dryRunMatrix — no-spend validation of cap wiring + output paths (requirement 6)", () => {
  it("threads authenticated binary provenance through every Harbor batch", () => {
    const dry = dryRunMatrix(cfg({ variants: [variant("A")] }));
    for (const argv of Object.values(dry.argvByJob)) {
      expect(argv).toEqual(
        expect.arrayContaining(["--ae", `KEEL_BINARY_SHA256=${"b".repeat(64)}`]),
      );
    }
  });

  it("fails closed on malformed binary provenance before a matrix can run", () => {
    expect(() => dryRunMatrix(cfg({ binarySha256: "not-a-sha256" }))).toThrow(
      /binary sha-256.*64 lowercase hexadecimal/i,
    );
  });

  it("A emits ONLY KEEL_MAX_GROSS_TOKENS=400000 (no KEEL_MAX_TOKENS) across every batch", () => {
    const dry = dryRunMatrix(cfg({ variants: [variant("A")] }));
    for (const [job, argv] of Object.entries(dry.argvByJob)) {
      expect(job).toMatch(/^matrix-A-b\d+$/);
      expect(argv).toEqual(expect.arrayContaining(["--ae", "KEEL_MAX_GROSS_TOKENS=400000"]));
      expect(argv.join(" ")).not.toMatch(/KEEL_MAX_TOKENS=/);
    }
  });

  it("B emits the effective cap + gross backstop; C adds the output guard", () => {
    const bJob = dryRunMatrix(cfg({ variants: [variant("B")] })).argvByJob["matrix-B-b0"]!;
    expect(bJob).toEqual(expect.arrayContaining(["--ae", "KEEL_MAX_TOKENS=400000"]));
    expect(bJob).toEqual(expect.arrayContaining(["--ae", "KEEL_MAX_GROSS_TOKENS=1200000"]));
    expect(bJob.join(" ")).not.toMatch(/KEEL_MAX_OUTPUT_TOKENS/);

    const cJob = dryRunMatrix(cfg({ variants: [variant("C")] })).argvByJob["matrix-C-b0"]!;
    expect(cJob).toEqual(expect.arrayContaining(["--ae", "KEEL_MAX_TOKENS=400000"]));
    expect(cJob).toEqual(expect.arrayContaining(["--ae", "KEEL_MAX_GROSS_TOKENS=1200000"]));
    expect(cJob).toEqual(expect.arrayContaining(["--ae", "KEEL_MAX_OUTPUT_TOKENS=80000"]));
  });

  it("reports the output paths + total estimate without spending", () => {
    const dry = dryRunMatrix(cfg());
    expect(dry.outFiles).toEqual([
      join("/abs/out", "matrix-A.json"),
      join("/abs/out", "matrix-B.json"),
      join("/abs/out", "matrix-C.json"),
    ]);
    expect(dry.totalEstimateUSD).toBeGreaterThan(0);
  });

  it("threads optional keelHome / nAttempts / nConcurrent into the argv when set", () => {
    const dry = dryRunMatrix(
      cfg({ variants: [variant("B")], keelHome: "/logs/agent/kh", nAttempts: 2, nConcurrent: 3 }),
    );
    const argv = dry.argvByJob["matrix-B-b0"]!;
    expect(argv).toEqual(expect.arrayContaining(["--ae", "KEEL_HOME=/logs/agent/kh"]));
    expect(argv).toEqual(expect.arrayContaining(["-k", "2"]));
    expect(argv).toEqual(expect.arrayContaining(["-n", "3"]));
  });

  it("threads the SHARED turn cap (config.maxTurns) into KEEL_MAX_TURNS on every batch (ER-038)", () => {
    // The turn cap is held IDENTICAL across A/B/C (caps stay the only difference) but raisable, so the
    // cost-aware variants' runway is bounded by their budget, not by the DEFAULT_MAX_TURNS=50 clamp.
    const dry = dryRunMatrix(cfg({ variants: [variant("A"), variant("B")], maxTurns: 120 }));
    for (const argv of Object.values(dry.argvByJob)) {
      expect(argv).toEqual(expect.arrayContaining(["--ae", "KEEL_MAX_TURNS=120"]));
    }
    // unset → no turn-cap env (the in-container kernel default applies)
    const noTurns = dryRunMatrix(cfg({ variants: [variant("B")] }));
    for (const argv of Object.values(noTurns.argvByJob)) {
      expect(argv.join(" ")).not.toMatch(/KEEL_MAX_TURNS/);
    }
  });

  it("threads reviewed interactive-console config only into QEMU task batches when enabled", () => {
    const dry = dryRunMatrix(
      cfg({
        variants: [variant("B")],
        taskNames: [
          "terminal-bench/build-cython-ext",
          "terminal-bench/qemu-startup",
          "terminal-bench/qemu-alpine-ssh",
        ],
        perRunUSD: 25,
        interactiveConsole: {
          tmuxPath: "/usr/bin/tmux",
          qemuBinary: "/usr/bin/qemu-system-x86_64",
          env: { KEEL_HOME: "/logs/agent/qemu-keelhome" },
        },
      }),
    );

    const batches = dry.plan.variants[0]!.batches;
    expect(batches.map((batch) => batch.taskNames)).toEqual([
      ["terminal-bench/build-cython-ext"],
      ["terminal-bench/qemu-startup"],
      ["terminal-bench/qemu-alpine-ssh"],
    ]);
    const nonQemu = Object.values(dry.argvByJob).find((argv) =>
      argv.includes("terminal-bench/build-cython-ext"),
    );
    const qemu = Object.values(dry.argvByJob).find((argv) =>
      argv.includes("terminal-bench/qemu-startup"),
    );
    const alpineSsh = Object.values(dry.argvByJob).find((argv) =>
      argv.includes("terminal-bench/qemu-alpine-ssh"),
    );
    expect(nonQemu?.join(" ")).not.toMatch(/KEEL_WARDEN_INTERACTIVE_CONSOLE/u);
    expect(nonQemu?.join(" ")).not.toMatch(/KEEL_EVAL_DIRECT_EXEC/u);
    expect(nonQemu?.join(" ")).not.toMatch(/KEEL_WARDEN_SANDBOX=srt/u);
    expect(nonQemu?.join(" ")).not.toMatch(/KEEL_RUN_SESSION_ID=/u);
    expect(nonQemu).not.toContain("HOME=/logs/agent");
    expect(nonQemu).not.toContain("KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64");
    const qemuSessionIds: string[] = [];
    for (const [argv, targetId] of [
      [qemu, "qemu-startup"],
      [alpineSsh, "qemu-alpine-ssh"],
    ] as const) {
      expect(argv).toEqual(expect.arrayContaining(["--ae", "KEEL_WARDEN_SANDBOX=srt"]));
      expect(argv).toEqual(
        expect.arrayContaining([
          "--ae",
          "KEEL_EVAL_DIRECT_EXEC=i-understand-this-disables-the-warden-eval-only",
        ]),
      );
      const configEnv = argv?.find((arg) =>
        arg.startsWith("KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64="),
      );
      const grantEnv = argv?.find((arg) =>
        arg.startsWith("KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64="),
      );
      const sessionEnv = argv?.find((arg) => arg.startsWith("KEEL_RUN_SESSION_ID="));
      expect(configEnv).toBeDefined();
      expect(grantEnv).toBeDefined();
      expect(sessionEnv).toMatch(/^KEEL_RUN_SESSION_ID=ses_[0-9A-HJKMNP-TV-Z]{26}$/u);
      const sessionId = sessionEnv?.split("=")[1] ?? "";
      qemuSessionIds.push(sessionId);
      expect(argv).toEqual(expect.arrayContaining(["--ae", "HOME=/logs/agent"]));
      expect(argv).toEqual(expect.arrayContaining(["--ae", "KEEL_HOME=/logs/agent/qemu-keelhome"]));
      const decoded = Buffer.from(configEnv?.split("=")[1] ?? "", "base64").toString("utf8");
      expect(decoded).toContain(`"targetId":"${targetId}"`);
      expect(decoded).toContain(`"privateRoot":"/tmp/keel-console-tmux-${targetId}-`);
      expect(decoded).not.toContain("build-cython-ext");
      const decodedGrant = JSON.parse(
        Buffer.from(grantEnv?.split("=")[1] ?? "", "base64").toString("utf8"),
      ) as {
        readonly sessionId: string;
        readonly target: { readonly targetId: string };
      };
      expect(decodedGrant.sessionId).toBe(sessionId);
      expect(decodedGrant.target.targetId).toBe(targetId);
    }
    expect(new Set(qemuSessionIds).size).toBe(2);
  });
});

describe("runMatrix — persists a MatrixRun per variant (injected $0 executor)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "keel-mrun-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes matrix-<id>.json to the expected location with the per-task records", async () => {
    const stats: MatrixTrialStats = {
      usage: { inputTokens: 405_000, outputTokens: 5_000, cachedInputTokens: 380_000 },
      reason: "budget",
      turns: 28,
      toolCalls: 33,
      wallTimeMs: 600_000,
    };
    // A fake paid op: one canned record per task in the batch — ZERO spend / harbor / Anthropic.
    const { buildMatrixTaskRecord } = await import("./matrix.js");
    const execBatch = (batch: { taskNames: readonly string[]; variantId: "A" | "B" | "C" }) =>
      Promise.resolve(
        batch.taskNames.map((taskId) =>
          buildMatrixTaskRecord({
            taskId,
            reward: 1,
            variant: variant(batch.variantId),
            cacheReadWeight: 0.1,
            stats,
          }),
        ),
      );

    const result = await runMatrix(
      cfg({ variants: [variant("A"), variant("B")], outDir: dir }),
      execBatch,
    );
    expect(result.runs.map((r) => r.variant)).toEqual(["A", "B"]);

    for (const id of ["A", "B"] as const) {
      const file = join(dir, `matrix-${id}.json`);
      expect(existsSync(file)).toBe(true);
      const run = await readMatrixRun(file);
      expect(run.variant).toBe(id);
      expect(run.tasks).toHaveLength(9); // every task recorded
      expect(run.tasks.every((t) => t.resolved)).toBe(true);
      // per-task fields persisted
      expect(run.tasks[0]).toMatchObject({
        effectiveTokens: 68_000, // (405k−380k) + 0.1·380k + 5k
        grossTokens: 410_000,
        cachedTokens: 380_000,
        outputTokens: 5_000,
        turns: 28,
        toolCalls: 33,
        wallTimeMs: 600_000,
        reason: "budget",
        endKind: id === "A" ? "gross" : "effective", // A=gross-only cap → gross; B=effective
      });
    }
    // C was NOT requested → not written (supports A+B-first, stop-before-C)
    expect(existsSync(join(dir, "matrix-C.json"))).toBe(false);
  });

  it("refuses BEFORE any batch runs when the task set doesn't match its claimed pinned subset (EVAL-1)", async () => {
    let execCalls = 0;
    // The default TASKS (9 fake ids) are NOT the pinned keel-tb2-25 set, so a run labeled keel-tb2-25
    // must be refused fail-closed before any paid batch — "what we claim we ran" must equal "what we run".
    await expect(
      runMatrix(cfg({ subset: "keel-tb2-25" }), async () => {
        execCalls += 1;
        return [];
      }),
    ).rejects.toThrow(/does not match its pinned/);
    expect(execCalls).toBe(0);
  });
});

describe("parseJobDirMatrixRecords — job dir → per-task records (fail-open analysis)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "keel-mjob-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function trial(
    name: string,
    taskId: string,
    reward: string,
    ledger?: string,
  ): Promise<void> {
    const t = join(dir, name);
    await mkdir(join(t, "verifier"), { recursive: true });
    await writeFile(
      join(t, "result.json"),
      JSON.stringify({ task_id: { name: taskId }, trial_name: name }),
    );
    await writeFile(join(t, "verifier", "reward.txt"), reward);
    if (ledger !== undefined) {
      await mkdir(join(t, "agent", "keelhome", "sessions"), { recursive: true });
      await writeFile(join(t, "agent", "keelhome", "sessions", "ses.jsonl"), ledger);
    }
  }

  it("builds a record per trial: reward, reconstructed endKind, and the token/shape fields", async () => {
    await trial(
      "task-0__t",
      "task-0",
      "1",
      [
        `{"type":"assistant","ts":"2026-06-17T00:00:01.000Z","toolCalls":[{"id":"a"}]}`,
        `{"type":"run_status","ts":"2026-06-17T00:00:05.000Z","reason":"model-stop","usage":{"inputTokens":100,"outputTokens":10,"cachedInputTokens":90}}`,
      ].join("\n"),
    );
    // a trial that errored before verification (no reward.txt content / no ledger) → reward -1, error
    await trial("task-1__t", "task-1", "");
    // non-trial noise that must be skipped: a stray file, and a dir with no result.json
    await writeFile(join(dir, "job.log"), "noise");
    await mkdir(join(dir, "not-a-trial"), { recursive: true });
    // a trial with result.json but NO reward.txt at all (missing-file catch) → reward -1
    await mkdir(join(dir, "task-2__t"), { recursive: true });
    await writeFile(
      join(dir, "task-2__t", "result.json"),
      JSON.stringify({ task_id: { name: "task-2" }, trial_name: "task-2__t" }),
    );
    // a dir whose result.json has a malformed task_id (no string name) → skipped, not crashed
    await mkdir(join(dir, "bad__t"), { recursive: true });
    await writeFile(join(dir, "bad__t", "result.json"), JSON.stringify({ task_id: {} }));

    const records = await parseJobDirMatrixRecords(dir, variant("B"), 0.1);
    expect(records.map((r) => r.taskId).sort()).toEqual(["task-0", "task-1", "task-2"]); // noise skipped
    // no turn cap supplied → not stamped (relies on the in-container kernel default)
    expect(records.every((r) => r.maxTurns === undefined)).toBe(true);
    const byId = Object.fromEntries(records.map((r) => [r.taskId, r]));
    expect(byId["task-2"]).toMatchObject({ reward: -1, resolved: false });
    expect(byId["task-0"]).toMatchObject({
      resolved: true,
      reward: 1,
      reason: "model-stop",
      endKind: "completed",
      cachedTokens: 90,
      turns: 1,
      toolCalls: 1,
    });
    expect(byId["task-1"]).toMatchObject({
      resolved: false,
      reward: -1,
      reason: null,
      endKind: "error",
    });
  });

  it("stamps the configured turn cap onto each record when supplied (turn-bound is self-describing)", async () => {
    await trial(
      "task-0__t",
      "task-0",
      "0",
      `{"type":"run_status","ts":"2026-06-17T00:00:05.000Z","reason":"max-turns","usage":{"inputTokens":100,"outputTokens":10}}`,
    );
    const records = await parseJobDirMatrixRecords(dir, variant("B"), 0.1, 120);
    expect(records[0]).toMatchObject({ maxTurns: 120, endKind: "turn", reason: "max-turns" });
  });
});

describe("defaultBatchExecutor — the guarded spend edge (fake spawn + temp ledger, $0)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "keel-mexec-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs a batch through runGuardedBenchmark (guard passes) then parses the job dir into records", async () => {
    const jobsDir = join(dir, "jobs");
    const ledgerPath = join(dir, "ledger.jsonl");
    // A fake harbor: writes a finished job dir for the batch (1 trial), then returns. NO real harbor,
    // NO Anthropic — the spawn just materializes the files runGuardedBenchmark + the matrix parse read.
    const spawn = async (): Promise<void> => {
      const trialDir = join(jobsDir, "matrix-B-b0", "t0__trial");
      await mkdir(join(trialDir, "verifier"), { recursive: true });
      await mkdir(join(trialDir, "agent", "keelhome", "sessions"), { recursive: true });
      await writeFile(
        join(trialDir, "result.json"),
        JSON.stringify({ task_id: { name: "t0" }, trial_name: "t0__trial" }),
      );
      await writeFile(join(trialDir, "verifier", "reward.txt"), "1");
      await writeFile(
        join(trialDir, "agent", "keelhome", "sessions", "ses.jsonl"),
        [
          `{"type":"assistant","ts":"2026-06-17T00:00:01.000Z","toolCalls":[{"id":"a"}]}`,
          `{"type":"run_status","ts":"2026-06-17T00:00:09.000Z","reason":"model-stop","usage":{"inputTokens":100,"outputTokens":10,"cachedInputTokens":90}}`,
        ].join("\n"),
      );
    };

    const plan = planMatrix(
      cfg({ variants: [variant("B")], taskNames: ["terminal-bench/t0"], jobsDir, maxTurns: 120 }),
    );
    const batch = plan.variants[0]!.batches[0]!;

    const exec = defaultBatchExecutor({
      spawn,
      guardConfig: defaultEvalConfig,
      ledgerPath,
      descriptorFor: (b) => ({ runId: b.jobName, suite: "terminal-bench-2", model: "m" }),
      variantById: (id) => variant(id),
      cacheReadWeight: 0.1,
      pricing: PRICING,
      now: new Date("2026-06-17T00:00:00.000Z"),
    });

    const records = await exec(batch);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      taskId: "t0",
      resolved: true,
      reason: "model-stop",
      endKind: "completed",
      cachedTokens: 90,
      turns: 1,
      toolCalls: 1,
      maxTurns: 120, // the production glue threads config.maxTurns → harborOpts → the record
    });
    // the guarded spend was recorded to the ledger (the guard path actually ran)
    expect(existsSync(ledgerPath)).toBe(true);
  });
});
