import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { cacheRewriteNetGainTokens, isCacheRewriteProfitable } from "./cache-gain.js";

const base = {
  savedTokensPerTurn: 1000,
  rewrittenTokens: 5000,
  cacheReadWeight: 0.1, // Anthropic ephemeral
  expectedRemainingReads: 20,
};

describe("cacheRewriteNetGainTokens (effective-token model of busting the prefix cache)", () => {
  it("rises with the read horizon (more remaining reads ⇒ more savings)", () => {
    const few = cacheRewriteNetGainTokens({ ...base, expectedRemainingReads: 1 });
    const many = cacheRewriteNetGainTokens({ ...base, expectedRemainingReads: 100 });
    expect(many).toBeGreaterThan(few);
  });

  it("rises with tokens saved per turn and falls with rewrite size", () => {
    expect(cacheRewriteNetGainTokens({ ...base, savedTokensPerTurn: 4000 })).toBeGreaterThan(
      cacheRewriteNetGainTokens({ ...base, savedTokensPerTurn: 500 }),
    );
    expect(cacheRewriteNetGainTokens({ ...base, rewrittenTokens: 50_000 })).toBeLessThan(
      cacheRewriteNetGainTokens({ ...base, rewrittenTokens: 1000 }),
    );
  });

  it("is NEGATIVE for a tiny saving against a huge cached suffix with few reads (don't bust cache)", () => {
    const g = cacheRewriteNetGainTokens({
      savedTokensPerTurn: 200,
      rewrittenTokens: 50_000,
      cacheReadWeight: 0.1,
      expectedRemainingReads: 2,
    });
    expect(g).toBeLessThan(0);
    expect(
      isCacheRewriteProfitable({
        savedTokensPerTurn: 200,
        rewrittenTokens: 50_000,
        cacheReadWeight: 0.1,
        expectedRemainingReads: 2,
      }),
    ).toBe(false);
  });

  it("break-even ≈ rewritten·(1−w) / (saved·w) reads (honest: ~9× suffix/saved at w=0.1)", () => {
    const saved = 1000;
    const rewritten = 5000;
    const w = 0.1;
    const breakeven = (rewritten * (1 - w)) / (saved * w); // 45
    expect(
      cacheRewriteNetGainTokens({
        savedTokensPerTurn: saved,
        rewrittenTokens: rewritten,
        cacheReadWeight: w,
        expectedRemainingReads: breakeven,
      }),
    ).toBeCloseTo(0, 6);
    expect(
      isCacheRewriteProfitable({
        savedTokensPerTurn: saved,
        rewrittenTokens: rewritten,
        cacheReadWeight: w,
        expectedRemainingReads: breakeven + 1,
      }),
    ).toBe(true);
    expect(
      isCacheRewriteProfitable({
        savedTokensPerTurn: saved,
        rewrittenTokens: rewritten,
        cacheReadWeight: w,
        expectedRemainingReads: breakeven - 1,
      }),
    ).toBe(false);
  });

  it("clamps a misconfigured weight into [0,1] (fail-safe, matches effectiveTokens)", () => {
    // weight > 1 clamps to 1 ⇒ savings full, rewrite cost 0
    expect(cacheRewriteNetGainTokens({ ...base, cacheReadWeight: 5 })).toBe(
      cacheRewriteNetGainTokens({ ...base, cacheReadWeight: 1 }),
    );
    // negative weight clamps to 0 ⇒ savings 0, full rewrite cost
    expect(cacheRewriteNetGainTokens({ ...base, cacheReadWeight: -3 })).toBe(
      cacheRewriteNetGainTokens({ ...base, cacheReadWeight: 0 }),
    );
  });

  it("isCacheRewriteProfitable agrees with the sign of the net gain (property)", () => {
    fc.assert(
      fc.property(
        fc.record({
          savedTokensPerTurn: fc.integer({ min: 0, max: 100_000 }),
          rewrittenTokens: fc.integer({ min: 0, max: 500_000 }),
          cacheReadWeight: fc.double({ min: 0, max: 1, noNaN: true }),
          expectedRemainingReads: fc.integer({ min: 0, max: 1000 }),
        }),
        (input) => isCacheRewriteProfitable(input) === cacheRewriteNetGainTokens(input) > 0,
      ),
    );
  });

  it("coerces non-finite inputs to a finite, not-profitable result (never NaN — QC fix)", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(Number.isFinite(cacheRewriteNetGainTokens({ ...base, cacheReadWeight: bad }))).toBe(
        true,
      );
      expect(Number.isFinite(cacheRewriteNetGainTokens({ ...base, savedTokensPerTurn: bad }))).toBe(
        true,
      );
      expect(
        Number.isFinite(cacheRewriteNetGainTokens({ ...base, expectedRemainingReads: bad })),
      ).toBe(true);
    }
    expect(isCacheRewriteProfitable({ ...base, cacheReadWeight: NaN })).toBe(false);
  });
});
