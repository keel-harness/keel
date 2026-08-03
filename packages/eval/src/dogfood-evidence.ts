import { z } from "zod";

/** Stable workflow order for the six external-repository dogfood scenarios. */
export const DOGFOOD_WORKFLOW_IDS = [
  "onboarding",
  "feature",
  "debugging",
  "refactor",
  "interruption",
  "warden-heavy",
] as const;

/** The score axes requested by the dogfood protocol, in scorecard column order. */
export const DOGFOOD_SCORE_AXES = [
  "clarity",
  "responsiveness",
  "progress-visibility",
  "user-control",
  "error-recovery",
  "visual-hierarchy",
  "cognitive-load",
  "trust",
  "warden-usefulness",
  "warden-interruption-burden",
  "final-result-confidence",
] as const;

const DogfoodWorkflowId = z.enum(DOGFOOD_WORKFLOW_IDS);
const DogfoodScoreAxis = z.enum(DOGFOOD_SCORE_AXES);
const ScreenshotCheckpoint = z
  .string()
  .regex(/^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.png$/, "checkpoint must be a safe PNG basename");

const DogfoodScenario = z
  .object({
    id: DogfoodWorkflowId,
    externalBaselineCommit: z.string().regex(/^[0-9a-f]{40}$/),
    prompt: z.string().min(1).max(8_000),
    promptProvenance: z.enum(["source-ledger", "canonicalized"]),
    terminal: z
      .object({
        columns: z.number().int().positive().max(500),
        rows: z.number().int().positive().max(300),
      })
      .strict(),
    mode: z.enum(["guided", "autopilot"]),
    expectedPolicyPosture: z
      .object({
        expectedHumanReview: z.enum(["none", "possible", "required"]),
        summary: z.string().min(1).max(1_000),
      })
      .strict(),
    authoritativeFacts: z
      .array(
        z
          .object({
            source: z.enum([
              "session",
              "audit",
              "tool-result",
              "mutation-presentation",
              "verification",
              "interrupt",
            ]),
            statement: z.string().min(1).max(1_000),
          })
          .strict(),
      )
      .min(1),
    expectedUserOutcome: z.string().min(1).max(2_000),
    screenshotCheckpoints: z.array(ScreenshotCheckpoint).min(1),
    costCeilingUsd: z.number().finite().nonnegative(),
  })
  .strict();

/** Private eval artifact contract. It is not a runtime, audit, policy, or shared wire schema. */
export const DogfoodScenarioManifest = z
  .object({
    schemaVersion: z.literal(1),
    sanitized: z.literal(true),
    externalRepository: z
      .object({
        name: z.string().min(1),
        url: z.string().url(),
      })
      .strict(),
    scoreAxes: z.array(DogfoodScoreAxis).length(DOGFOOD_SCORE_AXES.length),
    scenarios: z.array(DogfoodScenario).length(DOGFOOD_WORKFLOW_IDS.length),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (!DOGFOOD_SCORE_AXES.every((axis, index) => manifest.scoreAxes[index] === axis)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scoreAxes"],
        message: "scoreAxes must contain every dogfood axis exactly once in scorecard order",
      });
    }
    if (!DOGFOOD_WORKFLOW_IDS.every((id, index) => manifest.scenarios[index]?.id === id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scenarios"],
        message: "scenarios must contain every dogfood workflow exactly once in canonical order",
      });
    }
  });
export type DogfoodScenarioManifestT = z.infer<typeof DogfoodScenarioManifest>;

const BashController = z
  .object({
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).nullable(),
  })
  .strict();

const ReviewController = z
  .object({
    pending: z.boolean(),
    grantable: z.boolean(),
    terminal: z.boolean(),
  })
  .strict()
  .superRefine((review, context) => {
    if (review.pending === review.terminal) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "review must be either pending or terminal",
      });
    }
    if (review.grantable && !review.pending) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["grantable"],
        message: "only a pending review can be grantable",
      });
    }
  });

const VerificationStatus = z.enum(["passed", "failed", "partial", "not-run"]);
const InterruptState = z.enum(["queued", "applied", "interrupted", "completed"]);

