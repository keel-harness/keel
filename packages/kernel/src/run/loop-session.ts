import type {
  ExecutorPort,
  LoopConfigT,
  ModelMessageT,
  ModelPort,
  SessionEventT,
  ToolInvocationT,
  UIPort,
  ViewModel,
} from "@keel/shared";
import { RUN_CONTROL_SCHEMA_VERSION } from "@keel/shared";
import { readSession } from "../session/store.js";
import type { SessionStore } from "../session/store.js";
import { closeOpenToolCalls } from "../session/resume.js";
import { commandResultIndicatesFailure } from "../context/derive.js";
import { reduce } from "../tui/view-model.js";
import { createAgentLoopControlState } from "../loop.js";
import { runSessionWithControlState } from "../tui/runner.js";
import type { RunSessionOpts, TurnOutcome } from "../tui/runner.js";
import { shellJoin } from "./run-control-parser.js";
import { toolPresentationOutcome } from "../tool-presentation-outcome.js";
import { stripControlLine } from "../control-strip.js";
import { terminalDisplayWidth } from "../tui/row-budget.js";
import {
  shouldPreserveStopDetailAfterLoopStopped,
  stopCodeNeedsAttention,
  stopReasonForLoopStopped,
} from "../events.js";
import { loopContinuationMessage } from "./loop-continuation.js";

const EXIT_CODE_RE = /^\[exit code: ([1-9]\d*)\]$/m;
const FAIL_RE = /^TEST SUMMARY \([^)]+\): FAIL/m;
const RECEIPT_LINE_WIDTH = 72;
const receiptGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function boundedReceiptLine(value: string, maxWidth = RECEIPT_LINE_WIDTH): string {
  const normalized = stripControlLine(value).trim().replace(/\s+/gu, " ");
  if (terminalDisplayWidth(normalized) <= maxWidth) return normalized;
  if (maxWidth <= 1) return "…".slice(0, maxWidth);
  const limit = maxWidth - 1;
  let output = "";
  let width = 0;
  for (const { segment } of receiptGraphemes.segment(normalized)) {
    const next = terminalDisplayWidth(segment);
    if (width + next > limit) break;
    output += segment;
    width += next;
  }
  return `${output.trimEnd()}…`;
}

function evidenceSummary(refs: readonly string[]): string {
  if (refs.length === 0) return "none";
  if (refs.length === 1) return `1 ref · ${boundedReceiptLine(refs[0]!, 48)}`;
  const first = boundedReceiptLine(refs[0]!, 18);
  const last = boundedReceiptLine(refs[refs.length - 1]!, 18);
  return `${String(refs.length)} refs · first ${first} · last ${last}`;
}

export interface BoundedLoopSessionOpts extends Omit<RunSessionOpts, "ownsUi" | "seed"> {
  readonly model: ModelPort;
  readonly executor: ExecutorPort;
  readonly ui: UIPort;
  readonly store: SessionStore;
  readonly seed: readonly ModelMessageT[];
  readonly loop: LoopConfigT;
  readonly ownsUi?: boolean;
}

function append(store: SessionStore, event: SessionEventT): void {
  store.append(event);
}

function now(): string {
  return new Date().toISOString();
}

/**
 * The governed bash result envelope (`{exitCode, signal, …}`), extracted from a warden-rendered
 * output that may carry one or more guidance headers before the body (`header\n\nbody` — a `warn`
 * or `modify` verdict, or an untrusted marker). Returns `undefined` when no envelope is present,
 * i.e. the legacy plain-text local-executor shape.
 */
function governedCommandEnvelope(
  output: string,
): { readonly exitCode: unknown; readonly signal: unknown } | undefined {
  const candidates = [output];
  for (
    let index = output.indexOf("\n\n");
    index !== -1;
    index = output.indexOf("\n\n", index + 1)
  ) {
    candidates.push(output.slice(index + 2));
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && "exitCode" in parsed) {
        return parsed as { readonly exitCode: unknown; readonly signal: unknown };
      }
    } catch {
      // Not this slice — try the next boundary.
    }
  }
  return undefined;
}

