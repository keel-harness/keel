import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MatrixTrialStats } from "./harbor-invoker.js";
import {
  DEFAULT_MATRIX_VARIANTS,
  buildMatrixTaskRecord,
  readMatrixRun,
  variantHarborCaps,
  writeMatrixRun,
  type MatrixRunT,
} from "./matrix.js";

const variant = (id: "A" | "B" | "C") => DEFAULT_MATRIX_VARIANTS.find((v) => v.id === id)!;

describe("variantHarborCaps — the --ae caps each variant contributes", () => {
  it("A is a TRUE raw-gross control — gross cap ONLY, NO effective cap (no cache discount)", () => {
    // The load-bearing fix: A must NOT set KEEL_MAX_TOKENS (which now means EFFECTIVE tokens), or it
    // would get B's cache discount and the A↔B contrast would no longer isolate the cost-aware accounting.
    expect(variantHarborCaps(variant("A"))).toEqual({ maxGrossTokens: 400_000 });
    expect(variantHarborCaps(variant("A"))).not.toHaveProperty("maxTokens");
  });
  it("B sets the effective cap + a high gross backstop", () => {
    expect(variantHarborCaps(variant("B"))).toEqual({
      maxTokens: 400_000,
      maxGrossTokens: 1_200_000,
    });
  });
  it("C adds the output guard to B", () => {
    expect(variantHarborCaps(variant("C"))).toEqual({
      maxTokens: 400_000,
      maxGrossTokens: 1_200_000,
      maxOutputTokens: 80_000,
    });
  });
  it("falls back to a 400k gross cap for an A-variant with no explicit cap", () => {
    expect(variantHarborCaps({ id: "A", label: "raw", description: "x" })).toEqual({
      maxGrossTokens: 400_000,
    });
  });
  it("an effective-only (no gross/output) non-A variant emits just the effective cap", () => {
    expect(
      variantHarborCaps({
        id: "B",
        label: "eff-only",
        description: "x",
        maxEffectiveTokens: 250_000,
      }),
    ).toEqual({ maxTokens: 250_000 });
  });
});

