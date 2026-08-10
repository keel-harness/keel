import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CREDENTIAL_PROXY_CONFIG_ENV,
  CREDENTIAL_PROXY_PROJECT_CONFIG_ENV,
  CREDENTIAL_PROXY_PROJECT_CONFIG_PATH,
  INTERACTIVE_CONSOLE_CAPABILITY,
  INTERACTIVE_CONSOLE_TARGET_CAPABILITY_PREFIX,
  INTERNAL_MCP_DISCOVERY_ENV,
  LIFECYCLE_MANIFEST_CONFIG_ENV,
  MCP_DISCOVERY_REQUEST_ENV,
  MUTATION_PRESENTATION_CAPABILITY_V1,
  parseMcpDiscoveryResult,
  type ExecutorPort,
  type LifecycleManifestT,
  type McpDiscoveryResult,
  type McpStdioLaunchConfig,
  type PrincipalT,
  type ToolSpecT,
} from "@keel/shared";
import { KEEL_VERSION } from "../version.js";
import { ProjectReader, defaultProjectFs } from "../context/project-reader.js";
import {
  lifecycleManifestEnvValue,
  lifecycleToolSpecForManifest,
  loadLifecycleManifestFromProjectReader,
} from "../context/lifecycle-manifest.js";
import { keelHome } from "../session/paths.js";
import {
  advertisedMcpToolSpecs,
  mcpTrustedServersChildEnv,
  quarantineMcpTrustedServerBySlug,
} from "../mcp/local-stdio.js";
import type {
  ProcessLease,
  ProcessLeaseCleanupResult,
  ProcessLeaseScope,
} from "../tools/process-lease.js";
import { SPEC as BASH_SPEC } from "../tools/bash.js";
import {
  PROCESS_RUN_CAPABILITY_V1,
  PROCESS_RUN_TOOL_NAME,
  SPEC as PROCESS_RUN_SPEC,
} from "../tools/process-run.js";
import {
  GIT_PUSH_CAPABILITY_V1,
  GIT_PUSH_TOOL_NAME,
  SPEC as GIT_PUSH_SPEC,
} from "../tools/git-push.js";
import { SPEC as EDIT_SPEC } from "../tools/edit.js";
import { SPEC as READ_SPEC } from "../tools/read.js";
import { resolveRgPath, SPEC as SEARCH_SPEC } from "../tools/search.js";
import { SPEC as WRITE_SPEC } from "../tools/write.js";
import { mergeAndRestoreHostNodeEnv } from "../tools/child-env.js";
import { WardenExecutor } from "./executor.js";
import type { WardenReviewAutoResolvedEvent, WardenReviewDecisionHandler } from "./executor.js";
import { startWardenClient, WardenClientError, type StartedWardenClient } from "./client.js";
import {
  canRoutePlanApprovalReviews,
  wardenStatusViewConfig,
  type WardenStatusViewConfig,
} from "./status.js";
import {
  summarizePlanApprovalEnvelope,
  type PlanApprovalEnvelope,
  type PlanApprovalSummary,
} from "./approval.js";
import {
  buildModeChangeAuditEvent,
  canRouteAutopilotReviews,
  resolveAutonomyPosture,
  type AutonomyPostureRequest,
} from "../autopilot/posture.js";

export { LIFECYCLE_MANIFEST_CONFIG_ENV, MCP_TRUSTED_SERVERS_ENV } from "@keel/shared";

export interface ProductionWardenStartOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
}

export interface ProductionWardenClientOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly workspaceTrusted?: boolean;
  readonly start?: ProductionWardenStartOptions;
}

export interface ProductionWardenRuntimeOptions extends ProductionWardenClientOptions {
  readonly sessionId: string;
  /** Exact retry command for a resumed session. Presence means startup is a resume ownership check. */
  readonly resumeCommand?: string;
  /** Kernel-local autonomy posture request. Public config wiring remains a separate slice. */
  readonly autonomy?: AutonomyPostureRequest;
  /**
   * Exact-resource plan approval envelope. The runtime intersects the envelope trust bit with the
   * actual trusted-workspace state before it reaches the executor.
   */
  readonly planApproval?: PlanApprovalEnvelope;
  readonly onReviewAutoResolved?: (event: WardenReviewAutoResolvedEvent) => void | Promise<void>;
  readonly onReviewRequired?: WardenReviewDecisionHandler;
  /** Kernel-side RPC execute backstop (ms). Omitted → `PRODUCTION_WARDEN_EXECUTE_TIMEOUT_MS` (630s).
   *  `session-entry` injects the eval-aware value (`resolveWardenExecuteTimeoutMs`) so a benchmark's
   *  raised bash ceiling is not clipped at 630s; production stays 630s. */
  readonly executeTimeoutMs?: number;
}

