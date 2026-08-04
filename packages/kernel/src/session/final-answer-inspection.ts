import type { ModelMessageT } from "@keel/shared";
import type { ResumeState } from "./resume.js";

export interface FinalAnswerOriginalInspection {
  readonly settlementId: string;
  readonly messageIndex: number;
  readonly message: ModelMessageT;
}

/** Select the latest fully settled original by typed occurrence identity. Text never activates this
 * path, and ambiguous duplicate originals fail closed to "not found" rather than guessing. */
export function latestFinalAnswerOriginal(
  state: ResumeState,
): FinalAnswerOriginalInspection | undefined {
  const settledIds = [...state.finalAnswerSettlements.keys()].reverse();
  for (const settlementId of settledIds) {
    const matches = [...state.finalAnswerOccurrences.entries()].filter(
      ([, occurrence]) =>
        occurrence.settlementId === settlementId &&
        occurrence.kind === "attempt" &&
        occurrence.attempt === "original",
    );
    if (matches.length !== 1) continue;
    const [messageIndex] = matches[0]!;
    const message = state.messages[messageIndex];
    if (message?.role !== "assistant") continue;
    return { settlementId, messageIndex, message };
  }
  return undefined;
}
