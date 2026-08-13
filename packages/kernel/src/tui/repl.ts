import type {
  FinalAnswerContractT,
  LoopConfigT,
  ModelMessageT,
  StopReasonT,
  UiStatus,
  UserInput,
  ViewItem,
  ViewModel,
} from "@keel/shared";
import {
  EXIT_COMMANDS,
  densityForCommand,
  densityNotice,
  diffNotice,
  noticeForCommand,
} from "./commands.js";
import { runSession } from "./runner.js";
import type { GoalFailureReason, RunOutcome, RunSessionOpts } from "./runner.js";
import type { TurnOutcome } from "./runner.js";
import {
  applyPendingSteeringOnResume,
  closeOpenToolCalls,
  rebuild,
  type ResumeState,
} from "../session/resume.js";
import { readSession } from "../session/store.js";
import {
  buildTurnSummary,
  firstRunView,
  initialView,
  leadingSystemEnd,
  modelPanel,
  reduce,
} from "./view-model.js";
import type { ViewConfig } from "./view-model.js";
import { goalPrompt } from "../run/goal-session.js";
import { runBoundedLoopSession } from "../run/loop-session.js";
import { parseGoalArgs, parseLoopArgs, shellJoin, shellWords } from "../run/run-control-parser.js";
import { isReadOnlyCommand } from "../verify-gate.js";
import { modelRouteStatusFromDecision } from "../model-routing/controller.js";
import { oneLineText, stripControl, stripControlLine } from "../control-strip.js";
import { connectOverlayDismiss } from "./overlay-dismiss.js";
import { connectLocalInputActivity } from "./input-activity.js";
import { requestDiffViewer } from "./diff-viewer-control.js";
import { visibleTerminalText } from "./visible-text.js";
import { seedInputHistory } from "./input-history.js";
import { latestFinalAnswerOriginal } from "../session/final-answer-inspection.js";
import { stopCodeNeedsAttention } from "../events.js";

export interface InteractivePlanApprovalResult {
  readonly ok: boolean;
  readonly output: string;
  readonly view?: ViewConfig;
}

export interface InteractivePlanApprovalController {
  readonly preview: (args: string) => InteractivePlanApprovalResult;
  readonly approve: (args: string) => InteractivePlanApprovalResult;
  readonly clear: () => void;
}

function resumedSteeringLabel(total: number, urgent: number): string {
  const boundedTotal = Math.max(0, Math.floor(total));
  const boundedUrgent = Math.min(boundedTotal, Math.max(0, Math.floor(urgent)));
  if (boundedUrgent === 0) {
    return `${boundedTotal} pending comment${boundedTotal === 1 ? "" : "s"}`;
  }
  if (boundedUrgent === boundedTotal) {
    return `${boundedUrgent} urgent correction${boundedUrgent === 1 ? "" : "s"}`;
  }
  return `${boundedTotal} pending inputs (${boundedUrgent} urgent)`;
}

type SeedPresentationState = Pick<
  ResumeState,
  | "failedToolCallIds"
  | "failedToolMessageIndexes"
  | "finalAnswerOccurrences"
  | "finalAnswerSettlements"
  | "interruptedFinalAnswerSettlementIds"
>;

/**
 * Avoid projecting empty ledger presentation indexes across every message of an ordinary turn.
 * Any authoritative exceptional state keeps the complete projection so malformed or partial
 * histories remain conservative and visible (ADR-0087).
 */
export function seedPresentationForTurn(
  state: SeedPresentationState,
  sessionId: string,
): RunSessionOpts["seedPresentation"] {
  if (
    state.failedToolCallIds.size === 0 &&
    state.failedToolMessageIndexes.size === 0 &&
    state.finalAnswerOccurrences.size === 0 &&
    state.finalAnswerSettlements.size === 0 &&
    state.interruptedFinalAnswerSettlementIds.size === 0
  ) {
    return undefined;
  }
  return {
    failedToolCallIds: state.failedToolCallIds,
    failedToolMessageIndexes: state.failedToolMessageIndexes,
    finalAnswerOccurrences: state.finalAnswerOccurrences,
    finalAnswerSettlements: state.finalAnswerSettlements,
    interruptedFinalAnswerSettlementIds: state.interruptedFinalAnswerSettlementIds,
    originalInspectionCommand: `keel sessions answer ${sessionId} --original`,
  };
}

/**
 * Options for the multi-turn REPL driver. Everything `runSession` needs PER TURN, minus the seam
 * fields the driver owns itself (`seed` / `recordSeed` / `ownsUi`), plus the session-level `head`.
 *
 * (Resume seeding — `--continue` / `--resume <id>` — lands in slice 2 and will add its inputs here
 * with their own tests; they are not declared speculatively now, per YAGNI.)
 */
