import { chmod, cp, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Run-start workspace snapshot (the structural answer to "keel must never permanently destroy a user's
 * irreplaceable inputs"). Before the agent acts, copy the (trusted) workspace to a byte-faithful,
 * owner-private recovery copy outside the workspace so the originals survive no matter what the agent does — model-independent, not
 * a prompt the model can ignore (the TB-2 db-wal-recovery failure: keel deleted the very file it was
 * asked to recover; guidance alone did not stop it).
 *
 * **Fail-open, never fail-closed:** this is a safety net, not a gate. A workspace that is too large, or
 * a copy that errors, SKIPS the snapshot with a reason and lets the run proceed — a backup that blocks
 * the task would be worse than no backup. The size caps keep a huge repo (where git is the real backup
 * anyway) from being copied; the case this protects is the small, un-versioned, irreplaceable input.
 */

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024; // 64 MiB — above this, skip (a big repo has git; copy is costly)
const DEFAULT_MAX_FILES = 2000;
const PRIVATE_DIRECTORY_MODE = 0o700;

export interface SnapshotResult {
  /** Whether the backup was actually written. */
  readonly taken: boolean;
  /** Where the backup is (or would have been). */
  readonly path: string;
  /** Measured size/count of the workspace (up to the point measurement stopped). */
  readonly bytes: number;
  readonly files: number;
  /** Present iff `taken` is false — the human-readable reason the snapshot was skipped. */
  readonly skippedReason?: string;
}

export interface SnapshotOptions {
  /** The workspace root to back up. */
  readonly root: string;
  /** Where to write the backup. Callers use a path under `keelHome`, whose whole root is denied to
   *  governed bash and typed tools; a nested Keel home is explicitly excluded from the source copy. */
  readonly dest: string;
  /** Owner-private Keel state root containing `dest`. The destination must be exactly one direct
   *  child of `<privateRoot>/snapshots`; both directories are verified as real, owner-controlled,
   *  mode-0700 directories before any workspace byte is retained. */
  readonly privateRoot: string;
  /** Absolute paths to skip in BOTH the size walk and the copy. Callers pass `keelHome` so that, in the
   *  edge case where it sits inside the workspace, the backup never recurses into keel's own state. */
  readonly exclude?: readonly string[];
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}

type PrivateDestinationResult =
  | { readonly ok: true; readonly root: string; readonly dest: string }
  | { readonly ok: false; readonly dest: string; readonly reason: string };

function ownedByCurrentUser(uid: number): boolean {
  const currentUid = process.getuid?.();
  return currentUid === undefined || uid === currentUid;
}

/** Establish one owner-private directory without accepting a symlink as the boundary itself. */
async function establishPrivateDirectory(path: string, label: string): Promise<string | undefined> {
  try {
    await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    let state = await lstat(path);
    if (state.isSymbolicLink() || !state.isDirectory()) {
      return `${label} is not a real directory (symlinks are refused)`;
    }
    if (!ownedByCurrentUser(state.uid)) return `${label} is not owned by the current user`;
    if (process.platform !== "win32") {
      // `mode` on mkdir does not tighten a pre-existing directory. Chmod first, then verify the
      // actual postcondition rather than trusting the syscall to have changed the intended object.
      await chmod(path, PRIVATE_DIRECTORY_MODE);
      state = await lstat(path);
      if (
        state.isSymbolicLink() ||
        !state.isDirectory() ||
        !ownedByCurrentUser(state.uid) ||
        (state.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
      ) {
        return `${label} could not be established as an owner-only mode-0700 directory`;
      }
    }
    return undefined;
  } catch (error) {
    return `${label} privacy check failed: ${(error as Error).message}`;
  }
}

/** Establish only the owner-private Keel state root. This preflight reads no workspace bytes and
 * creates no snapshot destination, so callers may satisfy Warden's state-root prerequisite before
 * deferring the actual trusted fresh-run snapshot until governed readiness. */
export async function establishSnapshotPrivateRoot(
  privateRoot: string,
): Promise<string | undefined> {
  return await establishPrivateDirectory(privateRoot, "Keel state root");
}

function containsPath(container: string, candidate: string): boolean {
  const child = relative(container, candidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

export function snapshotCopyStrategy(
  root: string,
  dest: string,
): "recursive" | "explicit-traversal" {
  return containsPath(resolve(root), resolve(dest)) ? "explicit-traversal" : "recursive";
}

/** Resolve existing ancestors without requiring the final candidate to exist. This closes lexical
 * alias gaps before mkdir/chmod can touch a state root that physically contains the workspace. */
async function canonicalCandidate(pathInput: string): Promise<string> {
  let cursor = resolve(pathInput);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(cursor), ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Preflight the faithful-retention boundary before measuring or copying the workspace. A lexical
 * direct-child check prevents caller drift; lstat-after-mkdir refuses a state root or snapshots parent
 * that is itself a symlink. A same-user process racing the path after this check is outside Keel's
 * stated same-user-malware threat model; governed tools cannot reach the root at all.
 */
async function preparePrivateDestination(
  workspaceRootInput: string,
  privateRootInput: string,
  destInput: string,
): Promise<PrivateDestinationResult> {
  const workspaceRoot = resolve(workspaceRootInput);
  const privateRoot = resolve(privateRootInput);
  const snapshotRoot = join(privateRoot, "snapshots");
  const dest = resolve(destInput);
  if (containsPath(privateRoot, workspaceRoot)) {
    return {
      ok: false,
      dest,
      reason: "Keel state root must not equal or contain the workspace",
    };
  }
  if (dirname(dest) !== snapshotRoot) {
    return {
      ok: false,
      dest,
      reason: "snapshot destination is not a direct child of the private snapshot root",
    };
  }

  let canonicalWorkspaceRoot: string;
  let plannedCanonicalPrivateRoot: string;
  try {
    [canonicalWorkspaceRoot, plannedCanonicalPrivateRoot] = await Promise.all([
      canonicalCandidate(workspaceRoot),
      canonicalCandidate(privateRoot),
    ]);
  } catch (error) {
    return {
      ok: false,
      dest,
      reason: `snapshot privacy preflight failed: ${(error as Error).message}`,
    };
  }
  if (containsPath(plannedCanonicalPrivateRoot, canonicalWorkspaceRoot)) {
    return {
      ok: false,
      dest,
      reason: "Keel state root must not equal or contain the workspace",
    };
  }

  const privateRootError = await establishSnapshotPrivateRoot(privateRoot);
  if (privateRootError !== undefined) return { ok: false, dest, reason: privateRootError };
  const snapshotRootError = await establishPrivateDirectory(snapshotRoot, "snapshot root");
  if (snapshotRootError !== undefined) return { ok: false, dest, reason: snapshotRootError };
  try {
    const [canonicalPrivateRoot, canonicalSnapshotRoot] = await Promise.all([
      realpath(privateRoot),
      realpath(snapshotRoot),
    ]);
    if (
      canonicalPrivateRoot !== plannedCanonicalPrivateRoot ||
      dirname(canonicalSnapshotRoot) !== canonicalPrivateRoot
    ) {
      return {
        ok: false,
        dest,
        reason: "private snapshot boundary changed during establishment",
      };
    }
    return {
      ok: true,
      root: canonicalWorkspaceRoot,
      dest: join(canonicalSnapshotRoot, basename(dest)),
    };
  } catch (error) {
    return {
      ok: false,
      dest,
      reason: `private snapshot boundary verification failed: ${(error as Error).message}`,
    };
  }
}

/** Is `p` the excluded path itself, or under it? (path-prefix match on a separator boundary). */
function isExcluded(p: string, exclude: readonly string[]): boolean {
  return exclude.some((ex) => p === ex || p.startsWith(ex.endsWith(sep) ? ex : ex + sep));
}

/**
 * Measure a tree's regular-file bytes + entry count, stopping EARLY once either cap is exceeded (so a
 * huge workspace is cheap to reject — we never walk all of a 10 GB repo). Symlinks are counted but never
 * followed (no size, no descent) — a dangling link must not crash the walk. Unreadable entries are
 * skipped rather than thrown (best-effort measurement).
 */
/** Which cap a measurement exceeded — so the skip reason names the ACTUAL trigger (not a guess
 *  re-derived from possibly-both-exceeded counters). `null` = within both caps. */
type OverCap = "bytes" | "files" | "both" | null;

async function measure(
  root: string,
  exclude: readonly string[],
  maxBytes: number,
  maxFiles: number,
): Promise<{ bytes: number; files: number; over: OverCap }> {
  let bytes = 0;
  let files = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip, don't crash the safety net
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (isExcluded(p, exclude)) continue; // e.g. keelHome sitting inside the workspace
      if (e.isSymbolicLink()) {
        files += 1; // counted, never followed
      } else if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile()) {
        files += 1;
        bytes += (await lstat(p)).size; // a mid-walk failure bubbles to the caller's fail-open catch
      }
      const overBytes = bytes > maxBytes;
      const overFiles = files > maxFiles;
      if (overBytes || overFiles) {
        return {
          bytes,
          files,
          over: overBytes && overFiles ? "both" : overBytes ? "bytes" : "files",
        };
      }
    }
  }
  return { bytes, files, over: null };
}

/** Use one native recursive copy for the normal out-of-workspace destination. If Keel state is
 * intentionally nested below the workspace, `fs.cp(root, dest)` rejects the in-source destination
 * before consulting its filter; retain the explicit traversal so exclusions are checked first. */
async function copyTreeContents(
  root: string,
  dest: string,
  exclude: readonly string[],
): Promise<void> {
  await mkdir(dest, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (snapshotCopyStrategy(root, dest) === "recursive") {
    await cp(root, dest, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) => !isExcluded(source, exclude),
    });
    return;
  }
  const copyEntry = async (src: string, target: string): Promise<void> => {
    if (isExcluded(src, exclude)) return;
    const state = await lstat(src);
    if (!state.isDirectory() || state.isSymbolicLink()) {
      await cp(src, target, { verbatimSymlinks: true });
      return;
    }
    await mkdir(target, { mode: state.mode & 0o777 });
    for (const entry of await readdir(src, { withFileTypes: true })) {
      await copyEntry(join(src, entry.name), join(target, entry.name));
    }
  };
  for (const entry of await readdir(root, { withFileTypes: true })) {
    await copyEntry(join(root, entry.name), join(dest, entry.name));
  }
}

/**
 * Snapshot `root` → `dest`. Returns `{ taken: false, skippedReason }` (never throws) when the workspace
 * is over the caps or the copy fails — the run always proceeds.
 */
export async function snapshotWorkspace(opts: SnapshotOptions): Promise<SnapshotResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const privateDestination = await preparePrivateDestination(
    opts.root,
    opts.privateRoot,
    opts.dest,
  );
  if (!privateDestination.ok) {
    return {
      taken: false,
      path: privateDestination.dest,
      bytes: 0,
      files: 0,
      skippedReason: privateDestination.reason,
    };
  }
  const dest = privateDestination.dest;
  try {
    const inputRoot = resolve(opts.root);
    const exclude = new Set<string>([await canonicalCandidate(opts.privateRoot)]);
    for (const entry of opts.exclude ?? []) {
      const lexical = resolve(entry);
      const fromInputRoot = relative(inputRoot, lexical);
      if (containsPath(inputRoot, lexical)) {
        exclude.add(resolve(privateDestination.root, fromInputRoot));
      }
      exclude.add(await canonicalCandidate(lexical));
    }
    const excludedPaths = [...exclude];
    const { bytes, files, over } = await measure(
      privateDestination.root,
      excludedPaths,
      maxBytes,
      maxFiles,
    );
    if (over !== null) {
      // Name the cap that actually tripped (measure tells us), so a file-count skip is never
      // mislabeled "too large" just because bytes also happened to be over at that instant.
      const tooLarge = `workspace too large to snapshot (> ${String(maxBytes)} bytes)`;
      const tooMany = `workspace has too many files to snapshot (> ${String(maxFiles)})`;
      const reason =
        over === "both"
          ? `${tooLarge}; also too many files`
          : over === "bytes"
            ? tooLarge
            : tooMany;
      return { taken: false, path: dest, bytes, files, skippedReason: reason };
    }
    await rm(dest, { recursive: true, force: true }); // a stale backup from a crashed prior run
    // Recursive copy; symlinks are copied as links and never followed out of root.
    // `fs.cp` is NOT transactional: an unreadable entry mid-copy can leave a PARTIAL tree in `dest` and
    // then throw. We fail OPEN (run proceeds), but the catch below MUST delete that partial — a backup
    // the agent is told does not exist must not actually be sitting half-written on disk (ADR-0043:
    // an incomplete backup advertised as "no backup" is the dishonest, recovery-breaking case).
    // Node's default rewrites relative link targets to host-specific absolute paths. The helper uses
    // `verbatimSymlinks` for every non-directory entry so stored link text remains faithful.
    await copyTreeContents(privateDestination.root, dest, excludedPaths);
    return { taken: true, path: dest, bytes, files };
  } catch (err) {
    // Remove any partial backup the failed copy may have left, so a skipped snapshot leaves NOTHING
    // on disk (best-effort; a cleanup failure must not turn a fail-open into a throw).
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    return {
      taken: false,
      path: dest,
      bytes: 0,
      files: 0,
      skippedReason: `snapshot failed (run proceeds without a backup): ${(err as Error).message}`,
    };
  }
}

/**
 * The post-trust system message may disclose only whether a private human recovery snapshot exists,
 * never its concrete path, contents, or governed-tool recovery instructions. When the snapshot was
 * skipped, it still reinforces the workspace-local manual-backup habit. Kept terse because it rides in
 * every model turn's context.
 */
export function backupSystemMessage(result: SnapshotResult): string {
  if (result.taken) {
    return (
      `# Workspace backup\nA private human-only copy of the original workspace was retained outside ` +
      `the governed tool roots. Its path and contents are intentionally not available to you. Do not ` +
      `attempt to locate or access it. Continue using only the live workspace; for recover/repair tasks, ` +
      `work on a workspace-local copy and keep the live original intact.`
    );
  }
  return (
    `# Workspace backup\nNo automatic backup was made; the private human-only recovery snapshot ` +
    `was skipped and is not available to you. Continue using only the live workspace.`
  );
}
