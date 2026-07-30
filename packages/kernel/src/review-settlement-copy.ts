export const REVIEW_ACTION_INDETERMINATE_SUFFIX =
  "; action may have executed; do not retry automatically; restart the governed session and inspect audit";

export const REVIEW_RESOLUTION_INDETERMINATE_SUFFIX = `; review outcome indeterminate${REVIEW_ACTION_INDETERMINATE_SUFFIX}`;

export const REVIEW_STILL_PENDING_SUFFIX =
  "; review may remain pending; do not retry automatically; restart the governed session before deciding again";

export const REVIEW_DENIAL_UNCONFIRMED_SUFFIX =
  "; review denial not confirmed; review may remain pending; restart the governed session before deciding again";

export const REVIEW_DECISION_UNCONFIRMED_SUFFIX =
  "; review decision not confirmed; no approval assumed; restart the governed session before deciding again";

export type UnexpectedReviewDenialVerdict = "allow" | "warn" | "modify" | "review";

export function unexpectedReviewDenialMessage(verdict: UnexpectedReviewDenialVerdict): string {
  return `review denial returned unexpected ${verdict} verdict`;
}

export function unexpectedReviewDenialOutput(verdict: UnexpectedReviewDenialVerdict): string {
  const suffix =
    verdict === "review" ? REVIEW_STILL_PENDING_SUFFIX : REVIEW_ACTION_INDETERMINATE_SUFFIX;
  return `${unexpectedReviewDenialMessage(verdict)}${suffix}`;
}
