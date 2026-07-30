import { z } from "zod";
import { JsonObject } from "../common/json.js";

/**
 * The provider-abstraction port (ADR-0002). The kernel loop consumes a
 * `ModelPort`; `@keel/simulator` (Phase 0) and the Vercel-AI-SDK adapter
 * (Phase 1) both implement it independently. The chunk vocabulary below is
 * keel's own stable contract: provider SDKs reshape and rename their stream
 * parts across versions (the Vercel AI SDK renamed `text-delta`→`text` between
 * v4 and v5), so the Phase 1 provider adapter maps provider-native parts onto
 * these types and the kernel never sees provider churn. ADR-0002 already says
 * the port "must be frozen (or versioned) before Phase 1 work starts, since
 * `@keel/simulator` implements it independently."
 *
 * FROZEN before Phase 1. Changing the interface or chunk vocabulary after the
 * Phase 0 gate requires an ADR — the simulator and the real provider adapter
 * must agree on this contract.
 *
 * ## Streaming contract (ADR-0019)
 *
 * - `stream()` MUST observe `input.signal`. When the signal fires, the
 *   implementation MUST emit a terminal `{ type: "finish", reason: "aborted",
 *   usage: { inputTokens: 0, outputTokens: 0 } }` and stop. The simulator
 *   implements this in Task 2; the Phase-1 provider adapter must do the same.
 *
 * - **Terminal-chunk invariant:** every call to `stream()` MUST emit exactly
 *   one terminal chunk (`finish` or `error`) and it MUST be the last chunk
 *   emitted.
 *
 * - **Atomic vs. streaming tool calls:** `tool-call` is the complete/atomic
 *   form — the id, name, and fully-parsed args are all present. `tool-call-delta`
 *   is the streaming form: a consumer buffers consecutive `tool-call-delta`
 *   chunks by `id`, concatenating `argsTextDelta` strings, and assembles the
 *   complete call when the terminal chunk arrives. The simulator emits the atomic
 *   form only (a valid implementation); real provider adapters use the streaming
 *   form.
 *
 * - **Reasoning tokens:** `reasoning-delta` carries thinking/reasoning tokens
 *   (e.g. extended-thinking models). Consumers that do not use them may ignore
 *   these chunks; they do not count toward the terminal-chunk invariant.
 */

/** Role of a message handed to the model. */
export const ModelRole = z.enum(["system", "user", "assistant", "tool"]);
export type ModelRoleT = z.infer<typeof ModelRole>;

/**
 * One conversation message. Minimal for v1: text content plus the linkage a
 * tool result needs (`toolCallId` + tool `name` when `role` is "tool"). The
 * rich provider message shape is built by the Phase 1 adapter from these.
 *
 * Assistant turns may carry an optional `toolCalls` array recording the tool
 * calls the assistant issued, so the assistant→tool-result linkage real
 * providers require is representable in the conversation history (ADR-0019 / F).
 */
