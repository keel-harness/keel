import { describe, expect, it } from "vitest";
import type { ToolResultT } from "@keel/shared";
import { toolPresentationOutcome } from "../tool-presentation-outcome.js";
import {
  isTerminalReviewRecoveryAvailable,
  isTerminalReviewResult,
  recoverableTerminalReviewResult,
  terminalReviewResult,
} from "./terminal-review.js";

describe("terminal review process-local markers", () => {
  it("opens recovery only for the explicit no-handle marker", () => {
    const ordinary = terminalReviewResult("review pending");
    const recoverable = recoverableTerminalReviewResult("no live review handle");

    expect(isTerminalReviewResult(ordinary)).toBe(true);
    expect(isTerminalReviewRecoveryAvailable(ordinary)).toBe(false);
    expect(isTerminalReviewResult(recoverable)).toBe(true);
    expect(isTerminalReviewRecoveryAvailable(recoverable)).toBe(true);
    expect(toolPresentationOutcome(recoverable)).toBe("blocked");
  });

  it("does not let serialized or replayed tool data manufacture recovery authority", () => {
    const recoverable = recoverableTerminalReviewResult("no live review handle");
    const replayed = JSON.parse(JSON.stringify(recoverable)) as ToolResultT;

    expect(replayed).toEqual({ ok: false, output: "no live review handle" });
    expect(isTerminalReviewResult(replayed)).toBe(false);
    expect(isTerminalReviewRecoveryAvailable(replayed)).toBe(false);
  });
});
