import type { DiffLine, UiDensity, ViewModel } from "@keel/shared";
import {
  graphemeSpans,
  takeDisplayCells,
  terminalCellWidth,
  terminalDisplayWidth,
} from "./display-cells.js";
import { visibleTerminalText } from "./visible-text.js";

/**
 * Build a minimal line diff from an `edit` tool's `oldString`→`newString` args: shared leading/
 * trailing lines are context, the differing middle is removed (`del`) then added (`add`). Gives a
 * request comparison from data already on the tool call — not execution evidence. The reducer does
 * not attach this to governed mutation results; authoritative review lines come from the Warden
 * presentation artifact.
 */
export function editDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;

  let suf = 0;
  while (
    suf < oldLines.length - pre &&
    suf < newLines.length - pre &&
    oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]
  ) {
    suf++;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < pre; i++) out.push({ kind: "context", text: oldLines[i]! });
  for (let i = pre; i < oldLines.length - suf; i++) out.push({ kind: "del", text: oldLines[i]! });
  for (let i = pre; i < newLines.length - suf; i++) out.push({ kind: "add", text: newLines[i]! });
  for (let i = oldLines.length - suf; i < oldLines.length; i++) {
    out.push({ kind: "context", text: oldLines[i]! });
  }
  return out;
}

/** Compact change magnitude for a diff: the count of added vs. deleted lines (context ignored).
 *  Drives the calm one-line `· +A −D` summary used by the compact diff mode and the large-diff cap. */
export function summarizeDiff(diff: readonly DiffLine[]): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const d of diff) {
    if (d.kind === "add") added++;
    else if (d.kind === "del") deleted++;
  }
  return { added, deleted };
}

/** Full-mode per-line cap. Beyond this a diff shows its head and an honest "N more lines" footer —
 *  calm on a huge edit, and **never a silent truncation** (§8.6 / tui-principles §8). */
export const MAX_DIFF_LINES = 40;
/** Maximum wholly or partially visible hunks in the static transcript view. */
export const MAX_DIFF_HUNKS = 8;
/** Maximum admitted UTF-8 line-text bytes before physical layout. */
export const MAX_DIFF_LAYOUT_BYTES = 64 * 1024;
/** Defensive per-line mirror of the Warden producer's rendered-text contract. */
export const MAX_DIFF_LINE_BYTES = 8 * 1024;
/** Maximum physical content rows in one static diff block (header/footer excluded). */
export const MAX_DIFF_LAYOUT_ROWS = 40;
/** Maximum physical rows consumed by one source line, including its omission notice. */
export const MAX_DIFF_LINE_ROWS = 4;
/** Below this width two truthful line-number gutters leave too little room for omission counts. */
const MIN_DIFF_DETAIL_COLUMNS = 38;

export type DiffRenderLimit = "lines" | "hunks" | "bytes" | "line-bytes" | "rows";

export type DiffTriageKind = "source" | "lockfile" | "generated";

export interface DiffTriage {
  readonly kind: DiffTriageKind;
  readonly defaultCollapsed: boolean;
  readonly reason: string;
}

export interface DiffRenderTriage extends DiffTriage {
  readonly collapsed: boolean;
}

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
]);

function fileName(path: string | undefined): string {
  if (path === undefined) return "";
  const parts = path.split(/[\\/]/);
  return parts.at(-1) ?? "";
}

function isGeneratedPath(path: string): boolean {
  const p = path.toLowerCase();
  return (
    p.includes(".generated.") ||
    p.includes(".gen.") ||
    p.includes("/generated/") ||
    p.endsWith(".pb.ts") ||
    p.endsWith(".pb.go")
  );
}

/** File-level triage hints for diff presentation. This planner does NOT classify risk or policy. */
export function diffTriage(path: string | undefined): DiffTriage {
  const base = fileName(path);
  if (LOCKFILE_NAMES.has(base)) {
    return { kind: "lockfile", defaultCollapsed: true, reason: "high-noise dependency lockfile" };
  }
  if (path !== undefined && isGeneratedPath(path)) {
    return { kind: "generated", defaultCollapsed: true, reason: "generated artifact" };
  }
  return { kind: "source", defaultCollapsed: false, reason: "source edit" };
}

