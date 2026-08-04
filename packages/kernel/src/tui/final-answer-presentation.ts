import type { FinalAnswerContractT } from "@keel/shared";
import type { KernelEventT } from "../events.js";
import {
  buildFinalAnswerFallback,
  finalAnswerVisibleByteLimit,
  normalizeFinalAnswerText,
} from "../final-answer.js";

export const FINAL_ANSWER_REWRITE_NOTICE = "rewriting once · tools off";
const FINAL_ANSWER_MISMATCH_NOTICE =
  "final-answer settlement metadata did not match; showing the bounded raw candidate";

export type FinalAnswerPresentationEvent =
  | KernelEventT
  | { readonly type: "system-notice"; readonly content: string };

export interface FinalAnswerPresentation {
  readonly project: (event: KernelEventT) => readonly FinalAnswerPresentationEvent[];
  /** Peak sanitized bytes held during this task. Exposed only for deterministic resource tests. */
  readonly retainedVisibleBytes: () => number;
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (value.length === 0) return "";
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maxBytes) break;
    output += character;
    bytes += width;
  }
  return output;
}

/** Consume the controller's typed settlement events without independently validating or recounting
 * the full candidate. The recorder receives the unprojected stream first; this object only selects
 * the one bounded primary answer shown by the live UI. */
export function createFinalAnswerPresentation(input: {
  readonly contract: FinalAnswerContractT;
  readonly originalInspectionCommand: string;
  readonly attentionFacts?: () => readonly string[];
}): FinalAnswerPresentation {
  const retainedLimit = finalAnswerVisibleByteLimit(input.contract) + 1;
  let held = "";
  let heldBytes = 0;
  let peakHeldBytes = 0;
  let holding = false;
  let activeSettlementId: string | undefined;
  let selected: string | undefined;

  const clearHeld = (): void => {
    held = "";
    heldBytes = 0;
  };
  const appendHeld = (text: string): void => {
    const remaining = retainedLimit - heldBytes;
    if (remaining <= 0) return;
    const prefix = utf8Prefix(normalizeFinalAnswerText(text), remaining);
    held += prefix;
    heldBytes += Buffer.byteLength(prefix, "utf8");
    peakHeldBytes = Math.max(peakHeldBytes, heldBytes);
  };
  const mismatch = (): readonly FinalAnswerPresentationEvent[] => {
    const raw = held;
    clearHeld();
    holding = false;
    activeSettlementId = undefined;
    selected = undefined;
    return [
      { type: "system-notice", content: FINAL_ANSWER_MISMATCH_NOTICE },
      ...(raw.length > 0 ? ([{ type: "text-delta", text: raw }] as const) : []),
    ];
  };

  return {
    retainedVisibleBytes: () => peakHeldBytes,
    project(event) {
      switch (event.type) {
        case "turn-started":
          clearHeld();
          holding = true;
          selected = undefined;
          return [event];
        case "final-answer-buffer-released":
          clearHeld();
          holding = false;
          selected = undefined;
          return [];
        case "text-delta":
          if (!holding) return [event];
          appendHeld(event.text);
          return [];
        case "final-answer-attempt":
          if (
            activeSettlementId !== undefined &&
            activeSettlementId !== event.settlementId &&
            event.attempt === "rewrite"
          ) {
            return mismatch();
          }
          activeSettlementId = event.settlementId;
          selected = event.decision === "accepted" ? held : undefined;
          return [];
        case "final-answer-rewrite-requested":
          if (activeSettlementId !== event.settlementId) return mismatch();
          clearHeld();
          holding = true;
          selected = undefined;
          return [{ type: "system-notice", content: FINAL_ANSWER_REWRITE_NOTICE }];
        case "final-answer-settled": {
          if (activeSettlementId !== event.settlement.settlementId) return mismatch();
          const outcome = event.settlement.outcome;
          const primary =
            outcome === "accepted-original" || outcome === "accepted-rewrite"
              ? (selected ?? held)
              : buildFinalAnswerFallback({
                  contract: input.contract,
                  outcome,
                  originalInspectionCommand: input.originalInspectionCommand,
                  ...(input.attentionFacts === undefined
                    ? {}
                    : { attentionFacts: input.attentionFacts() }),
                });
          clearHeld();
          holding = false;
          activeSettlementId = undefined;
          selected = undefined;
          return primary.length > 0 ? [{ type: "text-delta", text: primary }] : [];
        }
        default:
          return [event];
      }
    },
  };
}
