import { z } from "zod";
import { JsonObject, ModelUsage, StopReason, type StopReasonT } from "@keel/shared";

// Why the loop stopped. Relocated to @keel/shared (Epic 1.4) so the durable run_status
// ledger event shares the vocabulary; re-exported here for back-compat. Every run emits
// exactly one `stop`.
export { StopReason } from "@keel/shared";
export type { StopReasonT } from "@keel/shared";

/** Non-error terminal code for a turn that answered after an unexecuted review-required action. */
export const REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE = "REVIEW_REQUIRED_AFTER_SYNTHESIS";
export const REVIEW_REQUIRED_AFTER_SYNTHESIS_MESSAGE =
  "answered from prior evidence; reviewed action was not executed";
export const BLOCKED_AFTER_SYNTHESIS_CODE = "BLOCKED_AFTER_SYNTHESIS";
export const BLOCKED_AFTER_SYNTHESIS_MESSAGE =
  "answered from prior evidence; blocked action was not executed";
/** Non-error terminal detail: the next estimated request input cannot fit the gross-token runway. */
export const GROSS_RUNWAY_PREFLIGHT_CODE = "GROSS_RUNWAY_PREFLIGHT";

export function stopCodeNeedsAttention(code: string | undefined): boolean {
  return code === REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE || code === BLOCKED_AFTER_SYNTHESIS_CODE;
}

export function shouldPreserveStopDetailAfterLoopStopped(input: {
  readonly loopStop: StopReasonT;
  readonly lastStop: StopReasonT | undefined;
  readonly lastStopCode: string | undefined;
}): boolean {
  return (
    input.loopStop === "error" &&
    ((input.lastStop === "model-stop" && stopCodeNeedsAttention(input.lastStopCode)) ||
      (input.lastStop === "error" && input.lastStopCode !== undefined))
  );
}

export type LoopStoppedReason =
  | "succeeded"
  | "loop-max-iterations"
  | "loop-deadline"
  | "loop-budget"
  | "loop-no-progress"
  | "aborted"
  | "error";

export function stopReasonForLoopStopped(reason: LoopStoppedReason): StopReasonT | undefined {
  switch (reason) {
    case "succeeded":
      return undefined;
    case "loop-max-iterations":
      return "max-turns";
    case "loop-deadline":
      return "deadline";
    case "loop-budget":
      return "budget";
    case "loop-no-progress":
      return "loop-detected";
    case "aborted":
      return "aborted";
    case "error":
      return "error";
  }
}

/**
 * The kernel loop's live event vocabulary — fine-grained and in-process, the
 * loop's public contract. Distinct from the coarse persisted `SessionEvent`
 * (`@keel/shared`): sessions (Epic 1.4) reduce these into the durable JSONL log;
 * the TUI (1.5) renders them live; eval records them as trajectory.
 *
 * `reasoning-delta` and buffered `tool-call-delta` join in Epic 1.3 with the real
 * provider adapter (the simulator emits neither).
 */
export const KernelEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run-started") }).strict(),
  z.object({ type: z.literal("turn-started"), turn: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("text-delta"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("tool-call"),
      id: z.string().min(1),
      name: z.string().min(1),
      args: JsonObject,
    })
    .strict(),
  /** An ephemeral live-output line from a *running* tool (Epic 1.5c — purposeful liveness). Emitted
   *  between `tool-call` and `tool-result` as the tool streams stdout; `chunk` is the latest completed
   *  line (raw — the reducer control-strips it). Display-only: the durable record is the eventual
   *  `tool-result`, so the recorder tees this through WITHOUT persisting it (like `text-delta`). */
  z
    .object({ type: z.literal("tool-output-delta"), id: z.string().min(1), chunk: z.string() })
    .strict(),
  z
    .object({
      type: z.literal("tool-result"),
      id: z.string().min(1),
      ok: z.boolean(),
      output: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("stop"),
      reason: StopReason,
      /** Structured terminal detail: provider error code for `error`, or non-error recovery detail. */
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .strict(),
  /** The pre-completion verification interceptor injected a verification turn (1.1b).
   *  Carries the prompt that was injected so observers can render/audit it. */
  z.object({ type: z.literal("verification-requested"), prompt: z.string() }).strict(),
  /** Loop detection tripped (1.1c) — emitted for warning/forced-pivot recovery before any halt.
   *  `signal` is which heuristic fired; `detail` is the repeated tool or file path; `guidance`, when
   *  present, is the exact user-message text the loop injected so recorders do not reconstruct it from
   *  separate config. Optional for compatibility with hand-authored/internal fixture events. */
  z
    .object({
      type: z.literal("loop-detected"),
      signal: z.enum(["tool-repeat", "file-edits"]),
      detail: z.string(),
      guidance: z.string().optional(),
    })
    .strict(),
  /** Budget-awareness warning injected at a usage threshold before the cap (1.1c→1.1d).
   *  Carries cumulative tokens used and the cap so observers can render remaining budget. */
  z
    .object({
      type: z.literal("budget-warning"),
      /** Explicit on new events; absent means the legacy effective-cost warning. Kernel-local only. */
      metric: z.enum(["effective", "gross"]).optional(),
      usedTokens: z.number().int().nonnegative(),
      maxTokens: z.number().int().positive(),
    })
    .strict(),
  /** An external op exceeded its deadline (1.1e) — recorded distinctly from model/tool
   *  errors (§8.2). `source` is which call timed out (model transport joins in Epic 1.3). */
  z
    .object({ type: z.literal("infra-error"), source: z.enum(["tool"]), message: z.string() })
    .strict(),
  z.object({ type: z.literal("run-finished"), usage: ModelUsage }).strict(),
]);
export type KernelEventT = z.infer<typeof KernelEvent>;