/** How to disclose an edit diff for the current mode — the single gated decision both renderers map
 *  over (ADR-0036: logic lives in the gated layer, renderers stay dumb). Exactly one of `compact`
 *  (a `+A -D` magnitude) or `lines` (the bounded semantic block) is set. `hidden` and
 *  `hiddenHunks` are exact source counts; physical wrapping is a separate pure layout step. */
export interface DiffRender {
  readonly compact?: { readonly added: number; readonly deleted: number };
  readonly lines?: readonly DiffLine[];
  readonly hidden?: number;
  readonly hiddenHunks?: number;
  readonly limits?: readonly DiffRenderLimit[];
  readonly path?: string;
  readonly triage?: DiffRenderTriage;
}

export interface DiffPathLayout {
  readonly fileName: string;
  readonly parentPath?: string;
  readonly hiddenCells: number;
  readonly cells: number;
}

export interface DiffLayoutRow {
  readonly kind: DiffLine["kind"];
  readonly observed: string;
  readonly installed: string;
  readonly marker: "  " | "+ " | "- " | " ↳" | "+↳" | "-↳" | " …" | "+…" | "-…";
  readonly text: string;
  readonly spans: readonly DiffLayoutSpan[];
  readonly continuation: boolean;
  readonly hunkBoundaryBefore?: boolean;
  readonly cells: number;
  readonly hiddenCells?: number;
  readonly hiddenBytes?: number;
}

export interface DiffLayoutSpan {
  readonly text: string;
  readonly emphasized: boolean;
}

export interface DiffLayout {
  readonly columns: number;
  readonly gutterWidth: number;
  readonly header: DiffPathLayout;
  readonly rows: readonly DiffLayoutRow[];
  /** Content rows plus deliberate blank rows between later hunks. */
  readonly physicalRows: number;
  readonly hiddenLines: number;
  readonly hiddenHunks: number;
  readonly limits: readonly DiffRenderLimit[];
}

export function effectiveDiffMode(
  density: UiDensity | undefined,
  mode: ViewModel["diffMode"],
): "compact" | "full" {
  if (mode !== undefined) return mode;
  return density === "verbose" || density === "debug" ? "full" : "compact";
}

export function planDiffRender(
  diff: readonly DiffLine[],
  mode: "compact" | "full" | undefined,
  path?: string,
): DiffRender {
  const triage = diffTriage(path);
  const renderTriage =
    path !== undefined && triage.kind !== "source"
      ? {
          ...triage,
          collapsed: mode === "compact" || (mode === undefined && triage.defaultCollapsed),
        }
      : undefined;
  const effectiveMode =
    mode === undefined && triage.defaultCollapsed && path !== undefined ? "compact" : mode;
  if (effectiveMode === "compact") {
    return {
      compact: summarizeDiff(diff),
      ...(renderTriage !== undefined ? { triage: renderTriage } : {}),
    };
  }
  const selected: DiffLine[] = [];
  const limits = new Set<DiffRenderLimit>();
  let admittedBytes = 0;
  let visibleHunks = 0;
  for (let index = 0; index < diff.length; index += 1) {
    const line = diff[index]!;
    const startsHunk = index === 0 || line.hunkStart === true;
    if (startsHunk && visibleHunks >= MAX_DIFF_HUNKS) {
      limits.add("hunks");
      break;
    }
    if (selected.length >= MAX_DIFF_LINES) {
      limits.add("lines");
      break;
    }
    const lineBytes = Buffer.byteLength(line.text, "utf8");
    const boundedLineBytes = Math.min(lineBytes, MAX_DIFF_LINE_BYTES);
    if (lineBytes > MAX_DIFF_LINE_BYTES) limits.add("line-bytes");
    if (selected.length > 0 && admittedBytes + boundedLineBytes > MAX_DIFF_LAYOUT_BYTES) {
      limits.add("bytes");
      break;
    }
    selected.push(line);
    admittedBytes += boundedLineBytes;
    if (startsHunk) visibleHunks += 1;
  }

  const totalHunks = countDiffHunks(diff);
  const hidden = diff.length - selected.length;
  const hiddenHunks = Math.max(0, totalHunks - visibleHunks);
  // Full mode shows a bounded prefix; every omitted source line and wholly hidden hunk remains an
  // exact count. The selected entries remain the original objects, so layout never rewrites bytes.
  return {
    lines: selected,
    ...(hidden > 0 ? { hidden } : {}),
    ...(hiddenHunks > 0 ? { hiddenHunks } : {}),
    ...(limits.size > 0 ? { limits: [...limits] } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(renderTriage !== undefined ? { triage: renderTriage } : {}),
  };
}

function countDiffHunks(lines: readonly DiffLine[]): number {
  let count = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (index === 0 || lines[index]!.hunkStart === true) count += 1;
  }
  return count;
}

