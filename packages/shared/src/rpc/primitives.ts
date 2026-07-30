import { z } from "zod";
import { JsonObject } from "../common/json.js";
import { Sha256 } from "../common/formats.js";

/** Protocol version (semver string). Protocol 1.1 adds mutation-presentation take (ADR-0078). */
export const PROTOCOL_VERSION = "1.1.0" as const;
export const ProtocolVersion = z.string().regex(/^\d+\.\d+\.\d+$/, "semver x.y.z");
export type ProtocolVersionT = z.infer<typeof ProtocolVersion>;

/** Who is acting. Identity seam (authProvider/assurance) is present from v1 but
 *  always "local"/"local-os-user" (or "signed-user-config") until SSO lands. */
export const Principal = z
  .object({
    osUser: z.string().min(1),
    configuredId: z.string().min(1).nullable(),
    authProvider: z.enum(["local", "oidc", "saml", "none"]),
    assurance: z.enum(["local-os-user", "signed-user-config", "sso"]),
  })
  .strict();
export type PrincipalT = z.infer<typeof Principal>;

/** Policy verdicts (MASTER_SPEC §4.3). Precedence deny>review>modify>warn>allow
 *  is enforced in the warden, not the schema. */
export const Verdict = z.enum(["allow", "deny", "modify", "review", "warn"]);
export type VerdictT = z.infer<typeof Verdict>;

/** Provenance tags (§3.2 + Epic 3.0 `mixed`). */
const PROVENANCE_TAG_VALUES = ["user", "workspace", "untrusted", "mixed"] as const;
export const ProvenanceTag = z.enum(PROVENANCE_TAG_VALUES);
export type ProvenanceTagT = z.infer<typeof ProvenanceTag>;

/**
 * Boundary mapper from broader trust/taint vocabularies (e.g. TaskState.TrustLevel, which carries
 * fail-closed `unknown`) into the frozen provenance tag set. Unknown/future tags collapse to
 * `untrusted`; the wire enum stays closed while the boundary remains safe under additive growth.
 */
export function provenanceTagFromTrustLevel(trust: string): ProvenanceTagT {
  const parsed = ProvenanceTag.safeParse(trust);
  return parsed.success ? parsed.data : "untrusted";
}

export const ProvenanceContext = z.object({ inputTags: z.array(ProvenanceTag) }).strict();
export type ProvenanceContextT = z.infer<typeof ProvenanceContext>;

/** A tool invocation the kernel asks the warden to execute. `args` is tool-
 *  specific JSON; constrained to JsonObject so the value set is JSON-wire-safe
 *  (rejects undefined, NaN, ±Infinity). */
export const ToolCall = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    args: JsonObject,
  })
  .strict();
export type ToolCallT = z.infer<typeof ToolCall>;

/** Monotonic audit sequence number returned by mutating RPCs. */
export const AuditSeq = z.number().int().nonnegative();
export type AuditSeqT = z.infer<typeof AuditSeq>;

/** Reference to the loaded policy pack (name + SHA-256 content hash). */
export const PolicyPackRef = z.object({ name: z.string().min(1), hash: Sha256 }).strict();
export type PolicyPackRefT = z.infer<typeof PolicyPackRef>;

/** Grant scope used by review/egress flows. */
export const GrantScope = z.enum(["once", "project"]);
export type GrantScopeT = z.infer<typeof GrantScope>;

/** Recognized v1 error codes carried in a JSON-RPC error's `data.code`. The
 *  wire field (see envelope.ts JsonRpcError) is forward-tolerant of unknown
 *  future codes, which consumers MUST treat as opaque. Adding a recognized code
 *  here is a MINOR protocol bump (see ADR-0012). */
export const ErrorCode = z.enum([
  "POLICY_PACK_TAMPERED",
  "TIER_UNAVAILABLE",
  "PROTOCOL_MISMATCH",
  "SANDBOX_INIT_FAILED",
]);
export type ErrorCodeT = z.infer<typeof ErrorCode>;

/** Enforcement tier reported by the warden. Kept a free string at the wire level
 *  so the set of tiers can evolve without a breaking protocol change. */
export const EnforcementTier = z.string().min(1);
export type EnforcementTierT = z.infer<typeof EnforcementTier>;