export interface ProductionWardenRuntime {
  readonly executor: ExecutorPort;
  readonly tools: readonly ToolSpecT[];
  readonly isMutating: (name: string) => boolean;
  readonly view: WardenStatusViewConfig;
  /** Structural warden liveness for the loop's fail-closed halt (P0-3): false once the spawned warden
   *  child is gone. The session entrypoint threads this into the loop as its enforcement probe.
   *  Optional — the local/eval runtime spawns no warden and simply omits it (probe absent → the loop
   *  keeps its unchanged behavior, which is correct when there is no enforcement plane to lose). */
  wardenAvailable?(): boolean;
  /** Validation summary after runtime workspace trust is intersected with the envelope. This is
   *  not a routing claim; visible policy/sandbox/egress/audit gates can still keep the plan inert. */
  readonly planApprovalSummary?: PlanApprovalSummary;
  /** The trusted lifecycle manifest, when loaded — so a goal's `--validation <tier>` can run the
   *  tier's required actions (governed `lifecycle.run`) for a REAL completion verdict (Epic 2.15b). */
  readonly lifecycleManifest?: LifecycleManifestT;
  /** Present only on eval/direct local runtime while governed warden lease semantics remain absent. */
  activeLeases?(): readonly ProcessLease[];
  /** Present only on eval/direct local runtime while warden lease semantics remain intentionally absent. */
  cleanupLeases?(scope?: ProcessLeaseScope): Promise<ProcessLeaseCleanupResult[]>;
  dispose(): Promise<void>;
}

export interface AuditExportCommandOptions extends ProductionWardenClientOptions {
  readonly sessionId: string;
  readonly outPath: string;
}

export interface ProductionMcpDiscoveryOptions extends Omit<
  ProductionWardenClientOptions,
  "env" | "start"
> {
  readonly env: NodeJS.ProcessEnv;
  readonly server: McpStdioLaunchConfig;
  readonly start: ProductionWardenStartOptions;
}

export interface ProductionWardenStartResolutionOptions {
  readonly moduleUrl?: string;
  readonly execPath?: string;
  readonly argv?: readonly string[];
  readonly exists?: (path: string) => boolean;
  readonly resolveImport?: (fromPath: string, specifier: string) => string;
  /** Test seam for the ADR-0040 single-file binary. Defaults to Bun runtime detection. */
  readonly compiledBinary?: boolean;
}

const GOVERNED_BASH_SPEC: ToolSpecT = {
  ...BASH_SPEC,
  description:
    "Run a shell command through the spawned keel warden. Policy, sandbox availability, and audit " +
    "are enforced by the warden.",
  parameters: governedBashParameters(BASH_SPEC.parameters),
};

function governedBashParameters(parameters: ToolSpecT["parameters"]): ToolSpecT["parameters"] {
  if (parameters === undefined) return undefined;
  const props = parameters["properties"];
  if (typeof props !== "object" || props === null || Array.isArray(props)) return parameters;
  const properties = { ...(props as Record<string, unknown>) };
  delete properties["lease"];
  delete properties["timeoutMs"];
  const required = Array.isArray(parameters["required"])
    ? parameters["required"].filter((item) => item !== "lease" && item !== "timeoutMs")
    : parameters["required"];
  return {
    ...parameters,
    properties,
    ...(required === undefined ? {} : { required }),
  };
}

function governedWorkspacePathParameters(
  parameters: ToolSpecT["parameters"],
  description: string,
): ToolSpecT["parameters"] {
  if (parameters === undefined) return undefined;
  const props = parameters["properties"];
  if (typeof props !== "object" || props === null || Array.isArray(props)) return parameters;
  const properties = { ...(props as Record<string, unknown>) };
  const pathProperty = properties["path"];
  if (typeof pathProperty === "object" && pathProperty !== null && !Array.isArray(pathProperty)) {
    properties["path"] = { ...(pathProperty as Record<string, unknown>), description };
  }
  return { ...parameters, properties };
}

const GOVERNED_READ_SPEC: ToolSpecT = {
  ...READ_SPEC,
  description:
    "Read a UTF-8 text file through the spawned keel warden. Policy, sandbox-profile checks, and " +
    "audit are enforced by the warden before file content is returned. Symlinks that resolve " +
    "outside the workspace remain denied in governed mode.",
  parameters: governedReadParameters(READ_SPEC.parameters),
};

function governedReadParameters(parameters: ToolSpecT["parameters"]): ToolSpecT["parameters"] {
  if (parameters === undefined) return undefined;
  const props = parameters["properties"];
  if (typeof props !== "object" || props === null || Array.isArray(props)) return parameters;
  const properties = { ...(props as Record<string, unknown>) };
  delete properties["followSymlink"];
  const pathProperty = properties["path"];
  if (typeof pathProperty === "object" && pathProperty !== null && !Array.isArray(pathProperty)) {
    properties["path"] = {
      ...(pathProperty as Record<string, unknown>),
      description: "Workspace-relative or absolute file path inside the workspace.",
    };
  }
  const required = Array.isArray(parameters["required"])
    ? parameters["required"].filter((item) => item !== "followSymlink")
    : parameters["required"];
  return {
    ...parameters,
    properties,
    ...(required === undefined ? {} : { required }),
  };
}
const GOVERNED_SEARCH_SPEC: ToolSpecT = {
  ...SEARCH_SPEC,
  description:
    "Search workspace files through the spawned keel warden. Policy, sandbox-profile checks, and " +
    "audit are enforced by the warden before matches are returned.",
};
const GOVERNED_WRITE_SPEC: ToolSpecT = {
  ...WRITE_SPEC,
  description:
    "Write a UTF-8 text file inside the workspace through the spawned keel warden. Policy, " +
    "sandbox-profile checks, and audit are enforced by the warden before the file is changed.",
  parameters: governedWorkspacePathParameters(
    WRITE_SPEC.parameters,
    "Workspace-relative or absolute file path inside the workspace.",
  ),
};
const GOVERNED_EDIT_SPEC: ToolSpecT = {
  ...EDIT_SPEC,
  description:
    "Edit a workspace file through the spawned keel warden. Policy, read-before-edit checks, and " +
    "audit are enforced by the warden before the file is changed.",
  parameters: governedWorkspacePathParameters(
    EDIT_SPEC.parameters,
    "Workspace-relative or absolute file path inside the workspace.",
  ),
};

