import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import type { Ed25519SigT, Sha256T } from "../common/formats.js";
import type { JsonValueT } from "../common/json.js";
import type { AuditCheckpointRecordT } from "./record.js";
import { GENESIS_PREV_HASH, hashAuditRecord } from "./hash.js";
import { type ChainDiagnosis, type ChainHead, type ChainRecord, verifyChain } from "./verify.js";

const MERKLE_LEAF_PREFIX = utf8ToBytes("keel-audit-merkle-leaf-v1\0");
const MERKLE_NODE_PREFIX = utf8ToBytes("keel-audit-merkle-node-v1\0");
const CHECKPOINT_SIGNATURE_PREFIX = utf8ToBytes("keel-audit-checkpoint-signature-v1\0");
const SHA256_PREFIX = "sha256:";
const ED25519_PREFIX = "ed25519:";
const ED25519_PKCS8_PRIVATE_KEY_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PUBLIC_KEY_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type CheckpointFaultKind =
  | "chain_invalid"
  | "checkpoint_hash_mismatch"
  | "checkpoint_range_invalid"
  | "checkpoint_link_mismatch"
  | "checkpoint_merkle_mismatch"
  | "checkpoint_signature_invalid";

export type CheckpointDiagnosis =
  | {
      ok: true;
      covered: { start: number; end: number };
      head: ChainHead;
      merkleRoot: Sha256T;
    }
  | {
      ok: false;
      kind: CheckpointFaultKind;
      detail: string;
      seq?: number;
      chain?: ChainDiagnosis;
    };

export interface VerifySignedCheckpointOptions {
  /**
   * Skip re-validating `records` as a hash chain. Use only when the caller has
   * already run `verifyChain(records)` over the exact same record array.
   */
  chainAlreadyVerified?: boolean;
}

export function publicKeyFromSecretKey(secretKey: Uint8Array): Uint8Array {
  const publicKey = createPublicKey(privateKeyFromSecretKey(secretKey));
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  if (
    publicKeyDer.length !== ED25519_SPKI_PUBLIC_KEY_PREFIX.length + 32 ||
    !publicKeyDer
      .subarray(0, ED25519_SPKI_PUBLIC_KEY_PREFIX.length)
      .equals(ED25519_SPKI_PUBLIC_KEY_PREFIX)
  ) {
    throw new Error("unexpected Ed25519 public key encoding");
  }
  return new Uint8Array(publicKeyDer.subarray(ED25519_SPKI_PUBLIC_KEY_PREFIX.length));
}

export function signCheckpointRecord(
  checkpoint: AuditCheckpointRecordT,
  secretKey: Uint8Array,
): AuditCheckpointRecordT {
  const hash = hashAuditRecord(checkpointHashInput(checkpoint));
  const signature = sign(
    null,
    checkpointSignatureMessage(hash),
    privateKeyFromSecretKey(secretKey),
  );
  return { ...checkpoint, hash, sig: encodeEd25519Signature(signature) };
}

export function verifySignedCheckpoint(
  records: readonly ChainRecord[],
  checkpoint: AuditCheckpointRecordT,
  publicKey: Uint8Array,
  opts?: VerifySignedCheckpointOptions,
): CheckpointDiagnosis {
  const chain = opts?.chainAlreadyVerified ? alreadyVerifiedChain(records) : verifyChain(records);
  if (!chain.ok) {
    return {
      ok: false,
      kind: "chain_invalid",
      seq: chain.seq,
      detail: chain.detail,
      chain,
    };
  }

  const recomputedHash = hashAuditRecord(checkpointHashInput(checkpoint));
  if (checkpoint.hash !== recomputedHash) {
    return {
      ok: false,
      kind: "checkpoint_hash_mismatch",
      seq: checkpoint.seq,
      detail: `checkpoint ${checkpoint.seq} stored hash does not match its content`,
    };
  }

  const [start, end] = checkpoint.range;
  if (!isValidCheckpointRange(start, end, records.length)) {
    return {
      ok: false,
      kind: "checkpoint_range_invalid",
      seq: checkpoint.seq,
      detail: `checkpoint ${checkpoint.seq} range [${start}, ${end}] is outside the ${records.length}-record chain`,
    };
  }

  const coveredRecords = records.slice(start, end + 1);
  const coveredHead = coveredRecords[coveredRecords.length - 1]!;
  if (checkpoint.seq !== end + 1 || checkpoint.prevHash !== coveredHead.hash) {
    return {
      ok: false,
      kind: "checkpoint_link_mismatch",
      seq: checkpoint.seq,
      detail: `checkpoint ${checkpoint.seq} does not link to covered head ${end}`,
    };
  }

  const merkleRoot = merkleRootForAuditHashes(coveredRecords.map((record) => record.hash));
  if (checkpoint.merkleRoot !== merkleRoot) {
    return {
      ok: false,
      kind: "checkpoint_merkle_mismatch",
      seq: checkpoint.seq,
      detail: `checkpoint ${checkpoint.seq} Merkle root does not match records ${start}..${end}`,
    };
  }

  const signature = decodeEd25519Signature(checkpoint.sig);
  const signatureOk = verifiesSignature(signature, checkpoint.hash, publicKey);
  if (!signatureOk) {
    return {
      ok: false,
      kind: "checkpoint_signature_invalid",
      seq: checkpoint.seq,
      detail: `checkpoint ${checkpoint.seq} signature does not verify for its hash`,
    };
  }

  return {
    ok: true,
    covered: { start, end },
    head: chain.head,
    merkleRoot,
  };
}

