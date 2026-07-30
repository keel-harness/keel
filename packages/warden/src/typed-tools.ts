import { type ChildProcess, type SpawnOptions, spawn as defaultSpawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync as defaultRealpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type PathLike,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  escapeSearchGlobLiteral,
  formatSearchResultPath,
  isVisibleSearchPath,
  matchesVisibleSearchGlob,
  normalizeSearchPath,
  searchExecutionScopeFromGlob,
  type JsonObjectT,
} from "@keel/shared";
import { MUTATION_PRESENTATION_MAX_IMAGE_BYTES } from "./mutation-presentation-bounds.js";

export const READ_MAX_OUTPUT_BYTES = 64 * 1024;
export const READ_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const READ_MAX_LARGE_LINE_SCAN_BYTES = 16 * 1024 * 1024;
export const READ_BINARY_SNIFF_BYTES = 8192;
export const SEARCH_MAX_RESULTS = 200;
export const SEARCH_MAX_LINE_BYTES = 1024;
export const SEARCH_MAX_OUTPUT_BYTES = 64 * 1024;
export const SEARCH_MAX_RAW_STDOUT_LINE_BYTES = 1024 * 1024;
export const SEARCH_MAX_STDERR_BYTES = 64 * 1024;
export const SEARCH_TIMEOUT_MS = 30_000;
const SEARCH_TERMINATION_GRACE_MS = 250;
const SEARCH_REAP_BUDGET_MS = 2_000;

const SearchText = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "search arguments may not contain a NUL byte");

export const ReadArgs = z
  .object({
    path: z.string().min(1),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
    start: z.number().int().positive().optional(),
    start_line: z.number().int().positive().optional(),
    byteOffset: z.number().int().nonnegative().optional(),
    byteLimit: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    const hasByteOffset = args.byteOffset !== undefined;
    const hasByteLimit = args.byteLimit !== undefined;
    if (hasByteOffset !== hasByteLimit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "byteOffset and byteLimit must be provided together",
        path: [hasByteOffset ? "byteLimit" : "byteOffset"],
      });
    }
    if (
      (hasByteOffset || hasByteLimit) &&
      (args.offset !== undefined ||
        args.limit !== undefined ||
        args.start !== undefined ||
        args.start_line !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "byte slices cannot be combined with line offset/limit",
        path: ["byteOffset"],
      });
    }
    for (const [alias, value] of [
      ["start", args.start],
      ["start_line", args.start_line],
    ] as const) {
      if (value !== undefined && args.offset !== undefined && value !== args.offset) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `read: conflicting '${alias}' and 'offset' arguments`,
          path: [alias],
        });
      }
    }
    if (
      args.start !== undefined &&
      args.start_line !== undefined &&
      args.start !== args.start_line
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "read: conflicting 'start' and 'start_line' arguments",
        path: ["start_line"],
      });
    }
    if (args.byteLimit !== undefined && args.byteLimit > READ_MAX_OUTPUT_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `byteLimit is too large (> ${String(READ_MAX_OUTPUT_BYTES)} bytes); narrow the slice`,
        path: ["byteLimit"],
      });
    }
  });
export type ReadArgsT = z.infer<typeof ReadArgs>;

export const SearchArgs = z
  .object({
    pattern: SearchText,
    kind: z.enum(["content", "filename"]).optional(),
    glob: SearchText.optional(),
    path: SearchText.optional(),
    output_mode: z.literal("content").optional(),
    maxResults: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.output_mode !== undefined && args.kind !== undefined && args.kind !== "content") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "search: conflicting output_mode and kind arguments",
        path: ["output_mode"],
      });
    }
    if (args.path !== undefined && args.kind === "filename") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "search: path is only supported for content searches; use glob instead",
        path: ["path"],
      });
    }
    if (args.path !== undefined && args.glob !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "search: conflicting 'path' and 'glob' arguments",
        path: ["path"],
      });
    }
    if (args.kind === "filename" && args.glob !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "glob is only supported for content searches",
        path: ["glob"],
      });
    }
  });
export type SearchArgsT = z.infer<typeof SearchArgs>;

export const WriteArgs = z
  .object({
    path: z.string().min(1),
    content: z
      .string()
      .refine(
        (content) => !content.includes("\0"),
        "content may not contain NUL bytes; refusing binary content",
      ),
  })
  .strict();
export type WriteArgsT = z.infer<typeof WriteArgs>;

export const EditArgs = z
  .object({
    path: z.string().min(1),
    oldString: z.string().min(1),
    newString: z
      .string()
      .refine(
        (text) => !text.includes("\0"),
        "newString may not contain NUL bytes; refusing binary content",
      ),
  })
  .strict()
  .refine((a) => a.oldString !== a.newString, {
    message: "oldString and newString are identical (no-op)",
    path: ["newString"],
  });
export type EditArgsT = z.infer<typeof EditArgs>;

export type TypedToolName = "read" | "search" | "write" | "edit";

export class TypedToolError extends Error {
  readonly code: "INVALID_PARAMS" | "TOOL_ERROR" | "TOOL_DENIED";
  readonly mutationPossible: boolean;

  constructor(
    code: "INVALID_PARAMS" | "TOOL_ERROR" | "TOOL_DENIED",
    message: string,
    options: { readonly mutationPossible?: boolean } = {},
  ) {
    super(message);
    this.name = "TypedToolError";
    this.code = code;
    this.mutationPossible = options.mutationPossible === true;
  }
}

export class TypedToolDeniedError extends TypedToolError {
  constructor(message: string) {
    super("TOOL_DENIED", message);
    this.name = "TypedToolDeniedError";
  }
}

export interface KnownRange {
  /** Inclusive UTF-8 byte offset. */
  readonly start: number;
  /** Exclusive UTF-8 byte offset. */
  readonly end: number;
}

interface KnownRangeObservation extends KnownRange {
  /** SHA-256 of the exact UTF-8 bytes in this observed range. */
  readonly hash: string;
}

interface KnownFile {
  readonly fullHash?: string;
  readonly ranges: readonly KnownRangeObservation[];
}

class FileAccessTracker {
  readonly #known = new Map<string, KnownFile>();

  markKnown(absPath: string, hash: string, range?: KnownRange, currentFullHash?: string): void {
    if (range === undefined) {
      this.#known.set(absPath, { fullHash: hash, ranges: [] });
      return;
    }
    if (range.end <= range.start) return;
    const prev = this.#known.get(absPath);
    const fullHash =
      prev?.fullHash !== undefined && currentFullHash === prev.fullHash ? prev.fullHash : undefined;
    this.#known.set(absPath, {
      ...(fullHash !== undefined ? { fullHash } : {}),
      ranges: [...(prev?.ranges ?? []), { ...range, hash }],
    });
  }

  hasKnownCoverage(absPath: string): boolean {
    const known = this.#known.get(absPath);
    return known !== undefined && (known.fullHash !== undefined || known.ranges.length > 0);
  }

  knownHash(absPath: string): string | undefined {
    return this.#known.get(absPath)?.fullHash;
  }

  coversFullFile(absPath: string, hash: string): boolean {
    return this.#known.get(absPath)?.fullHash === hash;
  }

  coversRange(
    absPath: string,
    currentHash: string,
    range: KnownRange,
    currentContent: string,
  ): boolean {
    const known = this.#known.get(absPath);
    if (known === undefined) return false;
    if (known.fullHash === currentHash) return true;
    let cursor = range.start;
    const sorted = known.ranges
      .filter((observed) => rangeHashMatches(currentContent, observed))
      .sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
    for (const observed of sorted) {
      if (observed.end <= cursor) continue;
      if (observed.start > cursor) return false;
      cursor = Math.max(cursor, observed.end);
      if (cursor >= range.end) return true;
    }
    return false;
  }

  markEdited(
    absPath: string,
    previousHash: string,
    nextHash: string,
    replaced: KnownRange,
    replacementLength: number,
    previousContent: string,
    updatedContent: string,
  ): void {
    const known = this.#known.get(absPath);
    if (known === undefined || (known.fullHash === undefined && known.ranges.length === 0)) {
      this.#known.delete(absPath);
      return;
    }
    if (known.fullHash === previousHash) {
      this.#known.set(absPath, { fullHash: nextHash, ranges: [] });
      return;
    }
    if (!this.coversRange(absPath, previousHash, replaced, previousContent)) {
      this.#known.delete(absPath);
      return;
    }

    const delta = replacementLength - (replaced.end - replaced.start);
    const transformed: KnownRange[] = [
      { start: replaced.start, end: replaced.start + replacementLength },
    ];
    for (const range of known.ranges) {
      if (!rangeHashMatches(previousContent, range)) continue;
      if (range.end <= replaced.start) {
        transformed.push(range);
      } else if (range.start >= replaced.end) {
        transformed.push({ start: range.start + delta, end: range.end + delta });
      } else {
        if (range.start < replaced.start) {
          transformed.push({ start: range.start, end: replaced.start });
        }
        if (range.end > replaced.end) {
          transformed.push({
            start: replaced.start + replacementLength,
            end: range.end + delta,
          });
        }
      }
    }
    const observations = mergeRanges(transformed)
      .map((range) => rangeObservation(updatedContent, range))
      .filter((range): range is KnownRangeObservation => range !== undefined);
    if (observations.length === 0) {
      this.#known.delete(absPath);
      return;
    }
    this.#known.set(absPath, { ranges: observations });
  }
}

