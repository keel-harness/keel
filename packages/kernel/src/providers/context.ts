import type { ModelMessage } from "ai";
import type { ModelMessageT } from "@keel/shared";
import { toSdkMessages } from "./messages.js";
import type { CacheStrategy } from "./capabilities.js";

type ToolNameMapper = (name: string) => string;

/**
 * Cache-stable context assembly (design §8 "Caching"; §16 local non-goal).
 *
 * Provider prompt-caching is a **prefix match**: the stable leading prefix (the system
 * prompt; tools render before it at the SDK layer) must stay byte-identical across turns,
 * and any byte change in the prefix invalidates the cache from that point on. This unit's
 * one job is to (a) keep the system message(s) leading and byte-stable while the conversation
 * grows strictly *after* them, and (b) apply the per-provider cache directive the capability
 * table declares (`cacheStrategy`). It is pure — no I/O, no state.
 *
 * **What this slice does NOT do (design §16):** decide what belongs in each tier — compaction,
 * summarization, eviction. That is Epic 1.6. Here we only *order* (system leads; conversation
 * follows, untouched) and *mark* (the cache directive).
 *
 * ## Per-strategy directive (verified against ai@6.0.197 / @ai-sdk/anthropic@3.0.81)
 *
 * - **`anthropic-breakpoint`** — message-level. The Anthropic provider reads the cache
 *   breakpoint from a message's `providerOptions.anthropic.cacheControl`
 *   (`convertToAnthropicMessagesPrompt` → `getCacheControl(providerMetadata.anthropic.cacheControl)`),
 *   so we attach `{ type:"ephemeral" }` to (a) the **leading system message** (the stable tools→system
 *   prefix — highest hit rate, always readable at lookback offset 0) and (b) **rolling breakpoints
 *   over the recent suffix**, spaced inside Anthropic's 20-block cache lookback so a high-fan-out turn
 *   still caches incrementally. Because the conversation is append-only, these markers are byte-stable
 *   next turn, so the next request reads the prior conversation from cache (~0.1× input) instead of
 *   re-sending it at full price. ≤4 breakpoints (Anthropic's cap). These are *message-level* directives,
 *   so they never collide with the call-level reasoning `providerOptions` from `mapParams` (slice 4) —
 *   they live on different objects. See `markAnthropicCachePoints` for the rolling-breakpoint rationale.
 *
 * - **`openai-cache-key`** — call-level, opt-in. OpenAI auto-caches the stable prefix
 *   regardless; the key only *pins routing* to the same cache shard. We emit the call-level
 *   `providerOptions: { openai: { promptCacheKey } }` ONLY when a `cacheKey` is supplied; with
 *   no key we emit nothing and rely on OpenAI's automatic prefix caching.
 *
 * - **`google-implicit`** — nothing to set. Gemini caches implicitly on a stable prefix; the
 *   byte-stable ordering above is the whole mechanism.
 *
 * - **`none`** — local/openai-compatible has no cache; no directive.
 *
 * The system message stays a *message* (not the SDK's top-level `system` string) precisely so
 * the Anthropic `cacheControl` can attach to it — moving it to `system` would leave nowhere to
 * place the breakpoint. The resulting system-in-messages SDK warning is suppressed at the call
 * site via `allowSystemInMessages` (see `VercelModelPort.stream()`).
 */

/**
 * Cache time-to-live for Anthropic ephemeral breakpoints (the `KEEL_CACHE_TTL` lever). `"5m"` is the
 * default and is byte-identical to omitting `ttl` (Anthropic's default ephemeral TTL); `"1h"` keeps the
 * cached prefix alive across longer gaps — a long tool turn (ADR-0050/0051) or an idle pause that would
 * otherwise expire a 5-minute entry and force a full re-write. Cost tradeoff: a 1h cache WRITE bills 2×
 * vs 1.25× for 5m (Anthropic), so it pays off only across enough reads — opt-in + measurable, not the
 * default (ADR-0052 deferred this as a measured lever). Consulted only by `anthropic-breakpoint`.
 */
