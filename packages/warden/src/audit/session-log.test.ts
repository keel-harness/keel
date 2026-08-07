import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  fsyncSync as realFsyncSync,
  ftruncateSync as realFtruncateSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync as realWriteSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuditCheckpointRecordT,
  GENESIS_PREV_HASH,
  type PolicyPackRefT,
  type PrincipalT,
  type SideEffectT,
  publicKeyFromSecretKey,
  toChainRecords,
  verifySignedCheckpoint,
  verifyChain,
} from "@keel/shared";
import { type AuditWriterAppendIo, readAuditLog } from "./writer.js";
import { SessionAuditLog } from "./session-log.js";

const PRINCIPAL: PrincipalT = {
  osUser: "alice",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
};
const SESSION_A = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SESSION_B = "ses_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const FIXED_TS = "2026-06-26T14:00:00.000Z";
const CHECKPOINT_SECRET_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const POLICY_PACK: PolicyPackRefT = {
  name: "test-policy-pack",
  hash: `sha256:${"a".repeat(64)}`,
};

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

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-sessionlog-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function log() {
  return new SessionAuditLog({ auditDir: dir, principal: PRINCIPAL, now: () => FIXED_TS });
}

function checkpointedLog(cadence = 128, policyPack?: PolicyPackRefT) {
  return new SessionAuditLog({
    auditDir: dir,
    principal: PRINCIPAL,
    now: () => FIXED_TS,
    ...(policyPack === undefined ? {} : { policyPack }),
    checkpoint: { cadence, secretKey: CHECKPOINT_SECRET_KEY },
  });
}

