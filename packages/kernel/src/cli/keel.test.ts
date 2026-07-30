import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, readSession } from "../session/store.js";
import { runKeelCli, runKeelCliResult } from "./keel.js";
import { BLOCKED_AFTER_SYNTHESIS_CODE, REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE } from "../events.js";
import { sessionsDir } from "../session/paths.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });
const ts = "2026-06-14T00:00:00.000Z";

describe("runKeelCli — sessions", () => {
  it("list shows each session id, cwd, event count, and terminal status", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w", id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV" }, e);
    s.append({ type: "user", v: 1, ts, content: "hi" });
    s.append({
      type: "run_status",
      v: 1,
      ts,
      reason: "model-stop",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    s.close();
    const out = runKeelCli(["sessions", "list"], e);
    expect(out).toContain("ses_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(out).toContain("/w");
    expect(out).toMatch(/2 event/);
    expect(out).toContain("finished (model-stop)");
  });

  it("list control-strips a cwd carrying ANSI/CR/newline so it cannot forge a row (F10)", () => {
    const e = env();
    // A cwd is the OS launch directory (ledger-derived); render it raw and a directory name carrying
    // ANSI/CR could overwrite keel's output and an embedded newline could forge a second session row.
    const evilCwd =
      "/w\r\u001b[31mX\u001b[0m\nses_01ARZ3NDEKTSV4RRFFQ69G5FZZ  /evil  99 event(s)  finished";
    const s = SessionStore.create({ cwd: evilCwd, id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV" }, e);
    s.append({ type: "user", v: 1, ts, content: "hi" });
    s.close();
    const out = runKeelCli(["sessions", "list"], e);
    expect(out).not.toContain("\u001b"); // ESC / ANSI CSI stripped
    expect(out).not.toContain("\r"); // CR stripped
    expect(out.split("\n")).toHaveLength(1); // one session -> one line; injected newline folded
    expect(out).toContain("ses_01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  it("list surfaces attention-coded stops without requiring session resume", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({
      type: "run_status",
      v: 1,
      ts,
      reason: "model-stop",
      code: REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE,
      message: "answered from prior evidence; reviewed action was not executed",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    s.close();

    const out = runKeelCli(["sessions", "list"], e);
    expect(out).toContain(s.id);
    expect(out).toContain("needs attention (model-stop:REVIEW_REQUIRED_AFTER_SYNTHESIS)");
    expect(out).not.toContain("finished");
  });

  it("list surfaces blocked-after-synthesis stops without requiring session resume", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({
      type: "run_status",
      v: 1,
      ts,
      reason: "model-stop",
      code: BLOCKED_AFTER_SYNTHESIS_CODE,
      message: "answered from prior evidence; blocked action was not executed",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    s.close();

    const out = runKeelCli(["sessions", "list"], e);
    expect(out).toContain(s.id);
    expect(out).toContain("needs attention (model-stop:BLOCKED_AFTER_SYNTHESIS)");
    expect(out).not.toContain("finished");
  });

  it("list with no sessions reports none", () => {
    expect(runKeelCli(["sessions", "list"], env())).toMatch(/no sessions/i);
  });

  it("resume reports status, message count, and pending steering", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({ type: "user", v: 1, ts, content: "go" });
    s.append({ type: "assistant", v: 1, ts, content: "done" });
    s.append({
      type: "run_status",
      v: 1,
      ts,
      reason: "model-stop",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    s.close();
    const out = runKeelCli(["sessions", "resume", s.id], e);
    expect(out).toContain(s.id);
    expect(out).toMatch(/finished/i);
    expect(out).toMatch(/messages: 2/);
    expect(out).toMatch(/pending steering: 0/);
    expect(out).toContain(`use keel --resume ${s.id} to continue`);
    expect(out).not.toMatch(/arrives with/i);
  });

  it("resume does not collapse recovered review-required answers into finished status", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({
      type: "run_status",
      v: 1,
      ts,
      reason: "model-stop",
      code: REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE,
      message: "answered from prior evidence; reviewed action was not executed",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    s.close();

    const out = runKeelCli(["sessions", "resume", s.id], e);
    expect(out).toMatch(/status: needs attention \(model-stop:REVIEW_REQUIRED_AFTER_SYNTHESIS\)/i);
    expect(out).toContain("detail: answered from prior evidence; reviewed action was not executed");
    expect(out).not.toMatch(/status: finished/i);
  });

  it("resume reports blocked-after-synthesis detail without collapsing it into finished status", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({
      type: "run_status",
      v: 1,
      ts,
      reason: "model-stop",
      code: BLOCKED_AFTER_SYNTHESIS_CODE,
      message: "answered from prior evidence; blocked action was not executed",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    s.close();

    const out = runKeelCli(["sessions", "resume", s.id], e);
    expect(out).toMatch(/status: needs attention \(model-stop:BLOCKED_AFTER_SYNTHESIS\)/i);
    expect(out).toContain("detail: answered from prior evidence; blocked action was not executed");
    expect(out).not.toMatch(/status: finished/i);
  });

  it("resume reports direct warden terminal stops as needs attention instead of in progress", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({
      type: "run_status",
      v: 1,
      ts,
      reason: "error",
      code: "BLOCKED",
      message: "blocked by warden",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    s.close();

    const out = runKeelCli(["sessions", "resume", s.id], e);
    expect(out).toMatch(/status: needs attention \(error:BLOCKED\)/i);
    expect(out).not.toMatch(/status: in progress/i);
  });

  it("branch prints the new id and actually copies the prefix", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({ type: "user", v: 1, ts, content: "a" });
    s.append({ type: "user", v: 1, ts, content: "b" });
    s.close();
    const out = runKeelCli(["sessions", "branch", s.id, "1"], e);
    expect(out).toContain(s.id);
    const newId = out.match(/ses_[0-9A-HJKMNP-TV-Z]{26}/g)?.find((m) => m !== s.id);
    expect(newId).toBeDefined();
    expect(readSession(newId as string, e).events).toHaveLength(1);
  });

  it.each(["3", String(Number.MAX_SAFE_INTEGER)])(
    "rejects out-of-range public index %s without creating a child",
    (atIndex) => {
      const e = env();
      const s = SessionStore.create({ cwd: "/w/private-ledger-path" }, e);
      s.append({ type: "user", v: 1, ts, content: "do-not-leak" });
      s.append({ type: "user", v: 1, ts, content: "b" });
      s.close();
      const beforeFiles = readdirSync(sessionsDir(e));

      const result = runKeelCliResult(["sessions", "branch", s.id, atIndex], e);

      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/error:.*out of range.*expected 0\.\.2/i);
      expect(result.output).not.toContain("do-not-leak");
      expect(result.output).not.toContain("/w/private-ledger-path");
      expect(readdirSync(sessionsDir(e))).toEqual(beforeFiles);
    },
  );

  it("accepts the exact end boundary with truthful full-prefix lineage", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({ type: "user", v: 1, ts, content: "a" });
    s.append({ type: "user", v: 1, ts, content: "b" });
    s.close();

    const result = runKeelCliResult(["sessions", "branch", s.id, "2"], e);
    expect(result.ok).toBe(true);
    const newId = result.output.match(/ses_[0-9A-HJKMNP-TV-Z]{26}/g)?.find((id) => id !== s.id);
    expect(newId).toBeDefined();
    const child = readSession(newId as string, e);
    expect(child.events).toEqual(readSession(s.id, e).events);
    expect(child.meta.parent).toEqual({ id: s.id, atIndex: 2 });
  });

  it.each([
    { input: "01", expected: 1, extra: [] },
    { input: "+1", expected: 1, extra: [] },
    { input: "1e0", expected: 1, extra: [] },
    { input: "0x1", expected: 1, extra: [] },
    { input: " 1 ", expected: 1, extra: [] },
    { input: "-0", expected: 0, extra: [] },
    { input: "1", expected: 1, extra: ["ignored"] },
  ])("preserves accepted branch index form $input", ({ input, expected, extra }) => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({ type: "user", v: 1, ts, content: "a" });
    s.close();

    const result = runKeelCliResult(["sessions", "branch", s.id, input, ...extra], e);
    expect(result.ok).toBe(true);
    const newId = result.output.match(/ses_[0-9A-HJKMNP-TV-Z]{26}/g)?.find((id) => id !== s.id);
    expect(newId).toBeDefined();
    const child = readSession(newId as string, e);
    expect(child.events).toHaveLength(expected);
    expect(child.meta.parent).toEqual({ id: s.id, atIndex: expected });
  });

  it("resume reports an in-progress session with n/a usage", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({ type: "user", v: 1, ts, content: "go" });
    s.close();
    const out = runKeelCli(["sessions", "resume", s.id], e);
    expect(out).toMatch(/in progress/i);
    expect(out).toMatch(/usage: n\/a/);
  });

  it("resume reports the latest goal failure instead of generic in-progress status", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({
      type: "run_status",
      v: 1,
      ts,
      reason: "model-stop",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    s.append({
      type: "goal_failed",
      v: 1,
      ts: "2026-06-14T00:00:01.000Z",
      goalId: "goal_failed_validation",
      reason: "unverified",
    });
    s.close();

    const out = runKeelCli(["sessions", "resume", s.id], e);
    expect(out).toMatch(/status: goal failed \(unverified\)/i);
    expect(out).not.toMatch(/status: (?:finished|in progress)/i);
  });

  it("list shows lineage for a branched session", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.append({ type: "user", v: 1, ts, content: "a" });
    s.close();
    runKeelCli(["sessions", "branch", s.id, "1"], e);
    expect(runKeelCli(["sessions", "list"], e)).toMatch(/from ses_/);
  });

  it("branch rejects a non-integer or negative index with usage", () => {
    const e = env();
    expect(runKeelCli(["sessions", "branch", "ses_x", "abc"], e)).toMatch(/usage/i);
    expect(runKeelCli(["sessions", "branch", "ses_x", "-1"], e)).toMatch(/usage/i);
    expect(runKeelCli(["sessions", "branch", "ses_x", "1.5"], e)).toMatch(/usage/i);
    expect(
      runKeelCli(["sessions", "branch", "ses_x", String(Number.MAX_SAFE_INTEGER + 1)], e),
    ).toMatch(/usage/i);
    expect(runKeelCli(["sessions", "branch", "ses_x"], e)).toMatch(/usage/i);
  });

  it("resume of a path-traversal id is rejected without escaping the sessions dir (denied-path)", () => {
    const out = runKeelCli(["sessions", "resume", "../../etc/passwd"], env());
    expect(out).toMatch(/invalid session id/i);
    expect(out).not.toMatch(/root:/); // never read /etc/passwd
  });

  // The agent must not be able to forge keel's own status report. `run_status.message`/`code` are
  // unbounded strings derived from model-influenced text (e.g. a bash command echoed into a
  // completion-evidence prompt), so the CLI must control-strip and bound them before rendering —
  // the same discipline the TUI already applies. AGENTS.md: "model self-report as truth" is a
  // named failure mode; status truth comes from the control plane, not model text.
  it("sessions resume cannot be made to forge a status field or emit terminal control bytes", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w", id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV" }, e);
    s.append({
      type: "run_status",
      v: 1,
      ts,
      reason: "error",
      code: "E[31mRED[0m\rOVERWRITE",
      message:
        "check failed. Command: pnpm test --x '\n  status: finished\n  messages: 999\n  usage: 0 in / 0 out'",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    s.close();

    const out = runKeelCli(["sessions", "resume", "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV"], e);

    // No raw terminal control bytes reach stdout.
    expect(out.includes("")).toBe(false);
    expect(out.includes("\r")).toBe(false);
    // The injected text cannot introduce a second "status:"/"messages:" report field.
    expect(out.match(/^\s*status:/gmu) ?? []).toHaveLength(1);
    expect(out.match(/^\s*messages:/gmu) ?? []).toHaveLength(1);
    // The detail is still shown (sanitized, folded to one line), not silently dropped.
    expect(out).toMatch(/detail: .*check failed/u);
  });

  it("sessions list cannot be made to emit terminal control bytes via a stop code", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w", id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW" }, e);
    s.append({
      type: "run_status",
      v: 1,
      ts,
      reason: "error",
      code: "E[2JCLEARED\rOVERWRITE",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    s.close();

    const out = runKeelCli(["sessions", "list"], e);
    expect(out.includes("")).toBe(false);
    expect(out.includes("\r")).toBe(false);
    expect(out.split("\n")).toHaveLength(1); // one session -> exactly one line
  });

  it("resume of a nonexistent id prints a friendly one-line error, not a stack trace", () => {
    const out = runKeelCli(["sessions", "resume", "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV"], env());
    expect(out).toMatch(/error/i);
    expect(out.split("\n")).toHaveLength(1);
    expect(out).not.toMatch(/\bat\b.*\(/); // no stack frame
  });

  it("branch of an invalid id prints a friendly error", () => {
    const out = runKeelCli(["sessions", "branch", "../evil", "1"], env());
    expect(out).toMatch(/invalid session id/i);
  });

  it("missing/unknown args print usage", () => {
    const e = env();
    expect(runKeelCli([], e)).toMatch(/usage/i);
    expect(runKeelCli(["sessions"], e)).toMatch(/usage/i);
    expect(runKeelCli(["sessions", "resume"], e)).toMatch(/usage/i);
    expect(runKeelCli(["sessions", "branch", "ses_x"], e)).toMatch(/usage/i);
    expect(runKeelCli(["sessions", "bogus"], e)).toMatch(/usage/i);
  });

  it("returns a machine-checkable failure for invalid usage and session errors", () => {
    const e = env();
    expect(runKeelCliResult(["sessions", "bogus"], e)).toMatchObject({ ok: false });
    expect(runKeelCliResult(["sessions", "resume", "../../etc/passwd"], e)).toMatchObject({
      ok: false,
    });
    expect(runKeelCliResult(["sessions", "list"], e)).toMatchObject({ ok: true });
  });
});
