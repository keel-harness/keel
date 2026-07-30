import {
  MODEL_ROUTING_SCHEMA_VERSION,
  foldModelRequestDataClass,
  type ModelCatalogT,
  type ModelPort,
  type ModelRouteInputT,
  type ModelRoutingDecisionT,
  type ModelRoutingPolicyT,
  type ModelStreamChunkT,
  type ModelTurnInput,
} from "@keel/shared";
import { routeModel, type RouteModelArgs } from "./router.js";

export type ModelDecisionFn = (args: RouteModelArgs) => ModelRoutingDecisionT;

export interface ModelGatewayOptions {
  readonly delegate: ModelPort;
  readonly catalog: ModelCatalogT;
  readonly policy: ModelRoutingPolicyT;
  readonly decide?: ModelDecisionFn;
  readonly onDecision?: (decision: ModelRoutingDecisionT) => void;
  readonly replayDecisions?: readonly ModelRoutingDecisionT[];
  readonly createdAt?: string;
  readonly requestDataClass?: ModelRouteInputT["requestDataClass"];
}

export class ModelGateway implements ModelPort {
  #replayCursor = 0;
  readonly #createdAt: string;
  readonly #decide: ModelDecisionFn;

  constructor(private readonly options: ModelGatewayOptions) {
    this.#createdAt = options.createdAt ?? new Date().toISOString();
    this.#decide = options.decide ?? routeModel;
  }

  static routeInputForTurn(args: {
    readonly turn: ModelTurnInput;
    readonly catalog: ModelCatalogT;
    readonly policy: ModelRoutingPolicyT;
    readonly createdAt?: string;
    readonly requestDataClass?: ModelRouteInputT["requestDataClass"];
  }): ModelRouteInputT {
    const estimatedInputTokens = Math.ceil(
      args.turn.messages.reduce((sum, message) => sum + message.content.length, 0) / 4,
    );
    const requestId =
      `route_req_${args.turn.messages.length}_${estimatedInputTokens}_${args.catalog.catalogVersion}_${args.policy.policyId}`
        .replace(/[^a-zA-Z0-9_]+/g, "_")
        .slice(0, 128);
    return {
      schemaVersion: MODEL_ROUTING_SCHEMA_VERSION,
      requestId,
      createdAt: args.createdAt ?? new Date(0).toISOString(),
      mode: args.policy.mode,
      requestDataClass: args.requestDataClass ?? foldModelRequestDataClass(["user", "workspace"]),
      requiredCapabilities:
        args.turn.tools !== undefined && args.turn.tools.length > 0
          ? ["text", "tool-calls"]
          : ["text"],
      estimatedInputTokens,
      sources: {
        mode: "policy",
        // Honesty: only label this "provenance" when a real, provenance-derived data class was
        // supplied. The fallback value is a static harness fold of ["user","workspace"] — not
        // derived from the turn's provenance — so it must be labelled "harness", not "provenance".
        requestDataClass: args.requestDataClass !== undefined ? "provenance" : "harness",
        requiredCapabilities: "harness",
        estimatedInputTokens: "metered",
        candidateModels: "catalog",
      },
    };
  }

  preview(turn: ModelTurnInput): ModelRoutingDecisionT {
    const recorded = this.options.replayDecisions?.[this.#replayCursor];
    if (recorded !== undefined) return recorded;
    return this.#decide({
      input: ModelGateway.routeInputForTurn({
        turn,
        catalog: this.options.catalog,
        policy: this.options.policy,
        createdAt: this.#createdAt,
        ...(this.options.requestDataClass !== undefined
          ? { requestDataClass: this.options.requestDataClass }
          : {}),
      }),
      catalog: this.options.catalog,
      policy: this.options.policy,
    });
  }

  async *stream(input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
    const recorded = this.options.replayDecisions?.[this.#replayCursor];
    const decision = recorded ?? this.preview(input);
    if (recorded !== undefined) this.#replayCursor += 1;
    this.options.onDecision?.(decision);
    if (decision.status === "denied") {
      yield {
        type: "error",
        code: "model-route-denied",
        message: `model route denied: ${decision.denyCode ?? "no-eligible-model"}`,
      };
      return;
    }
    for await (const chunk of this.options.delegate.stream(input)) yield chunk;
  }
}
