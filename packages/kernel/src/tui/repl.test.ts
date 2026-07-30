import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelMessageT,
  ModelPort,
  ModelStreamChunkT,
  ModelTurnInput,
  UIPort,
  UserInput,
  ViewModel,
} from "@keel/shared";
import { LIFECYCLE_MANIFEST_VERSION, LifecycleManifest } from "@keel/shared";
import { ScriptedModel } from "@keel/simulator";
import { InputQueue } from "../cli/input-queue.js";
import { SessionStore, readSession } from "../session/store.js";
import { rebuild } from "../session/resume.js";
import { runRepl, statusAfterPlanTurn } from "./repl.js";
import { COMMANDS } from "./commands.js";
import { staticModelRouteRuntime } from "../model-routing/controller.js";
import { renderFrame } from "./headless.js";
import { REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE } from "../events.js";
import { terminalReviewResult } from "../warden/terminal-review.js";
import { LOCAL_INPUT_ACTIVITY, LocalInputActivityRegistry } from "./input-activity.js";
import { DIFF_VIEWER_CONTROL, type DiffViewerOpenResult } from "./diff-viewer-control.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });

it("does not restore stale plan posture after governed protections become unavailable", () => {
  const unavailable = {
    tokens: 12,
    posture: { sandbox: false, egress: false, audit: false },
    policy: { active: false },
    startup: { phase: "protections-unavailable" as const },
  };

  expect(
    statusAfterPlanTurn(unavailable, {
      policy: { active: true, label: "Plan Autopilot · stale" },
      posture: { sandbox: true, egress: true, audit: true },
    }),
  ).toBe(unavailable);
});

it("retains the controller-owned protection route after a one-turn plan posture resets", () => {
  const status = {
    tokens: 12,
    posture: { sandbox: true, egress: true, audit: true },
    policy: { active: true, label: "Plan Autopilot · current" },
  };

  expect(
    statusAfterPlanTurn(status, {
      protectionRoute: "governed",
      policy: { active: true, label: "Guided · base" },
      posture: { sandbox: true, egress: true, audit: true },
    }),
  ).toMatchObject({
    protectionRoute: "governed",
    policy: { active: true, label: "Guided · base" },
  });
});

/**
 * A test `UIPort` backed by the REAL `InputQueue` (the same single-shared-iterator the interactive
 * InkUI uses), so the multi-turn driver is exercised against the production input semantics — not a
 * generator mock that would hide the single-consumer handoff. `endInput()` simulates EOF (Ctrl-D) on
 * the input stream only; `close()` is the UIPort teardown and is counted (the driver must call it
 * exactly once at session end, never per turn).
 */
class ReplUI implements UIPort {
  readonly queue = new InputQueue();
  #latest: ViewModel | undefined;
  closes = 0;
  readonly #localInputActivity = new LocalInputActivityRegistry();
  readonly [LOCAL_INPUT_ACTIVITY] = (handler: () => void): (() => void) =>
    this.#localInputActivity.connect(handler);
  #renderWaiters: { pred: (v: ViewModel) => boolean; resolve: () => void }[] = [];

  render(view: ViewModel): void {
    this.#latest = view;
    this.#renderWaiters = this.#renderWaiters.filter((w) => {
      if (w.pred(view)) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  awaitRender(pred: (v: ViewModel) => boolean): Promise<void> {
    if (this.#latest !== undefined && pred(this.#latest)) return Promise.resolve();
    return new Promise((resolve) => this.#renderWaiters.push({ pred, resolve }));
  }

  /** The most recent rendered view (for asserting post-turn idle state). */
  get latest(): ViewModel | undefined {
    return this.#latest;
  }

  push(input: UserInput): void {
    this.queue.push(input);
  }

  localInteraction(): void {
    this.#localInputActivity.notify();
  }

  /** Simulate the user pressing Ctrl-D / EOF on the input stream (NOT a UI teardown). */
  endInput(): void {
    this.queue.close();
  }

  inputs(): AsyncIterable<UserInput> {
    return this.queue;
  }

  close(): Promise<void> {
    this.closes++;
    this.queue.close();
    return Promise.resolve();
  }
}

class DiffViewerReplUI extends ReplUI {
  readonly #result: DiffViewerOpenResult;
  readonly #opened: Promise<void>;
  #resolveOpened!: () => void;
  opens = 0;
  readonly [DIFF_VIEWER_CONTROL] = (): DiffViewerOpenResult => {
    this.opens += 1;
    this.#resolveOpened();
    return this.#result;
  };

  constructor(result: DiffViewerOpenResult) {
    super();
    this.#result = result;
    this.#opened = new Promise((resolve) => {
      this.#resolveOpened = resolve;
    });
  }

  awaitViewerRequest(): Promise<void> {
    return this.#opened;
  }
}

const hasAssistant = (v: ViewModel, content: string): boolean =>
  v.items.some((it) => it.kind === "message" && it.role === "assistant" && it.content === content);

describe("runRepl — multi-turn REPL (Epic 1.23 slice 0, walking skeleton)", () => {
  it("returns terminal attention detail from an interactive recovered review-required answer", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    let turn = 0;
    const model: ModelPort = {
      async *stream(): AsyncGenerator<ModelStreamChunkT> {
        turn += 1;
        if (turn === 1) {
          yield { type: "tool-call", id: "read-1", name: "read", args: { path: "README.md" } };
          yield {
            type: "finish",
            reason: "tool-calls",
            usage: { inputTokens: 10, outputTokens: 2 },
          };
          return;
        }
        if (turn === 2) {
          yield { type: "tool-call", id: "bash-1", name: "bash", args: { command: "find ." } };
          yield {
            type: "finish",
            reason: "tool-calls",
            usage: { inputTokens: 20, outputTokens: 2 },
          };
          return;
        }
        yield { type: "text-delta", text: "Keel is a governed agent harness." };
        yield { type: "finish", reason: "stop", usage: { inputTokens: 30, outputTokens: 8 } };
      },
    };

    ui.push({ kind: "line", text: "what is in this repo?" });
    const done = runRepl({
      model,
      executor: {
        execute: (call) =>
          Promise.resolve(
            call.name === "read"
              ? { ok: true, output: "# Keel\nGoverned agent harness." }
              : terminalReviewResult("warden review required (not executed): no live review"),
          ),
      },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => hasAssistant(v, "Keel is a governed agent harness."));
    ui.endInput();
    await expect(done).resolves.toMatchObject({
      lastStop: "model-stop",
      lastStopCode: REVIEW_REQUIRED_AFTER_SYNTHESIS_CODE,
    });

    store.close();
  });

  it("stays open after a turn completes and answers a follow-up, closing the UI exactly once", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    // One scripted model serves both turns: a text-only turn = a model-stop completion.
    const model = new ScriptedModel({ turns: [{ text: "answer one" }, { text: "answer two" }] });

    ui.push({ kind: "line", text: "first question" });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    // Turn 1 completes and the REPL returns to an idle prompt (it did NOT exit).
    await ui.awaitRender((v) => hasAssistant(v, "answer one") && v.awaitingInput === true);

    // A follow-up typed at the prompt is answered as a fresh turn (the keystone behavior).
    ui.push({ kind: "line", text: "second question" });
    await ui.awaitRender((v) => hasAssistant(v, "answer two"));

    ui.endInput(); // Ctrl-D / EOF → the REPL exits cleanly
    await done;

    // The ledger is canonical: both turns recorded once, in order, no duplication.
    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "answer two" },
    ]);
    expect(ui.closes).toBe(1); // UI torn down once at session end, never per turn

