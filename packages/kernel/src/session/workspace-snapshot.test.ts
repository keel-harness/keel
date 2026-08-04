import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupSystemMessage,
  snapshotCopyStrategy,
  snapshotWorkspace,
} from "./workspace-snapshot.js";

/** chmod-based partial-copy tests need a POSIX FS where the current user is NOT root (root bypasses
 *  permission bits, so the EACCES we rely on never fires). */
const POSIX_NON_ROOT = process.platform !== "win32" && (process.getuid?.() ?? 0) !== 0;

let base: string;
let root: string;
let dest: string;
let privateRoot: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "keel-snap-"));
  root = join(base, "ws");
  privateRoot = join(base, "keel-home");
  dest = join(privateRoot, "snapshots", "ses_TEST");
  await mkdir(root, { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("snapshotWorkspace — run-start safety backup", () => {
  it("copies a small workspace faithfully (content recoverable byte-for-byte)", async () => {
    await writeFile(join(root, "main.db-wal"), "irreplaceable-bytes");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "note.txt"), "keep me");

    const r = await snapshotWorkspace({ root, dest, privateRoot });
    expect(r.taken).toBe(true);
    expect(snapshotCopyStrategy(await realpath(root), r.path)).toBe("recursive");
    expect(r.files).toBe(2);
    // The originals survive in the backup even if the agent later destroys them.
    expect(await readFile(join(dest, "main.db-wal"), "utf8")).toBe("irreplaceable-bytes");
    expect(await readFile(join(dest, "sub", "note.txt"), "utf8")).toBe("keep me");
  });

  it("skips (fail-open) when the workspace exceeds the byte cap — never blocks the run", async () => {
    await writeFile(join(root, "big.bin"), Buffer.alloc(4096));
    const r = await snapshotWorkspace({ root, dest, privateRoot, maxBytes: 1024 });
    expect(r.taken).toBe(false);
    expect(r.skippedReason).toMatch(/too large|bytes/i);
  });

  it("skips when the workspace exceeds the file-count cap", async () => {
    for (let i = 0; i < 5; i++) await writeFile(join(root, `f${String(i)}`), "x");
    const r = await snapshotWorkspace({ root, dest, privateRoot, maxFiles: 3 });
    expect(r.taken).toBe(false);
    expect(r.skippedReason).toMatch(/too many|files/i);
  });

  it("names both caps when the first retained entry exceeds both limits", async () => {
    await writeFile(join(root, "one-byte.txt"), "x");

    const r = await snapshotWorkspace({ root, dest, privateRoot, maxBytes: 0, maxFiles: 0 });

    expect(r.taken).toBe(false);
    expect(r.skippedReason).toMatch(/too large.*too many files/i);
  });

  it("handles an empty workspace (taken, zero files)", async () => {
    const r = await snapshotWorkspace({ root, dest, privateRoot });
    expect(r.taken).toBe(true);
    expect(r.files).toBe(0);
  });

  it("does not follow symlinks (a broken link is counted, not chased, and never crashes)", async () => {
    await writeFile(join(root, "real.txt"), "data");
    await symlink(join(root, "does-not-exist"), join(root, "dangling"));
    const r = await snapshotWorkspace({ root, dest, privateRoot });
    expect(r.taken).toBe(true);
    expect(await readFile(join(dest, "real.txt"), "utf8")).toBe("data");
  });

  it("preserves relative symlink target text verbatim without reading the outside target", async () => {
    const outside = join(base, "outside-secret.txt");
    await writeFile(outside, "FAKE_SECRET_MUST_NOT_BE_COPIED");
    await symlink("../outside-secret.txt", join(root, "outside-link"));

    const r = await snapshotWorkspace({ root, dest, privateRoot });

    expect(r.taken).toBe(true);
    expect(await readlink(join(dest, "outside-link"))).toBe("../outside-secret.txt");
    expect(existsSync(join(dest, "outside-secret.txt"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "tightens an existing permissive Keel state root to owner-only mode 0700 before retention",
    async () => {
      await mkdir(privateRoot, { recursive: true, mode: 0o755 });
      await chmod(privateRoot, 0o755);
      await writeFile(join(root, ".env"), "FAKE_SECRET_PRIVATE_ONLY");

      const r = await snapshotWorkspace({ root, dest, privateRoot });

      expect(r.taken).toBe(true);
      expect((await stat(privateRoot)).mode & 0o777).toBe(0o700);
      expect(await readFile(join(dest, ".env"), "utf8")).toBe("FAKE_SECRET_PRIVATE_ONLY");
    },
  );

  it("refuses a symlinked Keel state root without writing through it", async () => {
    const actual = join(base, "actual-state-target");
    const linkedRoot = join(base, "linked-keel-home");
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, linkedRoot);
    const linkedDest = join(linkedRoot, "snapshots", "ses_LINKED_ROOT");
    await writeFile(join(root, ".env"), "FAKE_SECRET_MUST_STAY_PRIVATE");

    const r = await snapshotWorkspace({ root, dest: linkedDest, privateRoot: linkedRoot });

    expect(r.taken).toBe(false);
    expect(r.skippedReason).toMatch(/private|symlink|state root/i);
    expect(existsSync(join(actual, "snapshots"))).toBe(false);
  });

  it("fails open when the configured private state root is a regular file", async () => {
    await writeFile(privateRoot, "not a directory");

    const r = await snapshotWorkspace({ root, dest, privateRoot });

    expect(r.taken).toBe(false);
    expect(r.skippedReason).toMatch(/state root.*privacy|state root.*directory/i);
    expect(existsSync(dest)).toBe(false);
  });

  it("refuses a symlinked snapshots parent without touching its outside target", async () => {
    const outside = join(base, "outside-snapshot-target");
    await mkdir(privateRoot, { recursive: true, mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(privateRoot, "snapshots"));
    await writeFile(join(root, ".env"), "FAKE_SECRET_MUST_NOT_ESCAPE");

    const r = await snapshotWorkspace({ root, dest, privateRoot });

    expect(r.taken).toBe(false);
    expect(r.skippedReason).toMatch(/private|symlink|snapshot root/i);
    expect(existsSync(join(outside, "ses_TEST"))).toBe(false);
  });

  it("refuses a destination outside the private snapshots root", async () => {
    const outsideDest = join(base, "outside-destination", "ses_ESCAPE");
    await writeFile(join(root, ".env"), "FAKE_SECRET_MUST_NOT_ESCAPE");

    const r = await snapshotWorkspace({ root, dest: outsideDest, privateRoot });

    expect(r.taken).toBe(false);
    expect(r.skippedReason).toMatch(/destination|private snapshot root/i);
    expect(existsSync(outsideDest)).toBe(false);
  });

  it("refuses a Keel state root that equals or contains the workspace before creating snapshot state", async () => {
    await writeFile(join(root, ".env"), "FAKE_SECRET_MUST_NOT_COPY_IN_PLACE");
    const sameRootDest = join(root, "snapshots", "ses_SAME_ROOT");

    const sameRoot = await snapshotWorkspace({
      root,
      dest: sameRootDest,
      privateRoot: root,
    });
    const ancestorRoot = await snapshotWorkspace({
      root,
      dest: join(base, "snapshots", "ses_ANCESTOR_ROOT"),
      privateRoot: base,
    });

    expect(sameRoot.taken).toBe(false);
    expect(sameRoot.skippedReason).toMatch(/state root.*workspace|workspace.*state root/i);
    expect(ancestorRoot.taken).toBe(false);
    expect(ancestorRoot.skippedReason).toMatch(/state root.*workspace|workspace.*state root/i);
    expect(existsSync(join(root, "snapshots"))).toBe(false);
    expect(existsSync(join(base, "snapshots"))).toBe(false);
  });

  it("refuses a Keel state root that physically contains the workspace through a symlinked ancestor", async () => {
    const physicalParent = join(base, "physical-parent");
    const physicalState = join(physicalParent, "state");
    const aliasedParent = join(base, "aliased-parent");
    root = join(physicalState, "workspace");
    privateRoot = join(aliasedParent, "state");
    dest = join(privateRoot, "snapshots", "ses_ALIASED_ANCESTOR");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, ".env"), "FAKE_SECRET_MUST_NOT_COPY_IN_PLACE");
    await symlink(physicalParent, aliasedParent);

    const r = await snapshotWorkspace({ root, dest, privateRoot });

    expect(r.taken).toBe(false);
    expect(r.skippedReason).toMatch(/state root.*workspace|workspace.*state root/i);
    expect(existsSync(join(physicalState, "snapshots"))).toBe(false);
  });

  it("canonically excludes an in-workspace Keel state root reached through a symlinked ancestor", async () => {
    const physicalWorkspace = join(base, "physical-workspace");
    const workspaceAlias = join(base, "workspace-alias");
    root = physicalWorkspace;
    privateRoot = join(workspaceAlias, ".keel-state");
    dest = join(privateRoot, "snapshots", "ses_ALIASED_EXCLUDE");
    await mkdir(root, { recursive: true });
    await symlink(physicalWorkspace, workspaceAlias);
    await writeFile(join(root, "keep.txt"), "keep me");

    const r = await snapshotWorkspace({ root, dest, privateRoot, exclude: [privateRoot] });

    expect(r.taken).toBe(true);
    expect(snapshotCopyStrategy(await realpath(root), r.path)).toBe("explicit-traversal");
    expect(await readFile(join(dest, "keep.txt"), "utf8")).toBe("keep me");
    expect(existsSync(join(dest, ".keel-state"))).toBe(false);
  });

  it("fails open (never throws) when the workspace is unreadable / the copy errors", async () => {
    // A non-existent root: the bounded walk skips the unreadable dir, then the copy errors — the run
    // must proceed with a reason, not crash. (`fs.cp` is all-or-nothing, so this is the fail-open path.)
    const r = await snapshotWorkspace({
      root: join(base, "no-such-dir"),
      dest,
      privateRoot,
    });
    expect(r.taken).toBe(false);
    expect(r.skippedReason).toMatch(/failed/i);
  });

  it("boundary: a workspace exactly at the byte/file cap is taken; one past is skipped (inclusive cap)", async () => {
    // exactly at: 2 files × 512 bytes = 1024 bytes, caps 1024/2 → taken (the cap is inclusive).
    await writeFile(join(root, "f1"), Buffer.alloc(512));
    await writeFile(join(root, "f2"), Buffer.alloc(512));
    const atCap = await snapshotWorkspace({
      root,
      dest,
      privateRoot,
      maxBytes: 1024,
      maxFiles: 2,
    });
    expect(atCap.taken).toBe(true);
    // one byte past the byte cap → skipped, named "too large".
    await rm(dest, { recursive: true, force: true });
    const overBytes = await snapshotWorkspace({
      root,
      dest,
      privateRoot,
      maxBytes: 1023,
      maxFiles: 2,
    });
    expect(overBytes.taken).toBe(false);
    expect(overBytes.skippedReason).toMatch(/too large/i);
    // one file past the file cap (bytes within) → skipped, named "too many files" (SF-4: not mislabeled).
    await rm(dest, { recursive: true, force: true });
    const overFiles = await snapshotWorkspace({
      root,
      dest,
      privateRoot,
      maxBytes: 1024,
      maxFiles: 1,
    });
    expect(overFiles.taken).toBe(false);
    expect(overFiles.skippedReason).toMatch(/too many files/i);
  });

  it.skipIf(!POSIX_NON_ROOT)(
    "removes the partial backup when the copy fails mid-way — never leaves a misleading half-backup (MF-2)",
    async () => {
      await writeFile(join(root, "a.txt"), "A");
      await writeFile(join(root, "b.txt"), "B");
      const locked = join(root, "locked");
      await mkdir(locked);
      await writeFile(join(locked, "secret"), "x");
      await chmod(locked, 0o000); // fs.cp EACCESes entering this dir → a partial copy, then throws
      try {
        const r = await snapshotWorkspace({ root, dest, privateRoot });
        expect(r.taken).toBe(false);
        expect(r.skippedReason).toMatch(/failed/i);
        // The honesty contract (ADR-0043): a skipped snapshot must leave NOTHING on disk — the agent
        // is told "no backup," so a half-written backup must not actually exist.
        expect(existsSync(dest)).toBe(false);
      } finally {
        await chmod(locked, 0o755).catch(() => {}); // let afterEach clean up
      }
    },
  );

  it("excludes a path inside the workspace (e.g. keelHome) from both the size walk and the copy", async () => {
    await writeFile(join(root, "keep.txt"), "data");
    const inner = join(root, ".keel");
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, "huge"), Buffer.alloc(8192)); // would blow a tiny byte cap if counted
    const r = await snapshotWorkspace({
      root,
      dest,
      privateRoot,
      exclude: [inner],
      maxBytes: 4096,
    });
    expect(r.taken).toBe(true); // the excluded 8KB did not count toward the 4KB cap
    expect(await readFile(join(dest, "keep.txt"), "utf8")).toBe("data");
    // the excluded subtree is NOT in the backup
    await expect(readFile(join(dest, ".keel", "huge"))).rejects.toThrow();
  });

  it("honors a filesystem-root exclusion without normalizing away its separator", async () => {
    await writeFile(join(root, "excluded.txt"), "must not be retained");

    const r = await snapshotWorkspace({
      root,
      dest,
      privateRoot,
      exclude: [parse(root).root],
    });

    expect(r.taken).toBe(true);
    expect(r.files).toBe(0);
    expect(existsSync(join(dest, "excluded.txt"))).toBe(false);
  });
});

describe("backupSystemMessage", () => {
  it("tells the agent only that a private human snapshot exists, never where or how to access it", () => {
    const msg = backupSystemMessage({
      taken: true,
      path: "/kh/snapshots/ses_1",
      bytes: 10,
      files: 2,
    });
    expect(msg).not.toContain("/kh/snapshots/ses_1");
    expect(msg).not.toMatch(/\bcp\b/);
    expect(msg).toMatch(/private.*human-only|human-only.*private/i);
    expect(msg).toMatch(/cannot access|not available to you/i);
  });
  it("withholds path-bearing failure detail when the private snapshot was skipped", () => {
    const msg = backupSystemMessage({
      taken: false,
      path: "/kh/x",
      bytes: 0,
      files: 0,
      skippedReason: "copy failed at /kh/x with FAKE_SECRET_IN_ERROR",
    });
    expect(msg).toMatch(/no automatic backup/i);
    expect(msg).not.toContain("/kh/x");
    expect(msg).not.toContain("FAKE_SECRET_IN_ERROR");
    expect(msg).not.toMatch(/\bcp\b/);
    expect(msg).toMatch(/snapshot was skipped|cannot access|not available to you/i);
  });
});
