import { describe, expect, it } from "vitest";
import { BLOCKED_AFTER_SYNTHESIS_CODE, REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE } from "../events.js";
import { shouldExitNonZeroForRunOutcome } from "./exit-code.js";

describe("shouldExitNonZeroForRunOutcome", () => {
  it("treats clean model stops as success", () => {
    expect(shouldExitNonZeroForRunOutcome({ lastStop: "model-stop" })).toBe(false);
  });

  it("treats model-stop with needs-attention terminal detail as nonzero", () => {
    expect(
      shouldExitNonZeroForRunOutcome({
        lastStop: "model-stop",
        lastStopCode: REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE,
      }),
    ).toBe(true);
    expect(
      shouldExitNonZeroForRunOutcome({
        lastStop: "model-stop",
        lastStopCode: BLOCKED_AFTER_SYNTHESIS_CODE,
      }),
    ).toBe(true);
  });

  it("treats abnormal stop reasons as nonzero", () => {
    expect(shouldExitNonZeroForRunOutcome({ lastStop: "budget" })).toBe(true);
  });

  it("treats failed goal validation as nonzero even after a clean model stop", () => {
    expect(
      shouldExitNonZeroForRunOutcome({
        lastStop: "model-stop",
        lastGoalFailure: "incomplete",
      }),
    ).toBe(true);
  });
});
