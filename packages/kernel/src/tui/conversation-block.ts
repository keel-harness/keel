import type {
  UiAttentionMark,
  UiCurrentTurn,
  UiDensity,
  UiMessage,
  UiTurnSummary,
  ViewItem,
  ViewModel,
} from "@keel/shared";
import { redactText } from "@keel/shared";
import { LIVENESS_REVEAL_MS, MAX_LIVENESS_MS } from "./purposeful-liveness.js";
import { SEMANTIC_TOKENS } from "./theme.js";
import { toolOutcome } from "./tool-outcome.js";
import { truncateDisplayCells } from "./display-cells.js";
import { oneLineText } from "../control-strip.js";
import { visibleTerminalText } from "./visible-text.js";
import {
  COMPLETION_TRUTH_NOTICE_PREFIX,
  isHiddenInDensity,
  leadingSystemEnd,
  mutationReceiptEvidence,
  stripControlLine,
} from "./view-model.js";
import {
  isRecoverableExploratoryFailure,
  reconciledToolAttempts,
  recoveredToolFailureIndexes,
} from "./recovered-tool.js";
import {
  reviewSettlementPresentation,
  reviewSettlementRecovery,
  type ReviewSettlementPresentationOutcome,
} from "./review-settlement-presentation.js";
import { TUI_MANUAL_RECOVERY_GUIDANCE, TUI_TERMINAL_REVIEW_TRUTH } from "./strings.js";

type UserMessage = UiMessage & { readonly role: "user" };

export type ConversationRecency = "older" | "recent" | "active";
export type ConversationMode = "expanded" | "compact";

export interface ConversationItemsBlock {
  readonly kind: "items";
  readonly id: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly items: readonly ViewItem[];
  readonly evidence?: TurnEvidencePresentation;
  readonly suppressProblemTools?: boolean;
}

export interface ConversationTurnBlock {
  readonly kind: "turn";
  readonly id: string;
  readonly index: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly user: UserMessage;
  readonly items: readonly ViewItem[];
  readonly recency: ConversationRecency;
  readonly mode: ConversationMode;
  readonly receipt: string;
  readonly currentTurn?: UiCurrentTurn;
  readonly summary?: TurnSummaryPresentation;
  /** Controller-owned goal/loop terminal receipt, projected separately for one-shot output. */
  readonly runControlReceipt?: readonly string[];
  readonly evidence?: TurnEvidencePresentation;
  readonly suppressFailedTools?: boolean;
  readonly suppressEvidenceItems?: boolean;
  readonly suppressProblemTools?: boolean;
  readonly suppressExploratoryFailures?: boolean;
}

export type ConversationBlock = ConversationItemsBlock | ConversationTurnBlock;

export interface ConversationPlan {
  readonly blocks: readonly ConversationBlock[];
  readonly showAttentionRail: boolean;
  readonly attentionRail?: readonly UiAttentionMark[];
  readonly standaloneCurrentTurn?: UiCurrentTurn;
  readonly standaloneSummary?: TurnSummaryPresentation;
  readonly standaloneRunControlReceipt?: readonly string[];
}

export interface ReviewNeededDetail {
  readonly what: string;
  readonly why: string;
  readonly next: string;
}

export type TurnEvidenceKind =
  | "file-evidence"
  | "file-evidence-unavailable"
  | "recovered"
  | "changed"
  | "checked"
  | "ran"
  | "tool"
  | "limited"
  | "partial"
  | "review"
  | "blocked"
  | "skipped"
  | "failed"
  | "stopped"
  | "more";

export interface TurnEvidenceLine {
  readonly kind: TurnEvidenceKind;
  readonly text: string;
  readonly why?: string;
  readonly next?: string;
  readonly omitted?: {
    readonly group: "file" | "ran" | "failed";
    readonly count: number;
    readonly unavailableCount?: number;
  };
}

export interface TurnEvidencePresentation {
  readonly title: "evidence";
  readonly lines: readonly TurnEvidenceLine[];
}

export interface TurnSummaryPresentation {
  readonly title:
    | "done"
    | "limited"
    | "partial"
    | "needs attention"
    | "review needed"
    | "blocked"
    | "skipped"
    | "failed"
    | "stopped";
  readonly answer?: string;
  readonly changed: readonly string[];
  readonly checked: readonly string[];
  readonly fileEvidence?: readonly TurnFileEvidencePresentation[];
  readonly fileEvidenceCount?: number;
  readonly fileEvidenceHidden?: number;
  readonly fileEvidenceUnavailableCount?: number;
  readonly verification?: readonly string[];
  readonly recovery?: readonly string[];
  readonly ran?: readonly string[];
  readonly ranCount?: number;
  readonly ranHidden?: number;
  readonly attentionCount?: number;
  readonly automatic?: readonly string[];
  readonly receipt?: readonly string[];
  readonly attention: readonly ReviewNeededDetail[];
}

export interface TurnFileEvidencePresentation {
  readonly status: "available" | "unavailable" | "more";
  readonly text: string;
}

export interface TranscriptCommitPlan {
  readonly staticBlocks: readonly ConversationBlock[];
  readonly livePlan: ConversationPlan;
}

export interface VisibleTurnItem {
  readonly item: ViewItem;
  readonly index: number;
  readonly synthetic: boolean;
  readonly assistantRole?: AssistantPresentationRole;
}

export interface VisibleConversationItem extends VisibleTurnItem {
  readonly synthetic: boolean;
}

export type AssistantPresentationRole = "progress" | "answer";

export type ScreenAnatomyFrame = "idle" | "running" | "review-needed" | "done";

export type ScreenAnatomyRegionKind =
  | "launch"
  | "transcript"
  | "active-turn"
  | "review"
  | "receipt"
  | "status"
  | "composer"
  | "hint";

export interface ScreenAnatomyRegion {
  readonly kind: ScreenAnatomyRegionKind;
  readonly label: string;
  readonly state?: keyof typeof SEMANTIC_TOKENS.states;
}

export interface ScreenAnatomyPlan {
  readonly frame: ScreenAnatomyFrame;
  readonly regions: readonly ScreenAnatomyRegion[];
}

interface ConversationPlanOptions {
  readonly verbose?: boolean;
  readonly compactHistory?: boolean;
  /** Absolute transcript prefix already owned by an append-only renderer such as Ink <Static>. */
  readonly sourceOffset?: number;
}

interface MutableTurn {
  readonly startIndex: number;
  endIndex: number;
  readonly user: UserMessage;
  readonly items: ViewItem[];
}

const MAX_RECEIPT_TEXT = 72;
const MAX_EVIDENCE_TEXT = 120;
const ACTIVE_TASK_PREFIX = "task · ";

/** Source-faithful active-task copy for the mutable cockpit. This repeats only the already-visible
 * initiating user message: it strips terminal controls/ANSI, redacts known secret shapes, makes
 * remaining invisible scalars explicit, normalizes whitespace, and clips at a whole grapheme. */
export function activeTaskRow(content: string, maxCells: number): string | undefined {
  const cells = Number.isFinite(maxCells) ? Math.max(0, Math.floor(maxCells)) : 0;
  const task = visibleTerminalText(redactText(oneLineText(content)));
  if (task.length === 0 || cells === 0) return undefined;
  return truncateDisplayCells(`${ACTIVE_TASK_PREFIX}${task}`, cells);
}

/** One active cockpit hierarchy: source task first, then controller-owned action/diagnostics. */
export function activeTurnRows(
  task: string,
  turn: UiCurrentTurn,
  density: UiDensity | undefined,
  maxCells: number,
): readonly string[] {
  const taskRow = activeTaskRow(task, maxCells);
  return taskRow === undefined
    ? currentTurnRows(turn, density)
    : [taskRow, ...currentTurnRows(turn, density)];
}

export function currentTurnRows(
  turn: UiCurrentTurn,
  density: UiDensity | undefined,
): readonly string[] {
  const duration = (value: number | undefined, reveal = true): string | undefined => {
    if (value === undefined || Number.isNaN(value) || value < 0) return undefined;
    const bounded = Number.isFinite(value) ? Math.min(value, MAX_LIVENESS_MS) : MAX_LIVENESS_MS;
    if (reveal && bounded < LIVENESS_REVEAL_MS) return undefined;
    if (bounded >= MAX_LIVENESS_MS) return "99h+";
    if (bounded < 1_000) return `${String(Math.max(1, Math.floor(bounded)))}ms`;
    if (bounded < 60_000) return `${String(Math.floor(bounded / 1_000))}s`;
    if (bounded < 60 * 60_000) {
      const minutes = Math.floor(bounded / 60_000);
      const seconds = Math.floor((bounded % 60_000) / 10_000) * 10;
      return seconds > 0 ? `${String(minutes)}m ${String(seconds)}s` : `${String(minutes)}m`;
    }
    const hours = Math.floor(bounded / (60 * 60_000));
    const minutes = Math.floor((bounded % (60 * 60_000)) / 60_000);
    return minutes > 0 ? `${String(hours)}h ${String(minutes)}m` : `${String(hours)}h`;
  };
  const elapsed = duration(turn.elapsedMs);
  const rows = [
    `working · ${stripControlLine(turn.doing)}${elapsed === undefined ? "" : ` · ${elapsed}`}`,
  ];
  if (density !== "verbose" && density !== "debug") return rows;
  const quiet = duration(turn.quietMs);
  if (turn.last !== undefined) {
    rows.push(
      `last · ${stripControlLine(turn.last)}${quiet === undefined ? "" : ` · quiet ${quiet}`}`,
    );
  } else if (quiet !== undefined) {
    rows.push(`quiet · ${quiet} without output`);
  }
  const timeout = duration(turn.timeoutMs, false);
  if (timeout !== undefined && turn.timeoutMs !== undefined && turn.timeoutMs > 0) {
    rows.push(`limit · timeout ${timeout}`);
  }
  rows.push(`next · ${stripControlLine(turn.next)}`);
  return rows;
}

