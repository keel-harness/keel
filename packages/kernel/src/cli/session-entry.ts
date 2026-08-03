import type {
  ExecutorPort,
  GoalT,
  LifecycleManifestT,
  LoopConfigT,
  ModelMessageT,
  ModelPort,
  SessionEventT,
  ToolSpecT,
  UiGitStatus,
  UIPort,
} from "@keel/shared";
import { SessionId } from "@keel/shared";
import {
  buildRecentSessionRows,
  buildUsageDigest,
  firstRunView,
  reduce,
  type ViewConfig,
} from "../tui/view-model.js";
import { runSession } from "../tui/runner.js";
import { runRepl } from "../tui/repl.js";
import type {
  InteractivePlanApprovalController,
  InteractivePlanApprovalResult,
} from "../tui/repl.js";
import type { RunOutcome, RunSessionOpts } from "../tui/runner.js";
import { HeadlessUI } from "../tui/headless.js";
import { createInteractiveReviewDecisionController } from "../tui/review-decision.js";
import { InkUI } from "../tui/ink/ink-ui.js";
import { activateTerminalLifecycle } from "../tui/terminal-control.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { verifyEvidenceBundle } from "../audit/verify-bundle.js";
import { SessionStore, readSession } from "../session/store.js";
import { applyPendingSteeringOnResume, rebuild } from "../session/resume.js";
import { listSessions } from "../session/list.js";
import { keelHome, sessionPath } from "../session/paths.js";
import { workspaceKey } from "../session/workspace-key.js";
import { backupSystemMessage, snapshotWorkspace } from "../session/workspace-snapshot.js";
import { SYSTEM_PROMPT } from "../context/system-prompt.js";
import { resolveContextWindow, type ContextWindowSpec } from "../context/pressure.js";
import { gatherProjectContext } from "../context/project-context.js";
import { createInLoopCompactor } from "../context/compress/in-loop-compactor.js";
import { deterministicFactsSummary } from "../context/facts-summary.js";
import { gitStatusAsync } from "./git-status.js";
import { loadProjectAutopilotMode } from "../autopilot/mode-store.js";
import { CAPABILITIES, type ProviderId } from "../providers/capabilities.js";
import type { InputQueue } from "./input-queue.js";
import {
  createProductionWardenRuntime,
  exportAuditSession,
  productionWardenAuditDir,
  type ProductionWardenRuntime,
  type ProductionWardenStartOptions,
} from "../warden/runtime.js";
import { historicOnceApprovalReceiptFromAudit } from "../warden/historic-once-receipt.js";
import {
  previewPlanApprovalEnvelope,
  type PlanApprovalEnvelope,
  type PlanApprovalSummary,
  type PlanApprovalResource,
} from "../warden/approval.js";
import {
  canRoutePlanApprovalReviews,
  withPlanApprovalStatusView,
  type WardenStatusViewConfig,
} from "../warden/status.js";
import { appendWardenAutoResolvedEvent } from "../warden/receipt.js";
import type { AutonomyPostureRequest } from "../autopilot/posture.js";
import { createEvalDirectConsoleBridgeRuntime, createEvalDirectRuntime } from "./runtime.js";
import {
  PRODUCTION_BASH_MAX_TIMEOUT_MS,
  resolveEvalBashMaxTimeoutMs,
  resolveExecutorMode,
  resolveWardenExecuteTimeoutMs,
} from "./eval-executor-gate.js";
import {
  ModelGateway,
  ModelRouteController,
  createLockedModelRoutingPolicy,
  createSingleModelCatalog,
} from "../model-routing/index.js";
import { appendModelRouteDecision } from "../session/model-route.js";
import { runBoundedLoopSession } from "../run/loop-session.js";
import { parseGoalArgs, parseLoopArgs, shellJoin, shellWords } from "../run/run-control-parser.js";
import { PROGRESS_CONTRACT_LOOP_CONFIG } from "../loop-detection.js";
import {
  DEFAULT_PRESTOP_CHECK_MAX_OUTPUT_BYTES,
  DEFAULT_PRESTOP_CHECK_TIMEOUT_MS,
  MAX_PRESTOP_CHECK_MAX_OUTPUT_BYTES,
  MAX_PRESTOP_CHECK_TIMEOUT_MS,
} from "../prestop-check.js";
import {
  acceptanceContractFromRequiredArtifacts,
  acceptanceContractFromProcessLeases,
  artifactReaderForRoot,
  requiredArtifactsFromEnv,
  type AcceptanceContract,
} from "../completion/acceptance-contract.js";
import {
  parsePreviewArgs,
  type ParsedPlanPreview,
  renderInteractivePlanApproval,
  renderPreview,
} from "./autopilot-plan.js";

/** Which renderer to drive. Ink for an interactive TTY; headless for everything else. */
export type Renderer = "ink" | "headless";

export interface RendererEnv {
  /** Whether stdin/stdout is an interactive terminal. */
  readonly isTTY: boolean;
  /** `CI=true` (or any CI marker the bin resolves) — force headless. */
  readonly ci: boolean;
  /** A `keel run -p` one-shot — always headless. */
  readonly oneShot: boolean;
}

/**
 * Route to a renderer (§8.6 — `CI=true`/non-TTY/one-shot must never need a TTY). Pure: the bin
 * resolves `process.stdout.isTTY` / `process.env.CI` / the parsed command into these booleans.
 */
export function selectRenderer(e: RendererEnv): Renderer {
  return e.oneShot || e.ci || !e.isTTY ? "headless" : "ink";
}

/** Construct the UIPort for a renderer. The interactive Ink UI bridges its `InputBar` to `queue`
 *  (the runner pulls steering from it); the headless UI is non-interactive and ignores it.
 *  C-stream (Epic 1.20): an optional `sink` makes the headless transcript stream incrementally so it
 *  survives a hard kill — wired only by the real entrypoint (bin.ts); omitted in tests (buffer only). */
export function buildUI(
  renderer: Renderer,
  queue: InputQueue,
  sink?: (chunk: string) => void,
  verbose = true,
  complete?: (query: string) => readonly string[],
  editDraft?: (draft: string) => Promise<string | undefined>,
  interactive = true,
): UIPort {
  return renderer === "ink"
    ? new InkUI(queue, complete, verbose, editDraft)
    : new HeadlessUI(sink, verbose, interactive);
}

export const HELP_TEXT = [
  "usage: keel [command]",
  "",
  "commands",
  "  keel [--trust] [--autopilot] interactive multi-turn session",
  "    --continue | -c            resume the most recent session in this directory",
  "    --resume <id> | -r <id>    resume a specific session by id",
  "  keel run -p <prompt> [--trust] [--autopilot]",
  "    --replay <recording.json> offline deterministic replay; no provider credential or network",
  "    --autopilot                trusted-repo opt-in; warden still asks on boundary expansion",
  "    [--plan-id <id>] (--plan-domain <domain> | --plan-command-key <sha256:key>) ...",
  "      exact-resource Plan Autopilot run envelope; cannot combine with --autopilot or --replay",
  '    --plan-confirm             preview exact plan resources and require typing "approve" before execution',
  "    --goal <objective> --goal-check <cmd>   audit completion from explicit evidence",
  "    --loop-until <cmd> [--loop-max-iterations <n>]   bounded in-session loop",
  "  keel autopilot mode status",
  "  keel autopilot mode set <guided|autopilot|project-autopilot>",
  "  keel autopilot mode clear",
  "  keel autopilot grants list   show current-project persisted Autopilot grants",
  "  keel autopilot grants revoke (--domain <domain> | --command-key <sha256:key>)",
  "  keel autopilot plan preview [--plan-id <id>] [--step <text> ...] (--domain <domain> | --command-key <sha256:key>) ...",
  "    preview exact Plan Autopilot resources; grants nothing",
  "  keel egress exception add|list|remove   manage exact private-address exceptions",
  "    requires --workspace; add/remove require --host, --cidr, and one or more --port",
  "  keel audit export <session>  export a per-session evidence bundle",
  "  keel audit verify <bundle>   verify a signed evidence bundle offline",
  "  keel mcp review <server>     review and pin a local-stdio MCP server",
  "  keel sessions <command>      list and inspect session ledgers",
  "  keel auth <command>          manage local provider API keys",
  "  keel doctor                  check required local tools",
  "  keel --version | -v          print version",
  "  keel --help | -h             show this help",
  "",
  "governed surfaces: governed bash, trusted file tools, lifecycle.run, and reviewed local-stdio MCP route through the warden; unreviewed tools fail closed",
].join("\n");

export const KEEL_RUN_SESSION_ID_ENV = "KEEL_RUN_SESSION_ID";

const INTERACTIVE_CONSOLE_CONFIG_ENV = "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG";
const INTERACTIVE_CONSOLE_CONFIG_B64_ENV = "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64";
const INTERACTIVE_CONSOLE_GRANT_B64_ENV = "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64";

function nonEmptyEnvValue(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key];
  return value !== undefined && value.trim() !== "";
}

function evalDirectInteractiveConsoleRequested(env: NodeJS.ProcessEnv): boolean {
  return (
    nonEmptyEnvValue(env, INTERACTIVE_CONSOLE_CONFIG_ENV) ||
    nonEmptyEnvValue(env, INTERACTIVE_CONSOLE_CONFIG_B64_ENV) ||
    nonEmptyEnvValue(env, INTERACTIVE_CONSOLE_GRANT_B64_ENV)
  );
}