    store.close();
  });

  it("renders /reviews at the idle prompt without starting a model turn", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "unexpected" }] });

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({ kind: "command", name: "/reviews" });
    await ui.awaitRender(
      (v) =>
        v.overlay?.kind === "panel" &&
        v.overlay.content.includes("reviews") &&
        v.overlay.content.includes("read-only: cannot approve"),
    );

    ui.endInput();
    await done;

    const text = ui.latest?.items.map((it) => (it.kind === "message" ? it.content : "")).join("\n");
    expect(text).not.toContain("unexpected");
    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([]);
    expect(ui.closes).toBe(1);
    store.close();
  });

  it("renders /policies and /policy at the idle prompt without starting a model turn", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "unexpected" }] });

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
      view: {
        protectionRoute: "governed",
        policy: { active: true, label: "Guided · starter@abc123" },
        posture: { sandbox: true, egress: true, audit: true },
        lastWardenPendingReviews: 1,
      },
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({ kind: "command", name: "/policies" });
    await ui.awaitRender(
      (v) =>
        v.overlay?.kind === "panel" &&
        v.overlay.content.includes("policies") &&
        v.overlay.content.includes("policy: Guided · starter@abc123") &&
        v.overlay.content.includes("read-only"),
    );
    ui.push({ kind: "command", name: "/policy" });
    await ui.awaitRender(
      (v) =>
        v.overlay?.kind === "panel" &&
        v.overlay.content.includes("policies") &&
        v.overlay.content.includes("reviews: 1 · snapshot, not live"),
    );
    ui.push({ kind: "command", name: "/policy", args: '"unterminated' });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          it.content.includes("/policy takes no arguments"),
      ),
    );

    ui.endInput();
    await done;

    const text = ui.latest?.items.map((it) => (it.kind === "message" ? it.content : "")).join("\n");
    expect(text).not.toContain("unexpected");
    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([]);
    expect(ui.closes).toBe(1);
    store.close();
  });

  it("activates an exact-resource Plan Autopilot envelope for the next idle turn only", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "answer one" }, { text: "answer two" }] });
    const planApprovals = {
      previews: [] as string[],
      approvals: [] as string[],
      clears: 0,
      preview(args: string) {
        this.previews.push(args);
        return { ok: true, output: `Plan Autopilot preview\nargs: ${args}` };
      },
      approve(args: string) {
        this.approvals.push(args);
        return {
          ok: true,
          output:
            "Plan Autopilot approved for the next plain task line only\ncommand envelopes:\n  - sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          view: {
            policy: { active: true, label: "Plan Autopilot · test-pack@abc123" },
            posture: { sandbox: true, egress: true, audit: true },
          },
        };
      },
      clear() {
        this.clears += 1;
      },
    };

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
      view: {
        policy: { active: true, label: "Guided · test-pack@abc123" },
        posture: { sandbox: true, egress: true, audit: true },
      },
      planApprovals,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({
      kind: "command",
      name: "/plan",
      args: 'preview --step "fix one" --plan-id fix --command-key sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          it.content.includes("Plan Autopilot preview"),
      ),
    );
    ui.push({
      kind: "command",
      name: "/plan",
      args: 'approve --step "fix one" --plan-id fix --command-key sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          it.content.includes("next plain task line only"),
      ),
    );
    expect(planApprovals.previews).toEqual([
      "--step 'fix one' --plan-id fix --command-key sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
    expect(planApprovals.approvals).toEqual([
      "--step 'fix one' --plan-id fix --command-key sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]);

    ui.push({ kind: "line", text: "first task" });
    await ui.awaitRender(
      (v) =>
        hasAssistant(v, "answer one") && v.status.policy?.label === "Guided · test-pack@abc123",
    );
    expect(planApprovals.clears).toBe(1);

    ui.push({ kind: "line", text: "second task" });
    await ui.awaitRender((v) => hasAssistant(v, "answer two"));

    ui.endInput();
    await done;

    expect(planApprovals.clears).toBe(1);
    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([
      { role: "user", content: "first task" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "second task" },
      { role: "assistant", content: "answer two" },
    ]);
    store.close();
  });

  it("refuses /plan approval when no live plan controller is available", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "unexpected" }] });

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({
      kind: "command",
      name: "/plan",
      args: "approve --plan-id fix --domain example.com",
    });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          it.content.includes("requires a live governed warden session"),
      ),
    );

    ui.endInput();
    await done;

    const text = ui.latest?.items.map((it) => (it.kind === "message" ? it.content : "")).join("\n");
    expect(text).not.toContain("unexpected");
    expect(rebuild(readSession(store.id, e)).messages).toEqual([]);
    store.close();
  });

  it("does not queue Plan Autopilot when the live controller rejects approval", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "answer" }] });
    const planApprovals = {
      clears: 0,
      preview: () => ({ ok: true, output: "unexpected preview" }),
      approve: () => ({
        ok: false,
        output: "Plan Autopilot approval was not activated: visible gates unavailable",
      }),
      clear() {
        this.clears += 1;
      },
    };

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
      planApprovals,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({
      kind: "command",
      name: "/plan",
      args: "approve --plan-id fix --domain example.com",
    });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" && it.role === "system" && it.content.includes("not activated"),
      ),
    );
    ui.push({ kind: "line", text: "plain task" });
    await ui.awaitRender((v) => hasAssistant(v, "answer"));

    ui.endInput();
    await done;

    expect(planApprovals.clears).toBe(1);
    expect(rebuild(readSession(store.id, e)).messages).toEqual([
      { role: "user", content: "plain task" },
      { role: "assistant", content: "answer" },
    ]);
    store.close();
  });

  it("clears a queued Plan Autopilot approval after a failed second approval", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "answer" }] });
    const approvals: string[] = [];
    const planApprovals = {
      clears: 0,
      preview: () => ({ ok: true, output: "unexpected preview" }),
      approve(args: string) {
        approvals.push(args);
        if (args.includes("bad.example")) {
          return {
            ok: false,
            output: "keel run plan approval rejected domain bad.example: invalid resource",
          };
        }
        return {
          ok: true,
          output: "Plan Autopilot approved for the next plain task line only",
          view: {
            policy: { active: true, label: "Plan Autopilot · test-pack@abc123" },
            posture: { sandbox: true, egress: true, audit: true },
          },
        };
      },
      clear() {
        this.clears += 1;
      },
    };

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
      planApprovals,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({ kind: "command", name: "/plan", args: "approve --domain example.com" });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          it.content.includes("next plain task line only"),
      ),
    );
    ui.push({ kind: "command", name: "/plan", args: "approve --domain bad.example" });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          it.content.includes("rejected domain bad.example"),
      ),
    );
    ui.push({ kind: "line", text: "plain task" });
    await ui.awaitRender((v) => hasAssistant(v, "answer"));

    ui.endInput();
    await done;

    expect(approvals).toEqual(["--domain example.com", "--domain bad.example"]);
    expect(planApprovals.clears).toBe(1);
    expect(rebuild(readSession(store.id, e)).messages).toEqual([
      { role: "user", content: "plain task" },
      { role: "assistant", content: "answer" },
    ]);
    store.close();
  });

  it("clears a controller-approved plan when approval returns no status view", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "answer" }] });
    const planApprovals = {
      clears: 0,
      preview: () => ({ ok: true, output: "unexpected preview" }),
      approve: () => ({ ok: true, output: "Plan Autopilot approved without a view" }),
      clear() {
        this.clears += 1;
      },
    };

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
      planApprovals,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({ kind: "command", name: "/plan", args: "approve --domain example.com" });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" && it.role === "system" && it.content.includes("no status view"),
      ),
    );
    ui.push({ kind: "line", text: "plain task" });
    await ui.awaitRender((v) => hasAssistant(v, "answer"));

    ui.endInput();
    await done;

    expect(planApprovals.clears).toBe(1);
    expect(rebuild(readSession(store.id, e)).messages).toEqual([
      { role: "user", content: "plain task" },
      { role: "assistant", content: "answer" },
    ]);
    store.close();
  });

  it("clears and refuses /goal or /loop while a next-task Plan Autopilot approval is queued", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "unexpected" }] });
    let checks = 0;
    const planApprovals = {
      clears: 0,
      preview: () => ({ ok: true, output: "unexpected preview" }),
      approve: () => ({
        ok: true,
        output: "Plan Autopilot approved for the next plain task line only",
        view: {
          policy: { active: true, label: "Plan Autopilot · test-pack@abc123" },
          posture: { sandbox: true, egress: true, audit: true },
        },
      }),
      clear() {
        this.clears += 1;
      },
    };

    const done = runRepl({
      model,
      executor: {
        execute: () => {
          checks += 1;
          return Promise.resolve({ ok: true, output: "unused" });
        },
      },
      ui,
      store,
      env: e,
      planApprovals,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({ kind: "command", name: "/plan", args: "approve --domain example.com" });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          it.content.includes("next plain task line only"),
      ),
    );
    ui.push({ kind: "command", name: "/goal", args: 'Fix --check "pnpm test"' });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          it.content.includes("/goal cannot run under a next-task plan boundary"),
      ),
    );
    ui.push({ kind: "command", name: "/plan", args: "approve --domain example.com" });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          it.content.includes("next plain task line only"),
      ),
    );
    ui.push({
      kind: "command",
      name: "/loop",
      args: 'Fix tests --until "pnpm test" --max-iterations 2',
    });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          it.content.includes("/loop cannot run under a next-task plan boundary"),
      ),
    );

    ui.endInput();
    await done;

    expect(planApprovals.clears).toBe(2);
    expect(checks).toBe(0);
    expect(rebuild(readSession(store.id, e)).messages).toEqual([]);
    store.close();
  });

  it("clears a next-task plan approval even when no base status view was configured", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "answer" }] });
    const planApprovals = {
      clears: 0,
      preview: () => ({ ok: true, output: "unexpected preview" }),
      approve: () => ({
        ok: true,
        output: "Plan Autopilot approved for the next plain task line only",
        view: {
          policy: { active: true, label: "Plan Autopilot · test-pack@abc123" },
          posture: { sandbox: true, egress: true, audit: true },
        },
      }),
      clear() {
        this.clears += 1;
      },
    };

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
      planApprovals,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({
      kind: "command",
      name: "/plan",
      args: "approve --plan-id fix --domain example.com",
    });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          it.content.includes("next plain task line only"),
      ),
    );
    ui.push({ kind: "line", text: "planned task" });
    await ui.awaitRender(
      (v) =>
        hasAssistant(v, "answer") && v.status.policy?.label !== "Plan Autopilot · test-pack@abc123",
    );

    ui.endInput();
    await done;

    expect(planApprovals.clears).toBe(1);
    store.close();
  });

  it("handles malformed /plan input and explicit /plan clear without starting a model turn", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "unexpected" }] });
    const planApprovals = {
      clears: 0,
      preview: () => ({ ok: true, output: "unexpected preview" }),
      approve: () => ({ ok: true, output: "unexpected approval" }),
      clear() {
        this.clears += 1;
      },
    };

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
      planApprovals,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({ kind: "command", name: "/plan", args: "status" });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          it.content.includes("usage: /plan <preview|approve|clear>"),
      ),
    );
    ui.push({ kind: "command", name: "/plan", args: "clear --domain example.com" });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          it.content.includes("usage: /plan clear"),
      ),
    );
    ui.push({ kind: "command", name: "/plan", args: 'preview "unterminated' });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          it.content.includes("unterminated quoted string"),
      ),
    );
    ui.push({ kind: "command", name: "/plan", args: "clear" });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" && it.role === "system" && it.content.includes("approval cleared"),
      ),
    );

    ui.endInput();
    await done;

    expect(planApprovals.clears).toBe(1);
    const text = ui.latest?.items.map((it) => (it.kind === "message" ? it.content : "")).join("\n");
    expect(text).not.toContain("unexpected");
    expect(rebuild(readSession(store.id, e)).messages).toEqual([]);
    store.close();
  });

  it("handles /model why and /model preview as read-only routing panels at the idle prompt", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "unused" }] });
    const modelRouting = staticModelRouteRuntime({
      schemaVersion: "model-routing.keel.dev/v1",
      decisionId: "route_dec_1",
      requestId: "route_req_1",
      createdAt: "2026-06-27T20:00:00.000Z",
      status: "selected",
      mode: "locked",
      selected: {
        ref: "anthropic/sonnet@test-catalog",
        provider: "anthropic",
        model: "sonnet",
        dataBoundary: "vendor_api",
      },
      reasons: ["locked-current-provider"],
      candidates: [{ ref: "anthropic/sonnet@test-catalog", status: "eligible", reasons: [] }],
      metadata: {
        catalogVersion: "test-catalog",
        requestDataClass: "workspace",
        estimatedInputTokens: 1,
        fallbackUsed: false,
      },
    });

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
      modelRouting,
      view: { model: "anthropic/sonnet", modelRoute: modelRouting.status() },
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({ kind: "command", name: "/model", args: "why" });
    await ui.awaitRender(
      (v) =>
        v.overlay?.kind === "panel" && v.overlay.content.includes("why: locked-current-provider"),
    );
    ui.push({ kind: "command", name: "/model", args: "preview" });
    await ui.awaitRender(
      (v) => v.overlay?.kind === "panel" && v.overlay.content.includes("preview: decision only"),
    );

    ui.endInput();
    await done;
    expect(modelRouting.previewCalls()).toBe(1);
    store.close();
  });

  it("renders /model status honestly when no routing runtime is available", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "unused" }] });

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({ kind: "command", name: "/model" });
    await ui.awaitRender(
      (v) =>
        v.overlay?.kind === "panel" &&
        v.overlay.content.includes("route mode: locked") &&
        v.overlay.content.includes("status: unknown"),
    );

    ui.endInput();
    await done;
    store.close();
  });

  it("renders an honest notice for an unavailable idle command — no new turn, session stays open", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "answer one" }, { text: "answer two" }] });

    ui.push({ kind: "line", text: "first" });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((v) => v.awaitingInput === true && hasAssistant(v, "answer one"));

    // An unavailable palette command at the idle prompt is acknowledged honestly, but must NEITHER
    // start a turn NOR exit the session. The follow-up line typed right after is still answered as a
    // fresh turn.
    ui.push({ kind: "command", name: "/session" });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          /keel --continue|keel --resume <id>/i.test(it.content),
      ),
    );
    ui.push({ kind: "line", text: "second" });
    await ui.awaitRender((v) => hasAssistant(v, "answer two"));

    ui.endInput();
    await done;

    // The ledger holds exactly the two real turns, in order — the palette command recorded nothing.
    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "second" },
      { role: "assistant", content: "answer two" },
    ]);
    expect(r.messages).not.toContainEqual({ role: "user", content: "/session" });
    expect(ui.closes).toBe(1); // session torn down once, at the real end — not on the palette command
    store.close();
  });

  it("runs an idle /goal command as an evidence-audited goal turn", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({
      turns: [{ toolCalls: [{ name: "bash", args: { command: "pnpm test" } }] }, { text: "done" }],
    });

    // Validation is opt-in (F-3 RC2a): request `--validation standard` explicitly so the trusted
    // manifest's tier runs for real (governed lifecycle.run) and the goal can honestly complete
    // (Epic 2.15b). Without `--validation`, a plain goal settles at the honest `unverified` instead.
    const lifecycleManifest = LifecycleManifest.parse({
      schemaVersion: LIFECYCLE_MANIFEST_VERSION,
      actions: { "test.unit": { argv: ["pnpm", "test"] } },
      validationTiers: { standard: { required: ["test.unit"] } },
    });

    ui.push({
      kind: "command",
      name: "/goal",
      args: 'Ship 2.12 --check "pnpm test" --validation standard',
    });
    const done = runRepl({
      model,
      executor: {
        execute: () => Promise.resolve({ ok: true, output: "TEST SUMMARY (pnpm test): PASS" }),
      },
      ui,
      store,
      env: e,
      lifecycleManifest,
    });

    await ui.awaitRender((v) =>
      (v.turnSummary?.receipt ?? []).some((detail) => /goal complete/i.test(detail)),
    );
    ui.endInput();
    await done;

    const events = readSession(store.id, e).events;
    expect(events.some((event) => event.type === "goal_completed")).toBe(true);
    expect(ui.closes).toBe(1);
    store.close();
  });

  it("runs an idle /loop command as a bounded loop and returns to the prompt", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    let checks = 0;

    ui.push({
      kind: "command",
      name: "/loop",
      args: 'Fix tests --until "pnpm test" --max-iterations 2',
    });
    const done = runRepl({
      model: new ScriptedModel({
        turns: [{ text: "attempt one" }, { text: "attempt two" }, { text: "follow-up answer" }],
      }),
      executor: {
        execute: () => {
          checks += 1;
          return Promise.resolve(
            checks === 1
              ? {
                  ok: true,
                  output: JSON.stringify({
                    exitCode: 1,
                    signal: null,
                    stdout: "",
                    stderr: "TEST SUMMARY (pnpm test): FAIL",
                  }),
                }
              : { ok: true, output: "TEST SUMMARY (pnpm test): PASS" },
          );
        },
      },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender(
      (v) =>
        v.awaitingInput === true &&
        (v.turnSummary?.receipt ?? []).some((detail) => /loop succeeded/i.test(detail)),
    );
    ui.push({ kind: "line", text: "what happened?" });
    await ui.awaitRender((v) => hasAssistant(v, "follow-up answer"));
    ui.endInput();
    await done;

    const events = readSession(store.id, e).events;
    expect(
      events.some((event) => event.type === "loop_stopped" && event.reason === "succeeded"),
    ).toBe(true);
    const controllerPrefix = "Keel loop controller · exit check failed";
    expect(
      events.some((event) => event.type === "user" && event.content.startsWith(controllerPrefix)),
    ).toBe(false);
    expect(
      events.some((event) => event.type === "system" && event.content.startsWith(controllerPrefix)),
    ).toBe(false);
    const resumed = rebuild(readSession(store.id, e)).messages;
    expect(
      resumed.some(
        (message) => message.role === "user" && message.content.startsWith(controllerPrefix),
      ),
    ).toBe(true);
    expect(
      resumed.some(
        (message) => message.role === "system" && message.content.startsWith(controllerPrefix),
      ),
    ).toBe(false);
    expect(renderFrame(ui.latest!)).not.toContain(`you  ${controllerPrefix}`);
    expect(renderFrame(ui.latest!)).toContain(`note\n  ${controllerPrefix}`);
    expect(ui.closes).toBe(1);
    store.close();
  });

  it("renders parse errors for idle /goal without starting a model turn", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();

    ui.push({ kind: "command", name: "/goal", args: 'Ship 2.12 --check "pnpm test' });
    const done = runRepl({
      model: new ScriptedModel({ turns: [{ text: "unreached" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "unused" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          /\/goal: unterminated quoted string/i.test(it.content),
      ),
    );
    ui.endInput();
    await done;

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([]);
    expect(ui.closes).toBe(1);
    store.close();
  });

  it("refuses an all-read-only /goal --check and steers to /loop without spending a turn (F-3 UX)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();

    ui.push({
      kind: "command",
      name: "/goal",
      args: 'Confirm the file exists --check "test -f marker.txt"',
    });
    const done = runRepl({
      // The model must never be driven: an all-read-only goal is refused before any turn.
      model: new ScriptedModel({ turns: [{ text: "unreached" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "unused" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          /\/loop --until/i.test(it.content) &&
          /read-only/i.test(it.content),
      ),
    );
    ui.endInput();
    await done;

    // No model turn ran (the ledger has no messages) — the goal was refused, not driven.
    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([]);
    store.close();
  });

  it("still runs a /goal with a mix of executable and read-only checks", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();

    ui.push({
      kind: "command",
      name: "/goal",
      args: 'Ship it --check "pnpm test" --check "test -f marker.txt"',
    });
    const done = runRepl({
      model: new ScriptedModel({ turns: [{ text: "done" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    // The goal drives a real turn (an executable check is present) — the model produces its answer.
    await ui.awaitRender((v) => hasAssistant(v, "done"));
    ui.endInput();
    await done;
    store.close();
  });

  it("renders parse errors for idle /loop without starting a model turn", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();

    ui.push({ kind: "command", name: "/loop", args: "Fix tests" });
    const done = runRepl({
      model: new ScriptedModel({ turns: [{ text: "unreached" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "unused" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          /\/loop: loop requires --until command/i.test(it.content),
      ),
    );
    ui.endInput();
    await done;

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([]);
    expect(ui.closes).toBe(1);
    store.close();
  });

  it("Ctrl-C at the idle prompt warns once, then exits on a second consecutive Ctrl-C (slice 7)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "answer one" }] });
    ui.push({ kind: "line", text: "first" });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((v) => v.awaitingInput === true && hasAssistant(v, "answer one"));

    // First idle Ctrl-C → WARNS (a system hint), does NOT exit (don't lose the session to a stray key).
    ui.push({ kind: "interrupt" });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) => it.kind === "message" && it.role === "system" && /again/i.test(it.content),
      ),
    );
    expect(ui.closes).toBe(0); // still open

    // Second CONSECUTIVE Ctrl-C → exits.
    ui.push({ kind: "interrupt" });
    await done;
    expect(ui.closes).toBe(1);
    store.close();
  });

  it("uses controller-owned local activity to disarm exit before a fresh two-press sequence", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const done = runRepl({
      model: new ScriptedModel({ turns: [] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((view) => view.awaitingInput === true);

    ui.push({ kind: "interrupt" });
    await ui.awaitRender((view) => view.exitArmed === true);
    ui.localInteraction();
    await ui.awaitRender((view) => view.exitArmed !== true);

    ui.push({ kind: "interrupt" });
    await ui.awaitRender((view) => view.exitArmed === true);
    expect(ui.closes).toBe(0);
    ui.push({ kind: "interrupt" });
    await done;

    expect(ui.closes).toBe(1);
    store.close();
  });

  it("/context at idle renders an honest context panel and keeps the session open (slice 8)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "answer one" }, { text: "answer two" }] });
    ui.push({ kind: "line", text: "first" });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((v) => v.awaitingInput === true && hasAssistant(v, "answer one"));

    // /context renders a read-only focused panel and does NOT exit or start a turn.
    ui.push({ kind: "command", name: "/context" });
    await ui.awaitRender(
      (v) => v.overlay?.kind === "panel" && /composition: visible estimate/.test(v.overlay.content),
    );
    expect(ui.closes).toBe(0); // session still open

    // a follow-up line is still answered normally (the panel didn't disturb the loop)
    ui.push({ kind: "line", text: "second" });
    await ui.awaitRender((v) => hasAssistant(v, "answer two"));

    ui.endInput();
    await done;
    // the ledger holds exactly the two real turns — /context recorded nothing
    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "second" },
      { role: "assistant", content: "answer two" },
    ]);
    store.close();
  });

  it("/compact at idle renders an honest review-only proposal and records no ledger turn", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "answer one" }, { text: "answer two" }] });
    ui.push({ kind: "line", text: "first" });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((v) => v.awaitingInput === true && hasAssistant(v, "answer one"));

    ui.push({ kind: "command", name: "/compact" });
    await ui.awaitRender(
      (v) =>
        v.overlay?.kind === "panel" && /compact proposal[\s\S]*review only/.test(v.overlay.content),
    );
    expect(ui.closes).toBe(0);

    ui.push({ kind: "line", text: "second" });
    await ui.awaitRender((v) => hasAssistant(v, "answer two"));
    ui.endInput();
    await done;

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "second" },
      { role: "assistant", content: "answer two" },
    ]);
    store.close();
  });

  it("/capabilities at idle renders native help, keeps the session open, and records no ledger turn", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "real answer" }] });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((v) => v.awaitingInput === true);

    ui.push({ kind: "command", name: "/capabilities" });
    await ui.awaitRender(
      (v) =>
        v.overlay?.kind === "panel" &&
        /capabilities[\s\S]*controls: status not reported/.test(v.overlay.content),
    );
    expect(ui.latest?.items).toHaveLength(0);
    expect(ui.closes).toBe(0);

    ui.push({ kind: "line", text: "real task" });
    await ui.awaitRender((v) => hasAssistant(v, "real answer"));
    ui.endInput();
    await done;

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([
      { role: "user", content: "real task" },
      { role: "assistant", content: "real answer" },
    ]);
    store.close();
  });

  it("/about at idle renders a distinct product panel, keeps the session open, and records no ledger turn", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "real answer" }] });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((v) => v.awaitingInput === true);

    ui.push({ kind: "command", name: "/about" });
    await ui.awaitRender(
      (v) =>
        v.overlay?.kind === "panel" &&
        /about[\s\S]*governance-native coding agent/.test(v.overlay.content),
    );
    const text = ui.latest?.overlay?.kind === "panel" ? ui.latest.overlay.content : "";
    expect(text).not.toMatch(/^capabilities/m);
    expect(text).not.toContain("scope: coding tasks in this workspace");
    expect(ui.latest?.items).toHaveLength(0);
    expect(ui.closes).toBe(0);

    ui.push({ kind: "line", text: "real task" });
    await ui.awaitRender((v) => hasAssistant(v, "real answer"));
    ui.endInput();
    await done;

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([
      { role: "user", content: "real task" },
      { role: "assistant", content: "real answer" },
    ]);
    store.close();
  });

  it("an exact novice capability question uses the same local panel and does not consume the model", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "answer after help" }] });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((v) => v.awaitingInput === true);

    ui.push({ kind: "line", text: "what can you do?" });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) => it.kind === "message" && it.role === "system" && /capabilities/.test(it.content),
      ),
    );
    expect(ui.latest?.items.some((it) => it.kind === "message" && it.role === "assistant")).toBe(
      false,
    );
    expect(
      ui.latest?.items.some(
        (it) => it.kind === "message" && it.role === "user" && it.content === "what can you do?",
      ),
    ).toBe(true);

    ui.push({ kind: "line", text: "now answer normally" });
    await ui.awaitRender((v) => hasAssistant(v, "answer after help"));
    ui.endInput();
    await done;

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([
      { role: "user", content: "now answer normally" },
      { role: "assistant", content: "answer after help" },
    ]);
    store.close();
  });

  it("turns pasted keel launch commands into a local shell-instruction notice, not a model turn", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "should not run" }] });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((v) => v.awaitingInput === true);

    ui.push({
      kind: "line",
      text: "NO_COLOR=1 KEEL_HOME=/private/tmp/keel-tui-dogfood pnpm keel",
    });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          it.content.includes("That looks like a shell command to launch keel") &&
          it.content.includes("run it in your terminal") &&
          it.content.includes("/exit"),
      ),
    );

    ui.endInput();
    await done;

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([]);
    expect(ui.latest?.items.some((it) => it.kind === "message" && it.role === "assistant")).toBe(
      false,
    );
    expect(ui.closes).toBe(1);
    store.close();
  });

  it("recognizes env-prefixed keel launch commands and keeps long notices one-line", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "should not run" }] });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((v) => v.awaitingInput === true);

    ui.push({
      kind: "line",
      text: `env NO_COLOR=1 KEEL_HOME=/private/tmp/${"x".repeat(140)} keel --trust`,
    });
    await ui.awaitRender((v) =>
      v.items.some(
        (it) =>
          it.kind === "message" &&
          it.role === "system" &&
          it.content.includes("That looks like a shell command to launch keel") &&
          it.content.endsWith("...") &&
          !it.content.includes("\n"),
      ),
    );

    ui.endInput();
    await done;

    expect(rebuild(readSession(store.id, e)).messages).toEqual([]);
    expect(ui.latest?.items.some((it) => it.kind === "message" && it.role === "assistant")).toBe(
      false,
    );
    store.close();
  });

  it("does not intercept malformed, unrelated, or unsupported launch-looking lines", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({
      turns: [{ text: "malformed ok" }, { text: "unrelated ok" }, { text: "unsupported ok" }],
    });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((v) => v.awaitingInput === true);

    ui.push({ kind: "line", text: '"unterminated launch' });
    await ui.awaitRender((v) => hasAssistant(v, "malformed ok") && v.awaitingInput === true);
    ui.push({ kind: "line", text: "ls" });
    await ui.awaitRender((v) => hasAssistant(v, "unrelated ok") && v.awaitingInput === true);
    ui.push({ kind: "line", text: "pnpm keel --bad-flag" });
    await ui.awaitRender((v) => hasAssistant(v, "unsupported ok"));

    ui.endInput();
    await done;

    expect(rebuild(readSession(store.id, e)).messages).toEqual([
      { role: "user", content: '"unterminated launch' },
      { role: "assistant", content: "malformed ok" },
      { role: "user", content: "ls" },
      { role: "assistant", content: "unrelated ok" },
      { role: "user", content: "pnpm keel --bad-flag" },
      { role: "assistant", content: "unsupported ok" },
    ]);
    store.close();
  });

  it("/help at idle opens a closable help overlay and keeps the session open (slice 9)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "answer one" }] });
    ui.push({ kind: "line", text: "first" });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((v) => v.awaitingInput === true && hasAssistant(v, "answer one"));
    ui.push({ kind: "command", name: "/help" });
    await ui.awaitRender((v) => v.overlay?.kind === "help"); // help overlay shown, not a silent no-op

    ui.push({ kind: "interrupt" });
    await ui.awaitRender((v) => v.overlay === undefined && v.awaitingInput === true);
    const text = ui.latest?.items.map((it) => (it.kind === "message" ? it.content : "")).join("\n");
    expect(text).not.toContain("press Ctrl-C again");
    expect(ui.closes).toBe(0);

    ui.endInput();
    await done;
    expect(ui.closes).toBe(1);
    store.close();
  });

  it("Esc closes an idle slash panel overlay instead of arming Ctrl-C exit", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const done = runRepl({
      model: new ScriptedModel({ turns: [] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((v) => v.awaitingInput === true);

    ui.push({ kind: "command", name: "/context" });
    await ui.awaitRender((v) => v.overlay?.kind === "panel" && /context/.test(v.overlay.content));
    ui.push({ kind: "interrupt" });
    await ui.awaitRender((v) => v.overlay === undefined && v.awaitingInput === true);

    const text = ui.latest?.items.map((it) => (it.kind === "message" ? it.content : "")).join("\n");
    expect(text).not.toContain("press Ctrl-C again");
    expect(ui.closes).toBe(0);

    ui.push({ kind: "command", name: "/exit" });
    await done;
    store.close();
  });

  it("keeps the first idle Ctrl-C warning visible until a second Ctrl-C exits", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const done = runRepl({
      model: new ScriptedModel({ turns: [] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((view) => view.awaitingInput === true);
    ui.push({ kind: "interrupt" });
    await ui.awaitRender((view) =>
      view.items.some(
        (item) => item.kind === "message" && item.content.includes("press Ctrl-C again"),
      ),
    );
    expect(ui.closes).toBe(0);
    ui.push({ kind: "interrupt" });
    await done;
    expect(ui.closes).toBe(1);
    store.close();
  });

  it("every visible slash command produces an observable local result instead of silently no-oping", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const done = runRepl({
      model: new ScriptedModel({ turns: [] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((v) => v.awaitingInput === true);

    for (const command of COMMANDS.filter((c) => c.name !== "/exit" && c.name !== "/quit")) {
      const before = ui.latest;
      expect(before, command.name).toBeDefined();
      ui.push({ kind: "command", name: command.name });
      await ui.awaitRender((v) => {
        if (v === before) return false;
        if (v.items.length > (before?.items.length ?? 0)) return true;
        if (v.overlay?.kind === "help" || v.overlay?.kind === "panel") return true;
        if (v.density !== before?.density) return true;
        if (v.diffMode !== before?.diffMode) return true;
        return false;
      });
    }

    ui.push({ kind: "command", name: "/exit" });
    await done;
    expect(ui.closes).toBe(1);
    store.close();
  });

  it("a typed line after a single idle Ctrl-C disarms the exit and runs normally (slice 7)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new ScriptedModel({ turns: [{ text: "answer one" }, { text: "answer two" }] });
    ui.push({ kind: "line", text: "first" });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((v) => v.awaitingInput === true && hasAssistant(v, "answer one"));

    ui.push({ kind: "interrupt" }); // arm (warn)
    await ui.awaitRender((v) =>
      v.items.some(
        (it) => it.kind === "message" && it.role === "system" && /again/i.test(it.content),
      ),
    );
    ui.push({ kind: "line", text: "second" }); // a real line disarms AND runs as a fresh turn
    await ui.awaitRender((v) => hasAssistant(v, "answer two"));
    expect(ui.closes).toBe(0); // the single Ctrl-C never exited

    ui.endInput();
    await done;
    expect(ui.closes).toBe(1); // clean EOF exit
    store.close();
  });
});

const onAbort = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (signal === undefined || signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

/** Turn 1 emits a tool call then HOLDS the turn open until the run is aborted — so the interrupt
 *  lands BEFORE the tool is dispatched and the loop ends on an OPEN (un-resulted) tool call. Turn 2
 *  records the context it is driven with, so the test can assert the carried history is valid provider
 *  history (M1 — every tool_use is followed by a tool_result). */
class InterruptOpenToolModel implements ModelPort {
  #turn = 0;
  turn2Context: readonly ModelMessageT[] | undefined;
  async *stream(input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
    this.#turn += 1;
    if (this.#turn === 1) {
      yield { type: "tool-call", id: "c1", name: "read", args: { path: "a.ts" } };
      await onAbort(input.signal); // held open until the interrupt aborts the run (before dispatch)
      yield { type: "finish", reason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1 } };
      return;
    }
    this.turn2Context = input.messages;
    yield { type: "text-delta", text: "continuing after the interrupt" };
    yield { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

/** Wraps a model, recording the message context it is driven with each turn (to assert what the
 *  NEXT turn actually sees, not just what the ledger holds). */
class RecordingModel implements ModelPort {
  readonly contexts: (readonly ModelMessageT[])[] = [];
  constructor(private readonly inner: ModelPort) {}
  stream(input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
    this.contexts.push(input.messages);
    return this.inner.stream(input);
  }
}

/** Valid provider history: every assistant message that carries tool calls is immediately followed
 *  by a tool result (Anthropic et al. reject a dangling tool_use). */
const wellFormed = (msgs: readonly ModelMessageT[]): boolean =>
  msgs.every((m, i) =>
    m.role === "assistant" && m.toolCalls !== undefined && m.toolCalls.length > 0
      ? msgs[i + 1]?.role === "tool"
      : true,
  );

describe("runRepl — multi-turn integrity (Epic 1.23 slice-0 QC)", () => {
  it("an interrupt mid-tool carries a CLOSED tool call into the next turn (M1 — valid provider history)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new InterruptOpenToolModel();

    ui.push({ kind: "line", text: "first" });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) }, // never reached turn 1
      ui,
      store,
      env: e,
    });

    // Turn 1 has emitted the tool call and is holding open — interrupt it (aborts before dispatch).
    await ui.awaitRender((v) => v.items.some((it) => it.kind === "tool" && it.id === "c1"));
    ui.push({ kind: "interrupt" });

    // Back at the idle prompt; send a follow-up that drives turn 2.
    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({ kind: "line", text: "second" });
    await ui.awaitRender((v) => hasAssistant(v, "continuing after the interrupt"));

    ui.endInput();
    await done;

    // The carried context turn 2 was driven with must be valid provider history (no dangling tool_use)
    // and must include the synthesized tool result that closes the interrupted call.
    expect(model.turn2Context).toBeDefined();
    expect(wellFormed(model.turn2Context!)).toBe(true);
    expect(model.turn2Context!.some((m) => m.role === "tool")).toBe(true);
    store.close();
  });

  it("carries the prior turn's assistant output into the next turn's MODEL CONTEXT (not just the ledger)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const model = new RecordingModel(
      new ScriptedModel({ turns: [{ text: "answer one" }, { text: "answer two" }] }),
    );

    ui.push({ kind: "line", text: "first" });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });
    await ui.awaitRender((v) => v.awaitingInput === true && hasAssistant(v, "answer one"));
    ui.push({ kind: "line", text: "second" });
    await ui.awaitRender((v) => hasAssistant(v, "answer two"));
    ui.endInput();
    await done;

    // Turn 2's context must contain turn 1's assistant reply (proves finalMessages is carried, not the
    // bare seed) AND the new user message — a "carry seed instead of finalMessages" mutation fails here.
    const turn2 = model.contexts[1] ?? [];
    expect(turn2.some((m) => m.role === "assistant" && m.content === "answer one")).toBe(true);
    expect(turn2.some((m) => m.role === "user" && m.content === "second")).toBe(true);
    store.close();
  });
});

