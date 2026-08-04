import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import type {
  ModelPort,
  ModelStreamChunkT,
  ModelTurnInput,
  UIPort,
  UserInput,
  ViewModel,
} from "@keel/shared";
import { ScriptedModel } from "@keel/simulator";
import { InputQueue } from "../../cli/input-queue.js";
import { SessionStore, readSession } from "../../session/store.js";
import { rebuild } from "../../session/resume.js";
import { runRepl } from "../repl.js";
import { OVERLAY_DISMISS, OverlayDismissRegistry } from "../overlay-dismiss.js";
import { LOCAL_INPUT_ACTIVITY, LocalInputActivityRegistry } from "../input-activity.js";
import {
  DIFF_VIEWER_CONTROL,
  DiffViewerControlRegistry,
  type DiffViewerOpenResult,
} from "../diff-viewer-control.js";
import type { DiffViewerState } from "../diff-viewer.js";
import { toolPresentationOutcome } from "../../tool-presentation-outcome.js";
import { appendWardenAutoResolvedEvent } from "../../warden/receipt.js";
import { ScopedEgressApprovals } from "../../warden/approval.js";
import { WardenExecutor, type WardenExecuteClient } from "../../warden/executor.js";
import { createInteractiveReviewDecisionController } from "../review-decision.js";
import { Interactive } from "./interactive.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });
const ENTER = "\r";
// A complete Kitty keyboard-protocol Escape event exercises Ink's real parser and `key.escape`
// path without depending on Ink's timer-based disambiguation of a lone ESC byte. Bare ESC remains
// covered by the focused InputBar and Interactive suites.
const ESCAPE = "\u001b[27u";
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const assistantSaid = (v: ViewModel, content: string): boolean =>
  v.items.some((it) => it.kind === "message" && it.role === "assistant" && it.content === content);

/**
 * A `UIPort` backed by the REAL Ink `Interactive` component (via ink-testing-library), so the
 * multi-turn driver is validated against the actual interactive stack — the Ink render tree, the
 * `InputBar`'s raw keypress handling, and the real `InputQueue` handoff across turns — not a headless
 * stub. `stdin.write` simulates typing; `awaitRender` lets the test wait for a turn to finish (the
 * idle prompt) before typing the next, fully deterministically. (A true OS pty — for raw-mode escape
 * sequences like bracketed paste — is a slice-4 concern; this proves the keystone loop end-to-end.)
 */
class InkReplUI implements UIPort {
  readonly queue = new InputQueue();
  latest: ViewModel | undefined;
  #app: ReturnType<typeof render> | undefined;
  #waiters: { pred: (v: ViewModel) => boolean; resolve: () => void }[] = [];
  readonly #overlayDismiss = new OverlayDismissRegistry();
  readonly #localInputActivity = new LocalInputActivityRegistry();
  readonly #diffViewerControl = new DiffViewerControlRegistry();
  #diffViewerState: DiffViewerState | undefined;
  readonly #decorateView: ((view: ViewModel) => ViewModel) | undefined;
  readonly [OVERLAY_DISMISS] = (handler: () => void): (() => void) =>
    this.#overlayDismiss.connect(handler);
  readonly [LOCAL_INPUT_ACTIVITY] = (handler: () => void): (() => void) =>
    this.#localInputActivity.connect(handler);
  readonly [DIFF_VIEWER_CONTROL] = (): DiffViewerOpenResult => this.#diffViewerControl.open();

  constructor(decorateView?: (view: ViewModel) => ViewModel) {
    this.#decorateView = decorateView;
  }

