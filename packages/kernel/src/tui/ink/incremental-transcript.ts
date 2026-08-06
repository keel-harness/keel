import type { UiMessage, ViewItem, ViewModel } from "@keel/shared";
import {
  assistantStreamingCommitBoundary,
  assistantStreamingRangePlan,
  type AssistantProsePlan,
  type AssistantStreamingProjection,
} from "../assistant-prose.js";
import {
  isRoutineSuccessfulTool,
  isTerminalRunNotice,
  transcriptCommitPlan,
  visibleTurnItemsWithIndexes,
  type AssistantPresentationRole,
  type ConversationBlock,
  type ConversationTurnBlock,
  type TranscriptCommitPlan,
  type TurnEvidencePresentation,
  type TurnSummaryPresentation,
} from "../conversation-block.js";
import {
  projectAssistantStream,
  type AssistantStreamProjectionSnapshot,
} from "../stream-projection.js";
import { leadingSystemEnd } from "../view-model.js";
import { hasSemanticZoomMutationReview } from "../tool-card.js";

export type IncrementalStaticUnit =
  | { readonly id: string; readonly kind: "user"; readonly item: ConversationTurnBlock["user"] }
  | { readonly id: string; readonly kind: "item"; readonly item: ViewItem }
  | {
      readonly id: string;
      readonly kind: "assistant-plans";
      readonly plans: readonly AssistantProsePlan[];
      readonly label: boolean;
      readonly role: AssistantPresentationRole;
    }
  | { readonly id: string; readonly kind: "evidence"; readonly card: TurnEvidencePresentation }
  | { readonly id: string; readonly kind: "summary"; readonly card: TurnSummaryPresentation };

export interface IncrementalAssistantPlansEntry {
  readonly kind: "assistant-plans";
  readonly plans: readonly AssistantProsePlan[];
  readonly label: boolean;
  readonly role: AssistantPresentationRole;
}

type IncrementalStaticUnitInput =
  | { readonly kind: "user"; readonly item: ConversationTurnBlock["user"] }
  | { readonly kind: "item"; readonly item: ViewItem }
  | IncrementalAssistantPlansEntry
  | { readonly kind: "evidence"; readonly card: TurnEvidencePresentation }
  | { readonly kind: "summary"; readonly card: TurnSummaryPresentation };

export interface IncrementalTurnState {
  readonly blockId: string;
  readonly committedItems: Set<number>;
  readonly committedAssistantLines: Map<number, number>;
  readonly observedAssistantLengths: Map<number, number>;
  readonly labeledAssistants: Set<number>;
  readonly wrapColumns: number;
  finalized: boolean;
}

// The projection layer retains up to eight rows so atomic Markdown constructs remain coherent. The
// mutable Ink viewport keeps the newest source row plus at most three pending batch rows at stable
// width; resize reflow trims to that source row without acquiring Static ownership.
const INCREMENTAL_MUTABLE_ASSISTANT_ROWS = 1;
const INCREMENTAL_STATIC_ASSISTANT_BATCH_ROWS = 4;

export function incrementalLiveLineLimit(sourceColumns: number, currentColumns: number): number {
  const physicalRowsPerSourceLine = Math.max(1, Math.ceil(sourceColumns / currentColumns));
  return Math.max(1, Math.floor(INCREMENTAL_MUTABLE_ASSISTANT_ROWS / physicalRowsPerSourceLine));
}

export function incrementalStreamingCommitTarget(
  committed: number,
  total: number,
  liveLineLimit: number,
  contentAdvanced: boolean,
): number {
  if (!contentAdvanced) return committed;
  const eligible = Math.max(committed, total - liveLineLimit);
  const available = eligible - committed;
  if (available < INCREMENTAL_STATIC_ASSISTANT_BATCH_ROWS) return committed;
  return (
    committed +
    Math.floor(available / INCREMENTAL_STATIC_ASSISTANT_BATCH_ROWS) *
      INCREMENTAL_STATIC_ASSISTANT_BATCH_ROWS
  );
}

