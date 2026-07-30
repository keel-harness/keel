import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { JUNK, assertRejects, assertRoundTrips } from "@keel/shared/testing";
import { EvalConfig, loadEvalConfig } from "./config.js";
import { defaultEvalConfig } from "./config.default.js";

describe("EvalConfig (Appendix F)", () => {
  it("validates the committed default config", () => {
    expect(loadEvalConfig(defaultEvalConfig).suite).toBe("terminal-bench-2");
    expect(EvalConfig.parse(defaultEvalConfig)).toBeTruthy();
  });

  it("pins the OQ-3/OQ-4 decisions, not placeholders (ADR-0022)", () => {
    expect(defaultEvalConfig.model).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      pinnedAt: "2026-06-13",
    });
    expect(defaultEvalConfig.costCapUSD).toEqual({ perRun: 25, perMonth: 300 });
    expect(defaultEvalConfig.referenceHarness.name).toContain("terminus-2");
    expect(defaultEvalConfig.referenceHarness.version).toBe("harbor@v0.13.2");
    // null until WE measure it on identical infra with the same model (§8.2; never a leaderboard number)
    expect(defaultEvalConfig.referenceHarness.score).toBeNull();
  });

  it("accepts a null reference-harness score and a zero cost cap (placeholders)", () => {
    // the schema itself must accept these placeholders (the cost-cap GUARD, not the schema,
    // refuses a 0 cap at run time — see cost-cap.test.ts)
    const parsed = EvalConfig.parse({
      ...defaultEvalConfig,
      referenceHarness: { name: "x", version: "1", score: null },
      costCapUSD: { perRun: 0, perMonth: 0 },
    });
    expect(parsed.referenceHarness.score).toBeNull();
    expect(parsed.costCapUSD.perRun).toBe(0);
  });

  it("rejects malformed configs", () => {
    expect(() => loadEvalConfig({})).toThrow(ZodError);
    expect(() => loadEvalConfig({ ...defaultEvalConfig, runs: 0 })).toThrow(ZodError); // runs must be positive
    expect(() => loadEvalConfig({ ...defaultEvalConfig, aggregate: "max" })).toThrow(ZodError);
    expect(() => loadEvalConfig({ ...defaultEvalConfig, extra: true })).toThrow(ZodError); // strict
  });

  it("rejects Infinity cost caps (N7: schema must be .finite() so an unlimited budget is impossible)", () => {
    // Infinity > 0 is true, so without .finite() the old guard accepted it; the schema must catch
    // Infinity before it ever reaches assertWithinCostCap.
    expect(() =>
      loadEvalConfig({ ...defaultEvalConfig, costCapUSD: { perRun: Infinity, perMonth: 0 } }),
    ).toThrow(ZodError);
    expect(() =>
      loadEvalConfig({ ...defaultEvalConfig, costCapUSD: { perRun: 0, perMonth: Infinity } }),
    ).toThrow(ZodError);
    // A finite positive cap must still work
    expect(() =>
      loadEvalConfig({ ...defaultEvalConfig, costCapUSD: { perRun: 10, perMonth: 100 } }),
    ).not.toThrow();
  });

  it("round-trips any generated valid EvalConfig (property)", () => {
    assertRoundTrips(EvalConfig);
  });

  it("rejects JUNK and schema-specific malformed inputs (property)", () => {
    assertRejects(EvalConfig, [
      ...JUNK,
      // Missing required fields
      {},
      // runs must be positive integer
      { ...defaultEvalConfig, runs: 0 },
      { ...defaultEvalConfig, runs: -1 },
      { ...defaultEvalConfig, runs: 1.5 },
      // aggregate must be one of the enum values
      { ...defaultEvalConfig, aggregate: "max" },
      { ...defaultEvalConfig, aggregate: "p90" },
      // extra field rejected (strict mode)
      { ...defaultEvalConfig, extra: true },
      // model fields must be non-empty strings
      { ...defaultEvalConfig, model: { provider: "", id: "x", pinnedAt: "x" } },
      { ...defaultEvalConfig, model: { provider: "x", id: "", pinnedAt: "x" } },
      // infra cpus/memoryGB must be positive integers
      { ...defaultEvalConfig, infra: { ...defaultEvalConfig.infra, cpus: 0 } },
      { ...defaultEvalConfig, infra: { ...defaultEvalConfig.infra, memoryGB: -1 } },
      // costCapUSD fields must be nonnegative
      { ...defaultEvalConfig, costCapUSD: { perRun: -1, perMonth: 0 } },
      { ...defaultEvalConfig, costCapUSD: { perRun: 0, perMonth: -1 } },
      // suite must be non-empty string
      { ...defaultEvalConfig, suite: "" },
      // parityThreshold must be nonnegative
      { ...defaultEvalConfig, parityThreshold: -1 },
      // regressionThreshold must be nonnegative
      { ...defaultEvalConfig, regressionThreshold: -0.1 },
      // reasoning values must be enum members
      { ...defaultEvalConfig, reasoning: { plan: "ultra", execute: "medium", verify: "high" } },
    ]);
  });
});
