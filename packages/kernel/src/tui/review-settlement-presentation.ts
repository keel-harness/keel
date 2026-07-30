export const REVIEW_INDETERMINATE_SUMMARY =
  "review outcome indeterminate · action may have executed · do not retry automatically · inspect audit";

export const REVIEW_PENDING_SUMMARY =
  "review settlement failed · review may remain pending · do not retry automatically · restart session";

export type ReviewSettlementPresentationOutcome = "partial" | "failed";

const REVIEW_SETTLEMENT_PRESENTATION = Symbol("keel.review-settlement-presentation");

type ReviewSettlementTagged = {
  readonly [REVIEW_SETTLEMENT_PRESENTATION]?: ReviewSettlementPresentationOutcome;
};

/** Kernel-local provenance that cannot be supplied by tool text or persisted as counterfeit JSON. */
export function markReviewSettlementPresentation<T extends object>(
  value: T,
  outcome: ReviewSettlementPresentationOutcome,
): T {
  Object.defineProperty(value, REVIEW_SETTLEMENT_PRESENTATION, { value: outcome });
  return value;
}

export function reviewSettlementPresentation(
  value: object,
): ReviewSettlementPresentationOutcome | undefined {
  return (value as ReviewSettlementTagged)[REVIEW_SETTLEMENT_PRESENTATION];
}

/**
 * Recovery is controller-owned only for the exact summary/outcome pairs emitted by the Kernel.
 * Tool content that merely copies these phrases remains data and cannot manufacture instructions.
 */
export function reviewSettlementRecovery(
  outcome: ReviewSettlementPresentationOutcome | undefined,
): string | undefined {
  if (outcome === "partial") {
    return "restart and inspect audit before deciding again";
  }
  if (outcome === "failed") {
    return "restart the governed session before deciding again";
  }
  return undefined;
}
