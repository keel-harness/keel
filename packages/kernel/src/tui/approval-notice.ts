import type { UiActiveApproval, UiApprovalInformation } from "@keel/shared";
import { graphemeSpans, takeDisplayCells, terminalDisplayWidth } from "./display-cells.js";
import { stripControlLine } from "./strip.js";

export interface ApprovalNoticePlan {
  readonly heading:
    | "approval required · not executed"
    | "decision sent"
    | "approval confirmed"
    | "governed result denied"
    | "request denied"
    | "decision not confirmed"
    | "outcome unknown";
  readonly detail: string;
  readonly actions?: readonly string[];
  readonly sessionNote?: string;
  readonly confirmation?: string;
  readonly sessionAvailable: boolean;
  readonly state: UiActiveApproval["state"];
  readonly facts?: readonly ApprovalNoticeFact[];
  readonly consequence: string;
  readonly next: string;
  readonly selectedChoice?: UiActiveApproval["selectedChoice"];
  readonly message?: string;
}

export interface ApprovalNoticeFact {
  readonly label: "Requested" | "Effective target" | "Why" | "Exact reusable scope";
  readonly value: string;
  readonly quoted?: boolean;
  readonly qualifier?: "abbreviated";
  /** Exact resource identity may wrap; bounded summaries may truncate visually. */
  readonly exact?: boolean;
  readonly compactValue?: string;
  /** Compact value which preserves Warden-owned decision evidence at constrained wider sizes. */
  readonly constrainedValue?: string;
  readonly compactWrap?: boolean;
}

export interface ApprovalNoticeRow {
  readonly kind:
    | "status"
    | "label"
    | "detail"
    | "evidence"
    | "action"
    | "confirmation"
    | "message"
    | "warning";
  readonly text: string;
}

export interface ApprovalNoticeRowsOptions {
  readonly compact?: boolean;
  readonly preserveDecisionEvidence?: boolean;
}

const MAX_DETAIL_WIDTH = 2_048;
const MAX_MESSAGE_WIDTH = 240;
const MAX_PENDING_MESSAGE_WIDTH = 72;
const MAX_REQUEST_WIDTH = 160;
const MAX_REASON_WIDTH = 320;
const MAX_RESOURCE_WIDTH = 384;
const MAX_CONSEQUENCE_WIDTH = 480;
const OMISSION_MARKER = " … ";

function cleanLine(value: string): string {
  return stripControlLine(value).replace(/\s+/gu, " ").trim();
}

function boundedDisplayLine(value: string, maxWidth: number, tailWidth: number): string {
  const line = cleanLine(value);
  if (terminalDisplayWidth(line) <= maxWidth) return line;
  const safeTailWidth = Math.min(
    tailWidth,
    Math.max(1, maxWidth - terminalDisplayWidth(OMISSION_MARKER) - 1),
  );
  const headWidth = maxWidth - terminalDisplayWidth(OMISSION_MARKER) - safeTailWidth;
  return `${takeDisplayStart(line, headWidth).trimEnd()}${OMISSION_MARKER}${takeDisplayEnd(line, safeTailWidth).trimStart()}`;
}

function boundedLine(value: string): string {
  return boundedDisplayLine(value, MAX_DETAIL_WIDTH, 512);
}

function boundedMessage(value: string, maxWidth = MAX_MESSAGE_WIDTH): string {
  return boundedDisplayLine(value, maxWidth, Math.min(160, Math.floor(maxWidth / 3)));
}

function takeDisplayStart(value: string, maxWidth: number): string {
  return takeDisplayCells(value, Math.max(0, maxWidth)).text;
}

function takeDisplayEnd(value: string, maxWidth: number): string {
  const segments = graphemeSpans(value).map((span) => span.text);
  const output: string[] = [];
  let width = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    const segmentWidth = terminalDisplayWidth(segment);
    if (width + segmentWidth > maxWidth) break;
    output.unshift(segment);
    width += segmentWidth;
  }
  return output.join("");
}

/**
 * Plan a controller-owned approval surface. This function accepts structured state only; there is
 * intentionally no decoder from transcript text, so copied, resumed, or model-authored prose is
 * display-only by construction.
 */
