import { describe, expect, it } from "vitest";
import { TaskState } from "@keel/shared";
import type { SessionEventT } from "@keel/shared";
import { deriveTaskFacts } from "./derive.js";
import { deterministicFactsSummary } from "./facts-summary.js";

const ts = "2026-06-19T00:00:00.000Z";

/** A ledger: task prompt → read a.ts → edit a.ts → a bash command that FAILED (non-zero exit). */
const events: SessionEventT[] = [
  { type: "user", v: 1, ts, content: "fix the failing test in a.ts" },
  {
    type: "assistant",
    v: 1,
    ts,
    content: "",
    toolCalls: [{ id: "r1", name: "read", args: { path: "a.ts" } }],
  },
  { type: "tool_result", v: 1, ts, toolCallId: "r1", name: "read", output: "export const a = 1;" },
  {
    type: "assistant",
    v: 1,
    ts,
    content: "",
    toolCalls: [{ id: "e1", name: "edit", args: { path: "a.ts", oldString: "1", newString: "2" } }],
  },
  { type: "tool_result", v: 1, ts, toolCallId: "e1", name: "edit", output: "edited 1 occurrence" },
  {
    type: "assistant",
    v: 1,
    ts,
    content: "",
    toolCalls: [{ id: "b1", name: "bash", args: { command: "npm test" } }],
  },
  { type: "tool_result", v: 1, ts, toolCallId: "b1", name: "bash", output: "FAIL\n[exit code: 1]" },
];

const call = () =>
  deterministicFactsSummary({ facts: deriveTaskFacts(events), messages: [], events });

describe("deterministicFactsSummary (model-free compaction summarizer — Epic 1.6c PR-d slice 5)", () => {
  it("returns a schema-valid TaskState", () => {
    expect(() => TaskState.parse(call())).not.toThrow();
  });

  it("recovers the task goal from the first user message in the ledger (never lost across the fold)", () => {
    expect(call().taskGoal).toBe("fix the failing test in a.ts");
  });

  it("maps the ledger-derived files (read + modified) faithfully", () => {
    const s = call();
    expect(s.filesRead.map((f) => f.path)).toEqual(["a.ts"]);
    expect(s.filesModified.map((f) => f.path)).toEqual(["a.ts"]);
  });

  it("surfaces a FAILED command as a current error (a needle the fold must retain)", () => {
    const s = call();
    expect(s.currentErrors.some((e) => e.includes("npm test"))).toBe(true);
  });

  it("is deterministic and pure (same ledger → identical summary)", () => {
    expect(call()).toEqual(call());
  });

  it("invents nothing — every file claim traces to the ledger (validation will keep all of it)", () => {
    const s = call();
    // no file appears that the ledger did not record a tool result for
    for (const f of [...s.filesRead, ...s.filesModified]) expect(f.path).toBe("a.ts");
  });

  it("empty ledger → empty goal, intake phase, no errors (no first user message)", () => {
    const s = deterministicFactsSummary({ facts: deriveTaskFacts([]), messages: [], events: [] });
    expect(TaskState.parse(s)).toBeTruthy();
    expect(s.taskGoal).toBe("");
    expect(s.currentPhase).toBe("intake");
    expect(s.currentErrors).toEqual([]);
  });

  it("read-only run (no modifications, all commands passing) → inspect phase, no errors", () => {
    const ev: SessionEventT[] = [
      { type: "user", v: 1, ts, content: "look around" },
      {
        type: "assistant",
        v: 1,
        ts,
        content: "",
        toolCalls: [{ id: "r1", name: "read", args: { path: "x.ts" } }],
      },
      { type: "tool_result", v: 1, ts, toolCallId: "r1", name: "read", output: "contents" },
    ];
    const s = deterministicFactsSummary({ facts: deriveTaskFacts(ev), messages: [], events: ev });
    expect(s.currentPhase).toBe("inspect");
    expect(s.filesModified).toEqual([]);
    expect(s.currentErrors).toEqual([]);
    expect(s.currentStatus).not.toMatch(/failing/);
  });

  it("bounds a pathological command in the error line (no re-bloat)", () => {
    const longCmd = "echo " + "x".repeat(500);
    const ev: SessionEventT[] = [
      {
        type: "assistant",
        v: 1,
        ts,
        content: "",
        toolCalls: [{ id: "b1", name: "bash", args: { command: longCmd } }],
      },
      {
        type: "tool_result",
        v: 1,
        ts,
        toolCallId: "b1",
        name: "bash",
        output: "boom\n[exit code: 2]",
      },
    ];
    const s = deterministicFactsSummary({ facts: deriveTaskFacts(ev), messages: [], events: ev });
    expect(s.currentErrors).toHaveLength(1);
    expect(s.currentErrors[0]!.length).toBeLessThan(longCmd.length);
    expect(s.currentErrors[0]).toContain("…");
  });
});
