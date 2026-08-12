import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import type {
  SandboxCredentialProxyConfig,
  SandboxExecuteOptions,
  SandboxExecutionResult,
  SandboxInvocation,
  SandboxPort,
  SandboxProcessRunner,
  SandboxProfile,
  SandboxSpawnDescriptor,
  SandboxStatus,
} from "./sandbox.js";
import { renderProcessRunArgv } from "./process-run.js";

interface SrtFilesystemConfig {
  allowRead?: string[];
  allowWrite?: string[];
  denyRead?: string[];
  denyWrite?: string[];
}

interface SrtNetworkConfig {
  allowedDomains?: string[];
  deniedDomains?: string[];
  strictAllowlist?: boolean;
}

interface SrtAuthorizationHeaderCredential {
  host: string;
  scheme: string;
  value: string;
}

interface SrtAuthorizationPlaceholderCredential {
  host: string;
  scheme: string;
  placeholder: string;
  value: string;
}

interface SrtCredentialsConfig {
  authorizationHeaders?: SrtAuthorizationHeaderCredential[];
  authorizationPlaceholders?: SrtAuthorizationPlaceholderCredential[];
  allowPlaintextInject?: boolean;
}

interface SrtRuntimeConfig {
  filesystem?: SrtFilesystemConfig;
  network?: SrtNetworkConfig;
  credentials?: SrtCredentialsConfig;
}

export interface SrtRuntimeAdapter {
  initialize?: () => Promise<void>;
  updateConfig?: (customConfig: SrtRuntimeConfig) => void;
  cleanupAfterCommand?: () => void;
  prepareLaunch?: (
    command: string,
    binShell: string | undefined,
    customConfig: SrtRuntimeConfig,
    abortSignal: AbortSignal | undefined,
  ) => Promise<{
    argv: string[];
    env: NodeJS.ProcessEnv;
    revoke(): void | Promise<void>;
    release(): void | Promise<void>;
    cleanup(): void | Promise<void>;
  }>;
  wrapWithSandboxArgv(
    command: string,
    binShell: string | undefined,
    customConfig: SrtRuntimeConfig,
    abortSignal: AbortSignal | undefined,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
}

const SANDBOX_ENV_ALLOWLIST = new Set([
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "SANDBOX_RUNTIME",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
]);

export interface SrtSandboxPortOptions {
  readonly runtime: SrtRuntimeAdapter;
  readonly runner?: SandboxProcessRunner;
  readonly status: SandboxStatus | (() => SandboxStatus);
  readonly binShell?: string;
}

export interface SrtSandboxLaunchPreparerOptions {
  readonly runtime: SrtRuntimeAdapter;
  readonly status: SandboxStatus | (() => SandboxStatus);
  readonly binShell?: string;
}

export interface SrtSandboxPreparedLaunch {
  readonly descriptor: SandboxSpawnDescriptor;
  revoke(): void | Promise<void>;
  release(): void | Promise<void>;
  cleanup(): void | Promise<void>;
}

export interface SrtSandboxLaunchPreparer {
  status(): SandboxStatus;
  prepareLaunch(
    invocation: SandboxInvocation,
    profile: SandboxProfile,
    executeOptions?: SandboxExecuteOptions,
  ): Promise<SrtSandboxPreparedLaunch>;
}

export interface NodeSandboxProcessRunnerOptions {
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly killGraceMs?: number;
  readonly processSettlementTimeoutMs?: number;
  readonly processGroupController?: {
    isAlive(processGroupId: number): boolean;
    wait(milliseconds: number): Promise<void>;
    nowMs(): number;
  };
  readonly platform?: NodeJS.Platform;
  // Per-stream cap on captured stdout/stderr (QC §5). The warden buffers the child's whole output
  // into a JS string (and the audit payload); an unbounded stream (`yes`, `cat /dev/zero`) would grow
  // it without limit and OOM the control plane. Beyond the cap we drain (discard) further output and
  // append a truncation marker, so warden memory stays bounded regardless of what the child emits.
  readonly maxOutputBytes?: number;
}

const DEFAULT_PROCESS_GROUP_KILL_GRACE_MS = 250;
const DEFAULT_PROCESS_GROUP_SETTLEMENT_TIMEOUT_MS = 2_000;
const DEFAULT_PROCESS_GROUP_POLL_MS = 10;
const DEFAULT_PROCESS_OUTPUT_DRAIN_MS = 100;

// 8 MiB per stream. Generous for any useful command output (the kernel truncates tool results far
// smaller before the model sees them) while bounding the warden's per-command buffer to ~16 MiB.
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function copyList(value: readonly string[] | undefined): string[] | undefined {
  return value === undefined ? undefined : [...value];
}

function sanitizeSandboxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SANDBOX_ENV_ALLOWLIST.has(name) || name.startsWith("LC_")) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

