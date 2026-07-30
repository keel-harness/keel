import type { StopReasonT } from "@keel/shared";
import { stopCodeNeedsAttention } from "../events.js";
import type { GoalFailureReason } from "../tui/runner.js";

export interface RunExitOutcome {
  readonly lastStop?: StopReasonT;
  readonly lastStopCode?: string;
  readonly lastGoalFailure?: GoalFailureReason;
}

export function shouldExitNonZeroForRunOutcome(outcome: RunExitOutcome): boolean {
  if (outcome.lastGoalFailure !== undefined) return true;
  return (
    outcome.lastStop !== undefined &&
    (outcome.lastStop !== "model-stop" || stopCodeNeedsAttention(outcome.lastStopCode))
  );
}
