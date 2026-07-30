import { describe, expect, it } from "vitest";
import { ModelStreamChunk, type ModelStreamChunkT } from "@keel/shared";
import { createPartMapper, isTerminal, mapFinishReason, mapPart } from "./chunks.js";
import type { SdkStreamPart } from "./chunks.js";

/** Convenience: assert the mapper returns exactly the given chunk (or undefined). */
function expectMaps(part: SdkStreamPart, expected: ModelStreamChunkT | undefined): void {
  expect(mapPart(part)).toEqual(expected);
}

describe("mapPart — text-delta", () => {
  it("passes the text through (v6 .text field)", () => {
    expectMaps({ type: "text-delta", text: "Hello " }, { type: "text-delta", text: "Hello " });
  });

  it("defaults to empty string when .text is absent (pinned ai@6.0.197: .text is required)", () => {
    // ai@6.0.197 declares .text as required; this branch is unreachable from the SDK's
    // type-checked path but is defended and tested for robustness against a future SDK shape change.
    expectMaps({ type: "text-delta" }, { type: "text-delta", text: "" });
  });
});

describe("mapFinishReason", () => {
  it("maps each known reason 1:1", () => {
    expect(mapFinishReason("stop")).toBe("stop");
    expect(mapFinishReason("tool-calls")).toBe("tool-calls");
    expect(mapFinishReason("length")).toBe("length");
    expect(mapFinishReason("error")).toBe("error");
  });

  it("maps non-clean/unknown provider reasons to error, not stop", () => {
    expect(mapFinishReason("content-filter")).toBe("error");
    expect(mapFinishReason("other")).toBe("error");
    expect(mapFinishReason("unknown")).toBe("error");
    expect(mapFinishReason("totally-made-up")).toBe("error");
  });
});

describe("mapPart — finish", () => {
  it("maps reason and extracts usage from totalUsage (v6 names)", () => {
    expectMaps(
      { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 10, outputTokens: 5 } },
      { type: "finish", reason: "stop", usage: { inputTokens: 10, outputTokens: 5 } },
    );
  });

  it("defaults missing usage fields to 0", () => {
    expectMaps(
      { type: "finish", finishReason: "stop", totalUsage: {} },
      { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } },
    );
  });

  it("carries cachedInputTokens from inputTokenDetails.cacheReadTokens (real SDK shape, PROV-2)", () => {
    expectMaps(
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: {
          inputTokens: 100,
          outputTokens: 5,
          inputTokenDetails: { cacheReadTokens: 80 },
        },
      },
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80 },
      },
    );
  });

  it("falls back to the deprecated top-level cachedInputTokens when inputTokenDetails is absent (PROV-2)", () => {
    expectMaps(
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80 },
      },
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80 },
      },
    );
  });

  it("omits cachedInputTokens when the provider does not report it (non-caching providers unaffected)", () => {
    const r = mapPart({
      type: "finish",
      finishReason: "stop",
      totalUsage: { inputTokens: 9, outputTokens: 1 },
    });
    expect(r && "usage" in r ? r.usage : undefined).not.toHaveProperty("cachedInputTokens");
  });

  it("carries the cache-WRITE subset from inputTokenDetails.cacheWriteTokens, omits it otherwise (ADR-0047, PROV-1)", () => {
    expectMaps(
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: {
          inputTokens: 100,
          outputTokens: 5,
          // The REAL ai@6 shape: cache read/write live under inputTokenDetails, NOT as a top-level
          // `cacheCreationInputTokens` (which the SDK never emits — the prior fixture invented it).
          inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 12 },
        },
      },
      {
        type: "finish",
        reason: "stop",
        usage: {
          inputTokens: 100,
          outputTokens: 5,
          cachedInputTokens: 80,
          cacheCreationInputTokens: 12,
        },
      },
    );
    const noWrite = mapPart({
      type: "finish",
      finishReason: "stop",
      totalUsage: { inputTokens: 9, outputTokens: 1 },
    });
    expect(noWrite && "usage" in noWrite ? noWrite.usage : undefined).not.toHaveProperty(
      "cacheCreationInputTokens",
    );
  });

  it("defaults a missing totalUsage object to 0/0", () => {
    expectMaps(
      { type: "finish", finishReason: "stop" },
      { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } },
    );
  });

  it("clamps negative usage to 0 and truncates fractional", () => {
    expectMaps(
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: -7, outputTokens: 3.9 },
      },
      { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 3 } },
    );
  });

  it("maps missing finishReason to a provider-terminal error (defended)", () => {
    // ai@6.0.197 requires finishReason on the finish part; this branch is unreachable
    // from the typed SDK path but is defended and tested for resilience. Missing
    // terminal classification must not become a clean model stop.
    expectMaps(
      { type: "finish" },
      {
        type: "error",
        code: "provider-terminal-finish",
        message: "provider finish reason 'unknown' is not a clean completion reason",
      },
    );
  });

  it("clamps NaN and Infinity token counts to 0 so the chunk passes ModelUsage zod schema", () => {
    expectMaps(
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: NaN, outputTokens: Infinity },
      },
      { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } },
    );
  });

  it("fails closed for content-filter and unknown terminal reasons with bounded detail", () => {
    expect(mapPart({ type: "finish", finishReason: "content-filter", totalUsage: {} })).toEqual({
      type: "error",
      code: "provider-terminal-finish",
      message: "provider finish reason 'content-filter' is not a clean completion reason",
    });
    expect(mapPart({ type: "finish", finishReason: "unknown", totalUsage: {} })).toEqual({
      type: "error",
      code: "provider-terminal-finish",
      message: "provider finish reason 'unknown' is not a clean completion reason",
    });
  });

  it("bounds, normalizes, and redacts unmapped provider finish reasons", () => {
    const secret = `sk-ant-${"a".repeat(24)}`;
    const longReason = `future-provider-reason\n${secret}\n${"x".repeat(300)}`;
    const out = mapPart({ type: "finish", finishReason: longReason, totalUsage: {} });

    expect(out?.type).toBe("error");
    if (out?.type === "error") {
      expect(out.message).toContain("future-provider-reason");
      expect(out.message).toContain("[redacted:anthropic-key]");
      expect(out.message).not.toContain(secret);
      expect(out.message).not.toContain("\n");
      expect(out.message.length).toBeLessThan(180);
    }
  });
});

