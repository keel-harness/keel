import { z } from "zod";

/** Reasoning-effort level for the "sandwich" (high at plan/verify, lower at execute). */
export const ReasoningEffort = z.enum(["low", "medium", "high"]);
export type ReasoningEffortT = z.infer<typeof ReasoningEffort>;

const EvalModel = z
  .object({
    provider: z.string().min(1),
    id: z.string().min(1), // `<PINNED_MODEL_ID>` placeholder until OQ-3
    pinnedAt: z.string().min(1),
  })
  .strict();

/** The reasoning "sandwich" (high at plan/verify, lower at execute). Exported so the scoreboard records
 *  the SAME schema with each score (QR-5 confound control) — one definition, no drift. */
export const ReasoningSandwich = z
  .object({ plan: ReasoningEffort, execute: ReasoningEffort, verify: ReasoningEffort })
  .strict();
export type ReasoningSandwichT = z.infer<typeof ReasoningSandwich>;

const ReferenceHarness = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    score: z.number().nullable(), // null until measured by us on identical infra
  })
  .strict();

/** The pinned infra block (Appendix F). Exported so the scoreboard records the SAME schema (parity:
 *  keel + reference must run on identical infra) — one definition, not two that can silently diverge. */
export const EvalInfra = z
  .object({
    cpus: z.number().int().positive(),
    memoryGB: z.number().int().positive(),
    taskTimeoutSec: z.number().int().positive(),
    networkPolicy: z.string().min(1),
    retries: z.number().int().nonnegative(),
  })
  .strict();
export type EvalInfraT = z.infer<typeof EvalInfra>;

const TrajectoryConfig = z.object({ store: z.boolean(), dir: z.string().min(1) }).strict();

const CostCapUSD = z
  .object({
    // N7: `.finite()` additionally rejects Infinity (which `> 0` passes but defeats the cap's
    // purpose).  The cost-cap guard in cost-cap.ts enforces a *positive* cap at run time; the
    // schema accepts 0 as a placeholder value (the guard, not the schema, refuses a 0 cap).
    perRun: z.number().nonnegative().finite(),
    // NOTE: the perMonth GUARD (`assertWithinMonthlyCap`) + the cross-run spend LEDGER that feeds it
    // `monthToDateUSD` + the `guardedRun` spending chokepoint now exist + are tested (Epic 1.11 slice 3,
    // `spend-ledger.ts`). What remains is the LIVE benchmark runner that calls `guardedRun` with a real
    // model spend — Phase B (B1). Until that runner exists no real spend path is reachable. Keep this in
    // sync with cost-cap.ts + ADR-0022.
    perMonth: z.number().nonnegative().finite(),
  })
  .strict();

/**
 * Normative benchmark configuration (Appendix F). Values are human-set per OQ-3/OQ-4; the
 * STRUCTURE is normative and frozen-ish (a field change needs a spec/Appendix-F update). The
 * schema permits placeholder values (`<PINNED_MODEL_ID>`, `score: null`, `costCapUSD.perRun: 0`);
 * the cost-cap GUARD — not the schema — refuses a 0/unset cap at run time.
 */
export const EvalConfig = z
  .object({
    suite: z.string().min(1),
    subset: z.string().min(1),
    smoke: z.string().min(1),
    model: EvalModel,
    reasoning: ReasoningSandwich,
    referenceHarness: ReferenceHarness,
    infra: EvalInfra,
    trajectories: TrajectoryConfig,
    runs: z.number().int().positive(),
    aggregate: z.enum(["median", "mean"]),
    costCapUSD: CostCapUSD,
    parityThreshold: z.number().nonnegative(),
    regressionThreshold: z.number().nonnegative(),
  })
  .strict();
export type EvalConfigT = z.infer<typeof EvalConfig>;

/** Validate an already-parsed value as an EvalConfig (parse, don't validate-by-hope). */
export function loadEvalConfig(raw: unknown): EvalConfigT {
  return EvalConfig.parse(raw);
}
