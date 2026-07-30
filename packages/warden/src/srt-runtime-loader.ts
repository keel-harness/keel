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

interface VendoredSrtDependencyCheck {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface VendoredSrtRuntimeConfig {
  readonly network: {
    readonly allowedDomains: readonly string[];
    readonly deniedDomains: readonly string[];
    readonly strictAllowlist?: boolean;
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
}

export interface VendoredSrtSandboxComponents {
  readonly sandbox: SandboxPort;
  readonly launchPreparer?: SrtSandboxLaunchPreparer;
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

function completeVendoredRuntimeConfig(customConfig: unknown): VendoredSrtRuntimeConfig {
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
        }
      : {
          allowedDomains: [...(config.network.allowedDomains ?? [])],
          deniedDomains: [...(config.network.deniedDomains ?? [])],
          ...(config.network.strictAllowlist === undefined
            ? {}
            : { strictAllowlist: config.network.strictAllowlist }),
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
  return { sandbox: unavailablePort(status) };
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

  try {
    await manager.initialize(BASE_RUNTIME_CONFIG);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailableComponents(
      unavailableStatus(`sandbox initialization failed: ${message}`, "keel doctor"),
    );
  }

  const runtime: SrtRuntimeAdapter = {
    initialize: async () => {},
    updateConfig: (customConfig) =>
      manager.updateConfig(completeVendoredRuntimeConfig(customConfig)),
    wrapWithSandboxArgv: (command, binShell, customConfig, abortSignal) =>
      manager.wrapWithSandboxArgv(command, binShell, customConfig, abortSignal),
    cleanupAfterCommand: () => manager.cleanupAfterCommand?.(),
  };

  const portOptions = {
    runtime,
    status: {
      available: true,
      backend: VENDORED_SRT_BACKEND,
      enforcementTier: "sandbox:srt",
    },
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.binShell === undefined ? {} : { binShell: options.binShell }),
  } satisfies SrtSandboxPortOptions;

  const launchPreparer = createSrtSandboxLaunchPreparer(portOptions);
  const runner = options.runner ?? createNodeSandboxProcessRunner();
  return {
    sandbox: sandboxFromLaunchPreparer(launchPreparer, runner),
    launchPreparer,
  };
}
