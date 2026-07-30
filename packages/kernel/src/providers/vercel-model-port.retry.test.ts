import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { streamText as realStreamText } from "ai";
import type { ModelStreamChunkT, ToolSpecT } from "@keel/shared";
import { runAgentLoop } from "../loop.js";
import { LocalExecutor } from "../local-executor.js";
import type { KernelEventT } from "../events.js";
import { createAnthropicModelPort } from "./factory.js";
import { DEFAULT_MAX_RETRIES } from "./vercel-model-port.js";
import type { StreamTextFn } from "./vercel-model-port.js";

/**
 * The REAL `streamText` cast to the adapter's structural `StreamTextFn` seam. The cast mirrors
 * the production wiring in `vercel-model-port.ts` (`defaultStreamText as unknown as StreamTextFn`):
 * the adapter's `StreamTextOptions` is a deliberate structural SUBSET of the SDK's far-wider call
 * settings, and the two differ only on `providerOptions` variance (keel's `Record<string,unknown>`
 * vs the SDK's `JSONObject`-valued type) — a known, intended narrowing. This is the same `streamText`
 * the adapter uses in production; only the seam's static type is bridged.
 */
const streamText = realStreamText as unknown as StreamTextFn;

/**
 * Slice-6 transport-retry contract (design §10, ADR-0028). Unlike the slice-1–5 suites
 * (which inject a MOCK `streamText`), these drive the REAL `streamText` from `'ai'` over a
 * mock `fetch` so the SDK's actual retry loop (`retryWithExponentialBackoffRespectingRetry
 * Headers` → `APICallError.isRetryable`) runs end-to-end. The mock `fetch` returns scripted
 * HTTP `Response`s with NO network and NO real backoff sleep — see `mock503` below.
 *
 * What this proves *executably* (not relied-upon from SDK prose):
 *  - a 503 is retried within the bound (real `fetch` call count is asserted),
 *  - a 400 is NOT retried (classification keys on status, as ADR-0028 §1 claims),
 *  - retry exhaustion surfaces as a single keel `error` chunk (the adapter never throws),
 *  - `maxRetries` is honored as a bound (override to 0 → immediate surface),
 *  - the LOAD-BEARING check: a transport retry below `ModelPort` does NOT multiply tool
 *    executions above it (the executor is called exactly once for a tool the retried turn
 *    yields).
 *
 * Determinism / no real timers: the SDK's backoff is `delay(getRetryDelayInMs(...))`, which
 * honors a `retry-after-ms` header when it is below the exponential delay. Every transient
 * (503) `Response` here carries `retry-after-ms: 0`, so the SDK sleeps `setTimeout(_, 0)` —
 * effectively instant — instead of its 2000ms default. No fake timers, no flakiness.
 */

const MODEL = "claude-test";
const API_KEY = "sk-test";

/** A minimal but VALID Anthropic SSE `200` body for a text-only turn (provider chunk schema). */
function anthropicTextSse(text: string, usage = { input: 7, output: 3 }): string {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        model: MODEL,
        role: "assistant",
        usage: { input_tokens: usage.input },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: usage.output },
    },
    { type: "message_stop" },
  ];
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

/** A VALID Anthropic SSE `200` body that yields ONE atomic tool call (tool_use + input_json_delta). */
function anthropicToolCallSse(toolName: string, args: Record<string, unknown>): string {
  const events = [
    {
      type: "message_start",
      message: { id: "msg_1", model: MODEL, role: "assistant", usage: { input_tokens: 5 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: toolName },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ];
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

/** A streaming `200` `Response` (text/event-stream) the SDK's success handler will consume. */
function sse200(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * A transient `503` `Response`. The `retry-after-ms: 0` header is the determinism seam: the
 * SDK's `getRetryDelayInMs` picks it over the 2000ms exponential default, so the retry sleeps
 * ~0ms. The JSON body matches Anthropic's error schema (so it parses cleanly), but the
 * statusCode (503 ≥ 500) is what makes the resulting `APICallError.isRetryable === true`.
 */
function err503(): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "overloaded" } }),
    {
      status: 503,
      headers: { "content-type": "application/json", "retry-after-ms": "0" },
    },
  );
}