export interface IncrementalTranscriptLedger {
  turns: Map<string, IncrementalTurnState>;
  entryCount: number;
  entryAppends: InkStaticEntry[];
  committedBlocks: Set<string>;
  committedThroughIndex: number;
  sourceItems: readonly ViewItem[] | undefined;
  turnsOwned: boolean;
  committedBlocksOwned: boolean;
  nextId: number;
}

export type InkStaticEntry =
  | { readonly id: string; readonly kind: "conversation"; readonly block: ConversationBlock }
  | { readonly id: string; readonly kind: "incremental"; readonly unit: IncrementalStaticUnit };

export type AssistantProjectionFor = (
  blockId: string,
  itemIndex: number,
  item: UiMessage,
  columns: number,
  retainFromLine?: number,
) => AssistantStreamingProjection;

export type AssistantProjectionCache = ReadonlyMap<string, AssistantStreamProjectionSnapshot>;

export interface IncrementalTranscriptCandidate {
  readonly ledger: IncrementalTranscriptLedger;
  readonly projectionCache: Map<string, AssistantStreamProjectionSnapshot>;
  readonly commitPlan: TranscriptCommitPlan;
  readonly staticEntries: AppendOnlyStaticItems<InkStaticEntry>;
  readonly projectionFor: AssistantProjectionFor;
}

export function createIncrementalTranscriptLedger(): IncrementalTranscriptLedger {
  return {
    turns: new Map(),
    entryCount: 0,
    entryAppends: [],
    committedBlocks: new Set(),
    committedThroughIndex: -1,
    sourceItems: undefined,
    turnsOwned: true,
    committedBlocksOwned: true,
    nextId: 0,
  };
}

function cloneIncrementalLedger(source: IncrementalTranscriptLedger): IncrementalTranscriptLedger {
  return {
    turns: source.turns,
    entryCount: source.entryCount,
    entryAppends: [],
    committedBlocks: source.committedBlocks,
    committedThroughIndex: source.committedThroughIndex,
    sourceItems: source.sourceItems,
    turnsOwned: false,
    committedBlocksOwned: false,
    nextId: source.nextId,
  };
}

function ownTurns(ledger: IncrementalTranscriptLedger): void {
  if (ledger.turnsOwned) return;
  ledger.turns = new Map(ledger.turns);
  ledger.turnsOwned = true;
}

function ownCommittedBlocks(ledger: IncrementalTranscriptLedger): void {
  if (ledger.committedBlocksOwned) return;
  ledger.committedBlocks = new Set(ledger.committedBlocks);
  ledger.committedBlocksOwned = true;
}

function markBlockCommitted(ledger: IncrementalTranscriptLedger, block: ConversationBlock): void {
  ownCommittedBlocks(ledger);
  ledger.committedBlocks.add(block.id);
  if (block.startIndex <= ledger.committedThroughIndex + 1) {
    ledger.committedThroughIndex = Math.max(ledger.committedThroughIndex, block.endIndex);
  }
}

function hasStableCommittedPrefix(
  previous: readonly ViewItem[] | undefined,
  current: readonly ViewItem[],
  committedThroughIndex: number,
): boolean {
  if (committedThroughIndex < 0) return true;
  if (
    previous === undefined ||
    previous.length <= committedThroughIndex ||
    current.length <= committedThroughIndex
  ) {
    return false;
  }
  for (let index = 0; index <= committedThroughIndex; index += 1) {
    if (previous[index] !== current[index]) return false;
  }
  return true;
}

function isReconstructedAwayNotice(item: ViewItem): boolean {
  return item.kind === "message" && item.role === "system" && item.presentation === "notice";
}

/** Fresh REPL reconstruction preserves authoritative conversation identity but intentionally drops
 * reducer-local presentation metadata (`streamDeltas`, `diff`, `liveOutput`, symbol tags). Compare
 * only fields that identify the already-written semantic record; any content/status drift still
 * fails closed to the full-plan fallback. */
