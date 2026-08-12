import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { JsonObject, type JsonObjectT } from "@keel/shared";
import type {
  ConsoleBrokerCloseResult,
  ConsoleBrokerHandleRequest,
  ConsoleBrokerOpenRequest,
  ConsoleBrokerOpenResult,
  ConsoleBrokerPort,
  ConsoleBrokerProcessIdentityCheckResult,
  ConsoleBrokerReleaseResult,
  ConsoleBrokerSendKeysResult,
} from "./broker.js";
import type { ConsoleScreenFrameT } from "./result.js";
import type { ConsoleSandboxPlan } from "./sandbox.js";
import type { ConsoleOperation, ConsoleSpecialKeyT } from "./schema.js";
import type {
  SandboxExecutionResult,
  SandboxExecuteOptions,
  SandboxInvocation,
  SandboxProfile,
  SandboxSpawnDescriptor,
  SandboxStatus,
} from "../sandbox.js";

export const SYSTEM_TMUX_CONSOLE_BROKER_KIND = "system-tmux-private-socket:v1";

const DEFAULT_TMUX_TIMEOUT_MS = 10_000;
const DEFAULT_TMUX_KILL_GRACE_MS = 100;
const DEFAULT_TMUX_PROCESS_SETTLEMENT_TIMEOUT_MS = 2_000;
const DEFAULT_TMUX_PROCESS_POLL_MS = 10;
const MAX_TMUX_OUTPUT_BYTES = 1_048_576;
const MAX_DIRECT_TMUX_DESCRIPTOR_ARGV_BYTES = 16_384;
const TARGET_ENV_EXECUTABLE = "/usr/bin/env";
const TMUX_PANE_IDENTITY_SEPARATOR = "|";
const TMUX_PANE_IDENTITY_FORMAT = [
  "#{session_id}",
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_dead}",
].join(TMUX_PANE_IDENTITY_SEPARATOR);
const BROKER_ENV_ALLOWLIST = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
]);
const TARGET_ENV_ALLOWLIST = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SANDBOX_RUNTIME",
  "SHELL",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
]);

function throwableError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value), { cause: value });
}

