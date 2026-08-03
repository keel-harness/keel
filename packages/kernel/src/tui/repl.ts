import type {
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
import { closeOpenToolCalls } from "../session/resume.js";
import { firstRunView, initialView, leadingSystemEnd, modelPanel, reduce } from "./view-model.js";
import type { ViewConfig } from "./view-model.js";
import { goalPrompt } from "../run/goal-session.js";
import { runBoundedLoopSession } from "../run/loop-session.js";
import { parseGoalArgs, parseLoopArgs, shellJoin, shellWords } from "../run/run-control-parser.js";
import { isReadOnlyCommand } from "../verify-gate.js";
import { modelRouteStatusFromDecision } from "../model-routing/controller.js";
import { oneLineText, stripControlLine } from "../control-strip.js";
import { connectOverlayDismiss } from "./overlay-dismiss.js";
import { connectLocalInputActivity } from "./input-activity.js";
import { requestDiffViewer } from "./diff-viewer-control.js";
import { visibleTerminalText } from "./visible-text.js";
import { seedInputHistory } from "./input-history.js";

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
  /** How many still-pending steering inputs (queued/urgent) were re-applied while rebuilding the
   *  resumed context (P1-3). Surfaced in the resume header so the carry-over is acknowledged, not
   *  silently folded into the message count (ADR-0034 "visibly acknowledge · no silent absorption").
   *  The applied inputs already ride `resumed` as `user` messages; this is the honest cue. */
  readonly resumedSteeringApplied?: number;
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
    resumedSteeringApplied = 0,
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
  const it = opts.ui.inputs()[Symbol.asyncIterator]();

  // The opening view. On RESUME (`--continue`/`--resume`), open ON the rebuilt conversation with a
  // compact "resumed N messages" header (design §2.2) — NOT the first-run welcome, which would make a
  // resumed session look brand-new + empty (end-of-epic QC must-fix). Otherwise: the first-run teaching
  // state. `idleView` is the latest idle view — transient hints (Ctrl-C warn, /context) render on top.
  let idleView: ViewModel;
  if (resumed.length > 0) {
    const base = initialView(resumed, opts.view ?? {}, {
      ...(resumedFailedToolMessageIndexes !== undefined
        ? { failedToolMessageIndexes: resumedFailedToolMessageIndexes }
        : {}),
      ...(resumedFailedToolCallIds !== undefined
        ? { failedToolCallIds: resumedFailedToolCallIds }
        : {}),
    });
    // Acknowledge any re-applied pending steering explicitly (ADR-0034 · P1-3) so a carried-over
    // mid-run comment is not silently folded into the message count.
    const steeringNote =
      resumedSteeringApplied > 0
        ? ` · ${resumedSteeringApplied} pending comment${resumedSteeringApplied === 1 ? "" : "s"} re-applied · continuing now`
        : "";
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
    } = {},
  ): Promise<void> => {
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
              loop: runControl.loop,
            })
          : await runSession({
              ...base,
              view: turnView,
              seed,
              recordSeed,
              ownsUi: false,
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
        `↻ ${resumedSteeringApplied} pending comment${resumedSteeringApplied === 1 ? "" : "s"} re-applied and dispatched`,
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
      await driveTurn({ role: "user", content: input.text });
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