/** A `400` client error `Response` — `isRetryable === false` (NOT 408/409/429/≥500). */
function err400(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "bad request" },
    }),
    {
      status: 400,
      headers: { "content-type": "application/json" },
    },
  );
}

/** Build a `fetch` mock that returns the queued responses in order (then repeats the last). */
function scriptedFetch(responses: Response[]): ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    // Clone so a body can be read once per call even if the same Response object is reused.
    return r.clone();
  });
}

/** A `fetch` that ALWAYS returns a fresh 503 (for the exhaustion test — every attempt fails). */
function always503(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => err503());
}

async function collect(stream: AsyncIterable<ModelStreamChunkT>): Promise<ModelStreamChunkT[]> {
  const out: ModelStreamChunkT[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

describe("VercelModelPort transport retry — real streamText over a mock fetch (ADR-0028)", () => {
  // Capture console.error so provider-error paths can prove the adapter suppresses the SDK's
  // default diagnostic dump while still surfacing a typed keel error chunk.
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  beforeEach(() => {
    consoleError.mockClear();
  });
  afterAll(() => {
    consoleError.mockRestore();
  });

  it("retries a 503 within the bound, then succeeds (fetch called exactly twice)", async () => {
    const fetchMock = scriptedFetch([
      err503(),
      sse200(anthropicTextSse("hello", { input: 10, output: 5 })),
    ]);
    const port = createAnthropicModelPort({
      model: MODEL,
      apiKey: API_KEY,
      // Inject real streamText + a mock fetch so the SDK's real retry path runs with no network.
      streamText,
      fetch: fetchMock,
    });

    const out = await collect(port.stream({ messages: [{ role: "user", content: "hi" }] }));

    // One retry: the first 503 was retried, the second attempt (200) produced output.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out).toContainEqual({ type: "text-delta", text: "hello" });
    const finish = out.find((c) => c.type === "finish");
    // The real Anthropic stream reports both cache subsets via `inputTokenDetails` (0 each here — no
    // cache read or write on this turn), so the mapped usage carries `cachedInputTokens` AND
    // `cacheCreationInputTokens` (bounded live Harbor validation + ADR-0047 instrumentation). PROV-1: before the field-name fix the
    // write subset was read from a top-level field the SDK never emits and was silently always dropped.
    expect(finish).toEqual({
      type: "finish",
      reason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
    // No error chunk on the successful (retried) path.
    expect(out.some((c) => c.type === "error")).toBe(false);
  });

  it("does NOT retry a 400 — fetch called exactly once, surfaces an error chunk", async () => {
    const fetchMock = scriptedFetch([err400(), sse200(anthropicTextSse("unreached"))]);
    const port = createAnthropicModelPort({
      model: MODEL,
      apiKey: API_KEY,
      streamText,
      fetch: fetchMock,
    });

    const out = await collect(port.stream({ messages: [{ role: "user", content: "hi" }] }));

    // A 400 is non-retryable (not 408/409/429/≥500): exactly one attempt, no retry.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const terminals = out.filter((c) => c.type === "finish" || c.type === "error");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.type).toBe("error");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("exhausts retries (maxRetries+1 attempts) then surfaces a single terminal error chunk (never throws)", async () => {
    const fetchMock = always503();
    const port = createAnthropicModelPort({
      model: MODEL,
      apiKey: API_KEY,
      maxRetries: 2, // the adapter default; stated explicitly for the count assertion
      streamText,
      fetch: fetchMock,
    });

    const out = await collect(port.stream({ messages: [{ role: "user", content: "hi" }] }));

    // maxRetries=2 → 1 initial + 2 retries = 3 attempts, all 503.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const terminals = out.filter((c) => c.type === "finish" || c.type === "error");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.type).toBe("error");
  });

  it("DEFAULT_MAX_RETRIES is exactly 2 — no override uses the constant (fetch called DEFAULT_MAX_RETRIES+1 = 3 times)", async () => {
    // Construct the port with NO maxRetries override so it falls back to DEFAULT_MAX_RETRIES.
    // If DEFAULT_MAX_RETRIES were mutated (e.g. to 1 or 5), this assertion would catch it:
    // the fetch call count must equal DEFAULT_MAX_RETRIES + 1, not a bare literal.
    const fetchMock = always503();
    const port = createAnthropicModelPort({
      model: MODEL,
      apiKey: API_KEY,
      // maxRetries intentionally omitted — the adapter must apply DEFAULT_MAX_RETRIES (= 2).
      streamText,
      fetch: fetchMock,
    });

    const out = await collect(port.stream({ messages: [{ role: "user", content: "hi" }] }));

    // Pin the constant value first: if a mutant changes DEFAULT_MAX_RETRIES away from 2, this
    // assertion kills it before the fetch-count check even runs.
    expect(DEFAULT_MAX_RETRIES).toBe(2);
    // The SDK retries DEFAULT_MAX_RETRIES times → total attempts = DEFAULT_MAX_RETRIES + 1 = 3.
    // Using the imported constant (not a bare 3) keeps the assertion self-documenting and tied
    // to the real retry budget.
    expect(fetchMock).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES + 1);
    const terminals = out.filter((c) => c.type === "finish" || c.type === "error");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.type).toBe("error");
  });

  it("honors maxRetries: 0 — a 503 surfaces immediately (fetch called once, error chunk)", async () => {
    const fetchMock = always503();
    const port = createAnthropicModelPort({
      model: MODEL,
      apiKey: API_KEY,
      maxRetries: 0,
      streamText,
      fetch: fetchMock,
    });

    const out = await collect(port.stream({ messages: [{ role: "user", content: "hi" }] }));

    // Bound honored: no retry at all.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const terminals = out.filter((c) => c.type === "finish" || c.type === "error");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.type).toBe("error");
  });

  it("a transport retry is NOT a tool retry: the executor runs the tool EXACTLY ONCE", async () => {
    // The FIRST model turn's transport request 503s-then-200s; the 200 yields a tool-call.
    // The transport retry happens BELOW ModelPort (inside the SDK). Tool dispatch happens ABOVE
    // it, in runAgentLoop. So the retry must not multiply executor.execute calls.
    // Turn 1: [503, tool-call 200]. Turn 2 (after the tool result is fed back): a plain text stop.
    const fetchMock = scriptedFetch([
      err503(),
      sse200(anthropicToolCallSse("echo", { value: "x" })),
      sse200(anthropicTextSse("done")),
    ]);

    const executor = new LocalExecutor();
    const executeSpy = vi.spyOn(executor, "execute");

    const echo: ToolSpecT = {
      name: "echo",
      description: "echo a value",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    };
    executor.register("echo", (args) => `echoed:${String((args as { value?: unknown }).value)}`);

    const port = createAnthropicModelPort({
      model: MODEL,
      apiKey: API_KEY,
      streamText,
      fetch: fetchMock,
    });

    const events: KernelEventT[] = [];
    for await (const ev of runAgentLoop(port, executor, {
      messages: [{ role: "user", content: "use the tool" }],
      tools: [echo],
      stop: { maxTurns: 5 },
    })) {
      events.push(ev);
    }

    // The retry re-issued the HTTP request (turn 1: 503 then the tool-call 200) but the tool
    // ran ONCE — transport retry does not re-execute a tool (ADR-0028 §2). This is the proof.
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]![0]).toMatchObject({ name: "echo", args: { value: "x" } });

    // The loop saw exactly one tool-call and one tool-result, and finished cleanly.
    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(1);
    expect(events.filter((e) => e.type === "tool-result")).toHaveLength(1);
    expect(events.find((e) => e.type === "stop")).toEqual({ type: "stop", reason: "model-stop" });

    // 3 fetches total: turn-1 503 + turn-1 200 (tool-call) + turn-2 200 (final). The retry
    // added exactly one extra HTTP attempt, not an extra tool execution.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
