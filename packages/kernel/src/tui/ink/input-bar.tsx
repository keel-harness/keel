/* @jsxRuntime automatic @jsxImportSource react */
// tsx (`pnpm keel`) ignores tsconfig `jsx:"react-jsx"` → force React's automatic JSX runtime so Ink
// renders without a React import (else "React is not defined"). No-op under tsc/vitest. Keep on every Ink .tsx.
import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, usePaste, useStdout, type Key as InkKey } from "ink";
import type { UserInput } from "@keel/shared";
import {
  composerBufferPresentation,
  composerPresentation,
  type ComposerContext,
} from "../composer.js";
import { URGENT_VERBS, commandRoute, paletteCommands } from "../commands.js";
import { emptyInput, inputReduce, type InputState, type Key } from "../input.js";
import { THEME } from "../theme.js";
import type { DiffViewerAction } from "../diff-viewer.js";

/** Map Ink's raw key event to a normalized `Key` for the (gated) input reducer. */
function toKey(input: string, key: InkKey): Key | undefined {
  // Multi-line (Epic 1.23 slice 3): Ctrl-J inserts a newline. Detection is terminal-dependent (Ctrl-J
  // is the byte \n, which some terminals report as Enter), so this is best-effort — the GUARANTEED,
  // terminal-agnostic multi-line path is a trailing backslash + Enter (handled in the reducer). Checked
  // before `return` so a terminal that does surface ctrl+j gets a newline rather than a submit.
  if (key.ctrl && input === "j") return { kind: "newline" };
  if (key.return) return { kind: "enter" };
  if (key.escape) return { kind: "escape" };
  if (key.ctrl && input === "c") return { kind: "interrupt" };
  // Ctrl-R: incremental reverse-search over history (Epic 1.23 slice 3b). Checked before the char
  // fallthrough (which excludes ctrl), so a terminal that surfaces Ctrl-R opens the search.
  if (key.ctrl && input === "r") return { kind: "reverse-search" };
  // Readline line editing (Epic 1.23 slice 4a) — cursor motion + kill/yank. All checked before the
  // char fallthrough (which excludes ctrl/meta), so the chord never lands as a literal character.
  if (key.leftArrow) return { kind: "left" };
  if (key.rightArrow) return { kind: "right" };
  if (key.ctrl && input === "a") return { kind: "home" };
  if (key.ctrl && input === "e") return { kind: "end" };
  if (key.ctrl && input === "u") return { kind: "killToStart" };
  if (key.ctrl && input === "k") return { kind: "killToEnd" };
  if (key.ctrl && input === "w") return { kind: "killWord" };
  if (key.ctrl && input === "y") return { kind: "yank" };
  if (key.meta && input === "b") return { kind: "wordLeft" };
  if (key.meta && input === "f") return { kind: "wordRight" };
  if (key.backspace) return { kind: "backspace" };
  if (key.delete) return { kind: "deleteForward" };
  if (key.upArrow) return { kind: "up" };
  if (key.downArrow) return { kind: "down" };
  if (input.length > 0 && !key.ctrl && !key.meta) return { kind: "char", value: input };
  return undefined;
}

export type OverlayNavigation = "up" | "down" | "page-up" | "page-down";

function diffViewerAction(input: string, key: InkKey): DiffViewerAction | undefined {
  if (key.tab || input === "\t") return { kind: key.shift ? "previous-file" : "next-file" };
  if (key.return || input === " ") return { kind: "toggle-hunk" };
  if (key.pageUp) return { kind: "page-up" };
  if (key.pageDown) return { kind: "page-down" };
  if (key.upArrow || (!key.ctrl && !key.meta && input === "k")) return { kind: "previous-row" };
  if (key.downArrow || (!key.ctrl && !key.meta && input === "j")) return { kind: "next-row" };
  if (!key.ctrl && !key.meta && input === "n") return { kind: "next-change" };
  if (!key.ctrl && !key.meta && input === "p") return { kind: "previous-change" };
  return undefined;
}

const REVIEW_INPUTS = [
  "a",
  "d",
  "s",
  "p",
  "/approve",
  "/approve once",
  "/approve session",
  "/approve project",
  "/deny",
  "/why",
] as const;

