import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { effectiveTokens, grossTokens, redactJsonValue } from "@keel/shared";
import { cacheReadRatio, realCostUSD, type TokenPricing } from "./cost-cap.js";
import {
  BudgetEndKind,
  type BudgetCaps,
  type BudgetEndKindT,
  reconstructBudgetEndKind,
} from "./budget-end-kind.js";
import type { MatrixTrialStats } from "./harbor-invoker.js";

/**
 * The Epic 1.11 A/B/C budget matrix (ER-038). This module is **instrumentation + variant config only**
 * — it runs NO benchmark and spends nothing; it shapes the harbor invocations (which caps to set) and
 * turns each trial's synced ledger into a comparable per-task record. The gate it serves: *does
 * cost-aware runway convert `budget`-ended failures into resolves, or just into longer failures?* That
 * needs the budget end kind reconstructed (effective/gross/output) alongside resolve rate, effective
 * cost, gross/cached/output tokens, wall time, turns, and tool calls — all per task, per variant.
 *
 * Explicitly NOT here (per the matrix-prep scope): prompt changes, convergence heuristics
 * (maxToolCalls / stagnation — ER-038's *next* step, after the matrix answers the question), and the
 * heredoc/large-artifact guard (ER-037, Phase-2 warden). Those stay out until the data says otherwise.
 */

/** The three variants on the same task set, holding the model + provider fixed. Caps are the only
 *  difference, so any resolve-rate delta is attributable to the budget controller, not other changes. */
export const MatrixVariantId = z.enum(["A", "B", "C"]);
export type MatrixVariantIdT = z.infer<typeof MatrixVariantId>;

export interface MatrixVariant {
  readonly id: MatrixVariantIdT;
  readonly label: string;
  readonly description: string;
  /** KEEL_MAX_TOKENS (effective-cost cap). Unset for A (a pure raw-token baseline). */
  readonly maxEffectiveTokens?: number;
  /** KEEL_MAX_GROSS_TOKENS (raw backstop). A uses it as its ONLY cap (= the pre-ADR-0044 behavior);
   *  B/C set it high to bound wall time without cutting cost-cheap progress. */
  readonly maxGrossTokens?: number;
  /** KEEL_MAX_OUTPUT_TOKENS (over-generation guard). Only C sets it. */
  readonly maxOutputTokens?: number;
}

/**
 * The default A/B/C variants at the B1-measured 400k operating point. First-guess numbers — the matrix
 * exists to tune them; they are NOT contracts. (cf. risk-register ER-038.)
 * - **A — raw baseline:** a single 400k *gross* cap, no effective discount. Reproduces the pre-ADR-0044
 *   behavior exactly (gross-only), so it is the control the cost-aware variants are measured against.
 * - **B — effective:** a 400k *effective*-cost cap (cached discounted by the provider's rate) + a high
 *   1.2M gross backstop so a cached-heavy task gets cost-proportional runway but cannot run forever.
 * - **C — effective + output guard:** B plus an 80k output cap, to see whether bounding over-generation
 *   (the circuit-fibsqrt mode) helps without cutting legitimate large-artifact work.
 */
export const DEFAULT_MATRIX_VARIANTS: readonly MatrixVariant[] = [
  {
    id: "A",
    label: "raw-400k",
    description: "single 400k gross cap (pre-ADR-0044 control)",
    maxGrossTokens: 400_000,
  },
  {
    id: "B",
    label: "effective-400k",
    description: "400k effective-cost cap + 1.2M gross backstop",
    maxEffectiveTokens: 400_000,
    maxGrossTokens: 1_200_000,
  },
  {
    id: "C",
    label: "effective-400k+out80k",
    description: "B + 80k output over-generation guard",
    maxEffectiveTokens: 400_000,
    maxGrossTokens: 1_200_000,
    maxOutputTokens: 80_000,
  },
];

/** The harbor `--ae` cap fields a variant contributes (fed straight into `buildHarborRunArgs`).
 *
 * **Variant A is a TRUE raw-gross control:** it emits ONLY `KEEL_MAX_GROSS_TOKENS` (no
 * `KEEL_MAX_TOKENS`), so the in-container binary caps on raw `input + output` with NO cache discount —
 * exactly the pre-ADR-0044 behavior. This is load-bearing: since `KEEL_MAX_TOKENS` now means *effective*
 * tokens, putting A's cap there would hand A the same cache-discounted runway as B and the A↔B contrast
 * would no longer isolate the cost-aware accounting (the thing the matrix measures). B/C set the
 * effective cap (`KEEL_MAX_TOKENS`) plus their guards. */
export function variantHarborCaps(v: MatrixVariant): {
  maxTokens?: number;
  maxGrossTokens?: number;
  maxOutputTokens?: number;
} {
  if (v.id === "A") {
    // RAW control: a gross-only cap. NO effective cap → no cache discount → true pre-ADR-0044 behavior.
    return { maxGrossTokens: v.maxGrossTokens ?? 400_000 };
  }
  return {
    maxTokens: v.maxEffectiveTokens ?? 400_000,
    ...(v.maxGrossTokens !== undefined ? { maxGrossTokens: v.maxGrossTokens } : {}),
    ...(v.maxOutputTokens !== undefined ? { maxOutputTokens: v.maxOutputTokens } : {}),
  };
}

/** One task × one variant: every number the ER-038 question needs, derived from the synced ledger +
 *  the verifier reward + the variant's caps + the provider cache weight. Persisted per run. */
