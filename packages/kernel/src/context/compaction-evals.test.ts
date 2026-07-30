import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessageT, SessionEventT, TaskStateT } from "@keel/shared";
import { FileAccessTracker } from "../tools/file-access.js";
import { createEditTool } from "../tools/edit.js";
import { createReadTool } from "../tools/read.js";
import { Workspace } from "../tools/workspace.js";
import { renderLedger } from "../tools/plan.js";
import { compact } from "./compact.js";
import { assembleActiveContext } from "./assemble.js";

/**
 * The §4.7.11 compaction eval set — the named, simulator-driven gate for Epic 1.6b (ADR-0025: evals
 * are simulator-driven, no API cost). It asserts the spec's success criteria as INVARIANTS over the
 * real engine — *no lost user constraints · no invented file modifications · no invented test success
 * · no trust/provenance upgrade · no loss of the current next action · no approved memory write
 * created solely by compaction* — plus the preservation dimensions and the headroom / anti-thrashing
 * goldens. Several invariants are also unit-tested in their own files (cited inline); this suite is
 * the assembled gate that proves them together against `compact()` / `assemble()`.
 */

const ts = "2026-06-15T00:00:00.000Z";

/** The ground-truth ledger: the model read + edited auth.ts and ran the tests. */
const ledgerEvents: SessionEventT[] = [
  { type: "user", v: 1, ts, content: "fix the token refresh bug" },
  {
    type: "assistant",
    v: 1,
    ts,
    content: "",
    toolCalls: [{ id: "r1", name: "read", args: { path: "src/auth.ts" } }],
  },
  { type: "tool_result", v: 1, ts, toolCallId: "r1", name: "read", output: "Y".repeat(900) },
  {
    type: "assistant",
    v: 1,
    ts,
    content: "",
    toolCalls: [
      { id: "e1", name: "edit", args: { path: "src/auth.ts", oldString: "x", newString: "y" } },
    ],
  },
  { type: "tool_result", v: 1, ts, toolCallId: "e1", name: "edit", output: "edited" },
  {
    type: "assistant",
    v: 1,
    ts,
    content: "",
    toolCalls: [{ id: "b1", name: "bash", args: { command: "npm test" } }],
  },
  { type: "tool_result", v: 1, ts, toolCallId: "b1", name: "bash", output: "1 passing" },
];

const ARTIFACT = "art_auth_diff_001";
const CONSTRAINT = "keep the public API backward compatible";
const NEXT = "wire the fix into the session refresh path";
const FAILED = "tried bumping the TTL globally";
const CANDIDATE = "auth tokens expire after 15m in this repo";

const base = (over: Partial<TaskStateT>): TaskStateT => ({
  taskGoal: "fix the token refresh bug",
  currentStatus: "in progress",
  currentPhase: "test",
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

/** A FAITHFUL rich summary — every factual claim is backed by `ledgerEvents`; prose fields populated. */
const richSummarizer = (): TaskStateT =>
  base({
    constraints: [CONSTRAINT],
    nextSteps: [NEXT],
    filesRead: [{ path: "src/auth.ts", status: "read", summary: "auth module", artifactRefs: [] }],
    filesModified: [
      { path: "src/auth.ts", status: "modified", summary: "fixed TTL", artifactRefs: [ARTIFACT] },
    ],
    testState: [{ command: "npm test", status: "passed", summary: "1 passing" }],
    failedAttempts: [
      {
        attempt: FAILED,
        result: "broke other tests",
        reasonNotContinuing: "too broad",
        artifactRefs: [],
      },
    ],
    artifactRefs: [{ artifactId: ARTIFACT, type: "diff", summary: "the auth.ts patch" }],
    memoryCandidates: [
      {
        content: CANDIDATE,
        type: "project_fact",
        proposedTopic: "auth",
        evidenceRefs: [],
        confidence: "medium",
        proposedScope: "repo",
      },
    ],
  });

/** A long session that forces a fold: the plan + a big read body sit older than the recent tail. */
const ledgerLine = renderLedger([
  { text: "reproduce", status: "done" },
  { text: "patch TTL", status: "current" },
  { text: "run tests", status: "pending" },
]);
const longMessages: ModelMessageT[] = [
  { role: "system", content: "SYS" },
  { role: "user", content: "fix the token refresh bug" },
  { role: "assistant", content: "", toolCalls: [{ id: "p1", name: "plan", args: { items: [] } }] },
  { role: "tool", content: ledgerLine, toolCallId: "p1", name: "plan" },
  { role: "user", content: CONSTRAINT }, // an applied steering constraint, older than the tail
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "r1", name: "read", args: { path: "src/auth.ts" } }],
  },
  { role: "tool", content: "Y".repeat(900), toolCallId: "r1", name: "read" },
  { role: "assistant", content: "patched and tested" },
  { role: "user", content: "anything else?" },
];

