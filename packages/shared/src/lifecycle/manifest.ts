import { createHash } from "node:crypto";
import { z } from "zod";
import { JsonObject, type JsonValueT } from "../common/json.js";
import { canonicalize } from "../audit/canonicalize.js";

export const LIFECYCLE_MANIFEST_VERSION = "lifecycle.keel.dev/v1" as const;

const ACTION_IDS = [
  "install",
  "build",
  "lint",
  "typecheck",
  "test.unit",
  "test.integration",
  "test.targeted",
  "dev",
  "healthcheck",
] as const;

export const LifecycleActionId = z.enum(ACTION_IDS);
export type LifecycleActionIdT = z.infer<typeof LifecycleActionId>;

const ACTION_ID_SET = new Set<string>(ACTION_IDS);
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/u;
const NAMESPACE_RE = /^(?=.+[./])[a-z0-9]+(?:[.-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[.-][a-z0-9]+)*)*$/u;
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/u;

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}

function hasTraversal(value: string): boolean {
  return value.split(/[\\/]+/u).some((part) => part === "..");
}

function isSafeRelativePath(value: string): boolean {
  if (value === "") return false;
  if (hasControlCharacter(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\") || WINDOWS_ABSOLUTE_RE.test(value)) {
    return false;
  }
  return !hasTraversal(value);
}

export const NamespacedLifecycleExtensions = JsonObject.superRefine((value, ctx) => {
  for (const key of Object.keys(value)) {
    if (!NAMESPACE_RE.test(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: "extension keys must be namespaced (for example dev.example.feature)",
      });
    }
  }
});

export const LifecyclePackageManager = z.enum([
  "pnpm",
  "npm",
  "yarn",
  "bun",
  "pip",
  "cargo",
  "go",
  "custom",
]);
export type LifecyclePackageManagerT = z.infer<typeof LifecyclePackageManager>;

export const LifecycleEnvVarName = z
  .string()
  .min(1)
  .max(128)
  .regex(ENV_NAME_RE, "env var names must be uppercase shell identifiers");

const LifecycleEnvEntry = z
  .object({
    name: LifecycleEnvVarName,
    secret: z.boolean(),
    requiredFor: z.array(LifecycleActionId).max(32).optional(),
  })
  .strict();
export type LifecycleEnvEntryT = z.infer<typeof LifecycleEnvEntry>;

const LifecycleEnv = z
  .object({
    required: z.array(LifecycleEnvEntry).max(128).optional(),
    optional: z
      .array(LifecycleEnvEntry.omit({ requiredFor: true }))
      .max(128)
      .optional(),
  })
  .strict()
  .superRefine((env, ctx) => {
    const seen = new Set<string>();
    for (const [group, entries] of [
      ["required", env.required ?? []],
      ["optional", env.optional ?? []],
    ] as const) {
      entries.forEach((entry, index) => {
        if (seen.has(entry.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [group, index, "name"],
            message: `duplicate env var declaration: ${entry.name}`,
          });
        }
        seen.add(entry.name);
      });
    }
  });

const LifecycleDiscover = z
  .object({
    kind: z.enum(["node-vitest"]),
    fileGlobs: z.array(z.string().min(1).max(256).refine(isSafeRelativePath)).min(1).max(128),
  })
  .strict();
export type LifecycleDiscoverT = z.infer<typeof LifecycleDiscover>;

export const LifecycleAction = z
  .object({
    argv: z.array(z.string().min(1).max(1024)).min(1).max(64).optional(),
    discover: LifecycleDiscover.optional(),
    timeoutMs: z.number().int().positive().max(1_800_000).optional(),
    longRunning: z.boolean().optional(),
    requiresEnv: z.array(LifecycleEnvVarName).max(128).optional(),
    extensions: NamespacedLifecycleExtensions.optional(),
  })
  .strict()
  .superRefine((action, ctx) => {
    const commandShapes = [action.argv !== undefined, action.discover !== undefined].filter(
      Boolean,
    );
    if (commandShapes.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "lifecycle action must define exactly one of argv or discover",
      });
    }
  });
export type LifecycleActionT = z.infer<typeof LifecycleAction>;

const LifecycleActions = z
  .record(LifecycleActionId, LifecycleAction)
  .superRefine((actions, ctx) => {
    const keys = Object.keys(actions);
    if (keys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one lifecycle action is required",
      });
    }
    if (keys.length > 64) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "too many lifecycle actions" });
    }
  });

const LifecycleValidationTier = z.enum(["minimal", "standard", "strict"]);
export type LifecycleValidationTierT = z.infer<typeof LifecycleValidationTier>;

const LifecycleValidationTierSpec = z
  .object({
    required: z.array(LifecycleActionId).min(1).max(64),
  })
  .strict();

