import type { ModelPort, ModelStreamChunkT, ModelTurnInput } from "@keel/shared";
import { describe, expect, it } from "vitest";
import { RecordingModelPort } from "./record.js";
import { ScriptedModel } from "./script-model.js";
import { drain } from "./testing/drain.js";

describe("RecordingModelPort (record-mode stub)", () => {
  it("passes chunks through and reconstructs a replayable script", async () => {
    const original = new ScriptedModel({
      turns: [
        { text: "hello", toolCalls: [{ name: "echo", args: { text: "hi" } }] },
        { text: "done" },
      ],
    });
    const rec = new RecordingModelPort(original);
    const t1 = await drain(rec, [{ role: "user", content: "go" }]);
    const t2 = await drain(rec, [
      { role: "tool", content: "hi", toolCallId: "call_0_0", name: "echo" },
    ]);

    const script = rec.toScript();
    expect(script.version).toBe(1);
    expect(script.turns).toEqual([
      { text: "hello", toolCalls: [{ name: "echo", args: { text: "hi" } }] },
      { text: "done" },
    ]);

    // Replaying the recorded script reproduces the recorded transcript exactly.
    const replay = new ScriptedModel(script);
    const r1 = await drain(replay, [{ role: "user", content: "go" }]);
    const r2 = await drain(replay, [
      { role: "tool", content: "hi", toolCallId: "call_0_0", name: "echo" },
    ]);
    expect([...r1, ...r2]).toEqual([...t1, ...t2]);
  });

  it("records an empty turn when the delegate emits only a finish", async () => {
    const rec = new RecordingModelPort(new ScriptedModel({ turns: [{}] }));
    await drain(rec, []);
    expect(rec.toScript().turns).toEqual([{}]);
  });

  it("toScript() returns a deep copy — mutating the returned script does not affect subsequent calls", async () => {
    const original = new ScriptedModel({
      turns: [{ text: "hi", toolCalls: [{ name: "echo", args: { text: "hello" } }] }],
    });
    const rec = new RecordingModelPort(original);
    await drain(rec, [{ role: "user", content: "go" }]);

    const script1 = rec.toScript();
    // Mutate a deeply nested field of the returned script
    const turn0 = script1.turns[0];
    const firstCall = turn0?.toolCalls?.[0];
    if (firstCall !== undefined) {
      firstCall.args["text"] = "MUTATED";
    }

    // A fresh call to toScript() must be unaffected by the mutation above
    const script2 = rec.toScript();
    expect(script2.turns[0]?.toolCalls?.[0]?.args).toEqual({ text: "hello" });
  });

  it("N5: clones tool-call args at capture — mid-iteration mutation does not corrupt toScript()", async () => {
    // Build a minimal mock delegate that yields exactly one tool-call chunk then finish.
    const mutableArgs = { a: 1 };
    const mockDelegate: ModelPort = {
      async *stream(_input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
        yield { type: "tool-call", id: "call_0_0", name: "probe", args: mutableArgs };
        yield { type: "finish", reason: "tool-calls", usage: { inputTokens: 0, outputTokens: 1 } };
      },
    };

    const rec = new RecordingModelPort(mockDelegate);
    // Mutate the yielded chunk's args object mid-iteration, AFTER the recorder has
    // pushed it internally but BEFORE toScript() is called.
    for await (const chunk of rec.stream({ messages: [{ role: "user", content: "go" }] })) {
      if (chunk.type === "tool-call") {
        // Deliberately mutate the yielded chunk's args to verify the recorder
        // cloned them at capture-time (N5 regression guard).
        chunk.args["a"] = 999;
      }
    }

    // The recorder's internal snapshot must be the pre-mutation value, not 999.
    const script = rec.toScript();
    expect(script.turns[0]?.toolCalls?.[0]?.args).toEqual({ a: 1 });
  });

  it("passes an error terminal chunk through and records only the pre-error text", async () => {
    const rec = new RecordingModelPort(
      new ScriptedModel({
        turns: [{ text: "abcd", toolCalls: [{ name: "echo", args: {} }] }],
        faultInjection: { chunkSize: 2, malformedChunkAtIndex: 1 },
      }),
    );
    const chunks = await drain(rec, []);
    // the error chunk passes through to the consumer unchanged (not swallowed)
    expect(chunks).toEqual([
      { type: "text-delta", text: "ab" },
      { type: "error", code: "malformed-chunk", message: "injected malformed chunk at index 1" },
    ]);
    // only the text accumulated before the error is recorded; the error itself and
    // the tool call that the terminated turn never reached are not part of the turn
    expect(rec.toScript().turns).toEqual([{ text: "ab" }]);
  });
});