function profileToSrtConfig(profile: SandboxProfile): SrtRuntimeConfig {
  const config: SrtRuntimeConfig = {};
  if (profile.filesystem !== undefined) {
    const filesystem: SrtFilesystemConfig = {};
    const allowRead = copyList(profile.filesystem.allowRead);
    const allowWrite = copyList(profile.filesystem.allowWrite);
    const denyRead = copyList(profile.filesystem.denyRead);
    const denyWrite = copyList(profile.filesystem.denyWrite);
    if (allowRead !== undefined) filesystem.allowRead = allowRead;
    if (allowWrite !== undefined) filesystem.allowWrite = allowWrite;
    if (denyRead !== undefined) filesystem.denyRead = denyRead;
    if (denyWrite !== undefined) filesystem.denyWrite = denyWrite;
    config.filesystem = filesystem;
  }
  if (profile.network !== undefined) {
    const network: SrtNetworkConfig = {};
    const allowedDomains = copyList(profile.network.allowedDomains);
    const deniedDomains = copyList(profile.network.deniedDomains);
    if (allowedDomains !== undefined) network.allowedDomains = allowedDomains;
    if (deniedDomains !== undefined) network.deniedDomains = deniedDomains;
    if (profile.network.strictAllowlist !== undefined) {
      network.strictAllowlist = profile.network.strictAllowlist;
    }
    config.network = network;
  }
  return config;
}

function credentialProxyToSrtConfig(
  credentialProxy: SandboxCredentialProxyConfig | undefined,
): Pick<SrtRuntimeConfig, "credentials"> {
  const authorizationHeaders = credentialProxy?.authorizationHeaders;
  const authorizationPlaceholders = credentialProxy?.authorizationPlaceholders;
  if (
    (authorizationHeaders === undefined || authorizationHeaders.length === 0) &&
    (authorizationPlaceholders === undefined || authorizationPlaceholders.length === 0)
  ) {
    return {};
  }
  const allowPlaintextInject = credentialProxy?.allowPlaintextInject ?? false;
  return {
    credentials: {
      ...(authorizationHeaders === undefined || authorizationHeaders.length === 0
        ? {}
        : {
            authorizationHeaders: authorizationHeaders.map((credential) => ({
              host: credential.host,
              scheme: credential.scheme,
              value: credential.secret,
            })),
          }),
      ...(authorizationPlaceholders === undefined || authorizationPlaceholders.length === 0
        ? {}
        : {
            authorizationPlaceholders: authorizationPlaceholders.map((credential) => ({
              host: credential.host,
              scheme: credential.scheme,
              placeholder: credential.placeholder,
              value: credential.secret,
            })),
          }),
      allowPlaintextInject,
    },
  };
}

function sandboxEnvFor(
  wrappedEnv: NodeJS.ProcessEnv,
  credentialProxy: SandboxCredentialProxyConfig | undefined,
): NodeJS.ProcessEnv {
  return {
    ...sanitizeSandboxEnv(wrappedEnv),
    ...(credentialProxy?.sandboxEnv ?? {}),
  };
}

