import { describe, expect, it } from "vitest";
import { assertRejects, assertRoundTrips } from "../testing/property.js";
import {
  ArtifactRef,
  CompactionEvent,
  CompressorKind,
  ContextCompressionEvent,
  Decision,
  FailedAttempt,
  FileState,
  MemoryCandidate,
  TaskState,
  TestState,
  TrustLevel,
} from "./task-state.js";

describe("context/task-state schemas (§4.7.7 / ADR-0025)", () => {
  it("round-trips every schema (serialize → parse)", () => {
    for (const s of [
      TrustLevel,
      ArtifactRef,
      FileState,
      TestState,
      Decision,
      FailedAttempt,
      MemoryCandidate,
      TaskState,
      CompactionEvent,
      ContextCompressionEvent,
    ]) {
      assertRoundTrips(s);
    }
  });

  it("TrustLevel is the single shared enum (incl. the fail-closed `unknown`)", () => {
    expect(TrustLevel.options).toEqual(["user", "workspace", "untrusted", "mixed", "unknown"]);
  });

  it("parses a realistic TaskState (the derived factual scaffold + model prose)", () => {
    const ts = TaskState.parse({
      taskGoal: "fix the failing median test",
      currentStatus: "edited stats.js; tests pass",
      currentPhase: "review",
      constraints: ["do not modify the test file"],
      plan: ["run tests", "fix bug", "re-run"],
      completedSteps: ["ran tests", "fixed median"],
      nextSteps: ["summarize"],
      filesRead: [{ path: "stats.js", status: "read", summary: "median helper", artifactRefs: [] }],
      filesModified: [
        {
          path: "stats.js",
          status: "modified",
          summary: "even-length fix",
          artifactRefs: ["a1"],
          trust: "workspace",
        },
      ],
      decisions: [{ decision: "average two middles", reason: "spec", evidenceRefs: ["a1"] }],
      failedAttempts: [],
      testState: [{ command: "node stats.test.js", status: "passed", summary: "all pass" }],
      currentErrors: [],
      blockers: [],
      artifactRefs: [
        { artifactId: "a1", type: "diff", summary: "stats.js diff", trust: "workspace" },
      ],
      policyNotes: [],
      provenanceNotes: [],
      memoryCandidates: [
        {
          content: "tests run with `node stats.test.js`",
          type: "procedural",
          proposedTopic: "testing",
          evidenceRefs: ["a1"],
          confidence: "medium",
          proposedScope: "repo",
          trust: "workspace",
        },
      ],
      unresolvedQuestions: [],
    });
    expect(ts.filesModified[0]?.path).toBe("stats.js");
    expect(ts.testState[0]?.status).toBe("passed");
  });

  it("rejects malformed shapes (unknown status, missing field, extra key)", () => {
    assertRejects(TestState, [
      { command: "x", status: "green", summary: "" }, // not a valid status
      { command: "x", summary: "" }, // missing status
    ]);
    assertRejects(ArtifactRef, [
      { artifactId: "a", type: "bogus", summary: "" }, // invalid artifact type
      { artifactId: "a", type: "diff", summary: "", surprise: 1 }, // extra key (strict)
    ]);
    assertRejects(TrustLevel, ["trusted", "tainted", ""]); // not in the enum
  });

  it("a CompactionEvent records trust as max taint + validation/probe status (§4.7.4 step 8)", () => {
    const ev = CompactionEvent.parse({
      type: "compaction",
      v: 1,
      compactionId: "cmp_1",
      ts: "2026-06-15T00:00:00.000Z",
      inputRange: { from: 0, to: 42 },
      summaryHash: "abc123",
      artifactRefs: ["a1"],
      tokensBefore: 9000,
      tokensAfter: 1800,
      trigger: "task_boundary",
      validation: "passed",
      probesPassed: true,
      trust: "untrusted",
    });
    expect(ev.trust).toBe("untrusted");
    expect(ev.trigger).toBe("task_boundary");
  });

  it("a ContextCompressionEvent records the deterministic tier's per-item char deltas (ADR-0045)", () => {
    const ev = ContextCompressionEvent.parse({
      type: "context_compression",
      v: 1,
      compressionId: "ccx_1",
      ts: "2026-06-18T00:00:00.000Z",
      inputRange: { from: 2, to: 4 },
      items: [{ kind: "log", name: "bash", beforeChars: 4000, afterChars: 80 }],
      tokensBefore: 1200,
      tokensAfter: 60,
      trigger: "token_soft",
      trust: "unknown",
    });
    expect(ev.items[0]?.kind).toBe("log");
    expect(ev.tokensAfter).toBeLessThan(ev.tokensBefore);
    expect(ev.trust).toBe("unknown"); // fail-closed Phase-1 (no trust laundering, SEC-023)
  });

  it("CompressorKind is the deterministic-tier enum; ContextCompressionEvent rejects bad shapes", () => {
    expect(CompressorKind.options).toEqual(["log", "search", "generic"]);
    const item = { kind: "generic" as const, name: "read", beforeChars: 10, afterChars: 5 };
    const base = {
      type: "context_compression" as const,
      v: 1 as const,
      compressionId: "ccx_1",
      ts: "2026-06-18T00:00:00.000Z",
      inputRange: { from: 0, to: 0 },
      items: [item],
      tokensBefore: 10,
      tokensAfter: 5,
      trigger: "token_soft" as const,
      trust: "unknown" as const,
    };
    assertRejects(ContextCompressionEvent, [
      { ...base, items: [{ ...item, kind: "ast" }] }, // unknown compressor kind
      { ...base, items: [{ ...item, afterChars: -1 }] }, // negative char count
      { ...base, trigger: "manual" }, // not a tier trigger (only token_soft/token_hard)
      { ...base, surprise: 1 }, // extra key (strict)
    ]);
  });
});
