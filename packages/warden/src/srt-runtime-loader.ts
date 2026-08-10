import { existsSync } from "node:fs";
import {
  createNodeSandboxProcessRunner,
  createSrtSandboxLaunchPreparer,
  type SrtSandboxLaunchPreparer,
  type SrtRuntimeAdapter,
  type SrtSandboxPortOptions,
} from "./srt-sandbox.js";
import type {
  SandboxExecutionResult,
  SandboxPort,
  SandboxProcessRunner,
  SandboxProcessRunnerOptions,
  SandboxStatus,
} from "./sandbox.js";
import {
  CREDENTIAL_TLS_TERMINATION_CAPABILITY,
  EGRESS_ADDRESS_GUARD_CAPABILITY,
} from "./sandbox.js";

interface VendoredSrtDependencyCheck {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface SrtResolvedDestinationAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type SrtResolveDestination = (
  hostname: string,
  port: number,
  signal: AbortSignal,
) => Promise<readonly SrtResolvedDestinationAddress[]>;

export interface VendoredSrtRuntimeConfig {
  readonly network: {
    readonly allowedDomains: readonly string[];
    readonly deniedDomains: readonly string[];
    readonly strictAllowlist?: boolean;
    readonly tlsTerminate?: {
      readonly caCertPath?: string;
      readonly caKeyPath?: string;
    };
    readonly resolveDestination?: SrtResolveDestination;
    readonly inheritProxyEnv?: boolean;
  };
  readonly filesystem: {
    readonly denyRead: readonly string[];
    readonly allowRead: readonly string[];
    readonly allowWrite: readonly string[];
    readonly denyWrite: readonly string[];
  };
  readonly credentials?: {
    readonly authorizationHeaders?: readonly {
      readonly host: string;
      readonly scheme: string;
      readonly value: string;
    }[];
    readonly authorizationPlaceholders?: readonly {
      readonly host: string;
      readonly scheme: string;
      readonly placeholder: string;
      readonly value: string;
    }[];
    readonly allowPlaintextInject?: boolean;
  };
}

export interface VendoredSrtManager {
  isSupportedPlatform(): boolean;
  checkDependencies(): VendoredSrtDependencyCheck;
  initialize(config: VendoredSrtRuntimeConfig): Promise<void>;
  updateConfig(config: VendoredSrtRuntimeConfig): void;
  wrapWithSandboxArgv(
    command: string,
    binShell: string | undefined,
    customConfig: unknown,
    abortSignal: AbortSignal | undefined,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  cleanupAfterCommand?: () => void;
  reset?: () => Promise<void>;
}

export interface VendoredSrtModule {
  readonly SandboxManager: VendoredSrtManager;
}

type UnavailableVendoredSrtStatus = SandboxStatus & {
  readonly available: false;
  readonly reason: string;
};

export interface VendoredSrtSandboxPortOptions {
  readonly importRuntime?: () => Promise<VendoredSrtModule>;
  readonly hostDependencyErrors?: () => readonly string[];
  readonly runner?: SandboxProcessRunner;
  readonly binShell?: string;
  /** Enables SRT's verified HTTPS termination before any credential-bearing launch is prepared. */
  readonly credentialTlsTermination?: boolean;
  /** Initialization-scoped Warden authority for connect-time destination resolution. */
  readonly resolveDestination?: SrtResolveDestination;
}

export interface VendoredSrtSandboxComponents {
  readonly sandbox: SandboxPort;
  readonly launchPreparer?: SrtSandboxLaunchPreparer;
  /** Stops accepting sandbox work and tears down the process-scoped SRT proxy infrastructure. */
  readonly shutdown: () => Promise<void>;
}

const VENDORED_SRT_BACKEND = "srt:vendored";
const VENDORED_SRT_ENTRY = new URL("../../../vendor/sandbox-runtime/src/index.ts", import.meta.url);
const BUNDLED_SRT_RUNTIME_GLOBAL = "__keelBundledSrtRuntime";

const BASE_RUNTIME_CONFIG: VendoredSrtRuntimeConfig = {
  network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true },
  filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
};

interface TsxEsmApi {
  tsImport(specifier: string, options: { parentURL: string; tsconfig?: false }): Promise<unknown>;
}

async function importSourceModeTsxApi(): Promise<TsxEsmApi> {
  const specifier = ["tsx", "esm", "api"].join("/");
  return (await import(specifier)) as TsxEsmApi;
}

export interface VendoredSrtRuntimeImportOptions {
  readonly directImport?: () => Promise<VendoredSrtModule>;
  readonly tsImport?: (
    specifier: string,
    options: { parentURL: string; tsconfig?: false },
  ) => Promise<VendoredSrtModule>;
}

function initialVendoredRuntimeConfig(
  credentialTlsTermination: boolean,
  resolveDestination: SrtResolveDestination | undefined,
): VendoredSrtRuntimeConfig {
  return {
    network: {
      allowedDomains: [...BASE_RUNTIME_CONFIG.network.allowedDomains],
      deniedDomains: [...BASE_RUNTIME_CONFIG.network.deniedDomains],
      strictAllowlist: true,
      ...(credentialTlsTermination ? { tlsTerminate: {} } : {}),
      ...(resolveDestination === undefined ? {} : { resolveDestination, inheritProxyEnv: false }),
    },
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
  };
}

function completeVendoredRuntimeConfig(
  customConfig: unknown,
  credentialTlsTermination: boolean,
  resolveDestination: SrtResolveDestination | undefined,
): VendoredSrtRuntimeConfig {
  const config = customConfig as {
    network?: {
      allowedDomains?: readonly string[];
      deniedDomains?: readonly string[];
      strictAllowlist?: boolean;
    };
    filesystem?: {
      denyRead?: readonly string[];
      allowRead?: readonly string[];
      allowWrite?: readonly string[];
      denyWrite?: readonly string[];
    };
    credentials?: {
      authorizationHeaders?: readonly {
        readonly host: string;
        readonly scheme: string;
        readonly value: string;
      }[];
      authorizationPlaceholders?: readonly {
        readonly host: string;
        readonly scheme: string;
        readonly placeholder: string;
        readonly value: string;
      }[];
      allowPlaintextInject?: boolean;
    };
  };
  const network =
    config.network === undefined
      ? {
          allowedDomains: [...BASE_RUNTIME_CONFIG.network.allowedDomains],
          deniedDomains: [...BASE_RUNTIME_CONFIG.network.deniedDomains],
          strictAllowlist: true,
          ...(credentialTlsTermination ? { tlsTerminate: {} } : {}),
          ...(resolveDestination === undefined
            ? {}
            : { resolveDestination, inheritProxyEnv: false }),
        }
      : {
          allowedDomains: [...(config.network.allowedDomains ?? [])],
          deniedDomains: [...(config.network.deniedDomains ?? [])],
          ...(config.network.strictAllowlist === undefined
            ? {}
            : { strictAllowlist: config.network.strictAllowlist }),
          ...(credentialTlsTermination ? { tlsTerminate: {} } : {}),
          ...(resolveDestination === undefined
            ? {}
            : { resolveDestination, inheritProxyEnv: false }),
        };
  const credentials =
    config.credentials === undefined
      ? undefined
      : {
          ...(config.credentials.authorizationHeaders === undefined
            ? {}
            : {
                authorizationHeaders: config.credentials.authorizationHeaders.map((credential) => ({
                  ...credential,
                })),
              }),
          ...(config.credentials.authorizationPlaceholders === undefined
            ? {}
            : {
                authorizationPlaceholders: config.credentials.authorizationPlaceholders.map(
                  (credential) => ({
                    ...credential,
                  }),
                ),
              }),
          ...(config.credentials.allowPlaintextInject === undefined
            ? {}
            : { allowPlaintextInject: config.credentials.allowPlaintextInject }),
        };
  return {
    network,
    filesystem: {
      denyRead: [...(config.filesystem?.denyRead ?? [])],
      allowRead: [...(config.filesystem?.allowRead ?? [])],
      allowWrite: [...(config.filesystem?.allowWrite ?? [])],
      denyWrite: [...(config.filesystem?.denyWrite ?? [])],
    },
    ...(credentials === undefined ? {} : { credentials }),
  };
}

function unavailablePort(status: UnavailableVendoredSrtStatus): SandboxPort {
  return {
    status: () => status,
    execute: async () => {
      throw new Error(status.reason);
    },
  };
}

function unavailableComponents(status: UnavailableVendoredSrtStatus): VendoredSrtSandboxComponents {
  return { sandbox: unavailablePort(status), shutdown: async () => {} };
}

function unavailableStatus(reason: string, fixCommand: string): UnavailableVendoredSrtStatus {
  return {
    available: false,
    backend: VENDORED_SRT_BACKEND,
    enforcementTier: "none",
    reason,
    fixCommand,
  };
}

export function detectVendoredSrtHostDependencyErrors(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string[] {
  return platform === "darwin" && !exists("/usr/bin/sandbox-exec")
    ? ["/usr/bin/sandbox-exec not found"]
    : [];
}

export function isPlainNodeTypeScriptImportError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as Record<string, unknown>)["code"];
  if (code === "ERR_UNKNOWN_FILE_EXTENSION") return true;
  const message = error instanceof Error ? error.message : "";
  return message.includes('Unknown file extension ".ts"');
}

