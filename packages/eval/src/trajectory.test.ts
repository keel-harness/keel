import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { JUNK, assertRejects, assertRoundTrips } from "@keel/shared/testing";
import { Trajectory, TrajectoryEvent } from "./trajectory.js";

const VALID = {
  schemaVersion: 1,
  runId: "run_0001",
  task: "tb2-task-01",
  suite: "terminal-bench-2",
  model: "<PINNED_MODEL_ID>",
  startedAt: "2026-06-12T00:00:00.000Z",
  events: [
    { type: "message", role: "user", content: "do the task" },
    { type: "tool-call", id: "call_0_0", name: "bash", args: { command: "ls" }, argsValid: true },
    { type: "tool-result", id: "call_0_0", ok: true, content: "a.txt" },
    {
      type: "turn",
      index: 0,
      reason: "tool-calls",
      usage: { inputTokens: 1, outputTokens: 2 },
      wallClockMs: 0,
    },
    { type: "completion-attempt", accepted: true, intercepted: false },
  ],
  outcome: "resolved",
  totals: { turns: 1, toolCalls: 1, wallClockMs: 0, inputTokens: 1, outputTokens: 2 },
};

describe("Trajectory schema (§8.2 substrate)", () => {
  it("round-trips a full trajectory", () => {
    expect(Trajectory.parse(VALID)).toEqual(VALID);
  });

  it("accepts every event variant", () => {
    for (const e of VALID.events) expect(TrajectoryEvent.parse(e)).toBeTruthy();
    expect(TrajectoryEvent.parse({ type: "assistant-text", text: "thinking" })).toBeTruthy();
    // context-discipline boundary (the §8.2 context-window-pollution substrate)
    expect(
      TrajectoryEvent.parse({ type: "compaction", beforeTokens: 8000, afterTokens: 2000 }),
    ).toBeTruthy();
  });

  it("rejects malformed trajectories and events", () => {
    expect(() => Trajectory.parse({ ...VALID, schemaVersion: 2 })).toThrow(ZodError);
    expect(() => Trajectory.parse({ ...VALID, outcome: "ok" })).toThrow(ZodError);
    expect(() => Trajectory.parse({ ...VALID, extra: 1 })).toThrow(ZodError); // strict
    expect(() => TrajectoryEvent.parse({ type: "message", role: "robot", content: "x" })).toThrow(
      ZodError,
    ); // role enum
    expect(() => TrajectoryEvent.parse({ type: "tool-call", id: "x", name: "bash" })).toThrow(
      ZodError,
    ); // missing args/argsValid
    expect(() =>
      TrajectoryEvent.parse({ type: "compaction", beforeTokens: -1, afterTokens: 0 }),
    ).toThrow(ZodError); // negative tokens
    expect(() => TrajectoryEvent.parse({ type: "nope" })).toThrow(ZodError);
  });

  it("round-trips any generated valid TrajectoryEvent (property)", () => {
    assertRoundTrips(TrajectoryEvent);
  });

  it("round-trips any generated valid Trajectory (property)", () => {
    assertRoundTrips(Trajectory);
  });

  it("rejects JUNK and schema-specific malformed TrajectoryEvent inputs (property)", () => {
    assertRejects(TrajectoryEvent, [
      ...JUNK,
      // Unknown type discriminant
      { type: "nope" },
      { type: "unknown-event" },
      // message: invalid role
      { type: "message", role: "robot", content: "x" },
      { type: "message", role: "system", content: 42 },
      // tool-call: missing required fields
      { type: "tool-call", id: "x", name: "bash" }, // missing args + argsValid
      { type: "tool-call", id: "", name: "bash", args: {}, argsValid: true }, // empty id
      { type: "tool-call", id: "x", name: "", args: {}, argsValid: true }, // empty name
      // tool-result: missing content
      { type: "tool-result", id: "x", ok: true },
      { type: "tool-result", id: "", ok: true, content: "x" }, // empty id
      // turn: negative index
      {
        type: "turn",
        index: -1,
        reason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
        wallClockMs: 0,
      },
      // turn: unknown reason
      {
        type: "turn",
        index: 0,
        reason: "yolo",
        usage: { inputTokens: 0, outputTokens: 0 },
        wallClockMs: 0,
      },
      // compaction: negative tokens
      { type: "compaction", beforeTokens: -1, afterTokens: 0 },
      { type: "compaction", beforeTokens: 0, afterTokens: -5 },
      // completion-attempt: extra field (strict)
      { type: "completion-attempt", accepted: true, intercepted: false, extra: 1 },
    ]);
  });

  it("rejects JUNK and schema-specific malformed Trajectory inputs (property)", () => {
    assertRejects(Trajectory, [
      ...JUNK,
      // Wrong schemaVersion
      { ...VALID, schemaVersion: 2 },
      { ...VALID, schemaVersion: 0 },
      // Invalid outcome
      { ...VALID, outcome: "ok" },
      { ...VALID, outcome: "failed" },
      // Extra field (strict)
      { ...VALID, extra: 1 },
      // Empty required strings
      { ...VALID, runId: "" },
      { ...VALID, task: "" },
      { ...VALID, suite: "" },
      { ...VALID, model: "" },
      // Invalid startedAt (not an ISO timestamp)
      { ...VALID, startedAt: "not-a-date" },
      { ...VALID, startedAt: "2026-06-12" }, // date-only, no time component
      // totals: negative values
      { ...VALID, totals: { ...VALID.totals, turns: -1 } },
      { ...VALID, totals: { ...VALID.totals, toolCalls: -1 } },
    ]);
  });
});
