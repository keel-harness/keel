import type { ModelRoutingDecisionT, UiModelRouteStatus } from "@keel/shared";

export interface ModelRouteRuntime {
  status(): UiModelRouteStatus;
  lastDecision(): ModelRoutingDecisionT | undefined;
  preview(): ModelRoutingDecisionT | undefined;
  previewCalls(): number;
  record(decision: ModelRoutingDecisionT): void;
}

export function modelRouteStatusFromDecision(
  decision: ModelRoutingDecisionT | undefined,
): UiModelRouteStatus {
  if (decision === undefined) return { mode: "locked", status: "unknown" };
  const reason = decision.reasons[0] ?? decision.denyCode;
  return {
    mode: decision.mode,
    status: decision.status,
    ...(decision.selected !== undefined ? { selected: decision.selected.ref } : {}),
    ...(reason !== undefined ? { reason } : {}),
    lastDecisionId: decision.decisionId,
  };
}

export class ModelRouteController implements ModelRouteRuntime {
  #last: ModelRoutingDecisionT | undefined;
  #previewCalls = 0;

  constructor(
    initial: ModelRoutingDecisionT | undefined,
    private readonly previewDecision?: () => ModelRoutingDecisionT | undefined,
    private readonly sink?: (decision: ModelRoutingDecisionT) => void,
  ) {
    this.#last = initial;
  }

  status(): UiModelRouteStatus {
    return modelRouteStatusFromDecision(this.#last);
  }

  lastDecision(): ModelRoutingDecisionT | undefined {
    return this.#last;
  }

  preview(): ModelRoutingDecisionT | undefined {
    this.#previewCalls += 1;
    return this.previewDecision?.() ?? this.#last;
  }

  previewCalls(): number {
    return this.#previewCalls;
  }

  record(decision: ModelRoutingDecisionT): void {
    this.#last = decision;
    this.sink?.(decision);
  }
}

export function staticModelRouteRuntime(decision: ModelRoutingDecisionT): ModelRouteRuntime {
  return new ModelRouteController(decision, () => decision);
}