describe("SessionAuditLog (per-session audit chains)", () => {
  it("routes appends to per-session <auditDir>/<sessionId>.jsonl, each its own complete chain", () => {
    const l = log();
    l.append({ eventType: "session.start", sessionId: SESSION_A, payload: {} });
    l.append({
      eventType: "tool.execute",
      sessionId: SESSION_A,
      payload: { i: 1 },
      sideEffect: SIDE_EFFECT,
    });
    l.append({ eventType: "session.start", sessionId: SESSION_B, payload: {} });
    l.close();

    expect(l.pathFor(SESSION_A).endsWith(`${SESSION_A}.jsonl`)).toBe(true);
    expect(readAuditLog(l.pathFor(SESSION_A))).toHaveLength(2);
    expect(readAuditLog(l.pathFor(SESSION_B))).toHaveLength(1);
    expect(verifyChain(toChainRecords(readAuditLog(l.pathFor(SESSION_A)))).ok).toBe(true);
    expect(verifyChain(toChainRecords(readAuditLog(l.pathFor(SESSION_B)))).ok).toBe(true);
  });

  it("gives each session an independent chain starting at seq 0", () => {
    const l = log();
    const a0 = l.append({ eventType: "session.start", sessionId: SESSION_A, payload: {} });
    const a1 = l.append({ eventType: "session.end", sessionId: SESSION_A, payload: {} });
    const b0 = l.append({ eventType: "session.start", sessionId: SESSION_B, payload: {} });
    l.close();
    expect([a0.seq, a1.seq, b0.seq]).toEqual([0, 1, 0]);
  });

  it("reports the head of the most-recently-appended session (genesis when empty)", () => {
    const l = log();
    expect(l.head).toEqual({ seq: -1, hash: GENESIS_PREV_HASH });
    const a0 = l.append({ eventType: "session.start", sessionId: SESSION_A, payload: {} });
    expect(l.head).toEqual({ seq: 0, hash: a0.hash });
    l.close();
  });

  it("resumes a session chain across a fresh log instance", () => {
    const l1 = log();
    l1.append({ eventType: "session.start", sessionId: SESSION_A, payload: {} });
    l1.close();
    const l2 = log();
    const a1 = l2.append({ eventType: "session.end", sessionId: SESSION_A, payload: {} });
    l2.close();
    expect(a1.seq).toBe(1);
    expect(verifyChain(toChainRecords(readAuditLog(l2.pathFor(SESSION_A)))).ok).toBe(true);
  });

  it("passes checkpoint signing through to per-session writers and exposes the public key", () => {
    const l = checkpointedLog();
    const record = l.append({ eventType: "session.start", sessionId: SESSION_A, payload: {} });
    expect(
      Buffer.from(l.checkpointPublicKey()!).equals(
        Buffer.from(publicKeyFromSecretKey(CHECKPOINT_SECRET_KEY)),
      ),
    ).toBe(true);
    l.close();

    const records = readAuditLog(l.pathFor(SESSION_A));
    expect(records).toHaveLength(2);
    const checkpoint = records[1] as AuditCheckpointRecordT;
    expect(checkpoint.eventType).toBe("checkpoint");
    expect(checkpoint.prevHash).toBe(record.hash);
    expect(
      verifySignedCheckpoint(
        toChainRecords(records.slice(0, 1)),
        checkpoint,
        l.checkpointPublicKey()!,
      ).ok,
    ).toBe(true);
  });

  it("passes policy-pack context through to per-session records and checkpoints", () => {
    const l = checkpointedLog(1, POLICY_PACK);
    l.append({ eventType: "session.start", sessionId: SESSION_A, payload: {} });
    l.close();

    const records = readAuditLog(l.pathFor(SESSION_A));
    expect(records).toHaveLength(2);
    expect(records[0]?.policyPack).toEqual({
      packName: POLICY_PACK.name,
      packHash: POLICY_PACK.hash,
    });
    expect(records[1]?.eventType).toBe("checkpoint");
    expect(records[1]?.policyPack).toEqual({
      packName: POLICY_PACK.name,
      packHash: POLICY_PACK.hash,
    });
  });

  it("rejects a session id that is not a valid ULID (filename safety)", () => {
    const l = log();
    expect(() => l.pathFor("../evil")).toThrow();
    expect(() =>
      l.append({ eventType: "session.start", sessionId: "../evil", payload: {} }),
    ).toThrow();
    l.close();
  });

  it("forwards redactOptions and a default clock to the per-session writers", () => {
    // No `now` (default wall-clock) + redactOptions set — exercises both option spreads.
    const l = new SessionAuditLog({
      auditDir: dir,
      principal: PRINCIPAL,
      redactOptions: { entropyNet: false },
    });
    const secret = "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF1234";
    const r = l.append({
      eventType: "tool.execute",
      sessionId: SESSION_A,
      payload: { token: secret },
      sideEffect: SIDE_EFFECT,
    });
    l.close();
    expect(new Date(r.ts).toISOString()).toBe(r.ts); // default clock produced a valid ISO instant
    expect(readFileSync(l.pathFor(SESSION_A), "utf8")).not.toContain(secret); // redaction forwarded
  });

  it("close() releases all per-session writer locks", () => {
    const l = log();
    l.append({ eventType: "session.start", sessionId: SESSION_A, payload: {} });
    l.close();
    const l2 = log();
    expect(() =>
      l2.append({ eventType: "session.end", sessionId: SESSION_A, payload: {} }),
    ).not.toThrow();
    l2.close();
  });

  // P1-2 (QC S1/S2/S3) — a poisoned writer must recover IN-PROCESS: the on-disk chain is valid up to
  // the last durable record, so the next use evicts the poisoned writer and reopens the path, instead
  // of wedging the session (and its evidence export) until the warden restarts.

  /** An io whose write fails once (after a torn partial), then behaves normally — a transient blip. */
  function transientFaultIo(): { io: AuditWriterAppendIo; failOnce: () => void } {
    let armed = false;
    return {
      failOnce: () => {
        armed = true;
      },
      io: {
        writeSync: (fd, data, offset, length) => {
          if (armed) {
            armed = false;
            realWriteSync(fd, data, offset, Math.min(length, 5));
            const err = new Error("ENOSPC") as NodeJS.ErrnoException;
            err.code = "ENOSPC";
            throw err;
          }
          return realWriteSync(fd, data, offset, length);
        },
        fsyncSync: (fd) => realFsyncSync(fd),
        ftruncateSync: (fd, len) => realFtruncateSync(fd, len),
      },
    };
  }

  it("recovers a poisoned session in-process: the next append reopens and resumes the valid chain", () => {
    const { io, failOnce } = transientFaultIo();
    const l = new SessionAuditLog({ auditDir: dir, principal: PRINCIPAL, now: () => FIXED_TS, io });
    const a = l.append({ eventType: "session.start", sessionId: SESSION_A, payload: { n: 1 } });

    failOnce();
    expect(() =>
      l.append({ eventType: "session.start", sessionId: SESSION_A, payload: { n: 2 } }),
    ).toThrow(/ENOSPC/);

    // The transient fault cleared: the next append must succeed by evicting+reopening the writer,
    // NOT keep failing as "poisoned".
    const c = l.append({ eventType: "session.start", sessionId: SESSION_A, payload: { n: 3 } });
    l.close();

    const records = readAuditLog(l.pathFor(SESSION_A));
    expect(records.map((r) => r.hash)).toEqual([a.hash, c.hash]);
    expect(records[1]!.prevHash).toBe(a.hash);
    expect(verifyChain(toChainRecords(records)).ok).toBe(true);
  });

  it("can checkpoint (export pre-step) a session that was just poisoned", () => {
    const { io, failOnce } = transientFaultIo();
    const l = new SessionAuditLog({
      auditDir: dir,
      principal: PRINCIPAL,
      now: () => FIXED_TS,
      checkpoint: { cadence: 100, secretKey: CHECKPOINT_SECRET_KEY },
      io,
    });
    l.append({ eventType: "session.start", sessionId: SESSION_A, payload: { n: 1 } });
    failOnce();
    expect(() =>
      l.append({ eventType: "session.start", sessionId: SESSION_A, payload: { n: 2 } }),
    ).toThrow(/ENOSPC/);

    // warden.audit.export calls checkpointNow(sessionId) first — it must not stay wedged on the
    // poisoned writer; it evicts+reopens and checkpoints the valid on-disk chain.
    expect(() => l.checkpointNow(SESSION_A)).not.toThrow();
    l.close();

    const records = readAuditLog(l.pathFor(SESSION_A));
    expect(records.some((r) => r.eventType === "checkpoint")).toBe(true);
    expect(verifyChain(toChainRecords(records)).ok).toBe(true);
  });

  /** An io that, once armed, faults on EVERY write — a persistent fault (e.g. a full disk that does
   *  not recover), so even an evicted+reopened writer cannot make progress. */
  function persistentFaultIo(): { io: AuditWriterAppendIo; arm: () => void } {
    let armed = false;
    return {
      arm: () => {
        armed = true;
      },
      io: {
        writeSync: (fd, data, offset, length) => {
          if (armed) {
            const err = new Error("ENOSPC") as NodeJS.ErrnoException;
            err.code = "ENOSPC";
            throw err;
          }
          return realWriteSync(fd, data, offset, length);
        },
        fsyncSync: (fd) => realFsyncSync(fd),
        ftruncateSync: (fd, len) => realFtruncateSync(fd, len),
      },
    };
  }

  it("no-arg checkpointNow() surfaces a persistent per-session failure as an aggregate error", () => {
    const { io, arm } = persistentFaultIo();
    const l = new SessionAuditLog({
      auditDir: dir,
      principal: PRINCIPAL,
      now: () => FIXED_TS,
      checkpoint: { cadence: 100, secretKey: CHECKPOINT_SECRET_KEY },
      io,
    });
    l.append({ eventType: "session.start", sessionId: SESSION_A, payload: {} });
    arm();
    expect(() => l.checkpointNow()).toThrow(/audit checkpoint failed for 1 session/);
  });

  it("close() attempts every writer, releases all locks, and surfaces a close failure", () => {
    const { io, arm } = persistentFaultIo();
    const l = new SessionAuditLog({
      auditDir: dir,
      principal: PRINCIPAL,
      now: () => FIXED_TS,
      checkpoint: { cadence: 100, secretKey: CHECKPOINT_SECRET_KEY },
      io,
    });
    l.append({ eventType: "session.start", sessionId: SESSION_A, payload: {} });
    l.append({ eventType: "session.start", sessionId: SESSION_B, payload: {} });
    arm(); // the closing checkpoint write now faults for both sessions
    expect(() => l.close()).toThrow(/audit close failed for 2 session/);

    // Despite both closes throwing, every lock must have been released — a fresh log opens both.
    const l2 = log();
    expect(() =>
      l2.append({ eventType: "session.end", sessionId: SESSION_A, payload: {} }),
    ).not.toThrow();
    expect(() =>
      l2.append({ eventType: "session.end", sessionId: SESSION_B, payload: {} }),
    ).not.toThrow();
    l2.close();
  });

  it("no-arg checkpointNow() isolates a poisoned session and still checkpoints the healthy ones", () => {
    const { io, failOnce } = transientFaultIo();
    const l = new SessionAuditLog({
      auditDir: dir,
      principal: PRINCIPAL,
      now: () => FIXED_TS,
      checkpoint: { cadence: 100, secretKey: CHECKPOINT_SECRET_KEY },
      io,
    });
    l.append({ eventType: "session.start", sessionId: SESSION_A, payload: {} });
    l.append({ eventType: "session.start", sessionId: SESSION_B, payload: {} });
    failOnce();
    expect(() =>
      l.append({ eventType: "session.start", sessionId: SESSION_A, payload: { n: 2 } }),
    ).toThrow(/ENOSPC/);

    // The batch must not abort on session A's poison and skip B — both get checkpointed (A recovers).
    l.checkpointNow();
    l.close();

    expect(readAuditLog(l.pathFor(SESSION_A)).some((r) => r.eventType === "checkpoint")).toBe(true);
    expect(readAuditLog(l.pathFor(SESSION_B)).some((r) => r.eventType === "checkpoint")).toBe(true);
  });

  // The audit chain carries full command text, resolved paths, and model-authored tool args with
  // only best-effort redaction. Every neighbouring keel artifact is owner-only — the checkpoint
  // SIGNING key is 0600 and its loader rejects `mode & 0o077`, and sessions/ and snapshots/ are
  // 0700 — but the records that key signs were left at the process umask (0755 dir / 0644 files).
  // Under the default KEEL_HOME that is masked by a 0700 parent, but KEEL_WARDEN_AUDIT_DIR can
  // point anywhere, so on a multi-user host the chain became world-readable.
  describe("owner-only permissions", () => {
    it("creates the audit directory owner-only regardless of umask", () => {
      const l = log();
      l.append({ eventType: "session.start", sessionId: SESSION_A, payload: {} });
      l.close();
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    });

    it("tightens an already-permissive audit directory instead of trusting the caller", () => {
      // The kernel pre-creates this directory before spawning the warden, so mkdir's `mode` is a
      // no-op on every existing install. Repairing on open is what actually changes the outcome.
      chmodSync(dir, 0o755);
      const l = log();
      l.append({ eventType: "session.start", sessionId: SESSION_A, payload: {} });
      l.close();
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    });

    it("creates session chain files owner-only", () => {
      const l = log();
      l.append({ eventType: "session.start", sessionId: SESSION_A, payload: {} });
      l.close();
      expect(statSync(l.pathFor(SESSION_A)).mode & 0o777).toBe(0o600);
    });
  });
});
