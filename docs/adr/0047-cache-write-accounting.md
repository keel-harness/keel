# 0047 — Cache-write (cache_creation) token accounting

**Status:** ACCEPTED (Epic 1.14 cache-write accounting slice; maintainer-approved frozen-schema
change, merged in the accepted implementation 2026-06-19)
**Date:** 2026-06-18
**Relates to:** ADR-0030 (per-provider capability table / cache strategy), ADR-0044 (cost-aware
budget triad). Extends the `ModelUsage` shape frozen with `ModelPort` (ADR-0002/0019). Surfaced by
the Epic 1.14 cost/context diagnosis.

## Context

The Phase-0 diagnosis established that keel captures the cache-**read** subset
(`cachedInputTokens`) and feeds it to the effective-cost budget, but the cache-**creation/write**
count is captured **nowhere** — not in `ModelUsage`, not in the run ledger, not in the eval
records. On Anthropic, a cache write bills at **1.25×** a fresh input token (ephemeral 5-min TTL;
2× for the 1-hour TTL), so ignoring it means:

- the **eval real-cost meter** (`realCostUSD`, from the initial cost-reporting slice) slightly
  **under**-counts the true
  bill on cache-write-heavy turns (it prices the written tokens at the fresh-input rate, $3, not
  $3.75) — though with the measured 92–95% read ratio this is a small term; and
- the SDK already surfaces it: the pinned `@ai-sdk/anthropic@3.0.81` reports
  `cacheCreationInputTokens` on the finish part (verified in `node_modules`). keel just never reads it.

The whole Epic-1.14 thesis is "measure, don't assume." Leaving a real, available cost component
uncaptured is the same blind spot that produced the ~4× ledger inflation, in miniature.

## Decision

Capture `cacheCreationInputTokens` end-to-end as an **additive, optional** field — the same
pattern `cachedInputTokens` already uses, so non-Anthropic / non-caching providers and every
older record are unaffected:

1. **`ModelUsage`** (`@keel/shared`) gains `cacheCreationInputTokens?: number` (frozen-schema
   change — this ADR + an isolated PR). Backward-compatible: absent → omitted; older JSONL still
   parses.
2. **`chunks.ts`** reads `part.totalUsage.cacheCreationInputTokens` and records it on the finish
   usage only when present (mirrors the existing `cachedInputTokens` capture).
3. **The loop** accumulates it across turns (mirrors the `cachedInputTokens` sum) so the
   `run-finished` / `run_status` usage carries the cumulative write count.
4. **The eval cost meter** prices it: `realCostUSD` adds `cacheCreation × cacheWritePerMTok`
   ($3.75/M = 1.25× input on Sonnet 4.6); `RunStatusUsage` parses it from the synced ledger.

### What this does NOT change (deliberate, deferred to the spend-guard decision)

- **The effective-cost CAP (ADR-0044) is unchanged.** A written token still counts as **1.0×
  input** in `effectiveTokens`, not 1.25×. This means the cap can *under*-count true spend on a
  write-heavy turn by the 0.25× delta — the one direction the `effective ≤ gross` safety argument
  does not cover. We do **not** silently re-weight the cap here: changing a money-safety guard is
  ADR-0022 territory (a separate spend-guard sign-off). Until then the gross backstop
  (`maxGrossTokens`) and the conservative un-cached pre-spend estimate bound real spend, so this
  under-count cannot cause an unbounded overspend — only a modest cap-timing drift on a
  pathologically write-heavy turn.
- **No new security claim.** This is cost instrumentation.

## Consequences

- The `realCostUSD` **formula** becomes exact on the write side **when supplied a write count** — it
  can no longer mis-price a written token as fresh input. **Honest caveat (end-of-epic QC):** records
  captured *before* this change carry no `cacheCreationInputTokens`, so a figure computed from them
  still treats writes as 0 and remains a **read-only lower bound**. In particular the published
  historical nine-task calibration figure (~$5.25) predates write capture; its raw ledger is not
  distributed with the public source. The figure is a lower bound on the true bill, **not** the exact
  cost — the write-side correction is
  unverified-on-real-data until a fresh run records `cacheCreationInputTokens`. The residual "fully
  closes" only then, not at merge of this PR.
- One additive field on a frozen schema, justified + isolated here. The cap-weighting question
  (should a write cost 1.25× in the budget?) is explicitly handed to ADR-0022 with the data to
  decide it.
- The 1-hour-TTL knob (2× writes) and its break-even are out of scope here (a separate,
  measurement-gated decision).
