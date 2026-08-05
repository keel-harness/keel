import type {
  ExecutorPort,
  FinalAnswerContractT,
  FinishReasonT,
  ModelMessageT,
  ModelPort,
  ModelTurnInput,
  ModelUsageT,
  ToolInvocationT,
  ToolResultT,
  ToolSpecT,
} from "@keel/shared";
import { randomUUID } from "node:crypto";
import {
  markToolPresentationOutcome,
  toolControlFailureCode,
  toolPresentationOutcome,
  type ToolPresentationOutcome,
} from "./tool-presentation-outcome.js";
import { JsonObject, effectiveTokens } from "@keel/shared";
import {
  BLOCKED_AFTER_SYNTHESIS_CODE,
  BLOCKED_AFTER_SYNTHESIS_MESSAGE,
  GROSS_RUNWAY_PREFLIGHT_CODE,
  REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE,
  REVIEW_REQUIRED_AFTER_SYNTHESIS_MESSAGE,
  type KernelEventT,
} from "./events.js";
import {
  KERNEL_STRINGS,
  budgetWarningMessage,
  grossRunwayPreflightMessage,
  grossRunwayWarningMessage,
  infraTimeoutMessage,
  knownRedCompletionMessage,
  turnLimitFinalizeMessage,
  turnLimitProgressRunwayMessage,
} from "./strings.js";
import {
  classifyCompletion,
  findKnownRedCompletionEvidence,
  isReadOnlyCommand,
  knownRedCompletionEvidenceKey,
} from "./verify-gate.js";
import { LoopDetector } from "./loop-detection.js";
import type { LoopDetectionConfig, LoopSignal } from "./loop-detection.js";
import {
  buildProgressLedgerEntry,
  classifyToolCall,
  type ProgressCommandClass,
  type ProgressSuccessSignal,
} from "./run-control/progress-ledger.js";
import { finalizeOnlyEvidenceForToolResult } from "./run-control/finalize-eligibility.js";
import {
  callSuggestsArtifactWrite,
  createTerminalReviewRecoveryState,
  extractLoopFailureEvidence,
  extractStrongSuccessEvidence,
  recordTerminalReviewCorrectionSuccess,
  recordTerminalReviewToolResult,
  renderLoopRecoveryGuidance,
  takeTerminalReviewRecoveryCredit,
} from "./loop-recovery.js";
import { abortForToolDeadline, InfraError, withDeadline } from "./infra.js";
import { estimateTokens, messageTokens } from "./context/system-prompt.js";
import {
  computeContextPressure,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  estimateTrailingToolObservationTokens,
  type ContextPressure,
  type ContextUsageSource,
  type ContextWindowSpec,
} from "./context/pressure.js";
import {
  runFreshPreStopCheck,
  type PreStopCheck,
  type PreStopCheckRunner,
} from "./prestop-check.js";
import {
  acceptanceContractFromPreStopCheck,
  evaluateAcceptanceContract,
  hasAuthoritativeAcceptanceEvidence,
  mergeAcceptanceContracts,
  renderAcceptanceFailurePrompt,
  type AcceptanceCommandRunner,
  type AcceptanceContract,
  type ArtifactReader,
} from "./completion/acceptance-contract.js";
import {
  isTerminalReviewRecoveryAvailable,
  isTerminalReviewResult,
  terminalReviewResult,
} from "./warden/terminal-review.js";
import {
  markToolDeadlineSignal,
  takeToolDeadlineReviewResult,
} from "./warden/tool-deadline-review-result.js";
import { transferMutationPresentationResolver } from "./warden/mutation-presentation-resolver.js";
import {
  finalAnswerRewriteOutputTokens,
  finalAnswerRewritePrompt,
  validateFinalAnswer,
} from "./final-answer.js";

/** Termination controls. `maxTurns` always applies (default below); `budget` enforces the
 *  cost-aware token triad (ADR-0044). */
export interface AgentLoopStop {
  readonly maxTurns?: number;
  /** Bounded extra turns after `maxTurns`, granted only when the immediately preceding turn produced
   *  typed high-confidence progress evidence (for example a passing verifier/build signal) through the
   *  loop-detection progress classifier. `maxTurns + maxFinalizeTurns` is the absolute turn ceiling. */
  readonly maxFinalizeTurns?: number;
  /** Bounded extra turns after `maxTurns`, granted only with a configured token budget and fresh,
   *  typed progress evidence from verifier/build output. Unlike finalize turns, this may continue a
   *  still-progressing build/test path; stdout novelty alone is never sufficient evidence. */
  readonly maxProgressRunwayTurns?: number;
  /** Optional wall-clock cap in ms for progress-runway turns. Unset = no separate runway wall cap. */
  readonly maxProgressRunwayWallMs?: number;
  /** Wall-clock run budget in ms (ADR-0051 / Lever C). When set, the loop stops with `reason:
   *  "deadline"` once `now() - start >= maxWallMs` — a graceful self-stop before an external hard cap.
   *  Unset = no time bound (unchanged). The deadline also arms an abort that interrupts a long in-flight
   *  turn (mid-turn enforcement). */
  readonly maxWallMs?: number;
  readonly budget?: {
    /**
     * Primary **effective-cost** ceiling — this is the EFFECTIVE (cost-true) cap, **NOT a raw-token
     * cap**; for the raw cumulative cap see `maxGrossTokens` below. (The name is `maxTokens` for env
     * continuity with `KEEL_MAX_TOKENS`; do not read it as "gross tokens".) The loop stops when
     * `effectiveTokens(usage) >= maxTokens`, where `effective = fresh + cacheReadWeight·cached +
     * output` (ADR-0044). When the provider reports no `cachedInputTokens`, `effective == input +
     * output` — identical to the pre-ADR-0044 gross check, so non-caching providers are unchanged.
     */
    readonly maxTokens?: number;
    /** Billing weight of a cached input token vs a fresh one, in `[0,1]`. Provider data (the
     *  capability table's `cacheReadWeight`); the caller plumbs it in. Default **1.0** (cached
     *  counts at full price — gross-equivalent, the conservative behavior). */
    readonly cacheReadWeight?: number;
    /** Emergency **gross**-token backstop: stop when `input + output >= maxGrossTokens` regardless
     *  of caching, so a cached-heavy task cannot churn indefinitely on the cheap effective budget.
     *  (Turns are the primary churn bound; this is extra insurance.) Unset = no gross backstop. */
    readonly maxGrossTokens?: number;
    /** Fractions of `maxGrossTokens` at which to inject a one-shot cumulative-runway warning.
     * Separate from `warnThresholds`: gross churn and effective cost are different metrics. */
    readonly grossWarnThresholds?: readonly number[];
    /** **Output**-token over-generation guard: stop when cumulative `outputTokens >=
     *  maxOutputTokens`. Bounds runaway generation (e.g. repeated full-file rewrites). Unset = none. */
    readonly maxOutputTokens?: number;
    /** Fractions of `maxTokens` (e.g. [0.5, 0.8]) at which to inject one budget-awareness
     *  warning BEFORE the cap (Epic 1.1d), measured against the SAME effective-cost metric as the
     *  cap. Each must be in the open interval (0, 1) — 1.0 is rejected because it coincides with
     *  the cap and could never fire. Each warns once. Empty/unset = no warnings. */
    readonly warnThresholds?: readonly number[];
  };
}

// `effectiveTokens` (the ADR-0044 cost-true metric + its money-safety clamps) lives in `@keel/shared`
// so the in-loop budget here and the eval scoreboard/end-kind reconstruction share ONE definition.

/**
 * The in-loop compaction hook (Epic 1.6c, option A — serves RUNWAY). See `AgentLoopInput.compactor`.
 * Given the current context + cumulative usage at a turn boundary (and the run's abort `signal`, so a
 * long model fold can be cancelled — ER-021), returns the (possibly compacted) context to drive from.
 * Sync or async. Decouples the core loop from the compaction module. `signal` is the run's CURRENT
 * signal at the call (passed per-call, not captured, so it stays fresh across steering re-drives).
 * Any user-role messages retained in the result must be the original, unmodified message objects in
 * their original relative order; a compactor that mutates its input or clones, invents, reorders, or
 * duplicates user messages is discarded so authorship provenance stays exact.
 */
export type AgentCompactor = (
  messages: readonly ModelMessageT[],
  usage: ModelUsageT,
  signal?: AbortSignal,
  pressure?: ContextPressure,
) => Promise<readonly ModelMessageT[]> | readonly ModelMessageT[];

export interface AgentLoopInput {
  readonly messages: readonly ModelMessageT[];
  readonly tools?: readonly ToolSpecT[];
  /** Explicit task-scoped final-answer settlement (ADR-0087). Absent preserves the existing byte
   * stream and provider-call sequence. The inspection command is controller-authored human-side
   * copy; it is never exposed to governed tools as authority. */
  readonly finalAnswer?: {
    readonly contract: FinalAnswerContractT;
    readonly originalInspectionCommand: string;
  };
  readonly stop?: AgentLoopStop;
  readonly signal?: AbortSignal;
  readonly params?: ModelTurnInput["params"];
  /**
   * Opt-in pre-completion verification (Epic 1.1b). When present, the FIRST time the
   * model would stop (no tool calls), the loop injects one verification turn (the
   * general rubric, or `prompt` if given) and continues; the next stop exits. Never
   * re-intercepts after the first (no infinite nag). Absent = no interception.
   */
  readonly verification?: {
    readonly prompt?: string;
    /**
     * Recognize generic test-pass signals (a pytest summary line) when deciding to SKIP, not only
     * keel's own banner (F6). **Default `false` (fail-safe)** — the bounded fix-validation run run measured this
     * broadening net-negative (it silenced a gate-fire `hf-model-inference`'s win relied on). Set
     * `true` to opt in for a re-ablation. Opting in only reduces nagging on already-verified work — the
     * execution-grounding is unchanged either way, and keel's own banner skips regardless.
     */
    readonly genericSkip?: boolean;
    /**
     * Opt-in fresh-process pre-stop verification (Epic 2.23). When configured, a clean model stop is
     * accepted only after this operator-supplied command exits 0 in a fresh subprocess. On the first
     * failure, keel feeds the bounded failure evidence back once; a second failure halts with an error.
     * The command is kernel configuration, never model-provided.
     */
    readonly preStop?: {
      readonly check: PreStopCheck;
      readonly runner?: PreStopCheckRunner;
    };
    /**
     * Acceptance contract checks visible, provenance-bound completion requirements such as explicit
     * required artifacts. Advisory-only evidence can warn but cannot materialize as authoritative
     * pass evidence or suppress the prompt verifier.
     */
    readonly acceptance?: {
      readonly contract: AcceptanceContract;
      readonly readArtifact?: ArtifactReader;
    };
    /**
     * Dynamic acceptance contracts discovered during the run, such as service/job leases created by
     * governed tools. Evaluated only at clean-stop boundaries and merged with static acceptance and
     * pre-stop checks; model prose cannot populate this hook.
     */
    readonly dynamicAcceptance?: () => AcceptanceContract | undefined;
  };
  /**
   * Opt-in loop detection (Epic 1.1c). When present, repeated tool calls (n-gram) or
   * repeated edits to one file trip a bounded recovery ladder: first trip emits
   * `loop-detected` guidance, a repeated non-advisory trip forces a stronger pivot,
   * and only the next repeated non-progress signal halts with `stop(loop-detected)`.
   * Advisory-only signals never consume this hard-stop ladder. Absent = no detection.
   */
  readonly loopDetection?: LoopDetectionConfig & { readonly guidance?: string };
  /**
   * Opt-in infra block-timeout (Epic 1.1e). When `toolMs` is set, each tool execution
   * is deadline-wrapped; a tool that exceeds it yields a distinct `infra-error` event
   * and a structured timeout result fed back to the model (recovery is model-driven,
   * §4.3 — the run continues, no auto-retry). Absent = no deadline. (Model/transport
   * timeout lands with the provider adapter in Epic 1.3.)
   */
  readonly infraTimeout?: { readonly toolMs?: number };
  /**
   * Opt-in IN-LOOP context compaction (Epic 1.6c, option A — serves RUNWAY). Called at each turn
   * boundary (after the budget checks, before the model turn) with the current messages + cumulative
   * usage; returns the (possibly compacted) messages the next turn drives from. The hook decides
   * (cache-aware) whether to act and records its own audit event(s) to the ledger; a no-op returns the
   * same array. Absent = no in-loop compaction. Injected so the core loop stays decoupled + testable.
   */
  readonly compactor?: AgentCompactor;
  /** Model context-window metadata for typed pressure decisions. Internal kernel wiring only; absent
   *  callers use the conservative default and keep simulator/offline behavior unchanged. */
  readonly contextWindow?: ContextWindowSpec;
  /**
   * Called exactly once, at run-finished, with the loop's FINAL working set (the in-memory messages it
   * ended on — including any in-loop compaction), minus controller-owned user-role prompts. Those
   * prompts remain provider-visible inside this run but cannot be carried into the next transcript as
   * counterfeit human input. The runner uses this set to re-drive after steering instead of rebuilding
   * from the full ledger (Epic 1.6c PR-d slice 4 / 4b). The messages may end on an aborted turn's open
   * tool call; the caller validates them (`closeOpenToolCalls`) before re-driving. Absent = not observed.
   * Read-only: the loop does not act on the callback's effects.
   */
  readonly onFinalMessages?: (messages: readonly ModelMessageT[]) => void;
  /** Injectable monotonic clock (ms) for the wall-clock deadline (ADR-0051). The production default
   *  uses the greater of monotonic and civil-clock elapsed time so clock rollback cannot extend a run
   *  while host suspend/forward clock progress still counts. Tests may inject one controllable
   *  monotonic clock so the deadline path is deterministic without real timers. */
  readonly now?: () => number;
  /** Optional structural enforcement probe (P0-3). When present and it reports unavailable after a
   *  tool result, the loop halts fail-closed — it stops re-driving the model against a dead warden,
   *  emits synthetic skips for the turn's remaining calls, and stops with `code:"WARDEN_UNAVAILABLE"`.
   *  Absent (simulator / local executor) keeps behavior unchanged. Kernel-local; not the frozen port. */
  readonly enforcement?: { available(): boolean };
}