  render(view: ViewModel): void {
    this.latest = view;
    const presented = this.#decorateView?.(view) ?? view;
    const el = (
      <Interactive
        view={presented}
        onAction={(a: UserInput) => this.queue.push(a)}
        onDismissOverlay={() => this.#overlayDismiss.dismiss()}
        onLocalInteraction={() => this.#localInputActivity.notify()}
        connectDiffViewer={(open) => this.#diffViewerControl.connect(open)}
        onDiffViewerState={(state) => {
          this.#diffViewerState = state;
        }}
        {...(this.#diffViewerState === undefined
          ? {}
          : { initialDiffViewerState: this.#diffViewerState })}
      />
    );
    if (this.#app === undefined) this.#app = render(el);
    else this.#app.rerender(el);
    this.#waiters = this.#waiters.filter((w) => {
      if (w.pred(view)) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  get stdin(): NonNullable<ReturnType<typeof render>>["stdin"] {
    if (this.#app === undefined) throw new Error("not rendered yet");
    return this.#app.stdin;
  }

  /** The actual rendered terminal frame (ANSI-stripped by ink-testing-library) — for asserting what
   *  the user really sees through the full Ink tree, not just the ViewModel. */
  lastFrame(): string | undefined {
    return this.#app?.lastFrame();
  }

  output(): string {
    return this.#app?.frames.join("\n") ?? "";
  }

  awaitRender(pred: (v: ViewModel) => boolean): Promise<void> {
    if (this.latest !== undefined && pred(this.latest)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              `timed out waiting for the controller ViewModel; latest=${JSON.stringify({
                awaitingInput: this.latest?.awaitingInput,
                overlay: this.latest?.overlay,
              })}`,
            ),
          ),
        5_000,
      );
      this.#waiters.push({
        pred,
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
      });
    });
  }

  async awaitFrame(pred: (frame: string) => boolean): Promise<void> {
    await vi.waitFor(
      () => {
        const frame = this.lastFrame();
        if (frame === undefined || !pred(frame)) {
          throw new Error(
            `waiting for the real Ink frame to commit; frame=${JSON.stringify(frame)}`,
          );
        }
      },
      { timeout: 5_000, interval: 10 },
    );
  }

  inputs(): AsyncIterable<UserInput> {
    return this.queue;
  }

  close(): Promise<void> {
    this.queue.close();
    this.#app?.unmount();
    return Promise.resolve();
  }
}

describe("runRepl through the REAL Ink stack (Epic 1.23 slice 0 — interactive validation)", () => {
  it("prints an exact session-grant reuse receipt before a later distinct denial", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const reviews = [
      {
        reviewId: "egress_review_1",
        summary: "egress to example.com requires review: curl https://example.com/first",
        allowCommand: "keel approve egress_review_1 --scope once --domain example.com",
      },
      {
        reviewId: "egress_review_2",
        summary: "egress to example.com requires review: curl https://example.com/second",
        allowCommand: "keel approve egress_review_2 --scope once --domain example.com",
      },
      {
        reviewId: "egress_review_3",
        summary: "egress to example.org requires review: curl https://example.org/distinct",
        allowCommand: "keel approve egress_review_3 --scope once --domain example.org",
      },
    ] as const;
    const resolved = [
      {
        verdict: "allow" as const,
        result: { exitCode: 0, signal: null, stdout: "first page\n", stderr: "" },
        auditSeq: 2,
      },
      {
        verdict: "allow" as const,
        result: { exitCode: 0, signal: null, stdout: "second page\n", stderr: "" },
        auditSeq: 4,
      },
      { verdict: "deny" as const, result: "human denied review", auditSeq: 6 },
    ];
    let execution = 0;
    let resolution = 0;
    const client = {
      async call(method: string) {
        if (method === "warden.execute") {
          const review = reviews[execution];
          if (review === undefined) throw new Error("unexpected warden.execute call");
          execution += 1;
          return { verdict: "review", review, auditSeq: execution * 2 - 1 };
        }
        if (method === "warden.resolveReview") {
          const result = resolved[resolution];
          if (result === undefined) throw new Error("unexpected warden.resolveReview call");
          resolution += 1;
          return result;
        }
        throw new Error(`unexpected Warden method: ${method}`);
      },
    } as unknown as WardenExecuteClient;
    const reviewDecisions = createInteractiveReviewDecisionController();
    const executor = new WardenExecutor({
      client,
      sessionId: store.id,
      egressApprovals: new ScopedEgressApprovals(),
      principal: {
        osUser: "tester",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
      onReviewAutoResolved: (event) => appendWardenAutoResolvedEvent(store, event),
      onReviewRequired: reviewDecisions.onReviewRequired,
    });
    const done = runRepl({
      model: new ScriptedModel({
        turns: [
          { toolCalls: [{ name: "bash", args: { command: "curl https://example.com/first" } }] },
          { toolCalls: [{ name: "bash", args: { command: "curl https://example.com/second" } }] },
          { toolCalls: [{ name: "bash", args: { command: "curl https://example.org/distinct" } }] },
          { text: "Equivalent scope reused; distinct scope denied." },
        ],
      }),
      executor,
      ui,
      store,
      env: e,
      reviewDecisions,
    });

    try {
      await ui.awaitRender((view) => view.awaitingInput === true);
      ui.stdin.write("fetch the documentation pages");
      await tick();
      ui.stdin.write(ENTER);
      await ui.awaitRender(
        (view) =>
          view.activeApproval?.state === "pending" &&
          view.activeApproval.detail.includes("example.com"),
      );
      expect(ui.latest?.pendingReviews).toBe(1);
      ui.stdin.write("s");
      await tick();
      ui.stdin.write(ENTER);
      await ui.awaitRender(
        (view) =>
          view.activeApproval?.state === "pending" &&
          view.activeApproval.detail.includes("example.org"),
      );
      expect(ui.latest?.pendingReviews).toBe(1);
      ui.stdin.write("d");
      await tick();
      ui.stdin.write(ENTER);
      await ui.awaitRender(
        (view) =>
          view.awaitingInput === true &&
          assistantSaid(view, "Equivalent scope reused; distinct scope denied."),
      );
      await tick();

      expect(ui.latest?.turnSummary?.automatic).toContain(
        "session grant (until session exit) allowed bash via domain example.com " +
          "(review egress_review_2, audit #4)",
      );
      // Settled approval state canonically removes the optional count; zero is rendered from its
      // absence, matching the reducer's approval-confirmed/denied contract.
      expect(ui.latest?.pendingReviews).toBeUndefined();
      const output = ui.output().replace(/\s+/gu, " ");
      expect(output).toContain("decision sent");
      expect(output).toContain("approval confirmed");
      expect(output).toContain("request denied");
      expect(output).not.toContain("2 review items pending");
      expect(output).toContain(
        "automatic session grant (until session exit) allowed bash via domain example.com " +
          "(review egress_review_2, audit #4)",
      );
    } finally {
      ui.stdin.write("/exit");
      await tick();
      ui.stdin.write(ENTER);
      await done;
      store.close();
    }
  });

  it("drives /diff review through the real InputBar, REPL sidecar, viewer, and back to composer", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI((view) => ({
      ...view,
      items: [
        ...view.items,
        {
          kind: "tool",
          id: "observed-edit",
          name: "edit",
          status: "ok",
          summary: "src/review.ts",
          diff: [
            { kind: "del", text: "const before = 1;", hunkStart: true },
            { kind: "add", text: "const after = 2;" },
          ],
        },
      ],
    }));
    const done = runRepl({
      model: new ScriptedModel({ turns: [] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((view) => view.awaitingInput === true);
    ui.stdin.write("/diff review");
    await tick();
    ui.stdin.write(ENTER);
    await ui.awaitFrame(
      (frame) => frame.includes("reviewing changes") && frame.includes("review.ts"),
    );

    expect(ui.lastFrame() ?? "").toContain("j/k rows · n/p changes · tab files");
    ui.stdin.write("\x1b");
    await ui.awaitFrame((frame) => !frame.includes("reviewing changes") && frame.includes("input"));

    ui.stdin.write("/exit");
    await tick();
    ui.stdin.write(ENTER);
    await done;
    store.close();
  });

  it("opens authoritative unavailable observations instead of falling back to a generic no-diffs notice", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI((view) => ({
      ...view,
      items: [
        ...view.items,
        { kind: "message", role: "user", content: "inspect the generated file" },
        {
          kind: "tool",
          id: "unavailable-edit",
          name: "edit",
          status: "ok",
          summary: "request-only/private/generated.ts",
          mutationPresentation: { status: "unavailable", reason: "capture-budget" },
        },
      ],
      turnSummary: { title: "done", changed: [], checked: [], attention: [] },
    }));
    const done = runRepl({
      model: new ScriptedModel({ turns: [] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((view) => view.awaitingInput === true);
    ui.stdin.write("/diff review");
    await tick();
    ui.stdin.write(ENTER);
    await ui.awaitFrame(
      (frame) =>
        frame.includes("review evidence unavailable") &&
        frame.replace(/\s+/gu, " ").includes("observation exceeded presentation limits"),
    );

    expect(ui.lastFrame() ?? "").toContain("automatic undo unavailable");
    expect(ui.lastFrame() ?? "").not.toContain("No settled diffs available to review");
    ui.stdin.write(ESCAPE);
    await ui.awaitFrame((frame) => !frame.includes("review evidence unavailable"));

    ui.stdin.write("/exit");
    await tick();
    ui.stdin.write(ENTER);
    await done;
    store.close();
  });

  it("keeps the first idle Ctrl-C warning visible in the real Ink frame", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const done = runRepl({
      model: new ScriptedModel({ turns: [] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.stdin.write("\x03");
    await ui.awaitRender((v) =>
      v.items.some(
        (item) => item.kind === "message" && item.content.includes("press Ctrl-C again"),
      ),
    );
    await tick();

    expect(ui.lastFrame() ?? "").toContain("press Ctrl-C again");
    expect(ui.lastFrame() ?? "").toContain("quit armed");
    expect(ui.lastFrame() ?? "").toContain("Ctrl-C again exits");

    ui.stdin.write("\x03");
    await done;
    store.close();
  });

  it("disarms through a real local edit before requiring a fresh two-press exit sequence", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const done = runRepl({
      model: new ScriptedModel({ turns: [] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.stdin.write("y");
    ui.stdin.write("\x03");
    await ui.awaitRender((v) => v.exitArmed === true);
    ui.stdin.write("x");
    await ui.awaitRender((v) => v.exitArmed !== true);
    await ui.awaitFrame((frame) => frame.includes("x") && !frame.includes("quit armed"));

    ui.stdin.write("\x03");
    await ui.awaitRender((v) => v.exitArmed === true);
    expect(ui.lastFrame() ?? "").toContain("quit armed");
    ui.stdin.write("\x03");
    await done;
    store.close();
  });

  it("does not arm exit when local editing follows Ctrl-C in the same input burst", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const done = runRepl({
      model: new ScriptedModel({ turns: [] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.stdin.write("\x03");
    ui.stdin.write("x");
    await ui.awaitFrame((frame) => frame.includes("x"));
    await tick();

    expect(ui.latest?.exitArmed).not.toBe(true);
    expect(ui.lastFrame() ?? "").not.toContain("quit armed");

    ui.stdin.write("\x03");
    await ui.awaitRender((v) => v.exitArmed === true);
    ui.stdin.write("\x03");
    await done;
    store.close();
  });

  it("keeps rapid repeated active Ctrl-C in the active cancellation path, then rearms only at idle", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const started = deferred();
    const releaseSettlement = deferred();
    const model: ModelPort = {
      async *stream(input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
        started.resolve();
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted === true) resolve();
          else input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await releaseSettlement.promise;
        yield {
          type: "finish",
          reason: "stop",
          usage: { inputTokens: 1, outputTokens: 0 },
        };
      },
    };
    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.stdin.write("cancel this turn");
    await tick();
    ui.stdin.write(ENTER);
    await started.promise;
    ui.stdin.write("\x03");
    ui.stdin.write("\x03");
    await ui.awaitFrame((frame) => frame.includes("stopping"));
    releaseSettlement.resolve();

    await ui.awaitRender(
      (v) =>
        v.awaitingInput === true &&
        v.items.some((item) => item.kind === "message" && item.content.includes("interrupted")),
    );
    expect(ui.latest?.exitArmed).not.toBe(true);
    expect(ui.lastFrame() ?? "").not.toContain("quit armed");

    ui.stdin.write("\x03");
    await ui.awaitRender((v) => v.exitArmed === true);
    ui.stdin.write("\x03");
    await done;
    store.close();
  });

  it("exits after a queued follow-up and two provider errors", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const firstCallStarted = deferred();
    const releaseFirstCall = deferred();
    let calls = 0;
    const model = {
      async *stream() {
        calls += 1;
        if (calls === 1) {
          firstCallStarted.resolve();
          await releaseFirstCall.promise;
        }
        yield { type: "error" as const, code: "provider", message: "API key is invalid." };
      },
    };

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.stdin.write("first question");
    await tick();
    ui.stdin.write(ENTER);
    await firstCallStarted.promise;

    expect(ui.lastFrame() ?? "").toContain("type a follow-up to queue");
    expect(ui.lastFrame() ?? "").not.toContain("input · type a task or /help");

    ui.stdin.write("queued follow-up");
    await tick();
    ui.stdin.write(ENTER);
    await ui.awaitRender((v) => (v.pendingInputs ?? 0) === 1);
    releaseFirstCall.resolve();
    await ui.awaitRender(
      (v) =>
        v.awaitingInput === true &&
        v.items.some(
          (item) =>
            item.kind === "message" && item.role === "user" && item.content === "queued follow-up",
        ),
    );

    ui.stdin.write("/exit");
    await tick();
    ui.stdin.write(ENTER);
    await done;

    expect(calls).toBe(2);
    expect(ui.latest?.pendingInputs ?? 0).toBe(0);
    expect(ui.latest?.awaitingInput).toBe(true);
    store.close();
  });

  it("answers typed prompts across turns and stays open until the input stream ends", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const model = new ScriptedModel({ turns: [{ text: "answer one" }, { text: "answer two" }] });

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    // The Ink shell mounts at the first-run idle prompt.
    await ui.awaitRender((v) => v.awaitingInput === true);

    // Type the first prompt through the real InputBar (keypresses → onAction → InputQueue → runRepl).
    ui.stdin.write("first question");
    await tick();
    ui.stdin.write(ENTER);

    // Turn 1 is answered and the shell returns to the idle prompt — it did NOT exit.
    await ui.awaitRender((v) => v.awaitingInput === true && assistantSaid(v, "answer one"));
    expect(ui.lastFrame() ?? "").toContain("answer one");
    expect(ui.lastFrame() ?? "").not.toContain("done"); // text-only duplicate Done card is suppressed

    // A follow-up typed at the prompt is answered as a fresh turn.
    ui.stdin.write("second question");
    await tick();
    ui.stdin.write(ENTER);
    await ui.awaitRender((v) => assistantSaid(v, "answer two"));

    await ui.close(); // end the session (input stream closed + Ink unmounted)
    await done;
    store.close();

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "answer two" },
    ]);
  });

  it("renders Markdown assistant answers through the REAL Ink stack without raw scaffolding", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const answer = [
      "I'm **keel**.",
      "",
      "## Core Capabilities",
      "",
      "- Read code",
      "- Run tests",
      "",
      "| Task | Examples |",
      "|---|---|",
      "| **Feature work** | Implement a feature |",
      "",
      "```bash",
      "pnpm test",
      "```",
    ].join("\n");
    const model = new ScriptedModel({ turns: [{ text: answer }] });

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.stdin.write("show markdown formatting");
    await tick();
    ui.stdin.write(ENTER);
    await ui.awaitRender((v) => v.awaitingInput === true && assistantSaid(v, answer));

    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("I'm keel.");
    expect(frame).toContain("Core Capabilities");
    expect(frame).toContain("• Read code");
    expect(frame).toContain("Feature work");
    expect(frame).toContain("Examples Implement a feature");
    expect(frame).toContain("pnpm test");
    expect(frame).not.toContain("##");
    expect(frame).not.toContain("**");
    expect(frame).not.toContain("```");
    expect(frame).not.toContain("|---|");

    await ui.close();
    await done;
    store.close();
  });

  it("routes an exact novice capability question to the native panel through the REAL Ink path", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const model = new ScriptedModel({ turns: [{ text: "real answer" }] });

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.stdin.write("what can you do?");
    await tick();
    ui.stdin.write(ENTER);
    await ui.awaitRender((v) =>
      v.items.some(
        (it) => it.kind === "message" && it.role === "system" && /capabilities/.test(it.content),
      ),
    );
    await tick();
    const helpFrame = ui.lastFrame() ?? "";
    expect(helpFrame).toContain("what can you do?");
    expect(helpFrame).toContain("capabilities");
    expect(helpFrame).toContain("read: inspect files");
    expect(helpFrame).toContain("controls: status not reported — do not infer enforcement");
    expect(helpFrame).toContain("protection: status not reported");
    expect(helpFrame).not.toContain("real answer");
    expect(helpFrame).not.toMatch(/secure by construction|trusted|approved|autopilot|guided|yolo/i);

    ui.stdin.write("real task");
    await tick();
    ui.stdin.write(ENTER);
    await ui.awaitRender((v) => assistantSaid(v, "real answer"));

    await ui.close();
    await done;
    store.close();

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([
      { role: "user", content: "real task" },
      { role: "assistant", content: "real answer" },
    ]);
  });

  it("renders a first-run slash-command panel visibly instead of returning to the empty launch view", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const model = new ScriptedModel({ turns: [{ text: "unused" }] });

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.stdin.write("/capabilities");
    await tick();
    ui.stdin.write(ENTER);
    await ui.awaitRender(
      (v) => v.overlay?.kind === "panel" && /capabilities/.test(v.overlay.content),
    );
    await tick();

    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("capabilities");
    expect(frame).toContain("read: inspect files");
    expect(frame).toContain("controls: status not reported — do not infer enforcement");
    expect(frame).not.toContain("› /capabilities");
    expect(frame).not.toContain("Type what you want changed.");
    expect(frame).not.toMatch(/secure by construction|trusted|approved|autopilot|guided|yolo/i);

    await ui.close();
    await done;
    store.close();
  });

  it("dismisses an idle controller panel locally through the real Ink stack", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const done = runRepl({
      model: new ScriptedModel({ turns: [] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.stdin.write("/context");
    await ui.awaitFrame((frame) => frame.includes("/context"));
    ui.stdin.write(ENTER);
    await ui.awaitRender((v) => v.overlay?.kind === "panel");
    await ui.awaitFrame((frame) => frame.includes("project input:"));
    // One printable key proves the focus guard without leaving a synthetic multi-key backlog that
    // can delay the following Escape when the full suite is exercising several Ink workers.
    ui.stdin.write("§");
    await tick();
    ui.stdin.write(ESCAPE);
    await ui.awaitRender((v) => v.overlay === undefined && v.awaitingInput === true);
    await ui.awaitFrame((frame) => frame.includes("input · type a task or /help"));

    expect(ui.lastFrame() ?? "").toContain("input · type a task or /help");
    expect(ui.lastFrame() ?? "").not.toContain("§");
    expect(ui.lastFrame() ?? "").not.toContain("quit armed");

    // Teardown is not under test here; close the shared queue directly so test-worker load cannot
    // race a synthetic multi-byte `/exit` write against its following Enter.
    await ui.close();
    await done;
    store.close();
  });

  it("restores a queued draft after an active panel Escape aborts through the real Ink stack", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const slowStarted = deferred();
    const model = new ScriptedModel({
      turns: [{ toolCalls: [{ name: "slow", args: {} }] }, { text: "SHOULD NOT APPEAR" }],
    });
    const done = runRepl({
      model,
      executor: {
        execute: (_call, opts) =>
          new Promise((resolve) => {
            slowStarted.resolve();
            const finish = (): void => resolve({ ok: false, output: "stopped" });
            if (opts?.signal?.aborted === true) finish();
            else opts?.signal?.addEventListener("abort", finish, { once: true });
          }),
      },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.stdin.write("start work");
    await ui.awaitFrame((frame) => frame.includes("start work"));
    ui.stdin.write(ENTER);
    await slowStarted.promise;

    ui.stdin.write("queued draft");
    await ui.awaitFrame((frame) => frame.includes("queued draft"));
    ui.stdin.write(String.fromCharCode(1));
    ui.stdin.write("/context");
    await ui.awaitFrame((frame) => frame.includes("/context"));
    ui.stdin.write(ENTER);
    await ui.awaitRender((v) => v.overlay?.kind === "panel");
    await ui.awaitFrame((frame) => frame.includes("project input:"));
    // The frame proves the controller rerender committed; allow Ink's input subscription effect to
    // install the panel-focused handler before delivering Escape.
    await tick();

    ui.stdin.write(ESCAPE);
    await ui.awaitRender((v) => v.awaitingInput === true && v.overlay === undefined);
    await ui.awaitFrame((frame) => frame.includes("queued draft"));

    expect(ui.lastFrame() ?? "").toContain("queued draft");
    expect(ui.lastFrame() ?? "").not.toContain("SHOULD NOT APPEAR");

    await ui.close();
    await done;
    store.close();
  });

  it("keeps a rejected first-run /goal visible with recovery guidance", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const model = new ScriptedModel({ turns: [{ text: "unreached" }] });

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "unused" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.stdin.write("/goal explore this codebase and give me your thoughts");
    await tick();
    ui.stdin.write(ENTER);
    await ui.awaitRender((v) =>
      v.items.some(
        (item) =>
          item.kind === "message" &&
          item.role === "system" &&
          item.content === "/goal: goal requires at least one --check command",
      ),
    );
    await tick();

    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("note");
    expect(frame).toContain("/goal: goal requires at least one --check command");
    expect(frame).toContain("input · type a task or /help");
    expect(frame).not.toContain("› /goal explore this codebase");

    await ui.close();
    await done;
    expect(rebuild(readSession(store.id, e)).messages).toEqual([]);
    store.close();
  });

  it("explains an unknown first-run slash command instead of silently clearing it", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const model = new ScriptedModel({ turns: [{ text: "unreached" }] });

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "unused" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.stdin.write("/zzz explain this");
    await tick();
    ui.stdin.write(ENTER);
    await ui.awaitRender((v) =>
      v.items.some(
        (item) =>
          item.kind === "message" &&
          item.role === "system" &&
          item.content === "↻ /zzz is not available in this TUI; type /help for commands",
      ),
    );
    await tick();

    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("/zzz is not available in this TUI");
    expect(frame).toContain("type /help for commands");
    expect(frame).toContain("input · type a task or /help");
    expect(frame).not.toContain("› /zzz explain this");

    await ui.close();
    await done;
    expect(rebuild(readSession(store.id, e)).messages).toEqual([]);
    store.close();
  });

  it("transitions directly when a slash command is submitted through the real Ink stack", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const model = new ScriptedModel({ turns: [{ text: "unused" }] });

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.stdin.write("/about");
    await tick();
    ui.stdin.write(ENTER);
    await ui.awaitRender((v) => v.overlay?.kind === "panel" && /about/.test(v.overlay.content));
    await tick();

    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("about");
    expect(frame).toContain("governance-native coding agent");
    expect(frame).not.toContain("› /about");
    expect(frame).not.toContain("Start: ask for a change");

    await ui.close();
    await done;
    store.close();
  });

  it("opens on the first-run hero v3 (wordmark + usage digest + resume onboarding) in the REAL Ink frame", async () => {
    // Locks the wordmark end-to-end through the full Ink tree (Interactive → App → WelcomeBanner),
    // not just the App component in isolation: the opening idle view carries `firstRun`, so the real
    // rendered frame must show the wordmark + tagline AND the honest no-enforcement posture (the banner
    // never replaces or softens §4.9.1). Guards the "the user actually sees the banner in a TTY" path.
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const model = new ScriptedModel({ turns: [{ text: "unused" }] });

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
      view: {
        recentSessions: [
          {
            id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            age: "2h ago",
            summary: "fix prior bug",
            resumeCommand: "keel --resume ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            tokens: 1_500,
            outcome: "done",
          },
        ],
        usageDigest: {
          scope: "workspace",
          windows: [
            { label: "24h", tokens: 1_500, runs: 1 },
            { label: "7d", tokens: 3_500, runs: 2 },
          ],
        },
      },
    });

    await ui.awaitRender((v) => v.awaitingInput === true && v.firstRun === true);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("keel"); // the wordmark
    expect(frame).toContain("▄█████▄"); // responsive mark is visible at this wide viewport
    expect(frame).toContain("coding agent for governed work");
    expect(frame).toContain("Type what you want changed.");
    expect(frame).toContain("zero telemetry"); // ethos
    expect(frame).toContain("workspace usage · 24h 1.5k tok · 7d 3.5k tok");
    expect(frame).toContain("Try: fix a failing test");
    expect(frame).toContain("Resume latest: keel --continue");
    expect(frame).not.toContain("keel --resume <id>");
    expect(frame).toContain("/help shows commands. Tab completes slash commands and @files.");
    expect(frame).toContain("Finished turns stay in terminal history.");
    expect(frame).toContain(
      "Protection: see the footer below for sandbox · egress guard · policy · audit.",
    );
    expect(frame).toContain("Recent");
    expect(frame).toContain("ses_01A…5FAV");
    expect(frame).toContain("fix prior bug");
    expect(frame).toContain("done");
    expect(frame).toContain("1.5k tok");
    expect(frame).toContain("resume: keel --resume ses_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(frame).toContain("protection: status not reported");
    expect(frame).not.toMatch(
      /enforced|secure by construction|sandboxed|autopilot|trusted|cost|spend|\$/i,
    );

    await ui.close();
    await done;
    store.close();
  });

  it("does not dump the seeded system preamble into the transcript (Epic 1.24 slice 0)", async () => {
    // The seeded `head` (system prompt · env · AGENTS.md · skills) must NOT be rendered into the
    // interactive transcript — it is context, not conversation. Drives a real turn through the full Ink
    // stack and asserts the preamble is absent while the actual turn shows (the "verify in the real
    // stack" guard: a unit test on App alone wouldn't prove the runRepl → Interactive → App chain).
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const model = new ScriptedModel({ turns: [{ text: "the real answer" }] });

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
      head: [{ role: "system", content: "SYSTEM-PREAMBLE-SCAFFOLDING-do-not-show" }],
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.stdin.write("hello");
    await tick();
    ui.stdin.write(ENTER);
    // Ink line-buffers the unfinished streaming row; wait for settlement before asserting that
    // single-row answers have moved into immutable terminal history.
    await ui.awaitRender((v) => v.awaitingInput === true && assistantSaid(v, "the real answer"));

    const frame = ui.lastFrame() ?? "";
    expect(frame).not.toContain("SYSTEM-PREAMBLE-SCAFFOLDING-do-not-show"); // scaffolding hidden
    expect(frame).toContain("the real answer"); // the actual turn is shown

    await ui.close();
    await done;
    store.close();
  });

  it("resumes through REAL Ink without exposing scaffolding or repainting a denial as success", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const done = runRepl({
      model: new ScriptedModel({ turns: [{ text: "unused" }] }),
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
      resumed: [
        { role: "system", content: "SYSTEM-PROMPT-PRIVATE" },
        { role: "system", content: "AGENTS-MD-PRIVATE" },
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
      ],
      resumedFailedToolCallIds: new Set(["denied"]),
    });

    await ui.awaitRender(
      (v) => v.awaitingInput === true && assistantSaid(v, "The write was blocked."),
    );
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("resumed 6 messages");
    expect(frame).toContain("blocked");
    expect(frame).not.toContain("SYSTEM-PROMPT-PRIVATE");
    expect(frame).not.toContain("AGENTS-MD-PRIVATE");
    expect(frame).not.toContain("tool ✓ write done");
    expect(
      frame.split("\n").filter((line) => line.trim().replace(/^│\s*/, "") === "keel"),
    ).toHaveLength(1);

    await ui.close();
    await done;
    store.close();
  });

  it("opens the grouped slash palette and applies /quiet through the REAL Ink input path", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const model = new ScriptedModel({ turns: [{ text: "unused" }] });

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.stdin.write("/");
    await tick();
    const palette = ui.lastFrame() ?? "";
    expect(palette).toContain("/capabilities");
    expect(palette).toContain("view");
    expect(palette).toContain("/quiet");
    expect(palette).not.toMatch(/danger|\/yolo|not wired|use CLI today/i);

    ui.stdin.write("quiet");
    await tick();
    ui.stdin.write(ENTER);
    await ui.awaitRender((v) => v.density === "quiet");
    expect(ui.lastFrame() ?? "").toMatch(/view\s+quiet/u);

    await ui.close();
    await done;
    store.close();
  });

  it("applies /compact through the REAL Ink input path as a review-only panel", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new InkReplUI();
    const model = new ScriptedModel({ turns: [{ text: "unused" }] });

    const done = runRepl({
      model,
      executor: { execute: () => Promise.resolve({ ok: true, output: "ok" }) },
      ui,
      store,
      env: e,
    });

    await ui.awaitRender((v) => v.awaitingInput === true);
    ui.stdin.write("/compact");
    await tick();
    ui.stdin.write(ENTER);
    await ui.awaitRender(
      (v) =>
        v.overlay?.kind === "panel" && /compact proposal[\s\S]*review only/.test(v.overlay.content),
    );
    await tick();
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("compact proposal");
    expect(frame).toContain("review only");
    expect(frame).toContain("protection: status not reported");
    expect(frame).not.toContain("› /compact");

    await ui.close();
    await done;
    store.close();
  });
});

describe("runRepl through REAL Ink — urgent steering terminal truth (Epic 3.17)", () => {
  it.each([
    { command: "/now", instruction: "do not edit f.ts" },
    { command: "/before-next-edit", instruction: "keep f.ts unchanged" },
    { command: "/stop-after-current", instruction: "stop before editing f.ts" },
  ] as const)(
    "$command returns to a truthful idle composer and the next ordinary line starts a new turn",
    async ({ command, instruction }) => {
      const e = env();
      const store = SessionStore.create({ cwd: "/w" }, e);
      const ui = new InkReplUI();
      const readStarted = deferred();
      const releaseRead = deferred();
      const executed: string[] = [];
      const done = runRepl({
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
            { text: `redrive settled after ${command}` },
            { text: `ordinary turn settled after ${command}` },
          ],
        }),
        executor: {
          execute(call): Promise<{ ok: boolean; output: string }> {
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
        },
        ui,
        store,
        env: e,
      });

      try {
        await ui.awaitRender((view) => view.awaitingInput === true);
        ui.stdin.write("start urgent steering scenario");
        await tick();
        ui.stdin.write(ENTER);
        await readStarted.promise;

        ui.stdin.write(`${command} ${instruction}`);
        await tick();
        ui.stdin.write(ENTER);
        await ui.awaitRender((view) => (view.pendingInputs ?? 0) === 1);
        releaseRead.resolve();

        await ui.awaitRender(
          (view) =>
            view.awaitingInput === true && assistantSaid(view, `redrive settled after ${command}`),
        );
        await ui.awaitFrame((frame) => frame.includes("input · type a task or /help"));
        const firstIdle = ui.lastFrame() ?? "";
        expect(firstIdle).toContain(`redrive settled after ${command}`);
        expect(firstIdle).toContain("input · type a task or /help");
        expect(firstIdle).not.toMatch(/\brunning\b/u);
        expect(firstIdle).not.toContain("follow-up to queue");
        expect(executed).toEqual(["read"]);
        expect(ui.latest?.currentTurn).toBeUndefined();
        expect(ui.latest?.streaming).toBe(false);
        expect(ui.latest?.pendingInputs ?? 0).toBe(0);
        expect(
          ui.latest?.items.some((item) => item.kind === "tool" && item.status === "running"),
        ).toBe(false);
        const stoppedActivities =
          ui.latest?.items.filter(
            (item) => item.kind === "tool" && toolPresentationOutcome(item) === "stopped",
          ) ?? [];
        expect(stoppedActivities).toHaveLength(1);
        const stopped = stoppedActivities[0];
        if (stopped?.kind !== "tool") throw new Error("expected prevented edit activity");
        expect(stopped.id).toBe("call_1_0");
        expect(toolPresentationOutcome(stopped)).toBe("stopped");

        ui.stdin.write("ordinary follow-up");
        await tick();
        ui.stdin.write(ENTER);
        await ui.awaitRender(
          (view) =>
            view.awaitingInput === true &&
            assistantSaid(view, `ordinary turn settled after ${command}`),
        );
        await ui.awaitFrame((frame) => frame.includes("input · type a task or /help"));
        const secondIdle = ui.lastFrame() ?? "";
        expect(secondIdle).toContain(`ordinary turn settled after ${command}`);
        expect(secondIdle).not.toMatch(/\brunning\b/u);
        expect(secondIdle).not.toContain("follow-up to queue");

        const file = readSession(store.id, e);
        expect(
          file.events.filter((event) => event.type === "run_status").map((event) => event.reason),
        ).toEqual(["aborted", "model-stop", "model-stop"]);
        expect(
          file.events.some(
            (event) => event.type === "tool_result" && event.toolCallId === "call_1_0",
          ),
        ).toBe(false);
        expect(rebuild(file).messages).toContainEqual({
          role: "user",
          content: "ordinary follow-up",
        });
      } finally {
        await ui.close();
        await done;
        store.close();
      }
    },
  );
});
