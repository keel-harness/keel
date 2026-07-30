# 0048 — Spend-guard recalibration onto real (cache-discounted) cost

**Status:** ACCEPTED — **Option A**, signed off by the maintainer 2026-06-18 (money-safety guard,
ADR-0022). Implemented in the Epic 1.14 spend-ledger real-cost slice. The options analysis
below is retained as the decision record; the **Decision** section states what was chosen and why.
**Relates to:** ADR-0022 ($25/run · $300/mo benchmark caps), ADR-0044 (cost-aware budget triad),
ADR-0047 (cache-write capture). Builds on the Epic 1.14 honest cost meter (`realCostUSD`).

## Decision (signed off 2026-06-18) — Option A

The maintainer reviewed this ADR and the independent verification of the Epic 1.14 must-fixes and
chose **Option A now; Option B deferred** until a conservative cache-hit floor is measured across ≥3
seeds (the paid ablation — pre-registered, **not yet run**). The three open questions are answered:

1. **`monthToDateUSD` accumulates REAL cost now (Option A).** The monthly accumulator prefers each
   record's `realCostUSD`, falling back to `costUSD` (the conservative un-cached UB) for legacy
   records — so the rollover never *under*-counts history.
2. **The `$25/run · $300/mo` caps are denominated in REAL dollars** (so A/B, never C). The phantom 4×
   ledger inflation is removed from the *accumulator*.
3. **`SpendRecord` gains an ADDITIVE `realCostUSD`; `costUSD` is KEPT as the conservative UB** (not
   redefined). New records carry both; the accumulator sums `realCostUSD ?? costUSD`.

**The two money-safety GUARD points stay pessimistic and unchanged.** The per-run pre-spend check
still rides the un-cached UB estimate (`estimateBenchmarkCostUB`), and the post-spend `actual ≤
estimate` backstop still rides the UB actual — the discounted real figure is the monthly-accumulator
and reporting input only, **never** a license to overspend on a single run. Every invariant in
"The money-safety invariants that MUST survive any change" below is preserved (verified by tests:
the backstop halts on the UB even when the real figure is tiny; the legacy fallback refuses a run
that real history would admit). Moving the **pre-spend estimate** onto a measured cache-floor is the
separate Option B, gated on the deferred paid ablation.

## Context

The diagnosis showed the eval spend path over-states real $ by **~4×**: both the pre-spend
estimate (`estimateBenchmarkCostUB`) and the recorded actual (`measureBenchmarkCost`) price input
at the full **un-cached** rate, ignoring the measured 92–95% cache discount. Two consequences:

1. **The recorded ledger over-counts.** `monthToDateUSD` accumulates ~4× the real bill, so the
   `$300/mo` cap is effectively a **~$75 real** ceiling — it refuses real work long before the
   intended budget.
2. **The per-run gate over-refuses.** A run whose real cost is ~$0.50 is gated against a ~$2 UB,
   so legitimately-cheap runs can be refused as "over $25" when batched.

The initial cost-reporting slice already **reports** real cost (in the matrix records, analysis-only)
and **left the guard
untouched** — deliberately, because tightening a money-safety guard is exactly an ADR-0022
"stop-and-ask." This ADR is that ask: should the guard **bind on real cost**, raising the effective
real-spend ceiling to its **intended** level (≈4× more real spend through the same nominal cap)?

## The money-safety invariants that MUST survive any change (non-negotiable)

- **Never under-count recorded spend.** A corrupt/torn ledger fails closed (unchanged).
- **The pre-spend ESTIMATE must remain an upper bound on REAL cost.** It may be loose; it must
  never be optimistic. (The current un-cached UB already satisfies this: real ≤ un-cached always.)
- **`actual ≤ estimate` post-spend backstop stays** — an estimate an actual breaches halts loudly.
- **Fail-closed on a 0/unset cap.** Unchanged.
- **No single run, and no month, can exceed its cap in REAL dollars.**

## Options

**Option A — Record real actuals; keep the pre-spend estimate as the un-cached UB.**
The ledger accumulates **real** cost (`realCostUSD`) so `monthToDateUSD` reflects true spend; each
run is still gated by the conservative un-cached UB. *Pro:* per-run safety unchanged (pessimistic
gate); the monthly budget stops reflecting a 4× phantom. *Con:* the per-run gate still over-refuses
cheap-but-large-token runs; the monthly check mixes units (real history + UB marginal) — safe
(UB ≥ real) but loose.

