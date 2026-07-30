import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BUNDLE_FORMAT_VERSION,
  BundleCheckpoints,
  BundleManifest,
  BundleRedactionReport,
  Ed25519PublicKey,
  checkpointRecords,
  checkpointTailCoverageError,
  sha256Bytes,
  toChainRecords,
  verifyChain,
  verifyCheckpointRecords,
  type AnyAuditRecordT,
  type BundleCheckpointsT,
  type BundleManifestT,
  type BundleRedactionReportT,
  type ConfigSnapshotT,
  type Ed25519PublicKeyT,
  type PolicyPackRefT,
  type PolicyPackSnapshotT,
  type RedactionLevelT,
  type Sha256T,
  type SessionIdT,
} from "@keel/shared";
import { renderReplayHtml } from "./replay.js";
import { AuditChainCorruptError } from "./writer.js";

// ADR-0071 P1-10 slice 2: the Phase-2B evidence-bundle format schema + verify result types now
// live in @keel/shared (one source of truth for the warden WRITER below and the @keel/kernel
// offline VERIFIER). Re-export to preserve the warden's public surface. `verifyEvidenceBundle`
// itself moved to @keel/kernel (it reads the filesystem and is what `keel audit verify` runs).
export {
  BUNDLE_FORMAT_VERSION,
  BundleCheckpoints,
  BundleManifest,
  BundleRedactionReport,
  ConfigSnapshot,
  Ed25519PublicKey,
  PolicyPackSnapshot,
  RedactionLevel,
  type BundleCheckpointsT,
  type BundleManifestT,
  type BundleRedactionReportT,
  type BundleVerificationDiagnosis,
  type BundleVerificationFaultKind,
  type ConfigSnapshotT,
  type Ed25519PublicKeyT,
  type PolicyPackSnapshotT,
  type RedactionLevelT,
} from "@keel/shared";

/** Raised when the export is refused on bundle-consistency grounds (distinct from
 *  {@link AuditChainCorruptError}, which is raised when the chain itself fails to
 *  verify). Both mean "an evidence bundle was NOT produced". */
export class EvidenceBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceBundleError";
  }
}

/** The verified-and-bundled inputs for one session's evidence bundle. */
export interface EvidenceBundleSource {
  sessionId: SessionIdT;
  /** The session's slice of the audit chain (caller loads it from the log). */
  records: readonly AnyAuditRecordT[];
  /** Public key matching the checkpoint signer. Required for Phase-2B bundles. */
  checkpointPublicKey?: Uint8Array;
  /** The warden's loaded pack at export time; the builder rejects any record whose
   *  `policy.packHash` names a different pack. */
  policyPack: PolicyPackSnapshotT;
  /** Enforcement posture at session time. */
  config: ConfigSnapshotT;
  /**
   * `redacted` currently means the audit was redacted before it was hashed and
   * written. It does not perform post-export field elision, because that would
   * invalidate the signed hash chain without a separate redaction-proof format.
   */
  redactionLevel?: RedactionLevelT;
}

export interface BuildBundleOptions {
  /** Directory under which `bundle_<sessionId>/` is written. */
  outDir: string;
  /** Injectable clock for the manifest `createdAt` (deterministic tests). */
  now?: () => string;
}

export interface BuildBundleResult {
  bundlePath: string;
  rootHash: Sha256T;
  manifest: BundleManifestT;
}

const SAFE_PACK_FILENAME = /^[A-Za-z0-9._-]+$/u;

function assertSafePackFilename(name: string): void {
  if (name === "." || name === ".." || !SAFE_PACK_FILENAME.test(name)) {
    throw new EvidenceBundleError(`unsafe policy-pack filename: ${JSON.stringify(name)}`);
  }
}

function normalizeEd25519PublicKey(publicKey: Uint8Array | undefined): {
  bytes: Uint8Array;
  text: Ed25519PublicKeyT;
} {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    throw new EvidenceBundleError("checkpoint public key must be a 32-byte Uint8Array");
  }
  return {
    bytes: publicKey,
    text: Ed25519PublicKey.parse(`ed25519:${Buffer.from(publicKey).toString("base64")}`),
  };
}

