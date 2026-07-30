import type { ToolResultT } from "@keel/shared";
import {
  markToolPresentationOutcome,
  type ToolPresentationOutcome,
} from "../tool-presentation-outcome.js";

const TERMINAL_REVIEW = Symbol("keel.terminal-review");

type TerminalReviewResult = ToolResultT & { readonly [TERMINAL_REVIEW]: true };

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
