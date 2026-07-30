import { z } from "zod";
import { JsonObject, JsonValue } from "../common/json.js";
import { SessionId, Sha256 } from "../common/formats.js";
import { KernelAuditEvent } from "./events.js";
import { WardenEvent } from "./events.js";
import {
  AuditSeq,
  EnforcementTier,
  GrantScope,
  PolicyPackRef,
  Principal,
  ProtocolVersion,
  ProvenanceContext,
  ProvenanceTag,
  ToolCall,
  Verdict,
} from "./primitives.js";
import {
  MutationPresentationTakeParamsV1,
  MutationPresentationTakeResultV1,
} from "./mutation-presentation.js";

// warden.hello
export const HelloParams = z
  .object({ kernelVersion: z.string().min(1), protocolVersion: ProtocolVersion })
  .strict();
export const HelloResult = z
  .object({
    wardenVersion: z.string().min(1),
    protocolVersion: ProtocolVersion,
    capabilities: z.array(z.string()),
    enforcementTier: EnforcementTier,
    policyPack: PolicyPackRef,
  })
  .strict();

// warden.trust.grant
export const TrustGrantParams = z
  .object({
    workspacePath: z.string().min(1),
    principal: Principal,
    userConfirmed: z.literal(true),
  })
  .strict();
export const TrustGrantResult = z.object({ granted: z.boolean(), auditSeq: AuditSeq }).strict();

// warden.execute
export const ExecuteParams = z
  .object({
    sessionId: SessionId,
    toolCall: ToolCall,
    provenanceContext: ProvenanceContext,
  })
  .strict();
const ReviewRequired = z
  .object({ reviewId: z.string().min(1), summary: z.string(), allowCommand: z.string() })
  .strict();
export const ExecuteResult = z
  .object({
    verdict: Verdict,
    /** Tool execution result value (JSON-wire-safe). */
    result: JsonValue.optional(),
    provenanceTag: ProvenanceTag.optional(),
    guidance: z.string().optional(),
    /** Policy-modified tool args (JSON-wire-safe object). */
    modifiedArgs: JsonObject.optional(),
    review: ReviewRequired.optional(),
    auditSeq: AuditSeq,
  })
  .strict();

// warden.resolveReview
export const ResolveReviewParams = z
  .object({
    reviewId: z.string().min(1),
    approved: z.boolean(),
    principal: Principal,
    scope: GrantScope.optional(),
  })
  .strict();
export const ResolveReviewResult = z
  .object({
    verdict: Verdict,
    /** Tool execution result value (JSON-wire-safe). */
    result: JsonValue.optional(),
    auditSeq: AuditSeq,
  })
  .strict();

// warden.egress.grant
export const EgressGrantParams = z
  .object({ domain: z.string().min(1), scope: GrantScope, principal: Principal })
  .strict();
export const EgressGrantResult = z.object({ granted: z.boolean(), auditSeq: AuditSeq }).strict();

// warden.provenance.declassify
export const DeclassifyParams = z
  .object({ resultId: z.string().min(1), principal: Principal, reason: z.string().min(1) })
  .strict();
export const DeclassifyResult = z
  .object({ declassified: z.boolean(), scope: GrantScope, auditSeq: AuditSeq })
  .strict();

// warden.audit.append
export const AuditAppendParams = z.object({ event: KernelAuditEvent }).strict();
export const AuditAppendResult = z.object({ auditSeq: AuditSeq }).strict();

// warden.audit.export
export const AuditExportParams = z
  .object({ sessionId: SessionId, outPath: z.string().min(1) })
  .strict();
export const AuditExportResult = z
  .object({ bundlePath: z.string().min(1), rootHash: Sha256 })
  .strict();

// warden.policy.test
const PolicyTestCaseResult = z
  .object({ name: z.string(), passed: z.boolean(), message: z.string().optional() })
  .strict();
export const PolicyTestParams = z.object({ packPath: z.string().min(1) }).strict();
export const PolicyTestResult = z.object({ results: z.array(PolicyTestCaseResult) }).strict();

// warden.policy.explain (dry-run; not audited as execution)
export const PolicyExplainParams = z
  .object({ toolCall: ToolCall, provenanceContext: ProvenanceContext })
  .strict();
export const PolicyExplainResult = z
  .object({ verdict: Verdict, matchedRules: z.array(z.string()), guidance: z.string() })
  .strict();

// warden.status
export const StatusParams = z.object({}).strict();
export const StatusResult = z
  .object({
    enforcementTier: EnforcementTier,
    sandboxBackend: z.string(),
    policyPack: PolicyPackRef,
    auditHead: z.object({ seq: AuditSeq, hash: Sha256 }).strict(),
    pendingReviews: z.number().int().nonnegative(),
  })
  .strict();

// warden.presentation.take (protocol 1.1; ADR-0078)
export const PresentationTakeParams = MutationPresentationTakeParamsV1;
export const PresentationTakeResult = MutationPresentationTakeResultV1;

// warden.shutdown
export const ShutdownParams = z.object({}).strict();
/** finalCheckpoint: a non-empty path or marker string (not a hash — use auditHead.hash for the
 *  signed chain head). Must be non-empty; an empty string indicates a failed checkpoint. */
export const ShutdownResult = z.object({ finalCheckpoint: z.string().min(1) }).strict();

export const WardenMethodName = z.enum([
  "warden.hello",
  "warden.trust.grant",
  "warden.execute",
  "warden.resolveReview",
  "warden.egress.grant",
  "warden.provenance.declassify",
  "warden.audit.append",
  "warden.audit.export",
  "warden.policy.test",
  "warden.policy.explain",
  "warden.status",
  "warden.presentation.take",
  "warden.shutdown",
]);
export type WardenMethodNameT = z.infer<typeof WardenMethodName>;

/** Registry: method name -> { params, result }. Used by the Phase 2 RPC contract
 *  suite to validate every call/response against the frozen interface. */
export const WARDEN_METHODS = {
  "warden.hello": { params: HelloParams, result: HelloResult },
  "warden.trust.grant": { params: TrustGrantParams, result: TrustGrantResult },
  "warden.execute": { params: ExecuteParams, result: ExecuteResult },
  "warden.resolveReview": { params: ResolveReviewParams, result: ResolveReviewResult },
  "warden.egress.grant": { params: EgressGrantParams, result: EgressGrantResult },
  "warden.provenance.declassify": { params: DeclassifyParams, result: DeclassifyResult },
  "warden.audit.append": { params: AuditAppendParams, result: AuditAppendResult },
  "warden.audit.export": { params: AuditExportParams, result: AuditExportResult },
  "warden.policy.test": { params: PolicyTestParams, result: PolicyTestResult },
  "warden.policy.explain": { params: PolicyExplainParams, result: PolicyExplainResult },
  "warden.status": { params: StatusParams, result: StatusResult },
  "warden.presentation.take": { params: PresentationTakeParams, result: PresentationTakeResult },
  "warden.shutdown": { params: ShutdownParams, result: ShutdownResult },
} as const satisfies Record<WardenMethodNameT, { params: z.ZodTypeAny; result: z.ZodTypeAny }>;

/** Registry: notification name -> { params }. Phase-2 contract suite uses this to
 *  validate notification frames. Adding an entry is a MINOR protocol bump (ADR-0012). */
export const WARDEN_NOTIFICATIONS = {
  "warden.event": { params: WardenEvent },
} as const satisfies Record<string, { readonly params: z.ZodTypeAny }>;

export type WardenNotificationNameT = keyof typeof WARDEN_NOTIFICATIONS;
