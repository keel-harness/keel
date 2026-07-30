import { describe, expect, it } from "vitest";
import * as shared from "../index.js";
import { JUNK, assertRejects, assertWireRoundTrips } from "../testing/property.js";
import { Recording, RecordedTurn, type RecordingT } from "./recording.js";

describe("Recording wire schema (ADR-0031 — full-fidelity record format)", () => {
  it("survives a JSON wire round-trip (file/process boundary)", () => {
    // The recording persists to disk and is read back by @keel/eval / the
    // Phase-2 calibration harness, so it must be byte-stable over JSON.
    assertWireRoundTrips(Recording);
    assertWireRoundTrips(RecordedTurn);
  });

  it("parses a hand-built valid recording covering several chunk types", () => {
    const value: RecordingT = {
      version: 1,
      provider: "anthropic",
      model: "claude-opus-4-8",
      turns: [
        {
          chunks: [
            { type: "text-delta", text: "Hel" },
            { type: "text-delta", text: "lo" },
            { type: "reasoning-delta", text: "thinking" },
            { type: "tool-call", id: "call_0_0", name: "bash", args: { command: "ls" } },
            { type: "finish", reason: "tool-calls", usage: { inputTokens: 12, outputTokens: 7 } },
          ],
          timings: [0, 3, 5, 9, 12],
        },
        {
          // A turn whose only chunk is its terminal finish (usage lives here).
          chunks: [{ type: "finish", reason: "stop", usage: { inputTokens: 4, outputTokens: 1 } }],
        },
      ],
    };
    const parsed = Recording.parse(value);
    expect(parsed).toEqual(value);
    // Usage is read from the terminal finish chunk (not a denormalized field).
    const last = parsed.turns[0]?.chunks.at(-1);
    expect(last).toEqual({
      type: "finish",
      reason: "tool-calls",
      usage: { inputTokens: 12, outputTokens: 7 },
    });
  });

  it("rejects malformed recordings", () => {
    assertRejects(Recording, [
      ...JUNK,
      // wrong version (only literal 1 allowed)
      { version: 2, provider: "anthropic", model: "m", turns: [] },
      // empty provider label
      { version: 1, provider: "", model: "m", turns: [] },
      // empty model label
      { version: 1, provider: "anthropic", model: "", turns: [] },
      // strict: unknown top-level key
      { version: 1, provider: "anthropic", model: "m", turns: [], extra: 1 },
      // a turn carrying a non-JSON-safe tool-call arg (NaN) — JsonObject rejects it
      {
        version: 1,
        provider: "anthropic",
        model: "m",
        turns: [
          { chunks: [{ type: "tool-call", id: "c", name: "bash", args: { x: Number.NaN } }] },
        ],
      },
      // a chunk with an unknown discriminator
      {
        version: 1,
        provider: "anthropic",
        model: "m",
        turns: [{ chunks: [{ type: "wat" }] }],
      },
      // timings of the wrong element type (string, not number)
      {
        version: 1,
        provider: "anthropic",
        model: "m",
        turns: [{ chunks: [{ type: "text-delta", text: "x" }], timings: ["0"] }],
      },
      // timings with a non-JSON-safe value (Infinity serialises to null over the wire)
      {
        version: 1,
        provider: "anthropic",
        model: "m",
        turns: [{ chunks: [{ type: "text-delta", text: "x" }], timings: [Infinity] }],
      },
      // timings with a negative offset (a wall-clock delta is never negative)
      {
        version: 1,
        provider: "anthropic",
        model: "m",
        turns: [{ chunks: [{ type: "text-delta", text: "x" }], timings: [-1] }],
      },
    ]);
  });

  it("rejects malformed RecordedTurns directly", () => {
    assertRejects(RecordedTurn, [
      ...JUNK,
      // missing chunks
      { timings: [0] },
      // strict: unknown key
      { chunks: [], extra: true },
      // chunks not an array
      { chunks: 7 },
    ]);
  });

  it("is re-exported from the package barrel", () => {
    for (const n of ["Recording", "RecordedTurn"]) {
      expect(n in shared).toBe(true);
    }
  });
});