export type CacheTtl = "5m" | "1h";

/** Input to the assembler. `cacheKey` is consulted only by the `openai-cache-key` strategy. */
export interface AssembleContextInput {
  readonly messages: readonly ModelMessageT[];
  readonly cacheStrategy: CacheStrategy;
  /** Optional stable routing key for `openai-cache-key`; ignored by every other strategy. */
  readonly cacheKey?: string;
  /** Ephemeral cache TTL for `anthropic-breakpoint`; default `"5m"` (omit `ttl`). Ignored elsewhere. */
  readonly cacheTtl?: CacheTtl;
  /** Optional provider-boundary projection for historical assistant/tool tool names. */
  readonly mapToolName?: ToolNameMapper;
}

/**
 * The pieces `VercelModelPort.stream()` needs: the SDK `messages` (with any message-level cache
 * marker applied) and the optional call-level `providerOptions` cache directive. `providerOptions`
 * is present ONLY when a strategy produces a call-level directive (currently `openai-cache-key`
 * with a `cacheKey`) — omitted otherwise, so it never introduces an `undefined`-valued key under
 * `exactOptionalPropertyTypes`, and merges cleanly with the reasoning `providerOptions`.
 */
export interface AssembledContext {
  readonly messages: ModelMessage[];
  readonly providerOptions?: Record<string, unknown>;
}

/** Attach an Anthropic ephemeral cache-control breakpoint to a message, MERGING into any existing
 *  providerOptions (so a per-message directive from elsewhere is preserved) and never touching the
 *  message CONTENT — caching is metadata-only. The `ttl` field is emitted ONLY for `"1h"`; `"5m"` and
 *  the default both omit it, keeping the marker byte-identical to the pre-lever wire (cache continuity).
 *  Returns a new message (the original is not mutated). */
function withEphemeralCache(m: ModelMessage, ttl?: CacheTtl): ModelMessage {
  const prior = m.providerOptions ?? {};
  const priorAnthropic = (prior as { anthropic?: Record<string, unknown> }).anthropic ?? {};
  const cacheControl = ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
  return {
    ...m,
    providerOptions: {
      ...prior,
      anthropic: { ...priorAnthropic, cacheControl },
    },
  };
}

/** Anthropic allows at most 4 `cache_control` breakpoints per request. */
const ANTHROPIC_MAX_BREAKPOINTS = 4;

/**
 * Anthropic's cache lookback walks back AT MOST 20 content blocks from a breakpoint to find a prior
 * cache entry (shared/prompt-caching.md "20-block lookback window"). We place rolling breakpoints
 * ~every {@link ROLLING_BLOCK_SPACING} blocks so consecutive read-points stay strictly inside this
 * window — the margin (20 − 15) absorbs the block count of the single message that crosses the
 * threshold (typically 1–2 blocks; a tool result is 1, an assistant turn is 1 + its tool calls).
 */
const CACHE_LOOKBACK_BLOCKS = 20;
const ROLLING_BLOCK_SPACING = CACHE_LOOKBACK_BLOCKS - 5;

/**
 * Content blocks an SDK message occupies on the Anthropic wire — string content is one block; array
 * content (assistant text + tool-call parts, tool-result parts) is its length. A safe estimate is all
 * we need: it only paces breakpoint spacing, and overestimating merely places breakpoints sooner
 * (still ≤4). One message that alone exceeds the lookback (≥20 parallel tool calls) cannot be
 * sub-divided at message granularity — a rare, documented limit, not a regression over head+tail.
 */
function blockCount(m: ModelMessage): number {
  return typeof m.content === "string" ? 1 : Math.max(1, m.content.length);
}

