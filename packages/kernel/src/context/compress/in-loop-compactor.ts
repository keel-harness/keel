import {
  ulid,
  type ContextCompressionEventT,
  type ModelMessageT,
  type SessionEventT,
} from "@keel/shared";
import type { AgentCompactor } from "../../loop.js";
import { compact, estimateMessagesTokens } from "../compact.js";
import type { Summarize } from "../compact.js";
import { isHarnessBudgetNotice, type ContextPressure } from "../pressure.js";
import { messageTokens } from "../system-prompt.js";
import { truncateHeadTail, truncateHeadUtf8 } from "../../tools/truncate.js";
import { PLAN_TOOL_NAME } from "../../tools/plan.js";
import { cacheRewriteNetGainTokens } from "./cache-gain.js";
import { ledgerNote, runDeterministicPass } from "./pass.js";
import { selectCompressor } from "./router.js";

/** The minimal ledger sink the compactor needs (a structural subset of `SessionStore`) — so it can be
 *  unit-tested with a fake and is decoupled from the file-backed store. */
export interface CompactorStore {
  append(event: SessionEventT): void;
}

/**
 * Construction-time config for the in-loop compactor's decision brain (Epic 1.6c PR-d slice 3). The
 * thresholds are deliberately tunable + documented as "tune vs the pre-registered ablation" —
 * measure-don't-assume; this module forecasts, the ablation validates.
 */
export interface InLoopCompactorDeps {
  /** The ledger sink: compression/compaction audit events are appended here (SEC-023 — the FULL output
   *  stays in the ledger; only the model's VIEW is compressed). */
  readonly store: CompactorStore;
  /** Resolve the session ledger for the model fold's `deriveTaskFacts`/`validateTaskState`. A thunk so
   *  the runner can read the live ledger lazily (only when a fold is actually escalated to). */
  readonly readEvents: () => readonly SessionEventT[];
  /** The model **context window** in tokens — the ACTION target for the deterministic pass + the fold
   *  (a single request must fit). Distinct from `maxGrossTokens`. */
  readonly budgetTokens: number;
  /** The cumulative **gross** runway cap (`input + output`, ADR-0044) — the PRIMARY trigger. Shrinking
   *  the per-turn view slows gross accumulation → more turns before the cap kills the task (ER-038).
   *  Pass `Infinity` to drive compaction off context-window pressure alone (no runway cap). */
  readonly maxGrossTokens: number;
  /** The §4.7 compactor-model seam (OQ-10) for the lossy fold escalation. */
  readonly summarize: Summarize;
  /** Provider cache-read billing weight in `[0,1]` (the capability table's `cacheReadWeight`). Default
   *  **1.0** (cached counts at full price ⇒ no cache penalty to a rewrite ⇒ the net-gain guard always
   *  accepts a shrinking pass — the conservative, caching-agnostic behavior). */
  readonly cacheReadWeight?: number;
  /** Trigger fraction of each cap (runway + window). Default 0.7 (§4.7.3 soft). */
  readonly softFraction?: number;
  /** Hard-pressure fraction. At/above it the cache guard is overridden (runway trumps a marginal
   *  cache shave) and the fold may escalate on runway alone. Default 0.85 (§4.7.3 hard). */
  readonly hardFraction?: number;
  /** Amortization horizon (remaining cached reads of this prefix) for the cache net-gain forecast. A
   *  FIXED placeholder — an honest constant beats an invented per-turn estimate until the ablation
   *  measures it (measure-don't-assume). Default 10. */
  readonly expectedRemainingReads?: number;
  /** Re-compaction bound: do not fold again until the post-pass context has grown by this many tokens
   *  beyond the previous fold's output — so a fail-soft fold isn't re-attempted every turn and a
   *  steering re-drive can't re-fold each cycle (amortize, don't thrash). Default = `headroomTokens`. */
  readonly minRefoldGrowthTokens?: number;
  /** Reserved output headroom; the pass/fold target is `budgetTokens − headroomTokens`. Default 16384
   *  (matches the deterministic pass). */
  readonly headroomTokens?: number;
  /** Turns kept verbatim at the tail (§4.7.2). Threaded into the pass + the fold. */
  readonly recentVerbatimTurns?: number;
  /** The compactor model/version, recorded on the fold's `CompactionEvent` (OQ-10 tunable). */
  readonly compactorModel?: string;
  /** Relevance-lite keyword hint forwarded to the deterministic pass (search compressor, PR-b2). */
  readonly taskTokens?: readonly string[];
  /** Source-side cap for newly appended trailing tool observations. Default 64 KiB. */
  readonly observationMaxBytes?: number;
}

