import type { ModelMessageT, ModelUsageT, ToolSpecT } from "@keel/shared";
import { CAPABILITIES, type ProviderId } from "../providers/capabilities.js";
import { estimateTokens } from "./system-prompt.js";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

export type ContextWindowSource = "explicit-env" | "provider-capability" | "fallback-default";
export type ContextUsageSource = "provider-reported" | "local-fallback" | "missing";
export type ContextPressureSeverity = "soft" | "hard";
export type ContextPressureReasonKind =
  | "none"
  | "provider-last-request"
  | "local-current-view"
  | "new-observation";

export interface ContextWindowSpec {
  readonly tokens: number;
  readonly source: ContextWindowSource;
  readonly provider?: string;
  readonly model?: string;
}

export type ContextPressureReason =
  | { readonly kind: "none" }
  | {
      readonly kind: Exclude<ContextPressureReasonKind, "none">;
      readonly severity: ContextPressureSeverity;
      readonly tokens: number;
      readonly thresholdTokens: number;
    };
type ActiveContextPressureReason = Exclude<ContextPressureReason, { readonly kind: "none" }>;

export interface ContextPressure {
  readonly providerLastRequestInputTokens: {
    readonly tokens: number;
    readonly source: ContextUsageSource;
  };
  readonly localCurrentViewTokens: number;
  readonly newObservationTokens: number;
  readonly overheadTokens: number;
  readonly cumulativeRunwayTokens: number;
  readonly contextWindow: ContextWindowSpec;
  readonly reason: ContextPressureReason;
}

export interface ComputeContextPressureInput {
  readonly messages: readonly ModelMessageT[];
  readonly tools?: readonly ToolSpecT[];
  readonly cumulativeUsage: ModelUsageT;
  readonly lastRequestUsage?: ModelUsageT;
  readonly lastRequestUsageSource?: ContextUsageSource;
  readonly newObservationTokens?: number;
  readonly overheadTokens?: number;
  readonly contextWindow: ContextWindowSpec;
  readonly softFraction?: number;
  readonly hardFraction?: number;
}

export interface ResolveContextWindowInput {
  readonly env: Record<string, string | undefined>;
  readonly provider?: string;
  readonly model?: string;
}

const DEFAULT_SOFT_FRACTION = 0.7;
const DEFAULT_HARD_FRACTION = 0.85;

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function isProviderId(value: string | undefined): value is ProviderId {
  return value !== undefined && Object.hasOwn(CAPABILITIES, value);
}

function toolTokens(tools: readonly ToolSpecT[] | undefined): number {
  return tools === undefined ? 0 : conservativeTokens(JSON.stringify(tools)) + tools.length;
}

function conservativeTokens(text: string): number {
  const rough = estimateTokens(text);
  const nonWhitespace = text.replace(/\s/g, "").length;
  const dense = Math.ceil(nonWhitespace / 2);
  return Math.max(rough, dense);
}

function contextMessageTokens(message: { readonly content: string }): number {
  return conservativeTokens(message.content) + 4;
}

export function isHarnessBudgetNotice(message: ModelMessageT): boolean {
  return (
    message.role === "user" &&
    (message.content.startsWith("Budget notice: ~") ||
      message.content.startsWith("Budget notice: effective-cost budget ~") ||
      message.content.startsWith("Effective-cost budget notice: ~") ||
      message.content.startsWith("Gross-token runway notice: ~"))
  );
}

export function estimateModelViewTokens(input: {
  readonly messages: readonly ModelMessageT[];
  readonly tools?: readonly ToolSpecT[];
}): number {
  return (
    input.messages.reduce((sum, message) => sum + contextMessageTokens(message), 0) +
    toolTokens(input.tools)
  );
}

export function estimateTrailingToolObservationTokens(messages: readonly ModelMessageT[]): number {
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "tool") {
      tokens += contextMessageTokens(message);
      continue;
    }
    if (isHarnessBudgetNotice(message)) continue;
    break;
  }
  return tokens;
}

export function resolveContextWindow(input: ResolveContextWindowInput): ContextWindowSpec {
  const explicit = positiveInt(input.env["KEEL_CONTEXT_WINDOW"]);
  if (explicit !== undefined) {
    return {
      tokens: explicit,
      source: "explicit-env",
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    };
  }

  if (isProviderId(input.provider)) {
    const capabilityTokens = CAPABILITIES[input.provider].contextWindowTokens(input.model);
    if (capabilityTokens !== undefined) {
      return {
        tokens: capabilityTokens,
        source: "provider-capability",
        provider: input.provider,
        ...(input.model !== undefined ? { model: input.model } : {}),
      };
    }
  }

  return {
    tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    source: "fallback-default",
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  };
}

function reasonFor(
  kind: Exclude<ContextPressureReasonKind, "none">,
  tokens: number,
  softThreshold: number,
  hardThreshold: number,
): ActiveContextPressureReason | undefined {
  if (tokens >= hardThreshold) {
    return { kind, severity: "hard", tokens, thresholdTokens: hardThreshold };
  }
  if (tokens >= softThreshold) {
    return { kind, severity: "soft", tokens, thresholdTokens: softThreshold };
  }
  return undefined;
}

function betterReason(
  current: ActiveContextPressureReason | undefined,
  next: ActiveContextPressureReason | undefined,
): ActiveContextPressureReason | undefined {
  if (next === undefined) return current;
  if (current === undefined) return next;
  if (next.severity === "hard" && current.severity === "soft") return next;
  if (next.severity === current.severity && next.tokens > current.tokens) return next;
  return current;
}

export function computeContextPressure(input: ComputeContextPressureInput): ContextPressure {
  const softFraction = input.softFraction ?? DEFAULT_SOFT_FRACTION;
  const hardFraction = input.hardFraction ?? DEFAULT_HARD_FRACTION;
  const softThreshold = Math.floor(input.contextWindow.tokens * softFraction);
  const hardThreshold = Math.floor(input.contextWindow.tokens * hardFraction);

  const lastRequestUsage = input.lastRequestUsage ?? { inputTokens: 0, outputTokens: 0 };
  const lastRequestUsageSource = input.lastRequestUsageSource ?? "missing";
  const localCurrentViewTokens = input.messages.reduce(
    (sum, message) => sum + contextMessageTokens(message),
    0,
  );
  const overheadTokens = (input.overheadTokens ?? 0) + toolTokens(input.tools);
  const newObservationTokens = input.newObservationTokens ?? 0;

  let reason: ActiveContextPressureReason | undefined;
  if (lastRequestUsageSource === "provider-reported") {
    reason = betterReason(
      reason,
      reasonFor(
        "provider-last-request",
        lastRequestUsage.inputTokens,
        softThreshold,
        hardThreshold,
      ),
    );
  }
  reason = betterReason(
    reason,
    reasonFor(
      "local-current-view",
      localCurrentViewTokens + overheadTokens,
      softThreshold,
      hardThreshold,
    ),
  );
  reason = betterReason(
    reason,
    reasonFor("new-observation", newObservationTokens, softThreshold, hardThreshold),
  );

  return {
    providerLastRequestInputTokens: {
      tokens: lastRequestUsage.inputTokens,
      source: lastRequestUsageSource,
    },
    localCurrentViewTokens,
    newObservationTokens,
    overheadTokens,
    cumulativeRunwayTokens: input.cumulativeUsage.inputTokens + input.cumulativeUsage.outputTokens,
    contextWindow: input.contextWindow,
    reason: reason ?? { kind: "none" },
  };
}
