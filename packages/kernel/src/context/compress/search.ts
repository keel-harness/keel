import type { CompressOpts, CompressResult, ContentCompressor } from "./types.js";

/** keel's search tool emits `path:line:col:text` (tools/search.ts). Match the `path:line:` prefix
 *  non-greedily; the remainder (`col:text`) is the match body. Non-matching lines pass through. */
const MATCH = /^(.+?):(\d+):/;
const KEEP_RELEVANT_PER_FILE = 2;
const MAX_FILES = 15;

/**
 * Search-results compressor: group grep-style matches by file; per file keep the first + last match and
 * up to a few whose text overlaps `taskTokens` (deterministic keyword overlap — NOT BM25); cap the
 * number of files; mark elisions. Non-matching lines (headers, the tool's "N+ more" note) pass through
 * verbatim — an unrecognized shape is never corrupted (defensive). Single-pass; the never-enlarge guard
 * (runner) discards a non-shrinking result.
 */
export const searchCompressor: ContentCompressor = {
  kind: "search",
  compress(content: string, opts: CompressOpts): CompressResult {
    const tokens = (opts.taskTokens ?? []).map((t) => t.toLowerCase()).filter((t) => t.length > 0);
    const lines = content.split("\n");
    const byFile = new Map<string, string[]>();
    const passthrough: string[] = [];
    for (const line of lines) {
      const m = MATCH.exec(line);
      if (m === null) {
        passthrough.push(line);
        continue;
      }
      const file = m[1]!;
      const arr = byFile.get(file);
      if (arr === undefined) byFile.set(file, [line]);
      else arr.push(line);
    }

    const out: string[] = [...passthrough];
    let fileCount = 0;
    for (const [file, matches] of byFile) {
      if (fileCount >= MAX_FILES) {
        out.push(`… [${String(byFile.size - MAX_FILES)} more files elided] …`);
        break;
      }
      fileCount++;
      // Keep by INDEX, not text value: a Set<string> would re-admit EVERY identical-text match
      // (defeating compression on duplicate grep hits, QC must-fix). Keep first + last + up to a few
      // whose text overlaps taskTokens.
      const keepIdx = new Set<number>([0, matches.length - 1]);
      if (tokens.length > 0) {
        let relevantKept = 0;
        for (let k = 0; k < matches.length && relevantKept < KEEP_RELEVANT_PER_FILE; k++) {
          if (keepIdx.has(k)) continue;
          if (tokens.some((t) => matches[k]!.toLowerCase().includes(t))) {
            keepIdx.add(k);
            relevantKept++;
          }
        }
      }
      const kept = matches.filter((_, k) => keepIdx.has(k));
      out.push(...kept);
      const dropped = matches.length - kept.length;
      if (dropped > 0) out.push(`… [${String(dropped)} more matches in ${file} elided] …`);
    }
    return { text: out.join("\n"), kind: "search" };
  },
};
