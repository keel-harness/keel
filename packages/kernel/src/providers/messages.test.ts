import { describe, expect, it } from "vitest";
import type { ModelMessageT } from "@keel/shared";
import { toSdkMessages } from "./messages.js";
import { toSdkToolName } from "./tools.js";

// ---------------------------------------------------------------------------
// Unit tests for toSdkMessages (pure, no I/O).
//
// The SDK outgoing shapes are the INSTALLED types from
// @ai-sdk/provider-utils@4.0.27 (re-exported by ai@6.0.197):
//
//   ToolCallPart  = { type:"tool-call", toolCallId, toolName, input }
//   ToolResultPart= { type:"tool-result", toolCallId, toolName, output }
//   ToolResultOutput (text) = { type:"text", value: string }
//   AssistantModelMessage content (with tool calls) = Array<TextPart | ToolCallPart | ...>
//   ToolModelMessage content = Array<ToolResultPart | ...>
//
// Every field of every produced shape is asserted — no bare truthiness.
// ---------------------------------------------------------------------------

describe("toSdkMessages — system role", () => {
  it("maps { role:'system', content } to { role:'system', content: string }", () => {
    const msgs: ModelMessageT[] = [{ role: "system", content: "be brief" }];
    expect(toSdkMessages(msgs)).toEqual([{ role: "system", content: "be brief" }]);
  });
});

describe("toSdkMessages — user role", () => {
  it("maps { role:'user', content } to { role:'user', content: string }", () => {
    const msgs: ModelMessageT[] = [{ role: "user", content: "hello" }];
    expect(toSdkMessages(msgs)).toEqual([{ role: "user", content: "hello" }]);
  });
});

describe("toSdkMessages — assistant without toolCalls", () => {
  it("maps assistant text turn to { role:'assistant', content: string }", () => {
    const msgs: ModelMessageT[] = [{ role: "assistant", content: "I will help" }];
    expect(toSdkMessages(msgs)).toEqual([{ role: "assistant", content: "I will help" }]);
  });

  it("maps assistant with empty content and no toolCalls to string form", () => {
    const msgs: ModelMessageT[] = [{ role: "assistant", content: "" }];
    expect(toSdkMessages(msgs)).toEqual([{ role: "assistant", content: "" }]);
  });

  it("maps assistant with empty toolCalls array to string form (no parts array)", () => {
    // An empty toolCalls array is treated the same as no toolCalls — no tool-call content.
    const msgs: ModelMessageT[] = [{ role: "assistant", content: "done", toolCalls: [] }];
    expect(toSdkMessages(msgs)).toEqual([{ role: "assistant", content: "done" }]);
  });
});

describe("toSdkMessages — assistant WITH toolCalls", () => {
  it("emits a text part AND a tool-call part when content is non-empty", () => {
    const msgs: ModelMessageT[] = [
      {
        role: "assistant",
        content: "let me read that",
        toolCalls: [{ id: "c1", name: "read", args: { path: "a.ts" } }],
      },
    ];
    const out = toSdkMessages(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "let me read that" },
        { type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "a.ts" } },
      ],
    });
  });

  it("OMITS the text part when content is empty string", () => {
    const msgs: ModelMessageT[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c2", name: "bash", args: { cmd: "ls" } }],
      },
    ];
    const out = toSdkMessages(msgs);
    expect(out).toHaveLength(1);
    // content must be an array with ONLY the tool-call part (no empty text part)
    expect(out[0]).toEqual({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c2", toolName: "bash", input: { cmd: "ls" } }],
    });
  });

  it("emits one tool-call part per entry when multiple tool calls are in one turn", () => {
    const msgs: ModelMessageT[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "t1", name: "read", args: { path: "x.ts" } },
          { id: "t2", name: "edit", args: { path: "x.ts", content: "new" } },
        ],
      },
    ];
    const out = toSdkMessages(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "t1", toolName: "read", input: { path: "x.ts" } },
        {
          type: "tool-call",
          toolCallId: "t2",
          toolName: "edit",
          input: { path: "x.ts", content: "new" },
        },
      ],
    });
  });

  it("places text part first, then all tool-call parts, in the order they appear in toolCalls", () => {
    const msgs: ModelMessageT[] = [
      {
        role: "assistant",
        content: "calling two tools",
        toolCalls: [
          { id: "a", name: "search", args: { q: "keel" } },
          { id: "b", name: "bash", args: { cmd: "pwd" } },
        ],
      },
    ];
    const out = toSdkMessages(msgs);
    expect(out[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "calling two tools" },
        { type: "tool-call", toolCallId: "a", toolName: "search", input: { q: "keel" } },
        { type: "tool-call", toolCallId: "b", toolName: "bash", input: { cmd: "pwd" } },
      ],
    });
  });

  it("sets toolCallId from tc.id and toolName from tc.name — field name mapping", () => {
    // Explicitly assert the rename: keel uses {id, name}; SDK uses {toolCallId, toolName}.
    const msgs: ModelMessageT[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "my-id-42", name: "my-tool", args: {} }],
      },
    ];
    const out = toSdkMessages(msgs);
    const part = (out[0] as { content: Array<{ toolCallId?: string; toolName?: string }> })
      .content[0];
    expect(part?.toolCallId).toBe("my-id-42");
    expect(part?.toolName).toBe("my-tool");
  });

  it("passes args object through as `input` unchanged", () => {
    const args = { nested: { a: 1 }, list: [1, 2, 3] };
    const msgs: ModelMessageT[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "x", name: "t", args }] },
    ];
    const out = toSdkMessages(msgs);
    const part = (out[0] as { content: Array<{ input?: unknown }> }).content[0];
    expect(part?.input).toStrictEqual(args);
  });

  it("maps assistant history tool-call names through the provider-safe projection", () => {
    const sdkName = toSdkToolName("interactive_console.open");
    const msgs: ModelMessageT[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "interactive_console.open", args: { targetId: "qemu" } }],
      },
    ];

    expect(toSdkMessages(msgs, toSdkToolName)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: sdkName,
            input: { targetId: "qemu" },
          },
        ],
      },
    ]);
  });
});