const DEFAULT_SOFT_FRACTION = 0.7;
const DEFAULT_HARD_FRACTION = 0.85;
const DEFAULT_EXPECTED_REMAINING_READS = 10;
/** Mirrors `pass.ts` DEFAULT_HEADROOM — the reserved output budget. */
const DEFAULT_HEADROOM = 16_384;
const DEFAULT_OBSERVATION_MAX_BYTES = 64 * 1024;

interface ObservationShapeResult {
  readonly messages: readonly ModelMessageT[];
  readonly event: ContextCompressionEventT | null;
}

function shapeTrailingToolObservations(input: {
  readonly messages: readonly ModelMessageT[];
  readonly maxBytes: number;
  readonly taskTokens?: readonly string[];
  readonly trigger: "token_soft" | "token_hard";
}): ObservationShapeResult {
  let latestPlanIdx = -1;
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const message = input.messages[i]!;
    if (message.role === "tool" && message.name === PLAN_TOOL_NAME) {
      latestPlanIdx = i;
      break;
    }
  }

  let firstFresh = input.messages.length;
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const message = input.messages[i]!;
    if (message.role === "tool" || isHarnessBudgetNotice(message)) {
      firstFresh = i;
      continue;
    }
    break;
  }
  if (firstFresh === input.messages.length) return { messages: input.messages, event: null };

  const candidates: Array<{ readonly index: number; readonly bytes: number }> = [];
  for (let i = firstFresh; i < input.messages.length; i++) {
    const msg = input.messages[i]!;
    if (msg.role !== "tool") continue;
    if (i === latestPlanIdx) continue;
    candidates.push({ index: i, bytes: Buffer.byteLength(msg.content, "utf8") });
  }
  const cumulativeFreshBytes = candidates.reduce((sum, item) => sum + item.bytes, 0);
  const cumulativeOverCap = cumulativeFreshBytes > input.maxBytes && candidates.length > 0;
  const cumulativeMessageMaxBytes = cumulativeOverCap
    ? Math.max(1, Math.floor(input.maxBytes / candidates.length))
    : input.maxBytes;

  let out: ModelMessageT[] | undefined;
  const items: ContextCompressionEventT["items"] = [];
  let from = -1;
  let to = -1;

  for (let i = firstFresh; i < input.messages.length; i++) {
    const msg = (out ?? input.messages)[i]!;
    if (msg.role !== "tool") continue;
    if (i === latestPlanIdx) continue;
    const original = msg.content;
    const maxBytes = cumulativeOverCap ? cumulativeMessageMaxBytes : input.maxBytes;
    if (Buffer.byteLength(original, "utf8") <= maxBytes) continue;
    const { text, kind } = selectCompressor(msg).compress(original, {
      maxBytes,
      ...(input.taskTokens !== undefined ? { taskTokens: input.taskTokens } : {}),
    });
    const note = ledgerNote(msg.toolCallId);
    const bodyBudget = Math.max(0, maxBytes - Buffer.byteLength(note, "utf8"));
    let boundedText = bodyBudget > 0 ? truncateHeadTail(text, bodyBudget).text : "";
    let candidate = boundedText + note;
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) {
      boundedText = bodyBudget > 0 ? truncateHeadUtf8(text, bodyBudget) : "";
      candidate = boundedText + note;
    }
    if (Buffer.byteLength(candidate, "utf8") >= Buffer.byteLength(original, "utf8")) continue;
    // Preserve untouched message identity. In particular, user-role identity carries authorship
    // provenance through the live loop; only this rewritten tool observation gets a new object.
    out ??= [...input.messages];
    out[i] = { ...msg, content: candidate };
    items.push({
      kind,
      name: msg.name ?? "unknown",
      beforeChars: original.length,
      afterChars: candidate.length,
    });
    if (from === -1) from = i;
    to = i;
  }

  if (items.length === 0) return { messages: input.messages, event: null };
  const shaped = out ?? input.messages;

  return {
    messages: shaped,
    event: {
      type: "context_compression",
      v: 1,
      compressionId: `ccx_${ulid()}`,
      ts: new Date().toISOString(),
      inputRange: { from, to },
      items,
      tokensBefore: estimateMessagesTokens(input.messages),
      tokensAfter: estimateMessagesTokens(shaped),
      trigger: input.trigger,
      trust: "unknown",
    },
  };
}

