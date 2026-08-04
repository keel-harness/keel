/* @jsxRuntime automatic @jsxImportSource react */
// tsx (`pnpm keel`) ignores tsconfig `jsx:"react-jsx"` → force React's automatic JSX runtime so Ink
// renders without a React import (else "React is not defined"). No-op under tsc/vitest. Keep on every Ink .tsx.
import { render, type RenderOptions } from "ink";
import type { UIPort, UserInput, ViewModel } from "@keel/shared";
import type { InputQueue } from "../../cli/input-queue.js";
import { OVERLAY_DISMISS, OverlayDismissRegistry } from "../overlay-dismiss.js";
import { LOCAL_INPUT_ACTIVITY, LocalInputActivityRegistry } from "../input-activity.js";
import type { InputState } from "../input.js";
import {
  TERMINAL_CONTROL,
  TERMINAL_SUSPEND_REQUEST,
  TerminalSuspendRequestRegistry,
} from "../terminal-control.js";
import { Interactive } from "./interactive.js";
import {
  DIFF_VIEWER_CONTROL,
  DiffViewerControlRegistry,
  type DiffViewerOpenResult,
} from "../diff-viewer-control.js";
import {
  collectDiffViewerFiles,
  hasDiffViewerEvidence,
  type DiffViewerState,
} from "../diff-viewer.js";
import { PURPOSEFUL_LIVENESS } from "../purposeful-liveness.js";
import { INPUT_HISTORY_SEED } from "../input-history.js";

/** Keel owns Ctrl-C so the first idle press can warn and the second can exit. */
export const KEEL_INK_RENDER_OPTIONS = {
  exitOnCtrlC: false,
} as const satisfies RenderOptions;

/**
 * Interactive `UIPort` backed by Ink. Holds the Ink render instance and re-renders the interactive
 * shell on each view change; the shell's `InputBar` pushes user actions into the `InputQueue`, which
 * `inputs()` exposes to the runner. Touches the real terminal, so it is coverage-exempt (ADR-0003)
 * while the components it renders are snapshot-tested via ink-testing-library.
 */
