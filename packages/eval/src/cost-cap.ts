import type { EvalConfigT } from "./config.js";

/** Raised when a run is refused on cost grounds (over budget, or a 0/unset cap). */
export class CostCapError extends Error {
  constructor(message: string) {
    super(`eval cost cap: ${message}`);
    this.name = "CostCapError";
  }
}

/**
 * A cap must be a FINITE POSITIVE USD amount — 0/negative/NaN/Infinity is never a license to spend.
 * `!(capUSD > 0)` catches 0, negative, and NaN; `!Number.isFinite` additionally catches Infinity
 * (which satisfies `> 0` but represents an unlimited budget — the exact thing the cap prevents). N7.
 */
function assertFinitePositiveCap(label: string, capUSD: number): void {
  if (!(capUSD > 0) || !Number.isFinite(capUSD)) {
    throw new CostCapError(
      `${label} must be a finite positive USD amount; got ${String(capUSD)} (set it in eval.config costCapUSD)`,
    );
  }
}

/** A spend/estimate amount must be a finite, non-negative number (a non-finite estimate must never pass). */
function assertFiniteNonNegative(label: string, amountUSD: number): void {
  if (!Number.isFinite(amountUSD) || amountUSD < 0) {
    throw new CostCapError(
      `${label} must be a finite non-negative number; got ${String(amountUSD)}`,
    );
  }
}

/**
 * Refuse a run unless `capUSD` is a positive number AND `estimatedUSD` is within it. A 0, negative,
 * NaN, or otherwise non-positive cap is refused — an unset cap is never a license to spend (§8.2,
 * Appendix F: "runner refuses 0/unset").
 */
export function assertWithinCostCap(capUSD: number, estimatedUSD: number): void {
  assertFinitePositiveCap("per-run cap", capUSD);
  assertFiniteNonNegative("estimated run cost", estimatedUSD);
  if (estimatedUSD > capUSD) {
    throw new CostCapError(
      `estimated run cost $${String(estimatedUSD)} exceeds the per-run cap $${String(capUSD)}`,
    );
  }
}

/** Apply `assertWithinCostCap` using the config's `costCapUSD.perRun`. */
export function assertConfigCostCap(config: EvalConfigT, estimatedUSD: number): void {
  assertWithinCostCap(config.costCapUSD.perRun, estimatedUSD);
}

/**
 * The monthly-cap **guard** (Appendix F `costCapUSD.perMonth`). Refuses a run unless the
 * **month-to-date** spend plus this run's estimate stays within the cap. The caller supplies
 * `monthToDateUSD`, keeping this pure + unit-testable like `assertWithinCostCap`.
 *
 * **Honest status:** this is the *guard* only. The cross-run **spend ledger** that accumulates this
 * calendar month's recorded run costs (to supply `monthToDateUSD`) and the **single spending
 * chokepoint** that invokes it before any paid call now exist + are tested (`spend-ledger.ts`'s
 * `readMonthToDateUSD` + `guardedRun`, Epic 1.11 slice 3). What remains is the **live benchmark runner**
 * that calls `guardedRun` with a real model spend — Phase B (B1). Until that runner exists no real
 * spend path is reachable. (`config.ts` and ADR-0022 carry the same status — keep them in sync.)
 */
export function assertWithinMonthlyCap(
  capUSD: number,
  monthToDateUSD: number,
  estimatedUSD: number,
): void {
  assertFinitePositiveCap("monthly cap", capUSD);
  assertFiniteNonNegative("month-to-date spend", monthToDateUSD);
  assertFiniteNonNegative("estimated run cost", estimatedUSD);
  const projected = monthToDateUSD + estimatedUSD;
  if (projected > capUSD) {
    throw new CostCapError(
      `month-to-date $${String(monthToDateUSD)} + this run $${String(estimatedUSD)} = $${String(projected)} exceeds the monthly cap $${String(capUSD)}`,
    );
  }
}

/** Apply `assertWithinMonthlyCap` using the config's `costCapUSD.perMonth`. */
export function assertConfigMonthlyCap(
  config: EvalConfigT,
  monthToDateUSD: number,
  estimatedUSD: number,
): void {
  assertWithinMonthlyCap(config.costCapUSD.perMonth, monthToDateUSD, estimatedUSD);
}

/** Token counts for a run (provider usage). `cachedInputTokens` is the subset of `inputTokens` the
 *  provider served from its prompt cache (billed at the cache-read rate); ADDITIVE + OPTIONAL so an
 *  older record / non-caching provider that omits it is unaffected (absent → 0 cached, no discount). */
