import { describe, expect, it } from "vitest";
import type { TaskStateT } from "@keel/shared";
import { renderCompactionSummary } from "./summary.js";

const populated: TaskStateT = {
  taskGoal: "fix the median bug",
  currentStatus: "edited stats.js; tests pass",
  currentPhase: "review",
  constraints: ["do not modify the test file"],
  plan: ["run tests", "fix bug", "re-run"],
  completedSteps: ["ran tests", "fixed median"],
  nextSteps: ["summarize for the user"],
  filesRead: [{ path: "stats.js", status: "read", summary: "median helper", artifactRefs: [] }],
  filesModified: [
    { path: "stats.js", status: "modified", summary: "even-length fix", artifactRefs: [] },
  ],
  decisions: [{ decision: "average two middles", reason: "the README spec", evidenceRefs: [] }],
  failedAttempts: [
    {
      attempt: "tried Math.round",
      result: "off by one",
      reasonNotContinuing: "wrong for evens",
      artifactRefs: [],
    },
  ],
  testState: [{ command: "node stats.test.js", status: "passed", summary: "all pass" }],
  currentErrors: [],
  blockers: [],
  artifactRefs: [{ artifactId: "a1", type: "diff", summary: "stats.js diff" }],
  policyNotes: [],
  provenanceNotes: [],
  memoryCandidates: [
    {
      content: "tests run with node stats.test.js",
      type: "procedural",
      proposedTopic: "testing",
      evidenceRefs: [],
      confidence: "medium",
      proposedScope: "repo",
    },
  ],
  unresolvedQuestions: [],
};

const empty: TaskStateT = {
  ...populated,
  constraints: [],
  plan: [],
  completedSteps: [],
  nextSteps: [],
  filesRead: [],
  filesModified: [],
  decisions: [],
  failedAttempts: [],
  testState: [],
  artifactRefs: [],
  memoryCandidates: [],
};

describe("renderCompactionSummary (§4.7.5 typed summary)", () => {
  it("renders the fixed sections with the task state's content", () => {
    const md = renderCompactionSummary(populated);
    expect(md).toMatch(/# Compacted Session State/);
    expect(md).toMatch(/## User Goal\nfix the median bug/);
    expect(md).toMatch(/## Non-Negotiable Constraints[\s\S]*do not modify the test file/);
    expect(md).toMatch(/## Files Modified[\s\S]*stats\.js: even-length fix/);
    expect(md).toMatch(/## Test and Verification State[\s\S]*node stats\.test\.js.*passed/);
    expect(md).toMatch(/## Failed Attempts[\s\S]*Math\.round/);
    expect(md).toMatch(/## Memory Candidates[\s\S]*procedural/);
    expect(md).toMatch(/## Next Best Actions[\s\S]*summarize for the user/);
  });

  it("renders empty sections honestly as (none), never fabricated", () => {
    const md = renderCompactionSummary(empty);
    expect(md).toMatch(/## Failed Attempts[^#]*\(none\)/);
    expect(md).toMatch(/## Files Modified[^#]*\(none\)/);
  });

  it("falls back to status / omits an empty summary cleanly", () => {
    const md = renderCompactionSummary({
      ...empty,
      filesRead: [{ path: "x.ts", status: "read", summary: "", artifactRefs: [] }],
      testState: [{ command: "npm test", status: "failed", summary: "" }],
    });
    expect(md).toMatch(/## Files Read\n- x\.ts: read/); // empty summary → status shown
    expect(md).toMatch(/## Test and Verification State\n- npm test — failed\n/); // no trailing ": "
  });
});
