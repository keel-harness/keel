import { createHash } from "node:crypto";
import { TaskState, ulid } from "@keel/shared";
import type { CompactionEventT, ModelMessageT, SessionEventT, TaskStateT } from "@keel/shared";
import { PLAN_TOOL_NAME } from "../tools/plan.js";
import { deriveTaskFacts } from "./derive.js";
import type { DerivedFacts } from "./derive.js";
import { renderCompactionSummary } from "./summary.js";
import { messageTokens } from "./system-prompt.js";
import { validateTaskState } from "./validate.js";

/** The §4.7.4 reasons a compaction can fire (mirrors the `CompactionEvent.trigger` enum). */
export type CompactionTrigger = CompactionEventT["trigger"];

/** Input handed to the compactor-model seam (OQ-10). `facts` is the ledger-DERIVED factual scaffold
 *  (the un-inventable ground truth, §4.7.6) — the model writes prose over it, and any invented file/
 *  test it adds is dropped by validation before the result becomes context. */
export interface SummarizeInput {
  readonly facts: DerivedFacts;
  /** The full pre-compaction message history being folded. */
  readonly messages: readonly ModelMessageT[];
  /** The session ledger (the canonical source of truth the prose must stay faithful to). */
  readonly events: readonly SessionEventT[];
  /** Abort signal for a long summarize call (ER-021) — a real provider summarizer should cancel on it. */
  readonly signal?: AbortSignal;
}

/** The compactor model: produces a claimed `TaskState` (prose over the derived facts). Sync or async
 *  so a deterministic test summarizer and a real provider both fit (OQ-10 tunable, recorded per event). */
export type Summarize = (input: SummarizeInput) => Promise<TaskStateT> | TaskStateT;

export interface CompactInput {
  readonly messages: readonly ModelMessageT[];
  readonly events: readonly SessionEventT[];
  /** The model's context window in tokens (drives the swap target alongside the trigger). */
  readonly budgetTokens: number;
  readonly trigger: CompactionTrigger;
  readonly summarize: Summarize;
  /** Turns kept verbatim at the tail (§4.7.2 / OQ-12). Default 6. */
  readonly recentVerbatimTurns?: number;
  /** The compactor model/version, recorded on the event (OQ-10 tunable). */
  readonly compactorModel?: string;
  /** Abort signal (ER-021) — if aborted during summarize, the swap is skipped (fail-soft, no swap). */
  readonly signal?: AbortSignal;
}

export interface CompactResult {
  /** The new active context to drive from: pinned system messages + the typed summary + recent tail. */
  readonly messages: ModelMessageT[];
  /** The auditable record to append to the ledger. */
  readonly event: CompactionEventT;
  /** The rendered §4.7.5 summary (the system message injected into `messages`). */
  readonly summary: string;
  /** The validated/repaired task state behind the summary. */
  readonly taskState: TaskStateT;
}

const DEFAULT_RECENT = 6;

/** Prefix for a re-pinned steering instruction (a folded mid-run constraint preserved as a `system`
 *  message). Constant so the swap probe can match it by EXACT equality (`PREFIX + content`). */
const STEERING_PRESERVE_PREFIX =
  "Standing user instruction (mid-run steering, preserved across compaction): ";

/** Estimate the token footprint of a message list (the trigger + the event's before/after deltas).
 *  Uses the shared `messageTokens` so the fold path and the clear path (`assemble.ts`) never drift. */
export const estimateMessagesTokens = (messages: readonly ModelMessageT[]): number =>
  messages.reduce((sum, m) => sum + messageTokens(m), 0);

/** A valid, empty TaskState — the placeholder behind a failed/no-op compaction result. */
const EMPTY_TASK_STATE: TaskStateT = {
  taskGoal: "",
  currentStatus: "",
  currentPhase: "intake",
  constraints: [],
  plan: [],
  completedSteps: [],
  nextSteps: [],
  filesRead: [],
  filesModified: [],
  decisions: [],
  failedAttempts: [],
  testState: [],
  currentErrors: [],
  blockers: [],
  artifactRefs: [],
  policyNotes: [],
  provenanceNotes: [],
  memoryCandidates: [],
  unresolvedQuestions: [],
};

