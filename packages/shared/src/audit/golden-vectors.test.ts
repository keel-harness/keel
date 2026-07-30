import { describe, expect, it } from "vitest";
import { GENESIS_PREV_HASH, hashAuditRecord } from "./hash.js";
import { toChainRecords, verifyChain } from "./verify.js";
import {
  merkleRootForAuditHashes,
  publicKeyFromSecretKey,
  signCheckpointRecord,
  verifySignedCheckpoint,
} from "./checkpoint.js";
import { AnyAuditRecord, type AnyAuditRecordT, type AuditCheckpointRecordT } from "./record.js";
import type { Sha256T } from "../common/formats.js";

/**
 * Frozen golden hash vectors for the tamper-evident audit chain (ADR-0072 P1-12).
 *
 * These pin the EXACT `sha256:` digest / Merkle root / Ed25519 signature the current
 * canonicalization + hash + sign pipeline produces for realistic records under a fixed test key
 * and fixed timestamps. They are the frozen anchor: any silent change to `canonicalize`,
 * `hashAuditRecord`, the checkpoint Merkle/signature construction, or a record's committed field
 * set changes these digests and fails this test loudly — which is the MAJOR break it would be
 * (ADR-0006: "any change after the first real audit record requires a migration + new schema
 * version"). Changing a pinned value here is itself a MAJOR bump requiring an ADR update.
 *
 * Coverage: a non-tool `session.start`, a `tool.execute` carrying the byte-affecting optional
 * `sideEffect` + `policy` + `provenance` fields, a non-tool `mode.change`, and a signed
 * checkpoint over a THREE-record range so the Merkle odd-leaf promotion branch is exercised.
 *
 * Determinism: fixed 32-byte TEST secret key (1..32) → deterministic Ed25519; fixed ISO
 * timestamps; no Date.now()/random. Ed25519 signatures are deterministic, so `sig` is a stable
 * vector too.
 */
const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TS = "2026-07-15T00:00:00.000Z";
const PRINCIPAL = {
  osUser: "keel-tester",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
} as const;
const SECRET_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PACK_HASH = `sha256:${"a".repeat(64)}`;
const SIDE_EFFECT = {
  taxonomyVersion: "side-effect-taxonomy/v1",
  staticCapability: { toolName: "bash", effectEnvelope: ["fs_read"], broad: true },
  dynamic: {
    effectKinds: ["fs_read"],
    scopes: ["workspace"],
    targets: [],
    modifiers: [],
    composition: {
      kind: "atomic",
      segments: [{ effectKinds: ["fs_read"], scopes: ["workspace"], targets: [], modifiers: [] }],
      edges: [],
    },
    classifier: { name: "golden-classifier", version: "1", confidence: "exact", reasons: [] },
  },
};

// --- known-answer digests (computed from the current pipeline; frozen) ---
const GOLDEN = {
  publicKeyB64: "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=",
  r0Hash: "sha256:eb57c0b955eab6f50c4e862ce4c1c4a97ecf412c960761168c4319f545a7fa49",
  r1Hash: "sha256:411cc37dcb0dd77fa39bd4dba3a02c7ec42d1f375f6aa2a0d14f5ed5f17082ae",
  r2Hash: "sha256:56b18790dd69b338f49eafca1b96ef3cb21a406946a5c4e443c5d6fb9a2b5c68",
  merkleRoot: "sha256:3728834907221a47d7f83a774537d1cdc9874be9110a9f4acee77b93b7215b84",
  cpHash: "sha256:4b51cbb6c980e9a5a679a689a6f230e525fc3e79e0e5bf77cc67c99bcb7dd366",
  cpSig:
    "ed25519:yZ75dZRzT4Rd6+428no/SgaK29Piw/BmfRUSMRKZtON7jE551nyMaP8/wBpi4Jn44laJesq5IA1iXt+BDzNPBQ==",
} as const;

function parsed(record: Record<string, unknown>): AnyAuditRecordT {
  return AnyAuditRecord.parse(record);
}

function sessionStartRecord(): AnyAuditRecordT {
  const base = {
    seq: 0,
    ts: TS,
    sessionId: SESSION_ID,
    principal: PRINCIPAL,
    eventType: "session.start" as const,
    payload: {},
    prevHash: GENESIS_PREV_HASH,
  };
  return parsed({ ...base, hash: hashAuditRecord(base) });
}

function toolExecuteRecord(prevHash: Sha256T): AnyAuditRecordT {
  const base = {
    seq: 1,
    ts: TS,
    sessionId: SESSION_ID,
    principal: PRINCIPAL,
    eventType: "tool.execute" as const,
    payload: { command: "ls" },
    sideEffect: SIDE_EFFECT,
    policy: { packName: "starter", packHash: PACK_HASH, ruleIds: ["R1"], verdict: "allow" },
    provenance: { inputTags: ["workspace", "untrusted"], resultTag: "untrusted" },
    prevHash,
  };
  return parsed({ ...base, hash: hashAuditRecord(base) });
}

function modeChangeRecord(prevHash: Sha256T): AnyAuditRecordT {
  const base = {
    seq: 2,
    ts: TS,
    sessionId: SESSION_ID,
    principal: PRINCIPAL,
    eventType: "mode.change" as const,
    payload: { from: "guided", to: "autopilot" },
    prevHash,
  };
  return parsed({ ...base, hash: hashAuditRecord(base) });
}