export const wardenRuntimeTestInternals = {
  governedBashParameters,
  governedReadParameters,
  governedWorkspacePathParameters,
};
const GOVERNED_INTERACTIVE_CONSOLE_SPECS: readonly ToolSpecT[] = [
  {
    name: "interactive_console.open",
    description:
      "Open a configured interactive console target through host-side warden mediation. Target " +
      "review, sandbox/egress containment, redaction, and audit are enforced by the warden; " +
      "guest effects are not claimed as keel-governed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["targetId"],
      properties: {
        targetId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$",
        },
        rows: { type: "integer", minimum: 5, maximum: 120, default: 24 },
        cols: { type: "integer", minimum: 20, maximum: 240, default: 80 },
      },
    },
  },
  {
    name: "interactive_console.send_keys",
    description:
      "Send bounded structured key tokens to an opened interactive console through the warden. " +
      "The warden audits before delivery and does not expose raw control bytes as model authority.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["handle", "input"],
      properties: {
        handle: { type: "string", minLength: 1, maxLength: 128, pattern: "^con_[A-Za-z0-9_-]+$" },
        input: {
          type: "array",
          minItems: 1,
          maxItems: 128,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind"],
            description:
              "For text tokens use kind:'text' with text. For key tokens use kind:'key' with key.",
            properties: {
              kind: { enum: ["text", "key"] },
              text: { type: "string", minLength: 1, maxLength: 1024 },
              key: { enum: ["Enter", "Tab", "Backspace", "Escape", "C-c", "C-d"] },
            },
          },
        },
      },
    },
  },
  {
    name: "interactive_console.read_screen",
    description:
      "Read a bounded, redacted screen snapshot from an opened interactive console. Screen bytes " +
      "are untrusted tool output and are provenance-marked before model visibility.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["handle"],
      properties: {
        handle: { type: "string", minLength: 1, maxLength: 128, pattern: "^con_[A-Za-z0-9_-]+$" },
        maxBytes: { type: "integer", minimum: 1, maximum: 65536, default: 16384 },
      },
    },
  },
  {
    name: "interactive_console.release",
    description:
      "Release an opened interactive console target only when its reviewed target profile allows " +
      "persistence for an external grader. The warden audits the request and drops the handle only " +
      "when the broker confirms release; after confirmed release the process is no longer " +
      "warden-controlled.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["handle", "reason"],
      properties: {
        handle: { type: "string", minLength: 1, maxLength: 128, pattern: "^con_[A-Za-z0-9_-]+$" },
        reason: { enum: ["external-grader"] },
      },
    },
  },
  {
    name: "interactive_console.close",
    description:
      "Close an opened interactive console handle through the warden. Close is audited and bounded " +
      "to the warden-held target/session handle.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["handle"],
      properties: {
        handle: { type: "string", minLength: 1, maxLength: 128, pattern: "^con_[A-Za-z0-9_-]+$" },
        reason: { enum: ["user", "cleanup", "shutdown", "budget"] },
      },
    },
  },
];
const CONSOLE_TARGET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const INTERNAL_WARDEN_STDIO_ENV = "KEEL_INTERNAL_WARDEN_STDIO";
// Default per-tool RPC execute backstop when no eval-aware value is injected. Bash commands may run
// for 600s; this RPC timeout stays above that shell budget and below the 660s product-loop
// infrastructure deadline so wedged wardens still fail closed first. For a benchmark eval build the
// bash ceiling is raised (eval-executor-gate); `createProductionWardenRuntime` then receives an
// eval-aware `executeTimeoutMs` (= ceiling + 30s) so long commands are not clipped at 630s while the
// same `ceiling < warden RPC < kernel infra` ordering is preserved. Production stays 630s.
const PRODUCTION_WARDEN_EXECUTE_TIMEOUT_MS = 630_000;
const PRODUCTION_MCP_DISCOVERY_TIMEOUT_MS = 15_000;
const PRODUCTION_MCP_DISCOVERY_TERM_GRACE_MS = 1_000;
const PRODUCTION_MCP_DISCOVERY_GIVE_UP_MS = 2_000;
const PRODUCTION_MCP_DISCOVERY_MAX_OUTPUT_BYTES = 512_000;
const WARDEN_REINSTALL_RECOVERY =
  "reinstall Keel in the same package-manager scope, then rerun this command";
const PACKAGED_WARDEN_UNAVAILABLE =
  "packaged Warden unavailable — this Keel installation is incomplete, so governed execution " +
  "cannot start; " +
  WARDEN_REINSTALL_RECOVERY;
const PRODUCTION_WARDEN_UNAVAILABLE =
  "production Warden unavailable — this Keel installation is incomplete or unsupported, so " +
  "governed execution cannot start; " +
  WARDEN_REINSTALL_RECOVERY;

