import { readFileSync } from "node:fs";
import {
  type ExecutorPort,
  type ModelPort,
  Recording,
  type SessionEventT,
  type ToolSpecT,
} from "@keel/shared";
import { LocalExecutor } from "../local-executor.js";
import {
  RecordedModelPort,
  createAnthropicModelPort,
  createGoogleModelPort,
  createOpenAICompatibleModelPort,
  createOpenAIModelPort,
} from "../providers/index.js";
// Single source of truth for the provider id — defined with the capability table (where a new
// provider is added). Re-exported below so existing `runtime.js` importers (auth.ts, index.ts) are
// unaffected, and a forker adding a provider edits ONE union, not two (SF-2).
import type { ProviderId } from "../providers/capabilities.js";
import type { CacheTtl } from "../providers/index.js";
import type { SkillRegistry } from "../context/skills.js";
import { type SecretStore, defaultSecretStore } from "../secrets/secret-store.js";
import { keelHome } from "../session/paths.js";
import type {
  ProcessLease,
  ProcessLeaseCleanupResult,
  ProcessLeaseScope,
} from "../tools/process-lease.js";
import {
  EVAL_DIRECT_EXEC_BANNER,
  EVAL_EXTRA_ROOTS_BANNER_PREFIX,
  resolveEvalBashMaxTimeoutMs,
  resolveEvalDeniedRoots,
  resolveEvalExtraRoots,
} from "./eval-executor-gate.js";
import type { ProductionWardenRuntime } from "../warden/runtime.js";
import {
  PipeShellSession,
  Workspace,
  coreToolSpecs,
  createCoreTools,
  createPlanTool,
  createSkillTool,
  isMutatingStaticCapability,
  registerCoreTools,
} from "../tools/index.js";
import { createRetrieveTool } from "../tools/retrieve.js";

/** A keel-supported model provider — re-exported from the capability table (its single home). */
export type { ProviderId };

/** Resolved model selection for a run. The API key is resolved separately by `resolveApiKey` (the
 *  `0600` secret store, then the provider env var — Epic 1.9), not carried here; the model id is
 *  pinned/overridable, never inferred from the network. `baseURL` is required only for
 *  `openai-compatible` (the local/compatible endpoint). */
export interface ModelConfig {
  readonly provider: ProviderId;
  readonly model: string;
  readonly baseURL?: string;
  /** Ephemeral cache TTL from `KEEL_CACHE_TTL` (`"5m"` | `"1h"`); omitted → `"5m"` default. Takes
   *  effect only for the `anthropic-breakpoint` strategy (other providers ignore it). See ADR-0052. */
  readonly cacheTtl?: CacheTtl;
}

export const PROVIDERS: readonly ProviderId[] = [
  "anthropic",
  "openai",
  "google",
  "openai-compatible",
];

/** The one pinned default (OQ-3/ADR-0022); other providers must name a model via `KEEL_MODEL`
 *  (keel never silently picks a model for a provider it has not pinned). */
const DEFAULT_MODEL: Partial<Record<ProviderId, string>> = { anthropic: "claude-sonnet-4-6" };

/**
 * Resolve which provider + model to run from the environment: `KEEL_PROVIDER` (default `anthropic`)
 * and `KEEL_MODEL` (default: the pinned Anthropic Sonnet; required for any other provider). Pure —
 * the key itself is read by the SDK from its own env var (e.g. `ANTHROPIC_API_KEY`).
 */