export function isBundledVendoredSrtHelperImportError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as Record<string, unknown>)["code"];
  const message = error instanceof Error ? error.message : "";
  return (
    (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
    message.includes("bundled-srt-runtime")
  );
}

function isVendoredSrtModule(value: unknown): value is VendoredSrtModule {
  if (typeof value !== "object" || value === null) return false;
  const manager = (value as Record<string, unknown>)["SandboxManager"];
  if (typeof manager !== "object" || manager === null) return false;
  return typeof (manager as Record<string, unknown>)["isSupportedPlatform"] === "function";
}

function bundledVendoredSrtRuntimeGlobal(): VendoredSrtModule | undefined {
  const value = (globalThis as Record<string, unknown>)[BUNDLED_SRT_RUNTIME_GLOBAL];
  return isVendoredSrtModule(value) ? value : undefined;
}

async function importBundledVendoredSrtRuntimeModule(): Promise<VendoredSrtModule> {
  const globalRuntime = bundledVendoredSrtRuntimeGlobal();
  if (globalRuntime !== undefined) return globalRuntime;
  const module = await import("./bundled-srt-runtime.js");
  return (await module.importBundledVendoredSrtRuntime()) as VendoredSrtModule;
}

export async function importVendoredSrtRuntime(
  options: VendoredSrtRuntimeImportOptions = {},
): Promise<VendoredSrtModule> {
  const directImport =
    options.directImport ??
    (async (): Promise<VendoredSrtModule> => importBundledVendoredSrtRuntimeModule());
  try {
    return await directImport();
  } catch (error) {
    if (!isPlainNodeTypeScriptImportError(error) && !isBundledVendoredSrtHelperImportError(error)) {
      throw error;
    }
  }

  try {
    const tsImport =
      options.tsImport ??
      (async (
        specifier: string,
        importOptions: { parentURL: string; tsconfig?: false },
      ): Promise<VendoredSrtModule> => {
        const api = await importSourceModeTsxApi();
        return (await api.tsImport(specifier, importOptions)) as VendoredSrtModule;
      });
    return await tsImport(VENDORED_SRT_ENTRY.href, {
      parentURL: import.meta.url,
      tsconfig: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`vendored sandbox runtime TypeScript loader unavailable: ${message}`);
  }
}

export async function createVendoredSrtSandboxPort(
  options: VendoredSrtSandboxPortOptions = {},
): Promise<SandboxPort> {
  const components = await createVendoredSrtSandboxComponents(options);
  return components.sandbox;
}

function runnerOptions(signal: AbortSignal | undefined): SandboxProcessRunnerOptions | undefined {
  return signal === undefined ? undefined : { signal };
}

function sandboxFromLaunchPreparer(
  launchPreparer: SrtSandboxLaunchPreparer,
  runner: SandboxProcessRunner,
): SandboxPort {
  return {
    status: () => launchPreparer.status(),
    async execute(invocation, profile, executeOptions): Promise<SandboxExecutionResult> {
      const launch = await launchPreparer.prepareLaunch(invocation, profile, executeOptions);
      try {
        return await runner.run(launch.descriptor, runnerOptions(executeOptions?.signal));
      } finally {
        launch.cleanup();
      }
    },
  };
}

export async function createVendoredSrtSandboxComponents(
  options: VendoredSrtSandboxPortOptions = {},
): Promise<VendoredSrtSandboxComponents> {
  const credentialTlsTermination = options.credentialTlsTermination === true;
  const resolveDestination = options.resolveDestination;
  const importRuntime = options.importRuntime ?? importVendoredSrtRuntime;
  let runtimeModule: VendoredSrtModule;
  try {
    runtimeModule = await importRuntime();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailableComponents(
      unavailableStatus(`vendored sandbox runtime unavailable: ${message}`, "pnpm install"),
    );
  }

  const manager = runtimeModule.SandboxManager;
  if (!manager.isSupportedPlatform()) {
    return unavailableComponents(
      unavailableStatus("sandbox platform is not supported", "keel doctor"),
    );
  }

  const dependencies = manager.checkDependencies();
  const readHostDependencyErrors =
    options.hostDependencyErrors ?? detectVendoredSrtHostDependencyErrors;
  const dependencyErrors = [...readHostDependencyErrors(), ...dependencies.errors];
  if (dependencyErrors.length > 0) {
    return unavailableComponents(
      unavailableStatus(
        `sandbox dependencies not available: ${dependencyErrors.join(", ")}`,
        "keel doctor",
      ),
    );
  }

  if (resolveDestination !== undefined && manager.reset === undefined) {
    return unavailableComponents(
      unavailableStatus("guarded sandbox shutdown is unavailable", "pnpm install"),
    );
  }

  try {
    await manager.initialize(
      initialVendoredRuntimeConfig(credentialTlsTermination, resolveDestination),
    );
  } catch (error) {
    if (resolveDestination !== undefined) {
      try {
        await manager.reset!();
      } catch {
        // Initialization may already have opened proxy listeners. If their authoritative reset
        // fails, do not keep a Warden process alive beside potentially unmanaged partial state.
        throw new Error("guarded sandbox initialization cleanup failed");
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return unavailableComponents(
      unavailableStatus(`sandbox initialization failed: ${message}`, "keel doctor"),
    );
  }

  const runtime: SrtRuntimeAdapter = {
    initialize: async () => {},
    updateConfig: (customConfig) =>
      manager.updateConfig(
        completeVendoredRuntimeConfig(customConfig, credentialTlsTermination, resolveDestination),
      ),
    wrapWithSandboxArgv: (command, binShell, customConfig, abortSignal) =>
      manager.wrapWithSandboxArgv(command, binShell, customConfig, abortSignal),
    cleanupAfterCommand: () => manager.cleanupAfterCommand?.(),
  };

  const activeStatus: SandboxStatus = Object.freeze({
    available: true,
    backend: VENDORED_SRT_BACKEND,
    enforcementTier: "sandbox:srt",
    ...(!credentialTlsTermination && resolveDestination === undefined
      ? {}
      : {
          features: Object.freeze([
            ...(credentialTlsTermination ? [CREDENTIAL_TLS_TERMINATION_CAPABILITY] : []),
            ...(resolveDestination === undefined ? [] : [EGRESS_ADDRESS_GUARD_CAPABILITY]),
          ]),
        }),
  });
  const stoppedStatus: UnavailableVendoredSrtStatus = Object.freeze(
    unavailableStatus("sandbox runtime is stopped", "restart keel"),
  );
  let stopped = false;
  let shutdownPromise: Promise<void> | undefined;
  const status = (): SandboxStatus => (stopped ? stoppedStatus : activeStatus);
  const portOptions = {
    runtime,
    status: activeStatus,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.binShell === undefined ? {} : { binShell: options.binShell }),
  } satisfies SrtSandboxPortOptions;

  const underlyingLaunchPreparer = createSrtSandboxLaunchPreparer(portOptions);
  const launchPreparer: SrtSandboxLaunchPreparer = {
    status,
    async prepareLaunch(invocation, profile, executeOptions) {
      if (stopped) throw new Error(stoppedStatus.reason);
      return underlyingLaunchPreparer.prepareLaunch(invocation, profile, executeOptions);
    },
  };
  const runner = options.runner ?? createNodeSandboxProcessRunner();
  return {
    sandbox: sandboxFromLaunchPreparer(launchPreparer, runner),
    launchPreparer,
    shutdown: () => {
      if (shutdownPromise !== undefined) return shutdownPromise;
      stopped = true;
      shutdownPromise = manager.reset?.() ?? Promise.resolve();
      return shutdownPromise;
    },
  };
}