export interface TypedToolState {
  readonly tracker: FileAccessTracker;
}

export function createTypedToolState(): TypedToolState {
  return { tracker: new FileAccessTracker() };
}

function mergeRanges(ranges: readonly KnownRange[]): readonly KnownRange[] {
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
  const merged: KnownRange[] = [];
  for (const range of sorted) {
    const prev = merged.at(-1);
    if (prev !== undefined && range.start <= prev.end) {
      merged[merged.length - 1] = { start: prev.start, end: Math.max(prev.end, range.end) };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function hashUtf8Range(content: string, range: KnownRange): string {
  const bytes = Buffer.from(content, "utf8");
  return contentHash(bytes.subarray(range.start, range.end));
}

function rangeHashMatches(content: string, range: KnownRangeObservation): boolean {
  return hashUtf8Range(content, range) === range.hash;
}

function rangeObservation(content: string, range: KnownRange): KnownRangeObservation | undefined {
  if (range.end <= range.start) return undefined;
  return { ...range, hash: hashUtf8Range(content, range) };
}

function badArgsMessage(toolName: string, error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue && issue.path.length > 0 ? `'${issue.path.join(".")}'` : "arguments";
  const why = issue?.message ?? "invalid arguments";
  return `tool '${toolName}': invalid ${where} - ${why}`;
}

function parseArgs<T>(toolName: string, schema: z.ZodType<T>, args: JsonObjectT): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new TypedToolError("INVALID_PARAMS", badArgsMessage(toolName, parsed.error));
  }
  return parsed.data;
}

export function parseReadArgs(args: JsonObjectT): ReadArgsT {
  return parseArgs("read", ReadArgs, normalizeReadArgs(args));
}

export function parseSearchArgs(
  args: JsonObjectT,
  options: { readonly workspaceRoot?: string; readonly realpath?: (path: string) => string } = {},
): SearchArgsT {
  return parseArgs("search", SearchArgs, normalizeSearchArgs(args, options));
}

export function parseWriteArgs(args: JsonObjectT): WriteArgsT {
  return parseArgs("write", WriteArgs, args);
}

export function parseEditArgs(args: JsonObjectT): EditArgsT {
  return parseArgs("edit", EditArgs, args);
}

function contains(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function resolveRealPathForClassification(
  candidate: string,
  realpath: (path: string) => string = defaultRealpathSync,
): string {
  const tail: string[] = [];
  let cur = candidate;
  for (;;) {
    try {
      const real = realpath(cur);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(cur);
      if (parent === cur) return candidate;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

interface ResolvedWorkspacePath {
  readonly lexical: string;
  readonly root: string;
}

function resolveWorkspacePath(
  workspaceRoot: string,
  input: string,
  realpath: (path: string) => string,
): ResolvedWorkspacePath {
  if (input.includes("\0")) {
    throw new TypedToolDeniedError("blocked: path may not contain a NUL byte");
  }
  const root = realpath(resolve(workspaceRoot));
  const lexical = resolve(root, input);
  if (!contains(root, lexical)) {
    throw new TypedToolDeniedError(
      `blocked: path '${input}' is outside the workspace; allowed root: ${root}. Use a workspace-relative path.`,
    );
  }
  let real: string;
  try {
    real = resolveRealPathForClassification(lexical, realpath);
  } catch {
    throw new TypedToolDeniedError(
      `blocked: cannot resolve path '${input}' to verify it is inside the workspace`,
    );
  }
  if (!contains(root, real)) {
    throw new TypedToolDeniedError(
      `blocked: path '${input}' is outside the workspace; allowed root: ${root}. Use a workspace-relative path.`,
    );
  }
  return { lexical, root };
}

function pathChangedGuidance(input: string): string {
  return `blocked: path '${input}' changed while being validated; retry after the workspace is stable`;
}

function assertWorkspacePathStillContained(
  resolved: ResolvedWorkspacePath,
  input: string,
  realpath: (path: string) => string,
): void {
  let real: string;
  try {
    real = resolveRealPathForClassification(resolved.lexical, realpath);
  } catch {
    throw new TypedToolDeniedError(pathChangedGuidance(input));
  }
  if (!contains(resolved.root, real)) {
    throw new TypedToolDeniedError(
      `blocked: path '${input}' is outside the workspace; allowed root: ${resolved.root}. Use a workspace-relative path.`,
    );
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOpenedWorkspacePath(
  resolved: ResolvedWorkspacePath,
  input: string,
  fd: number,
  realpath: (path: string) => string,
): void {
  assertWorkspacePathStillContained(resolved, input, realpath);
  let current: Stats;
  let opened: Stats;
  try {
    current = statSync(resolved.lexical);
    opened = fstatSync(fd);
  } catch {
    throw new TypedToolDeniedError(pathChangedGuidance(input));
  }
  if (!sameFile(current, opened)) throw new TypedToolDeniedError(pathChangedGuidance(input));
}

function normalizeReadArgs(raw: JsonObjectT): JsonObjectT {
  const normalized: JsonObjectT = { ...raw };
  const aliases = ["start", "start_line"] as const;
  for (const alias of aliases) {
    if (!(alias in normalized)) continue;
    const value = normalized[alias];
    if (value === undefined) continue;
    if ("offset" in normalized && normalized["offset"] !== value) {
      throw new TypedToolError(
        "INVALID_PARAMS",
        `read: conflicting '${alias}' and 'offset' arguments`,
      );
    }
    normalized["offset"] = value;
    delete normalized[alias];
  }
  return normalized;
}

function toRgGlobPath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function searchPathArgToGlob(
  pathArg: string,
  options: { readonly workspaceRoot?: string; readonly realpath?: (path: string) => string },
): string {
  if (options.workspaceRoot === undefined) return pathArg;
  const realpath = options.realpath ?? defaultRealpathSync;
  const root = realpath(resolve(options.workspaceRoot));
  const resolved = resolveWorkspacePath(root, pathArg, realpath);
  const rel = toRgGlobPath(relative(root, resolved.lexical));
  if (rel === "") return "**";
  const literal = escapeSearchGlobLiteral(rel);
  try {
    if (statSync(resolved.lexical).isDirectory()) return `${literal.replace(/\/+$/, "")}/**`;
  } catch {
    // Missing contained paths become exact rg globs and naturally produce no matches.
  }
  return literal;
}

function normalizeSearchArgs(
  raw: JsonObjectT,
  options: { readonly workspaceRoot?: string; readonly realpath?: (path: string) => string },
): JsonObjectT {
  const normalized: JsonObjectT = { ...raw };

  if ("output_mode" in normalized) {
    if (normalized["output_mode"] !== "content") {
      throw new TypedToolError(
        "INVALID_PARAMS",
        "search: unsupported output_mode; use kind:'content' or kind:'filename'",
      );
    }
    if ("kind" in normalized && normalized["kind"] !== "content") {
      throw new TypedToolError(
        "INVALID_PARAMS",
        "search: conflicting output_mode and kind arguments",
      );
    }
    normalized["kind"] = "content";
    delete normalized["output_mode"];
  }

  if ("path" in normalized) {
    if ("kind" in normalized && normalized["kind"] !== "content") {
      throw new TypedToolError(
        "INVALID_PARAMS",
        "search: path is only supported for content searches; use glob instead",
      );
    }
    const pathArg = normalized["path"];
    if (typeof pathArg !== "string" || pathArg.length === 0) {
      throw new TypedToolError("INVALID_PARAMS", "search: path must be a non-empty string");
    }
    if ("glob" in normalized) {
      throw new TypedToolError("INVALID_PARAMS", "search: conflicting 'path' and 'glob' arguments");
    }
    const glob = searchPathArgToGlob(pathArg, options);
    normalized["glob"] = glob;
    delete normalized["path"];
  }
  if (normalized["kind"] === "filename" && "glob" in normalized) {
    throw new TypedToolError(
      "INVALID_PARAMS",
      "search: glob is only supported for content searches",
    );
  }

  return normalized;
}

function decodeDropTrailingPartial(buf: Buffer): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf, { stream: true });
}

function decodeDropLeadingPartial(buf: Buffer): string {
  let start = 0;
  while (start < buf.length && ((buf[start] as number) & 0xc0) === 0x80) start += 1;
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf.subarray(start));
}

function truncateHeadUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return decodeDropTrailingPartial(buf.subarray(0, maxBytes));
}

function decodeUtf8(path: string, bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new TypedToolError(
      "TOOL_ERROR",
      `read: byte slice of '${path}' is not complete UTF-8 text; adjust byteOffset/byteLimit`,
    );
  }
}

function decodeTextFile(path: string, bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new TypedToolError(
      "TOOL_ERROR",
      `read: '${path}' is not complete UTF-8 text; refusing to read`,
    );
  }
}

export function truncateHeadTail(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const headBytes = Math.max(0, Math.floor(maxBytes * 0.6));
  // Guard against `tailBytes === 0`: `Buffer.subarray(-0)` collapses to `subarray(0)` and returns the
  // WHOLE buffer, defeating truncation at tiny budgets. Keep at least 1 tail byte.
  const tailBytes = Math.max(1, maxBytes - headBytes - 64);
  const tailBuffer = Buffer.from(text, "utf8").subarray(-tailBytes);
  return `${truncateHeadUtf8(text, headBytes)}\n... [output truncated] ...\n${decodeDropLeadingPartial(tailBuffer)}`;
}

/**
 * A window (bytes) added on each side of a truncation cut when redacting before truncation. A secret
 * that straddles a cut must be fully inside the redacted window to be replaced by a marker before the
 * middle is dropped; 64 KiB comfortably exceeds any plausible single secret token, and keeps each
 * redacted window (head/tail budget + this) well inside `redactText`'s safe input size.
 */
const REDACT_STRADDLE_WINDOW_BYTES = 64 * 1024;

/**
 * Like `truncateHeadTail`, but redacts a bounded window spanning each cut FIRST, so a secret straddling
 * a truncation boundary is replaced by a marker while still whole — before the middle (which holds the
 * rest of the token) is dropped and the surviving fragment falls below the entropy net's length floor.
 * Only the head/tail windows (each ≤ budget + overlap) are passed to `redact`, never the full stream,
 * so `redactText` is never handed a multi-MiB input that would blow its stack. For content with no
 * secret near a cut the output is byte-identical to `truncateHeadTail`.
 */
export function redactThenTruncateHeadTail(
  text: string,
  maxBytes: number,
  redact: (s: string) => string,
): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return redact(text);
  const headBytes = Math.max(0, Math.floor(maxBytes * 0.6));
  const tailBytes = Math.max(1, maxBytes - headBytes - 64);
  const headWindow = redact(
    decodeDropTrailingPartial(buf.subarray(0, headBytes + REDACT_STRADDLE_WINDOW_BYTES)),
  );
  const tailWindow = redact(
    decodeDropLeadingPartial(buf.subarray(-(tailBytes + REDACT_STRADDLE_WINDOW_BYTES))),
  );
  const tailBuffer = Buffer.from(tailWindow, "utf8").subarray(-tailBytes);
  return `${truncateHeadUtf8(headWindow, headBytes)}\n... [output truncated] ...\n${decodeDropLeadingPartial(tailBuffer)}`;
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  let byteOffset = 0;
  for (const char of text) {
    byteOffset += utf8ByteLength(char);
    if (char === "\n") starts.push(byteOffset);
  }
  return starts;
}

