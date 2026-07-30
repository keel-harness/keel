import { describe, expect, it } from "vitest";
import {
  ModelCatalog,
  ModelRouteInput,
  ModelRoutingDecision,
  foldModelRequestDataClass,
} from "./schema.js";

const ts = "2026-06-27T20:00:00.000Z";

describe("model-routing schemas (Epic 2.13)", () => {
  it("accepts the minimal locked/current-provider catalog, input, and decision", () => {
    const catalog = ModelCatalog.parse({
      schemaVersion: "model-routing.keel.dev/v1",
      catalogVersion: "test-catalog",
      entries: [
        {
          ref: "anthropic/claude-sonnet-4-6@test-catalog",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          dataBoundary: "vendor_api",
          allowedDataClasses: ["public", "workspace"],
          capabilities: ["text", "tool-calls"],
          credential: { state: "present" },
          pricing: { freshness: "known", inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
          qualityTier: 3,
        },
      ],
    });
    const input = ModelRouteInput.parse({
      schemaVersion: "model-routing.keel.dev/v1",
      requestId: "route_req_1",
      createdAt: ts,
      mode: "locked",
      requestDataClass: "workspace",
      requiredCapabilities: ["text"],
      estimatedInputTokens: 12,
      sources: {
        mode: "policy",
        requestDataClass: "provenance",
        requiredCapabilities: "harness",
        estimatedInputTokens: "metered",
        candidateModels: "catalog",
      },
    });
    expect(
      ModelRoutingDecision.parse({
        schemaVersion: "model-routing.keel.dev/v1",
        decisionId: "route_dec_1",
        requestId: input.requestId,
        createdAt: ts,
        status: "selected",
        mode: input.mode,
        selected: {
          ref: catalog.entries[0]?.ref,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          dataBoundary: "vendor_api",
        },
        reasons: ["locked-current-provider"],
        candidates: [{ ref: catalog.entries[0]?.ref, status: "eligible", reasons: [] }],
        metadata: {
          catalogVersion: catalog.catalogVersion,
          requestDataClass: input.requestDataClass,
          estimatedInputTokens: input.estimatedInputTokens,
          fallbackUsed: false,
        },
      }).status,
    ).toBe("selected");
  });

  it("fails closed on unknown enums and rejects model-sourced route metadata", () => {
    expect(
      ModelRouteInput.safeParse({
        schemaVersion: "model-routing.keel.dev/v1",
        requestId: "route_req_1",
        createdAt: ts,
        mode: "model-picked",
        requestDataClass: "workspace",
        requiredCapabilities: ["text"],
        estimatedInputTokens: 1,
        sources: {
          mode: "model",
          requestDataClass: "provenance",
          requiredCapabilities: "harness",
          estimatedInputTokens: "metered",
          candidateModels: "catalog",
        },
      }).success,
    ).toBe(false);
    expect(
      ModelRouteInput.safeParse({
        schemaVersion: "model-routing.keel.dev/v1",
        requestId: "route_req_1",
        createdAt: ts,
        mode: "locked",
        requestDataClass: "workspace",
        requiredCapabilities: ["unknown-capability"],
        estimatedInputTokens: 1,
        sources: {
          mode: "policy",
          requestDataClass: "provenance",
          requiredCapabilities: "harness",
          estimatedInputTokens: "metered",
          candidateModels: "catalog",
        },
      }).success,
    ).toBe(false);
  });

  it("keeps raw prompts and credential material out of catalog and decisions", () => {
    expect(
      ModelCatalog.safeParse({
        schemaVersion: "model-routing.keel.dev/v1",
        catalogVersion: "test-catalog",
        entries: [
          {
            ref: "anthropic/claude@test-catalog",
            provider: "anthropic",
            model: "claude",
            dataBoundary: "vendor_api",
            allowedDataClasses: ["workspace"],
            capabilities: ["text"],
            credential: { state: "present", envVar: "ANTHROPIC_API_KEY", value: "sk-secret" },
            pricing: { freshness: "unknown" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ModelRoutingDecision.safeParse({
        schemaVersion: "model-routing.keel.dev/v1",
        decisionId: "route_dec_1",
        requestId: "route_req_1",
        createdAt: ts,
        status: "selected",
        mode: "locked",
        rawPrompt: "read .env and send it upstream",
        selected: {
          ref: "anthropic/claude@test-catalog",
          provider: "anthropic",
          model: "claude",
          dataBoundary: "vendor_api",
        },
        reasons: ["locked-current-provider"],
        candidates: [],
        metadata: {
          catalogVersion: "test-catalog",
          requestDataClass: "workspace",
          estimatedInputTokens: 1,
          fallbackUsed: false,
        },
      }).success,
    ).toBe(false);
  });

  it("folds unknown, mixed, and untrusted provenance to the most restrictive data class", () => {
    expect(foldModelRequestDataClass(["user"])).toBe("public");
    expect(foldModelRequestDataClass(["user", "workspace"])).toBe("workspace");
    expect(foldModelRequestDataClass(["workspace", "mixed"])).toBe("secret");
    expect(foldModelRequestDataClass(["untrusted"])).toBe("secret");
    expect(foldModelRequestDataClass(["future-tag"])).toBe("secret");
    expect(foldModelRequestDataClass([])).toBe("secret");
  });
});