describe("runRepl — resume seeding (Epic 1.23 slice 2)", () => {
  it("seeds model context from `resumed` WITHOUT re-recording it; the ledger gets only the new turn", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const resumed: ModelMessageT[] = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ];
    const model = new RecordingModel(new ScriptedModel({ turns: [{ text: "new answer" }] }));

    ui.push({ kind: "line", text: "follow-up" });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
      resumed,
    });
    await ui.awaitRender((v) => hasAssistant(v, "new answer"));
    ui.endInput();
    await done;

    // Turn 1's model context carries the RESUMED conversation + the new user message.
    const ctx = model.contexts[0] ?? [];
    expect(ctx.some((m) => m.role === "assistant" && m.content === "earlier answer")).toBe(true);
    expect(ctx.some((m) => m.role === "user" && m.content === "follow-up")).toBe(true);
    // The ledger records ONLY the new turn — the resumed history is NOT re-recorded into this store.
    const users = readSession(store.id, e)
      .events.filter((ev) => ev.type === "user")
      .map((ev) => (ev as { content: string }).content);
    expect(users).toEqual(["follow-up"]);
    store.close();
  });

  it("opens ON the resumed conversation with a 'resumed N messages' header, not the welcome screen (slice 9 QC)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const resumed: ModelMessageT[] = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ];
    const model = new ScriptedModel({ turns: [{ text: "new answer" }] });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
      resumed,
    });
    // The OPENING idle view shows the prior conversation + a resumed header — and NOT the first-run
    // brand banner (which would make a resumed session look brand-new + empty). All in one predicate.
    await ui.awaitRender(
      (v) =>
        v.awaitingInput === true &&
        hasAssistant(v, "earlier answer") &&
        v.items.some((it) => it.kind === "message" && /resumed 2 messages/i.test(it.content)) &&
        v.firstRun !== true, // resume must not raise the first-run banner flag
    );
    ui.endInput();
    await done;
    store.close();
  });

  it("keeps a historic spent-authority receipt visible after the next turn without making it model-visible or durable", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const resumed: ModelMessageT[] = [
      { role: "user", content: "remove the file" },
      { role: "assistant", content: "The reviewed removal completed." },
    ];
    const receipt = [
      "Historic once-approval receipt · authority spent",
      "- bash · approved once at audit #1 · applied at audit #2 · review command_review_1",
      "Resume restored no authority; repeating the action requires a fresh review.",
    ].join("\n");
    const model = new RecordingModel(
      new ScriptedModel({ turns: [{ text: "The repeated action needs review." }] }),
    );
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
      resumed,
      historicOnceApprovalReceipt: receipt,
    });

    await ui.awaitRender(
      (v) =>
        v.awaitingInput === true &&
        v.items.filter(
          (item) =>
            item.kind === "message" &&
            item.role === "system" &&
            item.content === receipt &&
            item.presentation === "notice",
        ).length === 1,
    );

    ui.push({ kind: "line", text: "repeat it" });
    await ui.awaitRender(
      (v) =>
        hasAssistant(v, "The repeated action needs review.") &&
        v.awaitingInput === true &&
        v.items.filter((item) => item.kind === "message" && item.content === receipt).length === 1,
    );
    ui.endInput();
    await done;

    expect(model.contexts[0]).not.toContainEqual({ role: "system", content: receipt });
    expect(readSession(store.id, e).events).not.toContainEqual(
      expect.objectContaining({ content: receipt }),
    );
    store.close();
  });

  it("hides model-only resume scaffolding and preserves failed tool outcomes", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const resumed: ModelMessageT[] = [
      { role: "system", content: "SYSTEM PROMPT: private model instructions" },
      { role: "system", content: "ENVIRONMENT SNAPSHOT: private runtime context" },
      { role: "system", content: "PROJECT AGENTS: private project instructions" },
      { role: "system", content: "WORKSPACE BACKUP: private recovery context" },
      { role: "user", content: "try the write" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "denied", name: "write", args: { path: "/outside" } }],
      },
      {
        role: "tool",
        content: "blocked by warden (not executed): POL-002 deny: outside workspace",
        toolCallId: "denied",
        name: "write",
      },
      { role: "assistant", content: "The write was blocked." },
    ];
    const done = runRepl({
      model: new ScriptedModel({ turns: [{ text: "new answer" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
      resumed,
      resumedFailedToolCallIds: new Set(["denied"]),
    });
    await ui.awaitRender(
      (v) => v.awaitingInput === true && hasAssistant(v, "The write was blocked."),
    );

    const frame = renderFrame(ui.latest!, false);
    expect(frame).toContain("resumed 8 messages");
    expect(frame).toContain("what: blocked: write:");
    expect(frame).not.toContain("tool  ✓ write  done");
    expect(frame.split("\n").filter((line) => line === "keel")).toHaveLength(1);
    expect(frame).not.toContain("SYSTEM PROMPT");
    expect(frame).not.toContain("ENVIRONMENT SNAPSHOT");
    expect(frame).not.toContain("PROJECT AGENTS");
    expect(frame).not.toContain("WORKSPACE BACKUP");

    ui.endInput();
    await done;
    store.close();
  });

  it("acknowledges re-applied pending steering in the resume header (P1-3 / ADR-0034 no silent absorption)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const resumed: ModelMessageT[] = [
      { role: "user", content: "earlier question" },
      { role: "user", content: "also add tests" }, // an injected pending comment
    ];
    const model = new ScriptedModel({ turns: [{ text: "new answer" }] });
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
      resumed,
      resumedSteeringApplied: 1,
    });
    await ui.awaitRender(
      (v) =>
        v.awaitingInput === true &&
        hasAssistant(v, "new answer") &&
        v.items.some(
          (it) =>
            it.kind === "message" &&
            /1 pending comment re-applied and dispatched/i.test(it.content),
        ),
    );
    ui.endInput();
    await done;
    store.close();
  });
});