function errorForEvalDirectConsoleBridgeStartup(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function throwEvalDirectConsoleBridgeStartupFailure(
  primaryError: unknown,
  directRuntime: ProductionWardenRuntime,
  consoleRuntime: ProductionWardenRuntime | undefined,
): Promise<never> {
  const cleanupErrors: Error[] = [];
  try {
    await directRuntime.dispose();
  } catch (error) {
    cleanupErrors.push(errorForEvalDirectConsoleBridgeStartup(error));
  }
  if (consoleRuntime !== undefined) {
    try {
      await consoleRuntime.dispose();
    } catch (error) {
      cleanupErrors.push(errorForEvalDirectConsoleBridgeStartup(error));
    }
  }

  const primary = errorForEvalDirectConsoleBridgeStartup(primaryError);
  if (cleanupErrors.length === 0) throw primary;
  throw new Error(
    `${primary.message}; cleanup after eval-direct console bridge startup failure also failed: ${cleanupErrors
      .map((error) => error.message)
      .join("; ")}`,
    { cause: primary },
  );
}

const USAGE =
  "usage: keel [--trust] [--autopilot]\n" +
  "usage: keel [run -p <prompt> [--trust] [--autopilot] | autopilot <grants|mode|plan> <…> | egress exception <add|list|remove> | audit export <session> | audit verify <bundle> | sessions <…> | auth <…> | doctor | --version | --help]\n" +
  "usage: keel mcp review <server>\n" +
  "Run `keel` with no arguments for an interactive session; run `keel --help` for commands.";
const AUTOPILOT_PARSE_USAGE = "usage: keel autopilot <grants|mode|plan>";
const AUTOPILOT_GRANTS_PARSE_USAGE = "usage: keel autopilot grants <list|revoke>";
const AUTOPILOT_MODE_PARSE_USAGE = "usage: keel autopilot mode <status|set|clear>";
const AUTOPILOT_PLAN_PARSE_USAGE = "usage: keel autopilot plan <preview>";
const EGRESS_EXCEPTION_PARSE_USAGE = "usage: keel egress exception <add|list|remove>";
const RUN_USAGE =
  "usage: keel run -p <prompt> [--replay <recording.json>] [--trust] [--autopilot] [[--plan-confirm] [--plan-id <id>] (--plan-domain <domain> | --plan-command-key <sha256:key>) ...]";
const AUDIT_EXPORT_USAGE = "usage: keel audit export <session> [--out <dir>]";
const AUDIT_VERIFY_USAGE = "usage: keel audit verify <bundle>";
const MCP_REVIEW_USAGE = "usage: keel mcp review <server>";

export interface PlanApprovalRunRequest {
  readonly planId: string;
  readonly resources: readonly PlanApprovalResource[];
  readonly confirm?: true;
}

/** Which prior session a resumed interactive run targets (Epic 1.23 slice 2): the most recent session
 *  for the cwd (`--continue`), or a specific id (`--resume <id>`). Resolved to a concrete id by
 *  `resolveResumeId`; keel then CONTINUES that ledger (append-only, not a branch — see the design doc). */
export type ResumeSpec = { readonly kind: "latest" } | { readonly kind: "id"; readonly id: string };

/** The parsed top-level `keel` command. `trust` is the `--trust` workspace opt-in (a human act; see
 *  `resolveWorkspaceTrust`), accepted on the interactive and run forms. */
export type KeelCommand =
  | {
      readonly kind: "interactive";
      readonly trust: boolean;
      readonly autonomy?: AutonomyPostureRequest;
      readonly resume?: ResumeSpec;
    }
  | {
      readonly kind: "run";
      readonly prompt: string;
      readonly trust: boolean;
      readonly autonomy?: AutonomyPostureRequest;
      /** `--replay <file>` — drive the run from a recorded `Recording` (offline, no key). */
      readonly replay?: string;
      /** `--verbose` — show the seeded system preamble (prompt · env · skills · AGENTS.md) in the
       *  `-p` output. Absent (default) hides it, so the one-shot output is the answer, not scaffolding
       *  (DX bug a). Present only when the flag was passed (keeps the no-flag parse byte-identical). */
      readonly verbose?: boolean;
      readonly goal?: GoalT;
      readonly loop?: LoopConfigT;
      readonly planApproval?: PlanApprovalRunRequest;
    }
  | { readonly kind: "audit-export"; readonly sessionId: string; readonly outPath?: string }
  | { readonly kind: "audit-verify"; readonly bundlePath: string }
  | { readonly kind: "autopilot-grants"; readonly args: readonly string[] }
  | { readonly kind: "autopilot-mode"; readonly args: readonly string[] }
  | { readonly kind: "autopilot-plan"; readonly args: readonly string[] }
  | { readonly kind: "egress-exception"; readonly args: readonly string[] }
  | { readonly kind: "mcp-review"; readonly serverKey: string }
  | { readonly kind: "sessions"; readonly args: readonly string[] }
  | { readonly kind: "auth"; readonly args: readonly string[] }
  | { readonly kind: "doctor" }
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly message: string; readonly exitCode?: 1 };

/** Parse argv into a command (pure). `keel` → interactive; `keel run -p <prompt>` → headless
 *  one-shot; `keel sessions …` → the existing sessions CLI; `keel doctor` → the environment
 *  preflight; `--version`/`-v` (anywhere) → the version banner; `--help`/`-h` (anywhere) → help;
 *  anything else → usage. `--trust` (anywhere in argv) is the explicit workspace-trust opt-in for
 *  the interactive/run forms. */
export function parseKeelArgs(argv: readonly string[]): KeelCommand {
  // `--version`/`-v` short-circuits everything (it never needs a model/key/workspace).
  if (argv.includes("--version") || argv.includes("-v")) return { kind: "version" };
  // `--help`/`-h` also short-circuits: discoverability must not require a key, model, or workspace.
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  const trust = argv.includes("--trust");
  const verbose = argv.includes("--verbose");
  const autopilot = argv.includes("--autopilot");
  const autonomy: AutonomyPostureRequest | undefined = autopilot
    ? {
        mode: "autopilot",
        source: "human",
        userConfirmed: true,
        reason: "cli --autopilot",
      }
    : undefined;
  // Resume (interactive form, Epic 1.23 slice 2): --continue/-c = the latest session for this cwd;
  // --resume/-r <id> = a specific session. A bare --resume (no id / a following flag) is a usage error,
  // never a silent plain-interactive.
  const ri = argv.findIndex((a) => a === "--resume" || a === "-r");
  let resume: ResumeSpec | undefined;
  let resumeNeedsId = false;
  if (ri >= 0) {
    const id = argv[ri + 1];
    if (id === undefined || id.startsWith("-")) resumeNeedsId = true;
    else resume = { kind: "id", id };
  } else if (argv.includes("--continue") || argv.includes("-c")) {
    resume = { kind: "latest" };
  }
  const args = argv.filter(
    (a, i) =>
      a !== "--trust" &&
      a !== "--verbose" &&
      a !== "--autopilot" &&
      a !== "--continue" &&
      a !== "-c" &&
      a !== "--resume" &&
      a !== "-r" &&
      !(ri >= 0 && i === ri + 1), // the id that follows --resume/-r
  );
  if (resumeNeedsId)
    return { kind: "usage", message: `keel --resume needs a session id. ${USAGE}` };
  if (args.length === 0)
    return {
      kind: "interactive",
      trust,
      ...(autonomy === undefined ? {} : { autonomy }),
      ...(resume !== undefined ? { resume } : {}),
    };
  const [cmd, ...rest] = args;
  if (autopilot && cmd !== "run") {
    const usage =
      cmd === "autopilot" && rest[0] === "grants"
        ? AUTOPILOT_GRANTS_PARSE_USAGE
        : cmd === "autopilot" && rest[0] === "mode"
          ? AUTOPILOT_MODE_PARSE_USAGE
          : cmd === "autopilot" && rest[0] === "plan"
            ? AUTOPILOT_PLAN_PARSE_USAGE
            : USAGE;
    return {
      kind: "usage",
      message: `--autopilot is only valid for the interactive and run commands. ${usage}`,
      exitCode: 1,
    };
  }
  if (cmd === "doctor") return { kind: "doctor" };
  if (cmd === "egress") {
    if (trust || verbose) {
      const flag = trust ? "--trust" : "--verbose";
      return {
        kind: "usage",
        message: `${flag} is only valid for the interactive and run commands. ${EGRESS_EXCEPTION_PARSE_USAGE}`,
        exitCode: 1,
      };
    }
    const [area, subcommand, ...egressRest] = rest;
    if (
      area !== "exception" ||
      (subcommand !== "add" && subcommand !== "list" && subcommand !== "remove")
    ) {
      return { kind: "usage", message: EGRESS_EXCEPTION_PARSE_USAGE };
    }
    return { kind: "egress-exception", args: [subcommand, ...egressRest] };
  }
  if (cmd === "autopilot") {
    if (trust) {
      const usage =
        rest[0] === "grants"
          ? AUTOPILOT_GRANTS_PARSE_USAGE
          : rest[0] === "mode"
            ? AUTOPILOT_MODE_PARSE_USAGE
            : rest[0] === "plan"
              ? AUTOPILOT_PLAN_PARSE_USAGE
              : AUTOPILOT_PARSE_USAGE;
      return {
        kind: "usage",
        message: `--trust is only valid for the interactive and run commands. ${usage}`,
        ...(rest[0] === "grants" || rest[0] === "mode" || rest[0] === "plan"
          ? { exitCode: 1 as const }
          : {}),
      };
    }
    const [area, subcommand, ...autopilotRest] = rest;
    if (area === "grants") {
      if (subcommand === undefined) {
        return { kind: "usage", message: AUTOPILOT_GRANTS_PARSE_USAGE, exitCode: 1 };
      }
      if (subcommand !== "list" && subcommand !== "revoke") {
        return { kind: "usage", message: AUTOPILOT_GRANTS_PARSE_USAGE, exitCode: 1 };
      }
      return { kind: "autopilot-grants", args: [subcommand, ...autopilotRest] };
    }
    if (area === "mode") {
      if (subcommand === undefined) {
        return { kind: "usage", message: AUTOPILOT_MODE_PARSE_USAGE, exitCode: 1 };
      }
      if (subcommand !== "status" && subcommand !== "set" && subcommand !== "clear") {
        return { kind: "usage", message: AUTOPILOT_MODE_PARSE_USAGE, exitCode: 1 };
      }
      return { kind: "autopilot-mode", args: [subcommand, ...autopilotRest] };
    }
    if (area === "plan") {
      if (subcommand === undefined) {
        return { kind: "usage", message: AUTOPILOT_PLAN_PARSE_USAGE, exitCode: 1 };
      }
      if (subcommand !== "preview") {
        return { kind: "usage", message: AUTOPILOT_PLAN_PARSE_USAGE, exitCode: 1 };
      }
      return { kind: "autopilot-plan", args: [subcommand, ...autopilotRest] };
    }
    return { kind: "usage", message: AUTOPILOT_PARSE_USAGE };
  }
  if (cmd === "audit") {
    const [subcommand, sessionId, ...auditRest] = rest;
    if (subcommand === "verify") {
      if (sessionId === undefined || sessionId.startsWith("-") || auditRest.length > 0) {
        return { kind: "usage", message: AUDIT_VERIFY_USAGE };
      }
      return { kind: "audit-verify", bundlePath: sessionId };
    }
    if (subcommand !== "export" || sessionId === undefined || sessionId.startsWith("-")) {
      return { kind: "usage", message: AUDIT_EXPORT_USAGE };
    }
    const outIndex = auditRest.findIndex((arg) => arg === "--out");
    if (outIndex === -1) {
      return auditRest.length === 0
        ? { kind: "audit-export", sessionId }
        : { kind: "usage", message: AUDIT_EXPORT_USAGE };
    }
    const outPath = auditRest[outIndex + 1];
    if (outPath === undefined || outPath.length === 0 || outPath.startsWith("-")) {
      return { kind: "usage", message: AUDIT_EXPORT_USAGE };
    }
    const allowed = auditRest.length === 2 && outIndex === 0;
    return allowed
      ? { kind: "audit-export", sessionId, outPath }
      : { kind: "usage", message: AUDIT_EXPORT_USAGE };
  }
  if (cmd === "sessions") return { kind: "sessions", args: rest };
  if (cmd === "auth") return { kind: "auth", args: rest };
  if (cmd === "mcp") {
    const [subcommand, serverKey, ...mcpRest] = rest;
    if (
      subcommand !== "review" ||
      serverKey === undefined ||
      serverKey.startsWith("-") ||
      mcpRest.length > 0
    ) {
      return { kind: "usage", message: MCP_REVIEW_USAGE };
    }
    return { kind: "mcp-review", serverKey };
  }
  if (cmd === "run") {
    const flag = rest.findIndex((a) => a === "-p" || a === "--print");
    const prompt = flag >= 0 ? rest[flag + 1] : undefined;
    if (prompt === undefined || prompt.length === 0) return { kind: "usage", message: RUN_USAGE };
    // A prompt legitimately may START with "-": a markdown bullet ("- step one"), a diff hunk
    // ("- old line"), a dash-led phrase, or a sentence naming a flag. Only reject values that are a
    // keel-flag-SHAPED token — a bare `--flag` or `--flag=value` with no embedded whitespace — which
    // is almost always a forgotten prompt (`keel run -p --replay=x`), never intended prose. This keeps
    // the forgotten-prompt protection while accepting real dash-leading prompts. (The only residual
    // loss is a whole prompt that is a single flag-shaped word with no spaces — vanishingly rare.)
    if (/^--?[A-Za-z][A-Za-z0-9-]*(?:=|$)/.test(prompt)) {
      return {
        kind: "usage",
        message: "keel run -p requires a prompt, not a flag",
        exitCode: 1,
      };
    }
    const unsupported = unsupportedRunArg(rest);
    if (unsupported !== undefined) return unsupported;
    const planApproval = parseRunPlanApprovalArgs(planApprovalArgsFromRunArgs(rest), autopilot);
    if (planApproval.kind === "usage") {
      return { kind: "usage", message: planApproval.message, exitCode: 1 };
    }
    const runControl = parseRunControlArgs(rest, prompt);
    if (runControl.kind === "usage") return { kind: "usage", message: runControl.message };
    // Accept BOTH `--replay <file>` and `--replay=<file>`. The equals form must be handled
    // explicitly: `--replay` is the offline/no-spend safety flag, so a `--replay=rec.json` token
    // that the parser failed to recognize would silently fall through to a LIVE, paid run — a
    // money-safety footgun (QC final review B-F2). Either form with no path → usage, never a no-op.
    const ri = rest.findIndex((a) => a === "--replay" || a.startsWith("--replay="));
    if (ri >= 0) {
      if (planApproval.request !== undefined) {
        return {
          kind: "usage",
          message: "keel run cannot combine --replay with --plan-* exact-resource approval",
          exitCode: 1,
        };
      }
      const tok = rest[ri] as string;
      const file = tok.startsWith("--replay=") ? tok.slice("--replay=".length) : rest[ri + 1];
      if (file === undefined || file.length === 0 || file.startsWith("-")) {
        return { kind: "usage", message: `keel run --replay needs a recording file. ${RUN_USAGE}` };
      }
      return {
        kind: "run",
        prompt,
        trust,
        ...(autonomy === undefined ? {} : { autonomy }),
        replay: file,
        ...(verbose ? { verbose: true } : {}),
        ...(runControl.goal !== undefined ? { goal: runControl.goal } : {}),
        ...(runControl.loop !== undefined ? { loop: runControl.loop } : {}),
      };
    }
    return {
      kind: "run",
      prompt,
      trust,
      ...(autonomy === undefined ? {} : { autonomy }),
      ...(verbose ? { verbose: true } : {}),
      ...(runControl.goal !== undefined ? { goal: runControl.goal } : {}),
      ...(runControl.loop !== undefined ? { loop: runControl.loop } : {}),
      ...(planApproval.request !== undefined ? { planApproval: planApproval.request } : {}),
    };
  }
  return { kind: "usage", message: USAGE };
}

