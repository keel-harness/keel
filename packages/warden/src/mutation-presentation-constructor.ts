import {
  MutationPresentationV1,
  type MutationPresentationComparisonLineV1T,
  type MutationPresentationHunkV1T,
  type MutationPresentationObservedBeforeV1T,
  type MutationPresentationVerifiedInstalledAfterV1T,
  type MutationPresentationV1T,
} from "@keel/shared";
import {
  MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES,
  MUTATION_PRESENTATION_MAX_HUNKS,
  MUTATION_PRESENTATION_MAX_LINE_BYTES,
  MUTATION_PRESENTATION_MAX_PATH_BYTES,
  MUTATION_PRESENTATION_MAX_PRESENTED_LINES,
  MUTATION_PRESENTATION_YIELD_BYTE_WORK,
  MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS,
  ConstructionBudgetExceededError,
  assertArtifactWithinQuantitativeBounds,
} from "./mutation-presentation-bounds.js";
import { redactMutationPresentationLines } from "./mutation-presentation-redaction.js";
import type {
  MutationPresentationConstructionControl,
  WardenMutationPresentationConstructionCandidateV1,
} from "./mutation-presentation-walking-skeleton.js";

const DIFF_CONTEXT_LINES = 3;
const MAX_COMPARISON_RENDERED_BYTES = Math.floor(MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES / 2);

interface TextImage {
  readonly contentClass: "text";
  readonly finalNewline: boolean;
  readonly lines: readonly string[];
}

interface BinaryImage {
  readonly contentClass: "binary";
  readonly finalNewline: boolean;
}

type InspectedImage = TextImage | BinaryImage;

type RawComparisonLine =
  | {
      readonly kind: "context";
      readonly text: string;
      readonly observedBeforeLine: number;
      readonly installedAfterLine: number;
    }
  | {
      readonly kind: "observed-before";
      readonly text: string;
      readonly observedBeforeLine: number;
    }
  | {
      readonly kind: "installed-after";
      readonly text: string;
      readonly installedAfterLine: number;
    };

interface IndexRange {
  readonly start: number;
  readonly end: number;
}

function hasFinalNewline(content: string | Uint8Array): boolean {
  if (typeof content === "string") return content.endsWith("\n");
  return content.byteLength > 0 && content[content.byteLength - 1] === 0x0a;
}

function utf8ScalarBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function boundedStringChunkEnd(content: string, start: number): number {
  let bytes = 0;
  let cursor = start;
  while (cursor < content.length) {
    const codePoint = content.codePointAt(cursor)!;
    const encodedBytes = utf8ScalarBytes(codePoint);
    if (bytes + encodedBytes > MUTATION_PRESENTATION_YIELD_BYTE_WORK) break;
    bytes += encodedBytes;
    cursor += codePoint > 0xffff ? 2 : 1;
  }
  return cursor;
}

interface LogicalLineCollector {
  readonly lines: string[];
  readonly fragments: string[];
  indexedSinceAccount: number;
}

async function collectDecodedChunk(
  decoded: string,
  collector: LogicalLineCollector,
  control: MutationPresentationConstructionControl,
): Promise<void> {
  let start = 0;
  for (;;) {
    const newline = decoded.indexOf("\n", start);
    if (newline < 0) {
      if (start < decoded.length) collector.fragments.push(decoded.slice(start));
      return;
    }
    collector.fragments.push(decoded.slice(start, newline));
    collector.lines.push(collector.fragments.join(""));
    collector.fragments.length = 0;
    collector.indexedSinceAccount += 1;
    if (collector.indexedSinceAccount === MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS) {
      await control.account({ indexedLines: collector.indexedSinceAccount });
      collector.indexedSinceAccount = 0;
    }
    start = newline + 1;
  }
}

