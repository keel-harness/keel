import { streamText as defaultStreamText } from "ai";
import type { ModelMessage, LanguageModel } from "ai";
import type { ModelPort, ModelStreamChunkT, ModelTurnInput } from "@keel/shared";
import { PROVIDER_STRINGS } from "./strings.js";
import { createPartMapper, isTerminal, mapPart, type SdkStreamPart } from "./chunks.js";
import { type SdkToolSet, toSdkToolName, toSdkToolsProjection } from "./tools.js";
import { assembleContext, type CacheTtl } from "./context.js";
import { mapParams, type ProviderCapability } from "./capabilities.js";

export type { SdkStreamPart } from "./chunks.js";

/**
 * Structural view of a `streamText` result — just the `fullStream` this adapter
 * consumes. Both the real `streamText` return value and a test mock satisfy it, so the
 * transport can be injected (the `StreamTextFn` seam, mirroring Epic 1.2's
 * `SearchToolDeps.spawn` / `WorkspaceDeps.realpath`). Kept minimal on purpose: the
 * adapter needs nothing else from the result.
 */
export interface StreamResultLike {
  readonly fullStream: AsyncIterable<SdkStreamPart>;
}

/** The options this adapter passes to `streamText` (a structural subset of the SDK's). */
export interface StreamTextOptions {
  readonly model: LanguageModel;
  readonly messages: ModelMessage[];
  readonly abortSignal?: AbortSignal;
  /**
   * Native tool calling: the SDK `tools` object (tool name → SDK `Tool`, no `execute`).
   * Present only when the turn advertises tools — its absence means "no tools this turn"
   * (rather than an empty set), so the model is not nudged toward calling tools it lacks.
   */
  readonly tools?: SdkToolSet;
  /**
   * Per-provider reasoning options, keyed by provider name (`{ anthropic: {...} }`, …) — the
   * `ProviderOptions = Record<string, JSONObject>` shape from the SDK. Present only when
   * `params.reasoningEffort` is set on a row that defines reasoning options (slice 4).
   */
  readonly providerOptions?: Record<string, unknown>;
  /**
   * Sampling temperature — present ONLY when `params.temperature` is set AND no reasoning is
   * requested. Under reasoning the key is omitted entirely (ADR-0030): every current reasoning
   * model rejects a non-default temperature with a 400.
   */
  readonly temperature?: number;
  /** Per-turn output-token ceiling — present only when `params.maxOutputTokens` is set. */
  readonly maxOutputTokens?: number;
  /**
   * Suppress the SDK's system-in-messages warning. keel keeps its system prompt as a leading
   * `system` *message* (not the top-level `system` string) so the Anthropic cache breakpoint can
   * attach to it via `providerOptions.anthropic.cacheControl` (design §8 / OBS-3). The SDK warns
   * that system messages in `messages` *can* enable prompt injection — but keel's system prompt is
   * keel-authored and trusted (not untrusted input), so we opt in to silence the warning cleanly
   * rather than relocating system and breaking the breakpoint. Always `true` from this adapter.
   */
  readonly allowSystemInMessages?: boolean;
  /**
   * Bounded transport retry (slice 6, design §10 / ADR-0028). The SDK's built-in retry loop
   * re-issues the provider HTTP request on a classified-transient `APICallError` (statusCode
   * 408/409/429 or any 5xx, incl. Anthropic 529 — `isRetryable` is derived from the status; it
   * never retries a generic 4xx) and honors `Retry-After`. This is a TRANSPORT retry, NOT a tool
   * retry: it lives wholly inside the SDK, below `ModelPort`, so it can never re-execute a tool or
   * repeat a side effect (the loop's no-auto-retry rule, ADR-0016, is untouched). The retry
   * effectively governs the INITIAL request: a failing `doStream` throws before any chunk is
   * yielded; once streaming has begun, an error is surfaced (not re-streamed) per ADR-0028 §3.
   * Always set by this adapter (default 2) — never left to the SDK's own default — so the bound
   * is explicit and overridable via `VercelModelPortConfig.maxRetries`.
   */
  readonly maxRetries?: number;
  /**
   * Override the SDK's default console.error diagnostic sink. Provider failures already travel
   * through `fullStream` as typed keel error chunks; printing the raw SDK error would duplicate
   * the failure and leak implementation diagnostics into the normal interactive transcript.
   */
  readonly onError?: (event: { readonly error: unknown }) => void | PromiseLike<void>;
}

