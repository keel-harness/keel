import { z } from "zod";
import { JsonObject } from "../common/json.js";
import { Ed25519Sig, IsoTimestamp, Sha256, SessionId } from "../common/formats.js";
import { SideEffect } from "../policy/side-effect.js";
import { Principal, ProvenanceTag, Verdict } from "../rpc/primitives.js";

/**
 * Audit event types (MASTER_SPEC Appendix B). OAP/OQ-8 is resolved by ADR-0013:
 * Appendix B stays a bespoke, OAP-mappable audit record rather than an OAP profile.
 */
export const AuditEventType = z.enum([
  "tool.execute",
  "tool.deny",
  "review.requested",
  "review.resolved",
  "egress.deny",
  "egress.grant",
  "trust.grant",
  "mode.change",
  "memory.accept",
  "memory.decline",
  "memory.redact",
  "memory.delete",
  "provenance.declassify",
  "session.start",
  "session.end",
  "checkpoint",
]);
export type AuditEventTypeT = z.infer<typeof AuditEventType>;

/**
 * Event types valid for normal (non-checkpoint) records. "checkpoint" is excluded so
 * that AuditRecord structurally cannot represent an unsigned checkpoint — the
 * tamper-evidence spine (SEC-008 / C2). A checkpoint MUST carry merkleRoot/range/sig
 * and is represented by AuditCheckpointRecord.
 */
const NonCheckpointEventType = AuditEventType.exclude(["checkpoint"]);
const ToolAuditEventType = z.enum(["tool.execute", "tool.deny"]);
const NonToolNonCheckpointEventType = NonCheckpointEventType.exclude(["tool.execute", "tool.deny"]);

const AuditPolicyInfo = z
  .object({
    packName: z.string().min(1),
    packHash: Sha256,
    ruleIds: z.array(z.string()),
    verdict: Verdict,
  })
  .strict();

const AuditPolicyPackInfo = z
  .object({
    packName: z.string().min(1),
    packHash: Sha256,
  })
  .strict();

const AuditProvenanceInfo = z
  .object({ inputTags: z.array(ProvenanceTag), resultTag: ProvenanceTag.nullable() })
  .strict();

/**
 * Current audit-record schema version (ADR-0072 §5). Stamped by the warden writer on every new
 * record as an additive-optional, hash-committed `schemaVersion`; legacy records (written before
 * this field existed) simply omit it and still verify. A tolerant reader tolerates ANY value (it is
 * not part of the read gate — see `tolerant-read.ts`); the `z.literal` here binds only the strict
 * WRITE path to the version this keel emits. Symmetric with the session ledger's `v:1` (ADR-0008).
 */
export const AUDIT_SCHEMA_VERSION = 1;

/**
 * The base fields every audit record carries. Exported so the checkpoint-drift guard test can assert
 * `AuditCheckpointRecord` mirrors it (the two are hand-kept in sync — see the NOTE on
 * `AuditCheckpointRecord`). Any field added here MUST be mirrored there.
 */
export const AuditRecordBaseShape = {
  seq: z.number().int().nonnegative(),
  ts: IsoTimestamp,
  sessionId: SessionId,
  principal: Principal,
  payload: JsonObject,
  policyPack: AuditPolicyPackInfo.optional(),
  policy: AuditPolicyInfo.optional(),
  provenance: AuditProvenanceInfo.optional(),
  // Additive-optional, hash-committed (ADR-0072 §5): changes FORWARD writes only; never invalidates
  // an already-written record. Absent on legacy records.
  schemaVersion: z.literal(AUDIT_SCHEMA_VERSION).optional(),
  prevHash: Sha256,
  hash: Sha256,
};

/** A single hash-chained audit record (the warden writes these). `policy` and
 *  `provenance` are absent on non-policy events (e.g. session.start).
 *
 *  Tool records (`tool.execute` and `tool.deny`) MUST carry `sideEffect`; denied
 *  actions are logged with the same classification fidelity as allowed actions
 *  (ADR-0024 R1 freeze). Non-tool events may omit it.
 *
 *  `eventType` excludes "checkpoint" so
 *  an unsigned checkpoint is structurally unrepresentable (SEC-008 / C2).
 *
 *  `payload` uses JsonObject (C3) so no NaN/undefined/±Infinity can cross the
 *  warden JSON-RPC wire or corrupt a hash-over-canonical-JSON. */
const AuditToolRecord = z
  .object({
    ...AuditRecordBaseShape,
    eventType: ToolAuditEventType,
    sideEffect: SideEffect,
  })
  .strict();

const AuditNonToolRecord = z
  .object({
    ...AuditRecordBaseShape,
    eventType: NonToolNonCheckpointEventType,
    sideEffect: SideEffect.optional(),
  })
  .strict();

export const AuditRecord = z.discriminatedUnion("eventType", [AuditToolRecord, AuditNonToolRecord]);
export type AuditRecordT = z.infer<typeof AuditRecord>;

/** Checkpoint records add a Merkle root over a seq range + an Ed25519 signature.
 *
 *  `eventType` is z.literal("checkpoint") — combined with AuditRecord's exclusion,
 *  the two types are disjoint on eventType and form a proper discriminated union.
 *
 *  NOTE: the base fields below are intentionally a full copy of AuditRecord's (not
 *  `.extend()`), because a discriminated union needs each branch to be a plain ZodObject
 *  with the literal discriminant. **Keep these base fields in sync with AuditRecord** —
 *  any field added/changed there must be mirrored here. */
export const AuditCheckpointRecord = z
  .object({
    seq: z.number().int().nonnegative(),
    ts: IsoTimestamp,
    sessionId: SessionId,
    principal: Principal,
    eventType: z.literal("checkpoint"),
    payload: JsonObject,
    policyPack: AuditPolicyPackInfo.optional(),
    policy: AuditPolicyInfo.optional(),
    provenance: AuditProvenanceInfo.optional(),
    sideEffect: SideEffect.optional(),
    // Mirror of AuditRecordBaseShape.schemaVersion (kept in sync by the drift guard, ADR-0072 §5).
    schemaVersion: z.literal(AUDIT_SCHEMA_VERSION).optional(),
    prevHash: Sha256,
    hash: Sha256,
    merkleRoot: Sha256,
    range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    sig: Ed25519Sig,
  })
  .strict();
export type AuditCheckpointRecordT = z.infer<typeof AuditCheckpointRecord>;

/** Any record in the log: a (signed) checkpoint or a normal record.
 *
 *  Discriminated on "eventType": AuditCheckpointRecord matches literal "checkpoint";
 *  AuditRecord matches the enum of all other event types.  Because "checkpoint" is
 *  absent from NonCheckpointEventType, the two branches are disjoint — an unsigned
 *  checkpoint (no merkleRoot/range/sig) cannot match either branch (SEC-008 / C2). */
export const AnyAuditRecord = z.discriminatedUnion("eventType", [
  AuditCheckpointRecord,
  AuditToolRecord,
  AuditNonToolRecord,
]);
export type AnyAuditRecordT = z.infer<typeof AnyAuditRecord>;