function runtimePlanApprovalEnvelope(
  envelope: PlanApprovalEnvelope | undefined,
  trustedWorkspace: boolean,
): PlanApprovalEnvelope | undefined {
  if (envelope === undefined) return undefined;
  return {
    ...envelope,
    trustedWorkspace: trustedWorkspace && envelope.trustedWorkspace === true,
  };
}

function selfEntrypointCommand(options: {
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly exists: (path: string) => boolean;
}): { command: string; args: readonly string[] } {
  const argvEntry = options.argv[1];
  if (argvEntry !== undefined && options.exists(argvEntry)) {
    return { command: options.execPath, args: [argvEntry] };
  }
  return { command: options.argv[0] ?? options.execPath, args: [] };
}

export function resolveProductionWardenStart(
  options: ProductionWardenStartResolutionOptions = {},
): ProductionWardenStartOptions {
  const exists = options.exists ?? existsSync;
  const execPath = options.execPath ?? process.execPath;
  const argv = options.argv ?? process.argv;
  const modulePath = fileURLToPath(options.moduleUrl ?? import.meta.url);
  const here = dirname(modulePath);
  const sourceBin = resolve(here, "../../../warden/src/bin-entry.ts");
  const runningFromSource = here.endsWith(`${sep}src${sep}warden`);
  if (runningFromSource && exists(sourceBin)) {
    const resolveImport =
      options.resolveImport ??
      ((fromPath, specifier) => createRequire(fromPath).resolve(specifier));
    const tsxLoader = pathToFileURL(resolveImport(sourceBin, "tsx/esm")).href;
    return {
      command: execPath,
      args: ["--import", tsxLoader, "--conditions=@keel/source", sourceBin],
    };
  }
  // The packaged carrier is resolved FIRST and returns-or-throws, so no later probe is reachable
  // from a published artifact. ADR-0082 requires a packaged `keel-kernel.mjs` to resolve only its
  // exact `keel-warden.mjs` sibling, never a project-relative path — and from
  // `<project>/node_modules/keel-harness/bin` the `distBin` probe below resolves to
  // `<project>/warden/dist/bin-entry.js`, which is inside the model-writable workspace.
  if (basename(modulePath) === "keel-kernel.mjs") {
    const packagedWarden = resolve(here, "keel-warden.mjs");
    if (!exists(packagedWarden)) {
      throw new Error(PACKAGED_WARDEN_UNAVAILABLE);
    }
    return { command: execPath, args: [packagedWarden] };
  }
  // Built in-repo output only. The layout guard mirrors `runningFromSource` above: without it this
  // probe walks out of whatever tree the kernel happens to sit in and spawns the first
  // `warden/dist/bin-entry.js` it finds as the process that decides policy.
  const runningFromDist = here.endsWith(`${sep}dist${sep}warden`);
  const distBin = resolve(here, "../../../warden/dist/bin-entry.js");
  if (runningFromDist && exists(distBin)) return { command: execPath, args: [distBin] };
  const compiledBinary = options.compiledBinary ?? process.versions["bun"] !== undefined;
  if (!compiledBinary) {
    throw new Error(PRODUCTION_WARDEN_UNAVAILABLE);
  }
  const self = selfEntrypointCommand({ execPath, argv, exists });
  return {
    ...self,
    env: { [INTERNAL_WARDEN_STDIO_ENV]: "1" },
  };
}

function auditDirFor(env: NodeJS.ProcessEnv, start?: ProductionWardenStartOptions): string {
  return (
    start?.env?.["KEEL_WARDEN_AUDIT_DIR"] ??
    env["KEEL_WARDEN_AUDIT_DIR"] ??
    join(keelHome(env), "audit")
  );
}

/** Resolve the exact per-process audit directory shared with the spawned Warden. Kept public to
 *  kernel internals so resume presentation reads the same location even when start.env overrides it. */
export function productionWardenAuditDir(
  env: NodeJS.ProcessEnv = process.env,
  start?: ProductionWardenStartOptions,
): string {
  return auditDirFor(env, start);
}

function localPrincipalFor(env: NodeJS.ProcessEnv, fallbackEnv: NodeJS.ProcessEnv): PrincipalT {
  return {
    osUser:
      env["USER"] ??
      env["LOGNAME"] ??
      env["USERNAME"] ??
      fallbackEnv["USER"] ??
      fallbackEnv["LOGNAME"] ??
      fallbackEnv["USERNAME"] ??
      "unknown",
    configuredId: null,
    authProvider: "local",
    assurance: "local-os-user",
  };
}

function credentialProxyChildEnv(
  options: ProductionWardenClientOptions,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  // Operator config (either var already present) takes precedence and suppresses the project file, so
  // a project config never shadows or duplicates operator rules.
  if (
    env[CREDENTIAL_PROXY_CONFIG_ENV] !== undefined ||
    env[CREDENTIAL_PROXY_PROJECT_CONFIG_ENV] !== undefined
  ) {
    return {};
  }
  const reader = new ProjectReader(defaultProjectFs(), {
    trusted: options.workspaceTrusted === true,
  });
  const raw = reader.readFile(join(options.cwd, CREDENTIAL_PROXY_PROJECT_CONFIG_PATH));
  // Forward the model-writable workspace config through the PROJECT var, so the warden parses it under
  // restricted `project` provenance and never mistakes it for trusted operator config.
  return raw === undefined ? {} : { [CREDENTIAL_PROXY_PROJECT_CONFIG_ENV]: raw };
}