/**
 * Configuration for a `VercelModelPort`: the provider's default model id, a `buildModel`
 * function that resolves a model id to an SDK `LanguageModel` (so `params.model` can override
 * per turn, staying WITHIN this provider — design §8), and the provider's `ProviderCapability`
 * row (reasoning mapping + native-tool flag + cache strategy). The factory supplies these; tests
 * inject a fake `buildModel`. `model` is re-resolved each turn via `buildModel(params.model ??
 * defaultModelId)`.
 */
export interface VercelModelPortConfig {
  readonly defaultModelId: string;
  readonly buildModel: (modelId: string) => LanguageModel;
  readonly capability: ProviderCapability;
  /**
   * Bounded transport-retry count (slice 6, design §10 / ADR-0028), passed to `streamText`'s
   * `maxRetries`. Omitted → the adapter applies its own default of `DEFAULT_MAX_RETRIES` (2);
   * `0` disables retry. Small by design: a transport retry re-issues only the provider HTTP
   * request, never a tool. The factory threads a provider/config override here.
   */
  readonly maxRetries?: number;
  /**
   * Ephemeral cache TTL for the Anthropic breakpoint strategy (the `KEEL_CACHE_TTL` lever; see
   * `context.ts` `CacheTtl`). Omitted → `"5m"` (byte-identical to the pre-lever wire). The factory
   * threads the env-resolved value here; consumed only by the `anthropic-breakpoint` strategy.
   */
  readonly cacheTtl?: CacheTtl;
}

/** Injectable transport: the real `streamText` from `'ai'`, or a deterministic test mock. */
export type StreamTextFn = (opts: StreamTextOptions) => StreamResultLike;

/** Test/transport injection seam (mirrors `SearchToolDeps`/`WorkspaceDeps`). */
export interface VercelModelPortDeps {
  readonly streamText?: StreamTextFn;
}

