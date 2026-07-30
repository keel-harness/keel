import { describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import { ModelStreamChunk } from "@keel/shared";
import type { ModelStreamChunkT, ModelTurnInput, ToolSpecT } from "@keel/shared";
import { VercelModelPort } from "./vercel-model-port.js";
import type {
  SdkStreamPart,
  StreamResultLike,
  StreamTextFn,
  StreamTextOptions,
  VercelModelPortDeps,
} from "./vercel-model-port.js";
import { CAPABILITIES, type ProviderCapability } from "./capabilities.js";

/**
 * Construct a port with a fixed literal model via a fake `buildModel` returning it (the slice-4
 * constructor takes a config + a `buildModel` resolver; these slice-1–3 streaming/abort/tool
 * tests do not exercise per-turn model override, so a fixed resolver is the faithful adaptation —
 * no assertion is weakened, the model still reaches `streamText` unchanged).
 */
function makePort(model: LanguageModel, deps: VercelModelPortDeps): VercelModelPort {
  return new VercelModelPort(
    { defaultModelId: "default", buildModel: () => model, capability: CAPABILITIES.anthropic },
    deps,
  );
}

/** A fake `streamText` that yields the given parts from `fullStream`. */
function fakeStreamText(parts: SdkStreamPart[]): StreamTextFn {
  return () => ({
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
  });
}

/** A fake `streamText` whose `fullStream` throws partway through. */
function throwingStreamText(err: unknown, before: SdkStreamPart[] = []): StreamTextFn {
  return () => ({
    fullStream: (async function* () {
      for (const p of before) yield p;
      throw err;
    })(),
  });
}

/** Drain a port's stream into an array of keel chunks. */
async function collect(port: VercelModelPort, input: ModelTurnInput): Promise<ModelStreamChunkT[]> {
  const out: ModelStreamChunkT[] = [];
  for await (const c of port.stream(input)) out.push(c);
  return out;
}

const userInput: ModelTurnInput = { messages: [{ role: "user", content: "hi" }] };

describe("VercelModelPort.stream — happy path", () => {
  it("maps text-delta + finish into keel chunks via the injected streamText", async () => {
    const port = makePort("model", {
      streamText: fakeStreamText([
        { type: "text-delta", text: "Hello " },
        { type: "text-delta", text: "world" },
        { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 3, outputTokens: 2 } },
      ]),
    });
    expect(await collect(port, userInput)).toEqual([
      { type: "text-delta", text: "Hello " },
      { type: "text-delta", text: "world" },
      { type: "finish", reason: "stop", usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
  });

  it("passes the abort signal through to streamText and maps the SDK messages", async () => {
    const spy = vi.fn<StreamTextFn>(() => ({
      fullStream: (async function* () {
        yield { type: "finish", finishReason: "stop", totalUsage: {} };
      })(),
    }));
    const controller = new AbortController();
    const port = makePort("model", { streamText: spy });
    await collect(port, {
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok" },
      ],
      signal: controller.signal,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0]![0];
    expect(opts.abortSignal).toBe(controller.signal);
    // The anthropic capability marks the leading system message AND the last (settled) message with
    // the cache breakpoint (cacheControl ephemeral) — caching the growing conversation prefix; the
    // middle messages map straight through. (allowSystemInMessages is asserted in the caching test.)
    const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } };
    expect(opts.messages).toEqual([
      { role: "system", content: "be brief", providerOptions: EPHEMERAL },
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok", providerOptions: EPHEMERAL },
    ]);
    expect(opts.allowSystemInMessages).toBe(true);
  });
});

describe("VercelModelPort.stream — entry abort", () => {
  it("yields finish(aborted) and does NOT call streamText when already aborted", async () => {
    const spy = vi.fn<StreamTextFn>(fakeStreamText([]));
    const port = makePort("model", { streamText: spy });
    const controller = new AbortController();
    controller.abort();
    const out = await collect(port, { ...userInput, signal: controller.signal });
    expect(out).toEqual([
      { type: "finish", reason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("VercelModelPort.stream — terminal invariant", () => {
  it("emits nothing after the first terminal (finish), stopping iteration", async () => {
    const port = makePort("model", {
      streamText: fakeStreamText([
        { type: "text-delta", text: "a" },
        { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1 } },
        // Anything after the terminal must be ignored.
        { type: "text-delta", text: "ZZZ" },
        { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 9, outputTokens: 9 } },
      ]),
    });
    const out = await collect(port, userInput);
    expect(out).toEqual([
      { type: "text-delta", text: "a" },
      { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
  });

  it("treats an SDK error part as the terminal and stops", async () => {
    const port = makePort("model", {
      streamText: fakeStreamText([
        { type: "error", error: new Error("boom") },
        { type: "text-delta", text: "ignored" },
      ]),
    });
    const out = await collect(port, userInput);
    expect(out).toEqual([{ type: "error", code: "Error", message: "boom" }]);
  });

  it("maps an SDK abort part to a terminal finish(aborted)", async () => {
    const port = makePort("model", {
      streamText: fakeStreamText([{ type: "abort" }, { type: "text-delta", text: "ignored" }]),
    });
    const out = await collect(port, userInput);
    expect(out).toEqual([
      { type: "finish", reason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  it("fails closed for content-filter finish reasons instead of yielding clean stop", async () => {
    const port = makePort("model", {
      streamText: fakeStreamText([
        { type: "finish", finishReason: "content-filter", totalUsage: {} },
      ]),
    });
    expect(await collect(port, userInput)).toEqual([
      {
        type: "error",
        code: "provider-terminal-finish",
        message: "provider finish reason 'content-filter' is not a clean completion reason",
      },
    ]);
  });

  it("fails closed for unknown finish reasons instead of yielding clean stop", async () => {
    const port = makePort("model", {
      streamText: fakeStreamText([{ type: "finish", finishReason: "unknown", totalUsage: {} }]),
    });
    expect(await collect(port, userInput)).toEqual([
      {
        type: "error",
        code: "provider-terminal-finish",
        message: "provider finish reason 'unknown' is not a clean completion reason",
      },
    ]);
  });
});

describe("VercelModelPort.stream — never throw", () => {
  it("yields an error chunk (does not throw) when fullStream throws", async () => {
    const port = makePort("model", {
      streamText: throwingStreamText(new Error("transport exploded"), [
        { type: "text-delta", text: "partial" },
      ]),
    });
    const out = await collect(port, userInput);
    expect(out).toEqual([
      { type: "text-delta", text: "partial" },
      { type: "error", code: "Error", message: "transport exploded" },
    ]);
  });

  it("maps an AbortError thrown mid-stream to finish(aborted)", async () => {
    const abortErr = Object.assign(new Error("the operation was aborted"), { name: "AbortError" });
    const port = makePort("model", {
      streamText: throwingStreamText(abortErr),
    });
    const out = await collect(port, userInput);
    expect(out).toEqual([
      { type: "finish", reason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  it("maps a throw to finish(aborted) when the signal is aborted, even if not an AbortError", async () => {
    const controller = new AbortController();
    // A hand-built async iterable whose first pull aborts the signal then throws a generic
    // (non-AbortError) error — exercising the "throw while signal is aborted" recovery path.
    const fullStream: AsyncIterable<SdkStreamPart> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SdkStreamPart>> {
            controller.abort();
            return Promise.reject(new Error("generic failure during cancellation"));
          },
        };
      },
    };
    const st: StreamTextFn = () => ({ fullStream });
    const port = makePort("model", { streamText: st });
    const out = await collect(port, { ...userInput, signal: controller.signal });
    expect(out).toEqual([
      { type: "finish", reason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  it("does not emit a second terminal if the throw happens after a terminal was emitted", async () => {
    // fullStream yields a finish, then throws on the *next* pull. The terminal is already out;
    // the adapter must have stopped iterating, so the throw is never reached — single terminal.
    const st: StreamTextFn = () => ({
      fullStream: (async function* () {
        yield { type: "finish", finishReason: "stop", totalUsage: {} };
        throw new Error("should never be pulled");
      })(),
    });
    const port = makePort("model", { streamText: st });
    const out = await collect(port, userInput);
    expect(out).toEqual([
      { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });
});

describe("VercelModelPort.stream — never throw covers the setup phase (total invariant)", () => {
  it("yields one terminal error chunk (does not throw) when buildModel throws before streaming", async () => {
    // The class doc-block claims the WHOLE iteration is wrapped — including the setup phase
    // (buildModel/mapParams/assembleContext/toSdkTools), which runs before any chunk. A throw
    // there must surface as exactly one terminal error chunk, never escape stream().
    const port = new VercelModelPort(
      {
        defaultModelId: "default",
        buildModel: () => {
          throw new Error("model resolution blew up");
        },
        capability: CAPABILITIES.anthropic,
      },
      // streamText is never reached (buildModel throws first); a stub that would otherwise succeed.
      { streamText: fakeStreamText([{ type: "finish", finishReason: "stop", totalUsage: {} }]) },
    );
    const out = await collect(port, userInput);
    expect(out).toEqual([{ type: "error", code: "Error", message: "model resolution blew up" }]);
  });

  it("yields finish(aborted) (not error) when the signal is aborted and a setup-phase throw occurs", async () => {
    // If the signal fired before/during setup, an abort-shaped recovery is the honest terminal.
    const controller = new AbortController();
    const port = new VercelModelPort(
      {
        defaultModelId: "default",
        buildModel: () => {
          controller.abort();
          throw new Error("setup failure during cancellation");
        },
        capability: CAPABILITIES.anthropic,
      },
      { streamText: fakeStreamText([{ type: "finish", finishReason: "stop", totalUsage: {} }]) },
    );
    const out = await collect(port, { ...userInput, signal: controller.signal });
    expect(out).toEqual([
      { type: "finish", reason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });
});

describe("VercelModelPort.stream — no-terminal defensive guard", () => {
  it("emits a defensive error chunk when fullStream ends with no terminal", async () => {
    const port = makePort("model", {
      streamText: fakeStreamText([
        { type: "text-delta", text: "hi" },
        { type: "text-start", id: "x" },
      ]),
    });
    const out = await collect(port, userInput);
    expect(out).toEqual([
      { type: "text-delta", text: "hi" },
      {
        type: "error",
        code: "no-terminal",
        message: "provider stream ended without a terminal chunk",
      },
    ]);
  });
});

describe("VercelModelPort.stream — mid-stream signal check (frozen-contract conformance)", () => {
  it("stops iteration and emits finish(aborted) when signal fires mid-stream without a throw", async () => {
    // The frozen ModelPort contract (model-port.ts lines ~19-41) requires stream() to observe
    // input.signal and emit finish(aborted) when it fires — even when the transport keeps
    // yielding without throwing. ScriptedModel checks signal?.aborted between every yield;
    // VercelModelPort must do the same.
    const controller = new AbortController();
    const fullStream: AsyncIterable<SdkStreamPart> = {
      [Symbol.asyncIterator]() {
        let step = 0;
        return {
          async next(): Promise<IteratorResult<SdkStreamPart>> {
            step += 1;
            if (step === 1) {
              // First yield: a normal text-delta before abort.
              return { done: false, value: { type: "text-delta", text: "before" } };
            }
            if (step === 2) {
              // Between yields: abort the signal (simulates the signal firing mid-stream).
              controller.abort();
              // Transport still yields another chunk (no throw, no SDK abort part).
              return { done: false, value: { type: "text-delta", text: "SHOULD-NOT-APPEAR" } };
            }
            // Transport keeps going.
            return { done: false, value: { type: "text-delta", text: "ALSO-NOT-APPEAR" } };
          },
        };
      },
    };
    const st: StreamTextFn = () => ({ fullStream });
    const port = makePort("model", { streamText: st });
    const out = await collect(port, { ...userInput, signal: controller.signal });

    // The first text-delta is emitted (signal not yet aborted).
    expect(out[0]).toEqual({ type: "text-delta", text: "before" });
    // The terminal must be finish(aborted).
    const last = out[out.length - 1];
    expect(last).toEqual({
      type: "finish",
      reason: "aborted",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    // Post-abort text-deltas must NOT appear.
    expect(out.some((c) => c.type === "text-delta" && c.text.includes("SHOULD-NOT-APPEAR"))).toBe(
      false,
    );
    expect(out.some((c) => c.type === "text-delta" && c.text.includes("ALSO-NOT-APPEAR"))).toBe(
      false,
    );
  });
});

const readSpec: ToolSpecT = {
  name: "read",
  description: "Read a file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};

describe("VercelModelPort.stream — native tool calling (tools passed to streamText)", () => {
  it("maps input.tools and passes a non-empty SDK tools object to streamText, keyed by name", async () => {
    let captured: StreamTextOptions | undefined;
    const spy: StreamTextFn = (opts) => {
      captured = opts;
      return {
        fullStream: (async function* () {
          yield { type: "finish", finishReason: "tool-calls", totalUsage: {} };
        })(),
      };
    };
    const port = makePort("model", { streamText: spy });
    await collect(port, { messages: [{ role: "user", content: "read it" }], tools: [readSpec] });

    expect(captured?.tools).toBeDefined();
    const tools = captured?.tools ?? {};
    // The native-tool invariant, observed structurally: tools flow through the SDK `tools`
    // param (not text-parsed), keyed by the keel tool name, carrying the spec's JSON Schema.
    expect(Object.keys(tools)).toEqual(["read"]);
    expect(tools["read"]?.description).toBe("Read a file.");
    expect((tools["read"]?.inputSchema as { jsonSchema: unknown }).jsonSchema).toEqual(
      readSpec.parameters,
    );
    // No execute → the SDK surfaces the call instead of running it (the loop dispatches it).
    expect("execute" in (tools["read"] ?? {})).toBe(false);
  });

  it("uses provider-safe tool names on the SDK boundary and maps calls back to keel names", async () => {
    let sdkToolName = "";
    const consoleSpec: ToolSpecT = {
      name: "interactive_console.open",
      description: "Open a console.",
      parameters: {
        type: "object",
        properties: { targetId: { type: "string" } },
        required: ["targetId"],
        additionalProperties: false,
      },
    };
    const spy: StreamTextFn = (opts) => {
      sdkToolName = Object.keys(opts.tools ?? {})[0] ?? "";
      return {
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId: "c1",
            toolName: sdkToolName,
            input: { targetId: "qemu-startup" },
          };
          yield { type: "finish", finishReason: "tool-calls", totalUsage: {} };
        })(),
      };
    };
    const port = makePort("model", { streamText: spy });

    expect(await collect(port, { ...userInput, tools: [consoleSpec] })).toEqual([
      {
        type: "tool-call",
        id: "c1",
        name: "interactive_console.open",
        args: { targetId: "qemu-startup" },
      },
      { type: "finish", reason: "tool-calls", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    expect(sdkToolName).not.toBe("interactive_console.open");
    expect(sdkToolName).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
  });

  it("does NOT pass a tools option when input.tools is absent", async () => {
    let captured: StreamTextOptions | undefined;
    const spy: StreamTextFn = (opts) => {
      captured = opts;
      return {
        fullStream: (async function* () {
          yield { type: "finish", finishReason: "stop", totalUsage: {} };
        })(),
      };
    };
    const port = makePort("model", { streamText: spy });
    await collect(port, userInput);
    expect("tools" in (captured ?? {})).toBe(false);
  });

  it("does NOT pass a tools option for an empty tools array (advertise nothing, not an empty set)", async () => {
    let captured: StreamTextOptions | undefined;
    const spy: StreamTextFn = (opts) => {
      captured = opts;
      return {
        fullStream: (async function* () {
          yield { type: "finish", finishReason: "stop", totalUsage: {} };
        })(),
      };
    };
    const port = makePort("model", { streamText: spy });
    await collect(port, { ...userInput, tools: [] });
    expect("tools" in (captured ?? {})).toBe(false);
  });

  it("maps an atomic tool-call part into a keel tool-call chunk, then the terminal finish", async () => {
    const port = makePort("model", {
      streamText: fakeStreamText([
        { type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "a.ts" } },
        {
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 4, outputTokens: 6 },
        },
      ]),
    });
    expect(await collect(port, { ...userInput, tools: [readSpec] })).toEqual([
      { type: "tool-call", id: "c1", name: "read", args: { path: "a.ts" } },
      { type: "finish", reason: "tool-calls", usage: { inputTokens: 4, outputTokens: 6 } },
    ]);
  });

  it("assembles a streamed tool call: name on the first delta only, end clears, terminal last", async () => {
    const port = makePort("model", {
      streamText: fakeStreamText([
        { type: "tool-input-start", id: "t1", toolName: "search" },
        { type: "tool-input-delta", id: "t1", delta: '{"pattern":' },
        { type: "tool-input-delta", id: "t1", delta: '"keel"}' },
        { type: "tool-input-end", id: "t1" },
        { type: "finish", finishReason: "tool-calls", totalUsage: {} },
      ]),
    });
    expect(await collect(port, { ...userInput, tools: [readSpec] })).toEqual([
      { type: "tool-call-delta", id: "t1", name: "search", argsTextDelta: '{"pattern":' },
      { type: "tool-call-delta", id: "t1", argsTextDelta: '"keel"}' },
      { type: "finish", reason: "tool-calls", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  it("the per-stream id→name buffer is fresh per stream() call (no leak across turns)", async () => {
    // Two streams reuse the same id. If the buffer leaked, the second stream's first delta would
    // be missing its name (consumed by the first). A fresh buffer per call gives each its name.
    const parts: SdkStreamPart[] = [
      { type: "tool-input-start", id: "x", toolName: "edit" },
      { type: "tool-input-delta", id: "x", delta: "{" },
      { type: "finish", finishReason: "tool-calls", totalUsage: {} },
    ];
    const port = makePort("model", { streamText: fakeStreamText(parts) });
    const first = await collect(port, { ...userInput, tools: [readSpec] });
    const second = await collect(port, { ...userInput, tools: [readSpec] });
    const firstDelta = (out: ModelStreamChunkT[]): ModelStreamChunkT | undefined =>
      out.find((c) => c.type === "tool-call-delta");
    expect(firstDelta(first)).toEqual({
      type: "tool-call-delta",
      id: "x",
      name: "edit",
      argsTextDelta: "{",
    });
    expect(firstDelta(second)).toEqual({
      type: "tool-call-delta",
      id: "x",
      name: "edit",
      argsTextDelta: "{",
    });
  });

  it("module-scope-leak mutant: an orphan delta in turn 2 carries NO name leaked from turn 1's start", async () => {
    // Proves the id→toolName buffer is closure-local (not module-scope). A module-scope mutant
    // would retain "alpha" from turn 1's tool-input-start across the stream() call boundary and
    // leak it onto turn 2's orphan delta.
    //
    // Turn 1: emits tool-input-start {id:"x", toolName:"alpha"} then ends WITHOUT a delta (the
    // name stays unconsumed in the buffer). The stream ends with a finish and no delta for id "x".
    //
    // Turn 2 (a fresh stream() call / fresh mapper): emits an ORPHAN tool-input-delta {id:"x",
    // delta:"..."} with NO preceding tool-input-start. Because the buffer is closure-local, turn
    // 2's mapper has no record of "alpha". The emitted chunk must carry NO name. A module-scope
    // mutant would leak "alpha" from turn 1 — this assertion kills it.
    const turn1: SdkStreamPart[] = [
      { type: "tool-input-start", id: "x", toolName: "alpha" },
      // No tool-input-delta for "x" — the name stays buffered but unconsumed.
      { type: "finish", finishReason: "tool-calls", totalUsage: {} },
    ];
    const turn2: SdkStreamPart[] = [
      // Orphan delta: no preceding start for id "x" in this stream.
      { type: "tool-input-delta", id: "x", delta: '{"k":1}' },
      { type: "finish", finishReason: "tool-calls", totalUsage: {} },
    ];

    let callCount = 0;
    const alternating: StreamTextFn = () => {
      callCount += 1;
      const parts = callCount === 1 ? turn1 : turn2;
      return {
        fullStream: (async function* () {
          for (const p of parts) yield p;
        })(),
      };
    };

    const port = makePort("model", { streamText: alternating });
    await collect(port, { ...userInput, tools: [readSpec] }); // turn 1 — buffers "alpha", never consumed
    const out2 = await collect(port, { ...userInput, tools: [readSpec] }); // turn 2 — orphan delta

    const orphanDelta = out2.find((c) => c.type === "tool-call-delta");
    // The orphan delta must carry NO name — the closure-local buffer for turn 2 has no entry for
    // id "x". A module-scope mutant would inject name:"alpha" here (the unconsumed buffer from
    // turn 1), which this assertion catches.
    expect(orphanDelta).toBeDefined();
    expect(orphanDelta).toEqual({
      type: "tool-call-delta",
      id: "x",
      argsTextDelta: '{"k":1}',
      // name must be absent — NOT "alpha"
    });
    expect("name" in (orphanDelta ?? {})).toBe(false);
  });
});

describe("VercelModelPort — native-tool invariant (no text-parsing fallback exists)", () => {
  it("the providers/ tree contains NO text tool-call parser — tools always go through the SDK tools param", async () => {
    // REGRESSION TRIPWIRE for the native-tool invariant (design §8/vercel-model-port.test.ts).
    // The real guarantee is structural: tools only reach the model via the SDK `tools` param with
    // no `execute` (proven by the wiring test above). This scan is a secondary trip-wire: it
    // catches a specific class of regression where someone adds a named text-to-tool-call parser
    // anywhere under providers/. It is NOT a proof of the absence of all possible parsers — a
    // parser named differently or implementing the same logic without these symbols would pass
    // this scan. The definitive proof is the positive wiring test above.
    //
    // The scan is RECURSIVE over the whole providers/ tree (including subdirectories) so a parser
    // in a subdir or imported helper can't evade it by moving out of the flat top level.
    const { readFileSync, readdirSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const providersDir = fileURLToPath(new URL(".", import.meta.url));

    // Collect all .ts (non-test) source files recursively under providers/.
    function collectSources(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          out.push(...collectSources(full));
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          out.push(full);
        }
      }
      return out;
    }

    const sources = collectSources(providersDir);
    // Forbidden symbols that would indicate a hand-rolled text→tool-call parser path.
    const forbidden = [
      "parseToolCall",
      "parseToolCalls",
      "textToolParser",
      "extractToolCall",
      "decodeInlineTool",
    ];
    for (const filePath of sources) {
      const text = readFileSync(filePath, "utf8");
      for (const sym of forbidden) {
        expect(text.includes(sym), `${filePath} must not contain a text tool parser (${sym})`).toBe(
          false,
        );
      }
    }
    // Positive: tools.ts is the single tool path and exports toSdkTools.
    const toolsSrc = readFileSync(`${providersDir}/tools.ts`, "utf8");
    expect(toolsSrc).toContain("export function toSdkTools");
    // Positive: every SDK tool built by toSdkTools carries NO execute (the native-tool invariant
    // — proven structurally in the wiring test "attaches NO execute function" in tools.test.ts).
    // Confirmed here by absence of "execute:" in the tools.ts source (the function never sets it).
    expect(toolsSrc).not.toContain('"execute"');
    expect(toolsSrc).not.toContain("execute:");
  });
});

describe("VercelModelPort — StreamResultLike structural type", () => {
  it("accepts any object exposing an async-iterable fullStream", async () => {
    // A minimal object satisfying StreamResultLike compiles and runs — proving the seam
    // is structural (both the real streamText result and a test mock satisfy it).
    const result: StreamResultLike = {
      fullStream: (async function* () {
        yield { type: "finish", finishReason: "stop", totalUsage: {} };
      })(),
    };
    const port = makePort("model", { streamText: () => result });
    const out = await collect(port, userInput);
    expect(out[0]?.type).toBe("finish");
  });
});

describe("VercelModelPort — fail-closed non-native-tool guard (design §8)", () => {
  /** A test capability that declares `supportsNativeTools: false`. */
  const nonNativeCapability: ProviderCapability = {
    supportsNativeTools: false,
    reasoningOptions: () => undefined,
    cacheStrategy: "none",
    cacheReadWeight: 1.0,
    contextWindowTokens: () => undefined,
  };

  /** Build a port with the given capability and a capturing `streamText` mock. */
  function portWithCapability(
    capability: ProviderCapability,
    streamText: StreamTextFn,
  ): VercelModelPort {
    const fakeLanguageModel = "model" as unknown as LanguageModel;
    return new VercelModelPort(
      { defaultModelId: "default", buildModel: () => fakeLanguageModel, capability },
      { streamText },
    );
  }

  it("emits a single terminal error chunk and does NOT call streamText when supportsNativeTools is false and tools are present", async () => {
    // This is the structural proof of the §8 fail-closed claim:
    // "A provider with supportsNativeTools === false fails closed — the adapter refuses to
    // advertise tools rather than silently text-parsing."
    const streamTextMock = vi.fn<StreamTextFn>(() => ({
      fullStream: (async function* () {
        yield { type: "finish", finishReason: "stop", totalUsage: {} };
      })(),
    }));

    const port = portWithCapability(nonNativeCapability, streamTextMock);
    const out = await collect(port, { ...userInput, tools: [readSpec] });

    // The adapter must emit exactly one chunk and it must be the terminal error.
    expect(out).toHaveLength(1);
    const chunk = out[0]!;
    expect(chunk.type).toBe("error");
    // Code and message must match the fail-closed strings.
    expect((chunk as { type: "error"; code: string; message: string }).code).toBe(
      "tools-unsupported",
    );
    // The error chunk must satisfy the frozen ModelStreamChunk schema.
    expect(() => ModelStreamChunk.parse(chunk)).not.toThrow();

    // The critical assertion: streamText was NEVER called — no tools reached the SDK.
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("does NOT fail closed when supportsNativeTools is false but no tools are requested (no tools in turn)", async () => {
    // The guard fires only when tools are requested. A tool-less turn on a non-native provider
    // should pass through normally (text generation still works).
    const t = vi.fn<StreamTextFn>(() => ({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "ok" };
        yield { type: "finish", finishReason: "stop", totalUsage: {} };
      })(),
    }));
    const port = portWithCapability(nonNativeCapability, t);
    const out = await collect(port, userInput); // no tools
    expect(t).toHaveBeenCalledTimes(1);
    expect(out.some((c) => c.type === "text-delta")).toBe(true);
  });

  it("native providers (supportsNativeTools: true) still advertise tools to streamText — no regression", async () => {
    // Regression guard: the fail-closed path must not affect the native-tool providers.
    // All four CAPABILITIES rows have supportsNativeTools: true; spot-check anthropic.
    let captured: StreamTextOptions | undefined;
    const spy: StreamTextFn = (opts) => {
      captured = opts;
      return {
        fullStream: (async function* () {
          yield { type: "finish", finishReason: "tool-calls", totalUsage: {} };
        })(),
      };
    };
    const port = portWithCapability(CAPABILITIES.anthropic, spy);
    await collect(port, { ...userInput, tools: [readSpec] });

    // streamText must have been called (native provider — not refused).
    expect(captured).toBeDefined();
    // Tools must have reached the SDK `tools` param.
    expect(captured?.tools).toBeDefined();
    expect(Object.keys(captured?.tools ?? {})).toContain("read");
  });
});
