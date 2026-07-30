import type { JsonObjectT } from "@keel/shared";

export const DEFAULT_CONSOLE_MAX_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_CONSOLE_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_CONSOLE_MAX_KEY_TOKENS = 512;
export const DEFAULT_CONSOLE_MAX_SCREEN_FRAMES = 128;
export const DEFAULT_CONSOLE_MAX_SCREEN_BYTES = 1024 * 1024;

export interface ConsoleLifecycleProfile {
  readonly maxTtlMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxKeyTokens?: number;
  readonly maxScreenFrames?: number;
  readonly maxScreenBytes?: number;
}

export interface ConsoleLifecycleLimits {
  readonly maxTtlMs: number;
  readonly idleTimeoutMs: number;
  readonly maxKeyTokens: number;
  readonly maxScreenFrames: number;
  readonly maxScreenBytes: number;
}

export interface ConsoleLifecycleState {
  readonly openedAtMs: number;
  lastActivityAtMs: number;
  keyTokensUsed: number;
  screenFramesRead: number;
  screenBytesRead: number;
  readonly limits: ConsoleLifecycleLimits;
  readonly processIdentity: JsonObjectT;
}

function nonnegativeIntegerIssue(name: string, value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && value >= 0
    ? undefined
    : `${name} must be a nonnegative safe integer`;
}

export function consoleLifecycleProfileIssue(profile: ConsoleLifecycleProfile): string | undefined {
  return (
    nonnegativeIntegerIssue("maxTtlMs", profile.maxTtlMs) ??
    nonnegativeIntegerIssue("idleTimeoutMs", profile.idleTimeoutMs) ??
    nonnegativeIntegerIssue("maxKeyTokens", profile.maxKeyTokens) ??
    nonnegativeIntegerIssue("maxScreenFrames", profile.maxScreenFrames) ??
    nonnegativeIntegerIssue("maxScreenBytes", profile.maxScreenBytes)
  );
}

export function effectiveConsoleLifecycleLimits(
  profile: ConsoleLifecycleProfile,
): ConsoleLifecycleLimits {
  const issue = consoleLifecycleProfileIssue(profile);
  if (issue !== undefined) throw new Error(issue);
  return {
    maxTtlMs: profile.maxTtlMs ?? DEFAULT_CONSOLE_MAX_TTL_MS,
    idleTimeoutMs: profile.idleTimeoutMs ?? DEFAULT_CONSOLE_IDLE_TIMEOUT_MS,
    maxKeyTokens: profile.maxKeyTokens ?? DEFAULT_CONSOLE_MAX_KEY_TOKENS,
    maxScreenFrames: profile.maxScreenFrames ?? DEFAULT_CONSOLE_MAX_SCREEN_FRAMES,
    maxScreenBytes: profile.maxScreenBytes ?? DEFAULT_CONSOLE_MAX_SCREEN_BYTES,
  };
}

export function createConsoleLifecycleState(options: {
  readonly profile: ConsoleLifecycleProfile;
  readonly nowMs: number;
  readonly processIdentity: JsonObjectT;
}): ConsoleLifecycleState {
  return {
    openedAtMs: options.nowMs,
    lastActivityAtMs: options.nowMs,
    keyTokensUsed: 0,
    screenFramesRead: 0,
    screenBytesRead: 0,
    limits: effectiveConsoleLifecycleLimits(options.profile),
    processIdentity: options.processIdentity,
  };
}
