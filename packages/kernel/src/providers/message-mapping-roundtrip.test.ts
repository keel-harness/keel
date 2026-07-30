import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { runAgentLoop } from "../loop.js";
import { LocalExecutor } from "../local-executor.js";
import type { KernelEventT } from "../events.js";
import { VercelModelPort } from "./vercel-model-port.js";
import type { SdkStreamPart, StreamTextFn, StreamTextOptions } from "./vercel-model-port.js";
import { CAPABILITIES } from "./capabilities.js";
import { toSdkToolName } from "./tools.js";

/** A port pinned to a fixed literal model (slice-4 config form; no per-turn override here). */
function makePort(model: LanguageModel, streamText: StreamTextFn): VercelModelPort {
  return new VercelModelPort(
    { defaultModelId: "default", buildModel: () => model, capability: CAPABILITIES.anthropic },
    { streamText },
  );
}

/**
 * Epic 1.3 Slice-3 multi-turn round-trip proof.
 *
 * A mock `streamText` drives a real `VercelModelPort` through the real `runAgentLoop`
 * + `LocalExecutor`. The mock:
 *   - Turn 1: yields a `tool-call` (atomic) + `finish(tool-calls)`.
 *   - Turn 2: captures the exact SDK `messages` passed to streamText, then yields
 *             a `text-delta` + `finish(stop)`.
 *
 * The captured messages on turn 2 MUST contain the SDK assistant message with the
 * `tool-call` part AND the SDK `tool` message with the `tool-result` part — proving
 * the assistant→tool-result linkage round-trips through `toSdkMessages`.
 */
