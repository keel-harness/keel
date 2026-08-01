#!/usr/bin/env node
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  runStdioWardenServer,
  DEFAULT_MAX_LINE_BYTES,
  WARDEN_TEARDOWN_BUDGET_MS,
} from "./rpc-server.js";
import { createVendoredSrtSandboxComponents } from "./srt-runtime-loader.js";
import type { SandboxPort } from "./sandbox.js";
import type { ConsoleSandboxLaunchPreparer } from "./interactive-console/tmux-broker.js";
import { createWardenSandboxTempRoot } from "./sandbox-temp-root.js";
import { interactiveConsoleProductOptionsFromEnv } from "./interactive-console/product-config.js";
import { resolveWardenKeelHome } from "./capability-manifest.js";
import { loadOrCreateAuditCheckpointKey } from "./audit/checkpoint-key.js";
import { SessionAuditLog } from "./audit/session-log.js";
import { credentialProxyRulesFromEnvValues } from "./credential-proxy.js";
import {
  createSandboxTypedMutationRunner,
  type TypedMutationRunner,
} from "./typed-mutation-runner.js";
import { constructMutationPresentationArtifact } from "./mutation-presentation-constructor.js";
import {
  createMutationPresentationWalkingSkeletonTransport,
  type MutationPresentationWalkingSkeletonTransport,
} from "./mutation-presentation-walking-skeleton.js";
import { defaultPolicyPackRef } from "./policy.js";
import {
  LIFECYCLE_VALIDATION_POSTURE_ENV,
  lifecycleManifestFromEnv,
  parseValidationPostureId,
} from "./lifecycle.js";
import {
  discoverMcpServerWithSandbox,
  INTERNAL_MCP_DISCOVERY_ENV,
  MCP_DISCOVERY_REQUEST_ENV,
  mcpTrustedServersFromEnv,
  type McpStdioLaunchConfig,
} from "./mcp/local-stdio.js";

export { INTERNAL_MCP_DISCOVERY_ENV, MCP_DISCOVERY_REQUEST_ENV } from "./mcp/local-stdio.js";

// The SIGTERM/SIGINT teardown reap budget is shared with the EOF path (single-sourced in rpc-server
// so the two teardown paths — and the kernel's SIGKILL grace, kept strictly greater — never drift).

function maxLineBytesFromEnv(): number {
  const raw = process.env["KEEL_WARDEN_RPC_MAX_LINE_BYTES"];
  if (raw === undefined) return DEFAULT_MAX_LINE_BYTES;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_LINE_BYTES;
}

export interface InstalledSandboxTempRoot {
  readonly declaredTempRoots: readonly string[];
  assertOwned(): void;
  cleanup(): void;
}

/** Installs the warden-selected SRT temp root before the runtime is imported. The inherited
 * CLAUDE_CODE_TMPDIR value is restored only for embedding/tests; sandboxed children never receive it. */
export function installSandboxTempRootFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): InstalledSandboxTempRoot {
  if (env["KEEL_WARDEN_SANDBOX"] !== "srt") {
    return { declaredTempRoots: [], assertOwned: () => {}, cleanup: () => {} };
  }
  const previous = env["CLAUDE_CODE_TMPDIR"];
  const owned = createWardenSandboxTempRoot({ env });
  env["CLAUDE_CODE_TMPDIR"] = owned.path;
  let cleaned = false;
  return {
    declaredTempRoots: owned.declaredTempRoots,
    assertOwned: () => owned.assertOwned(),
    cleanup: () => {
      if (cleaned) return;
      owned.cleanup();
      cleaned = true;
      if (previous === undefined) delete env["CLAUDE_CODE_TMPDIR"];
      else env["CLAUDE_CODE_TMPDIR"] = previous;
    },
  };
}

interface SandboxComponentsFromEnv {
  readonly sandbox?: SandboxPort;
  readonly consoleLaunchPreparer?: ConsoleSandboxLaunchPreparer;
}

async function sandboxComponentsFromEnv(): Promise<SandboxComponentsFromEnv> {
  if (process.env["KEEL_WARDEN_SANDBOX"] !== "srt") return {};
  const components = await createVendoredSrtSandboxComponents();
  return {
    sandbox: components.sandbox,
    ...(components.launchPreparer === undefined
      ? {}
      : { consoleLaunchPreparer: components.launchPreparer }),
  };
}

