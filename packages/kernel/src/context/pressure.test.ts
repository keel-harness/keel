import { describe, expect, it } from "vitest";
import type { ModelMessageT } from "@keel/shared";
import {
  computeContextPressure,
  estimateModelViewTokens,
  estimateTrailingToolObservationTokens,
  isHarnessBudgetNotice,
  resolveContextWindow,
  type ContextPressure,
} from "./pressure.js";
import { budgetWarningMessage } from "../strings.js";

const messages = (content: string): readonly ModelMessageT[] => [{ role: "user", content }];

describe("computeContextPressure", () => {
  it("recognizes both effective-cost and gross-runway controller notices", () => {
    expect(isHarnessBudgetNotice({ role: "user", content: budgetWarningMessage(8, 10) })).toBe(
      true,
    );
    expect(
      isHarnessBudgetNotice({
        role: "user",
        content:
          "Gross-token runway notice: ~80 of 100 cumulative tokens used (~20 remaining). Finish now or continue with keel --continue for a fresh budgeted run.",
      }),
    ).toBe(true);
  });

  it("does not classify ordinary user prose that merely begins with Budget notice", () => {
    expect(
      isHarnessBudgetNotice({
        role: "user",
        content: "Budget notice: explain how this application's customer budgets are calculated.",
      }),
    ).toBe(false);
  });

  it("keeps provider last-request input, local view estimate, new observation estimate, overhead, and window metadata separate", () => {
    const pressure = computeContextPressure({
      messages: messages("small prompt"),
      cumulativeUsage: { inputTokens: 800_000, outputTokens: 12 },
      lastRequestUsage: { inputTokens: 190_000, outputTokens: 10 },
      lastRequestUsageSource: "provider-reported",
      newObservationTokens: 30,
      overheadTokens: 4_000,
      contextWindow: {
        tokens: 262_000,
        source: "provider-capability",
        provider: "openai-compatible",
        model: "laguna-fp8",
      },
    });

    expect(pressure.providerLastRequestInputTokens).toEqual({
      tokens: 190_000,
      source: "provider-reported",
    });
    expect(pressure.localCurrentViewTokens).toBeLessThan(1_000);
    expect(pressure.newObservationTokens).toBe(30);
    expect(pressure.overheadTokens).toBe(4_000);
    expect(pressure.contextWindow).toEqual({
      tokens: 262_000,
      source: "provider-capability",
      provider: "openai-compatible",
      model: "laguna-fp8",
    });
    expect(pressure.cumulativeRunwayTokens).toBe(800_012);
    expect(pressure.reason).toEqual({
      kind: "provider-last-request",
      severity: "soft",
      tokens: 190_000,
      thresholdTokens: 183_400,
    });
  });

  it("does not treat cumulative usage as current context occupancy", () => {
    const pressure = computeContextPressure({
      messages: messages("small prompt"),
      cumulativeUsage: { inputTokens: 900_000, outputTokens: 50_000 },
      lastRequestUsage: { inputTokens: 120, outputTokens: 5 },
      lastRequestUsageSource: "provider-reported",
      contextWindow: { tokens: 262_000, source: "fallback-default" },
    });

    expect(pressure.cumulativeRunwayTokens).toBe(950_000);
    expect(pressure.reason.kind).toBe("none");
  });

  it("falls back to local signals when provider usage is missing or synthetic", () => {
    const pressure = computeContextPressure({
      messages: messages("x".repeat(8_000)),
      cumulativeUsage: { inputTokens: 0, outputTokens: 0 },
      lastRequestUsage: { inputTokens: 0, outputTokens: 0 },
      lastRequestUsageSource: "local-fallback",
      contextWindow: { tokens: 2_000, source: "explicit-env" },
    });

    expect(pressure.providerLastRequestInputTokens).toEqual({
      tokens: 0,
      source: "local-fallback",
    });
    expect(pressure.reason).toMatchObject({ kind: "local-current-view", severity: "hard" });
  });

  it("accounts for newly appended observations before the next provider usage report can exist", () => {
    const pressure = computeContextPressure({
      messages: messages("short"),
      cumulativeUsage: { inputTokens: 100, outputTokens: 5 },
      lastRequestUsage: { inputTokens: 100, outputTokens: 5 },
      lastRequestUsageSource: "provider-reported",
      newObservationTokens: 9_000,
      contextWindow: { tokens: 10_000, source: "explicit-env" },
    });

    expect(pressure.reason).toEqual({
      kind: "new-observation",
      severity: "hard",
      tokens: 9_000,
      thresholdTokens: 8_500,
    });
  });

  it("prioritizes hard observation pressure over soft provider pressure", () => {
    const pressure = computeContextPressure({
      messages: messages("short"),
      cumulativeUsage: { inputTokens: 0, outputTokens: 0 },
      lastRequestUsage: { inputTokens: 1_500, outputTokens: 0 },
      lastRequestUsageSource: "provider-reported",
      newObservationTokens: 1_800,
      contextWindow: { tokens: 2_000, source: "explicit-env" },
    });

    expect(pressure.reason).toEqual({
      kind: "new-observation",
      severity: "hard",
      tokens: 1_800,
      thresholdTokens: 1_700,
    });
  });

  it("keeps the larger same-severity pressure reason instead of replacing it with a weaker one", () => {
    const pressure = computeContextPressure({
      messages: messages("x".repeat(3_000)),
      cumulativeUsage: { inputTokens: 0, outputTokens: 0 },
      newObservationTokens: 1_450,
      contextWindow: { tokens: 2_000, source: "explicit-env" },
    });

    expect(pressure.reason).toMatchObject({
      kind: "local-current-view",
      severity: "soft",
    });
  });

  it("replaces a same-severity pressure reason when a later source is stronger", () => {
    const pressure = computeContextPressure({
      messages: messages("x".repeat(2_800)),
      cumulativeUsage: { inputTokens: 0, outputTokens: 0 },
      newObservationTokens: 1_600,
      contextWindow: { tokens: 2_000, source: "explicit-env" },
    });

    expect(pressure.reason).toMatchObject({
      kind: "new-observation",
      severity: "soft",
      tokens: 1_600,
    });
  });
});

