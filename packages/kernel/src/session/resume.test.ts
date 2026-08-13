import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessageT, SessionEventT } from "@keel/shared";
import {
  BLOCKED_AFTER_SYNTHESIS_CODE,
  REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE,
  type KernelEventT,
} from "../events.js";
import { SessionStore, readSession } from "./store.js";
import { record } from "./recorder.js";
import {
  applyPendingSteeringOnResume,
  rebuild,
  closeOpenToolCalls,
  INTERRUPTED_FINAL_ANSWER_REWRITE,
  INTERRUPTED_TOOL_RESULT,
} from "./resume.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });
async function* toAsync<T>(xs: readonly T[]): AsyncIterable<T> {
  for (const x of xs) yield x;
}

describe("resume.rebuild (text-only ledger → messages)", () => {
  const finalAnswerContract = { version: 1 as const, maxWords: 250 };
  const occurrence = (
    settlementId: string,
    attempt: "original" | "rewrite",
  ): Extract<SessionEventT, { type: "assistant" }> => ({
    type: "assistant",
    v: 1,
    ts: "2026-08-04T13:00:00.000Z",
    content: `${attempt} answer`,
    finalAnswer: {
      settlementId,
      kind: "attempt",
      attempt,
      contract: finalAnswerContract,
    },
  });

  it("preserves persisted failed tool identities for honest resumed presentation", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ts = new Date().toISOString();
    store.append({
      type: "assistant",
      v: 1,
      ts,
      content: "",
      toolCalls: [
        { id: "denied", name: "write", args: { path: "/outside" } },
        { id: "passed", name: "read", args: { path: "README.md" } },
      ],
    });
    store.append({
      type: "tool_result",
      v: 1,
      ts,
      toolCallId: "denied",
      name: "write",
      output: "blocked by warden (not executed): POL-002 deny: outside workspace",
      isError: true,
    });
    store.append({
      type: "tool_result",
      v: 1,
      ts,
      toolCallId: "passed",
      name: "read",
      output: "# keel",
    });
    store.close();

    const resumed = rebuild(readSession(store.id, e));

    expect(resumed.failedToolCallIds).toEqual(new Set(["denied"]));
  });

  it("tracks failed tool results by message occurrence when providers reuse a call id", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ts = new Date().toISOString();
    for (const [output, isError] of [
      ["first failed", true],
      ["second passed", false],
    ] as const) {
      store.append({
        type: "assistant",
        v: 1,
        ts,
        content: "",
        toolCalls: [{ id: "reused", name: "bash", args: { command: "true" } }],
      });
      store.append({
        type: "tool_result",
        v: 1,
        ts,
        toolCallId: "reused",
        name: "bash",
        output,
        ...(isError ? { isError: true } : {}),
      });
    }
    store.close();

    const resumed = rebuild(readSession(store.id, e));

    expect(resumed.failedToolMessageIndexes).toEqual(new Set([1]));
  });

  it("reconstructs the conversation as ModelMessages, skipping metadata", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents: KernelEventT[] = [
      { type: "turn-started", turn: 1 },
      { type: "text-delta", text: "done" },
      { type: "stop", reason: "model-stop" },
      { type: "run-finished", usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    for await (const ev of record(store, [{ role: "user", content: "go" }], toAsync(kevents)))
      expect(ev).toBeDefined();
    store.close();

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "done" },
    ]);
    expect(r.pendingSteering).toEqual([]);
  });

  it("derives only ordinary turn-opening prompts for resumed composer history", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ts = "2026-08-03T00:00:00.000Z";
    const usage = { inputTokens: 1, outputTokens: 1 };

    store.append({ type: "system", v: 1, ts, content: "system context" });
    store.append({ type: "user", v: 1, ts, content: "inspect the repository" });
    store.append({ type: "assistant", v: 1, ts, content: "working" });
    // Controller-authored user-role messages inside a turn are provider context, not typed prompts.
    store.append({ type: "user", v: 1, ts, content: "controller verification nudge" });
    store.append({ type: "assistant", v: 1, ts, content: "done" });
    store.append({ type: "run_status", v: 1, ts, reason: "model-stop", usage });

    // Exact duplicates remain source-faithful and stable.
    store.append({ type: "user", v: 1, ts, content: "inspect the repository" });
    store.append({ type: "assistant", v: 1, ts, content: "working again" });
    // Production ordering is applied marker first, then its injected user-role message.
    store.append({
      type: "steering",
      v: 1,
      ts,
      inputId: "inp_applied",
      class: "urgent",
      content: "do not edit generated files",
      insertedAt: 7,
      changedTaskState: false,
      invalidatedPlan: false,
    });
    store.append({ type: "user", v: 1, ts, content: "do not edit generated files" });
    store.append({ type: "assistant", v: 1, ts, content: "done again" });
    store.append({ type: "run_status", v: 1, ts, reason: "model-stop", usage });

    // Blank turn input is invalid in the live reducer; a hostile/legacy ledger must not recall it.
    store.append({ type: "user", v: 1, ts, content: "   " });
    store.append({ type: "assistant", v: 1, ts, content: "ignored" });
    store.append({ type: "run_status", v: 1, ts, reason: "model-stop", usage });

    const secret = "sk-ant-api03-supersecretvalue1234567890ABCDEF";
    store.append({ type: "user", v: 1, ts, content: `use ${secret}` });
    store.close();

    const resumed = rebuild(readSession(store.id, e));

    expect(resumed.inputHistory.slice(0, 2)).toEqual([
      "inspect the repository",
      "inspect the repository",
    ]);
    expect(resumed.inputHistory).not.toContain("controller verification nudge");
    expect(resumed.inputHistory).not.toContain("do not edit generated files");
    expect(resumed.inputHistory).not.toContain("   ");
    expect(resumed.inputHistory).toHaveLength(3);
    expect(resumed.inputHistory[2]).toContain("[redacted:");
    expect(resumed.inputHistory.join("\n")).not.toContain(secret);
  });

  it("does not let a torn applied-steering marker hide a later ordinary prompt at the same index", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ts = "2026-08-03T00:00:00.000Z";
    const usage = { inputTokens: 1, outputTokens: 1 };

    store.append({ type: "user", v: 1, ts, content: "first task" });
    store.append({ type: "assistant", v: 1, ts, content: "done" });
    store.append({
      type: "steering",
      v: 1,
      ts,
      inputId: "inp_torn",
      class: "urgent",
      content: "steering content never injected",
      insertedAt: 2,
      changedTaskState: false,
      invalidatedPlan: false,
    });
    store.append({ type: "run_status", v: 1, ts, reason: "model-stop", usage });
    // The marker's promised user event was torn away. A future run legitimately reuses index 2.
    store.append({ type: "user", v: 1, ts, content: "second task" });
    store.append({ type: "assistant", v: 1, ts, content: "done again" });
    store.append({ type: "run_status", v: 1, ts, reason: "model-stop", usage });
    store.close();

    expect(rebuild(readSession(store.id, e)).inputHistory).toEqual(["first task", "second task"]);
  });

  it("skips a compaction event — it is auditable metadata, never a conversation message (§4.7.4/slice 6)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts: new Date().toISOString(), content: "go" });
    store.append({
      type: "compaction",
      v: 1,
      compactionId: "cmp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      ts: new Date().toISOString(),
      inputRange: { from: 0, to: 0 },
      summaryHash: "deadbeef",
      artifactRefs: [],
      tokensBefore: 100,
      tokensAfter: 20,
      trigger: "token_soft",
      validation: "passed",
      probesPassed: true,
      trust: "unknown",
    });
    store.append({ type: "assistant", v: 1, ts: new Date().toISOString(), content: "done" });
    store.close();

    const r = rebuild(readSession(store.id, e));
    // the full pre-compaction history is preserved; the compaction record itself is not a message
    expect(r.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("skips a context_compression event — auditable metadata, never a conversation message (Epic 1.6c)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts: new Date().toISOString(), content: "go" });
    store.append({
      type: "context_compression",
      v: 1,
      compressionId: "ccx_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      ts: new Date().toISOString(),
      inputRange: { from: 0, to: 0 },
      items: [{ kind: "generic", name: "bash", beforeChars: 4000, afterChars: 80 }],
      tokensBefore: 100,
      tokensAfter: 20,
      trigger: "token_soft",
      trust: "unknown",
    });
    store.append({ type: "assistant", v: 1, ts: new Date().toISOString(), content: "done" });
    store.close();

    const r = rebuild(readSession(store.id, e));
    // the deterministic-tier record is audit metadata; the full history stays the source of truth
    expect(r.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("skips goal and loop run-control events — metadata, never model-visible context", async () => {
    const e = env();
    const ts = "2026-06-27T08:00:00.000Z";
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts, content: "go" });
    store.append({
      type: "goal_started",
      v: 1,
      ts,
      goal: {
        schemaVersion: "run-control.keel.dev/v1",
        id: "goal_smoke",
        objective: "prove run-control metadata stays out of context",
        doneWhen: [{ id: "typecheck", kind: "command", check: { argv: ["pnpm", "typecheck"] } }],
        requiresCompletionAudit: true,
      },
    });
    store.append({
      type: "loop_iteration",
      v: 1,
      ts,
      loopId: "loop_smoke",
      iteration: 1,
      status: "running",
      evidenceRefs: [],
    });
    store.append({ type: "assistant", v: 1, ts, content: "done" });
    store.close();

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("rehydrates successful controller loop verification without changing provider messages", () => {
    const e = env();
    const ts = "2026-08-13T03:54:27.000Z";
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts, content: "create and verify the fixture" });
    store.append({ type: "assistant", v: 1, ts, content: "fixture ready" });
    store.append({
      type: "run_status",
      v: 1,
      ts,
      reason: "model-stop",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    store.append({
      type: "tool_result",
      v: 1,
      ts,
      toolCallId: "loop_release_exit_1",
      name: "bash",
      output: JSON.stringify({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    });
    store.append({
      type: "loop_iteration",
      v: 1,
      ts,
      loopId: "loop_release",
      iteration: 1,
      status: "exit-check-passed",
      evidenceRefs: ["tool_result:loop_release_exit_1"],
    });
    store.append({
      type: "loop_stopped",
      v: 1,
      ts,
      loopId: "loop_release",
      reason: "succeeded",
      iterations: 1,
      evidenceRefs: ["tool_result:loop_release_exit_1"],
    });
    store.close();

    const resumed = rebuild(readSession(store.id, e));

    expect(resumed.messages).toEqual([
      { role: "user", content: "create and verify the fixture" },
      { role: "assistant", content: "fixture ready" },
    ]);
    expect(resumed.latestLoopVerification).toEqual({
      evidenceRef: "tool_result:loop_release_exit_1",
    });
  });

  it.each([
    {
      label: "failed controller result",
      resultIsError: true,
      stop: "succeeded" as const,
      toolCallId: "loop_release_exit_1",
    },
    {
      label: "contradictory stop",
      resultIsError: false,
      stop: "error" as const,
      toolCallId: "loop_release_exit_1",
    },
    {
      label: "mismatched controller identity",
      resultIsError: false,
      stop: "succeeded" as const,
      toolCallId: "loop_other_exit_1",
    },
  ])(
    "does not promote $label to resumed verification truth",
    ({ resultIsError, stop, toolCallId }) => {
      const e = env();
      const ts = "2026-08-13T03:54:27.000Z";
      const store = SessionStore.create({ cwd: "/w" }, e);
      store.append({ type: "user", v: 1, ts, content: "verify" });
      store.append({ type: "assistant", v: 1, ts, content: "done" });
      store.append({
        type: "tool_result",
        v: 1,
        ts,
        toolCallId,
        name: "bash",
        output: resultIsError ? "blocked before execution" : "passed",
        ...(resultIsError ? { isError: true } : {}),
      });
      store.append({
        type: "loop_iteration",
        v: 1,
        ts,
        loopId: "loop_release",
        iteration: 1,
        status: "exit-check-passed",
        evidenceRefs: [`tool_result:${toolCallId}`],
      });
      store.append({
        type: "loop_stopped",
        v: 1,
        ts,
        loopId: "loop_release",
        reason: stop,
        iterations: 1,
        evidenceRefs: [`tool_result:${toolCallId}`],
      });
      store.close();

      expect(rebuild(readSession(store.id, e)).latestLoopVerification).toBeUndefined();
    },
  );

  it("uses the final passed evidence when a successful loop needed multiple iterations", () => {
    const e = env();
    const ts = "2026-08-13T03:54:27.000Z";
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({
      type: "tool_result",
      v: 1,
      ts,
      toolCallId: "loop_release_exit_2",
      name: "bash",
      output: "passed",
    });
    store.append({
      type: "loop_iteration",
      v: 1,
      ts,
      loopId: "loop_release",
      iteration: 2,
      status: "exit-check-passed",
      evidenceRefs: ["tool_result:loop_release_exit_2"],
    });
    store.append({
      type: "loop_stopped",
      v: 1,
      ts,
      loopId: "loop_release",
      reason: "succeeded",
      iterations: 2,
      evidenceRefs: ["tool_result:loop_release_exit_1", "tool_result:loop_release_exit_2"],
    });
    store.close();

    expect(rebuild(readSession(store.id, e)).latestLoopVerification).toEqual({
      evidenceRef: "tool_result:loop_release_exit_2",
    });
  });

  it("does not credit an earlier successful loop check to a later human turn", () => {
    const e = env();
    const ts = "2026-08-13T03:54:27.000Z";
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({
      type: "tool_result",
      v: 1,
      ts,
      toolCallId: "loop_release_exit_1",
      name: "bash",
      output: "passed",
    });
    store.append({
      type: "loop_iteration",
      v: 1,
      ts,
      loopId: "loop_release",
      iteration: 1,
      status: "exit-check-passed",
      evidenceRefs: ["tool_result:loop_release_exit_1"],
    });
    store.append({
      type: "loop_stopped",
      v: 1,
      ts,
      loopId: "loop_release",
      reason: "succeeded",
      iterations: 1,
      evidenceRefs: ["tool_result:loop_release_exit_1"],
    });
    store.append({ type: "user", v: 1, ts, content: "unrelated follow-up" });
    store.append({ type: "assistant", v: 1, ts, content: "unrelated answer" });
    store.close();

    expect(rebuild(readSession(store.id, e)).latestLoopVerification).toBeUndefined();
  });

  it("skips warden auto-resolution receipt events — metadata, never model-visible context", () => {
    const e = env();
    const ts = "2026-07-07T08:00:00.000Z";
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts, content: "go" });
    store.append({
      type: "assistant",
      v: 1,
      ts,
      content: "",
      toolCalls: [{ id: "call_0", name: "bash", args: { command: "python3 tools/check.py" } }],
    });
    store.append({
      type: "warden_auto_resolved",
      v: 1,
      ts,
      source: "autopilot-command",
      resource: {
        kind: "command-key",
        value: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      reviewId: "command_review_1",
      scope: "once",
      auditSeq: 5,
      verdict: "allow",
      toolCallId: "call_0",
      toolName: "bash",
    });
    store.append({
      type: "tool_result",
      v: 1,
      ts,
      toolCallId: "call_0",
      name: "bash",
      output: "ok",
    });
    store.close();

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_0", name: "bash", args: { command: "python3 tools/check.py" } }],
      },
      { role: "tool", content: "ok", toolCallId: "call_0", name: "bash" },
    ]);
  });

  it("reports finished, lastStop, and usage from run_status", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents: KernelEventT[] = [
      { type: "text-delta", text: "done" },
      { type: "stop", reason: "model-stop" },
      { type: "run-finished", usage: { inputTokens: 5, outputTokens: 6 } },
    ];
    for await (const ev of record(store, [{ role: "user", content: "go" }], toAsync(kevents)))
      expect(ev).toBeDefined();
    store.close();
    const r = rebuild(readSession(store.id, e));
    expect(r.finished).toBe(true);
    expect(r.lastStop).toBe("model-stop");
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
  });

  it("ADR-0087: rebuild preserves a complete settlement transaction and typed projection metadata", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ts = "2026-08-04T13:00:00.000Z";
    store.append({ type: "user", v: 1, ts, content: "task" });
    store.append(occurrence("fas_complete", "original"));
    store.append({
      type: "user",
      v: 1,
      ts,
      content: "controller rewrite prompt",
      finalAnswer: {
        settlementId: "fas_complete",
        kind: "rewrite-prompt",
        contract: finalAnswerContract,
      },
    });
    store.append(occurrence("fas_complete", "rewrite"));
    store.append({
      type: "run_status",
      v: 1,
      ts,
      reason: "model-stop",
      usage: { inputTokens: 12, outputTokens: 7 },
      finalAnswer: {
        settlementId: "fas_complete",
        outcome: "accepted-rewrite",
        rewriteUsage: { inputTokens: 4, outputTokens: 2 },
      },
    });
    store.close();

    const resumed = rebuild(readSession(store.id, e));
    expect(resumed.messages).toEqual([
      { role: "user", content: "task" },
      { role: "assistant", content: "original answer" },
      { role: "user", content: "controller rewrite prompt" },
      { role: "assistant", content: "rewrite answer" },
    ]);
    expect([...resumed.finalAnswerOccurrences.entries()]).toEqual([
      [1, expect.objectContaining({ settlementId: "fas_complete", attempt: "original" })],
      [2, expect.objectContaining({ settlementId: "fas_complete", kind: "rewrite-prompt" })],
      [3, expect.objectContaining({ settlementId: "fas_complete", attempt: "rewrite" })],
    ]);
    expect(resumed.finalAnswerSettlements.get("fas_complete")).toEqual(
      expect.objectContaining({ outcome: "accepted-rewrite" }),
    );
    expect(resumed.interruptedFinalAnswerSettlementIds).toEqual(new Set());
  });

  it("ADR-0087: every incomplete durable transaction prefix rebuilds honestly and idempotently", () => {
    const ts = "2026-08-04T13:00:00.000Z";
    const rebuildPrefix = (events: readonly SessionEventT[]) => {
      const e = env();
      const store = SessionStore.create({ cwd: "/w" }, e);
      for (const event of events) store.append(event);
      store.close();
      return rebuild(readSession(store.id, e));
    };
    const task: SessionEventT = { type: "user", v: 1, ts, content: "task" };
    const original = occurrence("fas_crash", "original");
    const prompt: SessionEventT = {
      type: "user",
      v: 1,
      ts,
      content: "controller rewrite prompt",
      finalAnswer: {
        settlementId: "fas_crash",
        kind: "rewrite-prompt",
        contract: finalAnswerContract,
      },
    };
    const rewrite = occurrence("fas_crash", "rewrite");

    const noTaggedOriginal = rebuildPrefix([task, { ...original, finalAnswer: undefined }]);
    expect(noTaggedOriginal.interruptedFinalAnswerSettlementIds).toEqual(new Set());
    expect(noTaggedOriginal.messages.at(-1)).toEqual({
      role: "assistant",
      content: "original answer",
    });

    const originalOnly = rebuildPrefix([task, original]);
    expect(originalOnly.interruptedFinalAnswerSettlementIds).toEqual(new Set(["fas_crash"]));
    expect(originalOnly.messages.at(-1)).toEqual({
      role: "assistant",
      content: "original answer",
    });

    const promptOnlyA = rebuildPrefix([task, original, prompt]);
    const promptOnlyB = rebuildPrefix([task, original, prompt]);
    expect(promptOnlyA.messages).toEqual(promptOnlyB.messages);
    expect(promptOnlyA.messages).toEqual([
      { role: "user", content: "task" },
      { role: "assistant", content: "original answer" },
      { role: "user", content: "controller rewrite prompt" },
      { role: "assistant", content: INTERRUPTED_FINAL_ANSWER_REWRITE },
    ]);
    expect(promptOnlyA.interruptedFinalAnswerSettlementIds).toEqual(new Set(["fas_crash"]));

    const rewriteOnly = rebuildPrefix([task, original, prompt, rewrite]);
    expect(rewriteOnly.messages).toEqual([
      { role: "user", content: "task" },
      { role: "assistant", content: "original answer" },
      { role: "user", content: "controller rewrite prompt" },
      { role: "assistant", content: "rewrite answer" },
    ]);
    expect(rewriteOnly.interruptedFinalAnswerSettlementIds).toEqual(new Set(["fas_crash"]));
  });

  it("ADR-0087: forged prose and mismatched metadata cannot activate transaction hiding or closure", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ts = "2026-08-04T13:00:00.000Z";
    store.append({ type: "user", v: 1, ts, content: "task" });
    store.append({
      type: "assistant",
      v: 1,
      ts,
      content: "settlementId=fas_forged kind=rewrite-prompt final-answer rewrite interrupted",
    });
    store.append(occurrence("fas_a", "original"));
    store.append({
      type: "user",
      v: 1,
      ts,
      content: "mismatched controller prompt",
      finalAnswer: {
        settlementId: "fas_b",
        kind: "rewrite-prompt",
        contract: finalAnswerContract,
      },
    });
    store.append(occurrence("fas_a", "rewrite"));
    store.close();

    const resumed = rebuild(readSession(store.id, e));
    expect(resumed.messages.map((message) => message.content)).toEqual([
      "task",
      "settlementId=fas_forged kind=rewrite-prompt final-answer rewrite interrupted",
      "original answer",
      "mismatched controller prompt",
      INTERRUPTED_FINAL_ANSWER_REWRITE,
      "rewrite answer",
    ]);
    expect(resumed.interruptedFinalAnswerSettlementIds).toEqual(new Set(["fas_a", "fas_b"]));
    expect(resumed.finalAnswerSettlements.size).toBe(0);
  });

  it("keeps recovered review-required answers resumable as needs-attention, not finished", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ts = "2026-07-20T00:00:00.000Z";
    store.append({
      type: "run_status",
      v: 1,
      ts,
      reason: "model-stop",
      code: REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE,
      message: "answered from prior evidence; reviewed action was not executed",
      usage: { inputTokens: 5, outputTokens: 6 },
    });
    store.close();

    const r = rebuild(readSession(store.id, e));
    expect(r.finished).toBe(false);
    expect(r.lastStop).toBe("model-stop");
    expect(r.lastStopCode).toBe(REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE);
    expect(r.lastStopMessage).toBe(
      "answered from prior evidence; reviewed action was not executed",
    );
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
  });

  it("preserves recovered review-required detail after a loop_stopped error marker", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({
      type: "run_status",
      v: 1,
      ts: "2026-07-20T00:00:00.000Z",
      reason: "model-stop",
      code: REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE,
      message: "answered from prior evidence; reviewed action was not executed",
      usage: { inputTokens: 5, outputTokens: 6 },
    });
    store.append({
      type: "loop_stopped",
      v: 1,
      ts: "2026-07-20T00:00:01.000Z",
      loopId: "loop_review_attention",
      reason: "error",
      iterations: 1,
      evidenceRefs: ["model turn stopped before exit check"],
    });
    store.close();

    const r = rebuild(readSession(store.id, e));
    expect(r.finished).toBe(false);
    expect(r.lastStop).toBe("model-stop");
    expect(r.lastStopCode).toBe(REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE);
    expect(r.lastStopMessage).toBe(
      "answered from prior evidence; reviewed action was not executed",
    );
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
  });

  it("preserves recovered blocked detail after a loop_stopped error marker", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({
      type: "run_status",
      v: 1,
      ts: "2026-07-20T00:00:00.000Z",
      reason: "model-stop",
      code: BLOCKED_AFTER_SYNTHESIS_CODE,
      message: "answered from prior evidence; blocked action was not executed",
      usage: { inputTokens: 5, outputTokens: 6 },
    });
    store.append({
      type: "loop_stopped",
      v: 1,
      ts: "2026-07-20T00:00:01.000Z",
      loopId: "loop_blocked_attention",
      reason: "error",
      iterations: 1,
      evidenceRefs: ["model turn stopped before exit check"],
    });
    store.close();

    const r = rebuild(readSession(store.id, e));
    expect(r.finished).toBe(false);
    expect(r.lastStop).toBe("model-stop");
    expect(r.lastStopCode).toBe(BLOCKED_AFTER_SYNTHESIS_CODE);
    expect(r.lastStopMessage).toBe("answered from prior evidence; blocked action was not executed");
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
  });

  it("reports finished=false for a non-model-stop run", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const kevents: KernelEventT[] = [
      { type: "stop", reason: "max-turns" },
      { type: "run-finished", usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    for await (const ev of record(store, [], toAsync(kevents))) expect(ev).toBeDefined();
    store.close();
    const r = rebuild(readSession(store.id, e));
    expect(r.finished).toBe(false);
    expect(r.lastStop).toBe("max-turns");
  });

  it("treats a later aborted goal failure as terminal without inventing another usage run", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({
      type: "run_status",
      v: 1,
      ts: "2026-07-16T12:00:00.000Z",
      reason: "model-stop",
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    store.append({
      type: "goal_failed",
      v: 1,
      ts: "2026-07-16T12:00:01.000Z",
      goalId: "goal_interrupted_validation",
      reason: "aborted",
    });
    store.close();

    const r = rebuild(readSession(store.id, e));
    expect(r.finished).toBe(false);
    expect(r.lastStop).toBe("aborted");
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
  });

  it.each(["incomplete", "unverified", "error"] as const)(
    "keeps a later %s goal failure from rehydrating as a finished turn",
    (reason) => {
      const e = env();
      const store = SessionStore.create({ cwd: "/w" }, e);
      store.append({
        type: "run_status",
        v: 1,
        ts: "2026-07-16T12:00:00.000Z",
        reason: "model-stop",
        usage: { inputTokens: 12, outputTokens: 3 },
      });
      store.append({
        type: "goal_failed",
        v: 1,
        ts: "2026-07-16T12:00:01.000Z",
        goalId: "goal_failed_validation",
        reason,
      });
      store.close();

      const r = rebuild(readSession(store.id, e));
      expect(r.finished).toBe(false);
      expect(r.lastGoalFailure).toBe(reason);
      expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    },
  );

  it("lets a subsequent run_status supersede an older aborted goal failure", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({
      type: "run_status",
      v: 1,
      ts: "2026-07-16T12:00:00.000Z",
      reason: "model-stop",
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    store.append({
      type: "goal_failed",
      v: 1,
      ts: "2026-07-16T12:00:01.000Z",
      goalId: "goal_interrupted_validation",
      reason: "aborted",
    });
    store.append({
      type: "run_status",
      v: 1,
      ts: "2026-07-16T12:01:00.000Z",
      reason: "model-stop",
      usage: { inputTokens: 7, outputTokens: 2 },
    });
    store.close();

    const r = rebuild(readSession(store.id, e));
    expect(r.finished).toBe(true);
    expect(r.lastStop).toBe("model-stop");
    expect(r.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
  });

  it("synthesizes a tool result for an aborted/orphaned tool call (valid resumed history)", () => {
    const e = env();
    const ts = "2026-06-14T00:00:00.000Z";
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts, content: "go" });
    store.append({
      type: "assistant",
      v: 1,
      ts,
      content: "",
      toolCalls: [
        { id: "c0", name: "echo", args: {} },
        { id: "c1", name: "echo", args: {} },
      ],
    });
    store.append({ type: "tool_result", v: 1, ts, toolCallId: "c0", name: "echo", output: "ok" });
    // c1 never got a result (aborted mid-turn / crash) — resume must still be valid
    store.close();

    const r = rebuild(readSession(store.id, e));
    const toolMsgs = r.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.toolCallId).sort()).toEqual(["c0", "c1"]);
    const c1 = toolMsgs.find((m) => m.toolCallId === "c1");
    expect(c1?.name).toBe("echo");
    expect(c1?.content).toMatch(/interrupt/i);
  });

  it("rehydrates queued steering as pending; an applied steering is not pending", () => {
    const e = env();
    const ts = "2026-06-14T00:00:00.000Z";
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts, content: "go" });
    store.append({
      type: "steering",
      v: 1,
      ts,
      inputId: "inp_1",
      class: "queued",
      content: "pending",
      insertedAt: null,
      changedTaskState: false,
      invalidatedPlan: false,
    });
    store.append({
      type: "steering",
      v: 1,
      ts,
      inputId: "inp_2",
      class: "queued",
      content: "applied",
      insertedAt: 1,
      changedTaskState: false,
      invalidatedPlan: false,
    });
    store.close();

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([{ role: "user", content: "go" }]); // steering is not a message
    expect(r.pendingSteering.map((s) => s.inputId)).toEqual(["inp_1"]);
  });

  it("an applied steering marker supersedes its own pending event (same inputId no longer pending)", () => {
    // §4.10 application (slice 7): recordSteering writes a PENDING event; applying it later appends
    // the injected `user` message + an applied marker with the SAME inputId. rebuild dedups by
    // inputId (last-wins), so the input is no longer pending and the message is in the conversation.
    const e = env();
    const ts = "2026-06-14T00:00:00.000Z";
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts, content: "go" });
    store.append({
      type: "steering",
      v: 1,
      ts,
      inputId: "inp_1",
      class: "queued",
      content: "focus on a.ts",
      insertedAt: null,
      changedTaskState: false,
      invalidatedPlan: false,
    });
    // application: the injected user message, then the applied marker for the SAME inputId
    store.append({ type: "user", v: 1, ts, content: "focus on a.ts" });
    store.append({
      type: "steering",
      v: 1,
      ts,
      inputId: "inp_1",
      class: "queued",
      content: "focus on a.ts",
      insertedAt: 1,
      changedTaskState: false,
      invalidatedPlan: false,
    });
    store.close();

    const r = rebuild(readSession(store.id, e));
    expect(r.pendingSteering).toEqual([]); // superseded — not re-applied on resume
    expect(r.messages).toEqual([
      { role: "user", content: "go" },
      { role: "user", content: "focus on a.ts" }, // the injected steering message
    ]);
  });

  it("maps system + tool_result messages and skips stray metadata events", () => {
    const e = env();
    const ts = "2026-06-14T00:00:00.000Z";
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "system", v: 1, ts, content: "sys" });
    store.append({
      type: "assistant",
      v: 1,
      ts,
      content: "",
      toolCalls: [{ id: "t", name: "bash", args: {} }],
    });
    store.append({ type: "tool_result", v: 1, ts, toolCallId: "t", name: "bash", output: "x" });
    // a stray metadata event in the body is skipped (not a conversation message)
    store.append({ type: "session_meta", v: 1, id: store.id, createdAt: ts, cwd: "/w" });
    store.append({ type: "assistant", v: 1, ts, content: "hi" });
    store.close();

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "assistant", content: "", toolCalls: [{ id: "t", name: "bash", args: {} }] },
      { role: "tool", content: "x", toolCallId: "t", name: "bash" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("drops an orphan tool_result (no matching tool call) so resumed history stays valid", () => {
    const e = env();
    const ts = "2026-06-14T00:00:00.000Z";
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts, content: "go" });
    // a tool_result with no preceding assistant tool-call (orphan) — invalid provider history
    store.append({ type: "tool_result", v: 1, ts, toolCallId: "orphan", name: "x", output: "y" });
    store.append({ type: "assistant", v: 1, ts, content: "done" });
    store.close();

    const r = rebuild(readSession(store.id, e));
    expect(r.messages.some((m) => m.role === "tool")).toBe(false);
    expect(r.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "done" },
    ]);
  });
});

