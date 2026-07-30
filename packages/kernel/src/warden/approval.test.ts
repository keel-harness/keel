import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { WARDEN_METHODS } from "@keel/shared";
import {
  type PlanApprovalEnvelope,
  ScopedEgressApprovals,
  previewPlanApprovalEnvelope,
  reviewApprovalOptions,
  reviewApprovalPresentation,
  reviewHasSessionGrantResource,
  renderScopedApprovalBatch,
  renderPendingReviewCount,
  renderScopedApprovalLine,
} from "./approval.js";

type ExecuteResult = z.infer<(typeof WARDEN_METHODS)["warden.execute"]["result"]>;
type ResolveReviewParams = z.infer<(typeof WARDEN_METHODS)["warden.resolveReview"]["params"]>;
type ResolveReviewResult = z.infer<(typeof WARDEN_METHODS)["warden.resolveReview"]["result"]>;

const PRINCIPAL: ResolveReviewParams["principal"] = {
  osUser: "tester",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
};

const REVIEW_RESULT: ExecuteResult = {
  verdict: "review",
  review: {
    reviewId: "egress_review_1",
    summary:
      "egress to xn--bcher-kva.example (unicode: bücher.example) requires review: curl https://bücher.example",
    allowCommand: "keel approve egress_review_1 --scope once --domain xn--bcher-kva.example",
  },
  auditSeq: 0,
};

