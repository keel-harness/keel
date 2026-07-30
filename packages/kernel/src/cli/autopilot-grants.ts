import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { domainToASCII } from "node:url";
import {
  loadProjectCommandGrants,
  loadProjectEgressGrants,
  revokeProjectCommandGrant,
  revokeProjectEgressGrant,
} from "@keel/warden";
import {
  appendAndRenderConfigChangeReceipt,
  nowConfigReceiptTs,
  type ConfigChangeReceiptT,
} from "../autopilot/config-receipt.js";
import { loadTrustDecision } from "../trust/trust-store.js";
import { workspaceKey } from "../session/workspace-key.js";

const COMMAND_GRANT_KEY_RE = /^sha256:[a-f0-9]{64}$/u;

export const AUTOPILOT_GRANTS_USAGE =
  "usage: keel autopilot grants <list|revoke>\n" +
  "usage: keel autopilot grants list\n" +
  "usage: keel autopilot grants revoke (--domain <domain> | --command-key <sha256:key>)";

export interface AutopilotGrantsCommandInput {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly args: readonly string[];
}

export interface AutopilotGrantsCommandResult {
  readonly output: string;
  readonly ok: boolean;
}

function ok(output: string): AutopilotGrantsCommandResult {
  return { output, ok: true };
}

function fail(output: string): AutopilotGrantsCommandResult {
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

function normalizeDisplayDomain(domain: string): string | undefined {
  const trimmed = domain.trim().toLowerCase();
  if (trimmed === "" || trimmed.includes("*")) return undefined;
  const ascii = domainToASCII(trimmed);
  return ascii === "" ? undefined : ascii;
}

type RevokeTarget =
  | { readonly kind: "domain"; readonly value: string }
  | { readonly kind: "command-key"; readonly value: string };

function withReceipt(output: string, event: ConfigChangeReceiptT, env: NodeJS.ProcessEnv): string {
  return `${output}\n\n${appendAndRenderConfigChangeReceipt(event, env)}`;
}

function parseRevokeTarget(args: readonly string[]): RevokeTarget | undefined {
  if (args.length === 1) {
    const [arg] = args;
    if (arg?.startsWith("--domain=")) {
      return { kind: "domain", value: arg.slice("--domain=".length) };
    }
    if (arg?.startsWith("--command-key=")) {
      return { kind: "command-key", value: arg.slice("--command-key=".length) };
    }
    return undefined;
  }
  if (args.length !== 2) return undefined;
  const [flag, value] = args;
  if (value === undefined) return undefined;
  if (flag === "--domain") return { kind: "domain", value };
  if (flag === "--command-key") return { kind: "command-key", value };
  return undefined;
}

function renderList(cwd: string, env: NodeJS.ProcessEnv): AutopilotGrantsCommandResult {
  const workspace = workspaceDisplayPath(cwd);
  const trusted = loadTrustDecision(workspace, env) === "trusted";
  const domains = loadProjectEgressGrants(workspace, env);
  const commands = loadProjectCommandGrants(workspace, env);
  const lines = [
    `Project Autopilot grants for ${workspace}`,
    `status: ${
      trusted
        ? "stored (workspace trusted; active only after Project Autopilot starts)"
        : "inactive (workspace not trusted)"
    }`,
    "source: keel-owned user config",
  ];

  if (domains.length === 0 && commands.length === 0) {
    lines.push("no project grants");
    return ok(lines.join("\n"));
  }

  lines.push("egress domains:");
  if (domains.length === 0) lines.push("  (none)");
  else lines.push(...domains.map((domain) => `  - ${domain}`));
  lines.push("command envelopes:");
  if (commands.length === 0) lines.push("  (none)");
  else lines.push(...commands.map((grant) => `  - ${grant.key}`));
  return ok(lines.join("\n"));
}

function renderRevoke(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): AutopilotGrantsCommandResult {
  const target = parseRevokeTarget(args);
  if (target === undefined) return fail(AUTOPILOT_GRANTS_USAGE);

  const workspace = workspaceDisplayPath(cwd);
  if (target.kind === "domain") {
    const domain = normalizeDisplayDomain(target.value);
    if (domain === undefined) return fail(AUTOPILOT_GRANTS_USAGE);
    const result = revokeProjectEgressGrant(workspace, domain, env);
    if (result === "revoked") {
      return ok(
        withReceipt(
          `revoked project egress grant: ${domain}`,
          {
            type: "config_change",
            v: 1,
            ts: nowConfigReceiptTs(),
            workspace,
            workspaceHash: workspaceKey(workspace),
            action: "revoke",
            target: { kind: "project-egress-domain", value: domain },
            changed: `Project egress grant revoked: ${domain}`,
            verified: ["removed from keel-owned user config"],
            notVerified: ["already-running warden sessions were not changed"],
            undoCommand: `approve egress to ${domain} again when a live review asks`,
          },
          env,
        ),
      );
    }
    if (result === "write-failed") {
      return fail(`failed to revoke persisted project egress grant: ${domain}`);
    }
    return ok(`no matching project egress grant: ${domain}`);
  }

  if (!COMMAND_GRANT_KEY_RE.test(target.value)) return fail(AUTOPILOT_GRANTS_USAGE);
  const result = revokeProjectCommandGrant(workspace, target.value as `sha256:${string}`, env);
  if (result === "revoked") {
    return ok(
      withReceipt(
        `revoked project command grant: ${target.value}`,
        {
          type: "config_change",
          v: 1,
          ts: nowConfigReceiptTs(),
          workspace,
          workspaceHash: workspaceKey(workspace),
          action: "revoke",
          target: { kind: "project-command-key", value: target.value },
          changed: `Project command grant revoked: ${target.value}`,
          verified: ["removed from keel-owned user config"],
          notVerified: ["already-running warden sessions were not changed"],
          undoCommand: "approve the same command review again",
        },
        env,
      ),
    );
  }
  if (result === "write-failed") {
    return fail(`failed to revoke persisted project command grant: ${target.value}`);
  }
  return ok(`no matching project command grant: ${target.value}`);
}

export function runAutopilotGrantsCommandResult(
  input: AutopilotGrantsCommandInput,
): AutopilotGrantsCommandResult {
  const env = input.env ?? process.env;
  const [subcommand, ...rest] = input.args;
  if (subcommand === "list" && rest.length === 0) return renderList(input.cwd, env);
  if (subcommand === "revoke") return renderRevoke(input.cwd, env, rest);
  return fail(AUTOPILOT_GRANTS_USAGE);
}

export function runAutopilotGrantsCommand(input: AutopilotGrantsCommandInput): string {
  return runAutopilotGrantsCommandResult(input).output;
}
