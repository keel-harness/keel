import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./store.js";
import { branch } from "./branch.js";
import { listSessions } from "./list.js";
import { BLOCKED_AFTER_SYNTHESIS_CODE, REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE } from "../events.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });
const ts = "2026-06-14T00:00:00.000Z";

describe("listSessions", () => {
  it("returns [] when the sessions dir does not exist", () => {
    expect(listSessions({ KEEL_HOME: mkdtempSync(join(tmpdir(), "empty-")) })).toEqual([]);
  });

  it("summarizes each session (id, cwd, event count), id-sorted", () => {
    const e = env();
    const a = SessionStore.create({ cwd: "/a", id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV" }, e);
    a.append({ type: "user", v: 1, ts, content: "hi" });
    a.close();
    const b = SessionStore.create({ cwd: "/b", id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW" }, e);
    b.close();

    const list = listSessions(e);
    expect(list.map((s) => s.id)).toEqual([
      "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW",
    ]);
    expect(list[0]).toMatchObject({ cwd: "/a", events: 1 });
    expect(list[1]).toMatchObject({ cwd: "/b", events: 0 });
  });

  it("includes the latest user prompt for recent-session surfaces", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({ type: "user", v: 1, ts, content: "first task" });
    s.append({ type: "assistant", v: 1, ts, content: "answer" });
    s.append({ type: "user", v: 1, ts, content: "follow-up\nwith forged row" });
    s.close();

    expect(listSessions(e)[0]?.summary).toBe("follow-up\nwith forged row");
  });

  it("summarizes completed-run usage and the last neutral outcome from run_status events", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({ type: "user", v: 1, ts: "2026-06-22T00:00:00.000Z", content: "fix tests" });
    s.append({
      type: "run_status",
      v: 1,
      ts: "2026-06-22T00:01:00.000Z",
      reason: "model-stop",
      usage: { inputTokens: 900, outputTokens: 100 },
    });
    s.append({
      type: "run_status",
      v: 1,
      ts: "2026-06-22T02:00:00.000Z",
      reason: "budget",
      usage: { inputTokens: 2_000, outputTokens: 500 },
    });
    s.close();

    expect(listSessions(e)[0]).toMatchObject({
      usageTokens: 3_500,
      lastStop: "budget",
      lastRunAt: "2026-06-22T02:00:00.000Z",
      usageRuns: [
        {
          ts: "2026-06-22T00:01:00.000Z",
          reason: "model-stop",
          inputTokens: 900,
          outputTokens: 100,
          tokens: 1_000,
        },
        {
          ts: "2026-06-22T02:00:00.000Z",
          reason: "budget",
          inputTokens: 2_000,
          outputTokens: 500,
          tokens: 2_500,
        },
      ],
    });
  });

  it("preserves non-error terminal detail for recovered review-required answers", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({ type: "user", v: 1, ts, content: "inspect repo" });
    s.append({
      type: "run_status",
      v: 1,
      ts: "2026-07-20T00:01:00.000Z",
      reason: "model-stop",
      code: REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE,
      message: "answered from prior evidence; reviewed action was not executed",
      usage: { inputTokens: 900, outputTokens: 100 },
    });
    s.close();

    expect(listSessions(e)[0]).toMatchObject({
      usageTokens: 1_000,
      lastStop: "model-stop",
      lastStopCode: REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE,
      lastStopMessage: "answered from prior evidence; reviewed action was not executed",
      lastRunAt: "2026-07-20T00:01:00.000Z",
      usageRuns: [
        {
          ts: "2026-07-20T00:01:00.000Z",
          reason: "model-stop",
          code: REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE,
          message: "answered from prior evidence; reviewed action was not executed",
          tokens: 1_000,
        },
      ],
    });
  });

  it("preserves recovered review-required detail when a loop stops on that attention code", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({ type: "user", v: 1, ts, content: "inspect repo in a loop" });
    s.append({
      type: "run_status",
      v: 1,
      ts: "2026-07-20T00:01:00.000Z",
      reason: "model-stop",
      code: REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE,
      message: "answered from prior evidence; reviewed action was not executed",
      usage: { inputTokens: 900, outputTokens: 100 },
    });
    s.append({
      type: "loop_stopped",
      v: 1,
      ts: "2026-07-20T00:01:01.000Z",
      loopId: "loop_review_attention",
      reason: "error",
      iterations: 1,
      evidenceRefs: ["model turn stopped before exit check"],
    });
    s.close();

    expect(listSessions(e)[0]).toMatchObject({
      lastStop: "model-stop",
      lastStopCode: REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE,
      lastStopMessage: "answered from prior evidence; reviewed action was not executed",
      lastRunAt: "2026-07-20T00:01:01.000Z",
    });
  });

  it("preserves recovered blocked detail when a loop stops on that attention code", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({ type: "user", v: 1, ts, content: "inspect repo in a loop" });
    s.append({
      type: "run_status",
      v: 1,
      ts: "2026-07-20T00:01:00.000Z",
      reason: "model-stop",
      code: BLOCKED_AFTER_SYNTHESIS_CODE,
      message: "answered from prior evidence; blocked action was not executed",
      usage: { inputTokens: 900, outputTokens: 100 },
    });
    s.append({
      type: "loop_stopped",
      v: 1,
      ts: "2026-07-20T00:01:01.000Z",
      loopId: "loop_blocked_attention",
      reason: "error",
      iterations: 1,
      evidenceRefs: ["model turn stopped before exit check"],
    });
    s.close();

    expect(listSessions(e)[0]).toMatchObject({
      lastStop: "model-stop",
      lastStopCode: BLOCKED_AFTER_SYNTHESIS_CODE,
      lastStopMessage: "answered from prior evidence; blocked action was not executed",
      lastRunAt: "2026-07-20T00:01:01.000Z",
    });
  });

  it("uses ordered aborted goal failures for terminal status without counting another usage run", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({
      type: "run_status",
      v: 1,
      ts: "2026-07-16T12:00:00.000Z",
      reason: "model-stop",
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    s.append({
      type: "goal_failed",
      v: 1,
      ts: "2026-07-16T12:00:01.000Z",
      goalId: "goal_interrupted_validation",
      reason: "aborted",
    });
    s.close();

    expect(listSessions(e)[0]).toMatchObject({
      usageTokens: 15,
      lastStop: "aborted",
      lastRunAt: "2026-07-16T12:00:01.000Z",
      usageRuns: [
        {
          ts: "2026-07-16T12:00:00.000Z",
          reason: "model-stop",
          inputTokens: 12,
          outputTokens: 3,
          tokens: 15,
        },
      ],
    });
  });

  it.each(["incomplete", "unverified", "error"] as const)(
    "does not report a model-stopped turn as done after a later %s goal failure",
    (reason) => {
      const e = env();
      const s = SessionStore.create({ cwd: "/w" }, e);
      s.append({
        type: "run_status",
        v: 1,
        ts: "2026-07-16T12:00:00.000Z",
        reason: "model-stop",
        usage: { inputTokens: 12, outputTokens: 3 },
      });
      s.append({
        type: "goal_failed",
        v: 1,
        ts: "2026-07-16T12:00:01.000Z",
        goalId: "goal_failed_validation",
        reason,
      });
      s.close();

      expect(listSessions(e)[0]).toMatchObject({
        usageTokens: 15,
        lastGoalFailure: reason,
        lastRunAt: "2026-07-16T12:00:01.000Z",
      });
    },
  );

  it("lets a later run_status supersede an older aborted goal failure", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({
      type: "run_status",
      v: 1,
      ts: "2026-07-16T12:00:00.000Z",
      reason: "model-stop",
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    s.append({
      type: "goal_failed",
      v: 1,
      ts: "2026-07-16T12:00:01.000Z",
      goalId: "goal_interrupted_validation",
      reason: "aborted",
    });
    s.append({
      type: "run_status",
      v: 1,
      ts: "2026-07-16T12:01:00.000Z",
      reason: "budget",
      usage: { inputTokens: 7, outputTokens: 2 },
    });
    s.close();

    expect(listSessions(e)[0]).toMatchObject({
      usageTokens: 24,
      lastStop: "budget",
      lastRunAt: "2026-07-16T12:01:00.000Z",
    });
    expect(listSessions(e)[0]?.usageRuns).toHaveLength(2);
  });

  it("skips corrupt and non-jsonl files rather than failing the whole list", () => {
    const e = env();
    const dir = join(e["KEEL_HOME"] as string, "sessions");
    const ok = SessionStore.create({ cwd: "/ok" }, e);
    ok.close();
    writeFileSync(join(dir, "ses_bad.jsonl"), "GARBAGE\n"); // corrupt → skipped
    writeFileSync(join(dir, "notes.txt"), "ignore me"); // non-jsonl → skipped
    expect(listSessions(e).map((s) => s.cwd)).toEqual(["/ok"]);
  });

  it("includes branch lineage in the summary", () => {
    const e = env();
    const src = SessionStore.create({ cwd: "/w" }, e);
    src.append({ type: "user", v: 1, ts, content: "a" });
    src.close();
    const newId = branch(src.id, 1, e);
    const summary = listSessions(e).find((s) => s.id === newId);
    expect(summary?.parent).toEqual({ id: src.id, atIndex: 1 });
  });

  it("defaults to process.env", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-"));
    const prev = process.env["KEEL_HOME"];
    process.env["KEEL_HOME"] = dir;
    try {
      expect(listSessions()).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env["KEEL_HOME"];
      else process.env["KEEL_HOME"] = prev;
    }
  });
});
