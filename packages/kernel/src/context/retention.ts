import type { ModelMessageT } from "@keel/shared";

/** The eight §4.7.2 retention classes. Phase-1 compaction uses pinned / recent_verbatim / clearable /
 *  summarizable over the message stream; active / retrievable / promotable / expired_or_superseded
 *  attach to structured items as the engine grows (later slices / Phase 3). */
export type RetentionClass =
  | "pinned"
  | "active"
  | "recent_verbatim"
  | "summarizable"
  | "clearable"
  | "retrievable"
  | "promotable"
  | "expired_or_superseded";

/**
 * Classify a conversation message for compaction (§4.7.2). `indexFromEnd` is 0 for the last message.
 * Phase-1 mapping: a `system` message is **pinned** (system prompt / env snapshot / non-negotiable
 * constraints); the last `recentVerbatimTurns` messages are **recent_verbatim** (kept verbatim,
 * never cleared, for steering + continuity); an older `tool` result is **clearable** (its raw body
 * may be dropped — the ledger retains it, so it stays re-fetchable); older user/assistant prose is
 * **summarizable** (folded into the typed compaction summary, slice 5).
 */
export function classify(
  message: ModelMessageT,
  indexFromEnd: number,
  recentVerbatimTurns: number,
): RetentionClass {
  if (message.role === "system") return "pinned";
  if (indexFromEnd < recentVerbatimTurns) return "recent_verbatim";
  if (message.role === "tool") return "clearable";
  return "summarizable";
}
