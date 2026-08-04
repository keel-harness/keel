import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { useEffect, useMemo, useState } from "react";
import type { UserInput, ViewModel } from "@keel/shared";
import type { InputState } from "../input.js";
import { createInteractiveReviewDecisionController } from "../review-decision.js";
import { ALL_OFF_POSTURE, reduce } from "../view-model.js";
import { Interactive } from "./interactive.js";
import type { DiffViewerOpenResult } from "../diff-viewer-control.js";
import type { DiffViewerState } from "../diff-viewer.js";

const ENTER = "\r";
const CTRL_C = String.fromCharCode(3);
const CTRL_Z = String.fromCharCode(26);
const ESC = String.fromCharCode(27);
const TAB = "\t";
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
const view: ViewModel = {
  items: [{ kind: "message", role: "assistant", content: "ready" }],
  status: { model: "sonnet", tokens: 0, posture: ALL_OFF_POSTURE },
  streaming: false,
};

const firstRunView: ViewModel = {
  items: [],
  status: { model: "sonnet", tokens: 0, posture: ALL_OFF_POSTURE },
  streaming: false,
  awaitingInput: true,
  firstRun: true,
};

const streamingView: ViewModel = {
  items: [
    { kind: "message", role: "user", content: "one" },
    { kind: "message", role: "assistant", content: "answer one" },
    { kind: "message", role: "user", content: "two" },
    { kind: "message", role: "assistant", content: "partial answer" },
  ],
  status: { model: "sonnet", tokens: 0, posture: ALL_OFF_POSTURE },
  streaming: true,
};

const waitingForProviderView: ViewModel = {
  items: [{ kind: "message", role: "user", content: "inspect the repo" }],
  status: { model: "sonnet", tokens: 0, posture: ALL_OFF_POSTURE },
  streaming: false,
  currentTurn: {
    doing: "waiting for assistant",
    why: "latest visible event is a user prompt",
    last: "inspect the repo",
    next: "provider stream or tool call",
  },
};

function LiveReviewExplanationHarness(): React.JSX.Element {
  const controller = useMemo(() => createInteractiveReviewDecisionController(), []);
  const [current, setCurrent] = useState<ViewModel>(streamingView);
  useEffect(() => {
    const disconnect = controller.connect({
      presentation: (event) => {
        setCurrent((previous) => {
          if (event.kind === "opened") {
            return reduce(previous, {
              type: "approval-opened",
              detail: event.detail,
              sessionAvailable: event.sessionAvailable,
              information: event.information,
            });
          }
          if (event.kind === "message") {
            return reduce(previous, { type: "approval-message", content: event.content });
          }
          return previous;
        });
      },
    });
    void controller.onReviewRequired({
      toolCall: { id: "review-explain", name: "bash", args: { command: "rm hello.md" } },
      review: {
        reviewId: "command_review_explain",
        summary: "workspace deletion requires exact once-only approval: rm hello.md",
        allowCommand: "keel approve command_review_explain --scope once",
      },
    });
    return disconnect;
  }, [controller]);
  return <Interactive view={current} onAction={(action) => controller.handleInput(action)} />;
}

