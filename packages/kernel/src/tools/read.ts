import { closeSync, openSync, type PathLike, readSync, statSync as defaultStatSync } from "node:fs";
import type { Stats } from "node:fs";
import { TextDecoder } from "node:util";
import { z } from "zod";
import type { JsonObjectT } from "@keel/shared";
import { parseArgs } from "./args.js";
import { ToolError } from "./errors.js";
import { contentHash, type FileAccessTracker } from "./file-access.js";
import { truncateHeadUtf8 } from "./truncate.js";
import { staticCapability, type CoreTool } from "./registry.js";
import { errMessage } from "./strings.js";
import { Workspace } from "./workspace.js";

/** Cap on returned (materialized) output — narrow with offset/limit to read a slice of a big file. */
export const READ_MAX_OUTPUT_BYTES = 64 * 1024;
/** Hard ceiling: refuse before loading a file this large (OOM guard; the sandbox bounds this Phase 2). */
export const READ_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Max bytes a large-file line slice may scan synchronously before requiring byte offsets. */
export const READ_MAX_LARGE_LINE_SCAN_BYTES = 16 * 1024 * 1024;
/** NUL-byte sniff window for binary detection. */
export const READ_BINARY_SNIFF_BYTES = 8192;

export const ReadArgs = z
  .object({
    path: z.string().min(1),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
    start: z.number().int().positive().optional(),
    start_line: z.number().int().positive().optional(),
    byteOffset: z.number().int().nonnegative().optional(),
    byteLimit: z.number().int().positive().optional(),
    followSymlink: z.boolean().optional(),
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

export const SPEC = {
  name: "read",
  description:
    "Read one UTF-8 text file, not a directory, in the workspace or a declared read root. Optional 1-based `offset` " +
    "(start line) and `limit` (max lines) read a slice. Binary files and oversize ranges are refused " +
    "with guidance. To inspect a directory, use search with `kind: filename`, `pattern: packages/**`. " +
    "Non-governed callers may opt into lexical symlink reads with `followSymlink`; governed mode keeps symlink escapes denied.",
  // Model-facing JSON Schema — mirrors `ReadArgs` (a drift-guard test asserts the two agree).
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        description: "Workspace-relative or absolute file path under an allowed read root.",
      },
      offset: {
        type: "integer",
        minimum: 1,
        description: "1-based start line; reads from here.",
      },
      start: {
        type: "integer",
        minimum: 1,
        description: "Compatibility alias for offset; prefer offset.",
      },
      start_line: {
        type: "integer",
        minimum: 1,
        description: "Compatibility alias for offset; prefer offset.",
      },
      limit: { type: "integer", minimum: 1, description: "Maximum number of lines to read." },
      byteOffset: {
        type: "integer",
        minimum: 0,
        description:
          "0-based byte offset for a bounded byte slice. Provide byteLimit too; do not combine byte slices with line offset/limit.",
      },
      byteLimit: {
        type: "integer",
        minimum: 1,
        maximum: READ_MAX_OUTPUT_BYTES,
        description:
          "Maximum bytes to read from byteOffset; capped by the tool output limit. Provide byteOffset too.",
      },
      followSymlink: {
        type: "boolean",
        description:
          "Non-governed lexical symlink mode; governed mode does not expose this option.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
} as const;

function normalizeReadArgs(raw: JsonObjectT): JsonObjectT {
  const normalized: JsonObjectT = { ...raw };
  const aliases = ["start", "start_line"] as const;
  for (const alias of aliases) {
    if (!(alias in normalized)) continue;
    const value = normalized[alias];
    if (value === undefined) continue;
    if ("offset" in normalized && normalized["offset"] !== value) {
      throw new ToolError(`read: conflicting '${alias}' and 'offset' arguments`);
    }
    normalized["offset"] = value;
    delete normalized[alias];
  }
  return normalized;
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

function fsGuidance(path: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return `read: '${path}' does not exist`;
  if (code === "EACCES") return `read: '${path}' is not readable (permission denied)`;
  if (code === "ENOTDIR")
    return `read: a parent path component of '${path}' is a file, not a directory`;
  return `read: cannot read '${path}': ${errMessage(err)}`;
}

function decodeUtf8(path: string, bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ToolError(
      `read: byte slice of '${path}' is not complete UTF-8 text; adjust byteOffset/byteLimit`,
    );
  }
}

function decodeTextFile(path: string, bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ToolError(`read: '${path}' is not complete UTF-8 text; refusing to read`);
  }
}

function boundedReadOutputWithRange(
  path: string,
  output: string,
  selectedLines: number,
  range: { readonly start: number; readonly end: number },
): {
  readonly output: string;
  readonly knownText: string;
  readonly range: { readonly start: number; readonly end: number };
} {
  if (utf8ByteLength(output) <= READ_MAX_OUTPUT_BYTES) return { output, knownText: output, range };
  if (selectedLines === 1) {
    const truncated = truncateHeadUtf8(output, READ_MAX_OUTPUT_BYTES);
    return {
      output: `${truncated}\n… [line truncated: exceeds ${String(READ_MAX_OUTPUT_BYTES)} bytes] …`,
      knownText: truncated,
      range: { start: range.start, end: range.start + utf8ByteLength(truncated) },
    };
  }
  throw new ToolError(
    `read: selected range is too large (> ${String(READ_MAX_OUTPUT_BYTES)} bytes); narrow with offset/limit`,
  );
}

function readByteSlice(
  abs: string,
  path: string,
  byteOffset: number,
  byteLimit: number,
  size: number,
  tracker: FileAccessTracker | undefined,
): string {
  if (byteOffset >= size) {
    return `read: byteOffset ${String(byteOffset)} is past end of file (${String(size)} bytes)`;
  }
  const fd = openSync(abs, "r");
  try {
    const buffer = Buffer.alloc(byteLimit);
    const bytesRead = readSync(fd, buffer, 0, byteLimit, byteOffset);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) {
      throw new ToolError(`read: '${path}' appears to be a binary file; refusing to read`);
    }
    const decoded = decodeUtf8(path, slice);
    tracker?.markKnown(abs, contentHash(slice), {
      start: byteOffset,
      end: byteOffset + bytesRead,
    });
    return decoded;
  } finally {
    closeSync(fd);
  }
}