function lineSliceRange(
  text: string,
  startLineIndex: number,
  endLineExclusive: number,
): KnownRange {
  const starts = lineStartOffsets(text);
  const totalBytes = utf8ByteLength(text);
  const start = starts[startLineIndex] ?? totalBytes;
  const end =
    endLineExclusive < starts.length ? Math.max(start, starts[endLineExclusive]! - 1) : totalBytes;
  return { start, end };
}

function boundedReadOutputWithRange(
  path: string,
  output: string,
  selectedLines: number,
  range: KnownRange,
  onLimited: (() => void) | undefined,
): { readonly output: string; readonly knownText: string; readonly range: KnownRange } {
  if (utf8ByteLength(output) <= READ_MAX_OUTPUT_BYTES) return { output, knownText: output, range };
  if (selectedLines === 1) {
    onLimited?.();
    const truncated = truncateHeadUtf8(output, READ_MAX_OUTPUT_BYTES);
    return {
      output: `${truncated}\n... [line truncated: exceeds ${String(READ_MAX_OUTPUT_BYTES)} bytes] ...`,
      knownText: truncated,
      range: { start: range.start, end: range.start + utf8ByteLength(truncated) },
    };
  }
  throw new TypedToolError(
    "TOOL_ERROR",
    `read: selected range is too large (> ${String(READ_MAX_OUTPUT_BYTES)} bytes); narrow with offset/limit`,
  );
}

function readByteSlice(
  resolved: ResolvedWorkspacePath,
  path: string,
  byteOffset: number,
  byteLimit: number,
  size: number,
  state: TypedToolState | undefined,
  onLimited: (() => void) | undefined,
  realpath: (path: string) => string,
): string {
  if (byteOffset >= size) {
    onLimited?.();
    return `read: byteOffset ${String(byteOffset)} is past end of file (${String(size)} bytes)`;
  }
  const fd = openSync(resolved.lexical, "r");
  try {
    assertOpenedWorkspacePath(resolved, path, fd, realpath);
    const buffer = Buffer.alloc(byteLimit);
    const bytesRead = readSync(fd, buffer, 0, byteLimit, byteOffset);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) {
      throw new TypedToolError(
        "TOOL_ERROR",
        `read: '${path}' appears to be a binary file; refusing to read`,
      );
    }
    const decoded = decodeUtf8(path, slice);
    state?.tracker.markKnown(resolved.lexical, contentHash(slice), {
      start: byteOffset,
      end: byteOffset + bytesRead,
    });
    return decoded;
  } finally {
    closeSync(fd);
  }
}

function readWholeFileBounded(
  resolved: ResolvedWorkspacePath,
  path: string,
  realpath: (path: string) => string,
): Buffer {
  const fd = openSync(resolved.lexical, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    assertOpenedWorkspacePath(resolved, path, fd, realpath);
    for (;;) {
      const remaining = READ_MAX_FILE_BYTES + 1 - total;
      const buffer = Buffer.alloc(Math.min(64 * 1024, remaining));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > READ_MAX_FILE_BYTES) {
        throw new TypedToolError(
          "TOOL_ERROR",
          `read: '${path}' grew beyond ${String(
            READ_MAX_FILE_BYTES,
          )} bytes while reading; too large to read whole - narrow with offset/limit or byteOffset/byteLimit`,
        );
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    closeSync(fd);
  }
  return Buffer.concat(chunks, total);
}

function readContainedFile(
  resolved: ResolvedWorkspacePath,
  path: string,
  realpath: (path: string) => string,
  expected: Extract<PreparedLeafExpectation, { readonly state: "regular-file" }>,
): Buffer {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new TypedToolDeniedError(
      `edit: no-follow file identity is unavailable on this platform; refusing '${path}'`,
    );
  }
  let fd: number;
  try {
    fd = openSync(resolved.lexical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw mutationSymlinkError("edit", path);
    }
    throw error;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    assertWorkspacePathStillContained(resolved, path, realpath);
    const opened = fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      String(opened.dev) !== expected.dev ||
      String(opened.ino) !== expected.ino
    ) {
      throw new TypedToolDeniedError(pathChangedGuidance(path));
    }
    const current = lstatOrUndefined(resolved.lexical);
    if (
      current === undefined ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      !samePreparedIdentity(current, opened)
    ) {
      throw new TypedToolDeniedError(pathChangedGuidance(path));
    }
    if (opened.size > BigInt(READ_MAX_FILE_BYTES)) {
      throw new TypedToolDeniedError(
        `edit: '${path}' is ${String(opened.size)} bytes; too large to edit whole - use smaller targeted files until streaming edit support lands`,
      );
    }
    for (;;) {
      const remaining = READ_MAX_FILE_BYTES + 1 - total;
      const buffer = Buffer.alloc(Math.min(64 * 1024, remaining));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > READ_MAX_FILE_BYTES) {
        throw new TypedToolDeniedError(
          `edit: '${path}' grew beyond ${String(
            READ_MAX_FILE_BYTES,
          )} bytes while reading; too large to edit whole - use smaller targeted files until streaming edit support lands`,
        );
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const afterRead = lstatOrUndefined(resolved.lexical);
    if (
      afterRead === undefined ||
      afterRead.isSymbolicLink() ||
      !afterRead.isFile() ||
      !samePreparedIdentity(afterRead, opened)
    ) {
      throw new TypedToolDeniedError(pathChangedGuidance(path));
    }
  } finally {
    closeSync(fd);
  }
  return Buffer.concat(chunks, total);
}

