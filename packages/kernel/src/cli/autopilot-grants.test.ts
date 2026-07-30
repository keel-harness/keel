import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadProjectCommandGrants,
  loadProjectEgressGrants,
  saveProjectCommandGrant,
  saveProjectEgressGrant,
} from "@keel/warden";
import { saveTrustDecision } from "../trust/trust-store.js";
import { readConfigChangeReceipts } from "../autopilot/config-receipt.js";
import { workspaceKey } from "../session/workspace-key.js";
import { runAutopilotGrantsCommand, runAutopilotGrantsCommandResult } from "./autopilot-grants.js";

const PRINCIPAL = {
  osUser: "tester",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
} as const;

const KEY_A = `sha256:${"a".repeat(64)}` as const;
const KEY_B = `sha256:${"b".repeat(64)}` as const;

describe("autopilot project grant CLI", () => {
  it("lists current-workspace project grants with honest trust status", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-grants-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-grants-ws-"));
    const env = { KEEL_HOME: keelHome };

    try {
      saveTrustDecision(workspaceRoot, "trusted", env);
      saveProjectEgressGrant(workspaceRoot, "Example.COM", PRINCIPAL, env);
      expect(saveProjectCommandGrant(workspaceRoot, KEY_A, PRINCIPAL, env)).toBe(true);

      const output = runAutopilotGrantsCommand({
        cwd: workspaceRoot,
        env,
        args: ["list"],
      });

      expect(output).toContain(`Project Autopilot grants for ${realpathSync(workspaceRoot)}`);
      expect(output).toContain(
        "status: stored (workspace trusted; active only after Project Autopilot starts)",
      );
      expect(output).toContain("egress domains:");
      expect(output).toContain("  - example.com");
      expect(output).toContain("command envelopes:");
      expect(output).toContain(`  - ${KEY_A}`);
      expect(output).toContain("source: keel-owned user config");
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("lists grants as inactive when the workspace is not trusted", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-grants-untrusted-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-grants-untrusted-ws-"));
    const env = { KEEL_HOME: keelHome };

    try {
      saveProjectEgressGrant(workspaceRoot, "example.com", PRINCIPAL, env);

      const output = runAutopilotGrantsCommand({
        cwd: workspaceRoot,
        env,
        args: ["list"],
      });

      expect(output).toContain("status: inactive (workspace not trusted)");
      expect(output).toContain("  - example.com");
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("lists no grants for a missing workspace path without requiring realpath", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-grants-empty-"));
    const workspaceRoot = join(
      tmpdir(),
      `keel-autopilot-grants-missing-ws-${process.pid}-${Date.now()}`,
    );
    const env = { KEEL_HOME: keelHome };

    try {
      const output = runAutopilotGrantsCommand({
        cwd: workspaceRoot,
        env,
        args: ["list"],
      });

      expect(output).toContain(`Project Autopilot grants for ${workspaceRoot}`);
      expect(output).toContain("status: inactive (workspace not trusted)");
      expect(output).toContain("no project grants");
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
    }
  });

  it("revokes exact project grants without touching other grant kinds or workspaces", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-grants-revoke-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-grants-revoke-ws-"));
    const otherWorkspace = mkdtempSync(join(tmpdir(), "keel-autopilot-grants-other-ws-"));
    const env = { KEEL_HOME: keelHome };

    try {
      saveProjectEgressGrant(workspaceRoot, "example.com", PRINCIPAL, env);
      saveProjectEgressGrant(workspaceRoot, "api.example.com", PRINCIPAL, env);
      saveProjectEgressGrant(otherWorkspace, "example.com", PRINCIPAL, env);
      expect(saveProjectCommandGrant(workspaceRoot, KEY_A, PRINCIPAL, env)).toBe(true);
      expect(saveProjectCommandGrant(workspaceRoot, KEY_B, PRINCIPAL, env)).toBe(true);
      expect(saveProjectCommandGrant(otherWorkspace, KEY_A, PRINCIPAL, env)).toBe(true);

      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          env,
          args: ["revoke", "--domain", "EXAMPLE.com"],
        }),
      ).toContain("revoked project egress grant: example.com");
      expect(readConfigChangeReceipts(env)).toEqual([
        expect.objectContaining({
          action: "revoke",
          workspaceHash: workspaceKey(realpathSync(workspaceRoot)),
          target: { kind: "project-egress-domain", value: "example.com" },
          undoCommand: "approve egress to example.com again when a live review asks",
        }),
      ]);
      expect(loadProjectEgressGrants(workspaceRoot, env)).toEqual(["api.example.com"]);
      expect(loadProjectEgressGrants(otherWorkspace, env)).toEqual(["example.com"]);

      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          env,
          args: ["revoke", "--command-key", KEY_A],
        }),
      ).toContain(`revoked project command grant: ${KEY_A}`);
      expect(readConfigChangeReceipts(env)).toHaveLength(2);
      expect(readConfigChangeReceipts(env)[1]).toMatchObject({
        action: "revoke",
        workspaceHash: workspaceKey(realpathSync(workspaceRoot)),
        target: { kind: "project-command-key", value: KEY_A },
        undoCommand: "approve the same command review again",
      });
      expect(loadProjectCommandGrants(workspaceRoot, env).map((grant) => grant.key)).toEqual([
        KEY_B,
      ]);
      expect(loadProjectCommandGrants(otherWorkspace, env).map((grant) => grant.key)).toEqual([
        KEY_A,
      ]);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });

  it("supports equals-form revoke flags and reports missing grants honestly", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-grants-revoke-equals-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-grants-revoke-equals-ws-"));
    const env = { KEEL_HOME: keelHome };

    try {
      saveProjectEgressGrant(workspaceRoot, "example.com", PRINCIPAL, env);
      expect(saveProjectCommandGrant(workspaceRoot, KEY_A, PRINCIPAL, env)).toBe(true);

      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          env,
          args: ["revoke", "--domain=EXAMPLE.com"],
        }),
      ).toContain("revoked project egress grant: example.com");
      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          env,
          args: ["revoke", "--domain=missing.example"],
        }),
      ).toBe("no matching project egress grant: missing.example");

      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          env,
          args: ["revoke", `--command-key=${KEY_A}`],
        }),
      ).toContain(`revoked project command grant: ${KEY_A}`);
      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          env,
          args: ["revoke", `--command-key=${KEY_B}`],
        }),
      ).toBe(`no matching project command grant: ${KEY_B}`);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("renders empty sections when only one project grant kind exists", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-grants-one-kind-"));
    const egressWorkspace = mkdtempSync(
      join(tmpdir(), "keel-autopilot-grants-one-kind-egress-ws-"),
    );
    const commandWorkspace = mkdtempSync(
      join(tmpdir(), "keel-autopilot-grants-one-kind-command-ws-"),
    );
    const env = { KEEL_HOME: keelHome };

    try {
      saveProjectEgressGrant(egressWorkspace, "example.com", PRINCIPAL, env);
      expect(saveProjectCommandGrant(commandWorkspace, KEY_A, PRINCIPAL, env)).toBe(true);

      expect(
        runAutopilotGrantsCommand({
          cwd: egressWorkspace,
          env,
          args: ["list"],
        }),
      ).toContain("command envelopes:\n  (none)");
      expect(
        runAutopilotGrantsCommand({
          cwd: commandWorkspace,
          env,
          args: ["list"],
        }),
      ).toContain("egress domains:\n  (none)");
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(egressWorkspace, { recursive: true, force: true });
      rmSync(commandWorkspace, { recursive: true, force: true });
    }
  });

  it("fails closed on ambiguous or invalid revoke requests", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-grants-usage-ws-"));
    const env = { KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-autopilot-grants-usage-")) };

    try {
      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          env,
          args: ["revoke", "--domain", "example.com", "--command-key", KEY_A],
        }),
      ).toContain("usage: keel autopilot grants revoke");
      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          env,
          args: ["revoke", "--command-key", "mkdir dist"],
        }),
      ).toContain("usage: keel autopilot grants revoke");
      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          env,
          args: ["revoke", "--domain", "example.com", "--unknown"],
        }),
      ).toContain("usage: keel autopilot grants revoke");
      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          env,
          args: ["revoke", "--domain=*"],
        }),
      ).toContain("usage: keel autopilot grants revoke");
      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          env,
          args: ["revoke", "--domain="],
        }),
      ).toContain("usage: keel autopilot grants revoke");
      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          env,
          args: ["revoke", "--bogus"],
        }),
      ).toContain("usage: keel autopilot grants revoke");
      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          env,
          args: ["revoke", "--command-key"],
        }),
      ).toContain("usage: keel autopilot grants revoke");
      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          env,
          args: ["list", "--verbose"],
        }),
      ).toContain("usage: keel autopilot grants list");
      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          args: ["bogus"],
        }),
      ).toContain("usage: keel autopilot grants <list|revoke>");
      expect(
        runAutopilotGrantsCommandResult({
          cwd: workspaceRoot,
          env,
          args: ["revoke", "--bogus"],
        }),
      ).toMatchObject({ ok: false });
      expect(
        runAutopilotGrantsCommandResult({
          cwd: workspaceRoot,
          env,
          args: ["bogus"],
        }),
      ).toMatchObject({ ok: false });
    } finally {
      rmSync(env.KEEL_HOME, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  // Skipped as root, where directory mode bits do not restrict writes.
  const itUnlessRoot = process.getuid?.() === 0 ? it.skip : it;
  itUnlessRoot("reports revoke write failures distinctly from missing grants", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-grants-write-fail-ws-"));
    const env = { KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-autopilot-grants-write-fail-")) };

    try {
      saveProjectEgressGrant(workspaceRoot, "example.com", PRINCIPAL, env);
      expect(saveProjectCommandGrant(workspaceRoot, KEY_A, PRINCIPAL, env)).toBe(true);
      // Make the store directory unwritable so the atomic write's temp-create fails while the
      // already-persisted grants stay readable.
      chmodSync(env.KEEL_HOME, 0o500);

      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          env,
          args: ["revoke", "--domain", "example.com"],
        }),
      ).toContain("failed to revoke persisted project egress grant: example.com");
      expect(
        runAutopilotGrantsCommandResult({
          cwd: workspaceRoot,
          env,
          args: ["revoke", "--domain", "example.com"],
        }),
      ).toMatchObject({ ok: false });
      expect(readConfigChangeReceipts(env)).toEqual([]);
      expect(
        runAutopilotGrantsCommand({
          cwd: workspaceRoot,
          env,
          args: ["revoke", "--command-key", KEY_A],
        }),
      ).toContain(`failed to revoke persisted project command grant: ${KEY_A}`);
      expect(readConfigChangeReceipts(env)).toEqual([]);
    } finally {
      chmodSync(env.KEEL_HOME, 0o700);
      rmSync(env.KEEL_HOME, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