function isReviewTerminal(context: ComposerContext | undefined): boolean {
  return (
    context?.reviewState === "confirmed" ||
    context?.reviewState === "governed-deny" ||
    context?.reviewState === "denied" ||
    context?.reviewState === "failed" ||
    context?.reviewState === "indeterminate"
  );
}

function isReviewPrefix(value: string): boolean {
  const candidate = value.toLowerCase();
  return REVIEW_INPUTS.some((decision) => decision.startsWith(candidate));
}

function isCompleteReviewInput(value: string): boolean {
  const candidate = value.trim().toLowerCase();
  return REVIEW_INPUTS.some((decision) => decision === candidate);
}

function isSubmittedReviewPrefix(value: string): boolean {
  return "/why".startsWith(value.toLowerCase());
}

function isMovementOrCompletion(input: string, key: InkKey): boolean {
  return (
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.pageUp ||
    key.pageDown ||
    key.tab ||
    input === "\t" ||
    input === "\n" ||
    key.meta ||
    (key.ctrl && ["a", "e", "g", "j", "k", "r", "u", "w", "y"].includes(input))
  );
}

/**
 * Interactive input line. A thin driver over the gated input state machine: it maps raw key
 * events to `Key`s, folds them through `inputReduce`, renders the buffer, and forwards resolved
 * `UserInput`s (submit / command / interrupt) and overlay changes to the entrypoint (slice 8).
 * Coverage-exempt (ADR-0003); behavior is covered via the gated reducer + ink-testing-library.
 */