function readLargeLineSlice(
  resolved: ResolvedWorkspacePath,
  path: string,
  offset: number,
  limit: number,
  state: TypedToolState | undefined,
  onLimited: (() => void) | undefined,
  realpath: (path: string) => string,
): string {
  const fd = openSync(resolved.lexical, "r");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const selected: string[] = [];
  const targetEndExclusive = offset + limit;
  let carry = "";
  let lineNumber = 1;
  let scannedBytes = 0;
  let sawBytes = false;
  let lastDecodedEndedWithNewline = false;
  let done = false;
  let currentLineStartByte = 0;
  let selectedRange: KnownRange | undefined;

  const processLine = (line: string, terminated: boolean): void => {
    const lineStart = currentLineStartByte;
    const lineEnd = lineStart + utf8ByteLength(line);
    if (lineNumber >= offset && lineNumber < targetEndExclusive) {
      selected.push(line);
      selectedRange =
        selectedRange === undefined
          ? { start: lineStart, end: lineEnd }
          : { start: selectedRange.start, end: lineEnd };
    }
    currentLineStartByte = lineEnd + (terminated ? 1 : 0);
    lineNumber += 1;
    if (lineNumber >= targetEndExclusive && selected.length >= limit) done = true;
  };

  try {
    assertOpenedWorkspacePath(resolved, path, fd, realpath);
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      scannedBytes += bytesRead;
      if (scannedBytes > READ_MAX_LARGE_LINE_SCAN_BYTES) {
        throw new TypedToolError(
          "TOOL_ERROR",
          `read: line slice scan exceeded ${String(
            READ_MAX_LARGE_LINE_SCAN_BYTES,
          )} bytes before reaching the requested range; use byteOffset/byteLimit for deep slices`,
        );
      }
      sawBytes = true;
      const chunk = buffer.subarray(0, bytesRead);
      if (chunk.includes(0)) {
        throw new TypedToolError(
          "TOOL_ERROR",
          `read: '${path}' appears to be a binary file; refusing to read`,
        );
      }
      let decoded: string;
      try {
        decoded = decoder.decode(chunk, { stream: true });
      } catch {
        throw new TypedToolError(
          "TOOL_ERROR",
          `read: '${path}' is not complete UTF-8 text; refusing to read`,
        );
      }
      lastDecodedEndedWithNewline = decoded.endsWith("\n");
      carry += decoded;
      let newline: number;
      while ((newline = carry.indexOf("\n")) !== -1) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        processLine(line, true);
        if (done) break;
      }
      if (done) break;
    }
    if (!done) {
      let tail = "";
      try {
        tail = decoder.decode();
      } catch {
        throw new TypedToolError(
          "TOOL_ERROR",
          `read: '${path}' is not complete UTF-8 text; refusing to read`,
        );
      }
      if (tail.length > 0) carry += tail;
      if (sawBytes && (carry.length > 0 || lastDecodedEndedWithNewline)) {
        processLine(carry, false);
      }
    }
  } finally {
    closeSync(fd);
  }

  if (selected.length === 0) {
    onLimited?.();
    return `read: offset ${String(offset)} is past end of file (${String(lineNumber - 1)} lines)`;
  }
  const bounded = boundedReadOutputWithRange(
    path,
    selected.join("\n"),
    selected.length,
    selectedRange ?? { start: currentLineStartByte, end: currentLineStartByte },
    onLimited,
  );
  state?.tracker.markKnown(resolved.lexical, contentHash(bounded.knownText), bounded.range);
  return bounded.output;
}

function errMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "unknown error";
}

function fsGuidance(path: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return `read: '${path}' does not exist`;
  if (code === "EACCES") return `read: '${path}' is not readable (permission denied)`;
  if (code === "ENOTDIR")
    return `read: a parent path component of '${path}' is a file, not a directory`;
  return `read: cannot read '${path}': ${errMessage(error)}`;
}

function writeGuidance(path: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT")
    return `write: parent directory for '${path}' does not exist or changed while being validated; retry after the workspace is stable`;
  if (code === "ENOTDIR" || code === "EEXIST")
    return `write: a parent path component of '${path}' is a file, not a directory`;
  if (code === "EACCES" || code === "EPERM")
    return `write: '${path}' is not writable (permission denied)`;
  if (code === "EISDIR") return `write: '${path}' is a directory, not a file`;
  return `write: cannot write '${path}': ${errMessage(err)}`;
}

function editReadGuidance(path: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return `edit: '${path}' does not exist`;
  if (code === "ENOTDIR")
    return `edit: a parent path component of '${path}' is a file, not a directory`;
  return `edit: cannot read '${path}': ${errMessage(err)}`;
}

function closeQuietly(fd: number, close: (fd: number) => void): void {
  try {
    close(fd);
  } catch {
    // Preserve the original atomic-write error.
  }
}

function withProcessCwd<T>(cwd: string, fn: () => T): T {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

export interface AtomicWriteDeps {
  readonly mkdirSync?: (
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number },
  ) => string | undefined;
  readonly openSync?: (path: string, flags: string, mode?: number) => number;
  readonly writeFileSync?: (fd: number, data: string) => void;
  readonly fsyncSync?: (fd: number) => void;
  readonly closeSync?: (fd: number) => void;
  readonly renameSync?: (from: string, to: string) => void;
}

class AtomicWriteError extends Error {
  readonly mutationPossible: boolean;
  readonly code: string | undefined;

  constructor(error: unknown, mutationPossible: boolean) {
    super(errMessage(error));
    this.name = "AtomicWriteError";
    this.mutationPossible = mutationPossible;
    this.code = (error as NodeJS.ErrnoException).code;
  }
}

interface StableParentDirectory {
  readonly path: string;
  readonly fd: number;
  readonly stats: Stats;
}

function assertStableParentDirectory(
  parent: StableParentDirectory,
  resolved: ResolvedWorkspacePath,
  input: string,
  realpath: (path: string) => string,
): void {
  assertWorkspacePathStillContained(resolved, input, realpath);
  let current: Stats;
  try {
    current = statSync(parent.path);
  } catch {
    throw new TypedToolDeniedError(pathChangedGuidance(input));
  }
  if (!sameFile(current, parent.stats)) throw new TypedToolDeniedError(pathChangedGuidance(input));
}

function assertStableParentCwd(
  parent: StableParentDirectory,
  resolved: ResolvedWorkspacePath,
  input: string,
  realpath: (path: string) => string,
): void {
  let current: Stats;
  let realCwd: string;
  try {
    current = statSync(".");
    realCwd = resolveRealPathForClassification(".", realpath);
  } catch {
    throw new TypedToolDeniedError(pathChangedGuidance(input));
  }
  if (!sameFile(current, parent.stats) || !contains(resolved.root, realCwd)) {
    throw new TypedToolDeniedError(pathChangedGuidance(input));
  }
  assertStableParentDirectory(parent, resolved, input, realpath);
}

function isStableParentCwd(
  parent: StableParentDirectory,
  resolved: ResolvedWorkspacePath,
  input: string,
  realpath: (path: string) => string,
): boolean {
  try {
    assertStableParentCwd(parent, resolved, input, realpath);
    return true;
  } catch {
    return false;
  }
}

function openStableParentDirectory(
  resolved: ResolvedWorkspacePath,
  input: string,
  realpath: (path: string) => string,
): StableParentDirectory {
  const parent = dirname(resolved.lexical);
  let fd: number | undefined;
  try {
    assertWorkspacePathStillContained(resolved, input, realpath);
    fd = openSync(parent, "r");
    const opened = fstatSync(fd);
    const current = statSync(parent);
    if (!sameFile(current, opened)) throw new TypedToolDeniedError(pathChangedGuidance(input));
    let realParent: string;
    try {
      realParent = resolveRealPathForClassification(parent, realpath);
    } catch {
      throw new TypedToolDeniedError(pathChangedGuidance(input));
    }
    if (!contains(resolved.root, realParent)) {
      throw new TypedToolDeniedError(
        `blocked: path '${input}' is outside the workspace; allowed root: ${resolved.root}. Use a workspace-relative path.`,
      );
    }
    return { path: parent, fd, stats: opened };
  } catch (err) {
    if (fd !== undefined) closeQuietly(fd, closeSync);
    throw err;
  }
}

function containedParentSegments(
  resolved: ResolvedWorkspacePath,
  parent: string,
  input: string,
): string[] {
  const rel = relative(resolved.root, parent);
  if (rel === "") return [];
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new TypedToolDeniedError(pathChangedGuidance(input));
  }
  return rel.split(sep).filter((part) => part.length > 0);
}

function ensureParentDirectoryContained(
  resolved: ResolvedWorkspacePath,
  input: string,
  mkdir: NonNullable<AtomicWriteDeps["mkdirSync"]>,
  realpath: (path: string) => string,
): void {
  const parent = dirname(resolved.lexical);
  const segments = containedParentSegments(resolved, parent, input);
  if (segments.length === 0) return;

  assertWorkspacePathStillContained(resolved, input, realpath);
  withProcessCwd(resolved.root, () => {
    for (const segment of segments) {
      try {
        const st = statSync(segment);
        if (!st.isDirectory()) {
          throw new TypedToolDeniedError(
            `write: a parent path component of '${input}' is a file, not a directory`,
          );
        }
      } catch (err) {
        if (err instanceof TypedToolError) throw err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw new TypedToolError("TOOL_ERROR", writeGuidance(input, err));
        try {
          mkdir(segment, { mode: 0o700 });
        } catch (mkdirErr) {
          if ((mkdirErr as NodeJS.ErrnoException).code !== "EEXIST") {
            throw new TypedToolError("TOOL_ERROR", writeGuidance(input, mkdirErr));
          }
        }
      }

      try {
        process.chdir(segment);
      } catch (err) {
        throw new TypedToolError("TOOL_ERROR", writeGuidance(input, err));
      }
      let realCwd: string;
      try {
        realCwd = resolveRealPathForClassification(".", realpath);
      } catch {
        throw new TypedToolDeniedError(pathChangedGuidance(input));
      }
      if (!contains(resolved.root, realCwd)) {
        throw new TypedToolDeniedError(
          `blocked: path '${input}' is outside the workspace; allowed root: ${resolved.root}. Use a workspace-relative path.`,
        );
      }
    }
  });
  assertWorkspacePathStillContained(resolved, input, realpath);
}

function assertOpenedTempContained(
  tmp: string,
  fd: number,
  parent: StableParentDirectory,
  resolved: ResolvedWorkspacePath,
  input: string,
  realpath: (path: string) => string,
): void {
  assertStableParentDirectory(parent, resolved, input, realpath);
  let realTmp: string;
  let current: Stats;
  let opened: Stats;
  try {
    realTmp = resolveRealPathForClassification(tmp, realpath);
    current = statSync(tmp);
    opened = fstatSync(fd);
  } catch {
    throw new TypedToolDeniedError(pathChangedGuidance(input));
  }
  if (!contains(resolved.root, realTmp) || !sameFile(current, opened)) {
    throw new TypedToolDeniedError(pathChangedGuidance(input));
  }
}