function checkpointRecord(
  prevHash: Sha256T,
  coveredHashes: readonly Sha256T[],
): AuditCheckpointRecordT {
  const draft: AuditCheckpointRecordT = {
    seq: 3,
    ts: TS,
    sessionId: SESSION_ID,
    principal: PRINCIPAL,
    eventType: "checkpoint",
    payload: {},
    prevHash,
    merkleRoot: merkleRootForAuditHashes(coveredHashes),
    range: [0, 2],
    hash: GENESIS_PREV_HASH,
    sig: `ed25519:${Buffer.alloc(64).toString("base64")}`,
  };
  const signed = signCheckpointRecord(draft, SECRET_KEY);
  // The checkpoint is a real `AnyAuditRecord` too — schema-validate it like the other records.
  parsed(signed);
  return signed;
}

describe("audit-chain golden vectors (ADR-0072 P1-12 frozen anchor)", () => {
  const r0 = sessionStartRecord();
  const r1 = toolExecuteRecord(r0.hash);
  const r2 = modeChangeRecord(r1.hash);
  const cp = checkpointRecord(r2.hash, [r0.hash, r1.hash, r2.hash]);

  it("pins the session.start record digest", () => {
    expect(r0.hash).toBe(GOLDEN.r0Hash);
  });

  it("pins the tool.execute record digest (sideEffect + policy + provenance)", () => {
    expect(r1.hash).toBe(GOLDEN.r1Hash);
  });

  it("pins the mode.change record digest", () => {
    expect(r2.hash).toBe(GOLDEN.r2Hash);
  });

  it("pins the checkpoint Merkle root (3 leaves), digest, and deterministic Ed25519 signature", () => {
    expect(cp.merkleRoot).toBe(GOLDEN.merkleRoot);
    expect(cp.hash).toBe(GOLDEN.cpHash);
    expect(cp.sig).toBe(GOLDEN.cpSig);
  });

  it("pins the test public key derived from the fixed secret key", () => {
    expect(Buffer.from(publicKeyFromSecretKey(SECRET_KEY)).toString("base64")).toBe(
      GOLDEN.publicKeyB64,
    );
  });

  it("verifies the full multi-record chain + signed checkpoint end to end", () => {
    const chain = toChainRecords([r0, r1, r2, cp]);
    expect(verifyChain(chain).ok).toBe(true);
    const diagnosis = verifySignedCheckpoint(chain, cp, publicKeyFromSecretKey(SECRET_KEY));
    expect(diagnosis.ok).toBe(true);
  });
});

// --- with-schemaVersion vectors (P1-12 Slice 4) ---
// These pin the digests the CURRENT writer produces (it stamps `schemaVersion: 1` on every record,
// ADR-0072 §5). The legacy (no-schemaVersion) vectors above stay valid and continue to lock
// legacy-record verification; these prove the additive field is hash-committed and did not disturb
// the pipeline. Changing a pinned value here is a MAJOR bump (see the header note).
const GOLDEN_V1 = {
  r0Hash: "sha256:514391eefa5699e4343917e65c2684a5b8e76baa0cc754ec53ec4f52fe08c4c0",
  cpHash: "sha256:e3a743f2f87cf98cebc42ca5f6d49cba0e4c196586583bfd4e68a43d5da76b6e",
  cpMerkleRoot: "sha256:4ff7e14d795ce0106bd5a2731cb4afa47226db9f153994004e018eece07becea",
  cpSig:
    "ed25519:V2vgQOe9fA9gszww0O3wpM6W0RF/e6rkZMlp+mrrElKtg2OO3zZYyQm0l1xfS8cwWKcg//KJ5yR/gx7/mIAyAA==",
} as const;

function sessionStartRecordV1(): AnyAuditRecordT {
  const base = {
    seq: 0,
    ts: TS,
    sessionId: SESSION_ID,
    principal: PRINCIPAL,
    eventType: "session.start" as const,
    payload: {},
    schemaVersion: 1 as const,
    prevHash: GENESIS_PREV_HASH,
  };
  return parsed({ ...base, hash: hashAuditRecord(base) });
}

function checkpointRecordV1(
  prevHash: Sha256T,
  coveredHashes: readonly Sha256T[],
): AuditCheckpointRecordT {
  const draft: AuditCheckpointRecordT = {
    seq: 1,
    ts: TS,
    sessionId: SESSION_ID,
    principal: PRINCIPAL,
    eventType: "checkpoint",
    payload: {},
    schemaVersion: 1,
    prevHash,
    merkleRoot: merkleRootForAuditHashes(coveredHashes),
    range: [0, 0],
    hash: GENESIS_PREV_HASH,
    sig: `ed25519:${Buffer.alloc(64).toString("base64")}`,
  };
  const signed = signCheckpointRecord(draft, SECRET_KEY);
  parsed(signed);
  return signed;
}

describe("audit-chain golden vectors WITH schemaVersion (ADR-0072 P1-12 Slice 4)", () => {
  const r0v = sessionStartRecordV1();
  const cpv = checkpointRecordV1(r0v.hash, [r0v.hash]);

  it("pins the session.start(schemaVersion:1) digest — distinct from the legacy record", () => {
    expect(r0v.hash).toBe(GOLDEN_V1.r0Hash);
    // The additive field is genuinely committed: the same record without it hashes differently.
    expect(r0v.hash).not.toBe(GOLDEN.r0Hash);
  });

  it("pins the checkpoint(schemaVersion:1) Merkle root, digest, and signature", () => {
    expect(cpv.merkleRoot).toBe(GOLDEN_V1.cpMerkleRoot);
    expect(cpv.hash).toBe(GOLDEN_V1.cpHash);
    expect(cpv.sig).toBe(GOLDEN_V1.cpSig);
  });

  it("verifies the with-schemaVersion chain + signed checkpoint end to end", () => {
    const chain = toChainRecords([r0v, cpv]);
    expect(verifyChain(chain).ok).toBe(true);
    expect(verifySignedCheckpoint(chain, cpv, publicKeyFromSecretKey(SECRET_KEY)).ok).toBe(true);
  });
});