describe("applyPendingSteeringOnResume (P1-3 — pending steering survives resume, ADR-0034)", () => {
  const ts = "2026-07-13T00:00:00.000Z";

  function pendingSteering(inputId: string, content: string): SessionEventT {
    return {
      type: "steering",
      v: 1,
      ts,
      inputId,
      class: "queued",
      content,
      insertedAt: null,
      changedTaskState: false,
      invalidatedPlan: false,
    };
  }

  it("applies each still-pending queued input on resume: marker + user message, no longer pending", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts, content: "build the thing" });
    // Two queued comments were recorded PENDING but never applied (the run ended first).
    store.append(pendingSteering("inp_1", "also add tests"));
    store.append(pendingSteering("inp_2", "keep it small"));
    store.close();

    const state = rebuild(readSession(store.id, e));
    expect(state.pendingSteering.map((s) => s.inputId)).toEqual(["inp_1", "inp_2"]);

    const store2 = SessionStore.open(store.id, e);
    const seed = applyPendingSteeringOnResume(store2, state);
    store2.close();

    // The returned resume seed carries the original messages plus the injected steering messages.
    expect(seed).toEqual([
      { role: "user", content: "build the thing" },
      { role: "user", content: "also add tests" },
      { role: "user", content: "keep it small" },
    ]);

    // The ledger now records them applied: a fresh rebuild sees NO pending + includes the messages.
    const after = rebuild(readSession(store.id, e));
    expect(after.pendingSteering).toEqual([]);
    expect(after.messages).toEqual([
      { role: "user", content: "build the thing" },
      { role: "user", content: "also add tests" },
      { role: "user", content: "keep it small" },
    ]);
  });

  it("also rehydrates + applies a still-pending URGENT instruction (ADR-0034 no silent drop)", () => {
    // An urgent `/now …` is recorded pending the instant it is pulled; if the run dies before the
    // boundary applies it (the exact crash/WARDEN_UNAVAILABLE window), it must not be lost while a
    // lower-priority queued comment survives.
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts, content: "go" });
    store.append({
      type: "steering",
      v: 1,
      ts,
      inputId: "inp_u",
      class: "urgent",
      content: "keep the API stable",
      insertedAt: null,
      changedTaskState: false,
      invalidatedPlan: false,
    });
    store.close();

    const state = rebuild(readSession(store.id, e));
    expect(state.pendingSteering.map((s) => [s.inputId, s.class])).toEqual([["inp_u", "urgent"]]);

    const store2 = SessionStore.open(store.id, e);
    const seed = applyPendingSteeringOnResume(store2, state);
    store2.close();

    expect(seed).toEqual([
      { role: "user", content: "go" },
      { role: "user", content: "keep the API stable" },
    ]);
    const after = rebuild(readSession(store.id, e));
    expect(after.pendingSteering).toEqual([]);
  });

  it("is a no-op when nothing is pending (returns the messages unchanged, no ledger writes)", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts, content: "go" });
    store.close();

    const state = rebuild(readSession(store.id, e));
    const store2 = SessionStore.open(store.id, e);
    const seed = applyPendingSteeringOnResume(store2, state);
    store2.close();

    expect(seed).toEqual([{ role: "user", content: "go" }]);
    // No new events were appended.
    expect(readSession(store.id, e).events.filter((ev) => ev.type === "steering")).toEqual([]);
  });

  it("does not re-apply across a second resume (idempotent — no duplicate messages)", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts, content: "go" });
    store.append(pendingSteering("inp_1", "focus on a.ts"));
    store.close();

    // First resume applies it.
    const store2 = SessionStore.open(store.id, e);
    applyPendingSteeringOnResume(store2, rebuild(readSession(store.id, e)));
    store2.close();

    // Second resume: nothing pending, so a second apply must not inject the message again.
    const state2 = rebuild(readSession(store.id, e));
    expect(state2.pendingSteering).toEqual([]);
    const store3 = SessionStore.open(store.id, e);
    const seed2 = applyPendingSteeringOnResume(store3, state2);
    store3.close();

    expect(seed2).toEqual([
      { role: "user", content: "go" },
      { role: "user", content: "focus on a.ts" },
    ]);
  });
});