type ParsedRunPlanApproval =
  | { readonly kind: "ok"; readonly request?: PlanApprovalRunRequest }
  | { readonly kind: "usage"; readonly message: string };

const RUN_FLAGS_WITH_SPLIT_VALUES = new Set([
  "-p",
  "--print",
  "--replay",
  "--plan-id",
  "--plan-domain",
  "--plan-command-key",
  "--goal",
  "--goal-check",
  "--goal-max-turns",
  "--goal-max-wall-ms",
  "--goal-validation",
  "--loop-until",
  "--loop-max-iterations",
  "--loop-max-wall-ms",
]);

const RUN_PLAN_FLAGS = new Set(["--plan-id", "--plan-domain", "--plan-command-key"]);
const RUN_FLAGS_WITH_EQUALS_VALUES = new Set([
  "--replay",
  "--plan-id",
  "--plan-domain",
  "--plan-command-key",
  "--goal",
  "--goal-check",
  "--goal-max-turns",
  "--goal-max-wall-ms",
  "--goal-validation",
  "--loop-until",
  "--loop-max-iterations",
  "--loop-max-wall-ms",
]);

function unsupportedRunArg(args: readonly string[]): KeelCommand | undefined {
  for (let i = 0; i < args.length; ) {
    const arg = args[i]!;
    if (RUN_FLAGS_WITH_SPLIT_VALUES.has(arg)) {
      i += 2;
      continue;
    }
    if (arg === "--plan-confirm" || arg.startsWith("--plan-confirm=")) {
      i += 1;
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals > 0 && RUN_FLAGS_WITH_EQUALS_VALUES.has(arg.slice(0, equals))) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      return {
        kind: "usage",
        message: `unsupported keel run flag: ${arg}`,
        exitCode: 1,
      };
    }
    return {
      kind: "usage",
      message: `unexpected keel run argument: ${arg}`,
      exitCode: 1,
    };
  }
  return undefined;
}

function planApprovalArgsFromRunArgs(args: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; ) {
    const arg = args[i]!;
    if (RUN_FLAGS_WITH_SPLIT_VALUES.has(arg)) {
      if (RUN_PLAN_FLAGS.has(arg)) {
        out.push(arg);
        const value = args[i + 1];
        if (value !== undefined) out.push(value);
      }
      i += 2;
      continue;
    }
    if (
      arg.startsWith("--plan-id=") ||
      arg.startsWith("--plan-domain=") ||
      arg.startsWith("--plan-command-key=") ||
      arg === "--plan-confirm" ||
      arg.startsWith("--plan-confirm=")
    ) {
      out.push(arg);
    }
    i += 1;
  }
  return out;
}

function hasPlanApprovalFlag(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "--plan-id" ||
      arg.startsWith("--plan-id=") ||
      arg === "--plan-domain" ||
      arg.startsWith("--plan-domain=") ||
      arg === "--plan-command-key" ||
      arg.startsWith("--plan-command-key=") ||
      arg === "--plan-confirm" ||
      arg.startsWith("--plan-confirm="),
  );
}

function parseRunPlanApprovalArgs(
  args: readonly string[],
  autopilot: boolean,
): ParsedRunPlanApproval {
  if (!hasPlanApprovalFlag(args)) return { kind: "ok" };
  if (autopilot) {
    return {
      kind: "usage",
      message: "keel run cannot combine --autopilot with --plan-* exact-resource approval",
    };
  }
  const confirmFlags = args.filter(
    (arg) => arg === "--plan-confirm" || arg.startsWith("--plan-confirm="),
  );
  if (confirmFlags.length > 1) {
    return { kind: "usage", message: "keel run --plan-confirm may be provided once" };
  }
  if (confirmFlags.some((arg) => arg.includes("="))) {
    return { kind: "usage", message: "keel run --plan-confirm takes no value" };
  }
  const planId = singleFlagValue(args, "--plan-id");
  if (typeof planId === "object") return { kind: "usage", message: planId.error };
  const domains = flagValues(args, "--plan-domain");
  if (typeof domains === "string") return { kind: "usage", message: domains };
  const commandKeys = flagValues(args, "--plan-command-key");
  if (typeof commandKeys === "string") return { kind: "usage", message: commandKeys };
  const confirm = confirmFlags.length === 1;
  const resources: PlanApprovalResource[] = [
    ...domains.map((value) => ({ kind: "domain" as const, value })),
    ...commandKeys.map((value) => ({ kind: "command-key" as const, value })),
  ];
  if (resources.length === 0) {
    if (confirm) {
      return {
        kind: "usage",
        message: "keel run --plan-confirm requires --plan-domain or --plan-command-key",
      };
    }
    return {
      kind: "usage",
      message: "keel run plan approval requires --plan-domain or --plan-command-key",
    };
  }
  const preview = previewPlanApprovalEnvelope({
    planId: planId ?? "plan",
    trustedWorkspace: true,
    resources,
  });
  const rejected = preview.rejectedResources[0];
  if (rejected !== undefined) {
    return { kind: "usage", message: renderRunPlanApprovalRejection(rejected) };
  }
  return {
    kind: "ok",
    request: {
      planId: preview.planId,
      resources: preview.acceptedResources,
      ...(confirm ? { confirm: true } : {}),
    },
  };
}

function renderRunPlanApprovalRejection(rejected: {
  readonly kind: string;
  readonly value: string;
  readonly reason: string;
}): string {
  if (rejected.kind === "domain") {
    return `keel run plan approval rejected domain ${rejected.value}: domain must be an exact host`;
  }
  if (rejected.kind === "command-key") {
    return `keel run plan approval rejected command-key ${rejected.value}: command-key must be sha256:<64 lowercase hex>`;
  }
  return `keel run plan approval rejected ${rejected.kind} ${rejected.value}: ${rejected.reason}`;
}

interface PlanApprovalCapableExecutor extends ExecutorPort {
  activatePlanApproval(envelope: PlanApprovalEnvelope): PlanApprovalSummary | undefined;
  clearPlanApproval(): boolean;
}

function planApprovalExecutor(executor: ExecutorPort): PlanApprovalCapableExecutor | undefined {
  const candidate = executor as Partial<PlanApprovalCapableExecutor>;
  return typeof candidate.activatePlanApproval === "function" &&
    typeof candidate.clearPlanApproval === "function"
    ? (candidate as PlanApprovalCapableExecutor)
    : undefined;
}

function parseInteractivePlanArgs(
  args: string,
):
  | { readonly ok: true; readonly parsed: ParsedPlanPreview }
  | { readonly ok: false; readonly output: string } {
  let words: string[];
  try {
    words = shellWords(args);
  } catch (err) {
    return {
      ok: false,
      output: `/plan: ${err instanceof Error ? err.message : "invalid quoted arguments"}`,
    };
  }
  const parsed = parsePreviewArgs(words);
  if (parsed === undefined) {
    return {
      ok: false,
      output:
        "usage: /plan <preview|approve|clear> [--plan-id <id>] (--domain <domain> | --command-key <sha256:key>) ...",
    };
  }
  return { ok: true, parsed };
}

function createInteractivePlanApprovalController(options: {
  readonly executor: ExecutorPort;
  readonly cwd: string;
  readonly trustedWorkspace: boolean;
  readonly view: WardenStatusViewConfig;
}): InteractivePlanApprovalController | undefined {
  const executor = planApprovalExecutor(options.executor);
  if (executor === undefined) return undefined;

  const envelopeFor = (
    args: string,
  ): InteractivePlanApprovalResult & {
    readonly envelope?: PlanApprovalEnvelope;
    readonly resources?: readonly PlanApprovalResource[];
    readonly planId?: string;
    readonly steps?: readonly string[];
  } => {
    const parsed = parseInteractivePlanArgs(args);
    if (!parsed.ok) return { ok: false, output: parsed.output };
    const rawEnvelope: PlanApprovalEnvelope = {
      planId: parsed.parsed.planId,
      trustedWorkspace: options.trustedWorkspace,
      resources: parsed.parsed.resources,
    };
    const preview = previewPlanApprovalEnvelope(rawEnvelope);
    const rejected = preview.rejectedResources[0];
    if (rejected !== undefined) {
      return { ok: false, output: renderRunPlanApprovalRejection(rejected) };
    }
    const envelope: PlanApprovalEnvelope = {
      planId: preview.planId,
      trustedWorkspace: options.trustedWorkspace,
      resources: preview.acceptedResources,
    };
    return {
      ok: true,
      output: "",
      envelope,
      planId: preview.planId,
      resources: preview.acceptedResources,
      steps: parsed.parsed.steps,
    };
  };

  return {
    preview: (args) => {
      const parsed = parseInteractivePlanArgs(args);
      if (!parsed.ok) return { ok: false, output: parsed.output };
      const preview = previewPlanApprovalEnvelope({
        planId: parsed.parsed.planId,
        trustedWorkspace: options.trustedWorkspace,
        resources: parsed.parsed.resources,
      });
      return {
        ok: preview.rejectedResources.length === 0,
        output: renderPreview(options.cwd, preview, parsed.parsed.steps),
      };
    },
    approve: (args) => {
      const prepared = envelopeFor(args);
      if (
        !prepared.ok ||
        prepared.envelope === undefined ||
        prepared.resources === undefined ||
        prepared.planId === undefined
      ) {
        return { ok: false, output: prepared.output };
      }
      const summary = executor.activatePlanApproval(prepared.envelope);
      if (!canRoutePlanApprovalReviews(options.view, summary)) {
        executor.clearPlanApproval();
        return {
          ok: false,
          output:
            "Plan Autopilot approval was not activated: runtime policy, sandbox, egress, and audit gates must be visible in the current session view",
        };
      }
      return {
        ok: true,
        output: renderInteractivePlanApproval({
          workspace: options.cwd,
          planId: prepared.planId,
          resources: prepared.resources,
        }),
        view: withPlanApprovalStatusView(options.view),
      };
    },
    clear: () => {
      executor.clearPlanApproval();
    },
  };
}

type ParsedRunControl =
  | { readonly kind: "ok"; readonly goal?: GoalT; readonly loop?: LoopConfigT }
  | { readonly kind: "usage"; readonly message: string };

