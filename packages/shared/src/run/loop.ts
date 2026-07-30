import { z } from "zod";
import { EffectKind, type EffectKindT } from "../policy/side-effect.js";
import { GoalCommandCheck, RUN_CONTROL_SCHEMA_VERSION } from "./goal.js";

export { RUN_CONTROL_SCHEMA_VERSION } from "./goal.js";

const RunControlId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u, "run-control ids must be stable slugs");

/** Schema ceiling for loop iterations. Exported because the kernel's run-control id budget
 *  reserves room for the loop exit-check tool-call id `<loopId>_exit_<maxIterations>` under the
 *  SEC-014 ledger-safe-id invariant — raising this bound widens that composite, so both sides
 *  must move together (the parser derives its suffix reserve from this constant). */
export const MAX_LOOP_ITERATIONS = 1_000;

const LoopBounds = z
  .object({
    maxIterations: z.number().int().positive().max(MAX_LOOP_ITERATIONS),
    maxWallMs: z.number().int().positive().max(86_400_000).optional(),
    maxEffectiveTokens: z.number().int().positive().max(100_000_000).optional(),
  })
  .strict();

const LoopUntil = z
  .object({
    kind: z.literal("command"),
    check: GoalCommandCheck,
    satisfiedWhen: z.literal("exitZero"),
  })
  .strict();

const LoopEffectEnvelope = z
  .object({
    allow: z.array(EffectKind).min(1).max(64).optional(),
    deny: z.array(EffectKind).max(64).optional(),
  })
  .strict()
  .superRefine((effects, ctx) => {
    if (effects.allow === undefined && effects.deny === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "loop effect envelope must declare allow or deny",
      });
    }
  });

export const LoopConfig = z
  .object({
    schemaVersion: z.literal(RUN_CONTROL_SCHEMA_VERSION),
    id: RunControlId,
    prompt: z.string().trim().min(1).max(8_192),
    until: LoopUntil,
    bounds: LoopBounds,
    effects: LoopEffectEnvelope.optional(),
    requireProgressEachIteration: z.boolean().default(true),
  })
  .strict();
export type LoopConfigT = z.infer<typeof LoopConfig>;

export interface LoopProfile {
  readonly allowedEffects: readonly EffectKindT[];
}

export type LoopConfigProfileParseResult =
  | { readonly success: true; readonly data: LoopConfigT }
  | { readonly success: false; readonly error: string };

export function parseLoopConfigForProfile(
  value: unknown,
  profile: LoopProfile,
): LoopConfigProfileParseResult {
  const parsed = LoopConfig.safeParse(value);
  if (!parsed.success) {
    return { success: false, error: parsed.error.message };
  }
  const active = new Set(profile.allowedEffects);
  for (const allowed of parsed.data.effects?.allow ?? []) {
    if (!active.has(allowed)) {
      return {
        success: false,
        error: `loop effect envelope cannot widen active profile with ${allowed}`,
      };
    }
  }
  return { success: true, data: parsed.data };
}
