import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { redactJsonValue } from "@keel/shared";
import { Trajectory, type TrajectoryT } from "./trajectory.js";

/**
 * Strict allowlist for trajectory path segments (`suite`, `runId`, `task`). Each segment must be
 * non-empty and contain only ASCII alphanumerics, dots, underscores, and hyphens — no path
 * separators, no whitespace or control characters (including space, tab, NUL, etc.), and no
 * `.`/`..` dot-only entries. This keeps the store layout flat and prevents:
 *   - In-bounds separator exploits: a `/` inside a segment silently nests directories and can
 *     cause two differently-keyed trajectories to resolve to the same file (silent overwrite).
 *   - Control/NUL injection: bytes that reach the filesystem syscall unfiltered.
 * The allowlist is intentionally narrow — expand only after an explicit security review.
 */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Validate a single path segment. Throws a `trajectory store:` error if the segment is invalid.
 * Note: `SEGMENT` allows a literal `.`, so `..` would match the character class — we reject it
 * explicitly. Single `.` is also rejected explicitly for the same reason.
 */
function validateSegment(name: string, value: string): void {
  if (value === "." || value === "..") {
    throw new Error(
      `trajectory store: ${name} must not be "." or ".." (got ${JSON.stringify(value)})`,
    );
  }
  if (!SEGMENT.test(value)) {
    throw new Error(
      `trajectory store: ${name} contains a disallowed character (path separator, whitespace, or control byte) — got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Resolve `<baseDir>/<suite>/<runId>/<task>.json`. The `suite`/`runId`/`task` segments are
 * validated first against the strict `SEGMENT` allowlist (letters, digits, `.`, `_`, `-` only; no
 * separators, no control chars, no `.`/`..`). Because each segment is thereby a flat token that
 * cannot contain a path separator or a traversal sequence, the joined path is STRUCTURALLY
 * contained within `baseDir` — there is no lexical escape left to check. (Symlink-based escapes are
 * a separate, filesystem-level concern handled by the realpath checks in `writeTrajectory`.) This
 * matters because Phase 1 writes model-derived identifiers here, so containment cannot be assumed.
 */
function resolveTrajectoryPath(baseDir: string, traj: TrajectoryT): string {
  validateSegment("suite", traj.suite);
  validateSegment("runId", traj.runId);
  validateSegment("task", traj.task);
  return resolve(join(baseDir, traj.suite, traj.runId, `${traj.task}.json`));
}

/**
 * Persist a trajectory under `<baseDir>/<suite>/<runId>/<task>.json` (the versioned layout — bulk
 * data is gitignored, schema/layout committed). Returns the written file path. The trajectory is
 * validated before write so the store never persists a malformed record, and the target path is
 * checked to stay within `baseDir` at three layers:
 *   1. Per-segment allowlist (no separators, no control chars, no `.`/`..`) — makes the joined path
 *      structurally contained, so there is no lexical traversal left to escape.
 *   2. Symlink-resolved containment (realpath of each existing prefix BEFORE mkdir so we never
 *      create directories inside an escaped symlink target, plus a post-mkdir re-check backstop for
 *      a symlink raced in between).
 *   3. Leaf-file symlink check (lstat of the final `<task>.json` path before writeFile) — refuses
 *      to write if the leaf exists and is a symbolic link; ENOENT (not yet created) or a regular
 *      file (overwrite) are both allowed. This closes the C1 containment escape: a pre-planted leaf
 *      symlink pointing outside the store root is never followed.
 */
export async function writeTrajectory(baseDir: string, traj: TrajectoryT): Promise<string> {
  const valid = Trajectory.parse(traj);
  // resolveTrajectoryPath validates segments (throws on invalid) and does the lexical check.
  const file = resolveTrajectoryPath(baseDir, valid);

  // Step 4a: symlink-resolved containment for already-existing path components BEFORE mkdir.
  // On macOS, `os.tmpdir()` often returns `/tmp` which is a symlink to `/private/tmp` — realpath
  // the base too so both sides are canonical. We walk from `baseDir` inward, resolving each
  // component that already exists to catch a symlink planted at e.g. `<base>/<suite>`.
  const realRoot = await realpath(baseDir);
  // Check each prefix that may already exist on disk (baseDir → suite dir → runId dir).
  // We must do this before mkdir so we don't create directories inside an escaped symlink target.
  const prefixesToCheck = [join(baseDir, valid.suite), join(baseDir, valid.suite, valid.runId)];
  for (const prefix of prefixesToCheck) {
    try {
      await access(prefix);
    } catch {
      // This prefix does not exist yet, so it can't be a pre-planted symlink; and if `<suite>`
      // doesn't exist, `<suite>/<runId>` can't either — mkdir creates both. Stop walking.
      break;
    }
    const realPrefix = await realpath(prefix);
    if (realPrefix !== realRoot && !realPrefix.startsWith(realRoot + sep)) {
      throw new Error(
        `trajectory store: resolved path escapes the store root (a symlinked component points outside baseDir)`,
      );
    }
  }

  await mkdir(dirname(file), { recursive: true });

  // Step 4b: post-mkdir realpath containment re-check (defense-in-depth; catches any exotic case
  // where mkdir itself resolves through a newly-created intermediate symlink).
  const realDir = await realpath(dirname(file));
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
    throw new Error(
      `trajectory store: resolved path escapes the store root (a symlinked component points outside baseDir)`,
    );
  }

  // Step 4c: leaf-symlink check (C1 fix). Before writing, lstat the leaf path. If it exists and is
  // a symbolic link, refuse — this store never legitimately writes through a symlink at the leaf,
  // and following one would let a pre-planted escape evade all the directory-level containment above.
  // ENOENT (file does not exist yet) and regular files (legitimate overwrite) are both allowed.
  // A residual TOCTOU window exists between this lstat and the writeFile below (a symlink raced in
  // after the check); this is acceptable for keel's threat model — a single-process local writer with
  // no concurrent adversary holding write access to the store dir — and is not closed here.
  try {
    const leafStat = await lstat(file);
    if (leafStat.isSymbolicLink()) {
      throw new Error(
        `trajectory store: leaf path is a symbolic link — refusing to follow (containment escape)`,
      );
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
    // ENOENT: the leaf does not exist yet — safe to create it.
  }

  // SEC-014 (§3.2(6), Epic 1.11 QR-4): redact at this SINGLE trajectory-write chokepoint. A benchmark
  // trajectory is built inside a TB-2 container that has `ANTHROPIC_API_KEY` in its env, so a planted/
  // leaked credential is removed before it ever lands on the host store.
  //
  // SCOPE — `entropyNet: false` (deliberate, QC ER-033): we run the format catalog + contextual filters
  // but NOT the high-entropy heuristic here. The only injected HOST credential in a fresh TB-2 container
  // is the known-format `ANTHROPIC_API_KEY` (always caught by the `sk-ant-…` catalog — strictly higher
  // confidence than the entropy heuristic), so the net adds no protection against the real asset; and it
  // would CORRUPT faithful high-entropy task content (artifact hashes, and the secret-themed tasks such
  // as `vulnerable-secret`/`password-recovery`/`crack-7z-hash`) that the §2.3 analysis loop must read
  // faithfully — a trajectory is the loop's analysis substrate, not just an at-rest record. Matching the
  // filter to this context's threat model is the secure-by-construction choice. (The session ledger,
  // scoreboard, and ledger-note chokepoints keep the FULL filter — those can carry unknown-format secrets.)
  // Redact the structured value BEFORE serializing (F1 integrity): redacting an already-serialized line
  // can split a JSON escape — e.g. a high-entropy token abutting an escaped `\n` in tool output — leaving
  // an invalid `\<char>` a strict parser silently drops. `redactJsonValue` keeps the file valid + reloadable.
  await writeFile(
    file,
    `${JSON.stringify(redactJsonValue(valid, { entropyNet: false }), null, 2)}\n`,
    "utf8",
  );
  return file;
}

/** Read and validate a persisted trajectory (parse, don't validate-by-hope). */
export async function readTrajectory(file: string): Promise<TrajectoryT> {
  const raw = await readFile(file, "utf8");
  return Trajectory.parse(JSON.parse(raw) as unknown);
}

/**
 * Host-side validating ingest for a trajectory copied out of an ephemeral TB-2 container (Epic 1.11
 * QR-4 mechanism). The container's raw trajectory bytes are UNTRUSTED: validate the JSON + schema here
 * (throwing a clear error on malformed container output), then `writeTrajectory` redacts (SEC-014) on
 * write. This is the single entry point the Phase-B host-side runner uses after Harbor syncs the
 * container's logs/artifacts back to the host (the egress transport itself — volume mount / Harbor
 * artifact copy-out — is finalized in slice 8 / Phase B; this is the host boundary it feeds).
 */
export async function ingestTrajectory(baseDir: string, rawJson: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("trajectory ingest: container output is not valid JSON");
  }
  return writeTrajectory(baseDir, Trajectory.parse(parsed));
}