function writeBundleFile(bundlePath: string, relativePath: string, contents: string): void {
  const fullPath = join(bundlePath, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function componentHashesFor(components: ReadonlyMap<string, string>): Record<string, Sha256T> {
  const hashes: Record<string, Sha256T> = {};
  for (const [path, contents] of [...components.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hashes[path] = sha256Bytes(contents);
  }
  return hashes;
}

function assertBundleSource(source: EvidenceBundleSource, publicKey: Uint8Array): void {
  const diagnosis = verifyChain(toChainRecords(source.records));
  if (!diagnosis.ok) {
    throw new AuditChainCorruptError(
      `refusing to export session ${source.sessionId}: audit chain is corrupt - ${diagnosis.kind} at seq ${diagnosis.seq}`,
      diagnosis,
    );
  }

  const foreign = source.records.find((record) => record.sessionId !== source.sessionId);
  if (foreign !== undefined) {
    throw new EvidenceBundleError(
      `refusing to export session ${source.sessionId}: foreign session record at seq ${foreign.seq}`,
    );
  }

  const checkpoints = checkpointRecords(source.records);
  if (source.records.length > 0 && checkpoints.length === 0) {
    throw new EvidenceBundleError(
      `refusing to export session ${source.sessionId}: non-empty Phase-2B bundle has no signed checkpoints`,
    );
  }
  const checkpointError = verifyCheckpointRecords(source.records, checkpoints, publicKey);
  if (checkpointError !== undefined) {
    throw new EvidenceBundleError(
      `refusing to export session ${source.sessionId}: ${checkpointError}`,
    );
  }
  const tailError = checkpointTailCoverageError(source.records, checkpoints);
  if (tailError !== undefined) {
    throw new EvidenceBundleError(`refusing to export session ${source.sessionId}: ${tailError}`);
  }

  for (const record of source.records) {
    if (record.policyPack === undefined) {
      throw new EvidenceBundleError(
        `refusing to export session ${source.sessionId}: record seq ${record.seq} is missing policy-pack evidence`,
      );
    }
    if (record.policyPack.packHash !== source.policyPack.hash) {
      throw new EvidenceBundleError(
        `refusing to export session ${source.sessionId}: record seq ${record.seq} names pack ${record.policyPack.packHash}, but the snapshot pack is ${source.policyPack.hash}`,
      );
    }
    if (record.policy && record.policy.packHash !== source.policyPack.hash) {
      throw new EvidenceBundleError(
        `refusing to export session ${source.sessionId}: record seq ${record.seq} was judged by pack ${record.policy.packHash}, but the snapshot pack is ${source.policyPack.hash}`,
      );
    }
  }
  for (const name of Object.keys(source.policyPack.files)) assertSafePackFilename(name);
}

/**
 * Build a Phase-2B evidence bundle (Appendix E) for a session:
 * `manifest.json`, verified `audit.jsonl`, `checkpoints.json`,
 * `config-snapshot.json`, `policy-pack/`, verifier instructions, redaction
 * report, and escaped `replay.html`. Export fails closed on chain, checkpoint,
 * pack, or component-consistency faults. Re-exporting a session replaces the
 * prior bundle directory.
 */
export function buildEvidenceBundle(
  source: EvidenceBundleSource,
  opts: BuildBundleOptions,
): BuildBundleResult {
  const now = opts.now ?? (() => new Date().toISOString());
  const publicKey = normalizeEd25519PublicKey(source.checkpointPublicKey);
  assertBundleSource(source, publicKey.bytes);

  const records = source.records;
  const diagnosis = verifyChain(toChainRecords(records));
  if (!diagnosis.ok) {
    throw new AuditChainCorruptError(
      `refusing to export session ${source.sessionId}: audit chain is corrupt - ${diagnosis.kind} at seq ${diagnosis.seq}`,
      diagnosis,
    );
  }

  const times = records.map((record) => record.ts);
  const timeRange = {
    from: times.length > 0 ? times.reduce((a, b) => (a < b ? a : b)) : null,
    to: times.length > 0 ? times.reduce((a, b) => (a > b ? a : b)) : null,
  };

  const policyPackRef: PolicyPackRefT = {
    name: source.policyPack.name,
    hash: source.policyPack.hash,
  };
  const redactionLevel = source.redactionLevel ?? "full";
  const checkpoints = checkpointRecords(records);
  const checkpointPayload: BundleCheckpointsT = {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    sessionId: source.sessionId,
    publicKey: publicKey.text,
    checkpoints,
  };
  BundleCheckpoints.parse(checkpointPayload);

  const redactionReport: BundleRedactionReportT = {
    redactionLevel,
    model: "pre-write-audit-redaction/v1",
    postExportFieldElision: false,
    note: "Audit records are redacted before hashing/signing by the warden writer; this bundle does not perform post-export field elision.",
  };
  BundleRedactionReport.parse(redactionReport);

  const components = new Map<string, string>();
  components.set("audit.jsonl", records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  components.set("checkpoints.json", `${JSON.stringify(checkpointPayload, null, 2)}\n`);
  components.set("config-snapshot.json", `${JSON.stringify(source.config, null, 2)}\n`);
  components.set("redaction-report.json", `${JSON.stringify(redactionReport, null, 2)}\n`);
  components.set(
    "verify/VERIFY.md",
    [
      "# Keel Evidence Bundle Verification",
      "",
      "This Phase-2B bundle is intended to verify offline with Node only.",
      "Run `keel audit verify <bundle>` or `node verify/verify-bundle.mjs <bundle>`.",
      "",
      "A successful verification means the bundle is internally consistent and signed under `manifest.signer.checkpointPublicKey`.",
      "For authenticity, compare `signer.checkpointPublicKey` with the warden's published or out-of-band checkpoint key before trusting the bundle as genuine.",
      "",
    ].join("\n"),
  );
  components.set("verify/verify-bundle.mjs", verifierScriptSource());
  for (const [name, content] of Object.entries(source.policyPack.files).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    components.set(`policy-pack/${name}`, content);
  }

  const rootHash = diagnosis.head.hash;
  components.set(
    "replay.html",
    renderReplayHtml({ sessionId: source.sessionId, records, rootHash }),
  );

  const manifest: BundleManifestT = {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    sessionId: source.sessionId,
    createdAt: now(),
    recordCount: records.length,
    timeRange,
    rootHash,
    policyPack: policyPackRef,
    redactionLevel,
    signer: { checkpointPublicKey: publicKey.text },
    checkpoints: { file: "checkpoints.json", count: checkpoints.length },
    componentHashes: componentHashesFor(components),
  };
  BundleManifest.parse(manifest);

  const bundlePath = join(opts.outDir, `bundle_${source.sessionId}`);
  rmSync(bundlePath, { recursive: true, force: true });
  mkdirSync(bundlePath, { recursive: true });
  for (const [relativePath, contents] of components) {
    writeBundleFile(bundlePath, relativePath, contents);
  }
  writeBundleFile(bundlePath, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  return { bundlePath, rootHash: manifest.rootHash, manifest };
}

function verifierScriptSource(): string {
  return `#!/usr/bin/env node
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const BUNDLE_FORMAT_VERSION = "evidence-bundle/v1-2b";
const GENESIS_PREV_HASH = "sha256:" + "0".repeat(64);
const MERKLE_LEAF_PREFIX = Buffer.from("keel-audit-merkle-leaf-v1\\0", "utf8");
const MERKLE_NODE_PREFIX = Buffer.from("keel-audit-merkle-node-v1\\0", "utf8");
const CHECKPOINT_SIGNATURE_PREFIX = Buffer.from("keel-audit-checkpoint-signature-v1\\0", "utf8");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function sha256Bytes(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value !== "object") throw new Error("non-JSON value in audit record");
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalize(value[key])).join(",") + "}";
}

function hashAuditRecord(record) {
  // Null prototype so a top-level __proto__ own key is committed, not swallowed by the inherited
  // setter (ADR-0072 §2 — lockstep with the in-process reader).
  const committed = Object.create(null);
  for (const [key, value] of Object.entries(record)) {
    if (key !== "hash" && key !== "sig") committed[key] = value;
  }
  return sha256Bytes(Buffer.from(canonicalize(committed), "utf8"));
}

function hashDigest(hash) {
  if (typeof hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
    throw new Error("bad sha256 value");
  }
  return Buffer.from(hash.slice("sha256:".length), "hex");
}

function merkleRoot(hashes) {
  if (hashes.length === 0) throw new Error("empty checkpoint range");
  let level = hashes.map((hash) => createHash("sha256").update(Buffer.concat([MERKLE_LEAF_PREFIX, hashDigest(hash)])).digest());
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(createHash("sha256").update(Buffer.concat([MERKLE_NODE_PREFIX, left, right])).digest());
    }
    level = next;
  }
  return "sha256:" + level[0].toString("hex");
}

function verifyChain(records) {
  let prevHash = GENESIS_PREV_HASH;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.seq !== i) throw new Error("seq discontinuity at record " + i);
    if (record.prevHash !== prevHash) throw new Error("chain break at seq " + record.seq);
    const recomputed = hashAuditRecord(record);
    if (record.hash !== recomputed) throw new Error("hash mismatch at seq " + record.seq);
    prevHash = record.hash;
  }
  const last = records[records.length - 1];
  return last ? { seq: last.seq, hash: last.hash } : { seq: -1, hash: GENESIS_PREV_HASH };
}

function publicKeyBytes(text) {
  if (typeof text !== "string" || !text.startsWith("ed25519:")) throw new Error("bad public key");
  const raw = Buffer.from(text.slice("ed25519:".length), "base64");
  if (raw.length !== 32) throw new Error("bad public key length");
  return raw;
}

function signatureBytes(text) {
  if (typeof text !== "string" || !text.startsWith("ed25519:")) throw new Error("bad signature");
  const raw = Buffer.from(text.slice("ed25519:".length), "base64");
  if (raw.length !== 64) throw new Error("bad signature length");
  return raw;
}

function verifyCheckpoint(records, checkpoint, publicKeyRaw) {
  const recomputedHash = hashAuditRecord(checkpoint);
  if (checkpoint.hash !== recomputedHash) throw new Error("checkpoint hash mismatch at seq " + checkpoint.seq);
  const start = checkpoint.range?.[0];
  const end = checkpoint.range?.[1];
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= records.length) {
    throw new Error("checkpoint range invalid at seq " + checkpoint.seq);
  }
  const coveredHead = records[end];
  if (checkpoint.seq !== end + 1 || checkpoint.prevHash !== coveredHead.hash) {
    throw new Error("checkpoint link mismatch at seq " + checkpoint.seq);
  }
  const root = merkleRoot(records.slice(start, end + 1).map((record) => record.hash));
  if (checkpoint.merkleRoot !== root) throw new Error("checkpoint Merkle mismatch at seq " + checkpoint.seq);
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]), format: "der", type: "spki" });
  const message = Buffer.concat([CHECKPOINT_SIGNATURE_PREFIX, Buffer.from(checkpoint.hash, "utf8")]);
  if (!verifySignature(null, message, key, signatureBytes(checkpoint.sig))) {
    throw new Error("checkpoint signature invalid at seq " + checkpoint.seq);
  }
}

function assertCheckpointTailCovered(records, checkpoints) {
  if (records.length === 0) return;
  const finalRecord = records[records.length - 1];
  const finalCheckpoint = checkpoints[checkpoints.length - 1];
  if (
    !finalRecord ||
    !finalCheckpoint ||
    finalRecord.eventType !== "checkpoint" ||
    finalRecord.seq !== finalCheckpoint.seq ||
    finalRecord.hash !== finalCheckpoint.hash ||
    finalCheckpoint.seq !== records.length - 1 ||
    finalCheckpoint.range?.[1] !== finalCheckpoint.seq - 1
  ) {
    throw new Error("checkpoint tail uncovered");
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ADR-0072 §2 lockstep with the in-process reader: reject duplicate object keys at any depth (a
// keep-first external verifier would otherwise hash a different byte-image). A JSON.parse reviver
// cannot see duplicates (they collapse first), so scan the raw, string-aware.
function assertNoDuplicateKeys(text) {
  const stack = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < n) {
        const c = text[i];
        if (c === "\\\\") { i += 2; continue; }
        i += 1;
        if (c === '"') break;
      }
      const frame = stack[stack.length - 1];
      if (frame && frame.isObject && frame.expectKey) {
        const key = JSON.parse(text.slice(start, i));
        if (frame.keys.has(key)) throw new Error("duplicate object key " + JSON.stringify(key));
        frame.keys.add(key);
      }
      continue;
    }
    if (ch === "{") stack.push({ isObject: true, keys: new Set(), expectKey: true });
    else if (ch === "[") stack.push({ isObject: false, keys: new Set(), expectKey: false });
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ":") { const f = stack[stack.length - 1]; if (f) f.expectKey = false; }
    else if (ch === ",") { const f = stack[stack.length - 1]; if (f && f.isObject) f.expectKey = true; }
    i += 1;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRecordLine(line) {
  assertNoDuplicateKeys(line);
  const record = JSON.parse(line);
  if (!isPlainObject(record)) throw new Error("audit record is not a JSON object");
  for (const key of ["__proto__", "constructor", "prototype"]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error("audit record carries a forbidden top-level key " + JSON.stringify(key));
    }
  }
  // Spine shape parity with the in-process tolerant gate (ADR-0072 §6). Field CONTENT is bound by
  // the chain hash + checkpoint signature; these presence/shape checks keep the auditor-facing
  // verifier from being strictly more lenient than keel's own on a malformed spine.
  if (typeof record.eventType !== "string" || record.eventType.length === 0) {
    throw new Error("audit record has a missing or empty eventType");
  }
  if (typeof record.ts !== "string") throw new Error("audit record has a non-string ts");
  if (typeof record.sessionId !== "string") throw new Error("audit record has a non-string sessionId");
  if (!isPlainObject(record.principal)) throw new Error("audit record has a non-object principal");
  if (!isPlainObject(record.payload)) throw new Error("audit record has a non-object payload");
  if (record.eventType !== "checkpoint" && Object.prototype.hasOwnProperty.call(record, "sig")) {
    throw new Error("non-checkpoint record carries a top-level sig (excluded from the digest)");
  }
  return record;
}

function parseJsonl(path) {
  return readFileSync(path, "utf8").split("\\n").filter((line) => line.length > 0).map(parseRecordLine);
}

function listFiles(bundlePath, dir = bundlePath) {
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error("bundle contains a symlink");
    if (stat.isDirectory()) {
      files.push(...listFiles(bundlePath, full));
    } else if (stat.isFile()) {
      files.push(full.slice(bundlePath.length + 1).split(sep).join("/"));
    } else {
      throw new Error("bundle contains a non-file artifact");
    }
  }
  return files;
}

function verifyBundle(bundlePath) {
  const manifest = readJson(join(bundlePath, "manifest.json"));
  if (manifest.bundleFormatVersion !== BUNDLE_FORMAT_VERSION) throw new Error("evidence bundle format " + JSON.stringify(manifest.bundleFormatVersion) + " is not supported by this verifier (expected " + JSON.stringify(BUNDLE_FORMAT_VERSION) + ") — it may have been written by a newer keel; upgrade keel to verify it");
  const expectedFiles = Object.keys(manifest.componentHashes ?? {}).sort();
  const actualFiles = listFiles(bundlePath).filter((file) => file !== "manifest.json").sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) throw new Error("component set mismatch");
  for (const file of expectedFiles) {
    const actualHash = sha256Bytes(readFileSync(join(bundlePath, file)));
    if (actualHash !== manifest.componentHashes[file]) throw new Error("component hash mismatch: " + file);
  }
  const records = parseJsonl(join(bundlePath, "audit.jsonl"));
  if (records.length !== manifest.recordCount) throw new Error("record count mismatch");
  if (records.some((record) => record.sessionId !== manifest.sessionId)) throw new Error("session mismatch");
  const head = verifyChain(records);
  if (head.hash !== manifest.rootHash) throw new Error("root mismatch");
  for (const record of records) {
    if (record.policyPack === undefined) throw new Error("missing policy pack");
    if (record.policyPack.packHash !== manifest.policyPack.hash) throw new Error("policy pack mismatch");
    if (record.policy && record.policy.packHash !== manifest.policyPack.hash) throw new Error("policy pack mismatch");
  }
  const checkpointFile = readJson(join(bundlePath, "checkpoints.json"));
  if (checkpointFile.sessionId !== manifest.sessionId) throw new Error("checkpoint session mismatch");
  if (checkpointFile.publicKey !== manifest.signer.checkpointPublicKey) throw new Error("checkpoint key mismatch");
  const checkpoints = records.filter((record) => record.eventType === "checkpoint");
  if (records.length > 0 && checkpoints.length === 0) throw new Error("missing checkpoint");
  if (manifest.checkpoints.count !== checkpoints.length || checkpointFile.checkpoints.length !== checkpoints.length) {
    throw new Error("checkpoint count mismatch");
  }
  if (canonicalize(checkpointFile.checkpoints) !== canonicalize(checkpoints)) throw new Error("checkpoint file mismatch");
  const publicKeyRaw = publicKeyBytes(manifest.signer.checkpointPublicKey);
  for (const checkpoint of checkpoints) verifyCheckpoint(records, checkpoint, publicKeyRaw);
  assertCheckpointTailCovered(records, checkpoints);
  const redactionReport = readJson(join(bundlePath, "redaction-report.json"));
  if (redactionReport.redactionLevel !== manifest.redactionLevel) throw new Error("redaction mismatch");
  return head;
}

try {
  const bundlePath = process.argv[2];
  if (!bundlePath) throw new Error("usage: node verify/verify-bundle.mjs <bundle>");
  const head = verifyBundle(bundlePath);
  console.log("OK " + head.hash);
} catch (error) {
  console.error("FAIL " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
`;
}
