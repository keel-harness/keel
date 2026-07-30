import type { ToolResultT } from "@keel/shared";

/**
 * Process-local association from one exact tool occurrence's deadline signal to the reviewed
 * executor result that will settle after the deadline revokes its live approval surface. Keeping
 * this in a WeakMap prevents the association from becoming a serializable authority/result field.
 */
const resultBySignal = new WeakMap<AbortSignal, Promise<ToolResultT>>();
const toolDeadlineSignals = new WeakSet<AbortSignal>();

/** Mark only the private per-occurrence signal created by the loop's infrastructure deadline. */
export function markToolDeadlineSignal(signal: AbortSignal): void {
  toolDeadlineSignals.add(signal);
}

export function associateToolDeadlineReviewResult(
  signal: AbortSignal,
  result: Promise<ToolResultT>,
): boolean {
  if (!toolDeadlineSignals.has(signal)) return false;
  if (resultBySignal.has(signal)) {
    throw new Error("tool-deadline review result already associated with this signal");
  }
  resultBySignal.set(signal, result);
  return true;
}

/** Take the reviewed result for this exact occurrence. A sibling or repeated take gets nothing. */
export function takeToolDeadlineReviewResult(
  signal: AbortSignal,
): Promise<ToolResultT> | undefined {
  const result = resultBySignal.get(signal);
  if (result !== undefined) resultBySignal.delete(signal);
  return result;
}
