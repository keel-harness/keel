# 0046 — Cache-aware context reduction (fold + deterministic compression)

**Status:** accepted + SHIPPED — model + `cache-gain` guard merged (the cache-gain implementation); the cache-aware RUNWAY *trigger* it governs is wired + merged in **the production-wiring implementation** (env-gated `KEEL_COMPACTION` default-OFF; ER-021 resolved). The guard is a FORECAST — its cost/runway benefit is unproven until the paid ablation measures it (ER-042). See ADR-0049.
**Date:** 2026-06-18
**Relates to:** conversation-prefix prompt caching (the prompt-cache implementation) + its `cachedInputTokens` telemetry; ADR-0044
(cost-aware multi-budget controller); ER-038 (runway is the binding constraint); `MASTER_SPEC.md` §4.7
(context lifecycle & compaction); ADR-0025 (compaction); the `compact()` fold (Epic 1.6b) and the
deterministic compression pass (Epic 1.6c, Amendment A). Paired with **ADR-0045**.

## Context

the prompt-cache implementation made caching cover the whole settled **conversation prefix** (breakpoints on the leading system
message and the last settled message), achieving 90–97% cache-read on the tb25 subset. Any context-
reduction step that **rewrites the prefix** therefore busts the cache from the rewrite point forward:
you pay ~1.25× to re-write the suffix and lose the ~0.1× cached read. **Both** reduction tiers do this
— the `compact()` fold rewrites everything after the pinned prefix (the larger rewrite), and the Epic
1.6c deterministic pass rewrites aged tool bodies in place.

Two findings reframe the trade-off: (a) ER-038 — the binding constraint is **runway (gross context
tokens)**, not effective cost; (b) the prompt-cache implementation and ADR-0044 — effective cost is now dominated by cheap cached reads,
and the gross-token budget cap had to be re-expressed in cost terms. So reduction's job is to **extend
runway** while **not regressing the cache cost win**. A token-only net-gain guard ("shrink whenever over
budget") ignores the cache-rewrite cost and can be cost-negative.

## Decision

Reduction tiers must be **cache-aware**, governed uniformly across the fold and the deterministic pass:

1. **Gate on a cache+runway net-gain**, not raw token reduction: rewrite only when
   `expected_remaining_cached_reads × per-turn_token_saving > cache_rewrite_cost` (Anthropic break-even
   ≈ `11.5 × suffix_tokens / tokens_saved`, from 1.25× write / 0.1× read), computed from the prompt-cache implementation's
   `cachedInputTokens` telemetry.
2. **Rewrite infrequently and in larger chunks** so the one-time rewrite amortizes over many subsequent
   cached reads; **prefer content near the 5-min cache-TTL expiry** (it will be re-cached anyway).
3. Keep a **stable-prefix discipline** so reduction does not gratuitously move the cache boundary.

The detailed thresholds and the shared trigger are designed with the epic-1.14 cache-cost
instrumentation; Epic 1.6c's runner-wiring and guard slice is sequenced behind that work, while its
cache-independent parts (schema/ADR-0045 + compressor units + eval gate) proceed in parallel.

## Consequences

- **+** Protects the prompt-cache implementation's cost reduction while still extending runway (the binding constraint).
- **+** One coherent policy for both reduction tiers, instead of a cache-oblivious fold plus a
  cache-oblivious pass.
- **−** Couples the reduction trigger to cache telemetry (epic 1.14) and adds cost-modeling to a path
  that was pure token-counting.
- **−** Requires the stable-prefix discipline to be specified and tested (a follow-on to the prompt-cache implementation).
