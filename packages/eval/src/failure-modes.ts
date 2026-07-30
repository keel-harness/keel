import { z } from "zod";
import type { TrajectoryT } from "./trajectory.js";
import {
  AggregateQualityMetrics,
  aggregateQualityMetrics,
  trajectoryQualityMetrics,
} from "./trajectory-metrics.js";

/**
 * The deterministic core of the §7/§2.3 failure-mode analysis workflow. Raw trajectories (not
 * summaries — the Meta-Harness ablation showed summary-only feedback halves achievable improvement) go
 * in; a structured, ranked failure-mode report comes out. This module does the **deterministic** half:
 * classify each unresolved task by a root-cause signature, group + rank them, and attach the §8.2
 * quality metrics. The **creative** half — proposing the targeted harness change for each mode — is the
 * LLM proposer (the `SKILL.md`): it reads this report PLUS the raw trajectories and fills each
 * `proposedChange`. Splitting it this way makes the factual scaffold reproducible + golden-testable with
 * zero spend, while the model does only the part that needs judgement.
 */

/** Root-cause signatures for an unresolved task, in priority order (most actionable/structural first). */
export const FailureSignature = z.enum([
  "invalid-tool-args", // the model emitted structurally-invalid tool arguments
  "premature-completion", // claimed/attempted done, but the grader says unresolved
  "error-cascade", // tool errors that were mostly not recovered from
  "ran-out-of-turns", // never reached a final answer (no terminal stop)
  "redundant-work", // looping / repeated identical tool calls
  "unresolved-other", // unresolved with no specific deterministic signal
]);
export type FailureSignatureT = z.infer<typeof FailureSignature>;

const SEVERITY: Record<FailureSignatureT, "high" | "medium" | "low"> = {
  "invalid-tool-args": "high",
  "premature-completion": "high",
  "error-cascade": "high",
  "ran-out-of-turns": "medium",
  "redundant-work": "medium",
  "unresolved-other": "low",
};
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

/** A resolvable reference to a stored trajectory (`<dir>/<suite>/<runId>/<task>.json`). */
export const TrajectoryRef = z
  .object({ suite: z.string().min(1), runId: z.string().min(1), task: z.string().min(1) })
  .strict();
export type TrajectoryRefT = z.infer<typeof TrajectoryRef>;

export const FailureMode = z
  .object({
    signature: FailureSignature,
    severity: z.enum(["high", "medium", "low"]),
    count: z.number().int().positive(),
    /** The unresolved tasks exhibiting this signature — each resolves to a stored trajectory. */
    trajectories: z.array(TrajectoryRef).min(1),
    /** Filled by the LLM proposer (SKILL.md). The deterministic analyzer leaves it null. */
    proposedChange: z.string().nullable(),
  })
  .strict();
export type FailureModeT = z.infer<typeof FailureMode>;

export const FailureModeReport = z
  .object({
    schemaVersion: z.literal(1),
    suite: z.string().min(1),
    totalTrajectories: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
    infraErrors: z.number().int().nonnegative(),
    /** Ranked: severity (high→low), then count (desc), then signature (asc) — deterministic. */
    failureModes: z.array(FailureMode),
    aggregateQuality: AggregateQualityMetrics,
  })
  .strict();
export type FailureModeReportT = z.infer<typeof FailureModeReport>;

/** Classify ONE unresolved trajectory by its root-cause signature (deterministic, priority-ordered). */
export function classifyFailure(traj: TrajectoryT): FailureSignatureT {
  const m = trajectoryQualityMetrics(traj);
  const reachedStop = traj.events.some((e) => e.type === "turn" && e.reason === "stop");
  if (m.toolCallArgValidityRate < 1) return "invalid-tool-args";
  if (m.completionAttempts > 0) return "premature-completion";
  if (m.toolErrors > 0 && m.errorRecoveryRate < 0.5) return "error-cascade";
  if (!reachedStop) return "ran-out-of-turns";
  if (m.redundantToolCalls >= 2) return "redundant-work";
  return "unresolved-other";
}

/**
 * Analyze a run's raw trajectories into a ranked failure-mode report (the deterministic scaffold).
 * Unresolved tasks are classified + grouped by signature; `infra-error` trajectories are counted
 * separately (§8.2: infra aborts are recorded distinctly, never as task failures) and excluded from the
 * quality aggregate. An empty or all-resolved input yields a report with no failure modes — never a crash.
 */
export function analyzeFailures(trajectories: readonly TrajectoryT[]): FailureModeReportT {
  let resolved = 0;
  let infraErrors = 0;
  const groups = new Map<FailureSignatureT, TrajectoryRefT[]>();
  const scored: TrajectoryT[] = []; // resolved + unresolved (excludes infra-error)

  for (const t of trajectories) {
    if (t.outcome === "infra-error") {
      infraErrors += 1;
      continue;
    }
    scored.push(t);
    if (t.outcome === "resolved") {
      resolved += 1;
      continue;
    }
    const sig = classifyFailure(t);
    const ref: TrajectoryRefT = { suite: t.suite, runId: t.runId, task: t.task };
    const arr = groups.get(sig);
    if (arr) arr.push(ref);
    else groups.set(sig, [ref]);
  }

  const failureModes: FailureModeT[] = [...groups.entries()]
    .map(([signature, trajs]) => ({
      signature,
      severity: SEVERITY[signature],
      count: trajs.length,
      trajectories: [...trajs].sort((a, b) => a.task.localeCompare(b.task)),
      proposedChange: null,
    }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        b.count - a.count ||
        a.signature.localeCompare(b.signature),
    );

  const unresolved = scored.length - resolved;
  return {
    schemaVersion: 1,
    suite: trajectories[0]?.suite ?? "terminal-bench-2",
    totalTrajectories: trajectories.length,
    resolved,
    unresolved,
    infraErrors,
    failureModes,
    aggregateQuality: aggregateQualityMetrics(scored),
  };
}
