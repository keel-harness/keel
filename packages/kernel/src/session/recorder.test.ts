import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessageT, ModelPort } from "@keel/shared";
import type { KernelEventT } from "../events.js";
import { KERNEL_STRINGS, budgetWarningMessage } from "../strings.js";
import { SessionStore, readSession } from "./store.js";
import { record } from "./recorder.js";
import { rebuild } from "./resume.js";
import { runAgentLoop } from "../loop.js";
import { R21_OVERSIZED_FINAL_ANSWER } from "../fixtures/r21-oversized-final-answer.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });
async function* toAsync<T>(xs: readonly T[]): AsyncIterable<T> {
  for (const x of xs) yield x;
}

describe("session recorder (text-only fold)", () => {
  it("ADR-0087: records exact original/prompt/rewrite ordering and final settlement metadata", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const contract = { version: 1 as const, maxWords: 250 };
    const kevents = [
      { type: "turn-started", turn: 1 },
      { type: "text-delta", text: "original answer" },
      {
        type: "final-answer-attempt",
        settlementId: "fas_record",
        attempt: "original",
        contract,
        decision: "rewrite",
        usage: { inputTokens: 8, outputTokens: 4 },
      },
      {
        type: "final-answer-rewrite-requested",
        settlementId: "fas_record",
        contract,
        prompt: "controller rewrite prompt",
      },
      { type: "turn-started", turn: 2 },
      { type: "text-delta", text: "rewrite answer" },
      {
        type: "final-answer-attempt",
        settlementId: "fas_record",
        attempt: "rewrite",
        contract,
        decision: "accepted",
        usage: { inputTokens: 4, outputTokens: 2 },
      },
      {
        type: "final-answer-settled",
        settlement: {
          settlementId: "fas_record",
          outcome: "accepted-rewrite",
          rewriteUsage: { inputTokens: 4, outputTokens: 2 },
        },
      },
      { type: "stop", reason: "model-stop" },
      { type: "run-finished", usage: { inputTokens: 12, outputTokens: 6 } },
    ] as unknown as KernelEventT[];

    for await (const ev of record(store, [{ role: "user", content: "task" }], toAsync(kevents))) {
      expect(ev).toBeDefined();
    }
    store.close();

    const events = readSession(store.id, e).events;
    expect(events.map((event) => event.type)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "run_status",
    ]);
    expect(events[1]).toMatchObject({
      content: "original answer",
      finalAnswer: {
        settlementId: "fas_record",
        kind: "attempt",
        attempt: "original",
        contract,
      },
    });
    expect(events[2]).toMatchObject({
      content: "controller rewrite prompt",
      finalAnswer: {
        settlementId: "fas_record",
        kind: "rewrite-prompt",
        contract,
      },
    });
    expect(events[3]).toMatchObject({
      content: "rewrite answer",
      finalAnswer: {
        settlementId: "fas_record",
        kind: "attempt",
        attempt: "rewrite",
        contract,
      },
    });
    expect(events[4]).toMatchObject({
      usage: { inputTokens: 12, outputTokens: 6 },
      finalAnswer: {
        settlementId: "fas_record",
        outcome: "accepted-rewrite",
        rewriteUsage: { inputTokens: 4, outputTokens: 2 },
      },
    });

    expect(rebuild(readSession(store.id, e)).messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("ADR-0087: same-process final carry and fresh-process rebuild retain the exact transaction", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    let request = 0;
    let finalMessages: readonly ModelMessageT[] = [];
    const model: ModelPort = {
      async *stream() {
        request += 1;
        if (request === 1) {
          yield { type: "text-delta", text: R21_OVERSIZED_FINAL_ANSWER };
          yield { type: "finish", reason: "stop", usage: { inputTokens: 80, outputTokens: 568 } };
          return;
        }
        yield { type: "text-delta", text: "Bounded architecture and test plan." };
        yield { type: "finish", reason: "stop", usage: { inputTokens: 90, outputTokens: 8 } };
      },
    };
    const stream = runAgentLoop(
      model,
      { execute: async () => ({ ok: false, output: "must not execute" }) },
      {
        messages: [{ role: "user", content: "task" }],
        finalAnswer: {
          contract: { version: 1, maxWords: 250 },
          originalInspectionCommand: `keel sessions answer ${store.id} --original`,
        },
        onFinalMessages: (messages) => {
          finalMessages = messages;
        },
      },
    );
    for await (const event of record(store, [{ role: "user", content: "task" }], stream)) {
      expect(event).toBeDefined();
    }
    store.close();

    const resumed = rebuild(readSession(store.id, e));
    expect(resumed.messages).toEqual(finalMessages);
    expect(resumed.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect([...resumed.finalAnswerOccurrences.values()].map((value) => value.kind)).toEqual([
      "attempt",
      "rewrite-prompt",
      "attempt",
    ]);
    expect([...resumed.finalAnswerSettlements.values()]).toEqual([
      expect.objectContaining({ outcome: "accepted-rewrite" }),
    ]);
  });

  it("folds a text-only run into user+assistant and tees every event", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const seed: ModelMessageT[] = [{ role: "user", content: "go" }];
    const kevents: KernelEventT[] = [
      { type: "run-started" },
      { type: "turn-started", turn: 1 },
      { type: "text-delta", text: "done" },
      { type: "stop", reason: "model-stop" },
      { type: "run-finished", usage: { inputTokens: 1, outputTokens: 2 } },
    ];
    const seen: string[] = [];
    for await (const ev of record(store, seed, toAsync(kevents))) seen.push(ev.type);
    store.close();
    expect(seen).toEqual(kevents.map((x) => x.type)); // passthrough tee
    const file = readSession(store.id, e);
    expect(file.events.map((x) => x.type)).toEqual(["user", "assistant", "run_status"]);
    expect(file.events[1]).toMatchObject({ content: "done" });
  });

  it("tees a tool-output-delta through but never persists it (Epic 1.5c — ephemeral live output)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const seed: ModelMessageT[] = [{ role: "user", content: "go" }];
    const kevents: KernelEventT[] = [
      { type: "run-started" },
      { type: "turn-started", turn: 1 },
      { type: "tool-call", id: "c0", name: "bash", args: {} },
      { type: "tool-output-delta", id: "c0", chunk: "compiling foo.ts" }, // ephemeral — NOT durable
      { type: "tool-result", id: "c0", ok: true, output: "done" },
      { type: "stop", reason: "model-stop" },
      { type: "run-finished", usage: { inputTokens: 1, outputTokens: 2 } },
    ];
    const seen: string[] = [];
    for await (const ev of record(store, seed, toAsync(kevents))) seen.push(ev.type);
    store.close();
    expect(seen).toEqual(kevents.map((x) => x.type)); // EVERY event teed, incl. tool-output-delta
    const file = readSession(store.id, e);
    // the durable ledger carries user + assistant(toolCalls) + tool_result + run_status — NO live line
    expect(file.events.map((x) => x.type)).toEqual([
      "user",
      "assistant",
      "tool_result",
      "run_status",
    ]);
    expect(JSON.stringify(file.events)).not.toContain("compiling foo.ts"); // never reaches disk
  });

  it("ADR-0087: tees final-answer drafting liveness without persisting a synthetic message", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const seed: ModelMessageT[] = [{ role: "user", content: "summarize" }];
    const kevents: KernelEventT[] = [
      { type: "run-started" },
      { type: "turn-started", turn: 1 },
      { type: "final-answer-buffering" },
      { type: "text-delta", text: "bounded answer" },
      { type: "stop", reason: "model-stop" },
      { type: "run-finished", usage: { inputTokens: 1, outputTokens: 2 } },
    ];
    const seen: string[] = [];

    for await (const ev of record(store, seed, toAsync(kevents))) seen.push(ev.type);
    store.close();

    expect(seen).toEqual(kevents.map((event) => event.type));
    const file = readSession(store.id, e);
    expect(file.events.map((event) => event.type)).toEqual(["user", "assistant", "run_status"]);
    expect(file.events[1]).toMatchObject({ content: "bounded answer" });
    expect(JSON.stringify(file.events)).not.toContain("final-answer-buffering");
  });

  it("records system and assistant seed messages in order", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const seed: ModelMessageT[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "prior" },
      { role: "user", content: "go" },
    ];
    for await (const ev of record(store, seed, toAsync<KernelEventT>([]))) expect(ev).toBeDefined();
    store.close();
    expect(readSession(store.id, e).events.map((x) => x.type)).toEqual([
      "system",
      "assistant",
      "user",
    ]);
  });

  it("omits opaque MCP tool args from assistant seed messages before writing session JSONL", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const seed: ModelMessageT[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c0", name: "mcp__fixture__echo", args: { token: "sk-test-secret" } },
          { id: "c1", name: "bash", args: { command: "echo ok" } },
        ],
      },
    ];
    for await (const ev of record(store, seed, toAsync<KernelEventT>([]))) expect(ev).toBeDefined();
    store.close();

    const assistant = readSession(store.id, e).events.find((x) => x.type === "assistant");
    expect(assistant).toMatchObject({
      toolCalls: [
        { id: "c0", name: "mcp__fixture__echo", args: { omitted: "opaque-mcp-args" } },
        { id: "c1", name: "bash", args: { command: "echo ok" } },
      ],
    });
    expect(
      readFileSync(join(e["KEEL_HOME"] as string, "sessions", `${store.id}.jsonl`), "utf8"),
    ).not.toContain("sk-test-secret");
  });

  it("records a tool-role seed message as a tool_result (resumed-session re-record)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const seed: ModelMessageT[] = [{ role: "tool", content: "out", toolCallId: "t", name: "bash" }];
    for await (const ev of record(store, seed, toAsync<KernelEventT>([]))) expect(ev).toBeDefined();
    store.close();
    const evs = readSession(store.id, e).events;
    expect(evs.map((x) => x.type)).toEqual(["tool_result"]);
    expect(evs[0]).toMatchObject({ toolCallId: "t", name: "bash", output: "out" });
  });

  it("records an orphan tool-result (no preceding tool-call) with name 'unknown'", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents: KernelEventT[] = [
      { type: "tool-result", id: "orphan", ok: true, output: "x" },
      { type: "run-finished", usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    for await (const ev of record(store, [], toAsync(kevents))) expect(ev).toBeDefined();
    store.close();
    const tr = readSession(store.id, e).events.find((x) => x.type === "tool_result");
    expect(tr).toMatchObject({ toolCallId: "orphan", name: "unknown", output: "x" });
  });

  it("folds a tool turn: assistant.toolCalls + tool_result with name-by-id", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents: KernelEventT[] = [
      { type: "turn-started", turn: 1 },
      { type: "text-delta", text: "plan" },
      { type: "tool-call", id: "call_0_0", name: "echo", args: { text: "a" } },
      { type: "tool-result", id: "call_0_0", ok: true, output: '{"text":"a"}' },
      { type: "turn-started", turn: 2 },
      { type: "text-delta", text: "done" },
      { type: "stop", reason: "model-stop" },
      { type: "run-finished", usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    for await (const ev of record(store, [{ role: "user", content: "go" }], toAsync(kevents)))
      expect(ev).toBeDefined();
    store.close();
    const evs = readSession(store.id, e).events;
    expect(evs.map((x) => x.type)).toEqual([
      "user",
      "assistant",
      "tool_result",
      "assistant",
      "run_status",
    ]);
    expect(evs[1]).toMatchObject({
      content: "plan",
      toolCalls: [{ id: "call_0_0", name: "echo", args: { text: "a" } }],
    });
    expect(evs[2]).toMatchObject({ toolCallId: "call_0_0", name: "echo", output: '{"text":"a"}' });
  });

  it("omits opaque MCP tool args from model-issued tool calls before writing session JSONL", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents: KernelEventT[] = [
      { type: "tool-call", id: "call_0_0", name: "mcp__fixture__echo", args: { token: "sk-test" } },
      { type: "tool-result", id: "call_0_0", ok: true, output: "ok" },
    ];
    for await (const ev of record(store, [], toAsync(kevents))) expect(ev).toBeDefined();
    store.close();

    const assistant = readSession(store.id, e).events.find((x) => x.type === "assistant");
    expect(assistant).toMatchObject({
      toolCalls: [
        { id: "call_0_0", name: "mcp__fixture__echo", args: { omitted: "opaque-mcp-args" } },
      ],
    });
    expect(
      readFileSync(join(e["KEEL_HOME"] as string, "sessions", `${store.id}.jsonl`), "utf8"),
    ).not.toContain("sk-test");
  });

  it("records a failed tool result with isError and the resolved name", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents: KernelEventT[] = [
      { type: "tool-call", id: "call_0_0", name: "boom", args: {} },
      { type: "tool-result", id: "call_0_0", ok: false, output: "kaboom" },
      { type: "stop", reason: "model-stop" },
      { type: "run-finished", usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    for await (const ev of record(store, [], toAsync(kevents))) expect(ev).toBeDefined();
    store.close();
    const tr = readSession(store.id, e).events.find((x) => x.type === "tool_result");
    expect(tr).toMatchObject({ name: "boom", output: "kaboom", isError: true });
  });

  it("records and rebuilds duplicate same-turn tool ids in occurrence order", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents: KernelEventT[] = [
      { type: "tool-call", id: "dup", name: "write", args: { path: "victim.txt" } },
      { type: "tool-call", id: "dup", name: "bash", args: { command: "rm -f victim.txt" } },
      { type: "tool-result", id: "dup", ok: false, output: "write was not executed" },
      { type: "tool-result", id: "dup", ok: false, output: "bash was not executed" },
      {
        type: "stop",
        reason: "error",
        code: "duplicate-tool-call-id",
        message: "provider emitted duplicate tool-call id 'dup'",
      },
      { type: "run-finished", usage: { inputTokens: 0, outputTokens: 0 } },
    ];

    for await (const ev of record(store, [{ role: "user", content: "go" }], toAsync(kevents)))
      expect(ev).toBeDefined();
    store.close();

    const file = readSession(store.id, e);
    const durableResults = file.events.filter((event) => event.type === "tool_result");
    expect(durableResults).toEqual([
      expect.objectContaining({
        toolCallId: "dup",
        name: "write",
        output: "write was not executed",
        isError: true,
      }),
      expect.objectContaining({
        toolCallId: "dup",
        name: "bash",
        output: "bash was not executed",
        isError: true,
      }),
    ]);

    const resumed = rebuild(file);
    expect(resumed.messages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "dup", name: "write", args: { path: "victim.txt" } },
          { id: "dup", name: "bash", args: { command: "rm -f victim.txt" } },
        ],
      },
      { role: "tool", content: "write was not executed", toolCallId: "dup", name: "write" },
      { role: "tool", content: "bash was not executed", toolCallId: "dup", name: "bash" },
    ]);
    expect(resumed.failedToolMessageIndexes).toEqual(new Set([2, 3]));
  });

  it("folds verification-requested into the injected user message (between assistants)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents: KernelEventT[] = [
      { type: "text-delta", text: "attempt" },
      { type: "verification-requested", prompt: "VERIFY NOW" },
      { type: "text-delta", text: "done" },
      { type: "stop", reason: "model-stop" },
      { type: "run-finished", usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    for await (const ev of record(store, [], toAsync(kevents))) expect(ev).toBeDefined();
    store.close();
    const evs = readSession(store.id, e).events;
    expect(evs.map((x) => x.type)).toEqual(["assistant", "user", "assistant", "run_status"]);
    expect(evs[0]).toMatchObject({ content: "attempt" });
    expect(evs[1]).toMatchObject({ content: "VERIFY NOW" });
    expect(evs[2]).toMatchObject({ content: "done" });
  });

  it("folds budget-warning into the injected user message", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents: KernelEventT[] = [
      { type: "budget-warning", usedTokens: 80, maxTokens: 100 },
      { type: "text-delta", text: "wrapping up" },
      { type: "stop", reason: "model-stop" },
      { type: "run-finished", usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    for await (const ev of record(store, [], toAsync(kevents))) expect(ev).toBeDefined();
    store.close();
    expect(readSession(store.id, e).events[0]).toMatchObject({
      type: "user",
      content: budgetWarningMessage(80, 100),
    });
  });

  it("folds a gross-runway warning into metric-specific controller guidance", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents = [
      {
        type: "budget-warning",
        metric: "gross",
        usedTokens: 80,
        maxTokens: 100,
      },
      { type: "stop", reason: "budget" },
      { type: "run-finished", usage: { inputTokens: 80, outputTokens: 0 } },
    ] as unknown as KernelEventT[];
    for await (const ev of record(store, [], toAsync(kevents))) expect(ev).toBeDefined();
    store.close();
    const recorded = readSession(store.id, e).events[0];
    expect(recorded?.type).toBe("user");
    expect(recorded?.type === "user" ? recorded.content : "").toMatch(
      /gross-token runway.*20 remaining.*fresh budgeted run/i,
    );
  });

  it("folds loop-detected into the injected guidance (default and custom)", async () => {
    const k = (): KernelEventT[] => [
      { type: "loop-detected", signal: "tool-repeat", detail: "echo" },
      { type: "stop", reason: "model-stop" },
      { type: "run-finished", usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    const e1 = env();
    const s1 = SessionStore.create({ cwd: "/w" }, e1);
    for await (const ev of record(s1, [], toAsync(k()))) expect(ev).toBeDefined();
    s1.close();
    expect(readSession(s1.id, e1).events[0]).toMatchObject({
      type: "user",
      content: KERNEL_STRINGS.loopGuidance,
    });

    const e2 = env();
    const s2 = SessionStore.create({ cwd: "/w" }, e2);
    for await (const ev of record(s2, [], toAsync(k()), { loopGuidance: "CUSTOM" }))
      expect(ev).toBeDefined();
    s2.close();
    expect(readSession(s2.id, e2).events[0]).toMatchObject({ type: "user", content: "CUSTOM" });
  });

  it("records loop guidance from the event, not a stale recorder config", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents: KernelEventT[] = [
      {
        type: "loop-detected",
        signal: "tool-repeat",
        detail: "echo",
        guidance: "EVENT GUIDANCE",
      },
      { type: "stop", reason: "model-stop" },
      { type: "run-finished", usage: { inputTokens: 0, outputTokens: 0 } },
    ];

    for await (const ev of record(store, [], toAsync(kevents), { loopGuidance: "STALE CONFIG" })) {
      expect(ev).toBeDefined();
    }
    store.close();

    expect(readSession(store.id, e).events[0]).toMatchObject({
      type: "user",
      content: "EVENT GUIDANCE",
    });
  });

  it("records run_status on run-finished with the stop reason + usage", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents: KernelEventT[] = [
      { type: "text-delta", text: "done" },
      { type: "stop", reason: "model-stop" },
      { type: "run-finished", usage: { inputTokens: 3, outputTokens: 4 } },
    ];
    for await (const ev of record(store, [], toAsync(kevents))) expect(ev).toBeDefined();
    store.close();
    const rs = readSession(store.id, e).events.find((x) => x.type === "run_status");
    expect(rs).toMatchObject({ reason: "model-stop", usage: { inputTokens: 3, outputTokens: 4 } });
  });

  it("records stop(error) code/message on run_status", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents: KernelEventT[] = [
      {
        type: "stop",
        reason: "error",
        code: "provider-400",
        message: "provider rejected malformed streamed args",
      },
      { type: "run-finished", usage: { inputTokens: 3, outputTokens: 4 } },
    ];
    for await (const ev of record(store, [], toAsync(kevents))) expect(ev).toBeDefined();
    store.close();

    const rs = readSession(store.id, e).events.find((x) => x.type === "run_status");
    expect(rs).toMatchObject({
      reason: "error",
      code: "provider-400",
      message: "provider rejected malformed streamed args",
      usage: { inputTokens: 3, outputTokens: 4 },
    });
  });

  it("records non-error stop code/message on run_status as terminal detail", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents: KernelEventT[] = [
      {
        type: "stop",
        reason: "model-stop",
        code: "REVIEW_REQUIRED_AFTER_SYNTHESIS",
        message: "answered from prior evidence; reviewed action was not executed",
      },
      { type: "run-finished", usage: { inputTokens: 3, outputTokens: 4 } },
    ];
    for await (const ev of record(store, [], toAsync(kevents))) expect(ev).toBeDefined();
    store.close();

    const rs = readSession(store.id, e).events.find((x) => x.type === "run_status");
    expect(rs).toMatchObject({
      reason: "model-stop",
      code: "REVIEW_REQUIRED_AFTER_SYNTHESIS",
      message: "answered from prior evidence; reviewed action was not executed",
      usage: { inputTokens: 3, outputTokens: 4 },
    });
  });

  it("does not record run_status if the stream ends without a stop", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents: KernelEventT[] = [
      { type: "text-delta", text: "partial" },
      { type: "run-finished", usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    for await (const ev of record(store, [], toAsync(kevents))) expect(ev).toBeDefined();
    store.close();
    expect(readSession(store.id, e).events.some((x) => x.type === "run_status")).toBe(false);
  });

  it("accumulates multiple text-deltas into one assistant event", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents: KernelEventT[] = [
      { type: "turn-started", turn: 1 },
      { type: "text-delta", text: "he" },
      { type: "text-delta", text: "llo" },
      { type: "stop", reason: "model-stop" },
      { type: "run-finished", usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    for await (const ev of record(store, [], toAsync(kevents))) expect(ev).toBeDefined();
    store.close();
    const file = readSession(store.id, e);
    expect(file.events.map((x) => x.type)).toEqual(["assistant", "run_status"]);
    expect(file.events[0]).toMatchObject({ content: "hello" });
  });
});