export function approvalNoticePlan(approval: UiActiveApproval): ApprovalNoticePlan {
  const actionable = approval.state === "pending";
  const detail = boundedLine(approval.detail);
  const message =
    approval.message === undefined
      ? undefined
      : boundedMessage(
          approval.message,
          actionable ? MAX_PENDING_MESSAGE_WIDTH : MAX_MESSAGE_WIDTH,
        );
  const facts =
    approval.information === undefined ? undefined : approvalFacts(approval.information);
  return {
    heading: APPROVAL_HEADINGS[approval.state],
    detail,
    sessionAvailable: approval.sessionAvailable,
    state: approval.state,
    ...(facts === undefined ? {} : { facts }),
    consequence: approvalConsequence(approval),
    next: APPROVAL_NEXT[approval.state],
    ...(approval.selectedChoice === undefined ? {} : { selectedChoice: approval.selectedChoice }),
    ...(actionable
      ? {
          actions: [
            "[a] Approve once · this action only",
            ...(approval.sessionAvailable ? ["[s] Session · exact target until exit"] : []),
            "[d] Deny · action will not run",
            "[?] Explain why",
          ],
          ...(approval.sessionAvailable
            ? {}
            : { sessionNote: "Broader approval unavailable · use once or deny" }),
          confirmation: approval.sessionAvailable
            ? "a/s/d Enter · ? why · Esc stops turn"
            : "a/d Enter · ? why · Esc stops turn",
        }
      : {}),
    ...(message !== undefined && message.length > 0 ? { message } : {}),
  };
}

function availableOrReason(
  fact: UiApprovalInformation["requestedAction"],
  maxWidth: number,
): { readonly value: string; readonly quoted: boolean } {
  return fact.status === "available"
    ? {
        value: boundedDisplayLine(fact.value, maxWidth, Math.min(120, Math.floor(maxWidth / 3))),
        quoted: true,
      }
    : {
        value: boundedDisplayLine(fact.reason, maxWidth, Math.min(120, Math.floor(maxWidth / 3))),
        quoted: false,
      };
}

function approvalFacts(information: UiApprovalInformation): readonly ApprovalNoticeFact[] {
  const requested = availableOrReason(information.requestedAction, MAX_REQUEST_WIDTH);
  const effective =
    information.effectiveTarget.status === "available"
      ? {
          value: boundedLine(information.effectiveTarget.value),
          quoted: true,
          ...(information.effectiveTarget.completeness === "abbreviated"
            ? { qualifier: "abbreviated" as const }
            : {}),
        }
      : {
          value: boundedMessage(information.effectiveTarget.reason),
          quoted: false,
        };
  const reviewReason = availableOrReason(information.reason, MAX_REASON_WIDTH);
  const policyDetail = availableOrReason(information.policyDetail, MAX_REASON_WIDTH);
  const compactWhy =
    reviewReason.value === "Warden requires human authorization before execution" &&
    policyDetail.value === "matched policy rule not reported by protocol 1.1"
      ? "human approval · rule unreported"
      : `${reviewReason.value} · ${policyDetail.value}`;
  const constrainedWhy =
    reviewReason.value === "Warden requires human authorization before execution" &&
    policyDetail.value === "matched policy rule not reported by protocol 1.1"
      ? `${reviewReason.value} · rule unreported`
      : compactWhy;
  const resource = information.exactResource;
  const exactScope =
    resource.status === "unavailable"
      ? resource.reason
      : resource.kind === "domain"
        ? `domain ${resource.value}`
        : resource.kind === "command-envelope"
          ? `command envelope ${resource.value}`
          : `console target ${resource.target} · key ${resource.key}`;
  return [
    { label: "Requested", value: requested.value, ...(requested.quoted ? { quoted: true } : {}) },
    {
      label: "Effective target",
      value: effective.value,
      ...(effective.quoted ? { quoted: true } : {}),
      ...(effective.qualifier === undefined ? {} : { qualifier: effective.qualifier }),
      compactWrap: true,
    },
    {
      label: "Why",
      value: boundedDisplayLine(
        `${reviewReason.value} · ${policyDetail.value}`,
        MAX_REASON_WIDTH,
        140,
      ),
      compactValue: compactWhy,
      constrainedValue: constrainedWhy,
      compactWrap: true,
    },
    {
      label: "Exact reusable scope",
      value: boundedDisplayLine(exactScope, MAX_RESOURCE_WIDTH, 192),
      exact: resource.status === "available",
    },
  ];
}