function lifecycleManifestChildEnv(
  options: ProductionWardenClientOptions,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (env[LIFECYCLE_MANIFEST_CONFIG_ENV] !== undefined) return {};
  const reader = new ProjectReader(defaultProjectFs(), {
    trusted: options.workspaceTrusted === true,
  });
  const loaded = loadLifecycleManifestFromProjectReader(reader, options.cwd);
  return loaded.kind === "loaded"
    ? { [LIFECYCLE_MANIFEST_CONFIG_ENV]: lifecycleManifestEnvValue(loaded) }
    : {};
}

function loadedLifecycleManifestFor(
  options: ProductionWardenClientOptions,
): LifecycleManifestT | undefined {
  const reader = new ProjectReader(defaultProjectFs(), {
    trusted: options.workspaceTrusted === true,
  });
  const loaded = loadLifecycleManifestFromProjectReader(reader, options.cwd);
  return loaded.kind === "loaded" ? loaded.manifest : undefined;
}

function lifecycleToolsFor(manifest: LifecycleManifestT | undefined): readonly ToolSpecT[] {
  return manifest !== undefined ? [lifecycleToolSpecForManifest(manifest)] : [];
}

function governedTypedToolsFor(options: ProductionWardenClientOptions): readonly ToolSpecT[] {
  return options.workspaceTrusted === true
    ? [GOVERNED_READ_SPEC, GOVERNED_SEARCH_SPEC, GOVERNED_WRITE_SPEC, GOVERNED_EDIT_SPEC]
    : [];
}

function governedInteractiveConsoleToolsFor(
  options: ProductionWardenClientOptions,
  capabilities: readonly string[],
): readonly ToolSpecT[] {
  if (options.workspaceTrusted !== true || !capabilities.includes(INTERACTIVE_CONSOLE_CAPABILITY)) {
    return [];
  }
  return interactiveConsoleSpecsWithTargets(interactiveConsoleTargetIds(capabilities));
}

function interactiveConsoleTargetIds(capabilities: readonly string[]): readonly string[] {
  const targetIds = new Set<string>();
  for (const capability of capabilities) {
    if (!capability.startsWith(INTERACTIVE_CONSOLE_TARGET_CAPABILITY_PREFIX)) continue;
    const targetId = capability.slice(INTERACTIVE_CONSOLE_TARGET_CAPABILITY_PREFIX.length);
    if (CONSOLE_TARGET_ID_RE.test(targetId)) targetIds.add(targetId);
  }
  return [...targetIds].sort();
}

function interactiveConsoleSpecsWithTargets(targetIds: readonly string[]): readonly ToolSpecT[] {
  if (targetIds.length === 0) return GOVERNED_INTERACTIVE_CONSOLE_SPECS;
  const [openSpec, ...rest] = GOVERNED_INTERACTIVE_CONSOLE_SPECS;
  if (openSpec === undefined) return GOVERNED_INTERACTIVE_CONSOLE_SPECS;
  const parameters = openSpec.parameters;
  const properties =
    typeof parameters?.["properties"] === "object" &&
    parameters["properties"] !== null &&
    !Array.isArray(parameters["properties"])
      ? (parameters["properties"] as Record<string, unknown>)
      : undefined;
  const targetId =
    typeof properties?.["targetId"] === "object" &&
    properties["targetId"] !== null &&
    !Array.isArray(properties["targetId"])
      ? (properties["targetId"] as Record<string, unknown>)
      : undefined;
  if (parameters === undefined || properties === undefined || targetId === undefined) {
    return GOVERNED_INTERACTIVE_CONSOLE_SPECS;
  }
  return [
    {
      ...openSpec,
      description: `${openSpec.description} Configured targetIds: ${targetIds.join(", ")}.`,
      parameters: {
        ...parameters,
        properties: {
          ...properties,
          targetId: { ...targetId, enum: [...targetIds] },
        },
      },
    },
    ...rest,
  ];
}

function governedMcpToolsFor(options: ProductionWardenClientOptions): readonly ToolSpecT[] {
  return options.workspaceTrusted === true
    ? advertisedMcpToolSpecs({ workspaceRoot: options.cwd, env: options.env ?? process.env })
    : [];
}

function searchChildEnv(
  options: ProductionWardenClientOptions,
  env: NodeJS.ProcessEnv,
  start: ProductionWardenStartOptions | undefined,
): NodeJS.ProcessEnv {
  const effectiveEnv = { ...env, ...start?.env };
  const override = effectiveEnv["KEEL_RG_PATH"];
  if (override !== undefined && override !== "") return {};
  const compiledBinary =
    process.versions["bun"] !== undefined || start?.env?.[INTERNAL_WARDEN_STDIO_ENV] === "1";
  return { KEEL_RG_PATH: resolveRgPath(effectiveEnv, undefined, undefined, compiledBinary) ?? "" };
}

/** Build the warden child process's environment. Exported for the P1-11 test that pins the resolved
 *  `KEEL_HOME` injection (a pure function of its inputs). */