async function sandboxFromEnv(): Promise<SandboxPort | undefined> {
  return (await sandboxComponentsFromEnv()).sandbox;
}

function auditDirFromEnv(): string {
  return process.env["KEEL_WARDEN_AUDIT_DIR"] ?? join(resolveWardenKeelHome(process.env), "audit");
}

function credentialProxyRulesFromEnv(workspaceRoot: string | undefined) {
  return credentialProxyRulesFromEnvValues({
    workspaceRoot: workspaceRoot ?? process.cwd(),
    env: process.env,
  });
}

function principalFromEnv() {
  let osUser = "unknown";
  try {
    osUser = userInfo().username || osUser;
  } catch {
    osUser = process.env["USER"] ?? osUser;
  }
  return {
    osUser,
    configuredId: null,
    authProvider: "local",
    assurance: "local-os-user",
  } as const;
}

function parseMcpDiscoveryRequest(env: NodeJS.ProcessEnv): McpStdioLaunchConfig {
  const raw = env[MCP_DISCOVERY_REQUEST_ENV];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`${MCP_DISCOVERY_REQUEST_ENV} is required`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw new Error("invalid MCP discovery request");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid MCP discovery request");
  }
  const request = parsed as Record<string, unknown>;
  const server = request["server"];
  if (typeof server !== "object" || server === null || Array.isArray(server)) {
    throw new Error("invalid MCP discovery server");
  }
  const candidate = server as Record<string, unknown>;
  const command = candidate["command"];
  const args = candidate["args"];
  const envKeys = candidate["envKeys"];
  if (candidate["transport"] !== "stdio") throw new Error("MCP discovery supports stdio only");
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("invalid MCP discovery command");
  }
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string")) {
    throw new Error("invalid MCP discovery args");
  }
  if (
    envKeys !== undefined &&
    (!Array.isArray(envKeys) ||
      !envKeys.every((entry): entry is string => typeof entry === "string"))
  ) {
    throw new Error("invalid MCP discovery envKeys");
  }
  return {
    transport: "stdio",
    command,
    args,
    ...(envKeys === undefined ? {} : { envKeys: [...new Set(envKeys)].sort() }),
  };
}

export interface AuditLogForExit {
  close(): void;
}

export function closeAuditLogForExit(
  auditLog: AuditLogForExit,
  onError: (error: unknown) => void = () => {},
): void {
  try {
    auditLog.close();
  } catch (error) {
    onError(error);
  }
}

export function cleanupSandboxTempRootAfterReap(
  sandboxTempRoot: Pick<InstalledSandboxTempRoot, "cleanup">,
  reaped: boolean,
  onError: (error: unknown) => void = reportSandboxTempRootCleanupError,
): void {
  if (!reaped) return;
  try {
    sandboxTempRoot.cleanup();
  } catch (error) {
    onError(error);
  }
}

const TYPED_MUTATION_CLEANUP_PENDING_MESSAGE =
  "keel-warden typed mutation temporary cleanup remains pending during shutdown";

export function closeTypedMutationRunnerForExit(
  runner: Pick<TypedMutationRunner, "close"> | undefined,
  onPending: (message: string) => void = (message) => console.error(message),
): void {
  if (runner?.close === undefined) return;
  try {
    if (runner.close().cleanup === "retry-required") {
      onPending(TYPED_MUTATION_CLEANUP_PENDING_MESSAGE);
    }
  } catch {
    onPending(TYPED_MUTATION_CLEANUP_PENDING_MESSAGE);
  }
}

export function cleanupTypedMutationAndSandboxTempAfterReap(
  runner: Pick<TypedMutationRunner, "close"> | undefined,
  sandboxTempRoot: Pick<InstalledSandboxTempRoot, "cleanup">,
  reaped: boolean,
  onMutationPending: (message: string) => void = (message) => console.error(message),
  onTempRootError: (error: unknown) => void = reportSandboxTempRootCleanupError,
): void {
  if (!reaped) return;
  closeTypedMutationRunnerForExit(runner, onMutationPending);
  cleanupSandboxTempRootAfterReap(sandboxTempRoot, true, onTempRootError);
}

