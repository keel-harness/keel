import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** Injection seam (test determinism) — defaults to real `node:fs`. Mirrors the kernel
 *  `AtomicWriteDeps` so the failure/cleanup branch is exercisable deterministically. */
export interface AtomicWriteDeps {
  readonly mkdirSync?: (path: string) => void;
  readonly openSync?: (path: string, flags: string, mode?: number) => number;
  readonly writeFileSync?: (fd: number, data: string) => void;
  readonly fsyncSync?: (fd: number) => void;
  readonly closeSync?: (fd: number) => void;
  readonly renameSync?: (from: string, to: string) => void;
  readonly rmSync?: (path: string) => void;
}

export type AtomicWriteResult = "durable" | "replaced";

/**
 * Atomically write `content` to `abs`: unique temp in the target's OWN directory (same filesystem →
 * `rename` is atomic), `wx` open (a planted symlink/leftover fails the open rather than being written
 * through), fsync the file before rename and the parent dir after, so returning means the bytes and
 * the directory entry are durable. A failure before rename throws and leaves the target untouched.
 * A failure after rename returns `replaced`: the target is already authoritative in this process,
 * but crash durability was not confirmed. The result distinction is warden-specific because grant
 * callers must not report a denial after replacement has already installed authority.
 */
export function atomicWriteFile(
  abs: string,
  content: string,
  mode?: number,
  deps: AtomicWriteDeps = {},
): AtomicWriteResult {
  const parent = dirname(abs);
  const mkdir = deps.mkdirSync ?? ((p) => void mkdirSync(p, { recursive: true }));
  const open = deps.openSync ?? ((p, flags, m) => openSync(p, flags, m));
  const write = deps.writeFileSync ?? ((fd, d) => writeFileSync(fd, d, { encoding: "utf8" }));
  const fsync = deps.fsyncSync ?? ((fd) => fsyncSync(fd));
  const close = deps.closeSync ?? ((fd) => closeSync(fd));
  const rename = deps.renameSync ?? ((from, to) => renameSync(from, to));
  const rm = deps.rmSync ?? ((p) => rmSync(p, { force: true }));
  mkdir(parent);
  const tmp = join(parent, `.${basename(abs)}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  let dirFd: number | undefined;
  let replaced = false;
  try {
    fd = open(tmp, "wx", mode);
    write(fd, content);
    fsync(fd);
    close(fd);
    fd = undefined;
    rename(tmp, abs);
    replaced = true;
    dirFd = open(parent, "r");
    fsync(dirFd);
    close(dirFd);
    dirFd = undefined;
    return "durable";
  } catch (err) {
    if (fd !== undefined) {
      try {
        close(fd);
      } catch {
        /* preserve original error */
      }
    }
    if (dirFd !== undefined) {
      try {
        close(dirFd);
      } catch {
        /* preserve original error */
      }
    }
    try {
      rm(tmp);
    } catch {
      // Cleanup is best-effort. After rename there is no temp path to remove, and before rename a
      // cleanup failure must not replace the operation's original error with a secondary one.
    }
    if (replaced) return "replaced";
    throw err;
  }
}
