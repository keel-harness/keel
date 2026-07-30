import { describe, expect, it } from "vitest";
import { type BudgetCaps, reconstructBudgetEndKind } from "./budget-end-kind.js";

const CAPS: BudgetCaps = {
  maxEffectiveTokens: 400_000,
  maxGrossTokens: 1_200_000,
  maxOutputTokens: 80_000,
  cacheReadWeight: 0.1,
};

describe("reconstructBudgetEndKind (ER-038 matrix attribution)", () => {
  it("maps non-budget stop reasons 1:1", () => {
    const u = { inputTokens: 1, outputTokens: 1 };
    expect(reconstructBudgetEndKind("model-stop", u, CAPS)).toBe("completed");
    expect(reconstructBudgetEndKind("max-turns", u, CAPS)).toBe("turn");
    expect(reconstructBudgetEndKind("loop-detected", u, CAPS)).toBe("loop");
    expect(reconstructBudgetEndKind("length", u, CAPS)).toBe("length");
    expect(reconstructBudgetEndKind("aborted", u, CAPS)).toBe("aborted");
    expect(reconstructBudgetEndKind("deadline", u, CAPS)).toBe("deadline"); // wall-clock self-stop (ADR-0051)
    expect(reconstructBudgetEndKind("error", u, CAPS)).toBe("error");
  });

  it("attributes a budget stop to OUTPUT when output ≥ its cap (checked first, like the loop)", () => {
    const u = { inputTokens: 50_000, outputTokens: 80_000, cachedInputTokens: 40_000 };
    expect(reconstructBudgetEndKind("budget", u, CAPS)).toBe("output");
  });

  it("attributes a budget stop to GROSS when gross ≥ its cap but output is under", () => {
    // gross = 1.3M ≥ 1.2M; output 10k < 80k → gross.
    const u = { inputTokens: 1_290_000, outputTokens: 10_000, cachedInputTokens: 1_200_000 };
    expect(reconstructBudgetEndKind("budget", u, CAPS)).toBe("gross");
  });

  it("attributes a budget stop to EFFECTIVE when neither output nor gross fired (the primary cap)", () => {
    // output 5k < 80k; gross 410k < 1.2M → effective is the only one left.
    const u = { inputTokens: 405_000, outputTokens: 5_000, cachedInputTokens: 0 };
    expect(reconstructBudgetEndKind("budget", u, CAPS)).toBe("effective");
  });

  it("falls back to effective when only the effective cap is configured (variant B has no gross/output)", () => {
    const onlyEffective: BudgetCaps = { maxEffectiveTokens: 400_000, cacheReadWeight: 0.1 };
    const u = { inputTokens: 4_000_000, outputTokens: 100_000, cachedInputTokens: 3_900_000 };
    expect(reconstructBudgetEndKind("budget", u, onlyEffective)).toBe("effective");
  });

  it("does not mislabel a gross-only configuration's budget stop as effective", () => {
    // Variant A (raw cap) models the cap as gross-only; a budget stop there is 'gross'.
    const grossOnly: BudgetCaps = { maxGrossTokens: 400_000, cacheReadWeight: 1.0 };
    const u = { inputTokens: 395_000, outputTokens: 6_000 };
    expect(reconstructBudgetEndKind("budget", u, grossOnly)).toBe("gross");
  });
});
