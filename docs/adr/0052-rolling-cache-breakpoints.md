# 0052 — Rolling Anthropic cache breakpoints (20-block-lookback-safe)

**Status:** ACCEPTED — implemented with TDD (metadata-only, behavior-preserving). Benefit (fewer full-prefix re-reads on high-fan-out turns) is a FORECAST until measured on a paid TB-2.1 run (see Consequences / follow-up).
**Date:** 2026-06-20
**Relates to:** conversation-prefix prompt caching (the prompt-cache implementation); ADR-0030 (per-provider capability table / `cacheStrategy`); ADR-0044 (cost-aware budget triad); ADR-0046 (cache-aware context reduction); ADR-0047 (cache-write accounting); Epic 1.14 (cache fidelity proven by CI). Refines `markAnthropicCachePoints` in `packages/kernel/src/providers/context.ts`. No change to a frozen interface, protocol, schema, audit format, or CLI contract — `cache_control` is billing-optimization metadata; message CONTENT and model behavior are unchanged.

## Context

the prompt-cache implementation made the Anthropic cache cover the whole settled **conversation prefix** by placing two `cache_control: {type:"ephemeral"}` breakpoints: one on the **leading system message** (the stable tools→system prefix) and one on the **last settled message** (so the growing conversation is read from cache next turn). This achieved 90–97% cache-read on the tb25 subset and is the fix for the "330–380k input on a 28-turn task" input-cost blow-up.

Auditing the implementation against Anthropic's published caching rules (`shared/prompt-caching.md`) surfaced a residual exposure the two-breakpoint design does not cover: **the cache lookback walks back at most 20 content blocks** from a breakpoint to find a prior cache entry. The system-head breakpoint always reads at offset 0 (so the tools+system prefix is safe every turn), but the *conversation* read depends on the new turn's tail breakpoint reaching the previous turn's tail breakpoint within 20 blocks.

In an agentic loop a **single turn can append far more than 20 blocks** — one assistant message plus many parallel tool-result messages. When a turn appends >20 blocks, turn N+1's tail breakpoint can no longer reach turn N's tail breakpoint, and the **entire conversation prefix misses cache** and is re-sent at full price (~10× the cached cost). The pinned head breakpoint does not help: in any non-trivial conversation it sits far more than 20 blocks behind the tail. So the original blow-up reproduces precisely on heavy-fan-out turns — exactly the turns where the conversation is largest and a miss hurts most.

Anthropic's own guidance for long agentic turns is to "place an intermediate breakpoint every ~15 blocks," and to use the full **4-breakpoint** budget (keel was using 2).

## Decision

Replace the fixed head+tail pair with **head (pinned) + rolling, block-spaced breakpoints over the recent suffix**, within Anthropic's 4-breakpoint cap:

1. **Pin the leading system message** (when present) — the most stable, highest-hit prefix; always readable at lookback offset 0 regardless of conversation length.
2. **Spend the remaining budget rolling backward from the last message:** place a breakpoint on the tail (the newest write point), then step back and place another each time ~15 estimated content blocks accumulate, until the budget (≤4 total) is spent. `ROLLING_BLOCK_SPACING = CACHE_LOOKBACK_BLOCKS − 5` so the margin absorbs the block count of the single message that crosses the threshold (a tool result is 1 block; an assistant turn is 1 + its tool calls).
3. **Estimate blocks from the mapped SDK message** (string content = 1; array content = its length). A safe estimate suffices — it only paces spacing, and overestimating merely places breakpoints sooner (still ≤4).

Consequences of the algorithm that matter:

- **Short conversations are unchanged.** Below ~15 blocks of suffix there is no >20-block gap to bridge, so it collapses to exactly the prior head+tail pair (2 breakpoints). The change only activates where the miss actually occurs.
- **Cache writes are not multiplied.** The suffix is written once regardless; extra breakpoints add only READ points within that already-written span — this is *why* Anthropic recommends incremental breakpoints. No new write cost.
- **Deterministic + pure.** Placement is a pure function of the message list; no I/O, no state, no timestamps/IDs. The stable-prefix discipline (ADR-0046 §3) is preserved — the head marker never moves and content is never mutated.
- **Documented limit:** a single message that *alone* exceeds the 20-block lookback (≥20 parallel tool calls in one assistant message) cannot be sub-divided at message granularity. This is rare and is not a regression over head+tail (which handled it no better); block-level breakpoints would be the future fix if a trajectory ever shows it.

## Alternatives considered

- **Last-N-message clustering (mark the last 3 messages).** Rejected: clustering near the tail adds redundant near-tail read points but does *not* place a breakpoint within 20 blocks of the *previous* tail on a heavy-fan-out turn, so it does not fix the binding miss. Block-spacing does.
- **1-hour TTL on the system prefix** (`ttl:"1h"`, supported by `@ai-sdk/anthropic@3.0.81`). Deferred as a separate, measured decision: it is a write-cost tradeoff (2× vs 1.25×) that should be validated against real long-turn ledgers, not bundled into a behavior-preserving metadata change. Tracked as a follow-up.

## Consequences

- **+** Removes the heavy-fan-out cache-miss exposure left by the prompt-cache implementation; keeps consecutive read-points inside the 20-block lookback so a large turn caches incrementally.
- **+** Uses the full 4-breakpoint budget at no extra write cost; strictly dominates the old 2-breakpoint scheme (head+tail are still marked).
- **+** No behavior/contract/audit change; wire-level + property tests lock the new invariant (≤4 breakpoints; consecutive rolling gaps ≤20 blocks) and the unchanged short-conversation behavior.
- **−** The benefit is a forecast until a paid ablation measures cache-read% on high-fan-out trajectories (mirrors ADR-0046's honesty stance). The mechanism is proven by CI; the dollar/latency win is not yet.
- **−** Block count is estimated (message-granularity), so the ≤20 guarantee assumes the crossing message is ≤5 blocks; pathological single messages are a documented, rare exception.
