import { describe, expect, it } from "vitest";
import type { UiApprovalInformation } from "@keel/shared";
import {
  associateExactGithubPrCreateReviewInformation,
  exactGithubPrCreateReviewSummary,
  exactGithubPrCreateReviewSummaryForInformation,
  githubPrCreateReviewSummaryForRequest,
} from "./github-pr-create-review-presentation.js";

const oid = "0123456789abcdef0123456789abcdef01234567";
const summary = [
  "GitHub pull request creation requires approval.",
  "Repository: keel-harness/keel",
  "Remote: https://github.com/keel-harness/keel.git",
  `Head: refs/heads/feature/pr @ ${oid}`,
  "Base: refs/heads/main",
  'Title JSON: "Ship the feature"',
  'Body JSON: "Summary\\n\\n- exact behavior"',
  "Draft: no",
  "Maintainers may modify: yes",
  "Effect: create one GitHub pull request and trigger repository notifications",
  "Blocked: merge, auto-merge, labels, reviews, releases, deployments, and branch mutation",
  "Credential: operator Git credential helper (system/global config); token stays in the Warden/SRT path",
  "Approval: this occurrence once; expires in 120 seconds",
].join("\n");

const toolCall = {
  id: "call",
  name: "github.pr.create",
  args: {
    remote: "origin",
    repository: "keel-harness/keel",
    head: "feature/pr",
    expectedHead: oid,
    base: "main",
    title: "Ship the feature",
    body: "Summary\n\n- exact behavior",
    draft: false,
    maintainerCanModify: true,
  },
};

function information(value = summary): UiApprovalInformation {
  return {
    requestedAction: { status: "available", value: "github.pr.create" },
    effectiveTarget: { status: "available", value, completeness: "complete" },
    reason: { status: "available", value: "Warden requires human authorization" },
    policyDetail: { status: "unavailable", reason: "not reported" },
    exactResource: { status: "unavailable", reason: "once-only occurrence" },
  };
}

describe("exact github.pr.create review presentation", () => {
  it("authenticates all thirteen lines against the exact tool request", () => {
    expect(exactGithubPrCreateReviewSummary(summary)).toBe(true);
    expect(
      githubPrCreateReviewSummaryForRequest(toolCall, {
        reviewId: "github_pr_create_review_1",
        summary,
        allowCommand: "keel approve github_pr_create_review_1 --scope once",
      }),
    ).toBe(summary);

    for (const changed of [
      summary.replace("keel-harness/keel\n", "attacker/repo\n"),
      summary.replace(`@ ${oid}`, `@ ${"f".repeat(40)}`),
      summary.replace("refs/heads/main", "refs/heads/release"),
      summary.replace('"Ship the feature"', '"Ship something else"'),
      summary.replace("Draft: no", "Draft: yes"),
      summary.replace("Maintainers may modify: yes", "Maintainers may modify: no"),
    ]) {
      expect(
        githubPrCreateReviewSummaryForRequest(toolCall, {
          reviewId: "github_pr_create_review_1",
          summary: changed,
          allowCommand: "keel approve github_pr_create_review_1 --scope once",
        }),
      ).toBeUndefined();
    }

    const specialTitle = '"\\\b\f\r\t\u0085\u2028\u202e😀';
    const specialTitleJson = '"\\"\\\\\\b\\f\\r\\t\\u0085\\u2028\\u202e😀"';
    expect(JSON.parse(specialTitleJson)).toBe(specialTitle);
    const specialSummary = summary
      .replace('Title JSON: "Ship the feature"', `Title JSON: ${specialTitleJson}`)
      .replace("Draft: no", "Draft: yes")
      .replace("Maintainers may modify: yes", "Maintainers may modify: no");
    expect(
      githubPrCreateReviewSummaryForRequest(
        {
          ...toolCall,
          args: {
            ...toolCall.args,
            title: specialTitle,
            draft: true,
            maintainerCanModify: false,
          },
        },
        {
          reviewId: "github_pr_create_review_2",
          summary: specialSummary,
          allowCommand: "keel approve github_pr_create_review_2 --scope once",
        },
      ),
    ).toBe(specialSummary);
  });

  it("rejects ID, scope, framing, redaction, control, and layout drift", () => {
    for (const review of [
      {
        reviewId: "github_pr_create_review_0",
        summary,
        allowCommand: "keel approve github_pr_create_review_0 --scope once",
      },
      {
        reviewId: "github_pr_create_review_1",
        summary,
        allowCommand: "keel approve github_pr_create_review_1 --scope project",
      },
      {
        reviewId: "github_pr_create_review_1",
        summary: summary.replace("Ship the feature", "[redacted:secret]"),
        allowCommand: "keel approve github_pr_create_review_1 --scope once",
      },
      {
        reviewId: "github_pr_create_review_1",
        summary: `${summary}\nextra`,
        allowCommand: "keel approve github_pr_create_review_1 --scope once",
      },
    ]) {
      expect(githubPrCreateReviewSummaryForRequest(toolCall, review)).toBeUndefined();
    }

    expect(exactGithubPrCreateReviewSummary("")).toBe(false);
    expect(exactGithubPrCreateReviewSummary(`${summary}\ud800`)).toBe(false);
    expect(
      exactGithubPrCreateReviewSummary(
        summary.replace('Title JSON: "Ship the feature"', "Title JSON: nope"),
      ),
    ).toBe(false);
    expect(
      exactGithubPrCreateReviewSummary(
        summary.replace('Body JSON: "Summary\\n\\n- exact behavior"', "Body JSON: 7"),
      ),
    ).toBe(false);
    expect(
      exactGithubPrCreateReviewSummary(summary.replace("Repository: ", "Repository: \u202e")),
    ).toBe(false);
    expect(exactGithubPrCreateReviewSummary(summary.replace("Repository: ", "Repo: "))).toBe(false);
    expect(
      githubPrCreateReviewSummaryForRequest(
        { ...toolCall, name: "git.push" },
        {
          reviewId: "github_pr_create_review_1",
          summary,
          allowCommand: "keel approve github_pr_create_review_1 --scope once",
        },
      ),
    ).toBeUndefined();
    expect(
      githubPrCreateReviewSummaryForRequest(
        { ...toolCall, args: { ...toolCall.args, draft: "no" } },
        {
          reviewId: "github_pr_create_review_1",
          summary,
          allowCommand: "keel approve github_pr_create_review_1 --scope once",
        },
      ),
    ).toBeUndefined();
    expect(
      githubPrCreateReviewSummaryForRequest(
        { ...toolCall, args: { ...toolCall.args, title: "broken\ud800" } },
        {
          reviewId: "github_pr_create_review_1",
          summary,
          allowCommand: "keel approve github_pr_create_review_1 --scope once",
        },
      ),
    ).toBeUndefined();
  });

  it("authenticates retained approval information and detects later mutation", () => {
    const exact = information();
    expect(associateExactGithubPrCreateReviewInformation(exact, summary)).toBe(exact);
    expect(exactGithubPrCreateReviewSummaryForInformation(exact)).toBe(summary);
    (exact.effectiveTarget as { value: string }).value = `${summary} `;
    expect(exactGithubPrCreateReviewSummaryForInformation(exact)).toBeUndefined();
    expect(exactGithubPrCreateReviewSummaryForInformation(undefined)).toBeUndefined();
    expect(
      associateExactGithubPrCreateReviewInformation(
        {
          ...information(),
          requestedAction: { status: "available", value: "git.push" },
        },
        summary,
      ),
    ).toBeUndefined();
  });
});