function flagValues(args: readonly string[], flag: string): string[] | string {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === flag) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) return `${flag} requires a value`;
      out.push(value);
      i += 1;
      continue;
    }
    const prefix = `${flag}=`;
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length);
      if (value === "") return `${flag} requires a value`;
      out.push(value);
    }
  }
  return out;
}

function singleFlagValue(
  args: readonly string[],
  flag: string,
): string | undefined | { error: string } {
  const values = flagValues(args, flag);
  if (typeof values === "string") return { error: values };
  if (values.length > 1) return { error: `${flag} may be provided once` };
  return values[0];
}

function parseRunControlArgs(args: readonly string[], prompt: string): ParsedRunControl {
  const goalObjective = singleFlagValue(args, "--goal");
  if (typeof goalObjective === "object") return { kind: "usage", message: goalObjective.error };
  const goalChecks = flagValues(args, "--goal-check");
  if (typeof goalChecks === "string") return { kind: "usage", message: goalChecks };
  const loopUntil = singleFlagValue(args, "--loop-until");
  if (typeof loopUntil === "object") return { kind: "usage", message: loopUntil.error };
  const hasGoal = goalObjective !== undefined || goalChecks.length > 0;
  const hasLoop = loopUntil !== undefined || args.some((arg) => arg.startsWith("--loop-"));
  if (hasGoal && hasLoop)
    return { kind: "usage", message: "run-control accepts either goal or loop, not both" };

  if (hasGoal) {
    if (goalObjective === undefined)
      return { kind: "usage", message: "--goal requires an objective" };
    const maxTurns = singleFlagValue(args, "--goal-max-turns");
    if (typeof maxTurns === "object") return { kind: "usage", message: maxTurns.error };
    const maxWallMs = singleFlagValue(args, "--goal-max-wall-ms");
    if (typeof maxWallMs === "object") return { kind: "usage", message: maxWallMs.error };
    const validation = singleFlagValue(args, "--goal-validation");
    if (typeof validation === "object") return { kind: "usage", message: validation.error };
    const raw = [
      shellJoin([goalObjective]),
      ...goalChecks.map((check) => `--check ${shellJoin([check])}`),
      ...(maxTurns !== undefined ? [`--max-turns ${maxTurns}`] : []),
      ...(maxWallMs !== undefined ? [`--max-wall-ms ${maxWallMs}`] : []),
      ...(validation !== undefined ? [`--validation ${validation}`] : []),
    ].join(" ");
    const parsed = parseGoalArgs(raw);
    return parsed.success
      ? { kind: "ok", goal: parsed.goal }
      : { kind: "usage", message: parsed.error };
  }

  if (hasLoop) {
    if (loopUntil === undefined)
      return { kind: "usage", message: "--loop-until requires a command" };
    const maxIterations = singleFlagValue(args, "--loop-max-iterations");
    if (typeof maxIterations === "object") return { kind: "usage", message: maxIterations.error };
    const maxWallMs = singleFlagValue(args, "--loop-max-wall-ms");
    if (typeof maxWallMs === "object") return { kind: "usage", message: maxWallMs.error };
    const raw = [
      shellJoin([prompt]),
      `--until ${shellJoin([loopUntil])}`,
      ...(maxIterations !== undefined ? [`--max-iterations ${maxIterations}`] : []),
      ...(maxWallMs !== undefined ? [`--max-wall-ms ${maxWallMs}`] : []),
    ].join(" ");
    const parsed = parseLoopArgs(raw);
    return parsed.success
      ? { kind: "ok", loop: parsed.loop }
      : { kind: "usage", message: parsed.error };
  }

  return { kind: "ok" };
}

function persistedAutonomyRequest(
  cwd: string,
  env: NodeJS.ProcessEnv,
): AutonomyPostureRequest | undefined {
  const mode = loadProjectAutopilotMode(cwd, env)?.mode;
  if (mode === undefined) return undefined;
  return {
    mode,
    source: "human",
    userConfirmed: true,
    // A prior-session human decision loaded from deny-write config, not a live confirmation this
    // session — the mode.change audit record is marked persisted so it reads honestly (QC §7).
    persisted: true,
    reason:
      mode === "project-autopilot"
        ? "persisted project Autopilot mode"
        : "persisted Autopilot mode",
  };
}

const ROUTABLE_PROVIDERS: readonly ProviderId[] = [
  "anthropic",
  "openai",
  "google",
  "openai-compatible",
];

function parseModelLabelForRouting(
  label: string | undefined,
): { readonly provider: ProviderId; readonly model: string } | undefined {
  if (label === undefined) return undefined;
  const slash = label.indexOf("/");
  if (slash <= 0 || slash === label.length - 1) return undefined;
  const provider = label.slice(0, slash) as ProviderId;
  if (!ROUTABLE_PROVIDERS.includes(provider)) return undefined;
  return { provider, model: label.slice(slash + 1) };
}

/**
 * Resolve a resume spec to a concrete session id for THIS workspace (Epic 1.23 slice 2). `id` returns
 * the id when its ledger exists (else undefined — fail closed, never a silent fresh session). `latest`
 * returns the most-recently-created session whose WORKSPACE HASH matches (ISO `createdAt` sorts
 * lexicographically), or undefined when the workspace has no prior session. The caller surfaces a clean
 * "nothing to resume" message on undefined.
 */
export function resolveResumeId(
  spec: ResumeSpec,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (spec.kind === "id") {
    // A malformed id (sessionPath validates the `ses_<ULID>` shape) or a non-existent ledger both
    // resolve to "nothing to resume" — fail closed, never a thrown error or a silent fresh session.
    try {
      return existsSync(sessionPath(spec.id, env)) ? spec.id : undefined;
    } catch {
      return undefined;
    }
  }
  // Scope to THIS workspace by the one-way cwd hash (ADR-0054), NOT the stored `cwd`: the latter is
  // redacted at write (SEC-014) and lossy — deep paths collapse to a single `[redacted:high-entropy]`
  // literal, so matching on it would let `--continue` resume (and cross-write) a DIFFERENT workspace's
  // ledger. `workspaceKey` is collision-free for distinct paths. Sessions written before the field
  // existed have no `cwdHash` and are intentionally not `--continue`-matched (use `--resume <id>`).
  const key = workspaceKey(cwd);
  const inCwd = listSessions(env).filter((s) => s.cwdHash === key);
  return inCwd.length === 0
    ? undefined
    : inCwd.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).id;
}

export function freshRunSessionIdFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  resume?: ResumeSpec,
): string | undefined {
  const raw = env[KEEL_RUN_SESSION_ID_ENV];
  if (raw === undefined || raw === "") return undefined;
  const parsed = SessionId.safeParse(raw);
  if (!parsed.success) throw new Error(`${KEEL_RUN_SESSION_ID_ENV} must be ses_<ULID>`);
  if (resume !== undefined) {
    throw new Error(`${KEEL_RUN_SESSION_ID_ENV} can only be used for fresh runs`);
  }
  return parsed.data;
}

export function assertFreshRunSessionIdAvailable(
  sessionId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (sessionId === undefined) return;
  if (existsSync(sessionPath(sessionId, env))) {
    throw new Error(
      `${KEEL_RUN_SESSION_ID_ENV} must name a fresh session; ${sessionId} already exists`,
    );
  }
}

export interface KeelSessionOpts {
  readonly model: ModelPort;
  readonly executor: ExecutorPort;
  readonly ui: UIPort;
  readonly store: SessionStore;
  readonly env?: NodeJS.ProcessEnv;
  /** Ambient HUD config (model label · cwd · posture) — shown in the trust-line and the first-run
   *  state. `runKeelCommand` builds it from the resolved model + cwd; omitted → blank model. */
  readonly view?: ViewConfig;
  /** A one-shot prompt (`keel run -p`). When set it is the seed and no first line is awaited; when
   *  absent (interactive), the first typed `line` becomes the seed after the first-run state. */
  readonly prompt?: string;
  /** Tool specs advertised to the model. Production governed mode currently advertises warden-backed
   *  `bash`; lower-level tests may inject other specs. Omitted → text-only. */
  readonly tools?: readonly ToolSpecT[];
  /** The stable system prompt (Epic 1.6b §4.7) — prepended as the seed's first message when set.
   *  Omitted → no system message (text-only / older tests). The bin passes `SYSTEM_PROMPT`. */
  readonly systemPrompt?: string;
  /** The environment snapshot (Epic 1.6b slice 3) — a contextual system message after the prompt.
   *  The bin gathers it (real fs/probes); omitted → none. */
  readonly environment?: string;
  /** The merged hierarchical AGENTS.md project instructions (Epic 1.7) — a post-trust system message.
   *  Gathered through the trust gate; omitted → none. */
  readonly instructions?: string;
  /** The SKILL.md discovery list (stubs) seeded as a post-trust system message (Epic 1.7). */
  readonly skills?: string;
  /** The run-start workspace-backup note (post-trust safety) — tells the agent only whether a private
   *  human recovery copy exists; never its path, contents, or a governed recovery command. */
  readonly backupNote?: string;
  /** Capability-derived mutating-action predicate (CAP-1) — forwarded to the runner's §4.10 boundary. */
  readonly isMutating?: RunSessionOpts["isMutating"];
  /** Epic-1.1 loop-safety controls forwarded to the loop (INT-1) — `runKeelCommand` sets production
   *  defaults (loop detection + a per-tool infra deadline + an optional token budget). */
  readonly stop?: RunSessionOpts["stop"];
  readonly loopDetection?: RunSessionOpts["loopDetection"];
  readonly infraTimeout?: RunSessionOpts["infraTimeout"];
  /** P0-3 structural enforcement probe — the loop halts fail-closed if the spawned warden dies. Built
   *  from the warden runtime's liveness; omitted for the local/eval runtime (no warden to lose). */
  readonly enforcement?: RunSessionOpts["enforcement"];
  readonly params?: RunSessionOpts["params"];
  /** Opt-in pre-completion verification (Epic 1.1b) — wired + tested but **default OFF** in
   *  `runKeelCommand`; enable with `KEEL_VERIFY=1`. A 2026-06-18 measurement found default-on
   *  net-negative (amplifies over-editing); see `productionLoopSafety` + the claim-ledger. */
  readonly verification?: RunSessionOpts["verification"];
  /** Epic 1.6c PR-d slice 5: the IN-LOOP context compactor (ER-021 flip). Forwarded to every turn's
   *  `runSession` so it fires at turn boundaries (RUNWAY); the re-drive bound (4b) keeps it from being
   *  re-folded each steering cycle. Omitted → no compaction (the default; flip OFF = zero behavior
   *  change). `runKeelCommand` constructs it from the env + budget when `KEEL_COMPACTION` is enabled. */
  readonly compactor?: RunSessionOpts["compactor"];
  /** Context-window metadata used by typed in-loop context pressure. */
  readonly contextWindow?: RunSessionOpts["contextWindow"];
  /** A resumed prior conversation (the messages `rebuild()` reconstructed from a reopened ledger —
   *  `keel --continue` / `--resume <id>`, Epic 1.23 slice 2). When set, the session SKIPS assembling a
   *  fresh `head` (system prompt + env + skills + AGENTS.md) — the resumed ledger already holds the
   *  original context — and seeds the REPL from these messages without re-recording them. */
  readonly resumed?: readonly ModelMessageT[];
  /** Internal ledger-derived tool outcomes for honest resumed presentation; never model-visible. */
  readonly resumedFailedToolCallIds?: ReadonlySet<string>;
  /** Occurrence-precise ledger-derived tool outcomes for honest resumed presentation. */
  readonly resumedFailedToolMessageIndexes?: ReadonlySet<number>;
  /** Number of pending steering comments applied during resume, surfaced in the resume notice. */
  readonly resumedSteeringApplied?: number;
  /** Verified Warden-audit receipt for prior human once-only authority. Presentation-only and never
   *  included in provider context or appended to the session ledger. */
  readonly historicOnceApprovalReceipt?: string;
  readonly goal?: GoalT;
  readonly loop?: LoopConfigT;
  /** Epic 2.15b: the trusted lifecycle manifest from the warden runtime, so a goal's `--validation`
   *  tier runs its required actions for a real completion verdict (absent → honest `not_run`). */
  readonly lifecycleManifest?: LifecycleManifestT;
  /** Interactive human review bridge. Omitted for one-shot/headless runs. */
  readonly reviewDecisions?: RunSessionOpts["reviewDecisions"];
  /** Interactive exact-resource Plan Autopilot bridge. Omitted for one-shot/headless runs. */
  readonly planApprovals?: InteractivePlanApprovalController;
}

