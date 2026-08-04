import type { InputState } from "./input.js";
import { paletteEnterHint } from "./commands.js";
import { graphemeSpans, nextGraphemeBoundary, terminalCellWidth } from "./display-cells.js";
import { stripControl } from "./strip.js";

export type ComposerState =
  | "idle"
  | "running"
  | "queued"
  | "review"
  | "exit"
  | "stopping"
  | "panel"
  | "slash"
  | "reverse-search"
  | "file"
  | "paste"
  | "editor"
  | "multiline";

export interface ComposerContext {
  readonly awaitingInput?: boolean;
  readonly running?: boolean;
  readonly pendingReview?: boolean;
  readonly reviewActionable?: boolean;
  readonly reviewSessionAvailable?: boolean;
  readonly reviewState?:
    | "pending"
    | "submitted"
    | "confirmed"
    | "governed-deny"
    | "denied"
    | "indeterminate"
    | "failed";
  readonly pendingInputs?: number;
  readonly stopping?: boolean;
  readonly foregroundPanel?: boolean;
  readonly exitArmed?: boolean;
  readonly editing?: boolean;
  readonly pasted?: boolean;
  /** Process-local bound armed for the next ordinary task; presentation only. */
  readonly nextFinalAnswerMaxWords?: number;
}

export interface ComposerPresentation {
  readonly state: ComposerState;
  readonly label: string;
  readonly hint: string;
  readonly tone: "neutral" | "info" | "warning";
}

export interface ComposerBufferRow {
  readonly cursor: boolean;
  readonly before: string;
  readonly atCursor?: string;
  readonly after?: string;
}

export interface ComposerBufferPresentation {
  readonly rows: readonly ComposerBufferRow[];
  readonly hidden: number;
  readonly total: number;
}

interface ComposerLineSegment {
  readonly start: number;
  readonly end: number;
  readonly cells: number;
}

function wrappedLineSegments(line: string, columns: number): readonly ComposerLineSegment[] {
  const segments: ComposerLineSegment[] = [];
  let start = 0;
  let end = 0;
  let cells = 0;
  for (const span of graphemeSpans(line)) {
    let width = terminalCellWidth(span.text, cells);
    if (end > start && cells + width > columns) {
      segments.push({ start, end, cells });
      start = span.start;
      end = span.start;
      cells = 0;
      width = terminalCellWidth(span.text, 0);
    }
    end = span.end;
    cells += width;
  }
  if (end > start || line.length === 0) segments.push({ start, end, cells });
  return segments;
}

/**
 * Pure physical-row planner for the composer. Ink receives already wrapped rows, so its flex layout
 * cannot leave an inverse cursor on an earlier row while wrapping the text sibling underneath it.
 */
export function composerBufferPresentation(
  buffer: string,
  cursor: number,
  columns: number,
  maxRows = 4,
): ComposerBufferPresentation {
  const width = Math.max(1, Math.floor(columns));
  const rowLimit = Math.max(1, Math.floor(maxRows));
  const safeCursor = Math.min(buffer.length, Math.max(0, Math.trunc(cursor)));
  const rows: ComposerBufferRow[] = [];
  const lines = buffer.split("\n");
  let lineStart = 0;

  for (const line of lines) {
    const lineEnd = lineStart + line.length;
    const ownsCursor = safeCursor >= lineStart && safeCursor <= lineEnd;
    const localCursor = safeCursor - lineStart;
    const segments = [...wrappedLineSegments(line, width)];
    const final = segments.at(-1);
    if (ownsCursor && localCursor === line.length && final?.cells === width) {
      segments.push({ start: line.length, end: line.length, cells: 0 });
    }
    const cursorSegment = ownsCursor
      ? segments.findIndex(
          (segment, index) =>
            localCursor >= segment.start &&
            (localCursor < segment.end ||
              (index === segments.length - 1 && localCursor <= segment.end)),
        )
      : -1;

    segments.forEach((segment, index) => {
      if (index !== cursorSegment) {
        rows.push({
          cursor: false,
          before: stripControl(line.slice(segment.start, segment.end)),
        });
        return;
      }
      const cellEnd = Math.min(segment.end, nextGraphemeBoundary(line, localCursor));
      rows.push({
        cursor: true,
        before: stripControl(line.slice(segment.start, localCursor)),
        atCursor: stripControl(line.slice(localCursor, cellEnd)) || " ",
        after: stripControl(line.slice(cellEnd, segment.end)),
      });
    });
    lineStart = lineEnd + 1;
  }

  if (rows.length <= rowLimit) return { rows, hidden: 0, total: rows.length };
  const cursorRow = Math.max(
    0,
    rows.findIndex((row) => row.cursor),
  );
  const start = Math.min(Math.max(0, cursorRow - rowLimit + 1), rows.length - rowLimit);
  return {
    rows: rows.slice(start, start + rowLimit),
    hidden: rows.length - rowLimit,
    total: rows.length,
  };
}