export function resolveModelConfig(env: NodeJS.ProcessEnv): ModelConfig {
  const provider = (env["KEEL_PROVIDER"] ?? "anthropic") as ProviderId;
  if (!PROVIDERS.includes(provider)) {
    throw new Error(
      `keel: unknown KEEL_PROVIDER "${provider}" (expected one of ${PROVIDERS.join(", ")})`,
    );
  }
  const model = env["KEEL_MODEL"] ?? DEFAULT_MODEL[provider];
  if (model === undefined) {
    throw new Error(`keel: set KEEL_MODEL — no pinned default model for provider "${provider}"`);
  }
  const baseURL = env["KEEL_BASE_URL"];
  if (provider === "openai-compatible" && baseURL === undefined) {
    throw new Error(
      "keel: set KEEL_BASE_URL for the openai-compatible provider (the endpoint URL)",
    );
  }
  // Cache TTL lever (ADR-0052): default 5m (omit). `1h` keeps the cached prefix alive across long tool
  // turns / idle gaps that would expire a 5-minute entry. Validate explicitly — a typo must fail loudly,
  // not silently fall back to 5m (a silent cost-behavior surprise). Only affects the anthropic strategy.
  const cacheTtl = env["KEEL_CACHE_TTL"];
  if (cacheTtl !== undefined && cacheTtl !== "5m" && cacheTtl !== "1h") {
    throw new Error(`keel: KEEL_CACHE_TTL must be "5m" or "1h" (got "${cacheTtl}")`);
  }
  // After the guard, control-flow narrows `cacheTtl` to `CacheTtl | undefined` (no assertion needed).
  return {
    provider,
    model,
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(cacheTtl !== undefined ? { cacheTtl } : {}),
  };
}

/** Provider → the env var its SDK reads the API key from (the fallback after the `0600` file store). */
export const PROVIDER_KEY_ENV: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
};

/**
 * Resolve a provider's API key (Epic 1.9): the `0600` secret store first, then the provider's env var
 * (CI/dev). `store` is injectable for tests; production uses the file store. An empty/whitespace value
 * is treated as absent (so a blank stored key never masks a valid env var). Returns `undefined` when no
 * usable key is found (the bin then points the user at `keel auth`).
 */
export function resolveApiKey(
  provider: ProviderId,
  env: NodeJS.ProcessEnv,
  store: SecretStore = defaultSecretStore(env),
): string | undefined {
  for (const candidate of [store.get(provider), env[PROVIDER_KEY_ENV[provider]]]) {
    const key = candidate?.trim();
    // Return the TRIMMED key — a stored/env value with a trailing newline (common from `echo … >`
    // or a here-doc) would otherwise corrupt the Authorization header (REL-6, Epic 1.9 QC).
    if (key !== undefined && key !== "") return key;
  }
  return undefined;
}

/**
 * Build a real `ModelPort` from a resolved config (Epic 1.6a Step 2). No network at construction —
 * the provider HTTP request is only issued when `stream()` runs. `apiKey` is the resolved key (Epic 1.9
 * `0600` file store / env); when omitted the factory falls through to the SDK's own env default. Provider
 * failover is never automatic (§ Epic 1.3 — explicit user switch only).
 */
export function createModelPort(config: ModelConfig, apiKey?: string): ModelPort {
  const key = apiKey !== undefined ? { apiKey } : {};
  switch (config.provider) {
    case "anthropic":
      return createAnthropicModelPort({
        model: config.model,
        ...key,
        // The cache-TTL lever only affects the anthropic-breakpoint strategy; other providers ignore it.
        ...(config.cacheTtl !== undefined ? { cacheTtl: config.cacheTtl } : {}),
      });
    case "openai":
      return createOpenAIModelPort({ model: config.model, ...key });
    case "google":
      return createGoogleModelPort({ model: config.model, ...key });
    case "openai-compatible":
      if (config.baseURL === undefined) {
        throw new Error("keel: openai-compatible requires a baseURL (set KEEL_BASE_URL)");
      }
      return createOpenAICompatibleModelPort({
        model: config.model,
        baseURL: config.baseURL,
        ...key,
      });
  }
}

/**
 * Build a `ModelPort` that replays a committed `Recording` (ADR-0031) — **deterministic, offline,
 * no API key, no network**. Drives the headless one-task smoke (Epic 1.10 `keel run --replay`) and
 * offline repro/demos through the real loop. Reads + parses the file, failing with a one-line typed
 * error (the bin surfaces it as `keel: <msg>`); the recording is **inert data** — `Recording.parse`
 * validates shape, nothing in it is executed.
 */
