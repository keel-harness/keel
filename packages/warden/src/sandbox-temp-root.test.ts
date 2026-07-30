import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildDefaultSandboxProfile } from "./sandbox-profile.js";
import { createWardenSandboxTempRoot } from "./sandbox-temp-root.js";

describe("warden-owned sandbox temporary root", () => {
  it("creates a fresh canonical owner-only root and ignores inherited temp authority", () => {
    const parent = realpathSync(tmpdir());
    const owned = createWardenSandboxTempRoot({
      parentDir: parent,
      env: {
        TMPDIR: "/private/tmp/untrusted-tmpdir",
        TMP: "/private/tmp/untrusted-tmp",
        TEMP: "/private/tmp/untrusted-temp",
        CLAUDE_CODE_TMPDIR: "/private/tmp/untrusted-claude-code",
        CLAUDE_TMPDIR: "/private/tmp/untrusted-claude",
      },
    });

    try {
      expect(owned.path).toBe(realpathSync(owned.path));
      expect(owned.path.startsWith(`${parent}/`)).toBe(true);
      expect(lstatSync(owned.path).isDirectory()).toBe(true);
      expect(lstatSync(owned.path).isSymbolicLink()).toBe(false);
      expect(lstatSync(owned.path).mode & 0o777).toBe(0o700);
      expect(owned.runtimeEnv).toEqual({ CLAUDE_CODE_TMPDIR: owned.path });
      expect(owned.declaredTempRoots).toEqual([owned.path]);
      expect(owned.path).not.toMatch(/untrusted/u);
      expect(() => owned.assertOwned()).not.toThrow();
    } finally {
      owned.cleanup();
    }
    expect(existsSync(owned.path)).toBe(false);
    expect(() => owned.cleanup()).not.toThrow();
  });

  it("projects only the exact owned root into the default sandbox profile", () => {
    const owned = createWardenSandboxTempRoot({ parentDir: realpathSync(tmpdir()), env: {} });
    try {
      const profile = buildDefaultSandboxProfile({
        workspaceRoot: "/repo",
        declaredTempRoots: owned.declaredTempRoots,
        env: { HOME: "/home/alice", KEEL_HOME: "/keel-home" },
      });
      expect(profile.filesystem?.allowRead).toEqual(["/repo", owned.path]);
      expect(profile.filesystem?.allowWrite).toEqual(["/repo", owned.path]);
      expect(profile.filesystem?.allowWrite).not.toContain(dirname(owned.path));
    } finally {
      owned.cleanup();
    }
  });

  it("selects the platform-owned parent when no override is supplied", () => {
    const owned = createWardenSandboxTempRoot();
    try {
      expect(dirname(owned.path)).toBe(realpathSync("/tmp"));
    } finally {
      owned.cleanup();
    }
  });

  it("rejects a parent that resolves to a non-directory", () => {
    const parent = mkdtempSync(join(realpathSync(tmpdir()), "keel-temp-parent-file-"));
    const file = join(parent, "not-a-directory");
    writeFileSync(file, "not a directory\n");
    try {
      expect(() => createWardenSandboxTempRoot({ parentDir: file })).toThrow(
        "warden sandbox temporary parent must be a canonical directory",
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("fails closed when the owned path is replaced by a file or different directory", () => {
    const parent = realpathSync(tmpdir());
    for (const replacement of ["file", "directory"] as const) {
      const owned = createWardenSandboxTempRoot({ parentDir: parent });
      const displaced = `${owned.path}-displaced`;
      if (replacement === "file") {
        owned.cleanup();
        writeFileSync(owned.path, "replacement\n");
      } else {
        // Keep the original inode allocated so every filesystem must give the replacement a
        // different identity. Deleting and recreating the same pathname can immediately reuse an
        // inode on Linux, which weakens the test without changing the production invariant.
        renameSync(owned.path, displaced);
        mkdirSync(owned.path, { mode: 0o700 });
      }

      try {
        expect(() => owned.assertOwned(), replacement).toThrow(
          "warden sandbox temporary root identity changed",
        );
        expect(() => owned.cleanup(), replacement).toThrow(
          "warden sandbox temporary root identity changed",
        );
      } finally {
        rmSync(owned.path, { recursive: true, force: true });
        rmSync(displaced, { recursive: true, force: true });
      }
    }
  });

  it("fails closed when the owned path disappears before execution", () => {
    const owned = createWardenSandboxTempRoot({ parentDir: realpathSync(tmpdir()) });
    owned.cleanup();

    expect(() => owned.assertOwned()).toThrow("warden sandbox temporary root is missing");
  });

  it("fails closed when owner, group, or mode drifts from the private root", () => {
    const owned = createWardenSandboxTempRoot({ parentDir: realpathSync(tmpdir()) });
    chmodSync(owned.path, 0o777);

    try {
      expect(() => owned.assertOwned()).toThrow(
        "warden sandbox temporary root ownership or permissions changed",
      );
      expect(() => owned.cleanup()).toThrow(
        "warden sandbox temporary root ownership or permissions changed",
      );
    } finally {
      chmodSync(owned.path, 0o700);
      owned.cleanup();
    }
  });

  it.runIf(process.getuid?.() !== 0)(
    "propagates cleanup inspection failures instead of treating them as missing",
    () => {
      const parent = mkdtempSync(join(realpathSync(tmpdir()), "keel-temp-inaccessible-parent-"));
      const owned = createWardenSandboxTempRoot({ parentDir: parent });
      chmodSync(parent, 0o000);
      try {
        expect(() => owned.cleanup()).toThrow();
        chmodSync(parent, 0o700);
        expect(existsSync(owned.path)).toBe(true);
        owned.cleanup();
      } finally {
        chmodSync(parent, 0o700);
        owned.cleanup();
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  it("removes only a replacement symlink and never follows it during cleanup", () => {
    const parent = realpathSync(tmpdir());
    const owned = createWardenSandboxTempRoot({ parentDir: parent, env: {} });
    const outside = join(parent, `keel-temp-outside-${String(process.pid)}-${String(Date.now())}`);
    mkdirSync(outside, { mode: 0o700 });
    owned.cleanup();
    symlinkSync(outside, owned.path);

    try {
      expect(() => owned.assertOwned()).toThrow("warden sandbox temporary root identity changed");
      owned.cleanup();

      expect(existsSync(owned.path)).toBe(false);
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
