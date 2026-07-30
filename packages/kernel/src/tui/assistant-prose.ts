import { stripControl, stripControlLine } from "./strip.js";
import { expandTerminalTabs, graphemeSpans, terminalDisplayWidth } from "./display-cells.js";
import { visibleTerminalText } from "./visible-text.js";

export type AssistantInline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string }
  | { readonly kind: "emphasis"; readonly text: string }
  | { readonly kind: "code"; readonly text: string };

export type AssistantListItem =
  | {
      readonly marker: "bullet";
      readonly text: readonly AssistantInline[];
    }
  | {
      readonly marker: "ordered";
      readonly ordinal: number;
      readonly text: readonly AssistantInline[];
    };

export type AssistantProseBlock =
  | {
      readonly kind: "paragraph";
      readonly text: readonly AssistantInline[];
    }
  | {
      readonly kind: "heading";
      readonly level: 1 | 2 | 3;
      readonly text: readonly AssistantInline[];
    }
  | {
      readonly kind: "list";
      readonly items: readonly AssistantListItem[];
    }
  | {
      readonly kind: "code";
      readonly language?: string;
      readonly lines: readonly string[];
    }
  | {
      readonly kind: "table";
      readonly headers: readonly (readonly AssistantInline[])[];
      readonly rows: readonly (readonly (readonly AssistantInline[])[])[];
    }
  | {
      readonly kind: "rule";
    };

export interface AssistantProsePlan {
  readonly blocks: readonly AssistantProseBlock[];
  /** Presentation rhythm for each block; parallel to `blocks` and safe across Static chunks. */
  readonly spacing?: readonly ("tight" | "section")[];
}

export interface AssistantLivePreview {
  readonly content: string;
  readonly hiddenLines: number;
}

export interface AssistantStreamingLine {
  readonly text: string;
  readonly sourceStart: number;
  /** This physical line continues the prior line without source whitespace between them. */
  readonly continuesPrevious: boolean;
  /** This physical row belongs to the same source line as the prior physical row. */
  readonly continuesSourceLine: boolean;
  /** Structured rows stay atomic so Markdown semantics survive terminal-width wrapping. */
  readonly logicalKind: "pipe" | "list" | "other";
  /** Overlong active source lines deliberately fall back to bounded literal rendering. */
  readonly literal: boolean;
  /** This logical line is short enough to remain indivisible until its syntax is stable. */
  readonly semanticAtomic: boolean;
  readonly syntax: "prose" | "code" | "fence";
  readonly fenceOpenBefore: boolean;
  readonly language?: string;
}

export interface AssistantStreamingProjection {
  readonly input: string;
  /** Retained normalized source tail; rows before `sourceOffset` already belong to Static. */
  readonly source: string;
  readonly sourceOffset: number;
  readonly columns: number;
  /** Absolute index of `lines[0]`; rows before this are already owned by terminal Static history. */
  readonly lineOffset: number;
  /** Absolute physical-line count, including rows released from this projection. */
  readonly totalLines: number;
  readonly lines: readonly AssistantStreamingLine[];
}

export const LIVE_ASSISTANT_PREVIEW_LINES = 8;
export const MAX_ATOMIC_STREAMING_ROWS = LIVE_ASSISTANT_PREVIEW_LINES;

type TableRow = readonly string[];

function normalizeSource(input: string): string {
  return stripControl(input)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n");
}

function normalizeInput(input: string): readonly string[] {
  return expandTerminalTabs(normalizeSource(input)).split("\n").map(visibleTerminalText);
}

function cleanLine(input: string): string {
  return expandTerminalTabs(visibleTerminalText(stripControlLine(input))).trim();
}

interface StreamingPart {
  readonly text: string;
  readonly width: number;
  readonly whitespace: boolean;
  readonly start: number;
}

