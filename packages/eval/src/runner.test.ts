import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CostCapError } from "./cost-cap.js";
import type { TokenPricing } from "./cost-cap.js";
import { defaultEvalConfig } from "./config.default.js";
import type { EvalConfigT } from "./config.js";
import { readMonthToDateUSD, readSpendRecords } from "./spend-ledger.js";
import type { SpendDescriptor } from "./spend-ledger.js";
import {
  estimateBenchmarkCostUB,
  measureBenchmarkCost,
  measureBenchmarkRealCost,
  runGuardedBenchmark,
  toBenchmarkResult,
} from "./runner.js";
import type { HarborRunOutcome, HarborTaskOutcome } from "./runner.js";

// Owner-set pricing WITH cache rates (the discounted real-cost path; un-cached UB ignores these).
const CACHED_PRICING: TokenPricing = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
};
function cachedOutcome(
  taskId: string,
  inTok: number,
  cachedTok: number,
  outTok: number,
): HarborTaskOutcome {
  return {
    taskId,
    resolved: true,
    failureMode: null,
    trial: `${taskId}__t0`,
    usage: { inputTokens: inTok, outputTokens: outTok, cachedInputTokens: cachedTok },
  };
}

// Sonnet 4.6 owner-set pricing (the runner never hard-codes prices; the test supplies them).
const PRICING: TokenPricing = { inputPerMTok: 3, outputPerMTok: 15 };
const CONFIG: EvalConfigT = defaultEvalConfig; // $25/run, $300/mo
const DESC: SpendDescriptor = {
  runId: "benchmark-run-1",
  suite: "terminal-bench-2",
  model: "claude-sonnet-4-6",
};
const NOW = new Date("2026-06-16T12:00:00.000Z");

function outcome(
  taskId: string,
  resolved: boolean,
  inTok: number,
  outTok: number,
): HarborTaskOutcome {
  return {
    taskId,
    resolved,
    failureMode: resolved ? null : "incomplete",
    trial: `${taskId}__t0`,
    usage: { inputTokens: inTok, outputTokens: outTok },
  };
}

let dir: string;
let ledger: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "keel-runner-"));
  ledger = join(dir, "spend-ledger.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("estimateBenchmarkCostUB — pre-run upper bound", () => {
  it("scales with task count and is an UPPER BOUND over a realistic measured cost", () => {
    const req = {
      config: CONFIG,
      ledgerPath: ledger,
      descriptor: DESC,
      taskIds: ["a", "b"],
      perTaskTokenCap: 150_000,
      pricing: PRICING,
    };
    const est = estimateBenchmarkCostUB(req);
    // A realistic run is input-heavy (~88% input) and ends near the cap; the estimate must exceed it.
    const realistic = measureBenchmarkCost(
      [outcome("a", false, 133_000, 18_000), outcome("b", false, 130_000, 21_000)],
      PRICING,
    );
    expect(est).toBeGreaterThan(realistic);
    // Two identical tasks → exactly double a single-task estimate (linear in count).
    const single = estimateBenchmarkCostUB({ ...req, taskIds: ["a"] });
    expect(est).toBeCloseTo(single * 2, 9);
  });

  it("honors explicit overshoot + output-fraction overrides", () => {
    const req = {
      config: CONFIG,
      ledgerPath: ledger,
      descriptor: DESC,
      taskIds: ["a"],
      perTaskTokenCap: 100_000,
      pricing: PRICING,
    };
    // overshoot 1.0 (no slack), 100% output → 100k tokens all at the $15/Mtok output rate = $1.50.
    expect(estimateBenchmarkCostUB(req, 1.0, 1.0)).toBeCloseTo(1.5, 9);
    // A bigger overshoot strictly raises the ceiling.
    expect(estimateBenchmarkCostUB(req, 2.0, 1.0)).toBeGreaterThan(
      estimateBenchmarkCostUB(req, 1.0, 1.0),
    );
  });
});

describe("measureBenchmarkCost — actual from measured tokens", () => {
  it("sums per-task estimateCostUSD over the outcomes", () => {
    const cost = measureBenchmarkCost(
      [outcome("a", true, 100_000, 10_000), outcome("b", false, 50_000, 5_000)],
      PRICING,
    );
    // (100k*3 + 10k*15 + 50k*3 + 5k*15) / 1e6 = (300+150+150+75)/1e3 = 0.675
    expect(cost).toBeCloseTo(0.675, 9);
  });
});

describe("measureBenchmarkRealCost — real cache-discounted cost (ADR-0048 Option A)", () => {
  it("is strictly cheaper than the un-cached UB when input is cache-heavy", () => {
    const tasks = [cachedOutcome("a", 100_000, 90_000, 10_000)];
    const real = measureBenchmarkRealCost(tasks, CACHED_PRICING);
    const ub = measureBenchmarkCost(tasks, CACHED_PRICING);
    expect(real).toBeLessThan(ub);
    // real: fresh 10k*3 + cached 90k*0.3 + out 10k*15 = (30 + 27 + 150)/1e3 = 0.207
    expect(real).toBeCloseTo(0.207, 9);
    // UB: all 100k input at the full $3 + out 10k*15 = (300 + 150)/1e3 = 0.45
    expect(ub).toBeCloseTo(0.45, 9);
  });

  it("equals the UB when there is no cache data (no discount to apply)", () => {
    const tasks = [outcome("a", true, 100_000, 10_000)];
    expect(measureBenchmarkRealCost(tasks, CACHED_PRICING)).toBeCloseTo(
      measureBenchmarkCost(tasks, CACHED_PRICING),
      9,
    );
  });
});

