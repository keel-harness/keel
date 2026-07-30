import { BenchmarkResult } from "./results.js";
import type { BenchmarkResultT } from "./results.js";
import { estimateCostUSD, realCostUSD } from "./cost-cap.js";
import type { RunUsage, TokenPricing } from "./cost-cap.js";
import { guardedRun } from "./spend-ledger.js";
import type { SpendDescriptor } from "./spend-ledger.js";
import type { EvalConfigT } from "./config.js";

/**
 * The live benchmark runner (Epic 1.11 Phase B). This is the piece `cost-cap.ts`/`config.ts` flagged as
 * the missing "LIVE benchmark runner that calls `guardedRun` with a real model spend" — it makes the
 * cost caps STRUCTURALLY binding (QR-1): every real benchmark spend is wrapped in `guardedRun`, so an
 * over-budget run is refused BEFORE any paid harbor invocation and the ACTUAL cost is recorded after.
 *
 * The paid work — running harbor against the TB-2 tasks and reading back each task's resolved/unresolved
 * verdict + measured token usage — is supplied as an INJECTABLE `HarborInvoker`. The orchestration here
 * (cap guard → spend → record → parse) is therefore unit-testable with a fake invoker at **zero spend**;
 * the real subprocess invoker (spawn the venv `harbor run`, read the synced job dir + keel ledgers) is a
 * thin adapter wired in for the bounded live Harbor validation run, exactly as `agent.py` wires the
 * container-side commands.
 */

/** One task's outcome as reported by harbor + keel's synced ledger: did the TB-2 verifier resolve it,
 *  and what did the run actually cost in tokens. `usage` MUST fold reasoning tokens into `outputTokens`
 *  (the cost ceiling never under-counts — see `estimateCostUSD`). */
export interface HarborTaskOutcome {
  readonly taskId: string;
  readonly resolved: boolean;
  readonly failureMode: string | null;
  readonly trial: string | null;
  readonly usage: RunUsage;
}

/** What one harbor invocation returns: the per-task outcomes for the requested tasks. */
export interface HarborRunOutcome {
  readonly tasks: readonly HarborTaskOutcome[];
}

/** The injectable paid operation: run harbor for the requested tasks and return their outcomes. Real =
 *  spawn `harbor run` + read the job dir; tests = a fake. Called ONLY after the cap guard passes. */
export type HarborInvoker = () => Promise<HarborRunOutcome>;

/** A guarded benchmark request: the config (caps + suite), the ledger, the run identity, the task set,
 *  the per-task **effective**-cost token cap (`KEEL_MAX_TOKENS`; cached input discounted per provider —
 *  ADR-0044), and the owner-set pricing table. (A raw cumulative-token emergency cap is the separate
 *  `KEEL_MAX_GROSS_TOKENS`; this `perTaskTokenCap` drives the primary effective budget.) */
export interface GuardedBenchmarkRequest {
  readonly config: EvalConfigT;
  readonly ledgerPath: string;
  readonly descriptor: SpendDescriptor;
  readonly taskIds: readonly string[];
  readonly perTaskTokenCap: number;
  readonly pricing: TokenPricing;
}

/** The result of a guarded benchmark run: the parsed result + the estimate it was guarded on + the
 *  actual measured cost recorded to the ledger. `actualUSD` is the conservative un-cached UB the GUARD
 *  rides; `realActualUSD` is the REAL cache-discounted cost recorded for the monthly accumulator
 *  (ADR-0048 Option A). With cached input present, `realActualUSD ≤ actualUSD`. */
export interface GuardedBenchmarkOutcome {
  readonly result: BenchmarkResultT;
  readonly estimatedUSD: number;
  readonly actualUSD: number;
  readonly realActualUSD: number;
}

/**
 * The pre-run UPPER-BOUND estimate `guardedRun` guards the caps on. The per-task **effective**-cost cap
 * (`KEEL_MAX_TOKENS`, ADR-0044) is the spend bound, but it is checked at TURN boundaries, so a run
 * overshoots by up to ~one final turn — modelled by `overshootFactor`. We split the capped tokens with a
 * conservative `outputFraction` (output bills 5×; initial bounded Harbor probe measured ~10–15% output, so 25% is a safe ceiling)
 * and price via `estimateCostUSD` (which charges input at the full, un-cached rate — a further over-count).
 * Because the cap is now *effective*, a cached-heavy task may consume MORE gross tokens than the cap (its
 * cheap cached reads barely count), so the estimate bounds *cost* (effective tokens are the cost proxy),
 * not gross token volume — and `guardedRun` still records the ACTUAL from the synced ledger and fails
 * closed if actual > estimate, so the money-safety backstop is unchanged. Pair with `KEEL_MAX_GROSS_TOKENS`
 * to also bound gross volume / wall time for a long cached-heavy task.
 *
 * **Contract:** this is a valid upper bound for any run whose output fraction ≤ `outputFraction` AND
 * whose token overshoot ≤ `(overshootFactor − 1)` of the cap. If a real run violates that, `guardedRun`'s
 * post-spend `actual ≤ estimate` assertion fails closed (records, then halts loudly) — so a wrong
 * assumption here can never silently overspend, only over-refuse or trip the loud backstop.
 */