function isUserMessage(item: ViewItem): item is UserMessage {
  return item.kind === "message" && item.role === "user";
}

function hashString(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

function itemIdentity(item: ViewItem): string {
  if (item.kind === "message")
    return `${item.kind}:${item.role}:${item.presentation ?? "conversation"}:${item.content}`;
  return `${item.kind}:${item.id}:${item.name}`;
}

function looseBlockId(startIndex: number, items: readonly ViewItem[]): string {
  return `items:${startIndex}:${hashString(items.map(itemIdentity).join("|"))}`;
}

function turnBlockId(startIndex: number, user: UserMessage): string {
  return `turn:${startIndex}:${hashString(itemIdentity(user))}`;
}

/** Abnormal controller-owned stop notice. It semantically terminates the current user turn rather
 * than opening a free-standing system panel, and its settled calm-mode rendering is owned by the
 * canonical what/why/next evidence card. */
export function isTerminalRunNotice(item: ViewItem): boolean {
  return (
    item.kind === "message" &&
    item.role === "system" &&
    (item.content.startsWith("⚠ run ended —") ||
      item.content.startsWith(COMPLETION_TRUTH_NOTICE_PREFIX))
  );
}

function isCompletionTruthNotice(item: ViewItem): boolean {
  return (
    item.kind === "message" &&
    item.role === "system" &&
    item.content.startsWith(COMPLETION_TRUTH_NOTICE_PREFIX)
  );
}

function isPostTurnSystemItem(item: ViewItem, turn: MutableTurn | undefined): boolean {
  return (
    turn !== undefined &&
    turn.items.length > 0 &&
    item.kind === "message" &&
    item.role === "system" &&
    !isTerminalRunNotice(item)
  );
}

function isLooseSystemItem(item: ViewItem, current: MutableTurn | undefined): boolean {
  return current === undefined && item.kind === "message" && item.role === "system";
}

function truncateLine(s: string, max = MAX_RECEIPT_TEXT): string {
  const one = stripControlLine(s).trim().replace(/\s+/g, " ");
  return truncateDisplayCells(one, max);
}

function summaryLine(s: string): string {
  return stripControlLine(s).trim().replace(/\s+/g, " ");
}

function compactProblemLine(s: string): string {
  const one = summaryLine(s);
  const review = one.match(/warden review required(?: \(not executed\))?:/iu);
  if (review === null || review.index === undefined)
    return truncateProblemLine(one, MAX_EVIDENCE_TEXT);

  const prefixEnd = review.index + review[0].length;
  const prefix = one.slice(0, prefixEnd).trim();
  const detail = one
    .slice(prefixEnd)
    .split(";")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .filter((segment) => !/\[[^\]]+\]/u.test(segment))
    .filter((segment) => !/^allow:/iu.test(segment))
    .filter((segment) => !/exact command envelope only/iu.test(segment))
    .join("; ");
  return truncateProblemLine(
    detail.length > 0 ? `${prefix} ${detail}` : `${prefix} review detail available in transcript`,
    MAX_EVIDENCE_TEXT,
  );
}

function truncateProblemLine(s: string, max: number): string {
  const one = summaryLine(s);
  return truncateDisplayCells(one, max, { tailCells: Math.min(40, Math.floor(max / 3)) });
}

function firstLine(s: string): string {
  const nl = s.indexOf("\n");
  return nl === -1 ? s : s.slice(0, nl);
}

function lastAssistantLine(items: readonly ViewItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "message" && it.role === "assistant") {
      const line = truncateLine(firstLine(it.content), 96);
      if (line.length > 0) return line;
    }
  }
  return undefined;
}

function toolCounts(
  items: readonly ViewItem[],
  recoveredFailures: ReadonlySet<number> = recoveredToolFailureIndexes(items),
): {
  readonly fileEvidence: number;
  readonly checked: number;
  readonly ran: number;
  readonly failed: number;
  readonly otherTools: number;
  readonly limited: number;
  readonly partial: number;
  readonly observationsUnavailable: number;
} {
  let fileEvidence = 0;
  const checked = 0;
  let ran = 0;
  let failed = 0;
  let otherTools = 0;
  let limited = 0;
  let partial = 0;
  let observationsUnavailable = 0;
  for (const [index, item] of items.entries()) {
    if (item.kind !== "tool") continue;
    if (recoveredFailures.has(index)) continue;
    const typedMutation = item.name === "edit" || item.name === "write";
    if (
      item.mutationPresentation?.status === "unavailable" ||
      (typedMutation && item.status === "ok" && item.mutationPresentation?.status !== "available")
    ) {
      observationsUnavailable += 1;
    }
    const outcome = toolOutcome(item);
    if (outcome === "limited") {
      limited += 1;
    } else if (outcome === "partial") {
      partial += 1;
    } else if (item.status === "error") {
      failed += 1;
    } else if (
      item.status === "ok" &&
      typedMutation &&
      item.mutationPresentation?.status === "available"
    ) {
      fileEvidence += 1;
    } else if (item.status === "ok" && typedMutation) {
      // The explicit observation-unavailable count above owns this successful mutation. Do not
      // relabel the request/result as a changed-file or generic-tool fact.
    } else if (item.status === "ok" && (item.name === "bash" || item.name === "process.run")) {
      ran += 1;
    } else if (item.status === "ok") {
      otherTools += 1;
    }
  }
  return {
    fileEvidence,
    checked,
    ran,
    failed,
    otherTools,
    limited,
    partial,
    observationsUnavailable,
  };
}

function hasAttention(items: readonly ViewItem[], summary: UiTurnSummary | undefined): boolean {
  if (
    summary?.title === "needs attention" ||
    summary?.attention.some((line) => summaryLine(line).length > 0) === true
  )
    return true;
  const recoveredFailures = recoveredToolFailureIndexes(items);
  return items.some(
    (item, index) =>
      (!recoveredFailures.has(index) &&
        item.kind === "tool" &&
        (toolOutcome(item) !== "done" || item.status === "running")) ||
      (item.kind === "message" && item.role === "system" && item.content.startsWith("⚠ ")),
  );
}

function attentionTitle(
  attention: readonly string[],
  fallback: Exclude<TurnSummaryPresentation["title"], "done"> = "failed",
): TurnSummaryPresentation["title"] {
  if (attention.length === 0) return fallback;
  const text = attention.map(summaryLine).join(" ").toLowerCase();
  if (text.length === 0) return fallback;
  if (/\btarget may have changed\b/.test(text)) return "partial";
  if (/^(?:[^:]+:\s*)?skipped:/u.test(text)) return "skipped";
  if (/\b(interrupted|stopped|aborted)\b/.test(text)) return "stopped";
  if (text.includes(TUI_TERMINAL_REVIEW_TRUTH.summaryPrefix)) return "blocked";
  if (
    /\b(blocked by (?:warden|policy)|pol-\d+\s+deny|\bdeny:|denied by warden|warden denied)\b/.test(
      text,
    )
  )
    return "blocked";
  if (/\b(review|approval|approve|pending review|requires human review)\b/.test(text)) {
    return "review needed";
  }
  return "failed";
}

function toolSummaryTitle(
  items: readonly ViewItem[],
): TurnSummaryPresentation["title"] | undefined {
  const recoveredFailures = recoveredToolFailureIndexes(items);
  const outcomes = items.flatMap((item, index) =>
    item.kind === "tool" && !recoveredFailures.has(index) ? [toolOutcome(item)] : [],
  );
  if (outcomes.includes("partial")) return "partial";
  if (outcomes.includes("blocked")) return "blocked";
  if (outcomes.includes("review")) return "review needed";
  if (outcomes.includes("stopped")) return "stopped";
  if (outcomes.includes("skipped")) return "skipped";
  if (outcomes.includes("failed")) return "failed";
  if (outcomes.includes("limited")) return "limited";
  return undefined;
}

function isProblemToolOutcome(outcome: ReturnType<typeof toolOutcome>): boolean {
  return (
    outcome === "partial" ||
    outcome === "blocked" ||
    outcome === "review" ||
    outcome === "stopped" ||
    outcome === "skipped" ||
    outcome === "failed"
  );
}

function lastProblemToolIndex(items: readonly ViewItem[]): number {
  const recoveredFailures = recoveredToolFailureIndexes(items);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (recoveredFailures.has(index)) continue;
    const item = items[index];
    if (item?.kind !== "tool") continue;
    if (isProblemToolOutcome(toolOutcome(item)) || item.status === "error") return index;
  }
  return -1;
}

function hasAnswerAfterProblem(items: readonly ViewItem[]): boolean {
  const problemIndex = lastProblemToolIndex(items);
  if (problemIndex < 0) return false;
  for (let index = items.length - 1; index > problemIndex; index -= 1) {
    const item = items[index];
    if (item?.kind === "message" && item.role === "assistant" && summaryLine(item.content) !== "")
      return true;
  }
  return false;
}

