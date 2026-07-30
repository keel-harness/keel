import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRoutingDecisionT } from "@keel/shared";
import { SessionStore, readSession } from "./store.js";
import { rebuild } from "./resume.js";
import { appendModelRouteDecision, recordedModelRouteDecisions } from "./model-route.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });

const decision: ModelRoutingDecisionT = {
  schemaVersion: "model-routing.keel.dev/v1",
  decisionId: "route_dec_1",
  requestId: "route_req_1",
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
    estimatedInputTokens: 12,
    fallbackUsed: false,
  },
};

describe("model routing session metadata", () => {
  it("records route decisions as metadata and keeps them out of resumed model context", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts: decision.createdAt, content: "go" });
    appendModelRouteDecision(store, decision);
    store.append({ type: "assistant", v: 1, ts: decision.createdAt, content: "done" });
    store.close();

    const file = readSession(store.id, e);
    expect(file.events.map((ev) => ev.type)).toEqual(["user", "model_route", "assistant"]);
    expect(recordedModelRouteDecisions(file.events)).toEqual([decision]);
    expect(rebuild(file).messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("does not serialize prompts or provider credentials in route metadata", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    appendModelRouteDecision(store, decision);
    store.close();

    const wire = JSON.stringify(readSession(store.id, e).events);
    expect(wire).not.toMatch(/raw prompt|ANTHROPIC_API_KEY|sk-|secret/i);
  });
});
