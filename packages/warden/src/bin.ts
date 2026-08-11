#!/usr/bin/env node
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  runStdioWardenServer,
  DEFAULT_AUDIT_SESSION_ID,
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
import {
  ensureEgressAddressExceptionAuthorityHome,
  loadEgressAddressExceptionSnapshot,
} from "./egress-address-exceptions.js";
import {
  createBoundedEgressAddressResolver,
  type BoundedEgressAddressResolver,
  type EgressResolverAuditRecord,
} from "./egress-resolver.js";
import { credentialProxyRulesFromEnvValues, type CredentialProxyRule } from "./credential-proxy.js";
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
import type { GitPushAuthority } from "./git-push-authority.js";
import { createGitCredentialBroker } from "./git-credential-broker.js";
import { createGitPushProductionAuthority } from "./git-push.js";
import { resolveProductionGitExecutable } from "./git-push-product.js";
import type { GithubPrCreateAuthority } from "./github-pr-create-authority.js";
import { createGithubPrCreateProductionAuthority } from "./github-pr-create.js";
import { resolveProductionCurlExecutable } from "./github-pr-create-product.js";

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
  readonly shutdown?: () => Promise<void>;
}

async function sandboxComponentsFromEnv(
  credentialProxyRules?: readonly CredentialProxyRule[],
  resolveDestination?: BoundedEgressAddressResolver["resolveDestination"],
  gitPushAuthority?: GitPushAuthority,
  githubPrCreateAuthority?: GithubPrCreateAuthority,
): Promise<SandboxComponentsFromEnv> {
  if (process.env["KEEL_WARDEN_SANDBOX"] !== "srt") return {};
  const credentialTlsTermination =
    (credentialProxyRules !== undefined && credentialProxyRules.length > 0) ||
    gitPushAuthority?.transportRequirements.credentialTlsTermination === true ||
    githubPrCreateAuthority?.transportRequirements.credentialTlsTermination === true;
  const options = {
    ...(credentialTlsTermination ? { credentialTlsTermination: true } : {}),
    ...(resolveDestination === undefined ? {} : { resolveDestination }),
  };
  const components =
    Object.keys(options).length === 0
      ? await createVendoredSrtSandboxComponents()
      : await createVendoredSrtSandboxComponents(options);
  return {
    sandbox: components.sandbox,
    shutdown: components.shutdown,
    ...(components.launchPreparer === undefined
      ? {}
      : { consoleLaunchPreparer: components.launchPreparer }),
  };
}

async function sandboxFromEnv(
  credentialProxyRules?: readonly CredentialProxyRule[],
): Promise<SandboxPort | undefined> {
  return (await sandboxComponentsFromEnv(credentialProxyRules)).sandbox;
}

