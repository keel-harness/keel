import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileLockBusyError, withFileLock, type FileLockDeps } from "./file-lock.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "keel-klock-"));
}

describe("withFileLock (kernel)", () => {
  it("runs the critical section, stamps a 0600 lock, and releases it", () => {
    const target = join(tmp(), "store.json");
    const result = withFileLock(target, () => {
      expect(existsSync(`${target}.lock`)).toBe(true);
      expect(statSync(`${target}.lock`).mode & 0o777).toBe(0o600);
      const raw = JSON.parse(readFileSync(`${target}.lock`, "utf8")) as { pid: number };
      expect(raw.pid).toBe(process.pid);
      return 42;
    });
    expect(result).toBe(42);
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it("releases the lock even when the critical section throws", () => {
    const target = join(tmp(), "store.json");
    expect(() =>
      withFileLock(target, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it("throws FileLockBusyError when a live process holds the lock", () => {
    const target = join(tmp(), "store.json");
    writeFileSync(`${target}.lock`, `${JSON.stringify({ pid: process.pid, path: target })}\n`);
    expect(() => withFileLock(target, () => 1)).toThrow(FileLockBusyError);
  });

  it("reclaims a stale lock whose owner PID is dead", () => {
    const target = join(tmp(), "store.json");
    // 2^31-1 is not a live process on the test host.
    writeFileSync(`${target}.lock`, `${JSON.stringify({ pid: 2147483647, path: target })}\n`);
    expect(withFileLock(target, () => "ran")).toBe("ran");
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it("treats a malformed lock file as busy (fail closed)", () => {
    const target = join(tmp(), "store.json");
    writeFileSync(`${target}.lock`, "not json");
    expect(() => withFileLock(target, () => 1)).toThrow(FileLockBusyError);
  });

  it("treats a lock with a non-positive/invalid pid as busy (fail closed)", () => {
    const target = join(tmp(), "store.json");
    writeFileSync(`${target}.lock`, `${JSON.stringify({ pid: -1, path: target })}\n`);
    expect(() => withFileLock(target, () => 1)).toThrow(FileLockBusyError);
  });

  // --- failure/cleanup/reclaim branches via the injection seam ---

  it("cleans up and rethrows when stamping the fresh lock fails (no leaked lock)", () => {
    const unlinked: string[] = [];
    const deps: FileLockDeps = {
      mkdirSync: () => {},
      openSync: () => 7,
      writeSync: () => {
        throw new Error("ENOSPC");
      },
      fsyncSync: () => {},
      closeSync: () => {},
      unlinkSync: (p) => {
        unlinked.push(p);
      },
      renameSync: () => {},
      readFileSync: () => "",
      isProcessAlive: () => false,
    };
    expect(() => withFileLock("/x/store.json", () => 1, deps)).toThrow("ENOSPC");
    // the half-written lock was unlinked during cleanup
    expect(unlinked).toContain("/x/store.json.lock");
  });

  it("retries when another reclaimer wins the rename race (ENOENT), then acquires", () => {
    let opens = 0;
    const deps: FileLockDeps = {
      mkdirSync: () => {},
      openSync: () => {
        opens += 1;
        if (opens === 1) {
          const e = new Error("exists") as NodeJS.ErrnoException;
          e.code = "EEXIST";
          throw e; // first create loses to an existing (stale) lock
        }
        return 11; // second create wins
      },
      writeSync: () => {},
      fsyncSync: () => {},
      closeSync: () => {},
      unlinkSync: () => {},
      renameSync: () => {
        const e = new Error("gone") as NodeJS.ErrnoException;
        e.code = "ENOENT"; // another reclaimer already moved the stale lock
        throw e;
      },
      readFileSync: () => JSON.stringify({ pid: 999999999 }),
      isProcessAlive: () => false, // the stale pid is dead
    };
    expect(withFileLock("/x/store.json", () => "ok", deps)).toBe("ok");
    expect(opens).toBe(2);
  });

  it("fails closed (restores, does not steal) when the claimed lock turns out to be LIVE", () => {
    const renames: Array<[string, string]> = [];
    let aliveCalls = 0;
    const deps: FileLockDeps = {
      mkdirSync: () => {},
      openSync: () => {
        const e = new Error("exists") as NodeJS.ErrnoException;
        e.code = "EEXIST";
        throw e; // the lock always already exists
      },
      writeSync: () => {},
      fsyncSync: () => {},
      closeSync: () => {},
      unlinkSync: () => {
        throw new Error("must not unlink a live lock");
      },
      renameSync: (from, to) => {
        renames.push([from, to]);
      },
      readFileSync: () => JSON.stringify({ pid: 4242 }),
      isProcessAlive: () => {
        aliveCalls += 1;
        // First check (the existing lock's pid): dead → eligible to reclaim.
        // Second check (the CLAIMED file's pid): alive → we grabbed a freshly-recreated live lock.
        return aliveCalls >= 2;
      },
    };
    expect(() => withFileLock("/x/store.json", () => 1, deps)).toThrow(FileLockBusyError);
    // it renamed the lock away to claim it, then renamed it BACK to restore (never unlinked it)
    expect(renames).toHaveLength(2);
    expect(renames[0]![0]).toBe("/x/store.json.lock"); // claim
    expect(renames[1]![1]).toBe("/x/store.json.lock"); // restore
  });

  it("fails closed when contention exhausts the acquire attempt budget", () => {
    const deps: FileLockDeps = {
      mkdirSync: () => {},
      openSync: () => {
        const e = new Error("exists") as NodeJS.ErrnoException;
        e.code = "EEXIST";
        throw e; // never succeeds
      },
      writeSync: () => {},
      fsyncSync: () => {},
      closeSync: () => {},
      unlinkSync: () => {},
      renameSync: () => {}, // reclaim always "succeeds" but the create keeps losing
      readFileSync: () => JSON.stringify({ pid: 999999999 }),
      isProcessAlive: () => false, // always stale → always reclaim → loop until budget exhausts
    };
    expect(() => withFileLock("/x/store.json", () => 1, deps)).toThrow(FileLockBusyError);
  });

  it("propagates a non-EEXIST open error unchanged", () => {
    const deps: FileLockDeps = {
      mkdirSync: () => {},
      openSync: () => {
        throw new Error("EACCES: permission denied");
      },
    };
    expect(() => withFileLock("/x/store.json", () => 1, deps)).toThrow("EACCES");
  });

  it("propagates a non-ENOENT rename error during reclaim", () => {
    const deps: FileLockDeps = {
      mkdirSync: () => {},
      openSync: () => {
        const e = new Error("exists") as NodeJS.ErrnoException;
        e.code = "EEXIST";
        throw e;
      },
      readFileSync: () => JSON.stringify({ pid: 999999999 }),
      isProcessAlive: () => false,
      renameSync: () => {
        throw new Error("EACCES during reclaim rename");
      },
    };
    expect(() => withFileLock("/x/store.json", () => 1, deps)).toThrow("EACCES during reclaim");
  });

  it("tolerates a failing restore when the claimed lock is live (still fails closed)", () => {
    let aliveCalls = 0;
    let renames = 0;
    const deps: FileLockDeps = {
      mkdirSync: () => {},
      openSync: () => {
        const e = new Error("exists") as NodeJS.ErrnoException;
        e.code = "EEXIST";
        throw e;
      },
      readFileSync: () => JSON.stringify({ pid: 4242 }),
      isProcessAlive: () => (aliveCalls += 1) >= 2, // existing=dead, claimed=live
      renameSync: () => {
        renames += 1;
        if (renames === 2) throw new Error("restore failed"); // the best-effort restore throws
      },
      unlinkSync: () => {},
    };
    expect(() => withFileLock("/x/store.json", () => 1, deps)).toThrow(FileLockBusyError);
  });

  it("tolerates a failing unlink of the claimed stale inode", () => {
    let opens = 0;
    const deps: FileLockDeps = {
      mkdirSync: () => {},
      openSync: () => {
        opens += 1;
        if (opens === 1) {
          const e = new Error("exists") as NodeJS.ErrnoException;
          e.code = "EEXIST";
          throw e;
        }
        return 3; // second create wins
      },
      writeSync: () => {},
      fsyncSync: () => {},
      closeSync: () => {},
      readFileSync: () => JSON.stringify({ pid: 999999999 }),
      isProcessAlive: () => false,
      renameSync: () => {},
      unlinkSync: (p) => {
        if (p.includes(".dead.")) throw new Error("unlink claimed failed"); // tolerated
      },
    };
    expect(withFileLock("/x/store.json", () => "ok", deps)).toBe("ok");
  });

  it("keeps the original write error even when cleanup unlink also fails", () => {
    const deps: FileLockDeps = {
      mkdirSync: () => {},
      openSync: () => 9,
      writeSync: () => {
        throw new Error("primary ENOSPC");
      },
      fsyncSync: () => {},
      closeSync: () => {},
      renameSync: () => {},
      readFileSync: () => "",
      isProcessAlive: () => false,
      unlinkSync: () => {
        throw new Error("secondary unlink failure");
      },
    };
    expect(() => withFileLock("/x/store.json", () => 1, deps)).toThrow("primary ENOSPC");
  });

  it("tolerates a failing close during release", () => {
    const deps: FileLockDeps = {
      mkdirSync: () => {},
      openSync: () => 5,
      writeSync: () => {},
      fsyncSync: () => {},
      renameSync: () => {},
      readFileSync: () => "",
      isProcessAlive: () => false,
      closeSync: () => {
        throw new Error("close failed");
      },
      unlinkSync: () => {},
    };
    expect(withFileLock("/x/store.json", () => "done", deps)).toBe("done");
  });

  it("tolerates a failing unlink during release (best-effort)", () => {
    const closeSpy = vi.fn();
    let releaseUnlink = false;
    const deps: FileLockDeps = {
      mkdirSync: () => {},
      openSync: () => 5,
      writeSync: () => {},
      fsyncSync: () => {},
      closeSync: closeSpy,
      renameSync: () => {},
      readFileSync: () => "",
      isProcessAlive: () => false,
      unlinkSync: () => {
        if (releaseUnlink) throw new Error("unlink failed");
      },
    };
    const out = withFileLock(
      "/x/store.json",
      () => {
        releaseUnlink = true; // make the release-time unlink throw
        return "done";
      },
      deps,
    );
    expect(out).toBe("done");
    expect(closeSpy).toHaveBeenCalled();
  });
});
