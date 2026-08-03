import type { ToolResultT } from "@keel/shared";
import {
  markToolPresentationOutcome,
  type ToolPresentationOutcome,
} from "../tool-presentation-outcome.js";

const TERMINAL_REVIEW = Symbol("keel.terminal-review");
const TERMINAL_REVIEW_RECOVERY_AVAILABLE = Symbol("keel.terminal-review-recovery-available");

type TerminalReviewResult = ToolResultT & { readonly [TERMINAL_REVIEW]: true };
type RecoverableTerminalReviewResult = TerminalReviewResult & {
  readonly [TERMINAL_REVIEW_RECOVERY_AVAILABLE]: true;
};

/** Internal control-plane tag. It is intentionally non-wire and disappears from session/audit JSON. */
export function terminalReviewResult(
  output: string,
  outcome: ToolPresentationOutcome = "review",
): ToolResultT {
  const result: ToolResultT = { ok: false, output };
  Object.defineProperty(result, TERMINAL_REVIEW, { value: true });
  return markToolPresentationOutcome(result, outcome);
}

export function isTerminalReviewResult(result: ToolResultT): boolean {
  return (result as Partial<TerminalReviewResult>)[TERMINAL_REVIEW] === true;
}

/**
 * Marks the exact process-local terminal result for which no live human decision exists. The marker
 * is deliberately non-wire: serialized/replayed terminal results cannot manufacture a recovery
 * opportunity, and the fresh model-authored action still traverses the ordinary executor/Warden path.
 */
export function recoverableTerminalReviewResult(output: string): ToolResultT {
  const result = terminalReviewResult(output, "blocked");
  Object.defineProperty(result, TERMINAL_REVIEW_RECOVERY_AVAILABLE, { value: true });
  return result;
}

export function isTerminalReviewRecoveryAvailable(result: ToolResultT): boolean {
  return (
    isTerminalReviewResult(result) &&
    (result as Partial<RecoverableTerminalReviewResult>)[TERMINAL_REVIEW_RECOVERY_AVAILABLE] ===
      true
  );
}