describe("Ink Interactive shell (conversation + live InputBar)", () => {
  it("renders the conversation/HUD above the input line", () => {
    const { lastFrame } = render(<Interactive view={view} onAction={vi.fn()} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ready"); // conversation (App)
    expect(frame).toContain("protection: status not reported"); // honest HUD
    expect(frame).toContain("›"); // the input prompt
  });

  it("opens a settled multi-file review, keeps navigation local, and restores the exact draft", async () => {
    let openViewer: (() => DiffViewerOpenResult) | undefined;
    const onAction = vi.fn<(action: UserInput) => void>();
    const onViewerState = vi.fn<(state: DiffViewerState | undefined) => void>();
    const onSuspendRequest = vi.fn();
    const initialComposerState: InputState = {
      buffer: "draft 👩🏽‍💻 survives",
      cursor: 6,
      history: ["older"],
      histIndex: 0,
      kill: "ring",
    };
    const diffView: ViewModel = {
      ...view,
      awaitingInput: true,
      items: [
        {
          kind: "tool",
          id: "edit-a",
          name: "edit",
          status: "ok",
          summary: "src/a.ts",
          diff: [
            { kind: "context", text: "const a = 0;", hunkStart: true },
            { kind: "del", text: "const oldA = 1;" },
            { kind: "add", text: "const newA = 1;" },
            { kind: "context", text: "const b = 0;", hunkStart: true },
            { kind: "del", text: "const oldB = 2;" },
            { kind: "add", text: "const newB = 2;" },
          ],
        },
        {
          kind: "tool",
          id: "edit-b",
          name: "edit",
          status: "ok",
          summary: "src/b.ts",
          diff: [
            { kind: "del", text: "before", hunkStart: true },
            { kind: "add", text: "after" },
          ],
        },
      ],
    };
    const rendered = render(
      <Interactive
        view={diffView}
        onAction={onAction}
        initialComposerState={initialComposerState}
        onDiffViewerState={onViewerState}
        onSuspendRequest={onSuspendRequest}
        connectDiffViewer={(open) => {
          openViewer = open;
          return () => undefined;
        }}
      />,
    );

    expect(openViewer?.()).toBe("opened");
    await tick();
    expect(rendered.lastFrame() ?? "").toContain(
      "reviewing changes · file 1/2 · hunk 1/2 · change 1/2",
    );
    expect(rendered.lastFrame() ?? "").toContain("a.ts");

    rendered.stdin.write("n");
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("hunk 2/2 · change 2/2");
    rendered.stdin.write(TAB);
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("file 2/2");
    expect(rendered.lastFrame() ?? "").toContain("b.ts");
    rendered.stdin.write("\x1b[Z");
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("file 1/2 · hunk 2/2 · change 2/2");
    rendered.stdin.write(TAB);
    await tick();
    rendered.stdin.write(ENTER);
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("▶ hunk 1/1 · +1 -1 · 2 rows");
    rendered.stdin.write(" ");
    await tick();
    expect(rendered.lastFrame() ?? "").not.toContain("▶ hunk 1/1");
    rendered.stdout.emit("resize");
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("reviewing changes");
    expect(onAction).not.toHaveBeenCalled();
    expect(onViewerState).toHaveBeenLastCalledWith(expect.objectContaining({ fileIndex: 1 }));

    rendered.stdin.write("\x1b[200~must not enter the draft\x1b[201~");
    rendered.stdin.write(CTRL_Z);
    await tick();
    expect(onSuspendRequest).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();

    rendered.stdin.write(CTRL_C);
    await tick();
    const restored = rendered.lastFrame() ?? "";
    expect(restored).not.toContain("reviewing changes");
    expect(restored).toContain("draft 👩🏽‍💻 survives");
    expect(restored).not.toContain("must not enter the draft");
    expect(onAction).not.toHaveBeenCalled();
    expect(onViewerState).toHaveBeenLastCalledWith(undefined);

    expect(openViewer?.()).toBe("opened");
    await tick();
    rendered.stdin.write(ESC);
    await tick();
    expect(rendered.lastFrame() ?? "").not.toContain("reviewing changes");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("hands raw focus to a newly opened approval in the same render that hides the viewer", async () => {
    let openViewer: (() => DiffViewerOpenResult) | undefined;
    const onAction = vi.fn<(action: UserInput) => void>();
    const connectDiffViewer = (open: () => DiffViewerOpenResult): (() => void) => {
      openViewer = open;
      return () => undefined;
    };
    const idle: ViewModel = {
      ...view,
      awaitingInput: true,
      items: [
        {
          kind: "tool",
          id: "edit-a",
          name: "edit",
          status: "ok",
          summary: "src/a.ts",
          diff: [
            { kind: "del", text: "before", hunkStart: true },
            { kind: "add", text: "after" },
          ],
        },
      ],
    };
    const rendered = render(
      <Interactive view={idle} onAction={onAction} connectDiffViewer={connectDiffViewer} />,
    );
    expect(openViewer?.()).toBe("opened");
    await vi.waitFor(() => expect(rendered.lastFrame() ?? "").toContain("reviewing changes"));

    rendered.rerender(
      <Interactive
        view={{
          ...idle,
          activeApproval: {
            detail: "command review requires approval: pnpm test",
            sessionAvailable: true,
            state: "pending",
          },
        }}
        onAction={onAction}
        connectDiffViewer={connectDiffViewer}
      />,
    );

    expect(rendered.lastFrame() ?? "").not.toContain("reviewing changes");
    expect(rendered.lastFrame() ?? "").toContain("approval required");
    rendered.stdin.write("a");
    await tick();
    rendered.stdin.write(ENTER);
    await tick();
    expect(onAction).toHaveBeenCalledWith({ kind: "line", text: "a" });
  });

  it("refuses viewer focus during an active turn even when earlier settled diffs remain", () => {
    let openViewer: (() => DiffViewerOpenResult) | undefined;
    render(
      <Interactive
        view={{
          ...waitingForProviderView,
          items: [
            {
              kind: "tool",
              id: "edit-a",
              name: "edit",
              status: "ok",
              summary: "src/a.ts",
              diff: [
                { kind: "del", text: "before", hunkStart: true },
                { kind: "add", text: "after" },
              ],
            },
            ...waitingForProviderView.items,
          ],
        }}
        onAction={vi.fn()}
        connectDiffViewer={(open) => {
          openViewer = open;
          return () => undefined;
        }}
      />,
    );

    expect(openViewer?.()).toBe("not-settled");
  });

  it("keeps the first-run composer concise in the default Ink test renderer", () => {
    const { lastFrame } = render(<Interactive view={firstRunView} onAction={vi.fn()} />);
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n").filter((line) => line.trim().length > 0);

    expect(lines.length).toBeLessThanOrEqual(20);
    expect(frame).toContain("input");
    expect(frame).toContain("type a task or /help");
    expect(frame).toContain("›");
    expect(frame).not.toContain("type to continue");
  });

  it("offers queueing while the provider has not emitted its first event yet", () => {
    const { lastFrame } = render(<Interactive view={waitingForProviderView} onAction={vi.fn()} />);

    expect(lastFrame() ?? "").toContain("type a follow-up to queue");
    expect(lastFrame() ?? "").not.toContain("input · type a task or /help");
  });

  it("keeps queue semantics between a settled tool and the next provider event", () => {
    const { lastFrame } = render(
      <Interactive
        view={{
          items: [
            { kind: "message", role: "user", content: "inspect the repo" },
            { kind: "tool", id: "read-1", name: "read", status: "ok", summary: "README.md" },
          ],
          status: waitingForProviderView.status,
          streaming: false,
          awaitingInput: false,
        }}
        onAction={vi.fn()}
      />,
    );

    expect(lastFrame() ?? "").toContain("type a follow-up to queue");
    expect(lastFrame() ?? "").not.toContain("input · type a task or /help");
  });

  it("typing '/' shows the command palette live (input overlay merged into the view)", async () => {
    const { stdin, lastFrame } = render(<Interactive view={view} onAction={vi.fn()} />);
    stdin.write("/cap");
    await tick();
    expect(lastFrame() ?? "").toContain("/capabilities");
  });

  it("reports an idle palette's exact local input for terminal suspension", async () => {
    const onComposerState = vi.fn();
    const rendered = render(
      <Interactive view={view} onAction={vi.fn()} onComposerState={onComposerState} />,
    );

    rendered.stdin.write("/cap");
    await tick();

    expect(onComposerState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        buffer: "/cap",
        cursor: 4,
        overlay: { kind: "palette", query: "/cap" },
      }),
    );
  });

  it("restores an idle palette visibly from an exact terminal suspension snapshot", () => {
    const restored = {
      buffer: "/cap",
      cursor: 4,
      history: [],
      histIndex: null,
      kill: "",
      overlay: { kind: "palette" as const, query: "/cap" },
    };
    const frame =
      render(
        <Interactive view={view} onAction={vi.fn()} initialComposerState={restored} />,
      ).lastFrame() ?? "";

    expect(frame).toContain("/capabilities");
    expect(frame).toContain("/cap");
  });

  it("marks and submits the selected command instead of the first palette row", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const rendered = render(<Interactive view={view} onAction={onAction} />);
    rendered.stdin.write("/");
    await tick();
    rendered.stdin.write("\x1b[B");
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("› /diff");

    rendered.stdin.write(ENTER);
    await tick();
    expect(onAction).toHaveBeenCalledWith({ kind: "command", name: "/diff" });
  });

  it("scrolls a bounded read-only panel without leaking keys into the composer", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const lines = Array.from(
      { length: 40 },
      (_, index) => `line-${String(index + 1).padStart(2, "0")}`,
    );
    const rendered = render(
      <Interactive
        view={{
          ...view,
          awaitingInput: true,
          overlay: { kind: "panel", content: ["long panel", ...lines].join("\n") },
        }}
        onAction={onAction}
        onDismissOverlay={vi.fn()}
      />,
    );
    expect(rendered.lastFrame() ?? "").toContain("line-01");

    rendered.stdin.write("\x1b[6~");
    await tick();
    expect(rendered.lastFrame() ?? "").not.toContain("line-01");
    expect(rendered.lastFrame() ?? "").toContain("earlier lines");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("renders the first physical row of an overlong single-line panel instead of an empty viewport", () => {
    const overlong = `BEGIN-RETAINED-ANSWER ${"detail ".repeat(800)}END-RETAINED-ANSWER`;
    const frame =
      render(
        <Interactive
          view={{
            ...view,
            awaitingInput: true,
            overlay: { kind: "panel", content: `original final answer\n${overlong}` },
          }}
          onAction={vi.fn()}
          onDismissOverlay={vi.fn()}
        />,
      ).lastFrame() ?? "";

    expect(frame).toContain("BEGIN-RETAINED-ANSWER");
    expect(frame).toContain("more panel lines");
  });

  it("keeps rendered panel offset synchronized at the bounded tail", async () => {
    const lines = Array.from(
      { length: 40 },
      (_, index) => `line-${String(index + 1).padStart(2, "0")}`,
    );
    const rendered = render(
      <Interactive
        view={{
          ...view,
          awaitingInput: true,
          overlay: { kind: "panel", content: ["long panel", ...lines].join("\n") },
        }}
        onAction={vi.fn()}
        onDismissOverlay={vi.fn()}
      />,
    );

    for (let page = 0; page < 6; page += 1) rendered.stdin.write("\x1b[6~");
    await tick();
    const tail = rendered.lastFrame() ?? "";
    expect(tail).toContain("line-40");

    rendered.stdin.write("\x1b[A");
    await tick();
    const oneLineUp = rendered.lastFrame() ?? "";
    expect(oneLineUp).not.toBe(tail);
    expect(oneLineUp).toContain("line-39");
    expect(oneLineUp).toContain("line-40");
  });

  it("does not scroll help when the complete surface already fits the viewport", async () => {
    const rendered = render(
      <Interactive
        view={{ ...view, awaitingInput: true, overlay: { kind: "help" } }}
        onAction={vi.fn()}
      />,
    );
    const completeHelp = rendered.lastFrame() ?? "";
    expect(completeHelp).toContain("common actions");
    expect(completeHelp).toContain("Esc closes panels");

    rendered.stdin.write("\x1b[6~");
    await tick();
    expect(rendered.lastFrame() ?? "").toBe(completeHelp);
  });

  it("reopens identical controller panel content at the top instead of a stale offset", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const lines = Array.from(
      { length: 40 },
      (_, index) => `line-${String(index + 1).padStart(2, "0")}`,
    );
    const panel: ViewModel = {
      ...view,
      awaitingInput: true,
      overlay: { kind: "panel", content: ["long panel", ...lines].join("\n") },
    };
    const rendered = render(<Interactive view={panel} onAction={onAction} />);

    rendered.stdin.write("\x1b[6~");
    await tick();
    expect(rendered.lastFrame() ?? "").not.toContain("line-01");

    rendered.rerender(<Interactive view={{ ...view, awaitingInput: true }} onAction={onAction} />);
    await tick();
    rendered.rerender(<Interactive view={panel} onAction={onAction} />);
    await tick();

    expect(rendered.lastFrame() ?? "").toContain("line-01");
  });

  it("submitting a line flows out through onAction (→ the InputQueue → the runner)", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const { stdin } = render(<Interactive view={view} onAction={onAction} />);
    stdin.write("focus on a.ts");
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(onAction).toHaveBeenCalledWith({ kind: "line", text: "focus on a.ts" });
  });

  it("routes raw Ctrl-Z to terminal suspension without crossing the input port", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const onSuspendRequest = vi.fn();
    const rendered = render(
      <Interactive view={view} onAction={onAction} onSuspendRequest={onSuspendRequest} />,
    );

    rendered.stdin.write(String.fromCharCode(26));
    await tick();

    expect(onSuspendRequest).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("threads foreground-panel focus into the composer and releases it with Escape", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const panelView: ViewModel = {
      ...streamingView,
      pendingReviews: 1,
      overlay: { kind: "panel", content: "protections\n  read-only" },
    };
    const rendered = render(<Interactive view={panelView} onAction={onAction} />);

    expect(rendered.lastFrame() ?? "").toContain("panel open");
    rendered.stdin.write("a");
    rendered.stdin.write(ENTER);
    await tick();
    expect(onAction).not.toHaveBeenCalled();

    rendered.stdin.write(ESC);
    await tick();
    expect(onAction).toHaveBeenCalledWith({ kind: "interrupt" });

    rendered.rerender(<Interactive view={streamingView} onAction={onAction} />);
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("type a follow-up to queue");
    expect(rendered.lastFrame() ?? "").not.toContain("reaching a safe stop");
  });

  it("dismisses an idle controller panel locally and interrupts only when a turn is active", async () => {
    const idleAction = vi.fn<(a: UserInput) => void>();
    const idleDismiss = vi.fn();
    const idlePanel: ViewModel = {
      ...view,
      awaitingInput: true,
      overlay: { kind: "panel", content: "context\n  read-only" },
    };
    const idle = render(
      <Interactive view={idlePanel} onAction={idleAction} onDismissOverlay={idleDismiss} />,
    );
    idle.stdin.write(ESC);
    await tick();
    expect(idleDismiss).toHaveBeenCalledTimes(1);
    expect(idleAction).not.toHaveBeenCalled();
    idle.unmount();

    const activeAction = vi.fn<(a: UserInput) => void>();
    const activeDismiss = vi.fn();
    const activePanel: ViewModel = {
      ...streamingView,
      overlay: { kind: "panel", content: "context\n  read-only" },
    };
    const active = render(
      <Interactive view={activePanel} onAction={activeAction} onDismissOverlay={activeDismiss} />,
    );
    active.stdin.write(ESC);
    await tick();
    expect(activeDismiss).toHaveBeenCalledTimes(1);
    expect(activeAction).toHaveBeenCalledTimes(1);
    expect(activeAction).toHaveBeenCalledWith({ kind: "interrupt" });
  });

  it("renders a submitted review as pending and non-actionable", () => {
    const submittedReview: ViewModel = {
      ...view,
      pendingReviews: 1,
      activeApproval: {
        detail: "bash command review for make",
        sessionAvailable: false,
        state: "submitted",
        message: "decision submitted · waiting for warden confirmation",
      },
    };

    const { lastFrame } = render(<Interactive view={submittedReview} onAction={vi.fn()} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("decision sent");
    expect(frame).toContain("waiting for warden confirmation");
    expect(frame).toContain("decision sent · input paused");
    expect(frame.match(/waiting for warden confirmation/gu)).toHaveLength(1);
    expect(frame).not.toContain("decision submitted · waiting for warden confirmation");
    expect(frame).not.toContain("open /reviews or answer the prompt");
  });

  it("advertises only the approval shortcuts available for this request", () => {
    const withoutSession: ViewModel = {
      ...view,
      pendingReviews: 1,
      activeApproval: {
        detail: "generic command review",
        sessionAvailable: false,
        state: "pending",
      },
    };
    const frame =
      render(<Interactive view={withoutSession} onAction={vi.fn()} />).lastFrame() ?? "";

    expect(frame).toContain("decision required · choose above");
    expect(frame).toContain("a/d Enter · ? why · Esc stops turn");
    expect(frame).not.toContain("a/s/p/d");
  });

  it("turns a raw ? key into unmistakable visible feedback while the review stays pending", async () => {
    const rendered = render(<LiveReviewExplanationHarness />);
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("approval required · not executed");

    rendered.stdin.write("?");
    await tick();

    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("explanation shown above · still pending · no authority granted");
    expect(frame).toContain("[a] Approve once");
    expect(frame).not.toContain("decision sent");
  });

  it("clears a buffered palette before a newly opened review can accept input", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const rendered = render(<Interactive view={view} onAction={onAction} />);
    rendered.stdin.write("/approve once");
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("/approve once");

    rendered.rerender(
      <Interactive
        view={{
          ...view,
          pendingReviews: 1,
          activeApproval: {
            detail: "command review requires approval: pnpm test",
            sessionAvailable: true,
            state: "pending",
          },
        }}
        onAction={onAction}
      />,
    );
    await tick();
    rendered.stdin.write(ENTER);
    await tick();

    expect(rendered.lastFrame() ?? "").toContain("approval required");
    expect(onAction).not.toHaveBeenCalledWith({
      kind: "command",
      name: "/approve",
      args: "once",
    });
  });

  it("does not restore a stale composer palette after an approval closes", async () => {
    const rendered = render(<Interactive view={view} onAction={vi.fn()} />);
    rendered.stdin.write("/cap");
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("/capabilities");

    rendered.rerender(
      <Interactive
        view={{
          ...view,
          activeApproval: {
            detail: "command review requires approval: pnpm test",
            sessionAvailable: false,
            state: "pending",
          },
        }}
        onAction={vi.fn()}
      />,
    );
    await tick();
    expect(rendered.lastFrame() ?? "").not.toContain("/capabilities");

    rendered.rerender(<Interactive view={view} onAction={vi.fn()} />);
    await tick();
    expect(rendered.lastFrame() ?? "").not.toContain("/capabilities");
  });

  it("invalidates the outer suspension snapshot when approval takes an idle palette's focus", async () => {
    const onComposerState = vi.fn();
    const rendered = render(
      <Interactive view={view} onAction={vi.fn()} onComposerState={onComposerState} />,
    );
    rendered.stdin.write("/cap");
    await tick();

    rendered.rerender(
      <Interactive
        view={{
          ...view,
          activeApproval: {
            detail: "command review requires approval: pnpm test",
            sessionAvailable: false,
            state: "pending",
          },
        }}
        onAction={vi.fn()}
        onComposerState={onComposerState}
      />,
    );
    await tick();

    expect(onComposerState).toHaveBeenLastCalledWith(
      expect.objectContaining({ buffer: "", cursor: 0 }),
    );
  });

  it("preserves an unsent multiline composer draft while approval owns focus", async () => {
    const rendered = render(<Interactive view={streamingView} onAction={vi.fn()} />);
    rendered.stdin.write("keep this draft\\");
    rendered.stdin.write(ENTER);
    rendered.stdin.write("second line");
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("keep this draft");
    expect(rendered.lastFrame() ?? "").toContain("second line");

    rendered.rerender(
      <Interactive
        view={{
          ...streamingView,
          activeApproval: {
            detail: "command review requires approval: pnpm test",
            sessionAvailable: false,
            state: "pending",
          },
        }}
        onAction={vi.fn()}
      />,
    );
    await tick();
    expect(rendered.lastFrame() ?? "").not.toContain("keep this draft");

    rendered.rerender(<Interactive view={streamingView} onAction={vi.fn()} />);
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("keep this draft");
    expect(rendered.lastFrame() ?? "").toContain("second line");
    expect(rendered.lastFrame() ?? "").not.toContain("/capabilities");
  });

  it("restores partial approval input separately from the queued composer after suspension", async () => {
    const approvalView: ViewModel = {
      ...streamingView,
      activeApproval: {
        detail: "command review requires approval: pnpm test",
        sessionAvailable: true,
        state: "pending",
      },
    };
    const composer: InputState = {
      buffer: "keep queued draft",
      cursor: 17,
      history: [],
      histIndex: null,
      kill: "",
    };
    const onApprovalState = vi.fn();
    const beforeSuspend = render(
      <Interactive
        view={approvalView}
        onAction={vi.fn()}
        initialComposerState={composer}
        onApprovalState={onApprovalState}
      />,
    );
    beforeSuspend.stdin.write("a");
    await tick();

    expect(onApprovalState).toHaveBeenLastCalledWith(
      expect.objectContaining({ buffer: "a", cursor: 1 }),
    );
    const approval = onApprovalState.mock.calls.at(-1)?.[0] as InputState | undefined;
    if (approval === undefined) throw new Error("approval input snapshot was not published");
    beforeSuspend.unmount();

    const resumed = render(
      <Interactive
        view={approvalView}
        onAction={vi.fn()}
        initialComposerState={composer}
        initialApprovalState={approval}
        onApprovalState={onApprovalState}
      />,
    );
    expect(resumed.lastFrame() ?? "").toContain("› a");

    resumed.rerender(<Interactive view={view} onAction={vi.fn()} />);
    await tick();
    expect(resumed.lastFrame() ?? "").toContain("keep queued draft");
    expect(resumed.lastFrame() ?? "").not.toContain("› a");
  });

  it("preserves the exact multiline grapheme draft and cursor through queue, resize, and approval", async () => {
    const onAction = vi.fn<(action: UserInput) => void>();
    const rendered = render(<Interactive view={streamingView} onAction={onAction} />);
    rendered.stdin.write("\x1b[200~first\nA👩🏽‍💻B\x1b[201~");
    await tick();
    rendered.stdin.write(`${ESC}[D`); // before B
    await tick();
    rendered.stdin.write(`${ESC}[D`); // before the whole emoji grapheme
    await tick();

    rendered.stdout.emit("resize");
    rendered.rerender(
      <Interactive view={{ ...streamingView, pendingInputs: 1 }} onAction={onAction} />,
    );
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("first");

    rendered.rerender(
      <Interactive
        view={{
          ...streamingView,
          pendingInputs: 1,
          activeApproval: {
            detail: "command review requires approval: pnpm test",
            sessionAvailable: false,
            state: "pending",
          },
        }}
        onAction={onAction}
      />,
    );
    await tick();
    expect(rendered.lastFrame() ?? "").not.toContain("first");

    rendered.rerender(
      <Interactive view={{ ...streamingView, pendingInputs: 1 }} onAction={onAction} />,
    );
    await tick();
    rendered.stdin.write("X");
    rendered.stdin.write(ENTER);
    await tick();

    expect(onAction).toHaveBeenCalledWith({ kind: "line", text: "first\nAX👩🏽‍💻B" });
  });

  it("routes a raw Escape from the live approval through interrupt and restores the draft", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const rendered = render(<Interactive view={streamingView} onAction={onAction} />);
    rendered.stdin.write("keep this correction");
    await tick();

    rendered.rerender(
      <Interactive
        view={{
          ...streamingView,
          activeApproval: {
            detail: "command review requires approval: pnpm test",
            sessionAvailable: false,
            state: "pending",
          },
        }}
        onAction={onAction}
      />,
    );
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("approval required");
    expect(rendered.lastFrame() ?? "").not.toContain("keep this correction");

    rendered.stdin.write(ESC);
    await tick();
    expect(onAction).toHaveBeenCalledWith({ kind: "interrupt" });

    rendered.rerender(<Interactive view={streamingView} onAction={onAction} />);
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("keep this correction");
  });

  it("invalidates stale palette callbacks across repeated approval generations", async () => {
    const rendered = render(<Interactive view={view} onAction={vi.fn()} />);

    for (let index = 0; index < 8; index += 1) {
      rendered.stdin.write("/cap");
      await tick();
      expect(rendered.lastFrame() ?? "").toContain("/capabilities");

      rendered.rerender(
        <Interactive
          view={{
            ...view,
            activeApproval: {
              detail: `command review ${index}`,
              sessionAvailable: false,
              state: "pending",
            },
          }}
          onAction={vi.fn()}
        />,
      );
      rendered.rerender(<Interactive view={view} onAction={vi.fn()} />);
      await tick();
      expect(rendered.lastFrame() ?? "").not.toContain("/capabilities");
    }
  });

  it("threads the editor hook to the composer", async () => {
    const editDraft = vi.fn<(draft: string) => Promise<string | undefined>>(() =>
      Promise.resolve("from editor"),
    );
    const { stdin, lastFrame } = render(
      <Interactive view={view} onAction={vi.fn()} editDraft={editDraft} />,
    );
    stdin.write("draft");
    await tick();
    stdin.write(String.fromCharCode(7));
    await tick();
    await tick();
    expect(editDraft).toHaveBeenCalledWith("draft");
    expect(lastFrame() ?? "").toContain("from editor");
  });

  it("preserves a draft prompt across static transcript promotion rerenders", async () => {
    const rendered = render(<Interactive view={streamingView} onAction={vi.fn()} />);
    rendered.stdin.write("keep this draft");
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("keep this draft");
    expect(rendered.lastFrame() ?? "").toContain("Enter queues for the next safe point");

    rendered.rerender(
      <Interactive
        view={{
          ...streamingView,
          items: [
            { kind: "message", role: "user", content: "one" },
            { kind: "message", role: "assistant", content: "answer one" },
            { kind: "message", role: "user", content: "two" },
            { kind: "message", role: "assistant", content: "partial answer plus more" },
          ],
        }}
        onAction={vi.fn()}
      />,
    );
    await tick();
    expect(rendered.lastFrame() ?? "").toContain("keep this draft");
    expect(rendered.lastFrame() ?? "").toContain("Enter queues for the next safe point");
  });

  it("shows stopping locally after an interrupt is requested during a running turn", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const rendered = render(<Interactive view={streamingView} onAction={onAction} />);

    rendered.stdin.write(CTRL_C);
    await tick();

    expect(onAction).toHaveBeenCalledWith({ kind: "interrupt" });
    expect(rendered.lastFrame() ?? "").toContain("stopping");
    expect(rendered.lastFrame() ?? "").toContain("reaching a safe stop");
  });

  it("shows the idle exit promise only after the controller arms the matching predicate", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const rendered = render(
      <Interactive view={{ ...view, awaitingInput: true }} onAction={onAction} />,
    );

    rendered.stdin.write(CTRL_C);
    await tick();

    expect(onAction).toHaveBeenCalledWith({ kind: "interrupt" });
    expect(rendered.lastFrame() ?? "").not.toContain("quit armed");
    expect(rendered.lastFrame() ?? "").not.toContain("Ctrl-C again exits");

    rendered.rerender(
      <Interactive view={{ ...view, awaitingInput: true, exitArmed: true }} onAction={onAction} />,
    );
    await tick();

    expect(rendered.lastFrame() ?? "").toContain("quit armed");
    expect(rendered.lastFrame() ?? "").toContain("Ctrl-C again exits");
  });
});
