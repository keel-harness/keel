import { describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import type { ModelStreamChunkT, ModelTurnInput } from "@keel/shared";
import { VercelModelPort } from "./vercel-model-port.js";
import type { StreamTextFn, StreamTextOptions } from "./vercel-model-port.js";
import { CAPABILITIES, type ProviderCapability, type ProviderId } from "./capabilities.js";

/**
 * Slice-4 param mapping wired into the port: the per-turn `params` (reasoning sandwich)
 * must reach `streamText` as the right `providerOptions`/`temperature`/`maxOutputTokens`,
 * and `params.model` must override the model PER TURN by re-resolving `buildModel`.
 *
 * Every provider row is exercised through the SAME adapter core + a mock transport that
 * captures the `streamText` options — proving the divergence lives only in the capability
 * table (ADR-0030), not in the adapter. The omit-temperature assertions are the structural
 * proof of ADR-0030 Decision 1, per provider id.
 */

/** A fake model object — distinct per id so `buildModel(id)` is observable. */
function fakeModel(id: string): LanguageModel {
  return { __fakeModelId: id } as unknown as LanguageModel;
}

/** A captured-options mock transport that finishes immediately. */
function capturingStreamText(): { fn: StreamTextFn; captured: () => StreamTextOptions } {
  let seen: StreamTextOptions | undefined;
  const fn: StreamTextFn = (opts) => {
    seen = opts;
    return {
      fullStream: (async function* () {
        yield { type: "finish", finishReason: "stop", totalUsage: {} };
      })(),
    };
  };
  return {
    fn,
    captured: () => {
      if (seen === undefined) throw new Error("streamText was not called");
      return seen;
    },
  };
}

/** Build a port for a given provider id with a tracking `buildModel`. */
function portFor(
  id: ProviderId,
  streamText: StreamTextFn,
  buildModel: (modelId: string) => LanguageModel = fakeModel,
): { port: VercelModelPort; capability: ProviderCapability } {
  const capability = CAPABILITIES[id];
  const port = new VercelModelPort(
    { defaultModelId: `${id}-default`, buildModel, capability },
    { streamText },
  );
  return { port, capability };
}

async function drain(port: VercelModelPort, input: ModelTurnInput): Promise<ModelStreamChunkT[]> {
  const out: ModelStreamChunkT[] = [];
  for await (const c of port.stream(input)) out.push(c);
  return out;
}

const userInput: ModelTurnInput = { messages: [{ role: "user", content: "hi" }] };

const PROVIDER_IDS = ["anthropic", "openai", "google", "openai-compatible"] as const;

/** Expected providerOptions for `reasoningEffort:"high"` per provider (undefined = none sent). */
const REASONING_HIGH: Record<ProviderId, Record<string, unknown> | undefined> = {
  anthropic: { anthropic: { thinking: { type: "enabled", budgetTokens: 16384 } } },
  openai: { openai: { reasoningEffort: "high" } },
  google: { google: { thinkingConfig: { thinkingLevel: "high" } } },
  "openai-compatible": undefined,
};

describe("VercelModelPort — omit-temperature under reasoning (ADR-0030 proof, per provider)", () => {
  for (const id of PROVIDER_IDS) {
    it(`[${id}] reasoningEffort:high → reasoning providerOptions present, NO temperature key`, async () => {
      const t = capturingStreamText();
      const { port } = portFor(id, t.fn);
      await drain(port, { ...userInput, params: { reasoningEffort: "high" } });
      const opts = t.captured();
      const expected = REASONING_HIGH[id];
      if (expected === undefined) {
        expect("providerOptions" in opts).toBe(false);
      } else {
        expect(opts.providerOptions).toEqual(expected);
      }
      // The structural ADR-0030 assertion: no temperature is ever sent under reasoning.
      expect("temperature" in opts).toBe(false);
    });

    it(`[${id}] reasoningEffort:high + explicit temperature:0.7 → STILL no temperature (reasoning wins)`, async () => {
      const t = capturingStreamText();
      const { port } = portFor(id, t.fn);
      await drain(port, { ...userInput, params: { reasoningEffort: "high", temperature: 0.7 } });
      const opts = t.captured();
      expect("temperature" in opts).toBe(false);
      const expected = REASONING_HIGH[id];
      if (expected !== undefined) expect(opts.providerOptions).toEqual(expected);
    });
  }
});

describe("VercelModelPort — temperature passthrough when reasoning is unset", () => {
  for (const id of PROVIDER_IDS) {
    it(`[${id}] temperature:0.3 (no reasoning) → temperature present, NO reasoning providerOptions`, async () => {
      const t = capturingStreamText();
      const { port } = portFor(id, t.fn);
      await drain(port, { ...userInput, params: { temperature: 0.3 } });
      const opts = t.captured();
      expect(opts.temperature).toBe(0.3);
      expect("providerOptions" in opts).toBe(false);
    });
  }

  it("passes no params at all (no temperature, no providerOptions) when params is absent", async () => {
    const t = capturingStreamText();
    const { port } = portFor("anthropic", t.fn);
    await drain(port, userInput);
    const opts = t.captured();
    expect("temperature" in opts).toBe(false);
    expect("providerOptions" in opts).toBe(false);
    expect("maxOutputTokens" in opts).toBe(false);
  });
});

describe("VercelModelPort — model override per turn", () => {
  it("resolves buildModel(params.model) when a per-turn model override is given", async () => {
    const build = vi.fn(fakeModel);
    const t = capturingStreamText();
    const { port } = portFor("anthropic", t.fn, build);
    await drain(port, { ...userInput, params: { model: "claude-x" } });
    expect(build).toHaveBeenCalledWith("claude-x");
    expect(t.captured().model).toEqual(fakeModel("claude-x"));
  });

  it("resolves buildModel(defaultModelId) when no per-turn model override is given", async () => {
    const build = vi.fn(fakeModel);
    const t = capturingStreamText();
    const { port } = portFor("anthropic", t.fn, build);
    await drain(port, userInput);
    expect(build).toHaveBeenCalledWith("anthropic-default");
    expect(t.captured().model).toEqual(fakeModel("anthropic-default"));
  });

  it("re-resolves the model EACH turn (a later turn's override does not reuse the first)", async () => {
    const build = vi.fn(fakeModel);
    const t = capturingStreamText();
    const { port } = portFor("anthropic", t.fn, build);
    await drain(port, userInput); // default
    await drain(port, { ...userInput, params: { model: "claude-haiku" } }); // override
    expect(build).toHaveBeenNthCalledWith(1, "anthropic-default");
    expect(build).toHaveBeenNthCalledWith(2, "claude-haiku");
  });
});

describe("VercelModelPort — maxOutputTokens passthrough", () => {
  it("forwards maxOutputTokens to streamText", async () => {
    const t = capturingStreamText();
    const { port } = portFor("openai", t.fn);
    await drain(port, { ...userInput, params: { maxOutputTokens: 2048, temperature: 0.2 } });
    const opts = t.captured();
    expect(opts.maxOutputTokens).toBe(2048);
    expect(opts.temperature).toBe(0.2);
  });

  it("forwards maxOutputTokens alongside reasoning options (still no temperature)", async () => {
    const t = capturingStreamText();
    const { port } = portFor("anthropic", t.fn);
    await drain(port, {
      ...userInput,
      params: { reasoningEffort: "medium", maxOutputTokens: 9000 },
    });
    const opts = t.captured();
    expect(opts.maxOutputTokens).toBe(9000);
    expect(opts.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 8192 } },
    });
    expect("temperature" in opts).toBe(false);
  });
});