function readWholeFileBounded(abs: string, path: string): Buffer {
  const fd = openSync(abs, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const remaining = READ_MAX_FILE_BYTES + 1 - total;
      const buffer = Buffer.alloc(Math.min(64 * 1024, remaining));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > READ_MAX_FILE_BYTES) {
        throw new ToolError(
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

function readLargeLineSlice(
  abs: string,
  path: string,
  offset: number,
  limit: number,
  tracker: FileAccessTracker | undefined,
): string {
  const fd = openSync(abs, "r");
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
  let selectedRange: { readonly start: number; readonly end: number } | undefined;

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
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      scannedBytes += bytesRead;
      if (scannedBytes > READ_MAX_LARGE_LINE_SCAN_BYTES) {
        throw new ToolError(
          `read: line slice scan exceeded ${String(
            READ_MAX_LARGE_LINE_SCAN_BYTES,
          )} bytes before reaching the requested range; use byteOffset/byteLimit for deep slices`,
        );
      }
      sawBytes = true;
      const chunk = buffer.subarray(0, bytesRead);
      if (chunk.includes(0)) {
        throw new ToolError(`read: '${path}' appears to be a binary file; refusing to read`);
      }
      let decoded: string;
      try {
        decoded = decoder.decode(chunk, { stream: true });
      } catch {
        throw new ToolError(`read: '${path}' is not complete UTF-8 text; refusing to read`);
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
        throw new ToolError(`read: '${path}' is not complete UTF-8 text; refusing to read`);
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
    return `read: offset ${String(offset)} is past end of file (${String(lineNumber - 1)} lines)`;
  }
  const bounded = boundedReadOutputWithRange(
    path,
    selected.join("\n"),
    selected.length,
    selectedRange ?? { start: currentLineStartByte, end: currentLineStartByte },
  );
  tracker?.markKnown(abs, contentHash(bounded.knownText), bounded.range);
  return bounded.output;
}

/** Injection seam for tests: allows overriding `statSync` (ESM spying is not available). The
 *  `tracker` records the file as known for the read-before-edit invariant (§8.6); omitted → no
 *  tracking (standalone use / unit tests). `createCoreTools` wires the shared per-session tracker. */
export interface ReadToolDeps {
  readonly statSync?: (path: PathLike) => Stats;
  readonly tracker?: FileAccessTracker;
}

export function createReadTool(workspace: Workspace, deps: ReadToolDeps = {}): CoreTool {
  const statSync: (path: PathLike) => Stats = deps.statSync ?? defaultStatSync;
  const handler = (raw: JsonObjectT): string => {
    const args = parseArgs("read", ReadArgs, normalizeReadArgs(raw));
    const resolved =
      args.followSymlink === true
        ? workspace.resolveLexical(args.path, { operation: "read" })
        : workspace.resolve(args.path, { operation: "read" });
    if (!resolved.ok) throw new ToolError(resolved.denial.guidance);
    const abs = resolved.path;

    let st;
    try {
      st = statSync(abs);
    } catch (err) {
      throw new ToolError(fsGuidance(args.path, err));
    }
    if (st.isDirectory()) throw new ToolError(`read: '${args.path}' is a directory, not a file`);
    if (args.byteOffset !== undefined && args.byteLimit !== undefined) {
      return readByteSlice(abs, args.path, args.byteOffset, args.byteLimit, st.size, deps.tracker);
    }
    if (st.size > READ_MAX_FILE_BYTES) {
      if (args.limit !== undefined) {
        return readLargeLineSlice(abs, args.path, args.offset ?? 1, args.limit, deps.tracker);
      }
      throw new ToolError(
        `read: '${args.path}' is ${String(st.size)} bytes (max ${String(
          READ_MAX_FILE_BYTES,
        )}); too large to read whole — narrow with offset/limit or byteOffset/byteLimit`,
      );
    }

    const buf = readWholeFileBounded(abs, args.path);
    if (buf.includes(0)) {
      throw new ToolError(`read: '${args.path}' appears to be a binary file; refusing to read`);
    }
    const text = decodeTextFile(args.path, buf);
    const hash = contentHash(buf);
    const lines = text.split("\n");
    const start = (args.offset ?? 1) - 1;
    if (start >= lines.length) {
      return `read: offset ${String(args.offset ?? 1)} is past end of file (${String(lines.length)} lines)`;
    }
    const end = args.limit !== undefined ? start + args.limit : lines.length;
    const selected = lines.slice(start, end);
    const output = selected.join("\n");
    if (utf8ByteLength(output) > READ_MAX_OUTPUT_BYTES) {
      if (selected.length === 1) {
        const only = selected[0] ?? "";
        const truncated = truncateHeadUtf8(only, READ_MAX_OUTPUT_BYTES);
        const starts = lineStartOffsets(text);
        const rangeStart = starts[start] as number;
        deps.tracker?.markKnown(
          abs,
          contentHash(truncated),
          {
            start: rangeStart,
            end: rangeStart + utf8ByteLength(truncated),
          },
          hash,
        );
        return `${truncated}\n… [line truncated: exceeds ${String(READ_MAX_OUTPUT_BYTES)} bytes] …`;
      }
      throw new ToolError(
        `read: selected range is too large (> ${String(READ_MAX_OUTPUT_BYTES)} bytes); narrow with offset/limit`,
      );
    }
    if (args.offset === undefined && args.limit === undefined) {
      deps.tracker?.markKnown(abs, hash);
    } else {
      const starts = lineStartOffsets(text);
      const rangeStart = starts[start] as number;
      const rangeEnd = rangeStart + utf8ByteLength(selected.join("\n"));
      deps.tracker?.markKnown(
        abs,
        contentHash(output),
        {
          start: rangeStart,
          end: rangeEnd,
        },
        hash,
      );
    }
    return output;
  };
  return { spec: SPEC, handler, staticCapability: staticCapability(SPEC.name, ["fs_read"]) };
}
