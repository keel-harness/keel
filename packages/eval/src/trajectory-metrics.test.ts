import { describe, expect, it } from "vitest";
import { aggregateQualityMetrics, trajectoryQualityMetrics } from "./trajectory-metrics.js";
import type { TrajectoryEventT, TrajectoryT } from "./trajectory.js";

const usage = { inputTokens: 10, outputTokens: 5 };
function traj(events: TrajectoryEventT[], totals?: Partial<TrajectoryT["totals"]>): TrajectoryT {
  return {
    schemaVersion: 1,
    runId: "r",
    task: "t",
    suite: "terminal-bench-2",
    model: "m",
    startedAt: "2026-06-16T00:00:00.000Z",
    events,
    outcome: "resolved",
    totals: {
      turns: 1,
      toolCalls: 0,
      wallClockMs: 0,
      inputTokens: 100,
      outputTokens: 40,
      ...totals,
    },
  };
}

describe("trajectoryQualityMetrics (§8.2)", () => {
  it("derives every metric, including duplicate calls and a compaction event", () => {
    const m = trajectoryQualityMetrics(
      traj(
        [
          { type: "tool-call", id: "1", name: "read", args: { path: "a" }, argsValid: true },
          { type: "tool-result", id: "1", ok: true, content: "x" },
          // a duplicate read (same name+args) — redundant
          { type: "tool-call", id: "2", name: "read", args: { path: "a" }, argsValid: true },
          { type: "tool-result", id: "2", ok: true, content: "x" },
          // an invalid-args call
          { type: "tool-call", id: "3", name: "bash", args: { command: "x" }, argsValid: false },
          { type: "tool-result", id: "3", ok: false, content: "boom" },
          { type: "completion-attempt", accepted: false, intercepted: true },
          { type: "compaction", beforeTokens: 9000, afterTokens: 3000 },
          { type: "turn", index: 0, reason: "stop", usage, wallClockMs: 0 },
        ],
        { turns: 1, wallClockMs: 1234, inputTokens: 500, outputTokens: 200 },
      ),
    );
    expect(m.toolCalls).toBe(3);
    expect(m.toolCallArgValidityRate).toBeCloseTo(2 / 3);
    expect(m.redundantToolCalls).toBe(1);
    expect(m.toolErrors).toBe(1);
    expect(m.prematureCompletionIntercepts).toBe(1);
    expect(m.completionAttempts).toBe(1);
    expect(m.compactions).toBe(1);
    expect(m.wallClockMs).toBe(1234);
    expect(m.inputTokens).toBe(500);
    expect(m.outputTokens).toBe(200);
  });

  it("error→recovery: an error followed by a later success counts as recovered", () => {
    const m = trajectoryQualityMetrics(
      traj([
        { type: "tool-call", id: "1", name: "bash", args: { c: "1" }, argsValid: true },
        { type: "tool-result", id: "1", ok: false, content: "e" },
        { type: "tool-call", id: "2", name: "bash", args: { c: "2" }, argsValid: true },
        { type: "tool-result", id: "2", ok: true, content: "ok" },
      ]),
    );
    expect(m.toolErrors).toBe(1);
    expect(m.errorRecoveryRate).toBe(1); // the single error was recovered
  });

  it("error→recovery: a trailing unrecovered error lowers the rate (cascade)", () => {
    const m = trajectoryQualityMetrics(
      traj([
        { type: "tool-call", id: "1", name: "bash", args: { c: "1" }, argsValid: true },
        { type: "tool-result", id: "1", ok: false, content: "e1" },
        { type: "tool-call", id: "2", name: "bash", args: { c: "2" }, argsValid: true },
        { type: "tool-result", id: "2", ok: false, content: "e2" },
      ]),
    );
    expect(m.toolErrors).toBe(2);
    expect(m.errorRecoveryRate).toBe(0); // neither error recovered
  });

  it("no tool calls / no errors → rates default to 1.0", () => {
    const m = trajectoryQualityMetrics(traj([{ type: "assistant-text", text: "hi" }]));
    expect(m.toolCalls).toBe(0);
    expect(m.toolCallArgValidityRate).toBe(1);
    expect(m.errorRecoveryRate).toBe(1);
  });
});

describe("aggregateQualityMetrics", () => {
  it("means rates, totals counts across a run", () => {
    const a = traj([
      { type: "tool-call", id: "1", name: "read", args: { p: "a" }, argsValid: true },
      { type: "tool-result", id: "1", ok: true, content: "x" },
    ]);
    const b = traj(
      [
        { type: "tool-call", id: "1", name: "bash", args: { c: "1" }, argsValid: false },
        { type: "tool-result", id: "1", ok: false, content: "e" },
      ],
      { toolCalls: 1 },
    );
    const agg = aggregateQualityMetrics([a, b]);
    expect(agg.nTrajectories).toBe(2);
    expect(agg.meanToolCalls).toBe(1);
    expect(agg.totalToolErrors).toBe(1);
    // a: validity 1.0, b: validity 0.0 → mean 0.5
    expect(agg.meanToolCallArgValidityRate).toBe(0.5);
  });

  it("sums compactions across the run (the §8.2 context-pollution signal at run level)", () => {
    const withCompaction = traj([{ type: "compaction", beforeTokens: 9000, afterTokens: 3000 }]);
    const agg = aggregateQualityMetrics([withCompaction, withCompaction, traj([])]);
    expect(agg.totalCompactions).toBe(2);
  });

  it("empty run → zeros with rates at 1.0 (no observed degradation)", () => {
    const agg = aggregateQualityMetrics([]);
    expect(agg.nTrajectories).toBe(0);
    expect(agg.meanToolCallArgValidityRate).toBe(1);
    expect(agg.meanErrorRecoveryRate).toBe(1);
    expect(agg.totalToolErrors).toBe(0);
    expect(agg.totalCompactions).toBe(0);
  });
});