function auditDirFromEnv(home = resolveWardenKeelHome(process.env)): string {
  return process.env["KEEL_WARDEN_AUDIT_DIR"] ?? join(home, "audit");
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

function egressAddressGuardAuditSink(auditLog: Pick<SessionAuditLog, "append">) {
  return {
    append(record: EgressResolverAuditRecord): void {
      auditLog.append({
        eventType: "egress.deny",
        sessionId: DEFAULT_AUDIT_SESSION_ID,
        payload: {
          host: record.host,
          port: record.port,
          reason: record.reason,
          addressClass: record.addressClass,
          answerCount: record.answerCount,
          exceptionPolicyRevision: record.exceptionPolicyRevision,
        },
      });
    },
  };
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
    const workspaceRoot = process.env["KEEL_WARDEN_WORKSPACE_ROOT"] ?? process.cwd();
    const credentialProxyRules = credentialProxyRulesFromEnv(workspaceRoot);
    const sandbox = await sandboxFromEnv(credentialProxyRules);
    if (sandbox === undefined) throw new Error("MCP discovery requires the warden sandbox");
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

export interface RunWardenFromEnvOptions {
  /** Injected only by a product entrypoint that has already constructed the typed authority. */
  readonly gitPushAuthority?: GitPushAuthority;
  readonly githubPrCreateAuthority?: GithubPrCreateAuthority;
}

export async function runWardenFromEnv(
  runtimeOptions: RunWardenFromEnvOptions = {},
): Promise<void> {
  const sandboxTempRoot = installSandboxTempRootFromEnv();
  const workspaceRoot = process.env["KEEL_WARDEN_WORKSPACE_ROOT"] ?? process.cwd();
  let sandboxComponents: SandboxComponentsFromEnv = {};
  let credentialProxyRules: CredentialProxyRule[] | undefined;
  let setupAuditLog: AuditLogForExit | undefined;
  let setupEgressResolver: BoundedEgressAddressResolver | undefined;
  let setupTypedMutationRunner: TypedMutationRunner | undefined;
  let setupMutationPresentation: MutationPresentationWalkingSkeletonTransport | undefined;
  try {
    // Establish owner-controlled state and the authoritative audit sink before constructing any
    // address authority or importing SRT. A malformed exception store therefore fails before a
    // proxy listener, sandboxed child, or RPC request can exist.
    const keelHome = ensureEgressAddressExceptionAuthorityHome(process.env);
    const auditDir = auditDirFromEnv(keelHome);
    const checkpointKey = loadOrCreateAuditCheckpointKey(auditDir);
    const workspaceTrusted = process.env["KEEL_WARDEN_WORKSPACE_TRUSTED"] === "1";
    const auditLog = new SessionAuditLog({
      auditDir,
      principal: principalFromEnv(),
      policyPack: defaultPolicyPackRef(),
      checkpoint: { secretKey: checkpointKey.secretKey },
    });
    setupAuditLog = auditLog;

    let quarantineRequested = false;
    let gitPushAddressGuardRevision: string | undefined;
    if (process.env["KEEL_WARDEN_SANDBOX"] === "srt") {
      const exceptionSnapshot = loadEgressAddressExceptionSnapshot(workspaceRoot, process.env);
      gitPushAddressGuardRevision = exceptionSnapshot.revision;
      const egressResolver = createBoundedEgressAddressResolver({
        audit: egressAddressGuardAuditSink(auditLog),
        onQuarantine: () => {
          quarantineRequested = true;
          void sandboxComponents.shutdown?.().catch(() => {});
        },
        ...(workspaceTrusted
          ? { allowsRestrictedAddress: exceptionSnapshot.allowsRestrictedAddress }
          : {}),
        exceptionPolicyRevision: workspaceTrusted ? exceptionSnapshot.revision : "none",
      });
      setupEgressResolver = egressResolver;
    }

    let gitPushAuthority = runtimeOptions.gitPushAuthority;
    let githubPrCreateAuthority = runtimeOptions.githubPrCreateAuthority;
    if (
      (gitPushAuthority === undefined || githubPrCreateAuthority === undefined) &&
      workspaceTrusted &&
      process.env["KEEL_WARDEN_SANDBOX"] === "srt"
    ) {
      sandboxTempRoot.assertOwned();
      const tempRoot = sandboxTempRoot.declaredTempRoots[0];
      if (tempRoot === undefined || sandboxTempRoot.declaredTempRoots.length !== 1) {
        throw new Error("governed publication requires one Warden-owned temporary root");
      }
      const resolvedGit = resolveProductionGitExecutable({
        workspaceRoot,
        env: process.env,
        platform: process.platform,
      });
      if (resolvedGit !== undefined) {
        const gitExecutable = resolvedGit.path;
        const credentialBroker = createGitCredentialBroker({
          gitExecutable,
          tempRoot,
          env: process.env,
        });
        if (gitPushAuthority === undefined) {
          gitPushAuthority = createGitPushProductionAuthority({
            productionCapability: true,
            credentialBroker,
            gitExecutable,
            gitVersion: resolvedGit.version,
            tempRoot,
          });
        }
        const resolvedCurl = resolveProductionCurlExecutable({
          workspaceRoot,
          env: process.env,
          platform: process.platform,
        });
        if (githubPrCreateAuthority === undefined && resolvedCurl !== undefined) {
          githubPrCreateAuthority = createGithubPrCreateProductionAuthority({
            productionCapability: true,
            credentialBroker,
            gitExecutable,
            gitVersion: resolvedGit.version,
            curlExecutable: resolvedCurl.path,
            curlVersion: resolvedCurl.version,
            tempRoot,
          });
        }
      }
    }

    credentialProxyRules = credentialProxyRulesFromEnv(workspaceRoot);
    const activeEgressResolver = setupEgressResolver;
    sandboxComponents = await sandboxComponentsFromEnv(
      credentialProxyRules,
      activeEgressResolver === undefined
        ? undefined
        : (hostname, port, signal) =>
            activeEgressResolver.resolveDestination(hostname, port, signal),
      gitPushAuthority,
      githubPrCreateAuthority,
    );
    if (quarantineRequested) await sandboxComponents.shutdown?.();

    const sandbox = sandboxComponents.sandbox;
    const lifecycleManifest = lifecycleManifestFromEnv(process.env);
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
      workspaceRoot,
      ...(credentialProxyRules === undefined ? {} : { credentialProxyRules }),
      ...(lifecycleManifest === undefined ? {} : { lifecycleManifest }),
      ...(typedMutationRunner === undefined ? {} : { typedMutationRunner }),
      ...(mutationPresentation === undefined ? {} : { mutationPresentation }),
      ...(gitPushAuthority === undefined ? {} : { gitPushAuthority }),
      ...(gitPushAddressGuardRevision === undefined ? {} : { gitPushAddressGuardRevision }),
      ...(githubPrCreateAuthority === undefined ? {} : { githubPrCreateAuthority }),
      ...(gitPushAddressGuardRevision === undefined
        ? {}
        : { githubPrCreateAddressGuardRevision: gitPushAddressGuardRevision }),
      mcpTrustedServers,
      validationPostureId,
      workspaceTrusted,
      shutdownRuntime: async () => {
        await Promise.allSettled([setupEgressResolver?.shutdown(), sandboxComponents.shutdown?.()]);
      },
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
    await Promise.allSettled([setupEgressResolver?.shutdown(), sandboxComponents.shutdown?.()]);
    if (setupAuditLog !== undefined) closeAuditLogForExit(setupAuditLog, reportAuditCloseError);
    cleanupTypedMutationAndSandboxTempAfterReap(setupTypedMutationRunner, sandboxTempRoot, true);
    throw error;
  }
}
