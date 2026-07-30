import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnyAuditRecord,
  type AnyAuditRecordT,
  type AuditCheckpointRecordT,
  GENESIS_PREV_HASH,
  hashAuditRecord,
  type JsonValueT,
  type PrincipalT,
  type SideEffectT,
  publicKeyFromSecretKey,
  toChainRecords,
  verifySignedCheckpoint,
  verifyChain,
} from "@keel/shared";
import { AuditChainCorruptError, AuditChainWriter, readAuditLog } from "./writer.js";

const PRINCIPAL: PrincipalT = {
  osUser: "alice",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
};

const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";

/** A minimal valid SideEffect (required on tool.execute / tool.deny records). */
const SIDE_EFFECT: SideEffectT = {
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
    classifier: { name: "test-classifier", version: "1", confidence: "exact", reasons: [] },
  },
};

const FIXED_TS = "2026-06-26T14:00:00.000Z";
const CHECKPOINT_SECRET_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const POLICY_PACK = { name: "starter", hash: `sha256:${"a".repeat(64)}` as const };

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-audit-"));
  path = join(dir, "audit.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function open() {
  return AuditChainWriter.open({ path, principal: PRINCIPAL, now: () => FIXED_TS });
}

function openWithCheckpoints(cadence = 2) {
  return AuditChainWriter.open({
    path,
    principal: PRINCIPAL,
    now: () => FIXED_TS,
    checkpoint: { cadence, secretKey: CHECKPOINT_SECRET_KEY },
  });
}

function openWithPolicyPack() {
  return AuditChainWriter.open({
    path,
    principal: PRINCIPAL,
    now: () => FIXED_TS,
    policyPack: POLICY_PACK,
  });
}

function loadRecords(): AnyAuditRecordT[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => AnyAuditRecord.parse(JSON.parse(l)));
}