async function inspectImage(
  content: string | Uint8Array,
  control: MutationPresentationConstructionControl,
): Promise<InspectedImage> {
  const finalNewline = hasFinalNewline(content);
  const collector: LogicalLineCollector = { lines: [], fragments: [], indexedSinceAccount: 0 };
  if (typeof content === "string") {
    let cursor = 0;
    while (cursor < content.length) {
      const end = boundedStringChunkEnd(content, cursor);
      const chunk = content.slice(cursor, end);
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (chunk.includes("\0")) {
        await control.account({ byteWork: bytes });
        return { contentClass: "binary", finalNewline };
      }
      await collectDecodedChunk(chunk, collector, control);
      await control.account({ byteWork: bytes });
      cursor = end;
    }
  } else {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (
      let start = 0;
      start < content.byteLength;
      start += MUTATION_PRESENTATION_YIELD_BYTE_WORK
    ) {
      const end = Math.min(content.byteLength, start + MUTATION_PRESENTATION_YIELD_BYTE_WORK);
      const chunk = content.subarray(start, end);
      if (chunk.includes(0)) {
        await control.account({ byteWork: chunk.byteLength });
        return { contentClass: "binary", finalNewline };
      }
      try {
        await collectDecodedChunk(
          decoder.decode(chunk, { stream: end < content.byteLength }),
          collector,
          control,
        );
      } catch {
        await control.account({ byteWork: chunk.byteLength });
        return { contentClass: "binary", finalNewline };
      }
      await control.account({ byteWork: chunk.byteLength });
    }
  }
  if (!finalNewline && (content.length > 0 || collector.fragments.length > 0)) {
    collector.lines.push(collector.fragments.join(""));
    collector.indexedSinceAccount += 1;
  }
  if (collector.indexedSinceAccount > 0) {
    await control.account({ indexedLines: collector.indexedSinceAccount });
  }
  return { contentClass: "text", finalNewline, lines: collector.lines };
}

class ScalarAccountant {
  readonly #control: MutationPresentationConstructionControl;
  #pending = 0;

  constructor(control: MutationPresentationConstructionControl) {
    this.#control = control;
  }

  compared(): boolean {
    this.#pending += 1;
    return this.#pending >= MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS;
  }