export const MatrixTaskRecord = z
  .object({
    taskId: z.string().min(1),
    variant: MatrixVariantId,
    resolved: z.boolean(),
    reward: z.number().finite(),
    // The caps this run was checked against (so the record is self-describing — reconstruction needs them).
    maxEffectiveTokens: z.number().nonnegative().optional(),
    maxGrossTokens: z.number().nonnegative().optional(),
    maxOutputTokens: z.number().nonnegative().optional(),
    cacheReadWeight: z.number().min(0).max(1),
    // Measured token usage (cumulative).
    inputTokens: z.number().nonnegative(),
    cachedTokens: z.number().nonnegative(),
    // The cache-WRITE subset (ADR-0047), for exact real-cost. Always present (0 when unreported).
    cacheCreationTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    grossTokens: z.number().nonnegative(),
    effectiveTokens: z.number().nonnegative(),
    // Epic 1.14 — the HONEST cost meter, alongside the gross/effective token counts. `cacheReadRatio`
    // (cached/input, the measured cache-hit fraction) is always derivable from usage. `realCostUSD` is
    // the cache-discounted bill the API actually charges; present only when the run supplied pricing
    // (the matrix can run without a price table). Reporting-only — neither feeds the spend GUARD.
    cacheReadRatio: z.number().min(0).max(1),
    realCostUSD: z.number().nonnegative().optional(),
    // Trajectory shape.
    turns: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    wallTimeMs: z.number().nonnegative().nullable(),
    // The configured turn cap this run was bounded by (ER-038). Present when the matrix set an explicit
    // KEEL_MAX_TURNS; absent → the in-container kernel DEFAULT_MAX_TURNS applied (not duplicated into the
    // eval layer to avoid drift). Lets a `turn`-ended run be told apart from a budget-ended one.
    maxTurns: z.number().int().positive().optional(),
    // Why the run ended.
    reason: z.string().nullable(), // the kernel StopReason, or null if no ledger synced
    endKind: BudgetEndKind, // the reconstructed budget end kind
  })
  .strict();
export type MatrixTaskRecordT = z.infer<typeof MatrixTaskRecord>;

/** A whole matrix run: one variant over the task set, with the run identity for cross-variant join. */
export const MatrixRun = z
  .object({
    schemaVersion: z.literal(1),
    variant: MatrixVariantId,
    label: z.string().min(1),
    model: z.string().min(1),
    suite: z.string().min(1),
    /** ISO timestamp — stamped by the caller (no clock in this pure module). */
    ranAt: z.string().min(1),
    tasks: z.array(MatrixTaskRecord),
  })
  .strict();
export type MatrixRunT = z.infer<typeof MatrixRun>;

/** Build one task record from a trial's stats + the variant + the provider cache weight (pure). A trial
 *  whose ledger never synced (`reason === null`) is classed `error` — never silently a 0-cost success. */
export function buildMatrixTaskRecord(args: {
  taskId: string;
  reward: number;
  variant: MatrixVariant;
  cacheReadWeight: number;
  stats: MatrixTrialStats;
  /** The configured KEEL_MAX_TURNS for this run (ER-038), if the matrix set one — recorded so a
   *  turn-bound run is self-describing. Omitted → the in-container kernel default applied. */
  maxTurns?: number;
  /** Owner-set pricing (Epic 1.14). When given, the record carries `realCostUSD` (the cache-discounted
   *  bill); when omitted (a price-table-less analysis run) only the token counts + `cacheReadRatio` land. */
  pricing?: TokenPricing;
}): MatrixTaskRecordT {
  const { taskId, reward, variant, cacheReadWeight, stats, maxTurns, pricing } = args;
  const usage = stats.usage;
  const caps: BudgetCaps = {
    maxEffectiveTokens: variant.maxEffectiveTokens,
    maxGrossTokens: variant.maxGrossTokens,
    maxOutputTokens: variant.maxOutputTokens,
    cacheReadWeight,
  };
  const endKind: BudgetEndKindT =
    stats.reason === null ? "error" : reconstructBudgetEndKind(stats.reason, usage, caps);
  return MatrixTaskRecord.parse({
    taskId,
    variant: variant.id,
    resolved: reward > 0,
    reward,
    ...(variant.maxEffectiveTokens !== undefined
      ? { maxEffectiveTokens: variant.maxEffectiveTokens }
      : {}),
    ...(variant.maxGrossTokens !== undefined ? { maxGrossTokens: variant.maxGrossTokens } : {}),
    ...(variant.maxOutputTokens !== undefined ? { maxOutputTokens: variant.maxOutputTokens } : {}),
    cacheReadWeight,
    inputTokens: usage.inputTokens,
    cachedTokens: usage.cachedInputTokens ?? 0,
    cacheCreationTokens: usage.cacheCreationInputTokens ?? 0,
    outputTokens: usage.outputTokens,
    grossTokens: grossTokens(usage),
    effectiveTokens: effectiveTokens(usage, cacheReadWeight),
    cacheReadRatio: cacheReadRatio(usage),
    ...(pricing !== undefined ? { realCostUSD: realCostUSD(usage, pricing) } : {}),
    turns: stats.turns,
    toolCalls: stats.toolCalls,
    wallTimeMs: stats.wallTimeMs,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    reason: stats.reason,
    endKind,
  });
}

/** Persist a matrix run. Like the scoreboard, the value is routed through the SEC-014 `redactJsonValue`
 *  filter BEFORE serializing (the records are aggregate numbers + a task id, but never leak) — redacting
 *  before stringify keeps the JSON valid by construction (F1 integrity). */
export async function writeMatrixRun(file: string, run: MatrixRunT): Promise<void> {
  const valid = MatrixRun.parse(run);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(redactJsonValue(valid), null, 2)}\n`, "utf8");
}

/** Read + validate a persisted matrix run (parse, don't validate-by-hope). */
export async function readMatrixRun(file: string): Promise<MatrixRunT> {
  return MatrixRun.parse(JSON.parse(await readFile(file, "utf8")) as unknown);
}
