import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CostCapError,
  SONNET_4_6_PRICING,
  assertCacheWeightConsistent,
  assertConfigCostCap,
  assertConfigMonthlyCap,
  assertWithinCostCap,
  assertWithinMonthlyCap,
  cacheReadRatio,
  estimateCostUSD,
  realCostUSD,
} from "./cost-cap.js";
import { defaultEvalConfig } from "./config.default.js";
import { loadEvalConfig } from "./config.js";

describe("cost-cap guard", () => {
  it("allows an estimate at or under a positive cap", () => {
    expect(() => assertWithinCostCap(10, 9.99)).not.toThrow();
    expect(() => assertWithinCostCap(10, 10)).not.toThrow();
  });

  it("refuses an estimate over the cap", () => {
    expect(() => assertWithinCostCap(10, 10.01)).toThrow(CostCapError);
  });

  it("refuses a 0, negative, or NaN cap (unset is not a license to spend)", () => {
    expect(() => assertWithinCostCap(0, 1)).toThrow(CostCapError);
    expect(() => assertWithinCostCap(-5, 1)).toThrow(CostCapError);
    expect(() => assertWithinCostCap(Number.NaN, 1)).toThrow(CostCapError);
  });

  it("refuses an Infinity cap (N7: unlimited budget defeats the purpose of the cap)", () => {
    // Infinity > 0 is true so the old guard passed it — this must now throw.
    expect(() => assertWithinCostCap(Number.POSITIVE_INFINITY, 1)).toThrow(CostCapError);
    expect(() => assertWithinCostCap(Number.NEGATIVE_INFINITY, 1)).toThrow(CostCapError);
  });

  it("refuses a NaN or negative estimate (non-finite estimate must never pass)", () => {
    expect(() => assertWithinCostCap(10, Number.NaN)).toThrow(CostCapError);
    expect(() => assertWithinCostCap(10, -1)).toThrow(CostCapError);
    expect(() => assertWithinCostCap(10, Number.POSITIVE_INFINITY)).toThrow(CostCapError);
  });

  it("reads the per-run cap from a config (positive default allowed; a 0 cap still refused)", () => {
    const cfg = loadEvalConfig(defaultEvalConfig);
    // OQ-3 (ADR-0022): the default now pins a positive cap, so a within-budget estimate is allowed.
    expect(cfg.costCapUSD.perRun).toBeGreaterThan(0);
    expect(() => assertConfigCostCap(cfg, 1)).not.toThrow();
    // ...but a config whose cap is left at 0 is still refused (unset is not a license to spend).
    expect(() =>
      assertConfigCostCap({ ...cfg, costCapUSD: { perRun: 0, perMonth: 0 } }, 1),
    ).toThrow(CostCapError);
    // ...and an over-budget estimate is refused.
    expect(() =>
      assertConfigCostCap({ ...cfg, costCapUSD: { perRun: 5, perMonth: 50 } }, 6),
    ).toThrow(CostCapError);
  });
});

describe("monthly cost-cap guard (perMonth — cross-run spend accounting)", () => {
  it("allows when month-to-date + this run is at or under the monthly cap", () => {
    expect(() => assertWithinMonthlyCap(300, 250, 50)).not.toThrow();
    expect(() => assertWithinMonthlyCap(300, 0, 300)).not.toThrow();
  });

  it("refuses when month-to-date + this run would exceed the monthly cap", () => {
    expect(() => assertWithinMonthlyCap(300, 280, 25)).toThrow(CostCapError);
  });

  it("refuses a 0/negative/NaN/Infinity monthly cap (unset is not a license to spend)", () => {
    expect(() => assertWithinMonthlyCap(0, 0, 1)).toThrow(CostCapError);
    expect(() => assertWithinMonthlyCap(-1, 0, 1)).toThrow(CostCapError);
    expect(() => assertWithinMonthlyCap(Number.NaN, 0, 1)).toThrow(CostCapError);
    expect(() => assertWithinMonthlyCap(Number.POSITIVE_INFINITY, 0, 1)).toThrow(CostCapError);
  });

  it("refuses a non-finite/negative month-to-date or estimate", () => {
    expect(() => assertWithinMonthlyCap(300, -1, 1)).toThrow(CostCapError);
    expect(() => assertWithinMonthlyCap(300, Number.NaN, 1)).toThrow(CostCapError);
    expect(() => assertWithinMonthlyCap(300, 0, Number.POSITIVE_INFINITY)).toThrow(CostCapError);
  });

  it("reads the monthly cap from a config", () => {
    const cfg = loadEvalConfig(defaultEvalConfig); // perMonth pinned at 300 (ADR-0022)
    expect(cfg.costCapUSD.perMonth).toBeGreaterThan(0);
    expect(() => assertConfigMonthlyCap(cfg, 250, 40)).not.toThrow();
    expect(() => assertConfigMonthlyCap(cfg, 290, 20)).toThrow(CostCapError);
    expect(() =>
      assertConfigMonthlyCap({ ...cfg, costCapUSD: { perRun: 25, perMonth: 0 } }, 0, 1),
    ).toThrow(CostCapError);
  });
});