export const ModelMessage = z
  .object({
    role: ModelRole,
    content: z.string(),
    toolCallId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    toolCalls: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().min(1),
            args: JsonObject,
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type ModelMessageT = z.infer<typeof ModelMessage>;

/**
 * A tool advertised to the model. `parameters` is an opaque JSON-Schema object
 * at this layer — schema enforcement is the executor's/warden's job, not the
 * model port's.
 */
export const ToolSpec = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ToolSpecT = z.infer<typeof ToolSpec>;

/** Why an assistant turn ended. */
export const FinishReason = z.enum(["stop", "tool-calls", "length", "error", "aborted"]);
export type FinishReasonT = z.infer<typeof FinishReason>;

/**
 * Token accounting for one turn (cost-discipline substrate — the in-loop scope/spend budget §4.9.6 and
 * the benchmark budget cap, Appendix F). `cachedInputTokens` is the subset of `inputTokens` served from
 * the provider prompt cache (billed at the provider's cache-read rate — e.g. ~0.1× on Anthropic
 * ephemeral; provider-dependent, see the capability table's `cacheReadWeight`). ADDITIVE + OPTIONAL: a
 * provider that doesn't report it (simulator, local) simply omits it; older records without the field
 * still parse. It is what makes the bounded live Harbor validation "effective cost per resolved task" + cache-hit ratio measurable
 * (a high `inputTokens` is cheap when most of it is cached) — see `providers/context.ts`.
 */
export const ModelUsage = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    // `cacheCreationInputTokens` is the subset of input WRITTEN to the prompt cache this turn (billed at
    // the provider's cache-write rate — ~1.25× fresh input on Anthropic ephemeral). ADDITIVE + OPTIONAL,
    // exactly like `cachedInputTokens`: a provider that doesn't report it omits it, and older records
    // still parse. It is what makes the real (cache-discounted) cost EXACT on the write side rather than
    // under-counted (Epic 1.14 / ADR-0047). NOT used by the effective-cost CAP — a write still counts as
    // 1.0× input there until the ADR-0022 recalibration decision.
    cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ModelUsageT = z.infer<typeof ModelUsage>;

/**
 * A single streaming chunk — keel's stable vocabulary. An implementation MUST
 * emit exactly one terminal chunk (`finish` or `error`) and it MUST be last.
 *
 * Non-terminal variants: `text-delta`, `tool-call`, `reasoning-delta`,
 * `tool-call-delta`. Terminal variants: `finish`, `error`.
 *
 * See the file-level doc block for the full streaming contract (signal/abort,
 * atomic vs. streaming tool calls, reasoning tokens).
 */
export const ModelStreamChunk = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text-delta"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("tool-call"),
      id: z.string().min(1),
      name: z.string().min(1),
      args: JsonObject,
    })
    .strict(),
  z.object({ type: z.literal("finish"), reason: FinishReason, usage: ModelUsage }).strict(),
  z.object({ type: z.literal("error"), code: z.string().min(1), message: z.string() }).strict(),
  /** Thinking/reasoning tokens from extended-thinking models (ADR-0019 / L). */
  z.object({ type: z.literal("reasoning-delta"), text: z.string() }).strict(),
  /**
   * Streaming partial tool-call args (ADR-0019 / L). `name` is present on the
   * first delta only (providers omit it on subsequent chunks). A consumer
   * buffers by `id`, concatenating `argsTextDelta` strings until the terminal
   * chunk arrives, then JSON-parses the accumulated string.
   */
  z
    .object({
      type: z.literal("tool-call-delta"),
      id: z.string().min(1),
      name: z.string().min(1).optional(),
      argsTextDelta: z.string(),
    })
    .strict(),
]);
export type ModelStreamChunkT = z.infer<typeof ModelStreamChunk>;

/**
 * Input to one assistant turn.
 *
 * ## Per-turn generation params (ADR-0019 extension — I5)
 *
 * The optional `params` field is the per-turn channel for the reasoning sandwich
 * (MASTER_SPEC §7 Epic 1.1) and any model-override or cost-discipline need.
 * Fields are provider-neutral; Phase-1 adapters map them onto provider-native APIs:
 *
 * - `reasoningEffort` — maps to extended-thinking depth / reasoning budget.
 *   Adapters MUST **omit `temperature` entirely** when `reasoningEffort` is set.
 *   (ADR-0030 corrects ADR-0019's original "force `temperature: 1`" rule: current
 *   reasoning models — e.g. Anthropic Opus 4.7/4.8, OpenAI o-series — reject *any*
 *   non-default temperature with a 400, and the provider default is the only
 *   accepted value, so the adapter sends no `temperature` rather than forcing 1.)
 * - `temperature` — sampling temperature; ignored (not sent) when `reasoningEffort`
 *   is set, per the omit rule above.
 * - `model` — per-turn model override; lets the kernel run a reasoning-sandwich
 *   (planning turn at `claude-opus-…`, execution turns at `claude-haiku-…`).
 * - `maxOutputTokens` — per-turn output token ceiling.
 *
 * The simulator (Phase 0) reads none of these fields — it is a seam for Phase-1
 * provider adapters, and silently ignoring unknown params is a valid implementation.
 */
export interface ModelTurnInput {
  readonly messages: readonly ModelMessageT[];
  readonly tools?: readonly ToolSpecT[];
  readonly signal?: AbortSignal;
  readonly params?: {
    readonly reasoningEffort?: "low" | "medium" | "high";
    readonly temperature?: number;
    readonly model?: string;
    readonly maxOutputTokens?: number;
  };
}

/**
 * Provider-abstraction port. `stream` yields the chunks of exactly one
 * assistant turn; the caller (kernel loop) dispatches any tool calls and calls
 * `stream` again with the appended results.
 */
export interface ModelPort {
  stream(input: ModelTurnInput): AsyncIterable<ModelStreamChunkT>;
}