describe("mapPart — error", () => {
  it("maps an Error to an error chunk, code from name", () => {
    const part: SdkStreamPart = { type: "error", error: new TypeError("kaboom") };
    expect(mapPart(part)).toEqual({ type: "error", code: "TypeError", message: "kaboom" });
  });

  it("derives code from a numeric status when present", () => {
    const err = Object.assign(new Error("rate limited"), { statusCode: 429 });
    expect(mapPart({ type: "error", error: err })).toEqual({
      type: "error",
      code: "429",
      message: "rate limited",
    });
  });

  it("falls back to stream-error code and stringifies a non-Error message", () => {
    expect(mapPart({ type: "error", error: "plain string failure" })).toEqual({
      type: "error",
      code: "stream-error",
      message: "plain string failure",
    });
  });

  it("never emits a non-string message", () => {
    const out = mapPart({ type: "error", error: { weird: true } });
    expect(out?.type).toBe("error");
    if (out?.type === "error") expect(typeof out.message).toBe("string");
  });

  it("falls back to stream-error code when an Error has an empty name and no status", () => {
    const err = Object.assign(new Error("nameless"), { name: "" });
    expect(mapPart({ type: "error", error: err })).toEqual({
      type: "error",
      code: "stream-error",
      message: "nameless",
    });
  });

  it("derives code from .status (not only .statusCode) — kills the .status mutant", () => {
    // Real fetch/Response errors carry .status, not .statusCode; both arms must be live.
    const err = Object.assign(new Error("not found"), { status: 404 });
    expect(mapPart({ type: "error", error: err })).toEqual({
      type: "error",
      code: "404",
      message: "not found",
    });
  });

  it("returns a string code+message (does not throw) when error.toString throws", () => {
    // A hostile object whose toString/Symbol.toPrimitive throws must not escape stream().
    const hostile = {
      toString() {
        throw new Error("toString blew up");
      },
      [Symbol.toPrimitive]() {
        throw new Error("toPrimitive blew up");
      },
    };
    const out = mapPart({ type: "error", error: hostile });
    expect(out?.type).toBe("error");
    if (out?.type === "error") {
      expect(typeof out.code).toBe("string");
      expect(out.code.length).toBeGreaterThan(0);
      expect(typeof out.message).toBe("string");
    }
  });

  it("returns a string code+message (does not throw) for an Error whose message/name getters throw", () => {
    // The never-throw invariant is TOTAL: even an `instanceof Error` whose `message`/`name`
    // getter throws (a hostile or corrupted Error) must not escape errorFields/stream(). The
    // Error-instance field extraction is itself guarded, falling back to a constant code+message.
    const hostile = new Error("placeholder");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("message getter blew up");
      },
    });
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error("name getter blew up");
      },
    });
    const out = mapPart({ type: "error", error: hostile });
    expect(out?.type).toBe("error");
    if (out?.type === "error") {
      expect(typeof out.code).toBe("string");
      expect(out.code.length).toBeGreaterThan(0);
      expect(typeof out.message).toBe("string");
    }
  });
});