function atomicWrite(
  resolved: ResolvedWorkspacePath,
  input: string,
  content: string,
  deps: AtomicWriteDeps = {},
  realpath: (path: string) => string,
  mode?: number,
): void {
  const parent = dirname(resolved.lexical);
  const mkdir = deps.mkdirSync ?? ((p, options) => mkdirSync(p, options));
  let parentCreated = false;
  const trackedMkdir: typeof mkdir = (p, options) => {
    try {
      const result = mkdir(p, options);
      parentCreated = true;
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") parentCreated = true;
      throw error;
    }
  };
  const open = deps.openSync ?? ((p, flags, m) => openSync(p, flags, m));
  const write = deps.writeFileSync ?? ((fd, d) => writeFileSync(fd, d, { encoding: "utf8" }));
  const fsync = deps.fsyncSync ?? ((fd) => fsyncSync(fd));
  const close = deps.closeSync ?? ((fd) => closeSync(fd));
  const rename = deps.renameSync ?? ((from, to) => renameSync(from, to));
  assertWorkspacePathStillContained(resolved, input, realpath);
  try {
    ensureParentDirectoryContained(resolved, input, trackedMkdir, realpath);
  } catch (err) {
    throw new AtomicWriteError(err, parentCreated);
  }
  assertWorkspacePathStillContained(resolved, input, realpath);
  const stableParent = openStableParentDirectory(resolved, input, realpath);
  try {
    withProcessCwd(parent, () => {
      assertStableParentCwd(stableParent, resolved, input, realpath);
      const targetName = basename(resolved.lexical);
      const tmpName = `.${targetName}.${randomBytes(6).toString("hex")}.tmp`;
      let fd: number | undefined;
      let renamed = false;
      try {
        assertStableParentCwd(stableParent, resolved, input, realpath);
        fd = open(tmpName, "wx", mode);
        assertOpenedTempContained(tmpName, fd, stableParent, resolved, input, realpath);
        assertStableParentCwd(stableParent, resolved, input, realpath);
        write(fd, content);
        fsync(fd);
        close(fd);
        fd = undefined;
        assertStableParentCwd(stableParent, resolved, input, realpath);
        rename(join(parent, tmpName), join(parent, targetName));
        renamed = true;
        assertStableParentCwd(stableParent, resolved, input, realpath);
        fsync(stableParent.fd);
      } catch (err) {
        if (fd !== undefined) closeQuietly(fd, close);
        rmSync(tmpName, { force: true });
        const parentUnstable = !isStableParentCwd(stableParent, resolved, input, realpath);
        throw new AtomicWriteError(err, renamed || parentUnstable);
      }
    });
  } finally {
    closeQuietly(stableParent.fd, closeSync);
  }
}

export interface ExecuteReadToolOptions {
  readonly workspaceRoot: string;
  readonly stat?: (path: PathLike) => Stats;
  readonly realpath?: (path: string) => string;
  readonly state?: TypedToolState;
  readonly onLimited?: () => void;
}

export function executeReadTool(rawArgs: JsonObjectT, options: ExecuteReadToolOptions): string {
  const args = parseReadArgs(rawArgs);
  const realpath = options.realpath ?? defaultRealpathSync;
  const resolved = resolveWorkspacePath(options.workspaceRoot, args.path, realpath);
  const stat = options.stat ?? statSync;

  let st;
  try {
    st = stat(resolved.lexical);
  } catch (error) {
    throw new TypedToolError("TOOL_ERROR", fsGuidance(args.path, error));
  }
  if (st.isDirectory()) {
    throw new TypedToolError("TOOL_ERROR", `read: '${args.path}' is a directory, not a file`);
  }
  if (args.byteOffset !== undefined && args.byteLimit !== undefined) {
    return readByteSlice(
      resolved,
      args.path,
      args.byteOffset,
      args.byteLimit,
      st.size,
      options.state,
      options.onLimited,
      realpath,
    );
  }
  if (st.size > READ_MAX_FILE_BYTES) {
    if (args.limit !== undefined) {
      return readLargeLineSlice(
        resolved,
        args.path,
        args.offset ?? 1,
        args.limit,
        options.state,
        options.onLimited,
        realpath,
      );
    }
    throw new TypedToolError(
      "TOOL_ERROR",
      `read: '${args.path}' is ${String(st.size)} bytes (max ${String(
        READ_MAX_FILE_BYTES,
      )}); too large to read whole - narrow with offset/limit or byteOffset/byteLimit`,
    );
  }

  const buf = readWholeFileBounded(resolved, args.path, realpath);
  if (buf.includes(0)) {
    throw new TypedToolError(
      "TOOL_ERROR",
      `read: '${args.path}' appears to be a binary file; refusing to read`,
    );
  }
  const text = decodeTextFile(args.path, buf);
  const lines = text.split("\n");
  const start = (args.offset ?? 1) - 1;
  if (start >= lines.length) {
    options.onLimited?.();
    return `read: offset ${String(args.offset ?? 1)} is past end of file (${String(lines.length)} lines)`;
  }
  const end = args.limit !== undefined ? start + args.limit : lines.length;
  const selected = lines.slice(start, end);
  const output = selected.join("\n");
  if (Buffer.byteLength(output, "utf8") > READ_MAX_OUTPUT_BYTES) {
    if (selected.length === 1) {
      options.onLimited?.();
      const only = selected[0] ?? "";
      const truncated = truncateHeadUtf8(only, READ_MAX_OUTPUT_BYTES);
      const lineStart = lineStartOffsets(text)[start] ?? 0;
      options.state?.tracker.markKnown(
        resolved.lexical,
        contentHash(truncated),
        {
          start: lineStart,
          end: lineStart + utf8ByteLength(truncated),
        },
        contentHash(buf),
      );
      return `${truncated}\n... [line truncated: exceeds ${String(READ_MAX_OUTPUT_BYTES)} bytes] ...`;
    }
    throw new TypedToolError(
      "TOOL_ERROR",
      `read: selected range is too large (> ${String(READ_MAX_OUTPUT_BYTES)} bytes); narrow with offset/limit`,
    );
  }
  if (args.offset === undefined && args.limit === undefined) {
    options.state?.tracker.markKnown(resolved.lexical, contentHash(buf));
  } else {
    options.state?.tracker.markKnown(
      resolved.lexical,
      contentHash(output),
      lineSliceRange(text, start, end),
      contentHash(buf),
    );
  }
  return output;
}

const RgMatch = z.object({
  type: z.literal("match"),
  data: z.object({
    path: z.object({ text: z.string() }),
    line_number: z.number(),
    lines: z.object({ text: z.string() }),
    submatches: z.array(z.object({ start: z.number() })),
  }),
});

const RgSummary = z.object({
  type: z.literal("summary"),
  data: z.object({ stats: z.object({ searches: z.number() }) }),
});

function capLine(text: string, onLimited?: () => void): string {
  if (Buffer.byteLength(text, "utf8") <= SEARCH_MAX_LINE_BYTES) return text;
  onLimited?.();
  return `${truncateHeadUtf8(text, SEARCH_MAX_LINE_BYTES)}... [line truncated]`;
}

function parseRgMatch(
  line: string,
  keep?: (path: string) => boolean,
  onLimited?: () => void,
): string | null {
  if (line.trim() === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const r = RgMatch.safeParse(raw);
  if (!r.success) return null;
  const d = r.data.data;
  const path = normalizeSearchPath(d.path.text);
  if (keep !== undefined && !keep(path)) return null;
  const col = (d.submatches[0]?.start ?? 0) + 1;
  return `${formatSearchResultPath(path)}:${String(d.line_number)}:${String(col)}:${capLine(d.lines.text.replace(/\n$/, ""), onLimited)}`;
}

function contentSearchArgs(pattern: string, scope: string): string[] {
  return [
    "--json",
    "--color=never",
    "--sort",
    "path",
    "--max-columns",
    String(SEARCH_MAX_LINE_BYTES),
    "--max-columns-preview",
    "--",
    pattern,
    scope,
  ];
}

function contentSearchScope(
  root: string,
  glob: string | undefined,
  realpath: (path: string) => string,
): string | undefined {
  const scope = glob === undefined ? "." : (searchExecutionScopeFromGlob(glob) ?? ".");
  if (scope === ".") return ".";
  const resolved = resolveWorkspacePath(root, scope, realpath);
  try {
    statSync(resolved.lexical);
    return scope;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new TypedToolError("TOOL_ERROR", `search: cannot inspect scope '${scope}'`);
  }
}

function filenameMatchesVisibleSearchGlob(path: string, glob: string): boolean {
  return glob === "**" || matchesVisibleSearchGlob(path, glob);
}

function minimalChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { PATH: env["PATH"] ?? "", LC_ALL: "C", LANG: "C" };
}