describe("AuditChainWriter (warden-owned hash-chained JSONL — Epic 2.6)", () => {
  it("appends linked records that verify as a chain (walking skeleton)", () => {
    const w = open();
    const start = w.append({
      eventType: "session.start",
      sessionId: SESSION_ID,
      payload: { kind: "start" },
    });
    const exec = w.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { command: "ls" },
      sideEffect: SIDE_EFFECT,
    });

    const records = loadRecords();
    expect(records).toHaveLength(2);
    expect(records[0]!.seq).toBe(0);
    expect(records[0]!.prevHash).toBe(GENESIS_PREV_HASH);
    expect(records[1]!.seq).toBe(1);
    expect(records[1]!.prevHash).toBe(start.hash);
    expect(records[1]!.hash).toBe(exec.hash);
    expect(verifyChain(toChainRecords(records)).ok).toBe(true);
  });

  it("stamps the principal on every record", () => {
    const w = open();
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    expect(loadRecords()[0]!.principal).toEqual(PRINCIPAL);
  });

  it("defaults the timestamp to wall-clock ISO 8601 when no clock is injected", () => {
    const w = AuditChainWriter.open({ path, principal: PRINCIPAL });
    const r = w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    // A canonical ISO-8601 instant round-trips through Date unchanged.
    expect(new Date(r.ts).toISOString()).toBe(r.ts);
  });

  it("carries policy and provenance fields through to the record", () => {
    const w = open();
    const policy = {
      packName: "default",
      packHash: `sha256:${"a".repeat(64)}` as const,
      ruleIds: ["POL-002"],
      verdict: "allow" as const,
    };
    const provenance = { inputTags: ["untrusted" as const], resultTag: null };
    w.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { command: "ls" },
      sideEffect: SIDE_EFFECT,
      policy,
      provenance,
    });
    const rec = loadRecords()[0]!;
    expect(rec.policy).toEqual(policy);
    expect(rec.provenance).toEqual(provenance);
    expect(verifyChain(toChainRecords(loadRecords())).ok).toBe(true);
  });

  it("stamps the active policy-pack reference on non-policy records", () => {
    const w = openWithPolicyPack();
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });

    expect(loadRecords()[0]!.policyPack).toEqual({
      packName: POLICY_PACK.name,
      packHash: POLICY_PACK.hash,
    });
    expect(verifyChain(toChainRecords(loadRecords())).ok).toBe(true);
  });

  it("stamps the active policy-pack reference on signed checkpoint records", () => {
    const w = AuditChainWriter.open({
      path,
      principal: PRINCIPAL,
      now: () => FIXED_TS,
      policyPack: POLICY_PACK,
      checkpoint: { cadence: 1, secretKey: CHECKPOINT_SECRET_KEY },
    });
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });

    const records = loadRecords();
    expect(records).toHaveLength(2);
    expect(records[0]!.policyPack).toEqual({
      packName: POLICY_PACK.name,
      packHash: POLICY_PACK.hash,
    });
    expect(records[1]!.eventType).toBe("checkpoint");
    expect(records[1]!.policyPack).toEqual({
      packName: POLICY_PACK.name,
      packHash: POLICY_PACK.hash,
    });
    expect(
      verifySignedCheckpoint(
        toChainRecords(records.slice(0, 1)),
        records[1] as AuditCheckpointRecordT,
        publicKeyFromSecretKey(CHECKPOINT_SECRET_KEY),
      ).ok,
    ).toBe(true);
    expect(verifyChain(toChainRecords(records)).ok).toBe(true);
  });

  it("reports the genesis head when empty and the last record after appends", () => {
    const w = open();
    expect(w.head).toEqual({ seq: -1, hash: GENESIS_PREV_HASH });
    const r = w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    expect(w.head).toEqual({ seq: 0, hash: r.hash });
  });

  it("writes tool.deny with the same classification fidelity as tool.execute", () => {
    const w = open();
    const deny = w.append({
      eventType: "tool.deny",
      sessionId: SESSION_ID,
      payload: { command: "rm -rf /" },
      sideEffect: SIDE_EFFECT,
    });
    expect(deny.eventType).toBe("tool.deny");
    expect(deny).toHaveProperty("sideEffect");
    expect(verifyChain(toChainRecords(loadRecords())).ok).toBe(true);
  });

  it("refuses to record a tool.deny without a sideEffect (denials cannot be under-recorded)", () => {
    const w = open();
    expect(() =>
      w.append({ eventType: "tool.deny", sessionId: SESSION_ID, payload: { command: "x" } }),
    ).toThrow();
  });

  it("redacts secrets in the payload before write, and the hash commits to the redacted bytes", () => {
    const w = open();
    const secret = "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF1234";
    w.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { token: secret },
      sideEffect: SIDE_EFFECT,
    });

    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("[redacted:");
    expect(verifyChain(toChainRecords(loadRecords())).ok).toBe(true);
  });

  it("redacts secrets in NON-payload fields too (e.g. sideEffect classifier reasons)", () => {
    const w = open();
    const secret = "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF1234";
    const sideEffect: SideEffectT = {
      ...SIDE_EFFECT,
      dynamic: {
        ...SIDE_EFFECT.dynamic,
        classifier: { ...SIDE_EFFECT.dynamic.classifier, reasons: [`leaked ${secret}`] },
      },
    };
    w.append({ eventType: "tool.deny", sessionId: SESSION_ID, payload: { cmd: "x" }, sideEffect });
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(secret); // the redactor must reach every string leaf, not just payload
    expect(verifyChain(toChainRecords(loadRecords())).ok).toBe(true);
  });

  it("redacts a secret used as a payload object KEY, not only a value (QC §6)", () => {
    const w = open();
    const secret = "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF1234";
    // A model-controlled tool `args` object reaches the audit payload verbatim; a secret can sit in a
    // KEY position, not just a value. Before the fix, `redactJsonValue` copied keys through and the
    // secret was hashed + signed into the chain in cleartext.
    w.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { args: { [secret]: "1", path: "src/x.ts" } },
      sideEffect: SIDE_EFFECT,
    });

    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("[redacted:");
    expect(raw).toContain("path"); // a benign key is untouched
    expect(verifyChain(toChainRecords(loadRecords())).ok).toBe(true);
  });

  it("does not corrupt a benign high-entropy id used as a payload key (e.g. a ULID toolCallId)", () => {
    const w = open();
    const ulidKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    w.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { results: { [ulidKey]: "ok" } },
      sideEffect: SIDE_EFFECT,
    });
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain(ulidKey); // format-catalog-only key redaction spares benign high-entropy ids
    expect(verifyChain(toChainRecords(loadRecords())).ok).toBe(true);
  });

  it("resumes the chain on re-open (crash → fresh process)", () => {
    const w1 = open();
    w1.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w1.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { i: 1 },
      sideEffect: SIDE_EFFECT,
    });
    w1.close();

    const w2 = open(); // fresh process on the same file
    expect(w2.head.seq).toBe(1);
    const r3 = w2.append({ eventType: "session.end", sessionId: SESSION_ID, payload: {} });
    expect(r3.seq).toBe(2);

    const records = loadRecords();
    expect(records).toHaveLength(3);
    expect(verifyChain(toChainRecords(records)).ok).toBe(true);
  });

  it("emits a signed checkpoint at the configured cadence and keeps the hash chain valid", () => {
    const w = openWithCheckpoints(2);
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    const coveredHead = w.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { i: 1 },
      sideEffect: SIDE_EFFECT,
    });

    const records = loadRecords();
    expect(records).toHaveLength(3);
    expect(verifyChain(toChainRecords(records)).ok).toBe(true);
    expect(w.head.seq).toBe(2);

    const checkpoint = records[2] as AuditCheckpointRecordT;
    expect(checkpoint.eventType).toBe("checkpoint");
    expect(checkpoint.range).toEqual([0, 1]);
    expect(checkpoint.prevHash).toBe(coveredHead.hash);
    const publicKey = publicKeyFromSecretKey(CHECKPOINT_SECRET_KEY);
    expect(
      verifySignedCheckpoint(toChainRecords(records.slice(0, 2)), checkpoint, publicKey).ok,
    ).toBe(true);
  });

  it("emits a final signed checkpoint on close for records since the last checkpoint", () => {
    const w = openWithCheckpoints(128);
    const coveredHead = w.append({
      eventType: "session.start",
      sessionId: SESSION_ID,
      payload: { kind: "short-session" },
    });

    w.close();

    const records = loadRecords();
    expect(records).toHaveLength(2);
    expect(verifyChain(toChainRecords(records)).ok).toBe(true);
    const checkpoint = records[1] as AuditCheckpointRecordT;
    expect(checkpoint.eventType).toBe("checkpoint");
    expect(checkpoint.range).toEqual([0, 0]);
    expect(checkpoint.prevHash).toBe(coveredHead.hash);
    const publicKey = publicKeyFromSecretKey(CHECKPOINT_SECRET_KEY);
    expect(
      verifySignedCheckpoint(toChainRecords(records.slice(0, 1)), checkpoint, publicKey).ok,
    ).toBe(true);
  });

  it("treats checkpoint APIs as no-ops when checkpoint signing is not configured", () => {
    const w = open();

    expect(w.checkpointPublicKey()).toBeUndefined();
    expect(() => w.checkpointNow()).not.toThrow();
    expect(w.head.seq).toBe(-1);
    w.close();

    expect(existsSync(path)).toBe(false);
  });

  it("does not append an empty final checkpoint for checkpoint-enabled empty logs", () => {
    const w = openWithCheckpoints();

    expect(w.checkpointPublicKey()).toBeInstanceOf(Uint8Array);
    expect(() => w.checkpointNow()).not.toThrow();
    w.close();

    expect(existsSync(path)).toBe(false);
  });

  it("fails closed before taking a writer lock when checkpoint signing configuration is invalid", () => {
    expect(() =>
      AuditChainWriter.open({
        path,
        principal: PRINCIPAL,
        now: () => FIXED_TS,
        checkpoint: { cadence: 1, secretKey: new Uint8Array([1, 2, 3]) },
      }),
    ).toThrow(/checkpoint signing key/i);
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("wraps unexpected checkpoint public-key derivation failures before locking", async () => {
    vi.resetModules();
    vi.doMock("@keel/shared", async () => {
      const actual = await vi.importActual<typeof import("@keel/shared")>("@keel/shared");
      return {
        ...actual,
        publicKeyFromSecretKey: () => {
          throw new Error("synthetic key failure");
        },
      };
    });
    try {
      const { AuditChainWriter: DynamicAuditChainWriter } = await import("./writer.js");
      expect(() =>
        DynamicAuditChainWriter.open({
          path: join(dir, "dynamic-audit.jsonl"),
          principal: PRINCIPAL,
          now: () => FIXED_TS,
          checkpoint: { cadence: 1, secretKey: new Uint8Array(32) },
        }),
      ).toThrow(/not a valid Ed25519 secret key/i);
      expect(existsSync(join(dir, "dynamic-audit.jsonl.lock"))).toBe(false);
    } finally {
      vi.doUnmock("@keel/shared");
      vi.resetModules();
    }
  });

  it("enforces a single active writer per audit log and releases the lock on close", () => {
    const w1 = open();
    w1.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });

    expect(() => open()).toThrow(/already active|lock/i);

    w1.close();
    const w2 = open();
    expect(w2.head.seq).toBe(0);
    w2.close();
  });

  it("reclaims a stale writer lock when its recorded process is gone", () => {
    writeFileSync(`${path}.lock`, `${JSON.stringify({ pid: 99_999_999, path })}\n`);

    const w = open();
    expect(w.head).toEqual({ seq: -1, hash: GENESIS_PREV_HASH });
    w.close();
  });

  it("fails closed on live or malformed writer locks", () => {
    writeFileSync(`${path}.lock`, `${JSON.stringify({ pid: process.pid, path })}\n`);
    expect(() => open()).toThrow(/active writer lock/);

    unlinkSync(`${path}.lock`);
    writeFileSync(`${path}.lock`, "not-json\n");
    expect(() => open()).toThrow(/active writer lock/);
  });

  it("releases the writer lock if opening an existing corrupt chain fails", () => {
    writeFileSync(path, "{not valid json}\n");

    expect(() => open()).toThrow(AuditChainCorruptError);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("opens an existing empty audit log as the genesis head", () => {
    writeFileSync(path, "");

    const w = open();

    expect(w.head).toEqual({ seq: -1, hash: GENESIS_PREV_HASH });
    w.close();
  });

  it("treats close as idempotent and tolerates an already-removed lock file", () => {
    const w = open();
    unlinkSync(`${path}.lock`);

    expect(() => w.close()).not.toThrow();
    expect(() => w.close()).not.toThrow();
  });

  it("surfaces unexpected lock cleanup errors on close", () => {
    const w = open();
    unlinkSync(`${path}.lock`);
    mkdirSync(`${path}.lock`);

    expect(() => w.close()).toThrow();
  });

  it("rejects appends after close before touching the log", () => {
    const w = open();
    w.close();

    expect(() =>
      w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} }),
    ).toThrow(/closed audit chain writer/);
    expect(existsSync(path)).toBe(false);
  });

  it("surfaces filesystem errors while acquiring the writer lock", () => {
    const missingParentPath = join(dir, "missing", "audit.jsonl");
    expect(() =>
      AuditChainWriter.open({
        path: missingParentPath,
        principal: PRINCIPAL,
        now: () => FIXED_TS,
      }),
    ).toThrow(/ENOENT|no such/i);
  });

  it("tolerates a torn final line: loads up to the last complete record and recovers", () => {
    const w1 = open();
    w1.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w1.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { i: 1 },
      sideEffect: SIDE_EFFECT,
    });
    w1.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { i: 2 },
      sideEffect: SIDE_EFFECT,
    });
    w1.close();

    // Simulate a crash mid-append: a truncated, newline-less partial line at the tail.
    writeFileSync(path, '{"seq":3,"ts":"2026', { flag: "a" });

    const w2 = open();
    expect(w2.head.seq).toBe(2); // last COMPLETE record
    const records = loadRecords();
    expect(records).toHaveLength(3);
    expect(verifyChain(toChainRecords(records)).ok).toBe(true);

    // Recovery: the torn tail is dropped from disk so the next append keeps the chain valid.
    const r4 = w2.append({ eventType: "session.end", sessionId: SESSION_ID, payload: {} });
    expect(r4.seq).toBe(3);
    expect(verifyChain(toChainRecords(loadRecords())).ok).toBe(true);
  });

  it("fails closed when opening a chain whose interior is corrupt (not just a torn tail)", () => {
    const w1 = open();
    w1.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w1.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { i: 1 },
      sideEffect: SIDE_EFFECT,
    });
    w1.close();
    // Corrupt the FIRST (complete, newline-terminated) record's payload.
    const lines = readFileSync(path, "utf8").split("\n");
    const rec0 = JSON.parse(lines[0] as string) as { payload: unknown };
    rec0.payload = { tampered: true };
    lines[0] = JSON.stringify(rec0);
    writeFileSync(path, lines.join("\n"));

    expect(() => open()).toThrow(AuditChainCorruptError);
  });

  it("fails closed with a typed error on a malformed (non-JSON) interior line", () => {
    const w1 = open();
    w1.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w1.append({ eventType: "session.end", sessionId: SESSION_ID, payload: {} });
    w1.close();
    const lines = readFileSync(path, "utf8").split("\n");
    lines[0] = "{not valid json";
    writeFileSync(path, lines.join("\n"));

    expect(() => open()).toThrow(AuditChainCorruptError);
  });

  it("rejects an interior blank line as corruption (does not silently swallow it)", () => {
    const w1 = open();
    w1.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w1.append({ eventType: "session.end", sessionId: SESSION_ID, payload: {} });
    w1.close();
    const [l0, l1] = readFileSync(path, "utf8").split("\n");
    writeFileSync(path, `${l0!}\n\n${l1!}\n`); // blank line injected between two records

    expect(() => open()).toThrow(AuditChainCorruptError);
  });

  it("rejects caller-supplied checkpoint records; checkpoints are writer-owned and signed", () => {
    const w = open();
    expect(() =>
      // @ts-expect-error checkpoint is not an allowed append eventType
      w.append({ eventType: "checkpoint", sessionId: SESSION_ID, payload: {} }),
    ).toThrow();
    expect(existsSync(path)).toBe(false); // nothing was written
  });
});

