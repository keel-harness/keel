import type { DiffLine, UiToolActivity, UiTurnSummary, ViewItem } from "@keel/shared";
import { diffTriage, planDiffLayout, summarizeDiff, type DiffLayoutRow } from "./diff.js";
import { terminalDisplayWidth, truncateDisplayCells, wrapDisplayLine } from "./display-cells.js";
import { stripControlLine } from "./strip.js";
import { TUI_MANUAL_RECOVERY_GUIDANCE } from "./strings.js";
import { mutationReviewCoverageCopy, mutationReviewUnavailableCopy } from "./tool-card.js";

export const MAX_DIFF_VIEWER_FILES = 32;
export const MAX_DIFF_VIEWER_ROWS = 24;
export const MAX_DIFF_VIEWER_UNAVAILABLE = 3;

export interface DiffViewerHunk {
  readonly start: number;
  readonly end: number;
  readonly added: number;
  readonly deleted: number;
}

export interface DiffViewerChange {
  readonly start: number;
  readonly end: number;
  readonly hunkIndex: number;
}

export interface DiffViewerFile {
  readonly id: string;
  readonly occurrenceKey: string;
  readonly path: string;
  readonly lines: readonly DiffLine[];
  readonly hunks: readonly DiffViewerHunk[];
  readonly changes: readonly DiffViewerChange[];
  readonly summary: { readonly added: number; readonly deleted: number; readonly rows: number };
  readonly defaultCollapsedHunks: readonly number[];
  readonly latestTurn: boolean;
  readonly evidence?: {
    readonly transitionBinding: "not-atomic";
    readonly concurrentMutation: "not-excluded";
    readonly coverageLine?: string;
  };
}

export interface DiffViewerUnavailable {
  readonly occurrenceKey: string;
  readonly text: string;
  readonly latestTurn: boolean;
}

export interface DiffViewerLatestTurnContext {
  readonly verificationLines: readonly string[];
  readonly recoveryLine: string;
}

export interface DiffViewerCollection {
  readonly files: readonly DiffViewerFile[];
  readonly hiddenFiles: number;
  readonly unavailable: readonly DiffViewerUnavailable[];
  readonly hiddenUnavailable: number;
  readonly latestTurnUnavailable: number;
  readonly latestTurnContext?: DiffViewerLatestTurnContext;
}

export const EMPTY_DIFF_VIEWER_COLLECTION: DiffViewerCollection = {
  files: [],
  hiddenFiles: 0,
  unavailable: [],
  hiddenUnavailable: 0,
  latestTurnUnavailable: 0,
};

export function hasDiffViewerEvidence(collection: DiffViewerCollection): boolean {
  return collection.files.length > 0 || collection.unavailable.length > 0;
}

export interface DiffViewerFileState {
  readonly occurrenceKey: string;
  readonly selectedLine: number;
  readonly selectedHunk: number;
  readonly selectedChange: number;
  readonly collapsedHunks: readonly number[];
}

export interface DiffViewerState {
  readonly fileIndex: number;
  readonly files: readonly DiffViewerFileState[];
}

export type DiffViewerAction =
  | { readonly kind: "next-row" }
  | { readonly kind: "previous-row" }
  | { readonly kind: "next-change" }
  | { readonly kind: "previous-change" }
  | { readonly kind: "next-file" }
  | { readonly kind: "previous-file" }
  | { readonly kind: "page-down" }
  | { readonly kind: "page-up" }
  | { readonly kind: "toggle-hunk" };

export type DiffViewerPlanRow =
  | {
      readonly kind: "line";
      readonly layout: DiffLayoutRow;
      readonly selected: boolean;
    }
  | {
      readonly kind: "hunk-summary";
      readonly text: string;
      readonly selected: true;
    };

