import type {
  ModelMessageT,
  ModelPort,
  ModelStreamChunkT,
  ModelTurnInput,
  SimulatorScriptT,
  SimulatorTurnT,
} from "@keel/shared";
import { ControlFlowError } from "./errors.js";
import { matchResult } from "./matcher.js";

/**
 * Bounds the number of pure-control (branch-only) turns resolved within a
 * SINGLE `stream()` call. This guards against an infinite loop of
 * branch-only turns that never reach a content turn — e.g. a cyclic goto
 * that keeps jumping without emitting anything.
 *
 * Content-turn cycles ACROSS `stream()` calls are NOT detected here by design:
 * the simulator faithfully replays scripted turns exactly as authored; higher-
 * level loop detection (n-gram / per-file-edit counters) is the caller/kernel's
 * responsibility (Phase 1, Epic 1.1).
 */
const MAX_CONTROL_STEPS = 1000;

/**
 * Deterministic per-turn token-usage stub (§6.3 cost-accounting substrate):
 * ~4 chars/token of text plus one token per tool call. Entirely deterministic
 * so golden transcripts are byte-stable.
 */
function estimateUsage(turn: SimulatorTurnT): { inputTokens: number; outputTokens: number } {
  const textTokens = Math.ceil((turn.text?.length ?? 0) / 4);
  const toolTokens = turn.toolCalls?.length ?? 0;
  return { inputTokens: 0, outputTokens: textTokens + toolTokens };
}

/** The content of the most recent tool-result message, or undefined if none. */
function lastToolText(messages: readonly ModelMessageT[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m !== undefined && m.role === "tool") return m.content;
  }
  return undefined;
}

/** Split a string into fixed-size pieces (last piece may be shorter). */
function sliceBy(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * A deterministic `ModelPort` driven by a validated `SimulatorScript`. Each
 * `stream()` call advances through zero or more pure-control (branch-only) turns
 * until it reaches a content turn, then emits that turn's text and tool calls
 * followed by exactly one terminal chunk. Tool-call ids are deterministic
 * (`call_<emitCount>_<callIndex>`) — derived from a monotonic per-run emission
 * counter so that branch revisits always get a fresh, unique id rather than
 * colliding with a prior emission of the same turn. Replay identically via a
 * fresh instance or `reset()`.
 */
export class ScriptedModel implements ModelPort {
  private cursor = 0;
  private emitCount = 0;

  constructor(private readonly script: SimulatorScriptT) {}

  /** Rewind to the first turn so the same script replays from the top. */
  reset(): void {
    this.cursor = 0;
    this.emitCount = 0;
  }

  async *stream(input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
    // Honor AbortSignal: if the signal is already aborted before we begin,
    // emit a terminal aborted finish and return immediately.
    if (input.signal?.aborted) {
      yield { type: "finish", reason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }
    const latest = lastToolText(input.messages);
    const turn = this.resolveTurn(latest);
    if (turn === undefined) {
      yield { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }
    this.cursor += 1;
    // Reserve this emission's id index and advance the counter BEFORE emitting, so an
    // abort (or any other interruption) that abandons emitTurn mid-stream still consumes
    // the index — a subsequent stream() call can never reuse it and emit a colliding id.
    const emitIndex = this.emitCount;
    this.emitCount += 1;
    // Iterate chunk-by-chunk so we can check the signal between yields.
    for (const chunk of this.emitTurn(turn, emitIndex)) {
      if (input.signal?.aborted) {
        yield { type: "finish", reason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } };
        return;
      }
      yield chunk;
    }
  }

  /**
   * Walk branch-only turns until a content turn or end-of-script, leaving
   * `cursor` pointing at the content turn. Returns the content turn to emit, or
   * undefined when the script is exhausted.
   */
  private resolveTurn(latest: string | undefined): SimulatorTurnT | undefined {
    for (let steps = 0; steps < MAX_CONTROL_STEPS; steps++) {
      if (this.cursor >= this.script.turns.length) return undefined;
      const turn = this.script.turns[this.cursor]!;
      const target = turn.branches?.find((b) => matchResult(b.match, latest));
      if (target !== undefined) {
        this.cursor = target.goto;
        continue;
      }
      const hasContent = turn.text !== undefined || (turn.toolCalls?.length ?? 0) > 0;
      if (hasContent) return turn;
      this.cursor += 1; // pure-control turn, nothing matched -> fall through
    }
    throw new ControlFlowError(
      `branch resolution exceeded ${String(MAX_CONTROL_STEPS)} steps (cyclic goto?)`,
    );
  }

  private *emitTurn(turn: SimulatorTurnT, emitIndex: number): Generator<ModelStreamChunkT> {
    const fault = this.script.faultInjection;
    // `malformedChunkAtIndex` counts text-delta chunks within this turn; a turn
    // with no text, or an index past the last slice, injects nothing (no-op).
    if (turn.text !== undefined) {
      const slices =
        fault?.chunkSize !== undefined ? sliceBy(turn.text, fault.chunkSize) : [turn.text];
      for (let i = 0; i < slices.length; i++) {
        if (fault?.malformedChunkAtIndex === i) {
          yield {
            type: "error",
            code: "malformed-chunk",
            message: `injected malformed chunk at index ${String(i)}`,
          };
          return; // an error chunk is terminal — stop the turn
        }
        yield { type: "text-delta", text: slices[i]! };
      }
    }
    const calls = turn.toolCalls ?? [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      yield {
        type: "tool-call",
        id: `call_${String(emitIndex)}_${String(i)}`,
        name: call.name,
        // Defensive copy: downstream mutation of returned args must not rewrite
        // the script's original args object (which is shared across stream() calls).
        args: structuredClone(call.args),
      };
    }
    yield {
      type: "finish",
      reason: calls.length > 0 ? "tool-calls" : "stop",
      usage: estimateUsage(turn),
    };
  }
}