export function createReplayModelPort(file: string): ModelPort {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`replay: cannot read recording file ${file}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`replay: ${file} is not valid JSON`);
  }
  const parsed = Recording.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `replay: ${file} is not a valid recording (does not match the Recording schema)`,
    );
  }
  return new RecordedModelPort(parsed.data);
}

/** The assembled tool side of a keel run: a `LocalExecutor` with the five core tools + the `plan`
 *  task-ledger tool registered, the `ToolSpec`s to advertise to the model, `dispose()` to release the
 *  shell session, and an explicit lease cleanup phase for verifier-handoff work. */
export interface ToolRuntime {
  readonly executor: ExecutorPort;
  readonly tools: readonly ToolSpecT[];
  /** Whether a tool name is a *mutating* action, derived from each tool's `staticCapability`
   *  (ADR-0024) — threaded to the runner's §4.10 urgent-steering boundary so it tracks the real
   *  capability taxonomy, not a duplicated name list. (Property, not a method, so it can be passed by
   *  reference without an unbound-`this` hazard.) */
  readonly isMutating: (name: string) => boolean;
  /** Release the shell session (kills its process group). Call in the entrypoint's `finally`. */
  dispose(): Promise<void>;
  /** Snapshot of intentionally preserved local leases for dynamic liveness acceptance checks. */
  activeLeases(): readonly ProcessLease[];
  /** Cleanup intentionally preserved service/job leases after any external verifier handoff finishes. */
  cleanupLeases(scope?: ProcessLeaseScope): Promise<ProcessLeaseCleanupResult[]>;
}

/**
 * Build the real local tool runtime for a workspace (Epic 1.6a): a `Workspace` (path containment —
 * the kernel-level precursor to the Phase-2 sandbox), a `PipeShellSession` (real `bash`), the five
 * core tools wired over them, and a `LocalExecutor` with their handlers registered. The executor is
 * **honest-YOLO** — no sandbox, no policy, no audit (the warden replaces it behind `ExecutorPort` in
 * Phase 2); `bash` runs a real, unsandboxed shell. Keys/provider construction is the model side
 * (Step 2 / the bin); this is only the tool side, so it is fully hermetic + testable.
 */
export function createToolRuntime(opts: {
  cwd: string;
  /** The post-trust skill registry (Epic 1.7). When present with discovered skills, the declarative
   *  `skill` tool is advertised so the model can load a skill's body on demand. Omitted → no skills. */
  skillRegistry?: SkillRegistry;
  /** Environment for resolving `keelHome` (Epic 1.9) — the keel config dir is denied to the typed
   *  tools even when inside the workspace (§3.2(6) config-dir guard). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Reads the live session ledger for the just-in-time `retrieve` tool (Epic 1.6c PR-d slice 5). When
   *  present, `retrieve` is advertised so the model can re-fetch the full output of a compressed tool
   *  result (`retrieve(ref=…)`). The entrypoint supplies it ONLY when compaction is on, so a run with
   *  compaction off advertises the unchanged tool set (flip OFF = zero behavior change). */
  readEvents?: () => readonly SessionEventT[];
  /** Operator/transcript sink for eval-only root expansion warnings. Defaults to stderr. */
  emit?: (line: string) => void;
  /** EVAL-ONLY. Auto-promote a safely-rewritable backgrounded server to a verifier-handoff lease so
   *  it survives into the separate verifier process. Set ONLY by {@link createEvalDirectRuntime}
   *  (itself build/run-time-gated); production keeps its no-orphans teardown + advisory-only hint. */
  autoLeaseBackgroundedServices?: boolean;
}): ToolRuntime {
  // The keel config dir is off-limits to the typed file tools (read/write/edit/search) even when it
  // sits inside the workspace — this in-process guard is independent of the runtime's OS sandbox.
  const env = opts.env ?? process.env;
  const evalExtraRoots = resolveEvalExtraRoots(env);
  if (evalExtraRoots.length > 0) {
    const emit = opts.emit ?? ((line: string) => void process.stderr.write(line));
    emit(
      `${EVAL_EXTRA_ROOTS_BANNER_PREFIX}: ${evalExtraRoots
        .map((r) => `${r.root} [${r.source}; ${r.allow.join("+")}]`)
        .join(", ")}\n`,
    );
  }
  const deniedRoots = [keelHome(env), ...resolveEvalDeniedRoots(env)];
  const workspace = new Workspace(opts.cwd, {
    deniedRoots,
    extraRoots: evalExtraRoots,
  });
  const evalBashMaxTimeoutMs = resolveEvalBashMaxTimeoutMs(env);
  const session = new PipeShellSession({
    cwd: workspace.root,
    ...(evalBashMaxTimeoutMs !== undefined ? { maxTimeoutMs: evalBashMaxTimeoutMs } : {}),
  });
  // The five core tools + the `plan` task-ledger tool (§4.9.7 / §8.6) — a side-effect-free attention
  // anchor advertised alongside them so the model can maintain a plan that survives compaction.
  const tools = [
    ...createCoreTools(workspace, session, {
      ...(evalBashMaxTimeoutMs !== undefined ? { bashMaxTimeoutMs: evalBashMaxTimeoutMs } : {}),
      ...(opts.autoLeaseBackgroundedServices === true
        ? { autoLeaseBackgroundedServices: true }
        : {}),
    }),
    createPlanTool(),
  ];
  // The declarative `skill` tool (Epic 1.7 / ADR-0026) — added only when skills were discovered
  // post-trust, so an untrusted/declined or skill-less workspace advertises no skill surface.
  if (opts.skillRegistry !== undefined && opts.skillRegistry.stubs.length > 0) {
    tools.push(createSkillTool(opts.skillRegistry));
  }
  // The just-in-time `retrieve` tool (Epic 1.6c PR-d slice 5) — advertised only when the entrypoint
  // supplies a ledger reader (i.e. compaction is on), so the compression note's `retrieve(ref=…)`
  // citation is honest and a compaction-off run's tool set is unchanged.
  if (opts.readEvents !== undefined) {
    tools.push(createRetrieveTool(opts.readEvents));
  }
  const executor = new LocalExecutor();
  registerCoreTools(executor, tools);
  // The mutating-tool set is derived from each tool's declared shared capability envelope (ADR-0024), so
  // a new write/network/broad tool is gated by the urgent-steering boundary automatically — no name list
  // to keep in sync (CAP-1).
  const mutating = new Set(
    tools.filter((t) => isMutatingStaticCapability(t.staticCapability)).map((t) => t.spec.name),
  );
  return {
    executor,
    tools: coreToolSpecs(tools),
    isMutating: (name: string) => mutating.has(name),
    dispose: () => session.dispose(),
    activeLeases: () => session.activeLeases(),
    cleanupLeases: (scope) => session.cleanupLeases(scope),
  };
}

/**
 * Eval-ONLY runtime: a {@link ProductionWardenRuntime}-shaped runtime backed by the in-process
 * `LocalExecutor` (NO warden · NO sandbox · NO policy · NO audit). It is reached ONLY when BOTH the
 * build-time and runtime gates in `eval-executor-gate.ts` hold — a release binary can never call it.
 * Used for benchmarks where the disposable, isolated container is already the sandbox (and where the
 * warden's `bubblewrap` tier cannot create namespaces anyway). Honest by construction: it prints the
 * no-enforcement banner and reports the explicit deliberately-unenforced route plus an all-off HUD.
 */
export function createEvalDirectRuntime(opts: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  readEvents?: () => readonly SessionEventT[];
  /** Injectable sink for the banner; defaults to real stderr. */
  emit?: (line: string) => void;
}): ProductionWardenRuntime {
  const emit = opts.emit ?? ((line: string) => void process.stderr.write(line));
  emit(`${EVAL_DIRECT_EXEC_BANNER}\n`);
  const tr = createToolRuntime({
    cwd: opts.cwd,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.readEvents !== undefined ? { readEvents: opts.readEvents } : {}),
    emit,
    // Eval-direct only: this runtime is the disposable-container executor (no warden), so a
    // backgrounded service must survive keel's exit to reach the separate verifier. Never set on the
    // production path (release binaries can't construct this runtime — eval-executor-gate.ts).
    autoLeaseBackgroundedServices: true,
  });
  return {
    executor: tr.executor,
    tools: tr.tools,
    isMutating: tr.isMutating,
    // Honest eval-only HUD: the controller explicitly names the direct route; renderers never infer it
    // from the all-off posture.
    view: {
      protectionRoute: "deliberately-unenforced",
      policy: { active: false, label: "none" },
      posture: { sandbox: false, egress: false, audit: false },
    },
    dispose: () => tr.dispose(),
    activeLeases: () => tr.activeLeases(),
    cleanupLeases: (scope) => tr.cleanupLeases(scope),
  };
}

export const EVAL_DIRECT_CONSOLE_BRIDGE_BANNER =
  "⚠ KEEL EVAL DIRECT INTERACTIVE CONSOLE WARDEN BRIDGE ACTIVE — advertised interactive_console.* tools route through the warden; unadvertised console-family calls are rejected; other tools remain eval-direct.";

const INTERACTIVE_CONSOLE_TOOL_PREFIX = "interactive_console.";

function isInteractiveConsoleToolName(name: string): boolean {
  return name.startsWith(INTERACTIVE_CONSOLE_TOOL_PREFIX);
}

function errorForRuntimeDispose(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Eval-only hybrid runtime for benchmark containers that need direct local tools because the general
 * warden sandbox cannot run there, while still requiring interactive console I/O to cross the warden RPC
 * boundary. The HUD remains explicitly `deliberately-unenforced` because ordinary tools are still
 * direct; the bridge is advertised separately and dispatches only `interactive_console.*` to the warden.
 */
export function createEvalDirectConsoleBridgeRuntime(opts: {
  readonly direct: ProductionWardenRuntime;
  readonly console: ProductionWardenRuntime;
  /** Injectable sink for the bridge banner; defaults to real stderr. */
  readonly emit?: (line: string) => void;
}): ProductionWardenRuntime {
  const emit = opts.emit ?? ((line: string) => void process.stderr.write(line));
  const consoleToolNames = new Set(
    opts.console.tools
      .filter((tool) => isInteractiveConsoleToolName(tool.name))
      .map((tool) => tool.name),
  );
  if (consoleToolNames.size === 0) {
    throw new Error(
      "eval-direct interactive console bridge requested but warden advertised no console tools",
    );
  }

  const directTools = opts.direct.tools.filter((tool) => !isInteractiveConsoleToolName(tool.name));
  const advertisedNames = new Set(directTools.map((tool) => tool.name));
  const consoleTools = opts.console.tools.filter((tool) => {
    if (!consoleToolNames.has(tool.name)) return false;
    if (advertisedNames.has(tool.name)) return false;
    advertisedNames.add(tool.name);
    return true;
  });
  emit(`${EVAL_DIRECT_CONSOLE_BRIDGE_BANNER}\n`);
  const activeLeases =
    opts.direct.activeLeases === undefined
      ? {}
      : { activeLeases: () => opts.direct.activeLeases?.() ?? [] };
  const cleanupLeases =
    opts.direct.cleanupLeases === undefined
      ? {}
      : {
          cleanupLeases: (scope?: ProcessLeaseScope) =>
            opts.direct.cleanupLeases?.(scope) ?? Promise.resolve([]),
        };

  return {
    executor: {
      execute: async (call, callOpts) => {
        if (!isInteractiveConsoleToolName(call.name)) {
          return await opts.direct.executor.execute(call, callOpts);
        }
        if (!consoleToolNames.has(call.name)) {
          return {
            ok: false,
            output: `interactive console tool ${call.name} is not available from the warden bridge`,
          };
        }
        return await opts.console.executor.execute(call, callOpts);
      },
    },
    tools: [...directTools, ...consoleTools],
    isMutating: (name) =>
      isInteractiveConsoleToolName(name) ? true : opts.direct.isMutating(name),
    // Honest mixed-mode status: core tools are still eval-direct/no-enforcement, so do not claim a
    // globally governed posture. The bridge banner carries the narrower console-specific claim.
    view: opts.direct.view,
    ...(opts.direct.planApprovalSummary === undefined
      ? {}
      : { planApprovalSummary: opts.direct.planApprovalSummary }),
    ...(opts.direct.lifecycleManifest === undefined
      ? {}
      : { lifecycleManifest: opts.direct.lifecycleManifest }),
    ...activeLeases,
    ...cleanupLeases,
    dispose: async () => {
      let firstError: Error | undefined;
      try {
        await opts.direct.dispose();
      } catch (error) {
        firstError = errorForRuntimeDispose(error);
      }
      try {
        await opts.console.dispose();
      } catch (error) {
        if (firstError === undefined) firstError = errorForRuntimeDispose(error);
      }
      if (firstError !== undefined) throw firstError;
    },
  };
}
