import type {
  FinalAnswerOccurrenceT,
  FinalAnswerSettlementT,
  ModelMessageT,
  ModelUsageT,
  SteeringEventT,
  StopReasonT,
} from "@keel/shared";
import {
  shouldPreserveStopDetailAfterLoopStopped,
  stopCodeNeedsAttention,
  stopReasonForLoopStopped,
} from "../events.js";
import { loopContinuationMessage } from "../run/loop-continuation.js";
import type { SessionFile, SessionStore } from "./store.js";
import { applySteering } from "./steering.js";

/** Synthetic content for a tool call that never completed (run aborted / crashed mid-turn).
 *  Re-fed to the model on resume so the assistant→tool-result linkage stays valid. */
export const INTERRUPTED_TOOL_RESULT =
  "[interrupted: the tool did not complete before the session ended]";
/** Process-local closure for an exactly tagged durable rewrite prompt whose provider response was
 * never recorded (ADR-0087). It is not provider output and is never appended to the ledger. */
export const INTERRUPTED_FINAL_ANSWER_REWRITE = "[interrupted: final-answer rewrite interrupted]";

/**
 * The resumable view of a session, rebuilt from the ledger (the inverse of the
 * recorder's fold, design §7). `messages` is the `AgentLoopInput.messages` shape a
 * fresh `runAgentLoop` can continue from. `usage` derives only from `run_status`; terminal state is
 * folded in ledger order so any later goal failure can supersede the loop's earlier model stop
 * without inventing another usage run. `pendingSteering` holds still-pending mid-run inputs.
 */
export interface ResumeState {
  readonly messages: ModelMessageT[];
  /** Ordinary human turn-opening prompts in durable order. This is presentation input only: the Ink
   * composer applies its own control/redaction/bound normalization before enabling recall. */
  readonly inputHistory: readonly string[];
  /** Tool-result identities whose durable ledger event recorded `isError:true`. Kept parallel to
   *  provider messages because `ModelMessage` is a frozen provider contract with no presentation
   *  status field; the TUI uses this internal metadata to avoid repainting denials as successes. */
  readonly failedToolCallIds: ReadonlySet<string>;
  /** Exact indexes in `messages` whose tool results failed. Unlike provider call ids, indexes remain
   * unique when a provider reuses an id in a later turn. */
  readonly failedToolMessageIndexes: ReadonlySet<number>;
  /** Presentation-only occurrence tags parallel to provider messages. These tags are never sent to
   * the provider; the messages themselves retain their exact bytes and roles. */
  readonly finalAnswerOccurrences: ReadonlyMap<number, FinalAnswerOccurrenceT>;
  readonly finalAnswerSettlements: ReadonlyMap<string, FinalAnswerSettlementT>;
  /** Settlements with a durable attempt/prompt but no matching terminal settlement record. */
  readonly interruptedFinalAnswerSettlementIds: ReadonlySet<string>;
  readonly pendingSteering: readonly SteeringEventT[];
  readonly finished: boolean;
  readonly lastStop?: StopReasonT;
  readonly lastStopCode?: string;
  readonly lastStopMessage?: string;
  readonly lastGoalFailure?: "incomplete" | "unverified" | "aborted" | "error";
  readonly usage?: ModelUsageT;
}

/**
 * Make an in-memory working set valid provider history by appending a synthetic
 * `INTERRUPTED_TOOL_RESULT` for any assistant tool call that has no matching tool result — the
 * flat-list analogue of `rebuild`'s `closeOpen`. Used by the runner's steering re-drive (Epic 1.6c
 * PR-d slice 4 / 4b) to continue from the loop's FINAL (possibly compacted) messages instead of
 * rebuilding from the full ledger — so an in-loop compaction is not discarded and re-folded each
 * steering cycle (the full history stays canonical in the ledger; SEC-023). In a well-formed loop the
 * only open calls are the trailing aborted turn, so synthetic results normally append at the end.
 * Matching is occurrence-ordered rather than set-based because providers may reuse an id in a later
 * turn. Pure: returns a new array, never mutates the input.
 */