const LifecycleValidationTiers = z
  .record(LifecycleValidationTier, LifecycleValidationTierSpec)
  .superRefine((tiers, ctx) => {
    if (Object.keys(tiers).length > 3) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "too many validation tiers" });
    }
  });

export const LifecycleManifest = z
  .object({
    schemaVersion: z.literal(LIFECYCLE_MANIFEST_VERSION),
    packageManager: LifecyclePackageManager.optional(),
    root: z.string().min(1).max(256).refine(isSafeRelativePath).default("."),
    env: LifecycleEnv.optional(),
    actions: LifecycleActions,
    validationTiers: LifecycleValidationTiers.optional(),
    extensions: NamespacedLifecycleExtensions.optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const actionIds = new Set(Object.keys(manifest.actions));
    const envNames = new Set([
      ...(manifest.env?.required ?? []).map((entry) => entry.name),
      ...(manifest.env?.optional ?? []).map((entry) => entry.name),
    ]);
    for (const [actionId, action] of Object.entries(manifest.actions)) {
      for (const name of action.requiresEnv ?? []) {
        if (!envNames.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["actions", actionId, "requiresEnv"],
            message: `requiresEnv references undeclared env var: ${name}`,
          });
        }
      }
    }
    for (const [tier, spec] of Object.entries(manifest.validationTiers ?? {})) {
      spec.required.forEach((actionId, index) => {
        if (!actionIds.has(actionId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["validationTiers", tier, "required", index],
            message: `validation tier references undefined action: ${actionId}`,
          });
        }
      });
    }
  });
export type LifecycleManifestT = z.infer<typeof LifecycleManifest>;

export const ValidationPostureId = z.enum(["guided", "autopilot-dev", "locked-down"]);
export type ValidationPostureIdT = z.infer<typeof ValidationPostureId>;

export const ValidationPosture = z
  .object({
    id: ValidationPostureId,
    policyProfileRef: z.string().min(1).max(256),
    sandboxProfileRef: z.string().min(1).max(256),
    egressProfileRef: z.string().min(1).max(256),
    validation: z
      .object({
        tier: LifecycleValidationTier,
        requiredLifecycleActions: z.array(LifecycleActionId).max(64),
        requireCleanWorktree: z.boolean().optional(),
        requireTargetedTestsForTouchedFiles: z.boolean().optional(),
      })
      .strict(),
    approvals: z
      .object({
        promptOnReview: z.boolean(),
        allowProjectGrants: z.boolean(),
        batchReviews: z.boolean(),
      })
      .strict(),
    retry: z.object({ readOnlyInfraRetry: z.enum(["off", "bounded"]) }).strict(),
    audit: z
      .object({
        requireHashChain: z.literal(true),
        requireDeniedActionRecords: z.literal(true),
        requireValidationReceipt: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ValidationPostureT = z.infer<typeof ValidationPosture>;

export const BUILTIN_VALIDATION_POSTURES = [
  "guided",
  "autopilot-dev",
  "locked-down",
] as const satisfies readonly ValidationPostureIdT[];

export function lifecycleActionIds(manifest: LifecycleManifestT): LifecycleActionIdT[] {
  return Object.keys(manifest.actions).filter((id): id is LifecycleActionIdT =>
    ACTION_ID_SET.has(id),
  );
}

export function canonicalLifecycleManifestHash(manifest: LifecycleManifestT): string {
  const parsed = LifecycleManifest.parse(manifest);
  const jsonSafe = JSON.parse(JSON.stringify(parsed)) as JsonValueT;
  return `sha256:${createHash("sha256").update(canonicalize(jsonSafe)).digest("hex")}`;
}

export interface LifecycleManifestPublicSummary {
  readonly schemaVersion: typeof LIFECYCLE_MANIFEST_VERSION;
  readonly packageManager?: LifecyclePackageManagerT;
  readonly root: string;
  readonly actions: readonly LifecycleActionIdT[];
  readonly validationTiers: readonly LifecycleValidationTierT[];
  readonly env: {
    readonly required: readonly LifecycleEnvEntryT[];
    readonly optional: readonly Omit<LifecycleEnvEntryT, "requiredFor">[];
  };
}

export function lifecycleManifestPublicSummary(
  manifest: LifecycleManifestT,
): LifecycleManifestPublicSummary {
  const parsed = LifecycleManifest.parse(manifest);
  return {
    schemaVersion: parsed.schemaVersion,
    ...(parsed.packageManager === undefined ? {} : { packageManager: parsed.packageManager }),
    root: parsed.root,
    actions: lifecycleActionIds(parsed),
    validationTiers: Object.keys(parsed.validationTiers ?? {}).filter(
      (tier): tier is LifecycleValidationTierT =>
        tier === "minimal" || tier === "standard" || tier === "strict",
    ),
    env: {
      required: parsed.env?.required ?? [],
      optional: parsed.env?.optional ?? [],
    },
  };
}
