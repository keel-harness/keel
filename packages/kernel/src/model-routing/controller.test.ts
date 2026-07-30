import { describe, expect, it } from "vitest";
import type { ModelRoutingDecisionT } from "@keel/shared";
import { ModelRouteController, modelRouteStatusFromDecision } from "./controller.js";

const decision: ModelRoutingDecisionT = {
  schemaVersion: "model-routing.keel.dev/v1",
  decisionId: "route_dec_controller",
  requestId: "route_req_controller",
  createdAt: "2026-06-27T20:00:00.000Z",
  status: "selected",
  mode: "locked",
  selected: {
    ref: "anthropic/sonnet@test-catalog",
    provider: "anthropic",
    model: "sonnet",
    dataBoundary: "vendor_api",
  },
  reasons: ["locked-current-provider"],
  candidates: [{ ref: "anthropic/sonnet@test-catalog", status: "eligible", reasons: [] }],
  metadata: {
    catalogVersion: "test-catalog",
    requestDataClass: "workspace",
    estimatedInputTokens: 1,
    fallbackUsed: false,
  },
};

describe("ModelRouteController", () => {
  it("reports unknown status before a routing decision exists", () => {
    expect(modelRouteStatusFromDecision(undefined)).toEqual({ mode: "locked", status: "unknown" });
  });

  it("falls back to the last decision for preview and records through an optional sink", () => {
    const recorded: ModelRoutingDecisionT[] = [];
    const controller = new ModelRouteController(undefined, undefined, (d) => recorded.push(d));

    expect(controller.lastDecision()).toBeUndefined();
    expect(controller.preview()).toBeUndefined();
    expect(controller.previewCalls()).toBe(1);

    controller.record(decision);
    expect(controller.lastDecision()).toEqual(decision);
    expect(controller.preview()).toEqual(decision);
    expect(controller.previewCalls()).toBe(2);
    expect(recorded).toEqual([decision]);
    expect(controller.status()).toMatchObject({
      mode: "locked",
      status: "selected",
      selected: "anthropic/sonnet@test-catalog",
      reason: "locked-current-provider",
      lastDecisionId: "route_dec_controller",
    });
  });

  it("does not invent a reason when the recorded decision has no reason or deny code", () => {
    const noReason: ModelRoutingDecisionT = {
      ...decision,
      reasons: [],
      decisionId: "route_dec_no_reason",
    };

    expect(modelRouteStatusFromDecision(noReason)).toEqual({
      mode: "locked",
      status: "selected",
      selected: "anthropic/sonnet@test-catalog",
      lastDecisionId: "route_dec_no_reason",
    });
  });
});