/**
 * ER-021 fail-soft / progress-guard outcome: keep the existing context UNCHANGED (no swap) and record
 * an auditable `validation:"failed"` compaction, so a thrown/malformed summary, an abort mid-summarize,
 * or a non-shrinking fold is honest in the ledger and never corrupts or enlarges the model's context.
 */
function failedCompaction(input: CompactInput): CompactResult {
  const tokens = estimateMessagesTokens(input.messages);
  const event: CompactionEventT = {
    type: "compaction",
    v: 1,
    compactionId: `cmp_${ulid()}`,
    ts: new Date().toISOString(),
    inputRange: { from: 0, to: 0 },
    summaryHash: "",
    artifactRefs: [],
    tokensBefore: tokens,
    tokensAfter: tokens,
    trigger: input.trigger,
    ...(input.compactorModel !== undefined ? { compactorModel: input.compactorModel } : {}),
    validation: "failed",
    probesPassed: false,
    trust: "unknown",
  };
  return {
    // A failed fold is a fail-soft no-op. Keep message identities as well as values so controller vs
    // human user-role provenance survives the live compactor boundary.
    messages: [...input.messages],
    event,
    summary: "",
    taskState: EMPTY_TASK_STATE,
  };
}

/**
 * Fold a session's accumulated context into a curated working set (§4.7.4) — the swap behind a
 * compaction. The factual scaffold is DERIVED from the ledger (`deriveTaskFacts`), the injected
 * compactor model writes prose over it, then `validateTaskState` drops anything the model invented
 * (no fake file edits / test passes can launder into task state). The resulting active context keeps
 * the pinned system messages and a recent-verbatim tail untouched and replaces the older middle with
 * one typed-summary system message; the tail is trimmed of any leading orphan tool result (its
 * assistant turn was folded) so the swapped history stays valid for the next model turn.
 *
 * Pure with respect to the ledger: it reads `events` but never mutates them — the full pre-compaction
 * history (and the record that each tool call occurred) stays the source of truth; the caller appends
 * the returned `CompactionEvent`. Trust is recorded `unknown` (Phase-1 fail-closed; §4.7.8 max-taint
 * is computed in Phase 3 / ADR-0010, where taint data exists).
 */
