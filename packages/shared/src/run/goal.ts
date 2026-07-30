import { z } from "zod";
import { LifecycleActionId } from "../lifecycle/manifest.js";

export const RUN_CONTROL_SCHEMA_VERSION = "run-control.keel.dev/v1" as const;

/** Run-control ids are schema-validated on ledger READ, so they are subject to the ledger-safe-id
 *  invariant (SEC-014): a GENERATED id — plus its longest derived composite (`<id>_exit_<n>`) —
 *  must stay below the entropy net's token floor (`ENTROPY_NET_MIN_TOKEN_CHARS`), or the redaction
 *  filter collapses it to a `[redacted:high-entropy]` marker this regex then rejects, bricking the
 *  session on read (2026-07-18 audit). `stableId` in the kernel's run-control parser derives its
 *  slug cap from that constant; mint any new id source against it too. */
const RunControlId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u, "run-control ids must be stable slugs");

const RunBounds = z
  .object({
    maxTurns: z.number().int().positive().max(1_000).optional(),
    maxWallMs: z.number().int().positive().max(86_400_000).optional(),
    maxEffectiveTokens: z.number().int().positive().max(100_000_000).optional(),
  })
  .strict()
  .superRefine((bounds, ctx) => {
    if (
      bounds.maxTurns === undefined &&
      bounds.maxWallMs === undefined &&
      bounds.maxEffectiveTokens === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one bound is required when bounds are present",
      });
    }
  });
export type RunBoundsT = z.infer<typeof RunBounds>;

export const GoalCommandCheck = z
  .object({
    action: LifecycleActionId.optional(),
    argv: z.array(z.string().min(1).max(1024)).min(1).max(64).optional(),
  })
  .strict()
  .superRefine((check, ctx) => {
    const shapes = [check.action !== undefined, check.argv !== undefined].filter(Boolean);
    if (shapes.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "command check must define exactly one of action or argv",
      });
    }
  });
export type GoalCommandCheckT = z.infer<typeof GoalCommandCheck>;

const GoalCommandCriterion = z
  .object({
    id: RunControlId,
    kind: z.literal("command"),
    check: GoalCommandCheck,
  })
  .strict();

const GoalNarrativeCriterion = z
  .object({
    id: RunControlId,
    kind: z.literal("narrative"),
    evidenceHint: z.string().min(1).max(2_000).optional(),
  })
  .strict();

export const GoalCriterion = z.discriminatedUnion("kind", [
  GoalCommandCriterion,
  GoalNarrativeCriterion,
]);
export type GoalCriterionT = z.infer<typeof GoalCriterion>;
export type GoalCommandCriterionT = Extract<GoalCriterionT, { kind: "command" }>;

const GoalValidation = z
  .object({
    tier: z.enum(["minimal", "standard", "strict"]),
  })
  .strict();

export const Goal = z
  .object({
    schemaVersion: z.literal(RUN_CONTROL_SCHEMA_VERSION),
    id: RunControlId,
    objective: z.string().trim().min(1).max(4_096),
    doneWhen: z.array(GoalCriterion).min(1).max(64),
    validation: GoalValidation.optional(),
    bounds: RunBounds.optional(),
    requiresCompletionAudit: z.literal(true).default(true),
  })
  .strict()
  .superRefine((goal, ctx) => {
    const seen = new Set<string>();
    goal.doneWhen.forEach((criterion, index) => {
      if (seen.has(criterion.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["doneWhen", index, "id"],
          message: `duplicate goal criterion id: ${criterion.id}`,
        });
      }
      seen.add(criterion.id);
    });
  });
export type GoalT = z.infer<typeof Goal>;

export const GoalEvidenceCitation = z
  .object({
    kind: z.enum(["session_event", "audit_record"]),
    ref: z.string().min(1).max(512),
  })
  .strict();
export type GoalEvidenceCitationT = z.infer<typeof GoalEvidenceCitation>;

export const GoalCriterionAudit = z
  .object({
    criterionId: RunControlId,
    status: z.enum(["satisfied", "unsatisfied", "unknown"]),
    assurance: z.enum(["machine_verified", "evidence_cited", "unverified"]),
    evidence: z.array(GoalEvidenceCitation).max(32),
    message: z.string().min(1).max(2_000).optional(),
  })
  .strict();
export type GoalCriterionAuditT = z.infer<typeof GoalCriterionAudit>;

const GoalValidationAudit = z
  .object({
    status: z.enum(["passed", "failed", "not_configured", "not_run"]),
    tier: z.enum(["minimal", "standard", "strict"]).optional(),
  })
  .strict();
export type GoalValidationAuditT = z.infer<typeof GoalValidationAudit>;

export const GoalCompletionAudit = z
  .object({
    schemaVersion: z.literal(RUN_CONTROL_SCHEMA_VERSION),
    goalId: RunControlId,
    verdict: z.enum(["complete", "incomplete", "unverified"]),
    validation: GoalValidationAudit,
    criteria: z.array(GoalCriterionAudit).min(1).max(64),
    gaps: z.array(RunControlId).max(64),
  })
  .strict()
  .superRefine((audit, ctx) => {
    const allCriteriaSatisfied = audit.criteria.every(
      (criterion) => criterion.status === "satisfied",
    );
    if (audit.verdict === "complete") {
      if (!allCriteriaSatisfied) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["criteria"],
          message: "complete goal audit requires every criterion to be satisfied",
        });
      }
      if (audit.validation.status !== "passed") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["validation", "status"],
          message: "complete goal audit requires passed validation",
        });
      }
      if (audit.gaps.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["gaps"],
          message: "complete goal audit cannot have gaps",
        });
      }
    }
  });
export type GoalCompletionAuditT = z.infer<typeof GoalCompletionAudit>;

export function commandCriterionMatchesArgv(
  criterion: GoalCriterionT,
  argv: readonly string[],
): boolean {
  if (criterion.kind !== "command") return false;
  const expected = criterion.check.argv;
  if (expected === undefined) return false;
  if (expected.length !== argv.length) return false;
  return expected.every((part, index) => part === argv[index]);
}
