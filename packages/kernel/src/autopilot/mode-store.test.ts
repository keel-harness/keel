import { describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearProjectAutopilotMode,
  loadProjectAutopilotMode,
  projectAutopilotModeFilePath,
  saveProjectAutopilotMode,
} from "./mode-store.js";

describe("project Autopilot mode store", () => {
  it("stores a persisted mode in keel-owned config keyed by real workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-store-"));
    const keelHome = join(root, "keel-home");
    const workspace = join(root, "workspace");
    const alias = join(root, "workspace-link");
    const env = { KEEL_HOME: keelHome, USER: "tester" };
    try {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(alias, { recursive: true, force: true });
      symlinkSync(root, workspace);
      symlinkSync(root, alias);

      expect(saveProjectAutopilotMode(workspace, "project-autopilot", env)).toBe("saved");

      expect(loadProjectAutopilotMode(alias, env)).toMatchObject({
        mode: "project-autopilot",
        principal: "tester",
      });
      expect(existsSync(join(root, "project-autopilot-modes.json"))).toBe(false);
      expect(lstatSync(projectAutopilotModeFilePath(env)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed config and supports exact current-workspace clear", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-clear-"));
    const keelHome = join(root, "keel-home");
    const workspace = join(root, "workspace");
    const other = join(root, "other");
    const env = { KEEL_HOME: keelHome };
    try {
      expect(saveProjectAutopilotMode(workspace, "autopilot", env)).toBe("saved");
      expect(saveProjectAutopilotMode(other, "project-autopilot", env)).toBe("saved");
      expect(clearProjectAutopilotMode(workspace, env)).toBe("cleared");
      expect(loadProjectAutopilotMode(workspace, env)).toBeUndefined();
      expect(loadProjectAutopilotMode(other, env)?.mode).toBe("project-autopilot");
      expect(clearProjectAutopilotMode(workspace, env)).toBe("not-found");

      writeFileSync(
        projectAutopilotModeFilePath(env),
        '{"version":1,"workspaces":{"x":{"mode":"danger"}}}',
      );
      expect(loadProjectAutopilotMode(other, env)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads entries that predate principal attribution", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-legacy-entry-"));
    const keelHome = join(root, "keel-home");
    const workspace = join(root, "workspace");
    const env = { KEEL_HOME: keelHome };
    try {
      mkdirSync(keelHome, { recursive: true });
      writeFileSync(
        projectAutopilotModeFilePath(env),
        JSON.stringify({
          version: 1,
          workspaces: {
            [workspace]: {
              mode: "project-autopilot",
              updatedAt: "2026-07-06T00:00:00.000Z",
            },
          },
        }),
      );

      expect(loadProjectAutopilotMode(workspace, env)).toEqual({
        mode: "project-autopilot",
        updatedAt: "2026-07-06T00:00:00.000Z",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports write failures without persisting a raised mode", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-write-fail-"));
    const keelHome = join(root, "keel-home");
    const workspace = join(root, "workspace");
    const env = { KEEL_HOME: keelHome };
    try {
      mkdirSync(projectAutopilotModeFilePath(env), { recursive: true });

      expect(saveProjectAutopilotMode(workspace, "autopilot", env)).toBe("write-failed");
      expect(loadProjectAutopilotMode(workspace, env)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not follow or rename a planted fixed temp symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-temp-hardening-"));
    const keelHome = join(root, "keel-home");
    const workspace = join(root, "workspace");
    const env = { KEEL_HOME: keelHome };
    const modeFile = projectAutopilotModeFilePath(env);
    const victim = join(root, "victim.json");
    try {
      expect(saveProjectAutopilotMode(workspace, "autopilot", env)).toBe("saved");
      expect(clearProjectAutopilotMode(workspace, env)).toBe("cleared");
      rmSync(modeFile, { force: true });
      writeFileSync(victim, "victim", { mode: 0o600 });
      symlinkSync(victim, `${modeFile}.tmp`);

      expect(saveProjectAutopilotMode(workspace, "project-autopilot", env)).toBe("saved");

      expect(readFileSync(victim, "utf8")).toBe("victim");
      expect(lstatSync(modeFile).isSymbolicLink()).toBe(false);
      expect(loadProjectAutopilotMode(workspace, env)?.mode).toBe("project-autopilot");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the final mode store owner-only even when a loose fixed temp file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-temp-mode-"));
    const keelHome = join(root, "keel-home");
    const workspace = join(root, "workspace");
    const env = { KEEL_HOME: keelHome };
    const modeFile = projectAutopilotModeFilePath(env);
    try {
      expect(saveProjectAutopilotMode(workspace, "autopilot", env)).toBe("saved");
      expect(clearProjectAutopilotMode(workspace, env)).toBe("cleared");
      rmSync(modeFile, { force: true });
      writeFileSync(`${modeFile}.tmp`, "leftover", { mode: 0o644 });

      expect(saveProjectAutopilotMode(workspace, "project-autopilot", env)).toBe("saved");

      expect(lstatSync(modeFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(`${modeFile}.tmp`, "utf8")).toBe("leftover");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports clear write failures without treating the mode as cleared", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-clear-fail-"));
    const keelHome = join(root, "keel-home");
    const workspace = join(root, "workspace");
    const env = { KEEL_HOME: keelHome };
    try {
      expect(saveProjectAutopilotMode(workspace, "project-autopilot", env)).toBe("saved");
      chmodSync(keelHome, 0o500);

      expect(clearProjectAutopilotMode(workspace, env)).toBe("write-failed");
      expect(loadProjectAutopilotMode(workspace, env)?.mode).toBe("project-autopilot");
    } finally {
      chmodSync(keelHome, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports clear write failures after the writer lock is acquired", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-clear-write-fail-"));
    const keelHome = join(root, "keel-home");
    const badKeelHome = join(root, "bad-keel-home");
    const workspace = join(root, "workspace");
    const env = { KEEL_HOME: keelHome };
    let keelHomeReads = 0;
    // Force the WRITE to fail (not the lock) by swapping KEEL_HOME to a bad dir only for the
    // writeStore read. clearProjectAutopilotMode reads KEEL_HOME 3× via `projectAutopilotModeFilePath`:
    // (1) withStoreLock's lock target, (2) readStore, (3) writeStore — so the good dir serves reads
    // 1-2 and the bad dir (a directory blocking the mode file) serves read 3+.
    const clearEnv = new Proxy<NodeJS.ProcessEnv>(
      {},
      {
        get(_target, prop) {
          if (prop !== "KEEL_HOME") return undefined;
          keelHomeReads += 1;
          return keelHomeReads <= 2 ? keelHome : badKeelHome;
        },
      },
    );
    try {
      expect(saveProjectAutopilotMode(workspace, "project-autopilot", env)).toBe("saved");
      mkdirSync(join(badKeelHome, "project-autopilot-modes.json"), { recursive: true });

      expect(clearProjectAutopilotMode(workspace, clearEnv)).toBe("write-failed");
      expect(loadProjectAutopilotMode(workspace, env)?.mode).toBe("project-autopilot");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed instead of mutating while another mode-store writer lock exists", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-lock-"));
    const keelHome = join(root, "keel-home");
    const workspace = join(root, "workspace");
    const other = join(root, "other");
    const env = { KEEL_HOME: keelHome };
    const modeFile = projectAutopilotModeFilePath(env);
    try {
      expect(saveProjectAutopilotMode(workspace, "autopilot", env)).toBe("saved");
      writeFileSync(`${modeFile}.lock`, '{"pid":1}\n', { mode: 0o600 });

      expect(saveProjectAutopilotMode(other, "project-autopilot", env)).toBe("write-failed");
      expect(clearProjectAutopilotMode(workspace, env)).toBe("write-failed");
      expect(loadProjectAutopilotMode(workspace, env)?.mode).toBe("autopilot");
      expect(loadProjectAutopilotMode(other, env)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reclaims a stale lock from a SIGKILL'd writer (dead PID) instead of bricking mode changes (P1-20)", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-autopilot-mode-stale-"));
    const keelHome = join(root, "keel-home");
    const workspace = join(root, "workspace");
    const env = { KEEL_HOME: keelHome };
    const modeFile = projectAutopilotModeFilePath(env);
    try {
      mkdirSync(keelHome, { recursive: true });
      // A previous writer was SIGKILL'd, leaving its lock behind with a now-dead PID (2147483000 is
      // a valid-range PID that does not exist → process.kill reports ESRCH). Before P1-20 this bricked
      // every future mode change with "write-failed" (EEXIST → bare catch) until a manual `rm`.
      writeFileSync(`${modeFile}.lock`, `${JSON.stringify({ pid: 2147483000 })}\n`, {
        mode: 0o600,
      });

      expect(saveProjectAutopilotMode(workspace, "autopilot", env)).toBe("saved");
      expect(loadProjectAutopilotMode(workspace, env)?.mode).toBe("autopilot");
      // The reclaimed lock is released after the operation, not left dangling.
      expect(existsSync(`${modeFile}.lock`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
