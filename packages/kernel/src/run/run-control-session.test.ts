import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecutorPort,
  ModelPort,
  SessionEventT,
  UIPort,
  UserInput,
  ViewModel,
} from "@keel/shared";
import {
  Goal,
  LIFECYCLE_MANIFEST_VERSION,
  LifecycleManifest,
  LoopConfig,
  RUN_CONTROL_SCHEMA_VERSION,
} from "@keel/shared";
import { ScriptedModel } from "@keel/simulator";
import { SessionStore, readSession } from "../session/store.js";
import { listSessions } from "../session/list.js";
import { rebuild } from "../session/resume.js";
import { renderFrame } from "../tui/headless.js";
import { runSession } from "../tui/runner.js";
import { appendGoalAudit, goalAuditNotice, goalPrompt } from "./goal-session.js";
import { loopReceipt, runBoundedLoopSession } from "./loop-session.js";
import { physicalRowCount, terminalDisplayWidth } from "../tui/row-budget.js";
import { terminalReviewResult } from "../warden/terminal-review.js";
import { REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE } from "../events.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });

class CapturingUI implements UIPort {
  latest: ViewModel | undefined;

  render(view: ViewModel): void {
    this.latest = view;
  }

  async *inputs(): AsyncIterable<UserInput> {}

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A `UIPort` whose `inputs()` is a manually-fed async queue, so a test can inject a mid-run
 *  interrupt (`push({ kind: "interrupt" })`) deterministically. */
class InterruptibleUI implements UIPort {
  latest: ViewModel | undefined;
  #queue: UserInput[] = [];
  #waiter: ((r: IteratorResult<UserInput>) => void) | undefined;
  #closed = false;

  render(view: ViewModel): void {
    this.latest = view;
  }

  push(input: UserInput): void {
    const w = this.#waiter;
    if (w !== undefined) {
      this.#waiter = undefined;
      w({ value: input, done: false });
    } else {
      this.#queue.push(input);
    }
  }

  async *inputs(): AsyncIterable<UserInput> {
    for (;;) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      const r = await new Promise<IteratorResult<UserInput>>((resolve) => {
        this.#waiter = resolve;
      });
      if (r.done) return;
      yield r.value;
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#waiter?.({ value: undefined as never, done: true });
    return Promise.resolve();
  }
}

const goal = Goal.parse({
  schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
  id: "goal_product_path",
  objective: "ship a public goal product path",
  doneWhen: [{ id: "check-1", kind: "command", check: { argv: ["pnpm", "test"] } }],
  validation: { tier: "standard" },
  requiresCompletionAudit: true,
});

// A trusted manifest whose `standard` tier runs one action — lets a goal's --validation actually
// execute (as governed lifecycle.run) so completion reflects a REAL pass (Epic 2.15b).
const validationManifest = LifecycleManifest.parse({
  schemaVersion: LIFECYCLE_MANIFEST_VERSION,
  actions: { "test.unit": { argv: ["pnpm", "test"] } },
  validationTiers: { standard: { required: ["test.unit"] } },
});

const loop = LoopConfig.parse({
  schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
  id: "loop_product_path",
  prompt: "fix tests",
  until: {
    kind: "command",
    check: { argv: ["pnpm", "test"] },
    satisfiedWhen: "exitZero",
  },
  bounds: { maxIterations: 3 },
  requireProgressEachIteration: true,
});

const errorModel: ModelPort = {
  async *stream() {
    yield { type: "error", code: "provider-error", message: "provider failed" };
  },
};

describe("run-control sessions (Epic 2.12 product path)", () => {
  it("renders goal criteria for argv checks, lifecycle checks, and narrative evidence", () => {
    const mixed = Goal.parse({
      schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
      id: "goal_mixed",
      objective: "ship with evidence",
      doneWhen: [
        { id: "check-1", kind: "command", check: { argv: ["pnpm", "test"] } },
        { id: "check-2", kind: "command", check: { action: "test.unit" } },
        { id: "review", kind: "narrative", evidenceHint: "link the final review event" },
      ],
      requiresCompletionAudit: true,
    });

    expect(goalPrompt(mixed)).toContain("- check-1: run pnpm test");
    expect(goalPrompt(mixed)).toContain("- check-2: run lifecycle action test.unit");
    expect(goalPrompt(mixed)).toContain("- review: cite evidence (link the final review event)");
  });

  it("does not mark a goal complete when terminal validation did not run", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const evidence: SessionEventT[] = [
      {
        type: "assistant",
        v: 1,
        ts: "2026-06-27T00:00:00.000Z",
        content: "",
        toolCalls: [{ id: "call_1", name: "bash", args: { command: "pnpm test" } }],
      },
      {
        type: "tool_result",
        v: 1,
        ts: "2026-06-27T00:00:01.000Z",
        toolCallId: "call_1",
        name: "bash",
        output: "TEST SUMMARY (pnpm test): PASS",
      },
    ];
    const emitted: SessionEventT[] = [];

    const audit = appendGoalAudit({
      append: (event) => emitted.push(event),
      sessionId: store.id,
      goal,
      events: evidence,
      // No validation result supplied → a configured tier is honestly `not_run`, never faked.
      ts: "2026-06-27T00:00:02.000Z",
    });

    store.close();
    expect(audit.verdict).toBe("incomplete");
    expect(audit.validation).toEqual({ status: "not_run", tier: "standard" });
    expect(
      emitted.some((event) => event.type === "goal_failed" && event.reason === "incomplete"),
    ).toBe(true);
    expect(goalAuditNotice(audit)).toContain("gaps: validation");
  });

  it("marks satisfied goals without configured validation as unverified, not complete", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const noValidation = Goal.parse({
      schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
      id: "goal_no_validation",
      objective: "ship with command evidence",
      doneWhen: [{ id: "check-1", kind: "command", check: { argv: ["pnpm", "test"] } }],
      requiresCompletionAudit: true,
    });
    const evidence: SessionEventT[] = [
      {
        type: "assistant",
        v: 1,
        ts: "2026-06-27T00:00:00.000Z",
        content: "",
        toolCalls: [{ id: "call_1", name: "bash", args: { command: "pnpm test" } }],
      },
      {
        type: "tool_result",
        v: 1,
        ts: "2026-06-27T00:00:01.000Z",
        toolCallId: "call_1",
        name: "bash",
        output: "TEST SUMMARY (pnpm test): PASS",
      },
    ];
    const emitted: SessionEventT[] = [];

    const audit = appendGoalAudit({
      append: (event) => emitted.push(event),
      sessionId: store.id,
      goal: noValidation,
      events: evidence,
      ts: "2026-06-27T00:00:02.000Z",
    });

    store.close();
    expect(audit.verdict).toBe("unverified");
    expect(audit.validation).toEqual({ status: "not_configured" });
    expect(
      emitted.some((event) => event.type === "goal_failed" && event.reason === "unverified"),
    ).toBe(true);
    expect(goalAuditNotice(audit)).toContain("gaps: validation");
    // The next-step for `unverified` is honest (F-3 RC2a): checks passed, validation was not requested
    // — teach the opt-in, don't frame it as a defect to "resolve".
    const unverifiedNotice = goalAuditNotice(audit);
    expect(unverifiedNotice).toContain("checks passed");
    expect(unverifiedNotice).toContain("--validation <tier>");
    expect(unverifiedNotice).not.toContain("resolve gaps");
    expect(
      goalAuditNotice({
        schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
        goalId: "goal_no_validation",
        verdict: "unverified",
        validation: { status: "not_configured" },
        criteria: [
          {
            criterionId: "check-1",
            status: "satisfied",
            assurance: "machine_verified",
            evidence: [{ kind: "session_event", ref: "tool_result:call_1" }],
          },
        ],
        gaps: [],
      }),
    ).toContain("gaps: none");
  });