/**
 * Place Anthropic cache breakpoints so the longest STABLE prefix is cache-read every turn, robust to
 * high-fan-out turns:
 *  - the **leading system message** (system + tools — the most stable prefix; pinned, always readable
 *    at lookback offset 0 regardless of conversation length), and
 *  - **rolling breakpoints over the recent suffix**: walking back from the last message, a breakpoint
 *    is placed at the tail and then every ≥{@link ROLLING_BLOCK_SPACING} content blocks until the
 *    4-breakpoint budget is spent.
 *
 * Why rolling, not just head+tail: a single agentic turn can append far more than 20 blocks (one
 * assistant message + many parallel tool results). With only a fixed head+tail pair, the gap from the
 * new tail back to the previous turn's tail exceeds the 20-block lookback, so the WHOLE conversation
 * prefix misses cache and is re-sent at full price — the "330–380k input on a 28-turn task" blow-up.
 * Keeping consecutive read-points inside the lookback window means even a heavy-fan-out turn caches
 * incrementally. For short conversations the spacing never triggers, so this collapses to exactly the
 * prior head+tail pair (2 breakpoints) — no change where there was no gap to bridge.
 *
 * Cost note: extra breakpoints do NOT multiply cache writes — the suffix is written once regardless;
 * breakpoints only add READ points within that written span (Anthropic's own multi-turn guidance
 * recommends incremental breakpoints for exactly this reason). Metadata-only: message CONTENT is never
 * altered, so model behavior is unchanged — only billing/latency improve. Returns a new array.
 */
function markAnthropicCachePoints(messages: ModelMessage[], ttl?: CacheTtl): ModelMessage[] {
  if (messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  const marks = new Set<number>();

  // Pin the stable system head (tools→system prefix). Its breakpoint reads at offset 0 every turn.
  const hasSystemHead = messages[0]?.role === "system";
  if (hasSystemHead) marks.add(0);

  // Spend the remaining budget on rolling breakpoints over the suffix, newest first. Never place one
  // on the pinned head slot. Place the tail unconditionally (the newest write point), then step back
  // ~ROLLING_BLOCK_SPACING blocks at a time so each gap stays inside the lookback window.
  let rollingBudget = ANTHROPIC_MAX_BREAKPOINTS - marks.size;
  const floor = hasSystemHead ? 1 : 0;
  let blocksSinceMark = 0;
  let tailPlaced = false;
  for (let i = lastIdx; i >= floor && rollingBudget > 0; i--) {
    blocksSinceMark += blockCount(messages[i]!);
    if (!tailPlaced) {
      marks.add(i);
      rollingBudget -= 1;
      tailPlaced = true;
      blocksSinceMark = 0;
      continue;
    }
    if (blocksSinceMark >= ROLLING_BLOCK_SPACING) {
      marks.add(i);
      rollingBudget -= 1;
      blocksSinceMark = 0;
    }
  }

  return messages.map((m, i) => (marks.has(i) ? withEphemeralCache(m, ttl) : m));
}

/**
 * Assemble a cache-stable SDK prompt: map keel messages to SDK messages (keeping the system
 * prefix leading and byte-stable), then apply the per-provider cache directive. See the module
 * doc-block for the per-strategy mechanism.
 */
export function assembleContext(input: AssembleContextInput): AssembledContext {
  // The conversation order is already correct: the system message(s) lead and the growing
  // conversation follows. toSdkMessages preserves order and never interleaves, so the leading
  // system prefix is byte-stable turn over turn (the cache-hit precondition).
  const mapped = toSdkMessages(input.messages, input.mapToolName);

  switch (input.cacheStrategy) {
    case "anthropic-breakpoint":
      // Message-level breakpoints: pinned system head + rolling suffix breakpoints (cache the growing
      // conversation prefix, not just the static system prefix), at the configured TTL. No call-level
      // directive.
      return { messages: markAnthropicCachePoints(mapped, input.cacheTtl) };

    case "openai-cache-key":
      // Call-level routing key — ONLY when one is supplied; otherwise rely on auto prefix caching.
      return input.cacheKey !== undefined
        ? { messages: mapped, providerOptions: { openai: { promptCacheKey: input.cacheKey } } }
        : { messages: mapped };

    case "google-implicit":
    case "none":
      // Implicit (Gemini) or absent (local): nothing to mark; the stable ordering is enough.
      return { messages: mapped };
  }
}
