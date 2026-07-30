import { ulid } from "@keel/shared";
import type { ContextCompressionEventT, JsonObjectT, ModelMessageT } from "@keel/shared";
import { PLAN_TOOL_NAME } from "../../tools/plan.js";
import { truncateHeadTail, truncateHeadUtf8 } from "../../tools/truncate.js";
import { classify } from "../retention.js";
import { boundedJsonStringify, messageTokens } from "../system-prompt.js";
import { isErrorLine } from "./error-keywords.js";
import { selectCompressor } from "./router.js";

const DEFAULT_HEADROOM = 16_384;
const DEFAULT_RECENT = 6;
const DEFAULT_ARG_STRING_MAX_BYTES = 4096;
const DEFAULT_ARG_OBJECT_MAX_CHARS = 16 * 1024;
const DEFAULT_ARG_OBJECT_SCAN_MAX_CHARS = 1024 * 1024;
const DEFAULT_ARG_COMPACT_MAX_DEPTH = 16;
const DEFAULT_ARG_COMPACT_MAX_NODES = 1024;
const DEFAULT_ARG_COMPACT_MAX_STRINGS = 16;
const ARGUMENT_NOTE_ID_MAX_BYTES = 128;
/** The stable opening of every compression note. Used to detect an already-compressed body
 *  (idempotence across re-compaction cycles) independently of the per-message `retrieve` ref. */
export const LEDGER_NOTE_MARKER = "[keel: output compressed";
export const ARGUMENT_NOTE_MARKER = "[keel: tool-call argument compressed";
/**
 * The note appended to a compressed tool body: honest about the loss, names the canonical session
 * ledger (the FULL output is retained there — SEC-023), and, when the source tool call's id is known,
 * cites the exact `retrieve(ref=…)` call that re-fetches the full output. In production the `retrieve`
 * tool is registered whenever compaction is on (Epic 1.6c PR-d slice 5), so the citation is honest by
 * construction; with no ref it falls back to naming the ledger.
 */
export function ledgerNote(ref?: string): string {
  const base = `\n${LEDGER_NOTE_MARKER}; full output retained in the session ledger`;
  return ref !== undefined && ref.length > 0
    ? `${base} — re-fetch with retrieve(ref="${ref}")]`
    : `${base}]`;
}

function resultHasErrorContext(output: string): boolean {
  const exit = output.match(/\[exit code:\s*(\d+)\]/i);
  return (
    output.includes("[interrupted:") ||
    (exit !== null && Number(exit[1]) !== 0) ||
    output.split("\n").some(isErrorLine)
  );
}

function isOpaqueToolCallName(name: string): boolean {
  return name.startsWith("mcp__");
}

function argumentNote(toolCallId: string, beforeChars: number): string {
  const ref = truncateHeadUtf8(toolCallId, ARGUMENT_NOTE_ID_MAX_BYTES);
  return (
    `\n${ARGUMENT_NOTE_MARKER}; full arguments retained in the session ledger; ` +
    `toolCallId="${ref}"; beforeChars=${String(beforeChars)}]`
  );
}

function compactStringArgument(value: string, toolCallId: string): string {
  const beforeBytes = Buffer.byteLength(value, "utf8");
  if (beforeBytes <= DEFAULT_ARG_STRING_MAX_BYTES) return value;
  const note = argumentNote(toolCallId, value.length);
  const bodyBudget = Math.max(0, DEFAULT_ARG_STRING_MAX_BYTES - Buffer.byteLength(note, "utf8"));
  let body = bodyBudget > 0 ? truncateHeadTail(value, bodyBudget).text : "";
  let candidate = body + note;
  if (Buffer.byteLength(candidate, "utf8") > DEFAULT_ARG_STRING_MAX_BYTES) {
    body = bodyBudget > 0 ? truncateHeadUtf8(value, bodyBudget) : "";
    candidate = body + note;
  }
  return Buffer.byteLength(candidate, "utf8") < beforeBytes ? candidate : value;
}