export interface RunReplOpts extends Omit<RunSessionOpts, "seed" | "recordSeed" | "ownsUi"> {
  /** Leading system context (system prompt + env snapshot + skills + AGENTS.md). Recorded to the
   *  ledger once, on the first turn of a FRESH session. Omitted on resume (the resumed ledger has it). */
  readonly head?: readonly ModelMessageT[];
  /** A resumed prior conversation — the messages `rebuild()` reconstructed from a reopened ledger
   *  (`keel --continue` / `--resume <id>`, Epic 1.23 slice 2). Seeds the model context but is NOT
   *  re-recorded (it is already in the ledger); the first new turn records only its own user message. */
  readonly resumed?: readonly ModelMessageT[];
  /** Ordinary persisted user prompts eligible for process-local composer recall on resume. */
  readonly resumedInputHistory?: readonly string[];
  /** Internal durable outcome metadata paired with `resumed`; never sent to the model. */
  readonly resumedFailedToolCallIds?: ReadonlySet<string>;
  /** Occurrence-precise durable outcome metadata paired with `resumed`. */
  readonly resumedFailedToolMessageIndexes?: ReadonlySet<number>;
  readonly resumedFinalAnswerOccurrences?: NonNullable<
    RunSessionOpts["seedPresentation"]
  >["finalAnswerOccurrences"];
  readonly resumedFinalAnswerSettlements?: NonNullable<
    RunSessionOpts["seedPresentation"]
  >["finalAnswerSettlements"];
  readonly resumedInterruptedFinalAnswerSettlementIds?: NonNullable<
    RunSessionOpts["seedPresentation"]
  >["interruptedFinalAnswerSettlementIds"];
  /** Controller-owned successful loop verification derived from the durable resume fold. */
  readonly resumedLoopVerification?: ResumeState["latestLoopVerification"];
  /** Durable controller stop truth paired with `resumed`. Presentation-only; model prose and tool
   * result text cannot set it. */
  readonly resumedLastStop?: StopReasonT;
  readonly resumedLastStopCode?: string;
  readonly resumedLastStopMessage?: string;
  /** How many still-pending steering inputs (queued/urgent) were re-applied while rebuilding the
   *  resumed context (P1-3). Surfaced in the resume header so the carry-over is acknowledged, not
   *  silently folded into the message count (ADR-0034 "visibly acknowledge · no silent absorption").
   *  The applied inputs already ride `resumed` as `user` messages; this is the honest cue. */
  readonly resumedSteeringApplied?: number;
  /** Subset of `resumedSteeringApplied` whose ledger class is urgent. Presentation-only, allowing
   *  resume copy to preserve the `/now` timing distinction without changing model context. */
  readonly resumedUrgentSteeringApplied?: number;
  /** Verified Warden-audit evidence for prior human once-only authority. Presentation-only: it is
   *  neither model context nor a session event, and explicitly states that resume restored no grant. */
  readonly historicOnceApprovalReceipt?: string;
  /** Epic 2.32 public interactive Plan Autopilot bridge. This approves an exact-resource envelope for
   *  the next plain task line only; the warden/executor still resolves every matching review. */
  readonly planApprovals?: InteractivePlanApprovalController;
}

function planCommandArgs(
  raw: string | undefined,
):
  | { readonly ok: true; readonly action: "preview" | "approve" | "clear"; readonly args: string }
  | { readonly ok: false; readonly error: string } {
  let words: string[];
  try {
    words = shellWords(raw ?? "");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "invalid /plan syntax",
    };
  }
  const [action, ...rest] = words;
  if (action !== "preview" && action !== "approve" && action !== "clear") {
    return {
      ok: false,
      error:
        "usage: /plan <preview|approve|clear> [--plan-id <id>] (--domain <domain> | --command-key <sha256:key>) ...",
    };
  }
  if (action === "clear" && rest.length > 0) {
    return { ok: false, error: "usage: /plan clear" };
  }
  return { ok: true, action, args: shellJoin(rest) };
}

type AnswerCommand =
  | { readonly ok: true; readonly action: "clear" | "full" }
  | { readonly ok: true; readonly action: "arm"; readonly contract: FinalAnswerContractT }
  | { readonly ok: false; readonly error: string };

function answerCommand(raw: string | undefined): AnswerCommand {
  const value = (raw ?? "").trim();
  if (value === "clear" || value === "full") return { ok: true, action: value };
  if (!/^[1-9]\d*$/u.test(value)) {
    return { ok: false, error: "usage: /answer <40..2000|clear|full>" };
  }
  const maxWords = Number(value);
  if (!Number.isSafeInteger(maxWords) || maxWords < 40 || maxWords > 2_000) {
    return { ok: false, error: "word bound must be a base-10 integer in 40..2000" };
  }
  return { ok: true, action: "arm", contract: { version: 1, maxWords } };
}

