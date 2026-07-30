import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
import { type PrincipalT, toChainRecords, verifyChain } from "@keel/shared";
import { AuditChainWriter, type AuditWriterAppendIo, readAuditLog } from "./writer.js";

// P1-2 — the durable append path must survive a short write (POSIX write(2) may write fewer bytes
// than requested) and a mid-write ENOSPC without poisoning the on-disk chain. A partial record must
// never be left where a later append concatenates onto it (→ interior malformed line → the whole
// session's evidence bundle becomes permanently unverifiable).

const PRINCIPAL: PrincipalT = {
  osUser: "alice",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
};
const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FIXED_TS = "2026-07-13T14:00:00.000Z";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-audit-sw-"));
  path = join(dir, "audit.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openWith(io: AuditWriterAppendIo) {
  return AuditChainWriter.open({ path, principal: PRINCIPAL, now: () => FIXED_TS, io });
}

/** An io that writes at most `maxBytesPerWrite` bytes per call (a real, deterministic short write)
 *  and otherwise delegates to the real fs. */
function shortWritingIo(maxBytesPerWrite: number): AuditWriterAppendIo {
  return {
    writeSync: (fd, data, offset, length) =>
      realWriteSync(fd, data, offset, Math.min(length, maxBytesPerWrite)),
    fsyncSync: (fd) => realFsyncSync(fd),
    ftruncateSync: (fd, len) => realFtruncateSync(fd, len),
  };
}

