import type { ModelMessageT } from "@keel/shared";
import { genericCompressor } from "./generic.js";
import { logCompressor } from "./log.js";
import { searchCompressor } from "./search.js";
import { isErrorLine } from "./error-keywords.js";
import type { ContentCompressor } from "./types.js";

/** Bounded heuristic: does this `bash` output read like a multi-line log/command stream worth
 *  log-compression? Inspects a capped prefix only (no full scan, no unbounded backtracking). */
function looksLikeLog(content: string): boolean {
  const head = content.slice(0, 4096);
  const lines = head.split("\n");
  if (lines.length < 10) return false;
  if (lines.some(isErrorLine)) return true;
  return lines.length >= 20;
}

/**
 * Select a deterministic compressor for a tool-result message, keyed on the producing tool's `name`
 * (the reliable signal) with a bounded content-sniff only where output is heterogeneous (`bash`):
 * `search` → search-results; long/log-ish `bash` → log; everything else (`read`, short/plain `bash`,
 * unknown) → the safe generic fallback. The LATEST `plan` ledger never reaches here — the pass skips
 * its index by construction (`pass.ts`, so the body `compact()` re-pins stays verbatim, §4.7.2); an
 * older, superseded plan snapshot may, and generic is the safe fallback for it.
 */
export function selectCompressor(message: ModelMessageT): ContentCompressor {
  switch (message.name) {
    case "search":
      return searchCompressor;
    case "bash":
      return looksLikeLog(message.content) ? logCompressor : genericCompressor;
    default:
      return genericCompressor;
  }
}
