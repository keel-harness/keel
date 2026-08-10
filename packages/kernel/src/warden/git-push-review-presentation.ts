import { Buffer } from "node:buffer";
import { redactText, type ToolInvocationT, type UiApprovalInformation } from "@keel/shared";
import { terminalDisplayWidth, wrapLosslessDisplayLine } from "../tui/display-cells.js";

export const GIT_PUSH_REVIEW_PRESENTATION_MAX_BYTES = 2_048;
export const GIT_PUSH_REVIEW_PRESENTATION_COLUMNS = 96;
export const GIT_PUSH_REVIEW_PRESENTATION_MAX_ROWS = 20;

const GIT_PUSH_REVIEW_ID = /^git_push_review_([1-9]\d{0,15})$/u;
const DISALLOWED_VALUE_CODE_POINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REDACTION_MARKER = /\[redacted:[a-z-]+\]/u;
const exactGitPushInformation = new WeakMap<object, string>();

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function valueAfter(line: string, prefix: string): string | undefined {
  return line.startsWith(prefix) && line.length > prefix.length
    ? line.slice(prefix.length)
    : undefined;
}

/** Controller-side half of ADR-0091's exact eleven-line approval predicate. */
export function exactGitPushReviewSummary(value: string): boolean {
  if (
    value === "" ||
    hasUnpairedSurrogate(value) ||
    REDACTION_MARKER.test(value) ||
    redactText(value) !== value ||
    Buffer.byteLength(value, "utf8") > GIT_PUSH_REVIEW_PRESENTATION_MAX_BYTES
  ) {
    return false;
  }
  const lines = value.split("\n");
  if (lines.length !== 11 || lines.some((line) => line === "")) return false;
  const repository = valueAfter(lines[1]!, "Repository: ");
  const destination = valueAfter(lines[2]!, "Destination: ");
  const commit = valueAfter(lines[3]!, "Commit: ");
  const subject = valueAfter(lines[4]!, "Subject: ");
  const commitFacts = valueAfter(lines[5]!, "Commit facts: ");
  const credential = valueAfter(lines[9]!, "Credential: ");
  if (
    lines[0] !== "Git push requires approval." ||
    repository === undefined ||
    destination === undefined ||
    !destination.startsWith("refs/heads/") ||
    commit === undefined ||
    !FULL_OID.test(commit) ||
    subject === undefined ||
    commitFacts === undefined ||
    lines[6] === undefined ||
    !/^Workspace: (?:clean|has uncommitted changes); uncommitted changes are excluded$/u.test(
      lines[6],
    ) ||
    lines[7] !==
      "Effect: create this branch or fast-forward it to this commit; the remote may receive every missing object reachable from the commit" ||
    lines[8] !==
      "Blocked: force, deletion, tags, hooks, submodule recursion, redirects, and remote-default-branch writes" ||
    credential === undefined ||
    !credential.endsWith("; secret stays in the Warden/SRT path") ||
    lines[10] !== "Approval: this occurrence once; expires in 120 seconds"
  ) {
    return false;
  }
  const variableValues = [repository, destination, commit, subject, commitFacts, credential];
  if (
    variableValues.some(
      (entry) =>
        entry === undefined ||
        DISALLOWED_VALUE_CODE_POINT.test(entry) ||
        hasUnpairedSurrogate(entry),
    )
  ) {
    return false;
  }
  let cells = 0;
  let rows = 0;
  for (const line of lines) {
    cells += terminalDisplayWidth(line);
    const wrapped = wrapLosslessDisplayLine(line, GIT_PUSH_REVIEW_PRESENTATION_COLUMNS);
    if (wrapped === undefined) return false;
    rows += wrapped.length;
  }
  return (
    cells <= GIT_PUSH_REVIEW_PRESENTATION_MAX_BYTES && rows <= GIT_PUSH_REVIEW_PRESENTATION_MAX_ROWS
  );
}

export function gitPushReviewSummaryForRequest(
  toolCall: ToolInvocationT,
  review: { readonly reviewId: string; readonly summary: string; readonly allowCommand: string },
): string | undefined {
  if (
    toolCall.name !== "git.push" ||
    !GIT_PUSH_REVIEW_ID.test(review.reviewId) ||
    review.allowCommand !== `keel approve ${review.reviewId} --scope once`
  ) {
    return undefined;
  }
  return exactGitPushReviewSummary(review.summary) ? review.summary : undefined;
}

export function associateExactGitPushReviewInformation(
  information: UiApprovalInformation,
  expectedSummary: string,
): UiApprovalInformation | undefined {
  if (
    !exactGitPushReviewSummary(expectedSummary) ||
    information.requestedAction.status !== "available" ||
    information.requestedAction.value !== "git.push" ||
    information.effectiveTarget.status !== "available" ||
    information.effectiveTarget.value !== expectedSummary ||
    information.effectiveTarget.completeness !== "complete" ||
    information.exactResource.status !== "unavailable"
  ) {
    return undefined;
  }
  exactGitPushInformation.set(information, expectedSummary);
  return information;
}

export function exactGitPushReviewSummaryForInformation(
  information: UiApprovalInformation | undefined,
): string | undefined {
  if (information === undefined) return undefined;
  const expected = exactGitPushInformation.get(information);
  if (
    expected === undefined ||
    !exactGitPushReviewSummary(expected) ||
    information.requestedAction.status !== "available" ||
    information.requestedAction.value !== "git.push" ||
    information.effectiveTarget.status !== "available" ||
    information.effectiveTarget.value !== expected ||
    information.effectiveTarget.completeness !== "complete" ||
    information.exactResource.status !== "unavailable"
  ) {
    return undefined;
  }
  return expected;
}