/**
 * Process-local accounting shared only by callers that own several automatic `runAgentLoop`
 * invocations as one physical run. It is intentionally absent from the package root exports and
 * every durable/public schema: the bounded-loop driver owns its lifetime, while ordinary callers
 * receive a fresh state through `runAgentLoop()`.
 */
export interface AgentLoopControlState {
  /** Monotonic (or injected-clock) origin for this physical run. */
  startMs: number | undefined;
  /** Civil-clock origin for the production hybrid elapsed clock; absent for injected clocks. */
  wallStartMs: number | undefined;
  usage: ModelUsageT;
  turn: number;
  finalizeTurnsUsed: number;
  progressRunwayTurnsUsed: number;
  /** Physical-run elapsed time at which progress runway began. */
  progressRunwayStartElapsedMs: number | undefined;
  readonly warnedThresholds: Set<number>;
  readonly warnedGrossThresholds: Set<number>;
}

export function createAgentLoopControlState(): AgentLoopControlState {
  return {
    startMs: undefined,
    wallStartMs: undefined,
    usage: { inputTokens: 0, outputTokens: 0 },
    turn: 0,
    finalizeTurnsUsed: 0,
    progressRunwayTurnsUsed: 0,
    progressRunwayStartElapsedMs: undefined,
    warnedThresholds: new Set<number>(),
    warnedGrossThresholds: new Set<number>(),
  };
}

/** Finite default turn cap — the loop must always terminate (no unbounded runs). */
export const DEFAULT_MAX_TURNS = 50;

/** Model-visible line when the spawned warden dies mid-session and the loop halts fail-closed (P0-3).
 *  The session driver adds the concrete `keel --resume <id>` restart guidance. */
export const LOOP_WARDEN_UNAVAILABLE_MESSAGE =
  "keel's warden (enforcement) stopped; tool execution is halted. No further tools will run this session.";

const LOOP_REVIEW_REQUIRED_SKIP_MESSAGE =
  "not executed: an earlier tool in this turn requires review; change the task and rerun";
const LOOP_BOUNDED_RECOVERY_SKIP_MESSAGE =
  "bounded recovery permits one tool call (model-authored); this additional call was not executed";
const LOOP_FINAL_ANSWER_REWRITE_TOOL_SKIP_MESSAGE =
  "not executed: final-answer rewrite tools are disabled";
const LOOP_FINAL_ANSWER_INCOMPLETE_TOOL_SKIP_MESSAGE =
  "not executed: final-answer attempt did not complete";
const NONZERO_EXIT_RESULT_RE = /\[exit code:\s*[1-9]\d*\]/m;
const UNTRUSTED_TOOL_RESULT_STEM = "[keel:untrusted-tool-result:";
const WARDEN_DECORATED_BASH_RESULT_RE = /^warden (?:containment|warning|modified tool args):/u;
const DUPLICATE_TOOL_CALL_ID_CODE = "duplicate-tool-call-id";

function governedBashCorrectionSucceeded(output: string): boolean | undefined {
  const trimmed = output.trim();
  if (trimmed.includes(UNTRUSTED_TOOL_RESULT_STEM)) return false;

  const separator = trimmed.lastIndexOf("\n\n");
  const suffix = separator < 0 ? undefined : trimmed.slice(separator + 2).trim();
  const candidate = trimmed.startsWith("{")
    ? trimmed
    : suffix?.startsWith("{") === true
      ? suffix
      : undefined;
  if (candidate === undefined) {
    return WARDEN_DECORATED_BASH_RESULT_RE.test(trimmed) ? false : undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;

  const envelope = parsed as Record<string, unknown>;
  if (
    !["exitCode", "signal", "stdout", "stderr"].some((key) => key in envelope) ||
    !Number.isSafeInteger(envelope["exitCode"]) ||
    !(
      envelope["signal"] === null ||
      (typeof envelope["signal"] === "string" && envelope["signal"].length > 0)
    ) ||
    typeof envelope["stdout"] !== "string" ||
    typeof envelope["stderr"] !== "string"
  ) {
    return false;
  }
  return envelope["exitCode"] === 0 && envelope["signal"] === null;
}

function boundedCorrectionSucceeded(
  call: ToolInvocationT,
  result: Pick<ToolResultT, "ok" | "output">,
  failureEvidence: string | undefined,
): boolean {
  if (!result.ok || failureEvidence !== undefined) return false;
  if (call.name !== "bash") return true;

  const governedOutcome = governedBashCorrectionSucceeded(result.output);
  return governedOutcome ?? !NONZERO_EXIT_RESULT_RE.test(result.output);
}

function terminalReviewStopMessage(outcome: ToolPresentationOutcome | undefined): string {
  switch (outcome) {
    case "blocked":
      return "blocked action was not executed; change the task and rerun";
    case "partial":
      return "review outcome is indeterminate; action may have executed; do not retry automatically; restart and inspect audit";
    case "failed":
      return "review settlement failed; no approval is assumed; restart the governed session before deciding again";
    default:
      return "requested action was not executed; change the task and rerun";
  }
}

function duplicateToolCallIds(calls: readonly ToolInvocationT[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const duplicateSet = new Set<string>();
  for (const call of calls) {
    if (!seen.has(call.id)) {
      seen.add(call.id);
      continue;
    }
    if (!duplicateSet.has(call.id)) {
      duplicateSet.add(call.id);
      duplicates.push(call.id);
    }
  }
  return duplicates;
}

function duplicateToolCallIdMessage(ids: readonly string[]): string {
  const suffix = ids.length === 1 ? "" : "s";
  const rendered = ids.map((id) => JSON.stringify(id)).join(", ");
  return `provider emitted duplicate tool-call id${suffix} in one assistant turn: ${rendered}; no tools were executed`;
}

function presentationToolResultEvent(
  id: string,
  result: Pick<ToolResultT, "ok" | "output">,
  outcome: ToolPresentationOutcome | undefined = toolPresentationOutcome(result),
): KernelEventT {
  const event: KernelEventT = {
    type: "tool-result",
    id,
    ok: result.ok,
    output: result.output,
  };
  const presented = outcome === undefined ? event : markToolPresentationOutcome(event, outcome);
  transferMutationPresentationResolver(result, presented);
  return presented;
}

interface ToolCallDeltaBuffer {
  name?: string;
  argsText: string;
}

type ToolCallDeltaAssembly =
  | { ok: true; call: ToolInvocationT }
  | { ok: false; code: string; message: string };
type StopEvent = Extract<KernelEventT, { type: "stop" }>;
type CompletionCheckDecision =
  | { readonly kind: "accepted"; readonly shouldStop: boolean }
  | { readonly kind: "prompt"; readonly prompt: string }
  | { readonly kind: "stop"; readonly event: StopEvent };

interface FinalizeProgressEvidence {
  readonly source: "progress-ledger" | "finalize-only";
  readonly strength: "strong";
  readonly turnSeen: number;
  readonly evidenceRef: string;
  readonly expiresAfterTurn: number;
  readonly evidenceKind: Extract<ProgressCommandClass, "verifier" | "build"> | "direct-check";
  readonly successSignal: ProgressSuccessSignal | "exit-zero";
  readonly actionSignature: string;
  readonly patternSignature: string;
}

interface ProgressRunwayEvidence {
  readonly source: "progress-ledger";
  readonly strength: "strong" | "stage";
  readonly turnSeen: number;
  readonly evidenceRef: string;
  readonly commandClass: Extract<ProgressCommandClass, "verifier" | "build">;
  readonly actionSignature: string;
  readonly patternSignature: string;
  readonly signal: string;
}

function assembleToolCallDelta(id: string, buffer: ToolCallDeltaBuffer): ToolCallDeltaAssembly {
  if (buffer.name === undefined) {
    return {
      ok: false,
      code: "malformed-tool-call-delta",
      message: `streamed tool call '${id}' ended without a tool name`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.argsText);
  } catch {
    return {
      ok: false,
      code: "malformed-tool-call-delta",
      message: `streamed tool call '${id}' ended with malformed JSON args`,
    };
  }
  const args = JsonObject.safeParse(parsed);
  if (!args.success) {
    return {
      ok: false,
      code: "malformed-tool-call-delta",
      message: `streamed tool call '${id}' args are not a JSON object`,
    };
  }
  return { ok: true, call: { id, name: buffer.name, args: args.data } };
}

function estimateTurnInputTokens(input: ModelTurnInput): number {
  const messageEstimate = input.messages.reduce((sum, message) => sum + messageTokens(message), 0);
  const toolEstimate =
    input.tools === undefined
      ? 0
      : estimateTokens(JSON.stringify(input.tools)) + input.tools.length;
  return Math.max(1, messageEstimate + toolEstimate);
}

function estimateTurnOutputTokens(
  assistantText: string,
  calls: readonly ToolInvocationT[],
  deltaCalls: ReadonlyMap<string, ToolCallDeltaBuffer>,
): number {
  const callText = calls.length > 0 ? JSON.stringify(calls) : "";
  const deltaText =
    deltaCalls.size > 0
      ? JSON.stringify(
          [...deltaCalls].map(([id, buffer]) => ({
            id,
            name: buffer.name ?? "",
            argsText: buffer.argsText,
          })),
        )
      : "";
  const text = assistantText + callText + deltaText;
  return text.length === 0 ? 0 : Math.max(1, estimateTokens(text));
}

function usageHasProviderReport(usage: ModelUsageT): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    (usage.cachedInputTokens ?? 0) > 0 ||
    (usage.cacheCreationInputTokens ?? 0) > 0
  );
}

function usageHasProviderInputReport(usage: ModelUsageT): boolean {
  return usage.inputTokens > 0;
}

function usageWithFallback(
  reported: ModelUsageT,
  turnInput: ModelTurnInput,
  assistantText: string,
  calls: readonly ToolInvocationT[],
  deltaCalls: ReadonlyMap<string, ToolCallDeltaBuffer>,
): ModelUsageT {
  const inputTokens =
    reported.inputTokens > 0 ? reported.inputTokens : estimateTurnInputTokens(turnInput);
  const outputTokens =
    reported.outputTokens > 0 || reported.inputTokens > 0
      ? reported.outputTokens
      : estimateTurnOutputTokens(assistantText, calls, deltaCalls);
  if (usageHasProviderReport(reported)) {
    return {
      inputTokens,
      outputTokens,
      ...(reported.cachedInputTokens !== undefined
        ? { cachedInputTokens: reported.cachedInputTokens }
        : {}),
      ...(reported.cacheCreationInputTokens !== undefined
        ? { cacheCreationInputTokens: reported.cacheCreationInputTokens }
        : {}),
    };
  }
  return {
    inputTokens,
    outputTokens,
  };
}

function usageDelta(current: ModelUsageT, baseline: ModelUsageT): ModelUsageT {
  const cached =
    current.cachedInputTokens !== undefined || baseline.cachedInputTokens !== undefined
      ? Math.max(0, (current.cachedInputTokens ?? 0) - (baseline.cachedInputTokens ?? 0))
      : undefined;
  const cacheWrite =
    current.cacheCreationInputTokens !== undefined ||
    baseline.cacheCreationInputTokens !== undefined
      ? Math.max(
          0,
          (current.cacheCreationInputTokens ?? 0) - (baseline.cacheCreationInputTokens ?? 0),
        )
      : undefined;
  return {
    inputTokens: Math.max(0, current.inputTokens - baseline.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - baseline.outputTokens),
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(cacheWrite !== undefined ? { cacheCreationInputTokens: cacheWrite } : {}),
  };
}

function loopRecoveryKey(signal: LoopSignal): string {
  return signal.highBurnFingerprint ?? `${signal.signal}:${signal.detail}`;
}

function bashCommandForLoop(call: ToolInvocationT): string | undefined {
  if (call.name !== "bash") return undefined;
  const command = call.args["command"];
  return typeof command === "string" ? command : undefined;
}

function hasAssistantOrToolEvidenceSinceLastUser(messages: readonly ModelMessageT[]): boolean {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  for (let index = lastUser + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role === "tool") return true;
    if (
      message.role === "assistant" &&
      (message.content.trim().length > 0 || (message.toolCalls?.length ?? 0) > 0)
    ) {
      return true;
    }
  }
  return false;
}

function hasActionableWorkSinceLastUser(messages: readonly ModelMessageT[]): boolean {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  for (let index = lastUser + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || message.toolCalls === undefined) continue;
    for (const call of message.toolCalls) {
      if (callSuggestsArtifactWrite(call)) return true;
      const command = bashCommandForLoop(call);
      if (command !== undefined && !isReadOnlyCommand(command)) return true;
    }
  }
  return false;
}

