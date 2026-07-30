import { describe, expect, it } from "vitest";
import * as shared from "../index.js";
import {
  JUNK,
  assertRejects,
  assertRoundTrips,
  assertWireRoundTrips,
} from "../testing/property.js";
import {
  FinishReason,
  ModelMessage,
  ModelRole,
  ModelStreamChunk,
  ModelUsage,
  ToolSpec,
  type ModelTurnInput,
} from "./model-port.js";

describe("ModelPort wire types (ADR-0002 — keel-owned, frozen before Phase 1)", () => {
  it("pins the enums", () => {
    expect(ModelRole.options).toEqual(["system", "user", "assistant", "tool"]);
    expect(FinishReason.options).toEqual(["stop", "tool-calls", "length", "error", "aborted"]);
  });

  it("round-trips messages, tools, usage, and every chunk variant", () => {
    for (const s of [ModelMessage, ToolSpec, ModelUsage, ModelStreamChunk]) assertRoundTrips(s);
    expect(ModelStreamChunk.parse({ type: "text-delta", text: "hi" })).toBeTruthy();
    expect(
      ModelStreamChunk.parse({
        type: "tool-call",
        id: "call_0_0",
        name: "bash",
        args: { command: "ls" },
      }),
    ).toBeTruthy();
    expect(
      ModelStreamChunk.parse({
        type: "finish",
        reason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 2 },
      }),
    ).toBeTruthy();
    expect(
      ModelStreamChunk.parse({ type: "error", code: "malformed-chunk", message: "x" }),
    ).toBeTruthy();
    // additive-optional cachedInputTokens (ADR-0044): a record WITH it parses, and the subset is kept.
    expect(
      ModelStreamChunk.parse({
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 100, outputTokens: 2, cachedInputTokens: 90 },
      }),
    ).toMatchObject({ usage: { cachedInputTokens: 90 } });
    // additive-optional cacheCreationInputTokens (ADR-0047, the cache-WRITE subset): parses + kept.
    expect(
      ModelStreamChunk.parse({
        type: "finish",
        reason: "stop",
        usage: {
          inputTokens: 100,
          outputTokens: 2,
          cachedInputTokens: 80,
          cacheCreationInputTokens: 12,
        },
      }),
    ).toMatchObject({ usage: { cacheCreationInputTokens: 12 } });
  });

  it("rejects malformed chunks and messages", () => {
    assertRejects(ModelStreamChunk, [
      ...JUNK,
      { type: "text-delta" }, // missing text
      { type: "tool-call", id: "x", name: "bash" }, // missing args
      { type: "tool-call", id: "", name: "bash", args: {} }, // empty id
      { type: "finish", reason: "nope", usage: { inputTokens: 0, outputTokens: 0 } }, // bad reason
      { type: "finish", reason: "stop", usage: { inputTokens: -1, outputTokens: 0 } }, // negative
      // negative cachedInputTokens — the additive optional field is bounds-checked like its siblings
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: -1 },
      },
      // negative cacheCreationInputTokens — same bounds check (ADR-0047)
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: -1 },
      },
      { type: "wat" }, // unknown discriminator
    ]);
    assertRejects(ModelMessage, [
      ...JUNK,
      { role: "robot", content: "x" }, // bad role
      { role: "user" }, // missing content
      { role: "user", content: "x", extra: 1 }, // strict: unknown key
    ]);
  });

  it("is re-exported from the package barrel", () => {
    for (const n of [
      "ModelRole",
      "ModelMessage",
      "ToolSpec",
      "FinishReason",
      "ModelUsage",
      "ModelStreamChunk",
    ]) {
      expect(n in shared).toBe(true);
    }
  });

  // ── ADR-0019: ModelPort pre-freeze refinements ────────────────────────────

  it("ModelMessage accepts an optional toolCalls array on assistant turns (F)", () => {
    // with toolCalls
    expect(
      ModelMessage.parse({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_0_0", name: "bash", args: { command: "ls" } }],
      }),
    ).toBeTruthy();
    // without toolCalls (backward compat)
    expect(ModelMessage.parse({ role: "assistant", content: "hello" })).toBeTruthy();
    // round-trips still hold (fast-check generates optional fields)
    assertRoundTrips(ModelMessage);
  });

  it("ModelMessage rejects malformed toolCalls (F)", () => {
    assertRejects(ModelMessage, [
      // empty id in a tool call
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "", name: "bash", args: {} }],
      },
      // empty name in a tool call
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_0_0", name: "", args: {} }],
      },
      // unknown key in a toolCall entry (strict)
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_0_0", name: "bash", args: {}, extra: true }],
      },
    ]);
  });

  it("ModelStreamChunk accepts reasoning-delta and tool-call-delta variants (L)", () => {
    // reasoning-delta
    expect(
      ModelStreamChunk.parse({ type: "reasoning-delta", text: "thinking about it" }),
    ).toBeTruthy();
    // tool-call-delta with name (first delta)
    expect(
      ModelStreamChunk.parse({
        type: "tool-call-delta",
        id: "call_0_0",
        name: "bash",
        argsTextDelta: '{"comm',
      }),
    ).toBeTruthy();
    // tool-call-delta without name (subsequent delta)
    expect(
      ModelStreamChunk.parse({
        type: "tool-call-delta",
        id: "call_0_0",
        argsTextDelta: 'and: "ls"}',
      }),
    ).toBeTruthy();
    // round-trips still hold for the full discriminated union
    assertRoundTrips(ModelStreamChunk);
  });

  it("ModelStreamChunk rejects malformed reasoning-delta and tool-call-delta (L)", () => {
    assertRejects(ModelStreamChunk, [
      // reasoning-delta missing text
      { type: "reasoning-delta" },
      // reasoning-delta unknown key (strict)
      { type: "reasoning-delta", text: "t", extra: 1 },
      // tool-call-delta empty id
      { type: "tool-call-delta", id: "", argsTextDelta: "{}" },
      // tool-call-delta missing id
      { type: "tool-call-delta", argsTextDelta: "{}" },
      // tool-call-delta empty name (when present, must be non-empty)
      { type: "tool-call-delta", id: "call_0_0", name: "", argsTextDelta: "{}" },
      // tool-call-delta missing argsTextDelta
      { type: "tool-call-delta", id: "call_0_0" },
      // tool-call-delta unknown key (strict)
      { type: "tool-call-delta", id: "call_0_0", argsTextDelta: "{}", extra: true },
    ]);
  });

  // ── ADR-0019 extension: per-turn generation-params seam + JSON-safe args ──

  it("ModelTurnInput accepts an optional params field (I5 — typecheck seam)", () => {
    // This test asserts that ModelTurnInput type-checks with all params sub-fields
    // and that the simulator (ScriptedModel) silently ignores them (the params
    // field is a seam for Phase-1 adapters, not consumed by the simulator).

    // All sub-fields populated — must type-check
    const full: ModelTurnInput = {
      messages: [{ role: "user", content: "hello" }],
      params: {
        reasoningEffort: "high",
        temperature: 1,
        model: "claude-opus-4-5",
        maxOutputTokens: 4096,
      },
    };
    expect(full.params?.reasoningEffort).toBe("high");
    expect(full.params?.temperature).toBe(1);
    expect(full.params?.model).toBe("claude-opus-4-5");
    expect(full.params?.maxOutputTokens).toBe(4096);

    // Each effort level
    const low: ModelTurnInput = { messages: [], params: { reasoningEffort: "low" } };
    const med: ModelTurnInput = { messages: [], params: { reasoningEffort: "medium" } };
    const high: ModelTurnInput = { messages: [], params: { reasoningEffort: "high" } };
    expect(low.params?.reasoningEffort).toBe("low");
    expect(med.params?.reasoningEffort).toBe("medium");
    expect(high.params?.reasoningEffort).toBe("high");

    // Omitted entirely (backward compat)
    const bare: ModelTurnInput = { messages: [{ role: "user", content: "x" }] };
    expect(bare.params).toBeUndefined();
  });

  it("ModelStreamChunk tool-call args are JSON-safe (C3 wire round-trip)", () => {
    assertWireRoundTrips(ModelStreamChunk);
  });

  it("ModelMessage toolCalls args are JSON-safe (C3 wire round-trip)", () => {
    assertWireRoundTrips(ModelMessage);
  });

  it("tool-call chunk rejects non-JSON-safe args values", () => {
    // NaN and Infinity are not JSON-safe — the JsonObject constraint must reject them.
    // We verify this by ensuring the schema rejects objects with symbol keys or
    // non-JSON-safe values embedded via plain object literals that pass through z.unknown().
    // Since JsonValue rejects non-finite numbers at the zod level, we can test via safeParse.
    const chunkWithNaN = {
      type: "tool-call",
      id: "call_0_0",
      name: "bash",
      args: { command: "ls", badNum: Number.NaN },
    };
    expect(ModelStreamChunk.safeParse(chunkWithNaN).success).toBe(false);

    const chunkWithInfinity = {
      type: "tool-call",
      id: "call_0_0",
      name: "bash",
      args: { command: "ls", badNum: Infinity },
    };
    expect(ModelStreamChunk.safeParse(chunkWithInfinity).success).toBe(false);
  });

  it("ModelMessage toolCalls rejects non-JSON-safe args values", () => {
    const msgWithNaN = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_0_0", name: "bash", args: { x: Number.NaN } }],
    };
    expect(ModelMessage.safeParse(msgWithNaN).success).toBe(false);

    const msgWithInfinity = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_0_0", name: "bash", args: { x: Infinity } }],
    };
    expect(ModelMessage.safeParse(msgWithInfinity).success).toBe(false);
  });
});
