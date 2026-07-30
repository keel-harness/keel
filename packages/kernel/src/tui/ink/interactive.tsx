/* @jsxRuntime automatic @jsxImportSource react */
// tsx (`pnpm keel`) ignores tsconfig `jsx:"react-jsx"` → force React's automatic JSX runtime so Ink
// renders without a React import (else "React is not defined"). No-op under tsc/vitest. Keep on every Ink .tsx.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box } from "ink";
import type { Overlay, UserInput, ViewModel } from "@keel/shared";
import {
  AppWithTerminalSize,
  overlayRowBudget,
  overlayScrollLimitForViewport,
  useTerminalSize,
} from "./app.js";
import { InputBar, type OverlayNavigation } from "./input-bar.js";
import { activeReviewIsActionable } from "../view-model.js";
import type { InputState } from "../input.js";
import { withOverlayPresentation } from "../overlay-presentation.js";
import type { DiffViewerOpenResult } from "../diff-viewer-control.js";
import {
  collectDiffViewerFiles,
  initialDiffViewerState,
  normalizeDiffViewerState,
  reduceDiffViewer,
  type DiffViewerAction,
  type DiffViewerState,
} from "../diff-viewer.js";
import { DiffViewer } from "./diff-viewer.js";

type InputMode = "composer" | "approval";

interface LocalInputPresentation {
  readonly generation: number;
  readonly overlay?: Overlay;
}

interface OverlayScrollState {
  readonly key: string;
  readonly offset: number;
}

function overlayScrollKey(overlay: Overlay | undefined): string | undefined {
  if (overlay?.kind === "panel") return `panel:${overlay.content}`;
  if (overlay?.kind === "help") return "help";
  return undefined;
}

function dormantComposerState(state: InputState): InputState {
  const paletteOpen = state.overlay?.kind === "palette";
  return {
    buffer: paletteOpen ? "" : state.buffer,
    cursor: paletteOpen ? 0 : state.cursor,
    history: state.history,
    histIndex: paletteOpen ? null : state.histIndex,
    kill: state.kill,
    ...(state.draft === undefined ? {} : { draft: state.draft }),
    ...(state.draftCursor === undefined ? {} : { draftCursor: state.draftCursor }),
  };
}

/**
 * The interactive shell: the conversation/HUD (`App`, driven by the runner's `ViewModel`) above the
 * live `InputBar`. Two update paths coexist — the runner re-renders with new `view`s as the loop
 * runs; the InputBar owns its own buffer/overlay locally and reports the current discoverability
 * overlay via `onState`, which is merged into the rendered view so the `/` palette and `?` help show
 * live as the user types. Submitted/urgent/interrupt actions flow out through `onAction` (→ the
 * `InputQueue`, → the runner). Coverage-exempt (ADR-0003); covered via ink-testing-library.
 */