export function closeOpenToolCalls(messages: readonly ModelMessageT[]): ModelMessageT[] {
  const output: ModelMessageT[] = [];
  let open: { readonly id: string; readonly name: string }[] = [];
  const closeOpen = (): void => {
    output.push(
      ...open.map(
        (call): ModelMessageT => ({
          role: "tool",
          content: INTERRUPTED_TOOL_RESULT,
          toolCallId: call.id,
          name: call.name,
        }),
      ),
    );
    open = [];
  };

  for (const message of messages) {
    if (message.role === "assistant") {
      closeOpen();
      output.push(message);
      open = (message.toolCalls ?? []).map((call) => ({ id: call.id, name: call.name }));
      continue;
    }
    if (message.role === "tool") {
      output.push(message);
      const matching = open.findIndex((call) => call.id === message.toolCallId);
      if (matching >= 0) open.splice(matching, 1);
      continue;
    }
    closeOpen();
    output.push(message);
  }
  closeOpen();
  return output;
}

/**
 * Rebuild the model-context view from a parsed ledger. Message-bearing events map back to
 * `ModelMessage`s in order; metadata events update run state. To guarantee VALID resumed
 * history regardless of how the ledger ended (abort mid-turn, crash, truncation), every
 * assistant tool call must have a matching tool message — an unmatched one (ER-012) gets a
 * synthetic interrupted result before the next message and at end-of-history.
 */
