import { describe, expect, it } from "vitest";
import type {
  ModelPort,
  ModelStreamChunkT,
  ModelTurnInput,
  ModelRoutingDecisionT,
} from "@keel/shared";
import { createLockedModelRoutingPolicy, createSingleModelCatalog } from "./registry.js";
import { ModelGateway } from "./gateway.js";
import { routeModel } from "./router.js";

class CountingModel implements ModelPort {
  calls = 0;
  constructor(private readonly chunks: readonly ModelStreamChunkT[]) {}
  async *stream(_input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
    this.calls += 1;
    for (const chunk of this.chunks) yield chunk;
  }
}

const chunks: readonly ModelStreamChunkT[] = [
  { type: "text-delta", text: "hello" },
  { type: "finish", reason: "stop", usage: { inputTokens: 2, outputTokens: 1 } },
];

describe("ModelGateway (Epic 2.13 local wrapper above ModelPort)", () => {
  it("builds route input from harness metadata without raw prompt text", () => {
    const catalog = createSingleModelCatalog({ provider: "anthropic", model: "sonnet" });
    const policy = createLockedModelRoutingPolicy(catalog.entries[0]!.ref);
    const input = ModelGateway.routeInputForTurn({
      turn: {
        messages: [{ role: "user", content: "raw prompt must stay below the gateway" }],
        tools: [{ name: "bash", description: "run a shell command" }],
      },
      catalog,
      policy,
      requestDataClass: "secret",
      createdAt: "2026-06-27T20:00:00.000Z",
    });

    expect(input).toMatchObject({
      mode: "locked",
      requestDataClass: "secret",
      requiredCapabilities: ["text", "tool-calls"],
      sources: {
        mode: "policy",
        requestDataClass: "provenance",
        requiredCapabilities: "harness",
        estimatedInputTokens: "metered",
        candidateModels: "catalog",
      },
    });
    expect(JSON.stringify(input)).not.toContain("raw prompt must stay below the gateway");
  });

  it("labels the request-data-class source as harness (not provenance) when no real class is supplied", () => {
    const catalog = createSingleModelCatalog({ provider: "anthropic", model: "sonnet" });
    const policy = createLockedModelRoutingPolicy(catalog.entries[0]!.ref);
    const input = ModelGateway.routeInputForTurn({
      turn: { messages: [{ role: "user", content: "no explicit data class" }] },
      catalog,
      policy,
      createdAt: "2026-06-28T00:00:00.000Z",
    });

    // The value is a static harness fold of ["user","workspace"], NOT derived from real turn
    // provenance — so the source label must say so honestly rather than claiming "provenance".
    expect(input.requestDataClass).toBe("workspace");
    expect(input.sources.requestDataClass).toBe("harness");
  });

  it("keeps locked-mode streaming byte-equivalent and records the same decision as preview", async () => {
    const delegate = new CountingModel(chunks);
    const catalog = createSingleModelCatalog({ provider: "anthropic", model: "sonnet" });
    const policy = createLockedModelRoutingPolicy(catalog.entries[0]!.ref);
    const decisions: ModelRoutingDecisionT[] = [];
    const gateway = new ModelGateway({
      delegate,
      catalog,
      policy,
      decide: routeModel,
      onDecision: (d) => decisions.push(d),
    });

    const input: ModelTurnInput = {
      messages: [{ role: "user", content: "raw prompt stays below" }],
    };
    const preview = gateway.preview(input);
    expect(delegate.calls).toBe(0);
    const live = [];
    for await (const chunk of gateway.stream(input)) live.push(chunk);

    expect(live).toEqual(chunks);
    expect(delegate.calls).toBe(1);
    expect(decisions).toEqual([preview]);
    expect(JSON.stringify(preview)).not.toContain("raw prompt stays below");
  });

  it("denies before upstream call when policy filtering leaves no eligible model", async () => {
    const delegate = new CountingModel(chunks);
    const catalog = createSingleModelCatalog({
      provider: "anthropic",
      model: "sonnet",
      credential: { state: "missing" },
    });
    const gateway = new ModelGateway({
      delegate,
      catalog,
      policy: createLockedModelRoutingPolicy(catalog.entries[0]!.ref),
      decide: routeModel,
    });

    const emitted = [];
    for await (const chunk of gateway.stream({ messages: [{ role: "user", content: "go" }] })) {
      emitted.push(chunk);
    }
    expect(delegate.calls).toBe(0);
    expect(emitted).toEqual([
      {
        type: "error",
        code: "model-route-denied",
        message: "model route denied: missing-credential",
      },
    ]);
  });

  it("uses conservative default routing and denied messages when optional hooks are absent", async () => {
    const delegate = new CountingModel(chunks);
    const catalog = createSingleModelCatalog({ provider: "anthropic", model: "sonnet" });
    const gateway = new ModelGateway({
      delegate,
      catalog,
      policy: createLockedModelRoutingPolicy(catalog.entries[0]!.ref),
      createdAt: "2026-06-27T20:00:00.000Z",
    });

    const out = [];
    for await (const chunk of gateway.stream({ messages: [{ role: "user", content: "go" }] })) {
      out.push(chunk);
    }
    expect(out).toEqual(chunks);
    expect(delegate.calls).toBe(1);

    const denied = new ModelGateway({
      delegate,
      catalog,
      policy: createLockedModelRoutingPolicy(catalog.entries[0]!.ref),
      decide: () => ({
        schemaVersion: "model-routing.keel.dev/v1",
        decisionId: "route_dec_denied",
        requestId: "route_req_denied",
        createdAt: "2026-06-27T20:00:00.000Z",
        status: "denied",
        mode: "locked",
        reasons: [],
        candidates: [],
        metadata: {
          catalogVersion: "test-catalog",
          requestDataClass: "workspace",
          estimatedInputTokens: 1,
          fallbackUsed: false,
        },
      }),
    });

    const deniedOut = [];
    for await (const chunk of denied.stream({ messages: [{ role: "user", content: "go" }] })) {
      deniedOut.push(chunk);
    }
    expect(deniedOut).toEqual([
      {
        type: "error",
        code: "model-route-denied",
        message: "model route denied: no-eligible-model",
      },
    ]);
    expect(delegate.calls).toBe(1);
  });

  it("previews recorded decisions and explicit request data class without upstream calls", () => {
    const delegate = new CountingModel(chunks);
    const catalog = createSingleModelCatalog({ provider: "anthropic", model: "sonnet" });
    const policy = createLockedModelRoutingPolicy(catalog.entries[0]!.ref);
    const recorded = routeModel({
      input: ModelGateway.routeInputForTurn({
        turn: { messages: [{ role: "user", content: "go" }] },
        catalog,
        policy,
        createdAt: "2026-06-27T20:00:00.000Z",
      }),
      catalog,
      policy,
    });
    let recomputed = 0;
    const replayGateway = new ModelGateway({
      delegate,
      catalog,
      policy,
      replayDecisions: [recorded],
      decide: (args) => {
        recomputed += 1;
        return routeModel(args);
      },
    });
    expect(replayGateway.preview({ messages: [{ role: "user", content: "go" }] })).toEqual(
      recorded,
    );
    expect(recomputed).toBe(0);
    expect(delegate.calls).toBe(0);

    const explicitGateway = new ModelGateway({
      delegate,
      catalog,
      policy,
      requestDataClass: "secret",
      decide: (args) => routeModel(args),
      createdAt: "2026-06-27T20:00:00.000Z",
    });
    const explicit = explicitGateway.preview({ messages: [{ role: "user", content: "go" }] });
    expect(explicit.metadata.requestDataClass).toBe("secret");
  });

  it("replays recorded routing decisions instead of recomputing against changed catalog state", async () => {
    const delegate = new CountingModel(chunks);
    const liveCatalog = createSingleModelCatalog({ provider: "anthropic", model: "sonnet" });
    const recorded = routeModel({
      input: ModelGateway.routeInputForTurn({
        turn: { messages: [{ role: "user", content: "go" }] },
        policy: createLockedModelRoutingPolicy(liveCatalog.entries[0]!.ref),
        catalog: liveCatalog,
      }),
      catalog: liveCatalog,
      policy: createLockedModelRoutingPolicy(liveCatalog.entries[0]!.ref),
    });
    const changedCatalog = createSingleModelCatalog({
      provider: "anthropic",
      model: "sonnet",
      credential: { state: "missing" },
    });
    let recomputed = 0;
    const gateway = new ModelGateway({
      delegate,
      catalog: changedCatalog,
      policy: createLockedModelRoutingPolicy(changedCatalog.entries[0]!.ref),
      replayDecisions: [recorded],
      decide: (args) => {
        recomputed += 1;
        return routeModel(args);
      },
    });

    const out = [];
    for await (const chunk of gateway.stream({ messages: [{ role: "user", content: "go" }] })) {
      out.push(chunk);
    }

    expect(recomputed).toBe(0);
    expect(delegate.calls).toBe(1);
    expect(out).toEqual(chunks);
  });
});