function typedWindowPressure(pressure: ContextPressure | undefined): {
  readonly soft: boolean;
  readonly hard: boolean;
} {
  if (pressure === undefined || pressure.reason.kind === "none")
    return { soft: false, hard: false };
  return { soft: true, hard: pressure.reason.severity === "hard" };
}

/**
 * Build the in-loop compaction brain (the `AgentCompactor` the runner plugs into `runAgentLoop`). At
 * each turn boundary it decides — cache-aware (ADR-0046) — WHETHER to act and records its own audit
 * event(s) to the ledger; a no-op returns the same array (the loop's `next !== messages` check then
 * skips the copy). It composes the existing pure pieces:
 *
 *   1. **Cheap gate** — act only under RUNWAY (`gross ≥ softFraction · maxGrossTokens`, the primary
 *      driver) OR context-WINDOW (`ctx ≥ softFraction · budgetTokens`) pressure; else no-op, no copy.
 *   2. **Deterministic pass** (`runDeterministicPass`, pure + ledger-reversible) targeting the window.
 *      Kept only if the **cache net-gain guard** says so (`cacheRewriteNetGainTokens > 0`) OR we're
 *      under hard runway pressure (runway trumps a marginal cache shave). Otherwise discarded — no
 *      cache bust for a marginal shave with no runway reason.
 *   3. **Fold escalation** (`compact`, the lossy model fold) — when the context window is still over
 *      hard pressure after the pass, OR under hard runway pressure (the big reclaim that buys turns).
 *      Bounded by `minRefoldGrowthTokens` so it fires infrequently (amortize, don't thrash). `compact`
 *      itself fail-soft / abort / progress-guards (ER-021); its event is always recorded (honest audit).
 *
 * SEC-023: only the model's VIEW is compressed; the full output stays verbatim + provenance-tagged in
 * the ledger (`readEvents` is read, never mutated), and the appended events carry `trust:"unknown"`.
 */
