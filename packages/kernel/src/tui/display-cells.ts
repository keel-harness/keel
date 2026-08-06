import stringWidth from "string-width";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const TERMINAL_TAB_STOP = 8;
// Preserve ordinary joined emoji/combining clusters without letting zero-width input turn a small
// visible-cell budget into an unbounded retained string.
const MAX_CODE_UNITS_PER_DISPLAY_CELL = 8;
const LINE_BREAK = /[\n\r\u2028\u2029]/u;

export interface GraphemeSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface DisplayCellRow {
  readonly text: string;
  readonly cells: number;
}

export interface DisplayCellSlice {
  readonly text: string;
  readonly cells: number;
  readonly hiddenCells: number;
  readonly truncated: boolean;
}

export interface DisplayCellTruncationOptions {
  /** Preserve up to this many cells from the distinguishing end of the line. */
  readonly tailCells?: number;
}

/**
 * Extended grapheme clusters with lossless UTF-16 offsets. The payload is never normalized or
 * rewritten: callers can always reconstruct the exact input from the returned spans.
 */
export function graphemeSpans(value: string): readonly GraphemeSpan[] {
  return Array.from(graphemeSegmenter.segment(value), ({ segment, index }) => ({
    text: segment,
    start: index,
    end: index + segment.length,
  }));
}

function boundedOffset(value: string, offset: number): number {
  if (Number.isNaN(offset) || offset === Number.NEGATIVE_INFINITY) return 0;
  if (offset === Number.POSITIVE_INFINITY) return value.length;
  return Math.min(value.length, Math.max(0, Math.trunc(offset)));
}

/** Previous whole-grapheme boundary, recovering an invalid/interior offset toward the start. */
export function previousGraphemeBoundary(value: string, offset: number): number {
  const bounded = boundedOffset(value, offset);
  if (bounded <= 0) return 0;
  return graphemeSegmenter.segment(value).containing(bounded - 1)?.index ?? 0;
}

/** Next whole-grapheme boundary, recovering an invalid/interior offset toward the end. */
export function nextGraphemeBoundary(value: string, offset: number): number {
  const bounded = boundedOffset(value, offset);
  if (bounded >= value.length) return value.length;
  const span = graphemeSegmenter.segment(value).containing(bounded);
  return span === undefined ? value.length : span.index + span.segment.length;
}

/**
 * Deterministic terminal-cell policy. `string-width` is intentionally pinned because Unicode East
 * Asian Width is not an off-the-shelf emulator contract; Keel uses one reviewed policy everywhere.
 */
export function terminalCellWidth(segment: string, column: number): number {
  if (segment === "\t") return TERMINAL_TAB_STOP - (column % TERMINAL_TAB_STOP);
  return stringWidth(segment);
}

/** Width of the final physical line, matching the existing TUI contract for embedded newlines. */
export function terminalDisplayWidth(value: string): number {
  let width = 0;
  for (const span of graphemeSpans(value)) {
    if (span.text === "\n") {
      width = 0;
    } else {
      width += terminalCellWidth(span.text, width);
    }
  }
  return width;
}

/** Expand source tabs only when a presentation surface deliberately chooses fixed spaces. */
export function expandTerminalTabs(value: string, spaces = 4): string {
  const width = Math.max(1, Math.floor(spaces));
  return value.replaceAll("\t", " ".repeat(width));
}

function assertCellBudget(cells: number, allowZero: boolean): void {
  if (!Number.isInteger(cells) || cells < (allowZero ? 0 : 1)) {
    throw new RangeError(
      allowZero ? "cells must be a non-negative integer" : "columns must be a positive integer",
    );
  }
}

function assertSingleLine(value: string): void {
  if (LINE_BREAK.test(value))
    throw new RangeError("display-cell operation requires one logical line");
}

function tailStartWithinDisplayCells(
  value: string,
  maxCells: number,
  maxCodeUnits: number,
  startColumn: number,
  minimumStart: number,
): number {
  let widths = Array.from({ length: TERMINAL_TAB_STOP }, () => 0);
  let start = value.length;
  const startModulo = startColumn % TERMINAL_TAB_STOP;
  const spans = graphemeSpans(value);
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index];
    if (span === undefined || span.start < minimumStart) break;
    if (value.length - span.start > maxCodeUnits) break;
    const nextWidths = widths.map((_, column) => {
      const width = terminalCellWidth(span.text, column);
      return width + (widths[(column + width) % TERMINAL_TAB_STOP] ?? 0);
    });
    if ((nextWidths[startModulo] ?? 0) > maxCells) break;
    widths = nextWidths;
    start = span.start;
  }
  return start;
}

function prefixWithinDisplayCellsAndCodeUnits(
  value: string,
  maxCells: number,
  maxCodeUnits: number,
): string {
  let text = "";
  let cells = 0;
  for (const span of graphemeSpans(value)) {
    if (text.length + span.text.length > maxCodeUnits) break;
    const next = terminalCellWidth(span.text, cells);
    if (cells + next > maxCells) break;
    text += span.text;
    cells += next;
  }
  return text;
}

