import {
  presentationRedactionSpans,
  type MutationPresentationSegmentV1T,
  type MutationPresentationTextV1T,
  type PresentationRedactionSpan,
} from "@keel/shared";
import {
  MUTATION_PRESENTATION_MAX_INDEXED_LINES,
  MUTATION_PRESENTATION_MAX_LINE_BYTES,
  MUTATION_PRESENTATION_MAX_REDACTION_BYTE_VISITS,
  MUTATION_PRESENTATION_MAX_REDACTION_METADATA_RECORDS,
  MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS,
  ConstructionBudgetExceededError,
  type MutationPresentationConstructionControl,
} from "./mutation-presentation-bounds.js";

const REDACTION_WINDOW_NEW_BYTES = 56 * 1024;
const REDACTION_WINDOW_OVERLAP_CODE_UNITS = 2 * 1024;
const REDACTED_RENDERED_BYTES = Buffer.byteLength("[redacted]", "utf8");
// One UTF-16 code unit encodes to at most three UTF-8 bytes, including lone surrogates. Bounding
// code units before join therefore bounds the joined producer image without scanning or copying it.
const MAX_REDACTION_INPUT_CODE_UNITS = Math.floor(
  MUTATION_PRESENTATION_MAX_REDACTION_BYTE_VISITS / 3,
);
const BEGIN_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const END_PRIVATE_KEY = /-----END [A-Z ]*PRIVATE KEY-----/g;
const URL_SCHEME = /\b[a-z][a-z0-9+.-]*:\/\//gi;

interface MutableSpan extends PresentationRedactionSpan {
  end: number;
}

export interface MutationPresentationRedactedLine {
  readonly text: MutationPresentationTextV1T;
  readonly truncated: boolean;
}

export interface MutationPresentationRedactionResult {
  readonly lines: readonly MutationPresentationRedactedLine[];
  /** Number of source matches before per-line display truncation. */
  readonly redactionCount: number;
  /** True when an optional aggregate rendered-byte budget omitted a source-line suffix. */
  readonly outputTruncated: boolean;
}

export interface MutationPresentationRedactionOptions {
  readonly control: MutationPresentationConstructionControl;
  readonly maxRenderedBytesPerLine: number;
  readonly maxRenderedBytesTotal?: number;
}

function renderedTextBytes(text: MutationPresentationTextV1T): number {
  return text.segments.reduce(
    (bytes, segment) =>
      bytes +
      (segment.kind === "literal"
        ? Buffer.byteLength(segment.text, "utf8")
        : REDACTED_RENDERED_BYTES),
    0,
  );
}

function utf8ScalarBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function utf8ChunkEnd(input: string, start: number, maxBytes: number): number {
  let bytes = 0;
  let index = start;
  while (index < input.length) {
    const codePoint = input.codePointAt(index)!;
    const scalarBytes = utf8ScalarBytes(codePoint);
    if (bytes + scalarBytes > maxBytes) break;
    bytes += scalarBytes;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return index;
}

function safeOverlapStart(input: string, cursor: number): number {
  let start = Math.max(0, cursor - REDACTION_WINDOW_OVERLAP_CODE_UNITS);
  const current = input.charCodeAt(start);
  const previous = start > 0 ? input.charCodeAt(start - 1) : 0;
  if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
    start -= 1;
  }
  return start;
}

function forEachMatch(
  input: string,
  re: RegExp,
  visit: (start: number, end: number) => void,
): void {
  re.lastIndex = 0;
  let match = re.exec(input);
  while (match !== null) {
    visit(match.index, match.index + match[0].length);
    if (match[0].length === 0) re.lastIndex += 1;
    match = re.exec(input);
  }
  re.lastIndex = 0;
}