/**
 * Run one keel session end-to-end with INJECTED ports. The seed is the `-p` prompt (one-shot) or
 * the first typed line (interactive). After the seed, `runSession` (slice 7) owns the run — teeing
 * to the ledger, rendering, and applying mid-run steering pulled from the same `ui.inputs()`.
 *
 * The production construction of the real provider + Workspace + tools + compaction is Epic 1.6,
 * which supplies those ports here. Multi-turn REPL continuity is part of that production entrypoint;
 * slice 8 proves one turn end-to-end. `ui.inputs()` is a single shared iterator (see `InputQueue`),
 * so the first-line pull and the runner's steering pulls never race.
 */
export async function runKeelSession(opts: KeelSessionOpts): Promise<RunOutcome> {
  // The leading system context (prompt + env snapshot + skills + AGENTS.md), recorded once on the
  // first turn. On RESUME this is skipped — the resumed ledger already holds the original context, so
  // re-seeding it would duplicate the system prompt and re-record it (Epic 1.23 slice 2).
  const head: ModelMessageT[] = [];
  if (opts.resumed === undefined) {
    if (opts.systemPrompt !== undefined) head.push({ role: "system", content: opts.systemPrompt });
    if (opts.environment !== undefined) head.push({ role: "system", content: opts.environment });
    if (opts.skills !== undefined) head.push({ role: "system", content: opts.skills });
    if (opts.instructions !== undefined) head.push({ role: "system", content: opts.instructions });
    if (opts.backupNote !== undefined) head.push({ role: "system", content: opts.backupNote });
  }

  // Shared runner options for every turn (the per-turn seed/history are added at the call site).
  const runnerBase = {
    model: opts.model,
    executor: opts.executor,
    ui: opts.ui,
    store: opts.store,
    ...(opts.view !== undefined ? { view: opts.view } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.isMutating !== undefined ? { isMutating: opts.isMutating } : {}),
    ...(opts.stop !== undefined ? { stop: opts.stop } : {}),
    ...(opts.loopDetection !== undefined ? { loopDetection: opts.loopDetection } : {}),
    ...(opts.infraTimeout !== undefined ? { infraTimeout: opts.infraTimeout } : {}),
    ...(opts.enforcement !== undefined ? { enforcement: opts.enforcement } : {}),
    ...(opts.params !== undefined ? { params: opts.params } : {}),
    ...(opts.verification !== undefined ? { verification: opts.verification } : {}),
    ...(opts.compactor !== undefined ? { compactor: opts.compactor } : {}),
    ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
    ...(opts.lifecycleManifest !== undefined ? { lifecycleManifest: opts.lifecycleManifest } : {}),
    ...(opts.reviewDecisions !== undefined ? { reviewDecisions: opts.reviewDecisions } : {}),
  };

  // One-shot (`keel run -p`): the prompt is the seed.
  if (opts.prompt !== undefined) {
    const seed = [...head, { role: "user" as const, content: opts.prompt }];
    if (opts.loop !== undefined) {
      return await runBoundedLoopSession({
        ...runnerBase,
        seed,
        loop: opts.loop,
      });
    }
    return await runSession({
      ...runnerBase,
      seed,
      ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
    });
  }

  // Interactive: a PERSISTENT multi-turn REPL (Epic 1.23, resolves INT-3 / ER-035). `runRepl` owns the
  // UI lifecycle + the first-line pull + the between-turn loop; the system context `head` is recorded
  // once on turn 1. The session STAYS OPEN after each task — answering follow-ups — until the user
  // exits (Ctrl-D / EOF; `/exit`·`/quit` land in slice 1). An interrupt at the first idle prompt
  // (before any line) exits cleanly with no session content, as before.
  return await runRepl({
    ...runnerBase,
    head,
    ...(opts.resumed !== undefined ? { resumed: opts.resumed } : {}),
    ...(opts.resumedFailedToolCallIds !== undefined
      ? { resumedFailedToolCallIds: opts.resumedFailedToolCallIds }
      : {}),
    ...(opts.resumedFailedToolMessageIndexes !== undefined
      ? { resumedFailedToolMessageIndexes: opts.resumedFailedToolMessageIndexes }
      : {}),
    ...(opts.resumedSteeringApplied !== undefined
      ? { resumedSteeringApplied: opts.resumedSteeringApplied }
      : {}),
    ...(opts.historicOnceApprovalReceipt !== undefined
      ? { historicOnceApprovalReceipt: opts.historicOnceApprovalReceipt }
      : {}),
    ...(opts.planApprovals !== undefined ? { planApprovals: opts.planApprovals } : {}),
  });
}

/** Ports the bin hands to a live run. `model` is injected so tests drive the simulator and the bin
 *  supplies the real provider (Epic 1.6a Step 2). The environment snapshot is no longer supplied here:
 *  `runKeelCommand` gathers it **through the trust gate** (Epic 1.7 — trust-before-parse). */
