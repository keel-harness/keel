import { describe, expect, it } from "vitest";
import type { SessionEventT, TaskStateT } from "@keel/shared";
import { validateTaskState } from "./validate.js";

const ts = "2026-06-15T00:00:00.000Z";

/** A ledger: read a.ts, edit b.ts, run `node test.js`. */
const ledger: SessionEventT[] = [
  {
    type: "assistant",
    v: 1,
    ts,
    content: "",
    toolCalls: [
      { id: "r", name: "read", args: { path: "a.ts" } },
      { id: "e", name: "edit", args: { path: "b.ts", oldString: "x", newString: "y" } },
      { id: "t", name: "bash", args: { command: "node test.js" } },
    ],
  },
  { type: "tool_result", v: 1, ts, toolCallId: "r", name: "read", output: "contents" },
  { type: "tool_result", v: 1, ts, toolCallId: "e", name: "edit", output: "edited" },
  { type: "tool_result", v: 1, ts, toolCallId: "t", name: "bash", output: "PASS" },
];

const task = (over: Partial<TaskStateT>): TaskStateT => ({
  taskGoal: "fix b.ts",
  currentStatus: "done",
  currentPhase: "review",
  constraints: [],
  plan: [],
  completedSteps: [],
  nextSteps: [],
  filesRead: [],
  filesModified: [],
  decisions: [],
  failedAttempts: [],
  testState: [],
  currentErrors: [],
  blockers: [],
  artifactRefs: [],
  policyNotes: [],
  provenanceNotes: [],
  memoryCandidates: [],
  unresolvedQuestions: [],
  ...over,
});

describe("validateTaskState (§4.7.6 — claims checked against the ledger; no invention)", () => {
  it("a faithful summary (files/tests backed by the ledger) passes clean", () => {
    const claimed = task({
      filesRead: [{ path: "a.ts", status: "read", summary: "", artifactRefs: [] }],
      filesModified: [{ path: "b.ts", status: "modified", summary: "", artifactRefs: [] }],
      testState: [{ command: "node test.js", status: "passed", summary: "" }],
    });
    const r = validateTaskState(claimed, ledger);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.repaired).toEqual(claimed);
  });

  it("flags + repairs an invented file modification (no edit/write in the ledger)", () => {
    const claimed = task({
      filesModified: [
        { path: "b.ts", status: "modified", summary: "", artifactRefs: [] },
        { path: "ghost.ts", status: "modified", summary: "", artifactRefs: [] }, // invented
      ],
    });
    const r = validateTaskState(claimed, ledger);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/ghost\.ts/);
    expect(r.repaired.filesModified.map((f) => f.path)).toEqual(["b.ts"]); // invented dropped
    expect(r.repaired.taskGoal).toBe("fix b.ts"); // prose preserved
  });

  it("flags + repairs a claimed test PASS that the ledger shows actually failed (no laundering)", () => {
    const failedLedger: SessionEventT[] = [
      {
        type: "assistant",
        v: 1,
        ts,
        content: "",
        toolCalls: [{ id: "t", name: "bash", args: { command: "node test.js" } }],
      },
      // ran, but failed (non-zero exit annotation) — bash returns ok:true for a non-zero exit
      {
        type: "tool_result",
        v: 1,
        ts,
        toolCallId: "t",
        name: "bash",
        output: "FAIL\n[exit code: 1]",
      },
    ];
    const claimed = task({
      testState: [{ command: "node test.js", status: "passed", summary: "green" }], // a lie
    });
    const r = validateTaskState(claimed, failedLedger);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/did not pass/);
    expect(r.repaired.testState).toEqual([]); // the fake pass is dropped
    // but truthfully claiming it FAILED is kept (the command did run)
    const honest = task({
      testState: [{ command: "node test.js", status: "failed", summary: "" }],
    });
    expect(validateTaskState(honest, failedLedger).repaired.testState).toHaveLength(1);
  });

  it("flags + repairs governed-bash failures behind warden guidance headers", () => {
    const failedLedger: SessionEventT[] = [
      {
        type: "assistant",
        v: 1,
        ts,
        content: "",
        toolCalls: [{ id: "t", name: "bash", args: { command: "pnpm test" } }],
      },
      {
        type: "tool_result",
        v: 1,
        ts,
        toolCallId: "t",
        name: "bash",
        output: `warden warning: POL-008 warn: package-manager command\n\n${JSON.stringify({
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "failed",
        })}`,
      },
    ];
    const claimed = task({
      testState: [{ command: "pnpm test", status: "passed", summary: "green" }],
    });

    const r = validateTaskState(claimed, failedLedger);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/did not pass/);
    expect(r.repaired.testState).toEqual([]);
  });

  it("validates reused tool-call IDs by occurrence instead of last-wins ID maps", () => {
    const reusedLedger: SessionEventT[] = [
      {
        type: "assistant",
        v: 1,
        ts,
        content: "",
        toolCalls: [{ id: "same", name: "read", args: { path: "first.ts" } }],
      },
      { type: "tool_result", v: 1, ts, toolCallId: "same", name: "read", output: "first" },
      {
        type: "assistant",
        v: 1,
        ts,
        content: "",
        toolCalls: [{ id: "same", name: "read", args: { path: "second.ts" } }],
      },
      { type: "tool_result", v: 1, ts, toolCallId: "same", name: "read", output: "second" },
      {
        type: "assistant",
        v: 1,
        ts,
        content: "",
        toolCalls: [{ id: "cmd", name: "bash", args: { command: "pnpm test" } }],
      },
      { type: "tool_result", v: 1, ts, toolCallId: "cmd", name: "bash", output: "ok" },
      {
        type: "assistant",
        v: 1,
        ts,
        content: "",
        toolCalls: [{ id: "cmd", name: "bash", args: { command: "pnpm typecheck" } }],
      },
      { type: "tool_result", v: 1, ts, toolCallId: "cmd", name: "bash", output: "ok" },
    ];
    const claimed = task({
      filesRead: [
        { path: "first.ts", status: "read", summary: "", artifactRefs: [] },
        { path: "second.ts", status: "read", summary: "", artifactRefs: [] },
      ],
      testState: [
        { command: "pnpm test", status: "passed", summary: "" },
        { command: "pnpm typecheck", status: "passed", summary: "" },
      ],
    });

    expect(validateTaskState(claimed, reusedLedger)).toMatchObject({ ok: true, violations: [] });
  });

  it("flags + repairs an invented file read and an invented test result", () => {
    const claimed = task({
      filesRead: [{ path: "never.ts", status: "read", summary: "", artifactRefs: [] }],
      testState: [{ command: "npm run e2e", status: "passed", summary: "" }], // never run
    });
    const r = validateTaskState(claimed, ledger);
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(2);
    expect(r.repaired.filesRead).toEqual([]);
    expect(r.repaired.testState).toEqual([]);
  });
});