function pathLayout(path: string | undefined, columns: number): DiffPathLayout {
  if (path === undefined || path.length === 0) {
    return { fileName: "diff", hiddenCells: 0, cells: 4 };
  }
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const candidateName = separator >= 0 ? path.slice(separator + 1) : path;
  const fileName = candidateName.length > 0 ? candidateName : path;
  const parent =
    candidateName.length > 0 && separator >= 0 ? path.slice(0, separator + 1) : undefined;
  const fileWidth = terminalDisplayWidth(fileName);
  if (fileWidth > columns) {
    const slice = takeDisplayCells(fileName, Math.max(0, columns - 1));
    const hiddenParent = parent === undefined ? 0 : terminalDisplayWidth(parent);
    return {
      fileName: `${slice.text}…`,
      hiddenCells: slice.hiddenCells + hiddenParent,
      cells: slice.cells + 1,
    };
  }
  if (parent === undefined) {
    return { fileName, hiddenCells: 0, cells: fileWidth };
  }
  const parentWidth = terminalDisplayWidth(parent);
  const parentBudget = Math.max(0, columns - fileWidth - 2);
  if (parentBudget === 0) {
    return { fileName, hiddenCells: parentWidth, cells: fileWidth };
  }
  const fullParentSlice = takeDisplayCells(parent, parentBudget);
  const parentSlice = fullParentSlice.truncated
    ? takeDisplayCells(parent, Math.max(0, parentBudget - 1))
    : fullParentSlice;
  const renderedParent = fullParentSlice.truncated ? `${parentSlice.text}…` : parentSlice.text;
  const renderedParentWidth = terminalDisplayWidth(renderedParent);
  return {
    fileName,
    parentPath: renderedParent,
    hiddenCells: parentSlice.hiddenCells,
    cells: fileWidth + 2 + renderedParentWidth,
  };
}

/** Display-only neutralization for untrusted diff text. Source bytes remain untouched in `DiffLine`;
 * terminal controls and invisible formatting scalars become stable, copyable tokens. The transform
 * is idempotent, and tabs remain tabs so the positional presentation expansion still applies. */
export function visibleDiffText(value: string): string {
  return visibleTerminalText(value);
}

interface IntralineRange {
  readonly start: number;
  readonly end: number;
}

function changedGraphemeRange(
  left: string,
  right: string,
): readonly [IntralineRange, IntralineRange] {
  const leftSpans = graphemeSpans(left);
  const rightSpans = graphemeSpans(right);
  let prefix = 0;
  while (
    prefix < leftSpans.length &&
    prefix < rightSpans.length &&
    leftSpans[prefix]!.text === rightSpans[prefix]!.text
  ) {
    prefix += 1;
  }
  if (prefix === leftSpans.length && prefix === rightSpans.length) {
    return [
      { start: left.length, end: left.length },
      { start: right.length, end: right.length },
    ];
  }
  let suffix = 0;
  while (
    suffix < leftSpans.length - prefix &&
    suffix < rightSpans.length - prefix &&
    leftSpans[leftSpans.length - 1 - suffix]!.text ===
      rightSpans[rightSpans.length - 1 - suffix]!.text
  ) {
    suffix += 1;
  }
  // An insertion/deletion immediately before an otherwise shared suffix would leave one side with
  // no emphasized cells. Include one shared anchor grapheme so both sides of the replacement remain
  // visually locatable (for example `1` -> `10` emphasizes `1` and `10`).
  if (
    prefix > 0 &&
    (prefix + suffix === leftSpans.length || prefix + suffix === rightSpans.length)
  ) {
    prefix -= 1;
  }
  const range = (spans: ReturnType<typeof graphemeSpans>, length: number): IntralineRange => ({
    start: prefix < spans.length ? spans[prefix]!.start : length,
    end: suffix === 0 ? length : spans[spans.length - suffix]!.start,
  });
  return [range(leftSpans, left.length), range(rightSpans, right.length)];
}

