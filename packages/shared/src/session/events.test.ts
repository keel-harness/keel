import { describe, expect, it } from "vitest";
import {
  JUNK,
  assertRejects,
  assertRoundTrips,
  assertWireRoundTrips,
} from "../testing/property.js";
import {
  KNOWN_SESSION_EVENT_TYPES,
  SESSION_SCHEMA_VERSION,
  SessionEvent,
  SessionEventTolerant,
  SessionEventType,
  StopReason,
} from "./events.js";

const ts = "2026-06-11T14:03:22.117Z";

describe("session JSONL events (Epic 1.4)", () => {
  const finalAnswerContract = { version: 1 as const, maxWords: 250 };

  it("message-event taxonomy (metadata events are tracked separately)", () => {
    expect(SessionEventType.options).toEqual(["user", "assistant", "tool_result", "system"]);
    assertRoundTrips(SessionEvent);
    assertRejects(SessionEvent, [
      ...JUNK,
      { type: "nope", ts },
      { type: "user", content: "no ts" },
      // tool_call is folded into assistant.toolCalls (Epic 1.4) — no longer its own event
      { type: "tool_call", v: 1, ts, toolCall: { id: "t", name: "bash", args: {} } },
    ]);
  });

  // I4 (ADR-0008): every variant carries v:1
  it("I4: every variant requires v:1 — missing or wrong version is rejected", () => {
    expect(SessionEvent.safeParse({ type: "user", ts, content: "hi" }).success).toBe(false);
    expect(SessionEvent.safeParse({ type: "user", v: 2, ts, content: "hi" }).success).toBe(false);
    expect(SessionEvent.parse({ type: "user", v: 1, ts, content: "hello" })).toBeTruthy();
    expect(SessionEvent.parse({ type: "system", v: 1, ts, content: "started" })).toBeTruthy();
  });

  it("assistant carries optional toolCalls (mirrors ModelMessage)", () => {
    expect(SessionEvent.parse({ type: "assistant", v: 1, ts, content: "thinking" })).toBeTruthy();
    expect(
      SessionEvent.parse({
        type: "assistant",
        v: 1,
        ts,
        content: "calling",
        toolCalls: [{ id: "call_0_0", name: "bash", args: { command: "ls" } }],
      }),
    ).toBeTruthy();
  });

  it("tool_result carries toolCallId + name + string output (+ optional isError)", () => {
    expect(
      SessionEvent.parse({
        type: "tool_result",
        v: 1,
        ts,
        toolCallId: "call_0_0",
        name: "bash",
        output: "file.txt",
      }),
    ).toBeTruthy();
    expect(
      SessionEvent.parse({
        type: "tool_result",
        v: 1,
        ts,
        toolCallId: "call_0_0",
        name: "bash",
        output: "boom",
        isError: true,
      }),
    ).toBeTruthy();
    // output must be a string; name is required (mirrors the loop's tool message)
    expect(
      SessionEvent.safeParse({
        type: "tool_result",
        v: 1,
        ts,
        toolCallId: "c",
        name: "bash",
        output: 42,
      }).success,
    ).toBe(false);
    expect(
      SessionEvent.safeParse({ type: "tool_result", v: 1, ts, toolCallId: "c", output: "x" })
        .success,
    ).toBe(false);
  });

  // Epic 1.4: session_meta is the first-line header (id, createdAt, cwd, optional lineage).
  it("accepts a session_meta header (with optional parent lineage)", () => {
    expect(
      SessionEvent.parse({
        type: "session_meta",
        v: 1,
        id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        createdAt: ts,
        cwd: "/w",
      }),
    ).toBeTruthy();
    expect(
      SessionEvent.parse({
        type: "session_meta",
        v: 1,
        id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        createdAt: ts,
        cwd: "/w",
        parent: { id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW", atIndex: 3 },
      }),
    ).toBeTruthy();
    expect(
      SessionEvent.safeParse({ type: "session_meta", v: 1, id: "bad", createdAt: ts, cwd: "/w" })
        .success,
    ).toBe(false);
  });

  it("StopReason is the shared loop stop-reason enum", () => {
    expect(StopReason.options).toContain("model-stop");
    expect(StopReason.safeParse("nope").success).toBe(false);
  });

  it("accepts a run_status event (reason + usage)", () => {
    expect(
      SessionEvent.parse({
        type: "run_status",
        v: 1,
        ts,
        reason: "model-stop",
        usage: { inputTokens: 1, outputTokens: 2 },
      }),
    ).toBeTruthy();
    expect(
      SessionEvent.safeParse({
        type: "run_status",
        v: 1,
        ts,
        reason: "nope",
        usage: { inputTokens: 0, outputTokens: 0 },
      }).success,
    ).toBe(false);
  });

  it("accepts optional run_status terminal detail", () => {
    expect(
      SessionEvent.parse({
        type: "run_status",
        v: 1,
        ts,
        reason: "model-stop",
        code: "REVIEW_REQUIRED_AFTER_SYNTHESIS",
        message: "answered from prior evidence; reviewed action was not executed",
        usage: { inputTokens: 3, outputTokens: 4 },
      }),
    ).toMatchObject({
      type: "run_status",
      reason: "model-stop",
      code: "REVIEW_REQUIRED_AFTER_SYNTHESIS",
      message: "answered from prior evidence; reviewed action was not executed",
    });
  });

  it("ADR-0087: accepts strict task-scoped final-answer occurrence and settlement metadata", () => {
    expect(
      SessionEvent.parse({
        type: "user",
        v: 1,
        ts,
        content: "Rewrite the answer within the explicit bound.",
        finalAnswer: {
          settlementId: "fas_01",
          kind: "rewrite-prompt",
          contract: finalAnswerContract,
        },
      }),
    ).toMatchObject({ finalAnswer: { kind: "rewrite-prompt", contract: finalAnswerContract } });

    for (const attempt of ["original", "rewrite"] as const) {
      expect(
        SessionEvent.parse({
          type: "assistant",
          v: 1,
          ts,
          content: `${attempt} answer`,
          finalAnswer: {
            settlementId: "fas_01",
            kind: "attempt",
            attempt,
            contract: finalAnswerContract,
          },
        }),
      ).toMatchObject({ finalAnswer: { kind: "attempt", attempt } });
    }

    for (const outcome of [
      "accepted-original",
      "accepted-rewrite",
      "fallback-budget",
      "fallback-cancelled",
      "fallback-length",
      "fallback-error",
      "fallback-tool-call",
      "fallback-oversized",
    ] as const) {
      expect(
        SessionEvent.parse({
          type: "run_status",
          v: 1,
          ts,
          reason: "model-stop",
          usage: { inputTokens: 10, outputTokens: 4 },
          finalAnswer: {
            settlementId: "fas_01",
            outcome,
            rewriteUsage: { inputTokens: 3, outputTokens: 2 },
          },
        }),
      ).toMatchObject({ finalAnswer: { settlementId: "fas_01", outcome } });
    }
  });

  it("ADR-0087: enforces contract bounds and rejects malformed strict metadata", () => {
    const assistant = {
      type: "assistant",
      v: 1,
      ts,
      content: "answer",
      finalAnswer: {
        settlementId: "fas_01",
        kind: "attempt",
        attempt: "original",
        contract: finalAnswerContract,
      },
    };

    expect(SessionEvent.parse(assistant)).toBeTruthy();
    expect(
      SessionEvent.parse({
        ...assistant,
        finalAnswer: { ...assistant.finalAnswer, contract: { version: 1, maxWords: 40 } },
      }),
    ).toBeTruthy();
    expect(
      SessionEvent.parse({
        ...assistant,
        finalAnswer: { ...assistant.finalAnswer, contract: { version: 1, maxWords: 2_000 } },
      }),
    ).toBeTruthy();

    for (const finalAnswer of [
      { ...assistant.finalAnswer, contract: { version: 1, maxWords: 39 } },
      { ...assistant.finalAnswer, contract: { version: 1, maxWords: 2_001 } },
      { ...assistant.finalAnswer, contract: { version: 1, maxWords: 40.5 } },
      { ...assistant.finalAnswer, contract: { version: 2, maxWords: 250 } },
      { ...assistant.finalAnswer, settlementId: "" },
      { ...assistant.finalAnswer, attempt: "hidden-third-attempt" },
      { ...assistant.finalAnswer, futureAuthority: true },
    ]) {
      expect(SessionEvent.safeParse({ ...assistant, finalAnswer }).success).toBe(false);
    }
  });

  it("accepts session-ledger warden auto-resolution metadata for audit-linked receipts", () => {
    expect(
      SessionEvent.parse({
        type: "warden_auto_resolved",
        v: 1,
        ts,
        source: "plan-approval",
        planId: "plan_auth_fix",
        resource: {
          kind: "command-key",
          value: `sha256:${"a".repeat(64)}`,
        },
        reviewId: "command_review_1",
        scope: "once",
        auditSeq: 5,
        verdict: "allow",
        toolCallId: "call_bash",
        toolName: "bash",
      }),
    ).toBeTruthy();

    expect(
      SessionEvent.parse({
        type: "warden_auto_resolved",
        v: 1,
        ts,
        source: "session-grant",
        resource: {
          kind: "domain",
          value: "example.com",
        },
        reviewId: "egress_review_1",
        scope: "once",
        auditSeq: 6,
        verdict: "allow",
        toolCallId: "call_bash",
        toolName: "bash",
      }),
    ).toBeTruthy();

    expect(
      SessionEvent.parse({
        type: "warden_auto_resolved",
        v: 1,
        ts,
        source: "plan-approval",
        planId: "p".repeat(300),
        resource: {
          kind: "command-key",
          value: `sha256:${"a".repeat(64)}`,
        },
        reviewId: "r".repeat(300),
        scope: "once",
        auditSeq: 7,
        verdict: "allow",
        toolCallId: "c".repeat(300),
        toolName: "t".repeat(300),
      }),
    ).toBeTruthy();

    for (const bad of [
      { source: "model-raised" },
      { resource: { kind: "command-key", value: "sha256:not-hex" } },
      { resource: { kind: "domain", value: "*" } },
      { resource: { kind: "domain", value: "Example.COM" } },
      { resource: { kind: "domain", value: "singlelabel" } },
      { resource: { kind: "domain", value: "127.0.0.1" } },
      { resource: { kind: "domain", value: "example..com" } },
      { resource: { kind: "domain", value: "example.com/path" } },
      { resource: { kind: "domain", value: "0x7f.example" } },
      { scope: "project" },
      { auditSeq: -1 },
      { verdict: "unknown" },
    ]) {
      expect(
        SessionEvent.safeParse({
          type: "warden_auto_resolved",
          v: 1,
          ts,
          source: "plan-approval",
          resource: {
            kind: "command-key",
            value: `sha256:${"a".repeat(64)}`,
          },
          reviewId: "command_review_1",
          scope: "once",
          auditSeq: 5,
          verdict: "allow",
          toolCallId: "call_bash",
          toolName: "bash",
          ...bad,
        }).success,
      ).toBe(false);
    }
  });

  it("accepts a steering event (§4.10 reserved fields); pending = queued + insertedAt null", () => {
    const base = {
      type: "steering",
      v: 1,
      ts,
      inputId: "inp_1",
      class: "queued",
      content: "hold on",
      insertedAt: null,
      changedTaskState: false,
      invalidatedPlan: false,
    };
    expect(SessionEvent.parse(base)).toBeTruthy();
    // an applied steering input: a boundary index + flags
    expect(
      SessionEvent.parse({ ...base, class: "urgent", insertedAt: 5, changedTaskState: true }),
    ).toBeTruthy();
    // class must be one of the three; insertedAt is required (number|null), not omittable
    expect(SessionEvent.safeParse({ ...base, class: "nope" }).success).toBe(false);
    expect(
      SessionEvent.safeParse({
        type: "steering",
        v: 1,
        ts,
        inputId: "inp_1",
        class: "queued",
        content: "hold on",
        changedTaskState: false,
        invalidatedPlan: false,
      }).success,
    ).toBe(false);
  });

  it("accepts goal lifecycle metadata events without adding them to the message taxonomy", () => {
    expect(SessionEventType.options).toEqual(["user", "assistant", "tool_result", "system"]);

    const started = {
      type: "goal_started",
      v: 1,
      ts,
      goal: {
        schemaVersion: "run-control.keel.dev/v1",
        id: "goal_smoke",
        objective: "prove goal run control",
        doneWhen: [
          {
            id: "typecheck",
            kind: "command",
            check: { argv: ["pnpm", "typecheck"] },
          },
        ],
        requiresCompletionAudit: true,
      },
    };
    expect(SessionEvent.parse(started)).toBeTruthy();
    expect(
      SessionEvent.parse({
        type: "goal_audit",
        v: 1,
        ts,
        audit: {
          schemaVersion: "run-control.keel.dev/v1",
          goalId: "goal_smoke",
          verdict: "incomplete",
          validation: { status: "not_configured" },
          criteria: [
            {
              criterionId: "typecheck",
              status: "unsatisfied",
              assurance: "unverified",
              evidence: [],
              message: "no matching command evidence",
            },
          ],
          gaps: ["typecheck"],
        },
      }),
    ).toBeTruthy();
    expect(
      SessionEvent.parse({
        type: "goal_completed",
        v: 1,
        ts,
        goalId: "goal_smoke",
        auditRef: "goal_audit:goal_smoke:1",
      }),
    ).toBeTruthy();
    expect(
      SessionEvent.parse({
        type: "goal_failed",
        v: 1,
        ts,
        goalId: "goal_smoke",
        reason: "incomplete",
        auditRef: "goal_audit:goal_smoke:1",
      }),
    ).toBeTruthy();
    expect(
      SessionEvent.safeParse({ ...started, goal: { ...started.goal, doneWhen: [] } }).success,
    ).toBe(false);
  });

  it("accepts bounded loop metadata events and rejects malformed loop stops", () => {
    expect(
      SessionEvent.parse({
        type: "loop_iteration",
        v: 1,
        ts,
        loopId: "loop_tests",
        iteration: 1,
        status: "running",
        evidenceRefs: ["tool_result:call_1"],
      }),
    ).toBeTruthy();
    expect(
      SessionEvent.parse({
        type: "loop_stopped",
        v: 1,
        ts,
        loopId: "loop_tests",
        reason: "loop-max-iterations",
        iterations: 5,
        evidenceRefs: [],
      }),
    ).toBeTruthy();
    expect(
      SessionEvent.safeParse({
        type: "loop_stopped",
        v: 1,
        ts,
        loopId: "loop_tests",
        reason: "scheduled",
        iterations: -1,
        evidenceRefs: [],
      }).success,
    ).toBe(false);
  });

  // Epic 1.6b slice 6: a compaction is an auditable ledger event (§4.7.4 step 8, ADR-0025) — the
  // record that a folding happened, not a conversation message (rebuild treats it as metadata).
  it("accepts a compaction event (§4.7 — auditable fold record); rejects a bad trigger/trust", () => {
    const base = {
      type: "compaction",
      v: 1,
      compactionId: "cmp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      ts,
      inputRange: { from: 1, to: 12 },
      summaryHash: "e3b0c44298fc1c149afbf4c8996fb924",
      artifactRefs: [],
      tokensBefore: 8000,
      tokensAfter: 1500,
      trigger: "token_soft",
      validation: "passed",
      probesPassed: true,
      trust: "unknown",
    };
    expect(SessionEvent.parse(base)).toBeTruthy();
    expect(SessionEvent.parse({ ...base, compactorModel: "claude-sonnet-4-6" })).toBeTruthy();
    // trigger + validation are closed enums; trust is required (fail-closed default = unknown)
    expect(SessionEvent.safeParse({ ...base, trigger: "nope" }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...base, validation: "nope" }).success).toBe(false);
    const noTrust: Record<string, unknown> = { ...base };
    delete noTrust["trust"];
    expect(SessionEvent.safeParse(noTrust).success).toBe(false);
  });

  // C3: wire round-trip (catches JSON corruption in toolCalls.args / any JSON-crossing field)
  it("C3: SessionEvent survives a JSON wire round-trip (assertWireRoundTrips)", () => {
    assertWireRoundTrips(SessionEvent);
  });
});