describe("estimateCostUSD (token counts → USD, against a pricing table)", () => {
  const pricing = { inputPerMTok: 3, outputPerMTok: 15 };

  it("computes input+output cost from per-million-token rates", () => {
    // 1M input @ $3 + 1M output @ $15 = $18
    expect(
      estimateCostUSD({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, pricing),
    ).toBeCloseTo(18, 6);
    // 200K in + 50K out = 0.2*3 + 0.05*15 = 0.6 + 0.75 = 1.35
    expect(estimateCostUSD({ inputTokens: 200_000, outputTokens: 50_000 }, pricing)).toBeCloseTo(
      1.35,
      6,
    );
  });

  it("returns 0 for a zero-token run", () => {
    expect(estimateCostUSD({ inputTokens: 0, outputTokens: 0 }, pricing)).toBe(0);
  });

  it("refuses negative/NaN/Infinity tokens or rates (a bad estimate must never silently pass)", () => {
    expect(() => estimateCostUSD({ inputTokens: -1, outputTokens: 0 }, pricing)).toThrow(
      CostCapError,
    );
    expect(() => estimateCostUSD({ inputTokens: Number.NaN, outputTokens: 0 }, pricing)).toThrow(
      CostCapError,
    );
    expect(() =>
      estimateCostUSD(
        { inputTokens: 1, outputTokens: 1 },
        { inputPerMTok: Number.POSITIVE_INFINITY, outputPerMTok: 15 },
      ),
    ).toThrow(CostCapError);
  });

  it("composes with the cap guards (estimate → assert)", () => {
    const cost = estimateCostUSD({ inputTokens: 1_000_000, outputTokens: 200_000 }, pricing); // $6
    expect(() => assertWithinCostCap(25, cost)).not.toThrow();
    expect(() => assertWithinMonthlyCap(300, 296, cost)).toThrow(CostCapError); // 296+6 > 300
  });
});

// Epic 1.14 — the HONEST cost meter (the diagnosis found the old `estimateCostUSD` over-states real
// $ by ~4× because it charges the 92-95%-cached input at the full un-cached rate). `realCostUSD` is the
// cache-discounted bill the API actually charges; it is REPORTING-ONLY here (the money GUARD keeps using
// the conservative `estimateCostUSD` upper bound until the recalibration is ADR-approved).
describe("realCostUSD (cache-discounted — what the API actually bills)", () => {
  // Sonnet 4.6 owner-set rates: fresh input $3/M, cache-read $0.30/M (0.1×), output $15/M.
  const priced = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 };

  it("discounts the cached subset of input at the cache-read rate", () => {
    // 1M input ALL cached + 1M output = 0·$3 + 1M×$0.30 + 1M×$15 = $15.30 (vs estimateCostUSD's $18).
    expect(
      realCostUSD(
        { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 1_000_000 },
        priced,
      ),
    ).toBeCloseTo(15.3, 6);
    // partial: 200K fresh + 800K cached + 100K out = 0.6 + 0.24 + 1.5 = $2.34.
    expect(
      realCostUSD(
        { inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 800_000 },
        priced,
      ),
    ).toBeCloseTo(2.34, 6);
  });

  it("falls back to the full input rate when no cache-read rate / no cached subset is given (backward-compatible)", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    // no cacheReadPerMTok → no discount → identical to estimateCostUSD.
    expect(realCostUSD(u, { inputPerMTok: 3, outputPerMTok: 15 })).toBeCloseTo(
      estimateCostUSD(u, { inputPerMTok: 3, outputPerMTok: 15 }),
      6,
    );
    // cacheReadPerMTok present but no cached subset → also identical (nothing to discount).
    expect(realCostUSD(u, priced)).toBeCloseTo(
      estimateCostUSD(u, { inputPerMTok: 3, outputPerMTok: 15 }),
      6,
    );
  });

  it("clamps a hostile cached > input (assume hostile inputs; never credit more than the input)", () => {
    // cached 2M but input 1M → treat cached as 1M (fresh 0): 1M×$0.30 + 0 out = $0.30.
    expect(
      realCostUSD(
        { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 2_000_000 },
        priced,
      ),
    ).toBeCloseTo(0.3, 6);
  });

  it("pins the historical nine-task calibration summary at ~$5.25, ~4.5× below the inflated estimate", () => {
    // Historical 9-task calibration summary (95.2% cache-read); its raw ledger is not distributed.
    const u = { inputTokens: 7_170_208, outputTokens: 144_028, cachedInputTokens: 6_823_269 };
    const real = realCostUSD(u, priced);
    const inflated = estimateCostUSD(u, { inputPerMTok: 3, outputPerMTok: 15 });
    expect(real).toBeCloseTo(5.25, 1); // the diagnosis figure — caching works, cost is modest
    expect(inflated).toBeCloseTo(23.67, 1); // the old cache-blind figure the spend-ledger recorded
    expect(inflated / real).toBeGreaterThan(4); // the ~4× artifact behind the "5-7× gap" headline
  });

  it("prices the cache-WRITE subset at 1.25× (ADR-0047) — inputTokens already includes it", () => {
    const sonnet = {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    };
    // input 1M = fresh 100k + cacheRead 800k + cacheWrite 100k (the SDK's inputTokens.total).
    const u = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 800_000,
      cacheCreationInputTokens: 100_000,
    };
    // fresh 100k×$3 + read 800k×$0.30 + write 100k×$3.75 = 0.3 + 0.24 + 0.375 = $0.915.
    expect(realCostUSD(u, sonnet)).toBeCloseTo(0.915, 6);
    // Without the write field, the same 100k is mis-priced as fresh ($3) → $0.84 (the initial meter's slight UNDER-count).
    expect(realCostUSD({ ...u, cacheCreationInputTokens: undefined }, sonnet)).toBeCloseTo(0.84, 6);
  });

  it("clamps so cached + write never exceed input (fresh stays ≥ 0 for hostile inputs)", () => {
    const sonnet = {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    };
    // cached 800k + write 900k = 1.7M > input 1M: write is clamped to the remaining 200k; fresh = 0.
    const c = realCostUSD(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 800_000,
        cacheCreationInputTokens: 900_000,
      },
      sonnet,
    );
    expect(c).toBeCloseTo((800_000 * 0.3 + 200_000 * 3.75) / 1_000_000, 6); // 0.24 + 0.75 = $0.99
  });

  it("SONNET_4_6_PRICING carries the cache-read AND cache-write rates (0.1× / 1.25×)", () => {
    expect(SONNET_4_6_PRICING.cacheReadPerMTok).toBe(0.3);
    expect(SONNET_4_6_PRICING.cacheWritePerMTok).toBe(3.75);
  });

  it("refuses negative/NaN/Infinity tokens or rates (a bad cost must never silently pass)", () => {
    expect(() => realCostUSD({ inputTokens: -1, outputTokens: 0 }, priced)).toThrow(CostCapError);
    expect(() =>
      realCostUSD(
        { inputTokens: 1, outputTokens: 0, cacheCreationInputTokens: Number.NaN },
        priced,
      ),
    ).toThrow(CostCapError);
    expect(() =>
      realCostUSD({ inputTokens: 1, outputTokens: 1, cachedInputTokens: Number.NaN }, priced),
    ).toThrow(CostCapError);
    expect(() =>
      realCostUSD(
        { inputTokens: 1, outputTokens: 1 },
        { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: Number.POSITIVE_INFINITY },
      ),
    ).toThrow(CostCapError);
  });

  it("property — realCostUSD is in [output-only floor, full-rate estimate] for any cacheReadPerMTok ≤ inputPerMTok", () => {
    fc.assert(
      fc.property(
        fc.record({
          inputTokens: fc.integer({ min: 0, max: 2_000_000 }),
          outputTokens: fc.integer({ min: 0, max: 2_000_000 }),
          cached: fc.integer({ min: 0, max: 2_000_000 }),
        }),
        ({ inputTokens, outputTokens, cached }) => {
          const usage = { inputTokens, outputTokens, cachedInputTokens: cached };
          const real = realCostUSD(usage, priced);
          const full = estimateCostUSD(usage, { inputPerMTok: 3, outputPerMTok: 15 });
          const outputFloor = (outputTokens / 1_000_000) * 15;
          // Never above full price (a cache read is ≤ a fresh read) and never below the un-discountable
          // output cost — so the honest meter can over-count vs reality only by ignoring cache-WRITES
          // (added with cache-write accounting), never under-count the output that bills at full rate.
          return real <= full + 1e-9 && real >= outputFloor - 1e-9;
        },
      ),
    );
  });
});