export interface KeelCommandDeps {
  readonly model: ModelPort;
  readonly ui: UIPort;
  readonly cwd: string;
  /** Display label for the resolved provider/model (e.g. `anthropic/claude-sonnet-4-6`) shown in the
   *  trust-line HUD. The bin passes `${config.provider}/${config.model}`; omitted → a blank model. */
  readonly modelLabel?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Explicit `--trust` opt-in for this workspace (a human act; see `resolveWorkspaceTrust`). */
  readonly trustFlag?: boolean;
  /** Interactive terminal? Gates the first-open trust prompt (the bin passes the real TTY state). */
  readonly isTTY?: boolean;
  /** The interactive trust y/n effect — the bin renders the prompt + reads stdin; omitted = no prompt. */
  readonly promptTrust?: (info: { readonly cwd: string }) => Promise<boolean>;
  /** Internal/test injection for the production warden process. Omitted uses the real warden bin. */
  readonly warden?: ProductionWardenStartOptions;
  /** Internal/test injection for the post-trust fresh-run safety backup. */
  readonly backupWorkspace?: (
    cwd: string,
    runId: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<string | undefined>;
  /** Internal/test injection for the trusted-workspace cockpit git probe. */
  readonly readGitStatus?: (cwd: string, signal?: AbortSignal) => Promise<UiGitStatus | undefined>;
  /** Explicit human autonomy posture request. Runtime still fail-closes unless the workspace is trusted. */
  readonly autonomy?: AutonomyPostureRequest;
  /** Exact-resource Plan Autopilot request for this run. Runtime intersects trust with live workspace trust. */
  readonly planApproval?: PlanApprovalRunRequest;
  /** Resume an existing session (Epic 1.23 slice 2 — `keel --continue` / `--resume <id>`). When it
   *  resolves to a real session, keel CONTINUES that ledger (append-only) seeded from its rebuilt
   *  history; an unresolvable spec falls back to a fresh session. */
  readonly resume?: ResumeSpec;
  /** Epic 2.12 run-control objects parsed by the CLI. They are explicit, additive run contracts:
   *  neither grants authority, changes policy, nor affects workspace trust. */
  readonly goal?: GoalT;
  readonly loop?: LoopConfigT;
}

/**
 * The bin's run orchestration (Epic 1.6a Step 2), kept here (gated + tested) so the `bin` stays a
 * thin argv→I/O wrapper: **resolve workspace trust and load project context through the gate**
 * (Epic 1.7), build the real tool runtime + a fresh session at `cwd`, run one `runKeelSession`
 * (the `-p` prompt one-shot or interactive), then ALWAYS release the shell session and close the
 * ledger. `model` is injected — the bin passes the real provider, tests the simulator.
 *
 * Trust is resolved **before** anything project-touching: an untrusted/declined workspace runs with
 * **empty** project context (no environment snapshot, no AGENTS.md, no skills) — the agent stays
 * functional; only an explicit human opt-in unlocks project context (§3.2(4), SEC-012).
 */
/**
 * Run-start workspace backup (the structural input-safety net, ON by default for a trusted run). Copies
 * the workspace to `$KEEL_HOME/snapshots/<runId>` BEFORE the agent acts so an irreplaceable input it
 * destroys is recoverable — model-independent (the TB-2 db-wal-recovery failure: keel deleted the file
 * it was asked to recover). Fail-open + opt-out via `KEEL_NO_SNAPSHOT=1`. Returns a bounded system
 * message that discloses only whether the private human recovery copy exists (or `undefined` when
 * opted out), never its path or contents. `keelHome` is excluded so a workspace that contains it never
 * recurses into keel's own state.
 */
async function backupNoteForRun(
  cwd: string,
  runId: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (["1", "true", "yes"].includes((env["KEEL_NO_SNAPSHOT"] ?? "").toLowerCase()))
    return undefined;
  const home = keelHome(env);
  const result = await snapshotWorkspace({
    root: cwd,
    dest: join(home, "snapshots", runId),
    privateRoot: home,
    exclude: [home],
  });
  return backupSystemMessage(result);
}

export async function runKeelCommand(
  prompt: string | undefined,
  deps: KeelCommandDeps,
): Promise<RunOutcome> {
  const env = deps.env ?? process.env;
  const pinnedFreshSessionId = freshRunSessionIdFromEnv(env, deps.resume);
  assertFreshRunSessionIdAvailable(pinnedFreshSessionId, env);
  const ctx = await gatherProjectContext({
    cwd: deps.cwd,
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.trustFlag !== undefined ? { trustFlag: deps.trustFlag } : {}),
    ...(deps.isTTY !== undefined ? { isTTY: deps.isTTY } : {}),
    ...(deps.promptTrust !== undefined ? { promptTrust: deps.promptTrust } : {}),
  });
  activateTerminalLifecycle(deps.ui);
  const { environment, instructions, skills } = ctx;
  const loopSafety = productionLoopSafetyWithAcceptance(env, {
    cwd: deps.cwd,
    workspaceTrusted: ctx.trusted,
  });
  const modelParams = productionModelParams(env);
  const contextWindowSpec = contextWindow(env, deps.modelLabel, modelParams.model);
  // Resume (Epic 1.23 slice 2): resolve the spec to a session for this cwd. When it resolves, CONTINUE
  // that ledger — reopen it for append and seed the REPL from its rebuilt history (no re-seeding of the
  // original system context; no re-snapshot — per the owner decision). An unresolvable spec (typo /
  // gone / none yet) falls back to a fresh session.
  const resumeId =
    deps.resume !== undefined ? resolveResumeId(deps.resume, deps.cwd, deps.env) : undefined;
  // Corrupt-ledger behavior is honest-by-construction and deliberate (Epic 1.23 QC): a CORRUPT ledger
  // under `--continue` is skipped by `listSessions`, so `resolveResumeId` returns undefined here and we
  // start FRESH; under an explicit `--resume <id>` the `readSession` below throws `SessionCorruptError`
  // (or, for a newer keel's ledger, `SessionNewerVersionError` with an honest "upgrade keel" message —
  // ADR-0072 §4), which propagates to the bin (printed, exit non-zero) — the user named THAT session,
  // so we refuse rather than silently continue elsewhere. Both paths are tested.
  const resumeState = resumeId !== undefined ? rebuild(readSession(resumeId, deps.env)) : undefined;
  const openingSessions =
    prompt === undefined && resumeState === undefined ? listSessions(env) : [];
  const recentSessions =
    openingSessions.length > 0 ? buildRecentSessionRows(openingSessions, deps.cwd) : [];
  const usageDigest =
    prompt === undefined && resumeState === undefined
      ? buildUsageDigest(openingSessions, deps.cwd)
      : undefined;
  const openingView: ViewConfig = {
    cwd: deps.cwd,
    workspaceTrust: ctx.trusted ? "trusted" : "untrusted",
    ...(deps.modelLabel !== undefined ? { model: deps.modelLabel } : {}),
    ...(recentSessions.length > 0 ? { recentSessions } : {}),
    ...(usageDigest !== undefined ? { usageDigest } : {}),
    context: { maxTokens: contextWindowSpec.tokens },
  };
  // The session ledger is created BEFORE the tool runtime so the just-in-time `retrieve` tool + the
  // in-loop compactor can both read it (Epic 1.6c PR-d slice 5). The shell is created after the store,
  // so `SessionStore.create` can no longer orphan a detached bash group; the store is closed in the
  // OUTER finally (always), the shell disposed in the inner finally.
  const store =
    resumeId !== undefined
      ? SessionStore.open(resumeId, deps.env)
      : SessionStore.create(
          {
            cwd: deps.cwd,
            ...(pinnedFreshSessionId === undefined ? {} : { id: pinnedFreshSessionId }),
          },
          deps.env,
        );
  let closeOpeningUi = false;
  let backupNotePending:
    | Promise<{ readonly note: string | undefined } | { readonly error: unknown }>
    | undefined;
  let gitStatusPending: Promise<UiGitStatus | undefined> | undefined;
  let gitStatusValue: UiGitStatus | undefined;
  let gitStatusAbort: AbortController | undefined;
  try {
    if (prompt === undefined && resumeState === undefined) {
      // Establish cleanup ownership before the first render call so even a partially mounted Ink
      // shell that throws during render is restored by the outer finally.
      closeOpeningUi = true;
      deps.ui.render(
        reduce(
          firstRunView({
            ...openingView,
            startup: { phase: "starting-protections" },
          }),
          { type: "awaiting-input" },
        ),
      );
      // The command owns this early-painted shell until the governed runtime has started and
      // `runKeelSession` takes over the normal one-shot/REPL lifecycle. Startup rejection must restore
      // the terminal here because neither runner has been entered yet.
    }
    // The safety backup and warden startup are independent post-trust work. Start the backup after
    // first paint, then await it before the model can act; this removes serialized startup latency
    // without reading an untrusted tree or weakening the pre-action recovery guarantee.
    backupNotePending =
      ctx.trusted && resumeId === undefined
        ? Promise.resolve()
            .then(() => (deps.backupWorkspace ?? backupNoteForRun)(deps.cwd, store.id, env))
            .then(
              (note) => ({ note }) as const,
              (error: unknown) => ({ error }) as const,
            )
        : Promise.resolve({ note: undefined } as const);
    // Git is cosmetic and can read repo-local config. Start it only after the backup has finished so
    // it cannot race the recovery snapshot, then consume only a result already available when the
    // governed shell becomes ready. It never gates input readiness.
    gitStatusAbort = new AbortController();
    gitStatusPending = ctx.trusted
      ? backupNotePending
          .then((backup) =>
            "error" in backup
              ? undefined
              : deps.readGitStatus !== undefined
                ? deps.readGitStatus(deps.cwd, gitStatusAbort?.signal)
                : gitStatusAsync(deps.cwd, undefined, gitStatusAbort?.signal),
          )
          .then((status) => {
            gitStatusValue = status;
            return status;
          })
          .catch(() => undefined)
      : Promise.resolve(undefined);
    const resumedSteeringApplied = resumeState?.pendingSteering.length ?? 0;
    const historicOnceApprovalReceipt =
      resumeId === undefined
        ? undefined
        : (() => {
            const loaded = historicOnceApprovalReceiptFromAudit(
              productionWardenAuditDir(env, deps.warden),
              resumeId,
            );
            return loaded.status === "none" ? undefined : loaded.content;
          })();
    const routeLabel = parseModelLabelForRouting(deps.modelLabel);
    let model = deps.model;
    let modelRouting: ModelRouteController | undefined;
    if (routeLabel !== undefined) {
      const catalog = createSingleModelCatalog(routeLabel);
      const policy = createLockedModelRoutingPolicy(catalog.entries[0]!.ref);
      const routeController: { current?: ModelRouteController } = {};
      const gateway = new ModelGateway({
        delegate: deps.model,
        catalog,
        policy,
        onDecision: (decision) => routeController.current?.record(decision),
      });
      const controller = new ModelRouteController(
        undefined,
        () => gateway.preview({ messages: [] }),
        (decision) => appendModelRouteDecision(store, decision),
      );
      routeController.current = controller;
      model = gateway;
      modelRouting = controller;
    }
    // Epic 1.6c PR-d slice 5 (ER-021 flip): the in-loop compactor is enabled via `KEEL_COMPACTION`
    // (default OFF — an unset value runs IDENTICALLY to pre-1.6c). `retrieve` remains withheld from
    // governed product mode until its own warden disposition lands; the compactor still reads this
    // ledger internally for fold decisions.
    const compactionOn = compactionEnabled(env);
    const readEvents = (): readonly SessionEventT[] => readSession(store.id, deps.env).events;
    // Executor selection. Production is ALWAYS the governed warden; the eval-only direct executor is
    // structurally unreachable in a release binary (build-time + runtime gates — eval-executor-gate.ts).
    const executorMode = resolveExecutorMode(env);
    if (deps.planApproval !== undefined && deps.autonomy !== undefined) {
      throw new Error("run plan approval cannot combine with an autonomy posture request");
    }
    const planApproval: PlanApprovalEnvelope | undefined =
      deps.planApproval === undefined
        ? undefined
        : {
            planId: deps.planApproval.planId,
            trustedWorkspace: ctx.trusted,
            resources: deps.planApproval.resources,
          };
    const autonomy =
      deps.planApproval === undefined
        ? (deps.autonomy ?? persistedAutonomyRequest(deps.cwd, env))
        : undefined;
    const reviewDecisions =
      prompt === undefined ? createInteractiveReviewDecisionController() : undefined;
    let rt!: ProductionWardenRuntime;
    /* v8 ignore start -- eval-only wiring: the decision is unit-tested in eval-executor-gate.test.ts,
       the direct/bridge runtimes are unit-tested in eval-direct-runtime.test.ts, and the product
       bridge path is covered by product-path-honesty.test.ts by deliberately flipping the eval-build
       global inside the test. The real production guarantee remains the compiled binary gate:
       release builds inject false; bin-eval injects true only for benchmark artifacts. */
    if (executorMode.kind === "eval-direct") {
      const directRuntime = createEvalDirectRuntime({
        cwd: deps.cwd,
        env,
        ...(compactionOn ? { readEvents } : {}),
      });
      if (!evalDirectInteractiveConsoleRequested(env)) {
        rt = directRuntime;
      } else {
        let consoleRuntime: ProductionWardenRuntime | undefined;
        try {
          consoleRuntime = await createProductionWardenRuntime({
            cwd: deps.cwd,
            sessionId: store.id,
            env,
            workspaceTrusted: ctx.trusted,
            ...(resumeId === undefined
              ? {}
              : {
                  resumeCommand:
                    deps.resume?.kind === "id" ? `keel --resume ${resumeId}` : "keel --continue",
                }),
            ...(autonomy === undefined ? {} : { autonomy }),
            ...(planApproval === undefined ? {} : { planApproval }),
            onReviewAutoResolved: (event) => appendWardenAutoResolvedEvent(store, event),
            ...(reviewDecisions === undefined
              ? {}
              : { onReviewRequired: reviewDecisions.onReviewRequired }),
            executeTimeoutMs: resolveWardenExecuteTimeoutMs(env),
            ...(deps.warden === undefined ? {} : { start: deps.warden }),
          });
          rt = createEvalDirectConsoleBridgeRuntime({
            direct: directRuntime,
            console: consoleRuntime,
          });
        } catch (error) {
          await throwEvalDirectConsoleBridgeStartupFailure(error, directRuntime, consoleRuntime);
        }
      }
    } else {
      /* v8 ignore stop */
      rt = await createProductionWardenRuntime({
        cwd: deps.cwd,
        sessionId: store.id,
        env,
        workspaceTrusted: ctx.trusted,
        ...(resumeId === undefined
          ? {}
          : {
              resumeCommand:
                deps.resume?.kind === "id" ? `keel --resume ${resumeId}` : "keel --continue",
            }),
        ...(autonomy === undefined ? {} : { autonomy }),
        ...(planApproval === undefined ? {} : { planApproval }),
        onReviewAutoResolved: (event) => appendWardenAutoResolvedEvent(store, event),
        ...(reviewDecisions === undefined
          ? {}
          : { onReviewRequired: reviewDecisions.onReviewRequired }),
        // Eval-aware RPC execute backstop: production stays 630s; a benchmark eval build with a raised
        // bash ceiling gets `ceiling + 30s` so long commands are not clipped at 630s (mirrors the Warden timeout contract for
        // the warden path). Structurally gated — inert in a release binary.
        executeTimeoutMs: resolveWardenExecuteTimeoutMs(env),
        ...(deps.warden === undefined ? {} : { start: deps.warden }),
      });
    }
    // Apply any still-pending queued steering from the resumed ledger before the first new turn, but
    // only after the Warden has atomically acquired this session's authoritative audit-writer lock.
    // A concurrent resume therefore cannot consume queued input or append steering before startup
    // fails closed. `resumed` seeds the REPL's model context (history + the injected steering).
    const resumed =
      resumeState === undefined ? undefined : applyPendingSteeringOnResume(store, resumeState);
    try {
      const loopSafetyWithRuntimeAcceptance =
        loopSafety.verification === undefined || rt.activeLeases === undefined
          ? loopSafety
          : {
              ...loopSafety,
              verification: {
                ...loopSafety.verification,
                dynamicAcceptance: () =>
                  acceptanceContractFromProcessLeases(rt.activeLeases?.() ?? [], {
                    cwd: deps.cwd,
                  }),
              },
            };
      // Run-start workspace backup (post-trust safety net) — only for a TRUSTED, FRESH run (keel must not
      // read/copy an untrusted one — SEC-012; a resume skips re-snapshotting per the owner decision).
      // Correlated with the session by id; fail-open.
      const backupResult = await backupNotePending;
      if ("error" in backupResult) throw backupResult.error;
      const backupNote = backupResult.note;
      const compactor = compactionOn
        ? buildInLoopCompactor(
            store,
            readEvents,
            env,
            loopSafety,
            deps.modelLabel,
            modelParams.model,
          )
        : undefined;
      // Cockpit git segment (Epic 1.24 Tier-A QC): probe ONLY a trusted workspace (git can run repo
      // config/hooks; consistent with the trust-gated backup/context). Fail-soft → omitted, never `n/a`.
      const git = gitStatusValue;
      const planApprovals =
        prompt === undefined && (autonomy === undefined || autonomy.mode === "guided")
          ? createInteractivePlanApprovalController({
              executor: rt.executor,
              cwd: deps.cwd,
              trustedWorkspace: ctx.trusted,
              view: rt.view,
            })
          : undefined;
      closeOpeningUi = false;
      return await runKeelSession({
        model,
        executor: rt.executor,
        tools: rt.tools,
        isMutating: rt.isMutating,
        // P0-3: the loop halts fail-closed if the spawned warden dies mid-session. The local/eval
        // runtime spawns no warden and omits `wardenAvailable`, so the probe is simply absent there.
        ...(rt.wardenAvailable !== undefined
          ? { enforcement: { available: () => rt.wardenAvailable!() } }
          : {}),
        ui: deps.ui,
        store,
        // Ambient HUD config: resolved model · cwd · trusted git · factual warden posture/policy · the
        // context window denominator. `ctx%` renders only when an explicit active-window percent exists.
        // No cost segment (no honest source — Tier-A QC).
        view: {
          ...openingView,
          ...rt.view,
          ...(deps.modelLabel !== undefined ? { model: deps.modelLabel } : {}),
          ...(modelRouting !== undefined ? { modelRoute: modelRouting.status() } : {}),
          ...(git !== undefined ? { git } : {}),
        },
        systemPrompt: SYSTEM_PROMPT,
        ...loopSafetyWithRuntimeAcceptance,
        params: modelParams,
        ...(environment !== undefined ? { environment } : {}),
        ...(instructions !== undefined ? { instructions } : {}),
        ...(skills !== undefined ? { skills } : {}),
        ...(backupNote !== undefined ? { backupNote } : {}),
        ...(deps.env !== undefined ? { env: deps.env } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(deps.goal !== undefined ? { goal: deps.goal } : {}),
        ...(deps.loop !== undefined ? { loop: deps.loop } : {}),
        ...(rt.lifecycleManifest !== undefined ? { lifecycleManifest: rt.lifecycleManifest } : {}),
        ...(compactor !== undefined ? { compactor } : {}),
        contextWindow: contextWindowSpec,
        ...(resumed !== undefined ? { resumed } : {}),
        ...(resumeState !== undefined
          ? {
              resumedFailedToolCallIds: resumeState.failedToolCallIds,
              resumedFailedToolMessageIndexes: resumeState.failedToolMessageIndexes,
            }
          : {}),
        ...(resumedSteeringApplied > 0 ? { resumedSteeringApplied } : {}),
        ...(historicOnceApprovalReceipt === undefined ? {} : { historicOnceApprovalReceipt }),
        ...(modelRouting !== undefined ? { modelRouting } : {}),
        ...(reviewDecisions !== undefined ? { reviewDecisions } : {}),
        ...(planApprovals !== undefined ? { planApprovals } : {}),
      });
    } finally {
      await rt.dispose();
    }
  } finally {
    try {
      // Restore a partially mounted terminal immediately on startup failure; a slow backup must not
      // hold the user's TTY hostage after the governed runtime has already failed.
      if (closeOpeningUi) await deps.ui.close();
    } finally {
      try {
        // Startup may fail while the post-trust backup is still running. Join command-owned filesystem
        // work before releasing the store; its captured error must not replace the original startup
        // failure (the successful-runtime path above remains responsible for propagating backup errors).
        gitStatusAbort?.abort();
        await backupNotePending;
        // The production probe is independently bounded and owns its process group. Do not join an
        // injected or wedged cosmetic probe during teardown; its rejection is already contained.
        void gitStatusPending;
      } finally {
        store.close();
      }
    }
  }
}

export async function runAuditExportCommand(options: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly outPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly warden?: ProductionWardenStartOptions;
}): Promise<string> {
  const env = options.env ?? process.env;
  const outPath = options.outPath ?? join(keelHome(env), "audit", "exports");
  const result = await exportAuditSession({
    sessionId: options.sessionId,
    outPath,
    cwd: options.cwd,
    env,
    workspaceTrusted: false,
    ...(options.warden === undefined ? {} : { start: options.warden }),
  });
  return `exported audit bundle: ${result.bundlePath}\nroot hash: ${result.rootHash}`;
}