function runRg(
  rgBin: string,
  rgArgs: string[],
  cwd: string,
  cap: number,
  parse: (line: string) => string | null,
  spawnFn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  delimiter: "\n" | "\0" = "\n",
): Promise<string[]> {
  return new Promise<string[]>((resolvePromise, reject) => {
    const child = spawnFn(rgBin, rgArgs, {
      cwd,
      env: minimalChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const results: string[] = [];
    let buffer = "";
    let stderr = "";
    let done = false;
    let noFilesSearched = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    let reapTimer: NodeJS.Timeout | undefined;

    const settle = (action: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener("abort", abortListener);
      action();
    };
    const ok = (v: string[]): void => settle(() => resolvePromise(v));
    const fail = (error: Error, childAlreadyTerminated = false): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener("abort", abortListener);

      const rejectOnce = (): void => {
        clearTimeout(terminationTimer);
        clearTimeout(reapTimer);
        child.removeListener("exit", rejectOnce);
        child.removeListener("close", rejectOnce);
        reject(error);
      };
      if (childAlreadyTerminated) {
        rejectOnce();
        return;
      }

      child.once("exit", rejectOnce);
      child.once("close", rejectOnce);
      terminationTimer = setTimeout(() => child.kill("SIGKILL"), SEARCH_TERMINATION_GRACE_MS);
      terminationTimer.unref();
      // SIGKILL should always settle an ordinary child. Keep the tool boundary finite for an
      // uninterruptible kernel-state process while still giving shutdown a real reap barrier.
      reapTimer = setTimeout(rejectOnce, SEARCH_REAP_BUDGET_MS);
      reapTimer.unref();
      child.kill("SIGTERM");
    };
    const abortListener = (): void => fail(new TypedToolError("TOOL_ERROR", "search: cancelled"));
    const timer = setTimeout(
      () =>
        fail(
          new TypedToolError(
            "TOOL_ERROR",
            `search: timed out after ${String(timeoutMs)}ms; narrow the pattern or glob`,
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
    if (signal?.aborted === true) {
      abortListener();
      return;
    }
    signal?.addEventListener("abort", abortListener, { once: true });

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (done) return;
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf(delimiter)) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + delimiter.length);
        if (Buffer.byteLength(line, "utf8") > SEARCH_MAX_RAW_STDOUT_LINE_BYTES) {
          fail(
            new TypedToolError(
              "TOOL_ERROR",
              `search: ripgrep output line exceeded ${String(
                SEARCH_MAX_RAW_STDOUT_LINE_BYTES,
              )} bytes; narrow the pattern or glob`,
            ),
          );
          return;
        }
        let jsonValue: unknown = null;
        try {
          jsonValue = JSON.parse(line);
        } catch {
          // Non-JSON stdout is ignored; rg --json may emit partial lines while exiting.
        }
        if (jsonValue !== null) {
          const summaryCheck = RgSummary.safeParse(jsonValue);
          if (summaryCheck.success && summaryCheck.data.data.stats.searches === 0) {
            noFilesSearched = true;
          }
        }
        const parsed = parse(line);
        if (parsed !== null) {
          results.push(parsed);
          if (results.length >= cap) {
            ok(results);
            child.kill("SIGTERM");
            return;
          }
        }
      }
      if (Buffer.byteLength(buffer, "utf8") > SEARCH_MAX_RAW_STDOUT_LINE_BYTES) {
        fail(
          new TypedToolError(
            "TOOL_ERROR",
            `search: ripgrep output line exceeded ${String(
              SEARCH_MAX_RAW_STDOUT_LINE_BYTES,
            )} bytes; narrow the pattern or glob`,
          ),
        );
      }
    });
    child.stderr!.on("data", (c: string) => {
      if (done) return;
      stderr += c;
      if (Buffer.byteLength(stderr, "utf8") > SEARCH_MAX_STDERR_BYTES) {
        fail(
          new TypedToolError(
            "TOOL_ERROR",
            `search: ripgrep stderr exceeded ${String(
              SEARCH_MAX_STDERR_BYTES,
            )} bytes; narrow the pattern or glob`,
          ),
        );
      }
    });
    child.on("error", (err) =>
      fail(new TypedToolError("TOOL_ERROR", `search: cannot run ripgrep: ${err.message}`)),
    );
    child.on("close", (code, signal) => {
      if (done) return;
      if (signal !== null && signal !== undefined) {
        fail(new TypedToolError("TOOL_ERROR", `search: ripgrep terminated by ${signal}`), true);
        return;
      }
      if (code === 0 || code === 1) {
        ok(results);
        return;
      }
      if (code === 2) {
        if (noFilesSearched) {
          ok(results);
          return;
        }
        fail(
          new TypedToolError(
            "TOOL_ERROR",
            `search: ripgrep error: ${stderr.trim() || "invalid pattern or glob"}`,
          ),
          true,
        );
        return;
      }
      if (code === null) {
        fail(new TypedToolError("TOOL_ERROR", "search: ripgrep exited without an exit code"), true);
        return;
      }
      fail(
        new TypedToolError(
          "TOOL_ERROR",
          `search: ripgrep unexpected exit ${String(code)}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
        ),
        true,
      );
    });
  });
}

export interface ExecuteSearchToolOptions {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly realpath?: (path: string) => string;
  readonly spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  readonly rgPath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onLimited?: () => void;
}

export async function executeSearchTool(
  rawArgs: JsonObjectT,
  options: ExecuteSearchToolOptions,
): Promise<string> {
  const env = options.env ?? process.env;
  const realpath = options.realpath ?? defaultRealpathSync;
  const root = realpath(resolve(options.workspaceRoot));
  const args = parseSearchArgs(rawArgs, { workspaceRoot: root, realpath });
  const cap = Math.min(args.maxResults ?? SEARCH_MAX_RESULTS, SEARCH_MAX_RESULTS);
  const keep = (path: string): boolean => {
    if (!isVisibleSearchPath(path)) return false;
    try {
      resolveWorkspacePath(root, path, realpath);
      return true;
    } catch {
      return false;
    }
  };
  const rgBin = options.rgPath ?? env["KEEL_RG_PATH"] ?? "rg";
  const spawnFn = options.spawn ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;

  let results: string[];
  if (args.kind === "filename") {
    results = await runRg(
      rgBin,
      ["--files", "--null", "--sort", "path"],
      root,
      cap + 1,
      (line) => {
        const path = line;
        return path === "" || !keep(path) || !filenameMatchesVisibleSearchGlob(path, args.pattern)
          ? null
          : formatSearchResultPath(path);
      },
      spawnFn,
      options.signal,
      timeoutMs,
      env,
      "\0",
    );
  } else {
    const contentKeep = (path: string): boolean =>
      keep(path) && (args.glob === undefined || matchesVisibleSearchGlob(path, args.glob));
    const scope = contentSearchScope(root, args.glob, realpath);
    if (scope === undefined) {
      results = [];
    } else {
      results = await runRg(
        rgBin,
        contentSearchArgs(args.pattern, scope),
        root,
        cap + 1,
        (line) => parseRgMatch(line, contentKeep, options.onLimited),
        spawnFn,
        options.signal,
        timeoutMs,
        env,
      );
    }
  }

  if (results.length === 0) return "search: no matches.";
  const shown = results.slice(0, cap);
  const more =
    results.length > cap
      ? `\n... ${String(results.length - cap)}+ more matches; refine the pattern or glob.`
      : "";
  if (results.length > cap) options.onLimited?.();
  const raw = shown.join("\n") + more;
  const bounded = truncateHeadTail(raw, SEARCH_MAX_OUTPUT_BYTES);
  if (bounded !== raw) options.onLimited?.();
  return bounded;
}

export interface ExecuteWriteToolOptions extends AtomicWriteDeps {
  readonly workspaceRoot: string;
  readonly stat?: (path: PathLike) => Stats;
  readonly realpath?: (path: string) => string;
  readonly state?: TypedToolState;
  /** Test-gated Slice-2B seam. Admission must succeed before bounded preimage bytes are retained.
   * Callback failure skips only the optional presentation sidecar. */
  readonly captureMutationPresentation?: (images: {
    readonly observedBeforeBytes: number;
    readonly verifiedInstalledAfterBytes: number;
  }) => boolean;
  /** Called once, immediately before the file is mutated (P1-1). The warden uses it to write a
   *  durable pre-execution audit-intent record; if it throws, the mutation does not happen (fail
   *  closed — no executed-but-unaudited write). */
  readonly onBeforeMutate?: () => void;
}

export interface PreparedTypedMutation {
  readonly tool: "write" | "edit";
  readonly path: string;
  readonly lexicalPath: string;
  readonly content: string;
  readonly preparedRoot: string;
  readonly preparedParentIdentities: readonly PreparedPathIdentity[];
  readonly expectedLeaf: PreparedLeafExpectation;
  readonly expectedInstalledHash: string;
  readonly expectedInstalledMode: number;
  readonly expectedCurrentHash?: string;
  readonly presentationObservation?:
    | { readonly observedBeforeContent: string }
    | {
        readonly writeObservedBefore:
          | { readonly status: "file-observed"; readonly content: Uint8Array }
          | { readonly status: "absent-observed" }
          | { readonly status: "not-inspected" };
      };
  runInProcessAtomicWrite(): void;
  commit(): string;
}

export interface PreparedPathIdentity {
  readonly dev: string;
  readonly ino: string;
}

export type PreparedLeafExpectation =
  | { readonly state: "absent" }
  | {
      readonly state: "regular-file";
      readonly dev: string;
      readonly ino: string;
      readonly hash: string;
      readonly mode: number;
    };

interface PreparedMutationPathObservation {
  readonly parentIdentities: readonly PreparedPathIdentity[];
  readonly leaf: PreparedLeafExpectation;
  readonly writeObservedBefore?:
    | { readonly status: "file-observed"; readonly content: Uint8Array }
    | { readonly status: "absent-observed" }
    | { readonly status: "not-inspected" };
}

interface WritePresentationCapture {
  readonly installedAfterBytes: number;
  readonly admit: NonNullable<ExecuteWriteToolOptions["captureMutationPresentation"]>;
}

function preparedPathIdentity(stat: BigIntStats): PreparedPathIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function samePreparedIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function mutationSymlinkError(tool: "write" | "edit", input: string): TypedToolDeniedError {
  return new TypedToolDeniedError(
    `${tool}: '${input}' contains a symbolic link; governed mutations require no-follow path identity`,
  );
}

function lstatOrUndefined(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function observeRegularFileNoFollow(
  path: string,
  input: string,
  tool: "write" | "edit",
  expected: BigIntStats,
  writeCapture?: WritePresentationCapture,
): {
  readonly hash: string;
  readonly writeObservedBefore?:
    | { readonly status: "file-observed"; readonly content: Uint8Array }
    | { readonly status: "not-inspected" };
} {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new TypedToolDeniedError(
      `${tool}: no-follow file identity is unavailable on this platform; refusing '${input}'`,
    );
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !samePreparedIdentity(opened, expected)) {
      throw new TypedToolDeniedError(pathChangedGuidance(input));
    }
    if (opened.size > BigInt(READ_MAX_FILE_BYTES)) {
      throw new TypedToolDeniedError(
        tool === "edit"
          ? `edit: '${input}' is ${String(opened.size)} bytes; too large to edit whole - use smaller targeted files until streaming edit support lands`
          : `write: '${input}' is ${String(opened.size)} bytes; too large for bounded mutation preimage verification`,
      );
    }
    const presentable = opened.size <= BigInt(MUTATION_PRESENTATION_MAX_IMAGE_BYTES);
    let captureAdmitted = false;
    if (tool === "write" && writeCapture !== undefined) {
      try {
        captureAdmitted =
          writeCapture.admit({
            observedBeforeBytes: presentable ? Number(opened.size) : 0,
            verifiedInstalledAfterBytes: writeCapture.installedAfterBytes,
          }) === true;
      } catch {
        // Presentation is optional and cannot deny an already-valid governed mutation.
        captureAdmitted = false;
      }
    }
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let retainedChunks: Buffer[] | undefined = captureAdmitted && presentable ? [] : undefined;
    let captureExceededCeiling = false;
    let total = 0;
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      total += bytes;
      if (total > READ_MAX_FILE_BYTES) {
        throw new TypedToolDeniedError(
          `${tool}: '${input}' grew beyond ${String(READ_MAX_FILE_BYTES)} bytes during mutation preimage verification`,
        );
      }
      const chunk = buffer.subarray(0, bytes);
      digest.update(chunk);
      if (retainedChunks !== undefined) {
        if (total > MUTATION_PRESENTATION_MAX_IMAGE_BYTES) {
          // A same-inode concurrent writer can grow the descriptor after admission. Release every
          // retained chunk immediately and preserve only the explicit not-inspected state.
          retainedChunks.length = 0;
          retainedChunks = undefined;
          captureExceededCeiling = true;
        } else {
          retainedChunks.push(Buffer.from(chunk));
        }
      }
    }
    const current = lstatOrUndefined(path);
    if (
      current === undefined ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      !samePreparedIdentity(current, opened)
    ) {
      throw new TypedToolDeniedError(pathChangedGuidance(input));
    }
    return {
      hash: digest.digest("hex"),
      ...(captureAdmitted
        ? {
            writeObservedBefore:
              presentable && !captureExceededCeiling
                ? {
                    status: "file-observed" as const,
                    content: Buffer.concat(retainedChunks ?? [], total),
                  }
                : { status: "not-inspected" as const },
          }
        : {}),
    };
  } catch (error) {
    if (error instanceof TypedToolError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw mutationSymlinkError(tool, input);
    }
    throw new TypedToolError(
      "TOOL_ERROR",
      `${tool}: cannot verify '${input}' without following links: ${errMessage(error)}`,
    );
  } finally {
    if (fd !== undefined) closeQuietly(fd, closeSync);
  }
}

function observePreparedMutationPath(
  resolved: ResolvedWorkspacePath,
  input: string,
  tool: "write" | "edit",
  realpath: (path: string) => string,
  writeCapture?: WritePresentationCapture,
): PreparedMutationPathObservation {
  const parent = dirname(resolved.lexical);
  const segments = containedParentSegments(resolved, parent, input);
  return withProcessCwd(resolved.root, () => {
    const root = lstatSync(".", { bigint: true });
    let realCurrent: string;
    try {
      realCurrent = realpath(".");
    } catch {
      throw new TypedToolDeniedError(pathChangedGuidance(input));
    }
    if (!root.isDirectory() || realCurrent !== resolved.root) {
      throw new TypedToolDeniedError(pathChangedGuidance(input));
    }

    const parentIdentities: PreparedPathIdentity[] = [preparedPathIdentity(root)];
    for (const segment of segments) {
      const stat = lstatOrUndefined(segment);
      if (stat === undefined) return { parentIdentities, leaf: { state: "absent" } };
      if (stat.isSymbolicLink()) throw mutationSymlinkError(tool, input);
      if (!stat.isDirectory()) {
        throw new TypedToolError(
          "TOOL_ERROR",
          `${tool}: a parent path component of '${input}' is a file, not a directory`,
        );
      }
      process.chdir(segment);
      const entered = lstatSync(".", { bigint: true });
      try {
        realCurrent = realpath(".");
      } catch {
        throw new TypedToolDeniedError(pathChangedGuidance(input));
      }
      if (!samePreparedIdentity(stat, entered) || !contains(resolved.root, realCurrent)) {
        throw new TypedToolDeniedError(pathChangedGuidance(input));
      }
      parentIdentities.push(preparedPathIdentity(entered));
    }

    const leafName = basename(resolved.lexical);
    const leaf = lstatOrUndefined(leafName);
    if (leaf === undefined) return { parentIdentities, leaf: { state: "absent" } };
    if (leaf.isSymbolicLink()) throw mutationSymlinkError(tool, input);
    if (!leaf.isFile()) {
      throw new TypedToolError("TOOL_ERROR", `${tool}: '${input}' is not a regular file`);
    }
    const file = observeRegularFileNoFollow(leafName, input, tool, leaf, writeCapture);
    return {
      parentIdentities,
      leaf: {
        state: "regular-file",
        ...preparedPathIdentity(leaf),
        hash: file.hash,
        mode: Number(leaf.mode & 0o777n),
      },
      ...(file.writeObservedBefore === undefined
        ? {}
        : { writeObservedBefore: file.writeObservedBefore }),
    };
  });
}

function samePreparedPathObservation(
  left: PreparedMutationPathObservation,
  right: PreparedMutationPathObservation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function prepareWriteToolMutation(
  rawArgs: JsonObjectT,
  options: ExecuteWriteToolOptions,
): PreparedTypedMutation {
  const args = parseWriteArgs(rawArgs);
  const realpath = options.realpath ?? defaultRealpathSync;
  const resolved = resolveWorkspacePath(options.workspaceRoot, args.path, realpath);
  const stat = options.stat ?? statSync;
  let existed = false;
  try {
    const st = stat(resolved.lexical);
    if (st.isDirectory()) {
      throw new TypedToolError("TOOL_ERROR", `write: '${args.path}' is a directory, not a file`);
    }
    existed = true;
  } catch (err) {
    if (err instanceof TypedToolError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new TypedToolError("TOOL_ERROR", writeGuidance(args.path, err));
    }
  }

  assertWorkspacePathStillContained(resolved, args.path, realpath);
  const verifiedInstalledAfterBytes = Buffer.byteLength(args.content, "utf8");
  const writeCapture =
    options.captureMutationPresentation === undefined
      ? undefined
      : {
          installedAfterBytes: verifiedInstalledAfterBytes,
          admit: options.captureMutationPresentation,
        };
  const observed = observePreparedMutationPath(
    resolved,
    args.path,
    "write",
    realpath,
    writeCapture,
  );
  const expectedInstalledMode =
    observed.leaf.state === "regular-file" ? observed.leaf.mode : 0o666 & ~process.umask();
  let writeObservedBefore = observed.writeObservedBefore;
  if (
    writeObservedBefore === undefined &&
    observed.leaf.state === "absent" &&
    options.captureMutationPresentation !== undefined
  ) {
    try {
      if (
        options.captureMutationPresentation({
          observedBeforeBytes: 0,
          verifiedInstalledAfterBytes,
        }) === true
      ) {
        writeObservedBefore = { status: "absent-observed" };
      }
    } catch {
      // Presentation admission cannot alter mutation validation or settlement.
    }
  }
  return {
    tool: "write",
    path: args.path,
    lexicalPath: resolved.lexical,
    content: args.content,
    preparedRoot: resolved.root,
    preparedParentIdentities: observed.parentIdentities,
    expectedLeaf: observed.leaf,
    expectedInstalledHash: contentHash(args.content),
    expectedInstalledMode,
    ...(observed.leaf.state === "regular-file" ? { expectedCurrentHash: observed.leaf.hash } : {}),
    ...(writeObservedBefore === undefined
      ? {}
      : { presentationObservation: { writeObservedBefore } }),
    runInProcessAtomicWrite(): void {
      try {
        atomicWrite(resolved, args.path, args.content, options, realpath);
        try {
          assertWorkspacePathStillContained(resolved, args.path, realpath);
        } catch (err) {
          throw new AtomicWriteError(err, true);
        }
      } catch (err) {
        const mutationPossible = err instanceof AtomicWriteError && err.mutationPossible;
        const suffix = mutationPossible
          ? "; target may have changed — inspect it before retrying"
          : "";
        throw new TypedToolError("TOOL_ERROR", `${writeGuidance(args.path, err)}${suffix}`, {
          mutationPossible,
        });
      }
    },
    commit(): string {
      options.state?.tracker.markKnown(resolved.lexical, contentHash(args.content));
      const bytes = Buffer.byteLength(args.content, "utf8");
      return `write: ${existed ? "overwrote" : "created"} '${args.path}' (${String(bytes)} bytes)`;
    },
  };
}

export function executeWriteTool(rawArgs: JsonObjectT, options: ExecuteWriteToolOptions): string {
  const mutation = prepareWriteToolMutation(rawArgs, options);
  options.onBeforeMutate?.(); // P1-1: durable audit intent before the mutation; throws -> no write
  mutation.runInProcessAtomicWrite();
  return mutation.commit();
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return count;
    count += 1;
    from = i + needle.length;
  }
}

function partialReadEditGuidance(path: string): string {
  return (
    `edit: Re-read the target range in '${path}' before editing it - keel cannot validate this ` +
    `edit against partially read file content (read-before-edit, Section 8.6).`
  );
}

export interface ExecuteEditToolOptions extends AtomicWriteDeps {
  readonly workspaceRoot: string;
  readonly realpath?: (path: string) => string;
  readonly state?: TypedToolState;
  readonly readFile?: (path: string) => Buffer;
  /** Test-gated Slice-2B seam. A callback receives exact UTF-8 image sizes and must admit the
   * optional retention before producer content is attached. Callback failure simply skips the
   * presentation sidecar; it cannot deny or rewrite the governed mutation. */
  readonly captureMutationPresentation?: (images: {
    readonly observedBeforeBytes: number;
    readonly verifiedInstalledAfterBytes: number;
  }) => boolean;
  /** Called once, immediately before the file is mutated (P1-1) — AFTER every read-before-edit /
   *  stale / anchor check has passed, so a denied edit never fires it. If it throws, no mutation
   *  happens (fail closed). */
  readonly onBeforeMutate?: () => void;
}

export function prepareEditToolMutation(
  rawArgs: JsonObjectT,
  options: ExecuteEditToolOptions,
): PreparedTypedMutation {
  const args = parseEditArgs(rawArgs);
  const realpath = options.realpath ?? defaultRealpathSync;
  const resolved = resolveWorkspacePath(options.workspaceRoot, args.path, realpath);
  const preparedBeforeRead = observePreparedMutationPath(resolved, args.path, "edit", realpath);
  const preparedLeaf = preparedBeforeRead.leaf;
  if (preparedLeaf.state === "absent") {
    throw new TypedToolError("TOOL_ERROR", `edit: '${args.path}' does not exist`);
  }
  const read: (path: string) => Buffer =
    options.readFile ?? (() => readContainedFile(resolved, args.path, realpath, preparedLeaf));

  let content: string;
  try {
    if (options.readFile !== undefined)
      assertWorkspacePathStillContained(resolved, args.path, realpath);
    content = decodeTextFile(args.path, read(resolved.lexical));
    if (options.readFile !== undefined)
      assertWorkspacePathStillContained(resolved, args.path, realpath);
  } catch (err) {
    if (err instanceof TypedToolError) throw err;
    throw new TypedToolError("TOOL_ERROR", editReadGuidance(args.path, err));
  }
  if (content.includes("\0")) {
    throw new TypedToolDeniedError(
      `edit: '${args.path}' appears to be a binary file; refusing to edit`,
    );
  }

  const currentHash = contentHash(content);
  const preparedAfterRead = observePreparedMutationPath(resolved, args.path, "edit", realpath);
  if (
    preparedAfterRead.leaf.state !== "regular-file" ||
    preparedAfterRead.leaf.hash !== currentHash ||
    !samePreparedPathObservation(preparedBeforeRead, preparedAfterRead)
  ) {
    throw new TypedToolDeniedError(pathChangedGuidance(args.path));
  }
  let partialCoverage = false;
  if (options.state !== undefined) {
    const known = options.state.tracker.knownHash(resolved.lexical);
    if (!options.state.tracker.hasKnownCoverage(resolved.lexical)) {
      throw new TypedToolDeniedError(
        `edit: read '${args.path}' before editing it - keel requires reading a file this session before editing it (read-before-edit, Section 8.6).`,
      );
    }
    if (known !== undefined && known !== currentHash) {
      throw new TypedToolDeniedError(
        `edit: '${args.path}' changed on disk since you read it - re-read it before editing (its content is stale; Section 4.7.10).`,
      );
    }
    partialCoverage = !options.state.tracker.coversFullFile(resolved.lexical, currentHash);
  }

  const count = countOccurrences(content, args.oldString);
  if (partialCoverage && count !== 1) {
    throw new TypedToolDeniedError(partialReadEditGuidance(args.path));
  }
  if (count === 0) {
    throw new TypedToolError(
      "TOOL_ERROR",
      `edit: oldString not found in '${args.path}' - the anchor must match byte-for-byte; check whitespace and line endings.`,
    );
  }
  if (count > 1) {
    throw new TypedToolError(
      "TOOL_ERROR",
      `edit: oldString matches ${String(count)} times in '${args.path}'; add surrounding context to make it unique.`,
    );
  }
  const i = content.indexOf(args.oldString);
  const previousHash = currentHash;
  const replacedStart = utf8ByteLength(content.slice(0, i));
  const replaced = { start: replacedStart, end: replacedStart + utf8ByteLength(args.oldString) };
  if (
    options.state !== undefined &&
    !options.state.tracker.coversRange(resolved.lexical, previousHash, replaced, content)
  ) {
    if (partialCoverage) throw new TypedToolDeniedError(partialReadEditGuidance(args.path));
    throw new TypedToolDeniedError(
      `edit: read the target range in '${args.path}' before editing it - keel refuses edits to an unread region (Section 8.6).`,
    );
  }
  const updated = content.slice(0, i) + args.newString + content.slice(i + args.oldString.length);
  if (updated.includes("\0")) {
    throw new TypedToolError(
      "INVALID_PARAMS",
      "edit: replacement would create NUL bytes; refusing binary content",
    );
  }

  assertWorkspacePathStillContained(resolved, args.path, realpath);
  let captureMutationPresentation = false;
  if (options.captureMutationPresentation !== undefined) {
    try {
      captureMutationPresentation =
        options.captureMutationPresentation({
          observedBeforeBytes: Buffer.byteLength(content, "utf8"),
          verifiedInstalledAfterBytes: Buffer.byteLength(updated, "utf8"),
        }) === true;
    } catch {
      // Optional admission is presentation-only. A failed admission callback cannot change the
      // already-validated mutation; it merely prevents producer content from being retained.
      captureMutationPresentation = false;
    }
  }
  return {
    tool: "edit",
    path: args.path,
    lexicalPath: resolved.lexical,
    content: updated,
    preparedRoot: resolved.root,
    preparedParentIdentities: preparedAfterRead.parentIdentities,
    expectedLeaf: preparedAfterRead.leaf,
    expectedInstalledHash: contentHash(updated),
    expectedInstalledMode: preparedAfterRead.leaf.mode,
    expectedCurrentHash: previousHash,
    ...(captureMutationPresentation
      ? { presentationObservation: { observedBeforeContent: content } }
      : {}),
    runInProcessAtomicWrite(): void {
      try {
        atomicWrite(resolved, args.path, updated, options, realpath);
        try {
          assertWorkspacePathStillContained(resolved, args.path, realpath);
        } catch (err) {
          throw new AtomicWriteError(err, true);
        }
      } catch (err) {
        const mutationPossible = err instanceof AtomicWriteError && err.mutationPossible;
        const suffix = mutationPossible
          ? "; target may have changed — inspect it before retrying"
          : "";
        throw new TypedToolError(
          "TOOL_ERROR",
          `edit: cannot write '${args.path}': ${errMessage(err)}${suffix}`,
          { mutationPossible },
        );
      }
    },
    commit(): string {
      options.state?.tracker.markEdited(
        resolved.lexical,
        previousHash,
        contentHash(updated),
        replaced,
        utf8ByteLength(args.newString),
        content,
        updated,
      );
      return `edit: replaced 1 occurrence in '${args.path}'`;
    },
  };
}

export function executeEditTool(rawArgs: JsonObjectT, options: ExecuteEditToolOptions): string {
  const mutation = prepareEditToolMutation(rawArgs, options);
  options.onBeforeMutate?.(); // P1-1: durable audit intent before the mutation; throws -> no write
  mutation.runInProcessAtomicWrite();
  return mutation.commit();
}