function streamingParts(line: string, sourceStart: number): readonly StreamingPart[] {
  if (/^[\x20-\x7e\t]*$/u.test(line)) {
    return [...line].map((text, index) => ({
      text: text === "\t" ? expandTerminalTabs(text) : text,
      width: text === "\t" ? 4 : 1,
      whitespace: /\s/u.test(text),
      start: sourceStart + index,
    }));
  }
  return graphemeSpans(line).map((span) => {
    const text =
      span.text === "\t" ? expandTerminalTabs(span.text) : visibleTerminalText(span.text);
    return {
      text,
      width: terminalDisplayWidth(text),
      whitespace: /\s/u.test(span.text),
      start: sourceStart + span.start,
    };
  });
}

function wrapStreamingLine(
  line: string,
  columns: number,
  sourceStart: number,
  initialContinuation = false,
  initialSourceContinuation = false,
  context: {
    readonly syntax: AssistantStreamingLine["syntax"];
    readonly fenceOpenBefore: boolean;
    readonly language?: string;
    readonly logicalKind?: AssistantStreamingLine["logicalKind"];
    readonly literal: boolean;
    readonly semanticAtomic: boolean;
  } = {
    syntax: "prose",
    fenceOpenBefore: false,
    literal: false,
    semanticAtomic: false,
  },
): readonly AssistantStreamingLine[] {
  // History promotion is append-only. Insert line breaks at deterministic grapheme boundaries,
  // but never delete or rewrite source: punctuation in code, shell, tables, and incomplete
  // Markdown remains exact when the promoted rows become permanent terminal history.
  const logicalKind = context.logicalKind ?? "other";
  if (line.length === 0)
    return [
      {
        text: "",
        sourceStart,
        continuesPrevious: initialContinuation,
        continuesSourceLine: initialSourceContinuation,
        logicalKind,
        ...context,
      },
    ];
  const wrapped: AssistantStreamingLine[] = [];
  let current: StreamingPart[] = [];
  let currentWidth = 0;
  let lastWhitespace = -1;
  let continuesPrevious = initialContinuation;
  let continuesSourceLine = initialSourceContinuation;
  const resetCurrent = (remaining: typeof current): void => {
    current = remaining;
    currentWidth = 0;
    lastWhitespace = -1;
    for (const [index, part] of current.entries()) {
      currentWidth += part.width;
      if (part.whitespace) lastWhitespace = index;
    }
  };
  const pushCurrent = (parts: readonly StreamingPart[]): void => {
    if (parts.length === 0) return;
    wrapped.push({
      text: parts.map((part) => part.text).join(""),
      sourceStart: parts[0]!.start,
      continuesPrevious,
      continuesSourceLine,
      logicalKind,
      ...context,
    });
    continuesSourceLine = true;
  };
  for (const segment of streamingParts(line, sourceStart)) {
    while (current.length > 0 && currentWidth + segment.width > columns) {
      const breakAt = lastWhitespace > 0 ? lastWhitespace + 1 : current.length;
      pushCurrent(current.slice(0, breakAt));
      const hardContinuation = breakAt === current.length && lastWhitespace <= 0;
      resetCurrent(current.slice(breakAt));
      continuesPrevious = hardContinuation;
    }
    current.push(segment);
    currentWidth += segment.width;
    if (segment.whitespace) lastWhitespace = current.length - 1;
  }
  pushCurrent(current);
  return wrapped;
}

