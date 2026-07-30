/**
 * Cache-aware net-gain model for the deterministic compression tier (ADR-0046).
 *
 * Compressing an aged tool body REWRITES the request prefix, which busts the Anthropic prefix cache
 * from that point: the suffix after the rewrite loses its cache entry and is re-written once at the
 * cache-WRITE rate before resuming cheap cache-READ rates. This module prices that trade-off in
 * effective-token terms (the same `cacheReadWeight ∈ [0,1]` the budget uses, ADR-0044) so the runner
 * (PR-d) can decide WHETHER a rewrite is worth it on COST grounds.
 *
 * IMPORTANT (honest framing): once caching works (~92–95% read), this number is usually small or
 * NEGATIVE — the saved tokens were cheap cached reads, and the rewrite is real. Compaction's true
 * value is RUNWAY (gross-token headroom → more turns to converge), NOT this cost delta. The runner
 * uses runway pressure as the PRIMARY trigger and this guard to avoid busting the cache when there is
 * no runway reason to (e.g. shaving a tiny body out of a large cached suffix). The exact constants are
 * validated empirically by the pre-registered ablation — measure, don't assume.
 */
export interface CacheRewriteInput {
  /** Gross tokens removed from the view by the compression, per subsequent turn. */
  readonly savedTokensPerTurn: number;
  /** Tokens after the compression point that lose their cache entry and are re-written once. */
  readonly rewrittenTokens: number;
  /** Provider cache-read billing multiplier in [0,1] (Anthropic ephemeral ≈ 0.1). */
  readonly cacheReadWeight: number;
  /** Estimated remaining turns that will read this prefix (the amortization horizon). */
  readonly expectedRemainingReads: number;
}

/**
 * Effective-token net gain of rewriting the prefix now vs. leaving the aged bodies in the cached
 * prefix: `reads · saved · w  −  rewritten · (1 − w)`.
 * - `reads · saved · w` — each remaining turn, the saved tokens would have been cached reads (cost `w`
 *   each); removing them avoids that.
 * - `rewritten · (1 − w)` — the rewritten suffix loses its cache hit once (written near full weight
 *   instead of read at `w`): the one-time marginal cost.
 * Break-even horizon ≈ `rewritten · (1 − w) / (saved · w)` reads. The weight is clamped to [0,1] as a
 * fail-safe (matches `effectiveTokens`; a bad weight degrades gracefully, never credits cost).
 */
export function cacheRewriteNetGainTokens(input: CacheRewriteInput): number {
  // Coerce non-finite inputs (NaN/±Infinity) to 0 BEFORE clamping: `Math.max(0, NaN) === NaN` would
  // otherwise poison the result (and silently suppress compression downstream). 0 is the fail-safe —
  // it never credits cost (a NaN weight ⇒ no savings + full rewrite cost ⇒ not profitable).
  const finite = (x: number): number => (Number.isFinite(x) ? x : 0);
  const w = Math.min(1, Math.max(0, finite(input.cacheReadWeight)));
  const reads = Math.max(0, finite(input.expectedRemainingReads));
  const saved = Math.max(0, finite(input.savedTokensPerTurn));
  const rewritten = Math.max(0, finite(input.rewrittenTokens));
  const savingsOverHorizon = reads * saved * w;
  const oneTimeRewriteCost = rewritten * (1 - w);
  return savingsOverHorizon - oneTimeRewriteCost;
}

/** Would rewriting the prefix pay for itself within the horizon on COST grounds alone? (Usually
 *  false once caching works — runway, not cost, is the real reason to compress; see the module doc.) */
export function isCacheRewriteProfitable(input: CacheRewriteInput): boolean {
  return cacheRewriteNetGainTokens(input) > 0;
}
