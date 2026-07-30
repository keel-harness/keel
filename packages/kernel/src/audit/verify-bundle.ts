import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import {
  BUNDLE_FORMAT_VERSION,
  BundleCheckpoints,
  BundleManifest,
  BundleRedactionReport,
  ConfigSnapshot,
  canonicalize,
  checkpointRecords,
  checkpointTailCoverageError,
  type JsonValueT,
  parseTolerantAuditRecord,
  sha256Bytes,
  toChainRecords,
  verifyChain,
  verifyCheckpointRecords,
  type AnyAuditRecordT,
  type BundleCheckpointsT,
  type BundleManifestT,
  type BundleRedactionReportT,
  type BundleVerificationDiagnosis,
  type BundleVerificationFaultKind,
  type Ed25519PublicKeyT,
} from "@keel/shared";

/**
 * Offline evidence-bundle verifier for `keel audit verify` (ADR-0071 P1-10 slice 2). The
 * warden BUILDS Phase-2B bundles (`@keel/warden` `buildEvidenceBundle`) and ships a standalone
 * `verify/verify-bundle.mjs` inside each one; this is the in-process TS verifier the kernel runs.
 * It lives in the kernel (not `@keel/warden`) so a Phase-4 Rust warden port leaves `keel audit
 * verify` intact, and not in `@keel/shared` because it reads the filesystem. The bundle format
 * schema and the pure build/verify-shared audit helpers are imported from `@keel/shared` — one
 * source of truth shared with the warden writer, not a divergent copy.
 */

function fail(kind: BundleVerificationFaultKind, detail: string): BundleVerificationDiagnosis {
  return { ok: false, kind, detail };
}

function safeBundlePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").includes("..") &&
    !path.split("/").includes(".")
  );
}

function listBundleFiles(bundlePath: string, dir = bundlePath): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const fullPath = join(dir, entry);
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      throw new Error("bundle contains a symlink");
    }
    if (stat.isDirectory()) {
      files.push(...listBundleFiles(bundlePath, fullPath));
      continue;
    }
    if (!stat.isFile()) {
      throw new Error("bundle contains a non-file artifact");
    }
    files.push(
      fullPath
        .slice(bundlePath.length + 1)
        .split(sep)
        .join("/"),
    );
  }
  return files;
}

function parseBundleRecords(auditJsonl: string): AnyAuditRecordT[] {
  // Tolerant read (ADR-0072 §1/§4): a newer keel's bundle may carry additive fields / novel
  // eventTypes; retain + hash them rather than rejecting. The chain hash + component hashes still
  // detect any tampering. Dup-key and digest-excluded/prototype hiding places fail closed.
  return auditJsonl
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => parseTolerantAuditRecord(line));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function decodeEd25519PublicKey(publicKey: Ed25519PublicKeyT): Uint8Array {
  const decoded = Buffer.from(publicKey.slice("ed25519:".length), "base64");
  /* v8 ignore next 3 -- defensive: callers pass a value that already parsed against the
     Ed25519PublicKey schema (`ed25519:` + 43 base64 chars + `=` ⇒ exactly 32 bytes), so this
     length guard never fires for a schema-valid manifest. */
  if (decoded.length !== 32) {
    throw new Error("checkpoint public key is not 32 bytes");
  }
  return new Uint8Array(decoded);
}

/**
 * Verify a Phase-2B evidence bundle using only local files and the public key in
 * its manifest/checkpoints metadata. This detects component tamper, chain
 * corruption, checkpoint signature failures, wrong-key metadata, and stale
 * policy/config artifacts relative to the manifest component hashes. A green
 * result proves internal consistency under the bundle-declared key; operators
 * must compare that key out-of-band before treating the bundle as authentic.
 */
