import { isErrorLine } from "./error-keywords.js";
import { normalizeCarriageReturnProgress } from "./generic.js";
import type { CompressOpts, CompressResult, ContentCompressor } from "./types.js";

const HEAD_LINES = 5;
const TAIL_LINES = 5;

/**
 * Log / command-output compressor: keep the head + tail anchor lines and EVERY error/warn/fail line
 * (needle retention — a tested invariant); elide contiguous dropped runs with a "… [N lines elided] …"
 * marker. Single-pass over lines (bounded by line count, hostile-input safe). A short log (≤ head+tail)
 * is returned verbatim. The runner's never-enlarge guard discards any result that didn't actually
 * shrink (so the elision markers can't make a tiny log bigger).
 */
export const logCompressor: ContentCompressor = {
  kind: "log",
  compress(content: string, _opts: CompressOpts): CompressResult {
    const normalized = normalizeCarriageReturnProgress(content);
    const lines = normalized.split("\n");
    const n = lines.length;
    const keep = new Array<boolean>(n).fill(false);
    for (let i = 0; i < n; i++) {
      if (i < HEAD_LINES || i >= n - TAIL_LINES || isErrorLine(lines[i]!)) keep[i] = true;
    }
    const out: string[] = [];
    let lastKept = -1;
    for (let i = 0; i < n; i++) {
      if (!keep[i]) continue;
      if (lastKept !== -1 && i > lastKept + 1) {
        out.push(`… [${String(i - lastKept - 1)} lines elided] …`);
      }
      out.push(lines[i]!);
      lastKept = i;
    }
    return { text: out.join("\n"), kind: "log" };
  },
};