function alreadyVerifiedChain(records: readonly ChainRecord[]): ChainDiagnosis {
  const last = records[records.length - 1];
  return {
    ok: true,
    count: records.length,
    head:
      last === undefined
        ? { seq: -1, hash: GENESIS_PREV_HASH }
        : { seq: last.seq, hash: last.hash },
  };
}

export function merkleRootForAuditHashes(hashes: readonly Sha256T[]): Sha256T {
  if (hashes.length === 0) {
    throw new RangeError("cannot compute an audit checkpoint Merkle root over an empty hash list");
  }

  let level = hashes.map((hash) =>
    sha256(concatBytes(MERKLE_LEAF_PREFIX, sha256DigestBytes(hash))),
  );
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(sha256(concatBytes(MERKLE_NODE_PREFIX, left, right)));
    }
    level = next;
  }

  return `sha256:${bytesToHex(level[0]!)}`;
}

function isValidCheckpointRange(start: number, end: number, recordCount: number): boolean {
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end >= start &&
    end < recordCount
  );
}

function checkpointSignatureMessage(hash: Sha256T): Uint8Array {
  return concatBytes(CHECKPOINT_SIGNATURE_PREFIX, utf8ToBytes(hash));
}

function checkpointHashInput(checkpoint: AuditCheckpointRecordT): Record<string, JsonValueT> {
  return checkpoint as unknown as Record<string, JsonValueT>;
}

function verifiesSignature(
  signature: Uint8Array | undefined,
  checkpointHash: Sha256T,
  publicKey: Uint8Array,
): boolean {
  if (signature === undefined) return false;
  try {
    return verify(
      null,
      checkpointSignatureMessage(checkpointHash),
      publicKeyFromRawBytes(publicKey),
      signature,
    );
  } catch {
    return false;
  }
}

function privateKeyFromSecretKey(secretKey: Uint8Array): KeyObject {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) {
    throw new Error("Ed25519 checkpoint secret key must be 32 bytes");
  }
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PRIVATE_KEY_PREFIX, Buffer.from(secretKey)]),
    format: "der",
    type: "pkcs8",
  });
}

function publicKeyFromRawBytes(publicKey: Uint8Array): KeyObject {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    throw new Error("Ed25519 checkpoint public key must be 32 bytes");
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PUBLIC_KEY_PREFIX, Buffer.from(publicKey)]),
    format: "der",
    type: "spki",
  });
}

function sha256DigestBytes(hash: Sha256T): Uint8Array {
  return hexToBytes(hash.slice(SHA256_PREFIX.length));
}

function encodeEd25519Signature(signature: Uint8Array): Ed25519SigT {
  return `${ED25519_PREFIX}${Buffer.from(signature).toString("base64")}`;
}

function decodeEd25519Signature(signature: Ed25519SigT): Uint8Array | undefined {
  const encoded = signature.slice(ED25519_PREFIX.length);
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === 64 ? new Uint8Array(decoded) : undefined;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/u.test(hex)) {
    throw new RangeError("expected lowercase hex bytes");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