function receiptFor(items: readonly ViewItem[], summary: UiTurnSummary | undefined): string {
  const reconciliation = reconciledToolAttempts(items);
  const recoveredFailures = reconciliation.failureIndexes;
  const counts = toolCounts(items, recoveredFailures);
  const attention = hasAttention(items, summary);
  const summaryAttention = cleanSummaryLines(summary?.attention);
  const attentionLines =
    summary === undefined
      ? items
          .flatMap((item, index): Extract<ViewItem, { kind: "tool" }>[] =>
            item.kind === "tool" && item.status === "error" && !recoveredFailures.has(index)
              ? [item]
              : [],
          )
          .map((item) => `${item.name}: ${item.summary}`)
      : summaryAttention;
  const answer = summary?.answer ?? lastAssistantLine(items);
  const toolTitle = toolSummaryTitle(items);
  const title =
    toolTitle !== undefined
      ? hasAnswerAfterProblem(items)
        ? "needs attention"
        : toolTitle
      : attention
        ? attentionTitle(
            attentionLines,
            summary?.title === "needs attention" ? "failed" : "review needed",
          )
        : "done";
  const summaryFileEvidence =
    summary?.fileEvidence?.filter((entry) => summaryLine(entry.text).length > 0) ?? [];
  const fileEvidence = Math.max(
    counts.fileEvidence,
    summaryFileEvidence.filter((entry) => entry.status === "available").length,
  );
  const observationsUnavailable = Math.max(
    counts.observationsUnavailable,
    summaryFileEvidence.filter((entry) => entry.status === "unavailable").length,
  );
  const checked = Math.max(counts.checked, cleanSummaryLines(summary?.checked).length);
  const ran = Math.max(counts.ran, cleanSummaryLines(summary?.ran).length);
  const automatic = cleanSummaryLines(summary?.automatic).length;
  const failed = Math.max(counts.failed, summaryAttention.length);
  const parts = [
    title,
    answer !== undefined ? "answered" : undefined,
    fileEvidence > 0 ? `file evidence ${fileEvidence}` : undefined,
    checked > 0 ? `checked ${checked}` : undefined,
    ran > 0 ? `ran ${ran}` : undefined,
    automatic > 0 ? `automatic ${automatic}` : undefined,
    reconciliation.recoveredCount > 0
      ? `recovered ${String(reconciliation.recoveredCount)}`
      : undefined,
    failed > 0 ? `failed ${failed}` : undefined,
    counts.limited > 0 ? `limited ${counts.limited}` : undefined,
    counts.partial > 0 ? `partial ${counts.partial}` : undefined,
    counts.otherTools > 0 ? `tools ${counts.otherTools}` : undefined,
    observationsUnavailable > 0 ? `observations unavailable ${observationsUnavailable}` : undefined,
    attention ? "next: review evidence before retrying" : undefined,
  ];
  return parts.filter((p): p is string => p !== undefined && p.length > 0).join(" · ");
}

function reviewReason(what: string): string {
  const lower = what.toLowerCase();
  if (lower.includes(TUI_TERMINAL_REVIEW_TRUTH.summaryPrefix)) {
    return TUI_TERMINAL_REVIEW_TRUTH.reason;
  }
  if (/target may have changed/u.test(lower))
    return "execution failed after mutation began; final target state is unknown";
  if (/blocked by (?:warden|policy)|\bpol-\d+ deny\b|denied by warden/u.test(lower))
    return "the warden denied the action before execution";
  if (/review|approval|requires human/u.test(lower))
    return "the warden required a human decision; this result was not executed";
  if (/skipped|not executed/u.test(lower)) return "the tool did not run after the turn halted";
  return "action did not complete cleanly";
}

function reviewNextAction(what: string): string {
  const lower = what.toLowerCase();
  if (lower.includes(TUI_TERMINAL_REVIEW_TRUTH.summaryPrefix)) {
    return TUI_TERMINAL_REVIEW_TRUTH.recovery;
  }
  if (/target may have changed/u.test(lower)) return "inspect the target before retrying";
  if (
    /\b(blocked by (?:warden|policy)|pol-\d+\s+deny|\bdeny:|denied by warden|warden denied)\b/.test(
      lower,
    )
  ) {
    return "fix the request or command, then retry";
  }
  if (/\b(review|approval|approve|deny)\b/.test(lower)) {
    return "no live approval · simplify the request, then rerun";
  }
  if (/\b(interrupted|stopped|run ended)\b/.test(lower)) {
    return "inspect the note above, then continue or retry";
  }
  if (/^(?:[^:]+:\s*)?skipped:/u.test(lower)) return "change approach before retrying";
  if (/^(?:[^:]+:\s*)?aborted:/u.test(lower)) return "continue when ready";
  return "fix the request or command, then retry";
}

function evidenceProblemKind(
  text: string,
): Extract<TurnEvidenceKind, "partial" | "review" | "blocked" | "skipped" | "failed" | "stopped"> {
  const normalized = summaryLine(text).toLowerCase();
  if (/^(?:[^:]+:\s*)?skipped:/u.test(normalized)) return "skipped";
  const title = attentionTitle([text]);
  if (title === "review needed") return "review";
  if (title === "done" || title === "limited" || title === "needs attention") return "failed";
  return title;
}

function toolProblemReason(
  outcome: Extract<
    TurnEvidenceKind,
    "partial" | "review" | "blocked" | "skipped" | "failed" | "stopped"
  >,
  detail = "",
  reviewSettlement?: ReviewSettlementPresentationOutcome,
): string {
  if (outcome === "partial" && reviewSettlement === "partial") {
    return "review settlement crossed the deadline; final execution state is unknown";
  }
  if (outcome === "partial")
    return "execution failed after mutation began; final target state is unknown";
  if (
    outcome === "blocked" &&
    detail.toLowerCase().includes(TUI_TERMINAL_REVIEW_TRUTH.summaryPrefix)
  ) {
    return TUI_TERMINAL_REVIEW_TRUTH.reason;
  }
  if (outcome === "blocked") return "the warden denied the action before execution";
  if (outcome === "review")
    return "the warden required a human decision; this result was not executed";
  if (outcome === "skipped") return "the tool did not run after the turn halted";
  if (outcome === "stopped") return "the turn stopped before the tool completed";
  return "action did not complete cleanly";
}

const WARDEN_DENIAL_PREFIX = "blocked by warden (not executed):";
const WARDEN_RECOVERY_UNAVAILABLE =
  "Warden recovery guidance unavailable · inspect /why-blocked before retrying";

function wardenDenialRecovery(detail: string): string | undefined {
  const oneLine = summaryLine(detail);
  if (!oneLine.startsWith(WARDEN_DENIAL_PREFIX)) return undefined;
  const guidance = oneLine.slice(WARDEN_DENIAL_PREFIX.length).trim();
  if (guidance.length === 0 || /^(?:blocked|denied|policy deny|policy denied)$/iu.test(guidance)) {
    return WARDEN_RECOVERY_UNAVAILABLE;
  }
  return truncateProblemLine(redactText(guidance), MAX_EVIDENCE_TEXT);
}

function toolProblemNext(
  outcome: Extract<
    TurnEvidenceKind,
    "partial" | "review" | "blocked" | "skipped" | "failed" | "stopped"
  >,
  detail = "",
  reviewSettlement?: ReviewSettlementPresentationOutcome,
): string {
  const reviewRecovery = reviewSettlementRecovery(reviewSettlement);
  if (reviewRecovery !== undefined) return reviewRecovery;
  if (outcome === "partial") return "inspect the target before retrying";
  if (outcome === "review") return "no live approval · simplify the request, then rerun";
  if (outcome === "blocked") {
    if (detail.toLowerCase().includes(TUI_TERMINAL_REVIEW_TRUTH.summaryPrefix)) {
      return TUI_TERMINAL_REVIEW_TRUTH.recovery;
    }
    if (/review closed as denied/iu.test(detail)) {
      return "no review pending · simplify the request or rerun with a live approval surface";
    }
    const denialRecovery = wardenDenialRecovery(detail);
    if (denialRecovery !== undefined) return denialRecovery;
    return "fix the request or command, then retry";
  }
  if (outcome === "skipped") return "change approach before retrying";
  if (outcome === "stopped") return "continue when ready";
  return "fix the request or command, then retry";
}

function reviewDetailKey(what: string): string {
  return what.replace(/\s+/g, " ").trim().toLowerCase();
}

function countedReviewDetails(
  attention: readonly string[],
): readonly { what: string; count: number; identity: string }[] {
  const details: { what: string; count: number; identity: string }[] = [];
  const indexes = new Map<string, number>();
  for (const raw of attention) {
    const identity = summaryLine(raw);
    const what = compactProblemLine(raw);
    if (what.length === 0) continue;
    const existing = indexes.get(identity);
    if (existing !== undefined) {
      const existingDetail = details[existing];
      if (existingDetail !== undefined) {
        details[existing] = { ...existingDetail, count: existingDetail.count + 1 };
      }
      continue;
    }
    indexes.set(identity, details.length);
    details.push({ what, count: 1, identity });
  }

  const visibleGroups = new Map<string, number[]>();
  for (let index = 0; index < details.length; index += 1) {
    const detail = details[index];
    if (detail === undefined) continue;
    const key = reviewDetailKey(detail.what);
    visibleGroups.set(key, [...(visibleGroups.get(key) ?? []), index]);
  }

  return details.map((detail, index) => {
    const group = visibleGroups.get(reviewDetailKey(detail.what)) ?? [index];
    const position = group.indexOf(index);
    const peers = group.flatMap((groupIndex) => {
      const peer = details[groupIndex];
      return peer === undefined ? [] : [peer.identity];
    });
    const excerpt = distinguishingExcerpt(detail.identity, peers);
    const marker =
      group.length > 1 ? ` [detail: ${excerpt}] [distinct ${position + 1}/${group.length}]` : "";
    return {
      what:
        marker.length > 0
          ? `${truncateProblemLine(detail.what, MAX_EVIDENCE_TEXT - marker.length)}${marker}`
          : detail.what,
      count: detail.count,
      identity: detail.identity,
    };
  });
}

function distinguishingExcerpt(value: string, peers: readonly string[]): string {
  let prefix = 0;
  while (prefix < value.length && peers.every((peer) => peer[prefix] === value[prefix]))
    prefix += 1;

  let suffix = 0;
  while (
    suffix < value.length - prefix &&
    peers.every((peer) => peer[peer.length - 1 - suffix] === value[value.length - 1 - suffix])
  ) {
    suffix += 1;
  }

  const start = Math.max(0, prefix - 16);
  const end = Math.min(value.length, value.length - suffix + 16);
  const excerpt = summaryLine(value.slice(start, end))
    .replace(/\[[a-z?]\]/giu, "")
    .replace(/\ballow:\s*keel approve\b.*$/iu, "")
    .trim();
  return truncateProblemLine(excerpt.length > 0 ? excerpt : "different detail", 48);
}

