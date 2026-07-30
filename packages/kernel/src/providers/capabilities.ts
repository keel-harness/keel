import type { ModelTurnInput } from "@keel/shared";

/**
 * The per-provider capability table (ADR-0030, Option A; design §8). This is the single
 * declarative home for provider divergence — reasoning enablement, native-tool support, and
 * the prompt-caching strategy — so the adapter core (`VercelModelPort`) carries no per-provider
 * conditionals. Adding a fifth provider is a new row here + one factory entry, no adapter change.
 *
 * `reasoningOptions(effort)` returns the `streamText` `providerOptions` fragment that enables
 * extended thinking for that provider, keyed by the provider name the SDK expects
 * (`{ anthropic: {...} }`, `{ openai: {...} }`, …) — exactly the `ProviderOptions =
 * Record<string, JSONObject>` shape verified against the installed `ai@6.0.197` types — or
 * `undefined` when the provider has no reasoning knob (Ollama/openai-compatible: best-effort,
 * ignored). `cacheStrategy` is declared here now but CONSUMED in slice 5 (`context.ts`).
 *
 * Temperature handling is deliberately NOT a per-row field: ADR-0030 Decision 1 is a single
 * GLOBAL rule (omit `temperature` whenever `reasoningEffort` is set) applied in `mapParams`.
 */

/** The provider ids the capability table is keyed by (design §8). */
export type ProviderId = "anthropic" | "openai" | "google" | "openai-compatible";

/** One reasoning-effort level (mirrors `ModelTurnInput.params.reasoningEffort`). */
export type ReasoningEffort = "low" | "medium" | "high";

/** How a provider's prompt cache is engaged (consumed by `context.ts` in slice 5). */
export type CacheStrategy =
  | "anthropic-breakpoint"
  | "openai-cache-key"
  | "google-implicit"
  | "none";

/**
 * One row of the capability table. `reasoningOptions` is a function (not static data) so a
 * row can compute provider-native options from the effort level; it returns the `providerOptions`
 * fragment to merge, or `undefined` when the provider ignores reasoning.
 */
export interface ProviderCapability {
  /**
   * Whether this provider supports native tool calling via the SDK `tools` param (design §8).
   * All four built-in providers are `true`. This flag IS consumed by `VercelModelPort.stream()`:
   * when a turn carries `input.tools` AND this is `false`, the adapter **fails closed** — it
   * emits a single terminal `error` chunk (code `"tools-unsupported"`) and returns without
   * calling `streamText`, rather than silently falling back to text-parsing (which is not built).
   * There is no text-parse fallback in the `providers/` tree at any point (design §8 invariant).
   */
  readonly supportsNativeTools: boolean;
  /** Provider-native reasoning `providerOptions` for an effort level, or `undefined` to omit. */
  reasoningOptions(effort: ReasoningEffort): Record<string, unknown> | undefined;
  /** The prompt-caching strategy (declared now; consumed by `context.ts` in slice 5). */
  readonly cacheStrategy: CacheStrategy;
  /**
   * Billing weight of a cached input token relative to a fresh one, in `[0,1]` — the multiplier
   * the cost-aware budget (ADR-0044) applies to `cachedInputTokens` so the effective-cost cap is a
   * real dollar ceiling, not a raw token counter. `anthropic = 0.1` (ephemeral cache reads bill
   * ~0.1× of fresh input); every other provider is `1.0` (conservative) until its cache-read
   * multiplier is validated against real billing. Under-crediting cache (a weight nearer 1) only
   * ever stops a task EARLY — it can never overspend — which is why an unvalidated provider stays
   * at 1.0. Consumed by the kernel loop via the budget config (it is provider data, not a loop knob).
   */
  readonly cacheReadWeight: number;
  /**
   * Provider/model context window metadata used by the in-loop compactor's context-pressure gate.
   * Rows may return exact model overrides or provider-family conservative defaults. Return `undefined`
   * only when the row cannot make even a conservative prompt-budget claim; callers then fall back
   * visibly to the explicit env override or the global default. This is prompt-budget metadata only, not
   * billing truth.
   */
  contextWindowTokens(modelId?: string): number | undefined;
}

/**
 * Anthropic extended-thinking budget per effort, in tokens (design §8). First-guess defaults,
 * tunable in the §2.3 iteration loop without touching the contract (ADR-0030 Consequences).
 * Must stay `< maxOutputTokens` at the call site.
 */
const ANTHROPIC_THINKING_BUDGET: Record<ReasoningEffort, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
};

const OPENAI_CONTEXT_WINDOW_TOKENS = 128_000;
const OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW_TOKENS = 32_000;
const OPENAI_COMPATIBLE_CONTEXT_WINDOWS = new Map<string, number>([["laguna-fp8", 262_000]]);

function normalizedModelId(modelId: string | undefined): string | undefined {
  return modelId?.trim().toLowerCase();
}