describe("message-mapping round-trip — multi-turn tool exchange through runAgentLoop", () => {
  it("carries assistant tool-call parts and tool-result parts to the second streamText call", async () => {
    const TOOL_ID = "call-42";
    const TOOL_NAME = "echo";
    const TOOL_ARGS = { message: "hello keel" };
    const EXECUTOR_OUTPUT = "echoed: hello keel";

    // Capture the messages passed on the SECOND streamText call.
    let capturedMessages: StreamTextOptions["messages"] | undefined;
    let callCount = 0;

    const streamText: StreamTextFn = (opts) => {
      callCount += 1;
      if (callCount === 1) {
        // Turn 1: emit an atomic tool-call then finish with tool-calls reason.
        return {
          fullStream: (async function* (): AsyncGenerator<SdkStreamPart> {
            yield {
              type: "tool-call",
              toolCallId: TOOL_ID,
              toolName: TOOL_NAME,
              input: TOOL_ARGS,
            };
            yield {
              type: "finish",
              finishReason: "tool-calls",
              totalUsage: { inputTokens: 5, outputTokens: 3 },
            };
          })(),
        };
      }
      // Turn 2: capture messages, then yield a text + stop.
      capturedMessages = opts.messages;
      return {
        fullStream: (async function* (): AsyncGenerator<SdkStreamPart> {
          yield { type: "text-delta", text: "done" };
          yield {
            type: "finish",
            finishReason: "stop",
            totalUsage: { inputTokens: 8, outputTokens: 2 },
          };
        })(),
      };
    };

    // A LocalExecutor with the echo tool registered.
    const executor = new LocalExecutor({
      [TOOL_NAME]: (args) => `echoed: ${String((args as { message: string }).message)}`,
    });

    const port = makePort("test-model", streamText);

    const events: KernelEventT[] = [];
    for await (const ev of runAgentLoop(port, executor, {
      messages: [{ role: "user", content: "echo hello keel" }],
      tools: [{ name: TOOL_NAME, description: "Echoes a message." }],
    })) {
      events.push(ev);
    }

    // --- Verify the run completed cleanly ---
    expect(callCount).toBe(2);
    expect(events.find((e) => e.type === "stop")).toEqual({ type: "stop", reason: "model-stop" });

    // --- Verify the captured turn-2 messages ---
    expect(capturedMessages).toBeDefined();
    const msgs = capturedMessages!;

    // The original user message should be first.
    expect(msgs[0]).toEqual({ role: "user", content: "echo hello keel" });

    // The assistant turn (turn 1 result) must carry the tool-call part.
    // Shape: { role:"assistant", content: [{ type:"tool-call", toolCallId, toolName, input }] }
    const assistantMsg = msgs[1];
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: TOOL_ID,
          toolName: TOOL_NAME,
          input: TOOL_ARGS,
        },
      ],
    });
    // Exact field names (not `id`/`name`/`args` — those are keel's internal names).
    expect(
      (assistantMsg as { content: Array<{ toolCallId?: string; toolName?: string }> }).content[0]
        ?.toolCallId,
    ).toBe(TOOL_ID);
    expect(
      (assistantMsg as { content: Array<{ toolCallId?: string; toolName?: string }> }).content[0]
        ?.toolName,
    ).toBe(TOOL_NAME);

    // The tool result message must carry the executor's output as a tool-result part.
    // Shape: { role:"tool", content: [{ type:"tool-result", toolCallId, toolName, output:{type:"text",value} }] }
    const toolMsg = msgs[2];
    expect(toolMsg).toBeDefined();
    // toMatchObject (not toEqual): this is a MESSAGE-MAPPING test — the last message also carries an
    // Anthropic cache breakpoint (providerOptions) from the caching layer, which the caching tests own.
    expect(toolMsg).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: TOOL_ID,
          toolName: TOOL_NAME,
          output: { type: "text", value: EXECUTOR_OUTPUT },
        },
      ],
    });
    // Exact output shape — { type:"text", value } not { type:"json", ... }.
    const resultPart = (toolMsg as { content: Array<{ output?: unknown }> }).content[0];
    expect(resultPart?.output).toEqual({ type: "text", value: EXECUTOR_OUTPUT });

    // The total messages on turn 2 are: [user, assistant(tool-call), tool(result)] — 3 entries.
    expect(msgs).toHaveLength(3);
  });

  it("correctly maps multiple tool calls from one assistant turn through the round-trip", async () => {
    // Two tool calls in a single assistant turn → two tool-call parts in the assistant message,
    // two tool-result parts (one each in separate tool messages) on the next turn.
    const capturedTurn2Messages: StreamTextOptions["messages"][] = [];
    let call = 0;

    const streamText: StreamTextFn = (opts) => {
      call += 1;
      if (call === 1) {
        return {
          fullStream: (async function* (): AsyncGenerator<SdkStreamPart> {
            yield { type: "tool-call", toolCallId: "id-A", toolName: "alpha", input: { x: 1 } };
            yield { type: "tool-call", toolCallId: "id-B", toolName: "beta", input: { y: 2 } };
            yield { type: "finish", finishReason: "tool-calls", totalUsage: {} };
          })(),
        };
      }
      capturedTurn2Messages.push(opts.messages);
      return {
        fullStream: (async function* (): AsyncGenerator<SdkStreamPart> {
          yield { type: "finish", finishReason: "stop", totalUsage: {} };
        })(),
      };
    };

    const executor = new LocalExecutor({
      alpha: (_args) => "alpha-result",
      beta: (_args) => "beta-result",
    });

    const port = makePort("m", streamText);
    // Drain the loop — events are not needed; the captured messages are the proof.
    const loop = runAgentLoop(port, executor, {
      messages: [{ role: "user", content: "run both" }],
      tools: [{ name: "alpha" }, { name: "beta" }],
    });
    for await (const ev of loop) void ev;

    expect(capturedTurn2Messages).toHaveLength(1);
    const msgs = capturedTurn2Messages[0]!;

    // Assistant message must have two tool-call parts (content is an array).
    const assistantMsg = msgs[1];
    expect(assistantMsg).toEqual({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "id-A", toolName: "alpha", input: { x: 1 } },
        { type: "tool-call", toolCallId: "id-B", toolName: "beta", input: { y: 2 } },
      ],
    });

    // Two separate tool messages (one per result, as the loop appends them individually).
    expect(msgs[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "id-A",
          toolName: "alpha",
          output: { type: "text", value: "alpha-result" },
        },
      ],
    });
    // toMatchObject: msgs[3] is the LAST message, so it also carries the Anthropic cache breakpoint
    // (providerOptions) from the caching layer — owned by the caching tests, not this mapping test.
    expect(msgs[3]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "id-B",
          toolName: "beta",
          output: { type: "text", value: "beta-result" },
        },
      ],
    });
    // Total: user + assistant(2 tool-calls) + 2 tool-result messages = 4.
    expect(msgs).toHaveLength(4);
  });

  it("keeps dotted keel tool names internal while using provider-safe names in turn-2 history", async () => {
    const TOOL_ID = "console-open";
    const TOOL_NAME = "interactive_console.open";
    const SDK_TOOL_NAME = toSdkToolName(TOOL_NAME);
    const TOOL_ARGS = { targetId: "qemu-startup" };
    let capturedTurn2: StreamTextOptions["messages"] | undefined;
    let executorSawName = false;
    let call = 0;

    const streamText: StreamTextFn = (opts) => {
      call += 1;
      if (call === 1) {
        expect(Object.keys(opts.tools ?? {})).toEqual([SDK_TOOL_NAME]);
        return {
          fullStream: (async function* (): AsyncGenerator<SdkStreamPart> {
            yield {
              type: "tool-call",
              toolCallId: TOOL_ID,
              toolName: SDK_TOOL_NAME,
              input: TOOL_ARGS,
            };
            yield { type: "finish", finishReason: "tool-calls", totalUsage: {} };
          })(),
        };
      }
      capturedTurn2 = opts.messages;
      return {
        fullStream: (async function* (): AsyncGenerator<SdkStreamPart> {
          yield { type: "finish", finishReason: "stop", totalUsage: {} };
        })(),
      };
    };

    const executor = new LocalExecutor({
      [TOOL_NAME]: () => {
        executorSawName = true;
        return "opened";
      },
    });

    const events: KernelEventT[] = [];
    for await (const ev of runAgentLoop(makePort("m", streamText), executor, {
      messages: [{ role: "user", content: "open console" }],
      tools: [{ name: TOOL_NAME, description: "Open console." }],
    })) {
      events.push(ev);
    }

    expect(executorSawName).toBe(true);
    expect(events.some((event) => event.type === "tool-call" && event.name === TOOL_NAME)).toBe(
      true,
    );
    expect(capturedTurn2?.[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: TOOL_ID,
          toolName: SDK_TOOL_NAME,
          input: TOOL_ARGS,
        },
      ],
    });
    expect(capturedTurn2?.[2]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: TOOL_ID,
          toolName: SDK_TOOL_NAME,
          output: { type: "text", value: "opened" },
        },
      ],
    });
  });
});