/** Linear, deterministic pairing: within each hunk, a contiguous deletion run followed immediately
 * by an addition run is zipped by stable ordinal. Unpaired lines retain line-level styling only. */
function intralineRanges(lines: readonly DiffLine[]): ReadonlyMap<number, IntralineRange> {
  const ranges = new Map<number, IntralineRange>();
  let hunkStart = 0;
  while (hunkStart < lines.length) {
    let hunkEnd = hunkStart + 1;
    while (hunkEnd < lines.length && lines[hunkEnd]!.hunkStart !== true) hunkEnd += 1;
    let index = hunkStart;
    while (index < hunkEnd) {
      if (lines[index]!.kind !== "del") {
        index += 1;
        continue;
      }
      const deletionStart = index;
      while (index < hunkEnd && lines[index]!.kind === "del") index += 1;
      const additionStart = index;
      while (index < hunkEnd && lines[index]!.kind === "add") index += 1;
      const pairs = Math.min(additionStart - deletionStart, index - additionStart);
      for (let pair = 0; pair < pairs; pair += 1) {
        const deletionIndex = deletionStart + pair;
        const additionIndex = additionStart + pair;
        const [deletionRange, additionRange] = changedGraphemeRange(
          lines[deletionIndex]!.text,
          lines[additionIndex]!.text,
        );
        if (deletionRange.start < deletionRange.end) ranges.set(deletionIndex, deletionRange);
        if (additionRange.start < additionRange.end) ranges.set(additionIndex, additionRange);
      }
    }
    hunkStart = hunkEnd;
  }
  return ranges;
}

function boundedUtf8Line(value: string): {
  readonly text: string;
  readonly hiddenBytes: number;
} {
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= MAX_DIFF_LINE_BYTES) return { text: value, hiddenBytes: 0 };
  let bytes = 0;
  let end = 0;
  for (const span of graphemeSpans(value)) {
    const next = Buffer.byteLength(span.text, "utf8");
    if (bytes + next > MAX_DIFF_LINE_BYTES) break;
    bytes += next;
    end = span.end;
  }
  return { text: value.slice(0, end), hiddenBytes: totalBytes - bytes };
}

function gutterValue(value: number | undefined, width: number): string {
  return value === undefined ? " ".repeat(width) : String(value).padStart(width, " ");
}

function lineMarker(
  kind: DiffLine["kind"],
  continuation: boolean,
  omitted = false,
): DiffLayoutRow["marker"] {
  if (omitted) return kind === "add" ? "+…" : kind === "del" ? "-…" : " …";
  if (continuation) return kind === "add" ? "+↳" : kind === "del" ? "-↳" : " ↳";
  return kind === "add" ? "+ " : kind === "del" ? "- " : "  ";
}

function omissionText(hiddenCells: number, hiddenBytes: number): string {
  return hiddenBytes > 0
    ? `${String(hiddenCells)}c · ${String(hiddenBytes)}B hidden`
    : `${String(hiddenCells)} cells hidden`;
}

function compactOmissionText(hiddenCells: number, hiddenBytes: number): string {
  return hiddenBytes > 0
    ? `${String(hiddenCells)}c/${String(hiddenBytes)}B`
    : `${String(hiddenCells)}c hidden`;
}

interface StyledDisplayRow {
  readonly text: string;
  readonly spans: readonly DiffLayoutSpan[];
  readonly cells: number;
}

function appendLayoutSpan(spans: DiffLayoutSpan[], text: string, emphasized: boolean): void {
  const previous = spans.at(-1);
  if (previous?.emphasized === emphasized) {
    spans[spans.length - 1] = { text: previous.text + text, emphasized };
  } else {
    spans.push({ text, emphasized });
  }
}

