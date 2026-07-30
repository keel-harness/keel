import { describe, expect, it } from "vitest";
import type { ModelCatalogT, ModelRouteInputT, ModelRoutingPolicyT } from "@keel/shared";
import { routeModel } from "./router.js";

const ts = "2026-06-27T20:00:00.000Z";
const baseInput: ModelRouteInputT = {
  schemaVersion: "model-routing.keel.dev/v1",
  requestId: "route_req_1",
  createdAt: ts,
  mode: "locked",
  requestDataClass: "workspace",
  requiredCapabilities: ["text"],
  estimatedInputTokens: 1_000,
  sources: {
    mode: "policy",
    requestDataClass: "provenance",
    requiredCapabilities: "harness",
    estimatedInputTokens: "metered",
    candidateModels: "catalog",
  },
};

const catalog: ModelCatalogT = {
  schemaVersion: "model-routing.keel.dev/v1",
  catalogVersion: "test-catalog",
  entries: [
    {
      ref: "anthropic/sonnet@test-catalog",
      provider: "anthropic",
      model: "sonnet",
      dataBoundary: "vendor_api",
      allowedDataClasses: ["public", "workspace"],
      capabilities: ["text", "tool-calls"],
      credential: { state: "present" },
      pricing: { freshness: "known", inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
      qualityTier: 3,
    },
    {
      ref: "openai/gpt-cheap@test-catalog",
      provider: "openai",
      model: "gpt-cheap",
      dataBoundary: "vendor_api",
      allowedDataClasses: ["public", "workspace"],
      capabilities: ["text"],
      credential: { state: "present" },
      pricing: { freshness: "known", inputUsdPerMillion: 1, outputUsdPerMillion: 4 },
      qualityTier: 1,
    },
    {
      ref: "google/gemini@test-catalog",
      provider: "google",
      model: "gemini",
      dataBoundary: "public_proxy",
      allowedDataClasses: ["public", "workspace"],
      capabilities: ["text"],
      credential: { state: "present" },
      pricing: { freshness: "known", inputUsdPerMillion: 0.5, outputUsdPerMillion: 2 },
      qualityTier: 2,
    },
  ],
};

const policy: ModelRoutingPolicyT = {
  schemaVersion: "model-routing.keel.dev/v1",
  policyId: "policy_test",
  mode: "locked",
  lockedModelRef: "anthropic/sonnet@test-catalog",
  allowedProviders: ["anthropic", "openai", "google"],
  allowedModelRefs: [
    "anthropic/sonnet@test-catalog",
    "openai/gpt-cheap@test-catalog",
    "google/gemini@test-catalog",
  ],
  allowedDataBoundaries: ["vendor_api"],
  allowFallback: false,
};

describe("model router (Epic 2.13 deterministic policy filter)", () => {
  it("defaults to locked/current-provider and is deterministic", () => {
    const a = routeModel({ input: baseInput, catalog, policy });
    const b = routeModel({ input: baseInput, catalog, policy });
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      status: "selected",
      mode: "locked",
      selected: { ref: "anthropic/sonnet@test-catalog", provider: "anthropic" },
      reasons: ["locked-current-provider"],
    });
  });

  it("filters broader data-boundary classes unless explicitly opted in", () => {
    const decision = routeModel({
      input: { ...baseInput, mode: "auto-cost" },
      catalog,
      policy: { ...policy, mode: "auto-cost", lockedModelRef: undefined },
    });
    expect(decision.status).toBe("selected");
    expect(decision.selected?.ref).toBe("openai/gpt-cheap@test-catalog");
    expect(decision.candidates.find((c) => c.ref === "google/gemini@test-catalog")).toMatchObject({
      status: "filtered",
      reasons: ["data-boundary-denied"],
    });
  });

  it("fails closed for missing credentials without serializing key names or values", () => {
    const decision = routeModel({
      input: baseInput,
      catalog: {
        ...catalog,
        entries: [
          {
            ...catalog.entries[0]!,
            credential: { state: "missing" },
          },
        ],
      },
      policy,
    });
    expect(decision).toMatchObject({
      status: "denied",
      denyCode: "missing-credential",
    });
    const wire = JSON.stringify(decision);
    expect(wire).not.toMatch(
      /ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|sk-|secret/i,
    );
  });

  it("treats unknown pricing as unsafe for budgeted and auto-cost routing", () => {
    const decision = routeModel({
      input: { ...baseInput, mode: "auto-cost", budget: { remainingUsd: 1 } },
      catalog: {
        ...catalog,
        entries: [
          {
            ...catalog.entries[1]!,
            pricing: { freshness: "unknown" },
          },
        ],
      },
      policy: {
        ...policy,
        mode: "auto-cost",
        lockedModelRef: undefined,
        allowedModelRefs: ["openai/gpt-cheap@test-catalog"],
      },
    });
    expect(decision).toMatchObject({
      status: "denied",
      denyCode: "unknown-price",
    });
  });

  it("supports deterministic static cost, balanced, and quality modes", () => {
    expect(
      routeModel({
        input: { ...baseInput, mode: "auto-cost" },
        catalog,
        policy: { ...policy, mode: "auto-cost", lockedModelRef: undefined },
      }).selected?.ref,
    ).toBe("openai/gpt-cheap@test-catalog");
    expect(
      routeModel({
        input: { ...baseInput, mode: "auto-quality" },
        catalog,
        policy: { ...policy, mode: "auto-quality", lockedModelRef: undefined },
      }).selected?.ref,
    ).toBe("anthropic/sonnet@test-catalog");
    expect(
      routeModel({
        input: { ...baseInput, mode: "auto-balanced" },
        catalog,
        policy: { ...policy, mode: "auto-balanced", lockedModelRef: undefined },
      }).selected?.ref,
    ).toBe("openai/gpt-cheap@test-catalog");
  });

  it("denies fallback when the fallback target crosses policy or data boundaries", () => {
    const decision = routeModel({
      input: baseInput,
      catalog,
      policy: {
        ...policy,
        lockedModelRef: "missing/model@test-catalog",
        allowFallback: true,
        fallbackModelRefs: ["google/gemini@test-catalog"],
      },
    });
    expect(decision).toMatchObject({
      status: "denied",
      denyCode: "fallback-denied",
    });
  });

  it("selects an explicitly allowed fallback without crossing policy filters", () => {
    const decision = routeModel({
      input: baseInput,
      catalog,
      policy: {
        ...policy,
        lockedModelRef: "missing/model@test-catalog",
        allowFallback: true,
        fallbackModelRefs: ["openai/gpt-cheap@test-catalog"],
      },
    });

    expect(decision).toMatchObject({
      status: "selected",
      selected: { ref: "openai/gpt-cheap@test-catalog" },
      reasons: ["fallback-selected"],
      metadata: { fallbackUsed: true },
    });
  });

  it("denies locked routing without a configured locked model", () => {
    const decision = routeModel({
      input: baseInput,
      catalog,
      policy: { ...policy, lockedModelRef: undefined },
    });

    expect(decision).toMatchObject({
      status: "denied",
      denyCode: "locked-model-unavailable",
    });
  });

  it("reports locked-model-unavailable when the locked ref is absent from otherwise eligible models", () => {
    const decision = routeModel({
      input: baseInput,
      catalog,
      policy: {
        ...policy,
        lockedModelRef: "missing/model@test-catalog",
        allowedDataBoundaries: ["vendor_api", "public_proxy"],
      },
    });

    expect(decision).toMatchObject({
      status: "denied",
      denyCode: "locked-model-unavailable",
    });
  });

  it("does not fallback when fallback is enabled without configured fallback targets", () => {
    const decision = routeModel({
      input: baseInput,
      catalog,
      policy: {
        ...policy,
        lockedModelRef: "missing/model@test-catalog",
        allowFallback: true,
      },
    });

    expect(decision).toMatchObject({
      status: "denied",
      denyCode: "data-boundary-denied",
      metadata: { fallbackUsed: false },
    });
  });

  it("records every policy filter reason and chooses the safest deny code", () => {
    const decision = routeModel({
      input: {
        ...baseInput,
        mode: "auto-quality",
        requestDataClass: "secret",
        requiredCapabilities: ["text", "vision"],
      },
      catalog: {
        ...catalog,
        entries: [
          {
            ...catalog.entries[0]!,
            credential: { state: "missing" },
            pricing: { freshness: "unknown" },
          },
        ],
      },
      policy: {
        ...policy,
        mode: "auto-quality",
        lockedModelRef: undefined,
        allowedProviders: ["openai"],
        allowedModelRefs: ["openai/not-the-catalog@test-catalog"],
        budget: { remainingUsd: 1 },
      },
    });

    expect(decision).toMatchObject({
      status: "denied",
      denyCode: "missing-credential",
      candidates: [
        {
          ref: "anthropic/sonnet@test-catalog",
          status: "filtered",
          reasons: [
            "provider-denied",
            "model-denied",
            "data-class-denied",
            "capability-vision-missing",
            "missing-credential",
            "unknown-price",
          ],
        },
      ],
    });
  });

  it("denies when known pricing exceeds the remaining budget", () => {
    const decision = routeModel({
      input: { ...baseInput, mode: "auto-cost", budget: { remainingUsd: 0.00001 } },
      catalog,
      policy: { ...policy, mode: "auto-cost", lockedModelRef: undefined },
    });

    expect(decision).toMatchObject({
      status: "denied",
      denyCode: "budget-exceeded",
    });
  });

  it("uses stable tie-breaks for quality and cost when catalog metadata ties", () => {
    const tiedCatalog: ModelCatalogT = {
      schemaVersion: "model-routing.keel.dev/v1",
      catalogVersion: "tied-catalog",
      entries: [
        {
          ...catalog.entries[1]!,
          ref: "openai/z-model@tied-catalog",
          model: "z-model",
          pricing: { freshness: "known", inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
          qualityTier: undefined,
        },
        {
          ...catalog.entries[0]!,
          ref: "anthropic/a-model@tied-catalog",
          model: "a-model",
          pricing: { freshness: "known", inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
          qualityTier: undefined,
        },
      ],
    };
    const tiedPolicy: ModelRoutingPolicyT = {
      ...policy,
      mode: "auto-quality",
      lockedModelRef: undefined,
      allowedModelRefs: tiedCatalog.entries.map((entry) => entry.ref),
    };

    expect(
      routeModel({
        input: { ...baseInput, mode: "auto-quality" },
        catalog: tiedCatalog,
        policy: tiedPolicy,
      }).selected?.ref,
    ).toBe("anthropic/a-model@tied-catalog");
    expect(
      routeModel({
        input: { ...baseInput, mode: "auto-cost" },
        catalog: tiedCatalog,
        policy: { ...tiedPolicy, mode: "auto-cost" },
      }).selected?.ref,
    ).toBe("anthropic/a-model@tied-catalog");
  });

  it("keeps auto-balanced deterministic when price and quality metadata are unknown", () => {
    const unknownCatalog: ModelCatalogT = {
      schemaVersion: "model-routing.keel.dev/v1",
      catalogVersion: "unknown-catalog",
      entries: [
        {
          ...catalog.entries[1]!,
          ref: "openai/z-model@unknown-catalog",
          model: "z-model",
          pricing: { freshness: "unknown" },
          qualityTier: undefined,
        },
        {
          ...catalog.entries[0]!,
          ref: "anthropic/a-model@unknown-catalog",
          model: "a-model",
          pricing: { freshness: "unknown" },
          qualityTier: undefined,
        },
      ],
    };
    const unknownPolicy: ModelRoutingPolicyT = {
      ...policy,
      mode: "auto-balanced",
      lockedModelRef: undefined,
      allowedModelRefs: unknownCatalog.entries.map((entry) => entry.ref),
    };

    expect(
      routeModel({
        input: { ...baseInput, mode: "auto-balanced" },
        catalog: unknownCatalog,
        policy: unknownPolicy,
      }).selected?.ref,
    ).toBe("anthropic/a-model@unknown-catalog");
  });
});