export interface DiffViewerPlan {
  readonly titleLines: readonly string[];
  readonly path: string;
  readonly parentPath?: string;
  readonly hiddenPathCells: number;
  readonly filePosition: {
    readonly current: number;
    readonly total: number;
    readonly hiddenEarlier: number;
  };
  readonly hunkPosition: { readonly current: number; readonly total: number };
  readonly changePosition: { readonly current: number; readonly total: number };
  readonly fileSummary: { readonly added: number; readonly deleted: number; readonly rows: number };
  readonly fileSummaryLines: readonly string[];
  readonly rows: readonly DiffViewerPlanRow[];
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
  readonly evidenceLine?: string;
  readonly evidenceLines: readonly string[];
  readonly coverageLines: readonly string[];
  readonly availabilityLines: readonly string[];
  readonly verificationLines: readonly string[];
  readonly recoveryLines: readonly string[];
  readonly footerLines: readonly string[];
}

export interface UnavailableDiffViewerPlan {
  readonly titleLines: readonly string[];
  readonly availabilityLines: readonly string[];
  readonly verificationLines: readonly string[];
  readonly recoveryLines: readonly string[];
  readonly footerLines: readonly string[];
}

function pathFor(item: UiToolActivity): string {
  const path =
    item.mutationPresentation?.status === "available"
      ? item.mutationPresentation.displayPath
      : (item.subject ?? item.summary);
  const safe = stripControlLine(path);
  return safe.trim().length === 0 ? "comparison" : safe;
}

function hunksFor(lines: readonly DiffLine[]): DiffViewerHunk[] {
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (index === 0 || lines[index]!.hunkStart === true) starts.push(index);
  }
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    const summary = summarizeDiff(lines.slice(start, end));
    return { start, end, ...summary };
  });
}

function changesFor(
  lines: readonly DiffLine[],
  hunks: readonly DiffViewerHunk[],
): DiffViewerChange[] {
  const changes: DiffViewerChange[] = [];
  for (const [hunkIndex, hunk] of hunks.entries()) {
    let index = hunk.start;
    while (index < hunk.end) {
      if (lines[index]!.kind === "context") {
        index += 1;
        continue;
      }
      const start = index;
      while (index < hunk.end && lines[index]!.kind !== "context") index += 1;
      changes.push({ start, end: index, hunkIndex });
    }
  }
  return changes;
}

function viewerFile(
  item: UiToolActivity,
  itemIndex: number,
  latestTurnStart: number,
): DiffViewerFile | undefined {
  if (item.status !== "ok" || item.diff === undefined || item.diff.length === 0) return undefined;
  // An explicit producer settlement outranks any contradictory/stale request-side comparison
  // bytes. In particular, never recover a path or line from the activity after redaction failed.
  if (item.mutationPresentation !== undefined && item.mutationPresentation.status !== "available") {
    return undefined;
  }
  if (!item.diff.some((line) => line.kind === "add" || line.kind === "del")) return undefined;
  const path = pathFor(item);
  const hunks = hunksFor(item.diff);
  const changes = changesFor(item.diff, hunks);
  if (changes.length === 0) return undefined;
  const triage = diffTriage(path);
  const presentation = item.mutationPresentation;
  const coverage =
    presentation?.status === "available" ? mutationReviewCoverageCopy(presentation) : undefined;
  return {
    id: item.id,
    occurrenceKey: `${String(itemIndex)}:${item.id}`,
    path,
    lines: item.diff,
    hunks,
    changes,
    summary: { ...summarizeDiff(item.diff), rows: item.diff.length },
    defaultCollapsedHunks: triage.defaultCollapsed ? hunks.map((_, index) => index) : [],
    latestTurn: itemIndex >= latestTurnStart,
    ...(presentation?.status === "available"
      ? {
          evidence: {
            transitionBinding: presentation.transitionBinding,
            concurrentMutation: presentation.concurrentMutation,
            ...(coverage === undefined ? {} : { coverageLine: coverage }),
          },
        }
      : {}),
  };
}

function latestTurnStart(items: readonly ViewItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "message" && item.role === "user") return index;
  }
  return 0;
}