function resourceKind(approval: UiActiveApproval): string {
  const resource = approval.information?.exactResource;
  if (resource?.status !== "available") return "target";
  if (resource.kind === "domain") return "domain";
  if (resource.kind === "command-envelope") return "command envelope";
  return "console target";
}

function approvalConsequence(approval: UiActiveApproval): string {
  if (approval.state === "governed-deny") {
    return "The human approved this attempt; Warden returned deny; no reusable authority remains";
  }
  const choice = approval.selectedChoice;
  if (choice === "deny") return "Deny grants no authority";
  if (choice === "once") return "Once applies only to this review; no authority is remembered";
  if (choice === "session") {
    return boundedDisplayLine(
      `Session remembers only this exact ${resourceKind(approval)} until Keel exits; policy, provenance, and audit remain active`,
      MAX_CONSEQUENCE_WIDTH,
      180,
    );
  }
  const once = "Once applies only to this review";
  if (!approval.sessionAvailable) return `${once} · Broader approval unavailable`;
  return boundedDisplayLine(
    `${once}; session remembers only this exact ${resourceKind(approval)} until Keel exits; policy, provenance, and audit remain active`,
    MAX_CONSEQUENCE_WIDTH,
    180,
  );
}

const APPROVAL_HEADINGS: Record<UiActiveApproval["state"], ApprovalNoticePlan["heading"]> = {
  pending: "approval required · not executed",
  submitted: "decision sent",
  confirmed: "approval confirmed",
  "governed-deny": "governed result denied",
  denied: "request denied",
  failed: "decision not confirmed",
  indeterminate: "outcome unknown",
};

const APPROVAL_NEXT: Record<UiActiveApproval["state"], string> = {
  pending: "Inspect the Warden facts and choose a decision",
  submitted: "Wait for Warden confirmation; do not submit another decision",
  confirmed: "Keel may resume the governed action",
  "governed-deny": "Inspect the governed tool result for effects and recovery guidance",
  denied: "Revise the request or rerun deliberately",
  failed: "Restart the governed session before deciding again",
  indeterminate: "Do not retry automatically; restart and inspect audit",
};

const COMPACT_APPROVAL_NEXT: Record<UiActiveApproval["state"], string> = {
  pending: "inspect facts · choose above",
  submitted: "wait for Warden · no duplicate",
  confirmed: "resume governed action",
  "governed-deny": "inspect governed result · follow recovery guidance",
  denied: "revise or rerun deliberately",
  failed: "restart governed session",
  indeterminate: "no auto-retry · restart · inspect audit",
};

function quotedDetail(detail: string): string {
  return JSON.stringify(detail);
}

function factText(fact: ApprovalNoticeFact): string {
  return fact.quoted === true ? quotedDetail(fact.value) : fact.value;
}

function factLabel(fact: ApprovalNoticeFact, compact: boolean): string {
  if (fact.label === "Exact reusable scope") return compact ? "Scope" : fact.label;
  if (fact.qualifier === "abbreviated") {
    return compact ? "Effective [abbr.]" : `${fact.label} · abbreviated`;
  }
  return fact.label;
}

