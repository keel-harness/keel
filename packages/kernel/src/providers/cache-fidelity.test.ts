import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { streamText as realStreamText } from "ai";
import type { ModelMessageT, ModelStreamChunkT } from "@keel/shared";
import { assembleContext } from "./context.js";
import { createAnthropicModelPort } from "./factory.js";
import type { StreamTextFn } from "./vercel-model-port.js";

/**
 * Epic 1.14 — CACHE FIDELITY, proven by CI rather than by audit. The H1/H2 audit established (by
 * reading the installed SDK) that keel's prompt-cache breakpoints reach the Anthropic wire and that the
 * request prefix is append-only — but keel's own suite proved it only at the `streamText`-options layer.
 * These two tests close that gap so a future `@ai-sdk/anthropic` bump that drops/mutates `cache_control`,
 * or a dynamic injection that shifts the prefix, fails loudly:
 *
 *  1. WIRE-LEVEL — the SERIALIZED Anthropic request body carries `cache_control` breakpoints (via the
 *     `fetch` transport seam, no network), not just keel's internal structure.
 *  2. PREFIX-STABILITY — the content prefix sent each turn is byte-for-byte append-only (only the
 *     breakpoint MARKER moves to the new last message; content never changes), and a planted
 *     pre-breakpoint mutation is caught.
 */

const streamText = realStreamText as unknown as StreamTextFn;
const MODEL = "claude-test";
const API_KEY = "sk-test";