function oneBoundedLine(value: string): string {
  const clean = stripControlLine(value).trim().replace(/\s+/gu, " ");
  return truncateDisplayCells(clean, 160, { tailCells: 32 });
}

function latestTurnContext(
  summary: UiTurnSummary | undefined,
): DiffViewerLatestTurnContext | undefined {
  if (summary === undefined) return undefined;
  const checked = summary.checked
    .map(oneBoundedLine)
    .filter((line) => line.length > 0)
    .map((line) => `latest turn · verified · ${line}`);
  const receipt = (summary.receipt ?? [])
    .map(oneBoundedLine)
    .filter((line) => /^verification\s*·/iu.test(line))
    .map((line) => `latest turn · ${line}`);
  const verificationLines = [...new Set([...receipt, ...checked])].slice(0, 2);
  const hasRanReceipt = (summary.ran ?? []).some((line) => oneBoundedLine(line).length > 0);
  return {
    verificationLines:
      verificationLines.length > 0
        ? verificationLines
        : hasRanReceipt
          ? []
          : ["verification not run"],
    recoveryLine: TUI_MANUAL_RECOVERY_GUIDANCE,
  };
}

function unavailableFile(
  item: UiToolActivity,
  itemIndex: number,
  latestStart: number,
): DiffViewerUnavailable | undefined {
  if (item.status !== "ok" || (item.name !== "edit" && item.name !== "write")) return undefined;
  const presentation = item.mutationPresentation;
  let text: string;
  if (presentation?.status === "available") {
    const path = oneBoundedLine(presentation.displayPath) || "comparison";
    const coverage = mutationReviewCoverageCopy(presentation);
    text = `${path} · ${oneBoundedLine(coverage ?? "comparison rows unavailable")}`;
  } else if (presentation?.status === "unavailable") {
    text = `${item.name} observation unavailable · ${mutationReviewUnavailableCopy(presentation.reason)}`;
  } else if (presentation?.status === "pending") {
    text = `${item.name} observation unavailable · presentation did not settle`;
  } else {
    text = `${item.name} observation unavailable · governed observation capture was unavailable`;
  }
  return {
    occurrenceKey: `${String(itemIndex)}:${item.id}`,
    text: oneBoundedLine(text),
    latestTurn: itemIndex >= latestStart,
  };
}

/** Select recent settled comparison and availability facts without reading the workspace or copying bytes. */
export function collectDiffViewerFiles(
  items: readonly ViewItem[],
  summary?: UiTurnSummary,
): DiffViewerCollection {
  const latestStart = latestTurnStart(items);
  const allFiles: DiffViewerFile[] = [];
  const allUnavailable: DiffViewerUnavailable[] = [];
  for (const [itemIndex, item] of items.entries()) {
    if (item.kind !== "tool") continue;
    const file = viewerFile(item, itemIndex, latestStart);
    if (file !== undefined) {
      allFiles.push(file);
      continue;
    }
    const unavailable = unavailableFile(item, itemIndex, latestStart);
    if (unavailable !== undefined) allUnavailable.push(unavailable);
  }
  const hiddenFiles = Math.max(0, allFiles.length - MAX_DIFF_VIEWER_FILES);
  const hiddenUnavailable = Math.max(0, allUnavailable.length - MAX_DIFF_VIEWER_UNAVAILABLE);
  const context = latestTurnContext(summary);
  return {
    files: allFiles.slice(hiddenFiles),
    hiddenFiles,
    unavailable: allUnavailable.slice(hiddenUnavailable),
    hiddenUnavailable,
    latestTurnUnavailable: allUnavailable.filter((item) => item.latestTurn).length,
    ...(context === undefined ? {} : { latestTurnContext: context }),
  };
}

function initialFileState(file: DiffViewerFile): DiffViewerFileState {
  return {
    occurrenceKey: file.occurrenceKey,
    selectedLine: file.hunks[0]?.start ?? 0,
    selectedHunk: 0,
    selectedChange: 0,
    collapsedHunks: file.defaultCollapsedHunks,
  };
}