**Option B — Real-cost estimate with a conservative cache-floor + real actuals.**
Estimate real cost assuming a **floor** cache-hit (e.g. 0% on the first turn, a low measured floor
thereafter) so the estimate stays an upper bound on real cost but far tighter than 4×; record real
actuals; keep the `actual ≤ estimate` halt. *Pro:* the gate binds near the real ceiling (intended).
*Con:* needs a defensible, measured cache-floor; mis-set floor over-refuses (safe) or, if set
optimistically, risks under-estimate — so the floor must be **conservative and measured**, and the
post-spend halt is the backstop.

**Option C — Two-tier: keep the pessimistic UB gate; raise the nominal caps to real intent.**
Leave the guard exactly as is (un-cached UB) but raise `$25/run · $300/mo` to the values that, at
the un-cached UB, permit the intended REAL spend (≈ multiply by the observed inflation). *Pro:*
zero guard-logic change (lowest money-safety risk). *Con:* the nominal numbers stop meaning real
dollars; brittle if the cache ratio shifts; least honest.

## Recommendation (for sign-off)

**Option A now, Option B when the cache-floor is measured.** Option A is the smallest change that
removes the 4× phantom from the *accumulator* while keeping the per-run gate pessimistic (so no
single run can overspend in real dollars). It needs:

- a `realCostUSD`-based `measureBenchmarkCost` (the recorded actual becomes real, cache-discounted —
  including the ADR-0047 write term), and
- the `SpendRecord` gains an **additive** `realCostUSD` field (audit-record touch — its own review),
  while `costUSD` is **redefined to the real cost** OR kept as the UB with `realCostUSD` added; the
  sign-off decides which `monthToDateUSD` should sum.

Then, once a conservative cache-hit **floor** is measured across ≥3 seeds (not assumed), move the
**pre-spend estimate** to Option B so the per-run gate also binds near the real ceiling.

## Open questions for the human (the sign-off)

1. Should `monthToDateUSD` accumulate **real** cost (Option A) now, or wait for the full Option B?
2. Is the `$25/run · $300/mo` intended in **real** dollars (then A/B) or **un-cached worst case**
   (then C / no change)?
3. The `SpendRecord` audit-record change (`costUSD` semantics vs an additive `realCostUSD`) — which?

**Answered + implemented (Option A — see the Decision section above).** The pre-spend estimate
remains the pessimistic un-cached UB (Option B's cache-floor estimate is deferred to the measured
paid ablation); only the *accumulator* now reflects real cost.

## Amendment (2026-07-10, QC §9) — the post-spend backstop now rides real cost

A pre-launch QC review found that one invariant asserted above is **false**, and the resulting guard
was under-enforced:

- The claim *"the pre-spend ESTIMATE must remain an upper bound on REAL cost … the current un-cached
  UB already satisfies this: **real ≤ un-cached always**"* does **not** hold. ADR-0047 prices cache
  **writes** at the **1.25× premium**, and `realCostUSD` charges that premium; the un-cached estimate
  charges every input token at the 1.0× fresh rate. So a **cache-write-heavy** run has
  `realCostUSD > estimateCostUSD` (worked example: 1M all-cache-write input → real $3.75 > estimate
  $3.00). The un-cached UB bounds the discounted *read* cost, not the *real* cost.
- Because `monthToDateUSD` accumulates `realCostUSD` (Option A above) but the post-spend backstop only
  compared the **UB** `actualUSD` to the estimate, a run whose real cost exceeded the estimate was
  recorded silently and the **monthly cap could drift past its ceiling** by the cache-write premium,
  run after run.

**Correction (implemented):** `guardedRun`'s post-spend backstop now halts loudly on
`max(actualUSD, realCostUSD) > estimatedUSD` (was: `actualUSD > estimatedUSD`). The invariant *"No
single run, and no month, can exceed its cap in REAL dollars"* is thereby restored to a **bounded +
loud** guarantee: a breaching run is recorded truthfully, then the campaign halts — month-to-date can
exceed the cap by **at most one breaching run's excess**, never unboundedly. The pre-spend estimate is
unchanged (still the pessimistic un-cached UB); moving it onto a true real-cost upper bound remains the
deferred Option B. The "real ≤ un-cached always" invariant above no longer holds and is superseded by
this amendment — a future change must treat the un-cached UB as bounding read cost only.