export function childEnvFor(
  options: ProductionWardenClientOptions,
  start: ProductionWardenStartOptions | undefined,
): NodeJS.ProcessEnv {
  const env = options.env ?? process.env;
  const auditDir = auditDirFor(env, start);
  const mergedEnv = { ...env, ...start?.env };
  return {
    ...mergedEnv,
    ...credentialProxyChildEnv(options, mergedEnv),
    ...lifecycleManifestChildEnv(options, mergedEnv),
    ...mcpTrustedServersChildEnv({
      workspaceRoot: options.cwd,
      env: mergedEnv,
      workspaceTrusted: options.workspaceTrusted === true,
    }),
    ...searchChildEnv(options, env, start),
    // Pass the kernel's RESOLVED absolute keel home to the warden (P1-11) so the warden never
    // re-resolves a relative/unset KEEL_HOME against its own (possibly different) cwd/HOME — the two
    // processes must agree byte-for-byte on where grants, trust, and the audit chain live. keelHome is
    // idempotent on an absolute value, so the warden's own resolution is a no-op. Resolved from
    // mergedEnv so a `start.env.KEEL_HOME` override is honored, matching KEEL_WARDEN_AUDIT_DIR below.
    KEEL_HOME: keelHome(mergedEnv),
    KEEL_WARDEN_WORKSPACE_ROOT: options.cwd,
    KEEL_WARDEN_AUDIT_DIR: auditDir,
    KEEL_WARDEN_WORKSPACE_TRUSTED: options.workspaceTrusted === true ? "1" : "0",
    KEEL_WARDEN_SANDBOX: start?.env?.["KEEL_WARDEN_SANDBOX"] ?? env["KEEL_WARDEN_SANDBOX"] ?? "srt",
  };
}

export async function startProductionWardenClient(
  options: ProductionWardenClientOptions,
): Promise<StartedWardenClient> {
  const start = options.start ?? resolveProductionWardenStart();
  await mkdir(auditDirFor(options.env ?? process.env, start), { recursive: true, mode: 0o700 });
  return await startWardenClient({
    command: start.command,
    args: [...start.args],
    cwd: options.cwd,
    env: childEnvFor(options, start),
    kernelVersion: KEEL_VERSION,
    ...(options.start?.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.start.requestTimeoutMs }),
  });
}

function encodeMcpDiscoveryRequest(server: McpStdioLaunchConfig): string {
  return Buffer.from(JSON.stringify({ server }), "utf8").toString("base64");
}

function assertWardenEntrypointForMcpDiscovery(start: ProductionWardenStartOptions): void {
  const selfEntrypoint =
    start.env?.[INTERNAL_WARDEN_STDIO_ENV] === "1" ||
    [start.command, ...start.args].some((entry) =>
      /packages[/\\]kernel[/\\](src|dist)[/\\]cli[/\\]bin\.(ts|js)$/u.test(entry),
    );
  if (selfEntrypoint) {
    throw new Error(
      "MCP discovery requires a warden entrypoint; the kernel self-entrypoint fallback cannot run hidden MCP discovery",
    );
  }
}

function capChildOutput(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return Buffer.from(next, "utf8")
    .subarray(0, PRODUCTION_MCP_DISCOVERY_MAX_OUTPUT_BYTES)
    .toString("utf8");
}

function safeMcpDiscoveryOutput(value: string): string {
  let output = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x1b && value[i + 1] === "[") {
      i += 2;
      while (i < value.length) {
        const finalCode = value.charCodeAt(i);
        if (finalCode >= 0x40 && finalCode <= 0x7e) break;
        i += 1;
      }
      continue;
    }
    output += code <= 0x1f || code === 0x7f ? " " : value.charAt(i);
  }
  return output.replace(/\s+/gu, " ").trim();
}

