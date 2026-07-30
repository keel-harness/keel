# 0031 — Full-fidelity recording format + replay (record mode)

**Status:** accepted
**Date:** 2026-06-14
**Related:** ADR-0002 (ModelPort), ADR-0019 (chunk vocabulary), ADR-0008 (session JSONL — the
sibling persisted-artifact decision), `MASTER_SPEC.md` §6.3 (record mode), §8.2 (trajectory
store), §8.5/§8.6 (the propagation-design gate that needs ≥10 recorded real sessions), Epic 2.2
(warden policy calibration replays recorded sessions).

## Context

`MASTER_SPEC.md` §6.3 calls for a record mode: capture a real-provider session so it can be
replayed deterministically. The Phase-0 `@keel/simulator` `RecordingModelPort` is a **stub** —
it reconstructs a `SimulatorScript` of just *text + tool calls* (enough to author replayable
scripts), discarding usage, timings, streaming cadence, and reasoning/tool-call-delta chunks.

The owner chose **full fidelity** for Epic 1.3 (the third locked decision, design spec §2/§9)
because the real consumers need more than text+tool-calls:

- **Phase-2 warden policy calibration** (Epic 2.2) replays recorded benchmark sessions through
  the policy gate and counts human prompts — it needs the *real tool-call trajectory + results*.
- **The §8.5/§8.6 propagation-design gate** runs the propagation rules over **≥10 recorded real
  sessions** before any enforcement code is written.
- **The Epic 0.4 trajectory store** (§8.2) persists full raw trajectories (prompts, tool calls,
  results, timings, token counts) as the substrate for the §2.3 iteration loop.

A stub that drops usage/timings/cadence cannot serve these. We need a keel-owned recording that
captures the **exact keel chunk stream + per-chunk timings + real usage + provider metadata**,
replayable byte-for-byte.

## Decision

1. **A new `Recording` zod schema in `@keel/shared`** (`src/ports/recording.ts`), built entirely
   from keel's own frozen `ModelStreamChunk` vocabulary — **zero provider coupling**, so a
   recording is portable across provider adapters and stable across SDK churn:

   ```ts
   RecordedTurn = {
     chunks: ModelStreamChunkT[];   // the exact keel chunk sequence (incl. reasoning/tool-call-delta
                                    // cadence AND the turn's usage, which lives in the finish chunk)
     timings?: number[];            // ms offset per chunk (len === chunks.len) — cadence, analysis-only
   }
   Recording = { version: 1; provider: string; model: string; turns: RecordedTurn[] }
   ```

   **Usage is not denormalized:** the turn's real provider usage already lives in its terminal
   `finish` chunk (`usage` is a required field of `ModelStreamChunk`), the single source of truth —
   consumers read `chunks.at(-1)`. **Raw provider metadata is not captured:** it is *below* the
   `ModelPort` boundary — a `RecordingModelPort` wrapping a `ModelPort` sees only keel chunks, never
   provider-native response metadata. Capturing it would require coupling to a specific provider
   adapter, breaking the zero-coupling principle; it is deliberately out of v1 (a future
   provider-keyed extension can add it behind a seam if a consumer needs it). The recording is
   therefore **exactly** what the `ModelPort` emitted (chunks) plus when (timings) — full fidelity
   *at the port boundary*, which is the layer every consumer replays through.

   It is a process/file boundary (recordings persist to disk and are read back by `@keel/eval` /
   the warden calibration harness), so `assertWireRoundTrips(Recording)` guards it and
   `@keel/shared` stays at 100% coverage. This is an **additive** new schema, not a change to any
   frozen contract.

2. **`RecordingModelPort` (capture)** — wraps a live delegate `ModelPort`; per `stream()` it tees
   each chunk (with a relative timestamp) into a `RecordedTurn` as `{ chunks, timings }`, yields the
   chunk unchanged (transparent), and exposes `toRecording()`. It does **not** denormalize a separate
   `usage`/`providerMetadata` field — usage already lives in the turn's terminal `finish` chunk
   (§1), and provider metadata is below the `ModelPort` boundary (the recorder sees only keel
   chunks). Provider-agnostic (wraps any `ModelPort`, including the Vercel adapter).

3. **`RecordedModelPort` (replay)** — a `ModelPort` built from a `Recording`; each `stream()`
   yields the next turn's recorded chunks, honoring `input.signal` (already-aborted →
   `finish(aborted)`), reproducing the exact chunk transcript **byte-for-byte**. Replay does
   **not** sleep on `timings` (determinism — golden replay must be fast and stable); timings are
   captured metadata for offline cadence analysis only.

4. **Placement:** schema in `@keel/shared`; both ports in `packages/kernel/src/providers/record.ts`
   (capture wraps the real adapter; replay is the deterministic `ModelPort` for tests/calibration).
   The Phase-0 `@keel/simulator` `RecordingModelPort` (SimulatorScript reconstruction) **stays** —
   it serves script *authoring* from observed behavior; the new `Recording` is record-mode-proper.
   The same class name lives in two packages for two purposes; each is documented to avoid
   confusion (a fork may rename if it prefers).

5. **On-disk layout is the consumer's concern (deferred).** The schema is the contract; the exact
   file path / JSONL-vs-JSON layout for the trajectory store + calibration harness is decided when
   those consumers land (Epic 0.4 store exists; Epic 2.2 calibration is Phase 2). Recording is
   wired into a live session by the kernel entrypoint (Epic 1.5/1.6).

## Consequences

- `@keel/shared` gains one additive schema (round-trip + parse/reject tested; 100% held); no
  frozen contract changes.
- The kernel providers gain capture + replay ports; a record→replay **golden-equality** test
  proves byte-for-byte fidelity.
- Phase-2 warden calibration and the propagation-design gate get real-fidelity recordings to
  replay; the trajectory store gets the usage/timing substrate the §2.3 loop needs.
- Cadence *replay* (sleeping on `timings`) is intentionally omitted — captured as metadata; added
  behind a flag only if a consumer needs it (recorded so a fork inherits the reasoning).
