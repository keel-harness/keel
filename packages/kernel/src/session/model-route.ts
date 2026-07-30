import type { ModelRoutingDecisionT, SessionEventT } from "@keel/shared";
import type { SessionStore } from "./store.js";

const now = (): string => new Date().toISOString();

export function appendModelRouteDecision(
  store: SessionStore,
  decision: ModelRoutingDecisionT,
): void {
  store.append({
    type: "model_route",
    v: 1,
    ts: now(),
    decision,
  });
}

export function recordedModelRouteDecisions(
  events: readonly SessionEventT[],
): readonly ModelRoutingDecisionT[] {
  return events.flatMap((event) => (event.type === "model_route" ? [event.decision] : []));
}