/** Append-stable, source-preserving physical lines for incremental terminal-history promotion. */
export function assistantStreamingProjection(
  input: string,
  columns: number,
  previous?: AssistantStreamingProjection,
  options: {
    readonly retainFromLine?: number;
    /** Exact reducer-owned append since `previous.input`; avoids an O(total history) prefix proof. */
    readonly appended?: string;
  } = {},
): AssistantStreamingProjection {
  const width = Math.max(20, Math.floor(columns));
  const retained =
    previous?.columns === width && options.retainFromLine !== undefined
      ? retainStreamingTail(previous, options.retainFromLine)
      : previous;
  if (retained?.columns === width && retained.input === input) return retained;

  const appendOnly =
    retained?.columns === width &&
    !retained.input.endsWith("\r") &&
    input.length > retained.input.length &&
    (options.appended !== undefined
      ? input.length === retained.input.length + options.appended.length &&
        input.slice(retained.input.length) === options.appended
      : input.slice(0, retained.input.length) === retained.input);
  const appended = appendOnly
    ? (options.appended ?? input.slice(retained.input.length))
    : undefined;
  const source = appendOnly
    ? `${retained.source}${normalizeSource(appended ?? "")}`
    : normalizeSource(input);
  const sourceOffset = appendOnly ? retained.sourceOffset : 0;

  let prefix: readonly AssistantStreamingLine[] = [];
  let offset = 0;
  let lineOffset = 0;
  let initialContinuation = false;
  let initialSourceContinuation = false;
  let fenceOpen = false;
  let fenceLanguage: string | undefined;
  let continuedSyntax: AssistantStreamingLine["syntax"] | undefined;
  let continuedLogicalKind: AssistantStreamingLine["logicalKind"] | undefined;
  let continuedLiteral = false;
  if (appendOnly && retained.lines.length > 0) {
    // A trailing grapheme can change terminal width when an appended ZWJ/code point joins it.
    // Reproject its row and the row it may pull back into; earlier physical rows remain stable.
    let restartIndex = Math.max(0, retained.lines.length - 2);
    if (retained.lines.at(-1)?.semanticAtomic === true) {
      while (restartIndex > 0 && retained.lines[restartIndex]?.continuesSourceLine) {
        restartIndex -= 1;
      }
    }
    const restart = retained.lines[restartIndex]!;
    prefix = retained.lines.slice(0, restartIndex);
    offset = restart.sourceStart;
    lineOffset = retained.lineOffset;
    initialContinuation = restart.continuesPrevious;
    initialSourceContinuation = restart.continuesSourceLine;
    fenceOpen = restart.fenceOpenBefore;
    fenceLanguage = restart.language;
    const relativeRestart = restart.sourceStart - retained.sourceOffset;
    const resumesLogicalLine = relativeRestart > 0 && retained.source[relativeRestart - 1] !== "\n";
    continuedSyntax = resumesLogicalLine ? restart.syntax : undefined;
    continuedLogicalKind = resumesLogicalLine ? restart.logicalKind : undefined;
    continuedLiteral = resumesLogicalLine && restart.literal;
  }

  const suffix = source.slice(offset - sourceOffset);
  const lines: AssistantStreamingLine[] = [...prefix];
  let lineStart = 0;
  for (;;) {
    const newline = suffix.indexOf("\n", lineStart);
    const end = newline === -1 ? suffix.length : newline;
    const logicalLine = suffix.slice(lineStart, end);
    const trimmed = logicalLine.trim();
    const resumed = lineStart === 0 && continuedSyntax !== undefined;
    const syntax: AssistantStreamingLine["syntax"] =
      lineStart === 0 && continuedSyntax !== undefined
        ? continuedSyntax
        : trimmed.startsWith("```")
          ? "fence"
          : fenceOpen
            ? "code"
            : "prose";
    const language =
      syntax === "fence" && !fenceOpen
        ? resumed
          ? fenceLanguage
          : cleanLine(trimmed.slice(3)).split(/\s+/u).filter(Boolean)[0]
        : fenceLanguage;
    const logicalKind = resumed
      ? (continuedLogicalKind ?? "other")
      : syntax === "prose" && logicalLine.trim().includes("|")
        ? "pipe"
        : syntax === "prose" && parseListLine(logicalLine) !== undefined
          ? "list"
          : "other";
    const provisionalRows = wrapStreamingLine(
      logicalLine,
      width,
      offset + lineStart,
      lineStart === 0 ? initialContinuation : false,
      lineStart === 0 ? initialSourceContinuation : false,
      {
        syntax,
        fenceOpenBefore: fenceOpen,
        logicalKind,
        literal: false,
        semanticAtomic: false,
        ...(language !== undefined ? { language } : {}),
      },
    );
    const literal =
      syntax === "prose" &&
      ((resumed && continuedLiteral) || provisionalRows.length > MAX_ATOMIC_STREAMING_ROWS);
    lines.push(
      ...provisionalRows.map((row) => ({
        ...row,
        logicalKind: literal ? ("other" as const) : row.logicalKind,
        literal,
        semanticAtomic: syntax === "prose" && !literal,
      })),
    );
    if (syntax === "fence") {
      if (fenceOpen) {
        fenceOpen = false;
        fenceLanguage = undefined;
      } else {
        fenceOpen = true;
        fenceLanguage = language;
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return {
    input,
    source,
    sourceOffset,
    columns: width,
    lineOffset,
    totalLines: lineOffset + lines.length,
    lines,
  };
}

function retainStreamingTail(
  projection: AssistantStreamingProjection,
  retainFromLine: number,
): AssistantStreamingProjection {
  // Keep two rows before the append boundary because one trailing grapheme can change width and pull
  // content across a physical wrap. Older rows are immutable and already owned by Ink's Static ledger.
  const requestedDrop = Math.max(0, Math.floor(retainFromLine) - projection.lineOffset);
  let drop = Math.min(requestedDrop, Math.max(0, projection.lines.length - 2));
  while (
    drop > 0 &&
    projection.lines[drop]?.semanticAtomic === true &&
    projection.lines[drop]?.continuesSourceLine
  ) {
    drop -= 1;
  }
  if (drop === 0) return projection;
  const firstRetained = projection.lines[drop]!;
  const sourceOffset = firstRetained.sourceStart;
  return {
    ...projection,
    source: projection.source.slice(sourceOffset - projection.sourceOffset),
    sourceOffset,
    lineOffset: projection.lineOffset + drop,
    lines: projection.lines.slice(drop),
  };
}

/** Width-stable source lines for incremental terminal-history promotion while an answer streams. */
export function assistantStreamingSource(input: string, columns: number): string {
  return assistantStreamingProjection(input, columns)
    .lines.map((line) => line.text)
    .join("\n");
}

function mergeInline(segments: AssistantInline[]): readonly AssistantInline[] {
  const merged: AssistantInline[] = [];
  for (const segment of segments) {
    if (segment.text.length === 0) continue;
    const prev = merged.at(-1);
    if (prev !== undefined && prev.kind === segment.kind) {
      merged[merged.length - 1] = { kind: prev.kind, text: `${prev.text}${segment.text}` };
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

export function assistantInlineText(segments: readonly AssistantInline[]): string {
  return segments.map((segment) => segment.text).join("");
}

export function assistantProseInline(input: string): readonly AssistantInline[] {
  const text = expandTerminalTabs(stripControlLine(input));
  const segments: AssistantInline[] = [];
  let i = 0;
  while (i < text.length) {
    const strongStar = text.indexOf("**", i);
    const strongUnderscore = text.indexOf("__", i);
    const code = text.indexOf("`", i);
    const emphasisStar = text.indexOf("*", i);
    const emphasisUnderscore = text.indexOf("_", i);
    const candidates = [
      strongStar === -1 ? undefined : { at: strongStar, marker: "**" as const },
      strongUnderscore === -1 ? undefined : { at: strongUnderscore, marker: "__" as const },
      code === -1 ? undefined : { at: code, marker: "`" as const },
      emphasisStar === -1 ? undefined : { at: emphasisStar, marker: "*" as const },
      emphasisUnderscore === -1 ? undefined : { at: emphasisUnderscore, marker: "_" as const },
    ].filter(
      (c): c is { readonly at: number; readonly marker: "**" | "__" | "`" | "*" | "_" } =>
        c !== undefined,
    );
    candidates.sort((a, b) => a.at - b.at || b.marker.length - a.marker.length);
    const next = candidates[0];
    if (next === undefined) {
      segments.push({ kind: "text", text: text.slice(i) });
      break;
    }
    if (next.at > i) segments.push({ kind: "text", text: text.slice(i, next.at) });
    const contentStart = next.at + next.marker.length;
    if (
      next.marker.length === 1 &&
      (text[next.at - 1] === next.marker ||
        text[contentStart] === next.marker ||
        (next.marker === "_" && /[\p{L}\p{N}]/u.test(text[next.at - 1] ?? "")))
    ) {
      segments.push({ kind: "text", text: next.marker });
      i = contentStart;
      continue;
    }
    const close = text.indexOf(next.marker, contentStart);
    const validSingleClose =
      next.marker.length > 1 ||
      (close > contentStart &&
        text[close - 1] !== next.marker &&
        text[close + 1] !== next.marker &&
        (next.marker !== "_" || !/[\p{L}\p{N}]/u.test(text[close + 1] ?? "")));
    if (close === -1 || !validSingleClose) {
      segments.push({ kind: "text", text: text.slice(next.at, contentStart) });
      i = contentStart;
      continue;
    }
    const content = text.slice(contentStart, close);
    segments.push({
      kind: next.marker === "`" ? "code" : next.marker.length === 1 ? "emphasis" : "strong",
      text: content,
    });
    i = close + next.marker.length;
  }
  return mergeInline(segments);
}

export function assistantLivePreview(
  input: string,
  maxLines = LIVE_ASSISTANT_PREVIEW_LINES,
): AssistantLivePreview {
  const lines = normalizeInput(input);
  const limit = Math.max(1, Math.floor(maxLines));
  if (lines.length <= limit) return { content: lines.join("\n"), hiddenLines: 0 };
  const hiddenLines = lines.length - limit;
  return {
    content: lines.slice(hiddenLines).join("\n"),
    hiddenLines,
  };
}

export function assistantLivePreviewNotice(hiddenLines: number): string {
  const count = Math.max(0, Math.floor(hiddenLines));
  return count === 1
    ? "… 1 earlier live line hidden until turn finishes"
    : `… ${count} earlier live lines hidden until turn finishes`;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function parseHeading(line: string):
  | {
      readonly level: 1 | 2 | 3;
      readonly text: readonly AssistantInline[];
    }
  | undefined {
  const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line.trim());
  if (m === null) return undefined;
  return {
    level: m[1]!.length as 1 | 2 | 3,
    text: assistantProseInline(m[2]!),
  };
}

function isRule(line: string): boolean {
  return /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function parseListLine(line: string): AssistantListItem | undefined {
  const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
  if (bullet !== null) {
    return { marker: "bullet", text: assistantProseInline(bullet[1]!) };
  }
  const ordered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
  if (ordered !== null) {
    return {
      marker: "ordered",
      ordinal: Number.parseInt(ordered[1]!, 10),
      text: assistantProseInline(ordered[2]!),
    };
  }
  return undefined;
}

function parsePipeRow(line: string): TableRow | undefined {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return undefined;
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = body.split("|").map((cell) => cleanLine(cell));
  return cells.length >= 2 ? cells : undefined;
}

function isSeparatorRow(row: TableRow | undefined): boolean {
  return row !== undefined && row.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableAt(lines: readonly string[], i: number): boolean {
  const header = parsePipeRow(lines[i] ?? "");
  const separator = parsePipeRow(lines[i + 1] ?? "");
  return header !== undefined && header.length >= 2 && isSeparatorRow(separator);
}

function isBlockStart(lines: readonly string[], i: number): boolean {
  const line = lines[i] ?? "";
  return (
    isBlank(line) ||
    line.trim().startsWith("```") ||
    parseHeading(line) !== undefined ||
    isRule(line) ||
    parseListLine(line) !== undefined ||
    tableAt(lines, i)
  );
}

function paddedRow(row: TableRow, length: number): TableRow {
  return Array.from({ length }, (_, i) => row[i] ?? "");
}

export function assistantProsePlan(input: string): AssistantProsePlan {
  return assistantProseRangePlan(input, 0, Number.POSITIVE_INFINITY);
}

/** Parse a source-line range with full-document block context for immutable streaming chunks. */
export function assistantProseRangePlan(
  input: string,
  startLine: number,
  endLine: number,
): AssistantProsePlan {
  return assistantProseRangePlanWithContinuations(input, startLine, endLine, new Set());
}

/** Parse projected streaming rows while preserving hard token continuations exactly. */
export function assistantStreamingRangePlan(
  projection: AssistantStreamingProjection,
  startLine: number,
  endLine: number,
): AssistantProsePlan {
  const start = Math.max(0, Math.floor(startLine));
  const end = Math.max(start, Math.min(projection.totalLines, Math.floor(endLine)));
  if (start < projection.lineOffset) {
    throw new RangeError(
      `streaming rows before ${projection.lineOffset} are already owned by terminal history`,
    );
  }
  const selectedRows = projection.lines.slice(
    start - projection.lineOffset,
    end - projection.lineOffset,
  );
  const selected: AssistantStreamingLine[] = [];
  for (const line of selectedRows) {
    const previous = selected.at(-1);
    if (
      line.logicalKind !== "other" &&
      line.continuesSourceLine &&
      previous?.logicalKind === line.logicalKind
    ) {
      selected[selected.length - 1] = { ...previous, text: `${previous.text}${line.text}` };
    } else {
      selected.push(line);
    }
  }
  const blocks: AssistantProseBlock[] = [];
  let index = 0;
  while (index < selected.length) {
    const line = selected[index]!;
    if (line.literal) {
      let text = line.text;
      index += 1;
      while (index < selected.length && selected[index]?.literal) {
        const continuation = selected[index]!;
        if (!continuation.continuesSourceLine) break;
        text += continuation.text;
        index += 1;
      }
      blocks.push({
        kind: "paragraph",
        text: [{ kind: "text", text: cleanLine(text).replace(/\s+/gu, " ") }],
      });
      continue;
    }
    if (line.syntax === "fence") {
      index += 1;
      continue;
    }
    if (line.syntax === "code") {
      const language = line.language;
      const codeLines: string[] = [];
      while (
        index < selected.length &&
        selected[index]?.syntax === "code" &&
        selected[index]?.language === language
      ) {
        const code = selected[index]!;
        if (code.continuesPrevious && codeLines.length > 0) {
          codeLines[codeLines.length - 1] += stripControlLine(code.text);
        } else {
          codeLines.push(stripControlLine(code.text));
        }
        index += 1;
      }
      if (codeLines.length > 0) {
        blocks.push({
          kind: "code",
          lines: codeLines,
          ...(language !== undefined ? { language } : {}),
        });
      }
      continue;
    }
    const prose: AssistantStreamingLine[] = [];
    while (index < selected.length && selected[index]?.syntax === "prose") {
      prose.push(selected[index]!);
      index += 1;
    }
    const continuations = new Set<number>();
    prose.forEach((entry, proseIndex) => {
      if (entry.continuesPrevious) continuations.add(proseIndex);
    });
    blocks.push(
      ...assistantProseRangePlanWithContinuations(
        prose.map((entry) => entry.text).join("\n"),
        0,
        prose.length,
        continuations,
      ).blocks,
    );
  }
  return withBlockSpacing(blocks, streamingLeadingSpacing(projection, start, selectedRows));
}

/** Move an immutable-history boundary away from a wrapped row or partial Markdown table. */
export function assistantStreamingCommitBoundary(
  projection: AssistantStreamingProjection,
  requestedLine: number,
): number {
  const requested = Math.max(
    projection.lineOffset,
    Math.min(projection.totalLines, Math.floor(requestedLine)),
  );
  let index = requested - projection.lineOffset;
  while (
    index > 0 &&
    projection.lines[index]?.continuesSourceLine &&
    projection.lines[index]?.semanticAtomic === true
  ) {
    index -= 1;
  }
  const before = projection.lines[index - 1];
  const after = projection.lines[index];
  if (
    index > 0 &&
    after?.text === "" &&
    projection.lineOffset + index === projection.totalLines - 1 &&
    before?.semanticAtomic === true
  ) {
    index -= 1;
    while (index > 0 && projection.lines[index]?.continuesSourceLine) index -= 1;
  }
  const stableBefore = projection.lines[index - 1];
  const stableAfter = projection.lines[index];
  if (stableBefore?.logicalKind === "pipe" && stableAfter?.logicalKind === "pipe") {
    while (index > 0 && projection.lines[index - 1]?.logicalKind === "pipe") index -= 1;
  }
  return projection.lineOffset + index;
}

function streamingLineBlockKind(line: AssistantStreamingLine): AssistantProseBlock["kind"] {
  if (line.syntax === "code" || line.syntax === "fence") return "code";
  if (line.logicalKind === "pipe") return "table";
  if (parseHeading(line.text) !== undefined) return "heading";
  if (parseListLine(line.text) !== undefined) return "list";
  if (isRule(line.text)) return "rule";
  return "paragraph";
}

function streamingLeadingSpacing(
  projection: AssistantStreamingProjection,
  startLine: number,
  selected: readonly AssistantStreamingLine[],
): "tight" | "section" {
  if (startLine <= 0) return "tight";
  const localCurrent = selected.findIndex((line) => !isBlank(line.text));
  if (localCurrent < 0) return "tight";
  const currentLine = selected[localCurrent];
  if (currentLine === undefined || currentLine.continuesSourceLine) return "tight";
  const absoluteCurrent = startLine - projection.lineOffset + localCurrent;
  let previous = absoluteCurrent - 1;
  let blankBetween = false;
  let previousLine: AssistantStreamingLine | undefined;
  // Retention deliberately keeps two look-behind rows; keep this lookup bounded as well.
  for (let lookbehind = 0; lookbehind < 2 && previous >= 0; lookbehind += 1, previous -= 1) {
    const candidate =
      previous >= startLine - projection.lineOffset
        ? selected[previous - (startLine - projection.lineOffset)]
        : projection.lines[previous];
    if (candidate === undefined) break;
    if (isBlank(candidate.text)) {
      blankBetween = true;
      continue;
    }
    previousLine = candidate;
    break;
  }
  if (previousLine === undefined)
    return streamingLineBlockKind(currentLine) === "heading" ? "section" : "tight";
  const currentKind = streamingLineBlockKind(currentLine);
  const previousKind = streamingLineBlockKind(previousLine);
  if (previousKind === "heading") return "tight";
  if (currentKind === previousKind && ["list", "table", "code"].includes(currentKind)) {
    return "tight";
  }
  if (currentKind === "paragraph" && previousKind === "paragraph" && !blankBetween) {
    return "tight";
  }
  return "section";
}

function withBlockSpacing(
  blocks: readonly AssistantProseBlock[],
  leading: "tight" | "section" = "tight",
): AssistantProsePlan {
  const spacing = blocks.map((_block, index) => {
    if (index === 0) return leading;
    const previous = blocks[index - 1];
    if (previous?.kind === "heading") return "tight";
    return "section";
  });
  return { blocks, spacing };
}

function assistantProseRangePlanWithContinuations(
  input: string,
  startLine: number,
  endLine: number,
  continuations: ReadonlySet<number>,
): AssistantProsePlan {
  const lines = normalizeInput(input);
  const blocks: AssistantProseBlock[] = [];
  const start = Math.max(0, Math.floor(startLine));
  const end = Math.max(start, Math.min(lines.length, Math.floor(endLine)));
  const included = (line: number): boolean => line >= start && line < end;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      const language = cleanLine(trimmed.slice(3)).split(/\s+/).filter(Boolean)[0];
      const codeLines: { readonly line: number; readonly content: string }[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        codeLines.push({ line: i, content: stripControlLine(lines[i] ?? "") });
        i += 1;
      }
      if (i < lines.length) i += 1;
      const selected = codeLines.filter((entry) => included(entry.line));
      if (selected.length > 0) {
        const selectedLines: string[] = [];
        for (const entry of selected) {
          if (continuations.has(entry.line) && selectedLines.length > 0) {
            selectedLines[selectedLines.length - 1] += entry.content;
          } else {
            selectedLines.push(entry.content);
          }
        }
        blocks.push({
          kind: "code",
          lines: selectedLines,
          ...(language !== undefined ? { language } : {}),
        });
      }
      continue;
    }

    const heading = parseHeading(line);
    if (heading !== undefined) {
      if (included(i)) blocks.push({ kind: "heading", ...heading });
      i += 1;
      continue;
    }

    if (isRule(line)) {
      if (included(i)) blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }

    if (tableAt(lines, i)) {
      const header = parsePipeRow(lines[i] ?? "")!;
      i += 2;
      const rows: { readonly line: number; readonly row: TableRow }[] = [];
      while (i < lines.length) {
        const row = parsePipeRow(lines[i] ?? "");
        if (row === undefined || isSeparatorRow(row)) break;
        rows.push({ line: i, row: paddedRow(row, header.length) });
        i += 1;
      }
      const selected = rows.filter((entry) => included(entry.line));
      if (selected.length > 0) {
        blocks.push({
          kind: "table",
          headers: header.map((cell) => assistantProseInline(cell)),
          rows: selected.map((entry) => entry.row.map((cell) => assistantProseInline(cell))),
        });
      }
      continue;
    }

    const firstList = parseListLine(line);
    if (firstList !== undefined) {
      const items = [{ line: i, item: firstList }];
      i += 1;
      while (i < lines.length) {
        const item = parseListLine(lines[i] ?? "");
        if (item === undefined) break;
        items.push({ line: i, item });
        i += 1;
      }
      const selected = items.filter((entry) => included(entry.line));
      if (selected.length > 0) {
        blocks.push({ kind: "list", items: selected.map((entry) => entry.item) });
      }
      continue;
    }

    const paragraph: { readonly line: number; readonly content: string }[] = [
      { line: i, content: cleanLine(line) },
    ];
    i += 1;
    while (i < lines.length && !isBlockStart(lines, i)) {
      paragraph.push({ line: i, content: cleanLine(lines[i] ?? "") });
      i += 1;
    }
    const selected = paragraph.filter((entry) => included(entry.line));
    if (selected.length > 0) {
      const content = selected.reduce((joined, entry, index) => {
        if (index === 0) return entry.content;
        return `${joined}${continuations.has(entry.line) ? "" : " "}${entry.content}`;
      }, "");
      blocks.push({
        kind: "paragraph",
        text: assistantProseInline(content.replace(/\s+/g, " ")),
      });
    }
  }
  return withBlockSpacing(blocks);
}

function renderTableRow(
  headers: readonly (readonly AssistantInline[])[],
  row: readonly (readonly AssistantInline[])[],
): string | undefined {
  const first = assistantInlineText(row[0]!).trim();
  const rest = row
    .slice(1)
    .map((cell, i) => {
      const label = assistantInlineText(headers[i + 1]!).trim();
      const value = assistantInlineText(cell).trim();
      if (value.length === 0) return undefined;
      return label.length > 0 ? `${label}: ${value}` : value;
    })
    .filter((part): part is string => part !== undefined);
  if (first.length === 0 && rest.length === 0) return undefined;
  return rest.length > 0 ? `${first} — ${rest.join(" · ")}` : first;
}

export function renderAssistantProsePlanText(plan: AssistantProsePlan): string {
  const lines: string[] = [];
  const pushBreak = (): void => {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
  };

  for (const [index, block] of plan.blocks.entries()) {
    if (block.kind === "rule") {
      pushBreak();
      continue;
    }
    if ((plan.spacing?.[index] ?? (index === 0 ? "tight" : "section")) === "section") {
      pushBreak();
    }
    if (block.kind === "paragraph" || block.kind === "heading") {
      lines.push(assistantInlineText(block.text));
    } else if (block.kind === "list") {
      for (const item of block.items) {
        const marker = item.marker === "ordered" ? `${item.ordinal}.` : "•";
        lines.push(`${marker} ${assistantInlineText(item.text)}`);
      }
    } else if (block.kind === "code") {
      lines.push(...block.lines.map((line) => `  ${line}`));
    } else if (block.kind === "table") {
      for (const row of block.rows) {
        const rendered = renderTableRow(block.headers, row);
        if (rendered !== undefined) lines.push(rendered);
      }
    }
  }
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

export function renderAssistantProseText(input: string): string {
  return renderAssistantProsePlanText(assistantProsePlan(input));
}