export function InputBar({
  onAction,
  onState,
  onInputState,
  history = [],
  initialState,
  context,
  complete,
  editDraft,
  onDismissOverlay,
  onNavigateOverlay,
  onLocalInteraction,
  onSuspendRequest,
  visible = true,
  diffViewer,
}: {
  onAction?: (action: UserInput) => void;
  onState?: (state: InputState) => void;
  /** Observe every local transition, including transitions that also emit an action. */
  onInputState?: (state: InputState) => void;
  history?: readonly string[];
  /** Restore a dormant composer without restoring authority or a controller-owned overlay. */
  initialState?: InputState;
  /** Presentation-only session context for composer hints. It never claims approval or enforcement. */
  context?: ComposerContext;
  /** Trust-gated `@file` path completer (Epic 1.23 slice 5). Given the query after `@`, returns
   *  workspace-relative candidates — or [] in an untrusted workspace (SEC-012). Absent → no completion
   *  (the overlay shows "(no matches)"). The impure fs/trust logic lives behind this; the reducer is pure. */
  complete?: (query: string) => readonly string[];
  /** Optional external-editor hook (`Ctrl-G`). Returns the edited draft, or undefined to leave it alone. */
  editDraft?: (draft: string) => Promise<string | undefined>;
  /** Dismiss a controller-owned read-only panel without manufacturing a `UserInput`. */
  onDismissOverlay?: () => void;
  /** Scroll a focused read-only overlay; never emits model/controller input. */
  onNavigateOverlay?: (navigation: OverlayNavigation) => void;
  /** Report a key/paste handled entirely inside Ink so controller-owned transient state can clear. */
  onLocalInteraction?: () => void;
  /** Route raw-mode Ctrl-Z to the host terminal lifecycle; never emits model/controller input. */
  onSuspendRequest?: () => void;
  /** Keep dormant composer state mounted without painting it beneath another focus surface. */
  visible?: boolean;
  /** Renderer-local diff focus route. No action crosses `UIPort`. */
  diffViewer?: {
    readonly onAction: (action: DiffViewerAction) => void;
    readonly onClose: () => void;
  };
}): React.JSX.Element {
  const [state, setState] = useState<InputState>(() => initialState ?? emptyInput(history));
  // Fold each event off the LATEST state via a synchronous ref — NOT the render-batched `state`. Ink
  // drains stdin and emits every parsed event in one tick with no re-render between, so reading the
  // closed-over `state` would let a later event in the same burst (e.g. a typed char immediately
  // followed by a paste, or two back-to-back pastes) clobber an earlier one (Epic 1.23 slice 4b QC).
  const stateRef = useRef(state);
  // An active-turn palette temporarily owns the composer. Keep the queued draft process-local and
  // exact so closing or running a local command restores it instead of treating palette text as it.
  const paletteReturnRef = useRef<InputState | undefined>(undefined);
  // The current @file candidates (for Tab-complete) — kept in sync with the at-complete overlay.
  const matchesRef = useRef<readonly string[]>([]);
  const editingRef = useRef(false);
  const interruptDispatchedRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [pasted, setPasted] = useState(false);
  const { stdout } = useStdout();
  useEffect(() => {
    // A local focus handoff may intentionally avoid a controller render. Commit the already-reduced
    // state before hiding so a submitted palette cannot reappear when focus returns.
    if (!visible) setState(stateRef.current);
  }, [visible]);
  const emitAction = (action: UserInput): void => {
    if (action.kind === "interrupt") interruptDispatchedRef.current = true;
    onAction?.(action);
  };
  const reportLocalInteraction = (): void => {
    // Sequence the local callback behind the current raw event. If one stdin burst contains
    // Ctrl-C then an edit, the queue continuation arms first and this later event disarms it; if
    // the edit precedes Ctrl-C, this callback runs first and cannot erase the later interrupt.
    if (onLocalInteraction !== undefined) queueMicrotask(onLocalInteraction);
  };
  const apply = (key: Key): void => {
    if (key.kind !== "paste") setPasted(false);
    const previous = stateRef.current;
    const result = inputReduce(previous, key);
    let next = result.state;
    // Augment an at-complete overlay with TRUST-GATED matches (impure; SEC-012). The reducer set only
    // the query (it is pure); the matches are display data + the Tab-complete source.
    if (next.overlay?.kind === "at-complete" && complete !== undefined) {
      const matches = complete(next.overlay.query);
      matchesRef.current = matches;
      next = { ...next, overlay: { ...next.overlay, matches } };
    } else {
      matchesRef.current = [];
    }
    const leavesDormantPalette =
      previous.overlay?.kind === "palette" &&
      paletteReturnRef.current !== undefined &&
      (next.overlay?.kind !== "palette" || result.action?.kind === "command");
    if (leavesDormantPalette) {
      next = paletteReturnRef.current!;
      paletteReturnRef.current = undefined;
    }
    stateRef.current = next;
    // While the palette is foreground, the dormant queued draft remains Interactive's restorable
    // composer state (including if approval opens before the palette closes).
    if (!(next.overlay?.kind === "palette" && paletteReturnRef.current !== undefined)) {
      onInputState?.(next);
    }
    const invalidActiveCommand =
      result.action?.kind === "command" &&
      previous.overlay?.kind === "palette" &&
      context?.running === true &&
      commandRoute(result.action.name, context.pendingReview === true ? "review" : "running") ===
        "notice" &&
      !URGENT_VERBS.has(result.action.name);
    const deferCommandClear =
      !invalidActiveCommand &&
      result.action?.kind === "command" &&
      previous.overlay?.kind === "palette";
    if (!deferCommandClear) setState(next);
    if (invalidActiveCommand) onState?.(next);
    else if (result.action !== undefined) emitAction(result.action);
    else onState?.(next);
  };
  const openEditor = (): void => {
    if (editDraft === undefined || editingRef.current) return;
    editingRef.current = true;
    setEditing(true);
    const draft = stateRef.current.buffer;
    void editDraft(draft)
      .then((edited) => {
        if (edited !== undefined) apply({ kind: "set-buffer", text: edited });
      })
      .finally(() => {
        editingRef.current = false;
        setEditing(false);
      });
  };

  const handleInput = (input: string, key: InkKey): void => {
    if ((key.ctrl && input === "z") || input === "\x1a") {
      onSuspendRequest?.();
      return;
    }
    if (diffViewer !== undefined) {
      if (key.escape || (key.ctrl && input === "c")) {
        diffViewer.onClose();
      } else {
        const action = diffViewerAction(input, key);
        if (action !== undefined) diffViewer.onAction(action);
      }
      return;
    }
    if (context?.foregroundPanel === true) {
      if (key.escape || (key.ctrl && input === "c")) {
        onDismissOverlay?.();
        if (context.running === true) emitAction({ kind: "interrupt" });
      } else if (key.upArrow) {
        onNavigateOverlay?.("up");
      } else if (key.downArrow) {
        onNavigateOverlay?.("down");
      } else if (key.pageUp) {
        onNavigateOverlay?.("page-up");
      } else if (key.pageDown) {
        onNavigateOverlay?.("page-down");
      }
      return;
    }
    const localOverlay = stateRef.current.overlay?.kind;
    const dismissKey = key.escape || (key.ctrl && input === "c");
    if (context?.pendingReview === true && !isReviewTerminal(context)) {
      if (isMovementOrCompletion(input, key)) return;
      if (key.return) {
        const valid =
          context.reviewState === "submitted"
            ? stateRef.current.buffer.trim().toLowerCase() === "/why"
            : isCompleteReviewInput(stateRef.current.buffer);
        if (!valid) return;
      }
      if (
        input === "?" &&
        !key.ctrl &&
        !key.meta &&
        stateRef.current.buffer === "" &&
        stateRef.current.overlay === undefined
      ) {
        emitAction({ kind: "command", name: "/why" });
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta && !key.return) {
        const current = stateRef.current;
        const candidate =
          current.buffer.slice(0, current.cursor) + input + current.buffer.slice(current.cursor);
        const valid =
          context.reviewState === "submitted"
            ? isSubmittedReviewPrefix(candidate)
            : isReviewPrefix(candidate);
        if (!valid) return;
      }
    }
    if (localOverlay === "help") {
      if (dismissKey) {
        apply({ kind: "escape" });
        if (context?.running === true) emitAction({ kind: "interrupt" });
      } else if (key.upArrow) {
        onNavigateOverlay?.("up");
      } else if (key.downArrow) {
        onNavigateOverlay?.("down");
      } else if (key.pageUp) {
        onNavigateOverlay?.("page-up");
      } else if (key.pageDown) {
        onNavigateOverlay?.("page-down");
      }
      return;
    }
    if (localOverlay === "palette" && dismissKey) {
      apply({ kind: "escape" });
      if (context?.running === true) emitAction({ kind: "interrupt" });
      return;
    }
    if (
      localOverlay === "palette" &&
      context?.pendingReview !== true &&
      (key.upArrow || key.downArrow)
    ) {
      const query =
        stateRef.current.overlay?.kind === "palette" ? stateRef.current.overlay.query : "";
      apply({
        kind: "select-overlay",
        delta: key.upArrow ? -1 : 1,
        count: paletteCommands(query).length,
      });
      return;
    }
    if (
      localOverlay === "palette" &&
      isMovementOrCompletion(input, key) &&
      !key.upArrow &&
      !key.downArrow &&
      !key.tab &&
      input !== "\t"
    ) {
      return;
    }
    if (localOverlay === "at-complete" && dismissKey) {
      apply({ kind: "escape" });
      if (context?.running === true || (key.ctrl && input === "c")) {
        emitAction({ kind: "interrupt" });
      }
      return;
    }
    if (localOverlay === "at-complete" && (key.upArrow || key.downArrow)) {
      apply({
        kind: "select-overlay",
        delta: key.upArrow ? -1 : 1,
        count: matchesRef.current.length,
      });
      return;
    }
    if (
      context?.running === true &&
      context.pendingReview !== true &&
      stateRef.current.overlay === undefined &&
      stateRef.current.buffer.length > 0 &&
      stateRef.current.cursor === 0 &&
      input.startsWith("/") &&
      !key.ctrl &&
      !key.meta
    ) {
      paletteReturnRef.current = stateRef.current;
      apply({ kind: "set-buffer", text: input });
      return;
    }
    if (context?.pendingReview === true) {
      if (isReviewTerminal(context)) {
        if (key.ctrl && input === "c" && context.running === true) {
          emitAction({ kind: "interrupt" });
        }
        return;
      }
    }
    if (
      context?.awaitingInput === true &&
      context.pendingReview !== true &&
      stateRef.current.buffer === "" &&
      stateRef.current.overlay === undefined &&
      ((key.ctrl && input === "d") || input === "\x04")
    ) {
      emitAction({ kind: "command", name: "/exit" });
      return;
    }
    // Escape is a cancel/close key, not an alias for Ctrl-C. With nothing local to cancel at an idle
    // composer it is intentionally inert, so the REPL never emits misleading Ctrl-C quit guidance.
    if (context?.awaitingInput === true && key.escape && stateRef.current.overlay === undefined) {
      return;
    }
    if ((key.ctrl && input === "g") || input === "\x07") {
      openEditor();
      return;
    }
    // Tab accepts the active completion overlay. Slash commands complete visibly without running; @file
    // candidates complete the top match (a dir keeps the cursor in the @token so you can drill in).
    if (key.tab || input === "\t") {
      if (stateRef.current.overlay?.kind === "palette") {
        apply({ kind: "complete-command" });
      } else if (
        stateRef.current.overlay?.kind === "at-complete" &&
        matchesRef.current.length > 0
      ) {
        const selected = Math.min(stateRef.current.selection ?? 0, matchesRef.current.length - 1);
        apply({ kind: "complete-path", path: matchesRef.current[selected]! });
      }
      return;
    }
    const k = toKey(input, key);
    if (k !== undefined) apply(k);
  };
  useInput((input, key) => {
    interruptDispatchedRef.current = false;
    try {
      handleInput(input, key);
    } finally {
      if (!interruptDispatchedRef.current) reportLocalInteraction();
    }
  });

  // Bracketed paste (Epic 1.23 slice 4b): Ink's `usePaste` auto-enables bracketed-paste mode and
  // delivers the whole paste as ONE string on a channel separate from `useInput`, so a multi-line
  // paste lands atomically (no per-newline submit, no per-char palette flicker). The reducer's `paste`
  // op sanitizes it (ER-020) and inserts at the cursor; it never emits an action (a paste never submits).
  usePaste((text) => {
    reportLocalInteraction();
    if (diffViewer !== undefined) return;
    if (
      context?.foregroundPanel === true ||
      context?.pendingReview === true ||
      stateRef.current.overlay?.kind === "help"
    )
      return;
    setPasted(true);
    apply({ kind: "paste", text });
  });

  const composer = composerPresentation(state, {
    ...(context ?? {}),
    ...(editing ? { editing: true } : {}),
    ...(pasted ? { pasted: true } : {}),
  });
  const toneColor =
    composer.tone === "warning"
      ? THEME.state.warning
      : composer.tone === "info"
        ? THEME.state.info
        : THEME.accent;
  const terminalColumns = typeof stdout.columns === "number" ? stdout.columns : 80;
  const visibleBuffer = composerBufferPresentation(
    state.buffer,
    state.cursor,
    Math.max(1, terminalColumns - 2),
  );
  const persistentHints =
    context?.pendingReview === true || context?.foregroundPanel === true
      ? ""
      : " · ^G editor · ↑ history";
  if (!visible) return <></>;
  return (
    <Box flexDirection="column">
      <Box width="100%">
        <Text wrap="truncate-end">
          <Text color={toneColor}>{composer.label}</Text>
          <Text dimColor>{` · ${composer.hint}${persistentHints}`}</Text>
        </Text>
      </Box>
      {visibleBuffer.hidden > 0 ? (
        <Text
          dimColor
        >{`  … ${visibleBuffer.hidden} lines hidden · ${visibleBuffer.total} total · ${state.buffer.length} chars`}</Text>
      ) : null}
      {visibleBuffer.rows.map((row, index) => (
        <Box key={index}>
          <Text color={THEME.accent}>{index === 0 ? "› " : "  "}</Text>
          {row.cursor ? (
            <>
              <Text>{row.before}</Text>
              <Text inverse>{row.atCursor}</Text>
              <Text>{row.after}</Text>
            </>
          ) : (
            <Text>{row.before}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