export interface RunUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number | undefined;
  // The cache-WRITE subset of `inputTokens` (ADR-0047). The SDK's `inputTokens` already INCLUDES it
  // (verified: `inputTokens.total = input + cacheCreation + cacheRead`), so it is subtracted from the
  // fresh term and priced at `cacheWritePerMTok`. Absent → 0 (no write cost).
  readonly cacheCreationInputTokens?: number | undefined;
}

/** Per-million-token USD rates (the owner-set pricing for the pinned model — never guessed here).
 *  `cacheReadPerMTok` is the cache-READ rate (Anthropic ephemeral ≈ 0.1× `inputPerMTok`); ADDITIVE +
 *  OPTIONAL so the conservative un-cached estimate (`estimateCostUSD`) is unchanged. When absent, the
 *  real-cost meter falls back to the full input rate for cached tokens (no discount). */
export interface TokenPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok?: number | undefined;
  // The cache-WRITE rate (Anthropic ephemeral ≈ 1.25× `inputPerMTok`; ADR-0047). ADDITIVE + OPTIONAL;
  // when absent, written tokens fall back to the full input rate (no premium).
  readonly cacheWritePerMTok?: number | undefined;
}

/**
 * Owner-set Sonnet 4.6 list pricing (per million tokens) — NOT guessed by keel (the model is pinned by
 * OQ-3/ADR-0022). The cache-read rate ($0.30) is 0.1× the fresh-input rate ($3.00), so it is the price
 * basis the budget controller's `cacheReadWeight` (anthropic 0.1×, ADR-0044) must stay consistent with —
 * `assertCacheWeightConsistent(0.1, SONNET_4_6_PRICING)` is the permanent CI tie (Epic 1.14). Committed
 * here so the price↔weight invariant is enforceable in tracked code (the live matrix driver is local).
 */
export const SONNET_4_6_PRICING: TokenPricing = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3, // 0.1× input (ephemeral cache read)
  cacheWritePerMTok: 3.75, // 1.25× input (ephemeral 5-min cache write); ADR-0047
};

/**
 * Estimate a run's USD cost from its token counts against a pricing table. Pure: pricing is supplied
 * by the caller (from eval.config / an owner-set table), never hard-coded — keel must not guess model
 * prices. Throws `CostCapError` on any non-finite/negative input so a bad estimate can never silently
 * pass a cap guard. Feeds `assertWithinCostCap` / `assertWithinMonthlyCap`.
 *
 * **Scope (deliberate, QC C3):** this is a coarse **pre-run UPPER-BOUND ceiling**, NOT an accurate
 * actual. It charges every input token at the full `inputPerMTok` — it does **not** model the
 * prompt-cache discount (cache-read input bills ~0.1×; borrowed-techniques #6 makes caching a core
 * lever), so it **over-counts** input and may refuse runs that would actually be affordable. It also
 * does not separate reasoning/thinking tokens — callers MUST include reasoning tokens in
 * `outputTokens` so the ceiling never *under*-counts. It must never be used to under-estimate. The
 * binding budget signal is the **actuals measured on the B1 smoke** (per the Epic 1.11 plan); a
 * cache-/reasoning-aware refinement (extra token classes) is a Phase-B prerequisite if this ceiling
 * proves too conservative.
 */
export function estimateCostUSD(usage: RunUsage, pricing: TokenPricing): number {
  assertFiniteNonNegative("input tokens", usage.inputTokens);
  assertFiniteNonNegative("output tokens", usage.outputTokens);
  assertFiniteNonNegative("input price per Mtok", pricing.inputPerMTok);
  assertFiniteNonNegative("output price per Mtok", pricing.outputPerMTok);
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPerMTok +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}

/**
 * The REAL (cache-discounted) cost the API actually bills (Epic 1.14 — the honest meter). Unlike
 * `estimateCostUSD` (a conservative un-cached UPPER BOUND used by the spend GUARD), this charges the
 * cached subset of input at `cacheReadPerMTok` (≈0.1× on Anthropic), so it reflects what was truly
 * spent. Pure; rates supplied by the caller (never guessed). This is REPORTING-ONLY — it does NOT feed
 * the cost-cap guard (which stays pessimistic until the recalibration is ADR-approved, ADR-0022).
 *
 * Money-safety direction vs the un-cached `estimateCostUSD` ceiling: on a cache-READ-heavy run this is
 * far *below* the ceiling (reads bill ~0.1×), but it prices cache-WRITES at the 1.25× premium
 * (ADR-0047) — so a cache-WRITE-heavy run can *exceed* the un-cached ceiling; `realCostUSD` is NOT
 * bounded by `estimateCostUSD`. That is why `guardedRun`'s post-spend backstop rides `realCostUSD` too
 * (QC §9). `cached` is clamped to `[0, input]` (assume hostile inputs — a provider reporting
 * cached > input must not credit a refund).
 */
