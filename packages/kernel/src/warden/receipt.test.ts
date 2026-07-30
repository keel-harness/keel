import { describe, expect, it } from "vitest";
import type { SessionEventT } from "@keel/shared";
import {
  appendWardenAutoResolvedEvent,
  renderAutoResolutionReceipt,
  summarizeAutoResolutionReceipt,
} from "./receipt.js";

const ts = "2026-07-06T20:00:00.000Z";
const commandKey = `sha256:${"a".repeat(64)}`;

describe("auto-resolution receipt ledger facts", () => {
  it("appends warden auto-resolution facts as session-ledger metadata events", () => {
    const events: SessionEventT[] = [];

    appendWardenAutoResolvedEvent(
      { append: (event) => events.push(event) },
      {
        source: "plan-approval",
        planId: "plan_auth_fix",
        resource: { kind: "command-key", value: commandKey },
        reviewId: "command_review_1",
        scope: "once",
        auditSeq: 5,
        verdict: "allow",
        toolCallId: "call_bash",
        toolName: "bash",
      },
      () => ts,
    );

    expect(events).toEqual([
      {
        type: "warden_auto_resolved",
        v: 1,
        ts,
        source: "plan-approval",
        planId: "plan_auth_fix",
        resource: { kind: "command-key", value: commandKey },
        reviewId: "command_review_1",
        scope: "once",
        auditSeq: 5,
        verdict: "allow",
        toolCallId: "call_bash",
        toolName: "bash",
      },
    ]);
  });

  it("renders allowed automatic actions only from session-ledger facts", () => {
    const receipt = renderAutoResolutionReceipt([
      {
        type: "warden_auto_resolved",
        v: 1,
        ts,
        source: "plan-approval",
        planId: "plan_auth_fix",
        resource: { kind: "command-key", value: commandKey },
        reviewId: "command_review_1",
        scope: "once",
        auditSeq: 5,
        verdict: "allow",
        toolCallId: "call_bash",
        toolName: "bash",
      },
      {
        type: "warden_auto_resolved",
        v: 1,
        ts,
        source: "session-grant",
        resource: { kind: "domain", value: "example.com" },
        reviewId: "egress_review_1",
        scope: "once",
        auditSeq: 6,
        verdict: "deny",
        toolCallId: "call_curl",
        toolName: "bash",
      },
    ]);

    expect(receipt).toBe(
      [
        "Auto-resolution receipt",
        "allowed automatically:",
        `- Plan Autopilot plan_auth_fix allowed bash via command-key ${commandKey} (review command_review_1, audit #5)`,
        "not auto-allowed:",
        "- session grant (until session exit) resolved deny for bash via domain example.com (review egress_review_1, audit #6)",
      ].join("\n"),
    );
  });

  it("summarizes receipt facts into public Done-card lines", () => {
    const summary = summarizeAutoResolutionReceipt([
      {
        type: "warden_auto_resolved",
        v: 1,
        ts,
        source: "plan-approval",
        planId: "plan_auth_fix",
        resource: { kind: "command-key", value: commandKey },
        reviewId: "command_review_1",
        scope: "once",
        auditSeq: 5,
        verdict: "allow",
        toolCallId: "call_bash",
        toolName: "bash",
      },
      {
        type: "warden_auto_resolved",
        v: 1,
        ts,
        source: "session-grant",
        resource: { kind: "domain", value: "example.com" },
        reviewId: "egress_review_1",
        scope: "once",
        auditSeq: 6,
        verdict: "deny",
        toolCallId: "call_curl",
        toolName: "bash",
      },
    ]);

    expect(summary).toEqual({
      automatic: [
        `Plan Autopilot plan_auth_fix allowed bash via command-key ${commandKey} (review command_review_1, audit #5)`,
      ],
      attention: [
        "session grant (until session exit) resolved deny for bash via domain example.com (review egress_review_1, audit #6)",
      ],
    });
  });

  it("control-strips receipt facts before rendering", () => {
    const receipt = renderAutoResolutionReceipt([
      {
        type: "warden_auto_resolved",
        v: 1,
        ts,
        source: "plan-approval",
        planId: "plan\u001b[31m\nid",
        resource: { kind: "domain", value: "example.com" },
        reviewId: "review\u001b[31m\n1",
        scope: "once",
        auditSeq: 1,
        verdict: "allow",
        toolCallId: "call",
        toolName: "bash\u001b[31m\n",
      },
    ]);

    expect(receipt).toContain("Plan Autopilot plan id allowed bash via domain example.com");
    expect(receipt).not.toContain("\u001b");
    expect(receipt).not.toContain("\n1, audit");
  });

  it("bounds long receipt labels without rejecting the stored fact", () => {
    const longPlanId = `plan_${"p".repeat(240)}`;
    const longReviewId = `review_${"r".repeat(240)}`;
    const longToolName = `tool_${"t".repeat(240)}`;
    const events: SessionEventT[] = [];

    appendWardenAutoResolvedEvent(
      { append: (event) => events.push(event) },
      {
        source: "plan-approval",
        planId: longPlanId,
        resource: { kind: "command-key", value: commandKey },
        reviewId: longReviewId,
        scope: "once",
        auditSeq: 8,
        verdict: "allow",
        toolCallId: `call_${"c".repeat(240)}`,
        toolName: longToolName,
      },
      () => ts,
    );

    expect(events[0]).toMatchObject({
      type: "warden_auto_resolved",
      planId: longPlanId,
      reviewId: longReviewId,
      toolName: longToolName,
    });

    const receipt = renderAutoResolutionReceipt(events);
    expect(receipt).toContain("...");
    for (const line of receipt?.split("\n") ?? []) {
      expect(line.length).toBeLessThanOrEqual(620);
    }
  });

  it("omits the receipt when there are no auto-resolution facts", () => {
    expect(renderAutoResolutionReceipt([])).toBeUndefined();
    expect(summarizeAutoResolutionReceipt([])).toBeUndefined();
  });
});
