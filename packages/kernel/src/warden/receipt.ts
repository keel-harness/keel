import type { SessionEventT } from "@keel/shared";
import type { WardenReviewAutoResolvedEvent } from "./executor.js";

export type WardenAutoResolvedSessionEvent = Extract<
  SessionEventT,
  { readonly type: "warden_auto_resolved" }
>;

export interface WardenAutoResolvedLedgerStore {
  append(event: SessionEventT): void;
}

function nowIso(): string {
  return new Date().toISOString();
}

const MAX_RECEIPT_LABEL_CHARS = 160;

export interface AutoResolutionReceiptSummary {
  readonly automatic: readonly string[];
  readonly attention: readonly string[];
}

export function appendWardenAutoResolvedEvent(
  store: WardenAutoResolvedLedgerStore,
  event: WardenReviewAutoResolvedEvent,
  now: () => string = nowIso,
): void {
  store.append({
    type: "warden_auto_resolved",
    v: 1,
    ts: now(),
    source: event.source,
    ...(event.planId === undefined ? {} : { planId: event.planId }),
    resource: event.resource,
    reviewId: event.reviewId,
    scope: event.scope,
    auditSeq: event.auditSeq,
    verdict: event.verdict,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
  });
}

function oneLine(value: string): string {
  let output = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x1b && value[i + 1] === "[") {
      i += 2;
      while (i < value.length) {
        const finalCode = value.charCodeAt(i);
        if (finalCode >= 0x40 && finalCode <= 0x7e) break;
        i += 1;
      }
      continue;
    }
    output += code <= 0x1f || code === 0x7f ? " " : value.charAt(i);
  }
  const clean = output.replace(/\s+/gu, " ").trim();
  if (clean.length <= MAX_RECEIPT_LABEL_CHARS) return clean;
  return `${clean.slice(0, MAX_RECEIPT_LABEL_CHARS - 3)}...`;
}

function sourceLabel(event: WardenAutoResolvedSessionEvent): string {
  if (event.source === "plan-approval") {
    return `Plan Autopilot ${oneLine(event.planId ?? "plan")}`;
  }
  if (event.source === "session-grant") return "session grant (until session exit)";
  return "Autopilot command";
}

function resourceLabel(event: WardenAutoResolvedSessionEvent): string {
  return `${event.resource.kind} ${oneLine(event.resource.value)}`;
}

function allowedLine(event: WardenAutoResolvedSessionEvent): string {
  return [
    sourceLabel(event),
    "allowed",
    oneLine(event.toolName),
    "via",
    resourceLabel(event),
    `(review ${oneLine(event.reviewId)}, audit #${String(event.auditSeq)})`,
  ].join(" ");
}

function notAllowedLine(event: WardenAutoResolvedSessionEvent): string {
  return [
    sourceLabel(event),
    "resolved",
    event.verdict,
    "for",
    oneLine(event.toolName),
    "via",
    resourceLabel(event),
    `(review ${oneLine(event.reviewId)}, audit #${String(event.auditSeq)})`,
  ].join(" ");
}

function renderAllowedLine(event: WardenAutoResolvedSessionEvent): string {
  return `- ${allowedLine(event)}`;
}

function renderNotAllowedLine(event: WardenAutoResolvedSessionEvent): string {
  return `- ${notAllowedLine(event)}`;
}

function autoResolvedEvents(
  events: readonly SessionEventT[],
): readonly WardenAutoResolvedSessionEvent[] {
  return events.filter(
    (event): event is WardenAutoResolvedSessionEvent => event.type === "warden_auto_resolved",
  );
}

export function summarizeAutoResolutionReceipt(
  events: readonly SessionEventT[],
): AutoResolutionReceiptSummary | undefined {
  const autoResolved = autoResolvedEvents(events);
  if (autoResolved.length === 0) return undefined;

  return {
    automatic: autoResolved.filter((event) => event.verdict === "allow").map(allowedLine),
    attention: autoResolved.filter((event) => event.verdict !== "allow").map(notAllowedLine),
  };
}

export function renderAutoResolutionReceipt(events: readonly SessionEventT[]): string | undefined {
  const autoResolved = autoResolvedEvents(events);
  if (autoResolved.length === 0) return undefined;

  const allowed = autoResolved.filter((event) => event.verdict === "allow");
  const notAllowed = autoResolved.filter((event) => event.verdict !== "allow");
  const lines = ["Auto-resolution receipt"];
  if (allowed.length > 0) {
    lines.push("allowed automatically:", ...allowed.map(renderAllowedLine));
  }
  if (notAllowed.length > 0) {
    lines.push("not auto-allowed:", ...notAllowed.map(renderNotAllowedLine));
  }
  return lines.join("\n");
}