export function estimateBenchmarkCostUB(
  req: GuardedBenchmarkRequest,
  overshootFactor = 1.3,
  outputFraction = 0.25,
): number {
  const perTaskTotal = req.perTaskTokenCap * overshootFactor;
  const usage: RunUsage = {
    inputTokens: perTaskTotal * (1 - outputFraction),
    outputTokens: perTaskTotal * outputFraction,
  };
  return estimateCostUSD(usage, req.pricing) * req.taskIds.length;
}

/**
 * The ACTUAL recorded cost: sum each task's measured usage through `estimateCostUSD`. Because that
 * charges input at the full rate (no prompt-cache discount), this is itself a conservative upper bound on
 * the real Anthropic bill — the safe direction for a spend ledger (it can over-count, never under-count).
 */
export function measureBenchmarkCost(
  tasks: readonly HarborTaskOutcome[],
  pricing: TokenPricing,
): number {
  let total = 0;
  for (const t of tasks) total += estimateCostUSD(t.usage, pricing);
  return total;
}

/**
 * The REAL (cache-discounted) cost actually billed: sum each task's measured usage through `realCostUSD`
 * (ADR-0048 Option A). Unlike `measureBenchmarkCost` — the conservative un-cached UPPER BOUND the spend
 * GUARD rides — this charges the cached input subset at the cache-read rate and the cache-write subset at
 * the cache-write rate, so it reflects the true Anthropic bill. It feeds the MONTHLY accumulator (so the
 * monthly cap is denominated in real dollars), NEVER the per-run pre-spend gate or the post-spend
 * backstop. With cached input present it is ≤ `measureBenchmarkCost`; with no cache data it equals it.
 */
export function measureBenchmarkRealCost(
  tasks: readonly HarborTaskOutcome[],
  pricing: TokenPricing,
): number {
  let total = 0;
  for (const t of tasks) total += realCostUSD(t.usage, pricing);
  return total;
}

/** Map harbor's per-task outcomes onto keel's stable `BenchmarkResult` (per-task `tasks` is ground
 *  truth; counts + rate are derived from it, never trusted from an aggregate). */
export function toBenchmarkResult(
  suite: string,
  tasks: readonly HarborTaskOutcome[],
): BenchmarkResultT {
  const taskResults = tasks.map((t) => ({
    taskId: t.taskId,
    resolved: t.resolved,
    failureMode: t.failureMode,
    trial: t.trial,
  }));
  const nTasks = taskResults.length;
  const nResolved = taskResults.filter((t) => t.resolved).length;
  return BenchmarkResult.parse({
    suite,
    nTasks,
    nResolved,
    nUnresolved: nTasks - nResolved,
    resolvedRate: nTasks === 0 ? 0 : nResolved / nTasks,
    tasks: taskResults,
  });
}

/**
 * Run a benchmark with the spend wrapped in `guardedRun` (QR-1). Refuses BEFORE any paid call if the
 * upper-bound estimate breaches the per-run or month-to-date cap (the `invoke` is never called on
 * refusal — no spend). On success, records BOTH the conservative un-cached UB (`actualUSD`, the GUARD
 * basis) and the REAL cache-discounted cost (`realActualUSD`, the monthly accumulator basis — ADR-0048
 * Option A) to the ledger, and returns the parsed result; if the UB actual exceeds the estimate,
 * `guardedRun` records it then halts loudly (fail-closed — the backstop stays on the UB, never the real).
 */
export async function runGuardedBenchmark(
  req: GuardedBenchmarkRequest,
  invoke: HarborInvoker,
  now: Date = new Date(),
): Promise<GuardedBenchmarkOutcome> {
  const estimatedUSD = estimateBenchmarkCostUB(req);
  let actualUSD = 0;
  let realActualUSD = 0;
  const result = await guardedRun(
    req.config,
    req.ledgerPath,
    req.descriptor,
    estimatedUSD,
    async () => {
      const run = await invoke(); // the PAID work — reached only after the cap guard passes
      actualUSD = measureBenchmarkCost(run.tasks, req.pricing); // conservative UB — the guard rides this
      realActualUSD = measureBenchmarkRealCost(run.tasks, req.pricing); // real — monthly accumulator only
      return { value: toBenchmarkResult(req.config.suite, run.tasks), actualUSD, realActualUSD };
    },
    now,
  );
  return { result, estimatedUSD, actualUSD, realActualUSD };
}
