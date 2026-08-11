import type {
  JsonObjectT,
  PolicyInputT,
  PolicyPackRefT,
  PrincipalT,
  SideEffectT,
} from "@keel/shared";
import type { AuditAppendInput } from "./audit/writer.js";
import type { PolicyDecision } from "./policy.js";
import type { SandboxPort, SandboxStatus } from "./sandbox.js";

export const GIT_PUSH_CAPABILITY_V1 = "git-push/v1";
export const GIT_PUSH_TOOL_NAME = "git.push";

export interface GitPushExecuteParams {
  readonly sessionId: string;
  readonly toolCall: {
    readonly id: string;
    readonly name: string;
    readonly args: JsonObjectT;
  };
  readonly provenanceContext: JsonObjectT;
}

export interface GitPushResolveParams {
  readonly reviewId: string;
  readonly approved: boolean;
  readonly principal: PrincipalT;
  readonly scope?: "once" | "project";
}

export interface GitPushBindingAuthority {
  readonly policyInput: PolicyInputT;
  readonly policyDecision: PolicyDecision;
  readonly policyPack: PolicyPackRefT;
  readonly addressGuardRevision: string;
  readonly auditAuthorityId: string;
}

export interface GitPushBindingAuthorityRequest {
  readonly executeParams: GitPushExecuteParams;
  readonly sideEffect: SideEffectT;
  readonly canonicalUrl: string;
  readonly host: string;
}

export interface GitPushAuthorityContext {
  readonly sandbox: SandboxPort;
  readonly workspaceRoot: string;
  readonly auditDir?: string;
  readonly signal?: AbortSignal;
  /** Stdio-owned containment revalidation. Concrete authorities invoke it only after consumption. */
  readonly preExecutionCheck?: () => void;
  /** Resolves the current Warden-owned policy, address-guard, and audit authority for binding. */
  readonly resolveBindingAuthority: (
    request: GitPushBindingAuthorityRequest,
  ) => Promise<GitPushBindingAuthority>;
  readonly appendAudit: (
    input: AuditAppendInput,
    failureContext?: { readonly actionMayHaveExecuted?: boolean },
  ) => number;
  /** Lets the authority preserve the RPC layer's durable-audit failure instead of reclassifying it. */
  readonly isAuditFailure?: (error: unknown) => boolean;
}

export interface GitPushRpcResult {
  readonly verdict: "allow" | "deny" | "review";
  readonly result?: JsonObjectT;
  readonly review?: {
    readonly reviewId: string;
    readonly summary: string;
    readonly allowCommand: string;
  };
  readonly auditSeq: number;
}

/** Opaque occurrence transported only inside the Warden process. */
export interface GitPushPendingReview {
  readonly kind: "git-push";
  readonly reviewId: string;
}

/**
 * Release-safe seam for the production Git-push authority. The normal Warden constructs the
 * production implementation only for a trusted enforcing SRT session. Slice 1's localhost
 * credential fixture remains injectable only from generated test entries, keeping that provider and
 * transport exception mechanically absent from packaged carriers.
 */
export interface GitPushAuthority {
  readonly capability: typeof GIT_PUSH_CAPABILITY_V1;
  readonly toolName: typeof GIT_PUSH_TOOL_NAME;
  readonly transportRequirements: {
    readonly credentialTlsTermination: true;
  };
  capabilityAvailable(input: {
    readonly workspaceTrusted: boolean;
    readonly auditAvailable: boolean;
    readonly sandbox: SandboxStatus;
  }): boolean;
  pendingReviewCount(): number;
  hasPendingReview(reviewId: string): boolean;
  request(
    context: GitPushAuthorityContext,
    params: GitPushExecuteParams,
  ): Promise<GitPushRpcResult>;
  consumeReview(reviewId: string): GitPushPendingReview | undefined;
  resolve(
    context: GitPushAuthorityContext,
    review: GitPushPendingReview,
    params: GitPushResolveParams,
  ): Promise<GitPushRpcResult>;
  isInvalidParams(error: unknown): error is Error;
  auditInvalidParams(
    context: GitPushAuthorityContext,
    params: GitPushExecuteParams,
    error: Error,
  ): number;
}