export function statusAfterPlanTurn(status: UiStatus, baseView: ViewConfig | undefined): UiStatus {
  if (status.startup?.phase === "protections-unavailable") return status;
  const protectionRoute = baseView?.protectionRoute ?? status.protectionRoute;
  return {
    ...(status.model !== undefined ? { model: status.model } : {}),
    ...(status.cwd !== undefined ? { cwd: status.cwd } : {}),
    ...(status.git !== undefined ? { git: status.git } : {}),
    ...(status.context !== undefined ? { context: status.context } : {}),
    ...(status.cost !== undefined ? { cost: status.cost } : {}),
    ...(status.modelRoute !== undefined ? { modelRoute: status.modelRoute } : {}),
    tokens: status.tokens,
    ...(protectionRoute === undefined ? {} : { protectionRoute }),
    ...(baseView?.policy === undefined ? {} : { policy: baseView.policy }),
    posture: baseView?.posture ?? status.posture,
  };
}

function clearOverlay(view: ViewModel): ViewModel {
  const { overlay: _overlay, ...rest } = view;
  void _overlay;
  return rest;
}

function withHistoricOnceApprovalReceipt(view: ViewModel, receipt: string | undefined): ViewModel {
  if (receipt === undefined) return view;
  const content = receipt
    .split(/\r?\n/u)
    .slice(0, 8)
    .map((line) => visibleTerminalText(stripControlLine(line)))
    .join("\n");
  if (
    view.items.some(
      (item) =>
        item.kind === "message" &&
        item.role === "system" &&
        item.presentation === "notice" &&
        item.content === content,
    )
  ) {
    return view;
  }
  return {
    ...view,
    items: [...view.items, { kind: "message", role: "system", content, presentation: "notice" }],
  };
}

/**
 * Drive a PERSISTENT multi-turn interactive session (Epic 1.23 — the keystone). Owns the UIPort and
 * the single shared input iterator across the whole session; runs one `runSession` per turn and,
 * crucially, **stays open after a turn completes** — rendering the idle prompt and awaiting the next
 * line — until the user exits (Ctrl-D / EOF, `/exit`, `/quit`, or an interrupt at the idle prompt; a
 * mid-turn interrupt is handled inside the turn and returns to the prompt).
 *
 * The session ledger stays the single source of truth: each turn records only its NEW user message
 * (`recordSeed`) while carrying the loop's final working set (`finalMessages`) into the next turn's
 * model context. The carry is run through `closeOpenToolCalls` so a turn interrupted mid-tool (which
 * ends on an assistant tool-call with no result) does NOT feed the next turn an invalid, provider-
 * rejecting history — mirroring the steering re-drive in `runner.ts`, and keeping the in-memory carry
 * in lockstep with what `rebuild()` reconstructs from the ledger.
 *
 * The idle prompt is rendered HERE (not inside `runSession`) so it fires AFTER the turn's input
 * consumer has stopped — otherwise a line typed the instant a turn ends would be swallowed as steering
 * for the just-finished turn instead of starting a new one. It renders FROM the turn's final view
 * (`finalView`), not a rebuild-from-messages, so the transcript + any interrupt / run-ended note
 * persist into the idle state.
 *
 * Ctrl-C at the IDLE prompt is WARN-then-exit (slice 7, the Claude/Codex idiom): the first idle Ctrl-C
 * renders a one-line hint and stays open — a multi-turn session must not be lost to one stray keypress;
 * a SECOND consecutive Ctrl-C (or `/exit`·`/quit`·Ctrl-D·EOF) exits. Any other input disarms. A
 * MID-RUN interrupt is different — `runSession` consumes it and returns to the prompt; it never reaches
 * this idle loop.
 *
 * The shared input queue tracks directly delivered values until this consumer acknowledges them. If a
 * turn ends while its pending pull wins the delivery race, detaching requeues that unacknowledged value
 * for this idle driver instead of dropping the user's line at the handoff boundary.
 */
