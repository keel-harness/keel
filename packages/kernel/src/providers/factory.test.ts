import { describe, expect, it, vi } from "vitest";
import type { ModelStreamChunkT, ModelTurnInput } from "@keel/shared";
import {
  createAnthropicModelPort,
  createOpenAIModelPort,
  createGoogleModelPort,
  createOpenAICompatibleModelPort,
} from "./factory.js";
import { VercelModelPort } from "./vercel-model-port.js";
import type { StreamTextFn, StreamTextOptions } from "./vercel-model-port.js";

const input: ModelTurnInput = { messages: [{ role: "user", content: "hi" }] };

async function collect(stream: AsyncIterable<ModelStreamChunkT>): Promise<ModelStreamChunkT[]> {
  const out: ModelStreamChunkT[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

/** A minimal StreamTextFn spy that yields one finish chunk and records its call options. */
function makeStreamSpy(): {
  spy: ReturnType<typeof vi.fn<StreamTextFn>>;
  capturedOpts: () => StreamTextOptions;
} {
  let captured: StreamTextOptions | undefined;
  const spy = vi.fn<StreamTextFn>((opts) => {
    captured = opts;
    return {
      fullStream: (async function* () {
        yield {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    };
  });
  return {
    spy,
    capturedOpts: () => {
      if (captured === undefined) throw new Error("streamText was not called");
      return captured;
    },
  };
}

describe("createAnthropicModelPort", () => {
  it("builds a VercelModelPort backed by an Anthropic language model", () => {
    const port = createAnthropicModelPort({ model: "claude-test", apiKey: "sk-test" });
    expect(port).toBeInstanceOf(VercelModelPort);
  });

  it("builds a port without an explicit apiKey (falls through to the SDK env default)", () => {
    // The no-apiKey branch: the provider is constructed with `{}` and reads ANTHROPIC_API_KEY
    // itself. Construction must not throw, and we never hit the network (no stream() call).
    const port = createAnthropicModelPort({ model: "claude-test" });
    expect(port).toBeInstanceOf(VercelModelPort);
  });

  it("streams through the injected streamText (no network), passing the built model", async () => {
    const spy = vi.fn<StreamTextFn>(() => ({
      fullStream: (async function* () {
        yield {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    }));
    const port = createAnthropicModelPort({
      model: "claude-sentinel",
      apiKey: "sk-test",
      streamText: spy,
    });
    const out: ModelStreamChunkT[] = [];
    for await (const c of port.stream(input)) out.push(c);
    expect(out).toEqual([
      { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    // The factory selected a concrete LanguageModel (not the bare string id) for the port,
    // and the sentinel model id must flow through buildModel to the resolved LanguageModel.
    const resolvedModel = spy.mock.calls[0]![0].model;
    expect(resolvedModel).toBeDefined();
    expect(typeof resolvedModel).not.toBe("string");
    expect((resolvedModel as { modelId?: string }).modelId).toBe("claude-sentinel");
  });

  it("wires the anthropic capability row — reasoningEffort:high → anthropic thinking providerOptions, no temperature", async () => {
    const { spy, capturedOpts } = makeStreamSpy();
    const port = createAnthropicModelPort({
      model: "claude-test",
      apiKey: "sk-test",
      streamText: spy,
    });
    const reasoningInput: ModelTurnInput = {
      messages: [{ role: "user", content: "think" }],
      params: { reasoningEffort: "high" },
    };
    for await (const chunk of port.stream(reasoningInput)) void chunk;
    const opts = capturedOpts();
    // Must carry anthropic-namespaced thinking config (the capability row mapping).
    expect(opts.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 16384 } },
    });
    // Temperature MUST be absent — the omit-temperature rule (ADR-0030).
    expect(opts).not.toHaveProperty("temperature");
  });

  it("threads maxRetries and fetch without TypeScript errors", () => {
    const mockFetch = vi.fn<typeof globalThis.fetch>();
    // Construction must not throw; no stream() needed to exercise the option threading path.
    const port = createAnthropicModelPort({
      model: "claude-test",
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: mockFetch,
    });
    expect(port).toBeInstanceOf(VercelModelPort);
  });
});

// ---------------------------------------------------------------------------
// createOpenAIModelPort
// ---------------------------------------------------------------------------
describe("createOpenAIModelPort", () => {
  it("builds a VercelModelPort backed by an OpenAI language model", () => {
    const port = createOpenAIModelPort({ model: "gpt-4o", apiKey: "sk-test" });
    expect(port).toBeInstanceOf(VercelModelPort);
  });

  it("builds a port without an explicit apiKey (falls through to OPENAI_API_KEY env)", () => {
    const port = createOpenAIModelPort({ model: "gpt-4o" });
    expect(port).toBeInstanceOf(VercelModelPort);
  });

  it("streams through the injected streamText (no network), passing the built model", async () => {
    const { spy } = makeStreamSpy();
    const port = createOpenAIModelPort({
      model: "openai-sentinel",
      apiKey: "sk-test",
      streamText: spy,
    });
    const out: ModelStreamChunkT[] = [];
    for await (const c of port.stream(input)) out.push(c);
    expect(out).toEqual([
      { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    // The factory selected a concrete LanguageModel (not the bare string id), and the sentinel
    // model id must flow through buildModel to the resolved LanguageModel.
    const resolvedModel = spy.mock.calls[0]![0].model;
    expect(resolvedModel).toBeDefined();
    expect(typeof resolvedModel).not.toBe("string");
    expect((resolvedModel as { modelId?: string }).modelId).toBe("openai-sentinel");
  });

  it("wires the openai capability row — reasoningEffort:high → openai providerOptions, no temperature", async () => {
    const { spy, capturedOpts } = makeStreamSpy();
    const port = createOpenAIModelPort({ model: "o3", apiKey: "sk-test", streamText: spy });
    const reasoningInput: ModelTurnInput = {
      messages: [{ role: "user", content: "think" }],
      params: { reasoningEffort: "high" },
    };
    for await (const chunk of port.stream(reasoningInput)) void chunk;
    const opts = capturedOpts();
    // Must carry openai-namespaced reasoningEffort (the capability row mapping).
    expect(opts.providerOptions).toEqual({ openai: { reasoningEffort: "high" } });
    // Temperature MUST be absent — the omit-temperature rule (ADR-0030).
    expect(opts).not.toHaveProperty("temperature");
  });

  it("threads maxRetries and fetch without TypeScript errors", () => {
    const mockFetch = vi.fn<typeof globalThis.fetch>();
    const port = createOpenAIModelPort({
      model: "gpt-4o",
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: mockFetch,
    });
    expect(port).toBeInstanceOf(VercelModelPort);
  });
});

// ---------------------------------------------------------------------------
// createGoogleModelPort
// ---------------------------------------------------------------------------
describe("createGoogleModelPort", () => {
  it("builds a VercelModelPort backed by a Google Generative AI language model", () => {
    const port = createGoogleModelPort({ model: "gemini-2.5-pro", apiKey: "key-test" });
    expect(port).toBeInstanceOf(VercelModelPort);
  });

  it("builds a port without an explicit apiKey (falls through to GOOGLE_GENERATIVE_AI_API_KEY env)", () => {
    const port = createGoogleModelPort({ model: "gemini-2.5-pro" });
    expect(port).toBeInstanceOf(VercelModelPort);
  });

  it("streams through the injected streamText (no network), passing the built model", async () => {
    const { spy } = makeStreamSpy();
    const port = createGoogleModelPort({
      model: "google-sentinel",
      apiKey: "key-test",
      streamText: spy,
    });
    const out: ModelStreamChunkT[] = [];
    for await (const c of port.stream(input)) out.push(c);
    expect(out).toEqual([
      { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    // The factory selected a concrete LanguageModel (not the bare string id), and the sentinel
    // model id must flow through buildModel to the resolved LanguageModel.
    const resolvedModel = spy.mock.calls[0]![0].model;
    expect(resolvedModel).toBeDefined();
    expect(typeof resolvedModel).not.toBe("string");
    expect((resolvedModel as { modelId?: string }).modelId).toBe("google-sentinel");
  });

  it("wires the google capability row — reasoningEffort:high → google thinkingConfig providerOptions, no temperature", async () => {
    const { spy, capturedOpts } = makeStreamSpy();
    const port = createGoogleModelPort({
      model: "gemini-2.5-pro",
      apiKey: "key-test",
      streamText: spy,
    });
    const reasoningInput: ModelTurnInput = {
      messages: [{ role: "user", content: "think" }],
      params: { reasoningEffort: "high" },
    };
    for await (const chunk of port.stream(reasoningInput)) void chunk;
    const opts = capturedOpts();
    // Must carry google-namespaced thinkingConfig (the capability row mapping).
    expect(opts.providerOptions).toEqual({
      google: { thinkingConfig: { thinkingLevel: "high" } },
    });
    // Temperature MUST be absent — the omit-temperature rule (ADR-0030).
    expect(opts).not.toHaveProperty("temperature");
  });

  it("threads maxRetries and fetch without TypeScript errors", () => {
    const mockFetch = vi.fn<typeof globalThis.fetch>();
    const port = createGoogleModelPort({
      model: "gemini-2.5-pro",
      apiKey: "key-test",
      maxRetries: 0,
      fetch: mockFetch,
    });
    expect(port).toBeInstanceOf(VercelModelPort);
  });
});

// ---------------------------------------------------------------------------
// createOpenAICompatibleModelPort
// ---------------------------------------------------------------------------
describe("createOpenAICompatibleModelPort", () => {
  it("builds a VercelModelPort backed by an OpenAI-compatible language model", () => {
    const port = createOpenAICompatibleModelPort({
      model: "llama3.2:1b",
      baseURL: "http://localhost:11434/v1",
    });
    expect(port).toBeInstanceOf(VercelModelPort);
  });

  it("accepts an explicit provider name and apiKey without TypeScript errors", () => {
    const port = createOpenAICompatibleModelPort({
      model: "llama3.2:1b",
      baseURL: "http://localhost:11434/v1",
      name: "ollama",
      apiKey: "ollama",
    });
    expect(port).toBeInstanceOf(VercelModelPort);
  });

  it("streams through the injected streamText (no network), passing the built model", async () => {
    const { spy } = makeStreamSpy();
    const port = createOpenAICompatibleModelPort({
      model: "compat-sentinel",
      baseURL: "http://localhost:11434/v1",
      streamText: spy,
    });
    const out: ModelStreamChunkT[] = [];
    for await (const c of port.stream(input)) out.push(c);
    expect(out).toEqual([
      { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    // The factory selected a concrete LanguageModel (not the bare string id), and the sentinel
    // model id must flow through buildModel to the resolved LanguageModel.
    const resolvedModel = spy.mock.calls[0]![0].model;
    expect(resolvedModel).toBeDefined();
    expect(typeof resolvedModel).not.toBe("string");
    expect((resolvedModel as { modelId?: string }).modelId).toBe("compat-sentinel");
  });

  it("requests stream usage from OpenAI-compatible providers", async () => {
    let requestBody: unknown;
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (typeof init?.body !== "string") throw new Error("expected JSON request body");
      requestBody = JSON.parse(init.body);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const port = createOpenAICompatibleModelPort({
      model: "compat-sentinel",
      baseURL: "http://localhost:11434/v1",
      apiKey: "sk-test",
      fetch: fetchMock,
    });

    await collect(port.stream(input));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBody).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("wires the openai-compatible capability row — reasoningEffort:high → NO providerOptions (undefined), no temperature", async () => {
    // The openai-compatible row returns `undefined` from `reasoningOptions` — reasoning is
    // silently ignored (no standard reasoning knob for local/Ollama models). The adapter
    // therefore OMITS `providerOptions` entirely from the streamText call, and the
    // omit-temperature rule (ADR-0030) also applies (no temperature key when reasoning is set).
    const { spy, capturedOpts } = makeStreamSpy();
    const port = createOpenAICompatibleModelPort({
      model: "llama3.2:1b",
      baseURL: "http://localhost:11434/v1",
      streamText: spy,
    });
    const reasoningInput: ModelTurnInput = {
      messages: [{ role: "user", content: "think" }],
      params: { reasoningEffort: "high" },
    };
    for await (const chunk of port.stream(reasoningInput)) void chunk;
    const opts = capturedOpts();
    // openai-compatible: no reasoning providerOptions — must be absent entirely.
    expect(opts).not.toHaveProperty("providerOptions");
    // Temperature MUST also be absent (omit-temperature rule applies regardless).
    expect(opts).not.toHaveProperty("temperature");
  });

  it("threads maxRetries and fetch without TypeScript errors", () => {
    const mockFetch = vi.fn<typeof globalThis.fetch>();
    const port = createOpenAICompatibleModelPort({
      model: "llama3.2:1b",
      baseURL: "http://localhost:11434/v1",
      maxRetries: 0,
      fetch: mockFetch,
    });
    expect(port).toBeInstanceOf(VercelModelPort);
  });
});