interface ArgumentCompactionState {
  nodes: number;
  stringsCompacted: number;
  aborted: boolean;
  readonly seen: WeakSet<object>;
}

function compactArgumentValue(
  value: unknown,
  toolCallId: string,
  state: ArgumentCompactionState,
  depth = 0,
): { readonly value: unknown; readonly changed: boolean } {
  if (state.aborted) return { value, changed: false };
  state.nodes += 1;
  if (state.nodes > DEFAULT_ARG_COMPACT_MAX_NODES || depth > DEFAULT_ARG_COMPACT_MAX_DEPTH) {
    state.aborted = true;
    return { value, changed: false };
  }
  if (typeof value === "string") {
    if (state.stringsCompacted >= DEFAULT_ARG_COMPACT_MAX_STRINGS) return { value, changed: false };
    const compacted = compactStringArgument(value, toolCallId);
    if (compacted !== value) state.stringsCompacted += 1;
    return { value: compacted, changed: compacted !== value };
  }
  if (Array.isArray(value)) {
    if (state.seen.has(value)) {
      state.aborted = true;
      return { value, changed: false };
    }
    state.seen.add(value);
    let changed = false;
    const next = value.map((item) => {
      const compacted = compactArgumentValue(item, toolCallId, state, depth + 1);
      if (compacted.changed) changed = true;
      return compacted.value;
    });
    return { value: next, changed };
  }
  if (value !== null && typeof value === "object") {
    if (state.seen.has(value)) {
      state.aborted = true;
      return { value, changed: false };
    }
    state.seen.add(value);
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const compacted = compactArgumentValue(child, toolCallId, state, depth + 1);
      if (compacted.changed) changed = true;
      next[key] = compacted.value;
    }
    return { value: next, changed };
  }
  return { value, changed: false };
}

function compactToolCallArgs(
  args: JsonObjectT,
  toolCallId: string,
): {
  readonly args: JsonObjectT;
  readonly beforeChars: number;
  readonly afterChars: number;
} | null {
  const before = boundedJsonStringify(args, {
    maxChars: DEFAULT_ARG_OBJECT_SCAN_MAX_CHARS,
    maxDepth: DEFAULT_ARG_COMPACT_MAX_DEPTH,
    maxNodes: DEFAULT_ARG_COMPACT_MAX_NODES,
  });
  if (before === null) return null;
  const state: ArgumentCompactionState = {
    nodes: 0,
    stringsCompacted: 0,
    aborted: false,
    seen: new WeakSet<object>(),
  };
  const compacted = compactArgumentValue(args, toolCallId, state);
  if (!compacted.changed || state.aborted) return null;
  const nextArgs = compacted.value as JsonObjectT;
  const after = boundedJsonStringify(nextArgs, {
    maxChars: DEFAULT_ARG_OBJECT_MAX_CHARS,
    maxDepth: DEFAULT_ARG_COMPACT_MAX_DEPTH,
    maxNodes: DEFAULT_ARG_COMPACT_MAX_NODES,
  });
  if (after === null) return null;
  if (after.length >= before.length) return null;
  return { args: nextArgs, beforeChars: before.length, afterChars: after.length };
}

function compressAssistantToolCallArgs(
  message: ModelMessageT,
  messageIndex: number,
  toolCallCounts: ReadonlyMap<string, number>,
  pairedResults: ReadonlyMap<string, { readonly content: string; readonly index: number }>,
): { readonly message: ModelMessageT; readonly items: ContextCompressionEventT["items"] } | null {
  if (
    message.role !== "assistant" ||
    message.toolCalls === undefined ||
    message.toolCalls.length === 0
  ) {
    return null;
  }
  const items: ContextCompressionEventT["items"] = [];
  const toolCalls = message.toolCalls.map((call) => {
    const result = pairedResults.get(call.id);
    if (
      isOpaqueToolCallName(call.name) ||
      toolCallCounts.get(call.id) !== 1 ||
      result === undefined ||
      result.index <= messageIndex ||
      resultHasErrorContext(result.content)
    ) {
      return call;
    }
    const compacted = compactToolCallArgs(call.args, call.id);
    if (compacted === null) return call;
    items.push({
      kind: "generic",
      name: `tool-call-args:${call.name}`,
      beforeChars: compacted.beforeChars,
      afterChars: compacted.afterChars,
    });
    return { ...call, args: compacted.args };
  });
  if (items.length === 0) return null;
  const candidate: ModelMessageT = { ...message, toolCalls };
  if (messageTokens(candidate) >= messageTokens(message)) return null;
  return { message: candidate, items };
}

