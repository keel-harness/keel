import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { effectiveTokens, grossTokens } from "./effective-tokens.js";

/**
 * The ADR-0044 money-safety invariant lives here (single source for the kernel budget + the eval
 * reconstruction). The clamps are what make `effective ≤ gross` hold structurally, not by trust.
 */
describe("effectiveTokens — cost-true accounting with structural clamps (ADR-0044)", () => {
  it("clamps a provider misreport of cached > input (cached is a subset of input)", () => {
    // input 50, cached 200 (impossible), weight 1.0 → clamp cached→50 → 0 + 1.0·50 + 0 = 50 = gross.
    // Without the clamp it would be 0 + 1.0·200 + 0 = 200 (> gross 50).
    expect(effectiveTokens({ inputTokens: 50, outputTokens: 0, cachedInputTokens: 200 }, 1.0)).toBe(
      50,
    );
  });

  it("clamps cacheReadWeight > 1 to 1.0 (a weight >1 would give LESS runway than gross)", () => {
    // weight 5 → 1.0 → fresh(10) + 1.0·90 + 10 = 110 = gross. Unclamped: 10 + 5·90 + 10 = 470.
    expect(
      effectiveTokens({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 90 }, 5.0),
    ).toBe(110);
  });

  it("clamps a negative cacheReadWeight to 0 (negative would CREDIT cache → undercount → overspend)", () => {
    // weight −0.5 → 0 → cached free → fresh(10) + 0 + 10 = 20.
    expect(
      effectiveTokens({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 90 }, -0.5),
    ).toBe(20);
  });

  it("equals gross when no cached subset is reported (backward-compat)", () => {
    expect(effectiveTokens({ inputTokens: 100, outputTokens: 10 }, 0.1)).toBe(110);
    expect(grossTokens({ inputTokens: 100, outputTokens: 10 })).toBe(110);
  });

  it("discounts cached input at the weight when within contract (the cost-true case)", () => {
    // input 100, cached 90, weight 0.1 → fresh(10) + 0.1·90 + 5 = 10 + 9 + 5 = 24.
    expect(effectiveTokens({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 90 }, 0.1)).toBe(
      24,
    );
  });

  it("property: output ≤ effective ≤ gross for ANY usage and ANY weight (clamps enforce the invariant)", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 5_000_000 }), // inputTokens
        fc.nat({ max: 5_000_000 }), // outputTokens
        fc.nat({ max: 10_000_000 }), // cachedInputTokens — deliberately allowed to EXCEED input
        fc.double({ min: -10, max: 10, noNaN: true }), // weight OUTSIDE [0,1] too
        (inputTokens, outputTokens, cachedInputTokens, weight) => {
          const usage = { inputTokens, outputTokens, cachedInputTokens };
          const e = effectiveTokens(usage, weight);
          expect(e).toBeGreaterThanOrEqual(usage.outputTokens);
          expect(e).toBeLessThanOrEqual(grossTokens(usage));
          expect(e).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});
