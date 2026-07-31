import { resolve } from "node:path";
import type { PolicyInputT, SideEffectT } from "@keel/shared";

const PACKAGE_MANAGER_METADATA_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
  ".pnpmfile.cjs",
  "pnpm-workspace.yaml",
  ".yarnrc",
  ".yarnrc.yml",
  "bunfig.toml",
] as const;

const VCS_SANDBOX_DENY_PATHS = [".git/config", ".git/config.worktree", ".git/hooks"] as const;

export interface ExecutionMetadataState {
  readonly invalidatedSessions: Set<string>;
}

export function createExecutionMetadataState(): ExecutionMetadataState {
  return { invalidatedSessions: new Set<string>() };
}

export function packageManagerExecutionMetadataPaths(workspaceRoot: string): string[] {
  return PACKAGE_MANAGER_METADATA_FILES.map((path) => resolve(workspaceRoot, path));
}

export function vcsExecutionMetadataPaths(workspaceRoot: string): string[] {
  return VCS_SANDBOX_DENY_PATHS.map((path) => resolve(workspaceRoot, path));
}

function sideEffectWritesWorkspace(sideEffect: SideEffectT): boolean {
  return sideEffect.dynamic.composition.segments.some(
    (segment) =>
      segment.effectKinds.includes("fs_write") &&
      segment.targets.some((target) => target.kind === "path" && target.withinWorkspace === true),
  );
}

export function invalidateExecutionMetadataForPotentialWrite(
  state: ExecutionMetadataState,
  sessionId: string,
  policyInput: PolicyInputT,
): void {
  // Package scripts, test discovery, tool configs, attributes, and plugin loading can turn an
  // otherwise ordinary workspace file into executable input. Enumerating those paths would leave
  // the review boundary dependent on every supported toolchain, so any governed workspace write
  // conservatively invalidates known-safe package/VCS command classification for this session.
  if (sideEffectWritesWorkspace(policyInput.sideEffect)) {
    state.invalidatedSessions.add(sessionId);
  }
}

export function executionMetadataTrusted(
  state: ExecutionMetadataState,
  sessionId: string,
): boolean {
  return !state.invalidatedSessions.has(sessionId);
}