export class InkUI implements UIPort {
  readonly [PURPOSEFUL_LIVENESS] = true;
  #instance: ReturnType<typeof render> | undefined;
  #latestView: ViewModel | undefined;
  #composerState: InputState | undefined;
  #initialInputHistory: readonly string[] = [];
  #approvalState: InputState | undefined;
  #diffViewerState: DiffViewerState | undefined;
  #suspended = false;
  #suspendInFlight: Promise<void> | undefined;
  #resumeRequested = false;
  #closed = false;
  readonly #queue: InputQueue;
  /** Trust-gated `@file` completer (Epic 1.23 slice 5), if wired by the entrypoint. */
  readonly #complete: ((query: string) => readonly string[]) | undefined;
  /** External editor hook for Ctrl-G composer editing. */
  readonly #editDraft: ((draft: string) => Promise<string | undefined>) | undefined;
  /** Show the seeded system preamble in the transcript (default false — hide scaffolding). */
  readonly #verbose: boolean;
  readonly #overlayDismiss = new OverlayDismissRegistry();
  readonly #localInputActivity = new LocalInputActivityRegistry();
  readonly #terminalSuspendRequest = new TerminalSuspendRequestRegistry();
  readonly #diffViewerControl = new DiffViewerControlRegistry();
  readonly #dismissOverlay = (): void => this.#overlayDismiss.dismiss();
  readonly #notifyLocalInput = (): void => this.#localInputActivity.notify();
  readonly #requestTerminalSuspend = (): void => this.#terminalSuspendRequest.request();
  readonly #connectDiffViewer = (
    open: () => Exclude<DiffViewerOpenResult, "unsupported">,
  ): (() => void) => this.#diffViewerControl.connect(open);
  readonly #rememberComposerState = (state: InputState): void => {
    this.#composerState = state;
  };
  readonly #rememberApprovalState = (state: InputState | undefined): void => {
    this.#approvalState = state;
  };
  readonly #rememberDiffViewerState = (state: DiffViewerState | undefined): void => {
    this.#diffViewerState = state;
  };
  readonly [OVERLAY_DISMISS] = (handler: () => void): (() => void) =>
    this.#overlayDismiss.connect(handler);
  readonly [LOCAL_INPUT_ACTIVITY] = (handler: () => void): (() => void) =>
    this.#localInputActivity.connect(handler);
  readonly [TERMINAL_SUSPEND_REQUEST] = (handler: () => void): (() => void) =>
    this.#terminalSuspendRequest.connect(handler);
  readonly [TERMINAL_CONTROL] = {
    suspend: async (): Promise<void> => this.#suspend(),
    resume: (): void => this.#resume(),
  };
  readonly [DIFF_VIEWER_CONTROL] = (): DiffViewerOpenResult => this.#diffViewerControl.open();
  readonly [INPUT_HISTORY_SEED] = (history: readonly string[]): void => {
    // Resume wiring runs before the first render. Never let a late seed overwrite a live or dormant
    // draft if a forker calls the optional sidecar out of order.
    if (this.#latestView === undefined && this.#composerState === undefined) {
      this.#initialInputHistory = [...history];
    }
  };

  constructor(
    queue: InputQueue,
    complete?: (query: string) => readonly string[],
    verbose = false,
    editDraft?: (draft: string) => Promise<string | undefined>,
  ) {
    this.#queue = queue;
    this.#complete = complete;
    this.#editDraft = editDraft;
    this.#verbose = verbose;
  }

  render(view: ViewModel): void {
    if (this.#closed) return;
    if (view.activeApproval === undefined) this.#approvalState = undefined;
    const diffViewerCollection = collectDiffViewerFiles(view.items, view.turnSummary);
    if (
      this.#diffViewerState !== undefined &&
      (view.awaitingInput !== true ||
        view.currentTurn !== undefined ||
        view.streaming ||
        view.items.some((item) => item.kind === "tool" && item.status === "running") ||
        view.activeApproval !== undefined ||
        view.overlay !== undefined ||
        !hasDiffViewerEvidence(diffViewerCollection))
    ) {
      this.#diffViewerState = undefined;
    }
    this.#latestView = view;
    if (this.#suspended) return;
    const el = this.#element(view);
    if (this.#instance === undefined) {
      this.#instance = render(el, KEEL_INK_RENDER_OPTIONS);
    } else {
      this.#instance.rerender(el);
    }
  }

  #element(view: ViewModel): React.JSX.Element {
    const el = (
      <Interactive
        view={view}
        onAction={(a) => this.#queue.push(a)}
        onDismissOverlay={this.#dismissOverlay}
        onLocalInteraction={this.#notifyLocalInput}
        onSuspendRequest={this.#requestTerminalSuspend}
        onComposerState={this.#rememberComposerState}
        onApprovalState={this.#rememberApprovalState}
        connectDiffViewer={this.#connectDiffViewer}
        onDiffViewerState={this.#rememberDiffViewerState}
        initialInputHistory={this.#initialInputHistory}
        {...(this.#composerState === undefined
          ? {}
          : { initialComposerState: this.#composerState })}
        {...(this.#approvalState === undefined
          ? {}
          : { initialApprovalState: this.#approvalState })}
        {...(this.#diffViewerState === undefined
          ? {}
          : { initialDiffViewerState: this.#diffViewerState })}
        verbose={this.#verbose}
        {...(this.#complete !== undefined ? { complete: this.#complete } : {})}
        {...(this.#editDraft !== undefined ? { editDraft: this.#editDraft } : {})}
      />
    );
    return el;
  }

  #suspend(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#suspendInFlight !== undefined) {
      // A second suspend before cleanup settles supersedes an early SIGCONT/remount request.
      this.#resumeRequested = false;
      this.#suspended = true;
      return this.#suspendInFlight;
    }
    if (this.#suspended) return Promise.resolve();
    this.#suspended = true;
    this.#resumeRequested = false;
    const suspension = this.#releaseForSuspension();
    this.#suspendInFlight = suspension;
    const clear = (): void => {
      if (this.#suspendInFlight !== suspension) return;
      this.#suspendInFlight = undefined;
      if (this.#resumeRequested && !this.#closed) {
        this.#resumeRequested = false;
        this.#suspended = false;
        if (this.#latestView !== undefined) this.render(this.#latestView);
      }
    };
    void suspension.then(clear, clear);
    return suspension;
  }

  async #releaseForSuspension(): Promise<void> {
    const instance = this.#instance;
    try {
      instance?.unmount();
      this.#instance = undefined;
      await instance?.waitUntilExit();
    } catch (error) {
      // A failed release must not leave a still-running process with a permanently dormant UI.
      // Preserve an instance whose unmount itself failed; otherwise rebuild from the newest view.
      if (!this.#closed) {
        this.#resumeRequested = false;
        this.#suspended = false;
        if (this.#instance === undefined && this.#latestView !== undefined) {
          this.render(this.#latestView);
        }
      }
      throw error;
    }
  }

  #resume(): void {
    if (this.#closed || !this.#suspended) return;
    if (this.#suspendInFlight !== undefined) {
      this.#resumeRequested = true;
      return;
    }
    this.#resumeRequested = false;
    this.#suspended = false;
    if (this.#latestView !== undefined) this.render(this.#latestView);
  }

  inputs(): AsyncIterable<UserInput> {
    return this.#queue;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.close();
    const suspension = this.#suspendInFlight;
    const instance = this.#instance;
    this.#instance = undefined;
    instance?.unmount();
    await instance?.waitUntilExit();
    await suspension;
  }
}