export function reviewNeededDetails(attention: readonly string[]): readonly ReviewNeededDetail[] {
  return countedReviewDetails(attention).map(({ what, count }) => {
    const countedWhat = count > 1 ? `${what} (${count} times)` : what;
    return {
      what: countedWhat,
      why: reviewReason(what),
      next: reviewNextAction(what),
    };
  });
}

function cleanSummaryLines(lines: readonly string[] | undefined): readonly string[] {
  return (lines ?? []).map(summaryLine).filter((line) => line.length > 0);
}

const MAX_SUMMARY_CATEGORY_ITEMS = 3;

function boundedSummaryLines(
  lines: readonly string[] | undefined,
  singular: string,
  plural: string,
): readonly string[] {
  const clean = cleanSummaryLines(lines);
  if (clean.length <= MAX_SUMMARY_CATEGORY_ITEMS) return clean;
  const hidden = clean.length - MAX_SUMMARY_CATEGORY_ITEMS;
  return [
    ...clean.slice(0, MAX_SUMMARY_CATEGORY_ITEMS),
    `… ${String(hidden)} more ${hidden === 1 ? singular : plural}`,
  ];
}

function boundedFileEvidence(entries: UiTurnSummary["fileEvidence"]): {
  readonly items: readonly TurnFileEvidencePresentation[];
  readonly total: number;
  readonly hidden: number;
  readonly unavailable: number;
} {
  const output: TurnFileEvidencePresentation[] = [];
  const seen = new Set<string>();
  let hidden = 0;
  let hiddenUnavailable = 0;
  let total = 0;
  let unavailable = 0;
  for (const entry of entries ?? []) {
    const text = summaryLine(entry.text);
    if (text.length === 0) continue;
    total += 1;
    if (entry.status === "unavailable") unavailable += 1;
    const identity = `${entry.status}:${text}`;
    if (output.length < MAX_SUMMARY_CATEGORY_ITEMS && !seen.has(identity)) {
      output.push({ status: entry.status, text });
      seen.add(identity);
    } else {
      hidden += 1;
      if (entry.status === "unavailable") hiddenUnavailable += 1;
    }
  }
  if (hidden > 0) {
    output.push({
      status: "more",
      text: `… ${String(hidden)} more ${hidden === 1 ? "file observation" : "file observations"}${hiddenUnavailable > 0 ? ` · ${String(hiddenUnavailable)} unavailable` : ""}`,
    });
  }
  return { items: output, total, hidden, unavailable };
}

function addEvidenceLine(
  lines: TurnEvidenceLine[],
  seen: Set<string>,
  line: TurnEvidenceLine,
): void {
  const text = summaryLine(line.text);
  if (text.length === 0) return;
  const why = line.why !== undefined ? summaryLine(line.why) : undefined;
  const next = line.next !== undefined ? summaryLine(line.next) : undefined;
  const key = `${line.kind}:${text}:${why ?? ""}:${next ?? ""}`;
  const occurrenceSensitive =
    line.kind === "file-evidence" ||
    line.kind === "file-evidence-unavailable" ||
    line.kind === "ran";
  if (!occurrenceSensitive && seen.has(key)) return;
  seen.add(key);
  lines.push({
    kind: line.kind,
    text,
    ...(why !== undefined && why.length > 0 ? { why } : {}),
    ...(next !== undefined && next.length > 0 ? { next } : {}),
  });
}

function toolEvidenceLine(
  item: Extract<ViewItem, { kind: "tool" }>,
  options: { readonly checked: ReadonlySet<string> },
): TurnEvidenceLine | undefined {
  const name = summaryLine(item.name);
  const summary = summaryLine(item.summary);
  const subject = item.subject === undefined ? "" : summaryLine(item.subject);
  const outcome = toolOutcome(item);
  if (outcome === "running") return undefined;
  if (
    outcome === "review" ||
    outcome === "blocked" ||
    outcome === "partial" ||
    outcome === "skipped" ||
    outcome === "stopped" ||
    outcome === "failed"
  ) {
    const problemOutcome = outcome;
    const reviewSettlement = reviewSettlementPresentation(item);
    const text = compactProblemLine(`${name}: ${summary.length > 0 ? summary : "failed"}`);
    return {
      kind: problemOutcome,
      text,
      why: toolProblemReason(problemOutcome, summary, reviewSettlement),
      next: toolProblemNext(problemOutcome, summary, reviewSettlement),
    };
  }
  if (outcome === "limited") {
    return {
      kind: "limited",
      text: truncateProblemLine(
        `${name}: ${summary.length > 0 ? summary : "limited"}`,
        MAX_EVIDENCE_TEXT,
      ),
      why: "output was bounded; this result is incomplete",
      next: "narrow the request for complete output",
    };
  }
  if (item.name === "edit" || item.name === "write") {
    const evidence = mutationReceiptEvidence(item);
    if (evidence === undefined) return undefined;
    return {
      kind: evidence.status === "available" ? "file-evidence" : "file-evidence-unavailable",
      text: evidence.text,
    };
  }
  if (item.name === "bash" || item.name === "process.run") {
    const text = `${name}: ${summary.length > 0 ? summary : "done"}`;
    return options.checked.has(text) ? undefined : { kind: "ran", text };
  }
  const target = subject.length > 0 ? subject : summary;
  return { kind: "tool", text: `${name}: ${target.length > 0 ? target : "done"}` };
}

type RoutineObservationTool = "read" | "search";

interface ToolEvidenceEntry {
  readonly line: TurnEvidenceLine;
  readonly receipt: string;
  readonly rawText: string;
  readonly routineObservation?: {
    readonly tool: RoutineObservationTool;
    readonly detail: string;
  };
}

/** Collapse only repeated, controller-settled trusted observations. Counts remain occurrence-true;
 * examples are source ordered and bounded after the count-bearing prefix. Consequential outcomes
 * never reach this path because their evidence kind is not `tool`. */
function groupedRoutineObservationEntries(
  entries: readonly ToolEvidenceEntry[],
): readonly ToolEvidenceEntry[] {
  const groups = new Map<RoutineObservationTool, ToolEvidenceEntry[]>();
  for (const entry of entries) {
    const observation = entry.routineObservation;
    if (observation === undefined) continue;
    const group = groups.get(observation.tool) ?? [];
    group.push(entry);
    groups.set(observation.tool, group);
  }

  const emitted = new Set<RoutineObservationTool>();
  return entries.flatMap((entry): ToolEvidenceEntry[] => {
    const observation = entry.routineObservation;
    if (observation === undefined) return [entry];
    const group = groups.get(observation.tool) ?? [entry];
    if (group.length < 2) return [entry];
    if (emitted.has(observation.tool)) return [];
    emitted.add(observation.tool);

    const examples = [...new Set(group.map((candidate) => candidate.routineObservation?.detail))]
      .filter((detail): detail is string => detail !== undefined && detail.length > 0)
      .slice(0, 2);
    const exampleLabel = examples.length === 1 ? "example" : "examples";
    const exampleText = examples.length === 0 ? "" : ` · ${exampleLabel}: ${examples.join("; ")}`;
    const text = truncateDisplayCells(
      `${observation.tool}: ${String(group.length)} successful observations${exampleText}`,
      MAX_EVIDENCE_TEXT,
    );
    return [
      {
        line: { kind: "tool", text },
        receipt: text.toLowerCase(),
        rawText: text,
      },
    ];
  });
}

/** Exact planner-owned evidence identity for one raw tool card. Headless detail-mode deduplication
 * uses this instead of reconstructing or prefix-matching text independently. */
export function toolEvidenceLineForItem(
  item: Extract<ViewItem, { kind: "tool" }>,
): TurnEvidenceLine | undefined {
  return toolEvidenceLine(item, { checked: new Set<string>() });
}

function isProblemEvidenceKind(
  kind: TurnEvidenceKind,
): kind is Extract<
  TurnEvidenceKind,
  "partial" | "review" | "blocked" | "skipped" | "failed" | "stopped"
> {
  return (
    kind === "partial" ||
    kind === "review" ||
    kind === "blocked" ||
    kind === "skipped" ||
    kind === "failed" ||
    kind === "stopped"
  );
}

function countedTypedProblemLines(
  entries: readonly { readonly line: TurnEvidenceLine; readonly rawText: string }[],
): readonly TurnEvidenceLine[] {
  const lines: { readonly line: TurnEvidenceLine; readonly firstIndex: number }[] = [];
  for (const kind of ["partial", "review", "blocked", "skipped", "failed", "stopped"] as const) {
    const matching = entries.filter((entry) => entry.line.kind === kind);
    for (const detail of countedReviewDetails(matching.map((entry) => entry.rawText))) {
      const representative = entries.find(
        (entry) => entry.line.kind === kind && summaryLine(entry.rawText) === detail.identity,
      );
      lines.push({
        firstIndex: representative === undefined ? -1 : entries.indexOf(representative),
        line: {
          kind,
          text: detail.count > 1 ? `${detail.what} (${detail.count} times)` : detail.what,
          why: representative?.line.why ?? toolProblemReason(kind),
          next: representative?.line.next ?? toolProblemNext(kind),
        },
      });
    }
  }
  return lines.sort((a, b) => a.firstIndex - b.firstIndex).map(({ line }) => line);
}

