import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import type { JsonObjectT, PolicyInputT } from "@keel/shared";
import { isInside } from "./path-util.js";
import { exactOneLineReviewText, extractExplicitEgressTarget } from "./egress-review.js";
import type { PolicyDecision } from "./policy.js";
import type { SandboxProfile } from "./sandbox.js";

export const COMMAND_SESSION_GRANT_RULE = "COMMAND-GRANT-SESSION";
export const COMMAND_PROJECT_GRANT_RULE = "COMMAND-GRANT-PROJECT";

export interface CommandReviewGrantContext {
  readonly workspaceRoot: string;
  readonly policyPack: {
    readonly name: string;
    readonly hash: string;
  };
}

export interface CommandReviewGrantCommand {
  readonly command: string;
  readonly sandboxToolName: string;
  readonly typedTool?: unknown;
  readonly lifecycle?: unknown;
  readonly mcp?: unknown;
}

function sha256Json(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function stableStringArray(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

function stableTargets(policyInput: PolicyInputT): JsonObjectT[] {
  const targets: JsonObjectT[] = policyInput.sideEffect.dynamic.targets.map((target) => ({
    kind: target.kind,
    value: target.value,
    normalized: target.normalized ?? null,
    withinWorkspace: target.withinWorkspace ?? null,
    sensitivity: target.sensitivity ?? null,
  }));
  return targets.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function commandFamily(policyInput: PolicyInputT): string {
  const commandTarget = policyInput.sideEffect.dynamic.targets.find(
    (target) => target.kind === "command",
  );
  const command = commandTarget?.normalized ?? commandTarget?.value ?? "unknown";
  return command.trim().split(/\s+/u)[0] || "unknown";
}

function rootContainedForCommandGrant(context: CommandReviewGrantContext, root: string): boolean {
  const systemTmp = tmpdir();
  const systemTmpAliases = [systemTmp, `/private${systemTmp}`];
  return (
    isInside(context.workspaceRoot, root) ||
    systemTmpAliases.some((alias) => isInside(alias, root)) ||
    isInside("/tmp", root) ||
    isInside("/private/tmp", root)
  );
}

function sandboxProfileForCommandGrant(
  context: CommandReviewGrantContext,
  profile: SandboxProfile,
): JsonObjectT {
  return {
    filesystem: {
      allowRead: stableStringArray(profile.filesystem?.allowRead),
      allowWrite: stableStringArray(profile.filesystem?.allowWrite),
      denyRead: stableStringArray(profile.filesystem?.denyRead),
      denyWrite: stableStringArray(profile.filesystem?.denyWrite),
    },
    network: {
      allowedDomains: stableStringArray(profile.network?.allowedDomains),
      deniedDomains: stableStringArray(profile.network?.deniedDomains),
      strictAllowlist: profile.network?.strictAllowlist ?? false,
    },
    containedReadRoots: stableStringArray(profile.filesystem?.allowRead).every((root) =>
      rootContainedForCommandGrant(context, root),
    ),
    containedWriteRoots: stableStringArray(profile.filesystem?.allowWrite).every((root) =>
      rootContainedForCommandGrant(context, root),
    ),
  };
}

function sandboxProfileIsCommandGrantContained(
  context: CommandReviewGrantContext,
  profile: SandboxProfile,
): boolean {
  const network = profile.network;
  if (network?.strictAllowlist !== true) return false;
  if ((network.allowedDomains ?? []).length !== 0) return false;
  if (!(network.deniedDomains ?? []).includes("*")) return false;
  const allowRead = profile.filesystem?.allowRead ?? [];
  if (allowRead.length === 0) return false;
  if (!allowRead.every((root) => rootContainedForCommandGrant(context, root))) return false;
  const allowWrite = profile.filesystem?.allowWrite ?? [];
  if (allowWrite.length === 0) return false;
  return allowWrite.every((root) => rootContainedForCommandGrant(context, root));
}

function commandReviewGrantKey(
  context: CommandReviewGrantContext,
  command: string,
  policyInput: PolicyInputT,
  decision: PolicyDecision,
  profile: SandboxProfile,
): `sha256:${string}` {
  return sha256Json({
    version: 1,
    kind: "session-command",
    workspaceRoot: context.workspaceRoot,
    toolName: policyInput.tool.name,
    commandFamily: commandFamily(policyInput),
    commandHash: sha256Json(command),
    effectEnvelope: {
      effectKinds: stableStringArray(policyInput.sideEffect.dynamic.effectKinds),
      scopes: stableStringArray(policyInput.sideEffect.dynamic.scopes),
      modifiers: stableStringArray(policyInput.sideEffect.dynamic.modifiers),
      targets: stableTargets(policyInput),
    },
    sandboxProfile: sandboxProfileForCommandGrant(context, profile),
    policyPack: context.policyPack,
    matchedRules: stableStringArray(decision.matchedRules),
  });
}

function exactStringSet(values: readonly string[], expected: readonly string[]): boolean {
  const actual = stableStringArray(values);
  const wanted = stableStringArray(expected);
  return actual.length === wanted.length && actual.every((value, index) => value === wanted[index]);
}

function atomicDeleteArgvIsOnceReviewable(argv: readonly string[]): boolean {
  if (argv[0] !== "rm" || argv.length < 2) return false;
  let targetCount = 0;
  let optionsEnded = false;
  for (const arg of argv.slice(1)) {
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg !== "-" && arg.startsWith("-")) {
      if (arg !== "--force" && !/^-f+$/u.test(arg)) return false;
      continue;
    }
    targetCount += 1;
  }
  return targetCount === 1;
}

/** A deliberately narrower review path than a command grant. It authorizes only the currently
 * pending, exact, non-recursive workspace deletion and never creates reusable authority. */
export function onceReviewableWorkspaceDelete(
  context: CommandReviewGrantContext,
  command: CommandReviewGrantCommand,
  policyInput: PolicyInputT,
  decision: PolicyDecision,
  profile: SandboxProfile | undefined,
): { readonly key: `sha256:${string}` } | undefined {
  if (decision.verdict !== "review") return undefined;
  if (
    command.mcp !== undefined ||
    command.lifecycle !== undefined ||
    command.typedTool !== undefined ||
    command.sandboxToolName !== "bash"
  ) {
    return undefined;
  }
  if (profile === undefined || !sandboxProfileIsCommandGrantContained(context, profile)) {
    return undefined;
  }
  // The normalized argv projection cannot by itself prove the raw shell statement is the same
  // lexical shape the operator reviewed: quoting, escapes, expansion, globs, comments, redirection,
  // and control operators can all change token count or target identity at execution. This
  // deliberately narrow path accepts only plain, literal argv spelling.
  if (/[\r\n\t'"\\;&|<>$`(){}[\]*?!~#]/u.test(command.command)) return undefined;
  if (exactOneLineReviewText(command.command) === undefined) return undefined;
  if (extractExplicitEgressTarget(command.command).kind !== "none") return undefined;
  if (!atomicDeleteArgvIsOnceReviewable(policyInput.normalized.argv)) return undefined;

  const dynamic = policyInput.sideEffect.dynamic;
  if (
    !exactStringSet(dynamic.effectKinds, ["fs_write"]) ||
    !exactStringSet(dynamic.scopes, ["workspace"]) ||
    !exactStringSet(dynamic.modifiers, ["destructive"]) ||
    dynamic.composition.kind !== "atomic" ||
    dynamic.composition.segments.length === 0
  ) {
    return undefined;
  }
  const segmentsAreExactWorkspaceDeletes = dynamic.composition.segments.every(
    (entry) =>
      exactStringSet(entry.effectKinds, ["fs_write"]) &&
      exactStringSet(entry.scopes, ["workspace"]) &&
      exactStringSet(entry.modifiers, ["destructive"]) &&
      entry.targets.length > 0 &&
      entry.targets.every(
        (target) =>
          target.kind === "path" &&
          target.withinWorkspace === true &&
          target.sensitivity !== "secret" &&
          target.sensitivity !== "unknown",
      ),
  );
  if (!segmentsAreExactWorkspaceDeletes) return undefined;
  if (
    dynamic.targets.length === 0 ||
    !dynamic.targets.every(
      (target) =>
        target.kind === "path" &&
        target.withinWorkspace === true &&
        target.sensitivity !== "secret" &&
        target.sensitivity !== "unknown",
    )
  ) {
    return undefined;
  }
  return { key: commandReviewGrantKey(context, command.command, policyInput, decision, profile) };
}

export function grantableCommandReview(
  context: CommandReviewGrantContext,
  command: CommandReviewGrantCommand,
  policyInput: PolicyInputT,
  decision: PolicyDecision,
  profile: SandboxProfile | undefined,
): { readonly key: `sha256:${string}` } | undefined {
  if (decision.verdict !== "review") return undefined;
  if (
    command.mcp !== undefined ||
    command.lifecycle !== undefined ||
    command.typedTool !== undefined
  ) {
    return undefined;
  }
  if (command.sandboxToolName !== "bash") return undefined;
  if (profile === undefined || !sandboxProfileIsCommandGrantContained(context, profile)) {
    return undefined;
  }
  if (extractExplicitEgressTarget(command.command).kind !== "none") return undefined;
  const dynamic = policyInput.sideEffect.dynamic;
  if (
    dynamic.effectKinds.some((kind) => kind === "unknown" || kind === "process_exec") ||
    dynamic.scopes.includes("unknown") ||
    dynamic.modifiers.includes("unknown")
  ) {
    return undefined;
  }
  if (
    dynamic.effectKinds.some((kind) => kind === "network_read" || kind === "network_write") ||
    dynamic.scopes.some(
      (scope) => scope === "external_service" || scope === "home" || scope === "system",
    ) ||
    dynamic.modifiers.some(
      (modifier) =>
        modifier === "destructive" || modifier === "irreversible" || modifier === "persistent",
    )
  ) {
    return undefined;
  }
  for (const target of dynamic.targets) {
    if (
      target.kind === "unknown" ||
      target.kind === "host" ||
      target.kind === "url" ||
      target.kind === "env_var"
    ) {
      return undefined;
    }
    if (target.sensitivity === "secret" || target.sensitivity === "unknown") return undefined;
    if (
      target.kind === "command" &&
      (target.normalized ?? target.value).startsWith("unsupported-shell-syntax:")
    ) {
      return undefined;
    }
    if (
      target.kind === "path" &&
      target.withinWorkspace !== true &&
      !rootContainedForCommandGrant(context, target.normalized ?? target.value)
    ) {
      return undefined;
    }
  }
  return { key: commandReviewGrantKey(context, command.command, policyInput, decision, profile) };
}