export async function discoverProductionMcpServer(
  options: ProductionMcpDiscoveryOptions,
): Promise<McpDiscoveryResult> {
  const start = options.start;
  assertWardenEntrypointForMcpDiscovery(start);
  const env = options.env;
  const startEnv = start.env ?? {};
  const mergedEnv = { ...env, ...startEnv };
  const auditDir = auditDirFor(env, start);
  // Owner-only from the start. The warden re-asserts this when it opens a session chain (the mode
  // here is a no-op for a directory that already exists), but the kernel is what creates it first,
  // so leaving it at the umask is what made existing installs 0755.
  await mkdir(auditDir, { recursive: true, mode: 0o700 });
  // Unlike startWardenClient, this spawn passes childEnv directly and never re-spreads process.env;
  // preserving the base env's sentinels across the merge and restoring here is therefore the final
  // ADR-0083 spawn boundary.
  const childEnv: NodeJS.ProcessEnv = mergeAndRestoreHostNodeEnv(env, {
    ...startEnv,
    ...credentialProxyChildEnv(
      { cwd: options.cwd, env: mergedEnv, workspaceTrusted: true },
      mergedEnv,
    ),
    [INTERNAL_MCP_DISCOVERY_ENV]: "1",
    [MCP_DISCOVERY_REQUEST_ENV]: encodeMcpDiscoveryRequest(options.server),
    KEEL_WARDEN_WORKSPACE_ROOT: options.cwd,
    KEEL_WARDEN_AUDIT_DIR: auditDir,
    KEEL_WARDEN_WORKSPACE_TRUSTED: options.workspaceTrusted === false ? "0" : "1",
    KEEL_WARDEN_SANDBOX: startEnv["KEEL_WARDEN_SANDBOX"] ?? env["KEEL_WARDEN_SANDBOX"] ?? "srt",
  });

  return await new Promise<McpDiscoveryResult>((resolvePromise, reject) => {
    const child = spawn(start.command, [...start.args], {
      cwd: options.cwd,
      env: childEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let leaderClosed = false;
    let directKillOnly = false;
    let cleanupStarted = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let giveUpTimer: NodeJS.Timeout | undefined;
    let cleanupPollTimer: NodeJS.Timeout | undefined;
    type Completion =
      | { readonly result: McpDiscoveryResult; readonly error?: never }
      | { readonly error: Error; readonly result?: never };
    const timeoutError = () => new Error("MCP discovery timed out");
    const clearTimers = () => {
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (giveUpTimer !== undefined) clearTimeout(giveUpTimer);
      if (cleanupPollTimer !== undefined) clearTimeout(cleanupPollTimer);
    };
    const settleOnce = (completion: Completion) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (completion.error !== undefined) reject(completion.error);
      else resolvePromise(completion.result);
    };
    const killChild = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        directKillOnly = true;
        child.kill(signal);
      }
    };
    const processGroupExists = (): boolean => {
      if (directKillOnly) return !leaderClosed;
      try {
        process.kill(-child.pid!, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const finishAfterCleanup = (completion: Completion) => {
      if (settled || cleanupStarted) return;
      cleanupStarted = true;
      clearTimeout(timer);
      const pollCleanup = () => {
        if (settled) return;
        if (!processGroupExists()) {
          settleOnce(completion);
          return;
        }
        cleanupPollTimer = setTimeout(pollCleanup, 25);
      };
      killChild("SIGTERM");
      cleanupPollTimer = setTimeout(pollCleanup, 25);
      forceTimer = setTimeout(() => {
        killChild("SIGKILL");
        pollCleanup();
      }, PRODUCTION_MCP_DISCOVERY_TERM_GRACE_MS);
      giveUpTimer = setTimeout(() => {
        killChild("SIGKILL");
        settleOnce({
          error: new Error(
            `${completion.error?.message ?? "MCP discovery completed"}; process-group cleanup did not complete`,
          ),
        });
      }, PRODUCTION_MCP_DISCOVERY_GIVE_UP_MS);
    };
    const timer = setTimeout(() => {
      finishAfterCleanup({ error: timeoutError() });
    }, start.requestTimeoutMs ?? PRODUCTION_MCP_DISCOVERY_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = capChildOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = capChildOutput(stderr, chunk);
    });
    child.once("error", (error) => {
      leaderClosed = true;
      finishAfterCleanup({ error });
    });
    child.once("close", (code, signal) => {
      leaderClosed = true;
      if (cleanupStarted) return;
      if (code !== 0) {
        finishAfterCleanup({
          error: new Error(
            `MCP discovery failed: ${safeMcpDiscoveryOutput(
              stderr.trim() || stdout.trim() || String(signal ?? code),
            )}`,
          ),
        });
        return;
      }
      try {
        finishAfterCleanup({ result: parseMcpDiscoveryResult(JSON.parse(stdout)) });
      } catch (error) {
        finishAfterCleanup({ error: new Error(safeMcpDiscoveryOutput(String(error))) });
      }
    });
  });
}

export async function shutdownProductionWarden(client: StartedWardenClient): Promise<void> {
  try {
    await client.call("warden.shutdown", {});
  } catch {
    // A dead or wedged warden is already a fail-closed state; close still reaps the child.
  } finally {
    await client.close();
  }
}

export async function createProductionWardenRuntime(
  options: ProductionWardenRuntimeOptions,
): Promise<ProductionWardenRuntime> {
  if (options.autonomy !== undefined && options.planApproval !== undefined) {
    throw new Error("ProductionWardenRuntime cannot combine autonomy posture with a plan approval");
  }
  const client = await startProductionWardenClient(options);
  try {
    try {
      await client.call("warden.audit.append", {
        event: { eventType: "session.start", payload: { sessionId: options.sessionId } },
      });
    } catch (error) {
      const details =
        error instanceof WardenClientError &&
        typeof error.details === "object" &&
        error.details !== null &&
        !Array.isArray(error.details)
          ? (error.details as Record<string, unknown>)
          : undefined;
      const lockState = details?.["auditWriterLockState"];
      if (
        error instanceof WardenClientError &&
        error.code === "AUDIT_WRITE_FAILED" &&
        (lockState === "active" || lockState === "indeterminate")
      ) {
        if (lockState === "active") {
          const recovery =
            options.resumeCommand === undefined
              ? "retry the original Keel command"
              : `run ${options.resumeCommand}`;
          throw new Error(
            `session ${options.sessionId} is already active in another Keel process. ` +
              `Exit that Keel process cleanly, then ${recovery}; no model call was made and the audit lock was not changed.`,
          );
        }
        throw new Error(
          `session ${options.sessionId} audit-writer ownership is indeterminate. ` +
            "Start a fresh session with keel; no model call was made and the existing audit lock was not changed.",
        );
      }
      throw error;
    }
    let status = await client.call("warden.status", {});
    const trustedWorkspace = options.workspaceTrusted === true;
    const autonomy = resolveAutonomyPosture(options.autonomy, { trustedWorkspace });
    const planApproval = runtimePlanApprovalEnvelope(options.planApproval, trustedWorkspace);
    const planApprovalSummary =
      planApproval === undefined ? undefined : summarizePlanApprovalEnvelope(planApproval);
    const modeChangeEvent = buildModeChangeAuditEvent({
      previousMode: "guided",
      resolved: autonomy,
      sessionId: options.sessionId,
      trustedWorkspace,
      workspaceRoot: options.cwd,
    });
    if (modeChangeEvent !== undefined) {
      await client.call("warden.audit.append", { event: modeChangeEvent });
      status = await client.call("warden.status", {});
    }
    const view = wardenStatusViewConfig(status, {
      autonomy,
      wardenCapabilities: client.hello.capabilities,
      ...(planApprovalSummary === undefined ? {} : { planApprovalSummary }),
    });
    const executorAutonomy = canRouteAutopilotReviews(view, autonomy) ? autonomy : undefined;
    const executorPlanApproval = canRoutePlanApprovalReviews(view, planApprovalSummary)
      ? planApproval
      : undefined;
    const lifecycleManifest = loadedLifecycleManifestFor(options);
    // Always retain local principal identity so an unhandled review can be explicitly closed as a
    // denial. This does not grant authority; it prevents abandoned pending authority from surviving
    // after the UI reports the result terminal.
    const principal = localPrincipalFor(options.env ?? process.env, process.env);
    const mutationPresentationAvailable = client.hello.capabilities.includes(
      MUTATION_PRESENTATION_CAPABILITY_V1,
    );
    const processRunAvailable =
      trustedWorkspace && client.hello.capabilities.includes(PROCESS_RUN_CAPABILITY_V1);
    const gitPushAvailable =
      trustedWorkspace && client.hello.capabilities.includes(GIT_PUSH_CAPABILITY_V1);
    const executor = new WardenExecutor({
      client,
      sessionId: options.sessionId,
      ...(executorAutonomy === undefined ? {} : { autonomy: executorAutonomy }),
      ...(executorPlanApproval === undefined ? {} : { planApproval: executorPlanApproval }),
      principal,
      executeTimeoutMs: options.executeTimeoutMs ?? PRODUCTION_WARDEN_EXECUTE_TIMEOUT_MS,
      processRunAvailable,
      ...(options.onReviewAutoResolved === undefined
        ? {}
        : { onReviewAutoResolved: options.onReviewAutoResolved }),
      ...(options.onReviewRequired === undefined
        ? {}
        : { onReviewRequired: options.onReviewRequired }),
      ...(mutationPresentationAvailable
        ? {
            takeMutationPresentation: (params, callOptions) =>
              client.call(
                "warden.presentation.take",
                params,
                callOptions?.timeoutMs === undefined
                  ? undefined
                  : { timeoutMs: callOptions.timeoutMs },
              ),
          }
        : {}),
      onMcpQuarantine: (event) => {
        quarantineMcpTrustedServerBySlug(
          {
            workspaceRoot: options.cwd,
            serverSlug: event.serverId,
            expectedPin: event.expectedPin,
            reason: "pin-mismatch",
            ...(event.observedPin === undefined ? {} : { observedPin: event.observedPin }),
          },
          options.env ?? process.env,
        );
      },
    });
    return {
      executor,
      tools: [
        GOVERNED_BASH_SPEC,
        ...(processRunAvailable ? [PROCESS_RUN_SPEC] : []),
        ...(gitPushAvailable ? [GIT_PUSH_SPEC] : []),
        ...governedTypedToolsFor(options),
        ...governedInteractiveConsoleToolsFor(options, client.hello.capabilities),
        ...lifecycleToolsFor(lifecycleManifest),
        ...governedMcpToolsFor(options),
      ],
      isMutating: (name: string) =>
        name === "bash" ||
        name === PROCESS_RUN_TOOL_NAME ||
        name === GIT_PUSH_TOOL_NAME ||
        name === "write" ||
        name === "edit" ||
        name === "lifecycle.run" ||
        name.startsWith("interactive_console.") ||
        name.startsWith("mcp__"),
      view,
      // Route liveness through the executor's probe so the production halt path uses the same tested
      // seam as the executor's own coverage (client.isClosed() → executor.enforcementAvailable()).
      wardenAvailable: () => executor.enforcementAvailable(),
      ...(planApprovalSummary === undefined ? {} : { planApprovalSummary }),
      ...(lifecycleManifest !== undefined ? { lifecycleManifest } : {}),
      dispose: () => shutdownProductionWarden(client),
    };
  } catch (error) {
    await shutdownProductionWarden(client);
    throw error;
  }
}

export async function exportAuditSession(
  options: AuditExportCommandOptions,
): Promise<{ bundlePath: string; rootHash: string }> {
  const client = await startProductionWardenClient(options);
  try {
    return await client.call("warden.audit.export", {
      sessionId: options.sessionId,
      outPath: options.outPath,
    });
  } finally {
    await shutdownProductionWarden(client);
  }
}