const steerEvent: SessionEventT = {
  type: "steering",
  v: 1,
  ts,
  inputId: "inp_1",
  class: "queued",
  content: CONSTRAINT,
  insertedAt: 4,
  changedTaskState: false,
  invalidatedPlan: false,
};

const run = (summarize: () => TaskStateT, recentVerbatimTurns = 2) =>
  compact({
    messages: longMessages,
    events: [...ledgerEvents, steerEvent],
    budgetTokens: 1000,
    trigger: "token_soft",
    summarize,
    recentVerbatimTurns,
  });

describe("§4.7.11 compaction evals — preservation dimensions (faithful summary over the real ledger)", () => {
  it("modified-files-preservation: a file edited in the ledger survives into the compacted summary", async () => {
    const r = await run(richSummarizer);
    expect(r.summary).toMatch(/## Files Modified[\s\S]*src\/auth\.ts/);
    expect(r.taskState.filesModified.map((f) => f.path)).toContain("src/auth.ts");
  });

  it("test-status-preservation: a test that actually ran + its status survive", async () => {
    const r = await run(richSummarizer);
    expect(r.summary).toMatch(/## Test and Verification State[\s\S]*npm test[\s\S]*passed/);
  });

  it("artifact-reference-preservation: artifact ids survive (summary + the CompactionEvent)", async () => {
    const r = await run(richSummarizer);
    expect(r.summary).toContain(ARTIFACT);
    expect(r.event.artifactRefs).toContain(ARTIFACT);
  });

  it("failed-attempt-preservation: a dead end is retained so it is not retried", async () => {
    const r = await run(richSummarizer);
    expect(r.summary).toMatch(/## Failed Attempts[\s\S]*tried bumping the TTL/);
  });

  it("constraint-preservation + next-action-preservation: the user constraint and current next action survive", async () => {
    const r = await run(richSummarizer);
    // the constraint is in the typed summary AND the raw steering instruction is re-pinned (§4.10)
    expect(r.summary).toContain(CONSTRAINT);
    expect(r.messages.some((m) => m.content.includes(CONSTRAINT))).toBe(true);
    expect(r.summary).toContain(NEXT); // no loss of the current next action
  });

  it("anti-thrashing: files already read are listed in the summary, so the model need not re-read them", async () => {
    const r = await run(richSummarizer);
    expect(r.summary).toMatch(/## Files Read[\s\S]*src\/auth\.ts/);
    // the bulky raw read body is cleared from the active context (only the summary remains)
    expect(r.messages.some((m) => m.content.includes("Y".repeat(900)))).toBe(false);
  });

  it("the task ledger (plan) survives the fold verbatim — the most durable item", async () => {
    const r = await run(richSummarizer);
    expect(r.messages.some((m) => m.content === ledgerLine)).toBe(true);
  });
});

describe("§4.7.11 compaction evals — success criteria (the safety floor)", () => {
  it("no invented file modification: a fabricated path is dropped + the event is marked repaired", async () => {
    const lying = () =>
      base({
        filesModified: [
          { path: "ghost.ts", status: "modified", summary: "INVENTED", artifactRefs: [] },
        ],
      });
    const r = await run(lying);
    expect(r.taskState.filesModified.map((f) => f.path)).not.toContain("ghost.ts");
    expect(r.summary).not.toContain("ghost.ts");
    expect(r.event.validation).toBe("repaired");
  });

  it("no invented test success: a test command that never ran is dropped", async () => {
    const lying = () =>
      base({ testState: [{ command: "npm run e2e", status: "passed", summary: "" }] });
    const r = await run(lying);
    expect(r.taskState.testState).toEqual([]);
    expect(r.summary).not.toContain("npm run e2e");
  });

  it("no invented test success (ran-but-FAILED): a command that failed cannot be laundered to passed", async () => {
    // the realistic laundering vector: the command DID run, but it failed (non-zero exit) — the model
    // must not be able to summarize it as a green verification.
    const failedLedger: SessionEventT[] = [
      { type: "user", v: 1, ts, content: "fix it" },
      {
        type: "assistant",
        v: 1,
        ts,
        content: "",
        toolCalls: [{ id: "b1", name: "bash", args: { command: "npm test" } }],
      },
      // bash returns ok:true for a non-zero exit; the failure shows as the `[exit code: N]` annotation
      {
        type: "tool_result",
        v: 1,
        ts,
        toolCallId: "b1",
        name: "bash",
        output: "3 failing\n[exit code: 1]",
      },
    ];
    const lyingPass = () =>
      base({ testState: [{ command: "npm test", status: "passed", summary: "all green" }] });
    const r = await compact({
      messages: longMessages,
      events: failedLedger,
      budgetTokens: 1000,
      trigger: "token_soft",
      summarize: lyingPass,
      recentVerbatimTurns: 2,
    });
    expect(r.taskState.testState).toEqual([]); // the fake pass is dropped
    expect(r.event.validation).toBe("repaired");
    expect(r.summary).not.toMatch(/npm test[\s\S]*passed/);
  });

  it("no trust/provenance upgrade (SEC-023): the event trust is fail-closed `unknown`, never raised", async () => {
    const r = await run(richSummarizer);
    expect(r.event.trust).toBe("unknown");
    expect(["user", "workspace"]).not.toContain(r.event.trust);
  });

  it("no memory write created solely by compaction: candidates are PROPOSED, never written", async () => {
    const r = await run(richSummarizer);
    // the candidate is surfaced as a proposal in the summary…
    expect(r.summary).toMatch(/## Memory Candidates[\s\S]*auth tokens expire/);
    // …and that is ALL compact() does — it is pure (returns data; touches no memory store). Durable
    // memory writes are Epic 3.4; in Phase 1 there is no write path for a candidate to reach.
    expect(r.taskState.memoryCandidates.map((m) => m.content)).toEqual([CANDIDATE]);
    expect(Object.keys(r)).toEqual(["messages", "event", "summary", "taskState"]);
  });
});

describe("§4.7.11 compaction evals — headroom + resume-staleness", () => {
  it("headroom: assembly drives an over-budget context down by clearing tool bodies (≥16K reserved)", () => {
    const heavy: ModelMessageT[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "go" },
      { role: "tool", content: "Z".repeat(400_000), toolCallId: "t1", name: "read" },
      { role: "tool", content: "W".repeat(400_000), toolCallId: "t2", name: "read" },
      { role: "assistant", content: "done" },
    ];
    const budget = 100_000;
    const before = heavy.reduce((s, m) => s + Math.ceil(m.content.length / 4) + 4, 0);
    // recentVerbatimTurns:1 keeps only the final turn verbatim, so the two big tool bodies are older
    // than the tail → clearable (with the default window they would all count as recent, nothing clears).
    const out = assembleActiveContext({
      messages: heavy,
      budgetTokens: budget,
      recentVerbatimTurns: 1,
    });
    const after = out.reduce((s, m) => s + Math.ceil(m.content.length / 4) + 4, 0);
    expect(after).toBeLessThan(before); // older clearable bodies were cleared
    expect(after).toBeLessThanOrEqual(budget - 16_384); // ≥16K response headroom reserved
    // the cleared messages remain (the call still happened), pointing at the ledger
    expect(out.some((m) => m.content.includes("output cleared"))).toBe(true);
  });

  it("resume-staleness (SEC-025): a file changed since its read is refused for edit until re-read", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-eval-")));
    try {
      writeFileSync(join(root, "a.ts"), "alpha BETA gamma");
      const tracker = new FileAccessTracker();
      const ws = new Workspace(root);
      const read = createReadTool(ws, { tracker }).handler;
      const edit = createEditTool(ws, { tracker }).handler;
      void read({ path: "a.ts" }); // marks the file read (result unused here)
      writeFileSync(join(root, "a.ts"), "alpha BETA gamma extra"); // external change after the read
      expect(() => edit({ path: "a.ts", oldString: "BETA", newString: "X" })).toThrow(
        /changed .*since you read|stale/i,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("long (multi-turn) session: compaction shrinks tokens while preserving the durable categories", async () => {
    const r = await run(richSummarizer);
    expect(r.event.tokensAfter).toBeLessThan(r.event.tokensBefore);
    // a representative durable item from each preserved category is present in the compacted context
    const blob = r.messages.map((m) => m.content).join("\n");
    expect(blob).toContain("src/auth.ts"); // files
    expect(blob).toContain(CONSTRAINT); // constraint
    expect(blob).toContain(ledgerLine); // task ledger
  });
});
