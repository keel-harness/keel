import type { ExecutorPort, GoalT, LifecycleManifestT } from "@keel/shared";
import type { GoalValidationResult } from "./goal-audit.js";
import { toolPresentationOutcome } from "../tool-presentation-outcome.js";

export interface RunGoalValidationOptions {
  readonly validation: GoalT["validation"];
  readonly manifest?: LifecycleManifestT;
  readonly executor: ExecutorPort;
  readonly signal?: AbortSignal;
  readonly onActionStart?: (action: string) => void;
  /** When `true`, the tier is not launched and a configured tier reports the honest `not_run` — used
   *  when the goal turn was interrupted before validation could run (no wasted, unstoppable suite). */
  readonly skip?: boolean;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Runs a goal's configured validation tier and returns its honest result. The tier resolves to the
 * trusted lifecycle manifest's `validationTiers[tier].required` actions (Epic 2.11 / ADR-0058) and
 * each runs as a governed `lifecycle.run` through the existing ExecutorPort — classified, policy-
 * checked, and audited exactly like a model-issued tool call (ADR-0060 §3 governed-execute, §4 "no
 * second validation engine"). `passed` is structurally unreachable without a real `ok` from EVERY
 * required action; a missing manifest, undeclared tier, or interrupted turn reports the honest
 * `not_run`, never a fabricated pass.
 */
export async function runGoalValidation(
  options: RunGoalValidationOptions,
): Promise<GoalValidationResult> {
  const { validation, manifest, executor, signal, skip, onActionStart } = options;
  if (validation === undefined) return { status: "not_configured" };
  const tier = validation.tier;
  if (skip === true) return { status: "not_run", tier };
  const spec = manifest?.validationTiers?.[tier];
  if (spec === undefined) return { status: "not_run", tier };
  for (const action of spec.required) {
    if (isAborted(signal)) return { status: "not_run", tier };
    onActionStart?.(action);
    if (isAborted(signal)) return { status: "not_run", tier };
    const result = await executor.execute(
      { id: `goal-validation:${action}`, name: "lifecycle.run", args: { action } },
      signal !== undefined ? { signal } : undefined,
    );
    if (isAborted(signal)) return { status: "not_run", tier };
    if (!result.ok) {
      const outcome = toolPresentationOutcome(result);
      const failureKind =
        outcome === "review" || outcome === "blocked" || outcome === "stopped" ? outcome : "failed";
      return { status: "failed", tier, failedAction: action, failureKind };
    }
  }
  return { status: "passed", tier };
}
