import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecutorPort,
  ModelPort,
  ModelTurnInput,
  SimulatorScriptT,
  ToolInvocationT,
  ToolResultT,
  ToolSpecT,
  UIPort,
  UserInput,
  ViewModel,
} from "@keel/shared";
import {
  Goal,
  LifecycleManifest,
  LIFECYCLE_MANIFEST_VERSION,
  RUN_CONTROL_SCHEMA_VERSION,
} from "@keel/shared";
import { ScriptedModel } from "@keel/simulator";
import { SessionStore, readSession } from "../session/store.js";
import { rebuild } from "../session/resume.js";
import { renderFrame } from "./headless.js";
import { classifyInput, runSession, runSessionWithControlState } from "./runner.js";
import { staticModelRouteRuntime } from "../model-routing/controller.js";
import { appendWardenAutoResolvedEvent } from "../warden/receipt.js";
import { associateMutationPresentationResolver } from "../warden/mutation-presentation-resolver.js";
import { createInteractiveReviewDecisionController } from "./review-decision.js";
import {
  markToolPresentationOutcome,
  toolPresentationOutcome,
  type ToolPresentationOutcome,
} from "../tool-presentation-outcome.js";
import { OVERLAY_DISMISS, OverlayDismissRegistry } from "./overlay-dismiss.js";
import { PURPOSEFUL_LIVENESS } from "./purposeful-liveness.js";
import { WardenExecutor, type WardenExecuteClient } from "../warden/executor.js";
import { WardenClientError } from "../warden/client.js";
import { createAgentLoopControlState } from "../loop.js";
import { recoverableTerminalReviewResult } from "../warden/terminal-review.js";
import { buildTurnSummary, initialView } from "./view-model.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (v: T) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A test `UIPort` whose `inputs()` is a manually-fed async queue, recording the latest rendered
 * view. `push` injects a mid-run input; `awaitRender` resolves once a rendered view matches a
 * predicate (so a test can wait until the runner has actually recorded a steering input before
 * releasing a blocked tool — fully deterministic, no sleeps).
 */
class QueueUI implements UIPort {
  #latest: ViewModel | undefined;
  readonly renders: ViewModel[] = [];
  #queue: UserInput[] = [];
  #waiter: ((r: IteratorResult<UserInput>) => void) | undefined;
  #closed = false;
  #renderWaiters: { pred: (v: ViewModel) => boolean; resolve: () => void }[] = [];
  readonly #overlayDismiss = new OverlayDismissRegistry();
  readonly [OVERLAY_DISMISS] = (handler: () => void): (() => void) =>
    this.#overlayDismiss.connect(handler);