export function initialDiffViewerState(files: readonly DiffViewerFile[]): DiffViewerState {
  return { fileIndex: 0, files: files.map(initialFileState) };
}

/** Rebind process-local focus only by exact visible occurrence; stale coordinates never cross files. */
export function normalizeDiffViewerState(
  files: readonly DiffViewerFile[],
  state: DiffViewerState | undefined,
): DiffViewerState {
  if (state === undefined || files.length === 0) return initialDiffViewerState(files);
  const previousSelectedKey = state.files[state.fileIndex]?.occurrenceKey;
  const normalized = files.map((file) => {
    const previous = state.files.find(
      (candidate) => candidate.occurrenceKey === file.occurrenceKey,
    );
    if (previous === undefined) return initialFileState(file);
    const selectedLine = clamp(previous.selectedLine, file.lines.length - 1);
    return {
      occurrenceKey: file.occurrenceKey,
      selectedLine,
      selectedHunk: hunkAt(file, selectedLine),
      selectedChange: changeAtOrBefore(file, selectedLine),
      collapsedHunks: previous.collapsedHunks.filter(
        (index) => Number.isInteger(index) && index >= 0 && index < file.hunks.length,
      ),
    };
  });
  const selectedIndex = files.findIndex((file) => file.occurrenceKey === previousSelectedKey);
  return { fileIndex: selectedIndex < 0 ? 0 : selectedIndex, files: normalized };
}

function clamp(value: number, maximum: number): number {
  return Math.min(Math.max(0, value), Math.max(0, maximum));
}

function hunkAt(file: DiffViewerFile, line: number): number {
  const index = file.hunks.findIndex((hunk) => line >= hunk.start && line < hunk.end);
  return index < 0 ? 0 : index;
}

function changeAtOrBefore(file: DiffViewerFile, line: number): number {
  const selectedHunk = hunkAt(file, line);
  const firstInHunk = file.changes.findIndex((change) => change.hunkIndex === selectedHunk);
  let selected = firstInHunk < 0 ? 0 : firstInHunk;
  for (const [index, change] of file.changes.entries()) {
    if (change.hunkIndex !== selectedHunk) continue;
    if (line < change.start) break;
    selected = index;
  }
  return selected;
}

function replaceFileState(
  state: DiffViewerState,
  fileIndex: number,
  next: DiffViewerFileState,
): DiffViewerState {
  return {
    ...state,
    files: state.files.map((fileState, index) => (index === fileIndex ? next : fileState)),
  };
}

function moveRow(
  file: DiffViewerFile,
  current: DiffViewerFileState,
  delta: number,
): DiffViewerFileState {
  const visibleLines = file.hunks.flatMap((hunk, hunkIndex) =>
    current.collapsedHunks.includes(hunkIndex)
      ? [hunk.start]
      : Array.from({ length: hunk.end - hunk.start }, (_, index) => hunk.start + index),
  );
  const currentHunk = hunkAt(file, current.selectedLine);
  const currentVisibleLine = current.collapsedHunks.includes(currentHunk)
    ? file.hunks[currentHunk]!.start
    : clamp(current.selectedLine, file.lines.length - 1);
  const currentVisibleIndex = Math.max(0, visibleLines.indexOf(currentVisibleLine));
  const selectedLine = visibleLines[clamp(currentVisibleIndex + delta, visibleLines.length - 1)]!;
  if (selectedLine === current.selectedLine) return current;
  return {
    ...current,
    selectedLine,
    selectedHunk: hunkAt(file, selectedLine),
    selectedChange: changeAtOrBefore(file, selectedLine),
  };
}