function wrapStyledLine(
  value: string,
  columns: number,
  emphasis: IntralineRange | undefined,
): readonly StyledDisplayRow[] {
  const rows: StyledDisplayRow[] = [];
  let text = "";
  let spans: DiffLayoutSpan[] = [];
  let cells = 0;
  const push = (): void => {
    rows.push({ text, spans, cells });
    text = "";
    spans = [];
    cells = 0;
  };
  const appendDisplayText = (displayText: string, emphasized: boolean): void => {
    let nextCells = terminalCellWidth(displayText, cells);
    if (text.length > 0 && cells + nextCells > columns) {
      push();
      nextCells = terminalCellWidth(displayText, 0);
    }
    text += displayText;
    appendLayoutSpan(spans, displayText, emphasized);
    cells += nextCells;
  };

  for (const sourceSpan of graphemeSpans(value)) {
    const emphasized =
      emphasis !== undefined && sourceSpan.start < emphasis.end && sourceSpan.end > emphasis.start;
    if (sourceSpan.text === "\t" && text.length > 0 && cells >= columns) push();
    const rendered =
      sourceSpan.text === "\t"
        ? " ".repeat(terminalCellWidth(sourceSpan.text, cells))
        : visibleTerminalText(sourceSpan.text);
    if (rendered === sourceSpan.text) {
      appendDisplayText(rendered, emphasized);
    } else {
      for (const displaySpan of graphemeSpans(rendered)) {
        appendDisplayText(displaySpan.text, emphasized);
      }
    }
  }
  if (text.length > 0 || rows.length === 0) push();
  return rows;
}

function rowsForLine(
  line: DiffLine,
  gutterWidth: number,
  contentColumns: number,
  emphasis: IntralineRange | undefined,
): readonly DiffLayoutRow[] {
  const bounded = boundedUtf8Line(line.text);
  const wrapped = wrapStyledLine(bounded.text, contentColumns, emphasis);
  const needsOmission = wrapped.length > MAX_DIFF_LINE_ROWS || bounded.hiddenBytes > 0;
  const contentRows = needsOmission
    ? wrapped.slice(0, Math.max(0, MAX_DIFF_LINE_ROWS - 1))
    : wrapped;
  const prefixCells = gutterWidth * 2 + 4;
  const output = contentRows.map(
    (row, index): DiffLayoutRow => ({
      kind: line.kind,
      observed: gutterValue(index === 0 ? line.observedBeforeLine : undefined, gutterWidth),
      installed: gutterValue(index === 0 ? line.installedAfterLine : undefined, gutterWidth),
      marker: lineMarker(line.kind, index > 0),
      text: row.text,
      spans: row.spans,
      continuation: index > 0,
      cells: prefixCells + row.cells,
    }),
  );
  if (!needsOmission) return output;

  const hiddenCells = wrapped
    .slice(contentRows.length)
    .reduce((total, row) => total + row.cells, 0);
  const verboseText = omissionText(hiddenCells, bounded.hiddenBytes);
  const text =
    terminalDisplayWidth(verboseText) <= contentColumns
      ? verboseText
      : compactOmissionText(hiddenCells, bounded.hiddenBytes);
  output.push({
    kind: line.kind,
    observed: gutterValue(undefined, gutterWidth),
    installed: gutterValue(undefined, gutterWidth),
    marker: lineMarker(line.kind, true, true),
    text,
    spans: [{ text, emphasized: false }],
    continuation: true,
    cells: prefixCells + terminalDisplayWidth(text),
    hiddenCells,
    hiddenBytes: bounded.hiddenBytes,
  });
  return output;
}

/**
 * Convert a bounded semantic diff plan into deterministic physical rows for one terminal width.
 * This layer expands presentation tabs and wraps graphemes, but retains the source lines untouched.
 */