function turnEvidencePresentation(
  items: readonly ViewItem[],
  summary: UiTurnSummary | undefined,
  density: UiDensity,
  options: { readonly deferExploratoryFailures?: boolean } = {},
): TurnEvidencePresentation | undefined {
  const reconciliation = reconciledToolAttempts(items);
  const recoveredFailures = reconciliation.failureIndexes;
  const lines: TurnEvidenceLine[] = [];
  const seen = new Set<string>();
  const add = (line: TurnEvidenceLine): void => addEvidenceLine(lines, seen, line);
  const checkedSet = new Set(cleanSummaryLines(summary?.checked));
  const toolLines = items.flatMap((item, index): ToolEvidenceEntry[] => {
    if (item.kind !== "tool") return [];
    if (recoveredFailures.has(index)) return [];
    if (options.deferExploratoryFailures === true && isRecoverableExploratoryFailure(item))
      return [];
    const line = toolEvidenceLine(item, { checked: checkedSet });
    const rawText = `${summaryLine(item.name)}: ${summaryLine(item.summary) || "failed"}`;
    if (line === undefined) return [];
    const routineTool =
      line.kind === "tool" && (item.name === "read" || item.name === "search")
        ? item.name
        : undefined;
    const prefix = routineTool === undefined ? "" : `${routineTool}: `;
    const detail =
      routineTool !== undefined && line.text.startsWith(prefix)
        ? line.text.slice(prefix.length)
        : line.text;
    return [
      {
        line,
        receipt: toolReceiptForMatch(item),
        rawText,
        ...(routineTool === undefined ? {} : { routineObservation: { tool: routineTool, detail } }),
      },
    ];
  });
  const unmatchedToolLines = [...toolLines];
  const typedProblems: { readonly line: TurnEvidenceLine; readonly rawText: string }[] = [];

  for (const fileEvidence of summary?.fileEvidence ?? []) {
    const text = summaryLine(fileEvidence.text);
    if (text.length === 0) continue;
    const receipt = text.toLowerCase();
    const match = unmatchedToolLines.findIndex(
      (entry) =>
        summaryLine(entry.line.text).toLowerCase() === receipt &&
        (fileEvidence.status === "available"
          ? entry.line.kind === "file-evidence"
          : entry.line.kind === "file-evidence-unavailable"),
    );
    if (match < 0) {
      add({
        kind: fileEvidence.status === "available" ? "file-evidence" : "file-evidence-unavailable",
        text,
      });
      continue;
    }
    const [matched] = unmatchedToolLines.splice(match, 1);
    if (matched !== undefined) add(matched.line);
  }

  for (const changed of cleanSummaryLines(summary?.changed)) {
    const receipt = changed.toLowerCase();
    const match = unmatchedToolLines.findIndex((entry) => entry.receipt === receipt);
    if (match < 0) {
      add({ kind: "changed", text: changed });
      continue;
    }
    const [matched] = unmatchedToolLines.splice(match, 1);
    if (matched !== undefined) add(matched.line);
  }
  for (const checked of checkedSet) add({ kind: "checked", text: checked });
  for (const receipt of reconciliation.receiptLines) {
    const prefix = "recovered · ";
    if (receipt.startsWith(prefix)) {
      add({ kind: "recovered", text: receipt.slice(prefix.length) });
    }
  }
  const unmatchedAttention: string[] = [];
  for (const raw of summary?.attention ?? []) {
    const receipt = summaryLine(raw).toLowerCase();
    const match = unmatchedToolLines.findIndex((entry) => entry.receipt === receipt);
    if (match < 0) {
      unmatchedAttention.push(raw);
      continue;
    }
    const [matched] = unmatchedToolLines.splice(match, 1);
    if (matched !== undefined) {
      if (isProblemEvidenceKind(matched.line.kind)) typedProblems.push(matched);
      else add(matched.line);
    }
  }
  for (const raw of summary?.ran ?? []) {
    const receipt = summaryLine(raw).toLowerCase();
    const match = unmatchedToolLines.findIndex((entry) => entry.receipt === receipt);
    if (match < 0) continue;
    unmatchedToolLines.splice(match, 1);
  }
  for (const detail of reviewNeededDetails(unmatchedAttention)) {
    add({
      kind: evidenceProblemKind(detail.what),
      text: detail.what,
      why: detail.why,
      next: detail.next,
    });
  }

  const visibleToolLines =
    density === "verbose" || density === "debug"
      ? unmatchedToolLines
      : groupedRoutineObservationEntries(unmatchedToolLines);
  for (const entry of visibleToolLines) {
    if (isProblemEvidenceKind(entry.line.kind)) typedProblems.push(entry);
    else add(entry.line);
  }
  for (const line of countedTypedProblemLines(typedProblems)) add(line);

  const visibleLines = boundedEvidenceLines(
    lines.sort((a, b) => evidenceKindRank(a.kind) - evidenceKindRank(b.kind)),
  );
  const densityLines =
    density === "quiet"
      ? visibleLines.filter(
          (line) =>
            line.kind === "review" ||
            line.kind === "blocked" ||
            line.kind === "limited" ||
            line.kind === "partial" ||
            line.kind === "skipped" ||
            line.kind === "failed" ||
            line.kind === "stopped" ||
            line.kind === "recovered" ||
            (line.kind === "more" && line.omitted?.group === "failed"),
        )
      : visibleLines;
  return densityLines.length > 0 ? { title: "evidence", lines: densityLines } : undefined;
}

type EvidenceCapGroup = "file" | "ran" | "failed";

function evidenceCapGroup(kind: TurnEvidenceKind): EvidenceCapGroup | undefined {
  if (kind === "file-evidence" || kind === "file-evidence-unavailable") return "file";
  if (kind === "ran") return "ran";
  if (isProblemEvidenceKind(kind) || kind === "limited") return "failed";
  return undefined;
}

function evidenceMoreText(group: EvidenceCapGroup, hidden: number, unavailable: number): string {
  if (group === "file")
    return `… ${String(hidden)} more ${hidden === 1 ? "file observation" : "file observations"}${unavailable > 0 ? ` · ${String(unavailable)} unavailable` : ""}`;
  if (group === "ran") return `… ${String(hidden)} more ${hidden === 1 ? "command" : "commands"}`;
  return `… ${String(hidden)} more ${hidden === 1 ? "failed item" : "failed items"}`;
}

function boundedEvidenceLines(lines: readonly TurnEvidenceLine[]): readonly TurnEvidenceLine[] {
  const output: TurnEvidenceLine[] = [];
  let activeGroup: EvidenceCapGroup | undefined;
  let visible = 0;
  let hidden = 0;
  let hiddenUnavailable = 0;
  let seen = new Set<string>();
  const flush = (): void => {
    if (activeGroup !== undefined && hidden > 0) {
      output.push({
        kind: "more",
        text: evidenceMoreText(activeGroup, hidden, hiddenUnavailable),
        omitted: {
          group: activeGroup,
          count: hidden,
          ...(activeGroup === "file" && hiddenUnavailable > 0
            ? { unavailableCount: hiddenUnavailable }
            : {}),
        },
      });
    }
    activeGroup = undefined;
    visible = 0;
    hidden = 0;
    hiddenUnavailable = 0;
    seen = new Set<string>();
  };

  for (const line of lines) {
    const group = evidenceCapGroup(line.kind);
    if (group !== activeGroup) flush();
    if (group === undefined) {
      output.push(line);
      continue;
    }
    activeGroup = group;
    const identity = `${line.kind}:${line.text}:${line.why ?? ""}:${line.next ?? ""}`;
    if (visible < MAX_SUMMARY_CATEGORY_ITEMS && !seen.has(identity)) {
      output.push(line);
      seen.add(identity);
      visible += 1;
    } else {
      hidden += 1;
      if (group === "file" && line.kind === "file-evidence-unavailable") {
        hiddenUnavailable += 1;
      }
    }
  }
  flush();
  return output;
}

function evidenceKindRank(kind: TurnEvidenceKind): number {
  if (kind === "file-evidence") return 0;
  if (kind === "file-evidence-unavailable") return 1;
  if (kind === "recovered") return 2;
  if (kind === "changed") return 3;
  if (kind === "checked") return 4;
  if (kind === "ran") return 5;
  if (kind === "tool") return 6;
  if (kind === "limited") return 7;
  return 8;
}

function consequentialEvidence(
  evidence: TurnEvidencePresentation | undefined,
): TurnEvidencePresentation | undefined {
  if (evidence === undefined) return undefined;
  const lines = evidence.lines.filter(
    (line) =>
      line.kind === "limited" ||
      line.kind === "partial" ||
      line.kind === "review" ||
      line.kind === "blocked" ||
      line.kind === "skipped" ||
      line.kind === "failed" ||
      line.kind === "stopped" ||
      (line.kind === "more" && line.omitted?.group === "failed"),
  );
  return lines.length > 0 ? { ...evidence, lines } : undefined;
}

function toolReceiptForMatch(item: Extract<ViewItem, { kind: "tool" }>): string {
  const name = item.status === "error" ? summaryLine(item.name) : truncateLine(item.name, 32);
  const summary =
    item.status === "error" ? summaryLine(item.summary) : truncateProblemLine(item.summary, 96);
  return summaryLine(
    summary.length > 0 ? `${name}: ${summary}` : `${name}: completed`,
  ).toLowerCase();
}