/**
 * Pure composer UX contract. This is presentation only: it explains what the local input will do next
 * without claiming approval, verification, containment, or any other control-plane guarantee.
 */
export function composerPresentation(
  input: InputState,
  context: ComposerContext = {},
): ComposerPresentation {
  if (context.foregroundPanel === true) {
    return { state: "panel", label: "panel open", hint: "Esc closes · input paused", tone: "info" };
  }
  if (context.stopping === true) {
    return { state: "stopping", label: "stopping", hint: "reaching a safe stop", tone: "warning" };
  }
  if (context.exitArmed === true) {
    return {
      state: "exit",
      label: "quit armed",
      hint: "Ctrl-C again exits · any other input cancels",
      tone: "warning",
    };
  }
  if (context.editing === true) {
    return { state: "editor", label: "editor", hint: "editing draft", tone: "info" };
  }
  if (input.overlay?.kind === "palette") {
    return {
      state: "slash",
      label: "commands",
      hint: paletteEnterHint(
        input.overlay.query,
        context.pendingReview === true ? "review" : context.running === true ? "running" : "idle",
        input.selection ?? 0,
      ),
      tone: "info",
    };
  }
  if (input.overlay?.kind === "reverse-search") {
    return {
      state: "reverse-search",
      label: "history",
      hint: "type to search · Enter accepts · Ctrl-R older",
      tone: "info",
    };
  }
  if (input.overlay?.kind === "at-complete") {
    return {
      state: "file",
      label: "files",
      hint: "Tab completes · Space ends the file token",
      tone: "info",
    };
  }
  if (context.pendingReview === true) {
    if (context.reviewState === "confirmed") {
      return {
        state: "review",
        label: "approval confirmed",
        hint: "warden confirmed · resuming governed action",
        tone: "info",
      };
    }
    if (context.reviewState === "governed-deny") {
      return {
        state: "review",
        label: "governed deny",
        hint: "human approval consumed · inspect tool result for effects",
        tone: "warning",
      };
    }
    if (context.reviewState === "denied") {
      return {
        state: "review",
        label: "review denied",
        hint: "warden confirmed · action not executed",
        tone: "info",
      };
    }
    if (context.reviewState === "failed") {
      return {
        state: "review",
        label: "review unavailable",
        hint: "not confirmed · restart the governed session",
        tone: "warning",
      };
    }
    if (context.reviewState === "indeterminate") {
      return {
        state: "review",
        label: "outcome unknown",
        hint: "do not retry · restart and inspect audit",
        tone: "warning",
      };
    }
    if (context.reviewActionable === false) {
      return {
        state: "review",
        label: "decision sent",
        hint: "input paused",
        tone: "warning",
      };
    }
    return {
      state: "review",
      label: "decision required",
      hint: "choose above",
      tone: "warning",
    };
  }
  if ((context.pendingInputs ?? 0) > 0) {
    const count = context.pendingInputs ?? 0;
    return {
      state: "queued",
      label: "queued",
      hint: `${count} follow-up${count === 1 ? "" : "s"} queued`,
      tone: "warning",
    };
  }
  if (context.pasted === true) {
    return {
      state: "paste",
      label: "paste",
      hint: "paste added; review before Enter",
      tone: "info",
    };
  }
  if (input.buffer.includes("\n")) {
    return {
      state: "multiline",
      label: "multiline",
      hint: "Enter submits · Ctrl-J adds a line",
      tone: "info",
    };
  }
  if (context.running === true) {
    return input.buffer.trim().length > 0
      ? {
          state: "running",
          label: "running",
          hint: "Enter queues for the next safe point",
          tone: "info",
        }
      : {
          state: "running",
          label: "running",
          hint: "type a follow-up to queue",
          tone: "info",
        };
  }
  if (context.nextFinalAnswerMaxWords !== undefined) {
    return {
      state: "idle",
      label: "input",
      hint: `final answer ≤${context.nextFinalAnswerMaxWords} words · next task only`,
      tone: "info",
    };
  }
  return {
    state: "idle",
    label: "input",
    hint: "type a task or /help",
    tone: "neutral",
  };
}
