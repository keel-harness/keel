import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { VercelModelPort } from "./vercel-model-port.js";
import type { StreamTextFn } from "./vercel-model-port.js";
import { CAPABILITIES } from "./capabilities.js";
import type { CacheTtl } from "./context.js";

/**
 * Options for building an Anthropic-backed `ModelPort`. `apiKey` is the key resolved by
 * `resolveApiKey` (the `0600` secret store, then the env var — Epic 1.9); it falls through to the
 * SDK's `ANTHROPIC_API_KEY` env default only when omitted. (Ledger redaction is SEC-014, also Epic 1.9.)
 * `streamText` is the transport seam: injected only in tests, so the real network model
 * is never hit (mirrors `SearchToolDeps.spawn`).
 *
 * `maxRetries` is the bounded transport-retry count (slice 6, ADR-0028 §1): the SDK re-issues
 * the provider HTTP request on a classified-transient failure (408/409/429/5xx, honoring
 * Retry-After), never re-executing a tool. Omitted → the adapter default of 2; `0` disables it.
 *
 * `fetch` is the FAITHFUL transport seam for retry tests: the SDK's `createAnthropic` accepts a
 * custom `fetch` (the provider's own documented testing hook), so a test injects a mock that
 * returns scripted HTTP `Response`s with NO network — letting the SDK's REAL retry loop run
 * against the real `streamText` (in contrast to the coarser `streamText` mock used elsewhere).
 * In production it is omitted and the SDK uses the global `fetch`.
 */
export interface AnthropicModelPortOptions {
  readonly model: string;
  readonly apiKey?: string;
  readonly streamText?: StreamTextFn;
  readonly maxRetries?: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Ephemeral cache TTL (the `KEEL_CACHE_TTL` lever); omitted → `"5m"`. See `context.ts` `CacheTtl`. */
  readonly cacheTtl?: CacheTtl;
}

/**
 * Build a `VercelModelPort` backed by an Anthropic `LanguageModel`. Minimal by design: it
 * constructs the provider, supplies a `buildModel = (id) => anthropic(id)` resolver (so a
 * per-turn `params.model` override re-selects an Anthropic model — design §8), the default
 * model id, the Anthropic capability row (reasoning mapping + native tools + cache strategy),
 * and the bounded transport-retry count (`maxRetries`, slice 6). A test-injected `fetch` flows
 * into `createAnthropic` so the SDK's real retry loop can run with no network.
 */
export function createAnthropicModelPort(opts: AnthropicModelPortOptions): VercelModelPort {
  // Conditional spreads keep every key value-bearing under exactOptionalPropertyTypes.
  const anthropic = createAnthropic({
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });
  return new VercelModelPort(
    {
      defaultModelId: opts.model,
      buildModel: (id) => anthropic(id),
      capability: CAPABILITIES.anthropic,
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(opts.cacheTtl !== undefined ? { cacheTtl: opts.cacheTtl } : {}),
    },
    opts.streamText !== undefined ? { streamText: opts.streamText } : {},
  );
}

/**
 * Options for building an OpenAI-backed `ModelPort`. `apiKey` is resolved by `resolveApiKey` (the
 * `0600` secret store, then the env var — Epic 1.9); it falls through to the SDK's `OPENAI_API_KEY`
 * env default only when omitted.
 * `streamText` and `fetch` are the transport seams: injected only in tests (no network).
 * `maxRetries` is the bounded transport-retry count (ADR-0028 §1): `0` disables it.
 */
