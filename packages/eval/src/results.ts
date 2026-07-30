import { z } from "zod";

/**
 * Raised when a Terminal-Bench `results.json` contains an aggregate field (`n_resolved` or
 * `n_unresolved`) that disagrees with the count derived from the per-task `results` array (the
 * ground truth). The message names both the provided and derived numbers.
 */
export class ResultMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultMismatchError";
  }
}

/** One task's outcome in keel's normative parsed form. */
export const TaskResult = z
  .object({
    taskId: z.string().min(1),
    resolved: z.boolean(),
    failureMode: z.string().nullable(),
    trial: z.string().nullable(),
  })
  .strict();
export type TaskResultT = z.infer<typeof TaskResult>;

/** A parsed benchmark run — keel's STABLE result form (independent of any harness's wire format). */
export const BenchmarkResult = z
  .object({
    suite: z.string().min(1),
    nTasks: z.number().int().nonnegative(),
    nResolved: z.number().int().nonnegative(),
    nUnresolved: z.number().int().nonnegative(),
    resolvedRate: z.number().min(0).max(1),
    tasks: z.array(TaskResult),
  })
  .strict();
export type BenchmarkResultT = z.infer<typeof BenchmarkResult>;

/**
 * Legacy/offline adapter from a Terminal-Bench-style aggregate `results.json` to keel's stable
 * `BenchmarkResult`. Phase 1's live paid runs did NOT emit this shape: Harbor job summaries use
 * `stats.evals[*].metrics[*].mean`, while the production path derives `BenchmarkResult` from
 * per-trial verifier rewards via `harbor-invoker.ts` and `runner.ts`.
 *
 * Keep this shape isolated for synthetic/offline fixtures and future direct-TB imports. If a future
 * direct `tb` CLI result differs, change it HERE; `BenchmarkResult` stays stable downstream.
 */
const TerminalBenchResults = z
  .object({
    n_resolved: z.number().int().nonnegative().optional(),
    n_unresolved: z.number().int().nonnegative().optional(),
    accuracy: z.number().optional(),
    results: z.array(
      z
        .object({
          task_id: z.string().min(1),
          is_resolved: z.boolean(),
          failure_mode: z.string().nullish(),
          trial_name: z.string().nullish(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export function parseTerminalBenchResults(
  raw: unknown,
  suite = "terminal-bench-2",
): BenchmarkResultT {
  const tb = TerminalBenchResults.parse(raw);
  const tasks = tb.results.map((r) => ({
    taskId: r.task_id,
    resolved: r.is_resolved,
    failureMode: r.failure_mode ?? null,
    trial: r.trial_name ?? null,
  }));
  const nTasks = tasks.length;
  // Per-task `results` is the ground truth. Derive counts from it — never blindly trust the
  // provided aggregates. If a provided aggregate disagrees with the derived count, throw
  // `ResultMismatchError` naming both numbers so the caller can surface the discrepancy. An empty
  // suite filter (nTasks === 0) yields rate 0, no NaN.
  const nResolved = tasks.filter((t) => t.resolved).length;
  const nUnresolved = nTasks - nResolved;
  if (tb.n_resolved !== undefined && tb.n_resolved !== nResolved) {
    throw new ResultMismatchError(
      `n_resolved aggregate disagrees with per-task count: provided ${String(tb.n_resolved)}, derived ${String(nResolved)}`,
    );
  }
  if (tb.n_unresolved !== undefined && tb.n_unresolved !== nUnresolved) {
    throw new ResultMismatchError(
      `n_unresolved aggregate disagrees with per-task count: provided ${String(tb.n_unresolved)}, derived ${String(nUnresolved)}`,
    );
  }
  const resolvedRate = nTasks === 0 ? 0 : nResolved / nTasks;
  // I8: for this legacy aggregate shape, `accuracy` is parsed and RECONCILED against the derived
  // `resolvedRate` (the ground truth). It is NOT re-exported; `resolvedRate` is normative. A
  // discrepancy beyond a floating-point epsilon indicates the harness computed a different denominator
  // (e.g. filtered vs total tasks) and the caller must surface it rather than silently accept a
  // conflicting aggregate.
  //
  // DOC-LIMIT: Phase 1's real paid runs confirmed the Harbor path, not this legacy direct-TB aggregate
  // shape. Keep the 1e-9 tolerance for the synthetic/offline fixtures because it is fail-closed and
  // exact for those fixtures. If a future direct `tb` CLI import emits rounded display accuracy
  // (for example, 0.33 for a 1/3 run), widen the tolerance or drop the redundant `accuracy` check while
  // retaining the exact `n_resolved`/`n_unresolved` reconciliation above.
  if (tb.accuracy !== undefined && Math.abs(tb.accuracy - resolvedRate) > 1e-9) {
    throw new ResultMismatchError(
      `accuracy aggregate disagrees with derived resolvedRate: provided accuracy ${String(tb.accuracy)}, derived resolvedRate ${String(resolvedRate)}`,
    );
  }
  return BenchmarkResult.parse({ suite, nTasks, nResolved, nUnresolved, resolvedRate, tasks });
}