describe("SessionEventTolerant (ADR-0072 P1-12 Slice 5 — read-tolerant variant)", () => {
  it("SESSION_SCHEMA_VERSION is 1 and matches the events' `v` literal", () => {
    expect(SESSION_SCHEMA_VERSION).toBe(1);
    expect(SessionEvent.parse({ type: "user", v: 1, ts, content: "x" }).v).toBe(
      SESSION_SCHEMA_VERSION,
    );
  });

  it("covers exactly the same discriminants as the strict SessionEvent (drift guard)", () => {
    const strict = SessionEvent.options.map((b) => b.shape.type.value).sort();
    const tolerant = SessionEventTolerant.options.map((b) => b.shape.type.value).sort();
    expect(tolerant).toEqual(strict);
    expect([...KNOWN_SESSION_EVENT_TYPES].sort()).toEqual(strict);
  });

  it("retains an unknown additive field the strict schema would reject", () => {
    const withUnknown = { type: "user", v: 1, ts, content: "x", futureField: { a: 1 } };
    // strict rejects the extra key…
    expect(SessionEvent.safeParse(withUnknown).success).toBe(false);
    // …tolerant accepts AND retains it (passthrough — the session ledger has no hash to protect).
    const parsed = SessionEventTolerant.parse(withUnknown) as Record<string, unknown>;
    expect(parsed["futureField"]).toEqual({ a: 1 });
  });

  it("still validates known fields and the version literal (not credulous)", () => {
    expect(
      SessionEventTolerant.safeParse({ type: "user", v: 1, ts: "nope", content: "x" }).success,
    ).toBe(false);
    // v:2 is rejected by the schema (the reader gates it into an honest-upgrade path BEFORE this parse).
    expect(SessionEventTolerant.safeParse({ type: "user", v: 2, ts, content: "x" }).success).toBe(
      false,
    );
  });

  it("ADR-0087: malformed presentation metadata fails visible by being treated as absent", () => {
    const malformed = {
      type: "assistant",
      v: 1,
      ts,
      content: "raw answer must remain visible",
      finalAnswer: {
        settlementId: "fas_forged",
        kind: "attempt",
        attempt: "original",
        contract: { version: 1, maxWords: 0 },
      },
    };

    expect(SessionEvent.safeParse(malformed).success).toBe(false);
    const parsed = SessionEventTolerant.parse(malformed);
    expect(parsed).toMatchObject({ type: "assistant", content: "raw answer must remain visible" });
    expect("finalAnswer" in parsed ? parsed.finalAnswer : undefined).toBeUndefined();
  });
});