function mergeSpans(spans: readonly PresentationRedactionSpan[]): MutableSpan[] {
  const ordered = [...spans].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: MutableSpan[] = [];
  for (const span of ordered) {
    const previous = merged.at(-1);
    if (previous !== undefined && span.start < previous.end) {
      previous.end = Math.max(previous.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

function isCredentialContinuation(character: string, kind: string): boolean {
  const codePoint = character.codePointAt(0)!;
  const alphaNumeric =
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a);
  if (alphaNumeric || character === "_" || character === "+" || character === "/") return true;
  if (character === "=" || character === "-") return true;
  return kind === "auth-header" && (character === "." || character === "~");
}

interface RedactionScanAccounting {
  byteWork: number;
  scalarOperations: number;
}

async function flushRedactionScanAccounting(
  accounting: RedactionScanAccounting,
  control: MutationPresentationConstructionControl,
): Promise<void> {
  if (accounting.byteWork === 0 && accounting.scalarOperations === 0) return;
  await control.account({
    byteWork: accounting.byteWork,
    scalarOperations: accounting.scalarOperations,
    redactionByteVisits: accounting.byteWork,
  });
  accounting.byteWork = 0;
  accounting.scalarOperations = 0;
}

async function extendBoundaryCredentials(
  input: string,
  spans: MutableSpan[],
  chunkEnds: ReadonlySet<number>,
  control: MutationPresentationConstructionControl,
): Promise<void> {
  const extensibleKinds = new Set([
    "anthropic-key",
    "openai-key",
    "google-key",
    "github-token",
    "slack-token",
    "auth-header",
    "high-entropy",
  ]);
  for (const span of spans) {
    if (!extensibleKinds.has(span.kind) || !chunkEnds.has(span.end)) continue;
    let cursor = span.end;
    const accounting: RedactionScanAccounting = { byteWork: 0, scalarOperations: 0 };
    while (cursor < input.length) {
      const codePoint = input.codePointAt(cursor)!;
      const character = String.fromCodePoint(codePoint);
      const scalarBytes = utf8ScalarBytes(codePoint);
      accounting.byteWork += scalarBytes;
      accounting.scalarOperations += 1;
      if (!isCredentialContinuation(character, span.kind)) break;
      cursor += codePoint > 0xffff ? 2 : 1;
      // Four UTF-8 bytes per scalar means this stricter 2,048-operation checkpoint also keeps byte
      // work far below the 64 KiB yield ceiling.
      if (accounting.scalarOperations === MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS) {
        await flushRedactionScanAccounting(accounting, control);
      }
    }
    await flushRedactionScanAccounting(accounting, control);
    if (cursor > span.end) span.end = cursor;
  }
}

interface UrlSchemeCandidate {
  readonly start: number;
  readonly credentialStart: number;
}

async function collectLongUrlCredentialSpans(
  input: string,
  candidates: readonly UrlSchemeCandidate[],
  control: MutationPresentationConstructionControl,
): Promise<PresentationRedactionSpan[]> {
  const spans: PresentationRedactionSpan[] = [];
  for (const candidate of [...candidates].sort((left, right) => left.start - right.start)) {
    let cursor = candidate.credentialStart;
    const accounting: RedactionScanAccounting = { byteWork: 0, scalarOperations: 0 };
    let firstColon: number | undefined;
    let lastAt: number | undefined;
    while (cursor < input.length) {
      const codePoint = input.codePointAt(cursor)!;
      const character = String.fromCodePoint(codePoint);
      const scalarBytes = utf8ScalarBytes(codePoint);
      accounting.byteWork += scalarBytes;
      accounting.scalarOperations += 1;
      if (character === "/" || /\s/u.test(character)) break;
      if (character === ":" && firstColon === undefined && cursor > candidate.credentialStart) {
        firstColon = cursor;
      } else if (character === "@" && firstColon !== undefined) {
        lastAt = cursor;
      }
      cursor += codePoint > 0xffff ? 2 : 1;
      if (accounting.scalarOperations === MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS) {
        await flushRedactionScanAccounting(accounting, control);
      }
    }
    await flushRedactionScanAccounting(accounting, control);
    if (firstColon !== undefined && lastAt !== undefined && lastAt > firstColon) {
      spans.push({
        start: candidate.credentialStart,
        end: lastAt,
        kind: "url-credential",
      });
    }
  }
  return spans;
}

function visibleControl(codePoint: number): string | undefined {
  if (codePoint >= 0 && codePoint <= 0x1f) return String.fromCodePoint(0x2400 + codePoint);
  if (codePoint === 0x7f) return "␡";
  if (
    (codePoint >= 0x80 && codePoint <= 0x9f) ||
    codePoint === 0x61c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  ) {
    return `‹U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}›`;
  }
  return undefined;
}

function pushLiteral(segments: MutationPresentationSegmentV1T[], text: string): void {
  if (text.length === 0) return;
  const previous = segments.at(-1);
  if (previous?.kind === "literal") {
    previous.text += text;
  } else {
    segments.push({ kind: "literal", text });
  }
}

interface BoundedLineBuilder {
  readonly segments: MutationPresentationSegmentV1T[];
  remainingBytes: number;
  pendingScalarOperations: number;
}

async function flushScalarOperations(
  builder: BoundedLineBuilder,
  control: MutationPresentationConstructionControl,
): Promise<void> {
  if (builder.pendingScalarOperations === 0) return;
  await control.account({ scalarOperations: builder.pendingScalarOperations });
  builder.pendingScalarOperations = 0;
}

async function accountScalarOperation(
  builder: BoundedLineBuilder,
  control: MutationPresentationConstructionControl,
): Promise<void> {
  builder.pendingScalarOperations += 1;
  if (builder.pendingScalarOperations === MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS) {
    await flushScalarOperations(builder, control);
  }
}

async function appendBoundedLiteral(
  input: string,
  start: number,
  end: number,
  builder: BoundedLineBuilder,
  control: MutationPresentationConstructionControl,
): Promise<{ readonly complete: boolean; readonly cursor: number }> {
  let cursor = start;
  while (cursor < end) {
    const codePoint = input.codePointAt(cursor)!;
    const character = String.fromCodePoint(codePoint);
    const rendered = visibleControl(codePoint) ?? character;
    const renderedBytes = Buffer.byteLength(rendered, "utf8");
    if (renderedBytes > builder.remainingBytes) {
      await flushScalarOperations(builder, control);
      return { complete: false, cursor };
    }
    pushLiteral(builder.segments, rendered);
    builder.remainingBytes -= renderedBytes;
    cursor += codePoint > 0xffff ? 2 : 1;
    await accountScalarOperation(builder, control);
  }
  return { complete: true, cursor };
}

async function boundedLine(
  input: string,
  start: number,
  end: number,
  spans: readonly PresentationRedactionSpan[],
  maxBytes: number,
  control: MutationPresentationConstructionControl,
): Promise<MutationPresentationRedactedLine> {
  const segments: MutationPresentationSegmentV1T[] = [];
  const builder: BoundedLineBuilder = {
    segments,
    remainingBytes: maxBytes,
    pendingScalarOperations: 0,
  };
  let cursor = start;
  for (const span of spans) {
    if (span.end <= start) continue;
    if (span.start >= end) break;
    const coveredStart = Math.max(start, span.start);
    const coveredEnd = Math.min(end, span.end);
    const literal = await appendBoundedLiteral(input, cursor, coveredStart, builder, control);
    if (!literal.complete) {
      return {
        text: {
          segments,
          redactionCount: segments.filter((segment) => segment.kind === "redacted").length,
        },
        truncated: true,
      };
    }
    if (span.start >= start && span.start < end) {
      if (REDACTED_RENDERED_BYTES > builder.remainingBytes) {
        await flushScalarOperations(builder, control);
        return {
          text: {
            segments,
            redactionCount: segments.filter((segment) => segment.kind === "redacted").length,
          },
          truncated: true,
        };
      }
      segments.push({ kind: "redacted" });
      builder.remainingBytes -= REDACTED_RENDERED_BYTES;
      await accountScalarOperation(builder, control);
    }
    cursor = Math.max(cursor, coveredEnd);
  }
  const tail = await appendBoundedLiteral(input, cursor, end, builder, control);
  await flushScalarOperations(builder, control);
  return {
    text: {
      segments,
      redactionCount: segments.filter((segment) => segment.kind === "redacted").length,
    },
    truncated: !tail.complete,
  };
}

/**
 * Redact bounded logical presentation lines before display truncation. Producer bytes remain local;
 * callers receive only typed literal/redacted segments and derived counts.
 */
export async function redactMutationPresentationLines(
  lines: readonly string[],
  options: MutationPresentationRedactionOptions,
): Promise<MutationPresentationRedactionResult> {
  if (
    !Number.isSafeInteger(options.maxRenderedBytesPerLine) ||
    options.maxRenderedBytesPerLine < 0 ||
    options.maxRenderedBytesPerLine > MUTATION_PRESENTATION_MAX_LINE_BYTES
  ) {
    throw new ConstructionBudgetExceededError();
  }
  const maxRenderedBytesTotal = options.maxRenderedBytesTotal ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxRenderedBytesTotal) || maxRenderedBytesTotal < 0) {
    throw new ConstructionBudgetExceededError();
  }

  if (lines.length > MUTATION_PRESENTATION_MAX_INDEXED_LINES) {
    throw new ConstructionBudgetExceededError();
  }
  let inputCodeUnits = Math.max(0, lines.length - 1);
  for (const line of lines) {
    if (typeof line !== "string" || line.length > MAX_REDACTION_INPUT_CODE_UNITS - inputCodeUnits) {
      throw new ConstructionBudgetExceededError();
    }
    inputCodeUnits += line.length;
  }

  const input = lines.join("\n");
  const spans: PresentationRedactionSpan[] = [];
  const beginMarkers = new Set<number>();
  const endMarkers = new Map<number, number>();
  const urlSchemes = new Map<number, UrlSchemeCandidate>();
  const chunkEnds = new Set<number>();
  let retainedMetadataRecords = 0;
  const retainMetadata = (): void => {
    retainedMetadataRecords += 1;
    if (retainedMetadataRecords > MUTATION_PRESENTATION_MAX_REDACTION_METADATA_RECORDS) {
      throw new ConstructionBudgetExceededError();
    }
  };
  let cursor = 0;
  while (cursor < input.length) {
    const end = utf8ChunkEnd(input, cursor, REDACTION_WINDOW_NEW_BYTES);
    if (end <= cursor) throw new ConstructionBudgetExceededError();
    const windowStart = safeOverlapStart(input, cursor);
    const window = input.slice(windowStart, end);
    const windowBytes = Buffer.byteLength(window, "utf8");
    await options.control.account({
      byteWork: windowBytes,
      redactionByteVisits: windowBytes,
    });

    for (const span of presentationRedactionSpans(window)) {
      if (span.kind === "private-key" || span.kind === "url-credential") continue;
      retainMetadata();
      spans.push({
        start: windowStart + span.start,
        end: windowStart + span.end,
        kind: span.kind,
      });
    }
    forEachMatch(window, BEGIN_PRIVATE_KEY, (start) => {
      retainMetadata();
      beginMarkers.add(windowStart + start);
    });
    forEachMatch(window, END_PRIVATE_KEY, (start, markerEnd) => {
      retainMetadata();
      endMarkers.set(windowStart + start, windowStart + markerEnd);
    });
    forEachMatch(window, URL_SCHEME, (start, schemeEnd) => {
      const globalStart = windowStart + start;
      if (urlSchemes.has(globalStart)) return;
      retainMetadata();
      urlSchemes.set(globalStart, {
        start: globalStart,
        credentialStart: windowStart + schemeEnd,
      });
    });
    chunkEnds.add(end);
    cursor = end;
  }

  const markerEvents = [
    ...[...beginMarkers].map((start) => ({ kind: "begin" as const, start, end: start })),
    ...[...endMarkers].map(([start, end]) => ({ kind: "end" as const, start, end })),
  ].sort((left, right) => left.start - right.start || (left.kind === "begin" ? -1 : 1));
  let pendingPrivateKeyStart: number | undefined;
  for (const event of markerEvents) {
    if (event.kind === "begin") {
      pendingPrivateKeyStart ??= event.start;
    } else if (pendingPrivateKeyStart !== undefined && event.start >= pendingPrivateKeyStart) {
      retainMetadata();
      spans.push({ start: pendingPrivateKeyStart, end: event.end, kind: "private-key" });
      pendingPrivateKeyStart = undefined;
    }
  }
  if (pendingPrivateKeyStart !== undefined) {
    retainMetadata();
    spans.push({ start: pendingPrivateKeyStart, end: input.length, kind: "private-key" });
  }

  let merged = mergeSpans(spans);
  await options.control.checkpoint();
  await extendBoundaryCredentials(input, merged, chunkEnds, options.control);
  const urlSpans = await collectLongUrlCredentialSpans(
    input,
    [...urlSchemes.values()],
    options.control,
  );
  for (let index = 0; index < urlSpans.length; index += 1) retainMetadata();
  merged = mergeSpans([...merged, ...urlSpans]);
  await options.control.checkpoint();
  const output: MutationPresentationRedactedLine[] = [];
  let remainingRenderedBytes = maxRenderedBytesTotal;
  let outputTruncated = false;
  let lineStart = 0;
  for (const line of lines) {
    if (remainingRenderedBytes === 0) {
      outputTruncated = true;
      break;
    }
    const lineEnd = lineStart + line.length;
    const effectiveLineBudget = Math.min(options.maxRenderedBytesPerLine, remainingRenderedBytes);
    const redacted = await boundedLine(
      input,
      lineStart,
      lineEnd,
      merged,
      effectiveLineBudget,
      options.control,
    );
    output.push(redacted);
    remainingRenderedBytes -= renderedTextBytes(redacted.text);
    lineStart = lineEnd + 1;
    if (redacted.truncated && effectiveLineBudget < options.maxRenderedBytesPerLine) {
      outputTruncated = true;
      break;
    }
  }

  return { lines: output, redactionCount: merged.length, outputTruncated };
}
