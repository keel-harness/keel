import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewModel } from "@keel/shared";
import { InputQueue } from "../../cli/input-queue.js";
import { firstRunView } from "../view-model.js";
import { connectOverlayDismiss } from "../overlay-dismiss.js";
import { connectLocalInputActivity } from "../input-activity.js";
import {
  connectTerminalSuspendRequest,
  resumeTerminal,
  suspendTerminal,
} from "../terminal-control.js";
import type { InputState } from "../input.js";
import type { DiffViewerState } from "../diff-viewer.js";
import { KEEL_INK_RENDER_OPTIONS } from "./ink-ui.js";
import { InkUI } from "./ink-ui.js";
import { supportsPurposefulLiveness } from "../purposeful-liveness.js";
import { seedInputHistory } from "../input-history.js";

const ink = vi.hoisted(() => ({
  render: vi.fn(() => ({
    rerender: vi.fn(),
    unmount: vi.fn(),
    waitUntilExit: vi.fn(() => Promise.resolve()),
  })),
}));

vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ink")>()),
  render: ink.render,
}));

describe("InkUI render ownership", () => {
  beforeEach(() => ink.render.mockClear());

  it("leaves Ctrl-C handling to Keel's two-press interrupt policy", () => {
    new InkUI(new InputQueue()).render(firstRunView());

    expect(KEEL_INK_RENDER_OPTIONS.exitOnCtrlC).toBe(false);
    expect(ink.render).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ exitOnCtrlC: false }),
    );
  });

  it("opts the production interactive port into controller-driven purposeful liveness", () => {
    expect(supportsPurposefulLiveness(new InkUI(new InputQueue()))).toBe(true);
  });

  it("threads a resume-only history seed to the first composer without emitting input", () => {
    const queue = new InputQueue();
    const ui = new InkUI(queue);
    seedInputHistory(ui, ["earlier task", "latest task"]);

    ui.render(firstRunView());

    const element = (ink.render.mock.calls as unknown[][])[0]?.[0] as
      | { readonly props?: { readonly initialInputHistory?: readonly string[] } }
      | undefined;
    expect(element?.props?.initialInputHistory).toEqual(["earlier task", "latest task"]);
  });

  it("ignores a late history seed instead of overwriting an active composer's recall state", () => {
    const ui = new InkUI(new InputQueue());
    seedInputHistory(ui, ["durable task"]);
    ui.render(firstRunView());

    seedInputHistory(ui, ["late replacement"]);
    ui.render({ ...firstRunView(), awaitingInput: true });

    const instance = ink.render.mock.results[0]?.value as
      | { readonly rerender: ReturnType<typeof vi.fn> }
      | undefined;
    const element = instance?.rerender.mock.calls.at(-1)?.[0] as
      | { readonly props?: { readonly initialInputHistory?: readonly string[] } }
      | undefined;
    expect(element?.props?.initialInputHistory).toEqual(["durable task"]);
  });

  it("routes overlay dismissal to the newest controller owner and restores the prior owner", () => {
    const ui = new InkUI(new InputQueue());
    const idleOwner = vi.fn();
    const activeOwner = vi.fn();
    const disconnectIdle = connectOverlayDismiss(ui, idleOwner);
    const disconnectActive = connectOverlayDismiss(ui, activeOwner);

    ui.render(firstRunView());
    const renderCall = (ink.render.mock.calls as unknown[][])[0];
    const element = renderCall?.[0] as
      | { readonly props?: { readonly onDismissOverlay?: () => void } }
      | undefined;
    expect(element?.props?.onDismissOverlay).toBeTypeOf("function");

    element?.props?.onDismissOverlay?.();
    expect(activeOwner).toHaveBeenCalledTimes(1);
    expect(idleOwner).not.toHaveBeenCalled();

    disconnectActive();
    element?.props?.onDismissOverlay?.();
    expect(activeOwner).toHaveBeenCalledTimes(1);
    expect(idleOwner).toHaveBeenCalledTimes(1);

    disconnectIdle();
    element?.props?.onDismissOverlay?.();
    expect(idleOwner).toHaveBeenCalledTimes(1);
  });

  it("routes local composer activity to the newest controller owner", () => {
    const ui = new InkUI(new InputQueue());
    const idleOwner = vi.fn();
    const nestedOwner = vi.fn();
    const disconnectIdle = connectLocalInputActivity(ui, idleOwner);
    const disconnectNested = connectLocalInputActivity(ui, nestedOwner);

    ui.render(firstRunView());
    const renderCall = (ink.render.mock.calls as unknown[][])[0];
    const element = renderCall?.[0] as
      | { readonly props?: { readonly onLocalInteraction?: () => void } }
      | undefined;
    element?.props?.onLocalInteraction?.();
    expect(nestedOwner).toHaveBeenCalledTimes(1);
    expect(idleOwner).not.toHaveBeenCalled();

    disconnectNested();
    element?.props?.onLocalInteraction?.();
    expect(idleOwner).toHaveBeenCalledTimes(1);
    disconnectIdle();
  });

  it("routes the raw-mode suspend callback to the active terminal lifecycle owner", () => {
    const ui = new InkUI(new InputQueue());
    const owner = vi.fn();
    const disconnect = connectTerminalSuspendRequest(ui, owner);

    ui.render(firstRunView());
    const renderCall = (ink.render.mock.calls as unknown[][])[0];
    const element = renderCall?.[0] as
      | { readonly props?: { readonly onSuspendRequest?: () => void } }
      | undefined;
    element?.props?.onSuspendRequest?.();

    expect(owner).toHaveBeenCalledTimes(1);
    disconnect();
  });

  it("unmounts for suspension and remounts the latest view with the exact dormant draft", async () => {
    const ui = new InkUI(new InputQueue());
    const initial = firstRunView();
    ui.render(initial);
    const firstCall = (ink.render.mock.calls as unknown[][])[0];
    const firstElement = firstCall?.[0] as
      | { readonly props?: { readonly onComposerState?: (state: InputState) => void } }
      | undefined;
    const draft: InputState = {
      buffer: "line one\n👩🏽‍💻 line two",
      cursor: 10,
      history: ["older"],
      histIndex: null,
      kill: "kept-ring",
    };
    firstElement?.props?.onComposerState?.(draft);

    await suspendTerminal(ui);
    const firstInstance = ink.render.mock.results[0]?.value as
      | { readonly unmount: ReturnType<typeof vi.fn> }
      | undefined;
    expect(firstInstance?.unmount).toHaveBeenCalledTimes(1);

    const latest = { ...initial, awaitingInput: true };
    ui.render(latest);
    resumeTerminal(ui);

    expect(ink.render).toHaveBeenCalledTimes(2);
    const resumedCall = (ink.render.mock.calls as unknown[][])[1];
    const resumedElement = resumedCall?.[0] as
      | {
          readonly props?: {
            readonly view?: ViewModel;
            readonly initialComposerState?: InputState;
          };
        }
      | undefined;
    expect(resumedElement?.props?.view).toBe(latest);
    expect(resumedElement?.props?.initialComposerState).toEqual(draft);
  });

  it("remounts the exact process-local diff selection only while its artifacts remain available", async () => {
    const ui = new InkUI(new InputQueue());
    const initial: ViewModel = {
      ...firstRunView(),
      awaitingInput: true,
      items: [
        {
          kind: "tool",
          id: "a",
          name: "edit",
          status: "ok",
          summary: "a.ts",
          diff: [
            { kind: "del", text: "a", hunkStart: true },
            { kind: "add", text: "A" },
          ],
        },
        {
          kind: "tool",
          id: "b",
          name: "edit",
          status: "ok",
          summary: "b.ts",
          diff: [
            { kind: "del", text: "b", hunkStart: true },
            { kind: "add", text: "B" },
          ],
        },
      ],
    };
    ui.render(initial);
    const firstCall = (ink.render.mock.calls as unknown[][])[0];
    const firstElement = firstCall?.[0] as
      | {
          readonly props?: {
            readonly onDiffViewerState?: (state: DiffViewerState | undefined) => void;
          };
        }
      | undefined;
    const selection: DiffViewerState = {
      fileIndex: 1,
      files: [
        {
          occurrenceKey: "0:a",
          selectedLine: 2,
          selectedHunk: 0,
          selectedChange: 0,
          collapsedHunks: [],
        },
        {
          occurrenceKey: "1:b",
          selectedLine: 8,
          selectedHunk: 2,
          selectedChange: 3,
          collapsedHunks: [0, 1],
        },
      ],
    };
    firstElement?.props?.onDiffViewerState?.(selection);

    await suspendTerminal(ui);
    resumeTerminal(ui);

    const resumedCall = (ink.render.mock.calls as unknown[][])[1];
    const resumedElement = resumedCall?.[0] as
      | { readonly props?: { readonly initialDiffViewerState?: DiffViewerState } }
      | undefined;
    expect(resumedElement?.props?.initialDiffViewerState).toEqual(selection);
  });

  it("clears process-local diff selection when artifacts disappear or a turn starts", () => {
    const ui = new InkUI(new InputQueue());
    const withDiff: ViewModel = {
      ...firstRunView(),
      awaitingInput: true,
      items: [
        {
          kind: "tool",
          id: "edit-a",
          name: "edit",
          status: "ok",
          summary: "a.ts",
          diff: [
            { kind: "del", text: "a", hunkStart: true },
            { kind: "add", text: "A" },
          ],
        },
      ],
    };
    ui.render(withDiff);
    const firstElement = (ink.render.mock.calls as unknown[][])[0]?.[0] as
      | {
          readonly props?: {
            readonly onDiffViewerState?: (state: DiffViewerState | undefined) => void;
          };
        }
      | undefined;
    const selection: DiffViewerState = {
      fileIndex: 0,
      files: [
        {
          occurrenceKey: "0:edit-a",
          selectedLine: 1,
          selectedHunk: 0,
          selectedChange: 0,
          collapsedHunks: [],
        },
      ],
    };
    firstElement?.props?.onDiffViewerState?.(selection);

    ui.render({ ...withDiff, items: [] });

    const instance = ink.render.mock.results[0]?.value as
      | { readonly rerender: ReturnType<typeof vi.fn> }
      | undefined;
    const clearedElement = instance?.rerender.mock.calls.at(-1)?.[0] as
      | { readonly props?: { readonly initialDiffViewerState?: DiffViewerState } }
      | undefined;
    expect(clearedElement?.props?.initialDiffViewerState).toBeUndefined();

    firstElement?.props?.onDiffViewerState?.(selection);
    ui.render({
      ...withDiff,
      currentTurn: {
        doing: "waiting for assistant",
        why: "a new turn owns focus",
        next: "provider output",
      },
    });
    const activeElement = instance?.rerender.mock.calls.at(-1)?.[0] as
      | { readonly props?: { readonly initialDiffViewerState?: DiffViewerState } }
      | undefined;
    expect(activeElement?.props?.initialDiffViewerState).toBeUndefined();
  });

  it("remounts composer and partial approval snapshots independently and clears settled approval input", async () => {
    const ui = new InkUI(new InputQueue());
    const approvalView: ViewModel = {
      ...firstRunView(),
      activeApproval: {
        detail: "command review requires approval: pnpm test",
        sessionAvailable: true,
        state: "pending",
      },
    };
    ui.render(approvalView);
    const firstCall = (ink.render.mock.calls as unknown[][])[0];
    const firstElement = firstCall?.[0] as
      | {
          readonly props?: {
            readonly onComposerState?: (state: InputState) => void;
            readonly onApprovalState?: (state: InputState | undefined) => void;
          };
        }
      | undefined;
    const composer: InputState = {
      buffer: "queued draft",
      cursor: 12,
      history: [],
      histIndex: null,
      kill: "",
    };
    const approval: InputState = {
      buffer: "a",
      cursor: 1,
      history: [],
      histIndex: null,
      kill: "",
    };
    firstElement?.props?.onComposerState?.(composer);
    firstElement?.props?.onApprovalState?.(approval);

    await suspendTerminal(ui);
    resumeTerminal(ui);

    const resumedCall = (ink.render.mock.calls as unknown[][])[1];
    const resumedElement = resumedCall?.[0] as
      | {
          readonly props?: {
            readonly initialComposerState?: InputState;
            readonly initialApprovalState?: InputState;
          };
        }
      | undefined;
    expect(resumedElement?.props?.initialComposerState).toEqual(composer);
    expect(resumedElement?.props?.initialApprovalState).toEqual(approval);

    ui.render(firstRunView());
    ui.render({ ...approvalView, activeApproval: { ...approvalView.activeApproval! } });
    const resumedInstance = ink.render.mock.results[1]?.value as
      | { readonly rerender: ReturnType<typeof vi.fn> }
      | undefined;
    const nextApprovalElement = resumedInstance?.rerender.mock.calls.at(-1)?.[0] as
      | { readonly props?: { readonly initialApprovalState?: InputState } }
      | undefined;
    expect(nextApprovalElement?.props?.initialApprovalState).toBeUndefined();
  });

  it("restores the latest view when suspension cleanup fails before the process stops", async () => {
    let rejectExit!: (error: Error) => void;
    const failedInstance = {
      rerender: vi.fn(),
      unmount: vi.fn(),
      waitUntilExit: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectExit = reject;
          }),
      ),
    };
    ink.render.mockReturnValueOnce(failedInstance);
    const ui = new InkUI(new InputQueue());
    const initial = firstRunView();
    const latest = { ...initial, awaitingInput: true };
    ui.render(initial);

    const suspension = suspendTerminal(ui);
    ui.render(latest);
    rejectExit(new Error("terminal release failed"));

    await expect(suspension).rejects.toThrow("terminal release failed");
    expect(ink.render).toHaveBeenCalledTimes(2);
    const restoredCall = (ink.render.mock.calls as unknown[][])[1];
    const restoredElement = restoredCall?.[0] as
      | { readonly props?: { readonly view?: ViewModel } }
      | undefined;
    expect(restoredElement?.props?.view).toBe(latest);
  });

  it("waits for in-flight suspension cleanup when terminal shutdown supersedes it", async () => {
    let releaseExit!: () => void;
    const pendingInstance = {
      rerender: vi.fn(),
      unmount: vi.fn(),
      waitUntilExit: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseExit = resolve;
          }),
      ),
    };
    ink.render.mockReturnValueOnce(pendingInstance);
    const queue = new InputQueue();
    const ui = new InkUI(queue);
    ui.render(firstRunView());

    const suspension = suspendTerminal(ui);
    let closeSettled = false;
    const closing = ui.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(closeSettled).toBe(false);
    releaseExit();
    await expect(Promise.all([suspension, closing])).resolves.toEqual([undefined, undefined]);
    expect(pendingInstance.unmount).toHaveBeenCalledTimes(1);
    expect(await queue.next()).toEqual({ value: undefined, done: true });
  });

  it("defers an early resume until the in-flight renderer cleanup settles", async () => {
    let releaseExit!: () => void;
    const pendingInstance = {
      rerender: vi.fn(),
      unmount: vi.fn(),
      waitUntilExit: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseExit = resolve;
          }),
      ),
    };
    ink.render.mockReturnValueOnce(pendingInstance);
    const ui = new InkUI(new InputQueue());
    ui.render(firstRunView());

    const suspension = suspendTerminal(ui);
    resumeTerminal(ui);
    expect(ink.render).toHaveBeenCalledTimes(1);

    releaseExit();
    await suspension;
    await Promise.resolve();
    expect(ink.render).toHaveBeenCalledTimes(2);
  });

  it("lets a repeated suspend cancel an early pending resume without remounting raw mode", async () => {
    let releaseExit!: () => void;
    const pendingInstance = {
      rerender: vi.fn(),
      unmount: vi.fn(),
      waitUntilExit: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseExit = resolve;
          }),
      ),
    };
    ink.render.mockReturnValueOnce(pendingInstance);
    const ui = new InkUI(new InputQueue());
    ui.render(firstRunView());

    const firstSuspension = suspendTerminal(ui);
    resumeTerminal(ui);
    const secondSuspension = suspendTerminal(ui);
    releaseExit();
    await Promise.all([firstSuspension, secondSuspension]);
    await Promise.resolve();

    expect(ink.render).toHaveBeenCalledTimes(1);
    resumeTerminal(ui);
    expect(ink.render).toHaveBeenCalledTimes(2);
  });

  it("makes repeated suspension and close-while-suspended idempotent and prevents resurrection", async () => {
    const queue = new InputQueue();
    const ui = new InkUI(queue);
    ui.render(firstRunView());
    const firstInstance = ink.render.mock.results[0]?.value as
      | {
          readonly unmount: ReturnType<typeof vi.fn>;
          readonly waitUntilExit: ReturnType<typeof vi.fn>;
        }
      | undefined;

    await suspendTerminal(ui);
    await suspendTerminal(ui);
    expect(firstInstance?.unmount).toHaveBeenCalledTimes(1);
    expect(firstInstance?.waitUntilExit).toHaveBeenCalledTimes(1);

    await ui.close();
    resumeTerminal(ui);
    ui.render({ ...firstRunView(), awaitingInput: true });

    expect(ink.render).toHaveBeenCalledTimes(1);
    expect(await queue.next()).toEqual({ value: undefined, done: true });
  });
});