export function planDiffLayout(plan: DiffRender, columns: number): DiffLayout {
  if (!Number.isInteger(columns) || columns < 20) {
    throw new RangeError("diff layout columns must be an integer of at least 20");
  }
  const lines = plan.lines ?? [];
  const largestLineNumber = lines.reduce(
    (largest, line) =>
      Math.max(largest, line.observedBeforeLine ?? 0, line.installedAfterLine ?? 0),
    0,
  );
  const gutterWidth = Math.max(2, String(largestLineNumber).length);
  const limits = new Set(plan.limits ?? []);
  const header = pathLayout(plan.path, columns);
  if (columns < MIN_DIFF_DETAIL_COLUMNS) {
    limits.add("rows");
    return {
      columns,
      gutterWidth,
      header,
      rows: [],
      physicalRows: 0,
      hiddenLines: (plan.hidden ?? 0) + lines.length,
      hiddenHunks: (plan.hiddenHunks ?? 0) + countDiffHunks(lines),
      limits: [...limits],
    };
  }

  const contentColumns = Math.max(1, columns - (gutterWidth * 2 + 4));
  const rows: DiffLayoutRow[] = [];
  const emphasisByLine = intralineRanges(lines);
  const rowsByLine = lines.map((line, index) =>
    rowsForLine(line, gutterWidth, contentColumns, emphasisByLine.get(index)),
  );
  let physicalRows = 0;
  let hiddenByRows = 0;
  let hiddenHunksByRows = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const boundaryBefore = index > 0 && lines[index]!.hunkStart === true;
    const boundaryRows = boundaryBefore ? 1 : 0;
    if (boundaryBefore) {
      let hunkEnd = index + 1;
      while (hunkEnd < lines.length && lines[hunkEnd]!.hunkStart !== true) hunkEnd += 1;
      let hunkRows = 0;
      for (let hunkIndex = index; hunkIndex < hunkEnd; hunkIndex += 1) {
        hunkRows += rowsByLine[hunkIndex]!.length;
      }
      // Once a later hunk starts, admit it as one readable unit. A dangling partial hunk would spend
      // the row budget without preserving enough local context to review the change.
      if (physicalRows + boundaryRows + hunkRows > MAX_DIFF_LAYOUT_ROWS) {
        hiddenByRows = lines.length - index;
        hiddenHunksByRows = countDiffHunks(lines.slice(index));
        limits.add("rows");
        break;
      }
    }
    const rawLineRows = rowsByLine[index]!;
    const lineRows = boundaryBefore
      ? rawLineRows.map((row, rowIndex) =>
          rowIndex === 0 ? { ...row, hunkBoundaryBefore: true as const } : row,
        )
      : rawLineRows;
    if (physicalRows + boundaryRows + lineRows.length > MAX_DIFF_LAYOUT_ROWS) {
      hiddenByRows = lines.length - index;
      hiddenHunksByRows = lines
        .slice(index)
        .filter((line, relativeIndex) =>
          index === 0 && relativeIndex === 0 ? true : line.hunkStart === true,
        ).length;
      limits.add("rows");
      break;
    }
    rows.push(...lineRows);
    physicalRows += boundaryRows + lineRows.length;
  }

  return {
    columns,
    gutterWidth,
    header,
    rows,
    physicalRows,
    hiddenLines: (plan.hidden ?? 0) + hiddenByRows,
    hiddenHunks: (plan.hiddenHunks ?? 0) + hiddenHunksByRows,
    limits: [...limits],
  };
}

/** The compact `· +A -D` magnitude suffix for an edit head — ASCII `-` (copy/paste- + grep-friendly,
 *  and matches the per-line `-` sign), or "" for a zero-magnitude (no-op / context-only) edit. */
export function compactStat(c: { added: number; deleted: number }): string {
  return c.added === 0 && c.deleted === 0 ? "" : ` · +${c.added} -${c.deleted}`;
}

/** The honest full-mode cap footer: how many lines are hidden in this rendered view. No magnitude
 *  here (it would mix a whole-diff total with this remainder, QC F2), and no `/diff` promise after
 *  static transcript commits because settled terminal scrollback cannot be rewritten. */
export function moreHint(hidden: number, hiddenHunks = 0): string {
  if (hiddenHunks > 0) {
    return `… ${hidden} line${hidden === 1 ? "" : "s"} · ${hiddenHunks} hunk${hiddenHunks === 1 ? "" : "s"} hidden`;
  }
  return `… ${hidden} more line${hidden === 1 ? "" : "s"} hidden in this view`;
}
