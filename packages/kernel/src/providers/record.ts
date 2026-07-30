import type {
  ModelPort,
  ModelStreamChunkT,
  ModelTurnInput,
  RecordedTurnT,
  RecordingT,
} from "@keel/shared";
import { isTerminal } from "./chunks.js";
import { PROVIDER_STRINGS } from "./strings.js";

/**
 * Full-fidelity record/replay (ADR-0031, design §9). These two ports turn a real
 * provider session into a keel-owned `Recording` (capture) and replay it
 * byte-for-byte (replay), built entirely from keel's frozen `ModelStreamChunk`
 * vocabulary — **zero provider coupling**.
 *
 * ## Distinct from `@keel/simulator`'s `RecordingModelPort`
 *
 * `@keel/simulator` also exports a class named `RecordingModelPort`. That one is
 * the Phase-0 *script-authoring* recorder: it reconstructs a `SimulatorScript` of
 * just text + tool calls (discarding usage, timings, cadence, and reasoning/
 * tool-call-delta chunks) so a human can hand-tune a replayable script. **This**
 * recorder is the full-fidelity record-mode-proper artifact: it preserves the
 * exact chunk transcript (deltas, cadence order, the turn's `usage` in its
 * `finish` chunk) plus per-chunk timings, and its output (`toRecording()`) feeds
 * Phase-2 warden calibration + the trajectory store. Same name, two packages, two
 * purposes — each documented so a forker is never confused (ADR-0031 §4).
 */

/** Injectable monotonic clock (ms). Defaults to `Date.now`; overridable for tests. */
export type Clock = () => number;

/** Construction deps for {@link RecordingModelPort}. */
export interface RecordingModelPortConfig {
  /** The live `ModelPort` whose stream is captured and passed through unchanged. */
  readonly delegate: ModelPort;
  /** Provider label written into the recording (which adapter produced it). */
  readonly provider: string;
  /** Model label written into the recording. */
  readonly model: string;
  /**
   * Monotonic clock for relative per-chunk timings (`now() - turnStart`).
   * Injectable so tests are deterministic; defaults to `() => Date.now()`.
   */
  readonly now?: Clock;
}

/**
 * **Capture port.** Wraps a live delegate `ModelPort` and tees every chunk it
 * emits into a `Recording`, while yielding the chunk **unchanged** — the
 * delegate's consumer sees exactly the delegate's stream (transparent
 * passthrough). Provider-agnostic: wraps ANY `ModelPort`, including the Vercel
 * adapter.
 *
 * Each `stream()` call records one `RecordedTurn`: every yielded chunk is
 * deep-copied (via `structuredClone`, so later mutation of a chunk by the
 * consumer cannot corrupt the recording) alongside a relative-ms `timings` entry
 * (`now() - turnStart`). On turn completion the `RecordedTurn` is appended.
 *
 * `toRecording()` returns an independent deep copy, safe to persist or mutate.
 *
 * **Single-session — NOT safe for concurrent/overlapping `stream()` calls.** The capture
 * appends turns to a shared `turns` array; overlapping streams would interleave or corrupt that
 * shared state. Drive one `stream()` to completion before the next (the kernel loop does).
 */
export class RecordingModelPort implements ModelPort {
  private readonly delegate: ModelPort;
  private readonly provider: string;
  private readonly model: string;
  private readonly now: Clock;
  private readonly turns: RecordedTurnT[] = [];

  constructor(config: RecordingModelPortConfig) {
    this.delegate = config.delegate;
    this.provider = config.provider;
    this.model = config.model;
    this.now = config.now ?? ((): number => Date.now());
  }

  /**
   * Note: if the delegate **throws** (rather than emitting an `error` terminal
   * chunk), the in-progress turn is dropped and the throw propagates transparently.
   * A well-behaved `ModelPort` emits `error` rather than throwing.
   */
  async *stream(input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
    const turnStart = this.now();
    const chunks: ModelStreamChunkT[] = [];
    const timings: number[] = [];
    for await (const chunk of this.delegate.stream(input)) {
      // Deep-copy into the recording so a consumer mutating the chunk it
      // received cannot retroactively corrupt the captured transcript.
      chunks.push(structuredClone(chunk));
      timings.push(this.now() - turnStart);
      // Yield the ORIGINAL chunk unchanged — capture is transparent.
      yield chunk;
    }
    this.turns.push({ chunks, timings });
  }