export function createInLoopCompactor(deps: InLoopCompactorDeps): AgentCompactor {
  const cacheReadWeight = deps.cacheReadWeight ?? 1.0;
  const softFraction = deps.softFraction ?? DEFAULT_SOFT_FRACTION;
  const hardFraction = deps.hardFraction ?? DEFAULT_HARD_FRACTION;
  const headroomTokens = deps.headroomTokens ?? DEFAULT_HEADROOM;
  const expectedRemainingReads = deps.expectedRemainingReads ?? DEFAULT_EXPECTED_REMAINING_READS;
  const minRefoldGrowthTokens = deps.minRefoldGrowthTokens ?? headroomTokens;
  const recentVerbatimTurns = deps.recentVerbatimTurns;
  const observationMaxBytes = deps.observationMaxBytes ?? DEFAULT_OBSERVATION_MAX_BYTES;

  // The fold's re-compaction bound (closure state): the context size right AFTER the last fold attempt.
  // `undefined` = never folded. On success this is small (re-fold gated by window/runway re-pressure);
  // on a fail-soft it equals the input size (re-fold gated by `minRefoldGrowthTokens` of fresh growth).
  let lastFoldOutputTokens: number | undefined;

  return async (messages, usage, signal, pressure) => {
    const gross = usage.inputTokens + usage.outputTokens;
    let current: readonly ModelMessageT[] = messages;

    const runwaySoft = deps.maxGrossTokens * softFraction;
    const runwayHard = deps.maxGrossTokens * hardFraction;
    const budgetTokens = pressure?.contextWindow.tokens ?? deps.budgetTokens;
    const windowSoft = budgetTokens * softFraction;
    const windowHard = budgetTokens * hardFraction;

    const underHardRunway = gross >= runwayHard;
    let typedPressure = typedWindowPressure(pressure);
    const shape = shapeTrailingToolObservations({
      messages: current,
      maxBytes: observationMaxBytes,
      ...(deps.taskTokens !== undefined ? { taskTokens: deps.taskTokens } : {}),
      trigger: typedPressure.hard || underHardRunway ? "token_hard" : "token_soft",
    });
    if (shape.event !== null) {
      deps.store.append(shape.event);
      current = shape.messages;
      if (pressure?.reason.kind === "new-observation") {
        typedPressure = { soft: false, hard: false };
      }
    }

    const ctx = estimateMessagesTokens(current);
    const underHardWindow = typedPressure.hard || ctx >= windowHard;
    const underPressure = gross >= runwaySoft || typedPressure.soft || ctx >= windowSoft;

    // 1) Cheap gate: nothing to do unless under runway or window pressure (return the SAME ref).
    if (!underPressure) return current;

    // 2) Deterministic pass (cheap, pure, ledger-reversible) targeting the window.
    const pass = runDeterministicPass({
      messages: current,
      budgetTokens,
      headroomTokens,
      ...(recentVerbatimTurns !== undefined ? { recentVerbatimTurns } : {}),
      ...(deps.taskTokens !== undefined ? { taskTokens: deps.taskTokens } : {}),
      trigger: underHardRunway || underHardWindow ? "token_hard" : "token_soft",
    });
    if (pass.event !== null) {
      // The cache net-gain guard (ADR-0046): the rewrite busts the prefix cache from the first
      // compressed message onward; that suffix is re-written once. Keep the swap only if it pays for
      // itself over the horizon — UNLESS under hard runway/window pressure, where fitting the next
      // request / preserving gross runway outweighs the one-time cache cost. `savedTokensPerTurn` =
      // the view shrink (cheap cached reads avoided each turn); `rewrittenTokens` = the post-pass
      // suffix that loses its cache entry.
      const savedTokensPerTurn = pass.event.tokensBefore - pass.event.tokensAfter;
      const rewrittenTokens = pass.messages
        .slice(pass.event.inputRange.from)
        .reduce((sum, m) => sum + messageTokens(m), 0);
      const netGain = cacheRewriteNetGainTokens({
        savedTokensPerTurn,
        rewrittenTokens,
        cacheReadWeight,
        expectedRemainingReads,
      });
      if (netGain > 0 || underHardRunway || underHardWindow) {
        deps.store.append(pass.event);
        current = pass.messages;
      }
    }

    // 3) Fold escalation: the big reclaim, when the window is still over hard pressure after the pass
    // OR runway is critically tight. Bounded so it fires infrequently (amortize, don't thrash).
    const ctxAfterPass = estimateMessagesTokens(current);
    const grownEnough =
      lastFoldOutputTokens === undefined ||
      ctxAfterPass > lastFoldOutputTokens + minRefoldGrowthTokens;
    if ((ctxAfterPass >= windowHard || typedPressure.hard || underHardRunway) && grownEnough) {
      const result = await compact({
        messages: current,
        events: deps.readEvents(),
        budgetTokens,
        trigger: "token_hard",
        summarize: deps.summarize,
        ...(recentVerbatimTurns !== undefined ? { recentVerbatimTurns } : {}),
        ...(deps.compactorModel !== undefined ? { compactorModel: deps.compactorModel } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
      deps.store.append(result.event); // honest audit — a fail-soft records a `validation:"failed"` event
      current = result.messages;
      lastFoldOutputTokens = estimateMessagesTokens(current);
    }

    return current;
  };
}
