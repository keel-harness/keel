import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseTolerantAuditRecord,
  SessionId,
  toChainRecords,
  verifyChain,
  type AnyAuditRecordT,
} from "@keel/shared";
import { oneLineText } from "../control-strip.js";
import { graphemeSpans } from "../tui/display-cells.js";
import { visibleTerminalText } from "../tui/visible-text.js";

export interface HistoricOnceApprovalReceipt {
  readonly reviewId: string;
  readonly toolName: string;
  readonly approvalAuditSeq: number;
  readonly executionAuditSeq: number;
}

export type HistoricOnceApprovalReceiptLoad =
  | { readonly status: "none" }
  | { readonly status: "ready" | "unavailable"; readonly content: string };

interface OnceGrant {
  readonly key: string;
  readonly reviewId: string;
}

interface ApprovedOnceGrant extends OnceGrant {
  readonly approvalAuditSeq: number;
}

const COMMAND_KEY_RE = /^sha256:[a-f0-9]{64}$/u;
const MAX_VISIBLE_RECEIPTS = 3;
const MAX_LABEL_GRAPHEMES = 128;
const UNAVAILABLE_RECEIPT =
  "Historic once-approval receipt unavailable: the audit chain could not be verified. " +
  "No authority was restored; repeating an action requires a fresh review.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onceGrant(payload: Record<string, unknown>): OnceGrant | undefined {
  const grant = payload["commandGrant"];
  if (!isRecord(grant)) return undefined;
  const payloadReviewId = payload["reviewId"];
  const grantReviewId = grant["reviewId"];
  const reviewId =
    typeof payloadReviewId === "string" && payloadReviewId.length > 0
      ? payloadReviewId
      : grantReviewId;
  if (typeof reviewId !== "string" || reviewId.length === 0) return undefined;
  const key = grant["key"];
  if (
    typeof key !== "string" ||
    !COMMAND_KEY_RE.test(key) ||
    grant["kind"] !== "once-only-command-review" ||
    grant["scope"] !== "once" ||
    (grantReviewId !== undefined && grantReviewId !== reviewId)
  ) {
    return undefined;
  }
  return { key, reviewId };
}

function grantIdentity(grant: OnceGrant): string {
  return `${grant.reviewId}\u0000${grant.key}`;
}

/**
 * Derive presentation-only evidence for human-approved, once-only command grants that were actually
 * consumed. The three-link requirement is deliberate: a request, terminal authorization record,
 * and applied execution must agree on the exact review id + command key. A model/tool result alone
 * can never manufacture this receipt, and the receipt never restores authority.
 */
export function historicOnceApprovalReceipts(
  records: readonly AnyAuditRecordT[],
  sessionId: string,
): readonly HistoricOnceApprovalReceipt[] {
  if (!SessionId.safeParse(sessionId).success) return [];
  if (records.some((record) => record.sessionId !== sessionId)) return [];

  const requested = new Set<string>();
  const terminallyResolved = new Set<string>();
  const approved = new Map<string, ApprovedOnceGrant>();
  const receipts: HistoricOnceApprovalReceipt[] = [];

  for (const record of records) {
    const payload = record.payload as Record<string, unknown>;
    const grant = onceGrant(payload);
    if (grant === undefined) continue;
    const identity = grantIdentity(grant);

    if (record.eventType === "review.requested") {
      if (!terminallyResolved.has(identity)) requested.add(identity);
      continue;
    }

    if (record.eventType === "review.resolved") {
      // The first terminal decision is final. A late/duplicate record must not rewrite settled
      // history into an approval receipt, even though this projector is presentation-only.
      if (payload["terminal"] === true) {
        if (terminallyResolved.has(identity)) continue;
        terminallyResolved.add(identity);
      }
      const hadRequest = requested.delete(identity);
      if (
        payload["approved"] === true &&
        payload["requestedApproval"] === true &&
        payload["requestedScope"] === "once" &&
        payload["terminal"] === true &&
        isRecord(payload["commandGrant"]) &&
        payload["commandGrant"]["authorizationRecorded"] === true &&
        hadRequest
      ) {
        approved.set(identity, {
          ...grant,
          approvalAuditSeq: record.seq,
        });
      } else {
        approved.delete(identity);
      }
      continue;
    }

    if (
      record.eventType !== "tool.execute" ||
      payload["execution"] !== "requested" ||
      !isRecord(payload["commandGrant"]) ||
      payload["commandGrant"]["applied"] !== true
    ) {
      continue;
    }

    const authorization = approved.get(identity);
    const toolName = payload["toolName"];
    if (authorization === undefined || typeof toolName !== "string" || toolName.length === 0) {
      continue;
    }
    receipts.push({
      reviewId: authorization.reviewId,
      toolName,
      approvalAuditSeq: authorization.approvalAuditSeq,
      executionAuditSeq: record.seq,
    });
    // A once-only grant can yield at most one historic consumed-authority receipt. A duplicated
    // result record or malformed repeated request must not inflate the visible evidence.
    approved.delete(identity);
    requested.delete(identity);
  }

  return receipts;
}