export async function runRepl(opts: RunReplOpts): Promise<RunOutcome> {
  const {
    head = [],
    resumed = [],
    resumedInputHistory = [],
    resumedFailedToolCallIds,
    resumedFailedToolMessageIndexes,
    resumedFinalAnswerOccurrences,
    resumedFinalAnswerSettlements,
    resumedInterruptedFinalAnswerSettlementIds,
    resumedLoopVerification,
    resumedLastStop,
    resumedLastStopCode,
    resumedLastStopMessage,
    resumedSteeringApplied = 0,
    resumedUrgentSteeringApplied = 0,
    historicOnceApprovalReceipt,
    ...base
  } = opts;
  let messages: readonly ModelMessageT[] = [...head, ...resumed];
  let lastStop: StopReasonT | undefined;
  let lastStopCode: string | undefined;
  let lastStopMessage: string | undefined;
  let lastGoalFailure: GoalFailureReason | undefined;
  let firstTurn = true;
  let nextTurnPlanView: ViewConfig | undefined;
  let nextFinalAnswerContract: FinalAnswerContractT | undefined;
  const it = opts.ui.inputs()[Symbol.asyncIterator]();

  // The opening view. On RESUME (`--continue`/`--resume`), open ON the rebuilt conversation with a
  // compact "resumed N messages" header (design §2.2) — NOT the first-run welcome, which would make a
  // resumed session look brand-new + empty (end-of-epic QC must-fix). Otherwise: the first-run teaching
  // state. `idleView` is the latest idle view — transient hints (Ctrl-C warn, /context) render on top.
  let idleView: ViewModel;
  if (resumed.length > 0) {
    const resumedBase = initialView(resumed, opts.view ?? {}, {
      ...(resumedFailedToolMessageIndexes !== undefined
        ? { failedToolMessageIndexes: resumedFailedToolMessageIndexes }
        : {}),
      ...(resumedFailedToolCallIds !== undefined
        ? { failedToolCallIds: resumedFailedToolCallIds }
        : {}),
      ...(resumedFinalAnswerOccurrences !== undefined
        ? { finalAnswerOccurrences: resumedFinalAnswerOccurrences }
        : {}),
      ...(resumedFinalAnswerSettlements !== undefined
        ? { finalAnswerSettlements: resumedFinalAnswerSettlements }
        : {}),
      ...(resumedInterruptedFinalAnswerSettlementIds !== undefined
        ? { interruptedFinalAnswerSettlementIds: resumedInterruptedFinalAnswerSettlementIds }
        : {}),
      originalInspectionCommand: `keel sessions answer ${opts.store.id} --original`,
    });
    const withCompletionTruth =
      resumedLastStop === "model-stop" && stopCodeNeedsAttention(resumedLastStopCode)
        ? reduce(resumedBase, {
            type: "stop",
            reason: resumedLastStop,
            ...(resumedLastStopCode !== undefined ? { code: resumedLastStopCode } : {}),
            ...(resumedLastStopMessage !== undefined ? { message: resumedLastStopMessage } : {}),
          })
        : resumedBase;
    const rawCompletionSummary = buildTurnSummary(withCompletionTruth);
    const completionSummary =
      rawCompletionSummary === undefined || resumedLoopVerification === undefined
        ? rawCompletionSummary
        : {
            ...rawCompletionSummary,
            checked: [...rawCompletionSummary.checked, "bounded loop exit check (controller)"],
            receipt: [
              ...(rawCompletionSummary.receipt ?? []),
              `loop succeeded · evidence ${oneLineText(resumedLoopVerification.evidenceRef)}`,
            ],
          };
    const base =
      completionSummary === undefined
        ? withCompletionTruth
        : { ...withCompletionTruth, turnSummary: completionSummary };
    // Acknowledge any re-applied pending steering explicitly (ADR-0034 · P1-3) so a carried-over
    // mid-run comment is not silently folded into the message count.
    const steeringLabel = resumedSteeringLabel(
      resumedSteeringApplied,
      resumedUrgentSteeringApplied,
    );
    const steeringNote =
      resumedSteeringApplied > 0 ? ` · ${steeringLabel} re-applied · continuing now` : "";
    const header: ViewItem = {
      kind: "message",
      role: "system",
      content: `↻ resumed ${resumed.length} message${resumed.length === 1 ? "" : "s"}${steeringNote} — continue below`,
    };
    const preambleEnd = leadingSystemEnd(base.items);
    idleView = reduce(
      withHistoricOnceApprovalReceipt(
        {
          ...base,
          items: [...base.items.slice(0, preambleEnd), header, ...base.items.slice(preambleEnd)],
        },
        historicOnceApprovalReceipt,
      ),
      { type: "awaiting-input" },
    );
  } else {
    idleView = reduce(firstRunView(opts.view), { type: "awaiting-input" });
  }
  if (resumed.length > 0) seedInputHistory(opts.ui, resumedInputHistory);
  opts.ui.render(idleView);
  const disconnectOverlayDismiss = connectOverlayDismiss(opts.ui, () => {
    if (idleView.overlay === undefined) return;
    const { overlay: _overlay, exitArmed: _exitArmed, ...rest } = idleView;
    void _overlay;
    void _exitArmed;
    idleView = rest;
    opts.ui.render(idleView);
  });
  const disconnectLocalInputActivity = connectLocalInputActivity(opts.ui, () => {
    if (idleView.exitArmed !== true) return;
    const { exitArmed: _exitArmed, ...rest } = idleView;
    void _exitArmed;
    idleView = rest;
    opts.ui.render(idleView);
  });

  const renderNotice = (content: string): void => {
    idleView = reduce(idleView, { type: "system-notice", content });
    opts.ui.render(idleView);
  };

  const clearQueuedPlanApproval = (): void => {
    base.planApprovals?.clear();
    nextTurnPlanView = undefined;
  };

  const driveTurn = async (
    turnUser: ModelMessageT | undefined,
    runControl: {
      readonly goal?: NonNullable<RunSessionOpts["goal"]>;
      readonly loop?: LoopConfigT;
      readonly finalAnswer?: FinalAnswerContractT;
    } = {},
  ): Promise<void> => {
    const pendingState = rebuild(readSession(base.store.id, base.env ?? process.env));
    const pendingBeforeTurn = pendingState.pendingSteering;
    const seedPresentation = seedPresentationForTurn(pendingState, base.store.id);
    const seedPresentationOption = seedPresentation === undefined ? {} : { seedPresentation };
    const carriedUrgent = [...pendingBeforeTurn]
      .reverse()
      .find((steering) => steering.class === "urgent");
    if (pendingBeforeTurn.length > 0) {
      messages = applyPendingSteeringOnResume(base.store, pendingState);
      for (const steering of pendingBeforeTurn) {
        idleView = reduce(idleView, {
          type: "input-applied",
          class: steering.class,
          content: steering.content,
        });
      }
      opts.ui.render(idleView);
    }
    const seed = turnUser === undefined ? messages : [...messages, turnUser];
    const planView = nextTurnPlanView;
    // Record the head only on a FRESH session's first turn. A resumed session already has head +
    // history in the ledger, so even its first new turn records only its own user message; every
    // later turn likewise records just the new message.
    const recordSeed =
      turnUser === undefined
        ? []
        : firstTurn && resumed.length === 0
          ? [...head, turnUser]
          : [turnUser];

    // Carry the idle presentation state (`/quiet`·`/diff`, etc.) into the turn's ViewConfig so the
    // turn's fresh `initialView` does NOT reset it to the automatic diff default (Tier-B QC).
    const turnView: ViewConfig = {
      ...base.view,
      ...(planView ?? {}),
      ...(base.modelRouting !== undefined ? { modelRoute: base.modelRouting.status() } : {}),
      ...(idleView.density !== undefined ? { density: idleView.density } : {}),
      ...(idleView.diffMode !== undefined ? { diffMode: idleView.diffMode } : {}),
      ...(carriedUrgent !== undefined
        ? {
            urgentSteering: {
              state: "applied" as const,
              content: carriedUrgent.content,
            },
          }
        : {}),
    };
    let outcome: TurnOutcome;
    try {
      outcome =
        runControl.loop !== undefined
          ? await runBoundedLoopSession({
              ...base,
              view: turnView,
              seed,
              recordSeed,
              ownsUi: false,
              ...seedPresentationOption,
              ...(runControl.finalAnswer !== undefined
                ? { finalAnswer: { contract: runControl.finalAnswer } }
                : {}),
              loop: runControl.loop,
            })
          : await runSession({
              ...base,
              view: turnView,
              seed,
              recordSeed,
              ownsUi: false,
              ...seedPresentationOption,
              ...(runControl.finalAnswer !== undefined
                ? { finalAnswer: { contract: runControl.finalAnswer } }
                : {}),
              ...(runControl.goal !== undefined ? { goal: runControl.goal } : {}),
            });
    } finally {
      if (planView !== undefined) {
        clearQueuedPlanApproval();
      }
    }
    lastStop = outcome.lastStop; // a completed turn always carries its terminal reason (TurnOutcome)
    lastStopCode = outcome.lastStopCode;
    lastStopMessage = outcome.lastStopMessage;
    lastGoalFailure = outcome.lastGoalFailure;
    messages = closeOpenToolCalls(outcome.finalMessages);
    firstTurn = false;
    idleView = reduce(
      withHistoricOnceApprovalReceipt(
        {
          ...outcome.finalView,
          ...(nextFinalAnswerContract === undefined
            ? {}
            : { nextFinalAnswerMaxWords: nextFinalAnswerContract.maxWords }),
          status: {
            ...(planView === undefined
              ? outcome.finalView.status
              : statusAfterPlanTurn(outcome.finalView.status, base.view)),
            ...(base.modelRouting !== undefined ? { modelRoute: base.modelRouting.status() } : {}),
          },
        },
        historicOnceApprovalReceipt,
      ),
      { type: "awaiting-input" },
    );
    opts.ui.render(idleView);
  };

  try {
    // Resume dispatch contract: pending steering was already appended and marked applied in the
    // ledger before this REPL opened. Drive it now without appending a duplicate user event.
    if (resumedSteeringApplied > 0) {
      await driveTurn(undefined);
      renderNotice(
        `↻ ${resumedSteeringLabel(
          resumedSteeringApplied,
          resumedUrgentSteeringApplied,
        )} re-applied and dispatched`,
      );
    }
    for (;;) {
      const r = await it.next();
      if (r.done) break; // EOF / Ctrl-D → exit the session
      acknowledgeInput(it, r.value);
      const input: UserInput = r.value;
      if (input.kind === "interrupt") {
        if (idleView.overlay !== undefined) {
          idleView = clearOverlay(idleView);
          opts.ui.render(idleView);
          continue;
        }
        if (idleView.exitArmed === true) break; // a SECOND consecutive idle Ctrl-C exits
        idleView = {
          ...reduce(idleView, { type: "system-notice", content: CTRL_C_HINT }),
          exitArmed: true,
        };
        opts.ui.render(idleView);
        continue;
      }
      if (idleView.exitArmed === true) {
        const { exitArmed: _exitArmed, ...disarmedView } = idleView;
        void _exitArmed;
        idleView = disarmedView;
      }
      if (input.kind === "command" && EXIT_COMMANDS.has(input.name)) break; // /exit · /quit
      if (input.kind === "command") {
        const density = densityForCommand(input.name);
        if (density !== undefined) {
          idleView = reduce(idleView, { type: "density-set", density });
          idleView = reduce(idleView, { type: "system-notice", content: densityNotice(density) });
          opts.ui.render(idleView);
          continue;
        }
      }
      if (
        input.kind === "command" &&
        input.name === "/diff" &&
        input.args?.trim().toLowerCase() === "review"
      ) {
        const result = requestDiffViewer(opts.ui);
        if (result === "no-diffs") renderNotice("No settled diffs available to review.");
        else if (result === "not-settled") {
          renderNotice("Focused diff review is available after the active turn settles.");
        } else if (result === "unsupported") {
          renderNotice(
            "Focused diff review needs an interactive terminal; the bounded summary remains available above.",
          );
        }
        continue;
      }
      if (
        input.kind === "command" &&
        input.name === "/diff" &&
        (input.args?.trim().length ?? 0) > 0
      ) {
        renderNotice("usage: /diff [review]");
        continue;
      }
      if (input.kind === "command" && input.name === "/diff") {
        // Mirror the runner's mid-turn `/diff`: flip the diff disclosure level at idle too (was a
        // dead "not wired" notice before). Threaded into the next turn below so it persists (Tier-B QC).
        idleView = reduce(idleView, { type: "diff-mode-toggle" });
        idleView = reduce(idleView, {
          type: "system-notice",
          content: diffNotice(idleView.diffMode ?? "compact"),
        });
        opts.ui.render(idleView);
        continue;
      }
      if (input.kind === "command" && input.name === "/help") {
        // `/help` is a read-only idle panel: it surfaces the key reference as the `?` overlay so a
        // palette pick is never a silent no-op. The session stays open.
        idleView = { ...idleView, overlay: { kind: "help" } };
        opts.ui.render(idleView);
        continue;
      }
      if (input.kind === "command" && input.name === "/answer") {
        const parsed = answerCommand(input.args);
        if (!parsed.ok) {
          renderNotice(`/answer: ${parsed.error}`);
          continue;
        }
        if (parsed.action === "clear") {
          nextFinalAnswerContract = undefined;
          const { nextFinalAnswerMaxWords: _arm, ...cleared } = idleView;
          void _arm;
          idleView = reduce(cleared, {
            type: "system-notice",
            content: "final answer bound cleared; no next task is armed",
          });
          opts.ui.render(idleView);
          continue;
        }
        if (parsed.action === "full") {
          const original = latestFinalAnswerOriginal(
            rebuild(readSession(base.store.id, base.env ?? process.env)),
          );
          if (original === undefined) {
            renderNotice("No settled final-answer original is available in this session.");
            continue;
          }
          idleView = {
            ...idleView,
            overlay: {
              kind: "panel",
              content: `original final answer · ${base.store.id}\n\n${stripControl(original.message.content)}`,
            },
          };
          opts.ui.render(idleView);
          continue;
        }
        if (parsed.action !== "arm") continue;
        nextFinalAnswerContract = parsed.contract;
        idleView = {
          ...reduce(idleView, {
            type: "system-notice",
            content: `final answer ≤${parsed.contract.maxWords} words armed for the next ordinary task only`,
          }),
          nextFinalAnswerMaxWords: parsed.contract.maxWords,
        };
        opts.ui.render(idleView);
        continue;
      }
      if (input.kind === "command" && input.name === "/capabilities") {
        idleView = reduce(idleView, { type: "capabilities-panel" });
        opts.ui.render(idleView);
        continue;
      }
      if (input.kind === "command" && input.name === "/about") {
        idleView = reduce(idleView, { type: "about-panel" });
        opts.ui.render(idleView);
        continue;
      }
      if (input.kind === "command" && (input.name === "/policies" || input.name === "/policy")) {
        if ((input.args ?? "").trim().length > 0) {
          renderNotice(`${input.name} takes no arguments; use ${input.name} by itself.`);
          continue;
        }
        idleView = reduce(idleView, { type: "policies-panel" });
        opts.ui.render(idleView);
        continue;
      }
      if (input.kind === "command" && input.name === "/goal") {
        if (nextTurnPlanView !== undefined) {
          clearQueuedPlanApproval();
          renderNotice(
            "Plan Autopilot approval cleared; /goal cannot run under a next-task plan boundary. Re-approve exact resources for a plain task line.",
          );
          continue;
        }
        const parsed = parseGoalArgs(input.args ?? "");
        if (!parsed.success) {
          renderNotice(`/goal: ${parsed.error}`);
          continue;
        }
        // Steer read-only predicates to the right tool BEFORE spending a turn (F-3 UX): `/goal --check`
        // requires an executable proof (a test/build that runs the deliverable) and REJECTS read-only
        // evidence (ADR-0060), so a goal whose command checks are all read-only (`test -f X`, `ls`)
        // can never satisfy any criterion. Refuse it with a steer to `/loop --until` (the exit-code
        // predicate) instead of spending a turn that cannot complete. A goal with any executable check
        // still runs; its read-only checks surface the same steer in the completion receipt.
        const commandChecks = parsed.goal.doneWhen.filter(
          (criterion) => criterion.kind === "command" && criterion.check.argv !== undefined,
        );
        const allChecksReadOnly =
          commandChecks.length > 0 &&
          commandChecks.every(
            (criterion) =>
              criterion.kind === "command" &&
              criterion.check.argv !== undefined &&
              isReadOnlyCommand(shellJoin(criterion.check.argv)),
          );
        if (allChecksReadOnly) {
          renderNotice(
            "/goal --check needs an executable proof (a test/build) and cannot verify a read-only " +
              "check. For an exit-code predicate like `test -f …`, use /loop --until instead.",
          );
          continue;
        }
        await driveTurn({ role: "user", content: goalPrompt(parsed.goal) }, { goal: parsed.goal });
        continue;
      }
      if (input.kind === "command" && input.name === "/loop") {
        if (nextTurnPlanView !== undefined) {
          clearQueuedPlanApproval();
          renderNotice(
            "Plan Autopilot approval cleared; /loop cannot run under a next-task plan boundary. Re-approve exact resources for a plain task line.",
          );
          continue;
        }
        const parsed = parseLoopArgs(input.args ?? "");
        if (!parsed.success) {
          renderNotice(`/loop: ${parsed.error}`);
          continue;
        }
        await driveTurn({ role: "user", content: parsed.loop.prompt }, { loop: parsed.loop });
        continue;
      }
      if (input.kind === "command" && input.name === "/context") {
        idleView = reduce(idleView, { type: "context-panel" });
        opts.ui.render(idleView);
        continue;
      }
      if (input.kind === "command" && input.name === "/model") {
        const arg = input.args?.trim();
        const variant = arg === "preview" ? "preview" : arg === "why" ? "why" : "status";
        const preview = variant === "preview" ? base.modelRouting?.preview() : undefined;
        const status =
          preview !== undefined
            ? modelRouteStatusFromDecision(preview)
            : base.modelRouting?.status();
        idleView = reduce(
          {
            ...idleView,
            status: {
              ...idleView.status,
              ...(status !== undefined ? { modelRoute: status } : {}),
            },
          },
          {
            type: "model-panel",
            content: modelPanel(
              { ...idleView.status, ...(status !== undefined ? { modelRoute: status } : {}) },
              variant,
            ),
          },
        );
        opts.ui.render(idleView);
        continue;
      }
      if (input.kind === "command" && input.name === "/compact") {
        idleView = reduce(idleView, { type: "compact-review" });
        opts.ui.render(idleView);
        continue;
      }
      if (input.kind === "command" && input.name === "/reviews") {
        idleView = reduce(idleView, { type: "review-queue-panel" });
        opts.ui.render(idleView);
        continue;
      }
      if (input.kind === "command" && input.name === "/plan") {
        const parsed = planCommandArgs(input.args);
        if (!parsed.ok) {
          renderNotice(`/plan: ${parsed.error}`);
          continue;
        }
        if (base.planApprovals === undefined) {
          renderNotice(
            "/plan requires a live governed warden session; use keel run -p --plan-confirm for headless exact-resource Plan Autopilot",
          );
          continue;
        }
        if (parsed.action === "clear") {
          clearQueuedPlanApproval();
          renderNotice("Plan Autopilot approval cleared; no plan boundary is queued");
          continue;
        }
        const result =
          parsed.action === "preview"
            ? base.planApprovals.preview(parsed.args)
            : base.planApprovals.approve(parsed.args);
        if (parsed.action === "approve") {
          if (result.ok && result.view !== undefined) {
            nextTurnPlanView = result.view;
          } else {
            clearQueuedPlanApproval();
            renderNotice(
              result.ok
                ? "Plan Autopilot approval was not activated: no status view was returned"
                : result.output,
            );
            continue;
          }
        }
        renderNotice(result.output);
        continue;
      }
      if (input.kind === "command") {
        idleView = reduce(idleView, {
          type: "system-notice",
          content: noticeForCommand(input.name),
        });
        opts.ui.render(idleView);
        continue;
      }
      if (input.kind !== "line") continue;
      const launchNotice = keelLaunchCommandNotice(input.text);
      if (launchNotice !== undefined) {
        renderNotice(launchNotice);
        continue;
      }
      if (isCapabilityPrompt(input.text)) {
        idleView = reduce(idleView, { type: "capabilities-panel", prompt: input.text });
        opts.ui.render(idleView);
        continue;
      }
      const finalAnswer = nextFinalAnswerContract;
      nextFinalAnswerContract = undefined;
      if (idleView.nextFinalAnswerMaxWords !== undefined) {
        const { nextFinalAnswerMaxWords: _consumedArm, ...consumedView } = idleView;
        void _consumedArm;
        idleView = consumedView;
      }
      await driveTurn(
        { role: "user", content: input.text },
        finalAnswer === undefined ? {} : { finalAnswer },
      );
    }
  } finally {
    try {
      disconnectOverlayDismiss();
      disconnectLocalInputActivity();
    } finally {
      await opts.ui.close();
    }
  }
  return {
    ...(lastStop !== undefined ? { lastStop } : {}),
    ...(lastStopCode !== undefined ? { lastStopCode } : {}),
    ...(lastStopMessage !== undefined ? { lastStopMessage } : {}),
    ...(lastGoalFailure !== undefined ? { lastGoalFailure } : {}),
  };
}