describe("AuditChainWriter durable append integrity (P1-2)", () => {
  it("loops short writes so a record is never left partial on disk", () => {
    // 8 bytes/call ≪ a record line, so a single unchecked writeSync would drop most of every record.
    const w = openWith(shortWritingIo(8));
    const a = w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 1 } });
    const b = w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 2 } });
    w.close();

    const records = readAuditLog(path);
    expect(records.map((r) => r.hash)).toEqual([a.hash, b.hash]);
    expect(verifyChain(toChainRecords(records)).ok).toBe(true);
  });

  it("rolls back the partial bytes and poisons the writer when a write fails mid-record", () => {
    let failNext = false;
    const io: AuditWriterAppendIo = {
      writeSync: (fd, data, offset, length) => {
        if (failNext) {
          // Write a few real bytes (a torn partial), then fault like a disk filling up.
          realWriteSync(fd, data, offset, Math.min(length, 5));
          const err = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
          err.code = "ENOSPC";
          throw err;
        }
        return realWriteSync(fd, data, offset, length);
      },
      fsyncSync: (fd) => realFsyncSync(fd),
      ftruncateSync: (fd, len) => realFtruncateSync(fd, len),
    };

    const w = openWith(io);
    const a = w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 1 } });
    const goodBytes = statSync(path).size;

    failNext = true;
    expect(() =>
      w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 2 } }),
    ).toThrow(/ENOSPC/);

    // The partial bytes must be rolled off disk — the chain is intact up to the last good record.
    expect(statSync(path).size).toBe(goodBytes);

    // The writer is poisoned: it must NOT append a new record on top of a torn tail (that is exactly
    // how the chain gets permanently corrupted). It fails closed instead.
    failNext = false;
    expect(() =>
      w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 3 } }),
    ).toThrow(/poison/i);

    const records = readAuditLog(path);
    expect(records.map((r) => r.hash)).toEqual([a.hash]);
    expect(verifyChain(toChainRecords(records)).ok).toBe(true);
  });

  it("poisons and rolls back when fsync fails after the bytes are written", () => {
    let failFsync = false;
    const io: AuditWriterAppendIo = {
      writeSync: (fd, data, offset, length) => realWriteSync(fd, data, offset, length),
      fsyncSync: (fd) => {
        if (failFsync) {
          const err = new Error("EIO: fsync failed") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        }
        realFsyncSync(fd);
      },
      ftruncateSync: (fd, len) => realFtruncateSync(fd, len),
    };

    const w = openWith(io);
    const a = w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 1 } });
    const goodBytes = statSync(path).size;

    failFsync = true;
    expect(() =>
      w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 2 } }),
    ).toThrow(/EIO/);
    expect(statSync(path).size).toBe(goodBytes);

    failFsync = false;
    expect(() =>
      w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 3 } }),
    ).toThrow(/poison/i);

    const records = readAuditLog(path);
    expect(records.map((r) => r.hash)).toEqual([a.hash]);
  });

  it("a poisoned writer closes cleanly (releases the lock) and a fresh writer resumes the valid chain", () => {
    let failNext = false;
    const io: AuditWriterAppendIo = {
      writeSync: (fd, data, offset, length) => {
        if (failNext) {
          realWriteSync(fd, data, offset, Math.min(length, 5));
          const err = new Error("ENOSPC") as NodeJS.ErrnoException;
          err.code = "ENOSPC";
          throw err;
        }
        return realWriteSync(fd, data, offset, length);
      },
      fsyncSync: (fd) => realFsyncSync(fd),
      ftruncateSync: (fd, len) => realFtruncateSync(fd, len),
    };

    const w = openWith(io);
    const a = w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 1 } });
    const goodBytes = statSync(path).size;
    failNext = true;
    expect(() =>
      w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 2 } }),
    ).toThrow(/ENOSPC/);
    // This fix specifically: the partial bytes are already rolled off and the SAME writer refuses to
    // append again — the recovery below therefore relies on the new poison+rollback, not only on
    // open()'s torn-tail truncation.
    expect(statSync(path).size).toBe(goodBytes);
    expect(() =>
      w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 99 } }),
    ).toThrow(/poison/i);
    // close() must not throw despite the poison, and must release the lock.
    expect(() => w.close()).not.toThrow();

    // A fresh writer (real fs) opens the same path, reads the intact [A], and continues the chain.
    const w2 = AuditChainWriter.open({ path, principal: PRINCIPAL, now: () => FIXED_TS });
    const c = w2.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 3 } });
    w2.close();

    const records = readAuditLog(path);
    expect(records.map((r) => r.hash)).toEqual([a.hash, c.hash]);
    expect(records[1]!.prevHash).toBe(a.hash);
    expect(verifyChain(toChainRecords(records)).ok).toBe(true);
  });

  it("fails closed on a pathological zero-progress write instead of spinning forever", () => {
    let stall = false;
    const io: AuditWriterAppendIo = {
      writeSync: (fd, data, offset, length) =>
        stall ? 0 : realWriteSync(fd, data, offset, length),
      fsyncSync: (fd) => realFsyncSync(fd),
      ftruncateSync: (fd, len) => realFtruncateSync(fd, len),
    };
    const w = openWith(io);
    const a = w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 1 } });
    stall = true;
    expect(() =>
      w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 2 } }),
    ).toThrow(/no progress/);
    stall = false;
    expect(() =>
      w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 3 } }),
    ).toThrow(/poison/i);
    expect(readAuditLog(path).map((r) => r.hash)).toEqual([a.hash]);
  });

  it("stays poisoned even when the best-effort rollback truncation also faults", () => {
    let failWrite = false;
    const io: AuditWriterAppendIo = {
      writeSync: (fd, data, offset, length) => {
        if (failWrite) {
          const err = new Error("ENOSPC") as NodeJS.ErrnoException;
          err.code = "ENOSPC";
          throw err;
        }
        return realWriteSync(fd, data, offset, length);
      },
      fsyncSync: (fd) => realFsyncSync(fd),
      // The rollback truncation itself faults — the writer must still poison (fail closed).
      ftruncateSync: () => {
        throw new Error("EIO: ftruncate failed");
      },
    };
    const w = openWith(io);
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 1 } });
    failWrite = true;
    expect(() =>
      w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 2 } }),
    ).toThrow(/ENOSPC/);
    // Rollback couldn't truncate, but the writer is still poisoned — it refuses to append again.
    failWrite = false;
    expect(() =>
      w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 3 } }),
    ).toThrow(/poison/i);
  });

  it("refuses checkpointNow() on a poisoned writer", () => {
    let failWrite = false;
    const io: AuditWriterAppendIo = {
      writeSync: (fd, data, offset, length) => {
        if (failWrite) {
          const err = new Error("ENOSPC") as NodeJS.ErrnoException;
          err.code = "ENOSPC";
          throw err;
        }
        return realWriteSync(fd, data, offset, length);
      },
      fsyncSync: (fd) => realFsyncSync(fd),
      ftruncateSync: (fd, len) => realFtruncateSync(fd, len),
    };
    const w = AuditChainWriter.open({
      path,
      principal: PRINCIPAL,
      now: () => FIXED_TS,
      io,
      checkpoint: { cadence: 100, secretKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1) },
    });
    w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 1 } });
    failWrite = true;
    expect(() =>
      w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 2 } }),
    ).toThrow(/ENOSPC/);
    expect(() => w.checkpointNow()).toThrow(/poison/i);
  });

  it("keeps the healthy path byte-for-byte identical (looping does not change output)", () => {
    const w = openWith(shortWritingIo(1_000_000)); // effectively one write per record
    const a = w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: { n: 1 } });
    w.close();
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).toBe(`${JSON.stringify(a)}\n`);
  });
});
