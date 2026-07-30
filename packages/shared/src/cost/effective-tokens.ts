/**
 * Effective (cost-true) token accounting for the cost-aware budget (ADR-0044). Lives in `@keel/shared`
 * so the kernel's in-loop budget enforcement and the eval layer's end-kind reconstruction / scoreboard
 * compute it from ONE definition — no drift between "what stopped the run" and "how we report it".
 */

/** The minimal usage shape the effective-token formula needs (a structural subset of `ModelUsage`).
 *  `cachedInputTokens` is the subset of `inputTokens` served from the provider prompt cache. */
export interface UsageForBudget {
  readonly inputTokens: number;
  readonly outputTokens: number;
  // `| undefined` (not a bare optional) so it accepts `ModelUsage` under `exactOptionalPropertyTypes`,
  // where the zod-inferred `cachedInputTokens` is `number | undefined`.
  readonly cachedInputTokens?: number | undefined;
}

/**
 * Effective tokens = fresh input at full weight, cached input at `cacheReadWeight` (the provider's
 * cache-read billing multiplier), plus output. With no cached subset reported this equals
 * `input + output` — the raw "gross" metric.
 *
 * ADR-0044's money-safety guarantee is `effective(u) ≤ gross(u)` (so the effective cap never permits an
 * over-run beyond the raw-token budget). That holds only when `cacheReadWeight ∈ [0,1]` AND
 * `cachedInputTokens ≤ inputTokens`. We do NOT trust the caller or the provider to honor those
 * preconditions (charter: structural, not behavioral): we **clamp both here**, so the invariant holds
 * for ANY input. With the clamps, `effective = input − cached·(1 − weight) + output`, and since
 * `0 ≤ cached ≤ input` and `0 ≤ weight ≤ 1`, the subtracted term is in `[0, input]`, giving
 * `output ≤ effective ≤ gross`. (Property-tested.)
 */
export function effectiveTokens(usage: UsageForBudget, cacheReadWeight: number): number {
  // Clamp the weight into [0,1]: a weight > 1 would make the cap stop EARLIER than gross (less runway
  // than intended); a negative weight would CREDIT cached tokens and undercount cost (overspend). Both
  // are misconfiguration; clamping is the fail-safe (a bad weight degrades to gross-equivalent).
  const weight = Math.min(1, Math.max(0, cacheReadWeight));
  // Clamp cached into [0, input]: it is a subset of input by contract, but a buggy/hostile provider
  // could report cached > input (assume hostile inputs). Clamping keeps `effective ≤ gross`.
  const cached = Math.min(Math.max(0, usage.cachedInputTokens ?? 0), usage.inputTokens);
  const fresh = usage.inputTokens - cached; // ≥ 0 by construction after the clamp
  return fresh + weight * cached + usage.outputTokens;
}

/** Gross (raw) tokens = input + output, regardless of caching. The emergency-backstop metric. */
export function grossTokens(usage: UsageForBudget): number {
  return usage.inputTokens + usage.outputTokens;
}
