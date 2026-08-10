import { describe, expect, it } from "vitest";
import type { UiApprovalInformation } from "@keel/shared";
import {
  associateExactGitPushReviewInformation,
  exactGitPushReviewSummary,
  exactGitPushReviewSummaryForInformation,
  gitPushReviewSummaryForRequest,
} from "./git-push-review-presentation.js";

const oid = "0123456789abcdef0123456789abcdef01234567";
const summary = [
  "Git push requires approval.",
  "Repository: https://localhost:54321/repo.git",
  "Destination: refs/heads/feature/walking-skeleton",
  `Commit: ${oid}`,
  "Subject: walking skeleton commit",
  "Commit facts: 2026-08-10T12:00:00Z; 1; 2 files; +3 -1",
  "Workspace: clean; uncommitted changes are excluded",
  "Effect: create this branch or fast-forward it to this commit; the remote may receive every missing object reachable from the commit",
  "Blocked: force, deletion, tags, hooks, submodule recursion, redirects, and remote-default-branch writes",
  "Credential: deterministic test fixture (release capability withheld); secret stays in the Warden/SRT path",
  "Approval: this occurrence once; expires in 120 seconds",
].join("\n");

function information(value = summary): UiApprovalInformation {
  return {
    requestedAction: { status: "available", value: "git.push" },
    effectiveTarget: { status: "available", value, completeness: "complete" },
    reason: { status: "available", value: "Warden requires human authorization" },
    policyDetail: { status: "unavailable", reason: "not reported" },
    exactResource: { status: "unavailable", reason: "once-only occurrence" },
  };
}

describe("exact git.push review presentation", () => {
  it("admits only the exact once-only envelope and retains all eleven lines byte-for-byte", () => {
    const toolCall = {
      id: "call",
      name: "git.push",
      args: { remote: "origin", branch: "feature/walking-skeleton", expectedHead: oid },
    };
    expect(exactGitPushReviewSummary(summary)).toBe(true);
    expect(
      gitPushReviewSummaryForRequest(toolCall, {
        reviewId: "git_push_review_1",
        summary,
        allowCommand: "keel approve git_push_review_1 --scope once",
      }),
    ).toBe(summary);
    for (const review of [
      {
        reviewId: "git_push_review_0",
        summary,
        allowCommand: "keel approve git_push_review_0 --scope once",
      },
      {
        reviewId: "git_push_review_1",
        summary,
        allowCommand: "keel approve git_push_review_1 --scope session",
      },
    ]) {
      expect(gitPushReviewSummaryForRequest(toolCall, review)).toBeUndefined();
    }
  });

  it("rejects line, control, redaction, and bounded-layout drift", () => {
    for (const hostile of [
      summary.replace("Repository:", "Repo:"),
      summary.replace("Subject: walking", "Subject: walking\r"),
      summary.replace("walking skeleton commit", "[redacted:secret]"),
      summary.replace("walking skeleton commit", "x".repeat(2_049)),
      `${summary}\nextra`,
    ]) {
      expect(exactGitPushReviewSummary(hostile)).toBe(false);
    }
  });

  it("authenticates the retained information object and detects every later mutation", () => {
    const exact = information();
    expect(associateExactGitPushReviewInformation(exact, summary)).toBe(exact);
    expect(exactGitPushReviewSummaryForInformation(exact)).toBe(summary);
    (exact.effectiveTarget as { value: string }).value = `${summary} `;
    expect(exactGitPushReviewSummaryForInformation(exact)).toBeUndefined();

    expect(
      associateExactGitPushReviewInformation(information(`${summary} `), summary),
    ).toBeUndefined();
  });
});
