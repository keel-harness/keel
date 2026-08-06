import { PROCESS_RESULT_MARKER, type GovernedProcessEnvelope } from "../../tool-command.js";
import { truncateHeadTail } from "../../tools/truncate.js";
import { genericCompressor } from "./generic.js";
import type { CompressOpts, CompressResult, ContentCompressor } from "./types.js";

const PREAMBLE_BYTES = 768;
const STREAM_BYTES = 1_536;
const COMPACTED_NOTICE = "[keel: context-only compacted process result; not completion evidence]";

function parsedEnvelope(content: string):
  | {
      readonly preamble: string;
      readonly value: Record<string, unknown> & GovernedProcessEnvelope;
    }
  | undefined {
  const marker = `${PROCESS_RESULT_MARKER}\n`;
  const markerIndex = content.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(markerIndex + marker.length).trim());
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  if (
    !(value["exitCode"] === null || Number.isSafeInteger(value["exitCode"])) ||
    !(value["signal"] === null || typeof value["signal"] === "string") ||
    typeof value["stdout"] !== "string" ||
    typeof value["stderr"] !== "string"
  ) {
    return undefined;
  }
  return {
    preamble: content.slice(0, markerIndex).trimEnd(),
    value: value as Record<string, unknown> & GovernedProcessEnvelope,
  };
}

/**
 * Context-only projection for an aged governed process result. It retains outcome fields and gives
 * stdout/stderr independent head/tail budgets, but deliberately adds a non-authoritative notice so a
 * compressed clean exit can never be reclassified as fresh completion evidence. The canonical bytes
 * remain in the session ledger and the pass appends an exact retrieve reference.
 */
export const processResultCompressor: ContentCompressor = {
  kind: "generic",
  compress(content: string, opts: CompressOpts): CompressResult {
    const parsed = parsedEnvelope(content);
    if (parsed === undefined) return genericCompressor.compress(content, opts);
    const preamble = truncateHeadTail(parsed.preamble, PREAMBLE_BYTES).text;
    const value = {
      ...parsed.value,
      stdout: truncateHeadTail(parsed.value.stdout, STREAM_BYTES).text,
      stderr: truncateHeadTail(parsed.value.stderr, STREAM_BYTES).text,
      compacted: true,
    };
    return {
      kind: "generic",
      text: [preamble, COMPACTED_NOTICE, "", PROCESS_RESULT_MARKER, JSON.stringify(value)]
        .filter((part, index) => part.length > 0 || index === 2)
        .join("\n"),
    };
  },
};