function acknowledgeInput(it: AsyncIterator<UserInput>, input: UserInput): void {
  (it as { acknowledge?: (value: UserInput) => void }).acknowledge?.(input);
}

/** The idle-prompt Ctrl-C confirmation (slice 7) — one calm line; a second Ctrl-C then exits. */
const CTRL_C_HINT = "↩ press Ctrl-C again — or /exit — to quit";

function keelLaunchCommandNotice(raw: string): string | undefined {
  let words: string[];
  try {
    words = shellWords(raw);
  } catch {
    return undefined;
  }
  if (words.length === 0) return undefined;

  let index = words[0] === "env" ? 1 : 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index++;

  const command = words[index];
  let rest: readonly string[];
  if (command === "pnpm" && words[index + 1] === "keel") {
    rest = words.slice(index + 2);
  } else if (command === "keel") {
    rest = words.slice(index + 1);
  } else {
    return undefined;
  }

  if (!rest.every((arg) => arg === "--trust" || arg === "--autopilot")) return undefined;
  const line = oneLineText(raw);
  const preview = line.length <= 120 ? line : `${line.slice(0, 117).trimEnd()}...`;
  return `That looks like a shell command to launch keel, and you are already inside keel. Type /exit, then run it in your terminal: ${preview}`;
}

const CAPABILITY_PROMPTS: ReadonlySet<string> = new Set([
  "help",
  "how do i use this",
  "what can i do",
  "what can you do",
  "what can you help with",
  "what do you do",
]);

function isCapabilityPrompt(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[?!.\s]+$/u, "")
    .replace(/\s+/gu, " ");
  return CAPABILITY_PROMPTS.has(normalized);
}