export async function compact(input: CompactInput): Promise<CompactResult> {
  const recentN = input.recentVerbatimTurns ?? DEFAULT_RECENT;
  const facts = deriveTaskFacts(input.events);

  // 1) the model writes prose over the derived scaffold — FAIL-SOFT (ER-021): a thrown or malformed
  // summarizer return must NEVER corrupt context; keep the existing context and record a failed
  // compaction (§4.7.6 "keep existing context, mark failed").
  let claimed: TaskStateT;
  try {
    const raw = await input.summarize({
      facts,
      messages: input.messages,
      events: input.events,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    claimed = TaskState.parse(raw); // shape guard — a malformed return falls into the catch
  } catch {
    return failedCompaction(input);
  }
  // Abort honoring (ER-021): if the run was aborted during a (possibly long) summarize, do not swap.
  if (input.signal?.aborted === true) return failedCompaction(input);

  // 2) validate against the ledger (drop inventions).
  const validation = validateTaskState(claimed, input.events);
  const taskState = validation.repaired;
  const summary = renderCompactionSummary(taskState);

  // The swap (§4.7.4 step 7): pinned (system) messages + the typed summary + a recent-verbatim tail.
  const pinned = input.messages.filter((m) => m.role === "system");
  const rest = input.messages.filter((m) => m.role !== "system");
  let tail = rest.slice(Math.max(0, rest.length - recentN));
  // A leading tool message would be an orphan (its assistant call is in the folded middle) — drop it.
  while (tail.length > 0 && tail[0]!.role === "tool") tail = tail.slice(1);

  // The in-session task ledger (§4.9.7 / §8.6) is the MOST durable context item — never summarized
  // away. Preserve the latest `plan` tool result verbatim as a pinned message, unless it already
  // survives in the recent tail (avoid a duplicate). Injected as `system` so it carries no dangling
  // tool linkage after its assistant turn is folded.
  const latestLedger = [...input.messages]
    .reverse()
    .find((m) => m.role === "tool" && m.name === PLAN_TOOL_NAME);
  const ledgerMessages: ModelMessageT[] =
    latestLedger !== undefined && !tail.includes(latestLedger)
      ? [{ role: "system", content: latestLedger.content }]
      : [];

  // A user's mid-run steering instruction (§4.10) is a non-negotiable constraint — never summarized
  // away. From the ledger (the source of truth, not a guess), collect every (non-empty) queued/urgent
  // steering instruction and re-pin verbatim any that the fold would drop. Presence is checked by
  // EXACT message equality (the applied steering rides an exact `user` message; a re-pin rides the
  // labeled `system` message below) — NOT a substring scan, so a coincidental substring in unrelated
  // prose can neither suppress a needed re-pin nor let the swap probe over-report preservation.
  const steeringInstructions = [
    ...new Set(
      input.events.flatMap((e) =>
        e.type === "steering" &&
        (e.class === "queued" || e.class === "urgent") &&
        e.content.length > 0
          ? [e.content]
          : [],
      ),
    ),
  ];
  const preserved = (c: string, msgs: readonly ModelMessageT[]): boolean =>
    msgs.some((m) => m.content === c || m.content === STEERING_PRESERVE_PREFIX + c);
  const tailPlusPinned = [...pinned, ...ledgerMessages, ...tail];
  const steeringMessages: ModelMessageT[] = steeringInstructions
    .filter((c) => !preserved(c, tailPlusPinned))
    .map((c) => ({ role: "system", content: STEERING_PRESERVE_PREFIX + c }));

  const summaryMessage: ModelMessageT = { role: "system", content: summary };
  const messages: ModelMessageT[] = [
    ...pinned,
    ...ledgerMessages,
    ...steeringMessages,
    summaryMessage,
    ...tail,
  ];

  // Progress guard (ER-021): never swap to a context that isn't strictly smaller — a no-op or larger
  // swap would only cost tokens and bust the prefix cache for nothing. Keep the existing context.
  const tokensBefore = estimateMessagesTokens(input.messages);
  const tokensAfter = estimateMessagesTokens(messages);
  if (tokensAfter >= tokensBefore) return failedCompaction(input);

  // The swap-safety probes (§4.7.6): (1) the state we install must be invention-free — after a repair
  // this re-check is invention-free by construction, and it catches a repair regression; (2) every
  // user steering instruction must survive into the compacted context by EXACT match (constraint-
  // preservation, §4.10 — a dropped user constraint flips this false rather than silently shipping a
  // lossy swap; an exact check means the probe cannot be fooled by a coincidental substring).
  const probesPassed =
    validateTaskState(taskState, input.events).ok &&
    steeringInstructions.every((c) => preserved(c, messages));

  const event: CompactionEventT = {
    type: "compaction",
    v: 1,
    compactionId: `cmp_${ulid()}`,
    ts: new Date().toISOString(),
    inputRange: { from: pinned.length, to: pinned.length + (rest.length - tail.length) },
    summaryHash: createHash("sha256").update(summary).digest("hex"),
    artifactRefs: taskState.artifactRefs.map((a) => a.artifactId),
    tokensBefore,
    tokensAfter,
    trigger: input.trigger,
    ...(input.compactorModel !== undefined ? { compactorModel: input.compactorModel } : {}),
    validation: validation.ok ? "passed" : "repaired",
    probesPassed,
    trust: "unknown",
  };

  return { messages, event, summary, taskState };
}