/** A minimal but VALID Anthropic SSE 200 body for a text-only turn (mirrors the retry suite). */
function anthropicTextSse(text: string): string {
  const events = [
    {
      type: "message_start",
      message: { id: "msg_1", model: MODEL, role: "assistant", usage: { input_tokens: 7 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

async function drain(stream: AsyncIterable<ModelStreamChunkT>): Promise<void> {
  const it = stream[Symbol.asyncIterator]();
  for (let r = await it.next(); r.done !== true; r = await it.next()) {
    /* consume every chunk so streamText actually issues the request */
  }
}

/** Count the ephemeral cache breakpoints in a serialized request body. */
function ephemeralCount(bodyStr: string): number {
  return (bodyStr.match(/"cache_control":\s*\{\s*"type":\s*"ephemeral"/g) ?? []).length;
}

describe("Epic 1.14 — wire-level cache_control fidelity (the serialized Anthropic request)", () => {
  // The real streamText surfaces nothing to console here (all 200s), but keep parity with the retry suite.
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeAll(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(() => {
    consoleError.mockRestore();
  });

  /** Build a fetch that captures the outgoing request body and returns one valid SSE turn. */
  function capturingFetch(): { fetch: typeof globalThis.fetch; body: () => unknown } {
    let captured: unknown = null;
    const fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      captured = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      return new Response(anthropicTextSse("ok"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, body: () => captured };
  }

  it("places cache_control on the system block AND the last message — on the wire", async () => {
    const cap = capturingFetch();
    const port = createAnthropicModelPort({
      model: MODEL,
      apiKey: API_KEY,
      streamText,
      fetch: cap.fetch,
    });
    await drain(
      port.stream({
        messages: [
          { role: "system", content: "you are keel, a governed agent harness" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    const body = cap.body() as { system?: unknown; messages?: Array<{ content?: unknown }> };
    const bodyStr = JSON.stringify(body);
    // The 2 breakpoints keel sets (system head + last settled message) must BOTH reach the serialized body.
    expect(ephemeralCount(bodyStr)).toBe(2);
    // Anthropic carries the system prompt as a top-level `system` (array of blocks when a breakpoint is on
    // it). It must include the system text and a cache_control marker.
    expect(JSON.stringify(body.system)).toContain("governed agent harness");
    expect(JSON.stringify(body.system)).toMatch(/cache_control/);
    // The LAST message (the settled-conversation breakpoint) must carry cache_control too.
    const lastMsg = body.messages?.at(-1);
    expect(JSON.stringify(lastMsg)).toContain("hello");
    expect(JSON.stringify(lastMsg)).toMatch(/cache_control/);
  });

  it("still places exactly 2 breakpoints on a SHORT conversation (prefix, not every message)", async () => {
    const cap = capturingFetch();
    const port = createAnthropicModelPort({
      model: MODEL,
      apiKey: API_KEY,
      streamText,
      fetch: cap.fetch,
    });
    await drain(
      port.stream({
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "u0" },
          { role: "assistant", content: "a0" },
          { role: "user", content: "u1-last" },
        ],
      }),
    );
    const bodyStr = JSON.stringify(cap.body());
    // Below the 20-block lookback there is no >20-block gap to bridge, so it stays head+tail (2).
    expect(ephemeralCount(bodyStr)).toBe(2);
  });

  it("places MORE than 2 breakpoints on a heavy fan-out (rolling breakpoints reach the wire)", async () => {
    const cap = capturingFetch();
    const port = createAnthropicModelPort({
      model: MODEL,
      apiKey: API_KEY,
      streamText,
      fetch: cap.fetch,
    });
    // A long single-block suffix: one head + many appended messages. The old head+tail pair would
    // leave a >20-block gap to the previous turn's tail; rolling breakpoints bridge it — and must
    // SERIALIZE (not just exist in keel's structure), still capped at Anthropic's 4.
    const messages = [
      { role: "system" as const, content: "system prompt" },
      ...Array.from({ length: 40 }, (_, i) => ({ role: "user" as const, content: `m${i}` })),
    ];
    await drain(port.stream({ messages }));
    const n = ephemeralCount(JSON.stringify(cap.body()));
    expect(n).toBeGreaterThan(2);
    expect(n).toBeLessThanOrEqual(4); // Anthropic's hard cap
  });

  it("threads cacheTtl '1h' to the serialized cache_control on the wire (KEEL_CACHE_TTL lever)", async () => {
    const cap = capturingFetch();
    const port = createAnthropicModelPort({
      model: MODEL,
      apiKey: API_KEY,
      streamText,
      fetch: cap.fetch,
      cacheTtl: "1h",
    });
    await drain(
      port.stream({
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    const bodyStr = JSON.stringify(cap.body());
    // Every breakpoint must carry the 1h TTL on the wire (not just keel's internal structure).
    expect(ephemeralCount(bodyStr)).toBe(2);
    expect(bodyStr).toMatch(/"cache_control":\s*\{\s*"type":\s*"ephemeral",\s*"ttl":\s*"1h"\s*\}/);
    // And the default path emits NO ttl field (guard against an accidental always-on 1h).
    const capDefault = capturingFetch();
    const portDefault = createAnthropicModelPort({
      model: MODEL,
      apiKey: API_KEY,
      streamText,
      fetch: capDefault.fetch,
    });
    await drain(
      portDefault.stream({
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    expect(JSON.stringify(capDefault.body())).not.toMatch(/"ttl"/);
  });
});

describe("Epic 1.14 — prefix stability (append-only; only the breakpoint moves)", () => {
  // Compare the CONTENT prefix (role + content), ignoring the providerOptions cache MARKER — which
  // legitimately moves to the new last message each turn without changing any cached content bytes.
  const contentOf = (msgs: ReadonlyArray<{ role: string; content: unknown }>) =>
    msgs.map((m) => ({ role: m.role, content: m.content }));
  const assemble = (messages: ModelMessageT[]) =>
    assembleContext({ messages, cacheStrategy: "anthropic-breakpoint" }).messages;

  it("turn N+1's content prefix is byte-identical to turn N (the cache-hit precondition)", () => {
    const base: ModelMessageT[] = [
      { role: "system", content: "S" },
      { role: "user", content: "u0" },
    ];
    const turnN = assemble([...base]);
    const turnN1 = assemble([
      ...base,
      { role: "assistant", content: "a0" },
      { role: "user", content: "u1" },
    ]);
    expect(contentOf(turnN1).slice(0, turnN.length)).toEqual(contentOf(turnN));
  });

  it("DENIED PATH: a content change in an early (pre-breakpoint) message is caught", () => {
    const turnN = assemble([
      { role: "system", content: "S" },
      { role: "user", content: "u0" },
    ]);
    // A timestamp injected into the system prompt — the classic silent cache-buster.
    const turnN1 = assemble([
      { role: "system", content: "S @ 2026-06-18T00:00:01.000Z" },
      { role: "user", content: "u0" },
      { role: "user", content: "u1" },
    ]);
    expect(contentOf(turnN1).slice(0, turnN.length)).not.toEqual(contentOf(turnN));
  });

  it("property: any append-only growth preserves the prior content prefix", () => {
    const msg = fc.record({
      role: fc.constantFrom("user" as const, "assistant" as const),
      content: fc.string(),
    });
    fc.assert(
      fc.property(fc.array(msg, { minLength: 1, maxLength: 20 }), msg, (convo, next) => {
        const sys: ModelMessageT = { role: "system", content: "S" };
        const before = assemble([sys, ...convo]);
        const after = assemble([sys, ...convo, next]);
        const beforePrefix = contentOf(before);
        const afterPrefix = contentOf(after).slice(0, beforePrefix.length);
        return JSON.stringify(beforePrefix) === JSON.stringify(afterPrefix);
      }),
    );
  });
});
