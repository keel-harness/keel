import {
  MODEL_ROUTING_SCHEMA_VERSION,
  ModelRoutingDecision,
  allowsModelDataClass,
  type ModelCatalogEntryT,
  type ModelCatalogT,
  type ModelRouteInputT,
  type ModelRouteModeT,
  type ModelRoutingDecisionT,
  type ModelRoutingPolicyT,
} from "@keel/shared";

export interface RouteModelArgs {
  readonly input: ModelRouteInputT;
  readonly catalog: ModelCatalogT;
  readonly policy: ModelRoutingPolicyT;
}

interface Candidate {
  readonly entry: ModelCatalogEntryT;
  readonly reasons: string[];
}

function stableDecisionId(
  input: ModelRouteInputT,
  catalog: ModelCatalogT,
  policy: ModelRoutingPolicyT,
): string {
  return `route_dec_${input.requestId}_${catalog.catalogVersion}_${policy.policyId}`
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .slice(0, 128);
}

function estimatedInputUsd(entry: ModelCatalogEntryT, input: ModelRouteInputT): number | undefined {
  if (entry.pricing.freshness === "unknown") return undefined;
  return (input.estimatedInputTokens / 1_000_000) * entry.pricing.inputUsdPerMillion;
}

function eligibilityReasons(
  entry: ModelCatalogEntryT,
  input: ModelRouteInputT,
  policy: ModelRoutingPolicyT,
): string[] {
  const reasons: string[] = [];
  if (!policy.allowedProviders.includes(entry.provider)) reasons.push("provider-denied");
  if (!policy.allowedModelRefs.includes(entry.ref)) reasons.push("model-denied");
  if (!policy.allowedDataBoundaries.includes(entry.dataBoundary))
    reasons.push("data-boundary-denied");
  if (!allowsModelDataClass(entry.allowedDataClasses, input.requestDataClass)) {
    reasons.push("data-class-denied");
  }
  for (const required of input.requiredCapabilities) {
    if (!entry.capabilities.includes(required)) reasons.push(`capability-${required}-missing`);
  }
  if (entry.credential.state === "missing") reasons.push("missing-credential");
  if (
    (input.mode === "auto-cost" || input.budget !== undefined || policy.budget !== undefined) &&
    entry.pricing.freshness === "unknown"
  ) {
    reasons.push("unknown-price");
  }
  const estimated = estimatedInputUsd(entry, input);
  const remaining = input.budget?.remainingUsd ?? policy.budget?.remainingUsd;
  if (estimated !== undefined && remaining !== undefined && estimated > remaining) {
    reasons.push("budget-exceeded");
  }
  return reasons;
}

function filteredCandidates(
  input: ModelRouteInputT,
  catalog: ModelCatalogT,
  policy: ModelRoutingPolicyT,
): readonly Candidate[] {
  return catalog.entries.map((entry) => ({
    entry,
    reasons: eligibilityReasons(entry, input, policy),
  }));
}

function decisionBase(
  input: ModelRouteInputT,
  catalog: ModelCatalogT,
  policy: ModelRoutingPolicyT,
  fallbackUsed: boolean,
): Pick<
  ModelRoutingDecisionT,
  "schemaVersion" | "decisionId" | "requestId" | "createdAt" | "mode" | "metadata" | "candidates"
> {
  return {
    schemaVersion: MODEL_ROUTING_SCHEMA_VERSION,
    decisionId: stableDecisionId(input, catalog, policy),
    requestId: input.requestId,
    createdAt: input.createdAt,
    mode: input.mode,
    candidates: filteredCandidates(input, catalog, policy).map(({ entry, reasons }) => ({
      ref: entry.ref,
      status: reasons.length === 0 ? "eligible" : "filtered",
      reasons,
    })),
    metadata: {
      catalogVersion: catalog.catalogVersion,
      requestDataClass: input.requestDataClass,
      estimatedInputTokens: input.estimatedInputTokens,
      fallbackUsed,
    },
  };
}

function denyCode(candidates: readonly Candidate[], preferred = "no-eligible-model"): string {
  const reasons = candidates.flatMap((candidate) => candidate.reasons);
  for (const code of [
    "missing-credential",
    "unknown-price",
    "budget-exceeded",
    "data-boundary-denied",
    "data-class-denied",
    "provider-denied",
    "model-denied",
  ]) {
    if (reasons.includes(code)) return code;
  }
  return preferred;
}