function sandboxSpawnDescriptor(
  invocation: SandboxInvocation,
  wrapped: { readonly argv: readonly string[]; readonly env: NodeJS.ProcessEnv },
  credentialProxy: SandboxCredentialProxyConfig | undefined,
): SandboxSpawnDescriptor {
  return invocation.cwd === undefined
    ? { argv: wrapped.argv, env: sandboxEnvFor(wrapped.env, credentialProxy) }
    : {
        argv: wrapped.argv,
        cwd: invocation.cwd,
        env: sandboxEnvFor(wrapped.env, credentialProxy),
      };
}

function sandboxCommandForInvocation(invocation: SandboxInvocation): string {
  const argv = invocation.argv;
  if (argv === undefined) return invocation.command;
  if (argv.length === 0) throw new Error("sandbox invocation argv must not be empty");
  const executable = argv[0];
  if (executable !== invocation.command) {
    throw new Error("sandbox invocation argv executable must match command");
  }
  for (const arg of argv) {
    if (arg.includes("\u0000")) {
      throw new Error("sandbox invocation argv must not contain NUL bytes");
    }
  }
  return renderProcessRunArgv(argv);
}

function canSignalProcessGroup(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

/** @internal Probe a POSIX process group without treating permission denial as absence. */
export function isProcessGroupAlive(
  processGroupId: number,
  probe: (pid: number, signal: 0) => boolean | void = (pid, signal) => process.kill(pid, signal),
): boolean {
  try {
    probe(-processGroupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // POSIX reserves ESRCH for absence. EPERM means the group may exist but the caller cannot
    // signal any member, so settlement must keep polling and eventually fail closed if it persists.
    if (code === "EPERM") return true;
    throw error;
  }
}

export function createNodeSandboxProcessRunner(
  options: NodeSandboxProcessRunnerOptions = {},
): SandboxProcessRunner {
  const killProcess =
    options.killProcess ??
    ((pid: number, signal: NodeJS.Signals): void => {
      process.kill(pid, signal);
    });
  const platform = options.platform ?? process.platform;
  const killGraceMs = options.killGraceMs ?? DEFAULT_PROCESS_GROUP_KILL_GRACE_MS;
  const processSettlementTimeoutMs =
    options.processSettlementTimeoutMs ?? DEFAULT_PROCESS_GROUP_SETTLEMENT_TIMEOUT_MS;
  const processGroups =
    options.processGroupController ??
    ({
      isAlive: isProcessGroupAlive,
      wait: async (milliseconds: number): Promise<void> => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, milliseconds);
        });
      },
      nowMs: () => Date.now(),
    } as const);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return {
    async run(descriptor, runOptions) {
      const command = descriptor.argv[0];
      if (command === undefined) {
        return Promise.reject(new Error("sandbox spawn descriptor argv must not be empty"));
      }
      const args = descriptor.argv.slice(1);
      let triggerSettlement: (() => void) | undefined;
      const settlementRequested = new Promise<void>((resolve) => {
        triggerSettlement = resolve;
      });
      let childPid: number | undefined;
      let childSpawned = false;
      let triggerSpawned: (() => void) | undefined;
      const childSpawnedPromise = new Promise<void>((resolve) => {
        triggerSpawned = resolve;
      });
      let signalSandboxProcess: ((signal: NodeJS.Signals) => void) | undefined;
      let processGroupSignalError: unknown;
      let settlementNeedsTermination = false;
      let closeOutputPipes: (() => void) | undefined;
      let outputClosed = false;
      let resolveOutputClosed: (() => void) | undefined;
      const outputClosedPromise = new Promise<void>((resolve) => {
        resolveOutputClosed = resolve;
      });
      let stdoutValue: (() => string) | undefined;
      let stderrValue: (() => string) | undefined;
      const childOutcome = new Promise<Pick<SandboxExecutionResult, "exitCode" | "signal">>(
        (resolve, reject) => {
          const spawnOptions: SpawnOptionsWithoutStdio = {
            detached: canSignalProcessGroup(platform),
            env: descriptor.env,
            shell: false,
          };
          if (descriptor.cwd !== undefined) spawnOptions.cwd = descriptor.cwd;
          const child = spawn(command, args, spawnOptions);
          childPid = child.pid;
          // Cap each captured stream so a flooding child cannot OOM the warden (QC §5). Once the cap is
          // reached we stop accumulating (the `data` handler still fires, draining the pipe so the child
          // isn't blocked) and append a one-time truncation marker.
          const makeSink = (): { push: (chunk: string) => void; value: () => string } => {
            let buf = "";
            let bytes = 0;
            let truncated = false;
            return {
              push(chunk: string): void {
                if (truncated) return;
                const chunkBytes = Buffer.byteLength(chunk, "utf8");
                if (bytes + chunkBytes <= maxOutputBytes) {
                  buf += chunk;
                  bytes += chunkBytes;
                  return;
                }
                buf += `\n[keel: output truncated — exceeded ${String(maxOutputBytes)} bytes]`;
                truncated = true;
              },
              value: () => buf,
            };
          };
          const stdoutSink = makeSink();
          const stderrSink = makeSink();
          stdoutValue = stdoutSink.value;
          stderrValue = stderrSink.value;
          closeOutputPipes = () => {
            child.stdout.destroy();
            child.stderr.destroy();
          };
          signalSandboxProcess = (signal: NodeJS.Signals): void => {
            if (canSignalProcessGroup(platform) && child.pid !== undefined) {
              try {
                killProcess(-child.pid, signal);
                return;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                  processGroupSignalError = error;
                }
                // Fall back to direct-child signaling below.
              }
            }
            child.kill(signal);
          };
          const onAbort = (): void => {
            settlementNeedsTermination = true;
            if (childSpawned) triggerSettlement?.();
          };
          if (runOptions?.signal?.aborted === true) {
            onAbort();
          } else {
            runOptions?.signal?.addEventListener("abort", onAbort, { once: true });
          }
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            stdoutSink.push(chunk);
          });
          child.stderr.on("data", (chunk: string) => {
            stderrSink.push(chunk);
          });
          const cleanup = (): void => {
            runOptions?.signal?.removeEventListener("abort", onAbort);
          };
          child.once("error", (error) => {
            cleanup();
            triggerSpawned?.();
            triggerSettlement?.();
            reject(error);
          });
          child.once("spawn", () => {
            childSpawned = true;
            triggerSpawned?.();
            if (settlementNeedsTermination) triggerSettlement?.();
          });
          child.once("exit", (exitCode, signal) => {
            cleanup();
            triggerSettlement?.();
            resolve({ exitCode, signal });
          });
          child.once("close", () => {
            outputClosed = true;
            resolveOutputClosed?.();
          });
        },
      );
      // Spawn errors can arrive before lifecycle revocation/settlement finishes. Attach a handler
      // immediately; the authoritative await below still observes and reports the rejection.
      void childOutcome.catch(() => undefined);

      await childSpawnedPromise;
      await settlementRequested;
      let revocationError: unknown;
      try {
        await runOptions?.beforeProcessGroupSettlement?.();
      } catch (error) {
        revocationError = error;
      }

      let settlementError: unknown;
      if (canSignalProcessGroup(platform) && childPid !== undefined) {
        try {
          const startedAt = processGroups.nowMs();
          const gracefulDeadline = startedAt + killGraceMs;
          const absoluteDeadline = startedAt + processSettlementTimeoutMs;
          signalSandboxProcess!("SIGTERM");
          while (processGroups.isAlive(childPid) && processGroups.nowMs() < gracefulDeadline) {
            await processGroups.wait(DEFAULT_PROCESS_GROUP_POLL_MS);
          }
          if (processGroups.isAlive(childPid)) signalSandboxProcess!("SIGKILL");
          while (processGroups.isAlive(childPid) && processGroups.nowMs() < absoluteDeadline) {
            await processGroups.wait(DEFAULT_PROCESS_GROUP_POLL_MS);
          }
          if (processGroups.isAlive(childPid)) {
            throw new Error("sandbox process-group settlement was not confirmed");
          }
          if (processGroupSignalError !== undefined) {
            throw processGroupSignalError instanceof Error
              ? processGroupSignalError
              : new Error("sandbox process-group signal failed");
          }
        } catch (error) {
          settlementError = error;
        }
      } else if (settlementNeedsTermination) {
        signalSandboxProcess!("SIGTERM");
      }
      if (settlementError === undefined) await runOptions?.onProcessGroupSettled?.();

      if (settlementError === undefined && !outputClosed) {
        let drainTimer: NodeJS.Timeout | undefined;
        await Promise.race([
          outputClosedPromise,
          new Promise<void>((resolve) => {
            drainTimer = setTimeout(resolve, DEFAULT_PROCESS_OUTPUT_DRAIN_MS);
            drainTimer.unref();
          }),
        ]);
        if (drainTimer !== undefined) clearTimeout(drainTimer);
        if (!outputClosed) closeOutputPipes?.();
      }

      if (settlementError !== undefined) {
        closeOutputPipes?.();
        throw new AggregateError(
          [revocationError, settlementError].filter(
            (failure): failure is NonNullable<typeof failure> => failure !== undefined,
          ),
          "sandbox lifecycle settlement failed",
        );
      }

      let outcome: Pick<SandboxExecutionResult, "exitCode" | "signal">;
      try {
        outcome = await childOutcome;
      } catch (error) {
        if (revocationError !== undefined || settlementError !== undefined) {
          throw new AggregateError(
            [error, revocationError, settlementError].filter(
              (failure): failure is NonNullable<typeof failure> => failure !== undefined,
            ),
            "sandbox spawn and lifecycle settlement failed",
          );
        }
        throw error;
      }
      if (revocationError !== undefined) {
        throw new AggregateError([revocationError], "sandbox lifecycle settlement failed");
      }
      return { ...outcome, stdout: stdoutValue!(), stderr: stderrValue!() };
    },
  };
}

