import { Buffer } from "node:buffer";
import { redactText, type ToolInvocationT, type UiApprovalInformation } from "@keel/shared";
import { terminalDisplayWidth, wrapLosslessDisplayLine } from "../tui/display-cells.js";

export const GITHUB_PR_CREATE_REVIEW_PRESENTATION_MAX_BYTES = 2_048;
export const GITHUB_PR_CREATE_REVIEW_PRESENTATION_COLUMNS = 96;
export const GITHUB_PR_CREATE_REVIEW_PRESENTATION_MAX_ROWS = 20;

const REVIEW_ID = /^github_pr_create_review_([1-9]\d{0,15})$/u;
const FULL_SHA1 = /^[0-9a-f]{40}$/u;
const REDACTION_MARKER = /\[redacted:[a-z-]+\]/u;
const DISALLOWED_VALUE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const exactInformation = new WeakMap<object, string>();

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function escapeCodeUnit(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

function escapeReviewText(value: string): string | undefined {
  if (hasUnpairedSurrogate(value)) return undefined;
  let escaped = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const char = value[index]!;
    if (char === '"') escaped += '\\"';
    else if (char === "\\") escaped += "\\\\";
    else if (char === "\b") escaped += "\\b";
    else if (char === "\f") escaped += "\\f";
    else if (char === "\n") escaped += "\\n";
    else if (char === "\r") escaped += "\\r";
    else if (char === "\t") escaped += "\\t";
    else if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      /\p{Cf}/u.test(char)
    ) {
      escaped += escapeCodeUnit(code);
    } else escaped += char;
  }
  return `${escaped}"`;
}

function valueAfter(line: string, prefix: string): string | undefined {
  return line.startsWith(prefix) && line.length > prefix.length
    ? line.slice(prefix.length)
    : undefined;
}

/** Controller-side shape and bounded-layout predicate for the exact thirteen-line review. */
export function exactGithubPrCreateReviewSummary(value: string): boolean {
  if (
    value === "" ||
    hasUnpairedSurrogate(value) ||
    REDACTION_MARKER.test(value) ||
    redactText(value) !== value ||
    Buffer.byteLength(value, "utf8") > GITHUB_PR_CREATE_REVIEW_PRESENTATION_MAX_BYTES
  ) {
    return false;
  }
  const lines = value.split("\n");
  if (lines.length !== 13 || lines.some((line) => line === "")) return false;
  const repository = valueAfter(lines[1]!, "Repository: ");
  const remote = valueAfter(lines[2]!, "Remote: ");
  const head = /^Head: refs\/heads\/(.+) @ ([0-9a-f]{40})$/u.exec(lines[3]!);
  const base = valueAfter(lines[4]!, "Base: refs/heads/");
  const title = valueAfter(lines[5]!, "Title JSON: ");
  const body = valueAfter(lines[6]!, "Body JSON: ");
  if (
    lines[0] !== "GitHub pull request creation requires approval." ||
    repository === undefined ||
    remote !== `https://github.com/${repository}.git` ||
    head === null ||
    !FULL_SHA1.test(head[2]!) ||
    base === undefined ||
    (lines[7] !== "Draft: yes" && lines[7] !== "Draft: no") ||
    (lines[8] !== "Maintainers may modify: yes" && lines[8] !== "Maintainers may modify: no") ||
    lines[9] !== "Effect: create one GitHub pull request and trigger repository notifications" ||
    lines[10] !==
      "Blocked: merge, auto-merge, labels, reviews, releases, deployments, and branch mutation" ||
    lines[11] !==
      "Credential: operator Git credential helper (system/global config); token stays in the Warden/SRT path" ||
    lines[12] !== "Approval: this occurrence once; expires in 120 seconds" ||
    title === undefined ||
    body === undefined
  ) {
    return false;
  }
  for (const entry of [repository, remote, head[1]!, head[2]!, base]) {
    if (DISALLOWED_VALUE.test(entry) || hasUnpairedSurrogate(entry)) return false;
  }
  try {
    if (typeof JSON.parse(title) !== "string" || typeof JSON.parse(body) !== "string") return false;
  } catch {
    return false;
  }
  let cells = 0;
  let rows = 0;
  for (const line of lines) {
    cells += terminalDisplayWidth(line);
    const wrapped = wrapLosslessDisplayLine(line, GITHUB_PR_CREATE_REVIEW_PRESENTATION_COLUMNS);
    if (wrapped === undefined) return false;
    rows += wrapped.length;
  }
  return (
    cells <= GITHUB_PR_CREATE_REVIEW_PRESENTATION_MAX_BYTES &&
    rows <= GITHUB_PR_CREATE_REVIEW_PRESENTATION_MAX_ROWS
  );
}

