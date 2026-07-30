# 0019 — ModelPort pre-freeze refinements (tool-call linkage, abort, streaming/reasoning chunks)

**Status:** accepted
**Date:** 2026-06-13

## Context

The QC adversarial review of Epics 0.3 + 0.4 surfaced three gaps in `ModelPort`
(findings F, E, L) while the interface is still **PRE-freeze** — the freeze
crystallises at the Phase 0 exit gate, which has not yet passed. Amending the
contract now avoids a breaking change to a semver-frozen interface in Phase 1,
when both the simulator and the real provider adapter must already agree on it.

**Finding F — assistant turn lacks tool-call linkage.** `ModelMessage` had no
way to record which tool calls an assistant turn issued. Real providers (Anthropic,
OpenAI) require the assistant→tool-result linkage to be present in the conversation
history; without it the Phase 1 adapter cannot faithfully reconstruct multi-turn
tool-use conversations.

**Finding E — `stream()` does not document `AbortSignal` semantics.** `ModelTurnInput`
already carried an optional `signal`, but the contract said nothing about what
implementations must do when it fires. The Phase 1 adapter and simulator could each
handle it differently, breaking the frozen contract's substitution guarantee.

**Finding L — chunk vocabulary missing reasoning and streaming-tool-call variants.**
Extended-thinking models emit reasoning/thinking tokens; providers stream partial
tool-call argument JSON across multiple deltas before the final args are available.
Without `reasoning-delta` and `tool-call-delta` in the vocabulary, the Phase 1
Vercel-AI-SDK adapter would need a vocabulary change after the freeze.

## Options

1. **Amend now (pre-freeze)** — add the three missing pieces to `ModelPort` while
   the interface is still mutable; no semver break; both the simulator and the adapter
   start from the corrected contract.

2. **Defer to Phase 1 with a versioned amendment** — leave the current interface
   frozen, introduce a v2 `ModelPort` at Phase 1. Costs an extra ADR, a versioning
   mechanism, and a migration in every callsite; the simulator would need a v1→v2
   adapter shim.

3. **Partial fix (F only)** — add `toolCalls` to `ModelMessage` now, defer L until
   Phase 1. Saves one amendment but still requires a vocabulary change after freeze,
   which is the costlier path.

## Decision

**Option 1: amend now.** The Phase 0 exit gate has not passed; the interface is
explicitly stated as pre-freeze in ADR-0002 and the file doc block. The cost of
amending now is zero rework; the cost of deferring is a breaking change to a frozen
interface.

Three specific decisions:

- **(F) `ModelMessage.toolCalls` (optional array).** An assistant message may carry
  the tool calls it issued, as a typed array of `{ id, name, args }` objects. The
  field is optional so existing consumers remain valid. The `args` field originally
  used `z.record(z.string(), z.unknown())` (same as `tool-call` chunks); this was
  **superseded by the C3 amendment below — `args` is now `JsonObject`** on both the
  message and the chunk, keeping the contract self-consistent AND JSON-safe. All three
  sub-fields validate non-empty strings for `id`/`name`.

- **(E) `stream()` MUST observe `input.signal`.** When the signal fires,
  implementations MUST emit a terminal `{ type: "finish", reason: "aborted", usage:
  { inputTokens: 0, outputTokens: 0 } }` and stop. This is now documented in the
  file-level doc block. The simulator implements this in a subsequent task; the
  Phase-1 adapter must too. The `FinishReason` enum already includes `"aborted"`;
  no schema change is needed.

- **(L) `reasoning-delta` and `tool-call-delta` added to `ModelStreamChunk`.**
  `reasoning-delta { type, text }` carries thinking/reasoning tokens.
  `tool-call-delta { type, id, name?(optional), argsTextDelta }` streams partial
  JSON args — `name` is present on the first delta only (real providers omit it on
  subsequent chunks). A consumer buffers by `id`, concatenating `argsTextDelta`
  strings, and JSON-parses the result when the terminal chunk arrives.
  The atomic `tool-call` variant is unchanged and remains the complete form; the
  simulator emits the atomic subset only (a valid implementation).

## Consequences

- `ModelMessage` gains an optional `toolCalls` field; all existing messages remain
  valid (no deserialization breakage).
- `ModelStreamChunk` gains two non-terminal variants; the terminal-chunk invariant
  (exactly one `finish`|`error`, last) is unchanged. Existing consumers that do not
  handle `reasoning-delta`/`tool-call-delta` will encounter unknown variants from
  Phase 1 provider adapters — they should add explicit `continue` branches rather
  than treating unknowns as errors.
- The simulator (Phase 0) emits the atomic `tool-call` variant only; real provider
  adapters (Phase 1) use `tool-call-delta`. This is a documented, valid split.
