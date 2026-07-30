import {
  MODEL_ROUTING_SCHEMA_VERSION,
  ModelCatalog,
  ModelRoutingPolicy,
  type ModelCatalogT,
  type ModelCredentialStateT,
  type ModelDataBoundaryT,
  type ModelProviderIdT,
  type ModelRoutingPolicyT,
} from "@keel/shared";

export interface SingleModelCatalogOptions {
  readonly provider: ModelProviderIdT;
  readonly model: string;
  readonly catalogVersion?: string;
  readonly dataBoundary?: ModelDataBoundaryT;
  readonly credential?: { readonly state: ModelCredentialStateT };
}

export function modelRef(
  provider: ModelProviderIdT,
  model: string,
  catalogVersion: string,
): string {
  return `${provider}/${model}@${catalogVersion}`;
}

export function createSingleModelCatalog(options: SingleModelCatalogOptions): ModelCatalogT {
  const catalogVersion = options.catalogVersion ?? "local-current";
  return ModelCatalog.parse({
    schemaVersion: MODEL_ROUTING_SCHEMA_VERSION,
    catalogVersion,
    entries: [
      {
        ref: modelRef(options.provider, options.model, catalogVersion),
        provider: options.provider,
        model: options.model,
        dataBoundary: options.dataBoundary ?? "vendor_api",
        allowedDataClasses: ["public", "workspace"],
        capabilities: ["text", "tool-calls"],
        credential: options.credential ?? { state: "present" },
        pricing: { freshness: "unknown" },
        qualityTier: 1,
      },
    ],
  });
}

export function createLockedModelRoutingPolicy(
  lockedModelRef: string,
  opts: {
    readonly policyId?: string;
    readonly allowedDataBoundaries?: readonly ModelDataBoundaryT[];
  } = {},
): ModelRoutingPolicyT {
  const [provider] = lockedModelRef.split("/");
  return ModelRoutingPolicy.parse({
    schemaVersion: MODEL_ROUTING_SCHEMA_VERSION,
    policyId: opts.policyId ?? "locked-current-provider",
    mode: "locked",
    lockedModelRef,
    allowedProviders: [provider],
    allowedModelRefs: [lockedModelRef],
    allowedDataBoundaries: opts.allowedDataBoundaries ?? ["vendor_api"],
    allowFallback: false,
  });
}