/**
 * Did the loop's exit-check command PROVE success?
 *
 * This is deliberately positive proof, not "absence of failure evidence". The governed envelope is
 * parsed structurally (past any warden guidance header) and must show `exitCode === 0` with no
 * signal; an envelope we cannot read fails CLOSED. Previously this asked only "does anything look
 * like a failure?", so a header that broke `JSON.parse` made a red check read as green — declaring
 * a bounded loop successful on failing tests (AGENTS.md "No hidden green").
 *
 * The legacy plain-text shape (local executor, no envelope) keeps its marker heuristic unchanged.
 */
function exitCheckPassed(output: string, ok: boolean): boolean {
  if (FAIL_RE.test(output) || EXIT_CODE_RE.test(output)) return false;
  const envelope = governedCommandEnvelope(output);
  if (envelope !== undefined) {
    return envelope.exitCode === 0 && (envelope.signal === undefined || envelope.signal === null);
  }
  return !commandResultIndicatesFailure(output, !ok);
}

function untilArgv(loop: LoopConfigT): readonly string[] {
  const argv = loop.until.check.argv;
  if (argv === undefined) {
    throw new Error("runnable loop lifecycle-action checks are not wired yet");
  }
  return argv;
}

function stopReasonFromTurn(
  outcome: TurnOutcome,
): "loop-no-progress" | "loop-budget" | "loop-deadline" | "error" | undefined {
  if (outcome.lastStop === "loop-detected") return "loop-no-progress";
  if (outcome.lastStop === "budget" || outcome.lastStop === "max-turns") return "loop-budget";
  if (outcome.lastStop === "deadline") return "loop-deadline";
  if (outcome.lastStop === "error") return "error";
  if (stopCodeNeedsAttention(outcome.lastStopCode)) return "error";
  return undefined;
}

function renderReceipt(ui: UIPort, view: ViewModel, content: string): ViewModel {
  const current = view.turnSummary ?? {
    title: "done" as const,
    changed: [],
    checked: [],
    attention: [],
  };
  const successful = content.startsWith("loop succeeded");
  const next = reduce(view, {
    type: "turn-finalized",
    summary: {
      ...current,
      title: successful ? current.title : "needs attention",
      receipt: content.split("\n"),
    },
  });
  ui.render(next);
  return next;
}

function withLoopStoppedOutcome(
  latest: TurnOutcome,
  reason: Parameters<typeof stopReasonForLoopStopped>[0],
  finalView: ViewModel,
): TurnOutcome {
  const loopStop = stopReasonForLoopStopped(reason);
  if (loopStop === undefined) return { ...latest, finalView };
  if (
    shouldPreserveStopDetailAfterLoopStopped({
      loopStop,
      lastStop: latest.lastStop,
      lastStopCode: latest.lastStopCode,
    })
  ) {
    return { ...latest, finalView };
  }
  const next = { ...latest, lastStop: loopStop, finalView };
  delete next.lastStopCode;
  delete next.lastStopMessage;
  return next;
}

type ExitCheckResult =
  | {
      readonly kind: "executed";
      readonly passed: boolean;
      readonly command: string;
      readonly result: string;
      readonly ref: string;
    }
  | {
      readonly kind: "not-executed";
      readonly command: string;
      readonly disposition: "not-executed" | "unknown";
      readonly reason: string;
      readonly next: string;
      readonly ref: string;
    };

function exitCheckNonExecution(result: {
  readonly output: string;
}): Pick<
  Extract<ExitCheckResult, { readonly kind: "not-executed" }>,
  "disposition" | "reason" | "next"
