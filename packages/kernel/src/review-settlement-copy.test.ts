import { describe, expect, it } from "vitest";
import {
  REVIEW_ACTION_INDETERMINATE_SUFFIX,
  REVIEW_DECISION_UNCONFIRMED_SUFFIX,
  REVIEW_DENIAL_UNCONFIRMED_SUFFIX,
  REVIEW_RESOLUTION_INDETERMINATE_SUFFIX,
  REVIEW_STILL_PENDING_SUFFIX,
  unexpectedReviewDenialOutput,
} from "./review-settlement-copy.js";

describe("review settlement copy", () => {
  it.each(["allow", "warn", "modify"] as const)(
    "keeps an unexpected %s denial indeterminate and non-retriable",
    (verdict) => {
      const output = unexpectedReviewDenialOutput(verdict);
      expect(output.endsWith(REVIEW_ACTION_INDETERMINATE_SUFFIX)).toBe(true);
      expect(output).toContain("may have executed");
      expect(output).not.toContain("not executed");
    },
  );

  it("keeps an unexpected review verdict pending and non-retriable", () => {
    const output = unexpectedReviewDenialOutput("review");
    expect(output.endsWith(REVIEW_STILL_PENDING_SUFFIX)).toBe(true);
    expect(output).toContain("may remain pending");
    expect(output).not.toContain("not executed");
  });

  it("keeps transport suffixes distinct and restart-biased", () => {
    expect(REVIEW_RESOLUTION_INDETERMINATE_SUFFIX).toContain("may have executed");
    expect(REVIEW_DENIAL_UNCONFIRMED_SUFFIX).toContain("may remain pending");
    expect(REVIEW_DECISION_UNCONFIRMED_SUFFIX).toContain("no approval assumed");
    expect(REVIEW_RESOLUTION_INDETERMINATE_SUFFIX).not.toBe(REVIEW_DENIAL_UNCONFIRMED_SUFFIX);
  });
});
