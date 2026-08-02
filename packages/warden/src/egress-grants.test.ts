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
  loadProjectEgressGrants,
  projectEgressGrantFilePath,
  revokeProjectEgressGrant,
  saveProjectEgressGrant,
} from "./egress-grants.js";
import { withFileLock } from "./file-lock.js";

const PRINCIPAL = {
  osUser: "tester",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
} as const;

describe("project egress grants", () => {
  it("stores canonical domains in keel-owned config keyed by real workspace", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-egress-grant-store-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-egress-grant-workspace-"));
    const otherWorkspace = mkdtempSync(join(tmpdir(), "keel-egress-grant-other-"));
    const env = { KEEL_HOME: keelHome };

    try {
      expect(saveProjectEgressGrant(workspaceRoot, "Example.COM", PRINCIPAL, env)).toBe(true);
      expect(saveProjectEgressGrant(workspaceRoot, "api.example.com", PRINCIPAL, env)).toBe(true);
      expect(saveProjectEgressGrant(workspaceRoot, "example.com", PRINCIPAL, env)).toBe(true);

      expect(loadProjectEgressGrants(workspaceRoot, env)).toEqual([
        "api.example.com",
        "example.com",
      ]);
      expect(loadProjectEgressGrants(otherWorkspace, env)).toEqual([]);

      const persisted = JSON.parse(readFileSync(projectEgressGrantFilePath(env), "utf8")) as {
        workspaces?: Record<string, { domains?: string[] }>;
      };
      expect(Object.keys(persisted.workspaces ?? {})).toEqual([realpathSync(workspaceRoot)]);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });

  it("fails closed for missing, malformed, or invalid persisted egress stores", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-egress-grant-invalid-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-egress-grant-invalid-workspace-"));
    const env = { KEEL_HOME: keelHome };

    try {
      expect(loadProjectEgressGrants(workspaceRoot, env)).toEqual([]);

      mkdirSync(keelHome, { recursive: true });
      writeFileSync(projectEgressGrantFilePath(env), "{not-json");
      expect(loadProjectEgressGrants(workspaceRoot, env)).toEqual([]);

      writeFileSync(
        projectEgressGrantFilePath(env),
        JSON.stringify({ version: 2, workspaces: {} }),
      );
      expect(loadProjectEgressGrants(workspaceRoot, env)).toEqual([]);

      for (const domain of ["*", "localhost", "api.localhost", "Bücher.Localhost"]) {
        writeFileSync(
          projectEgressGrantFilePath(env),
          JSON.stringify({
            version: 1,
            workspaces: {
              [realpathSync(workspaceRoot)]: {
                domains: [domain],
                updatedAt: "2026-07-05T00:00:00.000Z",
              },
            },
          }),
        );
        expect(loadProjectEgressGrants(workspaceRoot, env), domain).toEqual([]);
      }
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("revokes only the exact canonical domain for the current workspace", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-egress-grant-revoke-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-egress-grant-revoke-workspace-"));
    const otherWorkspace = mkdtempSync(join(tmpdir(), "keel-egress-grant-revoke-other-"));
    const env = { KEEL_HOME: keelHome };

    try {
      saveProjectEgressGrant(workspaceRoot, "Example.COM", PRINCIPAL, env);
      saveProjectEgressGrant(workspaceRoot, "api.example.com", PRINCIPAL, env);
      saveProjectEgressGrant(otherWorkspace, "example.com", PRINCIPAL, env);

      expect(revokeProjectEgressGrant(workspaceRoot, "EXAMPLE.com", env)).toBe("revoked");
      expect(loadProjectEgressGrants(workspaceRoot, env)).toEqual(["api.example.com"]);
      expect(loadProjectEgressGrants(otherWorkspace, env)).toEqual(["example.com"]);
      expect(revokeProjectEgressGrant(workspaceRoot, "missing.example", env)).toBe("not-found");
      expect(revokeProjectEgressGrant(workspaceRoot, "api.example.com", env)).toBe("revoked");
      expect(loadProjectEgressGrants(workspaceRoot, env)).toEqual([]);
      expect(revokeProjectEgressGrant(workspaceRoot, "api.example.com", env)).toBe("not-found");
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });

  // Skipped as root, where directory mode bits do not restrict writes.
  const itUnlessRoot = process.getuid?.() === 0 ? it.skip : it;
  itUnlessRoot("reports write failures without removing active persisted authority", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-egress-grant-write-fail-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-egress-grant-write-fail-workspace-"));
    const env = { KEEL_HOME: keelHome };

    try {
      saveProjectEgressGrant(workspaceRoot, "example.com", PRINCIPAL, env);
      // Make the store directory unwritable so the write fails (the lock-acquire's temp-create fails
      // first on the unwritable dir), while the already-persisted grant stays readable.
      chmodSync(keelHome, 0o500);

      expect(revokeProjectEgressGrant(workspaceRoot, "example.com", env)).toBe("write-failed");
      expect(loadProjectEgressGrants(workspaceRoot, env)).toEqual(["example.com"]);
    } finally {
      chmodSync(keelHome, 0o700);
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  describe("concurrency (revocation-resurrection race)", () => {
    it("does not persist a save while the store lock is held", () => {
      const env = { KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-egress-grant-lock-")) };
      const path = projectEgressGrantFilePath(env);
      withFileLock(path, () => saveProjectEgressGrant("/ws", "example.com", PRINCIPAL, env));
      expect(existsSync(path)).toBe(false);
    });

    // Sequential proxy (see the command-grant note): the contended-save test above is the real lock
    // guard; this only checks a normal revoke→save does not resurrect the domain.
    it("keeps a revoked domain gone across a later unrelated save (sequential)", () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-egress-grant-resurrect-ws-"));
      const env = { KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-egress-grant-resurrect-home-")) };
      try {
        saveProjectEgressGrant(workspaceRoot, "example.com", PRINCIPAL, env);
        expect(revokeProjectEgressGrant(workspaceRoot, "example.com", env)).toBe("revoked");
        saveProjectEgressGrant(workspaceRoot, "other.com", PRINCIPAL, env);
        expect(loadProjectEgressGrants(workspaceRoot, env)).toEqual(["other.com"]);
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });
  });

  it("fails closed when saving or revoking invalid domains", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-egress-grant-invalid-domain-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-egress-grant-invalid-domain-ws-"));
    const env = { KEEL_HOME: keelHome };

    try {
      for (const domain of ["*", "localhost", "api.localhost", "Bücher.Localhost"]) {
        expect(saveProjectEgressGrant(workspaceRoot, domain, PRINCIPAL, env), domain).toBe(false);
        expect(loadProjectEgressGrants(workspaceRoot, env), domain).toEqual([]);
        expect(revokeProjectEgressGrant(workspaceRoot, domain, env), domain).toBe("write-failed");
      }
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("reports a persistence failure instead of implying durable authority", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-egress-grant-save-fail-ws-"));
    const blockedParent = mkdtempSync(join(tmpdir(), "keel-egress-grant-save-fail-parent-"));
    const blockedFile = join(blockedParent, "not-a-directory");
    writeFileSync(blockedFile, "not a directory");
    const env = { KEEL_HOME: join(blockedFile, "keel") };

    try {
      expect(saveProjectEgressGrant(workspaceRoot, "example.com", PRINCIPAL, env)).toBe(false);
      expect(loadProjectEgressGrants(workspaceRoot, env)).toEqual([]);
    } finally {
      rmSync(blockedParent, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("resolves egress grant store paths outside project-file scope", () => {
    expect(projectEgressGrantFilePath({ KEEL_HOME: "/keel-home" })).toBe(
      "/keel-home/egress-project-grants.json",
    );
    expect(projectEgressGrantFilePath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/keel/egress-project-grants.json",
    );
    expect(projectEgressGrantFilePath({ HOME: "/home/tester" })).toBe(
      "/home/tester/.config/keel/egress-project-grants.json",
    );
  });
});
