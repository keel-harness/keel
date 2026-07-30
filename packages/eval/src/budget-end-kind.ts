import { z } from "zod";
import { type StopReasonT, type UsageForBudget, grossTokens } from "@keel/shared";

/**
 * Reconstruct WHICH budget (or other terminal) ended a run, for the Epic 1.11 A/B/C matrix (ER-038).
 *
 * The kernel's `stop` event records `reason: StopReason` — and for a budget stop, all three caps report
 * the SAME `"budget"` reason (ADR-0044 deliberately did not mint new `StopReason`s / change the frozen
 * schema). Which ceiling fired is reconstructable from the recorded `usage` **together with the run's
 * configured caps** — and ONLY here, in the eval layer, which has both (a generic trajectory reader has
 * the usage but not the caps). This is exactly that reconstruction, and it mirrors the loop's check
 * ORDER (output → gross → effective) so the attribution is faithful to what actually stopped the run.
 *
 * The matrix gate (ER-038): does cost-aware runway convert `budget`-ended failures into resolves, or
 * just into longer failures? Answering it needs `effective` vs `gross` vs `output` distinguished, plus
 * `turn` / `timeout` / `error` so a "budget" win is not confused with a turn-cap or infra death.
 */

/** The terminal classification we report per task. */
export const BudgetEndKind = z.enum([
  "completed", // model-stop: the agent ended on its own (whether it RESOLVED is the verifier's call)
  "effective", // budget: the primary effective-cost cap (KEEL_MAX_TOKENS)
  "gross", // budget: the raw-token emergency backstop (KEEL_MAX_GROSS_TOKENS)
  "output", // budget: the output-token over-generation guard (KEEL_MAX_OUTPUT_TOKENS)
  "turn", // max-turns
  "loop", // loop-detected
  "length", // a truncated turn (provider length finish)
  "aborted", // an abort signal
  "timeout", // a harbor/task-level wall-clock SIGKILL (set by the runner; not a kernel stop reason)
  "deadline", // keel's OWN wall-clock budget (KEEL_MAX_WALL_SEC) — a graceful self-stop (ADR-0051)
  "error", // a provider/harness error, OR no clean run_status synced (fail-closed unknown)
]);
export type BudgetEndKindT = z.infer<typeof BudgetEndKind>;

/** The run's configured caps — what the kernel checked `usage` against (the matrix variant sets these). */
export interface BudgetCaps {
  /** KEEL_MAX_TOKENS — the effective-cost cap. */
  readonly maxEffectiveTokens?: number | undefined;
  /** KEEL_MAX_GROSS_TOKENS — the raw-token backstop. */
  readonly maxGrossTokens?: number | undefined;
  /** KEEL_MAX_OUTPUT_TOKENS — the output guard. */
  readonly maxOutputTokens?: number | undefined;
  /** The provider cache-read weight the effective cap used (capability table; for the record). */
  readonly cacheReadWeight: number;
}

/**
 * Reconstruct the end kind from the kernel `stop` reason + the final `usage` + the configured caps.
 * For a `"budget"` stop it attributes the specific cap in the loop's own priority order (output, then
 * gross, then effective) — so the reconstruction matches the cap that actually fired. The harbor-level
 * `timeout` and the no-ledger `error` cases are NOT kernel stop reasons; the runner sets those directly.
 */
export function reconstructBudgetEndKind(
  reason: StopReasonT,
  usage: UsageForBudget,
  caps: BudgetCaps,
): BudgetEndKindT {
  switch (reason) {
    case "model-stop":
      return "completed";
    case "max-turns":
      return "turn";
    case "loop-detected":
      return "loop";
    case "length":
      return "length";
    case "aborted":
      return "aborted";
    case "deadline":
      return "deadline";
    case "error":
      return "error";
    case "budget": {
      // Same order the loop checks (loop.ts): output guard, then gross backstop, then effective cap.
      if (caps.maxOutputTokens !== undefined && usage.outputTokens >= caps.maxOutputTokens) {
        return "output";
      }
      if (caps.maxGrossTokens !== undefined && grossTokens(usage) >= caps.maxGrossTokens) {
        return "gross";
      }
      return "effective";
    }
  }
}