describe("runRepl — exit commands (Epic 1.23 slice 1)", () => {
  it.each(["/exit", "/quit"])(
    "ends the session when the user types %s at the idle prompt (no new turn)",
    async (cmd) => {
      const e = env();
      const store = SessionStore.create({ cwd: "/w" }, e);
      const ui = new ReplUI();
      const model = new ScriptedModel({ turns: [{ text: "answer one" }] });

      ui.push({ kind: "line", text: "first" });
      const done = runRepl({
        model,
        executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
        ui,
        store,
        env: e,
      });
      await ui.awaitRender((v) => v.awaitingInput === true && hasAssistant(v, "answer one"));

      ui.push({ kind: "command", name: cmd }); // /exit or /quit ends the session right away
      await done; // resolves without an EOF — the command exited the loop

      const r = rebuild(readSession(store.id, e));
      expect(r.messages).toEqual([
        { role: "user", content: "first" },
        { role: "assistant", content: "answer one" },
      ]); // only turn 1 — the exit command started no new turn
      expect(ui.closes).toBe(1);
      store.close();
    },
  );
});

describe("runRepl — density commands (Epic 1.24 slice 5)", () => {
  it("applies /quiet and /normal at the idle prompt as presentation density only", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const done = runRepl({
      model: new ScriptedModel({ turns: [{ text: "unused" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({ kind: "command", name: "/quiet" });
    await ui.awaitRender(
      (v) =>
        v.density === "quiet" &&
        v.items.some(
          (item) =>
            item.kind === "message" && item.role === "system" && item.content === "density: quiet",
        ),
    );
    ui.push({ kind: "command", name: "/normal" });
    await ui.awaitRender(
      (v) =>
        v.density === "normal" &&
        v.items.some(
          (item) =>
            item.kind === "message" && item.role === "system" && item.content === "density: normal",
        ),
    );
    ui.endInput();
    await done;
    store.close();
  });

  it("a density set at idle SURVIVES into the next turn (Tier-B QC: not reset to normal)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const done = runRepl({
      model: new ScriptedModel({ turns: [{ text: "answer" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({ kind: "command", name: "/quiet" });
    await ui.awaitRender((v) => v.density === "quiet");

    // Run a turn; the just-finished idle view must STILL be quiet (the bug reset it via initialView).
    ui.push({ kind: "line", text: "go" });
    await ui.awaitRender((v) => hasAssistant(v, "answer") && v.awaitingInput === true);
    expect(ui.latest?.density).toBe("quiet");

    ui.endInput();
    await done;
    store.close();
  });

  it("/diff at idle toggles diffMode AND it survives the next turn (Tier-B QC)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const done = runRepl({
      model: new ScriptedModel({ turns: [{ text: "answer" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    // `/diff` at idle must actually flip the disclosure level (auto compact → full), not emit a
    // "not wired" notice — mirroring the runner's mid-turn `/diff` (diff-mode-toggle).
    ui.push({ kind: "command", name: "/diff" });
    await ui.awaitRender((v) => v.diffMode === "full");
    // The idle toggle also acknowledges the new level in the transcript (parity with density).
    expect(ui.latest?.items).toContainEqual({
      kind: "message",
      role: "system",
      content: "diff detail: full",
      presentation: "notice",
    });

    ui.push({ kind: "line", text: "go" });
    await ui.awaitRender((v) => hasAssistant(v, "answer") && v.awaitingInput === true);
    expect(ui.latest?.diffMode).toBe("full");

    ui.endInput();
    await done;
    store.close();
  });
});

describe("runRepl — focused diff review entry (Epic 3.10 Slice 3C)", () => {
  it("routes /diff review to the private idle renderer without changing the bare /diff mode", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new DiffViewerReplUI("opened");
    const done = runRepl({
      model: new ScriptedModel({ turns: [{ text: "unused" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({ kind: "command", name: "/diff", args: "review" });
    await ui.awaitViewerRequest();

    expect(ui.opens).toBe(1);
    expect(ui.latest?.diffMode).toBeUndefined();
    expect(
      ui.latest?.items.some(
        (item) => item.kind === "message" && /diff detail:/u.test(item.content),
      ),
    ).toBe(false);

    ui.endInput();
    await done;
    store.close();
  });

  it.each([
    ["no-diffs", /no settled diffs available/iu],
    ["not-settled", /focused diff review is available after the active turn settles/iu],
    ["unsupported", /interactive terminal.*bounded summary/iu],
  ] as const)(
    "reports the %s fallback without pretending the viewer opened",
    async (result, copy) => {
      const e = env();
      const store = SessionStore.create({ cwd: "/w" }, e);
      const ui = new DiffViewerReplUI(result);
      const done = runRepl({
        model: new ScriptedModel({ turns: [{ text: "unused" }] }),
        executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
        ui,
        store,
        env: e,
      });

      await ui.awaitRender((v) => v.awaitingInput === true);
      ui.push({ kind: "command", name: "/diff", args: "review" });
      await ui.awaitRender((v) =>
        v.items.some(
          (item) => item.kind === "message" && item.role === "system" && copy.test(item.content),
        ),
      );

      expect(ui.latest?.diffMode).toBeUndefined();
      ui.endInput();
      await done;
      store.close();
    },
  );

  it("rejects unknown /diff arguments without silently changing disclosure", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new ReplUI();
    const done = runRepl({
      model: new ScriptedModel({ turns: [{ text: "unused" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.push({ kind: "command", name: "/diff", args: "surprise" });
    await ui.awaitRender((v) =>
      v.items.some((item) => item.kind === "message" && item.content === "usage: /diff [review]"),
    );

    expect(ui.latest?.diffMode).toBeUndefined();
    ui.endInput();
    await done;
    store.close();
  });
});