function hasStableReconstructedIdentity(previous: ViewItem, current: ViewItem): boolean {
  if (previous.kind !== current.kind) return false;
  if (previous.kind === "message" && current.kind === "message") {
    return previous.role === current.role && previous.content === current.content;
  }
  if (previous.kind === "tool" && current.kind === "tool") {
    return (
      previous.id === current.id &&
      previous.name === current.name &&
      previous.status === current.status &&
      previous.summary === current.summary &&
      previous.subject === current.subject
    );
  }
  return false;
}

/** Map terminal-owned semantic items onto a freshly reconstructed transcript while allowing only
 * reducer-local notices to disappear. Any other drift fails closed to the full-plan fallback. */
function reconcileCommittedPrefix(
  previous: readonly ViewItem[] | undefined,
  current: readonly ViewItem[],
  committedThroughIndex: number,
): number | undefined {
  if (previous === undefined || committedThroughIndex >= previous.length) return undefined;
  let currentIndex = 0;
  let committedCurrentIndex = -1;
  for (let previousIndex = 0; previousIndex <= committedThroughIndex; previousIndex += 1) {
    const previousItem = previous[previousIndex]!;
    const currentItem = current[currentIndex];
    if (currentItem !== undefined && hasStableReconstructedIdentity(previousItem, currentItem)) {
      committedCurrentIndex = currentIndex;
      currentIndex += 1;
      continue;
    }
    if (isReconstructedAwayNotice(previousItem)) continue;
    return undefined;
  }
  return committedCurrentIndex;
}

function mutableTurn(state: IncrementalTurnState): IncrementalTurnState {
  return {
    ...state,
    committedItems: new Set(state.committedItems),
    committedAssistantLines: new Map(state.committedAssistantLines),
    observedAssistantLengths: new Map(state.observedAssistantLengths),
    labeledAssistants: new Set(state.labeledAssistants),
  };
}

function activeStreamingTurn(block: ConversationTurnBlock, view: ViewModel): boolean {
  return view.streaming && block.startIndex + 1 + block.items.length === view.items.length;
}

function addIncrementalUnit(
  ledger: IncrementalTranscriptLedger,
  unit: IncrementalStaticUnitInput,
): void {
  const next = { ...unit, id: `stream:${ledger.nextId++}` } as IncrementalStaticUnit;
  ledger.entryAppends.push({ id: `unit:${next.id}`, kind: "incremental", unit: next });
}

/**
 * Ink's pinned Static implementation reads only `items.length` and `items.slice(index)`. Present a
 * count-only array-like window over the terminal-owned prefix plus this render's append batch, so
 * streaming neither retains presentation objects already written to scrollback nor allocates an
 * Array-sized hole backing store. `slice` deliberately omits the count-only prefix, including if
 * Static remounts with index zero, which prevents replaying terminal-owned rows. This intentionally
 * implements only the exact `length`/`slice` contract used by pinned Ink 7.0.5's Static component.
 */
export class AppendOnlyStaticItems<T> {
  readonly #baseLength: number;
  readonly length: number;

  constructor(
    baseLength: number,
    readonly appends: readonly T[],
  ) {
    this.#baseLength = baseLength;
    this.length = baseLength + appends.length;
  }