export function githubPrCreateReviewSummaryForRequest(
  toolCall: ToolInvocationT,
  review: { readonly reviewId: string; readonly summary: string; readonly allowCommand: string },
): string | undefined {
  if (
    toolCall.name !== "github.pr.create" ||
    !REVIEW_ID.test(review.reviewId) ||
    review.allowCommand !== `keel approve ${review.reviewId} --scope once` ||
    !exactGithubPrCreateReviewSummary(review.summary)
  ) {
    return undefined;
  }
  const args = toolCall.args;
  const remote = args["remote"];
  const repository = args["repository"];
  const head = args["head"];
  const expectedHead = args["expectedHead"];
  const base = args["base"];
  const title = args["title"];
  const body = args["body"];
  const draft = args["draft"];
  const maintainerCanModify = args["maintainerCanModify"];
  if (
    typeof remote !== "string" ||
    typeof repository !== "string" ||
    typeof head !== "string" ||
    typeof expectedHead !== "string" ||
    typeof base !== "string" ||
    typeof title !== "string" ||
    typeof body !== "string" ||
    typeof draft !== "boolean" ||
    typeof maintainerCanModify !== "boolean"
  ) {
    return undefined;
  }
  const escapedTitle = escapeReviewText(title);
  const escapedBody = escapeReviewText(body);
  if (escapedTitle === undefined || escapedBody === undefined) return undefined;
  const expected = [
    "GitHub pull request creation requires approval.",
    `Repository: ${repository}`,
    `Remote: https://github.com/${repository}.git`,
    `Head: refs/heads/${head} @ ${expectedHead}`,
    `Base: refs/heads/${base}`,
    `Title JSON: ${escapedTitle}`,
    `Body JSON: ${escapedBody}`,
    `Draft: ${draft ? "yes" : "no"}`,
    `Maintainers may modify: ${maintainerCanModify ? "yes" : "no"}`,
    "Effect: create one GitHub pull request and trigger repository notifications",
    "Blocked: merge, auto-merge, labels, reviews, releases, deployments, and branch mutation",
    "Credential: operator Git credential helper (system/global config); token stays in the Warden/SRT path",
    "Approval: this occurrence once; expires in 120 seconds",
  ].join("\n");
  return review.summary === expected ? expected : undefined;
}

export function associateExactGithubPrCreateReviewInformation(
  information: UiApprovalInformation,
  expectedSummary: string,
): UiApprovalInformation | undefined {
  if (
    !exactGithubPrCreateReviewSummary(expectedSummary) ||
    information.requestedAction.status !== "available" ||
    information.requestedAction.value !== "github.pr.create" ||
    information.effectiveTarget.status !== "available" ||
    information.effectiveTarget.value !== expectedSummary ||
    information.effectiveTarget.completeness !== "complete" ||
    information.exactResource.status !== "unavailable"
  ) {
    return undefined;
  }
  exactInformation.set(information, expectedSummary);
  return information;
}

export function exactGithubPrCreateReviewSummaryForInformation(
  information: UiApprovalInformation | undefined,
): string | undefined {
  if (information === undefined) return undefined;
  const expected = exactInformation.get(information);
  if (
    expected === undefined ||
    !exactGithubPrCreateReviewSummary(expected) ||
    information.requestedAction.status !== "available" ||
    information.requestedAction.value !== "github.pr.create" ||
    information.effectiveTarget.status !== "available" ||
    information.effectiveTarget.value !== expected ||
    information.effectiveTarget.completeness !== "complete" ||
    information.exactResource.status !== "unavailable"
  ) {
    return undefined;
  }
  return expected;
}