function selectedDecision(
  input: ModelRouteInputT,
  catalog: ModelCatalogT,
  policy: ModelRoutingPolicyT,
  selected: ModelCatalogEntryT,
  reasons: readonly string[],
  fallbackUsed = false,
): ModelRoutingDecisionT {
  return ModelRoutingDecision.parse({
    ...decisionBase(input, catalog, policy, fallbackUsed),
    status: "selected",
    selected: {
      ref: selected.ref,
      provider: selected.provider,
      model: selected.model,
      dataBoundary: selected.dataBoundary,
    },
    reasons,
  });
}

function deniedDecision(
  input: ModelRouteInputT,
  catalog: ModelCatalogT,
  policy: ModelRoutingPolicyT,
  code: string,
  reasons: readonly string[] = [code],
  fallbackUsed = false,
): ModelRoutingDecisionT {
  return ModelRoutingDecision.parse({
    ...decisionBase(input, catalog, policy, fallbackUsed),
    status: "denied",
    denyCode: code,
    reasons,
  });
}

function byStableRef(a: ModelCatalogEntryT, b: ModelCatalogEntryT): number {
  return a.ref.localeCompare(b.ref);
}

function pickByMode(
  mode: ModelRouteModeT,
  eligible: readonly ModelCatalogEntryT[],
  input: ModelRouteInputT,
): ModelCatalogEntryT | undefined {
  const sorted = [...eligible].sort(byStableRef);
  if (mode === "auto-quality") {
    return sorted.sort(
      (a, b) => (b.qualityTier ?? 0) - (a.qualityTier ?? 0) || byStableRef(a, b),
    )[0];
  }
  if (mode === "auto-balanced") {
    return sorted.sort((a, b) => {
      const ac = estimatedInputUsd(a, input) ?? Number.POSITIVE_INFINITY;
      const bc = estimatedInputUsd(b, input) ?? Number.POSITIVE_INFINITY;
      const av = (a.qualityTier ?? 1) / Math.max(ac, 0.000001);
      const bv = (b.qualityTier ?? 1) / Math.max(bc, 0.000001);
      return bv - av || ac - bc || byStableRef(a, b);
    })[0];
  }
  return sorted.sort((a, b) => {
    const ac = estimatedInputUsd(a, input) ?? Number.POSITIVE_INFINITY;
    const bc = estimatedInputUsd(b, input) ?? Number.POSITIVE_INFINITY;
    return ac - bc || byStableRef(a, b);
  })[0];
}

export function routeModel(args: RouteModelArgs): ModelRoutingDecisionT {
  const input = args.input;
  const policy = args.policy;
  const catalog = args.catalog;
  const candidates = filteredCandidates(input, catalog, policy);
  const eligible = candidates
    .filter((candidate) => candidate.reasons.length === 0)
    .map((candidate) => candidate.entry);

  if (input.mode === "locked") {
    const locked =
      policy.lockedModelRef !== undefined
        ? eligible.find((entry) => entry.ref === policy.lockedModelRef)
        : undefined;
    if (locked !== undefined) {
      return selectedDecision(input, catalog, policy, locked, ["locked-current-provider"]);
    }

    if (policy.allowFallback && (policy.fallbackModelRefs?.length ?? 0) > 0) {
      const fallback = policy.fallbackModelRefs
        ?.map((ref) => eligible.find((entry) => entry.ref === ref))
        .find((entry): entry is ModelCatalogEntryT => entry !== undefined);
      if (fallback !== undefined) {
        return selectedDecision(input, catalog, policy, fallback, ["fallback-selected"], true);
      }
      return deniedDecision(input, catalog, policy, "fallback-denied", ["fallback-denied"], true);
    }

    if (policy.lockedModelRef === undefined) {
      return deniedDecision(input, catalog, policy, "locked-model-unavailable");
    }

    return deniedDecision(input, catalog, policy, denyCode(candidates, "locked-model-unavailable"));
  }

  if (eligible.length === 0) {
    return deniedDecision(input, catalog, policy, denyCode(candidates));
  }

  const selected = pickByMode(input.mode, eligible, input);
  if (selected === undefined) return deniedDecision(input, catalog, policy, "no-eligible-model");
  return selectedDecision(input, catalog, policy, selected, [`${input.mode}-selected`]);
}
