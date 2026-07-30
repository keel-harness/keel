import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { JUNK, assertRejects, assertRoundTrips } from "@keel/shared/testing";
import {
  BenchmarkResult,
  ResultMismatchError,
  TaskResult,
  parseTerminalBenchResults,
} from "./results.js";

function fixture(name: string): unknown {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

describe("Terminal-Bench result parser", () => {
  it("parses an all-passing run", () => {
    const r = parseTerminalBenchResults(fixture("tb2-passing.json"));
    expect(r).toEqual(
      BenchmarkResult.parse({
        suite: "terminal-bench-2",
        nTasks: 2,
        nResolved: 2,
        nUnresolved: 0,
        resolvedRate: 1,
        tasks: [
          { taskId: "tb2-task-01", resolved: true, failureMode: null, trial: "trial-1" },
          { taskId: "tb2-task-02", resolved: true, failureMode: null, trial: "trial-1" },
        ],
      }),
    );
  });

  it("parses a mixed run with a failure mode and computes the resolved rate", () => {
    const r = parseTerminalBenchResults(fixture("tb2-mixed.json"));
    expect(r.nResolved).toBe(1);
    expect(r.nUnresolved).toBe(1);
    expect(r.resolvedRate).toBe(0.5);
    expect(r.tasks[1]?.failureMode).toBe("test_timeout");
  });

  it("derives counts when the run omits aggregates", () => {
    const r = parseTerminalBenchResults({
      results: [
        { task_id: "a", is_resolved: true },
        { task_id: "b", is_resolved: false },
      ],
    });
    expect(r.nResolved).toBe(1);
    expect(r.nUnresolved).toBe(1);
    expect(r.resolvedRate).toBe(0.5);
  });

  it("handles an empty run (no tasks) without dividing by zero", () => {
    const r = parseTerminalBenchResults({ results: [] });
    expect(r.nTasks).toBe(0);
    expect(r.nResolved).toBe(0);
    expect(r.nUnresolved).toBe(0);
    expect(r.resolvedRate).toBe(0);
    expect(r.tasks).toEqual([]);
  });

  it("rejects output that is not a terminal-bench results document", () => {
    expect(() => parseTerminalBenchResults({ foo: "bar" })).toThrow(ZodError);
    expect(() => parseTerminalBenchResults({ results: [{ task_id: 1 }] })).toThrow(ZodError);
  });

  it("throws ResultMismatchError (not ZodError) when n_resolved disagrees with per-task count", () => {
    const input = {
      n_resolved: 5,
      results: [
        { task_id: "a", is_resolved: true },
        { task_id: "b", is_resolved: false },
      ],
    };
    expect(() => parseTerminalBenchResults(input)).toThrow(ResultMismatchError);
    expect(() => parseTerminalBenchResults(input)).not.toThrow(ZodError);
    let caught: unknown;
    try {
      parseTerminalBenchResults(input);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ResultMismatchError);
    const msg = (caught as ResultMismatchError).message;
    // Message must name BOTH numbers: provided 5 vs derived 1
    expect(msg).toContain("5");
    expect(msg).toContain("1");
    expect((caught as ResultMismatchError).name).toBe("ResultMismatchError");
  });

  it("throws ResultMismatchError when accuracy disagrees with the derived resolvedRate", () => {
    // I8: accuracy is parsed but was silently discarded; it must now be reconciled against the
    // derived resolvedRate (the ground truth).  A mismatch beyond 1e-9 must throw.
    const input = {
      accuracy: 0.9, // disagrees: 1 of 2 tasks resolved → derived rate is 0.5
      results: [
        { task_id: "a", is_resolved: true },
        { task_id: "b", is_resolved: false },
      ],
    };
    expect(() => parseTerminalBenchResults(input)).toThrow(ResultMismatchError);
    let caught: unknown;
    try {
      parseTerminalBenchResults(input);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ResultMismatchError);
    const msg = (caught as ResultMismatchError).message;
    // Message must name BOTH the provided accuracy and the derived resolvedRate
    expect(msg).toContain("accuracy");
    expect(msg).toContain("resolvedRate");
    expect((caught as ResultMismatchError).name).toBe("ResultMismatchError");
  });

  it("accepts accuracy that agrees with the derived resolvedRate (within 1e-9)", () => {
    // The passing and mixed fixtures have agreeing accuracy values — they must still parse.
    expect(() => parseTerminalBenchResults(fixture("tb2-passing.json"))).not.toThrow();
    expect(() => parseTerminalBenchResults(fixture("tb2-mixed.json"))).not.toThrow();
    // Exact floating-point agreement
    const input = {
      accuracy: 0.5,
      results: [
        { task_id: "a", is_resolved: true },
        { task_id: "b", is_resolved: false },
      ],
    };
    expect(() => parseTerminalBenchResults(input)).not.toThrow();
  });

  it("throws ResultMismatchError when n_unresolved disagrees with per-task count", () => {
    const input = {
      n_unresolved: 99,
      results: [
        { task_id: "a", is_resolved: true },
        { task_id: "b", is_resolved: false },
      ],
    };
    let caught: unknown;
    try {
      parseTerminalBenchResults(input);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ResultMismatchError);
    const msg = (caught as ResultMismatchError).message;
    // Message must name BOTH numbers: provided 99 vs derived 1
    expect(msg).toContain("99");
    expect(msg).toContain("1");
  });

  it("satisfies ground-truth invariants on the passing fixture", () => {
    const r = parseTerminalBenchResults(fixture("tb2-passing.json"));
    expect(r.nResolved + r.nUnresolved).toBe(r.nTasks);
    expect(r.resolvedRate).toBe(r.nTasks === 0 ? 0 : r.nResolved / r.nTasks);
  });

  it("satisfies ground-truth invariants on the mixed fixture", () => {
    const r = parseTerminalBenchResults(fixture("tb2-mixed.json"));
    expect(r.nResolved + r.nUnresolved).toBe(r.nTasks);
    expect(r.resolvedRate).toBe(r.nTasks === 0 ? 0 : r.nResolved / r.nTasks);
  });

  it("round-trips any generated valid TaskResult (property)", () => {
    assertRoundTrips(TaskResult);
  });

  it("round-trips any generated valid BenchmarkResult (property)", () => {
    assertRoundTrips(BenchmarkResult);
  });

  it("rejects JUNK and schema-specific malformed TaskResult inputs (property)", () => {
    assertRejects(TaskResult, [
      ...JUNK,
      // missing required fields
      {},
      { taskId: "a" }, // missing resolved, failureMode, trial
      // taskId must be non-empty
      { taskId: "", resolved: true, failureMode: null, trial: null },
      // resolved must be boolean
      { taskId: "a", resolved: "yes", failureMode: null, trial: null },
      { taskId: "a", resolved: 1, failureMode: null, trial: null },
      // failureMode must be string or null (not undefined or number)
      { taskId: "a", resolved: true, failureMode: 42, trial: null },
      // trial must be string or null (not undefined or number)
      { taskId: "a", resolved: true, failureMode: null, trial: 0 },
      // extra field (strict)
      { taskId: "a", resolved: true, failureMode: null, trial: null, extra: 1 },
    ]);
  });

  it("rejects JUNK and schema-specific malformed BenchmarkResult inputs (property)", () => {
    assertRejects(BenchmarkResult, [
      ...JUNK,
      // missing required fields
      {},
      // suite must be non-empty string
      { suite: "", nTasks: 1, nResolved: 1, nUnresolved: 0, resolvedRate: 1, tasks: [] },
      // counts must be nonnegative integers
      { suite: "s", nTasks: -1, nResolved: 0, nUnresolved: 0, resolvedRate: 0, tasks: [] },
      { suite: "s", nTasks: 0, nResolved: -1, nUnresolved: 0, resolvedRate: 0, tasks: [] },
      { suite: "s", nTasks: 1, nResolved: 0, nUnresolved: -1, resolvedRate: 0, tasks: [] },
      { suite: "s", nTasks: 1.5, nResolved: 0, nUnresolved: 1, resolvedRate: 0, tasks: [] },
      // resolvedRate must be in [0, 1]
      { suite: "s", nTasks: 1, nResolved: 0, nUnresolved: 1, resolvedRate: -0.1, tasks: [] },
      { suite: "s", nTasks: 1, nResolved: 1, nUnresolved: 0, resolvedRate: 1.1, tasks: [] },
      // extra field (strict)
      { suite: "s", nTasks: 0, nResolved: 0, nUnresolved: 0, resolvedRate: 0, tasks: [], extra: 1 },
      // tasks must be an array
      { suite: "s", nTasks: 0, nResolved: 0, nUnresolved: 0, resolvedRate: 0, tasks: "none" },
    ]);
  });
});
