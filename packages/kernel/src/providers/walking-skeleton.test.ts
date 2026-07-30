import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { runAgentLoop } from "../loop.js";
import { LocalExecutor } from "../local-executor.js";
import type { KernelEventT } from "../events.js";
import { VercelModelPort } from "./vercel-model-port.js";
import type { SdkStreamPart, StreamTextFn } from "./vercel-model-port.js";
import { CAPABILITIES } from "./capabilities.js";

/** A port pinned to a fixed literal model (slice-4 config form; no per-turn override here). */
function makePort(model: LanguageModel, streamText: StreamTextFn): VercelModelPort {
  return new VercelModelPort(
    { defaultModelId: "default", buildModel: () => model, capability: CAPABILITIES.anthropic },
    { streamText },
  );
}

/**
 * The Epic 1.3 Slice-1 walking skeleton: a MOCKED transport drives a real
 * `VercelModelPort` through the real `runAgentLoop` + `LocalExecutor`. This proves
 * the seam `mock transport → adapter → ModelPort → kernel loop → kernel events`
 * across real package boundaries — text only, no tools.
 */
describe("walking skeleton — VercelModelPort end-to-end through runAgentLoop", () => {
  it("streams a two-delta text turn and finishes with model-stop + usage", async () => {
    const streamText: StreamTextFn = () => ({
      fullStream: (async function* (): AsyncGenerator<SdkStreamPart> {
        yield { type: "text-delta", text: "Hello " };
        yield { type: "text-delta", text: "world" };
        yield {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 10, outputTokens: 5 },
        };
      })(),
    });
    const port = makePort("anthropic-model", streamText);

    const events: KernelEventT[] = [];
    for await (const ev of runAgentLoop(port, new LocalExecutor(), {
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(ev);
    }

    // The full event sequence the seam must produce.
    expect(events.map((e) => e.type)).toEqual([
      "run-started",
      "turn-started",
      "text-delta",
      "text-delta",
      "stop",
      "run-finished",
    ]);

    const turnStarted = events.find((e) => e.type === "turn-started");
    expect(turnStarted).toEqual({ type: "turn-started", turn: 1 });

    const deltas = events.filter((e) => e.type === "text-delta");
    expect(deltas).toEqual([
      { type: "text-delta", text: "Hello " },
      { type: "text-delta", text: "world" },
    ]);

    expect(events.find((e) => e.type === "stop")).toEqual({ type: "stop", reason: "model-stop" });

    expect(events.find((e) => e.type === "run-finished")).toEqual({
      type: "run-finished",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it("passes a stream containing reasoning-delta parts through the loop without breaking it", async () => {
    // Slice 4: reasoning-delta is mapped to a keel reasoning-delta chunk; the loop validly
    // ignores it (it is non-terminal and emits no kernel event). The run must complete with
    // the same text + stop sequence as if no reasoning had been streamed — reasoning tokens
    // do not corrupt accounting or the terminal invariant.
    const streamText: StreamTextFn = () => ({
      fullStream: (async function* (): AsyncGenerator<SdkStreamPart> {
        yield { type: "reasoning-delta", text: "thinking…" };
        yield { type: "text-delta", text: "Answer" };
        yield { type: "reasoning-delta", text: "more thought" };
        yield {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 7, outputTokens: 3 },
        };
      })(),
    });
    const port = makePort("reasoning-model", streamText);

    const events: KernelEventT[] = [];
    for await (const ev of runAgentLoop(port, new LocalExecutor(), {
      messages: [{ role: "user", content: "think then answer" }],
    })) {
      events.push(ev);
    }

    // No reasoning event type leaks to the kernel; the loop emits its normal sequence.
    expect(events.map((e) => e.type)).toEqual([
      "run-started",
      "turn-started",
      "text-delta",
      "stop",
      "run-finished",
    ]);
    expect(events.filter((e) => e.type === "text-delta")).toEqual([
      { type: "text-delta", text: "Answer" },
    ]);
    expect(events.find((e) => e.type === "stop")).toEqual({ type: "stop", reason: "model-stop" });
    expect(events.find((e) => e.type === "run-finished")).toEqual({
      type: "run-finished",
      usage: { inputTokens: 7, outputTokens: 3 },
    });
  });
});
