import { z } from "zod";
import { ModelStreamChunk } from "./model-port.js";

/**
 * Full-fidelity record format (ADR-0031, design §9). A `Recording` captures a
 * real-provider session as keel's own frozen `ModelStreamChunk` vocabulary —
 * **zero provider coupling**, so a recording is portable across provider
 * adapters and stable across SDK churn, and replays byte-for-byte.
 *
 * It is a process/file boundary (recordings persist to disk and are read back
 * by `@keel/eval` / the Phase-2 warden calibration harness), so
 * `assertWireRoundTrips(Recording)` guards it and `@keel/shared` stays at 100%
 * coverage. This is an **additive** schema, not a change to any frozen contract.
 *
 * ## What is and isn't captured
 *
 * - **Usage is NOT denormalized.** A turn's real provider usage already lives in
 *   its terminal `finish` chunk (`usage` is a required field of
 *   `ModelStreamChunk`) — the single source of truth. Consumers read
 *   `chunks.at(-1)`. A separate `usage` field would be a second, drift-prone copy.
 * - **Raw provider metadata is NOT captured.** It is *below* the `ModelPort`
 *   boundary — a recorder wrapping a `ModelPort` sees only keel chunks, never
 *   provider-native response metadata. Capturing it would couple the recorder to
 *   a specific provider adapter, breaking the zero-coupling principle. Deliberately
 *   out of v1 (a future provider-keyed extension can add it behind a seam).
 *
 * The recording is therefore **exactly** what the `ModelPort` emitted (`chunks`)
 * plus when (`timings`) — full fidelity *at the port boundary*, the layer every
 * consumer replays through.
 */

/**
 * A relative-ms timing offset: finite and non-negative. Constrained (not a bare
 * `z.number()`) because timings cross the JSON file/wire boundary — `Infinity`/
 * `NaN` serialise to `null` and would not survive a round-trip — and a wall-clock
 * offset (`now() - turnStart`) is never negative or infinite.
 */
const TimingMs = z.number().finite().nonnegative();

/**
 * One captured assistant turn: the exact keel chunk sequence (including
 * reasoning/tool-call-delta cadence AND the turn's usage in its `finish` chunk)
 * plus an optional per-chunk relative-ms `timings` array (when present, parallel
 * to `chunks` and equal-length **by construction at capture**; the schema does not
 * enforce the coupling — the recorder guarantees it), captured metadata for
 * offline cadence analysis only — replay does not sleep on it.
 *
 * Note: this schema does **not** re-assert the `ModelStreamChunk` terminal-chunk
 * invariant (exactly one `finish`/`error`, last). That invariant belongs to the
 * `ModelPort` emitter; a persisted recording is validated for shape only, and
 * `RecordedModelPort` replays whatever was recorded verbatim.
 */
export const RecordedTurn = z
  .object({
    chunks: z.array(ModelStreamChunk),
    timings: z.array(TimingMs).optional(),
  })
  .strict();
export type RecordedTurnT = z.infer<typeof RecordedTurn>;

/**
 * A full-fidelity recording: a versioned, provider-tagged sequence of captured
 * turns. `provider`/`model` are non-empty labels (which adapter + model produced
 * it); `turns` is the linear transcript in capture order.
 */
export const Recording = z
  .object({
    version: z.literal(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    turns: z.array(RecordedTurn),
  })
  .strict();
export type RecordingT = z.infer<typeof Recording>;