/**
 * The capability table — one row per provider id. The structural home for divergence; the
 * adapter reads it and never branches on provider itself (ADR-0030).
 */
export const CAPABILITIES: Record<ProviderId, ProviderCapability> = {
  anthropic: {
    supportsNativeTools: true,
    reasoningOptions: (effort) => ({
      anthropic: { thinking: { type: "enabled", budgetTokens: ANTHROPIC_THINKING_BUDGET[effort] } },
    }),
    cacheStrategy: "anthropic-breakpoint",
    // Ephemeral cache reads bill ~0.1× of fresh input — Anthropic's published list-price ratio
    // ($0.30 cache-read / $3.00 fresh input on Sonnet 4.6), NOT an independently "validated" number.
    // Honest scope (Epic 1.14): the cache-read RATIO is now MEASURED end-to-end (92-95% on the TB-2.1
    // ledgers); this 0.1× COST WEIGHT is the list-price assumption it is checked against by
    // `assertCacheWeightConsistent` (the eval price↔weight drift guard), which fails CI if this and the
    // committed pricing disagree. (The earlier "validated" wording was inaccurate — there was no test.)
    cacheReadWeight: 0.1,
    contextWindowTokens: () => 200_000,
  },
  openai: {
    supportsNativeTools: true,
    // OpenAI's `reasoningEffort` takes the same low|medium|high vocabulary 1:1.
    reasoningOptions: (effort) => ({ openai: { reasoningEffort: effort } }),
    cacheStrategy: "openai-cache-key",
    // Conservative until OpenAI cache-read telemetry is validated against billing (ADR-0044).
    cacheReadWeight: 1.0,
    contextWindowTokens: () => OPENAI_CONTEXT_WINDOW_TOKENS,
  },
  google: {
    supportsNativeTools: true,
    // Gemini 3 uses `thinkingConfig.thinkingLevel` (low|medium|high). Gemini 2.5's numeric
    // `thinkingBudget` is model-keyed and out of scope for this slice (design §8 note).
    reasoningOptions: (effort) => ({ google: { thinkingConfig: { thinkingLevel: effort } } }),
    cacheStrategy: "google-implicit",
    cacheReadWeight: 1.0,
    contextWindowTokens: () => 200_000,
  },
  "openai-compatible": {
    // Local/Ollama: native tools are best-effort (per-model), with no reasoning knob and no
    // cache directive. Reasoning is silently ignored rather than forcing a non-standard option.
    supportsNativeTools: true,
    reasoningOptions: () => undefined,
    cacheStrategy: "none",
    cacheReadWeight: 1.0,
    contextWindowTokens: (modelId) => {
      const exact = OPENAI_COMPATIBLE_CONTEXT_WINDOWS.get(normalizedModelId(modelId) ?? "");
      return exact ?? OPENAI_COMPATIBLE_DEFAULT_CONTEXT_WINDOW_TOKENS;
    },
  },
};

/** The `streamText` option fragment `mapParams` produces — EXCLUDING the model (resolved by
 *  the port). Uses optional fields + `exactOptionalPropertyTypes`: a key is present only when
 *  it carries a value (no `undefined`-valued keys). */
export interface MappedParams {
  readonly providerOptions?: Record<string, unknown>;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

/**
 * Map the per-turn `ModelTurnInput.params` (the reasoning sandwich) onto the `streamText`
 * option fragment for a given provider capability — the ONE place per-turn generation params
 * become provider options (design §8). The model is resolved separately by the port (`params.model`
 * is intentionally ignored here).
 *
 * The rules (ADR-0030 Decision 1):
 * - **`reasoningEffort` set** → spread `capability.reasoningOptions(effort)` into `providerOptions`
 *   (when the row defines it) AND **omit `temperature` entirely** — current reasoning models reject
 *   any non-default temperature with a 400, so we send none and let the provider default apply.
 *   An explicit `params.temperature` is ignored in this case (reasoning wins).
 * - **`reasoningEffort` unset** → include `temperature` only when `params.temperature` is provided.
 * - **`maxOutputTokens`** → always included when provided (independent of reasoning).
 *
 * Conditional spreads keep every key value-bearing (no `undefined` keys under
 * `exactOptionalPropertyTypes`).
 */
export function mapParams(
  params: ModelTurnInput["params"],
  capability: ProviderCapability,
): MappedParams {
  if (params === undefined) return {};

  const maxTokens =
    params.maxOutputTokens !== undefined ? { maxOutputTokens: params.maxOutputTokens } : {};

  if (params.reasoningEffort !== undefined) {
    // Reasoning path: omit temperature entirely (ADR-0030); spread reasoning options if defined.
    const reasoning = capability.reasoningOptions(params.reasoningEffort);
    return {
      ...(reasoning !== undefined ? { providerOptions: reasoning } : {}),
      ...maxTokens,
    };
  }

  // No reasoning: temperature passes through when provided (0 is a valid value).
  return {
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...maxTokens,
  };
}