export function Interactive({
  view,
  onAction,
  complete,
  editDraft,
  onDismissOverlay,
  onLocalInteraction,
  onSuspendRequest,
  initialComposerState,
  onComposerState,
  initialApprovalState,
  onApprovalState,
  connectDiffViewer,
  initialDiffViewerState: restoredDiffViewerState,
  onDiffViewerState,
  verbose = false,
}: {
  view: ViewModel;
  onAction: (action: UserInput) => void;
  /** Trust-gated `@file` completer (Epic 1.23 slice 5), threaded to the InputBar. */
  complete?: (query: string) => readonly string[];
  /** Optional external-editor hook for Ctrl-G composer editing. */
  editDraft?: (draft: string) => Promise<string | undefined>;
  /** Dismiss the controller-owned overlay locally before an optional active-turn interrupt. */
  onDismissOverlay?: () => void;
  /** Notify the controller about a non-interrupt key handled entirely inside Ink. */
  onLocalInteraction?: () => void;
  /** Request host job-control suspension from a raw-mode Ctrl-Z key. */
  onSuspendRequest?: () => void;
  /** Exact dormant composer state to restore after the terminal renderer remounts. */
  initialComposerState?: InputState;
  /** Persist the exact dormant composer state outside the renderer before a possible suspension. */
  onComposerState?: (state: InputState) => void;
  /** Exact partial approval decision to restore after the terminal renderer remounts. */
  initialApprovalState?: InputState;
  /** Persist or clear partial approval input outside the renderer before a possible suspension. */
  onApprovalState?: (state: InputState | undefined) => void;
  /** Connect the renderer-private idle viewer entrypoint; never widens `UIPort`. */
  connectDiffViewer?: (open: () => Exclude<DiffViewerOpenResult, "unsupported">) => () => void;
  /** Process-local focus coordinates restored only against matching occurrence ids. */
  initialDiffViewerState?: DiffViewerState;
  /** Persist or clear process-local viewer focus across terminal remounts. */
  onDiffViewerState?: (state: DiffViewerState | undefined) => void;
  /** Show the seeded system preamble in the transcript (default false — interactive hides scaffolding). */
  verbose?: boolean;
}): React.JSX.Element {
  const terminalSize = useTerminalSize();
  const inputMode: InputMode = view.activeApproval === undefined ? "composer" : "approval";
  const previousInputMode = useRef<InputMode>(inputMode);
  const inputGeneration = useRef(0);
  if (previousInputMode.current !== inputMode) {
    previousInputMode.current = inputMode;
    inputGeneration.current += 1;
  }
  const generation = inputGeneration.current;
  const [localInput, setLocalInput] = useState<LocalInputPresentation>(() => {
    const overlay = inputMode === "composer" ? initialComposerState?.overlay : undefined;
    return {
      generation,
      ...(overlay === undefined
        ? {}
        : {
            overlay:
              initialComposerState?.selection === undefined
                ? overlay
                : withOverlayPresentation(overlay, { selected: initialComposerState.selection }),
          }),
    };
  });
  const [stopping, setStopping] = useState(false);
  const submittedPaletteFromView = useRef<ViewModel | undefined>(undefined);
  const [inputResetVersion, setInputResetVersion] = useState(0);
  const [overlayScroll, setOverlayScroll] = useState<OverlayScrollState>({ key: "", offset: 0 });
  const composerInput = useRef<InputState | undefined>(
    inputMode === "approval" && initialComposerState !== undefined
      ? dormantComposerState(initialComposerState)
      : initialComposerState,
  );
  const approvalInput = useRef<InputState | undefined>(initialApprovalState);
  const running =
    view.awaitingInput === false ||
    view.currentTurn !== undefined ||
    view.streaming ||
    view.items.some((item) => item.kind === "tool" && item.status === "running");
  const foregroundPanel =
    view.activeApproval === undefined &&
    (view.overlay?.kind === "panel" || view.overlay?.kind === "help");
  const viewerMayOwnFocus =
    view.awaitingInput === true &&
    !running &&
    view.activeApproval === undefined &&
    view.overlay === undefined;
  const viewerCollection = useMemo(
    () => (viewerMayOwnFocus ? collectDiffViewerFiles(view.items) : { files: [], hiddenFiles: 0 }),
    [view.items, viewerMayOwnFocus],
  );
  const [diffViewerState, setDiffViewerState] = useState<DiffViewerState | undefined>(() =>
    restoredDiffViewerState === undefined || viewerCollection.files.length === 0
      ? undefined
      : normalizeDiffViewerState(viewerCollection.files, restoredDiffViewerState),
  );
  // Authority-bearing or controller-owned focus wins in the render that introduces it. The effect
  // below settles stored viewer state, but raw keys must not spend even one commit on stale focus.
  const diffViewerActive =
    diffViewerState !== undefined && viewerMayOwnFocus && viewerCollection.files.length > 0;
  const closeDiffViewer = useCallback((): void => {
    setDiffViewerState(undefined);
    onDiffViewerState?.(undefined);
  }, [onDiffViewerState]);
  const openDiffViewer = useCallback((): Exclude<DiffViewerOpenResult, "unsupported"> => {
    if (!viewerMayOwnFocus) return "not-settled";
    if (viewerCollection.files.length === 0) return "no-diffs";
    const next = normalizeDiffViewerState(
      viewerCollection.files,
      diffViewerState ?? initialDiffViewerState(viewerCollection.files),
    );
    // A palette-submitted `/diff review` is complete now; do not resurrect its local palette after
    // viewer close merely because the controller intentionally did not render a transcript notice.
    submittedPaletteFromView.current = undefined;
    setLocalInput({ generation });
    setDiffViewerState(next);
    onDiffViewerState?.(next);
    return "opened";
  }, [diffViewerState, generation, onDiffViewerState, viewerCollection.files, viewerMayOwnFocus]);
  useEffect(() => connectDiffViewer?.(openDiffViewer), [connectDiffViewer, openDiffViewer]);
  useEffect(() => {
    if (diffViewerState === undefined) return;
    if (!viewerMayOwnFocus || viewerCollection.files.length === 0) closeDiffViewer();
  }, [closeDiffViewer, diffViewerState, viewerCollection.files.length, viewerMayOwnFocus]);
  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);
  useEffect(() => {
    // Approval replaces the local composer. Publish its non-authority dormant state so a terminal
    // suspend/remount cannot resurrect a palette that lost focus before suspension.
    if (inputMode === "approval" && composerInput.current !== undefined) {
      onComposerState?.(composerInput.current);
    } else if (inputMode === "composer" && approvalInput.current !== undefined) {
      approvalInput.current = undefined;
      onApprovalState?.(undefined);
    }
  }, [inputMode, onApprovalState, onComposerState]);
  useEffect(() => {
    if (
      submittedPaletteFromView.current !== undefined &&
      view !== submittedPaletteFromView.current
    ) {
      submittedPaletteFromView.current = undefined;
      setLocalInput({ generation });
      setInputResetVersion((version) => version + 1);
    }
  }, [generation, view]);
  const ownedOverlay = localInput.generation === generation ? localInput.overlay : undefined;
  const handleAction = (action: UserInput): void => {
    if (action.kind === "interrupt" && running && !foregroundPanel) setStopping(true);
    if (action.kind === "command" && ownedOverlay?.kind === "palette") {
      submittedPaletteFromView.current = view;
    }
    onAction(action);
  };
  const localOverlay =
    view.activeApproval !== undefined ||
    (submittedPaletteFromView.current !== undefined && view !== submittedPaletteFromView.current)
      ? undefined
      : ownedOverlay;
  const visibleOverlay = localOverlay ?? view.overlay;
  const scrollKey = overlayScrollKey(visibleOverlay);
  const overlayRows = overlayRowBudget(view, terminalSize);
  const scrollLimit =
    visibleOverlay === undefined
      ? 0
      : overlayScrollLimitForViewport(visibleOverlay, terminalSize.columns, overlayRows);
  useEffect(() => {
    setOverlayScroll((previous) => {
      if (scrollKey === undefined) {
        return previous.key === "" && previous.offset === 0 ? previous : { key: "", offset: 0 };
      }
      if (previous.key !== scrollKey) {
        return previous.offset === 0 ? previous : { key: "", offset: 0 };
      }
      const offset = Math.min(previous.offset, scrollLimit);
      return previous.offset === offset ? previous : { key: scrollKey, offset };
    });
  }, [scrollKey, scrollLimit]);
  const scrollOffset =
    scrollKey !== undefined && overlayScroll.key === scrollKey
      ? Math.min(overlayScroll.offset, scrollLimit)
      : 0;
  const presentedOverlay =
    visibleOverlay !== undefined && scrollOffset > 0
      ? withOverlayPresentation(visibleOverlay, { offset: scrollOffset })
      : visibleOverlay;
  const merged: ViewModel =
    presentedOverlay !== undefined &&
    (localOverlay !== undefined || presentedOverlay !== view.overlay)
      ? { ...view, overlay: presentedOverlay }
      : view;
  const handleOverlayNavigation = (navigation: OverlayNavigation): void => {
    if (visibleOverlay === undefined || scrollKey === undefined) return;
    const delta =
      navigation === "up" ? -1 : navigation === "down" ? 1 : navigation === "page-up" ? -8 : 8;
    setOverlayScroll((previous) => {
      const current = previous.key === scrollKey ? previous.offset : 0;
      const offset = Math.min(scrollLimit, Math.max(0, current + delta));
      if (current === 0 && offset === 0) return previous;
      return previous.key === scrollKey && previous.offset === offset
        ? previous
        : { key: scrollKey, offset };
    });
  };
  const handleDiffViewerAction = (action: DiffViewerAction): void => {
    setDiffViewerState((current) => {
      if (current === undefined) return current;
      const next = reduceDiffViewer(viewerCollection.files, current, action);
      onDiffViewerState?.(next);
      return next;
    });
  };
  const inputContext = {
    ...(view.awaitingInput === true ? { awaitingInput: true } : {}),
    ...(running ? { running: true } : {}),
    ...(view.activeApproval !== undefined
      ? {
          pendingReview: true,
          reviewActionable: activeReviewIsActionable(view),
          reviewSessionAvailable: view.activeApproval.sessionAvailable,
          reviewState: view.activeApproval.state,
        }
      : {}),
    ...((view.pendingInputs ?? 0) > 0 ? { pendingInputs: view.pendingInputs } : {}),
    ...(stopping ? { stopping: true } : {}),
    ...(view.exitArmed === true ? { exitArmed: true } : {}),
    ...(foregroundPanel ? { foregroundPanel: true } : {}),
  };
  return (
    <Box flexDirection="column">
      <AppWithTerminalSize
        view={merged}
        verbose={verbose}
        showHintFooter={false}
        terminalSize={terminalSize}
      />
      {diffViewerActive ? (
        <DiffViewer
          collection={viewerCollection}
          state={diffViewerState}
          columns={terminalSize.columns}
          rows={overlayRows}
        />
      ) : null}
      <InputBar
        key={`${inputResetVersion}:${inputMode}:${generation}`}
        visible={!diffViewerActive}
        {...(!diffViewerActive
          ? {}
          : {
              diffViewer: {
                onAction: handleDiffViewerAction,
                onClose: closeDiffViewer,
              },
            })}
        onAction={handleAction}
        onState={(s) =>
          setLocalInput({
            generation,
            ...(s.overlay === undefined
              ? {}
              : {
                  overlay:
                    s.selection === undefined
                      ? s.overlay
                      : withOverlayPresentation(s.overlay, { selected: s.selection }),
                }),
          })
        }
        {...(inputMode === "composer"
          ? {
              ...(composerInput.current === undefined
                ? {}
                : { initialState: composerInput.current }),
              onInputState: (state: InputState) => {
                const dormant = dormantComposerState(state);
                composerInput.current = dormant;
                // The outer terminal owner needs the exact local state for a lossless remount.
                // Active-turn palettes suppress this callback in InputBar, leaving their queued
                // draft (the dormant state above) as the last safe suspension snapshot.
                onComposerState?.(state);
              },
            }
          : {
              ...(approvalInput.current === undefined
                ? {}
                : { initialState: approvalInput.current }),
              onInputState: (state: InputState) => {
                approvalInput.current = state;
                onApprovalState?.(state);
              },
            })}
        context={inputContext}
        {...(onDismissOverlay !== undefined ? { onDismissOverlay } : {})}
        {...(onLocalInteraction !== undefined ? { onLocalInteraction } : {})}
        {...(onSuspendRequest !== undefined ? { onSuspendRequest } : {})}
        onNavigateOverlay={handleOverlayNavigation}
        {...(complete !== undefined ? { complete } : {})}
        {...(editDraft !== undefined ? { editDraft } : {})}
      />
    </Box>
  );
}
