import type { ModelMessageT } from "@keel/shared";
import { classify } from "./retention.js";
import { messageTokens } from "./system-prompt.js";

export interface AssembleInput {
  readonly messages: readonly ModelMessageT[];
  /** The model's context window in tokens. */
  readonly budgetTokens: number;
  /** Reserved output headroom (§4.7.3) — assembly targets `budget − headroom`. Default ~16K. */
  readonly headroomTokens?: number;
  /** Turns kept verbatim at the tail (§4.7.2 / OQ-12). Default 6. */
  readonly recentVerbatimTurns?: number;
}

const DEFAULT_HEADROOM = 16_384;
const DEFAULT_RECENT = 6;

/** Replace a tool result's raw body with a compact note — keeping the message (so the model still
 *  knows the call occurred) and pointing at the ledger (the full output is retained there). NOT
 *  re-fetchable in-session yet — on-demand retrieval is Epic 3.5; the note must not promise a fetch
 *  tool the model does not have. */
function clearToolBody(m: ModelMessageT): ModelMessageT {
  return {
    ...m,
    content: `[output cleared — ${String(m.content.length)} chars; full output retained in the session ledger]`,
  };
}

/**
 * Assemble the active model context within a token budget (§4.7.4 step 7), reserving output
 * headroom. When over budget, clear the **oldest clearable tool-result bodies first** (§4.7.4 step 3)
 * — never a pinned (system) message or a recent_verbatim turn — keeping each cleared message's
 * structure so the model still knows the call occurred (the full output is in the ledger). Best-effort:
 * if nothing more is clearable it returns the smallest it could reach, which MAY still exceed the
 * target (a single oversized pinned/recent message can't be cleared) — the caller is responsible for
 * that residual.
 *
 * Relationship to `compact()`: this **clears** tool bodies in place (lossless-ish, the body stays in
 * the ledger); `compact()` **folds** the older middle into a typed summary (a heavier reduction). They
 * are independent strategies over the same retention model; the live runner uses `compact()`. Pure —
 * operates on the message list, not the live loop.
 */
export function assembleActiveContext(input: AssembleInput): ModelMessageT[] {
  const headroom = input.headroomTokens ?? DEFAULT_HEADROOM;
  const recentN = input.recentVerbatimTurns ?? DEFAULT_RECENT;
  const target = Math.max(0, input.budgetTokens - headroom);
  const total = input.messages.length;
  const classes = input.messages.map((msg, i) => classify(msg, total - 1 - i, recentN));
  const out = input.messages.map((msg) => ({ ...msg }));

  let used = out.reduce((sum, msg) => sum + messageTokens(msg), 0);
  for (let i = 0; i < out.length && used > target; i++) {
    if (classes[i] !== "clearable") continue; // only older tool bodies; pinned/recent untouched
    const before = messageTokens(out[i]!);
    out[i] = clearToolBody(out[i]!);
    used -= before - messageTokens(out[i]!);
  }
  return out;
}
