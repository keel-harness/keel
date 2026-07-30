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

/** Injection seam (test determinism) — defaults to real `node:fs`. Mirrors `WorkspaceDeps`. */
export interface AtomicWriteDeps {
  readonly mkdirSync?: (path: string) => void;
  readonly openSync?: (path: string, flags: string, mode?: number) => number;
  readonly writeFileSync?: (fd: number, data: string) => void;
  readonly fsyncSync?: (fd: number) => void;
  readonly closeSync?: (fd: number) => void;
  readonly renameSync?: (from: string, to: string) => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AtomicWriteError extends Error {
  readonly mutationPossible: boolean;
  override readonly cause: unknown;
  override readonly name = "AtomicWriteError";

  constructor(cause: unknown, mutationPossible: boolean) {
    super(messageOf(cause));
    this.cause = cause;
    this.mutationPossible = mutationPossible;
  }
}

function closeQuietly(fd: number, close: (fd: number) => void): void {
  try {
    close(fd);
  } catch {
    // Cleanup path: preserve the original write/rename/fsync error.
  }
}

/**
 * Write `content` to `abs` atomically: create parent dirs (`mkdir -p`), write a uniquely-named temp
 * file in the target's OWN directory (same filesystem, so `rename` is atomic — a cross-device
 * `os.tmpdir()` temp would fail `EXDEV`), then rename over the target. Failures before `rename`
 * leave the target untouched; failures after `rename` throw `AtomicWriteError` with
 * `mutationPossible=true` so callers do not treat the target as known unchanged.
 *
 * `mode` (Epic 1.9 QC — SEC-1) sets the temp's permission bits **at creation**, which `rename`
 * preserves onto the target — so an owner-only `0o600` credential write is durable (Node only honors
 * `mode` when a file is *created*, so the unique temp must be fresh; see below). The temp is opened
 * with the exclusive `wx` flag (`O_CREAT|O_EXCL`): a pre-existing or symlinked temp at that path
 * fails the open rather than being written *through* (defeats a planted-symlink write primitive and a
 * loose-perm leftover — SEC-2), which the random name already makes unguessable. The temp file is
 * `fsync`'d before rename and the parent directory after rename, so returning means both the bytes and
 * the directory entry have been handed to the filesystem for durability.
 */
export function atomicWrite(
  abs: string,
  content: string,
  deps: AtomicWriteDeps = {},
  mode?: number,
): void {
  const parent = dirname(abs);
  const mkdir = deps.mkdirSync ?? ((p) => void mkdirSync(p, { recursive: true }));
  const open = deps.openSync ?? ((p, flags, m) => openSync(p, flags, m));
  const write = deps.writeFileSync ?? ((fd, d) => writeFileSync(fd, d, { encoding: "utf8" }));
  const fsync = deps.fsyncSync ?? ((fd) => fsyncSync(fd));
  const close = deps.closeSync ?? ((fd) => closeSync(fd));
  const rename = deps.renameSync ?? ((from, to) => renameSync(from, to));
  mkdir(parent);
  const tmp = join(parent, `.${basename(abs)}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  let dirFd: number | undefined;
  let renamed = false;
  try {
    fd = open(tmp, "wx", mode);
    write(fd, content);
    fsync(fd);
    close(fd);
    fd = undefined;
    rename(tmp, abs);
    renamed = true;
    dirFd = open(parent, "r");
    fsync(dirFd);
    close(dirFd);
    dirFd = undefined;
  } catch (err) {
    if (fd !== undefined) closeQuietly(fd, close);
    if (dirFd !== undefined) closeQuietly(dirFd, close);
    rmSync(tmp, { force: true }); // best-effort; force => no throw if absent
    throw new AtomicWriteError(err, renamed);
  }
}
