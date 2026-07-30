import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AuditCheckpointRecord,
  type AnyAuditRecordT,
  type AuditCheckpointRecordT,
} from "./record.js";
import { toChainRecords } from "./verify.js";
import { verifySignedCheckpoint } from "./checkpoint.js";
import { IsoTimestamp, Sha256, SessionId, type Sha256T } from "../common/formats.js";
import { PolicyPackRef } from "../rpc/primitives.js";

/**
 * Phase-2B evidence-bundle on-disk format (Appendix E) + the pure audit helpers shared by the
 * warden's bundle WRITER (`buildEvidenceBundle`, stays in `@keel/warden`) and the kernel's
 * offline VERIFIER (`verifyEvidenceBundle`, in `@keel/kernel`). ADR-0071 P1-10 slice 2 moves the
 * format schema + the build/verify-shared helpers here so a Phase-4 Rust warden port leaves the
 * kernel's `keel audit verify` intact — the two processes agree on one schema and one helper set,
 * not two divergent copies. This module is dependency-light (`node:crypto` + `zod` only); the
 * `node:fs` reading lives with each process's reader.
 */

/**
 * Bundle format version. `v1-2b` adds the Phase-2B portable-evidence fields:
 * signed checkpoint metadata, component hashes, and verifier inputs. Appendix B
 * audit records remain unchanged; this is a versioned bundle artifact.
 */
export const BUNDLE_FORMAT_VERSION = "evidence-bundle/v1-2b" as const;

export const Ed25519PublicKey = z
  .string()
  .regex(/^ed25519:[A-Za-z0-9+/]{43}=$/u, "expected ed25519:<32-byte-public-key-base64>");
export type Ed25519PublicKeyT = z.infer<typeof Ed25519PublicKey>;

export const RedactionLevel = z.enum(["full", "redacted"]);
export type RedactionLevelT = z.infer<typeof RedactionLevel>;

export const BundleCheckpoints = z
  .object({
    bundleFormatVersion: z.literal(BUNDLE_FORMAT_VERSION),
    sessionId: SessionId,
    publicKey: Ed25519PublicKey,
    checkpoints: z.array(AuditCheckpointRecord),
  })
  .strict();
export type BundleCheckpointsT = z.infer<typeof BundleCheckpoints>;

export const BundleRedactionReport = z
  .object({
    redactionLevel: RedactionLevel,
    model: z.literal("pre-write-audit-redaction/v1"),
    postExportFieldElision: z.literal(false),
    note: z.string().min(1),
  })
  .strict();
export type BundleRedactionReportT = z.infer<typeof BundleRedactionReport>;

/**
 * The evidence-bundle manifest (Appendix E, Phase-2B). `rootHash` is the verified
 * audit chain head hash, which may be a checkpoint record. `componentHashes`
 * commits to every non-manifest file in the bundle so local verification catches
 * accidental or single-file tamper without redefining the existing policy-pack
 * identity hash.
 */
export const BundleManifest = z
  .object({
    bundleFormatVersion: z.literal(BUNDLE_FORMAT_VERSION),
    sessionId: SessionId,
    createdAt: IsoTimestamp,
    recordCount: z.number().int().nonnegative(),
    timeRange: z.object({ from: IsoTimestamp.nullable(), to: IsoTimestamp.nullable() }).strict(),
    rootHash: Sha256,
    policyPack: PolicyPackRef,
    redactionLevel: RedactionLevel,
    signer: z.object({ checkpointPublicKey: Ed25519PublicKey }).strict(),
    checkpoints: z
      .object({ file: z.literal("checkpoints.json"), count: z.number().int().nonnegative() })
      .strict(),
    componentHashes: z.record(Sha256),
  })
  .strict();
export type BundleManifestT = z.infer<typeof BundleManifest>;

/** The exact policy pack that judged the session, snapshotted into `policy-pack/`. */
export const PolicyPackSnapshot = z
  .object({
    name: z.string().min(1),
    hash: Sha256,
    /** filename -> file content. Filenames must be safe basenames (no path traversal). */
    files: z.record(z.string(), z.string()),
  })
  .strict();
export type PolicyPackSnapshotT = z.infer<typeof PolicyPackSnapshot>;

/** Enforcement posture at session time -> `config-snapshot.json`. */
export const ConfigSnapshot = z
  .object({
    enforcementTier: z.string().min(1),
    sandboxBackend: z.string(),
    egressAllowlist: z.array(z.string()),
  })
  .strict();
export type ConfigSnapshotT = z.infer<typeof ConfigSnapshot>;

export type BundleVerificationFaultKind =
  | "manifest_invalid"
  | "component_set_mismatch"
  | "component_hash_mismatch"
  | "artifact_invalid"
  | "chain_invalid"
  | "root_mismatch"
  | "checkpoint_missing"
  | "checkpoint_mismatch"
  | "checkpoint_invalid"
  | "checkpoint_tail_uncovered"
  | "policy_mismatch"
  | "session_mismatch"
  | "redaction_mismatch";

export type BundleVerificationDiagnosis =
  | {
      ok: true;
      manifest: BundleManifestT;
      rootHash: Sha256T;
      recordCount: number;
      checkpointCount: number;
    }
  | { ok: false; kind: BundleVerificationFaultKind; detail: string };

export function sha256Bytes(bytes: string | Uint8Array): Sha256T {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function checkpointRecords(records: readonly AnyAuditRecordT[]): AuditCheckpointRecordT[] {
  return records.filter(
    (record): record is AuditCheckpointRecordT => record.eventType === "checkpoint",
  );
}

export function verifyCheckpointRecords(
  records: readonly AnyAuditRecordT[],
  checkpoints: readonly AuditCheckpointRecordT[],
  publicKey: Uint8Array,
): string | undefined {
  const chainRecords = toChainRecords(records);
  for (const checkpoint of checkpoints) {
    const diagnosis = verifySignedCheckpoint(chainRecords, checkpoint, publicKey, {
      chainAlreadyVerified: true,
    });
    if (!diagnosis.ok) {
      return `checkpoint ${checkpoint.seq} failed: ${diagnosis.kind} - ${diagnosis.detail}`;
    }
  }
  return undefined;
}

export function checkpointTailCoverageError(
  records: readonly AnyAuditRecordT[],
  checkpoints: readonly AuditCheckpointRecordT[],
): string | undefined {
  if (records.length === 0) return undefined;
  const finalRecord = records[records.length - 1];
  const finalCheckpoint = checkpoints[checkpoints.length - 1];
  if (finalRecord === undefined || finalCheckpoint === undefined) {
    return "checkpoint tail is not signed by a final checkpoint";
  }
  if (
    finalRecord.eventType !== "checkpoint" ||
    finalRecord.seq !== finalCheckpoint.seq ||
    finalRecord.hash !== finalCheckpoint.hash
  ) {
    return "checkpoint tail is not signed by a final checkpoint";
  }
  return undefined;
}