function moveChange(
  file: DiffViewerFile,
  current: DiffViewerFileState,
  delta: number,
): DiffViewerFileState {
  const selectedChange = clamp(current.selectedChange + delta, file.changes.length - 1);
  if (selectedChange === current.selectedChange) return current;
  const selected = file.changes[selectedChange]!;
  return {
    ...current,
    selectedLine: selected.start,
    selectedHunk: selected.hunkIndex,
    selectedChange,
    collapsedHunks: current.collapsedHunks.filter((index) => index !== selected.hunkIndex),
  };
}

/** Pure bounded focus reducer; no action emits `UserInput` or changes authority-bearing state. */
export function reduceDiffViewer(
  files: readonly DiffViewerFile[],
  state: DiffViewerState,
  action: DiffViewerAction,
): DiffViewerState {
  if (files.length === 0) return state;
  state = normalizeDiffViewerState(files, state);
  if (action.kind === "next-file" || action.kind === "previous-file") {
    const delta = action.kind === "next-file" ? 1 : -1;
    const fileIndex = clamp(state.fileIndex + delta, files.length - 1);
    return fileIndex === state.fileIndex ? state : { ...state, fileIndex };
  }
  const fileIndex = clamp(state.fileIndex, files.length - 1);
  const file = files[fileIndex]!;
  const current = state.files[fileIndex] ?? initialFileState(file);
  if (action.kind === "next-row" || action.kind === "previous-row") {
    const next = moveRow(file, current, action.kind === "next-row" ? 1 : -1);
    return next === current ? state : replaceFileState(state, fileIndex, next);
  }
  if (action.kind === "page-down" || action.kind === "page-up") {
    const next = moveRow(file, current, action.kind === "page-down" ? 8 : -8);
    return next === current ? state : replaceFileState(state, fileIndex, next);
  }
  if (action.kind === "next-change" || action.kind === "previous-change") {
    const next = moveChange(file, current, action.kind === "next-change" ? 1 : -1);
    return next === current ? state : replaceFileState(state, fileIndex, next);
  }
  const selectedHunk = clamp(current.selectedHunk, file.hunks.length - 1);
  const collapsed = new Set(current.collapsedHunks);
  if (collapsed.has(selectedHunk)) collapsed.delete(selectedHunk);
  else collapsed.add(selectedHunk);
  return replaceFileState(state, fileIndex, {
    ...current,
    collapsedHunks: [...collapsed].sort((left, right) => left - right),
  });
}

function selectWholeLineGroups(
  layoutRows: readonly DiffLayoutRow[],
  selectedRelativeLine: number,
  budget: number,
): {
  readonly rows: readonly DiffViewerPlanRow[];
  readonly firstLine: number;
  readonly lastLine: number;
} {
  const groups: { readonly line: number; readonly rows: readonly DiffLayoutRow[] }[] = [];
  let line = -1;
  for (const row of layoutRows) {
    if (!row.continuation) {
      line += 1;
      groups.push({ line, rows: [row] });
    } else {
      const current = groups.at(-1);
      if (current !== undefined) {
        groups[groups.length - 1] = { line: current.line, rows: [...current.rows, row] };
      }
    }
  }
  const selectedGroup = clamp(selectedRelativeLine, groups.length - 1);
  let first = selectedGroup;
  let last = selectedGroup;
  let used = groups[selectedGroup]?.rows.length ?? 0;
  for (;;) {
    let changed = false;
    const before = groups[first - 1];
    if (before !== undefined && used + before.rows.length <= budget) {
      first -= 1;
      used += before.rows.length;
      changed = true;
    }
    const after = groups[last + 1];
    if (after !== undefined && used + after.rows.length <= budget) {
      last += 1;
      used += after.rows.length;
      changed = true;
    }
    if (!changed) break;
  }
  return {
    rows: groups.slice(first, last + 1).flatMap((group) =>
      group.rows.map((layout) => ({
        kind: "line" as const,
        layout,
        selected: group.line === selectedGroup,
      })),
    ),
    firstLine: first,
    lastLine: last,
  };
}

const EVIDENCE_LINE =
  "observed before → verified installed after · transition not atomic · concurrent mutation not excluded";
