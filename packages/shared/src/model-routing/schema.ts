import { z } from "zod";

export const MODEL_ROUTING_SCHEMA_VERSION = "model-routing.keel.dev/v1" as const;
const schemaVersion = z.literal(MODEL_ROUTING_SCHEMA_VERSION);

export const ModelProviderId = z.enum(["anthropic", "openai", "google", "openai-compatible"]);
export type ModelProviderIdT = z.infer<typeof ModelProviderId>;

export const ModelRouteMode = z.enum(["locked", "auto-cost", "auto-balanced", "auto-quality"]);
export type ModelRouteModeT = z.infer<typeof ModelRouteMode>;

export const ModelRouteSource = z.enum([
  "harness",
  "policy",
  "catalog",
  "operator",
  "provenance",
  "metered",
  "recorded",
]);
export type ModelRouteSourceT = z.infer<typeof ModelRouteSource>;

export const ModelRequestDataClass = z.enum(["public", "workspace", "confidential", "secret"]);
export type ModelRequestDataClassT = z.infer<typeof ModelRequestDataClass>;

export const ModelDataBoundary = z.enum(["local", "vendor_api", "private_cloud", "public_proxy"]);
export type ModelDataBoundaryT = z.infer<typeof ModelDataBoundary>;

export const ModelCapability = z.enum(["text", "tool-calls", "reasoning", "vision", "json"]);
export type ModelCapabilityT = z.infer<typeof ModelCapability>;

export const ModelCredentialState = z.enum(["present", "missing", "not_required"]);
export type ModelCredentialStateT = z.infer<typeof ModelCredentialState>;

export const ModelPricing = z.discriminatedUnion("freshness", [
  z
    .object({
      freshness: z.literal("known"),
      inputUsdPerMillion: z.number().finite().nonnegative(),
      outputUsdPerMillion: z.number().finite().nonnegative(),
    })
    .strict(),
  z.object({ freshness: z.literal("unknown") }).strict(),
]);
export type ModelPricingT = z.infer<typeof ModelPricing>;

export const ModelCatalogEntry = z
  .object({
    ref: z.string().min(1).max(256),
    provider: ModelProviderId,
    model: z.string().min(1).max(160),
    dataBoundary: ModelDataBoundary,
    allowedDataClasses: z.array(ModelRequestDataClass).min(1).max(8),
    capabilities: z.array(ModelCapability).min(1).max(16),
    credential: z.object({ state: ModelCredentialState }).strict(),
    pricing: ModelPricing,
    /** Higher means more capable for static `auto-quality`; local/catalog-derived, not model-supplied. */
    qualityTier: z.number().int().min(0).max(10).optional(),
  })
  .strict();
export type ModelCatalogEntryT = z.infer<typeof ModelCatalogEntry>;

export const ModelCatalog = z
  .object({
    schemaVersion,
    catalogVersion: z.string().min(1).max(128),
    entries: z.array(ModelCatalogEntry).min(1).max(128),
  })
  .strict();
export type ModelCatalogT = z.infer<typeof ModelCatalog>;

export const ModelRouteBudget = z
  .object({
    remainingUsd: z.number().finite().nonnegative().optional(),
    maxInputTokens: z.number().int().nonnegative().optional(),
    maxOutputTokens: z.number().int().nonnegative().optional(),
    maxEffectiveTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ModelRouteBudgetT = z.infer<typeof ModelRouteBudget>;

export const ModelRouteInputSources = z
  .object({
    mode: ModelRouteSource,
    requestDataClass: ModelRouteSource,
    requiredCapabilities: ModelRouteSource,
    estimatedInputTokens: ModelRouteSource,
    candidateModels: ModelRouteSource,
    budget: ModelRouteSource.optional(),
  })
  .strict();
export type ModelRouteInputSourcesT = z.infer<typeof ModelRouteInputSources>;

export const ModelRouteInput = z
  .object({
    schemaVersion,
    requestId: z.string().min(1).max(128),
    createdAt: z.string().datetime(),
    mode: ModelRouteMode,
    requestDataClass: ModelRequestDataClass,
    requiredCapabilities: z.array(ModelCapability).min(1).max(16),
    estimatedInputTokens: z.number().int().nonnegative(),
    budget: ModelRouteBudget.optional(),
    sources: ModelRouteInputSources,
  })
  .strict();
export type ModelRouteInputT = z.infer<typeof ModelRouteInput>;

export const ModelRoutingPolicy = z
  .object({
    schemaVersion,
    policyId: z.string().min(1).max(128),
    mode: ModelRouteMode,
    lockedModelRef: z.string().min(1).max(256).optional(),
    allowedProviders: z.array(ModelProviderId).min(1).max(16),
    allowedModelRefs: z.array(z.string().min(1).max(256)).min(1).max(128),
    allowedDataBoundaries: z.array(ModelDataBoundary).min(1).max(8),
    allowFallback: z.boolean(),
    fallbackModelRefs: z.array(z.string().min(1).max(256)).max(16).optional(),
    budget: ModelRouteBudget.optional(),
  })
  .strict();
export type ModelRoutingPolicyT = z.infer<typeof ModelRoutingPolicy>;

export const ModelRoutingDecisionCandidate = z
  .object({
    ref: z.string().min(1).max(256),
    status: z.enum(["eligible", "filtered"]),
    reasons: z.array(z.string().min(1).max(80)).max(16),
  })
  .strict();
export type ModelRoutingDecisionCandidateT = z.infer<typeof ModelRoutingDecisionCandidate>;

export const ModelRoutingDecision = z
  .object({
    schemaVersion,
    decisionId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128),
    createdAt: z.string().datetime(),
    status: z.enum(["selected", "denied"]),
    mode: ModelRouteMode,
    selected: z
      .object({
        ref: z.string().min(1).max(256),
        provider: ModelProviderId,
        model: z.string().min(1).max(160),
        dataBoundary: ModelDataBoundary,
      })
      .strict()
      .optional(),
    denyCode: z.string().min(1).max(80).optional(),
    reasons: z.array(z.string().min(1).max(80)).max(16),
    candidates: z.array(ModelRoutingDecisionCandidate).max(128),
    metadata: z
      .object({
        catalogVersion: z.string().min(1).max(128),
        requestDataClass: ModelRequestDataClass,
        estimatedInputTokens: z.number().int().nonnegative(),
        fallbackUsed: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ModelRoutingDecisionT = z.infer<typeof ModelRoutingDecision>;

const DATA_CLASS_RANK: Record<ModelRequestDataClassT, number> = {
  public: 0,
  workspace: 1,
  confidential: 2,
  secret: 3,
};

export function compareModelDataClass(
  a: ModelRequestDataClassT,
  b: ModelRequestDataClassT,
): number {
  return DATA_CLASS_RANK[a] - DATA_CLASS_RANK[b];
}

export function allowsModelDataClass(
  allowed: readonly ModelRequestDataClassT[],
  required: ModelRequestDataClassT,
): boolean {
  return allowed.some((candidate) => compareModelDataClass(candidate, required) >= 0);
}

/** Harness boundary fold: unknown, mixed, and untrusted provenance all fail closed to `secret`. */
export function foldModelRequestDataClass(tags: readonly string[]): ModelRequestDataClassT {
  if (tags.length === 0) return "secret";
  let folded: ModelRequestDataClassT = "public";
  for (const tag of tags) {
    const next =
      tag === "user"
        ? "public"
        : tag === "workspace"
          ? "workspace"
          : tag === "mixed" || tag === "untrusted"
            ? "secret"
            : "secret";
    if (compareModelDataClass(next, folded) > 0) folded = next;
  }
  return folded;
}