/** Hard-wrap one logical line without splitting or rewriting an extended grapheme cluster. */
export function wrapDisplayLine(value: string, columns: number): readonly DisplayCellRow[] {
  assertCellBudget(columns, false);
  assertSingleLine(value);
  if (value.length === 0) return [{ text: "", cells: 0 }];

  const rows: DisplayCellRow[] = [];
  let text = "";
  let cells = 0;
  const push = (): void => {
    rows.push({ text, cells });
    text = "";
    cells = 0;
  };

  for (const span of graphemeSpans(value)) {
    let next = terminalCellWidth(span.text, cells);
    if (text.length > 0 && cells + next > columns) {
      push();
      next = terminalCellWidth(span.text, 0);
    }
    text += span.text;
    cells += next;
  }
  if (text.length > 0) push();
  return rows;
}

/**
 * Hard-wrap an exact evidence line without leaving source whitespace at a physical row edge.
 * Callers can remove terminal padding from every row and concatenate the fragments to recover the
 * byte-identical input. `undefined` means the value cannot be displayed unambiguously at this width.
 */
export function wrapLosslessDisplayLine(
  value: string,
  columns: number,
): readonly DisplayCellRow[] | undefined {
  assertCellBudget(columns, false);
  assertSingleLine(value);
  if (value.length === 0) return [{ text: "", cells: 0 }];

  const spans = graphemeSpans(value);
  const isWhitespace = (text: string): boolean => /^\s+$/u.test(text);
  if (isWhitespace(spans[0]!.text) || isWhitespace(spans.at(-1)!.text)) return undefined;

  const rows: DisplayCellRow[] = [];
  let start = 0;
  while (start < spans.length) {
    let cells = 0;
    let end = start;
    while (end < spans.length) {
      const span = spans[end]!;
      const width = terminalCellWidth(span.text, cells);
      if (cells + width > columns) break;
      cells += width;
      end += 1;
    }

    if (end === spans.length) {
      rows.push({
        text: spans
          .slice(start)
          .map((span) => span.text)
          .join(""),
        cells,
      });
      break;
    }

    let boundary = end;
    while (
      boundary > start &&
      (isWhitespace(spans[boundary - 1]!.text) || isWhitespace(spans[boundary]!.text))
    ) {
      boundary -= 1;
    }
    if (boundary === start) return undefined;

    const text = spans
      .slice(start, boundary)
      .map((span) => span.text)
      .join("");
    rows.push({ text, cells: terminalDisplayWidth(text) });
    start = boundary;
  }
  return rows;
}

/** Largest whole-grapheme prefix within `maxCells`, including an exact hidden-cell count. */
export function takeDisplayCells(value: string, maxCells: number): DisplayCellSlice {
  assertCellBudget(maxCells, true);
  assertSingleLine(value);

  let text = "";
  let cells = 0;
  for (const span of graphemeSpans(value)) {
    const next = terminalCellWidth(span.text, cells);
    if (cells + next > maxCells) break;
    text += span.text;
    cells += next;
  }
  const totalCells = terminalDisplayWidth(value);
  return {
    text,
    cells,
    hiddenCells: Math.max(0, totalCells - cells),
    truncated: text.length < value.length,
  };
}

/**
 * Fit one logical line to an exact terminal-cell budget with one shared ellipsis policy. The
 * default retains the leading context; `tailCells` adds a distinguishing suffix for paths, denial
 * reasons, and recovery copy. Every cut is an extended-grapheme boundary. A generous derived
 * code-unit ceiling separately prevents invisible-suffix amplification.
 */
export function truncateDisplayCells(
  value: string,
  maxCells: number,
  options: DisplayCellTruncationOptions = {},
): string {
  assertCellBudget(maxCells, true);
  assertSingleLine(value);
  const requestedTailCells = options.tailCells ?? 0;
  assertCellBudget(requestedTailCells, true);
  const maxCodeUnits = maxCells * MAX_CODE_UNITS_PER_DISPLAY_CELL;
  if (terminalDisplayWidth(value) <= maxCells && value.length <= maxCodeUnits) return value;
  if (maxCells === 0) return "";

  const marker = takeDisplayCells("…", maxCells);
  if (marker.cells >= maxCells) return marker.text;

  const tailBudget = Math.min(requestedTailCells, maxCells - marker.cells);
  const availableCodeUnits = Math.max(0, maxCodeUnits - marker.text.length);
  const tailCodeUnitBudget = Math.min(
    availableCodeUnits,
    tailBudget * MAX_CODE_UNITS_PER_DISPLAY_CELL,
  );
  const provisionalTailStart =
    tailBudget > 0
      ? tailStartWithinDisplayCells(value, tailBudget, tailCodeUnitBudget, 0, 0)
      : value.length;
  const provisionalTail = value.slice(provisionalTailStart).trimStart();
  const tailWidth = terminalDisplayWidth(provisionalTail);
  const headBudget = Math.max(0, maxCells - marker.cells - tailWidth);
  const headSlice = prefixWithinDisplayCellsAndCodeUnits(
    value.slice(0, provisionalTailStart),
    headBudget,
    Math.max(0, availableCodeUnits - provisionalTail.length),
  );
  const head = headSlice.trimEnd();
  const tailColumn = terminalDisplayWidth(head) + marker.cells;
  const placedTailBudget = Math.min(tailBudget, maxCells - tailColumn);
  const placedTailCodeUnitBudget = Math.min(
    tailCodeUnitBudget,
    Math.max(0, availableCodeUnits - head.length),
  );
  const tailStart =
    placedTailBudget > 0
      ? tailStartWithinDisplayCells(
          value,
          placedTailBudget,
          placedTailCodeUnitBudget,
          tailColumn,
          headSlice.length,
        )
      : value.length;
  const tail = value.slice(tailStart).trimStart();
  return `${head}${marker.text}${tail}`;
}
