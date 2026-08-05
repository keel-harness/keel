import type { JsonObjectT, UiToolActivity, ViewItem } from "@keel/shared";
import { toolOutcome } from "./tool-outcome.js";
import { TUI_TERMINAL_REVIEW_TRUTH } from "./strings.js";

const recoveryIdentityByActivity = new WeakMap<UiToolActivity, string>();
const MAX_RECOVERED_RECEIPT_LINES = 3;
const BOUNDED_RECOVERY_SIBLING_PREFIX = "bounded recovery permits one tool call";

/** Exact, process-local identity for retry reconciliation. Never rendered or persisted. */
export function toolRecoveryIdentityForCall(name: string, args: JsonObjectT): string | undefined {
  if (name !== "edit" && name !== "write") return undefined;
  const path = args["path"];
  return typeof path === "string" ? JSON.stringify([name, path]) : undefined;
}

export function associateToolRecoveryIdentity(
  activity: UiToolActivity,
  identity: string | undefined,
): void {
  if (identity !== undefined) recoveryIdentityByActivity.set(activity, identity);
}

export function transferToolRecoveryIdentity(source: UiToolActivity, target: UiToolActivity): void {
  associateToolRecoveryIdentity(target, recoveryIdentityByActivity.get(source));
}

function isExploratorySuccess(item: ViewItem): boolean {
  return (
    item.kind === "tool" &&
    item.status === "ok" &&
    (item.name === "read" || item.name === "search" || item.name === "bash")
  );
}

