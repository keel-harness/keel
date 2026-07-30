import { z } from "zod";
import type { JsonObjectT, SessionEventT } from "@keel/shared";
import { parseArgs } from "./args.js";
import { staticCapability, type CoreTool } from "./registry.js";
import { truncateHeadTail } from "./truncate.js";

/** The tool name — the just-in-time expansion path for content the compression tier shrank (Epic 3.5). */
export const RETRIEVE_TOOL_NAME = "retrieve";

const DEFAULT_MAX_LINES = 200;
const DEFAULT_MAX_BYTES = 32 * 1024;
const DIAGNOSTIC_LINE_RE =
  /\b(error|failed|failure|traceback|exception|fatal|segmentation fault|assertionerror)\b/i;
const MAX_DIAGNOSTIC_SAMPLE_LINES = 40;
const MAX_DIAGNOSTIC_SAMPLE_BYTES = 8 * 1024;

/**
 * The result of resolving an artifact ref against the session ledger. The ledger is the CANONICAL,
 * tamper-evident record (SEC-023: compress the view, never the record), so retrieval reads the full
 * output from it — never from a second store. `isError` rides along; there is intentionally NO trust
 * field: tool output is untrusted-derived and Phase-1 fail-closed (`unknown`), and retrieval NEVER
 * upgrades it (real taint tracking is Phase 3 / ADR-0010).
 */
export interface ArtifactResolution {
  readonly toolCallId: string;
  readonly name: string;
  readonly output: string;
  readonly isError: boolean;
}

/** Find the full tool output for a ref (a `tool_result`'s `toolCallId`) in the ledger. Pure; last-wins
 *  if a ref somehow recurs; null if the ref is not a recorded tool result. */
export function resolveArtifact(
  events: readonly SessionEventT[],
  ref: string,
): ArtifactResolution | null {
  let found: ArtifactResolution | null = null;
  for (const ev of events) {
    if (ev.type === "tool_result" && ev.toolCallId === ref) {
      found = {
        toolCallId: ev.toolCallId,
        name: ev.name,
        output: ev.output,
        isError: ev.isError ?? false,
      };
    }
  }
  return found;
}

const RetrieveArgs = z
  .object({
    ref: z.string().min(1),
    grep: z.string().optional(),
    maxLines: z.number().int().positive().optional(),
  })
  .strict();

/** Bound the returned view so retrieval never re-bloats the context we just compressed: optional
 *  substring `grep` (case-insensitive) then a head/tail line cap with an honest "omitted" marker. */
function sliceForModel(
  output: string,
  opts: { readonly grep?: string | undefined; readonly maxLines?: number | undefined },
): {
  text: string;
  total: number;
  matched: number;
  capped: boolean;
  byteCapped: boolean;
  diagnosticSampled: boolean;
} {
  const lines = output.split("\n");
  const total = lines.length;
  const grep = opts.grep;
  const selected =
    grep !== undefined && grep.length > 0
      ? lines.filter((l) => l.toLowerCase().includes(grep.toLowerCase()))
      : lines;
  const matched = selected.length;
  const cap = opts.maxLines ?? DEFAULT_MAX_LINES;
  const lineCapped = matched > cap;
  const lineBounded = lineCapped
    ? [
        ...selected.slice(0, Math.ceil(cap / 2)),
        `… [${String(matched - cap)} lines omitted — narrow with grep=<substring> or raise maxLines] …`,
        ...selected.slice(matched - (cap - Math.ceil(cap / 2))),
      ].join("\n")
    : selected.join("\n");
  const byteBounded = truncateHeadTail(lineBounded, DEFAULT_MAX_BYTES);
  const diagnosticSample = byteBounded.truncated ? diagnosticSampleFor(selected) : undefined;
  const diagnosticSampled = diagnosticSample !== undefined;
  const text =
    diagnosticSample === undefined
      ? byteBounded.text
      : truncateHeadTail(
          `${byteBounded.text}\n… [diagnostic sample preserved from byte-capped output] …\n${diagnosticSample}`,
          DEFAULT_MAX_BYTES,
        ).text;
  return {
    text,
    total,
    matched,
    capped: lineCapped || byteBounded.truncated,
    byteCapped: byteBounded.truncated,
    diagnosticSampled,
  };
}

