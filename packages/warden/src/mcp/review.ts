import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  PolicyInput,
  WARDEN_METHODS,
  canonicalize,
  type JsonObjectT,
  type PolicyInputT,
  type TrustedMcpServerConfig,
} from "@keel/shared";
import type { EgressReviewState } from "../egress-review.js";
import { oneLineReviewText } from "../egress-review.js";
import type { PolicyDecision } from "../policy.js";

type ExecuteParams = ReturnType<(typeof WARDEN_METHODS)["warden.execute"]["params"]["parse"]>;

export const MCP_REVIEW_ONCE_RULE = "MCP-REVIEW-ONCE";
export const MCP_REVIEW_SANDBOX_CLASS = "mcp-local-stdio-empty-egress-v1";

export interface McpReviewCommand {
  readonly projectedToolName: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly server: TrustedMcpServerConfig;
}

export interface McpReviewContext {
  readonly workspaceRoot: string;
  readonly policyPack: {
    readonly name: string;
    readonly hash: string;
  };
}

export interface PendingMcpReview {
  readonly kind: "mcp";
  readonly reviewId: string;
  readonly reviewKey: `sha256:${string}`;
  readonly executeParams: ExecuteParams;
  readonly auditPolicyInput: PolicyInputT;
  readonly auditPolicyDecision: PolicyDecision;
  readonly command: McpReviewCommand;
  readonly summary: string;
  readonly allowCommand: string;
}

function canonicalWorkspaceRoot(workspaceRoot: string): string {
  const absolute = resolve(workspaceRoot);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function sha256Canonical(value: JsonObjectT): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function trustedServerDigest(server: TrustedMcpServerConfig): `sha256:${string}` {
  return sha256Canonical(JSON.parse(JSON.stringify(server)) as JsonObjectT);
}

function jsonSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Exact, process-local authority binding for one retained MCP request. The digest is never a
 * reusable resource: the pending review ID is consumed once and no grant store accepts this key. */
export function mcpReviewKey(
  context: McpReviewContext,
  executeParams: ExecuteParams,
  command: McpReviewCommand,
  policyInput: PolicyInputT,
  decision: PolicyDecision,
): `sha256:${string}` {
  return sha256Canonical({
    version: 1,
    kind: "once-only-mcp",
    workspaceRoot: canonicalWorkspaceRoot(context.workspaceRoot),
    sessionId: executeParams.sessionId,
    toolCall: executeParams.toolCall,
    server: {
      id: command.serverId,
      toolName: command.toolName,
      pin: command.server.pin,
      configDigest: trustedServerDigest(command.server),
    },
    policyInput: JSON.parse(JSON.stringify(policyInput)) as JsonObjectT,
    policyPack: context.policyPack,
    matchedRules: [...new Set(decision.matchedRules)].sort(),
    sandboxClass: MCP_REVIEW_SANDBOX_CLASS,
  });
}

export function createPendingMcpReview(
  state: EgressReviewState,
  options: {
    readonly reviewKey: `sha256:${string}`;
    readonly executeParams: ExecuteParams;
    readonly auditPolicyInput: PolicyInputT;
    readonly auditPolicyDecision: PolicyDecision;
    readonly command: McpReviewCommand;
  },
): PendingMcpReview {
  const reviewId = `mcp_review_${state.nextMcpReviewSeq}`;
  state.nextMcpReviewSeq += 1;
  const executeParams = WARDEN_METHODS["warden.execute"].params.parse(
    jsonSnapshot(options.executeParams),
  );
  const auditPolicyInput = PolicyInput.parse(jsonSnapshot(options.auditPolicyInput));
  const auditPolicyDecision = jsonSnapshot(options.auditPolicyDecision);
  const command = jsonSnapshot(options.command);
  const projectedToolName = oneLineReviewText(command.projectedToolName) || "unknown";
  const summary = oneLineReviewText(
    `opaque local MCP call requires exact once-only approval: ${projectedToolName}; ` +
      "arguments are not displayed; the MCP sandbox and live pin check remain enforced",
  );
  const review: PendingMcpReview = {
    kind: "mcp",
    reviewId,
    reviewKey: options.reviewKey,
    executeParams,
    auditPolicyInput,
    auditPolicyDecision,
    command,
    summary,
    allowCommand: `keel approve ${reviewId} --scope once`,
  };
  state.pending.set(reviewId, review);
  return review;
}