describe("toSdkMessages — tool role", () => {
  it("maps tool message to { role:'tool', content:[{ type:'tool-result', ... }] }", () => {
    const msgs: ModelMessageT[] = [
      {
        role: "tool",
        content: "file contents here",
        toolCallId: "c1",
        name: "read",
      },
    ];
    const out = toSdkMessages(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read",
          output: { type: "text", value: "file contents here" },
        },
      ],
    });
  });

  it("maps tool-result history names through the provider-safe projection", () => {
    const sdkName = toSdkToolName("interactive_console.open");
    const msgs: ModelMessageT[] = [
      {
        role: "tool",
        content: "opened",
        toolCallId: "c1",
        name: "interactive_console.open",
      },
    ];

    expect(toSdkMessages(msgs, toSdkToolName)).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: sdkName,
            output: { type: "text", value: "opened" },
          },
        ],
      },
    ]);
  });

  it("maps name field to toolName in the tool-result part", () => {
    const msgs: ModelMessageT[] = [
      { role: "tool", content: "ok", toolCallId: "x99", name: "bash" },
    ];
    const out = toSdkMessages(msgs);
    const part = (out[0] as { content: Array<{ toolName?: string }> }).content[0];
    expect(part?.toolName).toBe("bash");
  });

  it("wraps the string result as { type:'text', value } in the output field", () => {
    const msgs: ModelMessageT[] = [
      { role: "tool", content: "the result text", toolCallId: "id1", name: "t" },
    ];
    const out = toSdkMessages(msgs);
    const part = (out[0] as { content: Array<{ output?: unknown }> }).content[0];
    expect(part?.output).toEqual({ type: "text", value: "the result text" });
  });

  it("skips a tool message missing toolCallId to avoid an invalid SDK message (honest guard)", () => {
    // The frozen schema makes toolCallId optional; the loop never produces a tool message
    // without it, but the guard is honest about the field absence.
    // Cast to bypass TS strictness — we are explicitly testing the runtime guard for data
    // that the frozen schema technically permits (toolCallId is `z.string().min(1).optional()`).
    const msgs = [{ role: "tool", content: "orphan", name: "t" }] as ModelMessageT[];
    // A missing toolCallId means we cannot form a valid SDK tool-result part.
    // The mapper skips such a message rather than emitting an invalid shape.
    const out = toSdkMessages(msgs);
    expect(out).toHaveLength(0);
  });

  it("skips a tool message missing name to avoid an invalid SDK message (honest guard)", () => {
    const msgs = [{ role: "tool", content: "orphan", toolCallId: "id1" }] as ModelMessageT[];
    // Missing name → skip.
    const out = toSdkMessages(msgs);
    expect(out).toHaveLength(0);
  });
});

describe("toSdkMessages — mixed conversation", () => {
  it("maps a full multi-role conversation in order", () => {
    const msgs: ModelMessageT[] = [
      { role: "system", content: "be concise" },
      { role: "user", content: "read a.ts" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read", args: { path: "a.ts" } }],
      },
      { role: "tool", content: "export const x = 1;", toolCallId: "c1", name: "read" },
      { role: "assistant", content: "The file exports x." },
    ];
    const out = toSdkMessages(msgs);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ role: "system", content: "be concise" });
    expect(out[1]).toEqual({ role: "user", content: "read a.ts" });
    expect(out[2]).toEqual({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "a.ts" } }],
    });
    expect(out[3]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read",
          output: { type: "text", value: "export const x = 1;" },
        },
      ],
    });
    expect(out[4]).toEqual({ role: "assistant", content: "The file exports x." });
  });
});
