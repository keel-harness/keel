import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import type {
  SandboxCredentialProxyConfig,
  SandboxExecuteOptions,
  SandboxExecutionResult,
  SandboxInvocation,
  SandboxPort,
  SandboxProcessRunner,
  SandboxProcessRunnerOptions,
  SandboxProfile,
  SandboxSpawnDescriptor,
  SandboxStatus,
} from "./sandbox.js";

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
  cleanup(): void;
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
  readonly platform?: NodeJS.Platform;
  // Per-stream cap on captured stdout/stderr (QC §5). The warden buffers the child's whole output
  // into a JS string (and the audit payload); an unbounded stream (`yes`, `cat /dev/zero`) would grow
  // it without limit and OOM the control plane. Beyond the cap we drain (discard) further output and
  // append a truncation marker, so warden memory stays bounded regardless of what the child emits.
  readonly maxOutputBytes?: number;
}

const DEFAULT_PROCESS_GROUP_KILL_GRACE_MS = 250;

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

function processRunnerOptions(
  executeOptions: SandboxExecuteOptions | undefined,
): SandboxProcessRunnerOptions | undefined {
  return executeOptions?.signal === undefined ? undefined : { signal: executeOptions.signal };
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

function shellQuoteArg(value: string): string {
  if (value === "") return "''";
  return `'${value.replace(/'/gu, `'\\''`)}'`;
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
  return argv.map(shellQuoteArg).join(" ");
}

function canSignalProcessGroup(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
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
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return {
    run(descriptor, options) {
      const command = descriptor.argv[0];
      if (command === undefined) {
        return Promise.reject(new Error("sandbox spawn descriptor argv must not be empty"));
      }
      const args = descriptor.argv.slice(1);
      return new Promise<SandboxExecutionResult>((resolve, reject) => {
        const spawnOptions: SpawnOptionsWithoutStdio = {
          detached: canSignalProcessGroup(platform),
          env: descriptor.env,
          shell: false,
        };
        if (descriptor.cwd !== undefined) spawnOptions.cwd = descriptor.cwd;
        const child = spawn(command, args, spawnOptions);
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
        let killTimer: NodeJS.Timeout | undefined;
        const signalSandboxProcess = (signal: NodeJS.Signals): void => {
          if (canSignalProcessGroup(platform) && child.pid !== undefined) {
            try {
              killProcess(-child.pid, signal);
              return;
            } catch {
              // Fall back to direct-child signaling below.
            }
          }
          child.kill(signal);
        };
        const onAbort = (): void => {
          signalSandboxProcess("SIGTERM");
          if (killGraceMs <= 0) return;
          killTimer = setTimeout(() => {
            signalSandboxProcess("SIGKILL");
          }, killGraceMs);
          killTimer.unref();
        };
        if (options?.signal?.aborted === true) {
          onAbort();
        } else {
          options?.signal?.addEventListener("abort", onAbort, { once: true });
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
          if (killTimer !== undefined) clearTimeout(killTimer);
          options?.signal?.removeEventListener("abort", onAbort);
        };
        child.once("error", (error) => {
          cleanup();
          reject(error);
        });
        child.once("close", (exitCode, signal) => {
          cleanup();
          resolve({ exitCode, signal, stdout: stdoutSink.value(), stderr: stderrSink.value() });
        });
      });
    },
  };
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
      if (!initialized) {
        await options.runtime.initialize?.();
        initialized = true;
      }
      const customConfig = {
        ...profileToSrtConfig(profile),
        ...credentialProxyToSrtConfig(executeOptions?.credentialProxy),
      };
      options.runtime.updateConfig?.(customConfig);
      let wrapped: { argv: string[]; env: NodeJS.ProcessEnv };
      try {
        wrapped = await options.runtime.wrapWithSandboxArgv(
          sandboxCommandForInvocation(invocation),
          options.binShell,
          customConfig,
          executeOptions?.signal,
        );
      } catch (error) {
        options.runtime.cleanupAfterCommand?.();
        throw error;
      }
      let cleaned = false;
      return {
        descriptor: sandboxSpawnDescriptor(invocation, wrapped, executeOptions?.credentialProxy),
        cleanup(): void {
          if (cleaned) return;
          cleaned = true;
          options.runtime.cleanupAfterCommand?.();
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
      try {
        return await runner.run(launch.descriptor, processRunnerOptions(executeOptions));
      } finally {
        launch.cleanup();
      }
    },
  };
}