export function isRecoverableExploratoryFailure(item: ViewItem): boolean {
  if (item.kind !== "tool" || item.status !== "error") return false;
  if ((item.name !== "read" && item.name !== "search") || toolOutcome(item) !== "failed") {
    return false;
  }
  if (item.name === "read") {
    const summary = item.summary.toLowerCase();
    // A later text read can recover path exploration, but it cannot recover the requested target's
    // content-class refusal. Keep that durable refusal visible even when another file succeeds.
    if (
      summary.includes("binary file; refusing to read") ||
      summary.includes("not complete utf-8 text; refusing to read")
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Returns problem-tool indexes that were superseded by a later successful exploratory path and a
 * final answer. This changes presentation only; the original tool result remains in the ledger and
 * in verbose/debug transcript views.
 */
export function recoveredExploratoryFailureIndexes(
  items: readonly ViewItem[],
): ReadonlySet<number> {
  return reconcileToolAttempts(items, false).recovered;
}

interface RecoveredMutationAttempt {
  readonly successIndex: number;
  readonly name: string;
  readonly subject?: string;
  readonly failedIndexes: readonly number[];
}

interface RecoveredTerminalReviewAttempt {
  readonly failureIndex: number;
  readonly successIndex: number;
  readonly name: string;
  readonly subject?: string;
}

function reconcileToolAttempts(
  items: readonly ViewItem[],
  includeMutationRecovery: boolean,
): {
  readonly recovered: ReadonlySet<number>;
  readonly mutationAttempts: readonly RecoveredMutationAttempt[];
  readonly terminalAttempt?: RecoveredTerminalReviewAttempt;
} {
  const recovered = new Set<number>();
  let answerSeen = false;
  let successfulPathToAnswer = false;
  const laterSuccessByIdentity = new Map<
    string,
    { readonly index: number; readonly item: UiToolActivity }
  >();
  const attemptsBySuccess = new Map<
    number,
    {
      readonly successIndex: number;
      readonly name: string;
      readonly subject?: string;
      readonly failedIndexes: number[];
    }
  >();
  let terminalAttempt: RecoveredTerminalReviewAttempt | undefined;
  let nearestLaterTool: { readonly index: number; readonly item: UiToolActivity } | undefined;
  let toolAfterNearestLaterTool:
    | { readonly index: number; readonly item: UiToolActivity }
    | undefined;
  let userMessageBetweenCurrentAndNearestTool = false;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "message") {
      if (item.role === "assistant" && item.content.trim().length > 0) answerSeen = true;
      if (item.role === "user" && nearestLaterTool !== undefined) {
        userMessageBetweenCurrentAndNearestTool = true;
      }
      continue;
    }
    // The exact no-live-review result is controller-owned presentation derived from a
    // WardenExecutor result. The immediate later tool occurrence can exist only on the bounded
    // recovery lane unless a new user turn intervenes. Same-response assistant narration is not an
    // authority boundary. A successful sole correction may now
    // be followed by ordinary Warden-gated work; failed corrections and bounded siblings remain
    // consequential. This shares the existing reverse pass to preserve linear projection.
    if (
      includeMutationRecovery &&
      terminalAttempt === undefined &&
      answerSeen &&
      nearestLaterTool !== undefined &&
      !userMessageBetweenCurrentAndNearestTool &&
      nearestLaterTool.item.status === "ok" &&
      toolOutcome(nearestLaterTool.item) === "done" &&
      !(
        toolAfterNearestLaterTool?.item.status === "error" &&
        toolOutcome(toolAfterNearestLaterTool.item) === "skipped" &&
        toolAfterNearestLaterTool.item.summary.startsWith(BOUNDED_RECOVERY_SIBLING_PREFIX)
      ) &&
      item.status === "error" &&
      toolOutcome(item) === "blocked" &&
      item.summary.startsWith(TUI_TERMINAL_REVIEW_TRUTH.summaryPrefix)
    ) {
      terminalAttempt = {
        failureIndex: index,
        successIndex: nearestLaterTool.index,
        name: nearestLaterTool.item.name,
        ...(nearestLaterTool.item.subject !== undefined
          ? { subject: nearestLaterTool.item.subject }
          : {}),
      };
      recovered.add(index);
    }
    toolAfterNearestLaterTool = nearestLaterTool;
    nearestLaterTool = { index, item };
    userMessageBetweenCurrentAndNearestTool = false;
    if (answerSeen && isExploratorySuccess(item)) successfulPathToAnswer = true;
    if (successfulPathToAnswer && isRecoverableExploratoryFailure(item)) recovered.add(index);
    if (!includeMutationRecovery) continue;
    const identity = recoveryIdentityByActivity.get(item);
    if (identity === undefined) continue;
    if (item.status === "ok" && toolOutcome(item) === "done") {
      laterSuccessByIdentity.set(identity, { index, item });
      continue;
    }
    // Only a controller-typed terminal non-execution may be superseded here. Ordinary failed,
    // partial, stopped, or indeterminate mutations remain consequential because effects may be
    // unknown; a later success cannot prove their final state.
    if (item.status !== "error" || toolOutcome(item) !== "blocked") continue;
    const success = laterSuccessByIdentity.get(identity);
    if (success === undefined) continue;
    recovered.add(index);
    const current = attemptsBySuccess.get(success.index);
    if (current !== undefined) {
      current.failedIndexes.unshift(index);
      continue;
    }
    attemptsBySuccess.set(success.index, {
      successIndex: success.index,
      name: success.item.name,
      ...(success.item.subject !== undefined ? { subject: success.item.subject } : {}),
      failedIndexes: [index],
    });
  }

  return {
    recovered,
    mutationAttempts: [...attemptsBySuccess.values()].sort(
      (a, b) => a.successIndex - b.successIndex,
    ),
    ...(terminalAttempt !== undefined ? { terminalAttempt } : {}),
  };
}

/** All failures made non-dominant by controller-owned later evidence. Full history remains intact. */
export function recoveredToolFailureIndexes(items: readonly ViewItem[]): ReadonlySet<number> {
  return reconcileToolAttempts(items, true).recovered;
}

export function reconciledToolAttempts(items: readonly ViewItem[]): {
  readonly failureIndexes: ReadonlySet<number>;
  readonly recoveredCount: number;
  readonly receiptLines: readonly string[];
} {
  const reconciliation = reconcileToolAttempts(items, true);
  const terminalReceipt =
    reconciliation.terminalAttempt === undefined
      ? []
      : [
          `recovered · ${
            reconciliation.terminalAttempt.subject === undefined
              ? reconciliation.terminalAttempt.name
              : `${reconciliation.terminalAttempt.name} ${reconciliation.terminalAttempt.subject}`
          } completed one bounded correction; original reviewed action was not executed`,
        ];
  const recoveredCount =
    reconciliation.mutationAttempts.length + (reconciliation.terminalAttempt === undefined ? 0 : 1);
  const receiptLines = reconciliation.mutationAttempts
    .slice(0, MAX_RECOVERED_RECEIPT_LINES - terminalReceipt.length)
    .map((attempt) => {
      const target =
        attempt.subject === undefined ? attempt.name : `${attempt.name} ${attempt.subject}`;
      const attempts = attempt.failedIndexes.length;
      return attempts === 1
        ? `recovered · ${target} completed after earlier blocked attempt`
        : `recovered · ${target} completed after ${String(attempts)} earlier blocked attempts`;
    });
  receiptLines.unshift(...terminalReceipt);
  const hidden = recoveredCount - receiptLines.length;
  if (hidden > 0) {
    receiptLines.push(
      `recovered · ${String(hidden)} more exact ${hidden === 1 ? "retry" : "retries"}; inspect verbose history`,
    );
  }
  return { failureIndexes: reconciliation.recovered, recoveredCount, receiptLines };
}