function finalizeProgressEvidenceFor(
  call: ToolInvocationT,
  result: Pick<ToolResultT, "ok" | "output">,
  turnSeen: number,
): FinalizeProgressEvidence | undefined {
  const finalizeOnly = finalizeOnlyEvidenceForToolResult(call, result);
  if (finalizeOnly !== undefined) {
    return {
      source: "finalize-only",
      strength: "strong",
      turnSeen,
      evidenceRef: [
        finalizeOnly.kind,
        finalizeOnly.successSignal,
        finalizeOnly.actionSignature,
        finalizeOnly.patternSignature,
      ].join(":"),
      expiresAfterTurn: turnSeen,
      evidenceKind: finalizeOnly.kind,
      successSignal: finalizeOnly.successSignal,
      actionSignature: finalizeOnly.actionSignature,
      patternSignature: finalizeOnly.patternSignature,
    };
  }
  const entry = buildProgressLedgerEntry(call, result.output, { ok: result.ok });
  if (entry.successSignal === undefined) return undefined;
  if (entry.commandClass !== "verifier" && entry.commandClass !== "build") return undefined;
  return {
    source: "progress-ledger",
    strength: "strong",
    turnSeen,
    evidenceRef: [
      entry.commandClass,
      entry.successSignal,
      entry.actionSignature,
      entry.patternSignature,
    ].join(":"),
    expiresAfterTurn: turnSeen,
    evidenceKind: entry.commandClass,
    successSignal: entry.successSignal,
    actionSignature: entry.actionSignature,
    patternSignature: entry.patternSignature,
  };
}

const PROGRESS_RUNWAY_FAILURE_RE =
  /\b(error|errors|failed|failure|failures|traceback|exception|fatal|segmentation fault)\b/i;

function extractProgressRunwayStage(output: string): string | undefined {
  const lines = output.split(/\r?\n/).slice(-200);
  for (const line of lines) {
    const explicit =
      /\b(stage|phase|step|target)\s*(?::|=|#|-)?\s*([A-Za-z0-9][A-Za-z0-9_.:/-]{0,79})\b/i.exec(
        line,
      );
    if (explicit !== null) {
      return `${explicit[1]!.toLowerCase()}:${explicit[2]!.toLowerCase()}`;
    }
  }
  return undefined;
}

function progressRunwayEvidenceFor(
  call: ToolInvocationT,
  result: Pick<ToolResultT, "ok" | "output">,
  turnSeen: number,
): ProgressRunwayEvidence | undefined {
  if (result.ok !== true) return undefined;
  const entry = buildProgressLedgerEntry(call, result.output, { ok: result.ok });
  if (entry.commandClass !== "verifier" && entry.commandClass !== "build") return undefined;
  if (PROGRESS_RUNWAY_FAILURE_RE.test(result.output)) return undefined;
  const signal =
    entry.successSignal !== undefined
      ? `success:${entry.successSignal}`
      : extractProgressRunwayStage(result.output);
  if (signal === undefined) return undefined;
  return {
    source: "progress-ledger",
    strength: entry.successSignal !== undefined ? "strong" : "stage",
    turnSeen,
    evidenceRef: [entry.commandClass, signal, entry.actionSignature].join(":"),
    commandClass: entry.commandClass,
    actionSignature: entry.actionSignature,
    patternSignature: entry.patternSignature,
    signal,
  };
}

function callCanMutateAfterVerification(call: ToolInvocationT): boolean {
  if (callSuggestsArtifactWrite(call)) return true;
  const commandClass = classifyToolCall(call);
  if (commandClass === "mutator" || commandClass === "destructive" || commandClass === "build") {
    return true;
  }
  if (call.name !== "bash") return false;
  const command = (call.args as { command?: unknown } | null | undefined)?.command;
  return typeof command === "string" && !isReadOnlyCommand(command) && commandClass === "unknown";
}

/**
 * Run one tool call while surfacing its incremental output as `tool-output-delta` events (Epic 1.5c —
 * purposeful liveness). The loop is an async generator, so a callback fired during `await execute(...)`
 * cannot itself `yield`; this helper buffers each `onOutput` chunk and drains it as a delta — racing the
 * execute promise against newly-arrived chunks — then returns the final result, which the caller captures
 * with `yield*`. `run` lets the caller wrap execution (e.g. `withDeadline`) yet still pass the hook.
 *
 * Race-free by construction: JS is single-threaded, and the `await new Promise(r => { wake = r })` sets
 * `wake` synchronously (the Promise executor runs sync) BEFORE the await suspends — so an `onOutput` (or
 * completion) that fires later can never lose its wakeup. Every chunk is yielded, in order, before the
 * result; a rejected `run` (e.g. the infra-timeout `InfraError`) re-throws through `yield*` after any
 * buffered chunks drain.
 */
