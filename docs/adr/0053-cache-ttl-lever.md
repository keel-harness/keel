# 0053 — `KEEL_CACHE_TTL` lever (opt-in 1-hour Anthropic cache TTL)

**Status:** ACCEPTED — implemented with TDD (default `"5m"` is byte-identical to the pre-lever wire). Whether `"1h"` is net-cost-positive on real workloads is a FORECAST until measured (see Consequences).
**Date:** 2026-06-20
**Relates to:** ADR-0052 (rolling cache breakpoints — deferred this TTL as a "separate, measured decision"); ADR-0030 (per-provider capability table / `cacheStrategy`); ADR-0044 (cost-aware budget); ADR-0046 (cache-aware reduction — "prefer content near the 5-min cache-TTL expiry"); ADR-0050/0051 (long bash turns / wall-clock budget — the long-turn evidence motivating this). No frozen interface/protocol/schema/audit/CLI-contract change — adds one optional env knob and an optional `ttl` field on the existing message-level `cache_control` metadata.

## Context

Anthropic ephemeral cache entries default to a **5-minute TTL**. keel's prompt cache (the prompt-cache implementation, ADR-0052) reads the stable system prefix and the conversation prefix from cache every turn — but only while those entries are alive. Two now-shipped realities make the 5-minute window a real exposure:

- **Long single turns.** ADR-0050 (bash keep-alive) and ADR-0051 (wall-clock budget) exist precisely because individual turns can run minutes (long builds, test suites, slow tools). A turn whose model-thinking + tool-execution exceeds 5 minutes lets the prior conversation/system cache expire, so the *next* turn re-writes the whole prefix at full price — the exact blow-up the caching work was meant to prevent, reappearing on the time axis.
- **Idle gaps.** An interactive session where the user steps away for >5 minutes cold-starts the prefix on return.

Anthropic offers a **1-hour TTL** (`cache_control: {type:"ephemeral", ttl:"1h"}`, supported by the installed `@ai-sdk/anthropic@3.0.81` — verified in its type schema). The tradeoff is write cost: a 1h cache **write** bills **2×** base input vs **1.25×** for 5m, so it pays off only across enough reads (break-even ~3 requests vs ~2 for 5m). ADR-0052 deliberately deferred this as "a write-cost tradeoff to measure on long-turn ledgers, not bundled into the default."

## Decision

Add **`KEEL_CACHE_TTL`** — an env-gated lever, **default `"5m"`**, accepting `"5m" | "1h"`:

1. **Default is byte-identical to before.** Unset or `"5m"` emits `cache_control: {type:"ephemeral"}` with **no `ttl` field** — preserving the exact pre-lever wire bytes (and therefore cache continuity and every existing test). Only `"1h"` adds `ttl:"1h"`.
2. **Uniform across breakpoints.** When `"1h"`, every ephemeral breakpoint (pinned system head + rolling suffix points) carries the 1h TTL. Rationale: cache *creation* is billed only on the small new suffix written each turn, while the *read* benefit (surviving a >5-min turn or gap) covers the whole prefix — so uniform 1h is the simplest net-positive shape for the long-task scenario an operator opts into, and a single TTL trivially satisfies Anthropic's "longer-TTL breakpoints must precede shorter ones" ordering rule.
3. **Anthropic-only, fail-loud parse.** The lever is consumed only by the `anthropic-breakpoint` strategy (other providers ignore it). An invalid value throws at config resolution (`resolveModelConfig`) rather than silently falling back to 5m — a cost-behavior surprise must be loud.
4. **Threaded as data, not read deep.** `KEEL_CACHE_TTL` → `resolveModelConfig` (validate) → `createModelPort`/factory → `VercelModelPortConfig.cacheTtl` → `assembleContext({cacheTtl})` → `markAnthropicCachePoints` → `withEphemeralCache`. `context.ts` stays pure (no env reads) — the tested invariant is preserved.

## Alternatives considered

- **1h on the system head only, 5m on rolling conversation breakpoints.** Defensible (the head is the most-reused, most-stable chunk), but more complex and it leaves the long-*turn* conversation-miss unaddressed (the conversation prefix would still expire at 5m during a long turn). Uniform 1h covers both; the extra write cost is small (incremental suffix only). Kept uniform for simplicity and to actually fix the long-turn case.
- **Make 1h the default.** Rejected — it changes cost characteristics for everyone without measurement, and contradicts ADR-0052's measured-not-defaulted stance. Default stays 5m.

## Consequences

- **+** An operator running long-turn or bursty workloads (e.g. the TB-2.1 harbor eval with long builds) can set `KEEL_CACHE_TTL=1h` to stop losing the cache across the 5-minute boundary — directly complementing ADR-0050/0051.
- **+** Default behavior and wire bytes are unchanged; fully reversible; the knob is the measurement surface for an A/B against the cache-read% already recorded by the eval matrix (ADR-0044 telemetry).
- **+** Honest-by-construction: invalid values fail loudly; `"5m"` and unset are indistinguishable on the wire.
- **−** Whether `"1h"` is net-cost-positive depends on the workload's turn cadence and length — it is a FORECAST until measured (mechanism proven by CI: the wire test asserts `ttl:"1h"` serializes and that the default emits no `ttl`). For continuous sub-5-minute-turn loops, `"1h"` is mild extra write cost with no read benefit; leave it at the 5m default there.