export function turnSummaryPresentation(summary: UiTurnSummary): TurnSummaryPresentation {
  const automatic = cleanSummaryLines(summary.automatic);
  const changed = boundedSummaryLines(summary.changed, "changed item", "changed items");
  const checked = boundedSummaryLines(summary.checked, "check", "checks");
  const fileEvidencePlan = boundedFileEvidence(summary.fileEvidence);
  const fileEvidence = fileEvidencePlan.items;
  const ranCount = cleanSummaryLines(summary.ran).length;
  const ran = boundedSummaryLines(summary.ran, "command", "commands");
  const receipt = cleanSummaryLines(summary.receipt);
  const attentionLines = cleanSummaryLines(summary.attention);
  const attention = reviewNeededDetails(attentionLines.slice(0, MAX_SUMMARY_CATEGORY_ITEMS));
  const answer = summary.answer === undefined ? undefined : summaryLine(summary.answer);
  const hasControllerVerification =
    checked.length > 0 || receipt.some((line) => /^verification\s*·/iu.test(line));
  const verification =
    fileEvidence.length > 0 && !hasControllerVerification && ranCount === 0
      ? ["verification not run"]
      : [];
  const recovery = fileEvidence.length > 0 ? [TUI_MANUAL_RECOVERY_GUIDANCE] : [];
  return {
    title:
      summary.title === "needs attention"
        ? attentionTitle(summary.attention.length > 0 ? summary.attention : receipt)
        : "done",
    ...(answer !== undefined ? { answer } : {}),
    changed,
    checked,
    ...(fileEvidence.length > 0 ? { fileEvidence } : {}),
    ...(fileEvidencePlan.total > 0
      ? {
          fileEvidenceCount: fileEvidencePlan.total,
          fileEvidenceHidden: fileEvidencePlan.hidden,
          fileEvidenceUnavailableCount: fileEvidencePlan.unavailable,
        }
      : {}),
    ...(verification.length > 0 ? { verification } : {}),
    ...(recovery.length > 0 ? { recovery } : {}),
    ...(ran.length > 0 ? { ran } : {}),
    ...(ranCount > 0 ? { ranCount, ranHidden: Math.max(0, ranCount - 3) } : {}),
    ...(attentionLines.length > 0 ? { attentionCount: attentionLines.length } : {}),
    ...(automatic.length > 0 ? { automatic } : {}),
    ...(receipt.length > 0 ? { receipt } : {}),
    attention,
  };
}

function attachedTurnSummaryPresentation(
  summary: UiTurnSummary,
  items: readonly ViewItem[],
  omitAttention: boolean,
): TurnSummaryPresentation {
  const presentation = turnSummaryPresentation(summary);
  const repeatedAnswer =
    presentation.answer !== undefined && presentation.answer === lastAssistantLine(items);
  return {
    title: presentation.title,
    ...(!repeatedAnswer && presentation.answer !== undefined
      ? { answer: presentation.answer }
      : {}),
    changed: presentation.changed,
    checked: presentation.checked,
    ...(presentation.fileEvidence !== undefined ? { fileEvidence: presentation.fileEvidence } : {}),
    ...(presentation.fileEvidenceCount !== undefined
      ? { fileEvidenceCount: presentation.fileEvidenceCount }
      : {}),
    ...(presentation.fileEvidenceHidden !== undefined
      ? { fileEvidenceHidden: presentation.fileEvidenceHidden }
      : {}),
    ...(presentation.fileEvidenceUnavailableCount !== undefined
      ? { fileEvidenceUnavailableCount: presentation.fileEvidenceUnavailableCount }
      : {}),
    ...(presentation.verification !== undefined ? { verification: presentation.verification } : {}),
    ...(presentation.recovery !== undefined ? { recovery: presentation.recovery } : {}),
    ...(presentation.ran !== undefined ? { ran: presentation.ran } : {}),
    ...(presentation.ranCount !== undefined ? { ranCount: presentation.ranCount } : {}),
    ...(presentation.ranHidden !== undefined ? { ranHidden: presentation.ranHidden } : {}),
    ...(!omitAttention && presentation.attentionCount !== undefined
      ? { attentionCount: presentation.attentionCount }
      : {}),
    ...(presentation.automatic !== undefined ? { automatic: presentation.automatic } : {}),
    ...(presentation.receipt !== undefined ? { receipt: presentation.receipt } : {}),
    attention: omitAttention ? [] : presentation.attention,
  };
}

function summaryWithoutRepeatedEvidence(
  summary: TurnSummaryPresentation,
  evidence: TurnEvidencePresentation | undefined,
): TurnSummaryPresentation {
  if (evidence === undefined) return summary;
  const hasChanged = evidence.lines.some((line) => line.kind === "changed");
  const hasFileEvidence = evidence.lines.some(
    (line) => line.kind === "file-evidence" || line.kind === "file-evidence-unavailable",
  );
  const hasChecked = evidence.lines.some((line) => line.kind === "checked");
  const hasRan = evidence.lines.some((line) => line.kind === "ran");
  const { ran, ...withoutRan } = summary;
  return {
    ...withoutRan,
    changed: hasChanged ? [] : summary.changed,
    checked: hasChecked ? [] : summary.checked,
    ...(summary.fileEvidence !== undefined
      ? { fileEvidence: hasFileEvidence ? [] : summary.fileEvidence }
      : {}),
    ...(hasFileEvidence
      ? {
          fileEvidenceCount: 0,
          fileEvidenceHidden: 0,
          fileEvidenceUnavailableCount: 0,
        }
      : {}),
    ...(!hasRan && ran !== undefined ? { ran } : {}),
  };
}

function runControlReceiptFor(
  summary: TurnSummaryPresentation | undefined,
): readonly string[] | undefined {
  const receipt = summary?.receipt;
  const first = receipt?.[0];
  if (
    first === undefined ||
    !/^(?:goal (?:complete|unverified|incomplete)|loop (?:succeeded|stopped)(?:\s|$))/u.test(first)
  ) {
    return undefined;
  }
  return receipt;
}

function duplicateTextOnlySummary(
  summary: UiTurnSummary | undefined,
  turnItems: readonly ViewItem[],
): boolean {
  if (summary === undefined) return false;
  if (summary.title !== "done") return false;
  if (
    summary.changed.length > 0 ||
    summary.checked.length > 0 ||
    (summary.fileEvidence?.length ?? 0) > 0 ||
    (summary.ran?.length ?? 0) > 0 ||
    (summary.automatic?.length ?? 0) > 0 ||
    (summary.receipt?.length ?? 0) > 0 ||
    summary.attention.length > 0
  ) {
    return false;
  }
  const answer = summary.answer !== undefined ? truncateLine(summary.answer, 96) : undefined;
  if (answer === undefined || answer.length === 0) return true;
  return answer === lastAssistantLine(turnItems);
}

function splitBlocks(
  items: readonly ViewItem[],
  offset = 0,
): readonly (MutableTurn | ConversationItemsBlock)[] {
  const blocks: (MutableTurn | ConversationItemsBlock)[] = [];
  let loose: ViewItem[] = [];
  let looseStartIndex: number | undefined;
  let current: MutableTurn | undefined;

  const flushLoose = (): void => {
    if (loose.length > 0) {
      const startIndex = looseStartIndex ?? offset;
      blocks.push({
        kind: "items",
        id: looseBlockId(startIndex, loose),
        startIndex,
        endIndex: startIndex + loose.length - 1,
        items: loose,
      });
      loose = [];
      looseStartIndex = undefined;
    }
  };
  const flushTurn = (): void => {
    if (current !== undefined) {
      blocks.push(current);
      current = undefined;
    }
  };

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const sourceIndex = offset + i;
    if (isUserMessage(item)) {
      flushLoose();
      flushTurn();
      current = { user: item, items: [], startIndex: sourceIndex, endIndex: sourceIndex };
      continue;
    }
    if (isPostTurnSystemItem(item, current)) {
      flushTurn();
      if (looseStartIndex === undefined) looseStartIndex = sourceIndex;
      loose.push(item);
      continue;
    }
    if (current !== undefined) {
      current.items.push(item);
      current.endIndex = sourceIndex;
    } else {
      if (loose.length > 0 && isLooseSystemItem(item, current)) flushLoose();
      if (looseStartIndex === undefined) looseStartIndex = sourceIndex;
      loose.push(item);
    }
  }
  flushLoose();
  flushTurn();
  return blocks;
}

function recentExpandedCount(density: UiDensity | undefined, hasActiveTurn: boolean): number {
  if (density === "quiet") return hasActiveTurn ? 0 : 1;
  if (density === "verbose" || density === "debug") return Number.POSITIVE_INFINITY;
  return hasActiveTurn ? 2 : 3;
}

function hasReceiptSubstance(
  items: readonly ViewItem[],
  summary: UiTurnSummary | undefined,
): boolean {
  return items.length > 0 || summary !== undefined;
}