> {
  const outcome = toolPresentationOutcome(result);
  if (
    outcome === "review" ||
    /review required|requires approval|needs approval/iu.test(result.output)
  ) {
    const onceOnly = /once-only|workspace deletion requires exact/iu.test(result.output);
    return {
      disposition: "not-executed",
      reason: "review required",
      next: onceOnly
        ? "choose a non-reviewing predicate; once-only checks cannot repeat"
        : "run the check directly; if session approval is offered, grant it before rerunning /loop",
    };
  }
  if (outcome === "blocked" || /blocked by (?:the )?warden|policy denial/iu.test(result.output)) {
    return {
      disposition: "not-executed",
      reason: "blocked by policy",
      next: "change the check or policy boundary before rerunning /loop",
    };
  }
  if (outcome === "stopped" || /\babort(?:ed)?\b|\binterrupt(?:ed)?\b/iu.test(result.output)) {
    return {
      disposition: "unknown",
      reason: "interrupted; completion unknown",
      next: "inspect the session audit before deciding whether to retry",
    };
  }
  return {
    disposition: "unknown",
    reason: "control result unknown; the check may have executed",
    next: "inspect the session audit before deciding whether to retry",
  };
}

function executedResult(output: string, passed: boolean): string {
  try {
    const parsed = JSON.parse(output) as { readonly exitCode?: unknown };
    if (Number.isInteger(parsed.exitCode)) return `exit ${String(parsed.exitCode)}`;
  } catch {
    // Some executors return a human-readable governed result instead of JSON.
  }
  return passed ? "passed" : "failed";
}

export function loopReceipt(options: {
  readonly outcome: string;
  readonly command: string;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly execution: string;
  readonly result: string;
  readonly evidenceRefs: readonly string[];
  readonly next: string;
}): string {
  return [
    boundedReceiptLine(options.outcome),
    boundedReceiptLine(`check · ${options.command}`),
    boundedReceiptLine(
      `iterations · ${String(options.iteration)}/${String(options.maxIterations)}`,
    ),
    boundedReceiptLine(`result · ${options.execution} · ${options.result}`),
    boundedReceiptLine(`evidence · ${evidenceSummary(options.evidenceRefs)}`),
    boundedReceiptLine(`next · ${options.next}`),
  ].join("\n");
}

