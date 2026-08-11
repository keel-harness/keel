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

export const GITHUB_PR_CREATE_CAPABILITY_V1 = "github-pr-create/v1";
export const GITHUB_PR_CREATE_TOOL_NAME = "github.pr.create";

export interface GithubPrCreateExecuteParams {
  readonly sessionId: string;
  readonly toolCall: {
    readonly id: string;
    readonly name: string;
    readonly args: JsonObjectT;
  };
  readonly provenanceContext: JsonObjectT;
}

export interface GithubPrCreateResolveParams {
  readonly reviewId: string;
  readonly approved: boolean;
  readonly principal: PrincipalT;
  readonly scope?: "once" | "project";
}

export interface GithubPrCreateBindingAuthority {
  readonly policyInput: PolicyInputT;
  readonly policyDecision: PolicyDecision;
  readonly policyPack: PolicyPackRefT;
  readonly addressGuardRevision: string;
  readonly auditAuthorityId: string;
}

export interface GithubPrCreateBindingAuthorityRequest {
  readonly executeParams: GithubPrCreateExecuteParams;
  readonly sideEffect: SideEffectT;
  readonly canonicalUrl: string;
  readonly host: string;
}

export interface GithubPrCreateAuthorityContext {
  readonly sandbox: SandboxPort;
  readonly workspaceRoot: string;
  readonly auditDir?: string;
  readonly signal?: AbortSignal;
  readonly preExecutionCheck?: () => void;
  readonly resolveBindingAuthority: (
    request: GithubPrCreateBindingAuthorityRequest,
  ) => Promise<GithubPrCreateBindingAuthority>;
  readonly appendAudit: (
    input: AuditAppendInput,
    failureContext?: { readonly actionMayHaveExecuted?: boolean },
  ) => number;
  readonly isAuditFailure?: (error: unknown) => boolean;
}

export interface GithubPrCreateRpcResult {
  readonly verdict: "allow" | "deny" | "review";
  readonly result?: JsonObjectT;
  readonly review?: {
    readonly reviewId: string;
    readonly summary: string;
    readonly allowCommand: string;
  };
  readonly auditSeq: number;
}

export interface GithubPrCreatePendingReview {
  readonly kind: "github-pr-create";
  readonly reviewId: string;
}

export interface GithubPrCreateAuthority {
  readonly capability: typeof GITHUB_PR_CREATE_CAPABILITY_V1;
  readonly toolName: typeof GITHUB_PR_CREATE_TOOL_NAME;
  readonly transportRequirements: { readonly credentialTlsTermination: true };
  capabilityAvailable(input: {
    readonly workspaceTrusted: boolean;
    readonly auditAvailable: boolean;
    readonly sandbox: SandboxStatus;
  }): boolean;
  pendingReviewCount(): number;
  hasPendingReview(reviewId: string): boolean;
  request(
    context: GithubPrCreateAuthorityContext,
    params: GithubPrCreateExecuteParams,
  ): Promise<GithubPrCreateRpcResult>;
  consumeReview(reviewId: string): GithubPrCreatePendingReview | undefined;
  resolve(
    context: GithubPrCreateAuthorityContext,
    review: GithubPrCreatePendingReview,
    params: GithubPrCreateResolveParams,
  ): Promise<GithubPrCreateRpcResult>;
  isInvalidParams(error: unknown): error is Error;
  auditInvalidParams(
    context: GithubPrCreateAuthorityContext,
    params: GithubPrCreateExecuteParams,
    error: Error,
  ): number;
}