/** One shared semantic row order for the Ink and headless maps. Compact mode only joins labels. */
export function approvalNoticeRows(
  plan: ApprovalNoticePlan,
  options: ApprovalNoticeRowsOptions = {},
): readonly ApprovalNoticeRow[] {
  const stateMessage = stateNotice(plan);
  const compact = options.compact === true;
  const preserveDecisionEvidence = options.preserveDecisionEvidence === true;
  const factRows: readonly ApprovalNoticeRow[] =
    plan.facts === undefined
      ? [
          { kind: "label", text: "Requested action" },
          { kind: "detail", text: quotedDetail(plan.detail) },
        ]
      : compact
        ? plan.facts.map((fact) => ({
            kind: fact.exact === true || fact.compactWrap === true ? "evidence" : "detail",
            text: `${factLabel(fact, true)} · ${
              preserveDecisionEvidence
                ? (fact.constrainedValue ?? factText(fact))
                : (fact.compactValue ?? factText(fact))
            }`,
          }))
        : plan.facts.flatMap((fact) => [
            { kind: "label" as const, text: factLabel(fact, false) },
            {
              kind: fact.exact === true ? ("evidence" as const) : ("detail" as const),
              text: factText(fact),
            },
          ]);
  const consequenceRows: readonly ApprovalNoticeRow[] =
    compact && plan.state !== "pending" && plan.selectedChoice === undefined
      ? []
      : compact
        ? [
            {
              kind: "evidence",
              text:
                plan.state === "pending"
                  ? plan.sessionAvailable
                    ? "Consequence · once: this review · session: exact scope until exit"
                    : "Consequence · once: this review · Broader approval unavailable"
                  : `Consequence · ${plan.consequence}`,
            },
          ]
        : [
            { kind: "label", text: "Consequence" },
            { kind: "detail", text: plan.consequence },
          ];
  const nextRows: readonly ApprovalNoticeRow[] = compact
    ? [{ kind: "detail", text: `Next · ${COMPACT_APPROVAL_NEXT[plan.state]}` }]
    : [
        { kind: "label", text: "Next" },
        { kind: "detail", text: plan.next },
        ...(plan.state === "pending"
          ? [
              {
                kind: "detail" as const,
                text: plan.sessionAvailable
                  ? "Choose once, exact session scope, deny, or explain"
                  : "Choose once, deny, or explain",
              },
            ]
          : []),
      ];
  const actionRows: readonly ApprovalNoticeRow[] =
    compact && plan.facts !== undefined && plan.actions !== undefined
      ? [
          { kind: "action", text: "[a] Approve once" },
          ...(plan.sessionAvailable
            ? [{ kind: "action" as const, text: "[s] Session · exact scope" }]
            : []),
          { kind: "action", text: "[d] Deny · [?] Explain" },
        ]
      : (plan.actions ?? []).map((text) => ({ kind: "action" as const, text }));
  return [
    ...(compact && plan.facts !== undefined && plan.state === "pending"
      ? []
      : [
          {
            kind: plan.state === "indeterminate" ? ("warning" as const) : ("status" as const),
            text: stateMessage,
          },
        ]),
    ...factRows,
    ...(plan.state === "pending" && plan.message !== undefined
      ? [
          {
            kind: "message" as const,
            text: plan.message,
          },
        ]
      : []),
    ...consequenceRows,
    ...actionRows,
    ...(!compact && plan.sessionNote !== undefined
      ? [{ kind: "warning" as const, text: plan.sessionNote }]
      : []),
    ...(!(compact && plan.facts !== undefined) && plan.confirmation !== undefined
      ? [{ kind: "confirmation" as const, text: plan.confirmation }]
      : []),
    ...nextRows,
  ];
}

function stateNotice(plan: ApprovalNoticePlan): string {
  if (plan.state === "pending") return "Keel is paused until you choose.";
  if (plan.state === "submitted") {
    const waiting = "Decision sent. Keel is waiting for warden confirmation.";
    if (plan.message === undefined) return waiting;
    const detail = cleanLine(plan.message)
      .replace(
        /(?:review )?decision (?:already )?submitted\s*·?\s*waiting for warden confirmation\.?/giu,
        "",
      )
      .replace(/(?:^|\s)·\s*(?:$|·)/gu, " ")
      .replace(/^\s*·\s*|\s*·\s*$/gu, "")
      .trim();
    return detail.length === 0 ? waiting : boundedMessage(`${waiting} ${detail}`);
  }
  if (plan.state === "confirmed") {
    return plan.message ?? "Warden confirmed approval. Keel is resuming the governed action.";
  }
  if (plan.state === "governed-deny") {
    return (
      plan.message ??
      "Human approval was consumed; Warden returned deny. Inspect the governed tool result for effect truth."
    );
  }
  if (plan.state === "denied") {
    return plan.message ?? "Request denied. The action did not run.";
  }
  if (plan.state === "failed") {
    return (
      plan.message ?? "Decision not confirmed. No approval assumed; restart the governed session."
    );
  }
  return boundedMessage(
    plan.message?.startsWith("review outcome indeterminate") === true
      ? plan.message
      : `review outcome indeterminate · ${plan.message ?? "action may have executed · do not retry automatically · inspect audit"}`,
  );
}
