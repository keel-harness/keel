import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectCommandGrants, loadProjectEgressGrants } from "@keel/warden";
import {
  clearProjectAutopilotMode,
  loadProjectAutopilotMode,
  saveProjectAutopilotMode,
  type PersistedAutopilotModeT,
} from "../autopilot/mode-store.js";
import {
  appendAndRenderConfigChangeReceipt,
  nowConfigReceiptTs,
  type ConfigChangeReceiptT,
} from "../autopilot/config-receipt.js";
import { loadTrustDecision } from "../trust/trust-store.js";
import { workspaceKey } from "../session/workspace-key.js";

export const AUTOPILOT_MODE_USAGE =
  "usage: keel autopilot mode <status|set|clear>\n" +
  "usage: keel autopilot mode status\n" +
  "usage: keel autopilot mode set <guided|autopilot|project-autopilot>\n" +
  "usage: keel autopilot mode clear";

export interface AutopilotModeCommandInput {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly args: readonly string[];
}

export interface AutopilotModeCommandResult {
  readonly output: string;
  readonly ok: boolean;
}

function ok(output: string): AutopilotModeCommandResult {
  return { output, ok: true };
}

function fail(output: string): AutopilotModeCommandResult {
  return { output, ok: false };
}

function workspaceDisplayPath(cwd: string): string {
  const abs = resolve(cwd);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function modeLabel(mode: "guided" | PersistedAutopilotModeT): string {
  if (mode === "project-autopilot") return "Project Autopilot";
  if (mode === "autopilot") return "Autopilot";
  return "Guided";
}

function withReceipt(output: string, event: ConfigChangeReceiptT, env: NodeJS.ProcessEnv): string {
  return `${output}\n\n${appendAndRenderConfigChangeReceipt(event, env)}`;
}

function projectAutopilotSummary(): readonly string[] {
  return [
    "Project Autopilot configured for trusted sessions:",
    "- live activation: accepted warden mode.change at session start",
    "- workspace edits: auto after activation",
    "- read/search inside workspace: auto after activation",
    "- known test/build commands: auto after activation",
    "- external writes: review",
    "- destructive/irreversible actions: review or deny",
    "- secrets paths: deny",
    "- untrusted-derived egress: review",
    "- memory writes: review unless category auto-accept is explicitly configured",
  ];
}

function grantSummary(workspace: string, env: NodeJS.ProcessEnv): readonly string[] {
  const domains = loadProjectEgressGrants(workspace, env);
  const commands = loadProjectCommandGrants(workspace, env);
  const lines = ["stored project grants:", "egress domains:"];
  if (domains.length === 0) lines.push("  (none)");
  else lines.push(...domains.map((domain) => `  - ${domain}`));
  lines.push("command envelopes:");
  if (commands.length === 0) lines.push("  (none)");
  else lines.push(...commands.map((grant) => `  - ${grant.key}`));
  return lines;
}

function renderStatus(cwd: string, env: NodeJS.ProcessEnv): AutopilotModeCommandResult {
  const workspace = workspaceDisplayPath(cwd);
  const trusted = loadTrustDecision(workspace, env) === "trusted";
  const configured = loadProjectAutopilotMode(workspace, env)?.mode;
  const effective = trusted ? (configured ?? "guided") : "guided";
  const lines = [
    `Autopilot mode for ${workspace}`,
    `status: ${
      trusted
        ? "configured (workspace trusted; live activation happens at session start)"
        : "inactive (workspace not trusted)"
    }`,
    `configured mode: ${configured ?? "guided (default)"}`,
    `session startup mode: ${modeLabel(effective)}`,
    "source: keel-owned user config",
  ];
  if (configured === "project-autopilot" && effective === "project-autopilot") {
    lines.push(...projectAutopilotSummary(), ...grantSummary(workspace, env));
  } else if (configured === "project-autopilot") {
    lines.push(
      "Project Autopilot configured but inactive until workspace trust is restored and a live session accepts the mode change.",
    );
  }
  return ok(lines.join("\n"));
}

function parseMode(value: string | undefined): "guided" | PersistedAutopilotModeT | undefined {
  if (value === "guided" || value === "autopilot" || value === "project-autopilot") {
    return value;
  }
  return undefined;
}

function renderSet(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): AutopilotModeCommandResult {
  const mode = parseMode(args[0]);
  if (mode === undefined || args.length !== 1) {
    return fail("usage: keel autopilot mode set <guided|autopilot|project-autopilot>");
  }
  const workspace = workspaceDisplayPath(cwd);
  const trusted = loadTrustDecision(workspace, env) === "trusted";
  if (mode !== "guided" && !trusted) {
    return fail(
      `cannot set ${mode}: workspace is not trusted; run \`keel\` in an interactive terminal and accept the workspace trust prompt first`,
    );
  }
  const previous = loadProjectAutopilotMode(workspace, env)?.mode;
  if (mode === "guided") {
    const result = clearProjectAutopilotMode(workspace, env);
    if (result === "write-failed") {
      return fail(`failed to set Autopilot mode for ${workspace}: Guided`);
    }
    const output = `set Autopilot mode for ${workspace}: Guided (default)`;
    if (result !== "cleared") {
      return ok(`Autopilot mode for ${workspace} is already Guided (default)`);
    }
    return ok(
      withReceipt(
        output,
        {
          type: "config_change",
          v: 1,
          ts: nowConfigReceiptTs(),
          workspace,
          workspaceHash: workspaceKey(workspace),
          action: "set",
          target: { kind: "autopilot-mode", value: "guided" },
          changed: "Autopilot mode: Guided (default)",
          verified: ["removed persisted mode from keel-owned user config"],
          notVerified: ["already-running warden sessions were not changed"],
          undoCommand: `keel autopilot mode set ${previous ?? "autopilot"}`,
        },
        env,
      ),
    );
  }
  if (previous === mode) {
    const lines = [`Autopilot mode for ${workspace} is already ${modeLabel(mode)}`];
    if (mode === "project-autopilot") {
      lines.push(...projectAutopilotSummary(), ...grantSummary(workspace, env));
    }
    return ok(lines.join("\n"));
  }
  const result = saveProjectAutopilotMode(workspace, mode, env);
  if (result === "write-failed") {
    return fail(`failed to set Autopilot mode for ${workspace}: ${modeLabel(mode)}`);
  }
  const lines = [`set Autopilot mode for ${workspace}: ${modeLabel(mode)}`];
  if (mode === "project-autopilot") {
    lines.push(...projectAutopilotSummary(), ...grantSummary(workspace, env));
  }
  const output = lines.join("\n");
  return ok(
    withReceipt(
      output,
      {
        type: "config_change",
        v: 1,
        ts: nowConfigReceiptTs(),
        workspace,
        workspaceHash: workspaceKey(workspace),
        action: "set",
        target: { kind: "autopilot-mode", value: mode },
        changed: `Autopilot mode: ${modeLabel(mode)}`,
        verified: ["stored in keel-owned user config"],
        notVerified: ["live warden mode.change has not run yet"],
        undoCommand:
          previous === undefined
            ? "keel autopilot mode clear"
            : `keel autopilot mode set ${previous}`,
      },
      env,
    ),
  );
}

function renderClear(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): AutopilotModeCommandResult {
  if (args.length !== 0) return fail("usage: keel autopilot mode clear");
  const workspace = workspaceDisplayPath(cwd);
  const previous = loadProjectAutopilotMode(workspace, env)?.mode;
  const result = clearProjectAutopilotMode(workspace, env);
  if (result === "cleared") {
    return ok(
      withReceipt(
        `cleared persisted Autopilot mode for ${workspace}`,
        {
          type: "config_change",
          v: 1,
          ts: nowConfigReceiptTs(),
          workspace,
          workspaceHash: workspaceKey(workspace),
          action: "clear",
          target: { kind: "autopilot-mode", value: "guided" },
          changed: "Autopilot mode: Guided (default)",
          verified: ["removed persisted mode from keel-owned user config"],
          notVerified: ["already-running warden sessions were not changed"],
          undoCommand: `keel autopilot mode set ${previous ?? "autopilot"}`,
        },
        env,
      ),
    );
  }
  if (result === "write-failed") {
    return fail(`failed to clear persisted Autopilot mode for ${workspace}`);
  }
  return ok(`no persisted Autopilot mode for ${workspace}`);
}

export function runAutopilotModeCommandResult(
  input: AutopilotModeCommandInput,
): AutopilotModeCommandResult {
  const env = input.env ?? process.env;
  const [subcommand, ...rest] = input.args;
  if (subcommand === "status" && rest.length === 0) return renderStatus(input.cwd, env);
  if (subcommand === "set") return renderSet(input.cwd, env, rest);
  if (subcommand === "clear") return renderClear(input.cwd, env, rest);
  return fail(AUTOPILOT_MODE_USAGE);
}

export function runAutopilotModeCommand(input: AutopilotModeCommandInput): string {
  return runAutopilotModeCommandResult(input).output;
}
