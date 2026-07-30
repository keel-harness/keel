import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadProjectCommandGrants,
  projectCommandGrantFilePath,
  revokeProjectCommandGrant,
  saveProjectCommandGrant,
} from "./command-project-grants.js";
import { withFileLock } from "./file-lock.js";

const PRINCIPAL = {
  osUser: "tester",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
} as const;

const KEY_A = `sha256:${"a".repeat(64)}` as const;
const KEY_B = `sha256:${"b".repeat(64)}` as const;

describe("project command grants", () => {
  it("stores exact command grant keys in keel-owned config keyed by real workspace", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-command-grant-store-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-command-grant-workspace-"));
    const otherWorkspace = mkdtempSync(join(tmpdir(), "keel-command-grant-other-"));
    const env = { KEEL_HOME: keelHome };

    try {
      expect(saveProjectCommandGrant(workspaceRoot, KEY_B, PRINCIPAL, env)).toBe(true);
      expect(saveProjectCommandGrant(workspaceRoot, KEY_A, PRINCIPAL, env)).toBe(true);
      expect(saveProjectCommandGrant(workspaceRoot, KEY_A, PRINCIPAL, env)).toBe(true);

      expect(loadProjectCommandGrants(workspaceRoot, env).map((grant) => grant.key)).toEqual([
        KEY_A,
        KEY_B,
      ]);
      expect(loadProjectCommandGrants(otherWorkspace, env)).toEqual([]);

      const persisted = JSON.parse(readFileSync(projectCommandGrantFilePath(env), "utf8")) as {
        workspaces?: Record<string, { grants?: Array<{ key?: string }> }>;
      };
      expect(Object.keys(persisted.workspaces ?? {})).toEqual([realpathSync(workspaceRoot)]);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });

  it("fails closed for missing, malformed, or invalid persisted command grant stores", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-command-grant-invalid-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-command-grant-invalid-workspace-"));
    const env = { KEEL_HOME: keelHome };

    try {
      expect(loadProjectCommandGrants(workspaceRoot, env)).toEqual([]);

      mkdirSync(keelHome, { recursive: true });
      writeFileSync(projectCommandGrantFilePath(env), "{not-json");
      expect(loadProjectCommandGrants(workspaceRoot, env)).toEqual([]);

      writeFileSync(
        projectCommandGrantFilePath(env),
        JSON.stringify({
          version: 1,
          workspaces: {
            [realpathSync(workspaceRoot)]: {
              grants: [{ key: "mkdir dist", updatedAt: "2026-07-05T00:00:00.000Z" }],
              updatedAt: "2026-07-05T00:00:00.000Z",
            },
          },
        }),
      );
      expect(loadProjectCommandGrants(workspaceRoot, env)).toEqual([]);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("revokes only the exact command grant key for the current workspace", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-command-grant-revoke-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-command-grant-revoke-workspace-"));
    const otherWorkspace = mkdtempSync(join(tmpdir(), "keel-command-grant-revoke-other-"));
    const env = { KEEL_HOME: keelHome };

    try {
      expect(saveProjectCommandGrant(workspaceRoot, KEY_A, PRINCIPAL, env)).toBe(true);
      expect(saveProjectCommandGrant(workspaceRoot, KEY_B, PRINCIPAL, env)).toBe(true);
      expect(saveProjectCommandGrant(otherWorkspace, KEY_A, PRINCIPAL, env)).toBe(true);

      expect(revokeProjectCommandGrant(workspaceRoot, KEY_A, env)).toBe("revoked");
      expect(loadProjectCommandGrants(workspaceRoot, env).map((grant) => grant.key)).toEqual([
        KEY_B,
      ]);
      expect(loadProjectCommandGrants(otherWorkspace, env).map((grant) => grant.key)).toEqual([
        KEY_A,
      ]);
      expect(revokeProjectCommandGrant(workspaceRoot, KEY_A, env)).toBe("not-found");
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });

  it("does not report command revocation success when only duplicate non-target grants changed", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-command-grant-duplicate-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-command-grant-duplicate-workspace-"));
    const env = { KEEL_HOME: keelHome };

    try {
      mkdirSync(keelHome, { recursive: true });
      writeFileSync(
        projectCommandGrantFilePath(env),
        JSON.stringify({
          version: 1,
          workspaces: {
            [realpathSync(workspaceRoot)]: {
              grants: [
                { key: KEY_B, updatedAt: "2026-07-05T00:00:00.000Z" },
                { key: KEY_B, updatedAt: "2026-07-05T00:00:01.000Z" },
              ],
              updatedAt: "2026-07-05T00:00:01.000Z",
            },
          },
        }),
      );

      expect(revokeProjectCommandGrant(workspaceRoot, KEY_A, env)).toBe("not-found");
      expect(loadProjectCommandGrants(workspaceRoot, env).map((grant) => grant.key)).toEqual([
        KEY_B,
      ]);
      expect(revokeProjectCommandGrant(workspaceRoot, KEY_B, env)).toBe("revoked");
      expect(loadProjectCommandGrants(workspaceRoot, env)).toEqual([]);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  // Skipped when the tests run as root, where directory mode bits do not restrict writes and the
  // unwritable-parent sabotage below cannot force a write failure.
  const itUnlessRoot = process.getuid?.() === 0 ? it.skip : it;
  itUnlessRoot(
    "reports command revoke write failure without removing active persisted authority",
    () => {
      const keelHome = mkdtempSync(join(tmpdir(), "keel-command-grant-revoke-write-fail-"));
      const workspaceRoot = mkdtempSync(
        join(tmpdir(), "keel-command-grant-revoke-write-fail-workspace-"),
      );
      const env = { KEEL_HOME: keelHome };

      try {
        expect(saveProjectCommandGrant(workspaceRoot, KEY_A, PRINCIPAL, env)).toBe(true);
        // Make the store directory unwritable so the write fails (the lock-acquire's temp-create is
        // the first thing to fail on the unwritable dir), while the already-persisted grant file stays
        // readable (read does not need write permission).
        chmodSync(keelHome, 0o500);

        expect(revokeProjectCommandGrant(workspaceRoot, KEY_A, env)).toBe("write-failed");
        expect(loadProjectCommandGrants(workspaceRoot, env).map((grant) => grant.key)).toEqual([
          KEY_A,
        ]);
      } finally {
        chmodSync(keelHome, 0o700);
        rmSync(keelHome, { recursive: true, force: true });
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    },
  );

  it("reports persistence failure without leaving a readable grant", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-command-grant-unwritable-workspace-"));
    const blockedParent = mkdtempSync(join(tmpdir(), "keel-command-grant-blocked-parent-"));
    const blockedFile = join(blockedParent, "not-a-directory");
    writeFileSync(blockedFile, "not a directory");
    const env = { KEEL_HOME: join(blockedFile, "keel") };

    try {
      expect(saveProjectCommandGrant(workspaceRoot, KEY_A, PRINCIPAL, env)).toBe(false);
      expect(loadProjectCommandGrants(workspaceRoot, env)).toEqual([]);
    } finally {
      rmSync(blockedParent, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("resolves command grant store paths outside project-file scope", () => {
    expect(projectCommandGrantFilePath({ KEEL_HOME: "/keel-home" })).toBe(
      "/keel-home/command-project-grants.json",
    );
    expect(projectCommandGrantFilePath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/keel/command-project-grants.json",
    );
    expect(projectCommandGrantFilePath({ HOME: "/home/tester" })).toBe(
      "/home/tester/.config/keel/command-project-grants.json",
    );
  });

  describe("concurrency (revocation-resurrection race)", () => {
    it("serializes save behind the store lock so a contended save does not interleave", () => {
      const env = { KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-command-grant-lock-")) };
      const path = projectCommandGrantFilePath(env);
      // Hold the lock as if another process is mid-revoke; the contended save must fail closed and
      // persist nothing rather than read-modify-writing over the in-flight revocation.
      const wrote = withFileLock(path, () => saveProjectCommandGrant("/ws", KEY_A, PRINCIPAL, env));
      expect(wrote).toBe(false);
      expect(existsSync(path)).toBe(false);
    });

    // Deterministic cross-process proof (no spawn flakiness): a lock stamped with a DIFFERENT live
    // process's pid (PID 1 = init/launchd, always alive on unix) must make a concurrent save fail
    // closed — the exclusion respects a foreign live holder, not just same-process nesting.
    const itUnixOnly = process.platform === "win32" ? it.skip : it;
    itUnixOnly("fails a save closed while a different live process holds the lock", () => {
      const env = { KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-command-grant-foreign-lock-")) };
      const path = projectCommandGrantFilePath(env);
      mkdirSync(env.KEEL_HOME, { recursive: true });
      writeFileSync(`${path}.lock`, `${JSON.stringify({ pid: 1, path })}\n`);
      try {
        expect(saveProjectCommandGrant("/ws", KEY_A, PRINCIPAL, env)).toBe(false);
        expect(existsSync(path)).toBe(false);
      } finally {
        rmSync(`${path}.lock`, { force: true });
      }
    });

    // NOTE: a true cross-process interleave cannot be reproduced in-process; the contended-save test
    // above is the real lock proxy (it fails without the lock). This sequential case only guards that
    // a normal revoke→save sequence does not re-add the revoked grant.
    it("keeps a revoked grant gone across a later unrelated save (sequential)", () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-command-grant-resurrect-"));
      const env = { KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-command-grant-resurrect-home-")) };
      try {
        expect(saveProjectCommandGrant(workspaceRoot, KEY_A, PRINCIPAL, env)).toBe(true);
        expect(revokeProjectCommandGrant(workspaceRoot, KEY_A, env)).toBe("revoked");
        expect(loadProjectCommandGrants(workspaceRoot, env)).toEqual([]);
        expect(saveProjectCommandGrant(workspaceRoot, KEY_B, PRINCIPAL, env)).toBe(true);
        expect(loadProjectCommandGrants(workspaceRoot, env).map((grant) => grant.key)).toEqual([
          KEY_B,
        ]);
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });
  });
});
