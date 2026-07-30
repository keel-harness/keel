import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** Raised when an authority-store lock is held by a live process — the caller must fail closed. */
export class FileLockBusyError extends Error {
  constructor(path: string) {
    super(`file lock is held by a live process: ${path}`);
    this.name = "FileLockBusyError";
  }
}

/** Injection seam (test determinism) — defaults to real `node:fs` + `process.kill` liveness. Lets the
 *  failure/cleanup/reclaim branches (which are otherwise timing-dependent) be exercised deterministically. */
export interface FileLockDeps {
  readonly mkdirSync?: (path: string) => void;
  readonly openSync?: (path: string, flags: string, mode?: number) => number;
  readonly writeSync?: (fd: number, data: string) => void;
  readonly fsyncSync?: (fd: number) => void;
  readonly closeSync?: (fd: number) => void;
  readonly unlinkSync?: (path: string) => void;
  readonly renameSync?: (from: string, to: string) => void;
  readonly readFileSync?: (path: string) => string;
  readonly isProcessAlive?: (pid: number) => boolean;
}

interface ResolvedDeps {
  readonly mkdirSync: (path: string) => void;
  readonly openSync: (path: string, flags: string, mode?: number) => number;
  readonly writeSync: (fd: number, data: string) => void;
  readonly fsyncSync: (fd: number) => void;
  readonly closeSync: (fd: number) => void;
  readonly unlinkSync: (path: string) => void;
  readonly renameSync: (from: string, to: string) => void;
  readonly readFileSync: (path: string) => string;
  readonly isProcessAlive: (pid: number) => boolean;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH => no such process (dead). Anything else (e.g. EPERM: owned by another user) => treat as
    // alive and fail closed.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function resolveDeps(deps: FileLockDeps): ResolvedDeps {
  return {
    mkdirSync: deps.mkdirSync ?? ((p) => void mkdirSync(p, { recursive: true })),
    openSync: deps.openSync ?? ((p, flags, m) => openSync(p, flags, m)),
    writeSync: deps.writeSync ?? ((fd, d) => void writeSync(fd, d)),
    fsyncSync: deps.fsyncSync ?? ((fd) => fsyncSync(fd)),
    closeSync: deps.closeSync ?? ((fd) => closeSync(fd)),
    unlinkSync: deps.unlinkSync ?? ((p) => unlinkSync(p)),
    renameSync: deps.renameSync ?? ((from, to) => renameSync(from, to)),
    readFileSync: deps.readFileSync ?? ((p) => readFileSync(p, "utf8")),
    isProcessAlive: deps.isProcessAlive ?? defaultIsProcessAlive,
  };
}

function lockPathFor(path: string): string {
  return `${path}.lock`;
}

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

/** The PID recorded in an existing lock, or `undefined` when the lock is unreadable, not valid JSON,
 *  or half-written (no positive integer `pid`). `undefined` is treated as busy — a half-created lock
 *  is never reclaimed (fail closed). */
function lockPid(lockPath: string, read: ResolvedDeps["readFileSync"]): number | undefined {
  try {
    const raw = JSON.parse(read(lockPath)) as { pid?: unknown };
    return typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0
      ? raw.pid
      : undefined;
  } catch {
    return undefined;
  }
}

// Per-process counter for unique reclaim-claim names (no randomness needed — the name only has to be
// unique within this process; different processes already differ by pid).
let reclaimCounter = 0;
const MAX_ACQUIRE_ATTEMPTS = 8;

function acquire(path: string, deps: ResolvedDeps): { lockPath: string; fd: number } {
  const lockPath = lockPathFor(path);
  deps.mkdirSync(dirname(path));
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    let fd: number;
    try {
      fd = deps.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
      // A lock file exists. Reclaim it ONLY if its recorded holder is provably dead; a malformed /
      // half-written lock (undefined pid) or a live holder fails closed.
      const pid = lockPid(lockPath, deps.readFileSync);
      if (pid === undefined || deps.isProcessAlive(pid)) throw new FileLockBusyError(path);
      // Stale holder. Claim the stale inode with an ATOMIC rename to a private name. Unlike
      // unlink-then-recreate, a rename of a given inode has exactly one winner, so two concurrent
      // reclaimers cannot both proceed to hold the lock (the loser gets ENOENT and retries the
      // exclusive create, where O_EXCL admits exactly one). A re-check after the claim makes even the
      // ultra-narrow "another process recreated a LIVE lock between our read and our rename" case fail
      // closed instead of stealing a live holder's lock.
      reclaimCounter += 1;
      const claimed = `${lockPath}.dead.${process.pid}.${reclaimCounter}`;
      try {
        deps.renameSync(lockPath, claimed);
      } catch (renameError) {
        if (errno(renameError) === "ENOENT") continue; // another reclaimer won the rename; retry
        throw renameError;
      }
      if (deps.isProcessAlive(lockPid(claimed, deps.readFileSync) ?? -1)) {
        // We claimed a lock that is actually LIVE (recreated in the window). Restore it best-effort and
        // fail closed — never steal a live holder's lock. A failed restore leaves a harmless orphan
        // `.dead.*` file (never `lockPath`, so it blocks nothing); doctor can sweep it.
        try {
          deps.renameSync(claimed, lockPath);
        } catch {
          /* best effort */
        }
        throw new FileLockBusyError(path);
      }
      try {
        deps.unlinkSync(claimed);
      } catch {
        /* best effort: the stale inode is exclusively ours; a failed unlink only orphans it */
      }
      continue; // retry the exclusive create
    }
    // We exclusively created the lock (O_EXCL). Stamp our pid so a future acquirer can detect staleness.
    try {
      deps.writeSync(fd, `${JSON.stringify({ pid: process.pid, path })}\n`);
      deps.fsyncSync(fd);
    } catch (error) {
      deps.closeSync(fd);
      try {
        deps.unlinkSync(lockPath);
      } catch {
        /* best effort */
      }
      throw error;
    }
    return { lockPath, fd };
  }
  // Contention exhausted the attempt budget — fail closed rather than spin.
  throw new FileLockBusyError(path);
}

/**
 * Run `fn` while holding an exclusive advisory lock at `<targetPath>.lock`, so a cross-process
 * read-modify-write of `targetPath` is serialized. Acquisition is NON-BLOCKING: it either wins,
 * reclaims a provably-dead holder's lock, or throws `FileLockBusyError` — it never waits, so a live
 * holder makes callers fail fast/closed rather than block. A SIGKILL'd holder is reclaimed via an
 * atomic rename (single-winner, no unlink-recreate double-hold).
 *
 * NOT reentrant: calling `withFileLock` for the same path from inside its own `fn` (same process) sees
 * a live self-PID and throws `FileLockBusyError` (fail closed, not deadlock). Keep critical sections
 * flat. Residual: after a SIGKILL, PID reuse can pin a lock as "live" until the reusing process exits
 * (fail-closed direction); an OS advisory lock (flock) would remove this but needs a dependency ADR.
 * Mirrors the audit-writer lock (`packages/warden/src/audit/writer.ts`) — a separate helper so the
 * security-critical audit spine is not refactored here (consolidation is a tracked follow-up).
 */
export function withFileLock<T>(targetPath: string, fn: () => T, deps: FileLockDeps = {}): T {
  const resolved = resolveDeps(deps);
  const lock = acquire(targetPath, resolved);
  try {
    return fn();
  } finally {
    try {
      resolved.closeSync(lock.fd);
    } catch {
      /* already closed */
    }
    try {
      resolved.unlinkSync(lock.lockPath);
    } catch {
      /* already removed */
    }
  }
}
