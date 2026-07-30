import { describe, expect, it } from "vitest";
import type { Ed25519SigT, Sha256T } from "../common/formats.js";
import type { JsonValueT } from "../common/json.js";
import { GENESIS_PREV_HASH, hashAuditRecord } from "./hash.js";
import type { AuditCheckpointRecordT } from "./record.js";
import type { ChainRecord } from "./verify.js";
import {
  merkleRootForAuditHashes,
  publicKeyFromSecretKey,
  signCheckpointRecord,
  verifySignedCheckpoint,
} from "./checkpoint.js";

const TEST_SECRET_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const WRONG_SECRET_KEY = Uint8Array.from({ length: 32 }, (_, i) => 101 + i);
const PLACEHOLDER_SIG: Ed25519SigT = `ed25519:${"A".repeat(86)}==`;

const principal = {
  osUser: "alice",
  configuredId: null,
  authProvider: "local" as const,
  assurance: "local-os-user" as const,
};

function seal(fields: Record<string, JsonValueT>): ChainRecord {
  return { ...fields, hash: hashAuditRecord(fields) } as ChainRecord;
}

function buildChain(n: number): ChainRecord[] {
  const records: ChainRecord[] = [];
  let prevHash = GENESIS_PREV_HASH;
  for (let i = 0; i < n; i++) {
    const record = seal({
      seq: i,
      ts: "2026-06-30T14:00:00.000Z",
      sessionId: "ses_01K000000000000000000000XY",
      principal,
      eventType: "tool.execute",
      payload: { i },
      prevHash,
    });
    records.push(record);
    prevHash = record.hash;
  }
  return records;
}