async function runExitCheck(options: {
  readonly executor: ExecutorPort;
  readonly store: SessionStore;
  readonly loop: LoopConfigT;
  readonly iteration: number;
  readonly signal?: AbortSignal;
}): Promise<ExitCheckResult> {
  const command = shellJoin(untilArgv(options.loop));
  const id = `${options.loop.id}_exit_${String(options.iteration)}`;
  const call: ToolInvocationT = { id, name: "bash", args: { command } };
  // Exit checks run after the interactive turn runner (and its approval controller) has detached.
  // Existing exact grants may still resolve inside the executor, but a fresh review must return as a
  // terminal not-executed result instead of opening an invisible prompt and hanging the bounded loop.
  const result = await options.executor.execute(call, {
    approvalMode: "terminal",
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  append(options.store, {
    type: "tool_result",
    v: 1,
    ts: now(),
    toolCallId: id,
    name: "bash",
    output: result.output,
    ...(result.ok ? {} : { isError: true }),
  });
  const ref = `tool_result:${id}`;
  if (!result.ok) {
    return { kind: "not-executed", command, ...exitCheckNonExecution(result), ref };
  }
  const passed = exitCheckPassed(result.output, true);
  return { kind: "executed", passed, command, result: executedResult(result.output, passed), ref };
}

export async function runBoundedLoopSession(opts: BoundedLoopSessionOpts): Promise<TurnOutcome> {
  if (opts.loop.schemaVersion !== RUN_CONTROL_SCHEMA_VERSION) {
    throw new Error("unsupported loop schema version");
  }
  if (opts.loop.effects !== undefined) {
    throw new Error("runnable loop effect envelopes require warden profile narrowing support");
  }

  const startedMonotonic = performance.now();
  const startedWall = Date.now();
  const physicalWallBounds = [opts.loop.bounds.maxWallMs, opts.stop?.maxWallMs].filter(
    (bound): bound is number => bound !== undefined,
  );
  const physicalMaxWallMs =
    physicalWallBounds.length === 0 ? undefined : Math.min(...physicalWallBounds);
  const physicalElapsedMs = (): number =>
    Math.max(
      Math.max(0, performance.now() - startedMonotonic),
      Math.max(0, Date.now() - startedWall),
    );
  const remainingWallMs = (): number | undefined =>
    physicalMaxWallMs === undefined ? undefined : physicalMaxWallMs - physicalElapsedMs();
  const wallDeadlineHit = (): boolean => {
    const remaining = remainingWallMs();
    return remaining !== undefined && remaining <= 0;
  };
  let messages: readonly ModelMessageT[] = opts.seed;
  let recordSeed: readonly ModelMessageT[] = opts.recordSeed ?? opts.seed;
  let latest: TurnOutcome | undefined;
  let evidenceRefs: string[] = [];
  const controlState = createAgentLoopControlState();
  controlState.startMs = startedMonotonic;
  controlState.wallStartMs = startedWall;
  const effectiveStop =
    physicalMaxWallMs === undefined
      ? opts.stop
      : { ...(opts.stop ?? {}), maxWallMs: physicalMaxWallMs };

  const finishAtDeadline = (
    outcome: TurnOutcome,
    iteration: number,
    check?: ExitCheckResult,
  ): TurnOutcome => {
    append(opts.store, {
      type: "loop_stopped",
      v: 1,
      ts: now(),
      loopId: opts.loop.id,
      reason: "loop-deadline",
      iterations: iteration,
      evidenceRefs,
    });
    const execution =
      check === undefined ? "not run" : check.kind === "executed" ? "executed" : "outcome unknown";
    const result =
      check === undefined
        ? "hard deadline reached before exit check"
        : check.kind === "executed"
          ? check.result
          : "hard deadline reached while exit check was in flight";
    const finalView = renderReceipt(
      opts.ui,
      outcome.finalView,
      loopReceipt({
        outcome: "loop stopped · loop-deadline",
        command: check?.command ?? shellJoin(untilArgv(opts.loop)),
        iteration,
        maxIterations: opts.loop.bounds.maxIterations,
        execution,
        result,
        evidenceRefs,
        next: "raise the explicit bound only after reviewing deadline evidence",
      }),
    );
    return withLoopStoppedOutcome(outcome, "loop-deadline", finalView);
  };

  try {
    for (let iteration = 1; iteration <= opts.loop.bounds.maxIterations; iteration++) {
      append(opts.store, {
        type: "loop_iteration",
        v: 1,
        ts: now(),
        loopId: opts.loop.id,
        iteration,
        status: "running",
        evidenceRefs: [],
      });

      latest = await runSessionWithControlState(
        {
          ...opts,
          seed: messages,
          recordSeed,
          ownsUi: false,
          ...(effectiveStop !== undefined ? { stop: effectiveStop } : {}),
        },
        controlState,
      );

      const structuralStop = stopReasonFromTurn(latest);
      if (structuralStop !== undefined) {
        if (latest.lastStop === "deadline") return finishAtDeadline(latest, iteration);
        append(opts.store, {
          type: "loop_stopped",
          v: 1,
          ts: now(),
          loopId: opts.loop.id,
          reason: structuralStop,
          iterations: iteration,
          evidenceRefs,
        });
        const finalView = renderReceipt(
          opts.ui,
          latest.finalView,
          loopReceipt({
            outcome: `loop stopped · ${structuralStop}`,
            command: shellJoin(untilArgv(opts.loop)),
            iteration,
            maxIterations: opts.loop.bounds.maxIterations,
            execution: "not run",
            result:
              latest.lastStop === "max-turns"
                ? "model-turn bound exhausted before exit check"
                : "model turn stopped before exit check",
            evidenceRefs,
            next:
              latest.lastStop === "max-turns"
                ? "raise model-turn bound only after reviewing prior evidence"
                : "address the stop reason before rerunning /loop",
          }),
        );
        return withLoopStoppedOutcome(latest, structuralStop, finalView);
      }

      const remaining = remainingWallMs();
      if (remaining !== undefined && remaining <= 0) {
        return finishAtDeadline(latest, iteration);
      }
      const checkDeadline = remaining === undefined ? undefined : new AbortController();
      const checkTimer =
        checkDeadline === undefined || remaining === undefined
          ? undefined
          : setTimeout(
              () => checkDeadline.abort(),
              Math.min(Math.max(0, remaining), 2_147_483_647),
            );
      checkTimer?.unref?.();
      let check: ExitCheckResult;
      try {
        check = await runExitCheck({
          executor: opts.executor,
          store: opts.store,
          loop: opts.loop,
          iteration,
          ...(checkDeadline !== undefined ? { signal: checkDeadline.signal } : {}),
        });
      } finally {
        if (checkTimer !== undefined) clearTimeout(checkTimer);
      }
      evidenceRefs = [...evidenceRefs, check.ref];
      if (check.kind === "not-executed") {
        append(opts.store, {
          type: "loop_stopped",
          v: 1,
          ts: now(),
          loopId: opts.loop.id,
          reason: "error",
          iterations: iteration,
          evidenceRefs,
        });
        const finalView = renderReceipt(
          opts.ui,
          latest.finalView,
          loopReceipt({
            outcome: `loop stopped · ${check.reason}`,
            command: check.command,
            iteration,
            maxIterations: opts.loop.bounds.maxIterations,
            execution: check.disposition === "not-executed" ? "not executed" : "outcome unknown",
            result: check.reason,
            evidenceRefs,
            next: check.next,
          }),
        );
        return withLoopStoppedOutcome(latest, "error", finalView);
      }
      if (wallDeadlineHit()) return finishAtDeadline(latest, iteration, check);
      append(opts.store, {
        type: "loop_iteration",
        v: 1,
        ts: now(),
        loopId: opts.loop.id,
        iteration,
        status: check.passed ? "exit-check-passed" : "exit-check-failed",
        evidenceRefs: [check.ref],
      });

      if (check.passed) {
        append(opts.store, {
          type: "loop_stopped",
          v: 1,
          ts: now(),
          loopId: opts.loop.id,
          reason: "succeeded",
          iterations: iteration,
          evidenceRefs,
        });
        const finalView = renderReceipt(
          opts.ui,
          latest.finalView,
          loopReceipt({
            outcome: "loop succeeded",
            command: check.command,
            iteration,
            maxIterations: opts.loop.bounds.maxIterations,
            execution: "executed",
            result: check.result,
            evidenceRefs,
            next: "bounded loop complete",
          }),
        );
        return withLoopStoppedOutcome(latest, "succeeded", finalView);
      }

      const controllerPrompt = loopContinuationMessage(iteration + 1);
      messages = [...closeOpenToolCalls(latest.finalMessages), controllerPrompt];
      // The existing structured `loop_iteration(exit-check-failed)` followed by the next
      // `loop_iteration(running)` durably reconstructs this controller-owned transport message.
      // Recording it as an ordinary user event would falsely attribute it to the human; recording it
      // as system recreates the Anthropic-invalid history this path is repairing.
      recordSeed = [];
    }

    if (latest === undefined) throw new Error("loop did not run any iterations");
    append(opts.store, {
      type: "loop_stopped",
      v: 1,
      ts: now(),
      loopId: opts.loop.id,
      reason: "loop-max-iterations",
      iterations: opts.loop.bounds.maxIterations,
      evidenceRefs,
    });
    const finalView = renderReceipt(
      opts.ui,
      latest.finalView,
      loopReceipt({
        outcome: "loop stopped · loop-max-iterations",
        command: shellJoin(untilArgv(opts.loop)),
        iteration: opts.loop.bounds.maxIterations,
        maxIterations: opts.loop.bounds.maxIterations,
        execution: "executed",
        result: "exit check still failed",
        evidenceRefs,
        next: "review failed-check evidence before starting a new bounded loop",
      }),
    );
    return withLoopStoppedOutcome(latest, "loop-max-iterations", finalView);
  } finally {
    if (opts.ownsUi ?? true) await opts.ui.close();
    // Force schema validation while the store is still open; this catches malformed metadata in tests
    // and keeps the raw ledger the source of truth for loop receipts.
    readSession(opts.store.id, opts.env);
  }
}