describe("toBenchmarkResult — harbor outcomes → keel BenchmarkResult", () => {
  it("derives counts + resolvedRate from the per-task outcomes (ground truth)", () => {
    const r = toBenchmarkResult("terminal-bench-2", [
      outcome("a", true, 1, 1),
      outcome("b", false, 1, 1),
      outcome("c", true, 1, 1),
    ]);
    expect(r.nTasks).toBe(3);
    expect(r.nResolved).toBe(2);
    expect(r.nUnresolved).toBe(1);
    expect(r.resolvedRate).toBeCloseTo(2 / 3, 9);
    expect(r.tasks.map((t) => t.taskId)).toEqual(["a", "b", "c"]);
  });
  it("empty run → rate 0, no NaN", () => {
    expect(toBenchmarkResult("terminal-bench-2", []).resolvedRate).toBe(0);
  });
});

describe("runGuardedBenchmark — spend flows through guardedRun (QR-1)", () => {
  const baseReq = () => ({
    config: CONFIG,
    ledgerPath: ledger,
    descriptor: DESC,
    taskIds: ["a", "b"],
    perTaskTokenCap: 150_000,
    pricing: PRICING,
  });

  it("happy path: invokes harbor once, records the ACTUAL cost, returns the parsed result", async () => {
    const run: HarborRunOutcome = {
      tasks: [outcome("a", true, 120_000, 12_000), outcome("b", false, 140_000, 16_000)],
    };
    const invoke = vi.fn(async () => run);
    const { result, actualUSD, estimatedUSD } = await runGuardedBenchmark(baseReq(), invoke, NOW);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.nResolved).toBe(1);
    expect(actualUSD).toBeCloseTo(measureBenchmarkCost(run.tasks, PRICING), 9);
    expect(actualUSD).toBeLessThanOrEqual(estimatedUSD); // estimate is a valid UB for this run
    const records = await readSpendRecords(ledger);
    expect(records).toHaveLength(1);
    expect(records[0]?.costUSD).toBeCloseTo(actualUSD, 9);
    expect(records[0]?.runId).toBe("benchmark-run-1");
  });

  it("refuses an over-budget run BEFORE spending: never calls the invoker, records nothing", async () => {
    // 1000 tasks at 150k cap → estimate far exceeds the $25 per-run cap.
    const invoke = vi.fn(async (): Promise<HarborRunOutcome> => ({ tasks: [] }));
    const bigReq = {
      ...baseReq(),
      taskIds: Array.from({ length: 1000 }, (_, i) => `t${String(i)}`),
    };
    await expect(runGuardedBenchmark(bigReq, invoke, NOW)).rejects.toBeInstanceOf(CostCapError);
    expect(invoke).not.toHaveBeenCalled(); // no paid call on refusal
    expect(await readSpendRecords(ledger)).toHaveLength(0);
  });

  it("fails closed if the ACTUAL exceeds the estimate (runaway / broken estimator)", async () => {
    // Tasks report far more tokens than the cap implies → actual > estimate → guardedRun halts loudly.
    const run: HarborRunOutcome = {
      tasks: [outcome("a", false, 5_000_000, 2_000_000), outcome("b", false, 1, 1)],
    };
    const invoke = vi.fn(async () => run);
    await expect(runGuardedBenchmark(baseReq(), invoke, NOW)).rejects.toBeInstanceOf(CostCapError);
    // The spend IS recorded (it happened) before the loud halt — the ledger must not under-count.
    expect(await readSpendRecords(ledger)).toHaveLength(1);
  });

  it("defaults `now` to the wall clock when omitted (records against the current month)", async () => {
    const run: HarborRunOutcome = { tasks: [outcome("a", true, 10_000, 1_000)] };
    // No `now` argument → the runner uses `new Date()`; a tiny run is well within the $25/$300 caps.
    const { actualUSD } = await runGuardedBenchmark(
      { ...baseReq(), taskIds: ["a"] },
      vi.fn(async () => run),
    );
    const records = await readSpendRecords(ledger);
    expect(records).toHaveLength(1);
    expect(records[0]?.costUSD).toBeCloseTo(actualUSD, 9);
  });

  it("records BOTH the UB actualUSD and the discounted realActualUSD; month-to-date uses the real (Option A)", async () => {
    const run: HarborRunOutcome = { tasks: [cachedOutcome("a", 120_000, 100_000, 12_000)] };
    const req = { ...baseReq(), taskIds: ["a"], pricing: CACHED_PRICING };
    const { actualUSD, realActualUSD } = await runGuardedBenchmark(
      req,
      vi.fn(async () => run),
      NOW,
    );

    // The real cost is cache-discounted below the conservative un-cached UB.
    expect(realActualUSD).toBeLessThan(actualUSD);
    expect(realActualUSD).toBeCloseTo(measureBenchmarkRealCost(run.tasks, CACHED_PRICING), 9);
    expect(actualUSD).toBeCloseTo(measureBenchmarkCost(run.tasks, CACHED_PRICING), 9);
    // The ledger record carries both figures; the GUARD recorded the UB as costUSD, the real as realCostUSD.
    const records = await readSpendRecords(ledger);
    expect(records[0]?.costUSD).toBeCloseTo(actualUSD, 9);
    expect(records[0]?.realCostUSD).toBeCloseTo(realActualUSD, 9);
    // The monthly accumulator reflects the REAL spend, not the UB.
    expect(await readMonthToDateUSD(ledger, NOW)).toBeCloseTo(realActualUSD, 9);
  });
});