export function runAuditVerifyCommand(options: { readonly bundlePath: string }): string {
  const diagnosis = verifyEvidenceBundle(options.bundlePath);
  if (!diagnosis.ok) {
    throw new Error(`${diagnosis.kind}: ${diagnosis.detail}`);
  }
  return [
    `verified audit bundle: ${options.bundlePath}`,
    `root hash: ${diagnosis.rootHash}`,
    `records: ${diagnosis.recordCount}`,
    `checkpoints: ${diagnosis.checkpointCount}`,
    `signer checkpoint key: ${diagnosis.manifest.signer.checkpointPublicKey}`,
    "Compare the signer checkpoint key with the warden's published or out-of-band key before treating this bundle as authentic.",
  ].join("\n");
}

/** Whether the Epic 1.6c in-loop compaction flip (ER-021) is enabled. Default OFF — an unset/false
 *  `KEEL_COMPACTION` runs identically to pre-1.6c (flip OFF = zero behavior change; tested both ways). */
export function compactionEnabled(env: NodeJS.ProcessEnv): boolean {
  return ["1", "true", "yes"].includes((env["KEEL_COMPACTION"] ?? "").toLowerCase());
}

const DEFAULT_RESPONSE_MAX_OUTPUT_TOKENS = 16_384;

/** The context window keel budgets against (the compactor target + the cockpit `ctx%` denominator —
 *  ONE source so they can't drift). `KEEL_CONTEXT_WINDOW` override, provider/model metadata, else
 *  conservative fallback. */
function capabilityProvider(provider: string | undefined): ProviderId | undefined {
  return ROUTABLE_PROVIDERS.includes(provider as ProviderId) ? (provider as ProviderId) : undefined;
}

function routedProvider(env: NodeJS.ProcessEnv, modelLabel?: string): string {
  return parseModelLabelForRouting(modelLabel)?.provider ?? env["KEEL_PROVIDER"] ?? "anthropic";
}

function contextWindow(
  env: NodeJS.ProcessEnv,
  modelLabel?: string,
  paramsModel?: string,
): ContextWindowSpec {
  const routed = parseModelLabelForRouting(modelLabel);
  const model = paramsModel ?? routed?.model ?? env["KEEL_MODEL"];
  return resolveContextWindow({
    env,
    provider: routed?.provider ?? env["KEEL_PROVIDER"] ?? "anthropic",
    ...(model !== undefined ? { model } : {}),
  });
}

/**
 * Build the in-loop compactor for the production flip (Epic 1.6c PR-d slice 5). RUNWAY-primary
 * (`maxGrossTokens` = the cost-aware backstop, ADR-0044) with the cache net-gain guard (ADR-0046); the
 * fold escalation uses the deterministic, model-free facts summarizer (OQ-10 default — honest, zero
 * extra cost). When no gross cap is configured the runway trigger is inert (`+Infinity`) and compaction
 * is driven by context-window pressure alone — both bounded by the slice-4 re-compaction guard.
 */
function buildInLoopCompactor(
  store: SessionStore,
  readEvents: () => readonly SessionEventT[],
  env: NodeJS.ProcessEnv,
  loopSafety: ReturnType<typeof productionLoopSafety>,
  modelLabel?: string,
  paramsModel?: string,
): RunSessionOpts["compactor"] {
  const provider = capabilityProvider(routedProvider(env, modelLabel));
  const window = contextWindow(env, modelLabel, paramsModel);
  // §4.7.2 recent-verbatim tail (turns kept un-compressed). Tunable via `KEEL_COMPACTION_RECENT`;
  // unset → the pass/fold default (6). The pre-registered ablation tunes it (measure-don't-assume).
  const recentVerbatimTurns = positiveIntEnv(env["KEEL_COMPACTION_RECENT"]);
  return createInLoopCompactor({
    store,
    readEvents,
    budgetTokens: window.tokens,
    maxGrossTokens: loopSafety.stop?.budget?.maxGrossTokens ?? Number.POSITIVE_INFINITY,
    cacheReadWeight: provider !== undefined ? CAPABILITIES[provider].cacheReadWeight : 1.0,
    summarize: deterministicFactsSummary,
    ...(recentVerbatimTurns !== undefined ? { recentVerbatimTurns } : {}),
  });
}

/** A positive-integer env value, or `undefined` for absent/empty/invalid (never silently truncate
 *  a real run with a guessed cap — only an explicit, valid value enables one). */
