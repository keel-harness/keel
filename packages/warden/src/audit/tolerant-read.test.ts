import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENESIS_PREV_HASH,
  hashAuditRecord,
  merkleRootForAuditHashes,
  publicKeyFromSecretKey,
  signCheckpointRecord,
  toChainRecords,
  verifyChain,
  verifySignedCheckpoint,
  type AuditCheckpointRecordT,
  type JsonValueT,
  type PrincipalT,
  type Sha256T,
} from "@keel/shared";
import { AuditChainCorruptError, AuditChainWriter, readAuditLog } from "./writer.js";

/**
 * Slice 2 (ADR-0072 P1-12): the warden audit READER must tolerate a newer keel's additive fields
 * and novel event types (forward-compat) while still failing closed on genuine corruption and on
 * the digest-excluded / prototype hiding places. These drive `parseCompleteLog` (shared by
 * `readAuditLog` and `AuditChainWriter.open`) through the tolerant parse.
 */
const PRINCIPAL: PrincipalT = {
  osUser: "alice",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
};
const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TS = "2026-07-16T00:00:00.000Z";
const SECRET_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-tolerant-"));
  path = join(dir, "audit.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Seal a record with its correct chain hash (as the writer does). */
function seal(record: Record<string, JsonValueT>): Record<string, JsonValueT> {
  return { ...record, hash: hashAuditRecord(record) };
}

/** Build a hash-linked chain from per-record partials (each merged over a genesis-linked base). */
function buildChain(partials: Record<string, JsonValueT>[]): Record<string, JsonValueT>[] {
  let prev: Sha256T = GENESIS_PREV_HASH;
  const out: Record<string, JsonValueT>[] = [];
  partials.forEach((partial, i) => {
    const base: Record<string, JsonValueT> = {
      seq: i,
      ts: TS,
      sessionId: SESSION_ID,
      principal: { ...PRINCIPAL },
      eventType: "session.start",
      payload: {},
      prevHash: prev,
      ...partial,
    };
    const sealed = seal(base);
    out.push(sealed);
    prev = sealed["hash"] as Sha256T;
  });
  return out;
}

function writeLog(records: Record<string, JsonValueT>[]): void {
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

describe("warden audit reader — forward-compat (ADR-0072 §4)", () => {
  it("tolerates an unknown top-level field and still verifies the chain", () => {
    writeLog(
      buildChain([
        { eventType: "session.start" },
        { eventType: "session.end", futureField: { schemaThing: 7 } },
      ]),
    );
    const records = readAuditLog(path);
    expect(records).toHaveLength(2);
    expect(verifyChain(toChainRecords(records)).ok).toBe(true);
  });

  it("tolerates an unknown eventType (opaque) — not reported as corrupt", () => {
    writeLog(buildChain([{ eventType: "session.start" }, { eventType: "widget.frobnicate" }]));
    const records = readAuditLog(path);
    expect(records).toHaveLength(2);
    expect(records[1]!.eventType).toBe("widget.frobnicate");
    expect(verifyChain(toChainRecords(records)).ok).toBe(true);
  });

  it("an older WRITER reopens a log with an unknown field, appends, and the chain stays valid", () => {
    writeLog(buildChain([{ eventType: "session.start", futureField: "x" }]));
    const writer = AuditChainWriter.open({ path, principal: PRINCIPAL, now: () => TS });
    writer.append({ eventType: "session.end", sessionId: SESSION_ID, payload: {} });
    writer.close();
    const records = readAuditLog(path);
    expect(records).toHaveLength(2);
    expect(verifyChain(toChainRecords(records)).ok).toBe(true);
  });

  it("a CHECKPOINT-signing writer reopens over an unknown-field record and signs a covering checkpoint", () => {
    // The pre-existing record (unknown field) must be recovered into the checkpoint cursor so the
    // signed Merkle root covers it — proving reopen + checkpoint interact correctly on tolerant reads.
    writeLog(buildChain([{ eventType: "session.start", futureField: { schemaThing: 7 } }]));
    const writer = AuditChainWriter.open({
      path,
      principal: PRINCIPAL,
      now: () => TS,
      checkpoint: { cadence: 2, secretKey: SECRET_KEY },
    });
    writer.append({ eventType: "session.end", sessionId: SESSION_ID, payload: {} });
    writer.close(); // flushes a final checkpoint covering [0,1]

    const records = readAuditLog(path);
    const chain = toChainRecords(records);
    expect(verifyChain(chain).ok).toBe(true);
    const checkpoint = records.find((r) => r.eventType === "checkpoint") as AuditCheckpointRecordT;
    expect(checkpoint).toBeDefined();
    expect(verifySignedCheckpoint(chain, checkpoint, publicKeyFromSecretKey(SECRET_KEY)).ok).toBe(
      true,
    );
  });

  it("verifies a signed checkpoint whose covered range includes a record with an unknown field", () => {
    const r0 = seal({
      seq: 0,
      ts: TS,
      sessionId: SESSION_ID,
      principal: { ...PRINCIPAL },
      eventType: "session.start",
      payload: {},
      prevHash: GENESIS_PREV_HASH,
    });
    const r1 = seal({
      seq: 1,
      ts: TS,
      sessionId: SESSION_ID,
      principal: { ...PRINCIPAL },
      eventType: "session.end",
      payload: {},
      prevHash: r0["hash"] as Sha256T,
      futureField: "novel",
    });
    const covered = [r0["hash"] as Sha256T, r1["hash"] as Sha256T];
    const draft: AuditCheckpointRecordT = {
      seq: 2,
      ts: TS,
      sessionId: SESSION_ID,
      principal: { ...PRINCIPAL },
      eventType: "checkpoint",
      payload: {},
      prevHash: r1["hash"] as Sha256T,
      merkleRoot: merkleRootForAuditHashes(covered),
      range: [0, 1],
      hash: GENESIS_PREV_HASH,
      sig: `ed25519:${Buffer.alloc(64).toString("base64")}`,
    };
    const cp = signCheckpointRecord(draft, SECRET_KEY);
    writeFileSync(path, [r0, r1, cp].map((r) => JSON.stringify(r)).join("\n") + "\n");

    const records = readAuditLog(path);
    const chain = toChainRecords(records);
    expect(verifyChain(chain).ok).toBe(true);
    expect(verifySignedCheckpoint(chain, cp, publicKeyFromSecretKey(SECRET_KEY)).ok).toBe(true);

    // And the unknown field is genuinely under the checkpoint: flip it -> both hash + sig fail.
    const tampered = readAuditLog(path);
    (tampered[1] as unknown as Record<string, JsonValueT>)["futureField"] = "tampered";
    expect(verifyChain(toChainRecords(tampered)).ok).toBe(false);
  });
});

describe("warden audit reader — fail-closed on genuine faults (tolerant is not credulous)", () => {
  it("rejects a top-level `sig` on a non-checkpoint record (digest-excluded hiding place)", () => {
    const [r0] = buildChain([{ eventType: "session.start" }]);
    const withSig = { ...r0, sig: `ed25519:${Buffer.alloc(64).toString("base64")}` };
    writeFileSync(path, JSON.stringify(withSig) + "\n");
    expect(() => readAuditLog(path)).toThrow(AuditChainCorruptError);
  });

  it("rejects a top-level __proto__ record key", () => {
    const line = JSON.stringify(buildChain([{ eventType: "session.start" }])[0]).replace(
      /}$/,
      ',"__proto__":{"x":1}}',
    );
    writeFileSync(path, line + "\n");
    expect(() => readAuditLog(path)).toThrow(AuditChainCorruptError);
  });

  it("rejects a duplicate key", () => {
    const line = JSON.stringify(buildChain([{ eventType: "session.start" }])[0]).replace(
      /}$/,
      ',"seq":9}',
    );
    writeFileSync(path, line + "\n");
    expect(() => readAuditLog(path)).toThrow(AuditChainCorruptError);
  });

  it("still rejects a malformed known field (seq is a string)", () => {
    const record = buildChain([{ eventType: "session.start" }])[0]!;
    const line = JSON.stringify({ ...record, seq: "zero" });
    writeFileSync(path, line + "\n");
    expect(() => readAuditLog(path)).toThrow(AuditChainCorruptError);
  });

  it("still detects a tampered field as a chain break", () => {
    const records = buildChain([{ eventType: "session.start" }, { eventType: "session.end" }]);
    (records[0] as Record<string, JsonValueT>)["payload"] = { tampered: true };
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    expect(() => readAuditLog(path)).toThrow(AuditChainCorruptError);
  });
});