describe("readAuditLog (read-only, no lock — for export)", () => {
  it("reads + verifies a log written by AuditChainWriter", () => {
    const w = open();
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { i: 1 },
      sideEffect: SIDE_EFFECT,
    });
    w.close();

    const records = readAuditLog(path);
    expect(records).toHaveLength(2);
    expect(verifyChain(toChainRecords(records)).ok).toBe(true);
  });

  it("reads an ACTIVE log without taking the writer lock", () => {
    const w = open(); // holds the exclusive lock
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    const records = readAuditLog(path); // must not contend for the lock
    expect(records).toHaveLength(1);
    w.close();
  });

  it("tolerates a torn final line WITHOUT truncating the file", () => {
    const w = open();
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w.close();
    const before = readFileSync(path).length;
    writeFileSync(path, '{"seq":1,"ts":"2026', { flag: "a" }); // torn partial

    expect(readAuditLog(path)).toHaveLength(1);
    expect(readFileSync(path).length).toBeGreaterThan(before); // not truncated (read-only)
  });

  it("fails closed (AuditChainCorruptError) on a tampered log", () => {
    const w = open();
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w.append({ eventType: "session.end", sessionId: SESSION_ID, payload: {} });
    w.close();
    const lines = readFileSync(path, "utf8").split("\n");
    const rec0 = JSON.parse(lines[0] as string) as { payload: unknown };
    rec0.payload = { tampered: true };
    lines[0] = JSON.stringify(rec0);
    writeFileSync(path, lines.join("\n"));

    expect(() => readAuditLog(path)).toThrow(AuditChainCorruptError);
  });
});