  render(view: ViewModel): void {
    this.#latest = view;
    this.renders.push(view);
    this.#renderWaiters = this.#renderWaiters.filter((w) => {
      if (w.pred(view)) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  view(): ViewModel {
    if (this.#latest === undefined) throw new Error("nothing rendered yet");
    return this.#latest;
  }

  awaitRender(pred: (v: ViewModel) => boolean): Promise<void> {
    if (this.#latest !== undefined && pred(this.#latest)) return Promise.resolve();
    return new Promise((resolve) => this.#renderWaiters.push({ pred, resolve }));
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

  dismissOverlay(): void {
    this.#overlayDismiss.dismiss();
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
    const w = this.#waiter;
    if (w !== undefined) {
      this.#waiter = undefined;
      w({ value: undefined, done: true });
    }
    return Promise.resolve();
  }
}

class LivenessQueueUI extends QueueUI {
  readonly [PURPOSEFUL_LIVENESS] = true;
}

class FailingLivenessQueueUI extends LivenessQueueUI {
  closeCalls = 0;

  override render(view: ViewModel): void {
    super.render(view);
    if (
      view.items.some((item) => item.kind === "tool" && (item.liveness?.elapsedMs ?? 0) >= 2_000)
    ) {
      throw new Error("dynamic renderer failed");
    }
  }

  override close(): Promise<void> {
    this.closeCalls += 1;
    return super.close();
  }
}

class FailingInputUI extends QueueUI {
  readonly #failure = deferred();
  didClose = false;

  failInputs(): void {
    this.#failure.resolve();
  }

  override async *inputs(): AsyncIterable<UserInput> {
    yield* [] as UserInput[];
    await this.#failure.promise;
    throw new Error("input channel failed");
  }

  override async close(): Promise<void> {
    this.didClose = true;
    await super.close();
  }
}

class FailingCloseUI extends QueueUI {
  override async close(): Promise<void> {
    await super.close();
    throw new Error("UI close failed");
  }
}

const seed = [{ role: "user" as const, content: "go" }];

const validationGoal = Goal.parse({
  schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
  id: "goal_validation_steering",
  objective: "finish without losing input during validation",
  doneWhen: [{ id: "check", kind: "command", check: { argv: ["pnpm", "test"] } }],
  validation: { tier: "standard" },
  requiresCompletionAudit: true,
});

const validationManifest = LifecycleManifest.parse({
  schemaVersion: LIFECYCLE_MANIFEST_VERSION,
  actions: { "test.unit": { argv: ["pnpm", "test"] } },
  validationTiers: { standard: { required: ["test.unit"] } },
});

describe("classifyInput (§4.10 input → steering intent)", () => {
  it("a typed line is a queued comment", () => {
    expect(classifyInput({ kind: "line", text: "also fix the typo" })).toEqual({
      kind: "steering",
      class: "queued",
      content: "also fix the typo",
    });
  });

  it("an urgent verb is urgent, carrying its instruction (or the verb when bare)", () => {
    expect(classifyInput({ kind: "command", name: "/now", args: "stop" })).toEqual({
      kind: "steering",
      class: "urgent",
      content: "stop",
    });
    expect(classifyInput({ kind: "command", name: "/before-next-edit" })).toEqual({
      kind: "steering",
      class: "urgent",
      content: "/before-next-edit",
    });
  });

  it("interrupt (key) and /interrupt (command) both hard-stop", () => {
    expect(classifyInput({ kind: "interrupt" })).toEqual({ kind: "interrupt" });
    expect(classifyInput({ kind: "command", name: "/interrupt" })).toEqual({ kind: "interrupt" });
  });

  it("any other slash command is a non-steering palette command (entrypoint handles it)", () => {
    expect(classifyInput({ kind: "command", name: "/quiet" })).toEqual({
      kind: "command",
      name: "/quiet",
    });
  });
});

describe("runner — /diff toggles the diff disclosure mode (Epic 1.5b)", () => {
  it("does not render when a loop event leaves the immutable view unchanged", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();

    await runSession({
      model: new ScriptedModel({ turns: [{ text: "done" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      seed,
      env: e,
    });
    store.close();

    expect(ui.renders.length).toBeGreaterThan(1);
    expect(ui.renders.some((view, index) => index > 0 && view === ui.renders[index - 1])).toBe(
      false,
    );
  });

  it("a /diff command flips the view's diffMode (auto compact default → full)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    ui.push({ kind: "command", name: "/diff" }); // queued before the run; consumed concurrently
    await runSession({
      model: new ScriptedModel({ turns: [{ text: "done" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      seed,
      env: e,
    });
    store.close();
    expect(ui.view().diffMode).toBe("full"); // the command expands the calm default
    // …and it acknowledges the change in the transcript, like the density commands do — a /diff
    // toggle must not be a silent state change (the footer alone doesn't label the compact default).
    expect(ui.view().items).toContainEqual({
      kind: "message",
      role: "system",
      content: "diff detail: full",
      presentation: "notice",
    });
  });

  it("does not open or toggle focused review while a turn is active", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    ui.push({ kind: "command", name: "/diff", args: "review" });
    await runSession({
      model: new ScriptedModel({ turns: [{ text: "done" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      seed,
      env: e,
    });
    store.close();

    expect(ui.view().diffMode).toBeUndefined();
    expect(ui.view().items).toContainEqual({
      kind: "message",
      role: "system",
      content: "Focused diff review is available after the active turn settles.",
      presentation: "notice",
    });
  });

  it("rejects unknown /diff arguments during a turn without toggling", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    ui.push({ kind: "command", name: "/diff", args: "surprise" });
    await runSession({
      model: new ScriptedModel({ turns: [{ text: "done" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      seed,
      env: e,
    });
    store.close();

    expect(ui.view().diffMode).toBeUndefined();
    expect(ui.view().items).toContainEqual({
      kind: "message",
      role: "system",
      content: "usage: /diff [review]",
      presentation: "notice",
    });
  });

  it("a density command changes presentation state without steering the model", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    ui.push({ kind: "command", name: "/debug" }); // queued before the run; consumed concurrently
    await runSession({
      model: new ScriptedModel({ turns: [{ text: "done" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      seed,
      env: e,
    });
    store.close();
    expect(ui.view().density).toBe("debug");
    expect(renderFrame(ui.view())).toContain("view debug");
    expect(ui.view().items).toContainEqual({
      kind: "message",
      role: "system",
      content: "density: debug",
      presentation: "notice",
    });

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).not.toContainEqual({ role: "user", content: "/debug" });
  });

  it("an unavailable palette command renders an honest notice without steering the model", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    ui.push({ kind: "command", name: "/session" });
    const outcome = await runSession({
      model: new ScriptedModel({ turns: [{ text: "done" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      seed,
      env: e,
    });
    store.close();

    expect(outcome.lastStop).toBe("model-stop");
    expect(ui.view().density).toBeUndefined();
    expect(ui.view().diffMode).toBeUndefined();
    expect(ui.view().pendingInputs).toBeUndefined();
    expect(renderFrame(ui.view())).toContain("keel --continue");
    const r = rebuild(readSession(store.id, e));
    expect(r.messages).not.toContainEqual({ role: "user", content: "/session" });
  });

  it("a /compact command during a turn renders review-only UI without steering the model", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    ui.push({ kind: "command", name: "/compact" });
    await runSession({
      model: new ScriptedModel({ turns: [{ text: "done" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      seed,
      env: e,
    });
    store.close();

    const frame = renderFrame(ui.view());
    expect(frame).toContain("compact proposal");
    expect(frame).toContain("review only");
    const r = rebuild(readSession(store.id, e));
    expect(r.messages).not.toContainEqual({ role: "user", content: "/compact" });
  });

  it("a /reviews command during a turn renders read-only queue state without steering the model", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    ui.push({ kind: "command", name: "/reviews" });
    await runSession({
      model: new ScriptedModel({ turns: [{ text: "done" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      seed,
      env: e,
    });
    store.close();

    const frame = renderFrame(ui.view());
    expect(frame).toContain("reviews");
    expect(frame).toContain("read-only: cannot approve");
    const r = rebuild(readSession(store.id, e));
    expect(r.messages).not.toContainEqual({ role: "user", content: "/reviews" });
  });

  it("a /policies command during a turn renders read-only protection state without steering the model", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    ui.push({ kind: "command", name: "/policies" });
    await runSession({
      model: new ScriptedModel({ turns: [{ text: "done" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      seed,
      env: e,
      view: {
        protectionRoute: "governed",
        policy: { active: true, label: "Guided · starter@abc123" },
        posture: { sandbox: true, egress: true, audit: true },
        lastWardenPendingReviews: 0,
      },
    });
    store.close();

    const frame = renderFrame(ui.view());
    expect(frame).toContain("policies");
    expect(frame).toContain("policy: Guided · starter@abc123");
    expect(frame).toContain("read-only");
    const r = rebuild(readSession(store.id, e));
    expect(r.messages).not.toContainEqual({ role: "user", content: "/policies" });
  });

  it("routes active warden review shortcuts to the controller before steering", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const reviewDecisions = createInteractiveReviewDecisionController();
    const commandKey = `sha256:${"a".repeat(64)}`;
    const executor: ExecutorPort = {
      execute: async (call, opts) => {
        const decision = await reviewDecisions.onReviewRequired({
          toolCall: call,
          review: {
            reviewId: "command_review_1",
            summary: "command review for python3 in workspace /repo",
            allowCommand: `keel approve command_review_1 --scope once --command-key ${commandKey}`,
          },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        });
        return decision?.approved === true
          ? { ok: true, output: `resolved ${decision.scope}` }
          : { ok: false, output: "left pending" };
      },
    };

    const done = runSession({
      model: new ScriptedModel({
        turns: [
          { toolCalls: [{ name: "bash", args: { command: "python3 tools/check.py" } }] },
          { text: "checked" },
        ],
      }),
      executor,
      ui,
      store,
      seed,
      env: e,
      reviewDecisions,
    });
    await ui.awaitRender((v) => renderFrame(v).includes("approval required"));
    const pendingFrame = renderFrame(ui.view());
    expect(ui.view().activeApproval?.information).toMatchObject({
      requestedAction: { status: "available", value: "bash" },
      effectiveTarget: {
        status: "available",
        value: "command review for python3 in workspace /repo",
        completeness: "complete",
      },
      exactResource: {
        status: "available",
        kind: "command-envelope",
        value: commandKey,
      },
    });
    expect(pendingFrame).toContain("Requested");
    expect(pendingFrame).toContain("Effective target");
    expect(pendingFrame).toContain("Exact reusable scope");
    expect(pendingFrame).toContain(commandKey);
    expect(pendingFrame).toContain("[a] Approve once");
    expect(pendingFrame).not.toContain("1 review item pending");
    expect(pendingFrame).not.toContain("manual approval command");

    ui.push({ kind: "line", text: "a" });
    await done;
    store.close();

    const frame = renderFrame(ui.view());
    expect(frame).toContain("resolved once");
    expect(frame).toContain("checked");
    expect(frame).not.toContain("1 review item pending");
    const r = rebuild(readSession(store.id, e));
    expect(r.messages).not.toContainEqual({ role: "user", content: "a" });
    const durable = JSON.stringify(readSession(store.id, e));
    expect(durable).not.toContain("effectiveTarget");
    expect(durable).not.toContain("exactResource");
    expect(durable).not.toContain(commandKey);
  });

  it("carries approved governed deny through the runner without authority or effect overclaims", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const reviewDecisions = createInteractiveReviewDecisionController();
    const settlement = deferred<{
      readonly status: "resolved";
      readonly verdict: "deny";
    }>();
    const executor: ExecutorPort = {
      execute: async (call, opts) => {
        const decision = await reviewDecisions.onReviewRequired({
          toolCall: call,
          review: {
            reviewId: "mcp_review_pin_drift",
            summary: "opaque local MCP call requires exact once-only approval: mcp__beta__add",
            allowCommand: "keel approve mcp_review_pin_drift --scope once",
          },
          settlement: settlement.promise,
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        });
        if (decision?.approved === true) {
          settlement.resolve({ status: "resolved", verdict: "deny" });
          await Promise.resolve();
        }
        return {
          ok: false,
          output:
            "MCP pin mismatch after local server startup; action may have executed; do not retry automatically; inspect audit",
        };
      },
    };

    const done = runSession({
      model: new ScriptedModel({
        turns: [
          { toolCalls: [{ name: "mcp__beta__add", args: { a: 20, b: 22 } }] },
          { text: "The governed result was denied after pin drift." },
        ],
      }),
      executor,
      ui,
      store,
      seed,
      env: e,
      reviewDecisions,
    });
    await ui.awaitRender((view) => view.activeApproval?.state === "pending");
    ui.push({ kind: "line", text: "a" });
    await ui.awaitRender((view) => view.activeApproval?.state === "governed-deny");

    const settledFrame = renderFrame(ui.view());
    expect(settledFrame).toContain("governed result denied");
    expect(settledFrame).toContain("governed result deny");
    expect(settledFrame).toContain("Inspect the governed tool result");
    expect(settledFrame).not.toContain("approval confirmed");
    expect(settledFrame).not.toContain("action not executed");
    expect(settledFrame).not.toContain("Keel may resume");

    await done;
    store.close();
    const finalFrame = renderFrame(ui.view());
    expect(finalFrame).toContain("human approved once; Warden returned deny");
    expect(finalFrame).toContain("this receipt does not claim non-execution");
    expect(finalFrame).toContain("MCP pin mismatch after local server startup");
    expect(finalFrame).not.toContain("authority · none granted; action not executed");
    const toolResult = readSession(store.id, e).events.find(
      (event) => event.type === "tool_result",
    );
    expect(toolResult?.output).toContain("action may have executed");
    expect(toolResult?.output).toContain("do not retry automatically; inspect audit");
  });

  it("waits for authoritative denial after a reviewed tool times out and rejects late approval", async () => {
    vi.useFakeTimers();
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const reviewDecisions = createInteractiveReviewDecisionController();
    const releaseDenial = deferred();
    let modelTurns = 0;
    const wardenCalls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const model: ModelPort = {
      async *stream() {
        modelTurns += 1;
        if (modelTurns === 1) {
          yield {
            type: "tool-call" as const,
            id: "call_review_timeout",
            name: "bash",
            args: { command: "rm -f protected.txt" },
          };
          yield {
            type: "finish" as const,
            reason: "tool-calls" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
          return;
        }
        yield { type: "text-delta" as const, text: "recovered after denial" };
        yield {
          type: "finish" as const,
          reason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const client = {
      call: async (method: string, params: unknown) => {
        wardenCalls.push({ method, params });
        if (method === "warden.execute") {
          return {
            verdict: "review",
            review: {
              reviewId: "command_review_timeout",
              summary: "command review requires approval: rm -f protected.txt",
              allowCommand: "keel approve command_review_timeout --scope once",
            },
            auditSeq: 4,
          };
        }
        await releaseDenial.promise;
        return { verdict: "deny", auditSeq: 5 };
      },
    } as unknown as WardenExecuteClient;
    const executor = new WardenExecutor({
      client,
      sessionId: store.id,
      principal: {
        osUser: "tester",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
      onReviewRequired: reviewDecisions.onReviewRequired,
    });

    try {
      const done = runSession({
        model,
        executor,
        ui,
        store,
        seed,
        env: e,
        reviewDecisions,
        infraTimeout: { toolMs: 1_000 },
      });
      await ui.awaitRender((view) => view.activeApproval?.state === "pending");

      await vi.advanceTimersByTimeAsync(1_000);
      await ui.awaitRender((view) => view.activeApproval?.state === "submitted");
      expect(renderFrame(ui.view())).toContain("expired at the tool deadline");

      const rendersBeforeLateDecision = ui.renders.length;
      ui.push({ kind: "line", text: "a" });
      await ui.awaitRender(
        (view) =>
          ui.renders.length > rendersBeforeLateDecision &&
          (view.activeApproval?.message ?? "").includes("late decisions are rejected"),
      );
      expect(modelTurns).toBe(1);

      releaseDenial.resolve();
      const outcome = await done;

      expect(modelTurns).toBe(1);
      expect(outcome.finalView.currentTurn).toBeUndefined();
      expect(outcome.finalView.streaming).toBe(false);
      expect(renderFrame(ui.view())).toContain("blocked");
      expect(renderFrame(ui.view())).toContain("not executed");
      expect(renderFrame(ui.view())).toContain("no review remains pending");
      expect(ui.view().activeApproval).toBeUndefined();
      const rebuilt = rebuild(readSession(store.id, e));
      const toolResult = rebuilt.messages.find(
        (message) => message.role === "tool" && message.toolCallId === "call_review_timeout",
      );
      expect(toolResult?.content).toContain("blocked by warden (not executed)");
      expect(toolResult?.content).toContain("review closed as denied");
      expect(toolResult?.content).toContain("no review remains pending");
      expect(rebuilt.messages).not.toContainEqual({
        role: "user",
        content: "a",
      });
      expect(JSON.stringify(rebuilt.messages)).not.toContain("try a smaller step");
      expect(JSON.stringify(rebuilt.messages)).not.toContain("recovered after denial");
      expect(wardenCalls).toHaveLength(2);
      expect(wardenCalls[1]).toMatchObject({
        method: "warden.resolveReview",
        params: { reviewId: "command_review_timeout", approved: false },
      });
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it.each([
    { name: "late allow", transportFailure: false },
    { name: "submitted transport failure", transportFailure: true },
  ])(
    "halts indeterminate after a $name crosses the review deadline",
    async ({ transportFailure }) => {
      vi.useFakeTimers();
      const e = env();
      const store = SessionStore.create({ cwd: "/w" }, e);
      const ui = new QueueUI();
      const reviewDecisions = createInteractiveReviewDecisionController();
      let modelTurns = 0;
      const wardenCalls: Array<{ readonly method: string; readonly params: unknown }> = [];
      const model: ModelPort = {
        async *stream() {
          modelTurns += 1;
          if (modelTurns === 1) {
            yield {
              type: "tool-call" as const,
              id: "call_submitted_review_timeout",
              name: "bash",
              args: { command: "rm -f protected.txt" },
            };
            yield {
              type: "finish" as const,
              reason: "tool-calls" as const,
              usage: { inputTokens: 1, outputTokens: 1 },
            };
            return;
          }
          yield { type: "text-delta" as const, text: "UNSAFE_RETRY_AFTER_SUBMITTED_APPROVAL" };
          yield {
            type: "finish" as const,
            reason: "stop" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      };
      const client = {
        call: async (
          method: string,
          params: unknown,
          options?: { readonly signal?: AbortSignal },
        ) => {
          wardenCalls.push({ method, params });
          if (method === "warden.execute") {
            return {
              verdict: "review",
              review: {
                reviewId: "command_review_submitted_timeout",
                summary: "command review requires approval: rm -f protected.txt",
                allowCommand: "keel approve command_review_submitted_timeout --scope once",
              },
              auditSeq: 4,
            };
          }
          await new Promise<void>((resolve) => {
            const onAbort = (): void => resolve();
            if (options?.signal?.aborted === true) onAbort();
            else options?.signal?.addEventListener("abort", onAbort, { once: true });
          });
          if (transportFailure) {
            throw new WardenClientError("WARDEN_UNAVAILABLE", "review transport unavailable", {
              requestSent: true,
            });
          }
          return { verdict: "allow", result: "RAW_LATE_APPROVED_EXECUTION", auditSeq: 5 };
        },
      } as unknown as WardenExecuteClient;
      const executor = new WardenExecutor({
        client,
        sessionId: store.id,
        principal: {
          osUser: "tester",
          configuredId: null,
          authProvider: "local",
          assurance: "local-os-user",
        },
        onReviewRequired: reviewDecisions.onReviewRequired,
      });

      try {
        const done = runSession({
          model,
          executor,
          ui,
          store,
          seed,
          env: e,
          reviewDecisions,
          infraTimeout: { toolMs: 1_000 },
        });
        await ui.awaitRender((view) => view.activeApproval?.state === "pending");
        ui.push({ kind: "line", text: "a" });
        await ui.awaitRender((view) => view.activeApproval?.state === "submitted");

        await vi.advanceTimersByTimeAsync(1_000);
        await done;

        expect(modelTurns).toBe(1);
        expect(ui.view().activeApproval).toBeUndefined();
        const frame = renderFrame(ui.view());
        expect(frame).toContain("partial");
        expect(frame).toContain("may have executed");
        expect(frame).toContain("restart and inspect audit before deciding again");
        expect(frame).not.toContain("inspect the target before retrying");
        const rebuilt = rebuild(readSession(store.id, e));
        const toolResult = rebuilt.messages.find(
          (message) =>
            message.role === "tool" && message.toolCallId === "call_submitted_review_timeout",
        );
        expect(toolResult?.content).toContain("may have executed");
        expect(toolResult?.content).toContain("do not retry automatically");
        expect(toolResult?.content).not.toContain("RAW_LATE_APPROVED_EXECUTION");
        expect(JSON.stringify(rebuilt.messages)).not.toContain(
          "UNSAFE_RETRY_AFTER_SUBMITTED_APPROVAL",
        );
        expect(wardenCalls[1]).toMatchObject({
          method: "warden.resolveReview",
          params: { reviewId: "command_review_submitted_timeout", approved: true, scope: "once" },
        });
      } finally {
        store.close();
        vi.useRealTimers();
      }
    },
  );

  it("halts instead of re-driving the model when timed-out review denial is not confirmed", async () => {
    vi.useFakeTimers();
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const reviewDecisions = createInteractiveReviewDecisionController();
    let modelTurns = 0;
    const model: ModelPort = {
      async *stream() {
        modelTurns += 1;
        if (modelTurns === 1) {
          yield {
            type: "tool-call" as const,
            id: "call_review_timeout_unsettled",
            name: "bash",
            args: { command: "rm -f protected.txt" },
          };
          yield {
            type: "finish" as const,
            reason: "tool-calls" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
          return;
        }
        yield { type: "text-delta" as const, text: "must not recover" };
        yield {
          type: "finish" as const,
          reason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const executor: ExecutorPort = {
      execute: async (call, options) => {
        let fail!: (value: { readonly status: "failed"; readonly message: string }) => void;
        const settlement = new Promise<{
          readonly status: "failed";
          readonly message: string;
        }>((resolve) => {
          fail = resolve;
        });
        await reviewDecisions.onReviewRequired({
          toolCall: call,
          review: {
            reviewId: "command_review_timeout_unsettled",
            summary: "command review requires approval: rm -f protected.txt",
            allowCommand: "keel approve command_review_timeout_unsettled --scope once",
          },
          settlement,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        });
        fail({ status: "failed", message: "warden denial transport unavailable" });
        await Promise.resolve();
        return { ok: false, output: "review denial not confirmed" };
      },
    };

    try {
      const done = runSession({
        model,
        executor,
        ui,
        store,
        seed,
        env: e,
        reviewDecisions,
        infraTimeout: { toolMs: 1_000 },
      });
      await ui.awaitRender((view) => view.activeApproval?.state === "pending");

      await vi.advanceTimersByTimeAsync(1_000);
      const outcome = await done;

      expect(modelTurns).toBe(1);
      expect(outcome.lastStop).toBe("aborted");
      expect(renderFrame(ui.view())).toContain("interrupted");
      expect(renderFrame(ui.view())).not.toContain("must not recover");
      expect(rebuild(readSession(store.id, e)).messages).not.toContainEqual(
        expect.objectContaining({ role: "assistant", content: "must not recover" }),
      );
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("keeps settlement delivery failure visible and non-actionable in the focused review", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const reviewDecisions = createInteractiveReviewDecisionController();
    const settlement = deferred<{
      readonly status: "failed";
      readonly message: string;
    }>();
    const executor: ExecutorPort = {
      execute: async (call, opts) => {
        const decision = await reviewDecisions.onReviewRequired({
          toolCall: call,
          review: {
            reviewId: "command_review_failed_delivery",
            summary: "command review for python3 in workspace /repo",
            allowCommand: "keel approve command_review_failed_delivery --scope once",
          },
          settlement: settlement.promise,
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        });
        if (decision?.approved === true) {
          settlement.resolve({ status: "failed", message: "warden connection closed" });
          await Promise.resolve();
        }
        return { ok: false, output: "review settlement unavailable" };
      },
    };

    const done = runSession({
      model: new ScriptedModel({
        turns: [
          { toolCalls: [{ name: "bash", args: { command: "python3 tools/check.py" } }] },
          { text: "I could not run the command." },
        ],
      }),
      executor,
      ui,
      store,
      seed,
      env: e,
      reviewDecisions,
    });
    await ui.awaitRender((v) => v.activeApproval?.state === "pending");
    ui.push({ kind: "line", text: "a" });
    await ui.awaitRender((v) => v.activeApproval?.state === "failed");

    const failedFrame = renderFrame(ui.view());
    expect(ui.view().activeApproval?.selectedChoice).toBe("once");
    expect(failedFrame).toContain("Consequence");
    expect(failedFrame).toContain("Once applies only to this review");
    expect(failedFrame).toContain("review decision not confirmed: warden connection closed");
    expect(failedFrame).toContain("no approval assumed");
    expect(failedFrame).not.toContain("[a] Approve once");
    expect(failedFrame).not.toContain("1 review item pending");

    await done;
    store.close();
    expect(ui.view().activeApproval).toBeUndefined();
    expect(renderFrame(ui.view())).toContain("I could not run the command.");
  });

  it("keeps approval focus ahead of unrelated panels until the review resolves", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const reviewDecisions = createInteractiveReviewDecisionController();
    const commandKey = `sha256:${"a".repeat(64)}`;
    let resolvedScope: string | undefined;
    const executor: ExecutorPort = {
      execute: async (call, opts) => {
        const decision = await reviewDecisions.onReviewRequired({
          toolCall: call,
          review: {
            reviewId: "command_review_focus",
            summary: "command review for python3 in workspace /repo",
            allowCommand: `keel approve command_review_focus --scope once --command-key ${commandKey}`,
          },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        });
        resolvedScope = decision?.approved === true ? decision.scope : "denied";
        return decision?.approved === true
          ? { ok: true, output: `resolved ${decision.scope}` }
          : { ok: false, output: "left pending" };
      },
    };

    const done = runSession({
      model: new ScriptedModel({
        turns: [
          { toolCalls: [{ name: "bash", args: { command: "python3 tools/check.py" } }] },
          { text: "checked" },
        ],
      }),
      executor,
      ui,
      store,
      seed,
      env: e,
      reviewDecisions,
    });
    await ui.awaitRender((v) => renderFrame(v).includes("approval required"));
    ui.push({ kind: "command", name: "/policies" });
    await ui.awaitRender((v) => renderFrame(v).includes("approval is active"));
    expect(ui.view().overlay).toBeUndefined();
    expect(resolvedScope).toBeUndefined();

    ui.push({ kind: "command", name: "/why" });
    await ui.awaitRender((v) => renderFrame(v).includes("explanation shown above"));
    expect(resolvedScope).toBeUndefined();
    ui.push({ kind: "line", text: "a" });
    await done;
    store.close();

    expect(resolvedScope).toBe("once");
    expect(renderFrame(ui.view())).toContain("checked");
  });

  it("does not convert plain line input into review approval authority", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const reviewDecisions = createInteractiveReviewDecisionController();
    const commandKey = `sha256:${"a".repeat(64)}`;
    let resolvedScope: string | undefined;
    const executor: ExecutorPort = {
      execute: async (call, opts) => {
        const decision = await reviewDecisions.onReviewRequired({
          toolCall: call,
          review: {
            reviewId: "command_review_1",
            summary: "command review for python3 in workspace /repo",
            allowCommand: `keel approve command_review_1 --scope once --command-key ${commandKey}`,
          },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        });
        resolvedScope = decision?.approved === true ? decision.scope : "denied";
        return decision?.approved === true
          ? { ok: true, output: `resolved ${decision.scope}` }
          : { ok: false, output: "left pending" };
      },
    };

    const done = runSession({
      model: new ScriptedModel({
        turns: [
          { toolCalls: [{ name: "bash", args: { command: "python3 tools/check.py" } }] },
          { text: "after steering" },
        ],
      }),
      executor,
      ui,
      store,
      seed,
      env: e,
      reviewDecisions,
    });
    await ui.awaitRender((v) => renderFrame(v).includes("approval required"));
    ui.push({ kind: "line", text: "o" });
    await ui.awaitRender((v) => renderFrame(v).includes("approval is active"));
    expect(resolvedScope).toBeUndefined();

    ui.push({ kind: "command", name: "/deny" });
    await done;
    store.close();

    expect(resolvedScope).toBe("denied");
    const r = rebuild(readSession(store.id, e));
    expect(r.messages).not.toContainEqual({ role: "user", content: "o" });
  });

  it("fails closed instead of hanging when input closes during an active review", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const reviewDecisions = createInteractiveReviewDecisionController();
    const commandKey = `sha256:${"a".repeat(64)}`;
    let resolved = false;
    const executor: ExecutorPort = {
      execute: async (call, opts) => {
        const decision = await reviewDecisions.onReviewRequired({
          toolCall: call,
          review: {
            reviewId: "command_review_1",
            summary: "command review for python3 in workspace /repo",
            allowCommand: `keel approve command_review_1 --scope once --command-key ${commandKey}`,
          },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        });
        resolved = true;
        return decision?.approved === true
          ? { ok: true, output: `resolved ${decision.scope}` }
          : { ok: false, output: "left pending" };
      },
    };

    const done = runSession({
      model: new ScriptedModel({
        turns: [{ toolCalls: [{ name: "bash", args: { command: "python3 tools/check.py" } }] }],
      }),
      executor,
      ui,
      store,
      seed,
      env: e,
      reviewDecisions,
    });
    await ui.awaitRender((v) => renderFrame(v).includes("approval required"));

    await ui.close();
    await done;
    store.close();

    expect(resolved).toBe(true);
    expect(renderFrame(ui.view())).toContain("interrupted");
  });

  it("a /model preview command renders a read-only routing panel without steering the model", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const modelRouting = staticModelRouteRuntime({
      schemaVersion: "model-routing.keel.dev/v1",
      decisionId: "route_dec_runner",
      requestId: "route_req_runner",
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

    ui.push({ kind: "command", name: "/model", args: "preview" });
    await runSession({
      model: new ScriptedModel({ turns: [{ text: "done" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      seed,
      env: e,
      modelRouting,
      view: { model: "anthropic/sonnet", modelRoute: modelRouting.status() },
    });
    store.close();

    const frame = renderFrame(ui.view());
    expect(frame).toContain("preview: decision only");
    expect(frame).toContain("route mode: locked");
    expect(modelRouting.previewCalls()).toBe(1);
    expect(rebuild(readSession(store.id, e)).messages).not.toContainEqual({
      role: "user",
      content: "/model preview",
    });
  });

  it("a /model command without routing runtime renders unknown status", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();

    ui.push({ kind: "command", name: "/model" });
    await runSession({
      model: new ScriptedModel({ turns: [{ text: "done" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      seed,
      env: e,
    });
    store.close();

    const frame = renderFrame(ui.view());
    expect(frame).toContain("route mode: locked");
    expect(frame).toContain("status: unknown");
  });
});

describe("runner — urgent steering terminal presentation truth (Epic 3.17)", () => {
  it.each([
    { name: "/now", instruction: "do not edit f.ts" },
    { name: "/before-next-edit", instruction: "keep f.ts unchanged" },
    { name: "/stop-after-current", instruction: "stop before editing f.ts" },
  ] as const)(
    "$name completes the current tool, prevents the edit, redrives once, and leaves no running residue",
    async ({ name, instruction }) => {
      const e = env();
      const store = SessionStore.create({ cwd: "/w" }, e);
      const ui = new QueueUI();
      const readStarted = deferred();
      const releaseRead = deferred();
      const executed: string[] = [];
      const executor: ExecutorPort = {
        execute(call): Promise<ToolResultT> {
          executed.push(call.name);
          if (call.name === "read") {
            readStarted.resolve();
            return releaseRead.promise.then(() => ({ ok: true, output: "original contents" }));
          }
          if (call.name === "edit") {
            return Promise.resolve({ ok: true, output: "MUST NOT EXECUTE" });
          }
          return Promise.resolve({ ok: false, output: `unexpected tool ${call.name}` });
        },
      };
      const done = runSession({
        model: new ScriptedModel({
          turns: [
            { toolCalls: [{ name: "read", args: { path: "f.ts" } }] },
            {
              text: "I will edit f.ts now.",
              toolCalls: [
                {
                  name: "edit",
                  args: { path: "f.ts", oldString: "before", newString: "after" },
                },
              ],
            },
            { text: `redrive settled after ${name}` },
          ],
        }),
        executor,
        ui,
        store,
        seed,
        env: e,
      });

      await readStarted.promise;
      ui.push({ kind: "command", name, args: instruction });
      await ui.awaitRender((view) => (view.pendingInputs ?? 0) === 1);
      releaseRead.resolve();
      const outcome = await done;

      expect(executed).toEqual(["read"]);
      expect(outcome.lastStop).toBe("model-stop");
      expect(outcome.finalView.streaming).toBe(false);
      expect(outcome.finalView.currentTurn).toBeUndefined();
      expect(outcome.finalView.pendingInputs ?? 0).toBe(0);
      expect(outcome.finalView.queuedInputs ?? []).toEqual([]);
      expect(
        outcome.finalView.items.some((item) => item.kind === "tool" && item.status === "running"),
      ).toBe(false);
      const prevented = outcome.finalView.items.find(
        (item) => item.kind === "tool" && item.id === "call_1_0",
      );
      expect(prevented).toMatchObject({
        kind: "tool",
        status: "error",
        summary:
          "not started: the controller ended the run before invoking this tool; this tool did not execute.",
      });
      if (prevented?.kind !== "tool") throw new Error("expected prevented edit activity");
      expect(toolPresentationOutcome(prevented)).toBe("stopped");
      expect(
        outcome.finalView.items.filter(
          (item) => item.kind === "tool" && toolPresentationOutcome(item) === "stopped",
        ),
      ).toEqual([prevented]);
      expect(renderFrame(outcome.finalView)).not.toContain("execution status is unknown");
      expect(renderFrame(outcome.finalView)).toContain(`redrive settled after ${name}`);

      const file = readSession(store.id, e);
      const statuses = file.events
        .filter((event) => event.type === "run_status")
        .map((event) => event.reason);
      expect(statuses).toEqual(["aborted", "model-stop"]);
      expect(
        file.events.some(
          (event) => event.type === "tool_result" && event.toolCallId === "call_1_0",
        ),
      ).toBe(false);
      const rebuilt = rebuild(file);
      expect(rebuilt.pendingSteering).toEqual([]);
      expect(rebuilt.messages).toContainEqual({ role: "user", content: instruction });
      store.close();
    },
  );
});

describe("runner — loop-safety opts are forwarded to runAgentLoop (INT-1)", () => {
  it("threads `stop` (maxTurns) so a runaway tool-calling model is bounded", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const executor: ExecutorPort = {
      execute: () => Promise.resolve({ ok: true, output: "ok" }),
    };
    // A model that would keep calling a tool forever; `stop.maxTurns` must bound it.
    const script: SimulatorScriptT = {
      turns: [
        { toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
        { toolCalls: [{ name: "read", args: { path: "b.ts" } }] },
        { toolCalls: [{ name: "read", args: { path: "c.ts" } }] },
      ],
    };
    const outcome = await runSession({
      model: new ScriptedModel(script),
      executor,
      ui,
      store,
      seed,
      env: e,
      stop: { maxTurns: 1 },
    });
    store.close();
    expect(rebuild(readSession(store.id, e)).lastStop).toBe("max-turns"); // the opt reached the loop
    expect(outcome.lastStop).toBe("max-turns"); // runSession returns the terminal reason (INT-2)
  });

  it("threads optional tool, loop, timeout, verification, params, and compactor controls when present", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const tools: readonly ToolSpecT[] = [{ name: "echo", description: "echo input" }];
    const seen: ModelTurnInput[] = [];
    const model: ModelPort = {
      async *stream(input) {
        seen.push({
          messages: [...input.messages],
          ...(input.tools !== undefined ? { tools: input.tools } : {}),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          ...(input.params !== undefined ? { params: input.params } : {}),
        });
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", reason: "stop", usage: { inputTokens: 2, outputTokens: 1 } };
      },
    };
    const compactorCalls: ModelTurnInput["messages"][] = [];

    const outcome = await runSession({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      seed,
      env: e,
      tools,
      loopDetection: { maxToolRepeats: 3 },
      infraTimeout: { toolMs: 1_000 },
      verification: { prompt: "verify the answer" },
      params: { reasoningEffort: "low" },
      compactor: (messages) => {
        compactorCalls.push(messages);
        return messages;
      },
    });
    store.close();

    expect(outcome.lastStop).toBe("model-stop");
    expect(compactorCalls).toHaveLength(2);
    expect(seen).toHaveLength(2); // answer turn + injected verification turn
    expect(seen[0]?.tools).toBe(tools);
    expect(seen[0]?.params).toEqual({ reasoningEffort: "low" });
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[1]?.messages.at(-1)).toMatchObject({ role: "user", content: "verify the answer" });
  });
});

describe("runner — bounded terminal-review correction presentation", () => {
  it("finishes cleanly and preserves the recovered receipt live, headless, and after resume", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const original = "cd . && python3 -m pytest --version 2>&1";
    const correction = "python3 -m pytest --version";
    const finalAnswer = "The atomic check passed; the reviewed composite command was not executed.";
    const executed: string[] = [];
    const outcome = await runSession({
      model: new ScriptedModel({
        turns: [
          { toolCalls: [{ name: "bash", args: { command: original } }] },
          { toolCalls: [{ name: "bash", args: { command: correction } }] },
          { text: finalAnswer },
        ],
      }),
      executor: {
        execute(call): Promise<ToolResultT> {
          const command = call.args["command"];
          if (typeof command !== "string") throw new Error("expected command string");
          executed.push(command);
          return Promise.resolve(
            command === original
              ? recoverableTerminalReviewResult(
                  "warden review required (not executed): POL-003 review: use a simpler command; no live review was opened by this kernel; no approval can be resolved from this result; simplify the request, then rerun",
                )
              : {
                  ok: true,
                  output: JSON.stringify({
                    exitCode: 0,
                    signal: null,
                    stdout: "pytest 9.1.1\n",
                    stderr: "",
                  }),
                },
          );
        },
      },
      ui,
      store,
      seed: [{ role: "user", content: "verify pytest" }],
      env: e,
      tools: [{ name: "bash", description: "run a governed command" }],
    });

    expect(executed).toEqual([original, correction]);
    expect(outcome).toMatchObject({ lastStop: "model-stop" });
    expect(outcome.lastStopCode).toBeUndefined();
    expect(outcome.finalView.turnSummary).toMatchObject({ title: "done", attention: [] });
    expect(outcome.finalView.turnSummary?.receipt).toContain(
      "recovered · bash completed one bounded correction; original reviewed action was not executed",
    );
    const liveFrame = renderFrame(outcome.finalView);
    expect(liveFrame).toContain("recovered");
    expect(liveFrame).toContain("original reviewed action was not executed");
    expect(liveFrame).not.toContain("needs attention");

    const rebuilt = rebuild(readSession(store.id, e));
    const resumedBase = initialView(
      rebuilt.messages,
      {},
      {
        failedToolCallIds: rebuilt.failedToolCallIds,
        failedToolMessageIndexes: rebuilt.failedToolMessageIndexes,
      },
    );
    const resumedSummary = buildTurnSummary(resumedBase);
    if (resumedSummary === undefined) throw new Error("expected resumed recovery summary");
    const resumedFrame = renderFrame({ ...resumedBase, turnSummary: resumedSummary });
    expect(rebuilt).toMatchObject({ finished: true, lastStop: "model-stop" });
    expect(resumedSummary).toMatchObject({ title: "done", attention: [] });
    expect(resumedFrame).toContain("recovered");
    expect(resumedFrame).not.toContain("needs attention");
    expect(resumedFrame).not.toContain(String.fromCharCode(27));
    store.close();
  });
});

describe("runner — purposeful tool liveness", () => {
  it("uses controller execution start, output, timeout, and an injected monotonic clock", async () => {
    vi.useFakeTimers();
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new LivenessQueueUI();
    const release = deferred<ToolResultT>();
    let onOutput: ((chunk: string) => void) | undefined;
    let nowMs = 100;
    const executor: ExecutorPort = {
      execute(_call, options) {
        onOutput = options?.onOutput;
        return release.promise;
      },
    };
    const script: SimulatorScriptT = {
      turns: [{ toolCalls: [{ name: "bash", args: { command: "pnpm test" } }] }, { text: "done" }],
    };

    try {
      const done = runSession({
        model: new ScriptedModel(script),
        executor,
        ui,
        store,
        seed,
        env: e,
        infraTimeout: { toolMs: 10_000 },
        presentationNow: () => nowMs,
        view: { density: "verbose" },
      });
      await ui.awaitRender((v) =>
        v.items.some((item) => item.kind === "tool" && item.liveness?.elapsedMs === 0),
      );
      const committed = ui.view().items[0];
      const subTwoSecondRenderCount = ui.renders.length;

      nowMs = 1_999;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ui.view().currentTurn).toMatchObject({ elapsedMs: 0, quietMs: 0 });
      expect(ui.renders).toHaveLength(subTwoSecondRenderCount);
      expect(renderFrame(ui.view())).not.toContain("1s");

      nowMs = 2_501;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ui.view().items[0]).toBe(committed);
      expect(renderFrame(ui.view())).toContain("working · checking bash execution · 2s");
      expect(renderFrame(ui.view())).toContain("limit · timeout 10s");
      expect(renderFrame(ui.view())).not.toContain("%");
      expect(JSON.stringify(readSession(store.id, e))).not.toMatch(
        /liveness|elapsedMs|quietMs|timeout 10s/,
      );

      const beforeRollback = ui.renders.length;
      nowMs = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ui.renders).toHaveLength(beforeRollback);
      expect(ui.view().currentTurn).toMatchObject({ elapsedMs: 2_000, quietMs: 2_000 });

      nowMs = 2_501;
      onOutput?.("compiling package");
      await ui.awaitRender((v) =>
        v.items.some((item) => item.kind === "tool" && item.liveOutput === "compiling package"),
      );
      nowMs = 5_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(renderFrame(ui.view())).toContain("last · compiling package · quiet 2s");

      release.resolve({ ok: true, output: "41 passed" });
      const outcome = await done;
      expect(
        outcome.finalView.items.some((item) => item.kind === "tool" && "liveness" in item),
      ).toBe(false);
      expect(outcome.finalView.currentTurn).toBeUndefined();
      const livenessTransitions = ui.renders
        .map((v) => v.items.some((item) => item.kind === "tool" && item.liveness !== undefined))
        .filter((state, index, states) => index === 0 || state !== states[index - 1]);
      expect(livenessTransitions).toEqual([false, true, false]);
      const settledRenderCount = ui.renders.length;
      nowMs = 120_000;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ui.renders).toHaveLength(settledRenderCount);
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it.each([
    { label: "error", result: { ok: false as const, output: "command failed" } },
    { label: "success", result: { ok: true as const, output: "done" } },
  ])("settles $label exactly once without stale dynamic residue", async ({ result }) => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new LivenessQueueUI();
    try {
      const outcome = await runSession({
        model: new ScriptedModel({
          turns: [{ toolCalls: [{ name: "bash", args: { command: "work" } }] }, { text: "done" }],
        }),
        executor: { execute: () => Promise.resolve(result) },
        ui,
        store,
        seed,
        env: e,
        presentationNow: () => 10,
      });
      expect(outcome.finalView.items.some((item) => item.kind === "tool" && item.liveness)).toBe(
        false,
      );
      const transitions = ui.renders
        .map((v) => v.items.some((item) => item.kind === "tool" && item.liveness !== undefined))
        .filter((state, index, states) => index === 0 || state !== states[index - 1]);
      expect(transitions).toEqual([false, true, false]);
    } finally {
      store.close();
    }
  });

  it("attributes liveness to the actually executing occurrence in a serial tool batch", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new LivenessQueueUI();
    const first = deferred<ToolResultT>();
    const second = deferred<ToolResultT>();
    const executor: ExecutorPort = {
      execute(call) {
        return call.name === "read" ? first.promise : second.promise;
      },
    };
    try {
      const done = runSession({
        model: new ScriptedModel({
          turns: [
            {
              toolCalls: [
                { name: "read", args: { path: "a.ts" } },
                { name: "search", args: { query: "needle" } },
              ],
            },
            { text: "done" },
          ],
        }),
        executor,
        ui,
        store,
        seed,
        env: e,
        presentationNow: () => 10,
      });
      await ui.awaitRender(
        (v) =>
          v.currentTurn?.doing === "checking read execution" &&
          v.items.filter((item) => item.kind === "tool" && item.status === "running").length ===
            2 &&
          v.items.some(
            (item) => item.kind === "tool" && item.name === "read" && item.liveness !== undefined,
          ),
      );
      const running = ui
        .view()
        .items.filter((item) => item.kind === "tool" && item.status === "running");
      expect(running).toHaveLength(2);
      expect(running[0]).toHaveProperty("liveness");
      expect(running[1]).not.toHaveProperty("liveness");

      first.resolve({ ok: true, output: "a.ts" });
      await ui.awaitRender((v) => v.currentTurn?.doing === "checking search execution");
      expect(
        ui.view().items.filter((item) => item.kind === "tool" && item.status === "running")[0],
      ).toHaveProperty("liveness");

      second.resolve({ ok: true, output: "found" });
      await done;
    } finally {
      store.close();
    }
  });

  it("clears the dynamic occurrence on the controller's infrastructure timeout", async () => {
    vi.useFakeTimers();
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new LivenessQueueUI();
    let nowMs = 0;
    try {
      const done = runSession({
        model: new ScriptedModel({
          turns: [
            { toolCalls: [{ name: "bash", args: { command: "hang" } }] },
            { text: "recovered" },
          ],
        }),
        executor: { execute: () => new Promise<ToolResultT>(() => undefined) },
        ui,
        store,
        seed,
        env: e,
        infraTimeout: { toolMs: 2_500 },
        presentationNow: () => nowMs,
      });
      await ui.awaitRender((v) =>
        v.items.some((item) => item.kind === "tool" && item.liveness !== undefined),
      );
      nowMs = 3_000;
      await vi.advanceTimersByTimeAsync(3_000);
      const outcome = await done;
      expect(outcome.finalView.items.some((item) => item.kind === "tool" && item.liveness)).toBe(
        false,
      );
      expect(
        outcome.finalView.items.some(
          (item) =>
            item.kind === "tool" && item.status === "error" && item.summary.includes("2500ms"),
        ),
      ).toBe(true);
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("clears the dynamic occurrence when the user cancels the executing tool", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new LivenessQueueUI();
    const executor: ExecutorPort = {
      execute(_call, options) {
        return new Promise((resolve) => {
          options?.signal?.addEventListener(
            "abort",
            () => resolve({ ok: false, output: "cancelled" }),
            { once: true },
          );
        });
      },
    };
    try {
      const done = runSession({
        model: new ScriptedModel({
          turns: [{ toolCalls: [{ name: "bash", args: { command: "work" } }] }],
        }),
        executor,
        ui,
        store,
        seed,
        env: e,
        presentationNow: () => 10,
      });
      await ui.awaitRender((v) =>
        v.items.some((item) => item.kind === "tool" && item.liveness !== undefined),
      );
      ui.push({ kind: "interrupt" });
      const outcome = await done;
      expect(outcome.lastStop).toBe("aborted");
      expect(outcome.finalView.items.some((item) => item.kind === "tool" && item.liveness)).toBe(
        false,
      );
      const transitions = ui.renders
        .map((v) => v.items.some((item) => item.kind === "tool" && item.liveness !== undefined))
        .filter((state, index, states) => index === 0 || state !== states[index - 1]);
      expect(transitions).toEqual([false, true, false]);
    } finally {
      store.close();
    }
  });

  it("contains a timer-driven renderer failure, aborts, and still closes the UI", async () => {
    vi.useFakeTimers();
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new FailingLivenessQueueUI();
    let nowMs = 0;
    const executor: ExecutorPort = {
      execute(_call, options) {
        return new Promise((resolve) => {
          options?.signal?.addEventListener(
            "abort",
            () => resolve({ ok: false, output: "aborted after renderer failure" }),
            { once: true },
          );
        });
      },
    };
    try {
      const done = runSession({
        model: new ScriptedModel({
          turns: [{ toolCalls: [{ name: "bash", args: { command: "work" } }] }],
        }),
        executor,
        ui,
        store,
        seed,
        env: e,
        presentationNow: () => nowMs,
      });
      const rejected = expect(done).rejects.toThrow("dynamic renderer failed");
      await ui.awaitRender((v) =>
        v.items.some((item) => item.kind === "tool" && item.liveness !== undefined),
      );
      nowMs = 2_100;
      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
      expect(ui.closeCalls).toBe(1);
      expect(ui.view().items.some((item) => item.kind === "tool" && item.liveness)).toBe(false);
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });

  it("keeps a non-opting headless-style port timer-free and deterministic", async () => {
    vi.useFakeTimers();
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const release = deferred<ToolResultT>();
    let nowMs = 0;
    try {
      const done = runSession({
        model: new ScriptedModel({
          turns: [
            { toolCalls: [{ name: "bash", args: { command: "sleep 3" } }] },
            { text: "done" },
          ],
        }),
        executor: { execute: () => release.promise },
        ui,
        store,
        seed,
        env: e,
        infraTimeout: { toolMs: 10_000 },
        presentationNow: () => nowMs,
      });
      await ui.awaitRender((v) =>
        v.items.some((item) => item.kind === "tool" && item.status === "running"),
      );
      const renderCount = ui.renders.length;
      nowMs = 5_000;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ui.renders).toHaveLength(renderCount);
      expect(JSON.stringify(ui.view())).not.toContain("liveness");

      release.resolve({ ok: true, output: "done" });
      await done;
    } finally {
      store.close();
      vi.useRealTimers();
    }
  });
});

describe("runner — end-of-run auto-resolution receipts", () => {
  const commandKey = `sha256:${"a".repeat(64)}`;

  it("renders warden auto-resolution session facts in the final Done card", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const executor: ExecutorPort = {
      execute(call: ToolInvocationT): Promise<ToolResultT> {
        appendWardenAutoResolvedEvent(
          { append: (event) => store.append(event) },
          {
            source: "plan-approval",
            planId: "plan_auth_fix",
            resource: { kind: "command-key", value: commandKey },
            reviewId: "command_review_1",
            scope: "once",
            auditSeq: 5,
            verdict: "allow",
            toolCallId: call.id,
            toolName: call.name,
          },
          () => "2026-07-07T00:00:00.000Z",
        );
        return Promise.resolve({ ok: true, output: "make-safe-target-ok" });
      },
    };
    const script: SimulatorScriptT = {
      turns: [{ toolCalls: [{ name: "bash", args: { command: "make test" } }] }, { text: "done" }],
    };

    await runSession({
      model: new ScriptedModel(script),
      executor,
      ui,
      store,
      seed,
      env: e,
    });
    store.close();

    const frame = renderFrame(ui.view());
    expect(frame).toContain("automatic:");
    expect(frame).toContain(
      `Plan Autopilot plan_auth_fix allowed bash via command-key ${commandKey} (review command_review_1, audit #5)`,
    );
    expect(ui.view().turnSummary?.automatic).toEqual([
      `Plan Autopilot plan_auth_fix allowed bash via command-key ${commandKey} (review command_review_1, audit #5)`,
    ]);
  });

  it("does not replay prior-turn auto-resolution facts into a later final card", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    appendWardenAutoResolvedEvent(
      { append: (event) => store.append(event) },
      {
        source: "plan-approval",
        planId: "prior_turn_plan",
        resource: { kind: "command-key", value: commandKey },
        reviewId: "prior_review",
        scope: "once",
        auditSeq: 2,
        verdict: "allow",
        toolCallId: "prior_call",
        toolName: "bash",
      },
      () => "2026-07-07T00:00:00.000Z",
    );
    const ui = new QueueUI();

    await runSession({
      model: new ScriptedModel({ turns: [{ text: "done" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      seed,
      env: e,
    });
    store.close();

    const frame = renderFrame(ui.view());
    expect(frame).not.toContain("automatic:");
    expect(frame).not.toContain("prior_turn_plan");
    expect(ui.view().turnSummary?.automatic).toBeUndefined();
  });
});

describe("runner — mid-run steering (§4.10 e2e, simulator-driven)", () => {
  it.each([
    ["failed", validationManifest, { ok: false, output: "TEST SUMMARY (pnpm test): FAIL" }],
    ["not_run", undefined, { ok: true, output: "must not execute" }],
  ] as const)(
    "keeps a %s goal validation final card in needs-attention state",
    async (_status, lifecycleManifest, validationResult) => {
      const e = env();
      const store = SessionStore.create({ cwd: "/w" }, e);
      const ui = new QueueUI();
      let executions = 0;

      const outcome = await runSession({
        model: new ScriptedModel({ turns: [{ text: "answer before validation" }] }),
        executor: {
          execute: () => {
            executions += 1;
            return Promise.resolve(validationResult);
          },
        },
        ui,
        store,
        seed,
        env: e,
        goal: validationGoal,
        ...(lifecycleManifest !== undefined ? { lifecycleManifest } : {}),
      });

      expect(outcome.finalView.turnSummary?.title).toBe("needs attention");
      expect(outcome.finalView.turnSummary?.receipt?.join("\n")).toContain("goal incomplete");
      expect(renderFrame(outcome.finalView).match(/goal incomplete/gu)).toHaveLength(1);
      expect(outcome.lastGoalFailure).toBe("incomplete");
      if (lifecycleManifest === undefined) expect(executions).toBe(0);
      store.close();
    },
  );

  it("shows a completed goal audit once in the final checked receipt", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const outcome = await runSession({
      model: new ScriptedModel({
        turns: [
          {
            text: "running the required check",
            toolCalls: [{ name: "bash", args: { command: "pnpm test" } }],
          },
          { text: "validated answer" },
        ],
      }),
      executor: {
        execute: () => Promise.resolve({ ok: true, output: "TEST SUMMARY (pnpm test): PASS" }),
      },
      ui,
      store,
      seed,
      env: e,
      goal: validationGoal,
      lifecycleManifest: validationManifest,
    });

    expect(outcome.finalView.turnSummary?.title).toBe("done");
    expect(outcome.finalView.turnSummary?.receipt?.join("\n")).toContain(
      `goal complete · ${validationGoal.objective}`,
    );
    expect(outcome.finalView.turnSummary?.receipt?.join("\n")).toContain("check · pnpm test");
    expect(renderFrame(outcome.finalView).match(/goal complete/gu)).toHaveLength(1);
    const oneShot = renderFrame(outcome.finalView, true, false);
    expect(oneShot.match(/goal complete/gu)).toHaveLength(1);
    expect(oneShot).toContain("verification · standard · passed");
    store.close();
  });

  it("re-drives a follow-up queued while goal validation is running", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const validationStarted = deferred();
    const releaseValidation = deferred<ToolResultT>();
    let validations = 0;
    const done = runSession({
      model: new ScriptedModel({ turns: [{ text: "first answer" }, { text: "follow-up answer" }] }),
      executor: {
        execute(call): Promise<ToolResultT> {
          if (call.name !== "lifecycle.run") {
            return Promise.resolve({ ok: false, output: `unexpected ${call.name}` });
          }
          validations += 1;
          if (validations === 1) {
            validationStarted.resolve();
            return releaseValidation.promise;
          }
          return Promise.resolve({ ok: true, output: "TEST SUMMARY (pnpm test): PASS" });
        },
      },
      ui,
      store,
      seed,
      env: e,
      goal: validationGoal,
      lifecycleManifest: validationManifest,
    });

    await validationStarted.promise;
    expect(ui.renders.at(-1)?.turnSummary).toBeUndefined();
    expect(ui.renders.some((rendered) => rendered.turnSummary?.title === "done")).toBe(false);
    expect(ui.view().currentTurn).toMatchObject({
      doing: "checking goal",
      last: "test.unit",
      next: "validation result or queued follow-up",
    });
    ui.push({ kind: "line", text: "also check the docs" });
    await ui.awaitRender((view) => (view.pendingInputs ?? 0) === 1);
    releaseValidation.resolve({ ok: false, output: "TEST SUMMARY (pnpm test): FAIL" });
    const outcome = await done;

    expect(validations).toBe(2);
    expect(outcome.finalView.pendingInputs ?? 0).toBe(0);
    expect(outcome.finalView.queuedInputs ?? []).toEqual([]);
    expect(outcome.finalView.items).toContainEqual({
      kind: "message",
      role: "user",
      content: "also check the docs",
    });
    expect(outcome.finalView.items).toContainEqual(
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        content: "follow-up answer",
      }),
    );
    expect(rebuild(readSession(store.id, e)).pendingSteering).toEqual([]);
    store.close();
  });

  it("applies input delivered immediately after validation resolves before finalizing", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const validationStarted = deferred();
    const releaseValidation = deferred<ToolResultT>();
    let validations = 0;
    const done = runSession({
      model: new ScriptedModel({ turns: [{ text: "first answer" }, { text: "late answer" }] }),
      executor: {
        execute(call): Promise<ToolResultT> {
          if (call.name !== "lifecycle.run") {
            return Promise.resolve({ ok: false, output: `unexpected ${call.name}` });
          }
          validations += 1;
          if (validations === 1) {
            validationStarted.resolve();
            return releaseValidation.promise;
          }
          return Promise.resolve({ ok: true, output: "TEST SUMMARY (pnpm test): PASS" });
        },
      },
      ui,
      store,
      seed,
      env: e,
      goal: validationGoal,
      lifecycleManifest: validationManifest,
    });

    await validationStarted.promise;
    releaseValidation.resolve({ ok: true, output: "TEST SUMMARY (pnpm test): PASS" });
    queueMicrotask(() => ui.push({ kind: "line", text: "late boundary follow-up" }));
    const outcome = await done;

    expect(validations).toBe(2);
    expect(outcome.finalView.pendingInputs ?? 0).toBe(0);
    expect(outcome.finalView.items).toContainEqual({
      kind: "message",
      role: "user",
      content: "late boundary follow-up",
    });
    expect(outcome.finalView.items).toContainEqual(
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        content: "late answer",
      }),
    );
    expect(
      ui.renders
        .filter((rendered) =>
          (rendered.queuedInputs ?? []).some((input) => input.content.includes("late boundary")),
        )
        .some((rendered) => rendered.turnSummary !== undefined),
    ).toBe(false);
    store.close();
  });

  it("names the failed lifecycle action in the needs-attention receipt", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const outcome = await runSession({
      model: new ScriptedModel({ turns: [{ text: "answer before check" }] }),
      executor: {
        execute: () => Promise.resolve({ ok: false, output: "unit check failed" }),
      },
      ui,
      store,
      seed,
      env: e,
      goal: validationGoal,
      lifecycleManifest: validationManifest,
    });

    const frame = renderFrame(outcome.finalView);
    expect(outcome.finalView.turnSummary?.title).toBe("needs attention");
    expect(frame).toContain("verification · standard · failed");
    expect(frame).toContain("next · test.unit: fix the validation check; rerun /goal");
    store.close();
  });

  it.each([
    ["review", "review", "next · test.unit: approve live, or choose a non-reviewing check"],
    ["blocked", "blocked", "next · test.unit: correct the policy boundary or check; rerun /goal"],
    ["stopped", "stopped", "next · test.unit: inspect audit before rerunning /goal"],
    ["execution failure", undefined, "next · test.unit: fix the validation check; rerun /goal"],
  ] as const)(
    "gives exact recovery guidance for a %s goal validation result",
    async (_label, outcome, expected) => {
      const e = env();
      const store = SessionStore.create({ cwd: "/w" }, e);
      const ui = new QueueUI();
      const execute = (): Promise<ToolResultT> => {
        const result = { ok: false, output: "validation did not complete" } as const;
        return Promise.resolve(
          outcome === undefined
            ? result
            : markToolPresentationOutcome(
                result,
                outcome as Exclude<ToolPresentationOutcome, "ok">,
              ),
        );
      };

      const completed = await runSession({
        model: new ScriptedModel({ turns: [{ text: "answer before check" }] }),
        executor: { execute },
        ui,
        store,
        seed,
        env: e,
        goal: validationGoal,
        lifecycleManifest: validationManifest,
      });

      expect(completed.finalView.turnSummary?.title).toBe("needs attention");
      expect(completed.finalView.turnSummary?.receipt?.join("\n")).toContain(expected);
      store.close();
    },
  );

  it("renders a late interrupt that arrives while goal validation is running", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const validationStarted = deferred();
    const validationStopped = deferred<ToolResultT>();
    const done = runSession({
      model: new ScriptedModel({ turns: [{ text: "answer before validation" }] }),
      executor: {
        execute(_call, options): Promise<ToolResultT> {
          validationStarted.resolve();
          options?.signal?.addEventListener(
            "abort",
            () => validationStopped.resolve({ ok: false, output: "validation interrupted" }),
            { once: true },
          );
          return validationStopped.promise;
        },
      },
      ui,
      store,
      seed,
      env: e,
      goal: validationGoal,
      lifecycleManifest: validationManifest,
    });

    await validationStarted.promise;
    ui.push({ kind: "interrupt" });
    const outcome = await done;

    expect(outcome.lastStop).toBe("aborted");
    expect(
      outcome.finalView.items.some(
        (item) =>
          item.kind === "message" && item.role === "system" && item.content.includes("interrupted"),
      ),
    ).toBe(true);
    expect(outcome.finalView.turnSummary?.title).not.toBe("done");
    expect(outcome.finalView.turnSummary?.receipt?.join("\n")).toContain("goal incomplete");
    expect(outcome.finalView.turnSummary?.receipt?.join("\n")).toContain(
      "verification · standard · not run",
    );
    expect(
      outcome.finalView.turnSummary?.receipt?.filter((line) =>
        line.includes("verification · standard · not run"),
      ),
    ).toHaveLength(1);
    expect(outcome.finalView.turnSummary?.receipt?.join("\n")).toContain(
      "lifecycle manifest validationTiers",
    );
    const events = readSession(store.id, e).events;
    const runStatuses = events.filter((event) => event.type === "run_status");
    expect(runStatuses).toHaveLength(1);
    expect(runStatuses[0]).toMatchObject({ reason: "model-stop" });
    expect(events.filter((event) => event.type === "goal_failed")).toEqual([
      expect.objectContaining({ reason: "aborted", goalId: validationGoal.id }),
    ]);
    const resumed = rebuild(readSession(store.id, e));
    expect(resumed.lastStop).toBe("aborted");
    expect(resumed.finished).toBe(false);
    expect(resumed.usage).toEqual(
      runStatuses[0]?.type === "run_status" ? runStatuses[0].usage : {},
    );
    const audit = events.find((event) => event.type === "goal_audit");
    expect(audit?.type === "goal_audit" && audit.audit.validation).toEqual({
      tier: "standard",
      status: "not_run",
    });
    expect(events.some((event) => event.type === "goal_completed")).toBe(false);
    store.close();
  });

  it("queued: a comment during a running tool shows the indicator, then is applied after it completes", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const readStarted = deferred();
    const releaseRead = deferred();
    const executor: ExecutorPort = {
      execute(call: ToolInvocationT): Promise<ToolResultT> {
        if (call.name === "read") {
          readStarted.resolve();
          return releaseRead.promise.then(() => ({ ok: true, output: "file contents" }));
        }
        return Promise.resolve({ ok: false, output: `unexpected tool ${call.name}` });
      },
    };
    const script: SimulatorScriptT = {
      turns: [
        {
          text: "I'll inspect the file first.",
          toolCalls: [{ name: "read", args: { path: "a.ts" } }],
        },
        { text: "noted — focusing on a.ts" },
      ],
    };

    const done = runSession({
      model: new ScriptedModel(script),
      executor,
      ui,
      store,
      seed,
      env: e,
    });

    await readStarted.promise;
    ui.push({ kind: "line", text: "focus on a.ts" });
    // the indicator appears (recorded as pending) before the tool completes
    await ui.awaitRender((v) => (v.pendingInputs ?? 0) >= 1);
    const queuedFrame = renderFrame(ui.view());
    expect(queuedFrame).toContain("queued next · focus on a.ts");
    expect(queuedFrame).not.toContain("input:1 queued");
    expect(queuedFrame).toContain("focus on a.ts");
    releaseRead.resolve();
    await done;
    store.close();

    const frame = renderFrame(ui.view());
    expect(frame).toContain("you  focus on a.ts"); // the steering injected as a user message
    expect(frame).toContain("noted — focusing on a.ts"); // the re-driven turn responded to it
    expect(frame).not.toContain("queued next"); // the pending preview cleared after application
    expect(
      ui.renders.filter((view) => (view.pendingInputs ?? 0) > 0 && view.turnSummary !== undefined),
    ).toEqual([]); // queued input cannot coexist with a final receipt that Ink may commit to scrollback

    const r = rebuild(readSession(store.id, e));
    expect(r.pendingSteering).toEqual([]); // applied, not still pending
    expect(r.messages).toContainEqual({ role: "user", content: "focus on a.ts" });
    expect(r.finished).toBe(true);
  });

  it("settles a queued edit occurrence without rendering or invoking its presentation resolver", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const editStarted = deferred();
    const releaseEdit = deferred();
    let resolverCalls = 0;
    const executor: ExecutorPort = {
      execute(call: ToolInvocationT): Promise<ToolResultT> {
        if (call.name !== "edit") {
          return Promise.resolve({ ok: false, output: `unexpected tool ${call.name}` });
        }
        editStarted.resolve();
        return releaseEdit.promise.then(() => {
          const result = { ok: true as const, output: "edited a.ts" };
          associateMutationPresentationResolver(result, async () => {
            resolverCalls += 1;
            return { status: "unavailable", reason: "capture-unavailable" };
          });
          return result;
        });
      },
    };
    const script: SimulatorScriptT = {
      turns: [
        {
          toolCalls: [
            {
              name: "edit",
              args: { path: "a.ts", oldString: "before", newString: "after" },
            },
          ],
        },
        { text: "queued correction handled" },
      ],
    };

    const done = runSession({
      model: new ScriptedModel(script),
      executor,
      ui,
      store,
      seed,
      env: e,
    });
    await editStarted.promise;
    ui.push({ kind: "line", text: "change the follow-up" });
    await ui.awaitRender((view) => (view.pendingInputs ?? 0) === 1);
    releaseEdit.resolve();
    await done;
    store.close();

    expect(resolverCalls).toBe(0);
    expect(
      ui.renders.some((view) =>
        view.items.some(
          (item) => item.kind === "tool" && item.mutationPresentation?.status === "pending",
        ),
      ),
    ).toBe(false);
  });

  it("settles an urgently steered edit before its first presentation render or resolver call", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const editStarted = deferred();
    const releaseEdit = deferred();
    let resolverCalls = 0;
    let executions = 0;
    const executor: ExecutorPort = {
      execute(call: ToolInvocationT): Promise<ToolResultT> {
        executions += 1;
        if (call.name !== "edit") {
          return Promise.resolve({ ok: false, output: `unexpected tool ${call.name}` });
        }
        editStarted.resolve();
        return releaseEdit.promise.then(() => {
          const result = { ok: true as const, output: "edited a.ts" };
          associateMutationPresentationResolver(result, async () => {
            resolverCalls += 1;
            return { status: "unavailable", reason: "capture-unavailable" };
          });
          return result;
        });
      },
    };
    const script: SimulatorScriptT = {
      turns: [
        {
          toolCalls: [
            {
              name: "edit",
              args: { path: "a.ts", oldString: "before", newString: "after" },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "write",
              args: { path: "b.ts", content: "must not execute" },
            },
          ],
        },
        { text: "urgent correction handled" },
      ],
    };

    const done = runSession({
      model: new ScriptedModel(script),
      executor,
      ui,
      store,
      seed,
      env: e,
    });
    await editStarted.promise;
    ui.push({ kind: "command", name: "/now", args: "change the follow-up" });
    await ui.awaitRender((view) => (view.pendingInputs ?? 0) === 1);
    releaseEdit.resolve();
    await done;
    store.close();

    expect(executions).toBe(1);
    expect(resolverCalls).toBe(0);
    expect(
      ui.renders.some((view) =>
        view.items.some(
          (item) => item.kind === "tool" && item.mutationPresentation?.status === "pending",
        ),
      ),
    ).toBe(false);
    expect(renderFrame(ui.view())).toContain("urgent correction handled");
  });

  it("ends an in-flight presentation occurrence promptly on queued steering and drops its late result", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const resolverStarted = deferred();
    const releaseResolver = deferred();
    let occurrenceSignal: AbortSignal | undefined;
    const executor: ExecutorPort = {
      execute(): Promise<ToolResultT> {
        const result = { ok: true as const, output: "edited a.ts" };
        associateMutationPresentationResolver(result, async (signal) => {
          occurrenceSignal = signal;
          resolverStarted.resolve();
          await releaseResolver.promise;
          return { status: "unavailable", reason: "capture-unavailable" };
        });
        return Promise.resolve(result);
      },
    };
    const script: SimulatorScriptT = {
      turns: [
        {
          toolCalls: [
            {
              name: "edit",
              args: { path: "a.ts", oldString: "before", newString: "after" },
            },
          ],
        },
        { text: "queued correction handled" },
      ],
    };

    const done = runSession({
      model: new ScriptedModel(script),
      executor,
      ui,
      store,
      seed,
      env: e,
    });
    await resolverStarted.promise;
    await ui.awaitRender((view) =>
      view.items.some(
        (item) => item.kind === "tool" && item.mutationPresentation?.status === "pending",
      ),
    );
    ui.push({ kind: "line", text: "change the follow-up" });
    let endedBeforeRelease = false;
    try {
      await vi.waitFor(
        () => {
          const edit = ui.view().items.find((item) => item.kind === "tool" && item.name === "edit");
          expect(edit?.kind === "tool" ? edit.mutationPresentation : undefined).toEqual({
            status: "unavailable",
            reason: "occurrence-ended",
          });
        },
        { timeout: 250, interval: 1 },
      );
      endedBeforeRelease = true;
    } finally {
      releaseResolver.resolve();
      await done;
      store.close();
    }

    expect(endedBeforeRelease).toBe(true);
    expect(occurrenceSignal?.aborted).toBe(true);
    const edit = ui.view().items.find((item) => item.kind === "tool" && item.name === "edit");
    expect(edit?.kind === "tool" ? edit.mutationPresentation : undefined).toEqual({
      status: "unavailable",
      reason: "occurrence-ended",
    });
    expect(renderFrame(ui.view())).toContain("queued correction handled");
  });

  it("keeps late presentation settlement isolated when a provider id is reused after steering", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const firstResolverStarted = deferred();
    const releaseFirstResolver = deferred();
    let executions = 0;
    const executor: ExecutorPort = {
      execute(): Promise<ToolResultT> {
        executions += 1;
        const result = { ok: true as const, output: `edit occurrence ${String(executions)}` };
        if (executions === 1) {
          associateMutationPresentationResolver(result, async () => {
            firstResolverStarted.resolve();
            await releaseFirstResolver.promise;
            return { status: "unavailable", reason: "capture-unavailable" };
          });
        } else {
          associateMutationPresentationResolver(result, async () => ({
            status: "unavailable",
            reason: "redaction-failed",
          }));
        }
        return Promise.resolve(result);
      },
    };
    let modelTurn = 0;
    const model: ModelPort = {
      async *stream() {
        const current = modelTurn;
        modelTurn += 1;
        if (current < 2) {
          yield {
            type: "tool-call" as const,
            id: "provider-reused-id",
            name: "edit",
            args: { path: "a.ts", oldString: "before", newString: `after-${String(current)}` },
          };
          yield {
            type: "finish" as const,
            reason: "tool-calls" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
          return;
        }
        yield { type: "text-delta" as const, text: "second occurrence settled" };
        yield {
          type: "finish" as const,
          reason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };

    const done = runSession({ model, executor, ui, store, seed, env: e });
    await firstResolverStarted.promise;
    ui.push({ kind: "line", text: "retry with the correction" });
    await vi.waitFor(() => expect(executions).toBe(2));
    await done;

    const beforeLate = ui
      .view()
      .items.filter((item) => item.kind === "tool" && item.id === "provider-reused-id")
      .map((item) => (item.kind === "tool" ? item.mutationPresentation : undefined));
    expect(beforeLate).toEqual([
      { status: "unavailable", reason: "occurrence-ended" },
      { status: "unavailable", reason: "redaction-failed" },
    ]);

    releaseFirstResolver.resolve();
    await Promise.resolve();
    const afterLate = ui
      .view()
      .items.filter((item) => item.kind === "tool" && item.id === "provider-reused-id")
      .map((item) => (item.kind === "tool" ? item.mutationPresentation : undefined));
    expect(afterLate).toEqual(beforeLate);
    expect(renderFrame(ui.view())).toContain("second occurrence settled");
    store.close();
  });

  it("ends an in-flight presentation occurrence on interrupt without waiting for its late result", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const resolverStarted = deferred();
    const releaseResolver = deferred();
    let occurrenceSignal: AbortSignal | undefined;
    const executor: ExecutorPort = {
      execute(): Promise<ToolResultT> {
        const result = { ok: true as const, output: "edited a.ts" };
        associateMutationPresentationResolver(result, async (signal) => {
          occurrenceSignal = signal;
          resolverStarted.resolve();
          await releaseResolver.promise;
          return { status: "unavailable", reason: "capture-budget" };
        });
        return Promise.resolve(result);
      },
    };
    const script: SimulatorScriptT = {
      turns: [
        {
          toolCalls: [
            {
              name: "edit",
              args: { path: "a.ts", oldString: "before", newString: "after" },
            },
          ],
        },
        { text: "SHOULD NOT RUN" },
      ],
    };

    const done = runSession({
      model: new ScriptedModel(script),
      executor,
      ui,
      store,
      seed,
      env: e,
    });
    await resolverStarted.promise;
    ui.push({ kind: "interrupt" });
    let endedBeforeRelease = false;
    try {
      await vi.waitFor(
        () => {
          const edit = ui.view().items.find((item) => item.kind === "tool" && item.name === "edit");
          expect(edit?.kind === "tool" ? edit.mutationPresentation : undefined).toEqual({
            status: "unavailable",
            reason: "occurrence-ended",
          });
        },
        { timeout: 250, interval: 1 },
      );
      endedBeforeRelease = true;
    } finally {
      releaseResolver.resolve();
    }
    const outcome = await done;
    store.close();

    expect(endedBeforeRelease).toBe(true);
    expect(occurrenceSignal?.aborted).toBe(true);
    expect(outcome.lastStop).toBe("aborted");
    expect(renderFrame(ui.view())).not.toContain("SHOULD NOT RUN");
    const edit = ui.view().items.find((item) => item.kind === "tool" && item.name === "edit");
    expect(edit?.kind === "tool" ? edit.mutationPresentation : undefined).toEqual({
      status: "unavailable",
      reason: "occurrence-ended",
    });
  });

  it("classifies a live presentation transport failure without changing the durable tool result", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const executor: ExecutorPort = {
      execute(): Promise<ToolResultT> {
        const result = { ok: true as const, output: "edited a.ts" };
        associateMutationPresentationResolver(result, async () => {
          throw new Error("warden transport closed");
        });
        return Promise.resolve(result);
      },
    };
    const script: SimulatorScriptT = {
      turns: [
        {
          toolCalls: [
            {
              name: "edit",
              args: { path: "a.ts", oldString: "before", newString: "after" },
            },
          ],
        },
        { text: "ordinary turn continued" },
      ],
    };

    await runSession({ model: new ScriptedModel(script), executor, ui, store, seed, env: e });
    const edit = ui.view().items.find((item) => item.kind === "tool" && item.name === "edit");
    expect(edit?.kind === "tool" ? edit.mutationPresentation : undefined).toEqual({
      status: "unavailable",
      reason: "transport-failed",
    });
    const persisted = readSession(store.id, e).events.filter(
      (event) => event.type === "tool_result" && event.name === "edit",
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ output: "edited a.ts" });
    expect(renderFrame(ui.view())).toContain("ordinary turn continued");
    store.close();
  });

  it("ends presentation promptly, closes the UI, and preserves an input-stream failure", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new FailingInputUI();
    const resolverStarted = deferred();
    const releaseResolver = deferred();
    let occurrenceSignal: AbortSignal | undefined;
    const executor: ExecutorPort = {
      execute(): Promise<ToolResultT> {
        const result = { ok: true as const, output: "edited a.ts" };
        associateMutationPresentationResolver(result, async (signal) => {
          occurrenceSignal = signal;
          resolverStarted.resolve();
          await releaseResolver.promise;
          return { status: "unavailable", reason: "capture-unavailable" };
        });
        return Promise.resolve(result);
      },
    };
    const script: SimulatorScriptT = {
      turns: [
        {
          toolCalls: [
            {
              name: "edit",
              args: { path: "a.ts", oldString: "before", newString: "after" },
            },
          ],
        },
        { text: "SHOULD NOT RUN" },
      ],
    };

    const done = runSession({
      model: new ScriptedModel(script),
      executor,
      ui,
      store,
      seed,
      env: e,
    });
    const observed = done.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    let settlement: Awaited<typeof observed> | undefined;
    void observed.then((value) => {
      settlement = value;
    });
    await resolverStarted.promise;
    ui.failInputs();

    let failedBeforeRelease = false;
    try {
      await vi.waitFor(
        () => {
          expect(settlement?.status).toBe("rejected");
        },
        { timeout: 250, interval: 1 },
      );
      failedBeforeRelease = true;
    } finally {
      releaseResolver.resolve();
      await observed;
      store.close();
    }

    expect(failedBeforeRelease).toBe(true);
    expect(occurrenceSignal?.aborted).toBe(true);
    expect(settlement?.status).toBe("rejected");
    if (settlement?.status !== "rejected") throw new Error("expected input failure");
    expect(settlement.error).toBeInstanceOf(Error);
    expect((settlement.error as Error).message).toContain("input channel failed");
    expect(ui.didClose).toBe(true);
    expect(renderFrame(ui.view())).not.toContain("SHOULD NOT RUN");
  });

  it("interrupt: Esc/Ctrl-C starts no new actions and leaves a resumable session", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const slowStarted = deferred();
    const executor: ExecutorPort = {
      execute(call: ToolInvocationT, opts?: { signal?: AbortSignal }): Promise<ToolResultT> {
        if (call.name === "slow") {
          slowStarted.resolve();
          return new Promise<ToolResultT>((resolve) => {
            const sig = opts?.signal;
            const finish = (): void => resolve({ ok: true, output: "stopped" });
            if (sig?.aborted === true) finish();
            else sig?.addEventListener("abort", finish, { once: true });
          });
        }
        return Promise.resolve({ ok: false, output: "unexpected" });
      },
    };
    const script: SimulatorScriptT = {
      turns: [
        { text: "I'll wait for the tool.", toolCalls: [{ name: "slow", args: {} }] },
        { text: "SHOULD NOT APPEAR" },
      ],
    };

    const done = runSession({
      model: new ScriptedModel(script),
      executor,
      ui,
      store,
      seed,
      env: e,
    });

    await slowStarted.promise;
    ui.push({ kind: "interrupt" });
    await done;
    store.close();

    const frame = renderFrame(ui.view());
    expect(frame).not.toContain("SHOULD NOT APPEAR"); // no new turn started
    expect(frame).toMatch(/interrupt/i); // calm, one-line note
    expect(frame.match(/interrupted/g)).toHaveLength(1);
    expect(frame).not.toMatch(/\bat\b.*\(/); // no stack trace
    expect(ui.view().turnSummary).toBeUndefined(); // an aborted turn is never presented as done
    expect(ui.renders.some((view) => view.turnSummary !== undefined)).toBe(false);

    const r = rebuild(readSession(store.id, e));
    expect(r.finished).toBe(false);
    expect(r.lastStop).toBe("aborted");
    expect(r.messages.length).toBeGreaterThan(0); // resumable
  });

  it("clears an active controller panel before the same Escape interrupt aborts the turn", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const slowStarted = deferred();
    const executor: ExecutorPort = {
      execute(_call, opts): Promise<ToolResultT> {
        slowStarted.resolve();
        return new Promise((resolve) => {
          const finish = (): void => resolve({ ok: false, output: "stopped" });
          if (opts?.signal?.aborted === true) finish();
          else opts?.signal?.addEventListener("abort", finish, { once: true });
        });
      },
    };
    const done = runSession({
      model: new ScriptedModel({
        turns: [{ toolCalls: [{ name: "slow", args: {} }] }, { text: "SHOULD NOT APPEAR" }],
      }),
      executor,
      ui,
      store,
      seed,
      env: e,
    });

    await slowStarted.promise;
    ui.push({ kind: "command", name: "/context" });
    await ui.awaitRender((v) => v.overlay?.kind === "panel");

    // The real InputBar performs these synchronously for one Escape: local dismissal first, then
    // exactly one interrupt. The runner must therefore see no overlay when the interrupt arrives.
    ui.dismissOverlay();
    expect(ui.view().overlay).toBeUndefined();
    ui.push({ kind: "interrupt" });

    await expect(done).resolves.toMatchObject({ lastStop: "aborted" });
    expect(renderFrame(ui.view())).not.toContain("SHOULD NOT APPEAR");
    store.close();
  });

  it("restores the prior overlay owner when UI close fails during session settlement", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new FailingCloseUI();
    let priorDismissals = 0;
    const disconnectPrior = ui[OVERLAY_DISMISS](() => {
      priorDismissals += 1;
    });

    try {
      await expect(
        runSession({
          model: new ScriptedModel({ turns: [{ text: "done" }] }),
          executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
          ui,
          store,
          seed,
          env: e,
        }),
      ).rejects.toThrow("UI close failed");

      ui.dismissOverlay();
      expect(priorDismissals).toBe(1);
    } finally {
      disconnectPrior();
      store.close();
    }
  });

  it.each([
    {
      name: "queued comment",
      input: { kind: "line", text: "use the safer approach" } as const,
      content: "use the safer approach",
      steeringClass: "queued",
    },
    {
      name: "urgent correction",
      input: { kind: "command", name: "/now", args: "do not edit auth.ts" } as const,
      content: "do not edit auth.ts",
      steeringClass: "urgent",
    },
  ])(
    "interrupts without dispatching a pending $name",
    async ({ input, content, steeringClass }) => {
      const e = env();
      const store = SessionStore.create({ cwd: "/w" }, e);
      const ui = new QueueUI();
      const slowStarted = deferred();
      const executor: ExecutorPort = {
        execute(_call, opts): Promise<ToolResultT> {
          slowStarted.resolve();
          return new Promise((resolve) => {
            const finish = (): void => resolve({ ok: false, output: "stopped for correction" });
            if (opts?.signal?.aborted === true) finish();
            else opts?.signal?.addEventListener("abort", finish, { once: true });
          });
        },
      };
      const done = runSession({
        model: new ScriptedModel({
          turns: [
            { toolCalls: [{ name: "slow", args: {} }] },
            { text: "queued correction handled" },
          ],
        }),
        executor,
        ui,
        store,
        seed,
        env: e,
      });
      await slowStarted.promise;
      ui.push(input);
      await ui.awaitRender((view) => (view.pendingInputs ?? 0) === 1);
      ui.push({ kind: "interrupt" });
      const outcome = await done;
      store.close();

      expect(outcome.lastStop).toBe("aborted");
      expect(renderFrame(ui.view())).toContain("interrupted");
      expect(renderFrame(ui.view())).not.toContain("Esc interrupts now");
      expect(renderFrame(ui.view())).not.toContain("queued correction handled");
      const rebuilt = rebuild(readSession(store.id, e));
      expect(rebuilt.pendingSteering).toMatchObject([
        { class: steeringClass, content, insertedAt: null },
      ]);
      expect(rebuilt.messages).not.toContainEqual({ role: "user", content });
      expect(rebuilt.lastStop).toBe("aborted");
    },
  );

  it("urgent: /now is applied before the next mutating action (the edit never executes)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const readStarted = deferred();
    const releaseRead = deferred();
    let editCalled = false;
    const executor: ExecutorPort = {
      execute(call: ToolInvocationT): Promise<ToolResultT> {
        if (call.name === "read") {
          readStarted.resolve();
          return releaseRead.promise.then(() => ({ ok: true, output: "read out" }));
        }
        if (call.name === "edit") {
          editCalled = true;
          return Promise.resolve({ ok: true, output: "edited" });
        }
        return Promise.resolve({ ok: false, output: "unexpected" });
      },
    };
    const script: SimulatorScriptT = {
      turns: [
        { toolCalls: [{ name: "read", args: {} }] }, // non-mutating — input arrives here
        {
          text: "I'll edit f.ts",
          toolCalls: [{ name: "edit", args: { path: "f.ts", oldString: "a", newString: "b" } }],
        },
        { text: "holding off on the edit per your note" },
      ],
    };

    const done = runSession({
      model: new ScriptedModel(script),
      executor,
      ui,
      store,
      seed,
      env: e,
    });

    await readStarted.promise;
    ui.push({ kind: "command", name: "/now", args: "do not edit f.ts" });
    await ui.awaitRender((v) => (v.pendingInputs ?? 0) >= 1);
    releaseRead.resolve();
    await done;
    store.close();

    expect(editCalled).toBe(false); // the mutating action was prevented
    const frame = renderFrame(ui.view());
    expect(frame).toContain("you  do not edit f.ts"); // urgent steering injected
    expect(frame).toContain("holding off on the edit per your note");

    const r = rebuild(readSession(store.id, e));
    expect(r.finished).toBe(true);
    expect(r.pendingSteering).toEqual([]);
  });

  it("urgent: /now is applied before a governed process starts", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const readStarted = deferred();
    const releaseRead = deferred();
    let processCalled = false;
    const executor: ExecutorPort = {
      execute(call: ToolInvocationT): Promise<ToolResultT> {
        if (call.name === "read") {
          readStarted.resolve();
          return releaseRead.promise.then(() => ({ ok: true, output: "read out" }));
        }
        if (call.name === "process.run") {
          processCalled = true;
          return Promise.resolve({ ok: true, output: "should not run" });
        }
        return Promise.resolve({ ok: false, output: "unexpected" });
      },
    };

    const done = runSession({
      model: new ScriptedModel({
        turns: [
          { toolCalls: [{ name: "read", args: {} }] },
          {
            text: "I'll run the check directly",
            toolCalls: [{ name: "process.run", args: { argv: ["pnpm", "test"] } }],
          },
          { text: "holding off on the command per your note" },
        ],
      }),
      executor,
      ui,
      store,
      seed,
      env: e,
    });

    await readStarted.promise;
    ui.push({ kind: "command", name: "/now", args: "do not run tests yet" });
    await ui.awaitRender((v) => (v.pendingInputs ?? 0) >= 1);
    releaseRead.resolve();
    await done;
    store.close();

    expect(processCalled).toBe(false);
    const frame = renderFrame(ui.view());
    expect(frame).toContain("you  do not run tests yet");
    expect(frame).toContain("holding off on the command per your note");
  });

  it("keeps urgent steering pending when the controller budget cannot dispatch another turn", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const readStarted = deferred();
    const releaseRead = deferred();
    let modelCalls = 0;
    const model: ModelPort = {
      async *stream() {
        modelCalls += 1;
        yield { type: "tool-call" as const, id: "read-1", name: "read", args: {} };
        yield {
          type: "finish" as const,
          reason: "tool-calls" as const,
          usage: { inputTokens: 9, outputTokens: 1 },
        };
      },
    };
    const executed: string[] = [];
    const done = runSessionWithControlState(
      {
        model,
        executor: {
          execute(call): Promise<ToolResultT> {
            executed.push(call.name);
            readStarted.resolve();
            return releaseRead.promise.then(() => ({ ok: true, output: "read complete" }));
          },
        },
        ui,
        store,
        seed,
        env: e,
        stop: { budget: { maxGrossTokens: 10 } },
        goal: validationGoal,
        lifecycleManifest: validationManifest,
      },
      createAgentLoopControlState(),
    );

    await readStarted.promise;
    ui.push({ kind: "command", name: "/now", args: "do not edit auth.ts" });
    await ui.awaitRender((view) => (view.pendingInputs ?? 0) === 1);
    releaseRead.resolve();
    const outcome = await done;
    store.close();

    expect(modelCalls).toBe(1);
    expect(executed).toEqual(["read"]);
    expect(outcome.lastStop).toBe("budget");
    expect(outcome.finalView).toMatchObject({
      pendingInputs: 1,
      urgentSteering: { state: "pending", content: "do not edit auth.ts" },
    });
    expect(renderFrame(outcome.finalView)).toContain("urgent correction still pending");
    expect(renderFrame(outcome.finalView)).toContain(`keel --resume ${store.id}`);
    expect(renderFrame(outcome.finalView)).not.toContain("Esc interrupts now");

    const rebuilt = rebuild(readSession(store.id, e));
    expect(rebuilt.pendingSteering).toMatchObject([
      { class: "urgent", content: "do not edit auth.ts", insertedAt: null },
    ]);
    expect(rebuilt.messages).not.toContainEqual({ role: "user", content: "do not edit auth.ts" });
  });
});