export interface OpenAIModelPortOptions {
  readonly model: string;
  readonly apiKey?: string;
  readonly streamText?: StreamTextFn;
  readonly maxRetries?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Build a `VercelModelPort` backed by an OpenAI `LanguageModel`. Mirrors
 * `createAnthropicModelPort` exactly: constructs the provider, wires `buildModel`, sets the
 * default model id, uses the `openai` capability row (reasoning via `reasoningEffort`,
 * native tools, openai-cache-key strategy), and threads `maxRetries` + `fetch`.
 */
export function createOpenAIModelPort(opts: OpenAIModelPortOptions): VercelModelPort {
  const openai = createOpenAI({
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });
  return new VercelModelPort(
    {
      defaultModelId: opts.model,
      buildModel: (id) => openai(id),
      capability: CAPABILITIES.openai,
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    },
    opts.streamText !== undefined ? { streamText: opts.streamText } : {},
  );
}

/**
 * Options for building a Google Generative AI-backed `ModelPort`. `apiKey` falls through to
 * the SDK's `GOOGLE_GENERATIVE_AI_API_KEY` env default when omitted.
 * `streamText` and `fetch` are the transport seams: injected only in tests (no network).
 * `maxRetries` is the bounded transport-retry count (ADR-0028 §1): `0` disables it.
 */
export interface GoogleModelPortOptions {
  readonly model: string;
  readonly apiKey?: string;
  readonly streamText?: StreamTextFn;
  readonly maxRetries?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Build a `VercelModelPort` backed by a Google Generative AI `LanguageModel`. Mirrors
 * `createAnthropicModelPort`: constructs the provider, wires `buildModel`, sets the default
 * model id, uses the `google` capability row (reasoning via `thinkingConfig.thinkingLevel`,
 * native tools, google-implicit cache strategy), and threads `maxRetries` + `fetch`.
 */
export function createGoogleModelPort(opts: GoogleModelPortOptions): VercelModelPort {
  const google = createGoogleGenerativeAI({
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });
  return new VercelModelPort(
    {
      defaultModelId: opts.model,
      buildModel: (id) => google(id),
      capability: CAPABILITIES.google,
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    },
    opts.streamText !== undefined ? { streamText: opts.streamText } : {},
  );
}

/**
 * Options for building an OpenAI-compatible (local/Ollama) `ModelPort`. `baseURL` is required
 * (e.g. `"http://localhost:11434/v1"` for Ollama). `name` is the provider label passed to the
 * SDK (`"openai-compatible"` by default). `apiKey` is optional — Ollama ignores it; other
 * local endpoints may require a token. `streamText` and `fetch` are the transport seams.
 * `maxRetries` is the bounded transport-retry count (ADR-0028 §1): `0` disables it.
 */
export interface OpenAICompatibleModelPortOptions {
  readonly model: string;
  readonly baseURL: string;
  readonly name?: string;
  readonly apiKey?: string;
  readonly streamText?: StreamTextFn;
  readonly maxRetries?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Build a `VercelModelPort` backed by an OpenAI-compatible `LanguageModel` (local / Ollama /
 * any OpenAI-API endpoint). Mirrors `createAnthropicModelPort`: constructs the provider via
 * `createOpenAICompatible({ name, baseURL })`, wires `buildModel`, sets the default model id,
 * and uses the `openai-compatible` capability row — which returns `undefined` from
 * `reasoningOptions` (reasoning is silently ignored, no standard reasoning knob), supports
 * native tools best-effort, and applies no cache strategy. Threads `maxRetries` + `fetch`.
 */
export function createOpenAICompatibleModelPort(
  opts: OpenAICompatibleModelPortOptions,
): VercelModelPort {
  const provider = createOpenAICompatible({
    name: opts.name ?? "openai-compatible",
    baseURL: opts.baseURL,
    // vLLM/OpenAI-compatible streams often omit usage unless explicitly requested. The installed
    // provider maps this setting to `stream_options: { include_usage: true }`.
    includeUsage: true,
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });
  return new VercelModelPort(
    {
      defaultModelId: opts.model,
      buildModel: (id) => provider(id),
      capability: CAPABILITIES["openai-compatible"],
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    },
    opts.streamText !== undefined ? { streamText: opts.streamText } : {},
  );
}