const FOOTER_LINE = "j/k rows · n/p changes · tab files · enter/space fold · esc close";
const UNAVAILABLE_FOOTER_LINE = "esc close";

function hardRows(value: string, columns: number): readonly string[] {
  return wrapDisplayLine(value, columns).map((row) => row.text);
}

function wordRows(value: string, columns: number): readonly string[] {
  if (terminalDisplayWidth(value) <= columns) return [value];
  const rows: string[] = [];
  let current = "";
  for (const word of value.split(" ")) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (terminalDisplayWidth(candidate) <= columns) {
      current = candidate;
      continue;
    }
    if (current.length > 0) rows.push(current);
    if (terminalDisplayWidth(word) <= columns) {
      current = word;
    } else {
      const pieces = hardRows(word, columns);
      rows.push(...pieces.slice(0, -1));
      current = pieces.at(-1) ?? "";
    }
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

function titleRows(
  filePosition: DiffViewerPlan["filePosition"],
  hunkPosition: DiffViewerPlan["hunkPosition"],
  changePosition: DiffViewerPlan["changePosition"],
  columns: number,
): readonly string[] {
  const full = `reviewing changes · file ${String(filePosition.current)}/${String(filePosition.total)} · hunk ${String(hunkPosition.current)}/${String(hunkPosition.total)} · change ${String(changePosition.current)}/${String(changePosition.total)}`;
  if (terminalDisplayWidth(full) <= columns) return [full];
  return [
    ...hardRows(
      `reviewing changes · file ${String(filePosition.current)}/${String(filePosition.total)}`,
      columns,
    ),
    ...hardRows(
      `hunk ${String(hunkPosition.current)}/${String(hunkPosition.total)} · change ${String(changePosition.current)}/${String(changePosition.total)}`,
      columns,
    ),
  ];
}

function evidenceRows(columns: number): readonly string[] {
  if (terminalDisplayWidth(EVIDENCE_LINE) <= columns) return [EVIDENCE_LINE];
  const medium = [
    "observed before → verified installed after",
    "transition not atomic · concurrent mutation not excluded",
  ];
  if (medium.every((line) => terminalDisplayWidth(line) <= columns)) return medium;
  return [
    ...hardRows("observed → verified installed after", columns),
    ...hardRows("transition not atomic", columns),
    ...hardRows("concurrent mutation not excluded", columns),
  ];
}

function footerRows(columns: number): readonly string[] {
  if (terminalDisplayWidth(FOOTER_LINE) <= columns) return [FOOTER_LINE];
  return [
    ...hardRows("j/k rows · n/p changes · tab files", columns),
    ...hardRows("enter/space fold · esc close", columns),
  ];
}

function fileSummaryRows(summary: DiffViewerFile["summary"], columns: number): readonly string[] {
  const counts = `+${String(summary.added)} -${String(summary.deleted)}`;
  const total = `${String(summary.rows)} source rows`;
  const full = `${counts} · ${total}`;
  return terminalDisplayWidth(full) <= columns
    ? [full]
    : [...hardRows(counts, columns), ...hardRows(total, columns)];
}

function metadataRows(value: string | undefined, columns: number): number {
  return value === undefined ? 0 : hardRows(value, columns).length;
}

function availabilityRows(
  collection: DiffViewerCollection,
  turn: boolean | "all",
  columns: number,
): readonly string[] {
  const overall = collection.unavailable.length + collection.hiddenUnavailable;
  const total =
    turn === "all"
      ? overall
      : turn
        ? collection.latestTurnUnavailable
        : overall - collection.latestTurnUnavailable;
  if (total <= 0) return [];
  const retained =
    turn === "all"
      ? collection.unavailable
      : collection.unavailable.filter((item) => item.latestTurn === turn);
  const reason = retained.at(-1)?.text ?? "reason outside the retained review window";
  const noun =
    total === 1 ? "file observation without review rows" : "file observations without review rows";
  const additional = total > 1 ? ` · ${String(total - 1)} more` : "";
  return wordRows(oneBoundedLine(`${String(total)} ${noun} · ${reason}${additional}`), columns);
}

function contextRows(
  context: DiffViewerLatestTurnContext | undefined,
  columns: number,
): {
  readonly verificationLines: readonly string[];
  readonly recoveryLines: readonly string[];
} {
  if (context === undefined) return { verificationLines: [], recoveryLines: [] };
  return {
    verificationLines: context.verificationLines.flatMap((line) =>
      wordRows(oneBoundedLine(line), columns),
    ),
    recoveryLines: wordRows(oneBoundedLine(context.recoveryLine), columns),
  };
}

function validateGeometry(geometry: { readonly columns: number; readonly rows: number }): void {
  if (!Number.isInteger(geometry.columns) || geometry.columns < 20) {
    throw new RangeError("diff viewer columns must be an integer of at least 20");
  }
  if (!Number.isInteger(geometry.rows) || geometry.rows < 6) {
    throw new RangeError("diff viewer rows must be an integer of at least 6");
  }
}

/** Plan the honest focused fallback when mutation evidence settled unavailable. */
export function planUnavailableDiffViewer(
  collection: DiffViewerCollection,
  geometry: { readonly columns: number; readonly rows: number },
): UnavailableDiffViewerPlan {
  validateGeometry(geometry);
  if (collection.files.length > 0 || collection.unavailable.length === 0) {
    throw new RangeError("unavailable diff viewer needs only unavailable observations");
  }
  const latestTurn = collection.latestTurnUnavailable > 0;
  const titleLines = hardRows("review evidence unavailable", geometry.columns);
  const availabilityLines = availabilityRows(collection, "all", geometry.columns);
  const context = contextRows(
    latestTurn ? collection.latestTurnContext : undefined,
    geometry.columns,
  );
  const footerLines = hardRows(UNAVAILABLE_FOOTER_LINE, geometry.columns);
  const totalRows =
    titleLines.length +
    availabilityLines.length +
    context.verificationLines.length +
    context.recoveryLines.length +
    footerLines.length;
  if (totalRows > geometry.rows) {
    throw new RangeError("diff viewer geometry cannot fit unavailable evidence and recovery");
  }
  return {
    titleLines,
    availabilityLines,
    verificationLines: context.verificationLines,
    recoveryLines: context.recoveryLines,
    footerLines,
  };
}

/** Build one bounded dynamic viewport around the selected source row. */
export function planDiffViewer(
  collection: DiffViewerCollection,
  state: DiffViewerState,
  geometry: { readonly columns: number; readonly rows: number },
): DiffViewerPlan {
  validateGeometry(geometry);
  if (collection.files.length === 0) throw new RangeError("diff viewer needs a settled comparison");
  state = normalizeDiffViewerState(collection.files, state);
  const fileIndex = clamp(state.fileIndex, collection.files.length - 1);
  const file = collection.files[fileIndex]!;
  const fileState = state.files[fileIndex] ?? initialFileState(file);
  const selectedLine = clamp(fileState.selectedLine, file.lines.length - 1);
  const selectedHunk = hunkAt(file, selectedLine);
  const selectedChange = changeAtOrBefore(file, selectedLine);
  const hunk = file.hunks[selectedHunk]!;
  const pathLayout = planDiffLayout({ lines: [], path: file.path }, geometry.columns).header;
  const filePosition = {
    current: fileIndex + 1,
    total: collection.files.length,
    hiddenEarlier: collection.hiddenFiles,
  };
  const hunkPosition = { current: selectedHunk + 1, total: file.hunks.length };
  const changePosition = { current: selectedChange + 1, total: file.changes.length };
  const titleLines = titleRows(filePosition, hunkPosition, changePosition, geometry.columns);
  const evidenceLines = file.evidence === undefined ? [] : evidenceRows(geometry.columns);
  const coverageLines =
    file.evidence?.coverageLine === undefined
      ? []
      : hardRows(oneBoundedLine(file.evidence.coverageLine), geometry.columns);
  const availabilityLines = availabilityRows(collection, file.latestTurn, geometry.columns);
  const context = contextRows(
    file.latestTurn ? collection.latestTurnContext : undefined,
    geometry.columns,
  );
  const footerLines = footerRows(geometry.columns);
  const fileSummaryLines = fileSummaryRows(file.summary, geometry.columns);
  const earlierFilesLine =
    collection.hiddenFiles > 0
      ? `… ${String(collection.hiddenFiles)} earlier files outside this review`
      : undefined;
  const hiddenPathLine =
    pathLayout.hiddenCells > 0
      ? `… ${String(pathLayout.hiddenCells)} path cells hidden`
      : undefined;
  // Reserve both possible source-omission disclosures before selecting content. Rendering uses the
  // same hard-cell wrapper, so metadata plus selected rows cannot exceed the physical row budget.
  const fixedRows =
    titleLines.length +
    1 + // filename-first path
    fileSummaryLines.length +
    metadataRows(earlierFilesLine, geometry.columns) +
    metadataRows(hiddenPathLine, geometry.columns) +
    evidenceLines.length +
    coverageLines.length +
    availabilityLines.length +
    context.verificationLines.length +
    context.recoveryLines.length +
    footerLines.length;
  const omissionRows =
    metadataRows(`↑ ${String(file.lines.length)} earlier source rows`, geometry.columns) +
    metadataRows(`↓ ${String(file.lines.length)} later source rows`, geometry.columns);
  const availableContentRows = geometry.rows - fixedRows - omissionRows;
  if (availableContentRows < 1) {
    throw new RangeError("diff viewer geometry cannot fit one content row and its disclosures");
  }
  const contentBudget = Math.min(MAX_DIFF_VIEWER_ROWS, availableContentRows);
  const common = {
    titleLines,
    path: pathLayout.fileName,
    ...(pathLayout.parentPath === undefined ? {} : { parentPath: pathLayout.parentPath }),
    hiddenPathCells: pathLayout.hiddenCells,
    filePosition,
    hunkPosition,
    changePosition,
    fileSummary: file.summary,
    fileSummaryLines,
    ...(file.evidence === undefined
      ? {}
      : {
          evidenceLine: EVIDENCE_LINE,
        }),
    evidenceLines,
    coverageLines,
    availabilityLines,
    verificationLines: context.verificationLines,
    recoveryLines: context.recoveryLines,
    footerLines,
  };

  if (fileState.collapsedHunks.includes(selectedHunk)) {
    return {
      ...common,
      rows: [
        {
          kind: "hunk-summary",
          selected: true,
          text: `▶ hunk ${String(selectedHunk + 1)}/${String(file.hunks.length)} · +${String(hunk.added)} -${String(hunk.deleted)} · ${String(hunk.end - hunk.start)} rows`,
        },
      ],
      hiddenBefore: hunk.start,
      hiddenAfter: file.lines.length - hunk.end,
    };
  }

  // At most five source lines on either side enter the generic layout planner. With its four-row
  // per-source-line cap, the selected source row necessarily remains inside the 40-row layout cap.
  const windowStart = Math.max(hunk.start, selectedLine - 5);
  const windowEnd = Math.min(hunk.end, selectedLine + 6);
  const layout = planDiffLayout(
    {
      lines: file.lines
        .slice(windowStart, windowEnd)
        .map((line, index) => (index === 0 ? { ...line, hunkStart: true } : line)),
      path: file.path,
    },
    geometry.columns,
  );
  const selected = selectWholeLineGroups(layout.rows, selectedLine - windowStart, contentBudget);
  const firstSourceLine = windowStart + selected.firstLine;
  const lastSourceLine = windowStart + selected.lastLine;
  return {
    ...common,
    rows: selected.rows,
    hiddenBefore: firstSourceLine,
    hiddenAfter: file.lines.length - lastSourceLine - 1,
  };
}