describe("AuditChainWriter — schemaVersion stamping (ADR-0072 §5 / P1-12 Slice 4)", () => {
  it("stamps schemaVersion=1 on every appended record", () => {
    const w = open();
    const rec = w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w.close();
    expect(rec.schemaVersion).toBe(1);
    // and it round-trips + verifies (the field is hash-committed)
    const read = readAuditLog(path);
    expect(read[0]!.schemaVersion).toBe(1);
    expect(verifyChain(toChainRecords(read)).ok).toBe(true);
  });

  it("stamps schemaVersion=1 on checkpoint records too", () => {
    const w = AuditChainWriter.open({
      path,
      principal: PRINCIPAL,
      now: () => FIXED_TS,
      checkpoint: { cadence: 1, secretKey: CHECKPOINT_SECRET_KEY },
    });
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    w.close();
    const checkpoint = readAuditLog(path).find(
      (r): r is AuditCheckpointRecordT => r.eventType === "checkpoint",
    );
    expect(checkpoint?.schemaVersion).toBe(1);
  });

  it("reopens an OLDER keel's log (no schemaVersion) and appends — the mixed chain verifies", () => {
    // Back-compat seam (ADR-0072 §5): a legacy record written before this field existed. Hash it
    // exactly as an older keel would (no schemaVersion), then reopen + append a v1 record.
    const legacy: Record<string, JsonValueT> = {
      seq: 0,
      ts: FIXED_TS,
      sessionId: SESSION_ID,
      principal: { ...PRINCIPAL },
      eventType: "session.start",
      payload: {},
      prevHash: GENESIS_PREV_HASH,
    };
    writeFileSync(path, `${JSON.stringify({ ...legacy, hash: hashAuditRecord(legacy) })}\n`);

    const w = AuditChainWriter.open({ path, principal: PRINCIPAL, now: () => FIXED_TS });
    w.append({ eventType: "session.end", sessionId: SESSION_ID, payload: {} });
    w.close();

    const records = readAuditLog(path);
    expect(records).toHaveLength(2);
    // The legacy record still has NO schemaVersion; the new one carries 1 — a mixed-version chain.
    expect(records[0]!.schemaVersion).toBeUndefined();
    expect(records[1]!.schemaVersion).toBe(1);
    expect(verifyChain(toChainRecords(records)).ok).toBe(true);
  });
});
