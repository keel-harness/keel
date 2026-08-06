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
  readonly mutationGenerations: Map<string, number>;
  readonly poisonedSessions: Set<string>;
}

export function createExecutionMetadataState(): ExecutionMetadataState {
  return {
    invalidatedSessions: new Set<string>(),
    mutationGenerations: new Map<string, number>(),
    poisonedSessions: new Set<string>(),
  };
}

export interface ExecutionMetadataGeneration {
  readonly generation: number;
  readonly poisoned: boolean;
}

export function executionMetadataGeneration(
  state: ExecutionMetadataState,
  sessionId: string,
): ExecutionMetadataGeneration {
  const generation = state.mutationGenerations.get(sessionId) ?? 0;
  const poisoned = state.poisonedSessions.has(sessionId);
  if (
    poisoned ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    generation >= Number.MAX_SAFE_INTEGER
  ) {
    state.mutationGenerations.set(sessionId, Number.MAX_SAFE_INTEGER);
    state.poisonedSessions.add(sessionId);
    state.invalidatedSessions.add(sessionId);
    return { generation: Number.MAX_SAFE_INTEGER, poisoned: true };
  }
  return {
    generation,
    poisoned: false,
  };
}

function advanceExecutionMetadataGeneration(
  state: ExecutionMetadataState,
  sessionId: string,
): void {
  const currentState = executionMetadataGeneration(state, sessionId);
  if (currentState.poisoned) return;
  if (currentState.generation >= Number.MAX_SAFE_INTEGER - 1) {
    state.mutationGenerations.set(sessionId, Number.MAX_SAFE_INTEGER);
    state.poisonedSessions.add(sessionId);
    state.invalidatedSessions.add(sessionId);
    return;
  }
  state.mutationGenerations.set(sessionId, currentState.generation + 1);
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
  // Every admitted execution attempt can make a concurrently displayed process review stale, even
  // when the classifier describes the attempt as read-only. Advance before the write predicate while
  // preserving the existing rule that only a classified workspace write revokes metadata trust.
  advanceExecutionMetadataGeneration(state, sessionId);
  // Package scripts, test discovery, tool configs, attributes, and plugin loading can turn an
  // otherwise ordinary workspace file into executable input. Enumerating those paths would leave
  // the review boundary dependent on every supported toolchain, so any governed workspace write
  // conservatively invalidates known-safe package/VCS command classification for this session.
  if (sideEffectWritesWorkspace(policyInput.sideEffect)) {
    state.invalidatedSessions.add(sessionId);
  }
}

/** An exact reviewed process can execute repository-controlled helpers whose writes are not visible
 * in the request classifier. Admission therefore invalidates unconditionally before durable intent,
 * staling every sibling review in the same session even for a read-only-looking argv. */
export function invalidateExecutionMetadataForReviewedProcess(
  state: ExecutionMetadataState,
  sessionId: string,
): void {
  state.invalidatedSessions.add(sessionId);
  advanceExecutionMetadataGeneration(state, sessionId);
}

export function executionMetadataTrusted(
  state: ExecutionMetadataState,
  sessionId: string,
): boolean {
  return (
    !state.invalidatedSessions.has(sessionId) &&
    !executionMetadataGeneration(state, sessionId).poisoned
  );
}