describe("cacheReadRatio (the measured cache-hit ratio — the cheapest diagnostic)", () => {
  it("is cached/input, clamped to [0,1]", () => {
    expect(
      cacheReadRatio({ inputTokens: 7_170_208, outputTokens: 0, cachedInputTokens: 6_823_269 }),
    ).toBeCloseTo(0.952, 3); // the measured 95.2%
    expect(cacheReadRatio({ inputTokens: 0, outputTokens: 0 })).toBe(0); // no input → 0, never NaN
    expect(cacheReadRatio({ inputTokens: 100, outputTokens: 0, cachedInputTokens: 999 })).toBe(1); // hostile clamp
    expect(cacheReadRatio({ inputTokens: 100, outputTokens: 0 })).toBe(0); // no cached subset reported
  });
});

// The PERMANENT "can't fool ourselves" guard: the budget controller's cache discount (cacheReadWeight,
// e.g. anthropic 0.1×) and the real-cost pricing (cacheReadPerMTok/inputPerMTok) MUST agree, or one was
// edited without the other and the cap's cost model has drifted from real billing. CI fails on drift.
describe("assertCacheWeightConsistent (weight ↔ pricing drift guard)", () => {
  it("passes when the weight equals the price ratio (0.1 == $0.30/$3.00)", () => {
    expect(() =>
      assertCacheWeightConsistent(0.1, {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
      }),
    ).not.toThrow();
  });

  it("throws when the cap's discount drifts from the real price ratio", () => {
    // weight says cached costs 0.1×, but pricing says 0.60/3.00 = 0.2× → they disagree.
    expect(() =>
      assertCacheWeightConsistent(0.1, {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.6,
      }),
    ).toThrow(CostCapError);
  });

  it("throws when the cap discounts cache but the pricing does not (implied ratio 1.0 ≠ 0.1)", () => {
    // No cacheReadPerMTok → real cost charges cached at full rate (ratio 1.0); a 0.1 weight is a lie.
    expect(() => assertCacheWeightConsistent(0.1, { inputPerMTok: 3, outputPerMTok: 15 })).toThrow(
      CostCapError,
    );
  });

  it("passes for a non-caching provider (weight 1.0, no cache-read rate → implied ratio 1.0)", () => {
    expect(() =>
      assertCacheWeightConsistent(1.0, { inputPerMTok: 3, outputPerMTok: 15 }),
    ).not.toThrow();
  });
});