export interface DeterministicPassInput {
  readonly messages: readonly ModelMessageT[];
  /** The model's context window in tokens. */
  readonly budgetTokens: number;
  /** Reserved output headroom; target = budgetTokens − headroomTokens. Default ~16K. */
  readonly headroomTokens?: number;
  /** Turns kept verbatim at the tail (§4.7.2). Default 6. */
  readonly recentVerbatimTurns?: number;
  /** Deterministic keyword hint for relevance-lite keep decisions (search, PR-b2). */
  readonly taskTokens?: readonly string[];
  readonly trigger: "token_soft" | "token_hard";
}

export interface DeterministicPassResult {
  readonly messages: ModelMessageT[];
  /** null when nothing was usefully compressed (the never-enlarge guard skipped everything). */
  readonly event: ContextCompressionEventT | null;
}

/**
 * Compress aged `clearable` tool-result bodies (older than the recent-verbatim tail, never `pinned`)
 * oldest-first until the token estimate is back under `budgetTokens − headroomTokens`. Each body is
 * routed to a content-aware compressor; the swap is taken ONLY if it actually shrinks the message (the
 * never-enlarge guard — a compressor's elision marker could grow a tiny body). Pure: operates on a
 * copy and never touches the ledger (the full output stays canonical there; SEC-023). Pairing-safe:
 * only the `content` of a `tool` message is rewritten — role, `toolCallId`, `name`, count, and order
 * are preserved, so assistant `tool_use` ↔ `tool_result` linkage is intact.
 *
 * This is the MECHANISM. WHETHER to run it (the cache-aware / runway trigger) is the runner's policy
 * (PR-d), informed by `cache-gain.ts`.
 */
