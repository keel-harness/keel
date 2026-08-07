import { describe, expect, it, vi } from "vitest";
import type { KernelEventT } from "../events.js";
import { LocalExecutor } from "../local-executor.js";
import { runAgentLoop } from "../loop.js";
import { createOpenAICompatibleModelPort } from "./factory.js";

function event(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function earlyParsableToolCallSse(): string {
  const base = {
    id: "chatcmpl-stream-integrity",
    object: "chat.completion.chunk",
    created: 1_786_057_200,
    model: "compat-test",
  };
  return (
    event({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }],
    }) +
    event({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_stream_integrity",
                type: "function",
                function: {
                  name: "read",
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    event({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: ',"encoding":"utf8"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    event({
      ...base,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }) +
    "data: [DONE]\n\n"
  );
}

function completeToolCallSse(): string {
  const base = {
    id: "chatcmpl-stream-integrity",
    object: "chat.completion.chunk",
    created: 1_786_057_200,
    model: "compat-test",
  };
  return (
    event({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }],
    }) +
    event({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_stream_integrity",
                type: "function",
                function: {
                  name: "read",
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    event({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }) +
    "data: [DONE]\n\n"
  );
}

function textStopSse(): string {
  const base = {
    id: "chatcmpl-stream-integrity-done",
    object: "chat.completion.chunk",
    created: 1_786_057_201,
    model: "compat-test",
  };
  return (
    event({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }],
    }) +
    event({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 16, completion_tokens: 2, total_tokens: 18 },
    }) +
    "data: [DONE]\n\n"
  );
}

const readTool = {
  name: "read",
  description: "Read a workspace file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
} as const;

async function run(
  fetchMock: typeof globalThis.fetch,
  executor: LocalExecutor,
  maxTurns = 2,
): Promise<KernelEventT[]> {
  const port = createOpenAICompatibleModelPort({
    model: "compat-test",
    baseURL: "http://compat.invalid/v1",
    apiKey: "test-key",
    fetch: fetchMock,
    maxRetries: 0,
  });
  const events: KernelEventT[] = [];
  for await (const current of runAgentLoop(port, executor, {
    messages: [{ role: "user", content: "read the file" }],
    tools: [readTool],
    stop: { maxTurns },
  })) {
    events.push(current);
  }
  return events;
}

describe("OpenAI-compatible streamed tool-call integrity", () => {
  it("never executes a parsable argument prefix when later stream bytes invalidate it", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => {
      return new Response(earlyParsableToolCallSse(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const execute = vi.fn(() => "unexpected execution");
    const events = await run(fetchMock, new LocalExecutor({ read: execute }), 1);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({ type: "tool-call" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "tool-result" }));
    expect(events.find((current) => current.type === "stop")).toEqual(
      expect.objectContaining({ type: "stop", reason: "error", code: "tool-call-args" }),
    );
    expect(events).not.toContainEqual({ type: "stop", reason: "model-stop" });
  });

  it("executes one ordinary complete tool call exactly once after the stream settles", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(completeToolCallSse(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(textStopSse(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    const execute = vi.fn(() => "file contents");
    const events = await run(fetchMock, new LocalExecutor({ read: execute }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      { path: "README.md" },
      expect.objectContaining({ toolCallId: "call_stream_integrity" }),
    );
    expect(events.filter((current) => current.type === "tool-call")).toHaveLength(1);
    expect(events.filter((current) => current.type === "tool-result")).toHaveLength(1);
    expect(events.find((current) => current.type === "stop")).toEqual({
      type: "stop",
      reason: "model-stop",
    });
  });
});