/** Normalized controller facts paired with the claims made by one rendered card or receipt. */
export const DogfoodEvidenceObservation = z
  .object({
    controller: z
      .object({
        bash: BashController.optional(),
        review: ReviewController.optional(),
        mutation: z.object({ available: z.boolean() }).strict().optional(),
        verification: z.object({ status: VerificationStatus }).strict().optional(),
        interrupt: z.object({ state: InterruptState }).strict().optional(),
      })
      .strict(),
    rendered: z
      .object({
        bash: z
          .object({ status: z.enum(["succeeded", "failed", "indeterminate"]) })
          .strict()
          .optional(),
        review: z
          .object({ state: z.enum(["actionable", "waiting", "terminal", "unavailable"]) })
          .strict()
          .optional(),
        mutation: z
          .object({ state: z.enum(["available", "unavailable", "omitted"]) })
          .strict()
          .optional(),
        verification: z.object({ status: VerificationStatus }).strict().optional(),
        interrupt: z.object({ state: InterruptState }).strict().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((observation, context) => {
    for (const domain of ["bash", "review", "mutation", "verification", "interrupt"] as const) {
      if (
        (observation.controller[domain] === undefined) !==
        (observation.rendered[domain] === undefined)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [observation.controller[domain] === undefined ? "controller" : "rendered", domain],
          message: `${domain} controller and rendered observations must be paired`,
        });
      }
    }
  });
export type DogfoodEvidenceObservationT = z.infer<typeof DogfoodEvidenceObservation>;

const DogfoodEvidenceDomain = z.enum(["bash", "review", "mutation", "verification", "interrupt"]);

export const DogfoodEvidenceIssue = z
  .object({
    code: z.string(),
    domain: DogfoodEvidenceDomain,
    expected: z.string(),
    rendered: z.string(),
  })
  .strict();
export type DogfoodEvidenceIssueT = z.infer<typeof DogfoodEvidenceIssue>;

function issue(
  domain: DogfoodEvidenceIssueT["domain"],
  expected: string,
  rendered: string,
): DogfoodEvidenceIssueT {
  return {
    code: `${domain}-render-mismatch`,
    domain,
    expected,
    rendered,
  };
}

/**
 * Compare already-authoritative controller facts with rendered claims.
 *
 * This function neither accepts action arguments nor emits a policy decision. Policy and risk
 * classification remain exclusively Warden-owned; this is an offline presentation-truth check.
 */
export function compareDogfoodEvidence(input: unknown): DogfoodEvidenceIssueT[] {
  const observation = DogfoodEvidenceObservation.parse(input);
  const issues: DogfoodEvidenceIssueT[] = [];

  if (observation.controller.bash && observation.rendered.bash) {
    const { exitCode, signal } = observation.controller.bash;
    const expected =
      signal !== null || (exitCode !== null && exitCode !== 0)
        ? "failed"
        : exitCode === 0
          ? "succeeded"
          : "indeterminate";
    if (observation.rendered.bash.status !== expected) {
      issues.push(issue("bash", expected, observation.rendered.bash.status));
    }
  }

  if (observation.controller.review && observation.rendered.review) {
    const expected = observation.controller.review.terminal
      ? "terminal"
      : observation.controller.review.grantable
        ? "actionable"
        : "waiting";
    if (observation.rendered.review.state !== expected) {
      issues.push(issue("review", expected, observation.rendered.review.state));
    }
  }

  if (observation.controller.mutation && observation.rendered.mutation) {
    const expected = observation.controller.mutation.available ? "available" : "unavailable";
    if (observation.rendered.mutation.state !== expected) {
      issues.push(issue("mutation", expected, observation.rendered.mutation.state));
    }
  }

  if (observation.controller.verification && observation.rendered.verification) {
    const expected = observation.controller.verification.status;
    if (observation.rendered.verification.status !== expected) {
      issues.push(issue("verification", expected, observation.rendered.verification.status));
    }
  }

  if (observation.controller.interrupt && observation.rendered.interrupt) {
    const expected = observation.controller.interrupt.state;
    if (observation.rendered.interrupt.state !== expected) {
      issues.push(issue("interrupt", expected, observation.rendered.interrupt.state));
    }
  }

  return issues;
}