export function verifyEvidenceBundle(bundlePath: string): BundleVerificationDiagnosis {
  let rawManifest: unknown;
  try {
    rawManifest = readJson(join(bundlePath, "manifest.json"));
  } catch (error) {
    return fail("manifest_invalid", error instanceof Error ? error.message : String(error));
  }
  // Honest higher-version message (ADR-0072 §4): a recognizable-but-unsupported envelope version is a
  // "newer keel" signal, not generic corruption — surface the upgrade line before the strict parse
  // (whose z.literal would otherwise bury it in a generic manifest error).
  const rawVersion = (rawManifest as Record<string, unknown> | null)?.["bundleFormatVersion"];
  if (typeof rawVersion === "string" && rawVersion !== BUNDLE_FORMAT_VERSION) {
    return fail(
      "manifest_invalid",
      `evidence bundle format ${JSON.stringify(rawVersion)} is not supported by this keel (expected ${JSON.stringify(BUNDLE_FORMAT_VERSION)}); it may have been written by a newer keel — upgrade keel to verify it`,
    );
  }
  let manifest: BundleManifestT;
  try {
    manifest = BundleManifest.parse(rawManifest);
  } catch (error) {
    return fail("manifest_invalid", error instanceof Error ? error.message : String(error));
  }

  const expectedFiles = Object.keys(manifest.componentHashes).sort();
  if (!expectedFiles.every(safeBundlePath)) {
    return fail("component_set_mismatch", "manifest contains an unsafe component path");
  }

  let actualFiles: string[];
  try {
    actualFiles = listBundleFiles(bundlePath)
      .filter((file) => file !== "manifest.json")
      .sort();
  } catch (error) {
    return fail("component_set_mismatch", error instanceof Error ? error.message : String(error));
  }
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    return fail(
      "component_set_mismatch",
      `bundle files ${JSON.stringify(actualFiles)} do not match manifest components ${JSON.stringify(expectedFiles)}`,
    );
  }

  for (const file of expectedFiles) {
    const actualHash = sha256Bytes(readFileSync(join(bundlePath, file)));
    if (actualHash !== manifest.componentHashes[file]) {
      return fail(
        "component_hash_mismatch",
        `${file} hash ${actualHash} does not match manifest ${manifest.componentHashes[file]}`,
      );
    }
  }

  let records: AnyAuditRecordT[];
  let checkpointFile: BundleCheckpointsT;
  let redactionReport: BundleRedactionReportT;
  try {
    records = parseBundleRecords(readFileSync(join(bundlePath, "audit.jsonl"), "utf8"));
    checkpointFile = BundleCheckpoints.parse(readJson(join(bundlePath, "checkpoints.json")));
    redactionReport = BundleRedactionReport.parse(
      readJson(join(bundlePath, "redaction-report.json")),
    );
    ConfigSnapshot.parse(readJson(join(bundlePath, "config-snapshot.json")));
  } catch (error) {
    return fail("artifact_invalid", error instanceof Error ? error.message : String(error));
  }

  if (redactionReport.redactionLevel !== manifest.redactionLevel) {
    return fail(
      "redaction_mismatch",
      "redaction-report.json does not match manifest redactionLevel",
    );
  }
  if (records.length !== manifest.recordCount) {
    return fail(
      "chain_invalid",
      `audit record count ${records.length} does not match manifest ${manifest.recordCount}`,
    );
  }
  const foreign = records.find((record) => record.sessionId !== manifest.sessionId);
  if (foreign !== undefined || checkpointFile.sessionId !== manifest.sessionId) {
    return fail("session_mismatch", "bundle artifacts do not all name the manifest session");
  }

  const chain = verifyChain(toChainRecords(records));
  if (!chain.ok) {
    return fail("chain_invalid", `${chain.kind} at seq ${chain.seq}: ${chain.detail}`);
  }
  if (chain.head.hash !== manifest.rootHash) {
    return fail(
      "root_mismatch",
      `audit root ${chain.head.hash} does not match manifest root ${manifest.rootHash}`,
    );
  }

  for (const record of records) {
    if (record.policyPack === undefined) {
      return fail("policy_mismatch", `record seq ${record.seq} is missing policy-pack evidence`);
    }
    if (record.policyPack.packHash !== manifest.policyPack.hash) {
      return fail(
        "policy_mismatch",
        `record seq ${record.seq} names pack ${record.policyPack.packHash}, manifest names ${manifest.policyPack.hash}`,
      );
    }
    if (record.policy && record.policy.packHash !== manifest.policyPack.hash) {
      return fail(
        "policy_mismatch",
        `record seq ${record.seq} names pack ${record.policy.packHash}, manifest names ${manifest.policyPack.hash}`,
      );
    }
  }

  const checkpoints = checkpointRecords(records);
  if (records.length > 0 && checkpoints.length === 0) {
    return fail("checkpoint_missing", "non-empty bundle has no checkpoint records");
  }
  if (
    manifest.checkpoints.count !== checkpoints.length ||
    checkpointFile.checkpoints.length !== checkpoints.length ||
    checkpointFile.publicKey !== manifest.signer.checkpointPublicKey ||
    // Compare by RFC-8785 canonical form (the hash basis), not raw JSON, so a tolerant reader
    // preserving a newer keel's on-disk KEY ORDER still matches checkpoints.json semantically
    // (ADR-0072 §1 — cross-version key order must not read as a mismatch).
    canonicalize(checkpointFile.checkpoints as unknown as JsonValueT) !==
      canonicalize(checkpoints as unknown as JsonValueT)
  ) {
    return fail("checkpoint_mismatch", "checkpoints.json does not match audit.jsonl/manifest");
  }

  try {
    const publicKey = decodeEd25519PublicKey(manifest.signer.checkpointPublicKey);
    const checkpointError = verifyCheckpointRecords(records, checkpoints, publicKey);
    if (checkpointError !== undefined) return fail("checkpoint_invalid", checkpointError);
    /* v8 ignore next 3 -- defensive: for schema-valid records `decodeEd25519PublicKey` (32-byte
       key) and `verifyCheckpointRecords`/`verifySignedCheckpoint` are total (they RETURN
       diagnoses, never throw), so this belt-and-suspenders catch is unreachable here. */
  } catch (error) {
    return fail("checkpoint_invalid", error instanceof Error ? error.message : String(error));
  }

  const tailError = checkpointTailCoverageError(records, checkpoints);
  if (tailError !== undefined) {
    return fail("checkpoint_tail_uncovered", tailError);
  }

  return {
    ok: true,
    manifest,
    rootHash: chain.head.hash,
    recordCount: records.length,
    checkpointCount: checkpoints.length,
  };
}