  async flush(): Promise<void> {
    if (this.#pending === 0) return;
    const scalarOperations = this.#pending;
    this.#pending = 0;
    await this.#control.account({ scalarOperations });
  }
}

async function lcsRow(
  left: readonly string[],
  leftStart: number,
  leftEnd: number,
  right: readonly string[],
  rightStart: number,
  rightEnd: number,
  reverse: boolean,
  accountant: ScalarAccountant,
): Promise<number[]> {
  const width = rightEnd - rightStart;
  let previous = new Array<number>(width + 1).fill(0);
  let current = new Array<number>(width + 1).fill(0);
  const height = leftEnd - leftStart;
  for (let row = 0; row < height; row += 1) {
    current[0] = 0;
    const leftIndex = reverse ? leftEnd - 1 - row : leftStart + row;
    for (let column = 0; column < width; column += 1) {
      const rightIndex = reverse ? rightEnd - 1 - column : rightStart + column;
      if (accountant.compared()) await accountant.flush();
      current[column + 1] =
        left[leftIndex] === right[rightIndex]
          ? previous[column]! + 1
          : Math.max(previous[column + 1]!, current[column]!);
    }
    [previous, current] = [current, previous];
  }
  return previous;
}

async function lcsMatches(
  left: readonly string[],
  leftStart: number,
  leftEnd: number,
  right: readonly string[],
  rightStart: number,
  rightEnd: number,
  accountant: ScalarAccountant,
  output: Array<readonly [number, number]>,
): Promise<void> {
  if (leftStart >= leftEnd || rightStart >= rightEnd) return;
  if (leftEnd - leftStart === 1) {
    for (let rightIndex = rightStart; rightIndex < rightEnd; rightIndex += 1) {
      if (accountant.compared()) await accountant.flush();
      if (left[leftStart] === right[rightIndex]) {
        output.push([leftStart, rightIndex]);
        return;
      }
    }
    return;
  }

  const leftMiddle = leftStart + Math.floor((leftEnd - leftStart) / 2);
  const forward = await lcsRow(
    left,
    leftStart,
    leftMiddle,
    right,
    rightStart,
    rightEnd,
    false,
    accountant,
  );
  const backward = await lcsRow(
    left,
    leftMiddle,
    leftEnd,
    right,
    rightStart,
    rightEnd,
    true,
    accountant,
  );
  const width = rightEnd - rightStart;
  let split = 0;
  let best = -1;
  for (let index = 0; index <= width; index += 1) {
    const score = forward[index]! + backward[width - index]!;
    if (score > best) {
      best = score;
      split = index;
    }
  }
  const rightMiddle = rightStart + split;
  await lcsMatches(left, leftStart, leftMiddle, right, rightStart, rightMiddle, accountant, output);
  await lcsMatches(left, leftMiddle, leftEnd, right, rightMiddle, rightEnd, accountant, output);
}

function rawComparison(
  observed: readonly string[],
  installed: readonly string[],
  matches: readonly (readonly [number, number])[],
): RawComparisonLine[] {
  const lines: RawComparisonLine[] = [];
  let observedIndex = 0;
  let installedIndex = 0;
  for (const [matchedObserved, matchedInstalled] of matches) {
    while (observedIndex < matchedObserved) {
      lines.push({
        kind: "observed-before",
        text: observed[observedIndex]!,
        observedBeforeLine: observedIndex + 1,
      });
      observedIndex += 1;
    }
    while (installedIndex < matchedInstalled) {
      lines.push({
        kind: "installed-after",
        text: installed[installedIndex]!,
        installedAfterLine: installedIndex + 1,
      });
      installedIndex += 1;
    }
    lines.push({
      kind: "context",
      text: observed[matchedObserved]!,
      observedBeforeLine: matchedObserved + 1,
      installedAfterLine: matchedInstalled + 1,
    });
    observedIndex = matchedObserved + 1;
    installedIndex = matchedInstalled + 1;
  }
  while (observedIndex < observed.length) {
    lines.push({
      kind: "observed-before",
      text: observed[observedIndex]!,
      observedBeforeLine: observedIndex + 1,
    });
    observedIndex += 1;
  }
  while (installedIndex < installed.length) {
    lines.push({
      kind: "installed-after",
      text: installed[installedIndex]!,
      installedAfterLine: installedIndex + 1,
    });
    installedIndex += 1;
  }
  return lines;
}

function selectedRanges(lines: readonly RawComparisonLine[]): IndexRange[] {
  const changed = lines.flatMap((line, index) => (line.kind === "context" ? [] : [index]));
  if (changed.length === 0) return [];
  const ranges: IndexRange[] = [];
  for (const index of changed) {
    const start = Math.max(0, index - DIFF_CONTEXT_LINES);
    const end = Math.min(lines.length, index + DIFF_CONTEXT_LINES + 1);
    const previous = ranges.at(-1);
    if (previous !== undefined && start <= previous.end) {
      ranges[ranges.length - 1] = { start: previous.start, end: Math.max(previous.end, end) };
    } else {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

function boundedRanges(ranges: readonly IndexRange[]): IndexRange[] {
  const output: IndexRange[] = [];
  let remaining = MUTATION_PRESENTATION_MAX_PRESENTED_LINES;
  for (const range of ranges.slice(0, MUTATION_PRESENTATION_MAX_HUNKS)) {
    if (remaining === 0) break;
    const end = Math.min(range.end, range.start + remaining);
    output.push({ start: range.start, end });
    remaining -= end - range.start;
  }
  return output;
}

function prefixRanges(ranges: readonly IndexRange[], lineLimit: number): IndexRange[] {
  const output: IndexRange[] = [];
  let remaining = lineLimit;
  for (const range of ranges) {
    if (remaining === 0) break;
    const end = Math.min(range.end, range.start + remaining);
    output.push({ start: range.start, end });
    remaining -= end - range.start;
  }
  return output;
}

function includesEveryChangedLine(
  lines: readonly RawComparisonLine[],
  ranges: readonly IndexRange[],
): boolean {
  let rangeIndex = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.kind === "context") continue;
    while (ranges[rangeIndex] !== undefined && ranges[rangeIndex]!.end <= index) rangeIndex += 1;
    const range = ranges[rangeIndex];
    if (range === undefined || index < range.start || index >= range.end) return false;
  }
  return true;
}

function consumedBefore(
  lines: readonly RawComparisonLine[],
  end: number,
  side: "observed" | "installed",
): number {
  let count = 0;
  for (let index = 0; index < end; index += 1) {
    const line = lines[index]!;
    if (side === "observed" ? line.kind !== "installed-after" : line.kind !== "observed-before") {
      count += 1;
    }
  }
  return count;
}

function hunkStart(
  lines: readonly RawComparisonLine[],
  range: IndexRange,
  side: "observed" | "installed",
): number {
  for (let index = range.start; index < range.end; index += 1) {
    const line = lines[index]!;
    if (side === "observed" && line.kind !== "installed-after") {
      return line.observedBeforeLine;
    }
    if (side === "installed" && line.kind !== "observed-before") {
      return line.installedAfterLine;
    }
  }
  const consumed = consumedBefore(lines, range.start, side);
  // Zero is valid only for a genuinely empty side, such as an absent observed image receiving only
  // additions. A non-empty side returned its exact one-based source line above.
  return consumed;
}

async function comparisonForText(
  observed: readonly string[],
  installed: readonly string[],
  control: MutationPresentationConstructionControl,
): Promise<MutationPresentationV1T["comparison"]> {
  const accountant = new ScalarAccountant(control);
  const matches: Array<readonly [number, number]> = [];
  await lcsMatches(
    observed,
    0,
    observed.length,
    installed,
    0,
    installed.length,
    accountant,
    matches,
  );
  await accountant.flush();
  const raw = rawComparison(observed, installed, matches);
  const admittedRanges = boundedRanges(selectedRanges(raw));
  const admittedLines = admittedRanges.flatMap((range) => raw.slice(range.start, range.end));
  const redacted = await redactMutationPresentationLines(
    admittedLines.map((line) => line.text),
    {
      control,
      maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES,
      maxRenderedBytesTotal: MAX_COMPARISON_RENDERED_BYTES,
    },
  );
  const ranges = prefixRanges(admittedRanges, redacted.lines.length);
  const selected = ranges.flatMap((range) => raw.slice(range.start, range.end));
  let selectedIndex = 0;
  let truncated = redacted.outputTruncated || !includesEveryChangedLine(raw, ranges);
  const hunks: MutationPresentationHunkV1T[] = ranges.map((range) => {
    const sourceLines = raw.slice(range.start, range.end);
    const lines = sourceLines.map((line): MutationPresentationComparisonLineV1T => {
      const display = redacted.lines[selectedIndex++]!;
      if (display.truncated) truncated = true;
      if (line.kind === "context") {
        return {
          kind: line.kind,
          observedBeforeLine: line.observedBeforeLine,
          installedAfterLine: line.installedAfterLine,
          ...display.text,
        };
      }
      if (line.kind === "observed-before") {
        return {
          kind: line.kind,
          observedBeforeLine: line.observedBeforeLine,
          ...display.text,
        };
      }
      return {
        kind: line.kind,
        installedAfterLine: line.installedAfterLine,
        ...display.text,
      };
    });
    return {
      observedBeforeStart: hunkStart(raw, range, "observed"),
      observedBeforeLines: sourceLines.filter((line) => line.kind !== "installed-after").length,
      installedAfterStart: hunkStart(raw, range, "installed"),
      installedAfterLines: sourceLines.filter((line) => line.kind !== "observed-before").length,
      lines,
    };
  });
  return {
    coverage: truncated ? "truncated" : "complete",
    totals: {
      observedBeforeLines: observed.length,
      installedAfterLines: installed.length,
      shownLines: selected.length,
      hiddenLines: raw.length - selected.length,
    },
    hunks,
    redactionCount: redacted.redactionCount,
  };
}

function observedMetadata(
  candidate: WardenMutationPresentationConstructionCandidateV1,
  image: InspectedImage | undefined,
): MutationPresentationObservedBeforeV1T {
  if (candidate.operation === "write") {
    if (candidate.observedBefore.status !== "file-observed") return candidate.observedBefore;
    if (image === undefined) throw new ConstructionBudgetExceededError();
    return {
      status: "file-observed",
      sha256: candidate.observedBefore.sha256,
      bytes: candidate.observedBefore.bytes,
      mode: candidate.observedBefore.mode,
      contentClass: image.contentClass,
      finalNewline: image.finalNewline,
    };
  }
  if (image === undefined) throw new ConstructionBudgetExceededError();
  return {
    status: "file-observed",
    sha256: candidate.observedBefore.sha256,
    bytes: candidate.observedBefore.bytes,
    mode: candidate.observedBefore.mode,
    contentClass: image.contentClass,
    finalNewline: image.finalNewline,
  };
}

function installedMetadata(
  candidate: WardenMutationPresentationConstructionCandidateV1,
  image: InspectedImage,
): MutationPresentationVerifiedInstalledAfterV1T {
  return {
    status: "file-observed",
    sha256: candidate.verifiedInstalledAfter.sha256,
    bytes: candidate.verifiedInstalledAfter.bytes,
    mode: candidate.verifiedInstalledAfter.mode,
    contentClass: image.contentClass,
    finalNewline: image.finalNewline,
  };
}

function unavailableComparison(
  installedLineCount: number | "unknown",
  coverage: "summary-only" | "unknown",
): MutationPresentationV1T["comparison"] {
  return {
    coverage,
    totals: {
      observedBeforeLines: "unknown",
      installedAfterLines: installedLineCount,
      shownLines: 0,
      hiddenLines: "unknown",
    },
    hunks: [],
    redactionCount: 0,
  };
}

function comparisonWithPresentedLineLimit(
  comparison: MutationPresentationV1T["comparison"],
  lineLimit: number,
): MutationPresentationV1T["comparison"] {
  const shownLines = comparison.totals.shownLines;
  if (typeof shownLines !== "number" || shownLines <= lineLimit) return comparison;
  let remaining = lineLimit;
  let retainedLines = 0;
  const hunks: MutationPresentationHunkV1T[] = [];
  for (const hunk of comparison.hunks) {
    if (remaining === 0) break;
    const lines = hunk.lines.slice(0, remaining);
    if (lines.length === 0) break;
    retainedLines += lines.length;
    remaining -= lines.length;
    hunks.push({
      ...hunk,
      observedBeforeLines: lines.filter((line) => line.kind !== "installed-after").length,
      installedAfterLines: lines.filter((line) => line.kind !== "observed-before").length,
      lines,
    });
  }
  const removedLines = shownLines - retainedLines;
  return {
    ...comparison,
    coverage: "truncated",
    totals: {
      ...comparison.totals,
      shownLines: retainedLines,
      hiddenLines:
        typeof comparison.totals.hiddenLines === "number"
          ? comparison.totals.hiddenLines + removedLines
          : "unknown",
    },
    hunks,
  };
}

async function serializedArtifactBytes(
  artifact: MutationPresentationV1T,
  control: MutationPresentationConstructionControl,
): Promise<number> {
  // JSON.stringify is synchronous, but every object admitted here is already bounded by the row,
  // hunk, line, and aggregate rendered-text ceilings. Yield before each bounded serialization so
  // the binary-search fit cannot monopolize the Warden event loop across repeated passes.
  await control.checkpoint();
  return Buffer.byteLength(JSON.stringify(artifact), "utf8");
}

async function fitSerializedArtifact(
  artifact: MutationPresentationV1T,
  control: MutationPresentationConstructionControl,
): Promise<MutationPresentationV1T> {
  if (
    (await serializedArtifactBytes(artifact, control)) <= MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES
  ) {
    await control.checkpoint();
    assertArtifactWithinQuantitativeBounds(artifact);
    return artifact;
  }
  const shownLines = artifact.comparison.totals.shownLines;
  if (typeof shownLines !== "number" || shownLines === 0) {
    throw new ConstructionBudgetExceededError();
  }
  let low = 0;
  let high = shownLines - 1;
  let fitted: MutationPresentationV1T | undefined;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = {
      ...artifact,
      comparison: comparisonWithPresentedLineLimit(artifact.comparison, middle),
    };
    if (
      (await serializedArtifactBytes(candidate, control)) <=
      MUTATION_PRESENTATION_MAX_ARTIFACT_BYTES
    ) {
      fitted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (fitted === undefined) throw new ConstructionBudgetExceededError();
  const parsed = MutationPresentationV1.parse(fitted);
  await control.checkpoint();
  assertArtifactWithinQuantitativeBounds(parsed);
  return parsed;
}

export async function constructMutationPresentationArtifact(
  candidate: WardenMutationPresentationConstructionCandidateV1,
  control: MutationPresentationConstructionControl,
): Promise<MutationPresentationV1T> {
  const installed = await inspectImage(candidate.verifiedInstalledAfter.content, control);
  let observed: InspectedImage | undefined;
  if (candidate.operation === "edit") {
    observed = await inspectImage(candidate.observedBefore.content, control);
  } else if (candidate.observedBefore.status === "file-observed") {
    observed = await inspectImage(candidate.observedBefore.content, control);
  }
  const installedLineCount = installed.contentClass === "text" ? installed.lines.length : "unknown";
  let comparison: MutationPresentationV1T["comparison"];
  if (
    candidate.operation === "write" &&
    candidate.observedBefore.status === "absent-observed" &&
    installed.contentClass === "text"
  ) {
    comparison = await comparisonForText([], installed.lines, control);
  } else if (
    (candidate.operation === "edit" || candidate.observedBefore.status === "file-observed") &&
    observed?.contentClass === "text" &&
    installed.contentClass === "text"
  ) {
    comparison = await comparisonForText(observed.lines, installed.lines, control);
  } else {
    comparison = unavailableComparison(
      installedLineCount,
      candidate.operation === "write" && candidate.observedBefore.status === "not-inspected"
        ? "unknown"
        : "summary-only",
    );
  }

  const displayPath = await redactMutationPresentationLines([candidate.displayPath], {
    control,
    maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_PATH_BYTES,
  });
  if (displayPath.lines.length !== 1) throw new ConstructionBudgetExceededError();

  const artifact = MutationPresentationV1.parse({
    schemaVersion: "mutation-presentation/v1",
    producer: "warden-typed-mutation",
    operation: candidate.operation,
    auditSeq: candidate.auditSeq,
    displayPath: displayPath.lines[0]!.text,
    pathIdentity: candidate.pathIdentity,
    observedBefore: observedMetadata(candidate, observed),
    verifiedInstalledAfter: installedMetadata(candidate, installed),
    transitionBinding: "not-atomic",
    concurrentMutation: "not-excluded",
    comparison,
    freshness: { basis: "warden-observation", currentWorkspace: "not-observed" },
  });
  return await fitSerializedArtifact(artifact, control);
}
