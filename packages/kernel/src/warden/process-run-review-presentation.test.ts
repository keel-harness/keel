import { describe, expect, it } from "vitest";
import type { UiApprovalInformation } from "@keel/shared";
import {
  PROCESS_RUN_REVIEW_PRESENTATION_MAX_BYTES,
  associateExactProcessRunReviewInformation,
  exactProcessRunReviewSummary,
  exactProcessRunReviewSummaryForInformation,
  isExactOnceProcessRunReviewRequest,
} from "./process-run-review-presentation.js";

function information(requestedAction: string, summary: string): UiApprovalInformation {
  return {
    requestedAction: { status: "available", value: requestedAction },
    effectiveTarget: { status: "available", value: summary, completeness: "complete" },
    reason: { status: "available", value: "Warden requires human authorization" },
    policyDetail: { status: "unavailable", reason: "not reported" },
    exactResource: { status: "unavailable", reason: "once only" },
  };
}

describe("exact process.run review presentation", () => {
  it("does not authenticate exact-summary storage for a different requested tool", () => {
    const summary = "exact argv: 'git' 'diff' ' repeated  spaces ' ''.";
    const wrongTool = information("bash", summary);

    expect(associateExactProcessRunReviewInformation(wrongTool, summary)).toBeUndefined();
    expect(exactProcessRunReviewSummaryForInformation(wrongTool)).toBeUndefined();
  });

  it("accepts only the strict process review id and once-only allow command", () => {
    const toolCall = { id: "call", name: "process.run", args: { argv: ["git", "diff"] } };

    expect(
      isExactOnceProcessRunReviewRequest(toolCall, {
        reviewId: "process_review_1",
        allowCommand: "keel approve process_review_1 --scope once",
      }),
    ).toBe(true);
    expect(
      isExactOnceProcessRunReviewRequest(toolCall, {
        reviewId: "process_review_1",
        allowCommand: "keel approve process_review_1 --scope project",
      }),
    ).toBe(false);
    expect(
      isExactOnceProcessRunReviewRequest(
        { ...toolCall, name: "bash" },
        {
          reviewId: "process_review_1",
          allowCommand: "keel approve process_review_1 --scope once",
        },
      ),
    ).toBe(false);
  });

  it("rejects summaries that cannot be carried byte-for-byte", () => {
    expect(exactProcessRunReviewSummary("exact argv: ' a  b ' ''.")).toBe(true);
    expect(exactProcessRunReviewSummary("")).toBe(false);
    expect(exactProcessRunReviewSummary("line one\nline two")).toBe(false);
    expect(exactProcessRunReviewSummary("zero\u200bwidth")).toBe(false);
    expect(exactProcessRunReviewSummary("unpaired\ud800surrogate")).toBe(false);
    expect(exactProcessRunReviewSummary("trailing-high\ud800")).toBe(false);
    expect(exactProcessRunReviewSummary("isolated-low\udc00")).toBe(false);
    expect(exactProcessRunReviewSummary("paired 😀 surrogate")).toBe(true);
    expect(
      exactProcessRunReviewSummary(
        "sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      ),
    ).toBe(false);
    expect(
      exactProcessRunReviewSummary("x".repeat(PROCESS_RUN_REVIEW_PRESENTATION_MAX_BYTES + 1)),
    ).toBe(false);
  });
});