export function runDeterministicPass(input: DeterministicPassInput): DeterministicPassResult {
  const headroom = input.headroomTokens ?? DEFAULT_HEADROOM;
  const recentN = input.recentVerbatimTurns ?? DEFAULT_RECENT;
  const target = Math.max(0, input.budgetTokens - headroom);
  const total = input.messages.length;
  const classes = input.messages.map((m, i) => classify(m, total - 1 - i, recentN));
  // Preserve object identity for untouched messages. The live loop uses identity as the local
  // provenance carrier for provider-compatible user-role messages; only the assistant/tool message
  // actually rewritten by this pass needs a replacement object.
  const out = [...input.messages];
  const toolCallCounts = new Map<string, number>();
  const resultOccurrences = new Map<string, { content: string; index: number }[]>();
  for (let i = 0; i < input.messages.length; i++) {
    const message = input.messages[i]!;
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        toolCallCounts.set(call.id, (toolCallCounts.get(call.id) ?? 0) + 1);
      }
    }
    if (message.role === "tool" && message.toolCallId !== undefined) {
      const occurrences = resultOccurrences.get(message.toolCallId) ?? [];
      occurrences.push({ content: message.content, index: i });
      resultOccurrences.set(message.toolCallId, occurrences);
    }
  }
  const pairedResults = new Map<string, { content: string; index: number }>();
  for (const [id, occurrences] of resultOccurrences) {
    if (occurrences.length === 1 && toolCallCounts.get(id) === 1) {
      pairedResults.set(id, occurrences[0]!);
    }
  }

  // The LATEST `plan` tool result is the in-session task ledger that `compact()` re-pins verbatim
  // (§4.7.2 / §8.6) — "the most durable context item, never summarized away." The deterministic pass
  // must therefore NEVER compress it, or `compact()` would re-pin an already-truncated body (the spec
  // promise would silently launder into a lossy ledger). Latest-only: older, superseded plan snapshots
  // (full-list replace) MAY still compress — they are not the re-pinned ledger and bloat a long session.
  let latestPlanIdx = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role === "tool" && m.name === PLAN_TOOL_NAME) {
      latestPlanIdx = i;
      break;
    }
  }

  let used = out.reduce((sum, m) => sum + messageTokens(m), 0);
  const tokensBefore = used;
  const items: ContextCompressionEventT["items"] = [];
  let from = -1;
  let to = -1;

  for (let i = 0; i < out.length && used > target; i++) {
    if (classes[i] !== "clearable") continue; // only aged tool bodies; pinned/recent untouched
    if (i === latestPlanIdx) continue; // the latest task ledger is preserved verbatim (§4.7.2; re-pinned by compact())
    const msg = out[i]!;
    const original = msg.content;
    // Idempotence across re-compaction cycles (PR-d loops the pass): a body already compressed on a
    // prior pass carries the LEDGER_NOTE_MARKER — skip it so we never double-stack the note or re-elide
    // with a false (smaller) line count. (Substring, not endsWith: the note now carries a per-message
    // `retrieve` ref, so the tail varies; the marker is the stable, keel-namespaced detector.)
    //
    // KNOWN LIMIT (documented, deliberately not over-fixed): the detector is a substring of the body,
    // so a HOSTILE tool output that itself contains the marker text evades compression of THAT body.
    // Blast radius is RUNWAY-VALUE ONLY — the body stays uncompressed but fully recorded in the ledger
    // (SEC-023 intact), trust is not laundered, and the model is the sole consumer; the model fold
    // remains a backstop. It is NOT a confidentiality/integrity breach. A structural fix (key
    // idempotence on compressed-message identity rather than a content substring) is a tracked
    // follow-up; the substring detector is retained for now as the simpler, audit-legible mechanism.
    if (original.includes(LEDGER_NOTE_MARKER)) continue;
    const { text, kind } = selectCompressor(msg).compress(original, {
      ...(input.taskTokens !== undefined ? { taskTokens: input.taskTokens } : {}),
    });
    // Cite the source tool call's id so the model can `retrieve(ref=…)` the full output (slice 5).
    const candidate = text + ledgerNote(msg.toolCallId);
    const beforeTok = messageTokens({ content: original });
    const afterTok = messageTokens({ content: candidate });
    if (afterTok >= beforeTok) continue; // never-enlarge guard: skip a no-op / counterproductive swap
    out[i] = { ...msg, content: candidate };
    used -= beforeTok - afterTok;
    items.push({
      kind,
      name: msg.name ?? "unknown",
      beforeChars: original.length,
      afterChars: candidate.length,
    });
    if (from === -1 || i < from) from = i;
    if (i > to) to = i;
  }

  for (let i = 0; i < out.length && used > target; i++) {
    if (classes[i] !== "summarizable") continue; // only aged assistant calls; pinned/recent untouched
    const msg = out[i]!;
    const compressed = compressAssistantToolCallArgs(msg, i, toolCallCounts, pairedResults);
    if (compressed === null) continue;
    const beforeTok = messageTokens(msg);
    const afterTok = messageTokens(compressed.message);
    if (afterTok >= beforeTok) continue;
    out[i] = compressed.message;
    used -= beforeTok - afterTok;
    items.push(...compressed.items);
    if (from === -1 || i < from) from = i;
    if (i > to) to = i;
  }

  if (items.length === 0) return { messages: out, event: null };

  const event: ContextCompressionEventT = {
    type: "context_compression",
    v: 1,
    compressionId: `ccx_${ulid()}`,
    ts: new Date().toISOString(),
    // First/last COMPRESSED message index — may be non-contiguous (guard-skipped clearable items can
    // sit between). The authoritative per-message record is `items[]`; this differs from
    // CompactionEvent's contiguous folded range. (QC note.)
    inputRange: { from, to },
    items,
    tokensBefore,
    tokensAfter: used,
    trigger: input.trigger,
    trust: "unknown",
  };
  return { messages: out, event };
}