export interface TmuxCommandRequest {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type TmuxCommandResult = SandboxExecutionResult;

export interface TmuxCommandRunner {
  run(request: TmuxCommandRequest): Promise<TmuxCommandResult>;
}

export interface SystemTmuxConsoleBrokerStatus {
  readonly available: boolean;
  readonly backend: typeof SYSTEM_TMUX_CONSOLE_BROKER_KIND;
  readonly tmuxPath?: string;
  readonly tmuxVersion?: string;
  readonly reason?: string;
  readonly fixCommand?: string;
}

export interface ConsoleSandboxLaunchPreparer {
  status(): SandboxStatus;
  prepareLaunch(
    invocation: SandboxInvocation,
    profile: SandboxProfile,
    executeOptions?: Pick<SandboxExecuteOptions, "signal">,
  ): Promise<{
    readonly descriptor: SandboxSpawnDescriptor;
    revoke(): void | Promise<void>;
    release(): void | Promise<void>;
    cleanup(): void | Promise<void>;
  }>;
}

export interface SystemTmuxConsoleBrokerOptions {
  readonly tmuxPath: string;
  readonly tmuxVersion: string;
  readonly tmuxStatus?: SystemTmuxConsoleBrokerStatus;
  readonly launchPreparer: ConsoleSandboxLaunchPreparer;
  readonly runner?: TmuxCommandRunner;
  readonly privateRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly processGroupController?: TmuxProcessGroupController;
}

export interface TmuxProcessGroupController {
  isAlive(processGroupId: number): boolean;
  signal(processGroupId: number, signal: NodeJS.Signals): void;
  wait(milliseconds: number): Promise<void>;
  nowMs(): number;
}

export interface ProbeSystemTmuxConsoleBrokerOptions {
  readonly tmuxPath?: string;
  readonly runner?: TmuxCommandRunner;
  readonly env?: NodeJS.ProcessEnv;
}

interface TmuxHandleState {
  readonly sessionName: string;
  readonly sessionId: string;
  readonly paneId: string;
  readonly panePid: number;
  readonly processIdentity: JsonObjectT;
  processSettled: boolean;
  revoke(): void | Promise<void>;
  release(): void | Promise<void>;
  cleanup(): void | Promise<void>;
}

interface PendingTmuxSettlement {
  readonly sessionName: string;
  panePid?: number;
  revokeSettled: boolean;
  cleanupSettled: boolean;
  processSettled: boolean;
  revoke(): void | Promise<void>;
  cleanup(): void | Promise<void>;
}

export function createNodeTmuxProcessGroupController(
  options: {
    readonly killProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
    readonly wait?: (milliseconds: number) => Promise<void>;
    readonly nowMs?: () => number;
  } = {},
): TmuxProcessGroupController {
  const killProcess =
    options.killProcess ??
    ((pid: number, signal: NodeJS.Signals | 0): void => {
      process.kill(pid, signal);
    });
  return {
    isAlive(processGroupId) {
      try {
        killProcess(-processGroupId, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    },
    signal(processGroupId, signal) {
      try {
        killProcess(-processGroupId, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    },
    wait:
      options.wait ??
      (async (milliseconds) => {
        await sleep(milliseconds);
      }),
    nowMs: options.nowMs ?? (() => Date.now()),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function brokerEnv(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (name === "TMUX") continue;
    if (BROKER_ENV_ALLOWLIST.has(name) || name.startsWith("LC_")) env[name] = value;
  }
  env["TERM"] = env["TERM"] ?? "xterm-256color";
  return env;
}

function targetEnvAssignments(input: NodeJS.ProcessEnv): string[] {
  const assignments: string[] = [];
  for (const [name, value] of Object.entries(input).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (value === undefined) continue;
    if (name === "TMUX") continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) continue;
    if (value.includes("\u0000")) continue;
    if (!TARGET_ENV_ALLOWLIST.has(name) && !name.startsWith("LC_")) continue;
    assignments.push(`${name}=${value}`);
  }
  return assignments;
}

function appendUnique(existing: readonly string[] | undefined, value: string): readonly string[] {
  return existing?.includes(value) === true ? existing : [...(existing ?? []), value];
}

export function prepareSystemTmuxConsoleSandboxPlan(
  plan: ConsoleSandboxPlan,
  privateRoot: string,
): ConsoleSandboxPlan {
  return {
    ...plan,
    profile: {
      ...plan.profile,
      filesystem: {
        ...plan.profile.filesystem,
        denyRead: appendUnique(plan.profile.filesystem?.denyRead, privateRoot),
        denyWrite: appendUnique(plan.profile.filesystem?.denyWrite, privateRoot),
      },
    },
  };
}

function sandboxPlanDeniesBrokerRoot(plan: ConsoleSandboxPlan, privateRoot: string): boolean {
  return (
    plan.profile.filesystem?.denyRead?.includes(privateRoot) === true &&
    plan.profile.filesystem?.denyWrite?.includes(privateRoot) === true
  );
}

function ensurePrivateRoot(path: string): void {
  mkdirSync(path, { recursive: true });
  chmodSync(path, 0o700);
}

function writeTmuxConfig(path: string): void {
  writeFileSync(
    path,
    [
      "set -g status off",
      "set -g history-limit 2000",
      'set -g update-environment ""',
      "set -g set-clipboard off",
      "set -g allow-rename off",
      "set -g remain-on-exit off",
      "set -g exit-empty on",
      'set -g default-terminal "tmux-256color"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

const TMUX_COMMAND_NAMES = new Set([
  "capture-pane",
  "display-message",
  "kill-server",
  "kill-session",
  "new-session",
  "send-keys",
]);

function tmuxCommandLabel(argv: readonly string[]): string {
  return argv.find((arg) => TMUX_COMMAND_NAMES.has(arg)) ?? "tmux";
}

function replaceAllLiteral(value: string, needle: string, replacement: string): string {
  if (needle.length === 0) return value;
  return value.split(needle).join(replacement);
}

function tmuxPrivatePaths(argv: readonly string[]): string[] {
  const paths = new Set<string>();
  for (let index = 0; index < argv.length - 1; index += 1) {
    const arg = argv[index];
    if (arg !== "-S" && arg !== "-f") continue;
    const path = argv[index + 1];
    if (path === undefined) continue;
    paths.add(path);
    paths.add(dirname(path));
  }
  return [...paths].sort((left, right) => right.length - left.length);
}

function redactTmuxPrivatePaths(value: string, argv: readonly string[]): string {
  let redacted = value;
  for (const path of tmuxPrivatePaths(argv)) {
    redacted = replaceAllLiteral(redacted, path, "[redacted:tmux-private-path]");
  }
  return redacted;
}

function shellQuoteArg(value: string): string {
  if (value === "") return "''";
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function argvByteLength(argv: readonly string[]): number {
  return argv.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0);
}

function launcherPathFor(privateRoot: string, handle: string, argv: readonly string[]): string {
  return join(
    privateRoot,
    `launch-${sha256(`${handle}\u0000${argv.join("\u0000")}`).slice(0, 24)}.sh`,
  );
}

function writePrivateLauncher(
  privateRoot: string,
  handle: string,
  argv: readonly string[],
): string {
  const path = launcherPathFor(privateRoot, handle, argv);
  writeFileSync(path, `#!/bin/sh\nexec ${argv.map(shellQuoteArg).join(" ")}\n`, {
    mode: 0o700,
  });
  chmodSync(path, 0o700);
  return path;
}

function targetArgvForTmux(options: {
  readonly privateRoot: string;
  readonly handle: string;
  readonly descriptor: SandboxSpawnDescriptor;
}): readonly string[] {
  const argv = [
    TARGET_ENV_EXECUTABLE,
    "-i",
    ...targetEnvAssignments(options.descriptor.env),
    ...options.descriptor.argv,
  ];
  if (argvByteLength(argv) <= MAX_DIRECT_TMUX_DESCRIPTOR_ARGV_BYTES) return argv;
  return ["/bin/sh", writePrivateLauncher(options.privateRoot, options.handle, argv)];
}

function commandError(argv: readonly string[], result: TmuxCommandResult): Error {
  const detail = (result.stderr || result.stdout || `exit ${String(result.exitCode)}`).trim();
  return new Error(
    `tmux command failed (${tmuxCommandLabel(argv)}): ${redactTmuxPrivatePaths(detail, argv)}`,
  );
}

function firstLine(value: string): string {
  return (
    value
      .split(/\r?\n/u)
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

function tmuxKeyName(key: ConsoleSpecialKeyT): string {
  switch (key) {
    case "Backspace":
      return "BSpace";
    case "Enter":
    case "Tab":
    case "Escape":
    case "C-c":
    case "C-d":
      return key;
  }
}

function safeSessionName(handle: string): string {
  return `keel_${sha256(handle).slice(0, 24)}`;
}

function parsePaneIdentity(output: string): {
  readonly sessionId: string;
  readonly paneId: string;
  readonly panePid: number;
  readonly paneDead: boolean;
} {
  const [sessionId, paneId, panePidRaw, paneDeadRaw] = firstLine(output).split(
    TMUX_PANE_IDENTITY_SEPARATOR,
  );
  const panePid = Number(panePidRaw);
  if (
    sessionId === undefined ||
    paneId === undefined ||
    !Number.isInteger(panePid) ||
    panePid <= 0
  ) {
    throw new Error("tmux did not return a valid session/pane identity");
  }
  return { sessionId, paneId, panePid, paneDead: paneDeadRaw === "1" };
}

function validateDirectExecDescriptor(descriptor: SandboxSpawnDescriptor): void {
  if (descriptor.argv.length < 2) {
    throw new Error(
      "interactive console launch descriptor must use tmux direct-exec mode with at least two argv elements",
    );
  }
  for (const arg of descriptor.argv) {
    if (arg.includes("\u0000")) {
      throw new Error("interactive console launch descriptor argv must not contain NUL bytes");
    }
  }
  const executable = descriptor.argv[0];
  if (
    executable === undefined ||
    executable === "" ||
    executable.startsWith("-") ||
    /^[A-Za-z_][A-Za-z0-9_]*=/u.test(executable)
  ) {
    throw new Error(
      "interactive console launch descriptor executable must be an explicit command path or name",
    );
  }
}

function tmuxPaneProcessIdentity(options: {
  readonly sessionName: string;
  readonly sessionId: string;
  readonly paneId: string;
  readonly panePid: number;
  readonly socketPath: string;
  readonly tmuxVersion: string;
}): JsonObjectT {
  return JsonObject.parse({
    kind: "tmux-pane",
    backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
    tmuxVersion: options.tmuxVersion,
    sessionName: options.sessionName,
    sessionId: options.sessionId,
    paneId: options.paneId,
    panePid: options.panePid,
    socketPathDigest: `sha256:${sha256(options.socketPath)}`,
  });
}

function identityFromHandle(handle: ConsoleBrokerHandleRequest<ConsoleOperation>):
  | {
      readonly sessionName: string;
      readonly paneId: string;
    }
  | undefined {
  const identity = handle.handle.processIdentity;
  const sessionName = identity["sessionName"];
  const paneId = identity["paneId"];
  return typeof sessionName === "string" && typeof paneId === "string"
    ? { sessionName, paneId }
    : undefined;
}

export function createNodeTmuxCommandRunner(): TmuxCommandRunner {
  return {
    run(request) {
      const command = request.argv[0];
      if (command === undefined) {
        return Promise.reject(new Error("tmux command argv must not be empty"));
      }
      const args = request.argv.slice(1);
      return new Promise<TmuxCommandResult>((resolve, reject) => {
        const child = spawn(command, args, {
          cwd: request.cwd,
          env: request.env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let killTimer: NodeJS.Timeout | undefined;
        const clearKillTimer = (): void => {
          if (killTimer === undefined) return;
          clearTimeout(killTimer);
          killTimer = undefined;
        };
        const signalChild = (signal: NodeJS.Signals): void => {
          child.kill(signal);
        };
        const scheduleKill = (): void => {
          if (killTimer !== undefined) return;
          killTimer = setTimeout(() => {
            signalChild("SIGKILL");
          }, DEFAULT_TMUX_KILL_GRACE_MS);
          killTimer.unref();
        };
        const terminateChild = (): void => {
          signalChild("SIGTERM");
          scheduleKill();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          terminateChild();
        }, request.timeoutMs ?? DEFAULT_TMUX_TIMEOUT_MS);
        timer.unref();
        const onAbort = (): void => {
          terminateChild();
        };
        request.signal?.addEventListener("abort", onAbort, { once: true });
        if (request.signal?.aborted === true) terminateChild();
        const append = (current: string, chunk: Buffer | string): string => {
          const next = current + chunk.toString();
          return Buffer.byteLength(next, "utf8") > MAX_TMUX_OUTPUT_BYTES
            ? next.slice(0, MAX_TMUX_OUTPUT_BYTES)
            : next;
        };
        child.stdout.on("data", (chunk: Buffer | string) => {
          stdout = append(stdout, chunk);
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderr = append(stderr, chunk);
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          clearKillTimer();
          request.signal?.removeEventListener("abort", onAbort);
          reject(error);
        });
        child.once("close", (exitCode, signal) => {
          clearTimeout(timer);
          clearKillTimer();
          request.signal?.removeEventListener("abort", onAbort);
          resolve({
            exitCode,
            signal,
            stdout,
            stderr: timedOut ? `${stderr}\ntmux command timed out`.trim() : stderr,
          });
        });
        if (request.stdin !== undefined) {
          child.stdin.end(request.stdin);
        } else {
          child.stdin.end();
        }
      });
    },
  };
}

export async function probeSystemTmuxConsoleBroker(
  options: ProbeSystemTmuxConsoleBrokerOptions = {},
): Promise<SystemTmuxConsoleBrokerStatus> {
  const tmuxPath = options.tmuxPath ?? "tmux";
  const runner = options.runner ?? createNodeTmuxCommandRunner();
  try {
    const result = await runner.run({
      argv: [tmuxPath, "-V"],
      env: brokerEnv(options.env),
      timeoutMs: DEFAULT_TMUX_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      return {
        available: false,
        backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
        reason: firstLine(result.stderr || result.stdout) || "tmux version probe failed",
        fixCommand: "keel doctor",
      };
    }
    return {
      available: true,
      backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
      tmuxPath,
      tmuxVersion: firstLine(result.stdout || result.stderr),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
      reason: message,
      fixCommand: "keel doctor",
    };
  }
}

export function createSystemTmuxConsoleBroker(
  options: SystemTmuxConsoleBrokerOptions,
): ConsoleBrokerPort & {
  prepareSandboxPlan(plan: ConsoleSandboxPlan): ConsoleSandboxPlan;
  dispose(): Promise<void>;
} {
  const runner = options.runner ?? createNodeTmuxCommandRunner();
  const privateRoot = options.privateRoot ?? mkdtempSync(join(tmpdir(), "keel-console-tmux-"));
  ensurePrivateRoot(privateRoot);
  const socketPath = join(privateRoot, "tmux.sock");
  const configPath = join(privateRoot, "tmux.conf");
  writeTmuxConfig(configPath);
  const env = brokerEnv(options.env);
  const handles = new Map<string, TmuxHandleState>();
  const pendingSettlements = new Map<string, PendingTmuxSettlement>();
  const releasedSessions = new Set<string>();
  const processGroups = options.processGroupController ?? createNodeTmuxProcessGroupController();
  let disposed = false;
  let opening = false;
  let privateServerSettled = false;
  const configuredTmuxStatus =
    options.tmuxStatus ??
    ({
      available: true,
      backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
      tmuxPath: options.tmuxPath,
      tmuxVersion: options.tmuxVersion,
    } satisfies SystemTmuxConsoleBrokerStatus);

  function currentStatus(): SystemTmuxConsoleBrokerStatus {
    if (!configuredTmuxStatus.available) {
      return {
        ...configuredTmuxStatus,
        fixCommand: configuredTmuxStatus.fixCommand ?? "keel doctor",
      };
    }
    const tmuxIdentity = {
      tmuxPath: configuredTmuxStatus.tmuxPath ?? options.tmuxPath,
      tmuxVersion: configuredTmuxStatus.tmuxVersion ?? options.tmuxVersion,
    };
    let launchStatus: SandboxStatus;
    try {
      launchStatus = options.launchPreparer.status();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
        ...tmuxIdentity,
        reason: `sandbox launch preparer status failed: ${message}`,
        fixCommand: "keel doctor",
      };
    }
    if (!launchStatus.available || !launchStatus.enforcementTier.startsWith("sandbox:")) {
      const reason =
        launchStatus.reason ??
        `${launchStatus.backend} reported ${launchStatus.enforcementTier} launch tier`;
      return {
        available: false,
        backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
        ...tmuxIdentity,
        reason: `sandbox launch preparer unavailable: ${reason}`,
        fixCommand: launchStatus.fixCommand ?? "keel doctor",
      };
    }
    return {
      available: true,
      backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
      ...tmuxIdentity,
    };
  }

  async function runTmux(
    args: readonly string[],
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<TmuxCommandResult> {
    const argv = [options.tmuxPath, "-S", socketPath, "-f", configPath, ...args];
    const result = await runner.run({
      argv,
      env,
      ...(cwd === undefined ? {} : { cwd }),
      timeoutMs: DEFAULT_TMUX_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.exitCode !== 0) throw commandError(argv, result);
    return result;
  }

  async function runTmuxStatus(
    args: readonly string[],
    signal?: AbortSignal,
    timeoutMs = DEFAULT_TMUX_TIMEOUT_MS,
  ): Promise<TmuxCommandResult> {
    return await runner.run({
      argv: [options.tmuxPath, "-S", socketPath, "-f", configPath, ...args],
      env,
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async function recoverPanePid(
    sessionName: string,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    try {
      const result = await runTmuxStatus(
        ["display-message", "-p", "-t", `=${sessionName}`, TMUX_PANE_IDENTITY_FORMAT],
        signal,
      );
      if (result.exitCode !== 0) return undefined;
      return parsePaneIdentity(result.stdout).panePid;
    } catch {
      return undefined;
    }
  }

  async function settleTmuxProcessGroup(
    sessionName: string,
    panePid: number | undefined,
    onProcessGroupResolved?: (processGroupId: number) => void,
  ): Promise<void> {
    const startedAt = processGroups.nowMs();
    const gracefulDeadline = startedAt + DEFAULT_TMUX_KILL_GRACE_MS;
    const absoluteDeadline = startedAt + DEFAULT_TMUX_PROCESS_SETTLEMENT_TIMEOUT_MS;
    const tmuxAbort = new AbortController();
    const tmuxAbortTimer = setTimeout(() => {
      tmuxAbort.abort();
    }, DEFAULT_TMUX_PROCESS_SETTLEMENT_TIMEOUT_MS);
    tmuxAbortTimer.unref();
    const processGroupId = panePid ?? (await recoverPanePid(sessionName, tmuxAbort.signal));
    if (processGroupId !== undefined) onProcessGroupResolved?.(processGroupId);
    if (processGroupId !== undefined && processGroups.isAlive(processGroupId)) {
      processGroups.signal(processGroupId, "SIGTERM");
    }

    // tmux destroys session metadata and sends its own hangup, but its success is not process-reap
    // proof: a pane group may ignore HUP/TERM and survive as an orphan. Never pass caller abort into
    // this terminal-cleanup sequence.
    const tmuxSettlement = runTmuxStatus(
      ["kill-session", "-t", `=${sessionName}`],
      tmuxAbort.signal,
    ).catch(() => undefined);
    void tmuxSettlement.finally(() => {
      clearTimeout(tmuxAbortTimer);
    });

    if (processGroupId === undefined) {
      tmuxAbort.abort();
      throw new Error("tmux pane process-group settlement was not confirmed");
    }
    while (processGroups.isAlive(processGroupId) && processGroups.nowMs() < gracefulDeadline) {
      await processGroups.wait(DEFAULT_TMUX_PROCESS_POLL_MS);
    }
    if (processGroups.isAlive(processGroupId)) {
      processGroups.signal(processGroupId, "SIGKILL");
    }
    while (processGroups.isAlive(processGroupId) && processGroups.nowMs() < absoluteDeadline) {
      await processGroups.wait(DEFAULT_TMUX_PROCESS_POLL_MS);
    }
    if (processGroups.isAlive(processGroupId)) {
      tmuxAbort.abort();
      throw new Error("tmux pane process-group settlement was not confirmed");
    }
    tmuxAbort.abort();
  }

  function stateForHandle(
    request: ConsoleBrokerHandleRequest<Exclude<ConsoleOperation, { readonly kind: "open" }>>,
  ): TmuxHandleState | undefined {
    return handles.get(request.handle.handle);
  }

  return {
    status: currentStatus,
    prepareSandboxPlan(plan) {
      return prepareSystemTmuxConsoleSandboxPlan(plan, privateRoot);
    },
    async open(request: ConsoleBrokerOpenRequest): Promise<ConsoleBrokerOpenResult> {
      if (disposed) throw new Error("interactive console broker is disposed");
      if (!sandboxPlanDeniesBrokerRoot(request.sandbox, privateRoot)) {
        throw new Error("interactive console sandbox plan does not deny broker private root");
      }
      const status = currentStatus();
      if (!status.available) {
        throw new Error(
          `interactive console broker unavailable: ${status.reason ?? "status unavailable"}`,
        );
      }
      const sessionName = safeSessionName(request.handle);
      if (pendingSettlements.has(sessionName)) {
        throw new Error("previous tmux session cleanup settlement was not confirmed");
      }
      if (opening || handles.size > 0 || pendingSettlements.size > 0) {
        throw new Error(
          "system tmux console supports one outstanding Warden-controlled session; close or release it before opening another",
        );
      }
      opening = true;
      try {
        const launch = await options.launchPreparer.prepareLaunch(
          request.sandbox.invocation,
          request.sandbox.profile,
          request.signal === undefined ? undefined : { signal: request.signal },
        );
        let attemptedStart = false;
        let panePid: number | undefined;
        try {
          validateDirectExecDescriptor(launch.descriptor);
          const targetArgv = targetArgvForTmux({
            privateRoot,
            handle: request.handle,
            descriptor: launch.descriptor,
          });
          attemptedStart = true;
          const result = await runTmux(
            [
              "new-session",
              "-d",
              "-P",
              "-F",
              TMUX_PANE_IDENTITY_FORMAT,
              "-s",
              sessionName,
              "-x",
              String(request.operation.args.cols),
              "-y",
              String(request.operation.args.rows),
              "-c",
              launch.descriptor.cwd ?? request.profile.cwd,
              "-E",
              ...targetArgv,
            ],
            launch.descriptor.cwd ?? request.profile.cwd,
            request.signal,
          );
          const identity = parsePaneIdentity(result.stdout);
          panePid = identity.panePid;
          if (identity.paneDead) throw new Error("tmux pane exited during open");
          if (!processGroups.isAlive(identity.panePid)) {
            throw new Error("tmux pane process group exited during open");
          }
          const processIdentity = tmuxPaneProcessIdentity({
            sessionName,
            sessionId: identity.sessionId,
            paneId: identity.paneId,
            panePid: identity.panePid,
            socketPath,
            tmuxVersion: options.tmuxVersion,
          });
          handles.set(request.handle, {
            sessionName,
            sessionId: identity.sessionId,
            paneId: identity.paneId,
            panePid: identity.panePid,
            processIdentity,
            processSettled: false,
            revoke: () => launch.revoke(),
            release: () => launch.release(),
            cleanup: () => launch.cleanup(),
          });
          return { processIdentity };
        } catch (error) {
          let revokeError: unknown;
          let cleanupError: unknown;
          let settlementError: unknown;
          try {
            await launch.revoke();
          } catch (failure) {
            revokeError = failure;
          }
          let processSettled = !attemptedStart;
          if (attemptedStart) {
            try {
              await settleTmuxProcessGroup(sessionName, panePid, (resolvedPanePid) => {
                panePid ??= resolvedPanePid;
              });
              processSettled = true;
            } catch (failure) {
              settlementError = failure;
            }
          }
          if (processSettled) {
            try {
              await launch.cleanup();
              revokeError = undefined;
            } catch (failure) {
              cleanupError = failure;
            }
          }
          if (
            revokeError !== undefined ||
            cleanupError !== undefined ||
            settlementError !== undefined
          ) {
            pendingSettlements.set(sessionName, {
              sessionName,
              ...(panePid === undefined ? {} : { panePid }),
              revokeSettled: revokeError === undefined,
              cleanupSettled: processSettled && cleanupError === undefined,
              processSettled,
              revoke: () => launch.revoke(),
              cleanup: () => launch.cleanup(),
            });
            const failures = [error, revokeError, cleanupError, settlementError]
              .filter((failure): failure is NonNullable<typeof failure> => failure !== undefined)
              .map(throwableError);
            const details = failures.map((failure) => failure.message).join("; ");
            throw new AggregateError(
              failures,
              `tmux open failed: ${details}; cleanup settlement was not confirmed`,
            );
          }
          throw error;
        }
      } finally {
        opening = false;
      }
    },
    async checkProcessIdentity(
      request: ConsoleBrokerHandleRequest<Exclude<ConsoleOperation, { readonly kind: "open" }>>,
    ): Promise<ConsoleBrokerProcessIdentityCheckResult> {
      const target = stateForHandle(request) ?? identityFromHandle(request);
      if (target === undefined) {
        return {
          live: false,
          observedProcessIdentity: JsonObject.parse({
            kind: "tmux-pane-missing",
            backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
          }),
        };
      }
      const result = await runTmuxStatus(
        ["display-message", "-p", "-t", target.paneId, TMUX_PANE_IDENTITY_FORMAT],
        request.signal,
        request.operation.kind === "close" &&
          request.operation.args.reason !== undefined &&
          request.operation.args.reason !== "user"
          ? DEFAULT_TMUX_PROCESS_SETTLEMENT_TIMEOUT_MS
          : DEFAULT_TMUX_TIMEOUT_MS,
      );
      if (result.exitCode !== 0) {
        return {
          live: false,
          observedProcessIdentity: JsonObject.parse({
            kind: "tmux-pane-missing",
            backend: SYSTEM_TMUX_CONSOLE_BROKER_KIND,
            paneId: target.paneId,
          }),
        };
      }
      const identity = parsePaneIdentity(result.stdout);
      const observedProcessIdentity = tmuxPaneProcessIdentity({
        sessionName: target.sessionName,
        sessionId: identity.sessionId,
        paneId: identity.paneId,
        panePid: identity.panePid,
        socketPath,
        tmuxVersion: options.tmuxVersion,
      });
      return {
        live: !identity.paneDead,
        observedProcessIdentity,
      };
    },
    async sendKeys(
      request: ConsoleBrokerHandleRequest<
        Extract<ConsoleOperation, { readonly kind: "send_keys" }>
      >,
    ): Promise<ConsoleBrokerSendKeysResult> {
      const state = stateForHandle(request);
      if (state === undefined) throw new Error("tmux handle is not open");
      let acceptedTokens = 0;
      for (const token of request.operation.args.input) {
        try {
          if (token.kind === "text") {
            await runTmux(
              ["send-keys", "-t", state.paneId, "-l", "--", token.text],
              undefined,
              request.signal,
            );
          } else {
            await runTmux(
              ["send-keys", "-t", state.paneId, tmuxKeyName(token.key)],
              undefined,
              request.signal,
            );
          }
        } catch (error) {
          if (error instanceof Error && acceptedTokens > 0) {
            Object.defineProperty(error, "acceptedTokens", {
              value: acceptedTokens,
              enumerable: true,
              configurable: true,
            });
          }
          throw error;
        }
        acceptedTokens += 1;
      }
      return { acceptedTokens };
    },
    async readScreen(
      request: ConsoleBrokerHandleRequest<
        Extract<ConsoleOperation, { readonly kind: "read_screen" }>
      >,
    ): Promise<ConsoleScreenFrameT> {
      const state = stateForHandle(request);
      if (state === undefined) throw new Error("tmux handle is not open");
      const result = await runTmux(
        ["capture-pane", "-p", "-t", state.paneId],
        undefined,
        request.signal,
      );
      return {
        handle: request.handle.handle,
        targetId: request.handle.targetId,
        seq: request.handle.nextSeq,
        screen: result.stdout,
      };
    },
    async release(
      request: ConsoleBrokerHandleRequest<Extract<ConsoleOperation, { readonly kind: "release" }>>,
    ): Promise<ConsoleBrokerReleaseResult> {
      const state = stateForHandle(request);
      if (state === undefined) return { released: false };
      await state.release();
      handles.delete(request.handle.handle);
      releasedSessions.add(state.sessionName);
      return { released: true };
    },
    async close(
      request: ConsoleBrokerHandleRequest<Extract<ConsoleOperation, { readonly kind: "close" }>>,
    ): Promise<ConsoleBrokerCloseResult> {
      const state = stateForHandle(request);
      if (state === undefined) return { closed: false };
      let revokeError: unknown;
      try {
        await state.revoke();
      } catch (error) {
        revokeError = error;
      }
      if (!state.processSettled) {
        await settleTmuxProcessGroup(state.sessionName, state.panePid);
        state.processSettled = true;
      }
      try {
        await state.cleanup();
        revokeError = undefined;
      } catch (error) {
        throw throwableError(error);
      }
      if (revokeError !== undefined) throw throwableError(revokeError);
      handles.delete(request.handle.handle);
      return { closed: true };
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      for (const [handle, state] of handles) {
        try {
          await state.revoke();
        } catch {
          // Full cleanup below retries revocation after process settlement.
        }
        if (!state.processSettled) {
          try {
            await settleTmuxProcessGroup(state.sessionName, state.panePid);
            state.processSettled = true;
          } catch {
            continue;
          }
        }
        try {
          await state.cleanup();
          handles.delete(handle);
        } catch {
          // Retain the state so cleanup can be retried after server settlement.
        }
      }
      for (const [sessionName, pending] of pendingSettlements) {
        if (!pending.revokeSettled) {
          try {
            await pending.revoke();
            pending.revokeSettled = true;
          } catch {
            // Full cleanup below retries revocation after process settlement.
          }
        }
        if (!pending.processSettled) {
          try {
            await settleTmuxProcessGroup(sessionName, pending.panePid, (resolvedPanePid) => {
              pending.panePid ??= resolvedPanePid;
            });
            pending.processSettled = true;
          } catch {
            continue;
          }
        }
        if (!pending.cleanupSettled) {
          try {
            await pending.cleanup();
            pending.revokeSettled = true;
            pending.cleanupSettled = true;
          } catch {
            // Retain the state for a subsequent disposal attempt.
          }
        }
        if (pending.cleanupSettled) pendingSettlements.delete(sessionName);
      }
      const processSettlementUnconfirmed =
        [...handles.values()].some((state) => !state.processSettled) ||
        [...pendingSettlements.values()].some((pending) => !pending.processSettled);
      if (processSettlementUnconfirmed) {
        throw new Error("tmux process settlement was not confirmed");
      }
      if (handles.size > 0 || pendingSettlements.size > 0) {
        throw new Error("tmux authority cleanup settlement was not confirmed");
      }
      if (releasedSessions.size > 0) {
        disposed = true;
        return;
      }
      if (!privateServerSettled) {
        let serverResult: TmuxCommandResult;
        try {
          serverResult = await runTmuxStatus(
            ["kill-server"],
            undefined,
            DEFAULT_TMUX_PROCESS_SETTLEMENT_TIMEOUT_MS,
          );
        } catch (error) {
          throw new Error("tmux process settlement was not confirmed", { cause: error });
        }
        if (serverResult.exitCode !== 0 && existsSync(socketPath)) {
          throw new Error("tmux process settlement was not confirmed", {
            cause: commandError(["kill-server"], serverResult),
          });
        }
        privateServerSettled = true;
      }
      rmSync(privateRoot, { recursive: true, force: true });
      disposed = true;
    },
  };
}