export async function executePreparedSrtLaunch(
  launch: SrtSandboxPreparedLaunch,
  runner: SandboxProcessRunner,
  signal: AbortSignal | undefined,
): Promise<SandboxExecutionResult> {
  let lifecycleStarted = false;
  let authorityRevoked = false;
  let processGroupSettled = false;
  const beforeProcessGroupSettlement = async (): Promise<void> => {
    lifecycleStarted = true;
    await launch.revoke();
    authorityRevoked = true;
  };
  const onProcessGroupSettled = (): void => {
    processGroupSettled = true;
  };
  try {
    const result = await runner.run(launch.descriptor, {
      ...(signal === undefined ? {} : { signal }),
      beforeProcessGroupSettlement,
      onProcessGroupSettled,
    });
    // Custom runners are a trusted Warden test/integration seam. A runner that does not implement
    // the lifecycle callbacks retains the historic contract that resolution proves termination.
    if (!lifecycleStarted) {
      await beforeProcessGroupSettlement();
      processGroupSettled = true;
    }
    return result;
  } finally {
    if (!lifecycleStarted) {
      await beforeProcessGroupSettlement();
      processGroupSettled = true;
    }
    if (authorityRevoked && processGroupSettled) await launch.cleanup();
  }
}

export function createSrtSandboxLaunchPreparer(
  options: SrtSandboxLaunchPreparerOptions,
): SrtSandboxLaunchPreparer {
  const status = (): SandboxStatus =>
    typeof options.status === "function" ? options.status() : options.status;
  let initialized = false;

  return {
    status,
    async prepareLaunch(
      invocation: SandboxInvocation,
      profile: SandboxProfile,
      executeOptions?: SandboxExecuteOptions,
    ): Promise<SrtSandboxPreparedLaunch> {
      const currentStatus = status();
      if (!currentStatus.available) {
        throw new Error(currentStatus.reason ?? "sandbox backend unavailable");
      }
      if (options.runtime.prepareLaunch === undefined && !initialized) {
        await options.runtime.initialize?.();
        initialized = true;
      }
      const customConfig = {
        ...profileToSrtConfig(profile),
        ...credentialProxyToSrtConfig(executeOptions?.credentialProxy),
      };
      let wrapped: { argv: string[]; env: NodeJS.ProcessEnv };
      let revoke: () => void | Promise<void>;
      let release: () => void | Promise<void>;
      let cleanup: () => void | Promise<void>;
      const preparePerLaunch = options.runtime.prepareLaunch;
      const perLaunchAuthority = preparePerLaunch !== undefined;
      try {
        if (perLaunchAuthority) {
          const launch = await preparePerLaunch(
            sandboxCommandForInvocation(invocation),
            options.binShell,
            customConfig,
            executeOptions?.signal,
          );
          wrapped = launch;
          revoke = () => launch.revoke();
          release = () => launch.release();
          cleanup = () => launch.cleanup();
        } else {
          options.runtime.updateConfig?.(customConfig);
          wrapped = await options.runtime.wrapWithSandboxArgv(
            sandboxCommandForInvocation(invocation),
            options.binShell,
            customConfig,
            executeOptions?.signal,
          );
          revoke = () => {};
          release = () => options.runtime.cleanupAfterCommand?.();
          cleanup = () => options.runtime.cleanupAfterCommand?.();
        }
      } catch (error) {
        // The per-launch manager owns exact rollback for a preparation that never returned a
        // launch handle. Calling the legacy process-global cleanup hook here can decrement or
        // delete filesystem mount state belonging to a different, still-live launch.
        if (!perLaunchAuthority) options.runtime.cleanupAfterCommand?.();
        throw error;
      }
      let cleanupResult: void | Promise<void> | undefined;
      let cleanupStarted = false;
      let revokeResult: void | Promise<void> | undefined;
      let revokeStarted = false;
      let releaseResult: void | Promise<void> | undefined;
      let releaseStarted = false;
      return {
        descriptor: sandboxSpawnDescriptor(invocation, wrapped, executeOptions?.credentialProxy),
        revoke(): void | Promise<void> {
          if (revokeStarted) return revokeResult;
          revokeStarted = true;
          try {
            revokeResult = revoke();
          } catch (error) {
            revokeStarted = false;
            revokeResult = undefined;
            throw error;
          }
          if (revokeResult !== undefined) {
            void Promise.resolve(revokeResult).catch(() => {
              revokeStarted = false;
              revokeResult = undefined;
            });
          }
          return revokeResult;
        },
        release(): void | Promise<void> {
          if (releaseStarted) return releaseResult;
          releaseStarted = true;
          try {
            releaseResult = release();
          } catch (error) {
            releaseStarted = false;
            releaseResult = undefined;
            throw error;
          }
          if (releaseResult !== undefined) {
            void Promise.resolve(releaseResult).catch(() => {
              releaseStarted = false;
              releaseResult = undefined;
            });
          }
          return releaseResult;
        },
        cleanup(): void | Promise<void> {
          if (cleanupStarted) return cleanupResult;
          cleanupStarted = true;
          try {
            cleanupResult = cleanup();
          } catch (error) {
            cleanupStarted = false;
            cleanupResult = undefined;
            throw error;
          }
          if (cleanupResult !== undefined) {
            void Promise.resolve(cleanupResult).catch(() => {
              cleanupStarted = false;
              cleanupResult = undefined;
            });
          }
          return cleanupResult;
        },
      };
    },
  };
}

export function createSrtSandboxPort(options: SrtSandboxPortOptions): SandboxPort {
  const runner = options.runner ?? createNodeSandboxProcessRunner();
  const launchPreparer = createSrtSandboxLaunchPreparer(options);

  return {
    status: () => launchPreparer.status(),
    async execute(
      invocation: SandboxInvocation,
      profile: SandboxProfile,
      executeOptions?: SandboxExecuteOptions,
    ): Promise<SandboxExecutionResult> {
      const launch = await launchPreparer.prepareLaunch(invocation, profile, executeOptions);
      return await executePreparedSrtLaunch(launch, runner, executeOptions?.signal);
    },
  };
}