  it("teaches how to enable a validation tier that did not run", () => {
    const notice = goalAuditNotice({
      schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
      goalId: "goal_product_path",
      verdict: "incomplete",
      validation: { status: "not_run", tier: "standard" },
      criteria: [
        {
          criterionId: "check-1",
          status: "satisfied",
          assurance: "machine_verified",
          evidence: [{ kind: "session_event", ref: "tool_result:call_1" }],
        },
      ],
      gaps: ["validation"],
    });
    // Still reports the gap...
    expect(notice).toContain("gaps: validation");
    // ...and teaches the fix: name the tier and point at the lifecycle manifest (what · why · how).
    expect(notice).toContain("standard");
    expect(notice).toMatch(/lifecycle manifest/i);
    expect(notice).toMatch(/rerun/i);
  });

  it("bounds hostile Unicode goal receipts by grapheme and terminal cell width", () => {
    const hostileGoal = Goal.parse({
      schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
      id: "goal_hostile_receipt",
      objective: `${"界".repeat(1_000)}\u0007\nforged status`,
      doneWhen: [
        {
          id: "check-hostile",
          kind: "command",
          check: { argv: ["pnpm", "test", "--filter", "🧪".repeat(400)] },
        },
      ],
      requiresCompletionAudit: true,
    });
    const notice = goalAuditNotice(
      {
        schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
        goalId: hostileGoal.id,
        verdict: "incomplete",
        validation: { status: "not_configured" },
        criteria: [
          {
            criterionId: "check-hostile",
            status: "unsatisfied",
            assurance: "machine_verified",
            evidence: [
              {
                kind: "session_event",
                ref: `tool_result:${"e\u0301界".repeat(1_000)}`,
              },
            ],
          },
        ],
        gaps: ["check-hostile"],
      },
      hostileGoal,
    );

    const lines = notice.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines.every((line) => terminalDisplayWidth(line) <= 72)).toBe(true);
    expect(lines.every((line) => physicalRowCount(line, 40) <= 2)).toBe(true);
    expect(notice).not.toContain("\u0007");
    expect(notice).not.toContain("forged status");
  });

  it("completes only after the validation tier really runs and passes", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    const executed: string[] = [];

    await runSession({
      model: new ScriptedModel({
        turns: [
          { toolCalls: [{ name: "bash", args: { command: "pnpm test" } }] },
          { text: "done" },
        ],
      }),
      executor: {
        execute: (call) => {
          executed.push(call.name);
          return Promise.resolve({ ok: true, output: "TEST SUMMARY (pnpm test): PASS" });
        },
      },
      ui,
      store,
      seed: [{ role: "user", content: "ship it" }],
      env: e,
      goal,
      lifecycleManifest: validationManifest,
    });

    store.close();
    const events = readSession(store.id, e).events;
    // The validation tier ran for real as a governed lifecycle.run (not a faked model-stop pass).
    expect(executed).toContain("lifecycle.run");
    expect(events.some((event) => event.type === "goal_started")).toBe(true);
    const audit = events.find((event) => event.type === "goal_audit");
    expect(audit?.type === "goal_audit" && audit.audit.verdict).toBe("complete");
    expect(audit?.type === "goal_audit" && audit.audit.validation).toEqual({
      status: "passed",
      tier: "standard",
    });
    expect(events.some((event) => event.type === "goal_completed")).toBe(true);
    const frame = renderFrame(ui.latest!);
    expect(frame).toContain("goal complete · ship a public goal product path");
    expect(frame).toContain("check · pnpm test");
    expect(frame).toContain("verification · standard · passed");
    expect(frame).toContain("criteria · 1/1 satisfied · gaps: none");
    expect(frame).toContain("evidence · 1 ref · tool_result:");
    expect(ui.latest?.turnSummary?.receipt).toHaveLength(6);
    expect(frame).not.toMatch(/checked: next ·/u);
    expect(frame).not.toMatch(/note\s+goal complete/iu);
    expect(frame).not.toContain("goal complete: goal_product_path");
  });

  it("does not complete when the validation tier runs and fails", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();

    await runSession({
      model: new ScriptedModel({
        turns: [
          { toolCalls: [{ name: "bash", args: { command: "pnpm test" } }] },
          { text: "done" },
        ],
      }),
      executor: {
        // The model's check passes, but the governed validation tier action fails.
        execute: (call) =>
          Promise.resolve(
            call.name === "lifecycle.run"
              ? { ok: false, output: "blocked by warden [denied]" }
              : { ok: true, output: "TEST SUMMARY (pnpm test): PASS" },
          ),
      },
      ui,
      store,
      seed: [{ role: "user", content: "ship it" }],
      env: e,
      goal,
      lifecycleManifest: validationManifest,
    });

    store.close();
    const events = readSession(store.id, e).events;
    const audit = events.find((event) => event.type === "goal_audit");
    expect(audit?.type === "goal_audit" && audit.audit.verdict).toBe("incomplete");
    expect(audit?.type === "goal_audit" && audit.audit.validation).toEqual({
      status: "failed",
      tier: "standard",
    });
    expect(events.some((event) => event.type === "goal_completed")).toBe(false);
  });

  it("does not run the validation tier when the goal turn is interrupted (records not_run)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InterruptibleUI();
    const slowStarted = deferred();
    const executed: string[] = [];

    const done = runSession({
      model: new ScriptedModel({
        turns: [{ toolCalls: [{ name: "slow", args: {} }] }, { text: "done" }],
      }),
      executor: {
        execute: (call, opts) => {
          executed.push(call.name);
          if (call.name === "slow") {
            slowStarted.resolve();
            return new Promise((resolve) => {
              const sig = opts?.signal;
              const finish = (): void => resolve({ ok: true, output: "stopped" });
              if (sig?.aborted === true) finish();
              else sig?.addEventListener("abort", finish, { once: true });
            });
          }
          // The validation tier (lifecycle.run) would pass if it ran — it must NOT run after interrupt.
          return Promise.resolve({ ok: true, output: "TEST SUMMARY (pnpm test): PASS" });
        },
      },
      ui,
      store,
      seed: [{ role: "user", content: "ship it" }],
      env: e,
      goal,
      lifecycleManifest: validationManifest,
    });

    await slowStarted.promise;
    ui.push({ kind: "interrupt" });
    await done;
    store.close();

    // The interrupt cancelled the turn before validation — the tier must not have launched...
    expect(executed).not.toContain("lifecycle.run");
    // ...and the goal audit must honestly report not_run, never a fabricated pass.
    const events = readSession(store.id, e).events;
    const audit = events.find((event) => event.type === "goal_audit");
    expect(audit?.type === "goal_audit" && audit.audit.validation).toEqual({
      status: "not_run",
      tier: "standard",
    });
    expect(events.some((event) => event.type === "goal_completed")).toBe(false);
    expect(events.some((event) => event.type === "goal_failed" && event.reason === "aborted")).toBe(
      true,
    );
  });

  it("does not complete a goal from model self-report", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();

    await runSession({
      model: new ScriptedModel({ turns: [{ text: "I am done; tests pass." }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "unused" }) },
      ui,
      store,
      seed: [{ role: "user", content: "ship it" }],
      env: e,
      goal,
    });

    store.close();
    const events = readSession(store.id, e).events;
    expect(events.some((event) => event.type === "goal_completed")).toBe(false);
    expect(
      events.some((event) => event.type === "goal_failed" && event.reason === "incomplete"),
    ).toBe(true);
    expect(renderFrame(ui.latest!)).toMatch(/goal incomplete/i);
  });

  it("runs a bounded loop until an executor-owned exit check passes", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    let checks = 0;
    const executor: ExecutorPort = {
      execute: (call) => {
        if (call.name !== "bash") return Promise.resolve({ ok: false, output: "unexpected" });
        checks += 1;
        return Promise.resolve(
          checks === 1
            ? {
                ok: true,
                output: JSON.stringify({
                  exitCode: 1,
                  signal: null,
                  stdout: "",
                  stderr: "1 test failed",
                }),
              }
            : {
                ok: true,
                output: JSON.stringify({
                  exitCode: 0,
                  signal: null,
                  stdout: "1 test passed",
                  stderr: "",
                }),
              },
        );
      },
    };

    const outcome = await runBoundedLoopSession({
      model: new ScriptedModel({ turns: [{ text: "attempt one" }, { text: "attempt two" }] }),
      executor,
      ui,
      store,
      seed: [{ role: "user", content: "fix tests" }],
      env: e,
      loop: {
        ...loop,
      },
    });

    store.close();
    expect(outcome.lastStop).toBe("model-stop");
    expect(checks).toBe(2);
    const events = readSession(store.id, e).events;
    expect(
      events.filter(
        (event) => event.type === "loop_iteration" && event.status === "exit-check-failed",
      ),
    ).toHaveLength(1);
    expect(
      events.some((event) => event.type === "loop_stopped" && event.reason === "succeeded"),
    ).toBe(true);
    const frame = renderFrame(ui.latest!);
    expect(frame).toMatch(/loop succeeded/i);
    expect(frame).toContain("check · pnpm test");
    expect(frame).toContain("iterations · 2/3");
    expect(frame).toContain("result · executed · exit 0");
    expect(frame).toContain("evidence · 2 refs · first");
    expect(frame).toContain("last");
    expect(frame).toContain("next · bounded loop complete");
    const oneShot = renderFrame(ui.latest!, true, false);
    expect(oneShot.match(/loop succeeded/giu)).toHaveLength(1);
    expect(oneShot).toContain("iterations · 2/3");
    expect(ui.latest?.turnSummary?.receipt).toHaveLength(6);
    expect(frame).not.toMatch(/note\s+loop succeeded/iu);
    const controller = "Keel loop controller · exit check failed";
    expect(
      events.some((event) => event.type === "user" && event.content.startsWith(controller)),
    ).toBe(false);
    expect(
      events.some((event) => event.type === "system" && event.content.startsWith(controller)),
    ).toBe(false);
    expect(
      outcome.finalMessages.some(
        (message) => message.role === "user" && message.content.startsWith(controller),
      ),
    ).toBe(true);
    expect(
      outcome.finalMessages.some(
        (message) => message.role === "system" && message.content.startsWith(controller),
      ),
    ).toBe(false);
    expect(frame).not.toContain(`you  ${controller}`);
    expect(frame).toContain(`note\n  ${controller}`);
  });

  it("credits a successful controller exit check after the model turn changed a file", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    const executor: ExecutorPort = {
      execute: (call) => {
        if (call.name === "write") {
          return Promise.resolve({ ok: true, output: "write: created 'result.txt' (3 bytes)" });
        }
        if (call.name === "bash") {
          return Promise.resolve({
            ok: true,
            output: JSON.stringify({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
          });
        }
        return Promise.resolve({ ok: false, output: `unexpected tool ${call.name}` });
      },
    };

    const outcome = await runBoundedLoopSession({
      model: new ScriptedModel({
        turns: [
          { toolCalls: [{ name: "write", args: { path: "result.txt", content: "ok\n" } }] },
          { text: "the requested file is ready" },
        ],
      }),
      executor,
      ui,
      store,
      seed: [{ role: "user", content: "write result.txt and verify it" }],
      env: e,
      loop: { ...loop, bounds: { maxIterations: 1 } },
    });

    store.close();
    expect(outcome.lastStop).toBe("model-stop");
    expect(ui.latest?.turnSummary?.fileEvidence).toHaveLength(1);
    expect(ui.latest?.turnSummary?.checked).toEqual(["pnpm test"]);
    const frame = renderFrame(ui.latest!);
    expect(frame).toContain("loop succeeded");
    expect(frame).toContain("checked");
    expect(frame).toContain("pnpm test");
    expect(frame).not.toContain("verification not run");
  });

  // "No hidden green": a FAILING exit check must never read as passed just because the governed
  // result carries a warden guidance header before the JSON body (`header\n\nbody`, e.g. a POL-008
  // `warn` on `pnpm install`). The old detector JSON.parse'd the whole output, so the header broke
  // the parse and "cannot determine" silently meant "passed" — declaring a bounded loop successful
  // on red tests and exiting 0.
  it("does not treat a failing exit check as passed when the warden prepends a guidance header", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    let checks = 0;
    const failingBody = JSON.stringify({
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "1 test failed",
    });
    const executor: ExecutorPort = {
      execute: (call) => {
        if (call.name !== "bash") return Promise.resolve({ ok: false, output: "unexpected" });
        checks += 1;
        // `ok: true` — the warden ALLOWED it (warn verdict), but the command itself failed.
        return Promise.resolve({
          ok: true,
          output: `warden warning: POL-008 warn: package install may run supply-chain scripts\n\n${failingBody}`,
        });
      },
    };

    await runBoundedLoopSession({
      model: new ScriptedModel({ turns: [{ text: "attempt one" }, { text: "attempt two" }] }),
      executor,
      ui,
      store,
      seed: [{ role: "user", content: "fix tests" }],
      env: e,
      loop: { ...loop, bounds: { maxIterations: 2 } },
    });

    store.close();
    const events = readSession(store.id, e).events;
    // The loop must NOT report success on a failing check.
    expect(
      events.some((event) => event.type === "loop_stopped" && event.reason === "succeeded"),
    ).toBe(false);
    expect(
      events.filter(
        (event) => event.type === "loop_iteration" && event.status === "exit-check-failed",
      ).length,
    ).toBeGreaterThan(0);
    expect(checks).toBe(2); // it kept iterating instead of stopping early on a false pass
    expect(ui.latest?.turnSummary?.checked).toEqual([]);
    expect(renderFrame(ui.latest!)).not.toMatch(/loop succeeded/iu);
  });

  it.each([
    [
      "review",
      "warden review required (not executed): exact command requires approval; no live approval is active",
      /needs approval|review required/iu,
    ],
    ["blocked", "blocked by warden (not executed): outside workspace", /blocked by policy/iu],
    ["stopped", "tool execution aborted by user", /outcome unknown.*interrupted/isu],
    [
      "control failure",
      "warden execution failed (WARDEN_CLOSED): connection closed",
      /may have executed/iu,
    ],
  ] as const)(
    "stops after a non-executed %s exit check without spending another model iteration",
    async (_kind, output, notice) => {
      const e = env();
      const store = SessionStore.create({ cwd: "/w" }, e);
      const ui = new CapturingUI();
      let modelCalls = 0;
      const model: ModelPort = {
        async *stream() {
          modelCalls += 1;
          yield { type: "text-delta", text: "attempt" };
          yield {
            type: "finish",
            reason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };

      const outcome = await runBoundedLoopSession({
        model,
        executor: { execute: () => Promise.resolve({ ok: false, output }) },
        ui,
        store,
        seed: [{ role: "user", content: "fix tests" }],
        env: e,
        loop: { ...loop, id: `loop_non_execution_${_kind.replace(/\s+/gu, "_")}` },
      });

      store.close();
      expect(modelCalls).toBe(1);
      expect(outcome.lastStop).toBe("error");
      const events = readSession(store.id, e).events;
      const rebuilt = rebuild(readSession(store.id, e));
      expect(rebuilt.finished).toBe(false);
      expect(rebuilt.lastStop).toBe("error");
      expect(listSessions(e)[0]).toMatchObject({ lastStop: "error" });
      expect(
        events.filter(
          (event) => event.type === "loop_iteration" && event.status === "exit-check-failed",
        ),
      ).toHaveLength(0);
      expect(
        events.filter((event) => event.type === "loop_stopped" && event.reason === "error"),
      ).toHaveLength(1);
      expect(renderFrame(outcome.finalView)).toMatch(notice);
      const frame = renderFrame(outcome.finalView);
      expect(frame).toContain("check · pnpm test");
      expect(frame).toContain("iterations · 1/3");
      expect(frame).toContain("evidence · 1 ref · tool_result:");
      expect(frame).toContain("next ·");
    },
  );

  it("forces loop exit checks through the terminal review path after the turn UI disconnects", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    const approvalModes: unknown[] = [];

    await runBoundedLoopSession({
      model: new ScriptedModel({ turns: [{ text: "iteration complete" }] }),
      executor: {
        execute: (_call, options) => {
          approvalModes.push(
            (options as { readonly approvalMode?: unknown } | undefined)?.approvalMode,
          );
          return Promise.resolve({
            ok: false,
            output:
              "warden review required (not executed): exact human approval required; no live approval is active",
          });
        },
      },
      ui,
      store,
      seed: [{ role: "user", content: "fix tests" }],
      env: e,
      loop: { ...loop, id: "loop_terminal_review_mode" },
    });

    store.close();
    expect(approvalModes).toEqual(["terminal"]);
    const frame = renderFrame(ui.latest!);
    expect(frame).toMatch(/review required/i);
    expect(frame).toContain("result · not executed · review required");
    expect(frame).toContain("if session approval is offered");
  });

  it("does not suggest reusable approval for a once-only loop exit check", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();

    await runBoundedLoopSession({
      model: new ScriptedModel({ turns: [{ text: "iteration complete" }] }),
      executor: {
        execute: () =>
          Promise.resolve({
            ok: false,
            output:
              "warden review required (not executed): workspace deletion requires exact once-only approval: rm stale.txt; no live approval is active",
          }),
      },
      ui,
      store,
      seed: [{ role: "user", content: "remove stale file" }],
      env: e,
      loop: {
        ...loop,
        id: "loop_once_only_review",
        until: { kind: "command", check: { argv: ["rm", "stale.txt"] }, satisfiedWhen: "exitZero" },
      },
    });

    store.close();
    const frame = renderFrame(ui.latest!);
    expect(frame).toContain("once-only checks cannot repeat");
    expect(frame).not.toContain("grant it before rerunning");
  });

  it("bounds loop receipts while disclosing omitted command and evidence detail", () => {
    const receipt = loopReceipt({
      outcome: "loop stopped · loop-max-iterations",
      command: `pnpm test --filter ${"界".repeat(1_024)}`,
      iteration: 1_000,
      maxIterations: 1_000,
      execution: "executed",
      result: "exit 1",
      evidenceRefs: Array.from(
        { length: 1_000 },
        (_, index) => `tool_result:loop_bounded_receipt_exit_${String(index + 1)}`,
      ),
      next: "review failed-check evidence before starting a new bounded loop",
    });
    const lines = receipt.split("\n");

    expect(lines).toHaveLength(6);
    expect(lines.every((line) => terminalDisplayWidth(line) <= 72)).toBe(true);
    expect(receipt).toContain("check ·");
    expect(receipt).toContain("…");
    expect(receipt).toContain("evidence · 1000 refs · first");
    expect(receipt).toContain("last");
    expect(receipt).not.toContain("exit_500");
    expect(physicalRowCount(receipt, 80)).toBeLessThanOrEqual(6);
    expect(physicalRowCount(receipt, 40)).toBeLessThanOrEqual(12);
  });

  it("stops a loop at max iterations instead of repeating indefinitely", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();

    await runBoundedLoopSession({
      model: new ScriptedModel({ turns: [{ text: "attempt one" }, { text: "attempt two" }] }),
      executor: {
        execute: () =>
          Promise.resolve({
            ok: true,
            output: JSON.stringify({ exitCode: 1, signal: null, stdout: "", stderr: "not yet" }),
          }),
      },
      ui,
      store,
      seed: [{ role: "user", content: "fix tests" }],
      env: e,
      loop: {
        ...loop,
        id: "loop_max_iterations",
        bounds: { maxIterations: 2 },
      },
    });

    store.close();
    const events = readSession(store.id, e).events;
    expect(
      events.some(
        (event) => event.type === "loop_stopped" && event.reason === "loop-max-iterations",
      ),
    ).toBe(true);
    expect(renderFrame(ui.latest!)).toMatch(/loop stopped · loop-max-iterations/i);
  });

  it("keeps the model-turn cap cumulative across bounded-loop iterations", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    let modelCalls = 0;
    let exitChecks = 0;
    const model: ModelPort = {
      async *stream() {
        modelCalls += 1;
        yield { type: "text-delta", text: "attempt" };
        yield { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const outcome = await runBoundedLoopSession({
      model,
      executor: {
        execute: () => {
          exitChecks += 1;
          return Promise.resolve({
            ok: true,
            output: JSON.stringify({
              exitCode: 1,
              signal: null,
              stdout: "",
              stderr: "not yet",
            }),
          });
        },
      },
      ui,
      store,
      seed: [{ role: "user", content: "fix tests" }],
      env: e,
      stop: { maxTurns: 1 },
      loop: { ...loop, id: "loop_cumulative_turn_cap" },
    });

    store.close();
    expect(modelCalls).toBe(1);
    expect(exitChecks).toBe(1);
    expect(outcome.lastStop).toBe("budget");
    expect(renderFrame(outcome.finalView)).toContain(
      "model-turn bound exhausted before exit check",
    );
    expect(renderFrame(outcome.finalView)).toContain(
      "raise model-turn bound only after reviewing prior evidence",
    );
    expect(
      readSession(store.id, e).events.some(
        (event) => event.type === "loop_stopped" && event.reason === "loop-budget",
      ),
    ).toBe(true);
  });

  it("keeps the cache-weighted effective-token cap cumulative across bounded-loop iterations", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    const usage = {
      inputTokens: 40,
      outputTokens: 1,
      cachedInputTokens: 40,
      cacheCreationInputTokens: 3,
    };
    let modelCalls = 0;
    let exitChecks = 0;
    const model: ModelPort = {
      async *stream() {
        modelCalls += 1;
        yield { type: "text-delta", text: "attempt" };
        yield { type: "finish", reason: "stop", usage };
      },
    };

    const outcome = await runBoundedLoopSession({
      model,
      executor: {
        execute: () => {
          exitChecks += 1;
          return Promise.resolve({
            ok: true,
            output: JSON.stringify({
              exitCode: 1,
              signal: null,
              stdout: "",
              stderr: "not yet",
            }),
          });
        },
      },
      ui,
      store,
      seed: [{ role: "user", content: "fix tests" }],
      env: e,
      stop: { budget: { maxTokens: 10, cacheReadWeight: 0.1 } },
      loop: { ...loop, id: "loop_cumulative_effective_cap" },
    });

    store.close();
    expect(modelCalls).toBe(2);
    expect(exitChecks).toBe(2);
    expect(outcome.lastStop).toBe("budget");
    const statuses = readSession(store.id, e).events.filter((event) => event.type === "run_status");
    expect(statuses).toHaveLength(3);
    expect(statuses[0]).toMatchObject({ usage });
    expect(statuses[1]).toMatchObject({ usage });
    expect(statuses[2]).toMatchObject({
      reason: "budget",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
    expect(listSessions(e)[0]?.usageTokens).toBe(82);
    expect(outcome.finalView.status.tokens).toBe(82);
  });

  it.each([
    ["gross", { maxGrossTokens: 10 }, { inputTokens: 9, outputTokens: 1 }],
    ["output", { maxOutputTokens: 10 }, { inputTokens: 1, outputTokens: 10 }],
  ] as const)(
    "keeps the %s-token cap cumulative across bounded-loop iterations",
    async (kind, budget, usage) => {
      const e = env();
      const store = SessionStore.create({ cwd: "/w" }, e);
      const ui = new CapturingUI();
      let modelCalls = 0;
      let exitChecks = 0;
      const model: ModelPort = {
        async *stream() {
          modelCalls += 1;
          yield { type: "text-delta", text: "attempt" };
          yield { type: "finish", reason: "stop", usage };
        },
      };

      const outcome = await runBoundedLoopSession({
        model,
        executor: {
          execute: () => {
            exitChecks += 1;
            return Promise.resolve({
              ok: true,
              output: JSON.stringify({
                exitCode: 1,
                signal: null,
                stdout: "",
                stderr: "not yet",
              }),
            });
          },
        },
        ui,
        store,
        seed: [{ role: "user", content: "fix tests" }],
        env: e,
        stop: { budget },
        loop: { ...loop, id: `loop_cumulative_${kind}_cap` },
      });

      store.close();
      expect(modelCalls).toBe(1);
      expect(exitChecks).toBe(1);
      expect(outcome.lastStop).toBe("budget");
      const statuses = readSession(store.id, e).events.filter(
        (event) => event.type === "run_status",
      );
      expect(statuses).toHaveLength(2);
      expect(statuses[0]).toMatchObject({ usage });
      expect(statuses[1]).toMatchObject({
        reason: "budget",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      });
      expect(listSessions(e)[0]?.usageTokens).toBe(usage.inputTokens + usage.outputTokens);
    },
  );

  it("keeps cumulative usage and one-shot warning state across bounded-loop iterations", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    const usages = [
      { inputTokens: 60, outputTokens: 0 },
      { inputTokens: 1, outputTokens: 0 },
      { inputTokens: 1, outputTokens: 0 },
    ];
    let modelCalls = 0;
    const model: ModelPort = {
      async *stream() {
        const usage = usages[modelCalls] ?? { inputTokens: 1, outputTokens: 0 };
        modelCalls += 1;
        yield { type: "text-delta", text: "attempt" };
        yield { type: "finish", reason: "stop", usage };
      },
    };

    await runBoundedLoopSession({
      model,
      executor: {
        execute: () =>
          Promise.resolve({
            ok: true,
            output: JSON.stringify({
              exitCode: 1,
              signal: null,
              stdout: "",
              stderr: "not yet",
            }),
          }),
      },
      ui,
      store,
      seed: [{ role: "user", content: "fix tests" }],
      env: e,
      stop: { budget: { maxTokens: 200, warnThresholds: [0.25] } },
      loop: { ...loop, id: "loop_cumulative_warning" },
    });

    store.close();
    const events = readSession(store.id, e).events;
    expect(modelCalls).toBe(3);
    expect(
      events.filter((event) => event.type === "user" && event.content.startsWith("Budget notice:")),
    ).toHaveLength(1);
    expect(
      events.flatMap((event) => (event.type === "run_status" ? [event.usage.inputTokens] : [])),
    ).toEqual([60, 1, 1]);
    expect(listSessions(e)[0]?.usageTokens).toBe(62);
  });

  it.each([
    ["finalize", "pytest -q", "================ 1 passed in 0.01s ================", "finalize"],
    [
      "finalize goal-check",
      "node goal-check.mjs",
      JSON.stringify({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
      "finalize",
    ],
    ["progress runway", "make all", "stage: parser\ncompiling parser objects", "runway"],
  ] as const)(
    "does not regrant a %s turn after an outer loop iteration",
    async (kind, command, toolOutput, allowance) => {
      const e = env();
      const store = SessionStore.create({ cwd: "/w" }, e);
      const ui = new CapturingUI();
      let modelCalls = 0;
      let exitChecks = 0;
      const captured: string[][] = [];
      const model: ModelPort = {
        async *stream(input) {
          modelCalls += 1;
          captured.push(input.messages.map((message) => message.content));
          if (modelCalls % 2 === 1) {
            yield {
              type: "tool-call",
              id: `call-${String(modelCalls)}`,
              name: "bash",
              args: { command },
            };
            yield {
              type: "finish",
              reason: "tool-calls",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
            return;
          }
          yield { type: "text-delta", text: "final answer" };
          yield { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      const executor: ExecutorPort = {
        execute: (call) => {
          if (call.args["command"] === command) {
            return Promise.resolve({ ok: true, output: toolOutput });
          }
          exitChecks += 1;
          return Promise.resolve({
            ok: true,
            output: JSON.stringify({
              exitCode: 1,
              signal: null,
              stdout: "",
              stderr: "not yet",
            }),
          });
        },
      };

      const outcome = await runBoundedLoopSession({
        model,
        executor,
        ui,
        store,
        seed: [{ role: "user", content: "fix tests" }],
        env: e,
        stop:
          allowance === "finalize"
            ? { maxTurns: 1, maxFinalizeTurns: 1 }
            : {
                maxTurns: 1,
                maxProgressRunwayTurns: 1,
                budget: { maxTokens: 1_000_000 },
              },
        loopDetection: { maxToolRepeats: 99 },
        loop: { ...loop, id: `loop_cumulative_${kind.replace(/\s+/gu, "_")}` },
      });

      store.close();
      expect(modelCalls).toBe(2);
      expect(exitChecks).toBe(1);
      expect(outcome.lastStop).toBe("budget");
      expect(captured[1]?.join("\n")).toContain(
        allowance === "finalize" ? "Finalize turn 1 of 1" : "Progress runway turn 1 of 1",
      );
    },
  );

  it("arms only the remaining wall deadline after an outer loop iteration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    let modelCalls = 0;
    let exitChecks = 0;
    let settled = false;
    const secondModelStarted = deferred();
    const model: ModelPort = {
      async *stream(input) {
        modelCalls += 1;
        if (modelCalls === 1) {
          yield { type: "text-delta", text: "attempt" };
          yield { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        secondModelStarted.resolve();
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted === true) {
            resolve();
            return;
          }
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "finish", reason: "aborted", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    try {
      const running = runBoundedLoopSession({
        model,
        executor: {
          execute: async () => {
            exitChecks += 1;
            await vi.advanceTimersByTimeAsync(90);
            return {
              ok: true,
              output: JSON.stringify({
                exitCode: 1,
                signal: null,
                stdout: "",
                stderr: "not yet",
              }),
            };
          },
        },
        ui,
        store,
        seed: [{ role: "user", content: "fix tests" }],
        env: e,
        stop: { maxWallMs: 100 },
        loop: {
          ...loop,
          id: "loop_cumulative_deadline",
          bounds: { maxIterations: 2 },
        },
      }).then((outcome) => {
        settled = true;
        return outcome;
      });

      await secondModelStarted.promise;
      await vi.advanceTimersByTimeAsync(11);
      const settledWithinRemainingDeadline = settled;
      if (!settled) await vi.advanceTimersByTimeAsync(100);
      const outcome = await running;

      expect(settledWithinRemainingDeadline).toBe(true);
      expect(modelCalls).toBe(2);
      expect(exitChecks).toBe(1);
      expect(outcome.lastStop).toBe("deadline");
      expect(renderFrame(outcome.finalView)).toContain("hard deadline reached before exit check");
      expect(renderFrame(outcome.finalView)).toContain(
        "raise the explicit bound only after reviewing deadline evidence",
      );
      expect(
        readSession(store.id, e).events.some(
          (event) => event.type === "loop_stopped" && event.reason === "loop-deadline",
        ),
      ).toBe(true);
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("does not dispatch after the cumulative wall deadline is already exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    let modelCalls = 0;
    let exitChecks = 0;
    const model: ModelPort = {
      async *stream() {
        modelCalls += 1;
        yield { type: "text-delta", text: "attempt" };
        yield { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    try {
      const outcome = await runBoundedLoopSession({
        model,
        executor: {
          execute: async () => {
            exitChecks += 1;
            await vi.advanceTimersByTimeAsync(100);
            return {
              ok: true,
              output: JSON.stringify({
                exitCode: 1,
                signal: null,
                stdout: "",
                stderr: "not yet",
              }),
            };
          },
        },
        ui,
        store,
        seed: [{ role: "user", content: "fix tests" }],
        env: e,
        stop: { maxWallMs: 100 },
        loop: { ...loop, id: "loop_exhausted_cumulative_deadline" },
      });

      expect(modelCalls).toBe(1);
      expect(exitChecks).toBe(1);
      expect(outcome.lastStop).toBe("deadline");
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("does not dispatch an exit check when the physical deadline expires at the inner-run boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    let modelCalls = 0;
    let exitChecks = 0;
    const ui = new (class extends CapturingUI {
      override render(view: ViewModel): void {
        super.render(view);
        if (view.turnSummary !== undefined) vi.setSystemTime(100);
      }
    })();
    const model: ModelPort = {
      async *stream() {
        modelCalls += 1;
        yield { type: "text-delta", text: "attempt" };
        yield { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    try {
      const outcome = await runBoundedLoopSession({
        model,
        executor: {
          execute: () => {
            exitChecks += 1;
            return Promise.resolve({ ok: true, output: "unused" });
          },
        },
        ui,
        store,
        seed: [{ role: "user", content: "fix tests" }],
        env: e,
        stop: { maxWallMs: 100 },
        loop: { ...loop, id: "loop_exact_boundary_cumulative_deadline" },
      });

      expect(modelCalls).toBe(1);
      expect(exitChecks).toBe(0);
      expect(outcome.lastStop).toBe("deadline");
      expect(renderFrame(outcome.finalView)).toContain("hard deadline reached before exit check");
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("keeps the progress-runway wall deadline across an outer loop iteration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    let modelCalls = 0;
    let exitChecks = 0;
    const model: ModelPort = {
      async *stream() {
        modelCalls += 1;
        if (modelCalls === 1) {
          yield {
            type: "tool-call",
            id: "runway-build",
            name: "bash",
            args: { command: "make all" },
          };
          yield {
            type: "finish",
            reason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
          return;
        }
        yield { type: "text-delta", text: "finished build path" };
        yield { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    try {
      const outcome = await runBoundedLoopSession({
        model,
        executor: {
          execute: async (call) => {
            if (call.args["command"] === "make all") {
              return { ok: true, output: "stage: parser\ncompiling parser objects" };
            }
            exitChecks += 1;
            await vi.advanceTimersByTimeAsync(100);
            return {
              ok: true,
              output: JSON.stringify({
                exitCode: 1,
                signal: null,
                stdout: "",
                stderr: "not yet",
              }),
            };
          },
        },
        ui,
        store,
        seed: [{ role: "user", content: "fix tests" }],
        env: e,
        stop: {
          maxTurns: 1,
          maxProgressRunwayTurns: 2,
          maxProgressRunwayWallMs: 100,
          budget: { maxTokens: 1_000_000 },
        },
        loopDetection: { maxToolRepeats: 99 },
        loop: { ...loop, id: "loop_cumulative_runway_deadline" },
      });

      expect(modelCalls).toBe(2);
      expect(exitChecks).toBe(1);
      expect(outcome.lastStop).toBe("deadline");
      expect(
        readSession(store.id, e).events.some(
          (event) => event.type === "loop_stopped" && event.reason === "loop-deadline",
        ),
      ).toBe(true);
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("does not extend the cumulative deadline when wall time rolls backward", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    let modelCalls = 0;
    let exitChecks = 0;
    const model: ModelPort = {
      async *stream() {
        modelCalls += 1;
        yield { type: "text-delta", text: "attempt" };
        yield { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    try {
      const outcome = await runBoundedLoopSession({
        model,
        executor: {
          execute: async () => {
            exitChecks += 1;
            vi.setSystemTime(0);
            await vi.advanceTimersByTimeAsync(100);
            return {
              ok: true,
              output: JSON.stringify({
                exitCode: 1,
                signal: null,
                stdout: "",
                stderr: "not yet",
              }),
            };
          },
        },
        ui,
        store,
        seed: [{ role: "user", content: "fix tests" }],
        env: e,
        stop: { maxWallMs: 100 },
        loop: { ...loop, id: "loop_monotonic_cumulative_deadline" },
      });

      expect(modelCalls).toBe(1);
      expect(exitChecks).toBe(1);
      expect(outcome.lastStop).toBe("deadline");
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("counts wall-clock forward jumps when the monotonic clock does not advance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    let modelCalls = 0;
    let exitChecks = 0;
    const model: ModelPort = {
      async *stream() {
        modelCalls += 1;
        yield { type: "text-delta", text: "attempt" };
        yield { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    try {
      const outcome = await runBoundedLoopSession({
        model,
        executor: {
          execute: () => {
            exitChecks += 1;
            vi.setSystemTime(10_100);
            return Promise.resolve({
              ok: true,
              output: JSON.stringify({
                exitCode: 1,
                signal: null,
                stdout: "",
                stderr: "not yet",
              }),
            });
          },
        },
        ui,
        store,
        seed: [{ role: "user", content: "fix tests" }],
        env: e,
        stop: { maxWallMs: 100 },
        loop: { ...loop, id: "loop_wall_jump_cumulative_deadline" },
      });

      expect(modelCalls).toBe(1);
      expect(exitChecks).toBe(1);
      expect(outcome.lastStop).toBe("deadline");
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("binds in-flight model work to the tighter loop wall deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    const modelStarted = deferred();
    let signalAborted = false;
    let exitChecks = 0;
    const model: ModelPort = {
      async *stream(input) {
        modelStarted.resolve();
        await new Promise<void>((resolve) => {
          const fallback = setTimeout(resolve, 20);
          input.signal?.addEventListener(
            "abort",
            () => {
              signalAborted = true;
              clearTimeout(fallback);
              resolve();
            },
            { once: true },
          );
        });
        yield { type: "finish", reason: "aborted", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    try {
      const running = runBoundedLoopSession({
        model,
        executor: {
          execute: () => {
            exitChecks += 1;
            return Promise.resolve({ ok: true, output: "unused" });
          },
        },
        ui,
        store,
        seed: [{ role: "user", content: "fix tests" }],
        env: e,
        loop: {
          ...loop,
          id: "loop_tighter_in_flight_deadline",
          bounds: { maxIterations: 3, maxWallMs: 10 },
        },
      });
      await modelStarted.promise;
      await vi.advanceTimersByTimeAsync(11);
      if (!signalAborted) await vi.advanceTimersByTimeAsync(10);
      const outcome = await running;

      expect(signalAborted).toBe(true);
      expect(exitChecks).toBe(0);
      expect(outcome.lastStop).toBe("deadline");
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("does not accept a passing exit check after the loop wall deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    let exitCheckSignalAborted = false;

    try {
      const running = runBoundedLoopSession({
        model: new ScriptedModel({ turns: [{ text: "attempt" }] }),
        executor: {
          execute: async (_call, options) => {
            await vi.advanceTimersByTimeAsync(11);
            exitCheckSignalAborted = options?.signal?.aborted === true;
            return {
              ok: true,
              output: JSON.stringify({
                exitCode: 0,
                signal: null,
                stdout: "passed too late",
                stderr: "",
              }),
            };
          },
        },
        ui,
        store,
        seed: [{ role: "user", content: "fix tests" }],
        env: e,
        loop: {
          ...loop,
          id: "loop_late_passing_exit_check",
          bounds: { maxIterations: 3, maxWallMs: 10 },
        },
      });
      const outcome = await running;

      expect(outcome.lastStop).toBe("deadline");
      expect(exitCheckSignalAborted).toBe(true);
      expect(
        readSession(store.id, e).events.some(
          (event) => event.type === "loop_stopped" && event.reason === "succeeded",
        ),
      ).toBe(false);
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("preserves no-retry guidance when an exit-check outcome becomes unknown at the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();

    try {
      const outcome = await runBoundedLoopSession({
        model: new ScriptedModel({ turns: [{ text: "attempt" }] }),
        executor: {
          execute: async () => {
            await vi.advanceTimersByTimeAsync(11);
            return { ok: false, output: "tool execution aborted by user" };
          },
        },
        ui,
        store,
        seed: [{ role: "user", content: "fix tests" }],
        env: e,
        loop: {
          ...loop,
          id: "loop_deadline_unknown_exit_check",
          bounds: { maxIterations: 3, maxWallMs: 10 },
        },
      });

      expect(outcome.lastStop).toBe("error");
      expect(renderFrame(outcome.finalView)).toMatch(/outcome unknown.*interrupted/isu);
      expect(renderFrame(outcome.finalView)).toContain(
        "inspect the session audit before deciding whether to retry",
      );
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("fails closed for loop inputs whose runtime enforcement is not wired yet", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();

    await expect(
      runBoundedLoopSession({
        model: new ScriptedModel({ turns: [{ text: "attempt" }] }),
        executor: { execute: () => Promise.resolve({ ok: true, output: "unused" }) },
        ui,
        store,
        seed: [{ role: "user", content: "fix tests" }],
        env: e,
        loop: {
          ...loop,
          until: { kind: "command", check: { action: "test.unit" }, satisfiedWhen: "exitZero" },
        },
      }),
    ).rejects.toThrow(/lifecycle-action checks are not wired/i);

    store.close();
  });

  it("fails closed rather than honoring unenforced loop effect envelopes", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();

    await expect(
      runBoundedLoopSession({
        model: new ScriptedModel({ turns: [{ text: "attempt" }] }),
        executor: { execute: () => Promise.resolve({ ok: true, output: "unused" }) },
        ui,
        store,
        seed: [{ role: "user", content: "fix tests" }],
        env: e,
        loop: { ...loop, effects: { deny: ["network_write"] } },
      }),
    ).rejects.toThrow(/effect envelopes require warden profile narrowing support/i);

    store.close();
  });

  it("maps inner structural stops to loop stop reasons with ledger evidence", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();

    const outcome = await runBoundedLoopSession({
      model: new ScriptedModel({ turns: [{ text: "unreached" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "unused" }) },
      ui,
      store,
      seed: [{ role: "user", content: "fix tests" }],
      env: e,
      stop: { budget: { maxTokens: 0 } },
      loop,
    });

    store.close();
    expect(outcome.lastStop).toBe("budget");
    const events = readSession(store.id, e).events;
    expect(
      events.some((event) => event.type === "loop_stopped" && event.reason === "loop-budget"),
    ).toBe(true);
    expect(renderFrame(outcome.finalView)).toMatch(/loop stopped · loop-budget/i);
  });

  it("stops a bounded loop when a turn answers after a review-required action", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    let exitChecks = 0;
    const executor: ExecutorPort = {
      execute: (call) => {
        if (call.name === "read") return Promise.resolve({ ok: true, output: "package list" });
        if (
          call.name === "bash" &&
          typeof call.args["command"] === "string" &&
          call.args["command"].includes("node -e")
        ) {
          return Promise.resolve(
            terminalReviewResult("bash: warden review required (not executed): POL-003 review"),
          );
        }
        if (call.name === "bash") {
          exitChecks += 1;
          return Promise.resolve({ ok: true, output: "unused" });
        }
        return Promise.resolve({ ok: false, output: "unexpected tool" });
      },
    };

    const outcome = await runBoundedLoopSession({
      model: new ScriptedModel({
        turns: [
          {
            toolCalls: [
              { name: "read", args: { path: "README.md" } },
              { name: "bash", args: { command: "node -e 'console.log(1)'" } },
            ],
          },
          { text: "Done." },
        ],
      }),
      executor,
      ui,
      store,
      seed: [{ role: "user", content: "whats in this repo?" }],
      env: e,
      loop,
    });

    store.close();
    expect(outcome.lastStop).toBe("model-stop");
    expect(outcome.lastStopCode).toBe(REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE);
    expect(exitChecks).toBe(0);
    expect(
      readSession(store.id, e).events.some(
        (event) => event.type === "loop_stopped" && event.reason === "error",
      ),
    ).toBe(true);
    const frame = renderFrame(outcome.finalView);
    const normalized = frame.replace(/\s+/gu, " ");
    expect(normalized).toContain("Done.");
    expect(normalized).toContain("Outcome: needs attention");
    expect(normalized).toContain("Task partially completed");
    expect(normalized).toContain("Review not executed: bash:");
    expect(normalized).toContain("Next: approve a fresh exact review");
    expect(normalized.indexOf("Outcome: needs attention")).toBeGreaterThan(
      normalized.indexOf("Done."),
    );
    expect(frame).toMatch(/loop stopped · error/i);
  });

  it("preserves direct blocked terminal-review detail after a loop_stopped error marker", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();
    const executor: ExecutorPort = {
      execute: () =>
        Promise.resolve(
          terminalReviewResult(
            "blocked by warden (not executed): review closed as denied; no review remains pending",
            "blocked",
          ),
        ),
    };

    const outcome = await runBoundedLoopSession({
      model: new ScriptedModel({
        turns: [{ toolCalls: [{ name: "bash", args: { command: "rm file.txt" } }] }],
      }),
      executor,
      ui,
      store,
      seed: [{ role: "user", content: "delete file" }],
      env: e,
      loop,
    });

    store.close();
    expect(outcome.lastStop).toBe("error");
    expect(outcome.lastStopCode).toBe("BLOCKED");
    expect(outcome.lastStopMessage).toContain("blocked action was not executed");

    const session = readSession(store.id, e);
    const rebuilt = rebuild(session);
    expect(rebuilt.finished).toBe(false);
    expect(rebuilt.lastStop).toBe("error");
    expect(rebuilt.lastStopCode).toBe("BLOCKED");
    expect(rebuilt.lastStopMessage).toContain("blocked action was not executed");
    const listed = listSessions(e)[0];
    expect(listed).toMatchObject({ lastStop: "error", lastStopCode: "BLOCKED" });
    expect(listed?.lastStopMessage).toContain("blocked action was not executed");
    expect(
      session.events.some((event) => event.type === "loop_stopped" && event.reason === "error"),
    ).toBe(true);
  });

  it("maps inner model errors to a loop error stop", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();

    const outcome = await runBoundedLoopSession({
      model: errorModel,
      executor: { execute: () => Promise.resolve({ ok: true, output: "unused" }) },
      ui,
      store,
      seed: [{ role: "user", content: "fix tests" }],
      env: e,
      loop,
    });

    store.close();
    expect(outcome.lastStop).toBe("error");
    const events = readSession(store.id, e).events;
    expect(events.some((event) => event.type === "loop_stopped" && event.reason === "error")).toBe(
      true,
    );
  });

  it("stops a loop at its wall-clock deadline after a failed exit check", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();

    const outcome = await runBoundedLoopSession({
      model: new ScriptedModel({ turns: [{ text: "attempt one" }] }),
      executor: {
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            ok: true,
            output: JSON.stringify({ exitCode: 1, signal: null, stdout: "", stderr: "not yet" }),
          };
        },
      },
      ui,
      store,
      seed: [{ role: "user", content: "fix tests" }],
      env: e,
      loop: { ...loop, id: "loop_deadline", bounds: { maxIterations: 3, maxWallMs: 1 } },
    });

    store.close();
    const events = readSession(store.id, e).events;
    expect(
      events.some((event) => event.type === "loop_stopped" && event.reason === "loop-deadline"),
    ).toBe(true);
    expect(renderFrame(outcome.finalView)).toMatch(/loop stopped · loop-deadline/i);
  });

  it("rejects unsupported schema versions and impossible zero-iteration loops", async () => {
    const e = env();
    const badVersionStore = SessionStore.create({ cwd: "/w" }, e);
    const ui = new CapturingUI();

    await expect(
      runBoundedLoopSession({
        model: new ScriptedModel({ turns: [{ text: "attempt" }] }),
        executor: { execute: () => Promise.resolve({ ok: true, output: "unused" }) },
        ui,
        store: badVersionStore,
        seed: [{ role: "user", content: "fix tests" }],
        env: e,
        loop: { ...loop, schemaVersion: "run-control.keel.dev/v0" as never },
      }),
    ).rejects.toThrow(/unsupported loop schema version/i);
    badVersionStore.close();

    const zeroStore = SessionStore.create({ cwd: "/w" }, e);
    await expect(
      runBoundedLoopSession({
        model: new ScriptedModel({ turns: [{ text: "attempt" }] }),
        executor: { execute: () => Promise.resolve({ ok: true, output: "unused" }) },
        ui,
        store: zeroStore,
        seed: [{ role: "user", content: "fix tests" }],
        env: e,
        loop: { ...loop, bounds: { maxIterations: 0 } },
      }),
    ).rejects.toThrow(/did not run any iterations/i);
    zeroStore.close();
  });
});
