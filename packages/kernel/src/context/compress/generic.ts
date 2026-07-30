import { truncateHeadTail } from "../../tools/truncate.js";
import { isErrorLine } from "./error-keywords.js";
import type { CompressOpts, CompressResult, ContentCompressor } from "./types.js";

const DEFAULT_MAX_BYTES = 4096;

/**
 * Collapse terminal progress updates that reuse the same physical line via carriage returns. This
 * mirrors the final visible line state closely enough for progress bars/log spinners while preserving
 * ordinary newline anchors before any head/tail truncation runs.
 */
export function normalizeCarriageReturnProgress(text: string): string {
  if (!text.includes("\r")) return text;
  const lines: string[] = [];
  let segment = "";
  let finalVisible = "";
  let retainedImportant: string[] | undefined;

  const finishSegment = (): void => {
    if (segment.length > 0 && isErrorLine(segment)) {
      retainedImportant ??= [];
      retainedImportant.push(segment);
    }
    finalVisible = segment;
    segment = "";
  };
  const finishLine = (): void => {
    finishSegment();
    const important = (retainedImportant ?? []).filter((s) => s !== finalVisible);
    lines.push([...important, finalVisible].join("\n"));
    finalVisible = "";
    retainedImportant = undefined;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\r") {
      finishSegment();
    } else if (ch === "\n") {
      finishLine();
    } else {
      segment += ch;
    }
  }
  finishLine();
  return lines.join("\n");
}

/** Collapse runs of identical consecutive lines to one line + a "(×N)" count. Single-pass, O(n). */
function collapseConsecutiveDuplicates(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    const original = lines.slice(i, j).join("\n");
    const collapsed = `${lines[i]!} (×${String(run)})`;
    if (run > 1 && collapsed.length < original.length) {
      out.push(collapsed);
    } else {
      out.push(...lines.slice(i, j));
    }
    i = j;
  }
  return out.join("\n");
}

/**
 * Universal fallback compressor: collapse consecutive duplicate lines, then head/tail to a byte budget
 * (reusing `truncateHeadTail`, which marks the elision and cuts on UTF-8 boundaries). Safe for any
 * content type — it never parses structure, so it cannot corrupt an unrecognized format. Idempotent:
 * re-compressing already-compressed (sub-budget, dedup-stable) text is a no-op.
 */
export const genericCompressor: ContentCompressor = {
  kind: "generic",
  compress(content: string, opts: CompressOpts): CompressResult {
    const normalized = normalizeCarriageReturnProgress(content);
    const deduped = collapseConsecutiveDuplicates(normalized);
    const { text } = truncateHeadTail(deduped, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    return { text: text.length <= content.length ? text : content, kind: "generic" };
  },
};
