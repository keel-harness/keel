import type { GoalCompletionAuditT, GoalT, SessionEventT, SessionIdT } from "@keel/shared";
import { stripControlLine } from "../control-strip.js";
import { terminalDisplayWidth } from "../tui/row-budget.js";
import { evaluateGoalCompletion, type GoalValidationResult } from "./goal-audit.js";
import { shellJoin } from "./run-control-parser.js";

const GOAL_RECEIPT_LINE_WIDTH = 72;
const goalReceiptGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function boundedGoalReceiptLine(value: string, maxWidth = GOAL_RECEIPT_LINE_WIDTH): string {
  const normalized = stripControlLine(value).trim().replace(/\s+/gu, " ");
  if (terminalDisplayWidth(normalized) <= maxWidth) return normalized;
  const limit = Math.max(0, maxWidth - 1);
  let output = "";
  let width = 0;
  for (const { segment } of goalReceiptGraphemes.segment(normalized)) {
    const next = terminalDisplayWidth(segment);
    if (width + next > limit) break;
    output += segment;
    width += next;
  }
  return maxWidth > 0 ? `${output.trimEnd()}…` : "";
}

function goalCheckSummary(goal: GoalT | undefined): string {
  if (goal === undefined) return "declared criteria retained in goal audit";
  const criterion = goal.doneWhen[0]!;
  const first =
    criterion.kind === "narrative"
      ? `evidence ${criterion.id}`
      : criterion.check.argv !== undefined
        ? shellJoin(criterion.check.argv)
        : `lifecycle ${criterion.check.action ?? "unknown"}`;
  return goal.doneWhen.length === 1
    ? first
    : `${String(goal.doneWhen.length)} declared · first ${first}`;
}

function goalEvidenceSummary(audit: GoalCompletionAuditT): string {
  const refs = [
    ...new Set(
      audit.criteria.flatMap((criterion) => criterion.evidence.map((evidence) => evidence.ref)),
    ),
  ];
  if (refs.length === 0) return "none";
  if (refs.length === 1) return `1 ref · ${boundedGoalReceiptLine(refs[0]!, 48)}`;
  return `${String(refs.length)} refs · first ${boundedGoalReceiptLine(refs[0]!, 18)} · last ${boundedGoalReceiptLine(refs[refs.length - 1]!, 18)}`;
}

export function goalPrompt(goal: GoalT): string {
  const checks = goal.doneWhen
    .map((criterion) => {
      if (criterion.kind === "command" && criterion.check.argv !== undefined) {
        return `- ${criterion.id}: run ${criterion.check.argv.join(" ")}`;
      }
      if (criterion.kind === "command") {
        return `- ${criterion.id}: run lifecycle action ${criterion.check.action}`;
      }
      return `- ${criterion.id}: cite evidence${criterion.evidenceHint !== undefined ? ` (${criterion.evidenceHint})` : ""}`;
    })
    .join("\n");
  return `Goal: ${goal.objective}\nCompletion evidence required:\n${checks}`;
}

export function appendGoalStarted(
  append: (event: SessionEventT) => void,
  goal: GoalT,
  ts = new Date().toISOString(),
): void {
  append({ type: "goal_started", v: 1, ts, goal });
}

export function appendGoalAudit(options: {
  readonly append: (event: SessionEventT) => void;
  readonly sessionId: SessionIdT;
  readonly goal: GoalT;
  readonly events: readonly SessionEventT[];
  /** The real result of running the goal's validation tier (Epic 2.15b). When absent, a configured
   *  tier falls back to the honest `not_run` — completion never fabricates a tier pass. */
  readonly validation?: GoalValidationResult;
  /** The user stopped this goal turn. Persist `aborted`, not the derived incomplete verdict. */
  readonly interrupted?: boolean;
  readonly ts?: string;
}): GoalCompletionAuditT {
  const ts = options.ts ?? new Date().toISOString();
  const validation: GoalValidationResult | undefined =
    options.validation ??
    (options.goal.validation !== undefined
      ? { status: "not_run", tier: options.goal.validation.tier }
      : undefined);
  const audit = evaluateGoalCompletion(options.goal, {
    events: options.events,
    ...(validation !== undefined ? { validation } : {}),
  });
  const auditRef = `goal_audit:${options.sessionId}:${options.goal.id}`;
  options.append({ type: "goal_audit", v: 1, ts, audit });
  if (audit.verdict === "complete") {
    options.append({
      type: "goal_completed",
      v: 1,
      ts,
      goalId: options.goal.id,
      auditRef,
    });
  } else {
    options.append({
      type: "goal_failed",
      v: 1,
      ts,
      goalId: options.goal.id,
      reason: options.interrupted === true ? "aborted" : audit.verdict,
      auditRef,
    });
  }
  return audit;
}

export function goalValidationFailureNotice(validation: GoalValidationResult): string | undefined {
  if (validation.status !== "failed" || validation.failedAction === undefined) return undefined;
  const action = validation.failedAction;
  if (validation.failureKind === "review") {
    return boundedGoalReceiptLine(
      `next · ${action}: approve live, or choose a non-reviewing check`,
    );
  }
  if (validation.failureKind === "blocked") {
    return boundedGoalReceiptLine(
      `next · ${action}: correct the policy boundary or check; rerun /goal`,
    );
  }
  if (validation.failureKind === "stopped") {
    return boundedGoalReceiptLine(`next · ${action}: inspect audit before rerunning /goal`);
  }
  return boundedGoalReceiptLine(`next · ${action}: fix the validation check; rerun /goal`);
}

export function goalAuditNotice(
  audit: GoalCompletionAuditT,
  goal?: GoalT,
  nextOverride?: string,
): string {
  const label = goal?.objective ?? audit.goalId;
  const satisfied = audit.criteria.filter((criterion) => criterion.status === "satisfied").length;
  const validation = `${audit.validation.tier !== undefined ? `${audit.validation.tier} · ` : ""}${audit.validation.status.replace("_", " ")}`;
  const gaps = audit.gaps.length > 0 ? audit.gaps.join(", ") : "none";
  let next =
    audit.verdict === "complete"
      ? "next · completion recorded; use the session audit for full evidence"
      : `next · resolve gaps (${gaps}), then rerun /goal`;
  // `unverified` (F-3 RC2a): every check passed but no validation tier was requested — an HONEST
  // terminal (ADR-0060), not a failure and not a gap the user must "resolve". Say so, and teach the
  // opt-in path rather than framing the absent validation as a defect.
  if (audit.verdict === "unverified") {
    next = "next · checks passed · add --validation <tier> (needs a lifecycle manifest) to verify";
  }
  // A configured tier that did not run (no lifecycle manifest declares it, or the turn was
  // interrupted) leaves the goal structurally un-completable. Teach the fix instead of just naming
  // the gap (what · why · how) — honest for both causes: declare the tier if missing, then re-run.
  if (audit.validation.status === "not_run" && audit.validation.tier !== undefined) {
    next = `next · declare ${audit.validation.tier} in lifecycle manifest validationTiers; rerun /goal`;
  }
  return [
    boundedGoalReceiptLine(`goal ${audit.verdict} · ${label}`),
    boundedGoalReceiptLine(`check · ${goalCheckSummary(goal)}`),
    boundedGoalReceiptLine(`verification · ${validation}`),
    boundedGoalReceiptLine(
      `criteria · ${String(satisfied)}/${String(audit.criteria.length)} satisfied · gaps: ${gaps}`,
    ),
    boundedGoalReceiptLine(`evidence · ${goalEvidenceSummary(audit)}`),
    nextOverride ?? boundedGoalReceiptLine(next),
  ].join("\n");
}