  slice(start = 0, end = this.length): T[] {
    const from = start < 0 ? Math.max(this.length + start, 0) : Math.min(start, this.length);
    const to = end < 0 ? Math.max(this.length + end, 0) : Math.min(end, this.length);
    if (to <= from) return [];
    if (to <= this.#baseLength) return [];
    const appendFrom = Math.max(from, this.#baseLength) - this.#baseLength;
    return this.appends.slice(appendFrom, to - this.#baseLength);
  }
}

export function commitStaticEntryAppends<T>(entryCount: number, appends: readonly T[]): number {
  const next = entryCount + appends.length;
  if (!Number.isSafeInteger(next)) throw new RangeError("Static entry count exceeds safe range");
  return next;
}

/** Preserve provider-authored hard prose lines without breaking Markdown structures. A wrapped
 * source line remains one plan; adjacent ordinary prose source lines become siblings, while code,
 * tables, lists, blank separators, and their surrounding context stay together. */
export function incrementalAssistantRangePlans(
  projection: AssistantStreamingProjection,
  start: number,
  end: number,
): AssistantProsePlan[] {
  const plans: AssistantProsePlan[] = [];
  let segmentStart = start;
  const addSegment = (segmentEnd: number): void => {
    plans.push(assistantStreamingRangePlan(projection, segmentStart, segmentEnd));
    segmentStart = segmentEnd;
  };

  for (let cursor = start + 1; cursor < end; cursor += 1) {
    const line = projection.lines[cursor - projection.lineOffset];
    const previous = projection.lines[cursor - projection.lineOffset - 1];
    const ordinaryProse =
      line !== undefined &&
      line.syntax === "prose" &&
      line.logicalKind === "other" &&
      line.text.trim() !== "";
    const previousOrdinaryProse =
      previous !== undefined &&
      previous.syntax === "prose" &&
      previous.logicalKind === "other" &&
      previous.text.trim() !== "";
    if (!line?.continuesSourceLine && ordinaryProse && previousOrdinaryProse) addSegment(cursor);
  }
  addSegment(end);
  return plans;
}

/** A semantic promotion is one Static-owned item even when source-aligned prose requires multiple
 * sibling render plans. Keeping this as a pure seam makes ownership granularity executable. */
export function incrementalAssistantRangeEntries(
  projection: AssistantStreamingProjection,
  start: number,
  end: number,
  label: boolean,
  role: AssistantPresentationRole,
): readonly IncrementalAssistantPlansEntry[] {
  const plans = incrementalAssistantRangePlans(projection, start, end);
  return plans.length === 0 ? [] : [{ kind: "assistant-plans", plans, label, role }];
}

/** Keep one bounded promotion render while publishing source-aligned sibling plans in one Static
 * entry, matching the earlier transcript without per-delta promotion. */
function addIncrementalAssistantRange(
  ledger: IncrementalTranscriptLedger,
  state: IncrementalTurnState,
  itemIndex: number,
  projection: AssistantStreamingProjection,
  start: number,
  end: number,
  role: AssistantPresentationRole,
): void {
  const [entry] = incrementalAssistantRangeEntries(
    projection,
    start,
    end,
    !state.labeledAssistants.has(itemIndex),
    role,
  );
  if (entry === undefined) return;
  addIncrementalUnit(ledger, entry);
  state.labeledAssistants.add(itemIndex);
}

function advanceIncrementalTurn(
  ledger: IncrementalTranscriptLedger,
  state: IncrementalTurnState,
  block: ConversationTurnBlock,
  view: ViewModel,
  currentWrapColumns: number,
  projectionFor: AssistantProjectionFor,
  commitEligible: boolean,
): void {
  if (state.finalized) return;
  const visible = visibleTurnItemsWithIndexes(block.items, view.density, {
    suppressFailedTools: block.suppressFailedTools === true,
    suppressEvidenceItems: block.suppressEvidenceItems === true,
    suppressProblemTools: block.suppressProblemTools === true,
    suppressExploratoryFailures: block.suppressExploratoryFailures === true,
    retainDiffTools: view.diffMode === "full",
  });
  // The shared transcript planner is the authority on immutability. In particular, merely having a
  // later system notice is not enough: a running tool in this block can still settle in place. A
  // graph-eligible prior block, however, is a real continuation boundary and may release a staged
  // terminal notice before the next prompt even while that next block streams.
  const finalized =
    commitEligible ||
    (!view.streaming && (block.summary !== undefined || view.awaitingInput === true));
  for (const { item, index, synthetic, assistantRole } of visible) {
    if (
      item.kind === "tool" &&
      (item.status === "running" || item.mutationPresentation?.status === "pending")
    )
      break;
    // A controller stop can arrive one reducer event before `run-finished` creates its canonical
    // evidence receipt. Keep that transient note in the mutable viewport; committing it here would
    // make the later receipt an unavoidable duplicate in terminal scrollback. If no receipt follows,
    // `awaiting-input` is itself a settlement boundary and the raw notice is committed fail-safely.
    if (!finalized && isTerminalRunNotice(item)) continue;
    // Semantic zoom can change while this turn is still live. Hold the successful mutation card
    // until settlement so Ink Static owns exactly the compact or detailed final representation.
    if (!finalized && item.kind === "tool" && hasSemanticZoomMutationReview(item)) break;
    // Immutable history keeps source order. A synthetic aggregate whose final count is not stable is
    // a commit barrier; settled real tools use the presentation visible when they settle.
    if (synthetic && !finalized) break;
    if (
      view.density !== "quiet" &&
      view.density !== "verbose" &&
      view.density !== "debug" &&
      isRoutineSuccessfulTool(item) &&
      (!finalized || block.evidence !== undefined || block.summary !== undefined)
    ) {
      continue;
    }
    if (item.kind === "message" && item.role === "assistant") {
      const committed = state.committedAssistantLines.get(index) ?? 0;
      const previousLength = state.observedAssistantLengths.get(index) ?? 0;
      const contentAdvanced = item.content.length > previousLength;
      state.observedAssistantLengths.set(index, item.content.length);
      const projection = projectionFor(block.id, index, item, state.wrapColumns, committed);
      const activeTail = block.startIndex + 1 + index === view.items.length - 1;
      // Keep a bounded live tail without mounting/removing one Static subtree per provider row.
      // Stable rows move to history four at a time, and only when source content advances; a
      // resize-only render can reflow the live preview but cannot acquire scrollback ownership.
      const stagingTail = activeTail && view.streaming;
      const holdbackRows = incrementalLiveLineLimit(state.wrapColumns, currentWrapColumns);
      const requestedTarget = stagingTail
        ? incrementalStreamingCommitTarget(
            committed,
            projection.totalLines,
            holdbackRows,
            contentAdvanced,
          )
        : projection.totalLines;
      const target = assistantStreamingCommitBoundary(projection, requestedTarget);
      if (target <= committed) continue;
      addIncrementalAssistantRange(
        ledger,
        state,
        index,
        projection,
        committed,
        target,
        assistantRole ?? "answer",
      );
      state.committedAssistantLines.set(index, target);
      if (!stagingTail) state.committedItems.add(index);
      continue;
    }
    if (!state.committedItems.has(index)) {
      addIncrementalUnit(ledger, { kind: "item", item });
      state.committedItems.add(index);
    }
  }

  if (!view.streaming && block.summary !== undefined && !state.finalized) {
    if (block.evidence !== undefined) {
      addIncrementalUnit(ledger, { kind: "evidence", card: block.evidence });
    }
    addIncrementalUnit(ledger, { kind: "summary", card: block.summary });
    state.finalized = true;
  } else if (
    (commitEligible || (!view.streaming && view.awaitingInput === true)) &&
    !state.finalized
  ) {
    if (block.evidence !== undefined) {
      addIncrementalUnit(ledger, { kind: "evidence", card: block.evidence });
    }
    state.finalized = true;
  }
}

export function planIncrementalTranscript(options: {
  readonly previousLedger: IncrementalTranscriptLedger;
  readonly previousProjectionCache: AssistantProjectionCache;
  readonly view: ViewModel;
  readonly verbose: boolean;
  readonly wrapColumns: number;
}): IncrementalTranscriptCandidate {
  const { previousLedger, previousProjectionCache, view, verbose, wrapColumns } = options;
  // Build the next ledger as a pure render candidate. The Ink parent installs it only after React
  // commits, so an interrupted/concurrent render cannot mark unprinted history as terminal-owned.
  const ledger = cloneIncrementalLedger(previousLedger);
  if (!hasStableCommittedPrefix(ledger.sourceItems, view.items, ledger.committedThroughIndex)) {
    ledger.committedThroughIndex =
      reconcileCommittedPrefix(ledger.sourceItems, view.items, ledger.committedThroughIndex) ??
      (verbose ? -1 : leadingSystemEnd(view.items) - 1);
  } else if (
    !verbose &&
    ledger.committedThroughIndex < 0 &&
    ledger.entryCount === 0 &&
    ledger.turns.size === 0
  ) {
    ledger.committedThroughIndex = leadingSystemEnd(view.items) - 1;
  }

  const commitPlan = transcriptCommitPlan(view, {
    verbose,
    sourceOffset: ledger.committedThroughIndex + 1,
  });
  const projectionCache = new Map<string, AssistantStreamProjectionSnapshot>();
  const projectionFor: AssistantProjectionFor = (
    blockId,
    itemIndex,
    item,
    columns,
    retainFromLine,
  ) => {
    const key = `${blockId}:${itemIndex}`;
    const previous = projectionCache.get(key) ?? previousProjectionCache.get(key);
    const snapshot = projectAssistantStream(item, columns, previous, retainFromLine);
    projectionCache.set(key, snapshot);
    return snapshot.projection;
  };
  const allBlocks = [...commitPlan.staticBlocks, ...commitPlan.livePlan.blocks];
  const staticBlockIds = new Set(commitPlan.staticBlocks.map((block) => block.id));
  const firstLiveBlockId = commitPlan.livePlan.blocks[0]?.id;

  for (const block of allBlocks) {
    if (
      ledger.committedBlocks.has(block.id) &&
      block.startIndex <= ledger.committedThroughIndex + 1
    ) {
      ledger.committedThroughIndex = Math.max(ledger.committedThroughIndex, block.endIndex);
    }
    let state = block.kind === "turn" ? ledger.turns.get(block.id) : undefined;
    if (
      block.kind === "turn" &&
      state === undefined &&
      block.id === firstLiveBlockId &&
      activeStreamingTurn(block, view)
    ) {
      state = {
        blockId: block.id,
        committedItems: new Set(),
        committedAssistantLines: new Map(),
        observedAssistantLengths: new Map(),
        labeledAssistants: new Set(),
        wrapColumns,
        finalized: false,
      };
      ownTurns(ledger);
      ledger.turns.set(block.id, state);
      addIncrementalUnit(ledger, { kind: "user", item: block.user });
    }
    if (block.kind === "turn" && state !== undefined) {
      if (!state.finalized) {
        state = mutableTurn(state);
        ownTurns(ledger);
        ledger.turns.set(block.id, state);
        advanceIncrementalTurn(
          ledger,
          state,
          block,
          view,
          wrapColumns,
          projectionFor,
          staticBlockIds.has(block.id),
        );
        if (state.finalized) {
          markBlockCommitted(ledger, block);
          ownTurns(ledger);
          ledger.turns.delete(block.id);
        }
      }
    } else if (staticBlockIds.has(block.id) && !ledger.committedBlocks.has(block.id)) {
      ledger.entryAppends.push({ id: `block:${block.id}`, kind: "conversation", block });
      markBlockCommitted(ledger, block);
    }
  }
  ledger.sourceItems = view.items;

  return {
    ledger,
    projectionCache,
    commitPlan,
    staticEntries: new AppendOnlyStaticItems(ledger.entryCount, ledger.entryAppends),
    projectionFor,
  };
}

/** Finalize only after React commits the candidate render. */
export function commitIncrementalTranscriptCandidate(
  candidate: IncrementalTranscriptCandidate,
): void {
  const { ledger } = candidate;
  if (ledger.entryAppends.length > 0) {
    ledger.entryCount = commitStaticEntryAppends(ledger.entryCount, ledger.entryAppends);
    ledger.entryAppends = [];
  }
}
