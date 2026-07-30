import { describe, expect, it } from "vitest";
import { CAPABILITIES, mapParams, type ProviderId } from "./capabilities.js";

/**
 * The capability table (ADR-0030 Option A) is the declarative home for per-provider
 * divergence. These tests assert the exact VALUE each row produces (not just its shape),
 * because the values — Anthropic's per-effort thinking budgets, OpenAI's 1:1
 * reasoningEffort passthrough, Google's thinkingLevel, and the deliberate `undefined`
 * for openai-compatible — are the contract. A mutant that swaps a budget, drops a
 * provider key, or returns `{}` instead of `undefined` must fail here.
 */

const EFFORTS = ["low", "medium", "high"] as const;

describe("CAPABILITIES — anthropic row", () => {
  const cap = CAPABILITIES.anthropic;

  it("supports native tools and uses the anthropic-breakpoint cache strategy", () => {
    expect(cap.supportsNativeTools).toBe(true);
    expect(cap.cacheStrategy).toBe("anthropic-breakpoint");
  });

  it("maps each effort to thinking.budgetTokens (low 2048 · medium 8192 · high 16384)", () => {
    expect(cap.reasoningOptions("low")).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 2048 } },
    });
    expect(cap.reasoningOptions("medium")).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 8192 } },
    });
    expect(cap.reasoningOptions("high")).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 16384 } },
    });
  });
});

describe("CAPABILITIES — openai row", () => {
  const cap = CAPABILITIES.openai;

  it("supports native tools and uses the openai-cache-key cache strategy", () => {
    expect(cap.supportsNativeTools).toBe(true);
    expect(cap.cacheStrategy).toBe("openai-cache-key");
  });

  it("passes the effort through 1:1 as reasoningEffort", () => {
    for (const e of EFFORTS) {
      expect(cap.reasoningOptions(e)).toEqual({ openai: { reasoningEffort: e } });
    }
  });
});

describe("CAPABILITIES — google row", () => {
  const cap = CAPABILITIES.google;

  it("supports native tools and uses the google-implicit cache strategy", () => {
    expect(cap.supportsNativeTools).toBe(true);
    expect(cap.cacheStrategy).toBe("google-implicit");
  });

  it("maps the effort to thinkingConfig.thinkingLevel", () => {
    for (const e of EFFORTS) {
      expect(cap.reasoningOptions(e)).toEqual({ google: { thinkingConfig: { thinkingLevel: e } } });
    }
  });
});

describe("CAPABILITIES — openai-compatible (local/Ollama) row", () => {
  const cap = CAPABILITIES["openai-compatible"];

  it("supports native tools best-effort and declares no cache strategy", () => {
    expect(cap.supportsNativeTools).toBe(true);
    expect(cap.cacheStrategy).toBe("none");
  });

  it("returns undefined reasoning options for every effort (ignored, not an empty object)", () => {
    for (const e of EFFORTS) {
      expect(cap.reasoningOptions(e)).toBeUndefined();
    }
  });
});

describe("CAPABILITIES — table completeness", () => {
  it("declares exactly the four provider ids", () => {
    expect(Object.keys(CAPABILITIES).sort()).toEqual(
      (["anthropic", "google", "openai", "openai-compatible"] satisfies ProviderId[]).sort(),
    );
  });
});

describe("mapParams — omit-temperature under reasoning (ADR-0030)", () => {
  it("returns reasoning providerOptions and NO temperature when reasoningEffort is set", () => {
    const out = mapParams({ reasoningEffort: "high" }, CAPABILITIES.anthropic);
    expect(out.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 16384 } },
    });
    expect("temperature" in out).toBe(false);
  });

  it("still omits temperature when BOTH reasoningEffort and an explicit temperature are given (reasoning wins)", () => {
    const out = mapParams({ reasoningEffort: "high", temperature: 0.7 }, CAPABILITIES.anthropic);
    expect(out.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 16384 } },
    });
    expect("temperature" in out).toBe(false);
  });

  it("omits providerOptions when the row returns undefined reasoning options (openai-compatible)", () => {
    const out = mapParams({ reasoningEffort: "high" }, CAPABILITIES["openai-compatible"]);
    expect("providerOptions" in out).toBe(false);
    expect("temperature" in out).toBe(false);
  });

  it("maps reasoningEffort onto each provider's options", () => {
    expect(mapParams({ reasoningEffort: "low" }, CAPABILITIES.openai).providerOptions).toEqual({
      openai: { reasoningEffort: "low" },
    });
    expect(mapParams({ reasoningEffort: "medium" }, CAPABILITIES.google).providerOptions).toEqual({
      google: { thinkingConfig: { thinkingLevel: "medium" } },
    });
  });
});

