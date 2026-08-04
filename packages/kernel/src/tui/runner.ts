import type {
  ExecutorPort,
  ModelMessageT,
  ModelPort,
  StopReasonT,
  ToolSpecT,
  UIPort,
  UiToolActivity,
  UserInput,
  ViewModel,
} from "@keel/shared";
import { runAgentLoop, runAgentLoopWithControlState } from "../loop.js";
import type {
  AgentCompactor,
  AgentLoopControlState,
  AgentLoopInput,
  AgentLoopStop,
} from "../loop.js";
import type { ContextWindowSpec } from "../context/pressure.js";
import { record } from "../session/recorder.js";
import { rebuild, closeOpenToolCalls } from "../session/resume.js";
import { applySteering, recordSteering } from "../session/steering.js";
import type { AppliedSteering } from "../session/steering.js";
import { readSession } from "../session/store.js";
import type { SessionStore } from "../session/store.js";
import {
  URGENT_VERBS,
  commandRoute,
  densityForCommand,
  densityNotice,
  diffNotice,
  noticeForCommand,
} from "./commands.js";
import {
  applyMutationPresentationResolution,
  initialView,
  modelPanel,
  reduce,
} from "./view-model.js";
import type { SeedPresentation, ViewConfig } from "./view-model.js";
import type { GoalCompletionAuditT, GoalT, LifecycleManifestT } from "@keel/shared";
import {
  appendGoalAudit,
  appendGoalStarted,
  goalAuditNotice,
  goalValidationFailureNotice,
} from "../run/goal-session.js";
import { runGoalValidation } from "../run/goal-validation.js";
import {
  modelRouteStatusFromDecision,
  type ModelRouteRuntime,
} from "../model-routing/controller.js";
import { summarizeAutoResolutionReceipt } from "../warden/receipt.js";
import type { InteractiveReviewDecisionController } from "./review-decision.js";
import {
  mutationPresentationResolverForEvent,
  type MutationPresentationResolutionV1,
  type MutationPresentationResolverV1,
} from "../warden/mutation-presentation-resolver.js";
import { mutationPresentationActivityForEvent } from "./mutation-presentation.js";
import { connectOverlayDismiss } from "./overlay-dismiss.js";
import {
  LIVENESS_TICK_MS,
  livenessDurationBucket,
  supportsPurposefulLiveness,
} from "./purposeful-liveness.js";
import { GROSS_RUNWAY_PREFLIGHT_CODE } from "../events.js";
import { createFinalAnswerPresentation } from "./final-answer-presentation.js";

export interface RunSessionOpts {
  readonly model: ModelPort;
  readonly executor: ExecutorPort;
  readonly ui: UIPort;
  readonly store: SessionStore;
  readonly seed: readonly ModelMessageT[];
  /** Ambient HUD config (model label · cwd · posture) for the protection line. Omitted → neutral
   *  all-off facts with an unreported route; the entrypoint threads the resolved product state. */
  readonly view?: ViewConfig;
  /** Resolve the session ledger (for the rebuild-from-ledger re-drive on steering application).
   *  Defaults to `process.env`; the CLI entrypoint (Epic 1.6) threads the real one. */
  readonly env?: NodeJS.ProcessEnv;
  /** Whether a tool name is a mutating action — gates the urgent "before the next mutating action"
   *  boundary (§4.10). Production injects `createToolRuntime().isMutating` (a `staticCapability`-backed
   *  predicate, ADR-0024 — CAP-1); the hardcoded five-tool set below is the fallback for text-only/test
   *  runs that pass no predicate. */
  readonly isMutating?: (toolName: string) => boolean;
  /** Tool specs advertised to the model each turn (Epic 1.6a). Omitted → a text-only run; the
   *  production entrypoint passes `createToolRuntime().tools` so the model can call the five tools. */
  readonly tools?: readonly ToolSpecT[];
  /** §4.3 / Epic-1.1 loop-safety controls threaded into `runAgentLoop` (INT-1). Omitted → only the
   *  loop's `DEFAULT_MAX_TURNS` cap applies. The production entrypoint sets sane defaults (loop
   *  detection + a per-tool infra deadline, + an optional token budget) so a real `keel run` is not
   *  unguarded against doom-loops / hung tools / unbounded cost. */
  readonly stop?: AgentLoopStop;
  readonly loopDetection?: AgentLoopInput["loopDetection"];
  readonly infraTimeout?: AgentLoopInput["infraTimeout"];
  /** Injectable presentation clock for deterministic purposeful-liveness tests. Production uses
   * `performance.now()`. It affects only an opted-in dynamic UIPort and never loop deadlines,
   * persistence, audit, model context, or headless output. */
  readonly presentationNow?: () => number;
  /** P0-3 structural enforcement probe. The session entrypoint builds this from the warden runtime's
   *  liveness so the loop halts fail-closed when the spawned warden dies mid-session. Omitted →
   *  unchanged behavior (simulator / local executor / text-only runs). */
  readonly enforcement?: AgentLoopInput["enforcement"];
  /** Pre-completion verification interceptor (Epic 1.1b) — inject one verify-against-the-task turn
   *  before the first completion. The production entrypoint enables it by default (spec §7). */
  readonly verification?: AgentLoopInput["verification"];
  readonly params?: AgentLoopInput["params"];
  /** Explicit task-scoped terminal-answer contract (ADR-0087). The runner derives the only local
   * inspection command from this session's controller-owned id. */
  readonly finalAnswer?: Pick<NonNullable<AgentLoopInput["finalAnswer"]>, "contract">;
  /** Ledger-derived seed projection metadata. Never enters provider context. */
  readonly seedPresentation?: SeedPresentation;
  /** Epic 1.6c PR-d: the IN-LOOP context compactor (serves RUNWAY). Threaded into `runAgentLoop` so it
   *  fires at turn boundaries; the runner re-drives after steering from the loop's resulting compacted
   *  set (4b), not a rebuild-from-full. Omitted → no in-loop compaction. INERT until the entrypoint
   *  (session-entry) supplies one — the ER-021 production flip (slice 5, human sign-off). Distinct from
   *  the legacy boundary-pass `compaction` opt above. */
  readonly compactor?: AgentCompactor;
  /** Context-window metadata used by the in-loop compactor's typed pressure gate. */
  readonly contextWindow?: ContextWindowSpec;
  /** Whether this `runSession` owns the UIPort lifecycle. `true` (default) → it closes the UI in its
   *  `finally` (single-turn / `keel run -p` / standalone tests — unchanged). `false` → the multi-turn
   *  `runRepl` driver (Epic 1.23) owns open/close across turns; runSession leaves the UI open and
   *  detaches its per-turn input consumer at the boundary so the driver can pull the next prompt. */
  readonly ownsUi?: boolean;
  /** Which seed messages to RECORD to the ledger on the first turn (default: all of `seed`). The
   *  multi-turn driver passes only the NEW user message so the carried prior history — already in the
   *  ledger — is not re-recorded, keeping the ledger canonical + de-duplicated (Epic 1.23). The full
   *  `seed` is still the model context; this controls persistence only. */
  readonly recordSeed?: readonly ModelMessageT[];
  /** Epic 2.12 run-control: an optional first-class goal whose completion is adjudicated from the
   *  session ledger after the turn settles. The goal changes no executor authority; it only adds
   *  metadata and a ledger-derived completion audit. */
  readonly goal?: GoalT;
  /** Epic 2.15b: the trusted lifecycle manifest, so a goal's `--validation <tier>` runs the tier's
   *  required actions (as governed `lifecycle.run`) and completion reflects a REAL pass. Absent → a
   *  configured tier is honestly `not_run` (the goal stays unverified/incomplete, never faked). */
  readonly lifecycleManifest?: LifecycleManifestT;
  /** Epic 2.13 governed model-routing inspection surface. Presentation-only; the gateway remains the
   *  authority for decisions and provider dispatch. */
  readonly modelRouting?: ModelRouteRuntime;
  /** Epic 2.32 interactive review-resolution bridge. The runner remains the sole input consumer and
   *  routes active review answers here before treating them as steering. */
  readonly reviewDecisions?: InteractiveReviewDecisionController;
}

