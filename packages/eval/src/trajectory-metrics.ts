import { z } from "zod";
import type { TrajectoryT } from "./trajectory.js";

/**
 * The §8.2 trajectory-quality metrics — "the *run* is evaluated, not just the answer." All derived
 * deterministically from a stored `Trajectory`'s events (the Epic 0.4 store), so they cost nothing
 * extra to collect and are reproducible (no LLM, no spend). The §2.3 iteration loop targets regressions
 * in THESE, not only the pass-rate: a task passed by stumbling (or solved with a degrading recovery
 * pattern) is a latent regression.
 */
export const TrajectoryQualityMetrics = z
  .object({
    turns: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    /** Fraction of tool calls with structurally-valid args (1.0 when there are no calls). §8.2. */
    toolCallArgValidityRate: z.number().min(0).max(1),
    /** Tool calls that repeat an earlier call's (name, args) — the §8.2 "redundant/duplicate reads"
     *  signal, generalized to any tool (a re-read of an unchanged file is the canonical case). */
    redundantToolCalls: z.number().int().nonnegative(),
    /** Failed tool results (`ok: false`). */
    toolErrors: z.number().int().nonnegative(),
    /** Fraction of failed tool results that were followed by a later successful result — graceful
     *  recovery vs. a cascade (1.0 when there are no errors). §8.2 error→recovery. */
    errorRecoveryRate: z.number().min(0).max(1),
    /** Premature-completion attempts intercepted by the verification interceptor (Epic 1.1). §8.2. */
    prematureCompletionIntercepts: z.number().int().nonnegative(),
    completionAttempts: z.number().int().nonnegative(),
    /** Compaction events — a proxy for context-window pressure/pollution (§8.2). */
    compactions: z.number().int().nonnegative(),
    wallClockMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();
export type TrajectoryQualityMetricsT = z.infer<typeof TrajectoryQualityMetrics>;

/** A stable canonical key for a tool call (name + sorted args), for duplicate detection. */
function callKey(name: string, args: Record<string, unknown>): string {
  const sorted = Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join("&");
  return `${name}(${sorted})`;
}

/** Compute the §8.2 trajectory-quality metrics for one trajectory (pure, deterministic). */
export function trajectoryQualityMetrics(traj: TrajectoryT): TrajectoryQualityMetricsT {
  let toolCalls = 0;
  let argValid = 0;
  let redundantToolCalls = 0;
  let toolErrors = 0;
  let recoveredErrors = 0;
  let prematureCompletionIntercepts = 0;
  let completionAttempts = 0;
  let compactions = 0;
  const seenCalls = new Set<string>();
  // Indices of unrecovered errors so far; a later ok:true result clears (recovers) all of them.
  let pendingErrorCount = 0;

  for (const e of traj.events) {
    switch (e.type) {
      case "tool-call": {
        toolCalls += 1;
        if (e.argsValid) argValid += 1;
        const key = callKey(e.name, e.args);
        if (seenCalls.has(key)) redundantToolCalls += 1;
        else seenCalls.add(key);
        break;
      }
      case "tool-result": {
        if (e.ok) {
          // A success recovers every error that preceded it without an intervening success.
          recoveredErrors += pendingErrorCount;
          pendingErrorCount = 0;
        } else {
          toolErrors += 1;
          pendingErrorCount += 1;
        }
        break;
      }
      case "completion-attempt": {
        completionAttempts += 1;
        if (e.intercepted) prematureCompletionIntercepts += 1;
        break;
      }
      case "compaction": {
        compactions += 1;
        break;
      }
      default:
        break;
    }
  }

  return {
    turns: traj.totals.turns,
    toolCalls,
    toolCallArgValidityRate: toolCalls === 0 ? 1 : argValid / toolCalls,
    redundantToolCalls,
    toolErrors,
    errorRecoveryRate: toolErrors === 0 ? 1 : recoveredErrors / toolErrors,
    prematureCompletionIntercepts,
    completionAttempts,
    compactions,
    wallClockMs: traj.totals.wallClockMs,
    inputTokens: traj.totals.inputTokens,
    outputTokens: traj.totals.outputTokens,
  };
}

/** Aggregate per-trajectory metrics across a run into means/totals (the scoreboard's run-level view). */
export const AggregateQualityMetrics = z
  .object({
    nTrajectories: z.number().int().nonnegative(),
    meanToolCalls: z.number().nonnegative(),
    meanToolCallArgValidityRate: z.number().min(0).max(1),
    totalRedundantToolCalls: z.number().int().nonnegative(),
    totalToolErrors: z.number().int().nonnegative(),
    meanErrorRecoveryRate: z.number().min(0).max(1),
    totalPrematureCompletionIntercepts: z.number().int().nonnegative(),
    /** Total compaction events across the run — the §8.2 context-window-pollution signal at run level. */
    totalCompactions: z.number().int().nonnegative(),
    meanWallClockMs: z.number().nonnegative(),
    meanInputTokens: z.number().nonnegative(),
    meanOutputTokens: z.number().nonnegative(),
  })
  .strict();
export type AggregateQualityMetricsT = z.infer<typeof AggregateQualityMetrics>;

/** Aggregate a run's trajectories into run-level §8.2 metrics (means for rates/counts, totals where a
 *  sum is the meaningful figure). An empty run yields zeros with rates at 1.0 (no observed degradation). */
export function aggregateQualityMetrics(
  trajectories: readonly TrajectoryT[],
): AggregateQualityMetricsT {
  const n = trajectories.length;
  if (n === 0) {
    return {
      nTrajectories: 0,
      meanToolCalls: 0,
      meanToolCallArgValidityRate: 1,
      totalRedundantToolCalls: 0,
      totalToolErrors: 0,
      meanErrorRecoveryRate: 1,
      totalPrematureCompletionIntercepts: 0,
      totalCompactions: 0,
      meanWallClockMs: 0,
      meanInputTokens: 0,
      meanOutputTokens: 0,
    };
  }
  const m = trajectories.map(trajectoryQualityMetrics);
  const sum = (f: (x: TrajectoryQualityMetricsT) => number): number =>
    m.reduce((a, x) => a + f(x), 0);
  return {
    nTrajectories: n,
    meanToolCalls: sum((x) => x.toolCalls) / n,
    meanToolCallArgValidityRate: sum((x) => x.toolCallArgValidityRate) / n,
    totalRedundantToolCalls: sum((x) => x.redundantToolCalls),
    totalToolErrors: sum((x) => x.toolErrors),
    meanErrorRecoveryRate: sum((x) => x.errorRecoveryRate) / n,
    totalPrematureCompletionIntercepts: sum((x) => x.prematureCompletionIntercepts),
    totalCompactions: sum((x) => x.compactions),
    meanWallClockMs: sum((x) => x.wallClockMs) / n,
    meanInputTokens: sum((x) => x.inputTokens) / n,
    meanOutputTokens: sum((x) => x.outputTokens) / n,
  };
}