/** True for an abort-shaped throw (the SDK's early-cancel path surfaces an `AbortError`). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** Read `signal.aborted` freshly (the signal can fire mid-stream, after any entry check). */
function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** Derive a keel error chunk from a thrown value (reuses the chunk mapper's classification). */
function errorChunk(err: unknown): ModelStreamChunkT {
  // The mapper's error path already yields `{ type:"error", code, message }`.
  return mapPart({ type: "error", error: err }) as ModelStreamChunkT;
}

const FINISH_ABORTED: ModelStreamChunkT = {
  type: "finish",
  reason: "aborted",
  usage: { inputTokens: 0, outputTokens: 0 },
};

/**
 * Deep-merge two CALL-LEVEL `providerOptions` fragments by provider key, so the reasoning
 * options (slice 4, `mapParams`) and any cache call-level directive (slice 5, `assembleContext`)
 * COEXIST under the same provider key (e.g. `{ openai: { reasoningEffort, promptCacheKey } }`)
 * rather than one clobbering the other. The merge is one level deep — each top-level key is a
 * provider name (`openai`/`anthropic`/…) mapping to a flat options object — which matches the
 * `ProviderOptions = Record<string, JSONObject>` shape. On a true same-leaf collision the second
 * argument (the cache fragment, applied last) wins; in practice the two write disjoint leaves.
 *
 * Returns `undefined` when both sides are undefined, so the caller spreads no `providerOptions`
 * key at all (no `undefined`-valued key under `exactOptionalPropertyTypes`). The Anthropic cache
 * breakpoint is a MESSAGE-level directive (on the system message), so it never reaches this merge.
 */
export function mergeProviderOptions(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const merged: Record<string, unknown> = { ...a };
  for (const [provider, bValue] of Object.entries(b)) {
    const aValue = merged[provider];
    // Both fragments target the same provider: shallow-merge their options (b wins per leaf).
    // Otherwise b's provider key is new — take it whole.
    merged[provider] =
      isPlainObject(aValue) && isPlainObject(bValue) ? { ...aValue, ...bValue } : bValue;
  }
  return merged;
}

/** True for a non-null, non-array plain object (the provider-options fragment shape). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Default bounded transport-retry count (design §10 / ADR-0028 §1). Small on purpose — a
 * classified-transient transport failure is retried at most twice (3 attempts total), the SDK's
 * own default. The adapter ALWAYS passes an explicit `maxRetries` so the bound is keel's, not an
 * implicit SDK default that a version bump could change silently.
 */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * `ModelPort` over the Vercel AI SDK (`streamText`). This is the ONLY unit that touches
 * the SDK transport; the pure mappers (`chunks.ts`) and the kernel loop see only keel's
 * frozen vocabulary. Text streaming, native tool calling, message mapping, per-turn reasoning
 * params (slice 4), cache-stable context (slice 5), and bounded transport retry (slice 6,
 * `maxRetries`, ADR-0028) are wired; record/replay lands in a later slice (design §15).
 *
 * Per-turn params (the reasoning sandwich, design §8): each `stream()` resolves the model via
 * `buildModel(params.model ?? defaultModelId)` (a per-turn override stays WITHIN this provider),
 * and maps `params` onto `streamText` options through the capability row (`mapParams`) — reasoning
 * `providerOptions`, the omit-temperature rule (ADR-0030), and `maxOutputTokens`.
 *
 * Streaming contract this enforces (`ModelPort` doc-block + design §6):
 * - **Entry abort:** if `input.signal` is already aborted, emit `finish(aborted)` and
 *   return WITHOUT calling `streamText` (mirrors `ScriptedModel`).
 * - **Terminal-chunk invariant:** emit exactly one terminal (`finish`|`error`), last —
 *   iteration stops at the first terminal.
 * - **Never throw (total):** `runAgentLoop` does not wrap `stream()` in try/catch, so a throw
 *   would break the loop. The whole iteration is wrapped — the SETUP phase (`toSdkTools`/
 *   `buildModel`/`mapParams`/`assembleContext`) AND the `fullStream` loop — so a throw from
 *   any of them is caught: an abort → `finish(aborted)`, any other throw → an `error` chunk,
 *   but only if no terminal was already emitted (a setup throw precedes any terminal, so the
 *   catch emits exactly one). The only step outside the try is the entry-abort early-return,
 *   which cannot throw. `errorFields` (chunks.ts) is itself total, so even a hostile `Error`
 *   whose `message`/`name` getter throws yields a string code+message rather than escaping.
 * - **No-terminal guard:** if `fullStream` ends with no terminal seen, emit a defensive
 *   `error` chunk so the loop never hangs.
 */
export class VercelModelPort implements ModelPort {
  readonly #defaultModelId: string;
  readonly #buildModel: (modelId: string) => LanguageModel;
  readonly #capability: ProviderCapability;
  readonly #streamText: StreamTextFn;
  readonly #maxRetries: number;
  readonly #cacheTtl: CacheTtl | undefined;

  /**
   * Construct from a `VercelModelPortConfig` (the provider's default model id + a `buildModel`
   * resolver + the capability row) and the optional transport-injection `deps`. The factory
   * supplies the config; tests inject a fake `buildModel` returning a stand-in model.
   */
  constructor(config: VercelModelPortConfig, deps: VercelModelPortDeps = {}) {
    this.#defaultModelId = config.defaultModelId;
    this.#buildModel = config.buildModel;
    this.#capability = config.capability;
    this.#streamText = deps.streamText ?? (defaultStreamText as unknown as StreamTextFn);
    this.#maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#cacheTtl = config.cacheTtl;
  }

  async *stream(input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
    // Entry abort: refuse to start the transport at all.
    if (input.signal?.aborted === true) {
      yield FINISH_ABORTED;
      return;
    }

    // Fail closed for non-native-tool providers (design §8): if `input.tools` is non-empty and
    // `this.capability.supportsNativeTools` is false, refuse to advertise tools. Emitting a
    // terminal `error` chunk is the honest, fail-closed path — there is no text-parse fallback
    // and silently swallowing the tools would be security theater. This path is exercised only
    // by test capabilities with `supportsNativeTools: false`; all four built-in providers are true.
    const toolsRequested = input.tools !== undefined && input.tools.length > 0;
    if (toolsRequested && !this.#capability.supportsNativeTools) {
      yield {
        type: "error",
        code: PROVIDER_STRINGS.toolsUnsupportedCode,
        message: PROVIDER_STRINGS.toolsUnsupportedMessage,
      };
      return;
    }

    let terminalEmitted = false;
    try {
      // Setup phase — INSIDE the try so a throw from any of toSdkTools / buildModel / mapParams /
      // assembleContext surfaces as exactly one terminal chunk (the catch below), never escapes
      // stream(). The class doc-block's "the whole iteration is wrapped" claim is total only with
      // the setup phase covered: on a setup throw, no terminal has been emitted yet, so the catch
      // emits exactly one (an `error` chunk, or `finish(aborted)` if the signal is aborted).

      // Advertise tools only when the turn carries them (an empty array advertises nothing —
      // we do not pass an empty `tools` set, which could nudge the model toward tool use).
      // `toolsRequested` already verified `input.tools` is non-empty; TypeScript narrows it here.
      const toolProjection =
        toolsRequested && input.tools !== undefined ? toSdkToolsProjection(input.tools) : undefined;
      const tools = toolProjection?.tools;

      // A fresh per-stream mapper: it holds the `id → toolName` buffer for streaming tool-call
      // deltas (name on the first delta only) and must not leak across turns.
      const mapPartStateful = createPartMapper(
        (name) => toolProjection?.keelNameBySdkName.get(name) ?? name,
      );

      // Resolve the model FRESH each turn so `params.model` can override per turn (the reasoning
      // sandwich: a planning turn at opus, execution turns at haiku — design §8). The override
      // stays within this provider's `buildModel`; a cross-provider switch is never per-turn.
      const model = this.#buildModel(input.params?.model ?? this.#defaultModelId);

      // Map the per-turn params onto streamText options through the capability row: reasoning
      // providerOptions + the omit-temperature rule (ADR-0030) + maxOutputTokens. Excludes the
      // model (resolved above). Conditional spreads keep every key value-bearing.
      const { providerOptions: reasoningOptions, ...generationParams } = mapParams(
        input.params,
        this.#capability,
      );

      // Cache-stable context assembly (slice 5, design §8): order the messages so the leading
      // system prefix is byte-stable across turns and apply the per-provider cache directive the
      // capability row declares. Anthropic's breakpoint rides on the leading system MESSAGE;
      // openai/google/none yield a call-level directive (or none). `cacheKey` is not threaded per
      // turn in this slice — adding it to the FROZEN ModelTurnInput.params is an ADR/stop-and-ask;
      // openai relies on its automatic prefix caching meanwhile (assembleContext documents this).
      const assembled = assembleContext({
        messages: input.messages,
        cacheStrategy: this.#capability.cacheStrategy,
        ...(this.#cacheTtl !== undefined ? { cacheTtl: this.#cacheTtl } : {}),
        mapToolName: toSdkToolName,
      });

      // Deep-merge the reasoning (slice 4) and cache (slice 5) CALL-LEVEL providerOptions so both
      // survive under the same provider key — neither clobbers the other. Spread the key only when
      // the merge is non-undefined (no `undefined`-valued key under exactOptionalPropertyTypes).
      const providerOptions = mergeProviderOptions(reasoningOptions, assembled.providerOptions);

      const result = this.#streamText({
        model,
        messages: assembled.messages,
        // keel's system prompt is a trusted, keel-authored leading system MESSAGE (so the
        // Anthropic cache breakpoint can attach to it — design §8 / OBS-3); opt in to silence
        // the SDK's system-in-messages prompt-injection warning rather than relocate system.
        allowSystemInMessages: true,
        // Bounded transport retry (slice 6, ADR-0028): re-issue the provider HTTP request on a
        // classified-transient failure (408/409/429/5xx, incl. Anthropic 529), honoring
        // Retry-After. `APICallError.isRetryable` is derived from the HTTP status (verified against
        // @ai-sdk/provider@3.0.10); a generic 4xx (e.g. 400) is NOT retried. This is a TRANSPORT
        // retry, NOT a tool retry — it lives wholly inside the SDK's `retry(() => doStream())`,
        // below ModelPort, so it can never re-execute a tool. A failing `doStream` throws BEFORE
        // any chunk is yielded, so the retry effectively governs the INITIAL request (ADR-0028 §3:
        // once streaming has begun, an error is surfaced, not re-streamed — no duplicate output).
        // Exhaustion / non-retryable errors surface as an SDK `error` PART → a keel `error` chunk
        // (mapped by chunks.ts); the never-throw try/catch below is a defensive backstop.
        //
        // HONEST connection-reset note (ADR-0028 §4 refinement): the as-installed SDK
        // (@ai-sdk/provider-utils@4.0.27 `handleFetchError`) DOES classify a low-level
        // `TypeError("fetch failed"|"failed to fetch")` that carries a `cause` as a RETRYABLE
        // `APICallError` ("Cannot connect to API: …"), so such a connection reset IS retried here
        // (verified empirically). This is safe — it is the same pre-stream `doStream` retry that
        // cannot duplicate output. A bare `TypeError` with NO `cause` is NOT classified and
        // surfaces directly as an `error` chunk. (ADR-0028 §4's prose under-states this; the
        // BEHAVIOR is the safe one either way. No hand-rolled `retry.ts` classifier is added —
        // the SDK's built-in path already covers the safe cases; flagged for the ADR to reconcile.)
        maxRetries: this.#maxRetries,
        // The SDK defaults to console.error when this callback is omitted. Keel surfaces the
        // same failure through `fullStream` and the TUI's typed error path, so suppress only the
        // duplicate raw diagnostic dump; the error chunk and honest run-ended receipt remain.
        onError: () => undefined,
        ...(input.signal !== undefined ? { abortSignal: input.signal } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(providerOptions !== undefined ? { providerOptions } : {}),
        ...generationParams,
      });

      for await (const part of result.fullStream) {
        // Mid-stream signal check: the signal may fire between iterations without the
        // transport throwing or emitting an SDK abort part. The frozen ModelPort contract
        // (model-port.ts, streaming contract doc-block) requires observing `input.signal`
        // at every yield point — matching the per-iteration guard in ScriptedModel.
        if (signalAborted(input.signal)) {
          terminalEmitted = true;
          yield FINISH_ABORTED;
          return;
        }
        const chunk = mapPartStateful(part);
        if (chunk === undefined) continue; // ignored lifecycle / later-slice part
        yield chunk;
        if (isTerminal(chunk)) {
          terminalEmitted = true;
          return; // exactly one terminal, and it is the last thing emitted
        }
      }
    } catch (err) {
      // Never throw: a throw would break the un-try/catch'd loop. Only emit a terminal if
      // none was emitted yet (a throw after the terminal — e.g. on a never-pulled next —
      // is unreachable because we `return` at the terminal, but the guard keeps the
      // invariant true regardless).
      if (!terminalEmitted) {
        terminalEmitted = true;
        // The signal may have fired DURING streaming (TS's flow analysis can't see the
        // mutation after the entry guard), so read `.aborted` freshly here.
        const aborted = isAbortError(err) || signalAborted(input.signal);
        yield aborted ? FINISH_ABORTED : errorChunk(err);
      }
      return;
    }

    // The stream ended with no terminal (anomalous) — emit a defensive terminal so the
    // loop never hangs waiting for one.
    if (!terminalEmitted) {
      yield {
        type: "error",
        code: PROVIDER_STRINGS.noTerminalCode,
        message: PROVIDER_STRINGS.noTerminal,
      };
    }
  }
}