async function* executeWithLiveOutput(
  call: ToolInvocationT,
  run: (opts: { signal?: AbortSignal; onOutput: (chunk: string) => void }) => Promise<ToolResultT>,
  signal: AbortSignal | undefined,
): AsyncGenerator<KernelEventT, ToolResultT> {
  const buffer: string[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  const wakeUp = (): void => {
    if (wake !== null) {
      wake();
      wake = null;
    }
  };
  const onOutput = (chunk: string): void => {
    buffer.push(chunk);
    wakeUp();
  };
  const execP = run({ ...(signal !== undefined ? { signal } : {}), onOutput }).finally(() => {
    finished = true;
    wakeUp();
  });
  // If a consumer abandons this generator mid-tool (a `break`/`.return()` before the result), the
  // `return await execP` below never runs — register a no-op catch so a later rejection from `run` (a
  // rejecting executor, or the infra-deadline `InfraError`) cannot surface as an UNHANDLED rejection.
  // The real awaiter at the end still observes the value/rejection — a promise allows many handlers.
  execP.catch(() => {});
  for (;;) {
    if (buffer.length > 0) {
      yield { type: "tool-output-delta", id: call.id, chunk: buffer.shift()! };
      continue;
    }
    if (finished) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  return await execP; // settled — returns the result, or re-throws a rejection through `yield*`
}

/**
 * The keel agent loop: stream one model turn → emit its chunks as kernel events →
 * dispatch tool calls through the executor → append results → repeat, until an
 * explicit stop condition fires. Exactly one `stop` event is emitted, immediately
 * before `run-finished`. Tool failures return structured `{ ok: false }` results
 * fed back to the model (no throw, no auto-retry — §4.3). A provider `error`
 * terminal ends the run with `stop(error)`; transport-level retry is Epic 1.3.
 */
export async function* runAgentLoop(
  model: ModelPort,
  executor: ExecutorPort,
  input: AgentLoopInput,
): AsyncIterable<KernelEventT> {
  yield* runAgentLoopWithControlState(model, executor, input, createAgentLoopControlState());
}

/** Kernel-internal continuation seam for a physical run composed of several automatic sessions. */
export async function* runAgentLoopWithControlState(
  model: ModelPort,
  executor: ExecutorPort,
  input: AgentLoopInput,
  controlState: AgentLoopControlState,
): AsyncIterable<KernelEventT> {
  let messages: ModelMessageT[] = [...input.messages];
  const maxTurns = input.stop?.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxFinalizeTurns = input.stop?.maxFinalizeTurns ?? 0;
  const maxProgressRunwayTurns = input.stop?.maxProgressRunwayTurns ?? 0;
  const maxProgressRunwayWallMs = input.stop?.maxProgressRunwayWallMs;
  const maxTokens = input.stop?.budget?.maxTokens;
  const maxGrossTokens = input.stop?.budget?.maxGrossTokens;
  const maxOutputTokens = input.stop?.budget?.maxOutputTokens;
  const finalAnswer = input.finalAnswer;
  const progressRunwayHasCostBudget =
    maxTokens !== undefined || maxGrossTokens !== undefined || maxOutputTokens !== undefined;
  // Default 1.0 → cached counts at full price (gross-equivalent), the conservative behavior.
  const cacheReadWeight = input.stop?.budget?.cacheReadWeight ?? 1.0;
  const warnThresholds = input.stop?.budget?.warnThresholds ?? [];
  const grossWarnThresholds = input.stop?.budget?.grossWarnThresholds ?? [];
  for (const t of [...warnThresholds, ...grossWarnThresholds]) {
    if (!Number.isFinite(t) || t <= 0 || t >= 1) {
      throw new RangeError(
        `budget warnThreshold must be a finite fraction in (0, 1); got ${String(t)}`,
      );
    }
  }
  const warnedThresholds = controlState.warnedThresholds;
  const warnedGrossThresholds = controlState.warnedGrossThresholds;
  let usage: ModelUsageT = controlState.usage;
  const runUsageBaseline = usage;
  let lastRequestUsage: ModelUsageT | undefined;
  let lastRequestUsageSource: ContextUsageSource = "missing";
  const accumulateRequestUsage = (requestUsage: ModelUsageT, source: ContextUsageSource): void => {
    lastRequestUsage = requestUsage;
    lastRequestUsageSource = source;
    const cached =
      usage.cachedInputTokens !== undefined || requestUsage.cachedInputTokens !== undefined
        ? (usage.cachedInputTokens ?? 0) + (requestUsage.cachedInputTokens ?? 0)
        : undefined;
    const cacheWrite =
      usage.cacheCreationInputTokens !== undefined ||
      requestUsage.cacheCreationInputTokens !== undefined
        ? (usage.cacheCreationInputTokens ?? 0) + (requestUsage.cacheCreationInputTokens ?? 0)
        : undefined;
    usage = {
      inputTokens: usage.inputTokens + requestUsage.inputTokens,
      outputTokens: usage.outputTokens + requestUsage.outputTokens,
      ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
      ...(cacheWrite !== undefined ? { cacheCreationInputTokens: cacheWrite } : {}),
    };
    controlState.usage = usage;
  };
  let turn = controlState.turn;
  let finalizeTurnsUsed = controlState.finalizeTurnsUsed;
  let progressRunwayTurnsUsed = controlState.progressRunwayTurnsUsed;
  let progressRunwayStartElapsedMs = controlState.progressRunwayStartElapsedMs;
  let latestFinalizeProgress: FinalizeProgressEvidence | undefined;
  let latestProgressRunwayEvidence: ProgressRunwayEvidence | undefined;
  const usedProgressRunwayEvidenceRefs = new Set<string>();
  const maxTailSuccessRepeats =
    input.loopDetection?.stopOnRepeatedSuccessEvidence === true
      ? (input.loopDetection.maxTailSuccessRepeats ?? 3)
      : 0;
  let tailSuccessEvidence: string | undefined;
  let tailSuccessRepeats = 0;
  let promptVerificationDone = false;
  let emptyAssistantStopRetried = false;
  const acceptanceRetryKeys = new Set<string>();
  const knownRedRetryKeys = new Set<string>();
  const detector =
    input.loopDetection !== undefined ? new LoopDetector(input.loopDetection) : undefined;
  const loopRecoveryTrips = new Map<string, number>();
  let loopProgressEpoch = detector?.progressEpoch() ?? 0;
  let advisoryTrips = 0; // F7: index into the escalating advisory guidance (clamped to the strongest)
  let latestFailureEvidence: string | undefined;
  let latestStrongSuccessEvidence: string | undefined;
  let hasArtifactWrite = false;
  let hasSuccessfulTypedReadEvidence = false;
  let terminalReviewSynthesisActive = false;
  let terminalReviewSynthesisAttempted = false;
  let terminalReviewOutcome: ToolPresentationOutcome | undefined;
  let terminalReviewTimedOut = false;
  let terminalReviewRecoveryActive = false;
  let terminalReviewRecoveryState = createTerminalReviewRecoveryState();
  let terminalReviewRecoveryFinalizationActive = false;
  let unrecoveredBlockedActions = 0;
  const blockedStopEvent = (): StopEvent => ({
    type: "stop",
    reason: "model-stop",
    code: BLOCKED_AFTER_SYNTHESIS_CODE,
    message: BLOCKED_AFTER_SYNTHESIS_MESSAGE,
  });
  const modelStopEvent = (): StopEvent =>
    unrecoveredBlockedActions > 0 ? blockedStopEvent() : { type: "stop", reason: "model-stop" };
  const controllerOwnedUserMessages = new WeakSet<ModelMessageT>();
  const pushControllerPrompt = (content: string): void => {
    const message: ModelMessageT = { role: "user", content };
    controllerOwnedUserMessages.add(message);
    messages.push(message);
  };
  // ADR-0087's rewrite instruction is controller-authored but DURABLE provider history. Unlike the
  // transient guidance above, it must survive onFinalMessages and resume between the two assistant
  // occurrences so same-process continuation and fresh-process rebuild have identical role order.
  const pushDurableControllerPrompt = (content: string): void => {
    messages.push({ role: "user", content });
  };
  // Human and controller prompts intentionally share the provider-compatible `user` role. Object
  // identity is therefore the local provenance carrier. A compactor may drop user messages but may
  // not clone, invent, reorder, duplicate, or mutate them; rejecting that result is safer than
  // guessing authorship from byte-identical text.
  type UserProvenanceSnapshot = {
    readonly message: ModelMessageT;
    readonly state: ModelMessageT;
    readonly serializedState: string;
    readonly index: number;
  };
  const snapshotUserProvenance = (
    before: readonly ModelMessageT[],
  ): readonly UserProvenanceSnapshot[] =>
    before.flatMap((message, index) => {
      if (message.role !== "user") return [];
      const state = structuredClone(message);
      return [{ message, state, serializedState: JSON.stringify(state), index }];
    });
  const compactorPreservesUserProvenance = (
    inputOrder: readonly ModelMessageT[],
    inputAfterCall: readonly ModelMessageT[],
    snapshots: readonly UserProvenanceSnapshot[],
    after: readonly ModelMessageT[],
  ): boolean => {
    if (
      inputAfterCall.length !== inputOrder.length ||
      inputAfterCall.some((message, index) => message !== inputOrder[index])
    ) {
      return false;
    }
    const available = new Map(snapshots.map((snapshot) => [snapshot.message, snapshot]));
    for (const snapshot of snapshots) {
      if (JSON.stringify(snapshot.message) !== snapshot.serializedState) {
        return false;
      }
    }
    let previousIndex = -1;
    for (const message of after) {
      if (message.role !== "user") continue;
      const snapshot = available.get(message);
      if (snapshot === undefined || snapshot.index <= previousIndex) return false;
      available.delete(message);
      previousIndex = snapshot.index;
    }
    return true;
  };
  const restoreUserProvenance = (snapshots: readonly UserProvenanceSnapshot[]): void => {
    for (const snapshot of snapshots) {
      const mutable = snapshot.message as unknown as Record<string, unknown>;
      for (const key of Object.keys(mutable)) delete mutable[key];
      Object.assign(mutable, structuredClone(snapshot.state));
    }
  };
  const renderConfiguredLoopGuidance = (baseGuidance: string): string => {
    if (input.loopDetection?.recoverWithEvidence !== true) return baseGuidance;
    return renderLoopRecoveryGuidance({
      baseGuidance,
      hasArtifactWrite,
      ...(latestFailureEvidence !== undefined ? { failureEvidence: latestFailureEvidence } : {}),
      ...(latestStrongSuccessEvidence !== undefined
        ? { successEvidence: latestStrongSuccessEvidence }
        : {}),
    });
  };

  // Hard elapsed run budget (ADR-0051 / Lever C). Production uses a fail-closed hybrid clock: the
  // greater of monotonic elapsed and civil-clock elapsed. Monotonic time prevents rollback from
  // extending a run; civil time ensures host suspend and forward clock progress still count. An
  // injected clock is explicitly a single monotonic test clock.
  const injectedNow = input.now;
  const monotonicNow = injectedNow ?? (() => performance.now());
  const startMs = controlState.startMs ?? monotonicNow();
  controlState.startMs = startMs;
  const wallStartMs =
    injectedNow === undefined ? (controlState.wallStartMs ?? Date.now()) : undefined;
  if (wallStartMs !== undefined) controlState.wallStartMs = wallStartMs;
  const elapsedMs = (): number => {
    const monotonicElapsed = Math.max(0, monotonicNow() - startMs);
    if (wallStartMs === undefined) return monotonicElapsed;
    return Math.max(monotonicElapsed, Math.max(0, Date.now() - wallStartMs));
  };
  const maxWallMs = input.stop?.maxWallMs;
  const deadlineHit = (): boolean => maxWallMs !== undefined && elapsedMs() >= maxWallMs;
  const progressRunwayDeadlineHit = (): boolean =>
    maxProgressRunwayWallMs !== undefined &&
    progressRunwayStartElapsedMs !== undefined &&
    elapsedMs() - progressRunwayStartElapsedMs >= maxProgressRunwayWallMs;
  // The stop reason when `effectiveSignal` aborts: the loop's own wall-clock deadline (its timer fired)
  // is "deadline"; any other abort (a caller cancel) is "aborted". Centralised so the three stop sites
  // that distinguish them can't drift — one forgetting `deadlineHit()` would mislabel the stop (LOOP-5).
  const abortStopReason = (): "deadline" | "aborted" =>
    deadlineTimerFired || progressRunwayTimerFired || deadlineHit() || progressRunwayDeadlineHit()
      ? "deadline"
      : "aborted";
  const deadlineController = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let progressRunwayTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimerFired = false;
  let progressRunwayTimerFired = false;
  let removeCallerAbortListener: (() => void) | undefined;
  // Default (no wall budget): use the caller signal directly — zero overhead, no extra listeners.
  let effectiveSignal = input.signal;
  if (maxWallMs !== undefined || maxProgressRunwayWallMs !== undefined) {
    // Clamp the armed delay to the 32-bit setTimeout max (a larger delay fires ~immediately); the
    // authoritative between-turns stop uses the true `maxWallMs` via `deadlineHit()`.
    if (maxWallMs !== undefined) {
      const remaining = maxWallMs - elapsedMs();
      if (remaining <= 0) {
        deadlineTimerFired = true;
        deadlineController.abort();
      } else {
        deadlineTimer = setTimeout(
          () => {
            deadlineTimerFired = true;
            deadlineController.abort();
          },
          Math.min(remaining, 2_147_483_647),
        );
        deadlineTimer.unref?.();
      }
    }
    if (input.signal === undefined || input.signal.aborted) {
      if (input.signal?.aborted === true) deadlineController.abort();
      effectiveSignal = deadlineController.signal;
    } else {
      // ONE listener, removed on loop exit (below), so a re-driven session signal (runner steering
      // loop) does not accumulate a listener per cycle.
      const callerSignal = input.signal;
      const onCallerAbort = (): void => deadlineController.abort();
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      removeCallerAbortListener = (): void =>
        callerSignal.removeEventListener("abort", onCallerAbort);
      effectiveSignal = deadlineController.signal;
    }
  }
  const armProgressRunwayDeadline = (): void => {
    if (maxProgressRunwayWallMs === undefined || progressRunwayTimer !== undefined) return;
    const elapsed =
      progressRunwayStartElapsedMs === undefined ? 0 : elapsedMs() - progressRunwayStartElapsedMs;
    const remaining = maxProgressRunwayWallMs - elapsed;
    if (remaining <= 0) {
      progressRunwayTimerFired = true;
      deadlineController.abort();
      return;
    }
    progressRunwayTimer = setTimeout(
      () => {
        progressRunwayTimerFired = true;
        deadlineController.abort();
      },
      Math.min(remaining, 2_147_483_647),
    );
    progressRunwayTimer.unref?.();
  };
  const signalAborted = (): boolean => effectiveSignal?.aborted === true;
  const effectiveAcceptance = ():
    | {
        readonly contract: AcceptanceContract;
        readonly readArtifact?: ArtifactReader;
        readonly runCommand?: AcceptanceCommandRunner;
      }
    | undefined => {
    const acceptance = input.verification?.acceptance;
    const preStop = input.verification?.preStop;
    const preStopContract =
      preStop === undefined ? undefined : acceptanceContractFromPreStopCheck(preStop.check);
    const dynamicContract = input.verification?.dynamicAcceptance?.();
    const contract = mergeAcceptanceContracts(
      mergeAcceptanceContracts(acceptance?.contract, preStopContract),
      dynamicContract,
    );
    if (contract === undefined) return undefined;
    const runCommand =
      preStop === undefined
        ? (contract.requiredCommands ?? []).length > 0
          ? runFreshPreStopCheck
          : undefined
        : (check: PreStopCheck, signal?: AbortSignal) =>
            check === preStop.check
              ? (preStop.runner ?? runFreshPreStopCheck)(check, signal)
              : runFreshPreStopCheck(check, signal);
    return {
      contract,
      ...(acceptance?.readArtifact !== undefined ? { readArtifact: acceptance.readArtifact } : {}),
      ...(runCommand !== undefined ? { runCommand } : {}),
    };
  };
  const acceptanceRetryKey = (
    evaluation: Awaited<ReturnType<typeof evaluateAcceptanceContract>>,
  ): string =>
    evaluation.blocking
      .map((issue) => `${issue.kind}:${issue.path}`)
      .sort()
      .join("|")
      .slice(0, 2_000);
  const runAcceptanceDecision = async (): Promise<CompletionCheckDecision> => {
    let acceptance: ReturnType<typeof effectiveAcceptance>;
    try {
      acceptance = effectiveAcceptance();
    } catch (err) {
      return {
        kind: "stop",
        event: {
          type: "stop",
          reason: "error",
          code: "acceptance-contract-error",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    if (acceptance === undefined) return { kind: "accepted", shouldStop: false };
    if (signalAborted()) {
      return { kind: "stop", event: { type: "stop", reason: abortStopReason() } };
    }
    let evaluation: Awaited<ReturnType<typeof evaluateAcceptanceContract>>;
    try {
      evaluation = await evaluateAcceptanceContract(acceptance.contract, {
        ...(acceptance.readArtifact === undefined ? {} : { readArtifact: acceptance.readArtifact }),
        ...(acceptance.runCommand === undefined ? {} : { runCommand: acceptance.runCommand }),
        ...(effectiveSignal === undefined ? {} : { signal: effectiveSignal }),
      });
    } catch (err) {
      return {
        kind: "stop",
        event: {
          type: "stop",
          reason: "error",
          code: "acceptance-contract-error",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    if (signalAborted()) {
      return { kind: "stop", event: { type: "stop", reason: abortStopReason() } };
    }
    if (!evaluation.ok) {
      const prompt = renderAcceptanceFailurePrompt(acceptance.contract, evaluation);
      const retryKey = acceptanceRetryKey(evaluation);
      if (!acceptanceRetryKeys.has(retryKey)) {
        acceptanceRetryKeys.add(retryKey);
        return { kind: "prompt", prompt };
      }
      return {
        kind: "stop",
        event: {
          type: "stop",
          reason: "error",
          code: "acceptance-contract-failed",
          message: prompt,
        },
      };
    }
    const hasAuthoritativeCompletionEvidence = hasAuthoritativeAcceptanceEvidence(
      acceptance.contract,
    );
    const hasAcceptanceOnlyVerification =
      hasAuthoritativeCompletionEvidence &&
      input.verification?.preStop === undefined &&
      input.verification?.prompt === undefined;
    return {
      kind: "accepted",
      shouldStop: input.verification?.preStop !== undefined || hasAcceptanceOnlyVerification,
    };
  };
  const runCompletionChecksDecision = async (): Promise<CompletionCheckDecision> => {
    return await runAcceptanceDecision();
  };
  const hasConfiguredCompletionGate = (): boolean =>
    input.verification?.acceptance !== undefined ||
    input.verification?.preStop !== undefined ||
    input.verification?.dynamicAcceptance !== undefined;
  const hasVisibleVerifiedCompletion = (): boolean =>
    classifyCompletion(messages, {
      genericSkip: input.verification?.genericSkip ?? false,
    }) === "skip";
  const resetTailSuccess = (): void => {
    tailSuccessEvidence = undefined;
    tailSuccessRepeats = 0;
  };
  const recordTailSuccess = (evidence: string): boolean => {
    if (maxTailSuccessRepeats <= 0) return false;
    if (tailSuccessEvidence === evidence) {
      tailSuccessRepeats += 1;
    } else {
      tailSuccessEvidence = evidence;
      tailSuccessRepeats = 1;
    }
    return tailSuccessRepeats >= maxTailSuccessRepeats;
  };

  const settleFinalAnswerCandidate = async function* (inputCandidate: {
    readonly text: string;
    readonly usage: ModelUsageT;
    readonly textAlreadyFlushed: boolean;
  }): AsyncGenerator<KernelEventT, StopEvent> {
    if (finalAnswer === undefined) {
      return modelStopEvent();
    }
    const settlementId = `fas_${randomUUID()}`;
    const originalValidation = validateFinalAnswer(inputCandidate.text, finalAnswer.contract);
    if (!inputCandidate.textAlreadyFlushed && inputCandidate.text.length > 0) {
      yield { type: "text-delta", text: inputCandidate.text };
    }

    if (originalValidation.ok && inputCandidate.text.trim().length > 0) {
      yield {
        type: "final-answer-attempt",
        settlementId,
        attempt: "original",
        contract: finalAnswer.contract,
        decision: "accepted",
        usage: inputCandidate.usage,
      };
      yield {
        type: "final-answer-settled",
        settlement: { settlementId, outcome: "accepted-original" },
      };
      return modelStopEvent();
    }

    const rewritePrompt = finalAnswerRewritePrompt(finalAnswer.contract);
    const rewriteOutputTokens = finalAnswerRewriteOutputTokens(
      finalAnswer.contract,
      input.params?.maxOutputTokens,
    );
    const rewriteMessages: ModelMessageT[] = [
      ...messages,
      { role: "user", content: rewritePrompt },
    ];
    const estimatedRewriteInput = estimateTurnInputTokens({ messages: rewriteMessages });
    const remainingEffective =
      maxTokens === undefined ? undefined : maxTokens - effectiveTokens(usage, cacheReadWeight);
    const remainingGross =
      maxGrossTokens === undefined
        ? undefined
        : maxGrossTokens - usage.inputTokens - usage.outputTokens;
    const remainingOutput =
      maxOutputTokens === undefined ? undefined : maxOutputTokens - usage.outputTokens;
    const lacksRunway =
      (remainingEffective !== undefined &&
        estimatedRewriteInput + rewriteOutputTokens >= remainingEffective) ||
      (remainingGross !== undefined &&
        estimatedRewriteInput + rewriteOutputTokens >= remainingGross) ||
      (remainingOutput !== undefined && rewriteOutputTokens >= remainingOutput);
    const preflightOutcome = signalAborted()
      ? "fallback-cancelled"
      : deadlineHit() || progressRunwayDeadlineHit()
        ? "fallback-cancelled"
        : input.enforcement !== undefined && !input.enforcement.available()
          ? "fallback-error"
          : lacksRunway
            ? "fallback-budget"
            : undefined;
    if (preflightOutcome !== undefined) {
      yield {
        type: "final-answer-attempt",
        settlementId,
        attempt: "original",
        contract: finalAnswer.contract,
        decision: "fallback",
        usage: inputCandidate.usage,
      };
      yield {
        type: "final-answer-settled",
        settlement: { settlementId, outcome: preflightOutcome },
      };
      const stop: StopEvent =
        preflightOutcome === "fallback-budget"
          ? { type: "stop", reason: "budget" }
          : preflightOutcome === "fallback-error"
            ? {
                type: "stop",
                reason: "error",
                code: "WARDEN_UNAVAILABLE",
                message: LOOP_WARDEN_UNAVAILABLE_MESSAGE,
              }
            : { type: "stop", reason: abortStopReason() };
      return stop;
    }

    yield {
      type: "final-answer-attempt",
      settlementId,
      attempt: "original",
      contract: finalAnswer.contract,
      decision: "rewrite",
      usage: inputCandidate.usage,
    };
    pushDurableControllerPrompt(rewritePrompt);
    yield {
      type: "final-answer-rewrite-requested",
      settlementId,
      contract: finalAnswer.contract,
      prompt: rewritePrompt,
    };

    const rewriteInput: ModelTurnInput = {
      messages: [...messages],
      ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
      params: {
        ...(input.params ?? {}),
        maxOutputTokens: rewriteOutputTokens,
      },
    };
    let rewriteText = "";
    const rewriteCalls: ToolInvocationT[] = [];
    const rewriteDeltaCalls = new Map<string, ToolCallDeltaBuffer>();
    let rewriteFinish: FinishReasonT | undefined;
    let rewriteErrorCode: string | undefined;
    let rewriteErrorMessage: string | undefined;
    let rewriteUsage: ModelUsageT = { inputTokens: 0, outputTokens: 0 };
    let hasRewriteUsage = false;
    for await (const chunk of model.stream(rewriteInput)) {
      if (chunk.type === "text-delta") {
        rewriteText += chunk.text;
      } else if (chunk.type === "tool-call") {
        rewriteCalls.push({ id: chunk.id, name: chunk.name, args: chunk.args });
      } else if (chunk.type === "tool-call-delta") {
        const existing = rewriteDeltaCalls.get(chunk.id);
        if (existing === undefined) {
          rewriteDeltaCalls.set(chunk.id, {
            ...(chunk.name !== undefined ? { name: chunk.name } : {}),
            argsText: chunk.argsTextDelta,
          });
        } else {
          if (existing.name === undefined && chunk.name !== undefined) existing.name = chunk.name;
          existing.argsText += chunk.argsTextDelta;
        }
      } else if (chunk.type === "finish") {
        const providerReportedInputUsage = usageHasProviderInputReport(chunk.usage);
        rewriteUsage = usageWithFallback(
          chunk.usage,
          rewriteInput,
          rewriteText,
          rewriteCalls,
          rewriteDeltaCalls,
        );
        hasRewriteUsage = true;
        accumulateRequestUsage(
          rewriteUsage,
          providerReportedInputUsage ? "provider-reported" : "local-fallback",
        );
        rewriteFinish = chunk.reason;
      } else if (chunk.type === "error") {
        rewriteFinish = "error";
        rewriteErrorCode = chunk.code;
        rewriteErrorMessage = chunk.message;
      }
    }
    if (rewriteFinish !== "error" && rewriteFinish !== "aborted" && rewriteDeltaCalls.size > 0) {
      if (rewriteFinish === "tool-calls") {
        for (const [id, buffer] of rewriteDeltaCalls) {
          if (rewriteCalls.some((call) => call.id === id)) continue;
          const assembled = assembleToolCallDelta(id, buffer);
          if (assembled.ok) rewriteCalls.push(assembled.call);
          else {
            rewriteFinish = "error";
            rewriteErrorCode = assembled.code;
            rewriteErrorMessage = assembled.message;
            break;
          }
        }
      } else {
        rewriteFinish = "error";
        rewriteErrorCode = "malformed-tool-call-delta";
        rewriteErrorMessage = "streamed rewrite tool call ended without a tool-call terminal";
      }
    }

    messages.push({
      role: "assistant",
      content: rewriteText,
      ...(rewriteCalls.length > 0 ? { toolCalls: rewriteCalls } : {}),
    });
    if (rewriteText.length > 0) yield { type: "text-delta", text: rewriteText };
    for (const call of rewriteCalls) {
      yield { type: "tool-call", id: call.id, name: call.name, args: call.args };
    }

    const validation = validateFinalAnswer(rewriteText, finalAnswer.contract);
    const rewriteCancelled = signalAborted() || deadlineHit() || progressRunwayDeadlineHit();
    const rewriteEnforcementUnavailable =
      input.enforcement !== undefined && !input.enforcement.available();
    if (rewriteEnforcementUnavailable) {
      rewriteErrorCode = "WARDEN_UNAVAILABLE";
      rewriteErrorMessage = LOOP_WARDEN_UNAVAILABLE_MESSAGE;
    }
    const outcome = rewriteCancelled
      ? "fallback-cancelled"
      : rewriteEnforcementUnavailable
        ? "fallback-error"
        : rewriteCalls.length > 0
          ? "fallback-tool-call"
          : rewriteFinish === "length"
            ? "fallback-length"
            : rewriteFinish === "aborted"
              ? "fallback-cancelled"
              : rewriteFinish !== "stop" || rewriteText.trim().length === 0
                ? "fallback-error"
                : validation.ok
                  ? "accepted-rewrite"
                  : "fallback-oversized";
    yield {
      type: "final-answer-attempt",
      settlementId,
      attempt: "rewrite",
      contract: finalAnswer.contract,
      decision: outcome === "accepted-rewrite" ? "accepted" : "fallback",
      usage: rewriteUsage,
    };
    for (const call of rewriteCalls) {
      yield presentationToolResultEvent(
        call.id,
        { ok: false, output: LOOP_FINAL_ANSWER_REWRITE_TOOL_SKIP_MESSAGE },
        "skipped",
      );
      messages.push({
        role: "tool",
        content: LOOP_FINAL_ANSWER_REWRITE_TOOL_SKIP_MESSAGE,
        toolCallId: call.id,
        name: call.name,
      });
    }
    yield {
      type: "final-answer-settled",
      settlement: {
        settlementId,
        outcome,
        ...(hasRewriteUsage ? { rewriteUsage } : {}),
      },
    };

    const stop: StopEvent =
      outcome === "accepted-rewrite" || outcome === "fallback-oversized"
        ? modelStopEvent()
        : outcome === "fallback-cancelled"
          ? { type: "stop", reason: abortStopReason() }
          : outcome === "fallback-length"
            ? { type: "stop", reason: "length" }
            : {
                type: "stop",
                reason: "error",
                ...(rewriteErrorCode !== undefined
                  ? { code: rewriteErrorCode }
                  : outcome === "fallback-tool-call"
                    ? { code: "final-answer-rewrite-tool-call" }
                    : { code: "final-answer-rewrite-error" }),
                ...(rewriteErrorMessage !== undefined ? { message: rewriteErrorMessage } : {}),
              };
    return stop;
  };

  const failFinalAnswerOriginal = (failure: {
    readonly text: string;
    readonly calls: readonly ToolInvocationT[];
    readonly usage: ModelUsageT;
    readonly textAlreadyFlushed: boolean;
    readonly outcome:
      | "fallback-length"
      | "fallback-error"
      | "fallback-cancelled"
      | "fallback-tool-call";
  }): readonly KernelEventT[] => {
    if (finalAnswer === undefined) return [];
    const settlementId = `fas_${randomUUID()}`;
    const events: KernelEventT[] = [];
    if (!failure.textAlreadyFlushed && failure.text.length > 0) {
      events.push({ type: "text-delta", text: failure.text });
    }
    for (const call of failure.calls) {
      events.push({ type: "tool-call", id: call.id, name: call.name, args: call.args });
    }
    messages.push({
      role: "assistant",
      content: failure.text,
      ...(failure.calls.length > 0 ? { toolCalls: [...failure.calls] } : {}),
    });
    events.push({
      type: "final-answer-attempt",
      settlementId,
      attempt: "original",
      contract: finalAnswer.contract,
      decision: "fallback",
      usage: failure.usage,
    });
    for (const call of failure.calls) {
      events.push(
        presentationToolResultEvent(
          call.id,
          { ok: false, output: LOOP_FINAL_ANSWER_INCOMPLETE_TOOL_SKIP_MESSAGE },
          "skipped",
        ),
      );
      messages.push({
        role: "tool",
        content: LOOP_FINAL_ANSWER_INCOMPLETE_TOOL_SKIP_MESSAGE,
        toolCallId: call.id,
        name: call.name,
      });
    }
    events.push({
      type: "final-answer-settled",
      settlement: { settlementId, outcome: failure.outcome },
    });
    return events;
  };

  yield { type: "run-started" };

  for (;;) {
    if (signalAborted()) {
      yield { type: "stop", reason: abortStopReason() };
      break;
    }
    // P0-3: if the warden died between turns, halt fail-closed at the boundary rather than burning a
    // model call against a dead enforcement plane (and so a text-only final turn cannot mask the
    // halt as a clean model-stop). The mid-turn per-call probe covers a death during a turn.
    if (input.enforcement !== undefined && !input.enforcement.available()) {
      yield {
        type: "stop",
        reason: "error",
        code: "WARDEN_UNAVAILABLE",
        message: LOOP_WARDEN_UNAVAILABLE_MESSAGE,
      };
      break;
    }
    if (deadlineHit() || progressRunwayDeadlineHit()) {
      yield { type: "stop", reason: "deadline" };
      break;
    }
    if (turn >= maxTurns) {
      const finalizeProgress = latestFinalizeProgress;
      const canFinalize =
        detector !== undefined &&
        finalizeTurnsUsed < maxFinalizeTurns &&
        finalizeProgress !== undefined &&
        finalizeProgress.turnSeen === turn &&
        turn <= finalizeProgress.expiresAfterTurn;
      if (canFinalize) {
        finalizeTurnsUsed += 1;
        controlState.finalizeTurnsUsed = finalizeTurnsUsed;
        pushControllerPrompt(
          turnLimitFinalizeMessage({
            maxTurns,
            finalizeTurn: finalizeTurnsUsed,
            maxFinalizeTurns,
            evidence: `${finalizeProgress.evidenceKind}/${finalizeProgress.successSignal}`,
          }),
        );
      } else {
        const runwayProgress = latestProgressRunwayEvidence;
        const runwayWithinWall =
          maxProgressRunwayWallMs === undefined ||
          progressRunwayStartElapsedMs === undefined ||
          !progressRunwayDeadlineHit();
        const canUseProgressRunway =
          detector !== undefined &&
          progressRunwayHasCostBudget &&
          progressRunwayTurnsUsed < maxProgressRunwayTurns &&
          runwayProgress !== undefined &&
          runwayProgress.turnSeen === turn &&
          !usedProgressRunwayEvidenceRefs.has(runwayProgress.evidenceRef) &&
          runwayWithinWall;
        if (!canUseProgressRunway) {
          yield { type: "stop", reason: "max-turns" };
          break;
        }
        progressRunwayTurnsUsed += 1;
        controlState.progressRunwayTurnsUsed = progressRunwayTurnsUsed;
        progressRunwayStartElapsedMs ??= elapsedMs();
        controlState.progressRunwayStartElapsedMs = progressRunwayStartElapsedMs;
        armProgressRunwayDeadline();
        usedProgressRunwayEvidenceRefs.add(runwayProgress.evidenceRef);
        pushControllerPrompt(
          turnLimitProgressRunwayMessage({
            maxTurns,
            progressRunwayTurn: progressRunwayTurnsUsed,
            maxProgressRunwayTurns,
            evidence: `${runwayProgress.commandClass}/${runwayProgress.signal}`,
          }),
        );
      }
    }
    // Cost-aware budget triad (ADR-0044). All three report `reason: "budget"`; which ceiling fired
    // is reconstructable from the recorded `usage` TOGETHER WITH the run's configured caps (output ≥
    // maxOutputTokens → output; gross ≥ maxGrossTokens → gross; else effective) — the usage alone is
    // not enough, you need the cap values. The reconstruction's home is therefore the eval
    // outcome-parse/scoreboard layer (which has both), not a generic trajectory reader; this keeps
    // attribution honest-by-construction without a `StopReason`/event schema change. Output guard
    // first (most specific over-generation signal), then the gross backstop, then the effective cap.
    if (maxOutputTokens !== undefined && usage.outputTokens >= maxOutputTokens) {
      yield { type: "stop", reason: "budget" };
      break;
    }
    if (maxGrossTokens !== undefined && usage.inputTokens + usage.outputTokens >= maxGrossTokens) {
      yield { type: "stop", reason: "budget" };
      break;
    }
    if (maxTokens !== undefined && effectiveTokens(usage, cacheReadWeight) >= maxTokens) {
      yield { type: "stop", reason: "budget" };
      break;
    }

    // Budget-awareness warnings (1.1d): inject one nudge per crossed threshold before the cap, so
    // the model wraps up. Measured against the SAME effective-cost metric as the cap. Each fires once.
    if (maxTokens !== undefined && warnThresholds.length > 0) {
      const used = effectiveTokens(usage, cacheReadWeight);
      const newlyCrossed = warnThresholds.filter(
        (t) => !warnedThresholds.has(t) && used >= t * maxTokens,
      );
      if (newlyCrossed.length > 0) {
        for (const t of newlyCrossed) warnedThresholds.add(t);
        // The effective metric can be fractional (cached × a sub-1 weight); the event + message
        // report whole tokens — floor (never round up past the real usage).
        const usedReported = Math.floor(used);
        yield { type: "budget-warning", metric: "effective", usedTokens: usedReported, maxTokens };
        pushControllerPrompt(budgetWarningMessage(usedReported, maxTokens));
      }
    }

    // Gross runway is cumulative churn, not effective spend and not active context occupancy. Warn
    // on its own thresholds so users and the model can distinguish the non-reclaimable backstop.
    if (maxGrossTokens !== undefined && grossWarnThresholds.length > 0) {
      const usedGross = usage.inputTokens + usage.outputTokens;
      const newlyCrossed = grossWarnThresholds.filter(
        (t) => !warnedGrossThresholds.has(t) && usedGross >= t * maxGrossTokens,
      );
      if (newlyCrossed.length > 0) {
        for (const t of newlyCrossed) warnedGrossThresholds.add(t);
        yield {
          type: "budget-warning",
          metric: "gross",
          usedTokens: usedGross,
          maxTokens: maxGrossTokens,
        };
        pushControllerPrompt(grossRunwayWarningMessage(usedGross, maxGrossTokens));
      }
    }

    // In-loop compaction (Epic 1.6c option A): give the injected compactor a chance to reclaim runway
    // BEFORE this turn — a long drive nearing the gross cap shrinks instead of dying uncompacted. The
    // hook decides (cache-aware) whether to act and records its own audit event(s); a no-op returns
    // the same array (no copy).
    const toolDisabledFinalActive =
      terminalReviewSynthesisActive || terminalReviewRecoveryFinalizationActive;
    const toolsForTurn = toolDisabledFinalActive ? undefined : input.tools;
    if (input.compactor !== undefined && !toolDisabledFinalActive) {
      const pressure = computeContextPressure({
        messages,
        ...(toolsForTurn !== undefined ? { tools: toolsForTurn } : {}),
        cumulativeUsage: usage,
        ...(lastRequestUsage !== undefined ? { lastRequestUsage } : {}),
        lastRequestUsageSource,
        newObservationTokens: estimateTrailingToolObservationTokens(messages),
        contextWindow: input.contextWindow ?? {
          tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
          source: "fallback-default",
        },
      });
      const inputOrder = [...messages];
      const userProvenance = snapshotUserProvenance(inputOrder);
      let next: readonly ModelMessageT[];
      try {
        next = await input.compactor(messages, usage, effectiveSignal, pressure);
      } catch (error) {
        restoreUserProvenance(userProvenance);
        messages = inputOrder;
        throw error;
      }
      if (compactorPreservesUserProvenance(inputOrder, messages, userProvenance, next)) {
        if (next !== messages) messages = [...next];
      } else {
        restoreUserProvenance(userProvenance);
        messages = inputOrder;
      }
    }

    // Post-compaction gross-runway fit preflight (R7). Gross usage already spent cannot be reclaimed,
    // but compaction can shrink this exact next request. If even its estimated INPUT consumes the
    // remaining cap, no answer has useful runway: stop before `model.stream` and preserve evidence.
    if (maxGrossTokens !== undefined) {
      const usedGross = usage.inputTokens + usage.outputTokens;
      const remainingGross = maxGrossTokens - usedGross;
      const estimatedInputTokens = estimateTurnInputTokens({
        messages,
        ...(toolsForTurn !== undefined ? { tools: toolsForTurn } : {}),
      });
      if (estimatedInputTokens >= remainingGross) {
        yield {
          type: "stop",
          reason: "budget",
          code: GROSS_RUNWAY_PREFLIGHT_CODE,
          message: grossRunwayPreflightMessage({
            usedTokens: usedGross,
            maxTokens: maxGrossTokens,
            estimatedInputTokens,
          }),
        };
        break;
      }
    }

    turn += 1;
    controlState.turn = turn;
    yield { type: "turn-started", turn };

    let assistantText = "";
    const calls: ToolInvocationT[] = [];
    const deltaCalls = new Map<string, ToolCallDeltaBuffer>();
    let finishReason: FinishReasonT | undefined;
    let errorMessage: string | undefined;
    let errorCode: string | undefined;
    let turnUsage: ModelUsageT = { inputTokens: 0, outputTokens: 0 };
    let finalAnswerTextFlushed = finalAnswer === undefined;
    let finalAnswerBufferingShown = false;

    const turnInput: ModelTurnInput = {
      messages,
      ...(toolsForTurn !== undefined ? { tools: toolsForTurn } : {}),
      ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
      ...(input.params !== undefined ? { params: input.params } : {}),
    };
    for await (const chunk of model.stream(turnInput)) {
      if (chunk.type === "text-delta") {
        assistantText += chunk.text;
        if (finalAnswer !== undefined && !toolDisabledFinalActive && !finalAnswerBufferingShown) {
          finalAnswerBufferingShown = true;
          yield { type: "final-answer-buffering" };
        }
        // The terminal-review synthesis turn is buffered until its terminal is known. A provider
        // that emits an unadvertised tool call cannot smuggle accompanying prose into the UI before
        // the kernel rejects that call as not executed.
        if (!toolDisabledFinalActive && finalAnswerTextFlushed) {
          yield { type: "text-delta", text: chunk.text };
        }
      } else if (chunk.type === "tool-call") {
        if (finalAnswer === undefined && !toolDisabledFinalActive && !finalAnswerTextFlushed) {
          if (assistantText.length > 0) yield { type: "text-delta", text: assistantText };
          finalAnswerTextFlushed = true;
        }
        const call: ToolInvocationT = { id: chunk.id, name: chunk.name, args: chunk.args };
        calls.push(call);
        if (finalAnswer === undefined) {
          yield { type: "tool-call", id: call.id, name: call.name, args: call.args };
        }
      } else if (chunk.type === "tool-call-delta") {
        if (finalAnswer === undefined && !toolDisabledFinalActive && !finalAnswerTextFlushed) {
          if (assistantText.length > 0) yield { type: "text-delta", text: assistantText };
          finalAnswerTextFlushed = true;
        }
        const existing = deltaCalls.get(chunk.id);
        if (existing === undefined) {
          deltaCalls.set(chunk.id, {
            ...(chunk.name !== undefined ? { name: chunk.name } : {}),
            argsText: chunk.argsTextDelta,
          });
        } else {
          if (existing.name === undefined && chunk.name !== undefined) existing.name = chunk.name;
          existing.argsText += chunk.argsTextDelta;
        }
      } else if (chunk.type === "finish") {
        const providerReportedInputUsage = usageHasProviderInputReport(chunk.usage);
        const chunkUsage = usageWithFallback(
          chunk.usage,
          turnInput,
          assistantText,
          calls,
          deltaCalls,
        );
        turnUsage = chunkUsage;
        accumulateRequestUsage(
          chunkUsage,
          providerReportedInputUsage ? "provider-reported" : "local-fallback",
        );
        finishReason = chunk.reason;
      } else if (chunk.type === "error") {
        finishReason = "error";
        errorMessage = chunk.message;
        errorCode = chunk.code;
      }
      // reasoning-delta is intentionally ignored until reasoning carriage is built end-to-end.
    }

    // A truncated turn is not safe to persist or execute. Discard any partial assistant text/calls and
    // ask the model to continue from the last complete state in a fresh response.
    if (finishReason === "length") {
      if (finalAnswer !== undefined) {
        for (const event of failFinalAnswerOriginal({
          text: assistantText,
          calls,
          usage: turnUsage,
          textAlreadyFlushed: finalAnswerTextFlushed,
          outcome: "fallback-length",
        })) {
          yield event;
        }
        yield { type: "stop", reason: "length" };
        break;
      }
      if (toolDisabledFinalActive) {
        const terminalBlocked = terminalReviewOutcome === "blocked";
        yield {
          type: "stop",
          reason: "error",
          code: terminalBlocked ? "BLOCKED" : "REVIEW_REQUIRED",
          message: terminalBlocked
            ? "blocked action was not executed; change the task and rerun"
            : "requested action was not executed; change the task and rerun",
        };
        break;
      }
      if (terminalReviewRecoveryActive) {
        terminalReviewRecoveryActive = false;
        yield {
          type: "stop",
          reason: "error",
          code: "BLOCKED",
          message:
            "bounded recovery response was truncated; no correction was executed and no further attempt is available",
        };
        break;
      }
      pushControllerPrompt(KERNEL_STRINGS.lengthContinuation);
      continue;
    }

    if (finishReason !== "error" && finishReason !== "aborted" && deltaCalls.size > 0) {
      if (finishReason !== "tool-calls") {
        finishReason = "error";
        errorCode = "malformed-tool-call-delta";
        errorMessage = "streamed tool call deltas ended without a tool-call terminal";
      }
      const atomicIds = new Set(calls.map((c) => c.id));
      if (finishReason === "tool-calls") {
        for (const [id, buffer] of deltaCalls) {
          if (atomicIds.has(id)) continue;
          const assembled = assembleToolCallDelta(id, buffer);
          if (!assembled.ok) {
            finishReason = "error";
            errorCode = assembled.code;
            errorMessage = assembled.message;
            break;
          }
          calls.push(assembled.call);
          if (finalAnswer === undefined) {
            yield {
              type: "tool-call",
              id: assembled.call.id,
              name: assembled.call.name,
              args: assembled.call.args,
            };
          }
        }
      }
    }

    if (finishReason === "error") {
      if (finalAnswer !== undefined) {
        for (const event of failFinalAnswerOriginal({
          text: assistantText,
          calls,
          usage: turnUsage,
          textAlreadyFlushed: finalAnswerTextFlushed,
          outcome: "fallback-error",
        })) {
          yield event;
        }
      }
      yield {
        type: "stop",
        reason: "error",
        ...(errorCode !== undefined ? { code: errorCode } : {}),
        ...(errorMessage !== undefined ? { message: errorMessage } : {}),
      };
      break;
    }
    if (finishReason === undefined) {
      if (finalAnswer !== undefined) {
        for (const event of failFinalAnswerOriginal({
          text: assistantText,
          calls,
          usage: turnUsage,
          textAlreadyFlushed: finalAnswerTextFlushed,
          outcome: "fallback-error",
        })) {
          yield event;
        }
      }
      yield {
        type: "stop",
        reason: "error",
        code: "no-terminal",
        message: "provider stream ended without a terminal chunk",
      };
      break;
    }
    if (finishReason === "aborted") {
      if (finalAnswer !== undefined) {
        for (const event of failFinalAnswerOriginal({
          text: assistantText,
          calls,
          usage: turnUsage,
          textAlreadyFlushed: finalAnswerTextFlushed,
          outcome: "fallback-cancelled",
        })) {
          yield event;
        }
      }
      yield { type: "stop", reason: abortStopReason() };
      break;
    }
    if (
      finalAnswer !== undefined &&
      (signalAborted() || deadlineHit() || progressRunwayDeadlineHit())
    ) {
      for (const event of failFinalAnswerOriginal({
        text: assistantText,
        calls,
        usage: turnUsage,
        textAlreadyFlushed: finalAnswerTextFlushed,
        outcome: "fallback-cancelled",
      })) {
        yield event;
      }
      yield { type: "stop", reason: abortStopReason() };
      break;
    }
    if (finishReason === "tool-calls" && calls.length === 0) {
      if (finalAnswer !== undefined) {
        for (const event of failFinalAnswerOriginal({
          text: assistantText,
          calls,
          usage: turnUsage,
          textAlreadyFlushed: finalAnswerTextFlushed,
          outcome: "fallback-error",
        })) {
          yield event;
        }
      }
      yield {
        type: "stop",
        reason: "error",
        code: "malformed-tool-call-terminal",
        message: "provider emitted finish reason 'tool-calls' without any tool calls",
      };
      break;
    }
    if (calls.length > 0 && finishReason !== "tool-calls") {
      if (finalAnswer !== undefined) {
        for (const event of failFinalAnswerOriginal({
          text: assistantText,
          calls,
          usage: turnUsage,
          textAlreadyFlushed: finalAnswerTextFlushed,
          outcome: "fallback-tool-call",
        })) {
          yield event;
        }
      }
      yield {
        type: "stop",
        reason: "error",
        code: "malformed-tool-call-terminal",
        message: `provider emitted tool calls with finish reason '${finishReason}'`,
      };
      break;
    }

    if (finalAnswer !== undefined && finishReason === "tool-calls" && calls.length > 0) {
      // A contract-active response is held until its terminal proves whether it is a final answer or
      // ordinary working narration. Release only after a valid tool-call terminal is known; this lets
      // the runner keep a bounded candidate buffer without losing or duplicating narration.
      yield { type: "final-answer-buffer-released" };
      if (assistantText.length > 0) yield { type: "text-delta", text: assistantText };
      for (const call of calls) {
        yield { type: "tool-call", id: call.id, name: call.name, args: call.args };
      }
      finalAnswerTextFlushed = true;
    }

    if (
      finishReason === "stop" &&
      assistantText.trim().length === 0 &&
      calls.length === 0 &&
      !terminalReviewSynthesisActive &&
      !terminalReviewRecoveryActive &&
      !terminalReviewRecoveryFinalizationActive &&
      !hasConfiguredCompletionGate() &&
      !hasVisibleVerifiedCompletion() &&
      (!hasAssistantOrToolEvidenceSinceLastUser(messages) ||
        hasActionableWorkSinceLastUser(messages))
    ) {
      if (!emptyAssistantStopRetried) {
        emptyAssistantStopRetried = true;
        pushControllerPrompt(KERNEL_STRINGS.emptyAssistantStopContinuation);
        continue;
      }
      if (finalAnswer !== undefined) {
        for (const event of failFinalAnswerOriginal({
          text: assistantText,
          calls,
          usage: turnUsage,
          textAlreadyFlushed: finalAnswerTextFlushed,
          outcome: "fallback-error",
        })) {
          yield event;
        }
      }
      yield {
        type: "stop",
        reason: "error",
        code: "empty-assistant-stop",
        message: "provider returned an empty assistant stop twice",
      };
      break;
    }
    if (assistantText.trim().length > 0 || calls.length > 0) emptyAssistantStopRetried = false;

    if (
      toolDisabledFinalActive &&
      finalAnswer === undefined &&
      calls.length === 0 &&
      assistantText.length > 0
    ) {
      yield { type: "text-delta", text: assistantText };
    }

    if (assistantText.length > 0 || calls.length > 0) {
      messages.push({
        role: "assistant",
        content: toolDisabledFinalActive && calls.length > 0 ? "" : assistantText,
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
      });
    }

    if (signalAborted() && finalAnswer === undefined) {
      yield { type: "stop", reason: abortStopReason() };
      break;
    }
    if (deadlineHit() && finalAnswer === undefined) {
      yield { type: "stop", reason: "deadline" };
      break;
    }

    // Terminal review closes action execution for the run, but the user can still receive an honest
    // answer from observations that completed before the review. This pass received no tools. If a
    // provider violates that contract and emits calls anyway, close each call explicitly without
    // dispatching it, then retain the authoritative REVIEW_REQUIRED stop.
    if (terminalReviewSynthesisActive) {
      terminalReviewSynthesisActive = false;
      for (const call of calls) {
        yield presentationToolResultEvent(
          call.id,
          { ok: false, output: LOOP_REVIEW_REQUIRED_SKIP_MESSAGE },
          "skipped",
        );
        messages.push({
          role: "tool",
          content: LOOP_REVIEW_REQUIRED_SKIP_MESSAGE,
          toolCallId: call.id,
          name: call.name,
        });
      }
      if (calls.length === 0 && assistantText.trim().length > 0) {
        if (finalAnswer !== undefined) {
          const settlementStop = yield* settleFinalAnswerCandidate({
            text: assistantText,
            usage: turnUsage,
            textAlreadyFlushed: finalAnswerTextFlushed,
          });
          if (settlementStop.reason !== "model-stop") {
            yield settlementStop;
            break;
          }
        }
        yield unrecoveredBlockedActions > 0
          ? blockedStopEvent()
          : {
              type: "stop",
              reason: "model-stop",
              code: REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE,
              message: REVIEW_REQUIRED_AFTER_SYNTHESIS_MESSAGE,
            };
        break;
      }
      const terminalBlocked = terminalReviewOutcome === "blocked";
      yield {
        type: "stop",
        reason: "error",
        code: terminalBlocked ? "BLOCKED" : "REVIEW_REQUIRED",
        message: terminalBlocked
          ? "blocked action was not executed; change the task and rerun"
          : "requested action was not executed; change the task and rerun",
      };
      break;
    }

    // The bounded correction always ends with one tool-disabled closeout. Unadvertised calls are
    // recorded as not executed and cannot become a second attempt.
    if (terminalReviewRecoveryFinalizationActive) {
      terminalReviewRecoveryFinalizationActive = false;
      for (const call of calls) {
        yield presentationToolResultEvent(
          call.id,
          { ok: false, output: LOOP_BOUNDED_RECOVERY_SKIP_MESSAGE },
          "skipped",
        );
        messages.push({
          role: "tool",
          content: LOOP_BOUNDED_RECOVERY_SKIP_MESSAGE,
          toolCallId: call.id,
          name: call.name,
        });
      }
      if (calls.length === 0 && assistantText.trim().length > 0) {
        if (finalAnswer !== undefined) {
          const settlementStop = yield* settleFinalAnswerCandidate({
            text: assistantText,
            usage: turnUsage,
            textAlreadyFlushed: finalAnswerTextFlushed,
          });
          yield settlementStop;
        } else {
          yield modelStopEvent();
        }
        break;
      }
      yield {
        type: "stop",
        reason: "error",
        code: "BLOCKED",
        message: "bounded recovery ended without a tool-disabled final answer",
      };
      break;
    }

    const duplicateIds = duplicateToolCallIds(calls);
    if (duplicateIds.length > 0) {
      const output = `not executed: ${duplicateToolCallIdMessage(duplicateIds)}`;
      for (const call of calls) {
        yield presentationToolResultEvent(call.id, { ok: false, output }, "failed");
        messages.push({ role: "tool", content: output, toolCallId: call.id, name: call.name });
      }
      yield {
        type: "stop",
        reason: "error",
        code: DUPLICATE_TOOL_CALL_ID_CODE,
        message: duplicateToolCallIdMessage(duplicateIds),
      };
      break;
    }

    if (calls.length === 0) {
      if (terminalReviewRecoveryActive) {
        terminalReviewRecoveryActive = false;
        if (finalAnswer !== undefined) {
          const settlementStop = yield* settleFinalAnswerCandidate({
            text: assistantText,
            usage: turnUsage,
            textAlreadyFlushed: finalAnswerTextFlushed,
          });
          yield settlementStop;
        } else {
          yield modelStopEvent();
        }
        break;
      }
      const knownRed = findKnownRedCompletionEvidence(messages);
      if (knownRed !== undefined) {
        const retryKey = knownRedCompletionEvidenceKey(knownRed);
        const prompt = knownRedCompletionMessage({
          command: knownRed.command,
          detail: knownRed.detail,
        });
        if (!knownRedRetryKeys.has(retryKey)) {
          knownRedRetryKeys.add(retryKey);
          if (!finalAnswerTextFlushed && assistantText.length > 0) {
            yield { type: "final-answer-buffer-released" };
            yield { type: "text-delta", text: assistantText };
            finalAnswerTextFlushed = true;
          }
          pushControllerPrompt(prompt);
          yield { type: "verification-requested", prompt };
          continue;
        }
        if (!finalAnswerTextFlushed && assistantText.length > 0) {
          yield { type: "final-answer-buffer-released" };
          yield { type: "text-delta", text: assistantText };
          finalAnswerTextFlushed = true;
        }
        yield {
          type: "stop",
          reason: "error",
          code: "known-red-completion-evidence",
          message: prompt,
        };
        break;
      }

      // Acceptance/pre-stop verification: run provenance-bound completion checks before accepting a
      // clean model stop. Explicit/high-confidence failures get one feedback turn; a repeated failure
      // halts honestly. Advisory acceptance evidence never suppresses the prompt verifier below.
      if (
        input.verification?.acceptance !== undefined ||
        input.verification?.preStop !== undefined ||
        input.verification?.dynamicAcceptance !== undefined
      ) {
        const decision = await runCompletionChecksDecision();
        if (decision.kind === "stop") {
          if (!finalAnswerTextFlushed && assistantText.length > 0) {
            yield { type: "final-answer-buffer-released" };
            yield { type: "text-delta", text: assistantText };
            finalAnswerTextFlushed = true;
          }
          yield decision.event;
          break;
        }
        if (decision.kind === "prompt") {
          if (!finalAnswerTextFlushed && assistantText.length > 0) {
            yield { type: "final-answer-buffer-released" };
            yield { type: "text-delta", text: assistantText };
            finalAnswerTextFlushed = true;
          }
          pushControllerPrompt(decision.prompt);
          yield { type: "verification-requested", prompt: decision.prompt };
          continue;
        }
        if (decision.shouldStop) {
          if (finalAnswer !== undefined) {
            const settlementStop = yield* settleFinalAnswerCandidate({
              text: assistantText,
              usage: turnUsage,
              textAlreadyFlushed: finalAnswerTextFlushed,
            });
            yield settlementStop;
          } else {
            yield modelStopEvent();
          }
          break;
        }
      }

      // Pre-completion verification interceptor (1.1b; execution-grounded, Epic 1.19). On the FIRST
      // completion attempt, classify it from the conversation: SKIP if a real test PASS is on record
      // (verified — no friction); otherwise inject one verification turn and continue — a SHARPER,
      // execution-grounded nudge when the model declared done without running anything, else the
      // standard STOP-biased prompt. Never re-intercepts (no infinite nag).
      if (input.verification !== undefined && !promptVerificationDone) {
        const verdict = classifyCompletion(messages, {
          genericSkip: input.verification.genericSkip ?? false,
        });
        if (verdict !== "skip") {
          promptVerificationDone = true;
          const prompt =
            input.verification.prompt ??
            (verdict === "sharpen"
              ? KERNEL_STRINGS.verificationPromptUnverified
              : KERNEL_STRINGS.verificationPrompt);
          if (!finalAnswerTextFlushed && assistantText.length > 0) {
            yield { type: "final-answer-buffer-released" };
            yield { type: "text-delta", text: assistantText };
            finalAnswerTextFlushed = true;
          }
          pushControllerPrompt(prompt);
          yield { type: "verification-requested", prompt };
          continue;
        }
        // verdict === "skip": a recent test PASS with nothing after it — accept the stop, don't nag.
      }
      if (finalAnswer !== undefined) {
        const settlementStop = yield* settleFinalAnswerCandidate({
          text: assistantText,
          usage: turnUsage,
          textAlreadyFlushed: finalAnswerTextFlushed,
        });
        yield settlementStop;
      } else {
        yield modelStopEvent();
      }
      break;
    }

    let tripped: LoopSignal | undefined;
    let verifiedLoopStop = false;
    let tailSuccessStop = false;
    let abortedMidTurn = false;
    let wardenHalted = false;
    let terminalReviewHalted = false;
    let terminalReviewRecoveryAvailable = false;
    let terminalReviewCorrectionCompleted = false;
    let terminalReviewCorrectionSucceeded = false;
    const boundedRecoveryTurn = terminalReviewRecoveryActive;
    terminalReviewRecoveryActive = false;
    const toolMs = input.infraTimeout?.toolMs;
    const perCallStepTokens =
      calls.length > 0 ? (turnUsage.inputTokens + turnUsage.outputTokens) / calls.length : 0;
    for (let ci = 0; ci < calls.length; ci++) {
      const call = calls[ci]!;
      // Honor an abort that fires mid-turn — do not run remaining tools (1.1e hardening).
      if (signalAborted()) {
        for (let j = ci; j < calls.length; j++) {
          const stopped = calls[j]!;
          yield presentationToolResultEvent(
            stopped.id,
            { ok: false, output: KERNEL_STRINGS.toolAborted },
            "stopped",
          );
          messages.push({
            role: "tool",
            content: KERNEL_STRINGS.toolAborted,
            toolCallId: stopped.id,
            name: stopped.name,
          });
        }
        abortedMidTurn = true;
        break;
      }
      let result: ToolResultT;
      let infraTimedOut = false;
      if (toolMs !== undefined) {
        const toolDeadlineController = new AbortController();
        markToolDeadlineSignal(toolDeadlineController.signal);
        let removeParentAbortListener: (() => void) | undefined;
        if (effectiveSignal?.aborted === true) {
          toolDeadlineController.abort(effectiveSignal.reason);
        } else if (effectiveSignal !== undefined) {
          const parentSignal = effectiveSignal;
          const abortFromParent = (): void => toolDeadlineController.abort(parentSignal.reason);
          parentSignal.addEventListener("abort", abortFromParent, { once: true });
          removeParentAbortListener = (): void =>
            parentSignal.removeEventListener("abort", abortFromParent);
        }
        try {
          // Stream live output even under the infra deadline; a timeout rejects `withDeadline`, which
          // first revokes this exact execution occurrence, then re-throws through `yield*` into the
          // catch below after any buffered chunks drain (1.5c). Interactive review settlement is
          // awaited by the runner at the yielded infra-error boundary before the loop can re-drive.
          result = yield* executeWithLiveOutput(
            call,
            (o) =>
              withDeadline(
                () => executor.execute(call, o),
                toolMs,
                `tool '${call.name}'`,
                () => abortForToolDeadline(toolDeadlineController),
              ),
            toolDeadlineController.signal,
          );
          const reviewedResult = takeToolDeadlineReviewResult(toolDeadlineController.signal);
          void reviewedResult?.then(
            () => undefined,
            () => undefined,
          );
        } catch (err) {
          if (!(err instanceof InfraError)) throw err;
          const reviewedResult = takeToolDeadlineReviewResult(toolDeadlineController.signal);
          // Infra timeout (1.1e): record distinctly, feed a structured result so the
          // model can recover (§4.3 — no auto-retry); the run continues.
          yield {
            type: "infra-error",
            source: "tool",
            message: `tool '${call.name}' exceeded ${String(toolMs)}ms`,
          };
          if (reviewedResult === undefined) {
            result = { ok: false, output: infraTimeoutMessage(call.name, toolMs) };
          } else {
            try {
              const lateResult = await reviewedResult;
              result = isTerminalReviewResult(lateResult)
                ? lateResult
                : terminalReviewResult(KERNEL_STRINGS.reviewDeadlineLateOutcome, "partial");
            } catch {
              result = terminalReviewResult(
                KERNEL_STRINGS.reviewDeadlineOutcomeUnavailable,
                "partial",
              );
            }
          }
          infraTimedOut = true;
        } finally {
          removeParentAbortListener?.();
        }
      } else {
        // Stream the tool's incremental output as `tool-output-delta`s, then capture its result (1.5c).
        result = yield* executeWithLiveOutput(
          call,
          (o) => executor.execute(call, o),
          effectiveSignal,
        );
      }
      const presentationOutcome = toolPresentationOutcome(result);
      if (presentationOutcome === "blocked") unrecoveredBlockedActions += 1;
      yield presentationToolResultEvent(call.id, result, presentationOutcome);
      messages.push({ role: "tool", content: result.output, toolCallId: call.id, name: call.name });
      if (result.ok && (call.name === "read" || call.name === "search")) {
        hasSuccessfulTypedReadEvidence = true;
      }
      terminalReviewRecoveryState = recordTerminalReviewToolResult(terminalReviewRecoveryState, {
        toolName: call.name,
        ok: result.ok,
        soleCall: calls.length === 1,
        boundedCorrectionTurn: boundedRecoveryTurn,
      });

      // User cancellation is authoritative over a concurrent child-process close. Close every
      // sibling tool call explicitly so provider/session history remains well formed, then stop
      // before interpreting enforcement availability or asking the model to recover.
      if (signalAborted()) {
        for (let j = ci + 1; j < calls.length; j++) {
          const stopped = calls[j]!;
          yield presentationToolResultEvent(
            stopped.id,
            { ok: false, output: KERNEL_STRINGS.toolAborted },
            "stopped",
          );
          messages.push({
            role: "tool",
            content: KERNEL_STRINGS.toolAborted,
            toolCallId: stopped.id,
            name: stopped.name,
          });
        }
        abortedMidTurn = true;
        break;
      }

      // A live warden that cannot adjudicate or execute this request is still an enforcement-plane
      // failure. Do not re-drive the model and let prose overwrite that structural fact. Ordinary
      // tool failures remain recoverable because only the kernel-local control-failure tag halts.
      const controlFailureCode = toolControlFailureCode(result);
      if (controlFailureCode !== undefined) {
        const skippedMessage = `skipped: warden control failure ${controlFailureCode} stopped this turn; not executed`;
        for (let j = ci + 1; j < calls.length; j++) {
          const skipped = calls[j]!;
          yield presentationToolResultEvent(
            skipped.id,
            { ok: false, output: skippedMessage },
            "skipped",
          );
          messages.push({
            role: "tool",
            content: skippedMessage,
            toolCallId: skipped.id,
            name: skipped.name,
          });
        }
        yield {
          type: "stop",
          reason: "error",
          code: controlFailureCode,
          message: result.output,
        };
        wardenHalted = true;
        break;
      }

      // P0-3: if the spawned warden died, halt fail-closed rather than re-driving the model against a
      // dead enforcement plane. Emit synthetic skips for the turn's remaining calls (well-formed
      // conversation) and stop with a structured code the session driver renders as restart guidance.
      if (input.enforcement !== undefined && !input.enforcement.available()) {
        for (let j = ci + 1; j < calls.length; j++) {
          const skipped = calls[j]!;
          yield presentationToolResultEvent(
            skipped.id,
            { ok: false, output: LOOP_WARDEN_UNAVAILABLE_MESSAGE },
            "skipped",
          );
          messages.push({
            role: "tool",
            content: LOOP_WARDEN_UNAVAILABLE_MESSAGE,
            toolCallId: skipped.id,
            name: skipped.name,
          });
        }
        yield {
          type: "stop",
          reason: "error",
          code: "WARDEN_UNAVAILABLE",
          message: LOOP_WARDEN_UNAVAILABLE_MESSAGE,
        };
        wardenHalted = true;
        break;
      }

      // Terminal review closes ordinary execution for this run. The sole exception is an exact
      // process-local no-handle marker, which may offer one fresh model-authored atomic call below;
      // every other result remains terminal. Sibling calls are never assumed independent.
      if (isTerminalReviewResult(result)) {
        for (let j = ci + 1; j < calls.length; j++) {
          const skipped = calls[j]!;
          const skippedMessage = boundedRecoveryTurn
            ? LOOP_BOUNDED_RECOVERY_SKIP_MESSAGE
            : LOOP_REVIEW_REQUIRED_SKIP_MESSAGE;
          yield presentationToolResultEvent(
            skipped.id,
            { ok: false, output: skippedMessage },
            "skipped",
          );
          messages.push({
            role: "tool",
            content: skippedMessage,
            toolCallId: skipped.id,
            name: skipped.name,
          });
        }
        terminalReviewOutcome = presentationOutcome;
        terminalReviewTimedOut = infraTimedOut;
        terminalReviewRecoveryAvailable = isTerminalReviewRecoveryAvailable(result);
        terminalReviewHalted = true;
        break;
      }

      if (result.ok) {
        if (callSuggestsArtifactWrite(call)) hasArtifactWrite = true;
        if (callCanMutateAfterVerification(call)) resetTailSuccess();
      }
      const failureEvidence = extractLoopFailureEvidence(result);
      if (failureEvidence !== undefined) {
        latestFailureEvidence = failureEvidence;
        resetTailSuccess();
      }
      if (boundedRecoveryTurn) {
        const correctionSucceeded = boundedCorrectionSucceeded(call, result, failureEvidence);
        for (let j = ci + 1; j < calls.length; j++) {
          const skipped = calls[j]!;
          yield presentationToolResultEvent(
            skipped.id,
            { ok: false, output: LOOP_BOUNDED_RECOVERY_SKIP_MESSAGE },
            "skipped",
          );
          messages.push({
            role: "tool",
            content: LOOP_BOUNDED_RECOVERY_SKIP_MESSAGE,
            toolCallId: skipped.id,
            name: skipped.name,
          });
        }
        terminalReviewCorrectionCompleted = true;
        terminalReviewCorrectionSucceeded = correctionSucceeded && calls.length === 1;
        if (terminalReviewCorrectionSucceeded) {
          unrecoveredBlockedActions = Math.max(0, unrecoveredBlockedActions - 1);
          terminalReviewRecoveryState = recordTerminalReviewCorrectionSuccess(
            terminalReviewRecoveryState,
          );
        }
        break;
      }
      const successEvidence = extractStrongSuccessEvidence(call, result);
      latestStrongSuccessEvidence = successEvidence;
      if (successEvidence !== undefined && ci === calls.length - 1) {
        tailSuccessStop = recordTailSuccess(successEvidence);
      }
      const finalizeProgress = finalizeProgressEvidenceFor(call, result, turn);
      if (finalizeProgress !== undefined) latestFinalizeProgress = finalizeProgress;
      const progressRunway = progressRunwayEvidenceFor(call, result, turn);
      if (progressRunway !== undefined) latestProgressRunwayEvidence = progressRunway;

      // Feed the loop detector only on a real result — an infra-timeout is not a model
      // loop signal (1.1c/1.1e hardening). On a trip, do NOT run the rest of this turn's
      // calls; emit synthetic skipped results so the conversation stays well-formed.
      if (!infraTimedOut) {
        const signal = detector?.recordResult(call, result.output, {
          stepTokens: perCallStepTokens,
          resultOk: result.ok,
        });
        const nextProgressEpoch = detector?.progressEpoch() ?? loopProgressEpoch;
        if (nextProgressEpoch !== loopProgressEpoch) {
          loopRecoveryTrips.clear();
          loopProgressEpoch = nextProgressEpoch;
        }
        if (signal !== undefined) {
          tripped = signal;
          if (signal.advisory !== true) latestProgressRunwayEvidence = undefined;
          verifiedLoopStop =
            input.loopDetection?.stopOnRepeatedSuccessEvidence === true &&
            signal.advisory !== true &&
            ci === calls.length - 1 &&
            successEvidence !== undefined;
          for (let j = ci + 1; j < calls.length; j++) {
            const skipped = calls[j]!;
            yield presentationToolResultEvent(
              skipped.id,
              { ok: false, output: KERNEL_STRINGS.loopSkipped },
              "skipped",
            );
            messages.push({
              role: "tool",
              content: KERNEL_STRINGS.loopSkipped,
              toolCallId: skipped.id,
              name: skipped.name,
            });
          }
          break;
        }
      }
    }

    // P0-3: the warden-death halt already emitted its terminal stop inside the per-call loop; exit the
    // outer loop without emitting any further stop so exactly one stop is produced.
    if (wardenHalted) break;

    if (
      (terminalReviewCorrectionCompleted && !terminalReviewCorrectionSucceeded) ||
      (terminalReviewHalted && boundedRecoveryTurn && !terminalReviewTimedOut)
    ) {
      terminalReviewRecoveryFinalizationActive = true;
      pushControllerPrompt(KERNEL_STRINGS.terminalReviewRecoveryFinalization);
      continue;
    }

    if (terminalReviewHalted) {
      const recovery =
        !terminalReviewTimedOut && terminalReviewRecoveryAvailable
          ? takeTerminalReviewRecoveryCredit(terminalReviewRecoveryState)
          : undefined;
      if (recovery !== undefined) {
        terminalReviewRecoveryState = recovery.state;
        terminalReviewRecoveryActive = true;
        pushControllerPrompt(
          recovery.credit === "initial"
            ? KERNEL_STRINGS.terminalReviewRecovery
            : KERNEL_STRINGS.terminalReviewRecoveryEarned,
        );
        continue;
      }
      if (
        !terminalReviewTimedOut &&
        hasSuccessfulTypedReadEvidence &&
        !terminalReviewSynthesisAttempted
      ) {
        terminalReviewSynthesisAttempted = true;
        terminalReviewSynthesisActive = true;
        pushControllerPrompt(KERNEL_STRINGS.terminalReviewSynthesis);
        continue;
      }
      yield {
        type: "stop",
        reason: "error",
        code: terminalReviewOutcome === "blocked" ? "BLOCKED" : "REVIEW_REQUIRED",
        message: terminalReviewStopMessage(terminalReviewOutcome),
      };
      break;
    }

    if (abortedMidTurn) {
      yield { type: "stop", reason: abortStopReason() };
      break;
    }
    if (signalAborted()) {
      yield { type: "stop", reason: abortStopReason() };
      break;
    }
    if (deadlineHit()) {
      yield { type: "stop", reason: "deadline" };
      break;
    }

    if (verifiedLoopStop) {
      const decision = await runCompletionChecksDecision();
      if (decision.kind === "stop") {
        yield decision.event;
        break;
      }
      if (decision.kind === "prompt") {
        pushControllerPrompt(decision.prompt);
        yield { type: "verification-requested", prompt: decision.prompt };
        continue;
      }
      yield modelStopEvent();
      break;
    }

    if (tailSuccessStop && findKnownRedCompletionEvidence(messages) === undefined) {
      const decision = await runCompletionChecksDecision();
      if (decision.kind === "stop") {
        yield decision.event;
        break;
      }
      if (decision.kind === "prompt") {
        pushControllerPrompt(decision.prompt);
        yield { type: "verification-requested", prompt: decision.prompt };
        continue;
      }
      yield modelStopEvent();
      break;
    }

    // Loop detection (1.1c / Epic 2.28 Slice 2.5): non-advisory trips now use a
    // bounded warning -> forced-pivot -> hard-halt ladder.
    if (tripped !== undefined) {
      // An ADVISORY signal (the Epic 1.13 over-generation rail) only ever WARNS + redirects — it never
      // escalates to a terminal halt and never consumes the doom-loop recovery budget, so it cannot
      // kill a legitimate large-multi-file workflow that merely shares a filename family. reset() spaces
      // the next warning by `maxLargeRewrites` rewrites; the hard stop is the output/turn/budget cap.
      if (tripped.advisory === true) {
        detector?.resetAdvisory();
        // F7: OPT-IN escalation of the advisory loop-breaker nudge. When `escalateGuidance` is on, the
        // guidance escalates across trips so the model changes STRATEGY instead of being nudged with
        // identical text it already ignored. **Default OFF (fail-safe):** the bounded fix-validation run fix-validation run
        // measured the escalation net-negative (it regressed `tune-mjcf` + `schemelike`, both loop-breaker-
        // dependent), so the default is the OLD flat behavior — inject `KERNEL_STRINGS.loopGuidance` every
        // trip. A caller-supplied `guidance` overrides BOTH (the disable/ablation seam). Stays non-terminal
        // (Epic 1.13): only the wording can change; the hard stop remains the output/turn/budget cap.
        const escalations = KERNEL_STRINGS.loopGuidanceEscalations;
        const level = Math.min(advisoryTrips, escalations.length - 1);
        advisoryTrips += 1;
        const advisoryGuidance =
          input.loopDetection?.escalateGuidance === true
            ? (escalations[level] ?? KERNEL_STRINGS.loopGuidance)
            : KERNEL_STRINGS.loopGuidance;
        const guidance =
          input.loopDetection?.guidance ?? renderConfiguredLoopGuidance(advisoryGuidance);
        yield {
          type: "loop-detected",
          signal: tripped.signal,
          detail: tripped.detail,
          guidance,
        };
        pushControllerPrompt(guidance);
        continue;
      }
      const recoveryKey = loopRecoveryKey(tripped);
      const recoveryTrips = loopRecoveryTrips.get(recoveryKey) ?? 0;
      if (recoveryTrips < 2) {
        const guidanceBase =
          recoveryTrips === 0
            ? KERNEL_STRINGS.loopGuidance
            : (KERNEL_STRINGS.loopGuidanceEscalations[1] ?? KERNEL_STRINGS.loopGuidance);
        loopRecoveryTrips.set(recoveryKey, recoveryTrips + 1);
        detector?.reset(tripped);
        const guidance =
          input.loopDetection?.guidance ?? renderConfiguredLoopGuidance(guidanceBase);
        yield {
          type: "loop-detected",
          signal: tripped.signal,
          detail: tripped.detail,
          guidance,
        };
        pushControllerPrompt(guidance);
        continue;
      }
      yield {
        type: "stop",
        reason: "loop-detected",
        message: `${tripped.signal}: ${tripped.detail}`,
      };
      break;
    }
  }

  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer); // release the armed wall-clock abort
  if (progressRunwayTimer !== undefined) clearTimeout(progressRunwayTimer);
  removeCallerAbortListener?.(); // drop the caller-signal listener so a re-driven signal doesn't leak
  // Controller prompts use provider-compatible `user` roles during the run, but are not human input.
  // Strip every tagged occurrence from the carry so the next REPL turn cannot render it as cyan `you`.
  input.onFinalMessages?.(messages.filter((message) => !controllerOwnedUserMessages.has(message)));
  yield { type: "run-finished", usage: usageDelta(usage, runUsageBaseline) };
}
