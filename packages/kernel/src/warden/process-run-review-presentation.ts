import { Buffer } from "node:buffer";
import { redactText, type ToolInvocationT, type UiApprovalInformation } from "@keel/shared";
import { wrapLosslessDisplayLine } from "../tui/display-cells.js";

export const PROCESS_RUN_REVIEW_PRESENTATION_MAX_BYTES = 512;
const PROCESS_RUN_REVIEW_MIN_LOSSLESS_COLUMNS = 18;

const PROCESS_RUN_REVIEW_ID = /^process_review_([1-9]\d{0,15})$/u;
const DISALLOWED_PRESENTATION_CODE_POINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const exactProcessRunInformation = new WeakMap<object, string>();

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
  }
  return false;
}

/** The controller-side half of ADR-0090's Warden-owned lossless display predicate. */
export function exactProcessRunReviewSummary(value: string): boolean {
  return (
    value !== "" &&
    !hasUnpairedSurrogate(value) &&
    !DISALLOWED_PRESENTATION_CODE_POINT.test(value) &&
    redactText(value) === value &&
    Buffer.byteLength(value, "utf8") <= PROCESS_RUN_REVIEW_PRESENTATION_MAX_BYTES &&
    wrapLosslessDisplayLine(value, PROCESS_RUN_REVIEW_MIN_LOSSLESS_COLUMNS) !== undefined
  );
}

export function processRunReviewSummaryForRequest(
  toolCall: ToolInvocationT,
  review: { readonly reviewId: string; readonly summary: string; readonly allowCommand: string },
): string | undefined {
  if (!isExactOnceProcessRunReviewRequest(toolCall, review)) return undefined;
  return exactProcessRunReviewSummary(review.summary) ? review.summary : undefined;
}

export function isExactOnceProcessRunReviewRequest(
  toolCall: ToolInvocationT,
  review: { readonly reviewId: string; readonly allowCommand: string },
): boolean {
  return (
    toolCall.name === "process.run" &&
    PROCESS_RUN_REVIEW_ID.test(review.reviewId) &&
    review.allowCommand === `keel approve ${review.reviewId} --scope once`
  );
}

export function associateExactProcessRunReviewInformation(
  information: UiApprovalInformation,
  expectedSummary: string,
): UiApprovalInformation | undefined {
  if (
    !exactProcessRunReviewSummary(expectedSummary) ||
    information.requestedAction.status !== "available" ||
    information.requestedAction.value !== "process.run" ||
    information.effectiveTarget.status !== "available" ||
    information.effectiveTarget.value !== expectedSummary ||
    information.effectiveTarget.completeness !== "complete" ||
    information.exactResource.status !== "unavailable"
  ) {
    return undefined;
  }
  exactProcessRunInformation.set(information, expectedSummary);
  return information;
}

export function exactProcessRunReviewSummaryForInformation(
  information: UiApprovalInformation | undefined,
): string | undefined {
  if (information === undefined) return undefined;
  const expected = exactProcessRunInformation.get(information);
  if (
    expected === undefined ||
    !exactProcessRunReviewSummary(expected) ||
    information.requestedAction.status !== "available" ||
    information.requestedAction.value !== "process.run" ||
    information.effectiveTarget.status !== "available" ||
    information.effectiveTarget.value !== expected ||
    information.effectiveTarget.completeness !== "complete" ||
    information.exactResource.status !== "unavailable"
  ) {
    return undefined;
  }
  return expected;
}