export function realCostUSD(usage: RunUsage, pricing: TokenPricing): number {
  assertFiniteNonNegative("input tokens", usage.inputTokens);
  assertFiniteNonNegative("output tokens", usage.outputTokens);
  if (usage.cachedInputTokens !== undefined) {
    assertFiniteNonNegative("cached input tokens", usage.cachedInputTokens);
  }
  if (usage.cacheCreationInputTokens !== undefined) {
    assertFiniteNonNegative("cache-creation input tokens", usage.cacheCreationInputTokens);
  }
  assertFiniteNonNegative("input price per Mtok", pricing.inputPerMTok);
  assertFiniteNonNegative("output price per Mtok", pricing.outputPerMTok);
  if (pricing.cacheReadPerMTok !== undefined) {
    assertFiniteNonNegative("cache-read price per Mtok", pricing.cacheReadPerMTok);
  }
  if (pricing.cacheWritePerMTok !== undefined) {
    assertFiniteNonNegative("cache-write price per Mtok", pricing.cacheWritePerMTok);
  }
  // `inputTokens` already INCLUDES both the read and write subsets (the SDK reports
  // `inputTokens.total = fresh + cacheRead + cacheWrite`; ADR-0047). Carve them out, clamping into the
  // remaining budget so fresh stays ≥ 0 even for a hostile provider reporting subsets > input.
  const cached = Math.min(Math.max(0, usage.cachedInputTokens ?? 0), usage.inputTokens);
  const cacheWrite = Math.min(
    Math.max(0, usage.cacheCreationInputTokens ?? 0),
    usage.inputTokens - cached,
  );
  const fresh = usage.inputTokens - cached - cacheWrite;
  const cacheReadRate = pricing.cacheReadPerMTok ?? pricing.inputPerMTok; // no rate → no discount
  const cacheWriteRate = pricing.cacheWritePerMTok ?? pricing.inputPerMTok; // no rate → no premium
  return (
    (fresh / 1_000_000) * pricing.inputPerMTok +
    (cached / 1_000_000) * cacheReadRate +
    (cacheWrite / 1_000_000) * cacheWriteRate +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}

/**
 * The measured cache-HIT ratio (`cachedInputTokens / inputTokens`), clamped to `[0,1]` — the cheapest,
 * highest-value diagnostic the cost workstream wanted and never had (the diagnosis: keel "budgeted
 * cache savings it never measured"). Total: `inputTokens ≤ 0` (incl. NaN) → 0, never NaN; cached is
 * clamped so a hostile `cached > input` reads as 1.0, not >1.
 */
export function cacheReadRatio(usage: RunUsage): number {
  if (!(usage.inputTokens > 0)) return 0;
  const cached = Math.min(Math.max(0, usage.cachedInputTokens ?? 0), usage.inputTokens);
  return cached / usage.inputTokens;
}

/**
 * The PERMANENT assumed-vs-actual guard (Epic 1.14): the budget controller's cache discount
 * (`cacheReadWeight` — e.g. anthropic 0.1× on the capability table, ADR-0030/0044) and the real-cost
 * pricing (`cacheReadPerMTok / inputPerMTok`) MUST agree. If they drift — someone edited the cap's
 * weight without the price table, or vice versa — the cap's cost model no longer tracks real billing and
 * we would be fooling ourselves again (the exact failure that produced the ~4× ledger inflation). CI
 * fails loudly on drift. When no `cacheReadPerMTok` is set the implied price ratio is 1.0 (cached billed
 * at full rate), so a discounting weight (< 1) is itself a drift — caught here.
 */
export function assertCacheWeightConsistent(
  cacheReadWeight: number,
  pricing: TokenPricing,
  epsilon = 1e-9,
): void {
  assertFiniteNonNegative("cache-read weight", cacheReadWeight);
  assertFinitePositiveCap("input price per Mtok", pricing.inputPerMTok);
  if (pricing.cacheReadPerMTok !== undefined) {
    assertFiniteNonNegative("cache-read price per Mtok", pricing.cacheReadPerMTok);
  }
  const impliedRatio = (pricing.cacheReadPerMTok ?? pricing.inputPerMTok) / pricing.inputPerMTok;
  if (Math.abs(cacheReadWeight - impliedRatio) > epsilon) {
    throw new CostCapError(
      `cache-read weight ${String(cacheReadWeight)} (the budget cap's discount, ADR-0044) drifted from ` +
        `the real price ratio ${String(impliedRatio)} (cacheReadPerMTok $${String(pricing.cacheReadPerMTok)} ` +
        `/ inputPerMTok $${String(pricing.inputPerMTok)}). They must agree — edit both together, or the ` +
        `effective-cost cap no longer tracks real billing (Epic 1.14 assumed-vs-actual guard).`,
    );
  }
}
