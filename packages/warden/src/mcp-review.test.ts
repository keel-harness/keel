import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { WARDEN_METHODS } from "@keel/shared";
import { createEgressReviewState } from "./egress-review.js";
import {
  createPendingMcpReview,
  MCP_REVIEW_SANDBOX_CLASS,
  mcpReviewKey,
  type McpReviewCommand,
} from "./mcp/review.js";
import { buildMcpOpaquePolicyInput } from "./mcp/policy.js";
import type { PolicyDecision } from "./policy.js";

const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PIN = `sha256:${"a".repeat(64)}`;
const PACK = { name: "mcp-review-test", hash: `sha256:${"b".repeat(64)}` };

function executeParams(args: Record<string, unknown> = { text: "ordinary" }) {
  return WARDEN_METHODS["warden.execute"].params.parse({
    sessionId: SESSION_ID,
    toolCall: { id: "tc_mcp_review", name: "mcp__fixture__echo", args },
    provenanceContext: { inputTags: ["workspace"] },
  });
}

function command(): McpReviewCommand {
  return {
    projectedToolName: "mcp__fixture__echo",
    serverId: "fixture",
    toolName: "echo",
    server: {
      transport: "stdio",
      command: "/usr/bin/node",
      args: ["fixture-server.js"],
      envKeys: [],
      pin: PIN,
      tools: [{ name: "echo", inputSchema: { type: "object" } }],
    },
  };
}

function decision(matchedRules: readonly string[] = ["POL-MCP-OPAQUE"]): PolicyDecision {
  return { verdict: "review", matchedRules };
}

function keyFor(
  params = executeParams(),
  reviewCommand = command(),
  reviewDecision = decision(),
  workspaceRoot = "/workspace",
  policyPack = PACK,
) {
  const policyInput = buildMcpOpaquePolicyInput(params, {
    workspaceRoot,
    workspaceTrusted: true,
  });
  return mcpReviewKey(
    { workspaceRoot, policyPack },
    params,
    reviewCommand,
    policyInput,
    reviewDecision,
  );
}

describe("exact once-only MCP review authority", () => {
  it("is deterministic, order-insensitive for matched rules, and names its sandbox class", () => {
    expect(keyFor()).toBe(keyFor());
    expect(keyFor(executeParams(), command(), decision(["rule-b", "rule-a", "rule-a"]))).toBe(
      keyFor(executeParams(), command(), decision(["rule-a", "rule-b"])),
    );
    expect(MCP_REVIEW_SANDBOX_CLASS).toBe("mcp-local-stdio-empty-egress-v1");
  });

  it("changes when any exact authority dimension changes", () => {
    const baseParams = executeParams();
    const baseCommand = command();
    const keys = [
      keyFor(baseParams, baseCommand),
      keyFor(
        WARDEN_METHODS["warden.execute"].params.parse({
          ...baseParams,
          sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FBV",
        }),
        baseCommand,
      ),
      keyFor(executeParams({ text: "changed" }), baseCommand),
      keyFor(baseParams, { ...baseCommand, toolName: "other" }),
      keyFor(baseParams, {
        ...baseCommand,
        server: { ...baseCommand.server, pin: `sha256:${"c".repeat(64)}` },
      }),
      keyFor(baseParams, {
        ...baseCommand,
        server: { ...baseCommand.server, args: ["different-server.js"] },
      }),
      keyFor(baseParams, baseCommand, decision(["POL-MCP-DIFFERENT"])),
      keyFor(baseParams, baseCommand, decision(), "/other-workspace"),
      keyFor(baseParams, baseCommand, decision(), "/workspace", {
        ...PACK,
        hash: `sha256:${"d".repeat(64)}`,
      }),
    ];

    expect(new Set(keys)).toHaveLength(keys.length);
  });

  it("property-binds every distinct exact argument string", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (left, right) => {
        fc.pre(left !== right);
        expect(keyFor(executeParams({ text: left }))).not.toBe(
          keyFor(executeParams({ text: right })),
        );
      }),
    );
  });

  it("sanitizes and bounds hostile projected labels without disclosing retained arguments", () => {
    const state = createEgressReviewState();
    const params = executeParams({ token: "MCP_REVIEW_ARGUMENT_MUST_STAY_OPAQUE" });
    const policyInput = buildMcpOpaquePolicyInput(params, {
      workspaceRoot: "/workspace",
      workspaceTrusted: true,
    });
    const hostileCommand = {
      ...command(),
      projectedToolName: `mcp__fixture__echo\nforged\u001b[31m\u202e${"x".repeat(400)}`,
    };
    const review = createPendingMcpReview(state, {
      reviewKey: keyFor(params, hostileCommand),
      executeParams: params,
      auditPolicyInput: policyInput,
      auditPolicyDecision: decision(),
      command: hostileCommand,
    });

    expect(review.summary).toContain("exact once-only approval");
    expect(review.summary.length).toBeLessThanOrEqual(180);
    expect(review.summary).not.toContain("\u001b");
    expect(review.summary).not.toContain("\u202e");
    expect(review.summary).not.toContain("MCP_REVIEW_ARGUMENT_MUST_STAY_OPAQUE");
    expect(review.allowCommand).toBe("keel approve mcp_review_1 --scope once");
  });

  it("uses a bounded unknown label when the projected tool name sanitizes to empty", () => {
    const state = createEgressReviewState();
    const params = executeParams();
    const policyInput = buildMcpOpaquePolicyInput(params, {
      workspaceRoot: "/workspace",
      workspaceTrusted: true,
    });
    const emptyLabelCommand = { ...command(), projectedToolName: "\u001b\u202e" };

    const review = createPendingMcpReview(state, {
      reviewKey: keyFor(params, emptyLabelCommand),
      executeParams: params,
      auditPolicyInput: policyInput,
      auditPolicyDecision: decision(),
      command: emptyLabelCommand,
    });

    expect(review.summary).toContain("exact once-only approval: unknown");
    expect(review.summary).not.toContain("\u001b");
    expect(review.summary).not.toContain("\u202e");
  });
});