function safeLabel(value: string): string {
  const visible = visibleTerminalText(oneLineText(value));
  const spans = graphemeSpans(visible);
  return spans.length <= MAX_LABEL_GRAPHEMES
    ? visible
    : `${spans
        .slice(0, MAX_LABEL_GRAPHEMES)
        .map((span) => span.text)
        .join("")}…`;
}

export function renderHistoricOnceApprovalReceipt(
  receipts: readonly HistoricOnceApprovalReceipt[],
): string | undefined {
  if (receipts.length === 0) return undefined;
  const visible = receipts.slice(-MAX_VISIBLE_RECEIPTS);
  const hidden = receipts.length - visible.length;
  return [
    "Historic once-approval receipt · authority spent",
    ...visible.map(
      (receipt) =>
        `- ${safeLabel(receipt.toolName)} · approved once at audit #${String(receipt.approvalAuditSeq)} · ` +
        `applied at audit #${String(receipt.executionAuditSeq)} · review ${safeLabel(receipt.reviewId)}`,
    ),
    ...(hidden > 0
      ? [`- ${String(hidden)} earlier spent approval${hidden === 1 ? "" : "s"} omitted`]
      : []),
    "Resume restored no authority; repeating the action requires a fresh review.",
  ].join("\n");
}

function completeAuditRecords(path: string): AnyAuditRecordT[] {
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a) {
    throw new Error("audit chain ends with an incomplete record");
  }
  const completeLength = bytes.lastIndexOf(0x0a) + 1;
  // Missing is quiet, but an empty or torn present file is not a complete verified history and must
  // produce the explicit fail-closed notice. Never project authority from a merely valid prefix.
  const complete = bytes.subarray(0, completeLength).toString("utf8");
  const lines = complete.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.some((line) => line.length === 0)) throw new Error("audit chain contains a blank line");
  const records = lines.map((line) => parseTolerantAuditRecord(line));
  const diagnosis = verifyChain(toChainRecords(records));
  if (!diagnosis.ok) throw new Error(`audit chain ${diagnosis.kind}`);
  return records;
}

/**
 * Load the prior Warden chain without taking its writer lock. Missing logs or logs with no consumed
 * human once approvals are quiet. Any present-but-unverifiable/mixed-session log yields an explicit
 * fail-closed notice and still restores no authority.
 */
export function historicOnceApprovalReceiptFromAudit(
  auditDir: string,
  sessionId: string,
): HistoricOnceApprovalReceiptLoad {
  if (!SessionId.safeParse(sessionId).success) {
    return { status: "unavailable", content: UNAVAILABLE_RECEIPT };
  }
  try {
    const records = completeAuditRecords(join(auditDir, `${sessionId}.jsonl`));
    if (records.some((record) => record.sessionId !== sessionId)) {
      return { status: "unavailable", content: UNAVAILABLE_RECEIPT };
    }
    const content = renderHistoricOnceApprovalReceipt(
      historicOnceApprovalReceipts(records, sessionId),
    );
    return content === undefined ? { status: "none" } : { status: "ready", content };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { status: "none" };
    }
    return { status: "unavailable", content: UNAVAILABLE_RECEIPT };
  }
}