describe("closeOpenToolCalls (make an in-memory working set re-drivable — Epic 1.6c PR-d slice 4)", () => {
  const asst = (id: string, name = "edit"): ModelMessageT => ({
    role: "assistant",
    content: "",
    toolCalls: [{ id, name, args: {} }],
  });
  const toolRes = (id: string, name = "edit"): ModelMessageT => ({
    role: "tool",
    content: "ok",
    toolCallId: id,
    name,
  });

  it("returns an equal (new) array when every tool call already has a result", () => {
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      asst("a"),
      toolRes("a"),
      { role: "assistant", content: "done" },
    ];
    const out = closeOpenToolCalls(messages);
    expect(out).toEqual(messages);
    expect(out).not.toBe(messages); // pure: a new array
  });

  it("appends a synthetic INTERRUPTED result for a trailing aborted tool call (valid provider history)", () => {
    const messages: ModelMessageT[] = [{ role: "user", content: "go" }, asst("open", "bash")];
    const out = closeOpenToolCalls(messages);
    expect(out.at(-1)).toEqual({
      role: "tool",
      content: INTERRUPTED_TOOL_RESULT,
      toolCallId: "open",
      name: "bash",
    });
    // every assistant tool call now has exactly one matching tool result
    const callIds = out
      .flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []))
      .map((c) => c.id);
    const resultIds = out.filter((m) => m.role === "tool").map((m) => m.toolCallId);
    expect(resultIds.sort()).toEqual(callIds.sort());
  });

  it("closes only the unmatched calls when a turn partially completed", () => {
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "done1", name: "read", args: {} },
          { id: "open2", name: "edit", args: {} },
        ],
      },
      toolRes("done1", "read"), // first completed, second aborted
    ];
    const out = closeOpenToolCalls(messages);
    const synth = out.filter((m) => m.role === "tool" && m.content === INTERRUPTED_TOOL_RESULT);
    expect(synth).toHaveLength(1);
    expect(synth[0]!.toolCallId).toBe("open2");
  });

  it("closes a later interrupted occurrence when a provider reuses a resolved tool-call id", () => {
    const messages: ModelMessageT[] = [
      { role: "user", content: "first" },
      asst("reused", "read"),
      toolRes("reused", "read"),
      { role: "assistant", content: "first done" },
      { role: "user", content: "second" },
      asst("reused", "bash"),
    ];

    const out = closeOpenToolCalls(messages);
    expect(out.at(-1)).toEqual({
      role: "tool",
      content: INTERRUPTED_TOOL_RESULT,
      toolCallId: "reused",
      name: "bash",
    });
    expect(
      out.filter((message) => message.role === "tool" && message.toolCallId === "reused"),
    ).toHaveLength(2);
  });

  it("does not mutate the input", () => {
    const messages: ModelMessageT[] = [{ role: "user", content: "go" }, asst("open")];
    const snapshot = JSON.parse(JSON.stringify(messages)) as ModelMessageT[];
    closeOpenToolCalls(messages);
    expect(messages).toEqual(snapshot);
  });
});