export type GoalFailureReason =
  | Exclude<GoalCompletionAuditT["verdict"], "complete">
  | "aborted"
  | "error";

/** The result of a session run — the final terminal reason, so the caller (the bin) can set an honest
 *  exit code. `undefined` = the run produced no terminal (e.g. the user left before typing a prompt);
 *  clean `model-stop` = success; attention-coded `model-stop`, failed goal validation, and abnormal
 *  reasons are nonzero. */
export interface RunOutcome {
  readonly lastStop?: StopReasonT;
  readonly lastStopCode?: string;
  readonly lastStopMessage?: string;
  readonly lastGoalFailure?: GoalFailureReason;
}

/** One turn's full result — what `runSession` returns. The loop ALWAYS emits exactly one `stop` event
 *  before `run-finished` (loop.ts) and always captures its final working set + view, so `finalMessages`
 *  and `finalView` are REQUIRED here (no undefined to guard against in the multi-turn driver). Kept
 *  distinct from `RunOutcome` — the bin's exit-code shape — because only the `runRepl` carry needs them. */
export interface TurnOutcome extends RunOutcome {
  /** The loop's FINAL working set (post in-loop compaction) — the multi-turn driver carries this into
   *  the next turn so the conversation accrues without a rebuild-from-ledger each turn (Epic 1.23).
   *  On an interrupted turn this is the turn's input messages (the loop still emits its stop + set). */
  readonly finalMessages: readonly ModelMessageT[];
  /** The turn's FINAL view (transcript + any interrupt / run-ended note). The multi-turn driver renders
   *  the idle prompt FROM this — after the turn's input consumer has stopped (handoff-safe) — so the
   *  notes persist instead of being wiped by a rebuild-from-messages (Epic 1.23). */
  readonly finalView: ViewModel;
}

/** Conservative fallback: workspace-write/broad tools mutate; read/search do not (§4.8 axis-1). */
const MUTATING_TOOLS = new Set(["edit", "write", "bash"]);
const defaultIsMutating = (name: string): boolean => MUTATING_TOOLS.has(name);

/** A classified mid-run input. `command` (non-steering palette commands) is surfaced for the
 *  entrypoint to handle; the runner itself acts only on steering + interrupt. */
export type Classified =
  | { readonly kind: "interrupt" }
  | { readonly kind: "steering"; readonly class: "queued" | "urgent"; readonly content: string }
  | { readonly kind: "command"; readonly name: string; readonly args?: string };

/** Map a raw `UserInput` to its §4.10 steering intent (pure; exported for unit testing). A typed
 *  line is a queued comment; an urgent verb (`/now` …) carries its instruction; `interrupt` and the
 *  `/interrupt` command hard-stop; any other slash command is a non-steering palette command. */