export function conversationPlan(
  view: ViewModel,
  options: ConversationPlanOptions = {},
): ConversationPlan {
  const density = view.density ?? "normal";
  const sourceOffset = Math.max(0, Math.min(view.items.length, options.sourceOffset ?? 0));
  const sourceItems = view.items.slice(sourceOffset);
  // Only index-zero system messages can be the hidden system preamble. A suffix beginning with a
  // later provider/warden notice must remain visible rather than being mistaken for scaffolding.
  const leadingSkip =
    options.verbose === true || sourceOffset > 0 ? 0 : leadingSystemEnd(sourceItems);
  const skip = sourceOffset + leadingSkip;
  const rawBlocks = splitBlocks(sourceItems.slice(leadingSkip), skip);
  const turnIndexes = rawBlocks.flatMap((block, i) => ("user" in block ? [i] : []));
  const turnOrdinalByBlockIndex = new Map(
    turnIndexes.map((blockIndex, turnIndex) => [blockIndex, turnIndex]),
  );
  const activeBlockIndex =
    (view.currentTurn !== undefined || view.streaming) && turnIndexes.length > 0
      ? turnIndexes[turnIndexes.length - 1]
      : undefined;
  const nonActiveTurnIndexes = turnIndexes.filter((i) => i !== activeBlockIndex);
  const recentCount = recentExpandedCount(density, activeBlockIndex !== undefined);
  const recentSet = new Set(recentCount === 0 ? [] : nonActiveTurnIndexes.slice(-recentCount));
  const lastTurnIndex = turnIndexes.at(-1);
  const attachedSummary =
    view.turnSummary !== undefined && lastTurnIndex !== undefined
      ? duplicateTextOnlySummary(view.turnSummary, [
          (rawBlocks[lastTurnIndex] as MutableTurn).user,
          ...(rawBlocks[lastTurnIndex] as MutableTurn).items,
        ])
        ? undefined
        : view.turnSummary
      : undefined;

  const blocks = rawBlocks.map((block, blockIndex): ConversationBlock => {
    if (!("user" in block)) {
      const evidence = turnEvidencePresentation(block.items, undefined, density);
      return {
        ...block,
        ...(evidence !== undefined ? { evidence } : {}),
        ...(evidence?.lines.some((line) => line.kind === "skipped" || line.kind === "stopped") ===
        true
          ? { suppressProblemTools: true }
          : {}),
      };
    }
    const rawSummary = blockIndex === lastTurnIndex ? attachedSummary : undefined;
    const recency: ConversationRecency =
      blockIndex === activeBlockIndex ? "active" : recentSet.has(blockIndex) ? "recent" : "older";
    const deferExploratoryFailures =
      recency === "active" && rawSummary === undefined && view.awaitingInput !== true;
    const allEvidence = turnEvidencePresentation(block.items, rawSummary, density, {
      deferExploratoryFailures,
    });
    const evidence =
      recency === "active" && rawSummary === undefined && view.awaitingInput !== true
        ? consequentialEvidence(allEvidence)
        : allEvidence;
    const canonicalAttention =
      allEvidence?.lines.some(
        (line) =>
          line.kind === "review" ||
          line.kind === "blocked" ||
          line.kind === "partial" ||
          line.kind === "skipped" ||
          line.kind === "failed" ||
          line.kind === "stopped",
      ) === true;
    const baseSummary =
      rawSummary !== undefined
        ? summaryWithoutRepeatedEvidence(
            attachedTurnSummaryPresentation(rawSummary, block.items, canonicalAttention),
            evidence,
          )
        : undefined;
    const evidenceTitle: TurnSummaryPresentation["title"] | undefined =
      evidence?.lines.some((line) => line.kind === "partial") === true
        ? "partial"
        : evidence?.lines.some((line) => line.kind === "blocked") === true
          ? "blocked"
          : evidence?.lines.some((line) => line.kind === "review") === true
            ? "review needed"
            : evidence?.lines.some((line) => line.kind === "stopped") === true
              ? "stopped"
              : evidence?.lines.some((line) => line.kind === "skipped") === true
                ? "skipped"
                : evidence?.lines.some((line) => line.kind === "failed") === true
                  ? "failed"
                  : evidence?.lines.some((line) => line.kind === "limited") === true
                    ? "limited"
                    : undefined;
    const preserveAnsweredAttention =
      rawSummary?.title === "needs attention" && hasAnswerAfterProblem(block.items);
    const summary =
      baseSummary === undefined
        ? undefined
        : preserveAnsweredAttention
          ? { ...baseSummary, title: "needs attention" as const }
          : evidenceTitle !== undefined
            ? { ...baseSummary, title: evidenceTitle }
            : baseSummary;
    const compactable =
      options.compactHistory !== false &&
      recency === "older" &&
      hasReceiptSubstance(block.items, rawSummary) &&
      !hasAttention(block.items, rawSummary);
    const mode: ConversationMode = compactable ? "compact" : "expanded";
    const runControlReceipt = runControlReceiptFor(summary);
    return {
      kind: "turn",
      id: turnBlockId(block.startIndex, block.user),
      index: turnOrdinalByBlockIndex.get(blockIndex) ?? 0,
      startIndex: block.startIndex,
      endIndex: block.endIndex,
      user: block.user,
      items: block.items,
      recency,
      mode,
      receipt: receiptFor(block.items, rawSummary),
      ...(blockIndex === activeBlockIndex && view.currentTurn !== undefined
        ? { currentTurn: view.currentTurn }
        : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(runControlReceipt !== undefined ? { runControlReceipt } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
      ...((density === "normal" || density === "quiet") && canonicalAttention
        ? { suppressFailedTools: true }
        : {}),
      ...(deferExploratoryFailures && (density === "normal" || density === "quiet")
        ? { suppressExploratoryFailures: true }
        : {}),
      ...(evidence !== undefined
        ? density === "normal" || density === "quiet"
          ? { suppressEvidenceItems: true }
          : {}
        : {}),
    };
  });

  const standaloneSummary =
    view.turnSummary !== undefined && lastTurnIndex === undefined && sourceOffset === 0
      ? turnSummaryPresentation(view.turnSummary)
      : undefined;
  const standaloneRunControlReceipt = runControlReceiptFor(standaloneSummary);
  return {
    blocks,
    showAttentionRail: density === "debug" && (view.attentionRail?.length ?? 0) > 0,
    ...(view.attentionRail !== undefined ? { attentionRail: view.attentionRail } : {}),
    ...(view.currentTurn !== undefined && turnIndexes.length === 0
      ? { standaloneCurrentTurn: view.currentTurn }
      : {}),
    ...(standaloneSummary !== undefined ? { standaloneSummary } : {}),
    ...(standaloneRunControlReceipt !== undefined ? { standaloneRunControlReceipt } : {}),
  };
}

function blockHasRunningTool(block: ConversationBlock): boolean {
  return block.items.some(
    (item) =>
      item.kind === "tool" &&
      (item.status === "running" || item.mutationPresentation?.status === "pending"),
  );
}

function blockContainsStreamingTail(block: ConversationBlock, view: ViewModel): boolean {
  if (!view.streaming || view.items.length === 0) return false;
  const tailIndex = view.items.length - 1;
  return block.startIndex <= tailIndex && tailIndex <= block.endIndex;
}

function isCommitEligible(
  block: ConversationBlock,
  view: ViewModel,
  latestTurnId: string | undefined,
  latestTurnHasTrailingControllerNotice: boolean,
): boolean {
  if (block.kind === "turn" && block.currentTurn !== undefined) return false;
  // A controller-authored notice can follow a settled tool while the same model turn continues.
  // `run-finished` still owns the authoritative summary for the latest user turn, so a trailing
  // loose notice is not by itself an immutable boundary. Keep that turn live until either its
  // summary arrives or the controller explicitly returns to input; an earlier user turn remains
  // safe to commit once a later user turn establishes the real continuation boundary.
  if (
    block.kind === "turn" &&
    block.id === latestTurnId &&
    latestTurnHasTrailingControllerNotice &&
    view.turnSummary === undefined &&
    view.awaitingInput !== true
  ) {
    return false;
  }
  if (
    block.kind === "items" &&
    block.endIndex === view.items.length - 1 &&
    view.awaitingInput === true
  ) {
    return false;
  }
  if (blockHasRunningTool(block)) return false;
  if (blockContainsStreamingTail(block, view)) return false;
  if (
    block.endIndex === view.items.length - 1 &&
    view.turnSummary === undefined &&
    view.awaitingInput !== true
  ) {
    return false;
  }
  return true;
}

export function transcriptCommitPlan(
  view: ViewModel,
  options: ConversationPlanOptions = {},
): TranscriptCommitPlan {
  const plan = conversationPlan(view, options);
  const staticBlocks: ConversationBlock[] = [];
  const liveBlocks: ConversationBlock[] = [];
  let foundLive = false;
  let latestTurnId: string | undefined;
  let latestTurnIndex = -1;
  for (const [index, block] of plan.blocks.entries()) {
    if (block.kind === "turn") {
      latestTurnId = block.id;
      latestTurnIndex = index;
    }
  }
  const latestTurnHasTrailingControllerNotice = plan.blocks
    .slice(latestTurnIndex + 1)
    .some(
      (block) =>
        block.kind === "items" &&
        block.items.some(
          (item) =>
            item.kind === "message" && item.role === "system" && item.presentation === "notice",
        ),
    );

  for (const block of plan.blocks) {
    if (
      !foundLive &&
      isCommitEligible(block, view, latestTurnId, latestTurnHasTrailingControllerNotice)
    ) {
      staticBlocks.push(block);
      continue;
    }
    foundLive = true;
    liveBlocks.push(block);
  }

  return {
    staticBlocks,
    livePlan: {
      ...plan,
      blocks: liveBlocks,
    },
  };
}

function hasRunningToolInItems(items: readonly ViewItem[]): boolean {
  return items.some((item) => item.kind === "tool" && item.status === "running");
}

function planHasRunningTool(plan: TranscriptCommitPlan): boolean {
  return [...plan.staticBlocks, ...plan.livePlan.blocks].some(blockHasRunningTool);
}

function visibleSummaries(plan: TranscriptCommitPlan): readonly TurnSummaryPresentation[] {
  const summaries: TurnSummaryPresentation[] = [];
  for (const block of [...plan.staticBlocks, ...plan.livePlan.blocks]) {
    if (block.kind === "turn" && block.summary !== undefined) summaries.push(block.summary);
  }
  if (plan.livePlan.standaloneSummary !== undefined)
    summaries.push(plan.livePlan.standaloneSummary);
  return summaries;
}

function visibleBlocks(plan: TranscriptCommitPlan): readonly ConversationBlock[] {
  return [...plan.staticBlocks, ...plan.livePlan.blocks];
}

export function screenAnatomyPlan(view: ViewModel): ScreenAnatomyPlan {
  const commitPlan = transcriptCommitPlan(view);
  const blocks = visibleBlocks(commitPlan);
  const summaries = visibleSummaries(commitPlan);
  const hasProblemSummary =
    summaries.some((summary) => summary.title !== "done") ||
    blocks.some((block) => block.kind === "turn" && !block.receipt.startsWith("done"));
  const hasDoneSummary = summaries.some((summary) => summary.title === "done");
  const running =
    view.currentTurn !== undefined ||
    view.streaming ||
    hasRunningToolInItems(view.items) ||
    planHasRunningTool(commitPlan);
  const frame: ScreenAnatomyFrame = running
    ? "running"
    : hasProblemSummary
      ? "review-needed"
      : hasDoneSummary
        ? "done"
        : "idle";
  const regions: ScreenAnatomyRegion[] = [];
  if (view.firstRun && view.items.length === 0) {
    regions.push({ kind: "launch", label: SEMANTIC_TOKENS.roles.assistant.label });
  }

  if (frame === "running") {
    if (commitPlan.staticBlocks.length > 0) {
      regions.push({ kind: "transcript", label: "transcript" });
    }
    regions.push({
      kind: "active-turn",
      label: SEMANTIC_TOKENS.states.running.label,
      state: "running",
    });
  } else if (commitPlan.staticBlocks.length > 0 || commitPlan.livePlan.blocks.length > 0) {
    regions.push({ kind: "transcript", label: "transcript" });
  }

  if (frame === "review-needed") {
    regions.push({
      kind: "review",
      label: SEMANTIC_TOKENS.states.review.label,
      state: "review",
    });
  } else if (frame === "done") {
    regions.push({
      kind: "receipt",
      label: SEMANTIC_TOKENS.states.done.label,
      state: "done",
    });
  }

  regions.push(
    { kind: "status", label: SEMANTIC_TOKENS.roles.status.label },
    { kind: "composer", label: SEMANTIC_TOKENS.roles.composer.label },
    { kind: "hint", label: SEMANTIC_TOKENS.roles.hint.label },
  );

  return { frame, regions };
}

export function visibleTurnItems(
  items: readonly ViewItem[],
  density: ViewModel["density"],
): readonly ViewItem[] {
  return visibleTurnItemsWithIndexes(items, density).map(({ item }) => item);
}

/**
 * Visible item sequence with original transcript indexes for incremental renderers. This applies the
 * same turn boundaries and failure-compaction plan as `conversationPlan`; an incremental sink can
 * therefore advance through raw indexes without inventing a second visibility implementation.
 */
export function visibleConversationItemsWithIndexes(
  view: ViewModel,
  options: { readonly verbose?: boolean; readonly retainSuccessfulTools?: boolean } = {},
): readonly VisibleConversationItem[] {
  const plan = conversationPlan(view, { ...options, compactHistory: false });
  return plan.blocks.flatMap((block) => {
    if (block.kind === "items") {
      return visibleTurnItemsWithIndexes(block.items, view.density, {
        suppressProblemTools: block.suppressProblemTools === true,
        retainDiffTools: view.diffMode === "full",
        retainSuccessfulTools: options.retainSuccessfulTools === true,
      }).map(({ item, index, synthetic, assistantRole }) => ({
        item,
        index: block.startIndex + index,
        synthetic,
        ...(assistantRole === undefined ? {} : { assistantRole }),
      }));
    }
    return [
      { item: block.user, index: block.startIndex, synthetic: false },
      ...visibleTurnItemsWithIndexes(block.items, view.density, {
        suppressFailedTools: block.suppressFailedTools === true,
        suppressEvidenceItems: block.suppressEvidenceItems === true,
        suppressProblemTools: block.suppressProblemTools === true,
        suppressExploratoryFailures: block.suppressExploratoryFailures === true,
        retainDiffTools: view.diffMode === "full",
        retainSuccessfulTools: options.retainSuccessfulTools === true,
      }).map(({ item, index, synthetic, assistantRole }) => ({
        item,
        index: block.startIndex + 1 + index,
        synthetic,
        ...(assistantRole === undefined ? {} : { assistantRole }),
      })),
    ];
  });
}

export function visibleTurnItemsWithIndexes(
  items: readonly ViewItem[],
  density: ViewModel["density"],
  options: {
    readonly suppressFailedTools?: boolean;
    readonly suppressEvidenceItems?: boolean;
    readonly suppressProblemTools?: boolean;
    readonly suppressExploratoryFailures?: boolean;
    readonly retainDiffTools?: boolean;
    readonly retainSuccessfulTools?: boolean;
  } = {},
): readonly VisibleTurnItem[] {
  const compactFailures = density !== "verbose" && density !== "debug";
  const answerFirstDensity = density !== "quiet" && density !== "verbose" && density !== "debug";
  const seenFailureKeys = new Set<string>();
  const pendingCompactions: FailureCompaction[] = [];
  const pendingIndexes = new Map<string, number>();
  const visible: VisibleTurnItem[] = [];
  let pendingAssistantIndexes: number[] = [];
  const recoveredFailures = recoveredToolFailureIndexes(items);
  const hasLaterMeaningfulItem =
    answerFirstDensity && options.retainSuccessfulTools !== true
      ? new Array<boolean>(items.length)
      : undefined;
  if (hasLaterMeaningfulItem !== undefined) {
    let meaningfulItemSeen = false;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      hasLaterMeaningfulItem[index] = meaningfulItemSeen;
      const item = items[index]!;
      if (
        !isHiddenInDensity(item, density) &&
        !isRoutineSuccessfulTool(item) &&
        !(item.kind === "tool" && item.status === "running")
      ) {
        meaningfulItemSeen = true;
      }
    }
  }

  const flushCompactions = (): void => {
    for (const compaction of pendingCompactions) {
      visible.push({
        index: compaction.lastIndex,
        synthetic: true,
        item: {
          kind: "message",
          role: "system",
          content: compactedFailureLine(compaction.count, compaction.recovery),
        },
      });
    }
    pendingCompactions.length = 0;
    pendingIndexes.clear();
  };

  for (const [index, item] of items.entries()) {
    // Presentation roles are derived in this existing linear pass so large transcripts do not pay
    // for a second scan. Typed tool boundaries, never model text, reclassify pending prose.
    if (item.kind === "message" && item.role === "user") {
      pendingAssistantIndexes = [];
    } else if (item.kind === "tool" && pendingAssistantIndexes.length > 0) {
      for (const visibleIndex of pendingAssistantIndexes) {
        const pending = visible[visibleIndex];
        if (pending !== undefined)
          visible[visibleIndex] = { ...pending, assistantRole: "progress" };
      }
      pendingAssistantIndexes = [];
    }
    if (isHiddenInDensity(item, density)) continue;
    if (compactFailures && recoveredFailures.has(index)) continue;
    if (options.suppressExploratoryFailures === true && isRecoverableExploratoryFailure(item)) {
      continue;
    }
    if (options.suppressFailedTools === true && item.kind === "tool" && item.status === "error") {
      continue;
    }
    if (
      options.suppressProblemTools === true &&
      item.kind === "tool" &&
      item.status !== "running" &&
      toolOutcome(item) !== "done" &&
      !(options.retainDiffTools === true && (item.name === "edit" || item.name === "write"))
    ) {
      continue;
    }
    if (options.suppressEvidenceItems === true) {
      if (isTerminalRunNotice(item) && !isCompletionTruthNotice(item)) continue;
      if (
        item.kind === "tool" &&
        item.status !== "running" &&
        !(options.retainSuccessfulTools === true && toolOutcome(item) === "done") &&
        !(options.retainDiffTools === true && (item.name === "edit" || item.name === "write"))
      ) {
        continue;
      }
    }
    if (
      options.retainSuccessfulTools !== true &&
      answerFirstDensity &&
      isRoutineSuccessfulTool(item) &&
      hasLaterMeaningfulItem?.[index] === true
    ) {
      continue;
    }
    const failure = compactFailures ? failureCompaction(item) : undefined;
    if (failure !== undefined) {
      if (seenFailureKeys.has(failure.key)) {
        const pendingIndex = pendingIndexes.get(failure.key);
        if (pendingIndex === undefined) {
          pendingIndexes.set(failure.key, pendingCompactions.length);
          pendingCompactions.push({
            key: failure.key,
            recovery: failure.recovery,
            count: 1,
            lastIndex: index,
          });
        } else {
          const pending = pendingCompactions[pendingIndex];
          if (pending !== undefined) {
            pendingCompactions[pendingIndex] = {
              ...pending,
              count: pending.count + 1,
              lastIndex: index,
            };
          }
        }
        continue;
      }
      seenFailureKeys.add(failure.key);
    }
    flushCompactions();
    const assistant = item.kind === "message" && item.role === "assistant";
    visible.push({
      item,
      index,
      synthetic: false,
      ...(assistant ? { assistantRole: "answer" } : {}),
    });
    if (assistant) pendingAssistantIndexes.push(visible.length - 1);
  }
  flushCompactions();
  return visible;
}

export function isRoutineSuccessfulTool(item: ViewItem): boolean {
  return (
    item.kind === "tool" &&
    toolOutcome(item) === "done" &&
    item.mutationPresentation === undefined &&
    (item.name === "read" ||
      item.name === "search" ||
      item.name === "bash" ||
      item.name === "process.run")
  );
}

type FailureRecovery =
  | "no action needed"
  | "try another way"
  | "blocked until policy/approval changes";

interface FailureCompaction {
  readonly key: string;
  readonly recovery: FailureRecovery;
  readonly count: number;
  readonly lastIndex: number;
}

function compactedFailureLine(count: number, recovery: FailureRecovery): string {
  return `${count} similar tool failure${count === 1 ? "" : "s"} compacted · ${recovery}`;
}

function failureCompaction(
  item: ViewItem,
): { readonly key: string; readonly recovery: FailureRecovery } | undefined {
  if (item.kind !== "tool" || item.status !== "error") return undefined;
  const name = summaryLine(item.name).toLowerCase();
  const summary = summaryLine(item.summary);
  const outcome = toolOutcome(item);
  return {
    key: `${outcome}:${name}:${failureReasonKey(summary)}`,
    recovery:
      outcome === "blocked" || outcome === "review"
        ? "blocked until policy/approval changes"
        : "try another way",
  };
}

function failureReasonKey(summary: string): string {
  return summary.replace(/\s+/g, " ");
}
