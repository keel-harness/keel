import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectCommandGrants, saveProjectCommandGrant } from "@keel/warden";
import { saveTrustDecision } from "../trust/trust-store.js";
import {
  readConfigChangeReceipts,
  renderConfigChangeReceipt,
} from "../autopilot/config-receipt.js";
import { workspaceKey } from "../session/workspace-key.js";
import {
  loadProjectAutopilotMode,
  projectAutopilotModeFilePath,
  saveProjectAutopilotMode,
} from "../autopilot/mode-store.js";
import { runAutopilotModeCommand, runAutopilotModeCommandResult } from "./autopilot-mode.js";

const KEY_A = `sha256:${"a".repeat(64)}` as const;

const PRINCIPAL = {
  osUser: "tester",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
} as const;

describe("autopilot mode CLI", () => {
  it("shows persisted mode status with trust and project authority summary", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-status-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-status-ws-"));
    const env = { KEEL_HOME: keelHome, USER: "tester" };
    try {
      saveTrustDecision(workspaceRoot, "trusted", env);
      expect(saveProjectAutopilotMode(workspaceRoot, "project-autopilot", env)).toBe("saved");
      expect(saveProjectCommandGrant(workspaceRoot, KEY_A, PRINCIPAL, env)).toBe(true);

      const output = runAutopilotModeCommand({ cwd: workspaceRoot, env, args: ["status"] });

      expect(output).toContain(`Autopilot mode for ${realpathSync(workspaceRoot)}`);
      expect(output).toContain(
        "status: configured (workspace trusted; live activation happens at session start)",
      );
      expect(output).toContain("configured mode: project-autopilot");
      expect(output).toContain("session startup mode: Project Autopilot");
      expect(output).toContain("source: keel-owned user config");
      expect(output).toContain("Project Autopilot configured for trusted sessions:");
      expect(output).toContain("live activation: accepted warden mode.change at session start");
      expect(output).toContain("stored project grants:");
      expect(output).toContain("command envelopes:");
      expect(output).toContain(KEY_A);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("refuses to persist raised modes for untrusted workspaces but allows lowering to Guided", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-untrusted-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-untrusted-ws-"));
    const env = { KEEL_HOME: keelHome };
    try {
      expect(
        runAutopilotModeCommand({
          cwd: workspaceRoot,
          env,
          args: ["set", "project-autopilot"],
        }),
      ).toContain("cannot set project-autopilot: workspace is not trusted");
      expect(loadProjectAutopilotMode(workspaceRoot, env)).toBeUndefined();

      expect(
        runAutopilotModeCommand({
          cwd: workspaceRoot,
          env,
          args: ["set", "guided"],
        }),
      ).toContain("is already Guided (default)");
      expect(loadProjectAutopilotMode(workspaceRoot, env)).toBeUndefined();
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("sets, clears, and validates persisted modes without touching grants", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-set-clear-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-set-clear-ws-"));
    const env = { KEEL_HOME: keelHome };
    try {
      saveTrustDecision(workspaceRoot, "trusted", env);
      expect(saveProjectCommandGrant(workspaceRoot, KEY_A, PRINCIPAL, env)).toBe(true);

      expect(
        runAutopilotModeCommand({ cwd: workspaceRoot, env, args: ["set", "autopilot"] }),
      ).toContain("set Autopilot mode");
      expect(loadProjectAutopilotMode(workspaceRoot, env)?.mode).toBe("autopilot");

      expect(
        runAutopilotModeCommand({
          cwd: workspaceRoot,
          env,
          args: ["clear"],
        }),
      ).toContain("cleared persisted Autopilot mode");
      expect(loadProjectAutopilotMode(workspaceRoot, env)).toBeUndefined();
      expect(loadProjectCommandGrants(workspaceRoot, env).map((grant) => grant.key)).toEqual([
        KEY_A,
      ]);

      expect(
        runAutopilotModeCommand({ cwd: workspaceRoot, env, args: ["set", "danger"] }),
      ).toContain("usage: keel autopilot mode set");
      expect(runAutopilotModeCommand({ cwd: workspaceRoot, env, args: ["clear", "x"] })).toContain(
        "usage: keel autopilot mode clear",
      );
      expect(
        runAutopilotModeCommandResult({ cwd: workspaceRoot, env, args: ["set", "danger"] }),
      ).toMatchObject({ ok: false });
      expect(
        runAutopilotModeCommandResult({ cwd: workspaceRoot, env, args: ["clear", "x"] }),
      ).toMatchObject({ ok: false });
      expect(runAutopilotModeCommand({ cwd: workspaceRoot, env, args: ["status", "x"] })).toContain(
        "usage: keel autopilot mode",
      );
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("renders inactive default status and a no-op clear for unconfigured workspaces", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-default-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-default-ws-"));
    const env = { KEEL_HOME: keelHome };
    try {
      const output = runAutopilotModeCommand({ cwd: workspaceRoot, env, args: ["status"] });

      expect(output).toContain("status: inactive (workspace not trusted)");
      expect(output).toContain("configured mode: guided (default)");
      expect(output).toContain("session startup mode: Guided");
      expect(output).not.toContain("Project Autopilot configured for trusted sessions:");
      expect(runAutopilotModeCommand({ cwd: workspaceRoot, env, args: ["clear"] })).toContain(
        "no persisted Autopilot mode",
      );
      expect(runAutopilotModeCommand({ cwd: workspaceRoot, args: ["wat"] })).toBe(
        "usage: keel autopilot mode <status|set|clear>\n" +
          "usage: keel autopilot mode status\n" +
          "usage: keel autopilot mode set <guided|autopilot|project-autopilot>\n" +
          "usage: keel autopilot mode clear",
      );
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("keeps stale persisted Project Autopilot visibly inactive for untrusted workspaces", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-inactive-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-inactive-ws-"));
    const env = { KEEL_HOME: keelHome };
    try {
      expect(saveProjectAutopilotMode(workspaceRoot, "project-autopilot", env)).toBe("saved");

      const output = runAutopilotModeCommand({ cwd: workspaceRoot, env, args: ["status"] });

      expect(output).toContain("status: inactive (workspace not trusted)");
      expect(output).toContain("configured mode: project-autopilot");
      expect(output).toContain("session startup mode: Guided");
      expect(output).toContain("Project Autopilot configured but inactive");
      expect(output).not.toContain("Project Autopilot configured for trusted sessions:");
      expect(output).not.toContain("stored project grants:");
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("prints Project Autopilot authority on set and reports mode-store write failures", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-write-fail-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-write-fail-ws-"));
    const env = { KEEL_HOME: keelHome, USER: "tester" };
    try {
      saveTrustDecision(workspaceRoot, "trusted", env);

      const setOutput = runAutopilotModeCommand({
        cwd: workspaceRoot,
        env,
        args: ["set", "project-autopilot"],
      });
      expect(setOutput).toContain("set Autopilot mode");
      expect(setOutput).toContain("Project Autopilot configured for trusted sessions:");
      expect(setOutput).toContain("egress domains:");
      expect(setOutput).toContain("command envelopes:");
      expect(setOutput).toContain("Config-change receipt");
      expect(setOutput).toContain("changed: Autopilot mode: Project Autopilot");
      expect(setOutput).toContain("verified: stored in keel-owned user config");
      expect(setOutput).toContain("undo: keel autopilot mode clear");
      expect(setOutput).toContain("not a warden audit event");
      const receipts = readConfigChangeReceipts(env);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        action: "set",
        workspaceHash: workspaceKey(realpathSync(workspaceRoot)),
        target: { kind: "autopilot-mode", value: "project-autopilot" },
      });
      expect(renderConfigChangeReceipt(receipts[0]!)).toContain(
        "changed: Autopilot mode: Project Autopilot",
      );

      expect(runAutopilotModeCommand({ cwd: workspaceRoot, env, args: ["clear"] })).toContain(
        "cleared persisted Autopilot mode",
      );
      expect(readConfigChangeReceipts(env)).toHaveLength(2);
      expect(readConfigChangeReceipts(env)[1]).toMatchObject({
        action: "clear",
        target: { kind: "autopilot-mode", value: "guided" },
        undoCommand: "keel autopilot mode set project-autopilot",
      });
      rmSync(projectAutopilotModeFilePath(env), { force: true });
      mkdirSync(projectAutopilotModeFilePath(env), { recursive: true });
      expect(
        runAutopilotModeCommand({ cwd: workspaceRoot, env, args: ["set", "autopilot"] }),
      ).toContain("failed to set Autopilot mode");
      expect(readConfigChangeReceipts(env)).toHaveLength(2);
      expect(
        runAutopilotModeCommandResult({ cwd: workspaceRoot, env, args: ["set", "autopilot"] }),
      ).toMatchObject({ ok: false });
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("reports clear write failures from the keel-owned mode store", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-clear-fail-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-clear-fail-ws-"));
    const env = { KEEL_HOME: keelHome };
    try {
      expect(saveProjectAutopilotMode(workspaceRoot, "autopilot", env)).toBe("saved");
      chmodSync(keelHome, 0o500);

      expect(runAutopilotModeCommand({ cwd: workspaceRoot, env, args: ["clear"] })).toContain(
        "failed to clear persisted Autopilot mode",
      );
      expect(
        runAutopilotModeCommandResult({ cwd: workspaceRoot, env, args: ["clear"] }),
      ).toMatchObject({ ok: false });
    } finally {
      chmodSync(keelHome, 0o700);
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("renders exact undo guidance when replacing an existing persisted mode", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-replace-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-replace-ws-"));
    const env = { KEEL_HOME: keelHome };
    try {
      saveTrustDecision(workspaceRoot, "trusted", env);

      expect(
        runAutopilotModeCommand({ cwd: workspaceRoot, env, args: ["set", "autopilot"] }),
      ).toContain("changed: Autopilot mode: Autopilot");
      const replaceOutput = runAutopilotModeCommand({
        cwd: workspaceRoot,
        env,
        args: ["set", "project-autopilot"],
      });

      expect(replaceOutput).toContain("changed: Autopilot mode: Project Autopilot");
      expect(replaceOutput).toContain("undo: keel autopilot mode set autopilot");
      expect(readConfigChangeReceipts(env)).toHaveLength(2);
      expect(readConfigChangeReceipts(env)[1]).toMatchObject({
        action: "set",
        target: { kind: "autopilot-mode", value: "project-autopilot" },
        undoCommand: "keel autopilot mode set autopilot",
      });
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("renders a receipt when lowering a persisted mode to Guided via set guided", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-guided-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-guided-ws-"));
    const env = { KEEL_HOME: keelHome };
    try {
      saveTrustDecision(workspaceRoot, "trusted", env);
      expect(saveProjectAutopilotMode(workspaceRoot, "project-autopilot", env)).toBe("saved");

      const output = runAutopilotModeCommand({
        cwd: workspaceRoot,
        env,
        args: ["set", "guided"],
      });

      expect(output).toContain("set Autopilot mode");
      expect(output).toContain("changed: Autopilot mode: Guided (default)");
      expect(output).toContain("verified: removed persisted mode from keel-owned user config");
      expect(output).toContain("undo: keel autopilot mode set project-autopilot");
      expect(loadProjectAutopilotMode(workspaceRoot, env)).toBeUndefined();
      expect(readConfigChangeReceipts(env)).toEqual([
        expect.objectContaining({
          action: "set",
          target: { kind: "autopilot-mode", value: "guided" },
          undoCommand: "keel autopilot mode set project-autopilot",
        }),
      ]);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("does not write a changed receipt when setting an already persisted raised mode", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-noop-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-noop-ws-"));
    const env = { KEEL_HOME: keelHome };
    try {
      saveTrustDecision(workspaceRoot, "trusted", env);

      expect(
        runAutopilotModeCommand({ cwd: workspaceRoot, env, args: ["set", "project-autopilot"] }),
      ).toContain("changed: Autopilot mode: Project Autopilot");

      const noOpOutput = runAutopilotModeCommand({
        cwd: workspaceRoot,
        env,
        args: ["set", "project-autopilot"],
      });

      expect(noOpOutput).toContain("is already Project Autopilot");
      expect(noOpOutput).toContain("Project Autopilot configured for trusted sessions:");
      expect(noOpOutput).not.toContain("Config-change receipt");
      expect(readConfigChangeReceipts(env)).toHaveLength(1);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