  /**
   * The full-fidelity recording of everything captured so far, as an independent
   * deep copy — mutating the return value (or persisting it) never touches this
   * recorder's internal state or a later `toRecording()` call.
   */
  toRecording(): RecordingT {
    return {
      version: 1,
      provider: this.provider,
      model: this.model,
      turns: this.turns.map((t) => structuredClone(t)),
    };
  }
}

/** A terminal chunk emitted when a replay turn is exhausted or aborted. */
function finish(reason: "stop" | "aborted"): ModelStreamChunkT {
  return { type: "finish", reason, usage: { inputTokens: 0, outputTokens: 0 } };
}

/**
 * **Replay port.** A deterministic `ModelPort` built from a `Recording`. Each
 * `stream()` call yields the next recorded turn's chunks (deep-copied so a
 * consumer's mutation cannot corrupt the recording for a later `reset()`),
 * reproducing the captured transcript **byte-for-byte**.
 *
 * Abort handling mirrors `@keel/simulator`'s `ScriptedModel`: an already-aborted
 * signal at entry yields a terminal `finish(aborted)` and returns (no recorded
 * chunks emitted); the signal is also checked between yields so a mid-replay
 * abort emits `finish(aborted)` and stops.
 *
 * Replay does **not** sleep on the recorded `timings` — golden replay must be
 * fast and stable; timings are captured metadata for offline cadence analysis
 * (ADR-0031). When the recorded turns are exhausted, `stream()` yields a terminal
 * `finish(stop)` (mirroring `ScriptedModel`'s end-of-script behavior). `reset()`
 * rewinds to the first turn so the same recording replays from the top.
 *
 * **Defensive terminal:** a recording is replayed verbatim, so a corrupted or hand-built
 * recording whose turn lacks a terminal chunk (`finish`/`error`) would otherwise leave the
 * kernel loop waiting for a terminal that never comes. Mirroring `VercelModelPort`'s no-terminal
 * guard, replay appends a defensive `error` terminal (the same `no-terminal` code+message) when a
 * turn's recorded chunks contain none — so the loop never hangs on a malformed recording.
 *
 * **Single-session — NOT safe for concurrent/overlapping `stream()` calls.** The replay shares a
 * mutable `cursor` across calls; overlapping streams would race the cursor and serve the wrong
 * turn. Drive one `stream()` to completion before the next (the kernel loop does).
 */
export class RecordedModelPort implements ModelPort {
  private cursor = 0;

  constructor(private readonly recording: RecordingT) {}

  /** Rewind to the first turn so the same recording replays from the top. */
  reset(): void {
    this.cursor = 0;
  }

  async *stream(input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
    // Already-aborted at entry: emit a terminal aborted finish and stop.
    if (input.signal?.aborted) {
      yield finish("aborted");
      return;
    }
    const turn = this.recording.turns[this.cursor];
    if (turn === undefined) {
      // Recorded turns exhausted — terminal stop (mirrors ScriptedModel).
      yield finish("stop");
      return;
    }
    this.cursor += 1;
    let terminalSeen = false;
    for (const chunk of turn.chunks) {
      // Check the signal between yields so a mid-replay abort stops cleanly.
      if (input.signal?.aborted) {
        yield finish("aborted");
        return;
      }
      // Deep-copy so a consumer mutating a replayed chunk cannot corrupt the
      // recording for a subsequent reset()+replay.
      yield structuredClone(chunk);
      if (isTerminal(chunk)) terminalSeen = true;
    }
    // Defensive terminal: a corrupted/hand-built recording whose turn lacks a terminal would
    // leave the loop waiting forever. Emit one (reusing VercelModelPort's no-terminal code+message)
    // so replay always terminates, exactly as the live adapter does.
    if (!terminalSeen) {
      yield {
        type: "error",
        code: PROVIDER_STRINGS.noTerminalCode,
        message: PROVIDER_STRINGS.noTerminal,
      };
    }
  }
}