describe("mapPart — abort", () => {
  it("maps abort to a terminal finish(aborted) with zero usage", () => {
    expectMaps(
      { type: "abort" },
      { type: "finish", reason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } },
    );
  });
});

describe("mapPart — ignored lifecycle and not-yet-handled parts", () => {
  it("ignores text-start/text-end/start/start-step/finish-step/raw", () => {
    for (const type of ["text-start", "text-end", "start", "start-step", "finish-step", "raw"]) {
      expectMaps({ type }, undefined);
    }
  });

  it("ignores the streaming tool-input-* parts (handled by the stateful mapper) and tool-result", () => {
    // The streaming tool-arg parts (tool-input-start/-delta/-end) carry per-stream buffer
    // state and are handled by createPartMapper, NOT the pure mapPart — so mapPart ignores
    // them. The atomic `tool-call` IS handled by mapPart (it is stateless) and is covered in
    // its own describe block below. tool-result is not surfaced to the kernel. (reasoning-delta
    // IS now mapped by mapPart — see its own describe block below.)
    for (const type of ["tool-input-start", "tool-input-delta", "tool-input-end", "tool-result"]) {
      expectMaps({ type }, undefined);
    }
  });
});

describe("mapPart — reasoning-delta (slice 4 passthrough)", () => {
  it("maps the v6 fullStream reasoning-delta (.text field) to a keel reasoning-delta chunk", () => {
    // The CONSUMED union (TextStreamPart, ai@6.0.197) carries reasoning text on `.text` — the
    // same field as text-delta. Verified against node_modules; design §6's `delta` is the
    // lower-level provider union the adapter never consumes.
    expectMaps(
      { type: "reasoning-delta", text: "let me think" },
      { type: "reasoning-delta", text: "let me think" },
    );
  });

  it("falls back to .delta when .text is absent (defensive against the lower-level shape)", () => {
    // Unreachable from the type-checked fullStream path (it uses .text), defended so a future
    // SDK shape that leaks the provider-level `.delta` field still maps rather than emitting "".
    expectMaps(
      { type: "reasoning-delta", delta: "deep thought" },
      { type: "reasoning-delta", text: "deep thought" },
    );
  });

  it("defaults to empty string when neither .text nor .delta is present", () => {
    expectMaps({ type: "reasoning-delta" }, { type: "reasoning-delta", text: "" });
  });

  it("the mapped chunk conforms to the frozen ModelStreamChunk schema (parse round-trip)", () => {
    const chunk = mapPart({ type: "reasoning-delta", text: "hmm" });
    expect(chunk).toBeDefined();
    expect(ModelStreamChunk.parse(chunk)).toEqual({ type: "reasoning-delta", text: "hmm" });
  });

  it("is NON-terminal (does not count toward the terminal-chunk invariant)", () => {
    const chunk = mapPart({ type: "reasoning-delta", text: "x" });
    expect(chunk).toBeDefined();
    expect(isTerminal(chunk!)).toBe(false);
  });
});