function reportAuditCloseError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`keel-warden audit close failed during shutdown: ${message}`);
}

function reportSandboxTempRootCleanupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`keel-warden sandbox temp cleanup failed during shutdown: ${message}`);
}

export async function runMcpDiscoveryFromEnv(): Promise<void> {
  if (process.env[INTERNAL_MCP_DISCOVERY_ENV] !== "1") {
    throw new Error(`${INTERNAL_MCP_DISCOVERY_ENV} is not enabled`);
  }
  const sandboxTempRoot = installSandboxTempRootFromEnv();
  const abortController = new AbortController();
  const abortDiscovery = (): void => abortController.abort();
  process.once("SIGTERM", abortDiscovery);
  process.once("SIGINT", abortDiscovery);
  try {
    const sandbox = await sandboxFromEnv();
    if (sandbox === undefined) throw new Error("MCP discovery requires the warden sandbox");
    const workspaceRoot = process.env["KEEL_WARDEN_WORKSPACE_ROOT"] ?? process.cwd();
    const credentialProxyRules = credentialProxyRulesFromEnv(workspaceRoot);
    sandboxTempRoot.assertOwned();
    const discovery = await discoverMcpServerWithSandbox({
      sandbox,
      workspaceRoot,
      server: parseMcpDiscoveryRequest(process.env),
      env: process.env,
      declaredTempRoots: sandboxTempRoot.declaredTempRoots,
      auditDir: auditDirFromEnv(),
      ...(credentialProxyRules === undefined ? {} : { credentialProxyRules }),
      signal: abortController.signal,
    });
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(discovery)}\n`, (error) => {
        if (error !== undefined && error !== null) reject(error);
        else resolve();
      });
    });
  } finally {
    process.removeListener("SIGTERM", abortDiscovery);
    process.removeListener("SIGINT", abortDiscovery);
    cleanupSandboxTempRootAfterReap(sandboxTempRoot, true);
  }
}

export async function runWardenFromEnv(): Promise<void> {
  const sandboxTempRoot = installSandboxTempRootFromEnv();
  let sandboxComponents: SandboxComponentsFromEnv;
  try {
    sandboxComponents = await sandboxComponentsFromEnv();
  } catch (error) {
    cleanupSandboxTempRootAfterReap(sandboxTempRoot, true);
    throw error;
  }
  let setupAuditLog: AuditLogForExit | undefined;
  let setupTypedMutationRunner: TypedMutationRunner | undefined;
  let setupMutationPresentation: MutationPresentationWalkingSkeletonTransport | undefined;
  try {
    const sandbox = sandboxComponents.sandbox;
    const workspaceRoot = process.env["KEEL_WARDEN_WORKSPACE_ROOT"];
    const auditDir = auditDirFromEnv();
    const checkpointKey = loadOrCreateAuditCheckpointKey(auditDir);
    const credentialProxyRules = credentialProxyRulesFromEnv(workspaceRoot);
    const lifecycleManifest = lifecycleManifestFromEnv(process.env);
    const workspaceTrusted = process.env["KEEL_WARDEN_WORKSPACE_TRUSTED"] === "1";
    const mcpTrustedServers = workspaceTrusted ? mcpTrustedServersFromEnv(process.env) : {};
    const typedMutationRunner =
      sandbox === undefined
        ? undefined
        : createSandboxTypedMutationRunner({
            sandbox,
            declaredTempRoots: sandboxTempRoot.declaredTempRoots,
          });
    setupTypedMutationRunner = typedMutationRunner;
    const mutationPresentation =
      typedMutationRunner === undefined
        ? undefined
        : createMutationPresentationWalkingSkeletonTransport({
            construct: constructMutationPresentationArtifact,
            constructWrite: constructMutationPresentationArtifact,
          });
    setupMutationPresentation = mutationPresentation;
    const validationPostureId = parseValidationPostureId(
      process.env[LIFECYCLE_VALIDATION_POSTURE_ENV],
    );
    // QC §8: the interactive console is an operator-configured privileged surface — load it only for a
    // trusted workspace, mirroring the MCP trusted-servers gate above. Without trust there is no broker
    // or targets, so the console is neither advertised (helloCapabilities) nor openable (fail-closed).
    const interactiveConsoleOptions = workspaceTrusted
      ? await interactiveConsoleProductOptionsFromEnv(
          process.env,
          sandboxComponents.consoleLaunchPreparer === undefined
            ? {}
            : { launchPreparer: sandboxComponents.consoleLaunchPreparer },
        )
      : {};
    // Per-session chains: each session writes its own <auditDir>/<sessionId>.jsonl so
    // the evidence bundle can export a complete, verifiable single-session chain.
    const auditLog = new SessionAuditLog({
      auditDir,
      principal: principalFromEnv(),
      policyPack: defaultPolicyPackRef(),
      checkpoint: { secretKey: checkpointKey.secretKey },
    });
    setupAuditLog = auditLog;
    let auditClosed = false;
    let tempRootCleaned = false;
    const closeResources = (reaped: boolean): void => {
      if (!auditClosed) {
        auditClosed = true;
        closeAuditLogForExit(auditLog, reportAuditCloseError);
      }
      if (reaped && !tempRootCleaned) {
        tempRootCleaned = true;
        cleanupTypedMutationAndSandboxTempAfterReap(typedMutationRunner, sandboxTempRoot, true);
      }
    };
    const options = {
      maxLineBytes: maxLineBytesFromEnv(),
      auditWriter: auditLog,
      auditDir,
      declaredTempRoots: sandboxTempRoot.declaredTempRoots,
      validateSandboxTempRoot: () => sandboxTempRoot.assertOwned(),
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      ...(credentialProxyRules === undefined ? {} : { credentialProxyRules }),
      ...(lifecycleManifest === undefined ? {} : { lifecycleManifest }),
      ...(typedMutationRunner === undefined ? {} : { typedMutationRunner }),
      ...(mutationPresentation === undefined ? {} : { mutationPresentation }),
      mcpTrustedServers,
      validationPostureId,
      workspaceTrusted,
      ...interactiveConsoleOptions,
      onShutdown: ({ reaped }: { readonly reaped: boolean }) => {
        closeResources(reaped);
        setImmediate(() => process.exit(0));
      },
    };

    const server = runStdioWardenServer(options);

    // The kernel terminates the warden by ending stdin and then sending SIGTERM (client #terminate).
    // Handle the signal so the in-flight sandbox execution is aborted and its detached child process
    // group is reaped before we exit, instead of racing process death. `server.close()` aborts the
    // in-flight execute and resolves once it has settled — for a SIGTERM-trapping child that means
    // after srt's SIGTERM->SIGKILL escalation (~250ms) actually kills the group. We bound the wait so a
    // pathological/hung reap can never wedge teardown: after WARDEN_TEARDOWN_BUDGET_MS we exit anyway
    // and deliberately preserve the private temp root if a child may still be alive.
    const shutdownOnSignal = (): void => {
      void (async () => {
        let reaped = false;
        try {
          const outcome = await Promise.race([
            server.close().then(() => ({ reaped: true as const })),
            new Promise<{ readonly reaped: false }>((resolve) => {
              setTimeout(() => resolve({ reaped: false }), WARDEN_TEARDOWN_BUDGET_MS).unref();
            }),
          ]);
          reaped = outcome.reaped;
        } finally {
          closeResources(reaped);
          process.exit(0);
        }
      })();
    };
    process.once("SIGTERM", shutdownOnSignal);
    process.once("SIGINT", shutdownOnSignal);
  } catch (error) {
    if (setupMutationPresentation !== undefined) {
      try {
        await setupMutationPresentation.clear();
      } catch {
        // Preserve the original startup failure. No request can have reached this not-yet-started
        // transport, and process exit remains the final memory boundary if cleanup itself fails.
      }
    }
    if (setupAuditLog !== undefined) closeAuditLogForExit(setupAuditLog, reportAuditCloseError);
    cleanupTypedMutationAndSandboxTempAfterReap(setupTypedMutationRunner, sandboxTempRoot, true);
    throw error;
  }
}