- The `signal`/`aborted` requirement is now a contractual obligation for every
  `ModelPort` implementation; future implementations are tested against it.
- Test coverage: `@keel/shared` stays at 100%; the new variants and field are
  exercised by round-trip (fast-check) + parse + reject tests in `model-port.test.ts`.

---

## Further pre-freeze refinement — 2026-06-13 (I5 + C3)

A second QC pass surfaced two additional gaps while the interface is still
**PRE-freeze** (Phase 0 exit gate has not yet passed):

**Finding I5 — `ModelTurnInput` has no per-turn generation-params seam.**
MASTER_SPEC §7 Epic 1.1 requires the reasoning sandwich to be expressible
per-turn through `ModelPort`. The kernel must be able to request extended-thinking
depth, a model override, a temperature, and an output-token ceiling on individual
turns without a second, out-of-band channel. The `@keel/eval` phase-reasoning
model already anticipates per-phase params; without a seam in `ModelTurnInput`
the Phase-1 adapter has nowhere to receive them.

**Finding C3 (input side) — `tool-call` chunk `args` and `ModelMessage.toolCalls[].args`
use `z.record(z.string(), z.unknown())`, which is not JSON-safe.**
T1 landed `JsonObject` (in `common/json.ts`) and `assertWireRoundTrips` precisely
to catch this class of bug. The `args` fields survived `JSON.stringify→parse` with
`undefined` array elements silently dropped, causing `assertWireRoundTrips` to fail
on those schemas. The existing `z.unknown()` type also permitted `NaN` and `Infinity`
which are not JSON-representable and would corrupt the warden JSON-RPC wire.

### Decisions

- **(I5) `ModelTurnInput.params?` — per-turn generation-params seam.**
  An optional, provider-neutral `params` field is added to `ModelTurnInput`:

  ```ts
  readonly params?: {
    readonly reasoningEffort?: "low" | "medium" | "high";
    readonly temperature?: number;
    readonly model?: string;
    readonly maxOutputTokens?: number;
  };
  ```

  `ModelTurnInput` is a TypeScript `interface` (not a Zod schema); the field is
  additive and optional, so all existing callsites remain valid. Phase-1 adapters
  map these fields onto provider-native APIs. **Adapter rule:** adapters MUST
  auto-enforce `temperature: 1` when `reasoningEffort` is set — several providers
  (Anthropic extended-thinking, OpenAI o-series) reject requests at temperatures
  other than 1 when reasoning is active. The simulator (Phase 0) reads none of
  these fields; silently ignoring `params` is a valid implementation and is
  explicitly documented in the interface doc-block.

  > **Corrected by [ADR-0030](0030-provider-adapter-temperature-and-capability-table.md)
  > (2026-06-14):** the "force `temperature: 1`" rule above is superseded. Current reasoning
  > models reject *any* non-default temperature with a 400 (Anthropic Opus 4.7/4.8, OpenAI
  > o-series), so adapters now **omit `temperature` entirely** when `reasoningEffort` is set
  > (the provider default is the only accepted value). The `params` *types* are unchanged.

- **(C3) `args` → `JsonObject` in `ModelStreamChunk` (`tool-call` variant) and
  `ModelMessage.toolCalls[].args`.**
  Both fields are changed from `z.record(z.string(), z.unknown())` to `JsonObject`
  (imported by reference from `../common/json.js` so the `assertWireRoundTrips`
  override in `property.ts` fires). The same constraint is propagated to
  `ScriptedToolCall.args` in `SimulatorScript` (the only downstream schema that
  feeds `tool-call` chunks) and to the local type annotations in
  `simulator/record.ts` and `eval/replay.ts`. All existing tests and fixtures use
  only JSON-safe values, so there is no breakage. `assertWireRoundTrips(ModelStreamChunk)`
  and `assertWireRoundTrips(ModelMessage)` are added to `model-port.test.ts`; two
  rejection tests confirm that `NaN` and `Infinity` args are now refused at parse time.

### Consequences

- `ModelTurnInput` gains an optional `params` field; all existing calls to
  `stream()` remain valid (no callsite changes required).
- `ModelStreamChunk` (`tool-call` variant) and `ModelMessage.toolCalls[].args`
  are narrowed from `unknown` values to `JsonValueT` values; any existing code
  that passed non-JSON-safe args (NaN, Infinity, undefined) will now fail at
  parse time — this is the desired behavior.
- `SimulatorScript` (`ScriptedToolCall.args`) and the local accumulator types
  in `record.ts` and `replay.ts` are updated to match; TypeScript enforces the
  alignment at compile time.
- Test coverage: all packages remain at or above their coverage floor;
  `@keel/shared` stays at 100%.