describe("mapPart — atomic tool-call (real SDK fields: toolCallId, toolName, input)", () => {
  it("maps an object input straight through to a tool-call chunk", () => {
    expectMaps(
      { type: "tool-call", toolCallId: "call_1", toolName: "read", input: { path: "a.ts" } },
      { type: "tool-call", id: "call_1", name: "read", args: { path: "a.ts" } },
    );
  });

  it("JSON-parses a string input into the args object (providers may serialize args as a string)", () => {
    expectMaps(
      { type: "tool-call", toolCallId: "c2", toolName: "bash", input: '{"command":"ls -la"}' },
      { type: "tool-call", id: "c2", name: "bash", args: { command: "ls -la" } },
    );
  });

  it("maps an empty-object input (no-arg tool call) to empty args", () => {
    expectMaps(
      { type: "tool-call", toolCallId: "c3", toolName: "noarg", input: {} },
      { type: "tool-call", id: "c3", name: "noarg", args: {} },
    );
  });

  it("maps a provider-safe tool name back to the keel tool name", () => {
    expect(
      mapPart(
        {
          type: "tool-call",
          toolCallId: "c4",
          toolName: "interactive_console_open",
          input: {},
        },
        (name) => (name === "interactive_console_open" ? "interactive_console.open" : name),
      ),
    ).toEqual({ type: "tool-call", id: "c4", name: "interactive_console.open", args: {} });
  });

  it("emits an error chunk (not a malformed tool-call) when a string input is not valid JSON", () => {
    const out = mapPart({
      type: "tool-call",
      toolCallId: "c4",
      toolName: "read",
      input: "{not json",
    });
    expect(out).toEqual({
      type: "error",
      code: "tool-call-args",
      message: "provider tool call 'read' (id c4) had args that are not a JSON object",
    });
  });

  it("emits an error chunk when input is a JSON array (not an object)", () => {
    const out = mapPart({ type: "tool-call", toolCallId: "c5", toolName: "x", input: [1, 2, 3] });
    expect(out).toEqual({
      type: "error",
      code: "tool-call-args",
      message: "provider tool call 'x' (id c5) had args that are not a JSON object",
    });
  });

  it("emits an error chunk when input is null / a number / a non-object primitive", () => {
    for (const input of [null, 42, true, "plain"]) {
      const out = mapPart({ type: "tool-call", toolCallId: "c6", toolName: "t", input });
      expect(out?.type).toBe("error");
      if (out?.type === "error") {
        expect(out.code).toBe("tool-call-args");
        expect(out.message).toContain("'t'");
        expect(out.message).toContain("id c6");
      }
    }
  });

  it("emits an error chunk when toolCallId is missing/empty (defended; SDK guarantees it present)", () => {
    // Unreachable from the typed SDK path (toolCallId is a required string), but defended so an
    // unfaithful call becomes an honest error chunk, never a tool-call failing the frozen min(1).
    const out = mapPart({ type: "tool-call", toolName: "read", input: { path: "a" } });
    expect(out).toEqual({
      type: "error",
      code: "tool-call-args",
      message: "provider tool call 'read' (id ) had args that are not a JSON object",
    });
  });

  it("emits an error chunk when toolName is missing/empty (defended)", () => {
    const out = mapPart({ type: "tool-call", toolCallId: "c", input: { path: "a" } });
    expect(out).toEqual({
      type: "error",
      code: "tool-call-args",
      message: "provider tool call '' (id c) had args that are not a JSON object",
    });
  });

  it("emits an error chunk when input contains a non-JSON-safe value (NaN) so it can't pass JsonObject", () => {
    // The frozen ModelStreamChunk validates args as JsonObject (finite numbers only). A NaN in
    // the args must be caught here, as an honest error chunk, not a tool-call that the frozen
    // schema would later reject.
    const out = mapPart({
      type: "tool-call",
      toolCallId: "c7",
      toolName: "t",
      input: { n: NaN },
    });
    expect(out).toEqual({
      type: "error",
      code: "tool-call-args",
      message: "provider tool call 't' (id c7) had args that are not a JSON object",
    });
  });
});

