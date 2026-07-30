# 0044 — Cost-aware multi-budget controller (effective tokens, not gross)

**Status:** accepted
**Date:** 2026-06-17
**Relates to:** §4.9.6 (scope budget / low-confidence stop — the in-loop budget concept) and
Appendix F (the benchmark per-run budget cap this enforces). Builds on ADR-0030 (the per-provider
capability table) and the conversation-prefix prompt caching landed in the prompt-cache implementation. Surfaced by the Epic
1.11 TB-2.1 efficiency autopsy.

## Context

The Epic 1.11 trajectory autopsy found two distinct efficiency problems that the single
gross-token budget (`usage.inputTokens + usage.outputTokens >= maxTokens`) conflated:

1. **Billing efficiency** — keel was caching only the static system prefix, so the growing
   conversation was re-sent uncached every turn (330–415k input on ~28-turn tasks). Fixed in the prompt-cache implementation
   by caching the settled conversation prefix: 90–97% cache-read across the tb25 subset.

2. **The budget then went misaligned with billing reality.** After caching, a task can hit a
   400k *gross*-token cap while only costing ~$0.30 — because most of those 400k tokens are
   near-free cached reads (~0.1× on Anthropic ephemeral). 7 of 9 tb25 tasks ended on `budget`;
   the gross cap was stopping cached-heavy tasks at a token count that was *mostly cheap cached
   history*, not real spend. The cap had become a token counter, not a cost ceiling.

A naive fix — "just count cached tokens at 0.1×" — is correct directionally but dangerous alone:
a purely cost-weighted cap lets a cheap, cached-heavy *failure* run until the wall-clock or
turn cap, converting cheap failures into long cheap failures. The honest model separates the
concerns a single number was hiding:

| Signal              | What it bounds                          |
| ------------------- | --------------------------------------- |
| Effective tokens    | **dollars** (the real cost ceiling)     |
| Gross tokens        | runaway / context churn (emergency cap) |
| Output tokens       | over-generation (the `circuit-fibsqrt` 73,668-output-token failure mode, ER-037) |
| Turns (existing)    | loop depth                              |

## Decision

Replace the single gross-token budget with a **cost-aware budget triad**, all enforced in the
kernel loop, all reporting `stop.reason = "budget"`:

1. **Effective-token budget (primary, `maxTokens`).** Stop when
   `effective(usage) >= maxTokens`, where

   ```
   effective(u) = max(0, u.inputTokens − cached) + cacheReadWeight · cached + u.outputTokens
   cached       = u.cachedInputTokens ?? 0
   ```

   `cacheReadWeight ∈ [0,1]` is **provider-supplied** — a new field on the capability table
   (ADR-0030), where `cacheStrategy` already lives. `anthropic = 0.1` (ephemeral cache reads bill
   ~0.1× of fresh input); all other providers `1.0` until their cache-read telemetry is validated.
   The loop's own default when no weight is supplied is **1.0** (conservative).

2. **Gross-token backstop (`maxGrossTokens`).** Stop when `inputTokens + outputTokens >=
   maxGrossTokens`. An emergency cap so a cached-heavy task cannot churn indefinitely on the
   effective budget alone. (Turns are the primary churn bound; this is extra insurance.)

3. **Output-token guard (`maxOutputTokens`).** Stop when `outputTokens >= maxOutputTokens`.
   Bounds over-generation (e.g. repeatedly emitting full-file `cat << EOF` rewrites).

### Why this is backward-compatible by construction

When `cachedInputTokens` is absent (the simulator, any non-caching provider), `cached = 0`, so
`effective(u) = inputTokens + outputTokens` — **identical** to the old gross check. Every existing
budget test passes unchanged; the semantics only change where the provider actually reports a
cache-read subset. This is the "use effective only when cached is available" rule from the
review, satisfied by the arithmetic rather than a conditional.

### Why `cacheReadWeight ≤ 1` never overspends

For any `weight ≤ 1`, `effective(u) ≤ gross(u)`, so at a fixed `maxTokens` the effective cap
fires *no earlier* than the gross cap would — a cached-heavy task gets proportionally more runway
because it is proportionally cheaper. Setting non-Anthropic providers to `1.0` until validated
means we only ever **under-credit** cache (stop early), never over-credit it (overspend).

### Honesty: gross is always recorded; attribution is reconstructed, not asserted

`run-finished` keeps reporting the full `usage` (input / output / cached) unchanged. Which of the
three ceilings fired is **reconstructable from that immutable record _together with the run's
configured caps_** (output ≥ `maxOutputTokens` → output; gross ≥ `maxGrossTokens` → gross; else
effective) — *the usage alone is not enough; you need the cap values it was checked against.* The
matrix runner has both (it sets the caps and reads the synced ledger), so the reconstruction's home
is the **eval outcome-parse / scoreboard layer**, not the generic trajectory reader (which sees the
usage but not the caps). It attributes the stop *from the ledger + run config*, not from model
self-report, and **without** changing the frozen `stop` event or `StopReason` schema. A schema-level
`budgetKind` discriminator is a possible later refinement (better for live UX / receipts than
reconstruction) — deferred as a frozen-schema change that this slice does not need.

## Scope (and explicit non-goals for this slice)

In: the three budgets above + the provider `cacheReadWeight` + env wiring
(`KEEL_MAX_TOKENS` now an *effective*-cost cap; new `KEEL_MAX_GROSS_TOKENS`,
`KEEL_MAX_OUTPUT_TOKENS`).

Out (deferred, with reasons):

- **`maxToolCalls` / stagnation detection** — these are *convergence* guards, not budgets; they
  belong with loop-detection (ADR-driven), and forcing them into a `"budget"` stop would be
  dishonest. The review agreed stagnation "can follow."
- **Large-heredoc / generated-artifact guard** — enforcement on tool *input* is warden territory
  (Phase 2). A Phase-1 prompt nudge is behavioral, not structural; we will not present one as an
  enforced guard, and we will not patch the system prompt from a single task's failure
  ("autopsy first").
- **`budgetKind` on the stop event** — reconstructable analytically (above); not worth a
  frozen-schema change yet.

## Consequences

- `KEEL_MAX_TOKENS` changes meaning from a *gross* to an *effective* (cost-true) cap. It is
  opt-in and unset by default, and for non-caching providers the two are identical, so the only
  observable change is the intended one: Anthropic cached-heavy tasks get cost-proportional
  runway. Documented at the env-wiring site and here.
- The default budget *values* (effective / gross / output) are first-guesses to be tuned by the
  Epic 1.11 A/B/C matrix on the tb25 subset, exactly as `cacheReadWeight` per non-Anthropic
  provider is to be tuned once its telemetry is validated. None of those numbers are contracts.
- The honest internal headline: **billing cost is fixed; the gross cap was miscalibrated; the cap
  is now a real cost ceiling.** Convergence efficiency (output discipline, churn/stagnation
  detection, replanning, targeted verification) is the next frontier — separate from this slice.