function diagnosticSampleFor(lines: readonly string[]): string | undefined {
  const sampled: string[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < lines.length && sampled.length < MAX_DIAGNOSTIC_SAMPLE_LINES; i++) {
    if (!DIAGNOSTIC_LINE_RE.test(lines[i] ?? "")) continue;
    for (
      let j = Math.max(0, i - 1);
      j <= Math.min(lines.length - 1, i + 2) && sampled.length < MAX_DIAGNOSTIC_SAMPLE_LINES;
      j++
    ) {
      if (seen.has(j)) continue;
      seen.add(j);
      sampled.push(`${String(j + 1)}: ${lines[j] ?? ""}`);
    }
  }
  if (sampled.length === 0) return undefined;
  return truncateHeadTail(sampled.join("\n"), MAX_DIAGNOSTIC_SAMPLE_BYTES).text;
}

const SPEC = {
  name: RETRIEVE_TOOL_NAME,
  description:
    "Re-fetch the full output of an EARLIER tool call that was compressed or cleared from your " +
    "context. Pass `ref` = the toolCallId shown in the compression note. Optionally narrow with " +
    "`grep` (substring) or `maxLines` to avoid re-bloating your context. Returns the output from the " +
    "session ledger, labelled as UNTRUSTED tool output (it is not verified by retrieving it).",
  parameters: {
    type: "object",
    properties: {
      ref: {
        type: "string",
        minLength: 1,
        description: "The toolCallId of the earlier tool result.",
      },
      grep: { type: "string", description: "Optional: keep only lines containing this substring." },
      maxLines: {
        type: "integer",
        minimum: 1,
        description: "Optional: cap the returned lines (default 200) to avoid re-bloating context.",
      },
    },
    required: ["ref"],
    additionalProperties: false,
  },
} as const;

/**
 * The just-in-time retrieve tool (Epic 3.5). Resolves a ref against the CURRENT session ledger (via the
 * injected `readEvents` thunk) and returns a bounded, provenance-tagged view of the full output. It is
 * non-mutating. Provenance is fail-closed by construction: the header always marks the
 * content UNTRUSTED / `trust=unknown` and retrieval has no path to upgrade trust (no laundering, SEC-023;
 * real taint enforcement is Phase 3 / ADR-0010). Honest when the ref is unknown rather than fabricating.
 */
export function createRetrieveTool(readEvents: () => readonly SessionEventT[]): CoreTool {
  const handler = (raw: JsonObjectT): string => {
    const args = parseArgs(RETRIEVE_TOOL_NAME, RetrieveArgs, raw);
    const res = resolveArtifact(readEvents(), args.ref);
    if (res === null) {
      return `[keel retrieve: no artifact for ref "${args.ref}" — it is not a recorded tool result in this session.]`;
    }
    const slice = sliceForModel(res.output, args);
    // A grep that matched nothing would otherwise return a blank body — give the model an actionable
    // next move instead (broaden the substring or drop grep), with the total line count it would see.
    if (args.grep !== undefined && slice.matched === 0) {
      return (
        `[keel retrieve — toolCallId=${res.toolCallId}, tool=${res.name}; UNTRUSTED tool output, trust=unknown] ` +
        `no lines matched grep="${args.grep}" (${String(slice.total)} line(s) total) — broaden the substring or drop grep to see them all.`
      );
    }
    const scopeLines = slice.capped
      ? `showing ${String(Math.min(args.maxLines ?? DEFAULT_MAX_LINES, slice.matched))} of ${String(slice.matched)}${args.grep !== undefined ? " matched" : ""} lines (${String(slice.total)} total)`
      : `${String(slice.matched)}${args.grep !== undefined ? ` of ${String(slice.total)} matched` : ""} lines`;
    const scope = slice.byteCapped
      ? `${scopeLines}; byte-capped${slice.diagnosticSampled ? "; diagnostic-sampled" : ""}`
      : scopeLines;
    const header =
      `[keel retrieve — toolCallId=${res.toolCallId}, tool=${res.name}${res.isError ? ", isError=true" : ""}; ` +
      `UNTRUSTED tool output, trust=unknown (fail-closed — retrieval does not verify or upgrade trust); ${scope}]`;
    return `${header}\n${slice.text}`;
  };
  return { spec: SPEC, handler, staticCapability: staticCapability(SPEC.name, ["fs_read"]) };
}