function checkpointFor(chain: readonly ChainRecord[]): AuditCheckpointRecordT {
  const checkpoint: AuditCheckpointRecordT = {
    seq: chain.length,
    ts: "2026-06-30T14:00:01.000Z",
    sessionId: "ses_01K000000000000000000000XY",
    principal,
    eventType: "checkpoint" as const,
    payload: {},
    prevHash: chain[chain.length - 1]?.hash ?? GENESIS_PREV_HASH,
    hash: GENESIS_PREV_HASH,
    merkleRoot: merkleRootForAuditHashes(chain.map((record) => record.hash)),
    range: [0, chain.length - 1] as [number, number],
    sig: PLACEHOLDER_SIG,
  };
  return { ...checkpoint, hash: checkpointHash(checkpoint) };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function checkpointHash(checkpoint: AuditCheckpointRecordT | Record<string, JsonValueT>): Sha256T {
  return hashAuditRecord(checkpoint as Record<string, JsonValueT>);
}

describe("signed audit checkpoints (Phase-2B walking skeleton)", () => {
  it("computes a deterministic Merkle root over audit record hashes", () => {
    const hashes = [
      `sha256:${"1".repeat(64)}`,
      `sha256:${"2".repeat(64)}`,
      `sha256:${"3".repeat(64)}`,
    ] as Sha256T[];
    expect(merkleRootForAuditHashes(hashes)).toBe(
      "sha256:f25b9528b374678de9c654f48e54f4c6498a7948eadd379869977473d8310c32",
    );
    expect(() => merkleRootForAuditHashes([])).toThrow(/empty hash list/u);
    expect(() => merkleRootForAuditHashes(["sha256:not-hex"])).toThrow(/lowercase hex/u);
  });

  it("omits sig from the checkpoint hash but commits merkleRoot and range", () => {
    const chain = buildChain(3);
    const checkpoint = checkpointFor(chain);
    expect(checkpointHash({ ...checkpoint, sig: PLACEHOLDER_SIG })).toBe(checkpoint.hash);
    expect(
      checkpointHash({
        ...checkpoint,
        merkleRoot: `sha256:${"f".repeat(64)}`,
      }),
    ).not.toBe(checkpoint.hash);
    expect(checkpointHash({ ...checkpoint, range: [1, 2] })).not.toBe(checkpoint.hash);
  });

  it("verifies a signed checkpoint with the matching key and rejects the wrong key", () => {
    const chain = buildChain(3);
    const publicKey = publicKeyFromSecretKey(TEST_SECRET_KEY);
    const wrongPublicKey = publicKeyFromSecretKey(WRONG_SECRET_KEY);
    const checkpoint = signCheckpointRecord(checkpointFor(chain), TEST_SECRET_KEY);

    expect(verifySignedCheckpoint(chain, checkpoint, publicKey)).toMatchObject({
      ok: true,
      covered: { start: 0, end: 2 },
      head: { seq: 2, hash: chain[2]!.hash },
      merkleRoot: checkpoint.merkleRoot,
    });
    expect(verifySignedCheckpoint(chain, checkpoint, wrongPublicKey)).toMatchObject({
      ok: false,
      kind: "checkpoint_signature_invalid",
    });
  });

  it("rejects altered covered records, Merkle roots, ranges, signatures, and checkpoint hashes", () => {
    const chain = buildChain(3);
    const publicKey = publicKeyFromSecretKey(TEST_SECRET_KEY);
    const checkpoint = signCheckpointRecord(checkpointFor(chain), TEST_SECRET_KEY);

    const alteredRecordBytes = clone(chain);
    alteredRecordBytes[1]!["payload"] = { i: 999 };
    expect(verifySignedCheckpoint(alteredRecordBytes, checkpoint, publicKey)).toMatchObject({
      ok: false,
      kind: "chain_invalid",
    });

    expect(
      verifySignedCheckpoint(
        chain,
        { ...checkpoint, merkleRoot: `sha256:${"e".repeat(64)}` },
        publicKey,
      ),
    ).toMatchObject({ ok: false, kind: "checkpoint_hash_mismatch" });

    expect(
      verifySignedCheckpoint(chain, { ...checkpoint, range: [1, 2] }, publicKey),
    ).toMatchObject({
      ok: false,
      kind: "checkpoint_hash_mismatch",
    });

    const alteredRoot = { ...checkpoint, merkleRoot: `sha256:${"e".repeat(64)}` };
    alteredRoot.hash = checkpointHash(alteredRoot);
    expect(
      verifySignedCheckpoint(chain, signCheckpointRecord(alteredRoot, TEST_SECRET_KEY), publicKey),
    ).toMatchObject({ ok: false, kind: "checkpoint_merkle_mismatch" });

    const alteredRange = { ...checkpoint, range: [1, 2] as [number, number] };
    alteredRange.hash = checkpointHash(alteredRange);
    expect(
      verifySignedCheckpoint(chain, signCheckpointRecord(alteredRange, TEST_SECRET_KEY), publicKey),
    ).toMatchObject({ ok: false, kind: "checkpoint_merkle_mismatch" });

    const floatingCheckpoint = { ...checkpoint, prevHash: GENESIS_PREV_HASH };
    floatingCheckpoint.hash = checkpointHash(floatingCheckpoint);
    expect(
      verifySignedCheckpoint(
        chain,
        signCheckpointRecord(floatingCheckpoint, TEST_SECRET_KEY),
        publicKey,
      ),
    ).toMatchObject({ ok: false, kind: "checkpoint_link_mismatch" });

    const wrongSeqCheckpoint = { ...checkpoint, seq: checkpoint.seq + 1 };
    wrongSeqCheckpoint.hash = checkpointHash(wrongSeqCheckpoint);
    expect(
      verifySignedCheckpoint(
        chain,
        signCheckpointRecord(wrongSeqCheckpoint, TEST_SECRET_KEY),
        publicKey,
      ),
    ).toMatchObject({ ok: false, kind: "checkpoint_link_mismatch" });

    expect(
      verifySignedCheckpoint(chain, { ...checkpoint, sig: PLACEHOLDER_SIG }, publicKey),
    ).toMatchObject({
      ok: false,
      kind: "checkpoint_signature_invalid",
    });

    expect(
      verifySignedCheckpoint(chain, { ...checkpoint, hash: `sha256:${"d".repeat(64)}` }, publicKey),
    ).toMatchObject({ ok: false, kind: "checkpoint_hash_mismatch" });
  });

  it("rejects empty, inverted, negative, and out-of-covered-record ranges", () => {
    const chain = buildChain(3);
    const publicKey = publicKeyFromSecretKey(TEST_SECRET_KEY);
    const checkpoint = signCheckpointRecord(checkpointFor(chain), TEST_SECRET_KEY);

    for (const range of [
      [0, -1],
      [2, 1],
      [-1, 1],
      [0, 3],
      [0.5, 1],
    ] as [number, number][]) {
      const altered = { ...checkpoint, range };
      altered.hash = checkpointHash(altered);
      const signed = signCheckpointRecord(altered, TEST_SECRET_KEY);
      expect(verifySignedCheckpoint(chain, signed, publicKey)).toMatchObject({
        ok: false,
        kind: "checkpoint_range_invalid",
      });
    }
  });

  it("fails closed for malformed signature and public-key bytes", () => {
    const chain = buildChain(3);
    const publicKey = publicKeyFromSecretKey(TEST_SECRET_KEY);
    const checkpoint = signCheckpointRecord(checkpointFor(chain), TEST_SECRET_KEY);

    expect(
      verifySignedCheckpoint(chain, { ...checkpoint, sig: "ed25519:Zm9v" }, publicKey),
    ).toMatchObject({
      ok: false,
      kind: "checkpoint_signature_invalid",
    });

    expect(verifySignedCheckpoint(chain, checkpoint, new Uint8Array([1, 2, 3]))).toMatchObject({
      ok: false,
      kind: "checkpoint_signature_invalid",
    });
  });
});