const COMMAND_REVIEW_RESULT: ExecuteResult = {
  verdict: "review",
  review: {
    reviewId: "command_review_1",
    summary:
      "command review for python3 in workspace /repo; exact command grant: python3 tools/check.py",
    allowCommand:
      "keel approve command_review_1 --scope once --command-key sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  auditSeq: 0,
};

const CONSOLE_REVIEW_RESULT: ExecuteResult = {
  verdict: "review",
  review: {
    reviewId: "console_review_1",
    summary: "console target qemu-alpine requires approval",
    allowCommand:
      "keel approve console_review_1 --scope once --console-target qemu-alpine --console-key sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  },
  auditSeq: 0,
};

const MCP_REVIEW_RESULT: ExecuteResult = {
  verdict: "review",
  review: {
    reviewId: "mcp_review_1",
    summary:
      "opaque local MCP call requires exact once-only approval: mcp__fixture__echo; arguments are not displayed; the MCP sandbox and live pin check remain enforced",
    allowCommand: "keel approve mcp_review_1 --scope once",
  },
  auditSeq: 0,
};

const PLAN_APPROVAL: PlanApprovalEnvelope = {
  planId: "plan_auth_fix",
  trustedWorkspace: true,
  resources: [
    { kind: "domain", value: "Example.COM" },
    {
      kind: "command-key",
      value: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  ],
};

describe("ScopedEgressApprovals", () => {
  it("does not offer persistent scopes when the warden review summary is abbreviated", () => {
    const review = {
      reviewId: "command_review_abbreviated",
      summary: "command review requires approval: prefix [93 chars omitted] dangerous-suffix",
      allowCommand:
        "keel approve command_review_abbreviated --scope once --command-key sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };

    expect(reviewApprovalOptions(review)).toEqual({ sessionAvailable: false });
    expect(reviewApprovalPresentation(review)).toEqual({
      summaryCompleteness: "abbreviated",
      exactResource: {
        status: "available",
        kind: "command-envelope",
        value: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      sessionAvailable: false,
    });
  });

  it("returns one strict presentation resource contract for domain, command, console, and generic reviews", () => {
    expect(reviewApprovalPresentation(REVIEW_RESULT.review!)).toEqual({
      summaryCompleteness: "complete",
      exactResource: {
        status: "available",
        kind: "domain",
        value: "xn--bcher-kva.example",
      },
      sessionAvailable: true,
    });
    expect(reviewApprovalPresentation(COMMAND_REVIEW_RESULT.review!)).toEqual({
      summaryCompleteness: "complete",
      exactResource: {
        status: "available",
        kind: "command-envelope",
        value: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      sessionAvailable: true,
    });
    expect(reviewApprovalPresentation(CONSOLE_REVIEW_RESULT.review!)).toEqual({
      summaryCompleteness: "complete",
      exactResource: {
        status: "available",
        kind: "console",
        target: "qemu-alpine",
        key: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      sessionAvailable: false,
    });
    expect(
      reviewApprovalPresentation({
        reviewId: "generic_review_1",
        summary: "generic review requires one-time approval",
        allowCommand: "keel approve generic_review_1 --scope once",
      }),
    ).toEqual({
      summaryCompleteness: "complete",
      exactResource: {
        status: "unavailable",
        reason: "no exact reusable resource in the Warden review",
      },
      sessionAvailable: false,
    });
  });
  it("renders scoped approval copy as one line with exact blast radius and no posture inflation", () => {
    const line = renderScopedApprovalLine(REVIEW_RESULT.review!);

    expect(line).toContain("xn--bcher-kva.example");
    expect(line).toContain("unicode: bücher.example");
    expect(line).toContain("[a] once");
    expect(line).toContain("[s] session");
    expect(line).not.toContain("[p] project");
    expect(line).toContain("configured through Project Autopilot");
    expect(line).toContain("[d] deny");
    expect(line).toContain("[?] why");
    expect(line).toContain("exact domain only");
    expect(line).toContain(
      "allow: keel approve egress_review_1 --scope once --domain xn--bcher-kva.example",
    );
    expect(line).not.toMatch(/\n|policy|audit|verified/i);
  });

  it("strips ANSI and control bytes from scoped approval copy", () => {
    const line = renderScopedApprovalLine({
      reviewId: "egress_review_ansi",
      summary:
        "egress to example.com requires review:\n\u001b[31mcurl https://example.com\u001b[0m",
      allowCommand: "keel approve egress_review_ansi --scope once --domain example.com",
    });

    expect(line).toContain("curl https://example.com");
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("\n");
  });

  it("renders command scoped approval copy with exact session and project scopes", () => {
    const line = renderScopedApprovalLine(COMMAND_REVIEW_RESULT.review!);

    expect(line).toContain("command review");
    expect(line).toContain("[a] once");
    expect(line).toContain("[s] session");
    expect(line).not.toContain("[p] project");
    expect(line).toContain("configured through Project Autopilot");
    expect(line).toContain("[d] deny");
    expect(line).toContain("[?] why");
    expect(line).toContain("exact command envelope only");
    expect(line).not.toMatch(/\n|verified/i);
  });

  it("renders a generic once-only command review without remembered-scope affordances", () => {
    const review = {
      reviewId: "command_review_once_1",
      summary: "workspace file deletion requires approval: rm obsolete.txt",
      allowCommand: "keel approve command_review_once_1 --scope once",
    };

    expect(reviewApprovalOptions(review)).toEqual({ sessionAvailable: false });
    expect(reviewHasSessionGrantResource(review)).toBe(false);
    const line = renderScopedApprovalLine(review);
    expect(line).toContain("command review");
    expect(line).toContain("workspace file deletion requires approval: rm obsolete.txt");
    expect(line).toContain("[a] once");
    expect(line).toContain("[d] deny");
    expect(line).toContain("[?] why");
    expect(line).toContain("this action only");
    expect(line).not.toContain("[s] session");
    expect(line).not.toContain("Project Autopilot");
    expect(line).not.toContain("domain");
    expect(line).not.toContain("command-key");
  });

  it("renders an MCP review as exact once-only authority with no remembered scope", () => {
    const review = MCP_REVIEW_RESULT.review!;

    expect(reviewApprovalOptions(review)).toEqual({ sessionAvailable: false });
    expect(reviewHasSessionGrantResource(review)).toBe(false);
    expect(reviewApprovalPresentation(review)).toEqual({
      summaryCompleteness: "complete",
      exactResource: {
        status: "unavailable",
        reason: "no exact reusable resource in the Warden review",
      },
      sessionAvailable: false,
    });
    const line = renderScopedApprovalLine(review);
    expect(line).toContain("mcp review");
    expect(line).toContain("mcp__fixture__echo");
    expect(line).toContain("arguments are not displayed");
    expect(line).toContain("[a] once");
    expect(line).toContain("[d] deny");
    expect(line).toContain("[?] why");
    expect(line).toContain("exact local MCP call only");
    expect(line).not.toContain("[s] session");
    expect(line).not.toContain("[p] project");
    expect(line).not.toContain("Project Autopilot");
  });

  it("qualifies project persistence without promising that later policy checks are bypassed", () => {
    for (const candidate of [REVIEW_RESULT.review!, COMMAND_REVIEW_RESULT.review!]) {
      const impact = reviewApprovalOptions(candidate).project?.impact ?? "";

      expect(impact).toContain("this workspace");
      expect(impact).toContain("policy/provenance checks still apply");
      expect(impact).toContain("keel autopilot grants revoke");
      expect(impact).not.toContain("will not ask again");
    }
  });

  it("renders console review copy without egress or project-autopilot affordances", () => {
    const line = renderScopedApprovalLine(CONSOLE_REVIEW_RESULT.review!);

    expect(line).toContain("console review");
    expect(line).toContain("console target qemu-alpine requires approval");
    expect(line).toContain("[a] once");
    expect(line).toContain("[d] deny");
    expect(line).toContain("[?] why");
    expect(line).toContain("exact console target only");
    expect(line).toContain("--console-target qemu-alpine");
    expect(line).toContain(
      "--console-key sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(line).not.toContain("egress review");
    expect(line).not.toContain("exact domain only");
    expect(line).not.toContain("[s] session");
    expect(line).not.toContain("[p] project");
    expect(line).not.toContain("requires Project Autopilot");
    expect(reviewHasSessionGrantResource(CONSOLE_REVIEW_RESULT.review!)).toBe(false);
  });

  it("renders review queue counts without interrupt-copy when there is no pending review", () => {
    expect(renderPendingReviewCount(0)).toBeUndefined();
    expect(renderPendingReviewCount(1)).toBe("1 review item pending");
    expect(renderPendingReviewCount(3)).toBe("3 review items pending");
  });

  it("renders a batched review queue without inflating posture or authority", () => {
    const batch = renderScopedApprovalBatch([COMMAND_REVIEW_RESULT.review!, REVIEW_RESULT.review!]);

    expect(batch).toContain("2 review items pending");
    expect(batch).toContain("1. command review:");
    expect(batch).toContain("2. egress review:");
    expect(batch).toContain("exact command envelope only");
    expect(batch).toContain("exact domain only");
    expect(batch).toContain("configured through Project Autopilot");
    expect(batch).not.toMatch(/verified|audit/i);
    expect(batch).not.toContain("\u001b");
  });

  it("applies session grants through the frozen once review primitive for exact domains only", async () => {
    const approvals = new ScopedEgressApprovals();
    approvals.rememberSessionGrant(REVIEW_RESULT.review!);
    const calls: ResolveReviewParams[] = [];
    const client = {
      async call(
        method: "warden.resolveReview",
        params: ResolveReviewParams,
      ): Promise<ResolveReviewResult> {
        expect(method).toBe("warden.resolveReview");
        calls.push(params);
        return { verdict: "allow", result: "ok", auditSeq: 0 };
      },
    };

    await expect(approvals.tryApplySessionGrant(REVIEW_RESULT, client, PRINCIPAL)).resolves.toEqual(
      {
        verdict: "allow",
        result: "ok",
        auditSeq: 0,
      },
    );

    expect(calls).toEqual([
      {
        reviewId: "egress_review_1",
        approved: true,
        principal: PRINCIPAL,
        scope: "once",
      },
    ]);
    expect(
      approvals.canApplySessionGrant({
        reviewId: "egress_review_2",
        summary: "egress to example.com requires review: curl https://example.com",
        allowCommand: "keel approve egress_review_2 --scope once --domain example.com",
      }),
    ).toBe(false);
  });

  it("applies session command grants through the frozen once review primitive for exact keys only", async () => {
    const approvals = new ScopedEgressApprovals();
    expect(approvals.rememberSessionGrant(COMMAND_REVIEW_RESULT.review!)).toBe(true);
    const calls: ResolveReviewParams[] = [];
    const client = {
      async call(
        method: "warden.resolveReview",
        params: ResolveReviewParams,
      ): Promise<ResolveReviewResult> {
        expect(method).toBe("warden.resolveReview");
        calls.push(params);
        return { verdict: "allow", result: "command-ok", auditSeq: 3 };
      },
    };

    await expect(
      approvals.tryApplySessionGrant(COMMAND_REVIEW_RESULT, client, PRINCIPAL),
    ).resolves.toEqual({
      verdict: "allow",
      result: "command-ok",
      auditSeq: 3,
    });

    expect(calls).toEqual([
      {
        reviewId: "command_review_1",
        approved: true,
        principal: PRINCIPAL,
        scope: "once",
      },
    ]);
    expect(
      approvals.canApplySessionGrant({
        reviewId: "command_review_2",
        summary: "command review for python3 in workspace /repo",
        allowCommand:
          "keel approve command_review_2 --scope once --command-key sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).toBe(false);
  });

  it("applies trusted plan-approved resources through the frozen once review primitive", async () => {
    const approvals = new ScopedEgressApprovals();
    expect(approvals.rememberPlanApproval(PLAN_APPROVAL)).toEqual({
      planId: "plan_auth_fix",
      accepted: 2,
      rejected: 0,
    });
    const calls: ResolveReviewParams[] = [];
    const client = {
      async call(
        method: "warden.resolveReview",
        params: ResolveReviewParams,
      ): Promise<ResolveReviewResult> {
        expect(method).toBe("warden.resolveReview");
        calls.push(params);
        return { verdict: "allow", result: "plan-command-ok", auditSeq: 4 };
      },
    };

    await expect(
      approvals.tryApplySessionGrant(COMMAND_REVIEW_RESULT, client, PRINCIPAL),
    ).resolves.toEqual({
      verdict: "allow",
      result: "plan-command-ok",
      auditSeq: 4,
    });
    expect(
      approvals.canApplySessionGrant({
        reviewId: "egress_review_plan",
        summary: "egress to example.com requires review: curl https://example.com",
        allowCommand: "keel approve egress_review_plan --scope once --domain example.com",
      }),
    ).toBe(true);
    expect(
      approvals.canApplySessionGrant({
        reviewId: "command_review_different",
        summary: "command review for node in workspace /repo",
        allowCommand:
          "keel approve command_review_different --scope once --command-key sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).toBe(false);
    expect(calls).toEqual([
      {
        reviewId: "command_review_1",
        approved: true,
        principal: PRINCIPAL,
        scope: "once",
      },
    ]);
  });

  it("attributes plan-approved review applications to the active plan", async () => {
    const approvals = new ScopedEgressApprovals();
    approvals.rememberPlanApproval(PLAN_APPROVAL);
    const applications: unknown[] = [];

    await approvals.tryApplySessionGrant(
      COMMAND_REVIEW_RESULT,
      {
        async call(
          method: "warden.resolveReview",
          params: ResolveReviewParams,
        ): Promise<ResolveReviewResult> {
          expect(method).toBe("warden.resolveReview");
          expect(params.scope).toBe("once");
          return { verdict: "allow", result: "plan-command-ok", auditSeq: 4 };
        },
      },
      PRINCIPAL,
      undefined,
      (application) => {
        applications.push(application);
      },
    );

    expect(applications).toEqual([
      {
        source: "plan-approval",
        planId: "plan_auth_fix",
        resource: {
          kind: "command-key",
          value: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        reviewId: "command_review_1",
        scope: "once",
        auditSeq: 4,
        verdict: "allow",
      },
    ]);
  });

  it("does not wait for scoped approval attribution observers before returning the resolved verdict", async () => {
    const approvals = new ScopedEgressApprovals();
    approvals.rememberPlanApproval(PLAN_APPROVAL);
    let observerStarted = false;

    const result = await Promise.race([
      approvals.tryApplySessionGrant(
        COMMAND_REVIEW_RESULT,
        {
          async call(): Promise<ResolveReviewResult> {
            return { verdict: "allow", result: "plan-command-ok", auditSeq: 4 };
          },
        },
        PRINCIPAL,
        undefined,
        () => {
          observerStarted = true;
          return new Promise<never>(() => {});
        },
      ),
      new Promise((resolve) => setTimeout(() => resolve("observer timed out"), 25)),
    ]);

    expect(observerStarted).toBe(true);
    expect(result).toEqual({
      verdict: "allow",
      result: "plan-command-ok",
      auditSeq: 4,
    });
  });

  it("does not remember untrusted or malformed plan approval resources", () => {
    const approvals = new ScopedEgressApprovals();
    expect(
      approvals.rememberPlanApproval({
        planId: "plan_untrusted",
        trustedWorkspace: false,
        resources: [
          { kind: "domain", value: "example.com" },
          {
            kind: "command-key",
            value: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ],
      }),
    ).toEqual({ planId: "plan_untrusted", accepted: 0, rejected: 2 });
    expect(
      approvals.rememberPlanApproval({
        planId: "plan_wildcard",
        trustedWorkspace: true,
        resources: [
          { kind: "domain", value: "*.example.com" },
          { kind: "domain", value: "example.com/path" },
          { kind: "domain", value: "127.0.0.1" },
          { kind: "domain", value: "localhost" },
          { kind: "domain", value: "singlelabel" },
          { kind: "command-key", value: "sha256:not-a-real-key" },
        ],
      }),
    ).toEqual({ planId: "plan_wildcard", accepted: 0, rejected: 6 });
    expect(approvals.canApplySessionGrant(REVIEW_RESULT.review!)).toBe(false);
    expect(approvals.canApplySessionGrant(COMMAND_REVIEW_RESULT.review!)).toBe(false);
  });

  it("keeps plan approvals scoped to the active plan and separate from session grants", () => {
    const approvals = new ScopedEgressApprovals();
    approvals.rememberSessionGrant(REVIEW_RESULT.review!);
    expect(approvals.rememberPlanApproval(PLAN_APPROVAL)).toEqual({
      planId: "plan_auth_fix",
      accepted: 2,
      rejected: 0,
    });

    expect(approvals.canApplySessionGrant(REVIEW_RESULT.review!)).toBe(false);
    expect(approvals.canApplySessionGrant(COMMAND_REVIEW_RESULT.review!)).toBe(true);
    expect(approvals.clearPlanApproval("wrong_plan")).toBe(false);
    expect(approvals.canApplySessionGrant(COMMAND_REVIEW_RESULT.review!)).toBe(true);
    expect(approvals.clearPlanApproval("plan_auth_fix")).toBe(true);

    expect(approvals.canApplySessionGrant(REVIEW_RESULT.review!)).toBe(true);
    expect(approvals.canApplySessionGrant(COMMAND_REVIEW_RESULT.review!)).toBe(false);
  });

  it("rejects malformed runtime plan resources instead of treating unknown kinds as command keys", () => {
    const approvals = new ScopedEgressApprovals();
    expect(approvals.rememberPlanApproval(PLAN_APPROVAL)).toEqual({
      planId: "plan_auth_fix",
      accepted: 2,
      rejected: 0,
    });
    expect(approvals.canApplySessionGrant(COMMAND_REVIEW_RESULT.review!)).toBe(true);

    const malformed = {
      planId: "plan_malformed",
      trustedWorkspace: true,
      resources: [
        {
          kind: "file-root",
          value: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        { kind: "command-key", value: 7 },
      ],
    } as unknown as PlanApprovalEnvelope;

    expect(approvals.rememberPlanApproval(malformed)).toEqual({
      planId: "plan_malformed",
      accepted: 0,
      rejected: 2,
    });
    expect(approvals.canApplySessionGrant(COMMAND_REVIEW_RESULT.review!)).toBe(false);

    const stringTrusted = {
      planId: "plan_string_trusted",
      trustedWorkspace: "true",
      resources: [
        {
          kind: "command-key",
          value: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ],
    } as unknown as PlanApprovalEnvelope;

    expect(approvals.rememberPlanApproval(stringTrusted)).toEqual({
      planId: "plan_string_trusted",
      accepted: 0,
      rejected: 1,
    });
    expect(approvals.canApplySessionGrant(COMMAND_REVIEW_RESULT.review!)).toBe(false);
  });

  it("previews missing and overlarge plan resources as rejected without authority", () => {
    expect(previewPlanApprovalEnvelope({ planId: "\u001b[31m\n", trustedWorkspace: true })).toEqual(
      {
        planId: "plan",
        trustedWorkspace: true,
        acceptedResources: [],
        rejectedResources: [
          {
            kind: "resource",
            value: "(invalid)",
            reason: "missing resources",
          },
        ],
      },
    );

    const resources = Array.from({ length: 129 }, (_, index) => ({
      kind: index === 0 ? "\u001b[31mdomain\nkind" : "domain",
      value: index === 0 ? "\u001b[32mExample.COM\n" : "example.com",
    }));

    const preview = previewPlanApprovalEnvelope({
      planId: "too_many",
      trustedWorkspace: true,
      resources,
    });

    expect(preview.planId).toBe("too_many");
    expect(preview.trustedWorkspace).toBe(true);
    expect(preview.acceptedResources).toEqual([]);
    expect(preview.rejectedResources).toHaveLength(129);
    expect(preview.rejectedResources[0]).toEqual({
      kind: "domain kind",
      value: "Example.COM",
      reason: "too many resources (max 128)",
    });
    expect(preview.rejectedResources[1]?.reason).toBe("too many resources (max 128)");
  });

  it("previews exact plan resources with fail-closed rejected-resource reasons", () => {
    const preview = previewPlanApprovalEnvelope({
      planId: "resource_preview",
      trustedWorkspace: true,
      resources: [
        { kind: "domain", value: "Example.COM" },
        {
          kind: "command-key",
          value: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        undefined,
        { kind: "domain", value: "0x7f.example" },
        { kind: "file-root", value: "/tmp/project" },
        { kind: "command-key", value: "sha256:not-a-key" },
        { kind: "command-key", value: 7 },
      ],
    });

    expect(preview).toEqual({
      planId: "resource_preview",
      trustedWorkspace: true,
      acceptedResources: [
        { kind: "domain", value: "example.com" },
        {
          kind: "command-key",
          value: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ],
      rejectedResources: [
        { kind: "resource", value: "(invalid)", reason: "invalid resource" },
        { kind: "domain", value: "0x7f.example", reason: "invalid exact domain" },
        { kind: "file-root", value: "/tmp/project", reason: "unknown resource kind" },
        { kind: "command-key", value: "sha256:not-a-key", reason: "invalid command key" },
        { kind: "command-key", value: "(invalid)", reason: "invalid resource" },
      ],
    });
  });

  it("ignores invalid session domains and non-review results", async () => {
    const approvals = new ScopedEgressApprovals(["  "]);
    const review = {
      reviewId: "egress_review_missing_domain",
      summary: "egress requires review",
      allowCommand: "keel approve egress_review_missing_domain --scope once",
    };

    expect(approvals.rememberSessionGrant(review)).toBe(false);
    expect(approvals.canApplySessionGrant(review)).toBe(false);
    await expect(
      approvals.tryApplySessionGrant(
        { verdict: "deny", guidance: "blocked", auditSeq: 0 },
        {
          async call(): Promise<ResolveReviewResult> {
            throw new Error("should not resolve non-review result");
          },
        },
        PRINCIPAL,
      ),
    ).resolves.toBeUndefined();
  });
});