describe("buildMatrixTaskRecord — per-task record from ledger stats + variant + provider weight", () => {
  const baseStats: MatrixTrialStats = {
    usage: { inputTokens: 405_000, outputTokens: 5_000, cachedInputTokens: 380_000 },
    reason: "budget",
    turns: 28,
    toolCalls: 33,
    wallTimeMs: 600_000,
  };

  it("computes effective + gross + endKind for a cached-heavy effective-budget stop (variant B)", () => {
    const r = buildMatrixTaskRecord({
      taskId: "db-wal-recovery",
      reward: 0,
      variant: variant("B"),
      cacheReadWeight: 0.1,
      stats: baseStats,
    });
    expect(r.resolved).toBe(false);
    expect(r.grossTokens).toBe(410_000); // 405k + 5k
    expect(r.cachedTokens).toBe(380_000);
    // effective = (405k − 380k) + 0.1·380k + 5k = 25k + 38k + 5k = 68k (cost-true; far below gross)
    expect(r.effectiveTokens).toBe(68_000);
    // budget stop, output<80k, gross<1.2M → the EFFECTIVE cap fired.
    expect(r.endKind).toBe("effective");
    expect(r.turns).toBe(28);
    expect(r.toolCalls).toBe(33);
    expect(r.cacheReadWeight).toBe(0.1);
    expect(r.maxEffectiveTokens).toBe(400_000);
    // Epic 1.14: cacheReadRatio is always present (cached/input); realCostUSD is absent with no pricing.
    expect(r.cacheReadRatio).toBeCloseTo(380_000 / 405_000, 6); // ~0.938
    expect(r.realCostUSD).toBeUndefined();
  });

  it("records the HONEST cache-discounted realCostUSD when pricing is supplied (Epic 1.14)", () => {
    const r = buildMatrixTaskRecord({
      taskId: "db-wal-recovery",
      reward: 0,
      variant: variant("B"),
      cacheReadWeight: 0.1,
      stats: baseStats,
      pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
    });
    // fresh 25k×$3 + cached 380k×$0.30 + output 5k×$15 = 0.075 + 0.114 + 0.075 = $0.264 (the real bill),
    // vs the cache-blind 405k×$3 + 5k×$15 = $1.29 the old meter would have recorded (~4.9× higher).
    expect(r.realCostUSD).toBeCloseTo(0.264, 6);
    expect(r.cacheReadRatio).toBeCloseTo(380_000 / 405_000, 6);
  });

  it("records the configured turn cap (maxTurns) so a 'turn'-ended run is self-describing (ER-038)", () => {
    // Without the turn cap on the record, a turn-bound run (turns≈the cap) is indistinguishable from
    // a budget-bound one — the matrix could not tell whether the budget or the turn cap limited runway.
    const withCap = buildMatrixTaskRecord({
      taskId: "t",
      reward: 0,
      variant: variant("B"),
      cacheReadWeight: 0.1,
      stats: { ...baseStats, reason: "max-turns", turns: 120 },
      maxTurns: 120,
    });
    expect(withCap.maxTurns).toBe(120);
    expect(withCap.endKind).toBe("turn");
    // Absent → omitted (the kernel DEFAULT_MAX_TURNS applied; not duplicated into the eval layer).
    const noCap = buildMatrixTaskRecord({
      taskId: "t",
      reward: 0,
      variant: variant("B"),
      cacheReadWeight: 0.1,
      stats: baseStats,
    });
    expect(noCap.maxTurns).toBeUndefined();
  });

  it("variant A (gross-only, no effective/output cap) attributes a budget stop to 'gross'", () => {
    const r = buildMatrixTaskRecord({
      taskId: "build-cython-ext",
      reward: 0,
      variant: variant("A"),
      // cacheReadWeight is the PROVIDER weight (anthropic 0.1), the SAME across all variants — it is what
      // the record's effective-token metric is computed at, for apples-to-apples cross-variant compare.
      // A's CAP is still raw gross; the weight only affects the recorded effective number (here: no cached).
      cacheReadWeight: 0.1,
      stats: { ...baseStats, usage: { inputTokens: 398_000, outputTokens: 4_000 } },
    });
    expect(r.endKind).toBe("gross"); // gross 402k ≥ A's 400k gross cap
    expect(r.maxEffectiveTokens).toBeUndefined(); // A has no effective cap → omitted from the record
    expect(r.maxOutputTokens).toBeUndefined();
    expect(r.maxGrossTokens).toBe(400_000);
    expect(r.cachedTokens).toBe(0); // no cached subset reported
  });

  it("an effective-only variant record omits gross + output caps (absent-spread branches)", () => {
    const r = buildMatrixTaskRecord({
      taskId: "t",
      reward: 1,
      variant: { id: "B", label: "eff-only", description: "x", maxEffectiveTokens: 250_000 },
      cacheReadWeight: 0.1,
      stats: { ...baseStats, reason: "model-stop" },
    });
    expect(r.maxEffectiveTokens).toBe(250_000);
    expect(r.maxGrossTokens).toBeUndefined();
    expect(r.maxOutputTokens).toBeUndefined();
  });

  it("a resolved task records resolved=true + a 'completed' end kind on model-stop", () => {
    const r = buildMatrixTaskRecord({
      taskId: "cobol-modernization",
      reward: 1,
      variant: variant("B"),
      cacheReadWeight: 0.1,
      stats: { ...baseStats, reason: "model-stop" },
    });
    expect(r.resolved).toBe(true);
    expect(r.endKind).toBe("completed");
  });

  it("attributes an over-generation stop to 'output' under variant C", () => {
    const r = buildMatrixTaskRecord({
      taskId: "circuit-fibsqrt",
      reward: 0,
      variant: variant("C"),
      cacheReadWeight: 0.1,
      stats: {
        ...baseStats,
        usage: { inputTokens: 300_000, outputTokens: 80_000, cachedInputTokens: 200_000 },
      },
    });
    expect(r.endKind).toBe("output");
    expect(r.outputTokens).toBe(80_000);
  });

  it("a trial whose ledger never synced (reason null) is classed 'error', never a silent 0-cost success", () => {
    const r = buildMatrixTaskRecord({
      taskId: "x",
      reward: 0,
      variant: variant("B"),
      cacheReadWeight: 0.1,
      stats: {
        usage: { inputTokens: 0, outputTokens: 0 },
        reason: null,
        turns: 0,
        toolCalls: 0,
        wallTimeMs: null,
      },
    });
    expect(r.endKind).toBe("error");
    expect(r.reason).toBeNull();
    expect(r.wallTimeMs).toBeNull();
  });
});

describe("writeMatrixRun / readMatrixRun round-trip (persistence)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "keel-matrix-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists + reloads a validated run", async () => {
    const run: MatrixRunT = {
      schemaVersion: 1,
      variant: "B",
      label: "effective-400k",
      model: "anthropic/claude-sonnet-4-6",
      suite: "terminal-bench-2",
      ranAt: "2026-06-17T00:00:00.000Z",
      tasks: [
        buildMatrixTaskRecord({
          taskId: "t1",
          reward: 1,
          variant: variant("B"),
          cacheReadWeight: 0.1,
          stats: {
            usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 90 },
            reason: "model-stop",
            turns: 2,
            toolCalls: 1,
            wallTimeMs: 1234,
          },
        }),
      ],
    };
    const file = join(dir, "runs", "B.json");
    await writeMatrixRun(file, run);
    expect(await readMatrixRun(file)).toEqual(run);
  });
});