export function classifyInput(input: UserInput): Classified {
  if (input.kind === "interrupt") return { kind: "interrupt" };
  if (input.kind === "line") return { kind: "steering", class: "queued", content: input.text };
  // command
  if (input.name === "/interrupt") return { kind: "interrupt" };
  if (URGENT_VERBS.has(input.name)) {
    return { kind: "steering", class: "urgent", content: input.args ?? input.name };
  }
  return {
    kind: "command",
    name: input.name,
    ...(input.args !== undefined ? { args: input.args } : {}),
  };
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function settleMutationPresentationOccurrence(
  resolver: MutationPresentationResolverV1,
  signal: AbortSignal,
): Promise<MutationPresentationResolutionV1> {
  const occurrenceEnded = (): MutationPresentationResolutionV1 => ({
    status: "unavailable",
    reason: "occurrence-ended",
  });
  if (signal.aborted) return occurrenceEnded();

  // Convert rejection into a strict local resolution before racing the process-local occurrence.
  // If the occurrence ends first, `observed` remains rejection-safe and its eventual value is
  // deliberately discarded rather than being allowed to mutate a later card with a reused id.
  const observed = Promise.resolve()
    .then(() => resolver(signal))
    .then(
      (resolution): MutationPresentationResolutionV1 => resolution,
      (): MutationPresentationResolutionV1 => ({
        status: "unavailable",
        reason: "transport-failed",
      }),
    );
  let onAbort: (() => void) | undefined;
  const ended = new Promise<MutationPresentationResolutionV1>((resolve) => {
    onAbort = () => resolve(occurrenceEnded());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  const resolution = await Promise.race([observed, ended]);
  if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  if (signal.aborted) void observed.then(() => undefined);
  return resolution;
}

function autoResolutionReceiptForStore(
  store: SessionStore,
  env: NodeJS.ProcessEnv,
  startIndex: number | undefined,
): { readonly automatic: readonly string[]; readonly attention: readonly string[] } | undefined {
  if (startIndex === undefined) return undefined;
  try {
    return summarizeAutoResolutionReceipt(readSession(store.id, env).events.slice(startIndex));
  } catch {
    return undefined;
  }
}

function sessionEventCountForStore(
  store: SessionStore,
  env: NodeJS.ProcessEnv,
): number | undefined {
  try {
    return readSession(store.id, env).events.length;
  } catch {
    return undefined;
  }
}

/**
 * Drive one interactive session end-to-end: stream `runAgentLoop`, tee through `record` (persist to
 * the session ledger, 1.4), reduce each event into the view, and render it via the `UIPort`, while
 * consuming `ui.inputs()` concurrently to apply §4.10 mid-run steering. Takes injected ports — the
 * production construction (real provider + Workspace + tools) is Epic 1.6.
 *
 * Steering (no loop change — `runAgentLoop` owns its messages, so application = re-drive, the 1.4
 * resume discipline):
 * - **queued** (a typed line): recorded pending (`recordSteering`, survives a crash before
 *   application) + indicator; at the next **tool/turn boundary** (a `tool-result`) the run is
 *   aborted, the comment is injected as a `user` message (`applySteering`), and the loop re-drives.
 * - **urgent** (`/now` etc.): same, but the boundary is the next **mutating** `tool-call` — aborted
 *   before that action executes.
 * - **interrupt** (`Esc`/`Ctrl-C`/`/interrupt`): aborts the run; no new actions, session resumable;
 *   no re-drive.
 *
 * Boundaries are turn/tool-level; edit-specific timing, structured-task-state application, and the
 * plan-change note mature with the Epic 1.6 task ledger (MASTER_SPEC §4.10 epic pointers).
 *
 * Post-completion input: a line typed after the run has already stopped is still recorded, echoed as
 * a user message (the `input-applied` view event = a visible ack, never silent absorption), and
 * re-driven — but in a single-turn 1.5 session the re-drive may yield no further model output. The
 * multi-turn REPL that turns such input into a fresh answered turn is the Epic 1.6 production loop.
 */
export async function runSession(opts: RunSessionOpts): Promise<TurnOutcome> {
  return await runSessionImpl(opts);
}

/** Kernel-internal seam for automatic sessions that belong to one physical bounded run. */
export async function runSessionWithControlState(
  opts: RunSessionOpts,
  controlState: AgentLoopControlState,
): Promise<TurnOutcome> {
  return await runSessionImpl(opts, controlState);
}

async function runSessionImpl(
  opts: RunSessionOpts,
  controlState?: AgentLoopControlState,
): Promise<TurnOutcome> {
  const env = opts.env ?? process.env;
  const isMutating = opts.isMutating ?? defaultIsMutating;
  const ownsUi = opts.ownsUi ?? true;
  const receiptStartIndex = sessionEventCountForStore(opts.store, env);
  let controller = new AbortController();
  const finalAnswerInspectionCommand = `keel sessions answer ${opts.store.id} --original`;
  const finalAnswerPresentation =
    opts.finalAnswer === undefined
      ? undefined
      : createFinalAnswerPresentation({
          contract: opts.finalAnswer.contract,
          originalInspectionCommand: finalAnswerInspectionCommand,
        });

  let view = initialView(opts.seed, opts.view, opts.seedPresentation);
  opts.ui.render(view);
  let lastRendered = view;
  const render = (): void => {
    if (view === lastRendered) return;
    opts.ui.render(view);
    lastRendered = view;
  };
  const livenessEnabled = supportsPurposefulLiveness(opts.ui);
  const presentationNow = opts.presentationNow ?? (() => performance.now());
  type LivenessTimer = ReturnType<typeof setInterval>;
  interface ActiveToolLiveness {
    readonly itemIndex: number;
    readonly id: string;
    readonly startedAtMs: number;
    lastOutputAtMs: number;
    lastNowMs: number;
    timer: LivenessTimer;
  }
  interface ToolExecutionOccurrence {
    readonly itemIndex: number;
    readonly id: string;
    state: "requested" | "in-flight" | "completed";
  }
  const toolExecutionOccurrences: ToolExecutionOccurrence[] = [];
  let activeToolLiveness: ActiveToolLiveness | undefined;
  let livenessFailure: unknown;
  let livenessFailed = false;
  const readPresentationNow = (previous = 0): number => {
    const observed = presentationNow();
    if (!Number.isFinite(observed)) return previous;
    return Math.max(previous, Math.max(0, observed));
  };
  const updateToolLiveness = (renderNow: boolean): void => {
    const active = activeToolLiveness;
    if (active === undefined) return;
    const now = readPresentationNow(active.lastNowMs);
    active.lastNowMs = now;
    const next = reduce(view, {
      type: "tool-liveness",
      itemIndex: active.itemIndex,
      id: active.id,
      elapsedMs: livenessDurationBucket(now - active.startedAtMs),
      quietMs: livenessDurationBucket(now - active.lastOutputAtMs),
      ...(opts.infraTimeout?.toolMs === undefined ? {} : { timeoutMs: opts.infraTimeout.toolMs }),
    });
    if (next === view) return;
    view = next;
    if (renderNow) render();
  };
  const endToolLiveness = (clearResidue: boolean, renderClear = true): void => {
    const active = activeToolLiveness;
    if (active === undefined) return;
    activeToolLiveness = undefined;
    clearInterval(active.timer);
    if (!clearResidue) return;
    const next = reduce(view, {
      type: "tool-liveness",
      itemIndex: active.itemIndex,
      id: active.id,
    });
    if (next !== view) {
      view = next;
      if (renderClear) render();
    }
  };
  const failToolLiveness = (error: unknown): void => {
    if (livenessFailed) return;
    livenessFailed = true;
    livenessFailure = error;
    // A timer callback is outside the async iterator's exception boundary. Settle its exact dynamic
    // occurrence locally, then abort the governed run so the ordinary runner boundary can close all
    // resources and rethrow after teardown. Never attempt another render through a renderer that just
    // failed.
    endToolLiveness(true, false);
    controller.abort();
  };
  const beginToolLiveness = (occurrence: ToolExecutionOccurrence): void => {
    if (!livenessEnabled) return;
    endToolLiveness(true);
    const target = view.items[occurrence.itemIndex];
    if (target?.kind !== "tool" || target.status !== "running" || target.id !== occurrence.id)
      return;
    const startedAtMs = readPresentationNow();
    const timer = setInterval(() => {
      try {
        updateToolLiveness(true);
      } catch (error) {
        failToolLiveness(error);
      }
    }, LIVENESS_TICK_MS);
    (timer as LivenessTimer & { unref?: () => void }).unref?.();
    activeToolLiveness = {
      itemIndex: occurrence.itemIndex,
      id: occurrence.id,
      startedAtMs,
      lastOutputAtMs: startedAtMs,
      lastNowMs: startedAtMs,
      timer,
    };
    updateToolLiveness(true);
  };
  const presentationExecutor: ExecutorPort = {
    execute(call, options) {
      const occurrence = toolExecutionOccurrences.find(
        (candidate) => candidate.id === call.id && candidate.state === "requested",
      );
      if (occurrence === undefined) return opts.executor.execute(call, options);
      occurrence.state = "in-flight";
      beginToolLiveness(occurrence);
      let execution: ReturnType<ExecutorPort["execute"]>;
      try {
        execution = opts.executor.execute(call, options);
      } catch (error) {
        occurrence.state = "completed";
        throw error;
      }
      void execution.then(
        () => {
          occurrence.state = "completed";
        },
        () => {
          occurrence.state = "completed";
        },
      );
      return execution;
    },
  };
  const disconnectOverlayDismiss = connectOverlayDismiss(opts.ui, () => {
    if (view.overlay === undefined) return;
    const { overlay: _overlay, ...rest } = view;
    void _overlay;
    view = rest;
    render();
  });

  let messages: readonly ModelMessageT[] = opts.seed;
  let firstRun = true;
  let interrupted = false;
  let lastStop: StopReasonT | undefined; // the final terminal reason (INT-2 — for the exit code)
  let lastStopCode: string | undefined;
  let lastStopMessage: string | undefined;
  let lastGoalFailure: GoalFailureReason | undefined;
  let urgentDeferred = false;
  const pending: AppliedSteering[] = [];

  interface ActivePresentationOccurrence {
    readonly target: UiToolActivity;
    readonly controller: AbortController;
  }
  let activePresentation: ActivePresentationOccurrence | undefined;
  const endActivePresentation = (): void => {
    const occurrence = activePresentation;
    if (occurrence === undefined) return;
    activePresentation = undefined;
    occurrence.controller.abort();
    view = applyMutationPresentationResolution(view, occurrence.target, {
      status: "unavailable",
      reason: "occurrence-ended",
    });
    render();
  };

  const hasUrgent = (): boolean => pending.some((s) => s.class === "urgent");
  const hasQueued = (): boolean => pending.some((s) => s.class === "queued");
  const urgentMustWaitForResume = (): boolean =>
    hasUrgent() &&
    (lastStop === "budget" ||
      (lastStop === "error" && lastStopCode === GROSS_RUNWAY_PREFLIGHT_CODE));
  const disconnectReviewDecisions = opts.reviewDecisions?.connect({
    presentation: (event) => {
      switch (event.kind) {
        case "opened":
          view = reduce(view, {
            type: "approval-opened",
            detail: event.detail,
            sessionAvailable: event.sessionAvailable,
            information: event.information,
          });
          break;
        case "message":
          view = reduce(view, { type: "approval-message", content: event.content });
          break;
        case "submitted":
          view = reduce(view, {
            type: "approval-submitted",
            content: event.content,
            ...(event.choice === undefined ? {} : { choice: event.choice }),
          });
          break;
        case "confirmed":
          view = reduce(view, { type: "approval-confirmed", content: event.content });
          break;
        case "governed-deny":
          view = reduce(view, { type: "approval-governed-deny", content: event.content });
          break;
        case "denied":
          view = reduce(view, { type: "approval-denied", content: event.content });
          break;
        case "indeterminate":
          view = reduce(view, { type: "approval-indeterminate", content: event.content });
          break;
        case "failed":
          view = reduce(view, { type: "approval-failed", content: event.content });
          break;
        case "closed":
          view = reduce(view, {
            type: "approval-closed",
            ...(event.content !== undefined ? { content: event.content } : {}),
          });
          break;
      }
      render();
    },
  });

  const handleInput = (input: UserInput): void => {
    if (view.overlay !== undefined) {
      if (input.kind === "interrupt") {
        const { overlay: _overlay, ...rest } = view;
        void _overlay;
        view = rest;
        render();
      }
      return;
    }
    if (opts.reviewDecisions?.handleInput(input) === true) return;
    const c = classifyInput(input);
    if (c.kind === "interrupt") {
      endActivePresentation();
      interrupted = true;
      controller.abort();
      return;
    }
    if (c.kind === "steering") {
      endActivePresentation();
      const inputId = recordSteering(opts.store, { class: c.class, content: c.content });
      pending.push({ inputId, class: c.class, content: c.content });
      view = reduce(view, { type: "input-queued", class: c.class, content: c.content }); // visible queue + ack
      render();
      return;
    }
    if (c.kind === "command" && commandRoute(c.name, "running") === "notice") {
      view = reduce(view, { type: "system-notice", content: noticeForCommand(c.name) });
      render();
      return;
    }
    if (c.kind === "command" && c.name === "/diff" && c.args?.trim().toLowerCase() === "review") {
      view = reduce(view, {
        type: "system-notice",
        content: "Focused diff review is available after the active turn settles.",
      });
      render();
      return;
    }
    if (c.kind === "command" && c.name === "/diff" && (c.args?.trim().length ?? 0) > 0) {
      view = reduce(view, { type: "system-notice", content: "usage: /diff [review]" });
      render();
      return;
    }
    if (c.kind === "command" && c.name === "/diff") {
      // §8 (Epic 1.5b): a view-only toggle the runner owns (it holds the view + render) — flip the
      // diff disclosure level (auto compact default ↔ full) and re-render existing edits at the new level.
      view = reduce(view, { type: "diff-mode-toggle" });
      // Acknowledge the new level in the transcript, mirroring the density commands — the footer only
      // labels `full`, so a toggle back to the `compact` default would otherwise be a silent change.
      view = reduce(view, {
        type: "system-notice",
        content: diffNotice(view.diffMode ?? "compact"),
      });
      render();
      return;
    }
    const density = c.kind === "command" ? densityForCommand(c.name) : undefined;
    if (density !== undefined) {
      view = reduce(view, { type: "density-set", density });
      view = reduce(view, { type: "system-notice", content: densityNotice(density) });
      render();
      return;
    }
    if (c.kind === "command" && c.name === "/context") {
      view = reduce(view, { type: "context-panel" });
      render();
      return;
    }
    if (c.kind === "command" && (c.name === "/policies" || c.name === "/policy")) {
      view = reduce(view, { type: "policies-panel" });
      render();
      return;
    }
    if (c.kind === "command" && c.name === "/model") {
      const mode =
        c.args?.trim() === "preview" ? "preview" : c.args?.trim() === "why" ? "why" : "status";
      const preview = mode === "preview" ? opts.modelRouting?.preview() : undefined;
      const status =
        preview !== undefined ? modelRouteStatusFromDecision(preview) : opts.modelRouting?.status();
      view = reduce(
        {
          ...view,
          status: {
            ...view.status,
            ...(status !== undefined ? { modelRoute: status } : {}),
          },
        },
        {
          type: "model-panel",
          content: modelPanel(
            { ...view.status, ...(status !== undefined ? { modelRoute: status } : {}) },
            mode,
          ),
        },
      );
      render();
      return;
    }
    if (c.kind === "command" && c.name === "/compact") {
      view = reduce(view, { type: "compact-review" });
      render();
      return;
    }
    if (c.kind === "command" && c.name === "/reviews") {
      view = reduce(view, { type: "review-queue-panel" });
      render();
      return;
    }
    if (c.kind === "command") {
      view = reduce(view, { type: "system-notice", content: noticeForCommand(c.name) });
      render();
    }
  };

  // Consume mid-run input concurrently. The race with `stop` means an interactive stream that never
  // completes cannot block teardown — when the run ends we stop pulling regardless.
  const stop = deferred();
  const inputIt = opts.ui.inputs()[Symbol.asyncIterator]();
  let inputFailed = false;
  let inputFailure: unknown;
  const consumeInputs = async (): Promise<void> => {
    for (;;) {
      const next = await Promise.race([inputIt.next(), stop.promise.then(() => "stop" as const)]);
      if (next === "stop") return;
      if (next.done) {
        endActivePresentation();
        if (opts.reviewDecisions?.cancelPending() === true) {
          interrupted = true;
          controller.abort();
        }
        return;
      }
      acknowledgeInput(inputIt, next.value);
      handleInput(next.value);
    }
  };
  const consumeTask = consumeInputs().catch((error: unknown) => {
    inputFailed = true;
    inputFailure = error;
    interrupted = true;
    try {
      endActivePresentation();
    } catch (settlementError) {
      inputFailure = new AggregateError(
        [error, settlementError],
        "input channel failed and presentation settlement could not be rendered",
      );
    }
    controller.abort();
  });

  // The loop's FINAL working set (post in-loop compaction), surfaced via `onFinalMessages`. The
  // steering re-drive continues from this — NOT a rebuild-from-full — so an in-loop compaction is not
  // discarded and re-folded each steering cycle (Epic 1.6c PR-d slice 4 / 4b). Seeded with the initial
  // context for the (impossible) case the loop yields no run-finished.
  let loopFinal: readonly ModelMessageT[] = messages;
  let completedGoalValidation: Awaited<ReturnType<typeof runGoalValidation>> | undefined;
  let pendingGoalTurnSummary: ViewModel["turnSummary"];

  const validateGoal = async (skip: boolean) => {
    if (opts.goal === undefined) throw new Error("goal validation requires a goal");
    let announced = false;
    try {
      return await runGoalValidation({
        validation: opts.goal.validation,
        ...(opts.lifecycleManifest !== undefined ? { manifest: opts.lifecycleManifest } : {}),
        executor: opts.executor,
        signal: controller.signal,
        skip,
        onActionStart: (action) => {
          announced = true;
          view = reduce(view, { type: "goal-validation-started", action });
          render();
        },
      });
    } finally {
      if (announced) {
        view = reduce(view, { type: "goal-validation-finished" });
        render();
      }
    }
  };

  const applyPendingAtBoundary = (): void => {
    const before = rebuild(readSession(opts.store.id, env)).messages.length;
    const next = closeOpenToolCalls(loopFinal);
    pending.forEach((steering, index) => {
      applySteering(opts.store, steering, before + index);
      next.push({ role: "user", content: steering.content });
      view = reduce(view, {
        type: "input-applied",
        content: steering.content,
        class: steering.class,
      });
      render();
    });
    messages = next;
    pending.length = 0;
    controller = new AbortController();
  };

  try {
    for (;;) {
      if (interrupted) break; // interrupt arrived between runs (during application)

      if (firstRun && opts.goal !== undefined) {
        appendGoalStarted((event) => opts.store.append(event), opts.goal);
      }

      // §4.7 compaction now runs IN-LOOP (Epic 1.6c PR-d): the injected `compactor` fires at each turn
      // boundary inside `runAgentLoop` (RUNWAY-driven, cache-aware), and the steering re-drive below
      // continues from its compacted working set (4b). The full pre-compaction history stays canonical
      // in the ledger (SEC-023). (The legacy re-drive-boundary compaction block was removed here — the
      // in-loop compactor subsumes it; production never wired the old `opts.compaction` boundary path.)

      const loopInput: AgentLoopInput = {
        messages,
        signal: controller.signal,
        ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
        ...(opts.stop !== undefined ? { stop: opts.stop } : {}),
        ...(opts.loopDetection !== undefined ? { loopDetection: opts.loopDetection } : {}),
        ...(opts.infraTimeout !== undefined ? { infraTimeout: opts.infraTimeout } : {}),
        ...(opts.enforcement !== undefined ? { enforcement: opts.enforcement } : {}),
        ...(opts.verification !== undefined ? { verification: opts.verification } : {}),
        ...(opts.params !== undefined ? { params: opts.params } : {}),
        ...(opts.finalAnswer !== undefined
          ? {
              finalAnswer: {
                contract: opts.finalAnswer.contract,
                originalInspectionCommand: finalAnswerInspectionCommand,
              },
            }
          : {}),
        ...(opts.compactor !== undefined ? { compactor: opts.compactor } : {}),
        ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
        onFinalMessages: (m) => {
          loopFinal = m;
        },
      };
      const loopEvents =
        controlState === undefined
          ? runAgentLoop(opts.model, presentationExecutor, loopInput)
          : runAgentLoopWithControlState(opts.model, presentationExecutor, loopInput, controlState);
      const events = record(opts.store, firstRun ? (opts.recordSeed ?? opts.seed) : [], loopEvents);
      firstRun = false;

      for await (const ev of events) {
        if (ev.type === "infra-error") {
          const settlement = await opts.reviewDecisions?.awaitTimedOutReviewSettlement();
          if (
            settlement !== undefined &&
            !(settlement.status === "resolved" && settlement.verdict === "deny")
          ) {
            interrupted = true;
            controller.abort();
          }
        }
        // A bounded loop persists per-automatic-run usage deltas so durable consumers can sum each
        // provider token exactly once. Its live HUD, however, represents the whole physical run and
        // must not fall back to the final zero-request delta when a cumulative cap stops re-drive.
        const presentationEvent =
          ev.type === "run-finished" && controlState !== undefined
            ? { ...ev, usage: controlState.usage }
            : ev;
        if (ev.type === "run-finished" && toolExecutionOccurrences.length > 0) {
          // The loop's canonical end closes process-local execution observation before the generic
          // reducer settlement runs. These occurrence-indexed facts explain only what this runner
          // directly observed; they do not synthesize a tool result, durable event, or audit claim.
          endToolLiveness(false);
          for (const occurrence of toolExecutionOccurrences) {
            view = reduce(view, {
              type: "tool-execution-state-at-run-end",
              itemIndex: occurrence.itemIndex,
              id: occurrence.id,
              state:
                occurrence.state === "requested"
                  ? "not-started"
                  : occurrence.state === "in-flight"
                    ? "in-flight"
                    : "completed",
            });
          }
          toolExecutionOccurrences.length = 0;
        }
        for (const projectedEvent of finalAnswerPresentation?.project(presentationEvent) ?? [
          presentationEvent,
        ]) {
          view = reduce(view, projectedEvent);
        }
        if (ev.type === "tool-call") {
          const itemIndex = view.items.length - 1;
          const target = view.items[itemIndex];
          if (target?.kind === "tool" && target.status === "running" && target.id === ev.id) {
            toolExecutionOccurrences.push({ itemIndex, id: ev.id, state: "requested" });
          }
        } else if (ev.type === "tool-result") {
          const occurrenceIndex = toolExecutionOccurrences.findIndex(
            (occurrence) => occurrence.id === ev.id,
          );
          if (occurrenceIndex >= 0) toolExecutionOccurrences.splice(occurrenceIndex, 1);
        }
        if (ev.type === "tool-output-delta" && activeToolLiveness?.id === ev.id) {
          const now = readPresentationNow(activeToolLiveness.lastNowMs);
          activeToolLiveness.lastNowMs = now;
          activeToolLiveness.lastOutputAtMs = now;
          updateToolLiveness(false);
        } else if (ev.type === "tool-result" && activeToolLiveness?.id === ev.id) {
          // The reducer reconstructed the settled activity without liveness. Stop the clock without
          // another view mutation or render: the ordinary event render below owns settlement once.
          endToolLiveness(false);
        }
        const presentationResolver =
          ev.type === "tool-result" ? mutationPresentationResolverForEvent(ev) : undefined;
        const goalValidationPending = ev.type === "run-finished" && opts.goal !== undefined;
        const turnWillContinue =
          ev.type === "run-finished" &&
          !urgentMustWaitForResume() &&
          (interrupted || pending.length > 0 || goalValidationPending);
        if (ev.type === "run-finished") {
          const receipt = autoResolutionReceiptForStore(opts.store, env, receiptStartIndex);
          if (receipt !== undefined) {
            view = reduce(view, {
              type: "auto-resolution-receipt",
              automatic: receipt.automatic,
              attention: receipt.attention,
            });
          }
          if (goalValidationPending) pendingGoalTurnSummary = view.turnSummary;
        }
        if (turnWillContinue) {
          view = reduce(view, { type: "turn-not-final" });
        }
        const presentationActivity =
          presentationResolver === undefined ? undefined : mutationPresentationActivityForEvent(ev);
        if (
          presentationResolver !== undefined &&
          presentationActivity !== undefined &&
          (interrupted || pending.length > 0)
        ) {
          view = applyMutationPresentationResolution(view, presentationActivity, {
            status: "unavailable",
            reason: "occurrence-ended",
          });
          render();
        } else {
          // Only an active occurrence may render the pending mutable card. A queued/interrupt
          // boundary above settles it before this first render, so it can never enter scrollback.
          render();
          if (presentationResolver !== undefined && presentationActivity !== undefined) {
            // A fresh object is the occurrence identity. Provider ids may be reused across turns;
            // only this exact controller/target pair may settle this exact mutable activity.
            const occurrence: ActivePresentationOccurrence = {
              target: presentationActivity,
              controller: new AbortController(),
            };
            activePresentation = occurrence;
            const resolution = await settleMutationPresentationOccurrence(
              presentationResolver,
              occurrence.controller.signal,
            );
            if (activePresentation === occurrence) {
              activePresentation = undefined;
              view = applyMutationPresentationResolution(view, presentationActivity, resolution);
              render();
            }
          }
        }
        if (ev.type === "stop") {
          lastStop = ev.reason; // remember the terminal reason for the outcome
          lastStopCode = ev.code;
          lastStopMessage = ev.message;
        }
        if (ev.type === "stop" && ev.code === "WARDEN_UNAVAILABLE") {
          // P0-3: the warden died mid-session and the loop halted fail-closed. The reducer already
          // surfaced the honest "enforcement stopped" line; add the concrete, resumable restart path
          // (the session is saved — a fresh `--resume` re-establishes a governed warden).
          view = reduce(view, {
            type: "system-notice",
            content: `Your session is saved — restart governed enforcement with: keel --resume ${opts.store.id}`,
          });
          render();
        }
        if (interrupted) continue; // interrupting — let the loop wind down, no boundary re-entry
        if (ev.type === "tool-call" && isMutating(ev.name) && hasUrgent()) {
          controller.abort(); // urgent: apply before this mutating action runs
        } else if (ev.type === "tool-result" && hasQueued()) {
          controller.abort(); // queued: apply after the current tool/turn
        }
      }

      if (!interrupted && urgentMustWaitForResume()) {
        urgentDeferred = true;
        view = reduce(view, { type: "urgent-input-deferred" });
        view = reduce(view, {
          type: "system-notice",
          content: `urgent correction still pending — this turn's token budget ended before it could be applied; resume with: keel --resume ${opts.store.id}`,
        });
        render();
        break;
      }

      if (interrupted) {
        // Immediate interrupt means no new model/tool action starts. Pending steering stays durable
        // in the ledger; the REPL applies it before the user's next explicit turn, or a fresh process
        // applies it on resume. Never auto-redrive merely because input was queued before Esc.
        break;
      }
      if (pending.length === 0 && opts.goal !== undefined) {
        // Validation is still part of the active turn: the input consumer remains connected and a
        // follow-up may arrive while a real lifecycle tier runs. A completed validation becomes
        // stale if that happens, so re-drive the queued input and validate the resulting final turn.
        completedGoalValidation = await validateGoal(interrupted);
        if (interrupted) break;
      }
      if (pending.length === 0 && opts.goal !== undefined) {
        // Promise continuations for an input delivered at the same boundary run before the receipt
        // decision. Then stop and await this turn's consumer: no later continuation can append a
        // queued input after an immutable final receipt has already been rendered.
        await Promise.resolve();
        if (pending.length === 0) {
          stop.resolve();
          await consumeTask;
        }
        if (interrupted) break;
      }
      if (pending.length === 0) break; // run and any configured validation completed with no follow-up
      completedGoalValidation = undefined;
      pendingGoalTurnSummary = undefined;

      // Apply pending steering at the boundary: record each to the ledger (the canonical full history)
      // and re-drive from the loop's FINAL (possibly compacted) working set + the steering user
      // message(s) — NOT a rebuild-from-full (4b). The full pre-compaction history stays in the ledger
      // for fresh-process resume (SEC-023); `closeOpenToolCalls` repairs an aborted turn's dangling
      // tool call so the in-memory re-drive context is valid provider history. `insertedAt` stays a
      // ledger index (rebuild length), independent of the compacted in-memory view.
      applyPendingAtBoundary();
    }

    if (interrupted) {
      // A stop recorded by the model loop can precede goal validation. If the user interrupts while
      // that validation is still part of the active turn, the turn's terminal outcome is the later
      // interrupt, not the earlier model stop. The durable goal_failed event records the same
      // ordering for resume/list without fabricating a second usage-bearing run_status event.
      lastStop = "aborted";
      lastStopCode = undefined;
      lastStopMessage = undefined;
      view = reduce(view, { type: "interrupted" });
      render();
    }
    if (opts.goal !== undefined) {
      // Run the configured validation tier for real (governed lifecycle.run) before adjudicating —
      // completion is honest only when the tier actually passed (Epic 2.15b). A clean model-stop no
      // longer fabricates a pass; no manifest/tier resolves to `not_run`. On an interrupted turn we
      // skip the tier (honest `not_run`) rather than launch the full suite the user just cancelled,
      // and thread the turn's signal so a Ctrl-C arriving mid-tier aborts the in-flight action.
      const validation =
        (!interrupted && !urgentDeferred ? completedGoalValidation : undefined) ??
        (await validateGoal(interrupted || urgentDeferred));
      const audit = appendGoalAudit({
        append: (event) => opts.store.append(event),
        sessionId: opts.store.id,
        goal: opts.goal,
        events: readSession(opts.store.id, env).events,
        validation,
        interrupted,
      });
      lastGoalFailure =
        audit.verdict === "complete" ? undefined : interrupted ? "aborted" : audit.verdict;
      const auditNotice = goalAuditNotice(
        audit,
        opts.goal,
        goalValidationFailureNotice(validation),
      );
      const auditLines = auditNotice.split("\n");
      const baseSummary = pendingGoalTurnSummary ??
        view.turnSummary ?? {
          title: "done" as const,
          changed: [],
          checked: [],
          attention: [],
        };
      view = reduce(view, {
        type: "turn-finalized",
        summary: {
          ...baseSummary,
          title: audit.verdict === "complete" ? baseSummary.title : "needs attention",
          receipt: auditLines,
        },
      });
      render();
    }
  } finally {
    try {
      // Close owns the final terminal erase. Mutate the returned view but do not risk a second
      // renderer call during exceptional teardown.
      endToolLiveness(true, false);
      endActivePresentation();
      stop.resolve();
      await consumeTask;
      // Single-turn / one-shot owns the UI → close it. Multi-turn (runRepl) keeps it open across
      // turns; instead, detach this turn's input consumer (it abandoned a pending `next()` when the
      // run stopped) so the driver's next pull doesn't trip the InputQueue single-consumer guard
      // (1.23).
      if (ownsUi) await opts.ui.close();
      else detachInput(inputIt);
    } finally {
      // Presentation sidecars are process-local ownership only. Always restore the prior LIFO owner,
      // even when UI or input settlement fails, so a later session cannot inherit stale authority.
      disconnectOverlayDismiss();
      disconnectReviewDecisions?.();
    }
  }
  if (inputFailed && livenessFailed) {
    throw new AggregateError(
      [inputFailure, livenessFailure],
      "input channel and purposeful-liveness rendering both failed",
    );
  }
  if (inputFailed) throw inputFailure;
  if (livenessFailed) throw livenessFailure;
  return {
    ...(lastStop !== undefined ? { lastStop } : {}),
    ...(lastStopCode !== undefined ? { lastStopCode } : {}),
    ...(lastStopMessage !== undefined ? { lastStopMessage } : {}),
    ...(lastGoalFailure !== undefined ? { lastGoalFailure } : {}),
    finalMessages: loopFinal,
    finalView: view,
  };
}

/** Clear a per-turn input consumer's abandoned pull at a turn-handoff boundary (Epic 1.23). Only the
 *  InputQueue iterator implements `detachConsumer`; a headless/other input source is a safe no-op. */
function detachInput(it: AsyncIterator<UserInput>): void {
  (it as { detachConsumer?: () => void }).detachConsumer?.();
}

/** Confirm that a directly delivered shared-queue value belongs to this consumer. */
function acknowledgeInput(it: AsyncIterator<UserInput>, input: UserInput): void {
  (it as { acknowledge?: (value: UserInput) => void }).acknowledge?.(input);
}
