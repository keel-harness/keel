import type { ViewItem } from "@keel/shared";
import { toolOutcome } from "./tool-outcome.js";

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
  const recovered = new Set<number>();
  let answerSeen = false;
  let successfulPathToAnswer = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "message" && item.role === "assistant" && item.content.trim().length > 0) {
      answerSeen = true;
      continue;
    }
    if (answerSeen && isExploratorySuccess(item)) {
      successfulPathToAnswer = true;
      continue;
    }
    if (successfulPathToAnswer && isRecoverableExploratoryFailure(item)) recovered.add(index);
  }
  return recovered;
}