describe("mapParams — temperature passthrough when reasoning is unset", () => {
  it("includes temperature when provided and reasoningEffort is unset", () => {
    const out = mapParams({ temperature: 0.3 }, CAPABILITIES.anthropic);
    expect(out.temperature).toBe(0.3);
    expect("providerOptions" in out).toBe(false);
  });

  it("includes temperature 0 (a valid value, not treated as absent)", () => {
    const out = mapParams({ temperature: 0 }, CAPABILITIES.anthropic);
    expect(out.temperature).toBe(0);
  });

  it("omits temperature when neither reasoningEffort nor temperature is given", () => {
    const out = mapParams({}, CAPABILITIES.anthropic);
    expect("temperature" in out).toBe(false);
    expect("providerOptions" in out).toBe(false);
  });

  it("omits everything when params is undefined", () => {
    const out = mapParams(undefined, CAPABILITIES.anthropic);
    expect(out).toEqual({});
  });
});

describe("mapParams — maxOutputTokens passthrough (independent of reasoning)", () => {
  it("includes maxOutputTokens when provided (with reasoning)", () => {
    const out = mapParams(
      { reasoningEffort: "high", maxOutputTokens: 4096 },
      CAPABILITIES.anthropic,
    );
    expect(out.maxOutputTokens).toBe(4096);
    expect("temperature" in out).toBe(false);
  });

  it("includes maxOutputTokens when provided (with temperature, no reasoning)", () => {
    const out = mapParams({ temperature: 0.5, maxOutputTokens: 1000 }, CAPABILITIES.openai);
    expect(out.maxOutputTokens).toBe(1000);
    expect(out.temperature).toBe(0.5);
  });

  it("omits maxOutputTokens when not provided", () => {
    const out = mapParams({ temperature: 0.5 }, CAPABILITIES.openai);
    expect("maxOutputTokens" in out).toBe(false);
  });

  it("includes maxOutputTokens when the value is 0 (falsy but defined — not treated as absent)", () => {
    // Regression: a truthiness check (`params.maxOutputTokens ?`) would drop 0. The correct
    // guard is `!== undefined`, which this test enforces. The temperature:0 parallel is already
    // tested above; this closes the mutant gap for maxOutputTokens.
    const out = mapParams({ maxOutputTokens: 0 }, CAPABILITIES.anthropic);
    expect("maxOutputTokens" in out).toBe(true);
    expect(out.maxOutputTokens).toBe(0);
  });

  it("never includes a `model` key (the model is resolved separately by the port)", () => {
    const out = mapParams({ model: "claude-x", reasoningEffort: "high" }, CAPABILITIES.anthropic);
    expect("model" in out).toBe(false);
  });
});

describe("CAPABILITIES — cacheReadWeight (ADR-0044 cost-aware budget)", () => {
  it("anthropic weights cached input at 0.1× (ephemeral cache reads bill ~0.1× of fresh input)", () => {
    expect(CAPABILITIES.anthropic.cacheReadWeight).toBe(0.1);
  });

  it("every other provider is conservative (1.0×) until its cache-read telemetry is validated", () => {
    // Under-crediting cache only ever stops a task EARLY (never overspends) — the safe default
    // for a provider whose cache-read multiplier we have not measured against real billing.
    expect(CAPABILITIES.openai.cacheReadWeight).toBe(1.0);
    expect(CAPABILITIES.google.cacheReadWeight).toBe(1.0);
    expect(CAPABILITIES["openai-compatible"].cacheReadWeight).toBe(1.0);
  });

  it("every row declares a weight in [0,1] (a weight > 1 would let cached history overspend)", () => {
    for (const id of Object.keys(CAPABILITIES) as ProviderId[]) {
      const w = CAPABILITIES[id].cacheReadWeight;
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });
});

describe("CAPABILITIES — contextWindowTokens metadata", () => {
  it("keeps generic built-in provider windows conservative", () => {
    expect(CAPABILITIES.anthropic.contextWindowTokens("claude-sonnet-4-6")).toBe(200_000);
    expect(CAPABILITIES.openai.contextWindowTokens("gpt-x")).toBe(128_000);
    expect(CAPABILITIES.google.contextWindowTokens("gemini-x")).toBe(200_000);
  });

  it("advertises the exact known Laguna openai-compatible window without overmatching every Laguna-like model", () => {
    expect(CAPABILITIES["openai-compatible"].contextWindowTokens("laguna-fp8")).toBe(262_000);
    expect(CAPABILITIES["openai-compatible"].contextWindowTokens("laguna-experimental")).toBe(
      32_000,
    );
    expect(CAPABILITIES["openai-compatible"].contextWindowTokens("llama3.2:1b")).toBe(32_000);
  });
});