describe("createPartMapper — streaming tool-call deltas (real SDK fields: id, toolName, delta)", () => {
  it("buffers tool-input-start, puts name on the FIRST delta only, clears on tool-input-end", () => {
    const map = createPartMapper();
    // tool-input-start buffers id->name and emits nothing.
    expect(map({ type: "tool-input-start", id: "t1", toolName: "search" })).toBeUndefined();
    // First delta carries the buffered name.
    expect(map({ type: "tool-input-delta", id: "t1", delta: '{"pat' })).toEqual({
      type: "tool-call-delta",
      id: "t1",
      name: "search",
      argsTextDelta: '{"pat',
    });
    // Subsequent deltas for the same id omit the name (providers send it once).
    expect(map({ type: "tool-input-delta", id: "t1", delta: 'tern":"x"}' })).toEqual({
      type: "tool-call-delta",
      id: "t1",
      argsTextDelta: 'tern":"x"}',
    });
    // tool-input-end clears the buffer and emits nothing.
    expect(map({ type: "tool-input-end", id: "t1" })).toBeUndefined();
  });

  it("maps a provider-safe streamed tool name back before emitting the first delta", () => {
    const map = createPartMapper((name) =>
      name === "interactive_console_send_keys" ? "interactive_console.send_keys" : name,
    );
    expect(
      map({ type: "tool-input-start", id: "t1", toolName: "interactive_console_send_keys" }),
    ).toBeUndefined();
    expect(map({ type: "tool-input-delta", id: "t1", delta: '{"keys":' })).toEqual({
      type: "tool-call-delta",
      id: "t1",
      name: "interactive_console.send_keys",
      argsTextDelta: '{"keys":',
    });
  });

  it("tracks two interleaved tool calls independently, each getting its name on its own first delta", () => {
    const map = createPartMapper();
    map({ type: "tool-input-start", id: "a", toolName: "read" });
    map({ type: "tool-input-start", id: "b", toolName: "bash" });
    expect(map({ type: "tool-input-delta", id: "a", delta: "{" })).toEqual({
      type: "tool-call-delta",
      id: "a",
      name: "read",
      argsTextDelta: "{",
    });
    expect(map({ type: "tool-input-delta", id: "b", delta: "{" })).toEqual({
      type: "tool-call-delta",
      id: "b",
      name: "bash",
      argsTextDelta: "{",
    });
    // Second delta on each omits the name.
    expect(map({ type: "tool-input-delta", id: "a", delta: "}" })).toEqual({
      type: "tool-call-delta",
      id: "a",
      argsTextDelta: "}",
    });
    expect(map({ type: "tool-input-delta", id: "b", delta: "}" })).toEqual({
      type: "tool-call-delta",
      id: "b",
      argsTextDelta: "}",
    });
  });

  it("ignores a tool-input-delta with no id (defended; SDK guarantees id present)", () => {
    // A delta with no id can't be a valid tool-call-delta (frozen id is min(1)); the mapper
    // ignores it rather than emit an invalid chunk. Unreachable from the typed SDK path.
    const map = createPartMapper();
    expect(map({ type: "tool-input-delta", delta: "x" })).toBeUndefined();
  });

  it("emits a delta with no name when a delta arrives for an id that was never started (defensive)", () => {
    // If the SDK ever emits a delta without a preceding start (shape drift), we must still emit
    // a valid tool-call-delta — name omitted (none buffered) — never throw, never invent a name.
    const map = createPartMapper();
    expect(map({ type: "tool-input-delta", id: "orphan", delta: "x" })).toEqual({
      type: "tool-call-delta",
      id: "orphan",
      argsTextDelta: "x",
    });
  });

  it("defaults a missing delta string to empty (defended against a future shape change)", () => {
    const map = createPartMapper();
    map({ type: "tool-input-start", id: "z", toolName: "t" });
    expect(map({ type: "tool-input-delta", id: "z" })).toEqual({
      type: "tool-call-delta",
      id: "z",
      name: "t",
      argsTextDelta: "",
    });
  });

  it("re-buffers a name after tool-input-end so a re-issued id gets its name again", () => {
    const map = createPartMapper();
    map({ type: "tool-input-start", id: "r", toolName: "edit" });
    map({ type: "tool-input-delta", id: "r", delta: "1" }); // consumes the name
    map({ type: "tool-input-end", id: "r" }); // clears
    map({ type: "tool-input-start", id: "r", toolName: "write" }); // re-buffer
    expect(map({ type: "tool-input-delta", id: "r", delta: "2" })).toEqual({
      type: "tool-call-delta",
      id: "r",
      name: "write",
      argsTextDelta: "2",
    });
  });

  it("delegates non-tool parts to the pure mapPart (text-delta/finish/error/abort unchanged)", () => {
    const map = createPartMapper();
    expect(map({ type: "text-delta", text: "hi" })).toEqual({ type: "text-delta", text: "hi" });
    expect(map({ type: "abort" })).toEqual({
      type: "finish",
      reason: "aborted",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    // The atomic tool-call also flows through the stateful mapper (delegated to mapPart).
    expect(
      map({ type: "tool-call", toolCallId: "c", toolName: "read", input: { path: "p" } }),
    ).toEqual({ type: "tool-call", id: "c", name: "read", args: { path: "p" } });
  });
});

describe("ModelStreamChunk.parse — zod conformance (mirrors script-model.test.ts)", () => {
  it("a text-delta chunk from mapPart parses cleanly", () => {
    const chunk = mapPart({ type: "text-delta", text: "hello" });
    expect(() => ModelStreamChunk.parse(chunk)).not.toThrow();
    expect(ModelStreamChunk.parse(chunk)).toEqual({ type: "text-delta", text: "hello" });
  });

  it("an error chunk from mapPart parses cleanly", () => {
    const chunk = mapPart({ type: "error", error: new Error("boom") });
    expect(() => ModelStreamChunk.parse(chunk)).not.toThrow();
  });

  it("a finish chunk with NaN/Infinity tokens maps to 0 and parses through ModelStreamChunk", () => {
    // This is the critical regression guard for fix #1: NaN/Infinity usage must be clamped to 0
    // BEFORE the chunk leaves the mapper, so ModelUsage's int().nonnegative() never sees a bad value.
    const chunk = mapPart({
      type: "finish",
      finishReason: "stop",
      totalUsage: { inputTokens: NaN, outputTokens: Infinity },
    });
    expect(() => ModelStreamChunk.parse(chunk)).not.toThrow();
    const parsed = ModelStreamChunk.parse(chunk);
    if (parsed.type === "finish") {
      expect(parsed.usage.inputTokens).toBe(0);
      expect(parsed.usage.outputTokens).toBe(0);
    }
  });

  it("a finish(aborted) chunk from the abort part parses cleanly", () => {
    const chunk = mapPart({ type: "abort" });
    expect(() => ModelStreamChunk.parse(chunk)).not.toThrow();
  });

  it("an atomic tool-call chunk from mapPart parses cleanly (args is a JsonObject)", () => {
    const chunk = mapPart({
      type: "tool-call",
      toolCallId: "c1",
      toolName: "read",
      input: { path: "a.ts", limit: 10 },
    });
    expect(() => ModelStreamChunk.parse(chunk)).not.toThrow();
    expect(ModelStreamChunk.parse(chunk)).toEqual({
      type: "tool-call",
      id: "c1",
      name: "read",
      args: { path: "a.ts", limit: 10 },
    });
  });

  it("the error chunk emitted for a malformed tool-call input parses cleanly", () => {
    const chunk = mapPart({ type: "tool-call", toolCallId: "c", toolName: "t", input: [1] });
    expect(() => ModelStreamChunk.parse(chunk)).not.toThrow();
  });

  it("a first tool-call-delta (with name) from createPartMapper parses cleanly", () => {
    const map = createPartMapper();
    map({ type: "tool-input-start", id: "t1", toolName: "search" });
    const chunk = map({ type: "tool-input-delta", id: "t1", delta: '{"x":1}' });
    expect(() => ModelStreamChunk.parse(chunk)).not.toThrow();
    expect(ModelStreamChunk.parse(chunk)).toEqual({
      type: "tool-call-delta",
      id: "t1",
      name: "search",
      argsTextDelta: '{"x":1}',
    });
  });

  it("a subsequent tool-call-delta (no name) from createPartMapper parses cleanly", () => {
    const map = createPartMapper();
    map({ type: "tool-input-start", id: "t1", toolName: "search" });
    map({ type: "tool-input-delta", id: "t1", delta: "a" });
    const chunk = map({ type: "tool-input-delta", id: "t1", delta: "b" });
    expect(() => ModelStreamChunk.parse(chunk)).not.toThrow();
    expect(ModelStreamChunk.parse(chunk)).toEqual({
      type: "tool-call-delta",
      id: "t1",
      argsTextDelta: "b",
    });
  });
});