function positiveIntEnv(raw: string | undefined): number | undefined {
  // Base-10 digits only — reject hex (`0x10`), scientific (`1e3`), signs, and decimals, which `Number`
  // would silently coerce to surprising caps. `Number.isSafeInteger` then rejects a digit string beyond
  // 2^53 (which would be an effectively-unbounded cap). A leading-zero string is accepted as its value.
  if (raw === undefined) return undefined;
  const s = raw.trim();
  if (!/^[0-9]+$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Production per-response model params. This is a single-turn output ceiling, separate from the
 *  cumulative output-token budget rail (`KEEL_MAX_OUTPUT_TOKENS`). It prevents provider-default
 *  truncation from surprising autonomous runs while keeping tool execution safety in the loop. */
export function productionModelParams(
  env: NodeJS.ProcessEnv,
): NonNullable<KeelSessionOpts["params"]> {
  return {
    maxOutputTokens:
      positiveIntEnv(env["KEEL_MAX_RESPONSE_TOKENS"]) ?? DEFAULT_RESPONSE_MAX_OUTPUT_TOKENS,
  };
}

const INFRA_TOOL_TIMEOUT_MARGIN_MS = 60_000;

function infraToolTimeoutMs(env: NodeJS.ProcessEnv): number {
  const bashMaxTimeoutMs = resolveEvalBashMaxTimeoutMs(env) ?? PRODUCTION_BASH_MAX_TIMEOUT_MS;
  return bashMaxTimeoutMs + INFRA_TOOL_TIMEOUT_MARGIN_MS;
}

/** Production loop-safety options for `runKeelCommand` (INT-1). Loop detection + a per-tool infra
 *  deadline are always on; the cost-aware budget triad (ADR-0044) is enabled when ANY of the three
 *  caps is a positive integer (so a legit long task is never cut off by a guessed default):
 *  - `KEEL_MAX_TOKENS`       — primary EFFECTIVE-cost cap (cached weighted by the provider's rate).
 *  - `KEEL_MAX_GROSS_TOKENS` — raw input+output emergency backstop against runaway churn.
 *  - `KEEL_MAX_OUTPUT_TOKENS`— over-generation guard.
 *  - `KEEL_MAX_TURNS`        — explicit turn cap (ER-038): raises the loop's DEFAULT_MAX_TURNS so the
 *    cost-aware budget, not the turn cap, is what bounds a cached-heavy task's runway. Not a money cap.
 *  - `KEEL_MAX_FINALIZE_TURNS`— optional bounded progress-aware turns after `KEEL_MAX_TURNS`; invalid
 *    values are ignored, and the loop grants them only after typed verifier/build progress.
 *  - `KEEL_MAX_PROGRESS_RUNWAY_TURNS`— optional bounded extra turns for still-progressing verifier/build
 *    paths after `KEEL_MAX_TURNS`; enabled only when a token budget is also configured.
 *  - `KEEL_MAX_PROGRESS_RUNWAY_WALL_SEC`— optional wall-clock cap for that progress runway.
 *  The provider's `cacheReadWeight` (capability table) is plumbed in whenever a budget exists, so the
 *  effective cap is cost-true rather than a raw token counter. */
type ProductionLoopSafetyVerification = Omit<
  NonNullable<KeelSessionOpts["verification"]>,
  "acceptance"
>;

export function productionAcceptanceContract(
  env: NodeJS.ProcessEnv,
): AcceptanceContract | undefined {
  return acceptanceContractFromRequiredArtifacts(
    requiredArtifactsFromEnv(env["KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS"]),
  );
}

export interface ProductionLoopSafetyWithAcceptanceOptions {
  readonly cwd: string;
  readonly workspaceTrusted: boolean;
  readonly artifactReaderFactory?: typeof artifactReaderForRoot;
}

export function productionLoopSafetyWithAcceptance(
  env: NodeJS.ProcessEnv,
  opts: ProductionLoopSafetyWithAcceptanceOptions,
): {
  loopDetection: NonNullable<KeelSessionOpts["loopDetection"]>;
  infraTimeout: NonNullable<KeelSessionOpts["infraTimeout"]>;
  stop?: NonNullable<KeelSessionOpts["stop"]>;
  verification?: NonNullable<KeelSessionOpts["verification"]>;
} {
  // Production loop-safety defaults (INT-1): a real `keel run` must not be unguarded. Loop detection
  // (doom-loop guard) + a per-tool infra deadline (hung tool) are always on; the cost-aware token budget
  // is opt-in via `KEEL_MAX_TOKENS` (the EFFECTIVE-cost ceiling, ADR-0044 — cached input discounted per
  // provider; companion `KEEL_MAX_GROSS_TOKENS`/`KEEL_MAX_OUTPUT_TOKENS`), left unset by default so a
  // legitimately long task is bounded by `DEFAULT_MAX_TURNS`, never silently truncated by a guessed cap.
  const baseLoopSafety = productionLoopSafety(env);
  const configuredVerification = baseLoopSafety.verification;
  const configuredPreStop = configuredVerification?.preStop;
  const acceptanceContract = productionAcceptanceContract(env);
  if (acceptanceContract !== undefined && !opts.workspaceTrusted) {
    throw new Error(
      "KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS requires a trusted workspace before keel can read required artifact paths. Re-run with `--trust`, set `KEEL_TRUST=1`, or unset `KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS`.",
    );
  }
  if (configuredVerification === undefined && acceptanceContract === undefined) {
    return baseLoopSafety;
  }
  return {
    ...baseLoopSafety,
    verification: {
      ...(configuredVerification ?? {}),
      ...(configuredPreStop === undefined
        ? {}
        : {
            preStop: {
              ...configuredPreStop,
              check: { ...configuredPreStop.check, cwd: opts.cwd },
            },
          }),
      ...(acceptanceContract === undefined
        ? {}
        : {
            acceptance: {
              contract: acceptanceContract,
              readArtifact: (opts.artifactReaderFactory ?? artifactReaderForRoot)(opts.cwd),
            },
          }),
    },
  };
}

export function productionLoopSafety(env: NodeJS.ProcessEnv): {
  loopDetection: NonNullable<KeelSessionOpts["loopDetection"]>;
  infraTimeout: NonNullable<KeelSessionOpts["infraTimeout"]>;
  stop?: NonNullable<KeelSessionOpts["stop"]>;
  verification?: ProductionLoopSafetyVerification;
} {
  const maxTokens = positiveIntEnv(env["KEEL_MAX_TOKENS"]);
  const maxGrossTokens = positiveIntEnv(env["KEEL_MAX_GROSS_TOKENS"]);
  const maxOutputTokens = positiveIntEnv(env["KEEL_MAX_OUTPUT_TOKENS"]);
  // Turn cap (ER-038): explicit override of DEFAULT_MAX_TURNS. The cost-aware budget gives cached-heavy
  // tasks cost-proportional runway, but DEFAULT_MAX_TURNS=50 silently clamps it — so a benchmark that
  // means to test "more budget runway" actually tests "more runway until the turn cap". This knob lets
  // the operator raise the turn cap so the BUDGET is what binds. It is NOT a money cap (it bounds loop
  // depth, not spend); a real run still needs a token cap for cost-safety. Unset → the loop default applies.
  const maxTurns = positiveIntEnv(env["KEEL_MAX_TURNS"]);
  const configuredFinalizeTurns = positiveIntEnv(env["KEEL_MAX_FINALIZE_TURNS"]);
  const maxFinalizeTurns = configuredFinalizeTurns ?? (maxTurns !== undefined ? 2 : undefined);
  const configuredProgressRunwayTurns = positiveIntEnv(env["KEEL_MAX_PROGRESS_RUNWAY_TURNS"]);
  const configuredProgressRunwayWallSec = positiveIntEnv(env["KEEL_MAX_PROGRESS_RUNWAY_WALL_SEC"]);
  // Wall-clock run budget (ADR-0051 / Lever C): KEEL_MAX_WALL_SEC (seconds) → a graceful `"deadline"`
  // self-stop. Set it BELOW any external hard cap (e.g. the harbor agent timeout) so keel stops and
  // flushes its transcript first instead of being SIGKILLed. Unset → no time bound.
  const maxWallSec = positiveIntEnv(env["KEEL_MAX_WALL_SEC"]);
  const maxWallMs = maxWallSec !== undefined ? maxWallSec * 1000 : undefined;
  // Provider billing weight for cached input (default anthropic; unknown provider → conservative 1.0×).
  const provider = (env["KEEL_PROVIDER"] ?? "anthropic") as ProviderId;
  const cacheReadWeight = CAPABILITIES[provider]?.cacheReadWeight ?? 1.0;
  const hasBudget =
    maxTokens !== undefined || maxGrossTokens !== undefined || maxOutputTokens !== undefined;
  const maxProgressRunwayTurns =
    hasBudget && configuredProgressRunwayTurns !== undefined
      ? configuredProgressRunwayTurns
      : undefined;
  const maxProgressRunwayWallMs =
    maxProgressRunwayTurns !== undefined && configuredProgressRunwayWallSec !== undefined
      ? configuredProgressRunwayWallSec * 1000
      : undefined;
  // `stop` carries the turn cap and/or the cost-aware budget triad — present when EITHER is set, so a
  // turn cap can be raised independently of a token budget (and vice-versa).
  const stop =
    maxTurns !== undefined ||
    maxFinalizeTurns !== undefined ||
    maxProgressRunwayTurns !== undefined ||
    maxProgressRunwayWallMs !== undefined ||
    hasBudget ||
    maxWallMs !== undefined
      ? {
          ...(maxTurns !== undefined ? { maxTurns } : {}),
          ...(maxFinalizeTurns !== undefined ? { maxFinalizeTurns } : {}),
          ...(maxProgressRunwayTurns !== undefined ? { maxProgressRunwayTurns } : {}),
          ...(maxProgressRunwayWallMs !== undefined ? { maxProgressRunwayWallMs } : {}),
          ...(maxWallMs !== undefined ? { maxWallMs } : {}),
          ...(hasBudget
            ? {
                budget: {
                  cacheReadWeight,
                  ...(maxTokens !== undefined ? { maxTokens, warnThresholds: [0.8] } : {}),
                  ...(maxGrossTokens !== undefined ? { maxGrossTokens } : {}),
                  ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
                },
              }
            : {}),
        }
      : undefined;
  // Pre-completion verification interceptor (Epic 1.1b; spec §7 harness-hygiene **must-have**): inject
  // ONE "verify your work against the ORIGINAL task before declaring done" turn on the first completion
  // attempt (never re-intercepts — no infinite nag). The capability stays wired + tested, but it is
  // **DEFAULT OFF** — opt in with `KEEL_VERIFY=1`.
  //
  // Why default-off (honest, measured): a 2026-06-18 head-to-head on the 7 model-stop TB-2.1 tasks
  // (verify-ON vs verify-OFF, identical budget/model/infra — only this flag differed) showed the
  // interceptor **net-negative**: it converted clean model-stops into budget churn (7/7 → 2/7 ended
  // by stopping; the other 5 ran to the gross cap), **regressed 2 previously-passing tasks**
  // (circuit-fibsqrt, compile-compcert — the extra verification context stole the budget they needed
  // to converge), recovered **0** of the 2 target failures, and raised mean output ~49%. The dominant
  // failure mode the Epic 1.11 diagnosis surfaced is **over-editing / poor convergence**, and a
  // "verify and continue/fix" nudge *amplifies* it rather than fixing it — verification targets
  // *premature stopping*, the opposite mode. Until a STOP-biased redesign exists (or it earns its keep
  // under measurement), it must not be a default. Opt-in remains for that experimentation.
  // See docs/quality/claim-ledger.md (verification-interceptor row) for the data.
  const verifyOn = ["1", "true", "yes"].includes((env["KEEL_VERIFY"] ?? "").toLowerCase());
  // F6: the verify gate can ALSO skip re-nagging on a generic pytest pass (from a real run), not only
  // keel's own `TEST SUMMARY` banner. **DEFAULT OFF (fail-safe)** — the bounded fix-validation run fix-validation run
  // measured this broadening net-negative (it widened the skip enough to silence the gate-fire
  // `hf-model-inference`'s win depended on, with no offsetting win). Opt IN with `KEEL_GENERIC_SKIP=1`
  // purely to re-ablate it under a multi-seed run. When opted in it only affects how readily the gate
  // SKIPS already-passing work; it never relaxes the execution-grounding (the banner skips regardless).
  const genericSkipOn = ["1", "true", "yes"].includes(
    (env["KEEL_GENERIC_SKIP"] ?? "").toLowerCase(),
  );
  const verifyModeRaw = env["KEEL_VERIFY_MODE"]?.trim().toLowerCase();
  const verifyMode = verifyModeRaw === "" ? undefined : verifyModeRaw;
  if (verifyOn && verifyMode !== undefined && verifyMode !== "prompt" && verifyMode !== "prestop") {
    throw new Error(
      `KEEL_VERIFY_MODE must be "prompt" or "prestop" when KEEL_VERIFY is enabled; got ${JSON.stringify(
        env["KEEL_VERIFY_MODE"],
      )}`,
    );
  }
  const preStopCommand = env["KEEL_PRESTOP_CHECK_CMD"]?.trim();
  const preStop =
    verifyOn && preStopCommand !== undefined && preStopCommand.length > 0
      ? {
          check: {
            command: preStopCommand,
            timeoutMs: Math.min(
              positiveIntEnv(env["KEEL_PRESTOP_CHECK_TIMEOUT_MS"]) ??
                DEFAULT_PRESTOP_CHECK_TIMEOUT_MS,
              MAX_PRESTOP_CHECK_TIMEOUT_MS,
            ),
            maxOutputBytes: Math.min(
              positiveIntEnv(env["KEEL_PRESTOP_CHECK_MAX_OUTPUT_BYTES"]) ??
                DEFAULT_PRESTOP_CHECK_MAX_OUTPUT_BYTES,
              MAX_PRESTOP_CHECK_MAX_OUTPUT_BYTES,
            ),
          },
        }
      : undefined;
  if (verifyOn && verifyMode === "prestop" && preStop === undefined) {
    throw new Error(
      "KEEL_VERIFY_MODE=prestop requires a non-empty KEEL_PRESTOP_CHECK_CMD; refusing to fall back to the prompt-only verification gate.",
    );
  }
  // F7: escalate the advisory loop-breaker nudge across trips (reconsider → rewrite the plan → switch
  // strategy or stop) instead of repeating the same flat text. **DEFAULT OFF (fail-safe)** — the bounded fix-validation run
  // fix-validation run measured the escalation net-negative (it regressed `tune-mjcf` + `schemelike`,
  // both loop-breaker-dependent wins). Opt IN with `KEEL_LOOP_ESCALATION=1` to re-ablate it; default is
  // the original flat single-text behavior.
  const loopEscalationOn = ["1", "true", "yes"].includes(
    (env["KEEL_LOOP_ESCALATION"] ?? "").toLowerCase(),
  );
  return {
    loopDetection: {
      ...PROGRESS_CONTRACT_LOOP_CONFIG,
      recoverWithEvidence: true,
      stopOnRepeatedSuccessEvidence: true,
      ...(loopEscalationOn ? { escalateGuidance: true } : {}),
    },
    // Belt-and-suspenders backstop for a tool that never returns. Kept ABOVE the bash shell's own
    // per-command ceiling so a legitimate long command the model opted into is bounded by the
    // shell's own timeout, not pre-empted here. In practice the shell timeout settles the tool first,
    // so this rarely engages for bash — it covers a non-shell tool (or a shell whose own timer was
    // bypassed) that hangs past the configured bash ceiling. The ceiling can be raised only by the
    // eval-build/ack-gated bash timeout knob; production remains 600s + 60s.
    infraTimeout: { toolMs: infraToolTimeoutMs(env) },
    ...(verifyOn
      ? {
          verification: {
            genericSkip: genericSkipOn,
            ...(preStop !== undefined ? { preStop } : {}),
          },
        }
      : {}),
    ...(stop !== undefined ? { stop } : {}),
  };
}