describe("context pressure token helpers", () => {
  it("estimates model-visible request tokens including tool-schema overhead", () => {
    const base = estimateModelViewTokens({ messages: messages("go") });
    const withTool = estimateModelViewTokens({
      messages: messages("go"),
      tools: [
        { name: "bash", parameters: { type: "object", properties: { cmd: { const: "x" } } } },
      ],
    });

    expect(withTool).toBeGreaterThan(base);
  });

  it("counts trailing tool observations across harness-injected budget warnings", () => {
    expect(
      estimateTrailingToolObservationTokens([
        { role: "user", content: "go" },
        { role: "tool", toolCallId: "old", name: "bash", content: "old output" },
        { role: "assistant", content: "next" },
        { role: "tool", toolCallId: "new-1", name: "bash", content: "new output 1" },
        { role: "tool", toolCallId: "new-2", name: "bash", content: "new output 2" },
        { role: "user", content: budgetWarningMessage(8, 10) },
      ]),
    ).toBeGreaterThan(0);
    expect(
      estimateTrailingToolObservationTokens([
        { role: "user", content: "go" },
        { role: "tool", toolCallId: "old", name: "bash", content: "old output" },
        { role: "assistant", content: "not a new observation" },
      ]),
    ).toBe(0);
  });
});

describe("resolveContextWindow", () => {
  it("prefers the explicit env override and records the source", () => {
    expect(
      resolveContextWindow({
        env: { KEEL_CONTEXT_WINDOW: " 123456 " },
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      }),
    ).toEqual({
      tokens: 123_456,
      source: "explicit-env",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    } satisfies ContextPressure["contextWindow"]);
  });

  it("uses provider capability metadata before the conservative fallback", () => {
    expect(
      resolveContextWindow({
        env: {},
        provider: "openai-compatible",
        model: "laguna-fp8",
      }),
    ).toEqual({
      tokens: 262_000,
      source: "provider-capability",
      provider: "openai-compatible",
      model: "laguna-fp8",
    } satisfies ContextPressure["contextWindow"]);
  });

  it("uses a conservative generic local-model window when no openai-compatible model override is known", () => {
    expect(
      resolveContextWindow({
        env: {},
        provider: "openai-compatible",
        model: "llama3.2:1b",
      }),
    ).toEqual({
      tokens: 32_000,
      source: "provider-capability",
      provider: "openai-compatible",
      model: "llama3.2:1b",
    } satisfies ContextPressure["contextWindow"]);
  });

  it("falls back visibly when the provider id is absent or mismatched", () => {
    expect(
      resolveContextWindow({
        env: {},
        provider: "not-a-provider",
        model: "claude-sonnet-4-6",
      }),
    ).toEqual({
      tokens: 200_000,
      source: "fallback-default",
      provider: "not-a-provider",
      model: "claude-sonnet-4-6",
    } satisfies ContextPressure["contextWindow"]);
  });

  it("omits optional provider/model metadata when no source supplied it", () => {
    expect(resolveContextWindow({ env: { KEEL_CONTEXT_WINDOW: "9000" } })).toEqual({
      tokens: 9_000,
      source: "explicit-env",
    } satisfies ContextPressure["contextWindow"]);
    expect(resolveContextWindow({ env: {} })).toEqual({
      tokens: 200_000,
      source: "fallback-default",
    } satisfies ContextPressure["contextWindow"]);
  });

  it("rejects malformed env overrides and falls back to provider metadata", () => {
    expect(
      resolveContextWindow({
        env: { KEEL_CONTEXT_WINDOW: "1e6" },
        provider: "openai-compatible",
        model: "laguna-fp8",
      }),
    ).toEqual({
      tokens: 262_000,
      source: "provider-capability",
      provider: "openai-compatible",
      model: "laguna-fp8",
    } satisfies ContextPressure["contextWindow"]);
  });
});