export function rebuild(file: SessionFile): ResumeState {
  const messages: ModelMessageT[] = [];
  const inputHistory: string[] = [];
  const failedToolCallIds = new Set<string>();
  const failedToolMessageIndexes = new Set<number>();
  const finalAnswerOccurrences = new Map<number, FinalAnswerOccurrenceT>();
  const finalAnswerSettlements = new Map<string, FinalAnswerSettlementT>();
  const interruptedFinalAnswerSettlementIds = new Set<string>();
  const observedFinalAnswerSettlementIds = new Set<string>();
  // §4.10: a steering input may be recorded PENDING then later superseded by an APPLIED marker
  // (slice 7) carrying the same inputId. Track the LAST event per inputId so an applied marker
  // overrides its pending event; the injected message itself rides a separate `user` event (the
  // applied marker is metadata only, never a conversation message). Insertion order preserved.
  const steeringById = new Map<string, SteeringEventT>();
  const steeringMessagesByIndex = new Map<number, Set<string>>();
  const failedLoopIterationById = new Map<string, number>();
  let expectedLegacyLoopController: string | undefined;
  let lastStop: StopReasonT | undefined;
  let lastStopCode: string | undefined;
  let lastStopMessage: string | undefined;
  let lastGoalFailure: "incomplete" | "unverified" | "aborted" | "error" | undefined;
  let usage: ModelUsageT | undefined;
  // A real typed prompt opens each durable run. User-role messages later in that run are controller
  // continuations, verification nudges, budget notices, loop guidance, or structured steering—not
  // composer history. `run_status` is the durable boundary that makes the next user event eligible.
  let awaitingHumanPrompt = true;
  let openFinalAnswerRewritePrompt: string | undefined;

  // The current assistant's tool calls not yet matched by a tool_result.
  let open: { id: string; name: string }[] = [];
  const closeOpen = (): void => {
    for (const c of open) {
      failedToolMessageIndexes.add(messages.length);
      messages.push({
        role: "tool",
        content: INTERRUPTED_TOOL_RESULT,
        toolCallId: c.id,
        name: c.name,
      });
      failedToolCallIds.add(c.id);
    }
    open = [];
  };
  const closeInterruptedFinalAnswerRewrite = (): void => {
    if (openFinalAnswerRewritePrompt === undefined) return;
    messages.push({ role: "assistant", content: INTERRUPTED_FINAL_ANSWER_REWRITE });
    interruptedFinalAnswerSettlementIds.add(openFinalAnswerRewritePrompt);
    openFinalAnswerRewritePrompt = undefined;
  };

  for (const ev of file.events) {
    switch (ev.type) {
      case "user":
        expectedLegacyLoopController = undefined;
        closeInterruptedFinalAnswerRewrite();
        closeOpen();
        {
          const index = messages.length;
          // An applied marker identifies its injected message by both durable message index and
          // exact content. Index-only matching lets a torn marker suppress an unrelated prompt if a
          // later run legitimately reuses the promised index.
          const structuredSteering = steeringMessagesByIndex.get(index)?.has(ev.content) === true;
          const finalAnswerRewritePrompt = ev.finalAnswer?.kind === "rewrite-prompt";
          const ordinaryPrompt =
            awaitingHumanPrompt && !structuredSteering && !finalAnswerRewritePrompt;
          if (ordinaryPrompt && ev.content.trim() !== "") inputHistory.push(ev.content);
          // Even an excluded steering/blank at the boundary owns this run; later controller user-role
          // messages must not be promoted merely because the first one was not recallable.
          if (awaitingHumanPrompt) awaitingHumanPrompt = false;
        }
        messages.push({ role: "user", content: ev.content });
        if (ev.finalAnswer !== undefined) {
          const index = messages.length - 1;
          finalAnswerOccurrences.set(index, ev.finalAnswer);
          observedFinalAnswerSettlementIds.add(ev.finalAnswer.settlementId);
          if (ev.finalAnswer.kind === "rewrite-prompt") {
            openFinalAnswerRewritePrompt = ev.finalAnswer.settlementId;
          }
        }
        break;
      case "assistant":
        expectedLegacyLoopController = undefined;
        if (
          ev.finalAnswer?.kind !== "attempt" ||
          ev.finalAnswer.attempt !== "rewrite" ||
          ev.finalAnswer.settlementId !== openFinalAnswerRewritePrompt
        ) {
          closeInterruptedFinalAnswerRewrite();
        }
        closeOpen();
        messages.push({
          role: "assistant",
          content: ev.content,
          ...(ev.toolCalls !== undefined ? { toolCalls: ev.toolCalls } : {}),
        });
        if (ev.finalAnswer !== undefined) {
          finalAnswerOccurrences.set(messages.length - 1, ev.finalAnswer);
          observedFinalAnswerSettlementIds.add(ev.finalAnswer.settlementId);
          if (
            ev.finalAnswer.kind === "attempt" &&
            ev.finalAnswer.attempt === "rewrite" &&
            ev.finalAnswer.settlementId === openFinalAnswerRewritePrompt
          ) {
            openFinalAnswerRewritePrompt = undefined;
          }
        }
        open = (ev.toolCalls ?? []).map((c) => ({ id: c.id, name: c.name }));
        break;
      case "tool_result":
        expectedLegacyLoopController = undefined;
        closeInterruptedFinalAnswerRewrite();
        // Only keep a result that matches an open assistant tool call. Matching is
        // occurrence-ordered so historical duplicate ids remain replayable.
        {
          const matching = open.findIndex((c) => c.id === ev.toolCallId);
          if (matching < 0) break;
          const matched = open[matching]!;
          const messageIndex = messages.length;
          messages.push({
            role: "tool",
            content: ev.output,
            toolCallId: ev.toolCallId,
            name: matched.name,
          });
          if (ev.isError === true) {
            failedToolCallIds.add(ev.toolCallId);
            failedToolMessageIndexes.add(messageIndex);
          }
          open.splice(matching, 1);
        }
        break;
      case "system":
        closeInterruptedFinalAnswerRewrite();
        closeOpen();
        // Sessions written before Epic 3.15 recorded this exact controller continuation as a tail
        // system event. A preceding structured running-iteration marker has already reconstructed
        // the provider-valid controller message, so consume only that immediate exact legacy copy.
        // Arbitrary user/system text cannot activate this migration path by content alone.
        if (expectedLegacyLoopController === ev.content) {
          expectedLegacyLoopController = undefined;
          break;
        }
        expectedLegacyLoopController = undefined;
        messages.push({ role: "system", content: ev.content });
        break;
      case "run_status":
        expectedLegacyLoopController = undefined;
        lastStop = ev.reason;
        lastStopCode = ev.code;
        lastStopMessage = ev.message;
        lastGoalFailure = undefined;
        usage = ev.usage;
        if (ev.finalAnswer !== undefined) {
          finalAnswerSettlements.set(ev.finalAnswer.settlementId, ev.finalAnswer);
        }
        awaitingHumanPrompt = true;
        break;
      case "loop_iteration":
        if (ev.status === "exit-check-failed") {
          failedLoopIterationById.set(ev.loopId, ev.iteration);
          break;
        }
        if (
          ev.status === "running" &&
          ev.iteration > 1 &&
          failedLoopIterationById.get(ev.loopId) === ev.iteration - 1
        ) {
          closeOpen();
          const continuation = loopContinuationMessage(ev.iteration);
          messages.push(continuation);
          awaitingHumanPrompt = false;
          expectedLegacyLoopController = continuation.content;
        }
        // A failed-check marker authorizes at most the immediately following running iteration.
        // Passed/no-progress states and malformed non-consecutive running events consume it too,
        // preventing stale metadata from inventing a controller message later in the ledger.
        failedLoopIterationById.delete(ev.loopId);
        break;
      case "loop_stopped": {
        failedLoopIterationById.delete(ev.loopId);
        expectedLegacyLoopController = undefined;
        const loopStop = stopReasonForLoopStopped(ev.reason);
        if (loopStop !== undefined) {
          const preserveDetail = shouldPreserveStopDetailAfterLoopStopped({
            loopStop,
            lastStop,
            lastStopCode,
          });
          if (!preserveDetail) {
            lastStop = loopStop;
            lastStopCode = undefined;
            lastStopMessage = undefined;
          }
          lastGoalFailure = undefined;
        }
        break;
      }
      case "goal_failed":
        lastGoalFailure = ev.reason;
        lastStop = ev.reason === "aborted" || ev.reason === "error" ? ev.reason : undefined;
        lastStopCode = undefined;
        lastStopMessage = undefined;
        break;
      case "steering":
        // Last-wins per inputId: an applied marker (insertedAt set) supersedes its pending event.
        steeringById.set(ev.inputId, ev);
        if (ev.insertedAt !== null) {
          const contents = steeringMessagesByIndex.get(ev.insertedAt) ?? new Set<string>();
          contents.add(ev.content);
          steeringMessagesByIndex.set(ev.insertedAt, contents);
        }
        break;
      default:
        break; // session_meta is not a conversation message
    }
  }
  closeInterruptedFinalAnswerRewrite();
  closeOpen(); // synthesize results for any tool calls left open by an aborted final turn

  for (const settlementId of observedFinalAnswerSettlementIds) {
    if (!finalAnswerSettlements.has(settlementId)) {
      interruptedFinalAnswerSettlementIds.add(settlementId);
    }
  }

  // §4.10 / ADR-0034 ("survive resume · no silent drop"): any still-pending steering — a queued
  // comment OR an urgent instruction the run ended before applying (e.g. an abnormal exit between
  // recording and applying it) — rehydrates as pending across resume so it can be re-applied. An
  // applied or superseded one does not (its injected message already rode a `user` event). `interrupt`
  // is a hard-stop, not injectable content, and is never recorded as a pending steering event.
  const pendingSteering = [...steeringById.values()].filter(
    (s) => (s.class === "queued" || s.class === "urgent") && s.insertedAt === null,
  );

  return {
    messages,
    inputHistory,
    failedToolCallIds,
    failedToolMessageIndexes,
    finalAnswerOccurrences,
    finalAnswerSettlements,
    interruptedFinalAnswerSettlementIds,
    pendingSteering,
    finished:
      lastGoalFailure === undefined &&
      lastStop === "model-stop" &&
      !stopCodeNeedsAttention(lastStopCode),
    ...(lastStop !== undefined ? { lastStop } : {}),
    ...(lastStopCode !== undefined ? { lastStopCode } : {}),
    ...(lastStopMessage !== undefined ? { lastStopMessage } : {}),
    ...(lastGoalFailure !== undefined ? { lastGoalFailure } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

/**
 * Rehydrate a resumed session's still-pending steering (ADR-0034 §4.10: an unresolved queued comment
 * OR urgent instruction — one the user typed mid-run that the run ended before applying — **survives
 * resume** and must not be silently dropped). Apply each pending item exactly as the live runner does
 * at a turn
 * boundary ({@link applySteering}): an applied marker with `insertedAt` set (so `rebuild` dedups it
 * by inputId — it is never applied again on a later resume) followed by the injected `user` message
 * (so the model, and any future resume, sees the instruction as a conversation message). `insertedAt`
 * mirrors the runner: the resumed ledger message index (`messages.length + i`).
 *
 * Returns the resumed context seed — the rebuilt messages with each applied steering's `user` message
 * appended in order — so the next turn's model context carries them. A no-op returning
 * `state.messages` (no ledger writes) when nothing is pending.
 */
export function applyPendingSteeringOnResume(
  store: SessionStore,
  state: ResumeState,
): ModelMessageT[] {
  const seed = [...state.messages];
  const before = state.messages.length;
  state.pendingSteering.forEach((s, i) => {
    applySteering(store, { inputId: s.inputId, class: s.class, content: s.content }, before + i);
    seed.push({ role: "user", content: s.content });
  });
  return seed;
}
