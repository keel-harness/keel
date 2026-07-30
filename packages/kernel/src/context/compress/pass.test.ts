import { describe, expect, it } from "vitest";
import type { ModelMessageT } from "@keel/shared";
import { runDeterministicPass, ledgerNote } from "./pass.js";
import { toSdkMessages } from "../../providers/messages.js";
import { estimateMessagesTokens } from "../compact.js";
import { PLAN_TOOL_NAME } from "../../tools/plan.js";

const REPEAT = (n: number): string =>
  Array.from({ length: n }, () => "duplicate log line").join("\n");
const toolMsg = (id: string, body: string): ModelMessageT => ({
  role: "tool",
  name: "bash",
  toolCallId: id,
  content: body,
});
const assistantToolCall = (id: string, command: string): ModelMessageT => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name: "bash", args: { command, cwd: "/app" } }],
});
const hugeCommand = (): string => `python - <<'PY'\n${"print('payload')\n".repeat(2_000)}PY`;

describe("runDeterministicPass (aged tool-body compression, never-enlarge guard)", () => {
  it("returns messages unchanged and a null event when already under target", () => {
    const messages: ModelMessageT[] = [
      { role: "system", content: "p" },
      { role: "user", content: "go" },
    ];
    const r = runDeterministicPass({
      messages,
      budgetTokens: 10_000,
      headroomTokens: 0,
      trigger: "token_soft",
    });
    expect(r.messages).toEqual(messages);
    expect(r.event).toBeNull();
  });

  it("compresses the oldest clearable tool body first and emits an event; pinned + recent untouched", () => {
    const messages: ModelMessageT[] = [
      { role: "system", content: "pinned" },
      { role: "user", content: "do it" },
      toolMsg("old", REPEAT(600)), // aged → clearable → compressed
      { role: "assistant", content: "next" }, // recent_verbatim (last 1)
    ];
    const r = runDeterministicPass({
      messages,
      budgetTokens: 300,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_soft",
    });
    const old = r.messages.find((m) => m.toolCallId === "old")!;
    expect(old.content.length).toBeLessThan(REPEAT(600).length);
    expect(old.content).toMatch(/ledger/i); // honest marker
    expect(old.content).toContain('retrieve(ref="old")'); // cites the retrievable artifact ref (slice 5)
    expect(r.messages[0]).toEqual(messages[0]); // pinned untouched
    expect(r.messages[0]).toBe(messages[0]); // untouched identity carries message provenance
    expect(r.messages[1]).toBe(messages[1]);
    expect(r.messages.at(-1)).toEqual(messages.at(-1)); // recent untouched
    expect(r.event).not.toBeNull();
    expect(r.event!.type).toBe("context_compression");
    expect(r.event!.items).toHaveLength(1);
    expect(r.event!.items[0]!.name).toBe("bash");
    expect(r.event!.tokensAfter).toBeLessThan(r.event!.tokensBefore);
    expect(r.event!.trust).toBe("unknown"); // fail-closed (SEC-023)
  });

  it("net-gain guard: leaves an incompressible clearable body unchanged and out of the event", () => {
    const incompressible = "X".repeat(4000); // one line of X — generic cannot shrink under 4096
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      toolMsg("inc", incompressible),
      { role: "assistant", content: "n" },
    ];
    const r = runDeterministicPass({
      messages,
      budgetTokens: 50,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });
    expect(r.messages.find((m) => m.toolCallId === "inc")!.content).toBe(incompressible);
    expect(r.event).toBeNull();
  });

  it("never compresses a tool body inside the recent_verbatim window", () => {
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      toolMsg("recent", REPEAT(600)),
    ];
    const r = runDeterministicPass({
      messages,
      budgetTokens: 10,
      headroomTokens: 0,
      recentVerbatimTurns: 6,
      trigger: "token_hard",
    });
    expect(r.messages.find((m) => m.toolCallId === "recent")!.content).toBe(REPEAT(600));
    expect(r.event).toBeNull();
  });

  it("preserves message count, roles, and toolCallIds (pairing safety)", () => {
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      toolMsg("a", REPEAT(600)),
      { role: "assistant", content: "mid" },
      toolMsg("b", REPEAT(600)),
      { role: "assistant", content: "last" },
    ];
    const r = runDeterministicPass({
      messages,
      budgetTokens: 100,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });
    expect(r.messages.map((m) => m.role)).toEqual(messages.map((m) => m.role));
    expect(r.messages.map((m) => m.toolCallId)).toEqual(messages.map((m) => m.toolCallId));
    expect(r.messages).toHaveLength(messages.length);
  });

  it("uses the default output headroom when headroomTokens is omitted", () => {
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      toolMsg("old", REPEAT(600)),
      { role: "assistant", content: "last" },
    ];
    // No headroomTokens → default 16K reserved → target 0 for this small budget → compress.
    const r = runDeterministicPass({
      messages,
      budgetTokens: 300,
      recentVerbatimTurns: 1,
      trigger: "token_soft",
    });
    expect(r.event).not.toBeNull();
    expect(r.messages.find((m) => m.toolCallId === "old")!.content).toMatch(/ledger/i);
  });

  it("threads taskTokens through to the compressor without breaking compression", () => {
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      toolMsg("old", REPEAT(600)),
      { role: "assistant", content: "last" },
    ];
    const r = runDeterministicPass({
      messages,
      budgetTokens: 100,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      taskTokens: ["median", "stats"],
      trigger: "token_hard",
    });
    expect(r.event).not.toBeNull();
    expect(r.event!.items).toHaveLength(1);
  });

  it("labels a tool result that carries no name as 'unknown' in the event", () => {
    const nameless: ModelMessageT = { role: "tool", toolCallId: "n", content: REPEAT(600) };
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      nameless,
      { role: "assistant", content: "last" },
    ];
    const r = runDeterministicPass({
      messages,
      budgetTokens: 100,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });
    expect(r.event!.items[0]!.name).toBe("unknown");
  });

  it("skips a body already carrying the ledger note (no double-compression across cycles — QC fix)", () => {
    const already = REPEAT(600) + ledgerNote("old"); // large, but already compressed on a prior pass
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      toolMsg("old", already),
      { role: "assistant", content: "last" },
    ];
    const r = runDeterministicPass({
      messages,
      budgetTokens: 10,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });
    expect(r.event).toBeNull(); // skipped — no second note, no re-elide with a false count
    expect(r.messages.find((m) => m.toolCallId === "old")!.content).toBe(already); // untouched
  });

  it("uses the ledger-note fallback when no retrievable ref is available", () => {
    expect(ledgerNote()).toContain("full output retained in the session ledger");
    expect(ledgerNote("")).not.toContain("retrieve(ref=");
  });

  it("preserves the latest plan tool result verbatim under hard pressure", () => {
    const oldPlan = REPEAT(600);
    const latestPlan = REPEAT(700);
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      { role: "tool", name: PLAN_TOOL_NAME, toolCallId: "plan-old", content: oldPlan },
      { role: "assistant", content: "mid" },
      { role: "tool", name: PLAN_TOOL_NAME, toolCallId: "plan-latest", content: latestPlan },
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 50,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });

    expect(r.messages.find((m) => m.toolCallId === "plan-old")!.content).not.toBe(oldPlan);
    expect(r.messages.find((m) => m.toolCallId === "plan-latest")!.content).toBe(latestPlan);
  });

  it("records the routed compressor kind per item and an honest tokensAfter", () => {
    const searchBody = Array.from({ length: 40 }, (_, i) => `a.ts:${i + 1}:1:hit ${i}`).join("\n");
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      { role: "tool", name: "search", toolCallId: "s", content: searchBody },
      { role: "assistant", content: "last" },
    ];
    const r = runDeterministicPass({
      messages,
      budgetTokens: 50,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });
    expect(r.event!.items[0]!.kind).toBe("search"); // routed to the search compressor, recorded
    // tokensAfter is the honest re-sum of the post-compression conversation
    const resum = r.messages.reduce((s, m) => s + Math.ceil(m.content.length / 4) + 4, 0);
    expect(r.event!.tokensAfter).toBe(resum);
  });

  it("does not mutate the input messages (pure; SEC-023 compress the view, not the record)", () => {
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      toolMsg("old", REPEAT(600)),
      { role: "assistant", content: "last" },
    ];
    const snapshot = JSON.parse(JSON.stringify(messages)) as ModelMessageT[];
    runDeterministicPass({
      messages,
      budgetTokens: 50,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });
    expect(messages).toEqual(snapshot); // input untouched
  });

  it("compresses aged large assistant tool-call arguments after the paired result exists", () => {
    const command = hugeCommand();
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      assistantToolCall("args-1", command),
      toolMsg("args-1", "ok"),
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 500,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_soft",
    });

    const assistant = r.messages[1]!;
    const call = assistant.role === "assistant" ? assistant.toolCalls![0]! : undefined;
    expect(call?.id).toBe("args-1");
    expect(call?.name).toBe("bash");
    expect(call?.args["cwd"]).toBe("/app");
    const compactedCommand = call?.args["command"];
    if (typeof compactedCommand !== "string") {
      throw new Error("expected compacted command to remain a string");
    }
    expect(compactedCommand).toContain("[keel: tool-call argument compressed");
    expect(compactedCommand).toContain("python - <<'PY'");
    expect(compactedCommand.length).toBeLessThan(command.length);
    expect(r.messages[2]).toEqual(messages[2]);
    expect(r.event).not.toBeNull();
    expect(r.event!.items.some((item) => item.name === "tool-call-args:bash")).toBe(true);
    expect(r.event!.tokensAfter).toBeLessThan(r.event!.tokensBefore);
    expect(r.event!.tokensAfter).toBe(estimateMessagesTokens(r.messages));
    expect(messages[1]).toEqual(assistantToolCall("args-1", command));
  });

  it("compresses nested array string arguments while preserving primitive leaves", () => {
    const command = hugeCommand();
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "nested-args",
            name: "write",
            args: { chunks: [command, "short"], retries: 2 },
          },
        ],
      },
      { role: "tool", name: "write", toolCallId: "nested-args", content: "ok" },
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 500,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });

    const assistant = r.messages[1]!;
    const call = assistant.role === "assistant" ? assistant.toolCalls![0]! : undefined;
    const chunks = call?.args["chunks"];
    if (!Array.isArray(chunks)) {
      throw new Error("expected chunks to remain an array");
    }
    expect(chunks[0]).toContain("[keel: tool-call argument compressed");
    expect(chunks[1]).toBe("short");
    expect(call?.args["retries"]).toBe(2);
  });

  it("records an ordered input range when both tool-call args and the paired result body compress", () => {
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      assistantToolCall("both", hugeCommand()),
      toolMsg("both", REPEAT(800)),
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 500,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });

    expect(r.event).not.toBeNull();
    expect(r.event!.inputRange).toEqual({ from: 1, to: 2 });
    expect(r.event!.items.some((item) => item.name === "bash")).toBe(true);
    expect(r.event!.items.some((item) => item.name === "tool-call-args:bash")).toBe(true);
  });

  it("skips opaque MCP tool-call arguments because the ledger may intentionally omit them", () => {
    const command = hugeCommand();
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "mcp-args", name: "mcp__fixture__echo", args: { secretSizedPayload: command } },
        ],
      },
      { role: "tool", name: "mcp__fixture__echo", toolCallId: "mcp-args", content: "ok" },
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 500,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });

    expect(r.event).toBeNull();
    expect(r.messages).toEqual(messages);
  });

  it("does not compress assistant tool-call arguments without a paired tool result", () => {
    const command = hugeCommand();
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      assistantToolCall("open-call", command),
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 500,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });

    expect(r.event).toBeNull();
    expect(r.messages).toEqual(messages);
  });

  it("does not treat an earlier malformed tool result as a valid pair for argument compaction", () => {
    const command = hugeCommand();
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      toolMsg("out-of-order", "ok"),
      assistantToolCall("out-of-order", command),
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 500,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });

    expect(r.event).toBeNull();
    expect(r.messages).toEqual(messages);
  });

  it("does not compress assistant tool-call arguments when duplicate call ids make pairing ambiguous", () => {
    const command = hugeCommand();
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "dup", name: "bash", args: { command } },
          { id: "dup", name: "bash", args: { command } },
        ],
      },
      toolMsg("dup", "ok"),
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 500,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });

    expect(r.event).toBeNull();
    expect(r.messages).toEqual(messages);
  });

  it("does not compress assistant tool-call arguments inside the recent-verbatim window", () => {
    const command = hugeCommand();
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      assistantToolCall("recent-args", command),
      toolMsg("recent-args", "ok"),
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 500,
      headroomTokens: 0,
      recentVerbatimTurns: 3,
      trigger: "token_hard",
    });

    expect(r.event).toBeNull();
    expect(r.messages).toEqual(messages);
  });

  it("keeps arguments for nonzero exit-code results even without error keywords", () => {
    const command = hugeCommand();
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      assistantToolCall("exit-code", command),
      toolMsg("exit-code", "[exit code: 2]"),
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 500,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });

    expect(r.event).toBeNull();
    expect(r.messages).toEqual(messages);
  });

  it("keeps arguments for synthetic interrupted tool results", () => {
    const command = hugeCommand();
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      assistantToolCall("interrupted", command),
      toolMsg("interrupted", "[interrupted: the tool did not complete before the session ended]"),
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 500,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });

    expect(r.event).toBeNull();
    expect(r.messages).toEqual(messages);
  });

  it("skips wide argument objects that remain too large after bounded leaf compaction", () => {
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "wide",
            name: "write",
            args: Object.fromEntries(
              Array.from({ length: 10 }, (_, i) => [`chunk${String(i)}`, hugeCommand()]),
            ),
          },
        ],
      },
      { role: "tool", name: "write", toolCallId: "wide", content: "ok" },
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 500,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });

    expect(r.event).toBeNull();
    expect(r.messages).toEqual(messages);
  });

  it("skips argument objects that exceed the bounded string-compaction cap", () => {
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "too-many-strings",
            name: "write",
            args: {
              chunks: Array.from({ length: 17 }, () => hugeCommand()),
            },
          },
        ],
      },
      { role: "tool", name: "write", toolCallId: "too-many-strings", content: "ok" },
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 500,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });

    expect(r.event).toBeNull();
    expect(r.messages).toEqual(messages);
  });

  it("skips cyclic argument objects at the bounded precheck", () => {
    const chunks: unknown[] = [hugeCommand()];
    chunks.push(chunks);
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "cyclic", name: "write", args: { chunks: chunks as never } }],
      },
      { role: "tool", name: "write", toolCallId: "cyclic", content: "ok" },
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 500,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });

    expect(r.event).toBeNull();
    expect(r.messages).toEqual(messages);
  });

  it("keeps arguments for a paired tool call whose result still carries error context", () => {
    const command = hugeCommand();
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      assistantToolCall("errored", command),
      toolMsg("errored", "ERROR: command failed"),
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 500,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });

    expect(r.event).toBeNull();
    expect(r.messages).toEqual(messages);
  });

  it("preserves provider tool-call/result serialization invariants after argument compaction", () => {
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      assistantToolCall("sdk-args", hugeCommand()),
      toolMsg("sdk-args", "ok"),
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 500,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });
    const sdk = toSdkMessages(r.messages);

    expect(sdk[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "sdk-args", toolName: "bash" }],
    });
    expect(sdk[2]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "sdk-args", toolName: "bash" }],
    });
    const input = (sdk[1] as { content: Array<{ input?: { command?: string } }> }).content[0]
      ?.input;
    expect(input?.command).toContain("[keel: tool-call argument compressed");
  });

  it("preserves order and provider linkage for multi-call turns when only one call's args compact", () => {
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "small", name: "bash", args: { command: "pwd" } },
          { id: "large", name: "bash", args: { command: hugeCommand() } },
        ],
      },
      toolMsg("small", "ok"),
      toolMsg("large", "ok"),
      { role: "assistant", content: "last" },
    ];

    const r = runDeterministicPass({
      messages,
      budgetTokens: 500,
      headroomTokens: 0,
      recentVerbatimTurns: 1,
      trigger: "token_hard",
    });
    const sdk = toSdkMessages(r.messages);

    expect(sdk[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "small", toolName: "bash", input: { command: "pwd" } },
        { type: "tool-call", toolCallId: "large", toolName: "bash" },
      ],
    });
    expect(sdk[2]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "small", toolName: "bash" }],
    });
    expect(sdk[3]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "large", toolName: "bash" }],
    });
    const largeInput = (sdk[1] as { content: Array<{ input?: { command?: string } }> }).content[1]
      ?.input;
    expect(largeInput?.command).toContain("[keel: tool-call argument compressed");
  });
});
