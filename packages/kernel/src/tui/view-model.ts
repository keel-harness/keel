import type {
  JsonObjectT,
  ModelMessageT,
  SteeringClassT,
  UiContextStatus,
  UiCostStatus,
  UiAttentionMark,
  UiApprovalChoice,
  UiApprovalInformation,
  UiCurrentTurn,
  UiDensity,
  UiGitStatus,
  UiPolicyStatus,
  UiModelRouteStatus,
  UiMutationPresentation,
  UiQueuedInput,
  UiPosture,
  UiRecentSession,
  UiStatus,
  UiToolActivity,
  UiTurnFileEvidence,
  UiTurnSummary,
  UiUsageDigest,
  ViewItem,
  ViewModel,
} from "@keel/shared";
import { basename } from "node:path";
import { stopCodeNeedsAttention, type KernelEventT } from "../events.js";
import { KERNEL_STRINGS } from "../strings.js";
import {
  REVIEW_DECISION_UNCONFIRMED_SUFFIX,
  REVIEW_DENIAL_UNCONFIRMED_SUFFIX,
  REVIEW_RESOLUTION_INDETERMINATE_SUFFIX,
  unexpectedReviewDenialOutput,
} from "../review-settlement-copy.js";
import type { SessionSummary } from "../session/list.js";
import { INTERRUPTED_TOOL_RESULT } from "../session/resume.js";
import { workspaceKey } from "../session/workspace-key.js";
import {
  markToolPresentationOutcome,
  toolPresentationOutcome,
} from "../tool-presentation-outcome.js";
import { formatTokens } from "./format.js";
import { stripControl, stripControlLine } from "./strip.js";
import { toolOutcome } from "./tool-outcome.js";
import { mutationReviewUnavailableCopy } from "./tool-card.js";
import {
  expandTerminalTabs,
  graphemeSpans,
  takeDisplayCells,
  terminalDisplayWidth,
  truncateDisplayCells,
  wrapDisplayLine,
} from "./display-cells.js";
import { recoveredExploratoryFailureIndexes } from "./recovered-tool.js";
import { appendAssistantStream, beginAssistantStream } from "./stream-projection.js";
import {
  TUI_RUNTIME_TRUTH,
  TUI_TERMINAL_REVIEW_TRUTH,
  type UiRuntimeProtectionState,
} from "./strings.js";
import { visibleTerminalText } from "./visible-text.js";
import {
  markReviewSettlementPresentation,
  REVIEW_INDETERMINATE_SUMMARY,
  REVIEW_PENDING_SUMMARY,
} from "./review-settlement-presentation.js";
import { mutationPresentationResolverForEvent } from "../warden/mutation-presentation-resolver.js";
import type { MutationPresentationResolutionV1 } from "../warden/mutation-presentation-resolver.js";
import {
  associateMutationPresentationActivity,
  resolveMutationPresentationActivity,
} from "./mutation-presentation.js";
import { isLoopContinuationMessage } from "../run/loop-continuation.js";

// `stripControl` / `stripControlLine` (the security-critical control-byte sanitizers) are defined in
// `./strip.js` — extracted so that one chokepoint is auditable in isolation (TUI-2) — and re-exported
// here, so every caller importing them from this module is unchanged.
export { stripControl, stripControlLine };

/** One calm owner for queued-input detail; composer state owns the count and action semantics. */
function truncateDisplayLine(input: string, maxWidth: number): string {
  const normalized = expandTerminalTabs(input);
  return truncateDisplayCells(normalized, Math.max(0, Math.floor(maxWidth)));
}

export function queuedInputLine(
  inputs: readonly UiQueuedInput[],
  maxWidth = 80,
): string | undefined {
  return queuedInputLines(inputs, maxWidth, 1)[0];
}

/** Bounded multi-row queued preview. The later-input suffix is reserved before content is clipped. */
export function queuedInputLines(
  inputs: readonly UiQueuedInput[],
  maxWidth = 80,
  maxRows = 1,
): readonly string[] {
  const next = inputs[0];
  if (next === undefined) return [];
  const classLabel = next.class === "urgent" ? " · urgent" : "";
  const later = inputs.length > 1 ? ` · +${inputs.length - 1} later` : "";
  const prefix = `queued next${classLabel} · `;
  const content = stripControlLine(next.content);
  const width = Math.max(1, Math.floor(maxWidth));
  const rows = Math.max(1, Math.floor(maxRows));
  const capacity = width * rows - (rows - 1);
  const available = capacity - terminalDisplayWidth(prefix) - terminalDisplayWidth(later);
  const line =
    available <= 0
      ? truncateDisplayLine(`${prefix}${content}${later}`, capacity)
      : `${prefix}${truncateDisplayLine(content, available)}${later}`;
  return wrapDisplayLine(line, width).map((row) => row.text);
}

/**
 * UI-originated events the reducer folds alongside the loop's `KernelEvent`s (§4.10). The runner
 * emits these as mid-run input is observed/applied — keeping the view a pure function of one event
 * stream (the design's single source of "what to show"). Not loop events: they never touch the
 * ledger here (the runner persists steering via `recordSteering`/`applySteering`).
 */
export type UiInputEventT =
  | { readonly type: "input-queued"; readonly class: "queued" | "urgent"; readonly content: string }
  | { readonly type: "input-applied"; readonly content: string; readonly class: SteeringClassT }
  | { readonly type: "turn-not-final" }
  | { readonly type: "turn-finalized"; readonly summary: UiTurnSummary }
  | { readonly type: "goal-validation-started"; readonly action: string }
  | { readonly type: "goal-validation-finished" }
  | { readonly type: "interrupted" }
  | {
      readonly type: "tool-liveness";
      readonly itemIndex: number;
      readonly id: string;
      /** Absence clears presentation residue during exceptional teardown. */
      readonly elapsedMs?: number;
      readonly quietMs?: number;
      readonly timeoutMs?: number;
    }
  | { readonly type: "diff-mode-toggle" }
  | { readonly type: "density-set"; readonly density: UiDensity }
  | { readonly type: "capabilities-panel"; readonly prompt?: string }
  | { readonly type: "about-panel" }
  | { readonly type: "policies-panel" }
  | { readonly type: "context-panel" }
  | { readonly type: "model-panel"; readonly content: string }
  | { readonly type: "compact-review" }
  | { readonly type: "review-queue-panel" }
  | {
      readonly type: "approval-opened";
      readonly detail: string;
      readonly sessionAvailable: boolean;
      readonly information?: UiApprovalInformation;
    }
  | { readonly type: "approval-message"; readonly content: string }
  | {
      readonly type: "approval-submitted";
      readonly content: string;
      readonly choice?: UiApprovalChoice;
    }
  | { readonly type: "approval-confirmed"; readonly content: string }
  | { readonly type: "approval-governed-deny"; readonly content: string }
  | { readonly type: "approval-denied"; readonly content: string }
  | { readonly type: "approval-indeterminate"; readonly content: string }
  | { readonly type: "approval-failed"; readonly content: string }
  | { readonly type: "approval-closed"; readonly content?: string }
  | { readonly type: "system-notice"; readonly content: string }
  | {
      readonly type: "auto-resolution-receipt";
      readonly automatic: readonly string[];
      readonly attention: readonly string[];
    }
  | { readonly type: "awaiting-input" };

function approvalLine(value: string): string {
  return visibleTerminalText(stripControlLine(value)).replace(/\s+/gu, " ").trim();
}

function approvalLineTail(value: string, maxWidth: number): string {
  const tail: string[] = [];
  let usedWidth = 0;
  const spans = graphemeSpans(value);
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index];
    if (span === undefined) continue;
    const width = terminalDisplayWidth(span.text);
    if (usedWidth + width > maxWidth) break;
    tail.unshift(span.text);
    usedWidth += width;
  }
  return tail.join("").trimStart();
}

/**
 * Bound untrusted approval presentation before it enters the live ViewModel. Keeping a bounded
 * tail is intentional: settlement copy ends with the operator's safe recovery action, while the
 * head preserves what the message is about. Display-cell accounting also avoids splitting a
 * grapheme or overflowing because a wide terminal glyph was counted as one code point.
 */
function boundedApprovalLine(value: string, maxWidth: number, tailWidth?: number): string {
  const one = approvalLine(value);
  const budget = Math.max(0, Math.floor(maxWidth));
  if (terminalDisplayWidth(one) <= budget) return one;
  if (budget === 0) return "";

  const marker = " … ";
  const markerWidth = terminalDisplayWidth(marker);
  if (markerWidth >= budget) return takeDisplayCells(marker, budget).text;

  const requestedTailWidth = Math.max(
    0,
    Math.floor(tailWidth ?? Math.min(160, Math.floor(budget / 3))),
  );
  const tail = approvalLineTail(one, Math.min(requestedTailWidth, budget - markerWidth));
  const headWidth = Math.max(0, budget - markerWidth - terminalDisplayWidth(tail));
  const head = takeDisplayCells(one, headWidth).text.trimEnd();
  return `${head}${marker}${tail}`;
}

function sanitizedApprovalInformation(information: UiApprovalInformation): UiApprovalInformation {
  const requestedAction =
    information.requestedAction.status === "available"
      ? {
          status: "available" as const,
          value: boundedApprovalLine(information.requestedAction.value, 160, 48),
        }
      : {
          status: "unavailable" as const,
          reason: boundedApprovalLine(information.requestedAction.reason, 160, 64),
        };
  const effectiveTarget =
    information.effectiveTarget.status === "available"
      ? {
          status: "available" as const,
          value: boundedApprovalLine(information.effectiveTarget.value, 2_048, 512),
          completeness: information.effectiveTarget.completeness,
        }
      : {
          status: "unavailable" as const,
          reason: boundedApprovalLine(information.effectiveTarget.reason, 2_048, 512),
        };
  const reason =
    information.reason.status === "available"
      ? {
          status: "available" as const,
          value: boundedApprovalLine(information.reason.value, 320, 120),
        }
      : {
          status: "unavailable" as const,
          reason: boundedApprovalLine(information.reason.reason, 320, 120),
        };
  const policyDetail =
    information.policyDetail.status === "available"
      ? {
          status: "available" as const,
          value: boundedApprovalLine(information.policyDetail.value, 320, 120),
        }
      : {
          status: "unavailable" as const,
          reason: boundedApprovalLine(information.policyDetail.reason, 320, 120),
        };
  const resource = information.exactResource;
  const exactResource =
    resource.status === "unavailable"
      ? {
          status: "unavailable" as const,
          reason: boundedApprovalLine(resource.reason, 384, 144),
        }
      : resource.kind === "console"
        ? {
            status: "available" as const,
            kind: "console" as const,
            target: boundedApprovalLine(resource.target, 384, 144),
            key: boundedApprovalLine(resource.key, 384, 144),
          }
        : {
            status: "available" as const,
            kind: resource.kind,
            value: boundedApprovalLine(resource.value, 384, 144),
          };
  return { requestedAction, effectiveTarget, reason, policyDetail, exactResource };
}

/** Calm interrupt note (§8.6 — one line, no stack trace). Neutral wording so it is honest in BOTH the
 *  persistent REPL (the turn stopped; the session stays open — just type) and the one-shot run (the
 *  process exits; the session is saved + resumable). Avoids the old "resume with `keel sessions resume`"
 *  imperative, which contradicted the live "type to continue" prompt in the multi-turn REPL (slice-9 QC). */
const INTERRUPTED_NOTE = "⏸ interrupted — the turn was stopped (the session is saved)";
const GOAL_VALIDATION_ACTION = Symbol("keel.goal-validation-action");
type LocalViewModel = ViewModel & { [GOAL_VALIDATION_ACTION]?: string };

function goalValidationAction(view: ViewModel): string | undefined {
  return (view as LocalViewModel)[GOAL_VALIDATION_ACTION];
}

function withGoalValidationAction(view: ViewModel, action: string | undefined): ViewModel {
  const next: LocalViewModel = { ...view };
  if (action === undefined) delete next[GOAL_VALIDATION_ACTION];
  else next[GOAL_VALIDATION_ACTION] = action;
  return next;
}

/** The `?` help / `/help` key reference — the durable place the epic's input affordances live (the
 *  first-run text scrolls away). One source, mapped by BOTH renderers so they can never drift. */
export const HELP_LINES: readonly string[] = [
  "common actions",
  "  Type a task, then press Enter. Use @ for files.",
  "  /diff changes · /policies protections · /reviews history",
  "  /context session · /model model · /exit quit",
  "checked work",
  '  /goal TASK --check "CMD"',
  '  /loop TASK --until "CMD"',
  "keyboard",
  "  Tab completes · ↑/↓ history · Ctrl-R search · ^G editor",
  "  Esc closes panels; while working, stops turn · Ctrl-C twice quits",
];

/**
 * Whether a view item is hidden at the given presentation density. `quiet` hides ONLY routine
 * successful tool cards \u2014 a failed tool, a running tool, and every message always show. The single
 * source the three renderer call sites map (Ink's item filter + headless's transcript loop + the
 * headless streaming sink), so the predicate can never drift between them. Presentation only \u2014 this
 * never implies a trust/autonomy mode (UiDensity is a view setting, not enforcement).
 */
export function isHiddenInDensity(item: ViewItem, density: ViewModel["density"]): boolean {
  return (
    density === "quiet" &&
    item.kind === "tool" &&
    toolOutcome(item) === "done" &&
    item.mutationPresentation === undefined
  );
}

/** Human-readable reason for abnormal terminals. Clean `model-stop` and `aborted` add no notice;
 *  attention-coded `model-stop` uses the stop detail instead of this map. */
const TERMINAL_FAILURE: Partial<Record<string, string>> = {
  error: "the model/provider returned an error",
  "max-turns": "it hit the turn limit before finishing",
  budget:
    "it reached the token budget (raise KEEL_MAX_TOKENS / KEEL_MAX_GROSS_TOKENS / KEEL_MAX_OUTPUT_TOKENS to allow more)",
  "loop-detected": "a loop was detected and the run was halted",
  length: "the model hit its output-length limit",
  deadline: "it reached the wall-clock budget (raise KEEL_MAX_WALL_SEC to allow more time)",
};

/** Neutral all-off facts. Route meaning comes only from controller-owned `protectionRoute`. */
export const ALL_OFF_POSTURE: UiPosture = { sandbox: false, egress: false, audit: false };
/** @deprecated Source-compatibility alias for pre-ADR-0080 tests and integrations. */
export const PHASE1_POSTURE = ALL_OFF_POSTURE;

function postureControls(p: UiPosture): string {
  const g = (on: boolean): string => (on ? "●" : "○");
  return `${g(p.sandbox)} sandbox · ${g(p.egress)} egress · ${g(p.audit)} audit`;
}

const finiteNumber = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n);

function clampedPercent(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function formatGitStatus(git: UiGitStatus | undefined): string {
  if (git === undefined) return "git n/a";
  const branch = git.branch !== undefined ? stripControlLine(git.branch).trim() : "";
  const deltas: string[] = [];
  const add = finiteNumber(git.added) ? Math.max(0, Math.trunc(git.added)) : 0;
  const modified = finiteNumber(git.modified) ? Math.max(0, Math.trunc(git.modified)) : 0;
  const deleted = finiteNumber(git.deleted) ? Math.max(0, Math.trunc(git.deleted)) : 0;
  if (add > 0) deltas.push(`+${add}`);
  if (modified > 0) deltas.push(`~${modified}`);
  if (deleted > 0) deltas.push(`-${deleted}`);
  if (branch.length === 0 && deltas.length === 0) return "git n/a";
  return ["git", branch.length > 0 ? branch : "n/a", ...deltas].join(" ");
}

function formatContextStatus(s: UiStatus): string {
  if (finiteNumber(s.context?.percent)) return `ctx ${clampedPercent(s.context.percent)}%`;
  return "ctx n/a";
}

// NOTE (Epic 1.24 Tier-A QC): the cockpit does NOT render a cost segment — the interactive kernel has
// no honest per-session cost source (real cost accounting lives in @keel/eval, ADR-0044/0047).
// Rendering a permanent `cost n/a` slot read as unfinished; rendering a fabricated number would violate
// §4.9.1. `UiCostStatus` / `ViewConfig.cost` stay as a RESERVED, UN-rendered seam for when a provider
// cost report is wired (a MODEL-NOW → P2 item).

function policySegment(
  policy: UiPolicyStatus | undefined,
  state: UiRuntimeProtectionState,
): string {
  if (policy?.active !== true) return "○ policy none";
  if (state !== "governed") return "● policy active";
  const label = policy.label !== undefined ? stripControlLine(policy.label).trim() : "";
  return `● policy ${label.length > 0 ? label : "active"}`;
}

function isStartingProtections(s: UiStatus): boolean {
  return s.startup?.phase === "starting-protections";
}

function isProtectionsUnavailable(s: UiStatus): boolean {
  return s.startup?.phase === "protections-unavailable";
}

function runtimeProtectionState(s: UiStatus): UiRuntimeProtectionState {
  if (isStartingProtections(s)) return "starting";
  if (isProtectionsUnavailable(s)) return "unavailable";
  return s.protectionRoute ?? "not-reported";
}

function runtimeProtectionLead(state: UiRuntimeProtectionState): string {
  const copy = TUI_RUNTIME_TRUTH[state];
  return [`protection: ${copy.label}`, copy.qualifier].filter(Boolean).join(" · ");
}

function boundedRuntimeProtectionLead(state: UiRuntimeProtectionState, columns: number): string {
  if (columns > 40) return truncateLine(runtimeProtectionLead(state), columns);
  switch (state) {
    case "starting":
      return "protection: starting · input waits";
    case "deliberately-unenforced":
      return "protection: UNENFORCED · direct";
    case "not-reported":
      return "protection: status not reported";
    default:
      return truncateLine(runtimeProtectionLead(state), columns);
  }
}

/**
 * Persistent cockpit status bar (Epic 1.24 slice 2): operational metadata first, then the honest
 * posture. Unknown git/context/cost fields render as `n/a`; absent route state stays unreported. This
 * function is the renderer source of truth, so Ink and headless cannot drift or invent enforcement.
 */
function cockpitMetaLine(s: UiStatus): string {
  return [
    s.model !== undefined ? stripControlLine(s.model).trim() : undefined,
    s.modelRoute !== undefined ? `route ${stripControlLine(s.modelRoute.mode)}` : undefined,
    s.cwd !== undefined && s.cwd.length > 0 ? basename(stripControlLine(s.cwd)) : undefined,
    s.workspaceTrust !== undefined ? `workspace ${s.workspaceTrust}` : undefined,
    formatGitStatus(s.git),
  ]
    .filter((x): x is string => x !== undefined && x.length > 0)
    .join(" · ");
}

function cockpitTelemetryLine(s: UiStatus): string {
  return [formatContextStatus(s), `total ${formatTokens(s.tokens)} tok`].join(" · ");
}

function cockpitControlsLine(s: UiStatus): string {
  if (isStartingProtections(s)) return "○ protections starting";
  if (isProtectionsUnavailable(s)) return "○ protections unavailable";
  return postureControls(s.posture);
}

function cockpitClaimLine(s: UiStatus): string {
  const state = runtimeProtectionState(s);
  if (state === "starting" || state === "unavailable") return runtimeProtectionLead(state);
  return `${runtimeProtectionLead(state)}   ${policySegment(s.policy, state)}`;
}

function compactModelLabel(model: string | undefined, narrow: boolean): string | undefined {
  if (model === undefined) return undefined;
  if (!narrow) return model;
  const parts = model.split("/").filter((part) => part.length > 0);
  return parts.at(-1) ?? model;
}

function joinCompactParts(parts: readonly (string | undefined)[]): string {
  return parts.filter((x): x is string => x !== undefined && x.length > 0).join(" · ");
}

function compactMetaLine(s: UiStatus, columns: number | undefined): string {
  const git = formatGitStatus(s.git);
  const narrow = columns !== undefined && columns <= 60;
  const model = compactModelLabel(
    s.model !== undefined ? stripControlLine(s.model).trim() : undefined,
    narrow,
  );
  const workspace =
    s.cwd !== undefined && s.cwd.length > 0 ? basename(stripControlLine(s.cwd)) : undefined;
  const gitPart = git !== "git n/a" ? git : undefined;
  const tokenPart = s.tokens > 0 ? `${formatTokens(s.tokens)} tokens` : undefined;
  const trustPart = s.workspaceTrust !== undefined ? `workspace ${s.workspaceTrust}` : undefined;
  if (!narrow) return joinCompactParts([model, workspace, trustPart, gitPart, tokenPart]);

  const candidates =
    trustPart !== undefined
      ? ([
          [model, trustPart, tokenPart],
          [model, gitPart, trustPart],
          [model, workspace, trustPart],
          [model, trustPart],
          [model, gitPart, tokenPart],
          [model, workspace, tokenPart],
          [model, tokenPart],
          [model, gitPart],
          [model, workspace],
          [model],
        ] as const)
      : ([
          [model, gitPart, tokenPart],
          [model, workspace, tokenPart],
          [model, tokenPart],
          [model, gitPart],
          [model, workspace],
          [model],
        ] as const);
  for (const parts of candidates) {
    const line = joinCompactParts(parts);
    if (columns === undefined || terminalDisplayWidth(line) <= columns) return line;
  }
  const line = joinCompactParts([model, tokenPart]);
  return columns === undefined ? line : truncateLine(line, columns);
}

export function cockpitStatusRows(s: UiStatus): readonly string[] {
  return [
    cockpitMetaLine(s),
    cockpitTelemetryLine(s),
    cockpitControlsLine(s),
    cockpitClaimLine(s),
  ].filter((x) => x.length > 0);
}

/** One-line cockpit status for headless/non-TTY; Ink maps `cockpitStatusRows` to avoid ugly wraps. */
export function cockpitStatusLine(s: UiStatus): string {
  return cockpitStatusRows(s).join("   ");
}

interface CompactStatusOptions {
  readonly columns?: number;
}

interface StatusRowsOptions extends CompactStatusOptions {
  readonly density?: ViewModel["density"];
  readonly diffMode?: ViewModel["diffMode"];
}

function auditPostureLabel(status: UiStatus): "on" | "unseen" | "off" {
  if (status.posture.audit) return "on";
  if (status.posture.sandbox || status.posture.egress) {
    return "unseen";
  }
  return "off";
}

function visiblePolicyLabel(s: UiStatus, state: UiRuntimeProtectionState): string {
  if (s.policy?.active !== true) return "off";
  if (state !== "governed") return "active";
  const label = stripControlLine(s.policy.label ?? "").trim();
  return label.length > 0 ? label : "active";
}

function primaryPolicyLabel(s: UiStatus, state: UiRuntimeProtectionState): string {
  return visiblePolicyLabel(s, state).split("·", 1)[0]?.trim() || "active";
}

function protectionFactLine(s: UiStatus, state: UiRuntimeProtectionState): string {
  return [
    `sandbox ${onOff(s.posture.sandbox)}`,
    `egress guard ${onOff(s.posture.egress)}`,
    `policy ${visiblePolicyLabel(s, state)}`,
    `audit ${auditPostureLabel(s)}`,
  ].join(" · ");
}

function wideProtectionFactLine(s: UiStatus, state: UiRuntimeProtectionState): string {
  return [
    `sandbox ${onOff(s.posture.sandbox)}`,
    `egress guard ${onOff(s.posture.egress)}`,
    `policy ${primaryPolicyLabel(s, state)}`,
    `audit ${auditPostureLabel(s)}`,
  ].join(" · ");
}

function compactProtectionFactLine(s: UiStatus): string {
  return [
    `sbx:${onOff(s.posture.sandbox)}`,
    `net:${onOff(s.posture.egress)}`,
    `p:${s.policy?.active === true ? "on" : "off"}`,
    `aud:${auditPostureLabel(s)}`,
  ].join(" · ");
}

function mediumProtectionFactLine(s: UiStatus): string {
  return [
    `sbx:${onOff(s.posture.sandbox)}`,
    `net:${onOff(s.posture.egress)}`,
    `policy:${s.policy?.active === true ? "on" : "off"}`,
    `audit:${auditPostureLabel(s)}`,
  ].join(" · ");
}

function mediumProtectionLine(
  s: UiStatus,
  state: UiRuntimeProtectionState,
  columns: number,
): string | undefined {
  if (columns <= 60) return undefined;
  if (state === "governed") {
    const prefix = `protection: governed · sbx:${onOff(s.posture.sandbox)} · net:${onOff(s.posture.egress)} · policy:`;
    const suffix = ` · audit:${auditPostureLabel(s)}`;
    const label = primaryPolicyLabel(s, state);
    const line = `${prefix}${label}${suffix}`;
    return terminalDisplayWidth(line) <= columns ? line : undefined;
  }
  const label =
    state === "deliberately-unenforced"
      ? "protection: UNENFORCED · direct"
      : `protection: ${TUI_RUNTIME_TRUTH[state].label}`;
  const line = `${label} · ${mediumProtectionFactLine(s)}`;
  return terminalDisplayWidth(line) <= columns ? line : undefined;
}

function compactProtectionRows(s: UiStatus, columns: number | undefined): readonly string[] {
  const state = runtimeProtectionState(s);
  const lead = runtimeProtectionLead(state);
  if (state === "starting" || state === "unavailable") {
    return [columns === undefined ? lead : boundedRuntimeProtectionLead(state, columns)];
  }

  const facts =
    columns === undefined ? protectionFactLine(s, state) : wideProtectionFactLine(s, state);
  const full = `${lead} · ${facts}`;
  if (columns === undefined && state === "governed") return [full];

  const effectiveColumns = columns ?? 80;
  if (effectiveColumns > 80 && terminalDisplayWidth(full) <= effectiveColumns) return [full];

  const medium = mediumProtectionLine(s, state, effectiveColumns);
  if (medium !== undefined) return [medium];

  if (state === "governed") {
    const policyPrefix = "policy ";
    const policySuffix = ` · audit ${auditPostureLabel(s)}`;
    const rawPolicy = primaryPolicyLabel(s, state);
    const policy = truncateLine(
      rawPolicy,
      Math.max(
        1,
        effectiveColumns - terminalDisplayWidth(policyPrefix) - terminalDisplayWidth(policySuffix),
      ),
    );
    return [
      truncateLine(
        `protection: governed · sbx:${onOff(s.posture.sandbox)} · net:${onOff(s.posture.egress)}`,
        effectiveColumns,
      ),
      `${policyPrefix}${policy}${policySuffix}`,
    ];
  }

  const boundedLead = boundedRuntimeProtectionLead(state, effectiveColumns);
  const compactFacts = compactProtectionFactLine(s);
  return [boundedLead, truncateLine(compactFacts, effectiveColumns)];
}

/** Compact default live HUD: one operational line plus one plain-language protection line. */
export function compactStatusRows(
  s: UiStatus,
  options: CompactStatusOptions = {},
): readonly string[] {
  return [compactMetaLine(s, options.columns), ...compactProtectionRows(s, options.columns)].filter(
    (x) => x.length > 0,
  );
}

/** Adds non-default local presentation settings to the existing metadata row, never a new HUD row. */
export function statusRows(status: UiStatus, options: StatusRowsOptions = {}): readonly string[] {
  const rows =
    options.density === "debug"
      ? [...cockpitStatusRows(status)]
      : [...compactStatusRows(status, options)];
  const settings = [
    options.density !== undefined && options.density !== "normal"
      ? `view ${options.density}`
      : undefined,
    options.diffMode === "full" ? "diff full" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (settings.length === 0) return rows;
  if (rows.length === 0) return settings;
  const settingText = settings.join(" · ");
  const suffix = ` · ${settingText}`;
  if (options.columns !== undefined) {
    const baseWidth = options.columns - terminalDisplayWidth(suffix);
    rows[0] =
      baseWidth > 0
        ? `${truncateLine(rows[0] ?? "", baseWidth)}${suffix}`
        : truncateLine(settingText, options.columns);
  } else {
    rows[0] = `${rows[0]}${suffix}`;
  }
  return rows;
}

/**
 * The `/context` panel (Epic 1.23 slice 8): a calm, on-demand restatement of the session's context
 * state, drawn ENTIRELY from the already-control-stripped `UiStatus` — the model, workspace, the
 * provider's last token-usage report, and controller-bound protection state. Never model self-report,
 * never a faked enforcement mode (Autopilot ≠ YOLO): an absent route remains explicitly unreported.
 */
function isViewModel(source: UiStatus | ViewModel): source is ViewModel {
  return Array.isArray((source as ViewModel).items);
}

function panelStatus(source: UiStatus | ViewModel): UiStatus {
  return isViewModel(source) ? source.status : source;
}

const estimatePanelTokens = (text: string): number => Math.ceil(stripControl(text).length / 4);

type ContextBucketLabel = "system" | "user" | "assistant" | "tools" | "final";
interface ContextBucket {
  readonly label: ContextBucketLabel;
  readonly tokens: number;
  readonly items: number;
}

const BUCKETS: readonly ContextBucketLabel[] = ["system", "user", "assistant", "tools", "final"];

function itemPanelText(item: ViewItem): string {
  if (item.kind === "message") return item.content;
  const diff = item.diff?.map((d) => d.text).join("\n") ?? "";
  return [item.name, item.summary, diff].filter((s) => s.length > 0).join("\n");
}

function contextBuckets(view: ViewModel): readonly ContextBucket[] {
  const buckets = new Map<ContextBucketLabel, { tokens: number; items: number }>();
  const add = (label: ContextBucketLabel, text: string): void => {
    const prev = buckets.get(label) ?? { tokens: 0, items: 0 };
    buckets.set(label, {
      tokens: prev.tokens + estimatePanelTokens(text),
      items: prev.items + 1,
    });
  };
  for (const item of view.items) {
    if (item.kind === "tool") add("tools", itemPanelText(item));
    else add(item.role, item.content);
  }
  if (view.turnSummary !== undefined) {
    add(
      "final",
      [
        view.turnSummary.title,
        view.turnSummary.answer ?? "",
        ...view.turnSummary.changed,
        ...view.turnSummary.checked,
        ...(view.turnSummary.fileEvidence ?? []).map((entry) => entry.text),
        ...(view.turnSummary.ran ?? []),
        ...(view.turnSummary.automatic ?? []),
        ...(view.turnSummary.receipt ?? []),
        ...view.turnSummary.attention,
      ].join("\n"),
    );
  }
  return BUCKETS.flatMap((label) => {
    const bucket = buckets.get(label);
    return bucket !== undefined && bucket.items > 0 ? [{ label, ...bucket }] : [];
  });
}

function contextWindowLine(s: UiStatus): string {
  if (finiteNumber(s.context?.percent) && finiteNumber(s.context?.maxTokens)) {
    return `${clampedPercent(s.context.percent)}% of ${formatTokens(s.context.maxTokens)}`;
  }
  if (finiteNumber(s.context?.percent)) return `${clampedPercent(s.context.percent)}%`;
  if (finiteNumber(s.context?.maxTokens) && s.context.maxTokens > 0)
    return `n/a of ${formatTokens(s.context.maxTokens)}`;
  return "n/a";
}

function bucketLines(view: ViewModel): readonly string[] {
  const buckets = contextBuckets(view);
  if (buckets.length === 0) return ["    none: 0 tok · 0 items"];
  return buckets.map(
    (b) =>
      `    ${b.label}: ${formatTokens(b.tokens)} tok · ${b.items} item${b.items === 1 ? "" : "s"}`,
  );
}

export function contextPanel(source: UiStatus | ViewModel): string {
  const s = panelStatus(source);
  const protection = TUI_RUNTIME_TRUTH[runtimeProtectionState(s)];
  const trustSuffix = s.workspaceTrust === undefined ? "" : ` · ${s.workspaceTrust}`;
  const projectInput =
    s.workspaceTrust === "untrusted"
      ? "empty — workspace not trusted"
      : s.workspaceTrust === "trusted"
        ? "eligible — workspace trusted"
        : "trust not reported";
  const lines = [
    "context",
    `  model:       ${s.model ?? "(default)"}`,
    `  route:       ${s.modelRoute?.mode ?? "locked"} · ${s.modelRoute?.status ?? "unknown"}`,
    `  workspace:   ${s.cwd ? basename(s.cwd) : "(none)"}${trustSuffix}`,
    `  project input: ${projectInput}`,
    `  total:       ~${formatTokens(s.tokens)} tokens (cumulative provider usage)`,
    `  window:      ${contextWindowLine(s)}`,
    `  composition: ${
      isViewModel(source)
        ? "visible estimate (not provider billing)"
        : "unavailable on status-only surface"
    }`,
    ...(isViewModel(source) ? bucketLines(source) : []),
    "  compaction:  /compact reviews a proposal; no manual rewrite is executed from this panel",
    "  protections: /policies shows carried protection status",
    `  enforcement: ${protection.panel}`,
  ];
  return lines.join("\n");
}

function formatRouteStatus(status: UiModelRouteStatus | undefined): UiModelRouteStatus {
  return status ?? { mode: "locked", status: "unknown" };
}

export function modelPanel(
  source: UiStatus | ViewModel,
  variant: "status" | "why" | "preview" = "status",
): string {
  const s = panelStatus(source);
  const route = formatRouteStatus(s.modelRoute);
  const selected = route.selected ?? "(none)";
  return [
    "model",
    `  current: ${s.model ?? "(default)"}`,
    `  route mode: ${route.mode}`,
    `  status: ${route.status}`,
    `  selected: ${selected}`,
    ...(route.reason !== undefined ? [`  why: ${stripControlLine(route.reason)}`] : []),
    ...(route.lastDecisionId !== undefined
      ? [`  decision: ${stripControlLine(route.lastDecisionId)}`]
      : []),
    ...(variant === "preview" ? ["  preview: decision only · zero upstream call"] : []),
  ].join("\n");
}

export function capabilitiesPanel(source: UiStatus | ViewModel): string {
  const s = panelStatus(source);
  const protection = TUI_RUNTIME_TRUTH[runtimeProtectionState(s)];
  const workspace = s.cwd !== undefined && s.cwd.length > 0 ? basename(s.cwd) : "(none)";
  const model =
    s.model !== undefined && s.model.length > 0 ? stripControlLine(s.model) : "(default)";
  return [
    "capabilities",
    "  scope: coding tasks in this workspace",
    `  here: model ${model} · workspace ${stripControlLine(workspace)}`,
    "  read: inspect files, trace code, explain architecture",
    "  edit: make targeted changes, keep diffs reviewable",
    "  run: tests, typechecks, linters, and shell commands",
    "  find: search file names and contents; use @ to mention files",
    "  steer: type follow-ups while a turn runs; esc interrupts",
    "  resume: keel --continue · keel --resume <id>",
    "  inspect: /context for session details; /policies for protections; /compact to preview a shorter session summary",
    `  controls: ${protection.panel}`,
    "  start: describe the change you want, or ask about a file/function",
  ].join("\n");
}

export function aboutPanel(source: UiStatus | ViewModel): string {
  const s = panelStatus(source);
  const workspace = s.cwd !== undefined && s.cwd.length > 0 ? basename(s.cwd) : "(none)";
  const model =
    s.model !== undefined && s.model.length > 0 ? stripControlLine(s.model) : "(default)";
  return [
    "about",
    "  keel: governance-native coding agent",
    "  values: local-first · zero telemetry · Apache-2.0",
    `  here: model ${model} · workspace ${stripControlLine(workspace)}`,
    "  protection: /policies shows sandbox · egress guard · policy · audit",
    "  start: describe the change you want, or ask about a file/function",
    "  help: /help for commands · /capabilities for what keel can do here",
  ].join("\n");
}

function onOff(value: boolean): "on" | "off" {
  return value ? "on" : "off";
}

function policyPanelLine(
  policy: UiPolicyStatus | undefined,
  state: UiRuntimeProtectionState,
): string {
  if (policy?.active !== true) return "none active";
  if (state !== "governed") return "active (mode not shown outside governed route)";
  const label = policy.label !== undefined ? stripControlLine(policy.label).trim() : "";
  return label.length > 0 ? label : "active (label unavailable)";
}

function reviewSnapshotLine(view: ViewModel | undefined): string {
  if (view?.pendingReviews !== undefined) {
    const count = Math.max(0, Math.trunc(view.pendingReviews));
    return `${count} waiting · active turn`;
  }
  if (view?.lastWardenPendingReviews !== undefined) {
    const count = Math.max(0, Math.trunc(view.lastWardenPendingReviews));
    return `${count} · snapshot, not live`;
  }
  return "unavailable";
}

export function protectionsPanel(source: UiStatus | ViewModel): string {
  const s = panelStatus(source);
  const view = isViewModel(source) ? source : undefined;
  const state = runtimeProtectionState(s);
  const truth = TUI_RUNTIME_TRUTH[state];
  const lifecycle = state === "starting" || state === "unavailable";
  const headingQualifier =
    state === "starting"
      ? "input waits"
      : state === "deliberately-unenforced"
        ? "direct"
        : state === "unavailable"
          ? "tools halted"
          : undefined;
  return [
    ["policies", truth.label, headingQualifier].filter(Boolean).join(" · "),
    `  policy: ${lifecycle ? state : policyPanelLine(s.policy, state)}`,
    lifecycle
      ? `  protections: ${truth.panel}`
      : `  sandbox ${onOff(s.posture.sandbox)} · egress guard ${onOff(s.posture.egress)} · audit ${auditPostureLabel(s)}`,
    `  reviews: ${lifecycle ? `${state} — no review action available` : reviewSnapshotLine(view)}`,
    state === "governed"
      ? "  next session mode (run in shell): keel autopilot mode set --help"
      : `  mode changes: unavailable while protection is ${truth.label}`,
    "  read-only: changes nothing; approvals appear in a focused prompt",
    "  guide: docs/guide/policy-guide.md",
  ].join("\n");
}

function panelOverlay(content: string): NonNullable<ViewModel["overlay"]> {
  return { kind: "panel", content: stripControl(content) };
}

function compactCandidateTokens(view: ViewModel): number {
  const recentStart = Math.max(0, view.items.length - 3);
  return view.items.reduce((sum, item, index) => {
    if (item.kind === "tool" && item.status === "ok")
      return sum + estimatePanelTokens(itemPanelText(item));
    if (index < recentStart && item.kind === "message" && item.role === "assistant") {
      return sum + estimatePanelTokens(item.content);
    }
    return sum;
  }, 0);
}

export function compactReview(view: ViewModel): string {
  const candidateTokens = compactCandidateTokens(view);
  const savings = Math.max(0, Math.floor(candidateTokens * 0.65));
  const summarize =
    candidateTokens > 0
      ? "older assistant prose and routine successful tool detail into a task-state summary"
      : "nothing material yet; the visible context is already small";
  return [
    "compact proposal",
    "  status: review only — manual compaction is not executed from this TUI",
    "  preserve: latest user/assistant turns; failed tools; standing system context",
    `  summarize: ${summarize}`,
    "  drop: nothing automatically; raw session ledger remains canonical",
    `  est. savings: ~${formatTokens(savings)} tok (visible estimate, not provider billing)`,
    "  automatic: threshold compaction may run when configured; no provenance or tamper-evidence claim",
  ].join("\n");
}

// Keep the historical prefix so resumed sessions from before the explicit "not executed" copy still
// populate /reviews.
const REVIEW_PREFIXES = [
  TUI_TERMINAL_REVIEW_TRUTH.summaryPrefix,
  "warden review required (not executed):",
  "warden review required:",
];
const MAX_VISIBLE_REVIEW_LINES = 5;

const TERMINAL_REVIEW_NO_LIVE_MARKERS = [
  "no live review was opened by this kernel; no approval can be resolved from this result",
  "no live approval is active",
] as const;

function isTerminalReviewWithoutLiveDecision(summary: string): boolean {
  const lower = summary.toLowerCase();
  return (
    REVIEW_PREFIXES.some((prefix) => lower.startsWith(prefix)) &&
    TERMINAL_REVIEW_NO_LIVE_MARKERS.some((marker) => lower.includes(marker))
  );
}

function reviewDetail(summary: string, terminalWithoutLiveDecision = false): string | undefined {
  const lower = summary.toLowerCase();
  const prefix = REVIEW_PREFIXES.find((candidate) => lower.startsWith(candidate));
  if (prefix === undefined) return undefined;
  const detail = summary.slice(prefix.length).trim();
  return detail.length > 0
    ? sanitizeVisibleReviewDetail(detail, terminalWithoutLiveDecision)
    : summary;
}

function sanitizeVisibleReviewDetail(detail: string, terminalWithoutLiveDecision: boolean): string {
  const safe = detail
    .split(";")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .filter((segment) => !/\[[^\]]+\]/u.test(segment))
    .filter((segment) => !/^allow:/iu.test(segment))
    .filter((segment) => !/exact command envelope only/iu.test(segment))
    .filter((segment) => !/^no live review was opened by this kernel$/iu.test(segment))
    .filter((segment) => !/^no approval can be resolved from this result$/iu.test(segment))
    .filter((segment) => !/^simplify the request, then rerun$/iu.test(segment))
    .filter((segment) => !terminalWithoutLiveDecision || !/\bask for approval\.?$/iu.test(segment))
    .join("; ");
  return safe.length > 0 ? safe : "review detail available in transcript; no live approval here";
}

function visibleReviewLines(view: ViewModel): readonly string[] {
  return view.items
    .flatMap((item): string[] => {
      if (item.kind !== "tool" || item.status !== "error") return [];
      const summary = stripControlLine(item.summary).trim();
      const detail = reviewDetail(summary, isTerminalReviewWithoutLiveDecision(summary));
      if (detail === undefined) return [];
      return [truncateLine(detail, 180)];
    })
    .slice(-MAX_VISIBLE_REVIEW_LINES);
}

export function reviewQueuePanel(view: ViewModel): string {
  const liveCount = Math.max(0, Math.trunc(view.pendingReviews ?? 0));
  const liveStatus = liveCount === 0 ? "none open" : `${liveCount} open in the active turn`;
  const pendingStatus =
    view.lastWardenPendingReviews === undefined
      ? "unavailable"
      : `${Math.max(0, Math.trunc(view.lastWardenPendingReviews))} pending · last reported, not live`;
  const visible = visibleReviewLines(view);
  const visibleStatus =
    visible.length === 0
      ? "no review details visible yet"
      : `${visible.length} review detail${visible.length === 1 ? "" : "s"} visible`;
  return [
    "reviews",
    `  approval prompt: ${liveStatus}`,
    `  warden snapshot: ${pendingStatus}`,
    `  history: ${visibleStatus}`,
    ...(liveCount > 0
      ? ["  decisions: return to the focused approval prompt"]
      : ["  decisions: use the focused approval prompt when Keel pauses"]),
    "  read-only: cannot approve, resolve, or change policy",
    ...(visible.length > 0
      ? ["  details:", ...visible.map((line, index) => `    ${index + 1}. ${line}`)]
      : []),
  ].join("\n");
}

export interface ViewConfig {
  readonly model?: string;
  readonly modelRoute?: UiModelRouteStatus;
  readonly cwd?: string;
  readonly git?: UiGitStatus;
  readonly context?: UiContextStatus;
  readonly cost?: UiCostStatus;
  readonly policy?: UiPolicyStatus;
  readonly startup?: UiStatus["startup"];
  readonly protectionRoute?: UiStatus["protectionRoute"];
  readonly workspaceTrust?: UiStatus["workspaceTrust"];
  readonly recentSessions?: readonly UiRecentSession[];
  readonly usageDigest?: UiUsageDigest;
  /** Last pending-review count returned by the warden status path. Presentation only; not a live
   *  review-queue subscription. */
  readonly lastWardenPendingReviews?: number;
  /** Defaults to neutral all-off facts; an absent route remains `status not reported`. */
  readonly posture?: UiPosture;
  /** Presentation density to seed the view with — the multi-turn driver threads the idle setting here
   *  so `/quiet`·`/verbose`·`/debug` survive into the next turn (Tier-B QC). Absent = the `normal`
   *  default. Presentation only; never a trust/autonomy mode. */
  readonly density?: UiDensity;
  /** Diff disclosure level to seed the view with — threaded the same way so `/diff` persists across a
   *  turn. Absent = automatic presentation: compact in normal/quiet and full in verbose/debug. */
  readonly diffMode?: "compact" | "full";
}

const firstLine = (s: string): string => {
  const nl = s.indexOf("\n");
  return nl === -1 ? s : s.slice(0, nl);
};

/** The last non-blank line of `s` (else its first line). A failed tool's most meaningful output — the
 *  error — is almost always at the END, not the start (a build prints progress, then the error); this
 *  is the §3.9 "retain the last meaningful output line" rule, surfaced in the failed-tool summary (slice 6). */
const lastMeaningfulLine = (s: string): string => {
  const lines = s.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() !== "") return lines[i]!;
  }
  return firstLine(s);
};

interface BashResultEnvelope {
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBashResultEnvelope(output: string): BashResultEnvelope | undefined {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const exitCode = parsed["exitCode"];
  const signal = parsed["signal"];
  const stdout = parsed["stdout"];
  const stderr = parsed["stderr"];
  if (
    typeof exitCode !== "number" &&
    typeof signal !== "string" &&
    typeof stdout !== "string" &&
    typeof stderr !== "string"
  ) {
    return undefined;
  }
  return {
    ...(typeof exitCode === "number" && Number.isFinite(exitCode) ? { exitCode } : {}),
    ...(typeof signal === "string" && signal.length > 0 ? { signal } : {}),
    stdout: typeof stdout === "string" ? stdout : "",
    stderr: typeof stderr === "string" ? stderr : "",
  };
}

function firstMeaningfulLines(s: string, maxLines: number): readonly string[] {
  const out: string[] = [];
  for (const raw of s.split("\n")) {
    const line = stripControlLine(raw).trim().replace(/\s+/g, " ");
    if (line.length === 0) continue;
    out.push(line);
    if (out.length >= maxLines) break;
  }
  return out;
}

function bashEnvelopeSummary(env: BashResultEnvelope, ok: boolean): string {
  const status = [
    ok ? undefined : env.exitCode !== undefined ? `exit ${env.exitCode}` : undefined,
    ok ? undefined : env.signal !== undefined ? `signal ${env.signal}` : undefined,
  ].filter((part): part is string => part !== undefined);

  if (ok) {
    const stdout = firstMeaningfulLines(env.stdout, 6);
    if (stdout.length > 0)
      return truncateLine(`stdout: ${stdout.join(" · ")}`, MAX_LIVE_OUTPUT_LEN);
    const stderr = firstMeaningfulLines(env.stderr, 3);
    if (stderr.length > 0)
      return truncateLine(`stderr: ${stderr.join(" · ")}`, MAX_LIVE_OUTPUT_LEN);
  } else {
    const stderr = stripControlLine(lastMeaningfulLine(env.stderr)).trim().replace(/\s+/g, " ");
    const stdout = stripControlLine(lastMeaningfulLine(env.stdout)).trim().replace(/\s+/g, " ");
    const detail =
      stderr.length > 0 ? `stderr: ${stderr}` : stdout.length > 0 ? `stdout: ${stdout}` : undefined;
    if (detail !== undefined) status.push(detail);
  }

  if (status.length > 0) return truncateLine(status.join(" · "), MAX_LIVE_OUTPUT_LEN);
  if (env.exitCode !== undefined) return `exit ${env.exitCode}`;
  if (env.signal !== undefined) return `signal ${env.signal}`;
  return "";
}

type KernelReviewSettlementOutcome = "partial" | "failed";

/**
 * Rehydrate only the closed, Kernel-authored review-settlement formats. Live presentation also
 * requires the matching private outcome marker. Governed command output is wrapped in its tool
 * envelope, so copied policy language cannot cross this boundary as control-plane truth.
 */
function kernelReviewSettlementOutcome(output: string): KernelReviewSettlementOutcome | undefined {
  if (
    output === KERNEL_STRINGS.reviewDeadlineLateOutcome ||
    output === KERNEL_STRINGS.reviewDeadlineOutcomeUnavailable ||
    (output.startsWith("warden execution failed") &&
      output.endsWith(REVIEW_RESOLUTION_INDETERMINATE_SUFFIX)) ||
    (["allow", "warn", "modify"] as const).some(
      (verdict) => output === unexpectedReviewDenialOutput(verdict),
    )
  ) {
    return "partial";
  }
  if (
    output === KERNEL_STRINGS.reviewResolutionStillPending ||
    output === unexpectedReviewDenialOutput("review") ||
    (output.startsWith("warden execution failed") &&
      (output.endsWith(REVIEW_DENIAL_UNCONFIRMED_SUFFIX) ||
        output.endsWith(REVIEW_DECISION_UNCONFIRMED_SUFFIX)))
  ) {
    return "failed";
  }
  return undefined;
}

function kernelReviewSettlementSummary(outcome: KernelReviewSettlementOutcome): string {
  return outcome === "partial" ? REVIEW_INDETERMINATE_SUMMARY : REVIEW_PENDING_SUMMARY;
}

function toolResultSummary(
  name: string,
  priorSummary: string,
  ok: boolean,
  output: string,
  outcome: ReturnType<typeof toolPresentationOutcome>,
): string {
  const cleanedOutput = ok ? undefined : stripControlLine(output).trim();
  if (cleanedOutput !== undefined) {
    const reviewSettlementOutcome = kernelReviewSettlementOutcome(cleanedOutput);
    if (reviewSettlementOutcome !== undefined && reviewSettlementOutcome === outcome)
      return kernelReviewSettlementSummary(reviewSettlementOutcome);
  }
  if (name === "edit") return priorSummary;
  if (cleanedOutput !== undefined) {
    // Structured warden denials may carry a machine-readable findings body after the human guidance.
    // The findings stay in the transcript/audit; the compact tool card must lead with the actionable
    // first line instead of leaking the final JSON line into the ordinary evidence surface.
    const denialFirstLine = stripControlLine(firstLine(output)).trim();
    if (denialFirstLine.startsWith("blocked by warden (not executed):")) {
      if (denialFirstLine.includes("no review remains pending")) {
        return "blocked by warden (not executed): review closed as denied · no review remains pending";
      }
      return truncateLine(denialFirstLine, MAX_LIVE_OUTPUT_LEN);
    }
    const terminal = outcome === "blocked" && isTerminalReviewWithoutLiveDecision(cleanedOutput);
    const review = reviewDetail(cleanedOutput, terminal);
    if (review !== undefined) {
      const prefix = terminal
        ? `${TUI_TERMINAL_REVIEW_TRUTH.summaryPrefix} `
        : "warden review required (not executed): ";
      const suffix = terminal ? "" : " · no live approval";
      const detailBudget = MAX_LIVE_OUTPUT_LEN - prefix.length - suffix.length;
      return `${prefix}${truncateLine(review, detailBudget)}${suffix}`;
    }
  }
  if (name === "bash") {
    const envelope = parseBashResultEnvelope(output);
    if (envelope !== undefined) return bashEnvelopeSummary(envelope, ok);
  }
  const summary = ok
    ? firstLine(output.slice(0, MAX_LIVE_OUTPUT_LEN))
    : lastMeaningfulLine(output.slice(-MAX_LIVE_OUTPUT_LEN));
  return truncateLine(summary, MAX_LIVE_OUTPUT_LEN);
}

const MAX_TOOL_SUBJECT_LEN = 160;

function toolInvocationSubject(name: string, args: JsonObjectT): string | undefined {
  if (name !== "read" && name !== "write" && name !== "edit") return undefined;
  const path = args["path"];
  if (typeof path !== "string") return undefined;
  const subject = truncateLine(path, MAX_TOOL_SUBJECT_LEN);
  return subject.length > 0 ? subject : undefined;
}

const MAX_RECENT_SESSIONS = 3;
const MAX_WELCOME_RECENT_ROWS = 1;
const MAX_RECENT_SUMMARY = 72;

function truncateLine(s: string, max = MAX_RECENT_SUMMARY): string {
  const one = stripControlLine(s).trim().replace(/\s+/g, " ");
  return truncateDisplayLine(one, max);
}

const MAX_QUEUE_SUMMARY = 240;
const MAX_ATTENTION_MARKS = 12;

function queueSummary(content: string): string {
  const oneLine = stripControlLine(content).trim().replace(/\s+/gu, " ");
  return truncateDisplayLine(oneLine, MAX_QUEUE_SUMMARY);
}

function attentionMark(item: ViewItem): UiAttentionMark {
  if (item.kind === "message") {
    if (item.role === "user") return { glyph: "U", label: "user", tone: "user" };
    if (item.role === "assistant") return { glyph: "A", label: "assistant", tone: "assistant" };
    return { glyph: "S", label: "system", tone: "system" };
  }
  if (item.status === "running") {
    return {
      glyph: "T",
      label:
        item.liveness === undefined
          ? "tool requested"
          : item.liveOutput === undefined
            ? "tool checking"
            : "tool running",
      tone: "tool",
    };
  }
  if (item.status === "error") return { glyph: "!", label: "tool failed", tone: "error" };
  return { glyph: "✓", label: "tool ok", tone: "success" };
}

function queueMark(input: UiQueuedInput): UiAttentionMark {
  return input.class === "urgent"
    ? { glyph: "!", label: "urgent input", tone: "queue" }
    : { glyph: "Q", label: "queued input", tone: "queue" };
}

/** The event mini-map: the last `MAX_ATTENTION_MARKS` marks of `[...items, ...queuedInputs]` (items
 *  first, queued at the tail). Built from the TAIL so it never maps the whole transcript — `withDerived`
 *  runs on every `text-delta`, so an O(n)-per-reduce map here would be O(n²) over a turn (Tier-B QC).
 *  The queued tail is taken first; items fill only the remaining slots — equivalent to mapping
 *  everything and slicing `-12`, but bounded to ≤12 mark allocations regardless of transcript size. */
function buildAttentionRail(view: ViewModel): readonly UiAttentionMark[] {
  const queueMarks = (view.queuedInputs ?? []).slice(-MAX_ATTENTION_MARKS).map(queueMark);
  const need = MAX_ATTENTION_MARKS - queueMarks.length;
  // `need > 0` guard avoids `slice(-0)` — which returns the WHOLE array — when ≥12 inputs are queued.
  const itemMarks = need > 0 ? view.items.slice(-need).map(attentionMark) : [];
  return [...itemMarks, ...queueMarks];
}

function lastRunningTool(view: ViewModel): Extract<ViewItem, { kind: "tool" }> | undefined {
  // Execution liveness is attached only when the executor actually starts. Prefer that occurrence
  // over a later batched call which the provider announced but the serial executor has not reached.
  for (let i = view.items.length - 1; i >= 0; i--) {
    const it = view.items[i]!;
    if (it.kind === "tool" && it.status === "running" && it.liveness !== undefined) return it;
  }
  for (let i = view.items.length - 1; i >= 0; i--) {
    const it = view.items[i]!;
    if (it.kind === "tool" && it.status === "running") return it;
  }
  return undefined;
}

function currentNext(view: ViewModel, fallback: string): string {
  const count = view.queuedInputs?.length ?? 0;
  return count > 0
    ? `apply queued input${count === 1 ? "" : "s"} at the next safe point`
    : fallback;
}

function buildCurrentTurn(view: ViewModel): UiCurrentTurn | undefined {
  if (view.awaitingInput || view.turnSummary !== undefined) return undefined;
  const validation = goalValidationAction(view);
  if (validation !== undefined) {
    return {
      doing: "checking goal",
      why: "governed lifecycle validation is running",
      last: validation,
      next: currentNext(view, "validation result or queued follow-up"),
    };
  }
  const running = lastRunningTool(view);
  if (running !== undefined) {
    const last = running.liveOutput ?? (running.summary.length > 0 ? running.summary : undefined);
    if (running.liveness === undefined) {
      return {
        doing: `checking ${running.name} request`,
        why: "the Warden has not reported execution start",
        ...(last !== undefined ? { last } : {}),
        next: currentNext(view, "waiting for Warden decision or execution"),
      };
    }
    if (running.liveOutput === undefined) {
      return {
        doing: `checking ${running.name} execution`,
        why: "tool output has not confirmed execution",
        ...(last !== undefined ? { last } : {}),
        next: currentNext(view, "waiting for Warden decision or tool result"),
        elapsedMs: running.liveness.elapsedMs,
        quietMs: running.liveness.quietMs,
        ...(running.liveness.timeoutMs === undefined
          ? {}
          : { timeoutMs: running.liveness.timeoutMs }),
      };
    }
    return {
      doing: `running ${running.name}`,
      why: "the controller is waiting on the executing tool",
      ...(last !== undefined ? { last } : {}),
      next: currentNext(view, "waiting for tool result"),
      elapsedMs: running.liveness.elapsedMs,
      quietMs: running.liveness.quietMs,
      ...(running.liveness.timeoutMs === undefined
        ? {}
        : { timeoutMs: running.liveness.timeoutMs }),
    };
  }
  if (view.streaming) {
    const answer = lastAssistantLine(view.items);
    return {
      doing: "assistant drafting",
      why: "provider text stream is active",
      ...(answer !== undefined ? { last: answer } : {}),
      next: currentNext(view, "tool call or final answer"),
    };
  }
  const last = view.items.at(-1);
  // A provider stop turns streaming off one render before `run-finished`. When the final visible
  // event is already assistant prose, the turn is settling rather than waiting for another assistant
  // response. Painting the fallback activity in that frame is not merely a transient lie: native
  // Static promotion can push it into terminal history, where the next render cannot erase it.
  if (last?.kind === "message" && last.role === "assistant") return undefined;
  // Terminal notices are outcomes, not a request for another provider response. They can arrive in
  // the same render that promotes the held assistant tail, so deriving fallback activity here would
  // strand a false "waiting" row above the next mutable frame (provider failure and interrupt paths).
  if (
    last?.kind === "message" &&
    last.role === "system" &&
    (last.content.startsWith("⚠ run ended —") || last.content.startsWith("⏸ interrupted —"))
  ) {
    return undefined;
  }
  if (last?.kind === "message" && last.role === "user") {
    return {
      doing: "waiting for assistant",
      why: "latest visible event is a user prompt",
      last: truncateLine(last.content, 96),
      next: currentNext(view, "provider stream or tool call"),
    };
  }
  if ((view.queuedInputs?.length ?? 0) > 0) {
    return {
      doing: "queued follow-up waiting",
      why: "user typed during an active turn",
      last: view.queuedInputs!.at(-1)!.content,
      next: currentNext(view, "waiting for safe point"),
    };
  }
  const activeUser = [...view.items]
    .reverse()
    .find((item) => item.kind === "message" && item.role === "user");
  if (activeUser?.kind === "message") {
    return {
      doing: "waiting for assistant",
      why: "the active turn has not reached an input boundary",
      last: truncateLine(activeUser.content, 96),
      next: "provider stream or tool call",
    };
  }
  return undefined;
}

function withDerived(view: ViewModel): ViewModel {
  const { attentionRail, currentTurn: _currentTurn, ...base } = view;
  void attentionRail;
  void _currentTurn;
  const rail = buildAttentionRail(base);
  const currentTurn = buildCurrentTurn(base);
  return {
    ...base,
    ...(rail.length > 0 ? { attentionRail: rail } : {}),
    ...(currentTurn !== undefined ? { currentTurn } : {}),
  };
}

/** Settle exactly one resolver-bearing activity by object identity; stale occurrences are ignored. */
export function applyMutationPresentationResolution(
  view: ViewModel,
  target: UiToolActivity,
  resolution: MutationPresentationResolutionV1,
): ViewModel {
  let changed = false;
  const items = view.items.map((item) => {
    if (item !== target || item.kind !== "tool") return item;
    changed = true;
    return resolveMutationPresentationActivity(item, resolution);
  });
  return changed ? withDerived({ ...view, items }) : view;
}

export function activeReviewIsActionable(view: ViewModel): boolean {
  return view.activeApproval?.state === "pending";
}

function settledApprovalReceipt(approval: NonNullable<ViewModel["activeApproval"]>): string {
  const detail = boundedApprovalLine(approval.detail, 2_048, 512);
  const history = "history · earlier approval-required block is historical/resolved";
  switch (approval.state) {
    case "confirmed": {
      const scope =
        approval.selectedChoice === "once"
          ? "approved once"
          : approval.selectedChoice === "session"
            ? "approved exact session scope"
            : "approval confirmed";
      const authority =
        approval.selectedChoice === "once"
          ? "authority · limited to that governed attempt; no reusable authority remains; repeating it requires a fresh review"
          : approval.selectedChoice === "session"
            ? "authority · only the exact approved scope remains active until this Keel session exits"
            : "authority · only the Warden-confirmed review scope applies";
      return [
        `approval settled · ${scope}`,
        history,
        authority,
        `detail · confirmed by warden · ${detail}`,
      ].join("\n");
    }
    case "governed-deny":
      return [
        `approval settled · human approved${approval.selectedChoice === "once" ? " once" : ""}; Warden returned deny`,
        history,
        "authority · the decision was consumed by that governed attempt; no reusable authority remains",
        "effects · inspect the governed tool result and audit; this receipt does not claim non-execution",
        `detail · governed result deny · ${detail}`,
      ].join("\n");
    case "denied":
      return [
        "approval settled · denied",
        history,
        "authority · none granted; action not executed",
        `detail · ${detail}`,
      ].join("\n");
    case "failed":
      return [
        "approval settled · decision not confirmed",
        history,
        "authority · none assumed; restart the governed session before deciding again",
        `detail · ${detail}`,
      ].join("\n");
    case "indeterminate":
      return [
        "approval settled · outcome unknown",
        history,
        "authority · do not retry automatically; restart and inspect audit",
        `detail · ${detail}`,
      ].join("\n");
    case "pending":
    case "submitted":
      return [
        "approval settled · no approval assumed",
        history,
        "authority · none granted",
        `detail · ${detail}`,
      ].join("\n");
  }
}

function formatAge(createdAt: string, now: Date): string {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return "unknown age";
  const deltaMs = Math.max(0, now.getTime() - t);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return createdAt.slice(0, 10);
}

/** Build first-run recent-session rows for THIS workspace only (ADR-0054). The stored `cwd` is
 *  redacted/lossy, so it is never used as identity; legacy rows without `cwdHash` are not shown in
 *  the automatic recent list. Summaries are ledger data and are single-line control-stripped here
 *  before either renderer sees them (ER-020). */
export function buildRecentSessionRows(
  sessions: readonly SessionSummary[],
  cwd: string,
  now: Date = new Date(),
  limit = MAX_RECENT_SESSIONS,
): readonly UiRecentSession[] {
  const key = workspaceKey(cwd);
  return (
    sessions
      .filter((s) => s.cwdHash === key)
      .map((s) => {
        const summary = s.summary !== undefined ? truncateLine(s.summary) : "";
        return { session: s, summary };
      })
      // The automatic hero list is an affordance, not the durable session ledger. Suppress abandoned
      // prompt-less rows so first-run UX teaches useful resume paths instead of a wall of "(no prompt
      // recorded)" entries; `keel sessions` remains the complete list.
      .filter((row) => row.summary.trim().length > 0)
      .slice()
      .sort((a, b) => b.session.createdAt.localeCompare(a.session.createdAt))
      .slice(0, Math.max(0, limit))
      .map(({ session, summary }) => {
        const safeId = stripControlLine(session.id);
        return {
          id: safeId,
          age: formatAge(session.createdAt, now),
          summary,
          resumeCommand: `keel --resume ${safeId}`,
          ...(session.usageTokens !== undefined && session.usageTokens > 0
            ? { tokens: session.usageTokens }
            : {}),
          ...(session.lastGoalFailure !== undefined
            ? { outcome: "needs attention" as const }
            : session.lastStop !== undefined
              ? { outcome: outcomeLabel(session.lastStop, session.lastStopCode) }
              : {}),
        };
      })
  );
}

function outcomeLabel(
  reason: SessionSummary["lastStop"],
  code: SessionSummary["lastStopCode"],
): NonNullable<UiRecentSession["outcome"]> {
  if (reason === "model-stop") return stopCodeNeedsAttention(code) ? "needs attention" : "done";
  if (reason === "aborted") return "stopped";
  return "needs attention";
}

const USAGE_WINDOWS: readonly { label: string; ms: number }[] = [
  { label: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
];

export function buildUsageDigest(
  sessions: readonly SessionSummary[],
  cwd: string,
  now: Date = new Date(),
): UiUsageDigest {
  const key = workspaceKey(cwd);
  const nowMs = now.getTime();
  const runs = sessions
    .filter((s) => s.cwdHash === key)
    .flatMap((s) => s.usageRuns ?? [])
    .flatMap((run) => {
      const ts = Date.parse(run.ts);
      return Number.isFinite(ts) && ts <= nowMs ? [{ ts, tokens: run.tokens }] : [];
    });
  return {
    scope: "workspace",
    windows: USAGE_WINDOWS.map((w) => {
      const since = nowMs - w.ms;
      const inside = runs.filter((r) => r.ts >= since);
      return {
        label: w.label,
        tokens: inside.reduce((sum, r) => sum + r.tokens, 0),
        runs: inside.length,
      };
    }),
  };
}

export function usageDigestLine(digest: UiUsageDigest): string {
  const windows = digest.windows
    .map((w) => `${stripControlLine(w.label)} ${formatTokens(w.tokens)} tok`)
    .join(" · ");
  return `workspace usage · ${windows}`;
}

function compactSessionId(id: string): string | undefined {
  const clean = stripControlLine(id).trim().replace(/\s+/g, " ");
  if (clean.length === 0) return undefined;
  if (clean.length <= 18) return clean;
  return `${clean.slice(0, 7)}…${clean.slice(-4)}`;
}

export function recentSessionLine(session: UiRecentSession): string {
  const outcome = session.outcome === "needs attention" ? "incomplete" : session.outcome;
  return [
    compactSessionId(session.id),
    session.age,
    session.summary,
    outcome,
    session.tokens !== undefined ? `${formatTokens(session.tokens)} tok` : undefined,
  ]
    .filter((x): x is string => x !== undefined && x.length > 0)
    .join(" · ");
}

function lastAssistantLine(items: readonly ViewItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "message" && it.role === "assistant") {
      const line = truncateLine(firstLine(it.content), 96);
      if (line.length > 0) return line;
    }
  }
  return undefined;
}

function latestTurnItems(items: readonly ViewItem[]): readonly ViewItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "message" && it.role === "user") return items.slice(i);
  }
  return items;
}

function toolReceipt(it: Extract<ViewItem, { kind: "tool" }>): string {
  const name = truncateLine(it.name, 32);
  const summary = truncateReceiptLine(it.summary, 96);
  return summary.length > 0 ? `${name}: ${summary}` : `${name}: completed`;
}

function failedToolReceipt(it: Extract<ViewItem, { kind: "tool" }>): string {
  const name = stripControlLine(it.name).trim().replace(/\s+/g, " ");
  const summary = stripControlLine(it.summary).trim().replace(/\s+/g, " ");
  return summary.length > 0 ? `${name}: ${summary}` : `${name}: completed`;
}

function mutationObservedLabel(
  presentation: Extract<UiMutationPresentation, { readonly status: "available" }>,
): string {
  switch (presentation.observedBefore.status) {
    case "file-observed":
      return "observed file before";
    case "absent-observed":
      return "observed absent before";
    case "not-inspected":
      return "before not inspected";
  }
}

function mutationCoverageSummary(
  presentation: Extract<UiMutationPresentation, { readonly status: "available" }>,
): string {
  switch (presentation.coverage) {
    case "complete":
      return "comparison complete";
    case "truncated":
      return `comparison truncated · ${String(presentation.shownLines)} shown · ${String(presentation.hiddenLines)} hidden`;
    case "summary-only":
      return "comparison summary only";
    case "unknown":
      return "comparison unknown";
  }
}

export function mutationReceiptEvidence(
  it: Extract<ViewItem, { kind: "tool" }>,
): UiTurnFileEvidence | undefined {
  if (it.name !== "edit" && it.name !== "write") return undefined;
  const presentation = it.mutationPresentation;
  if (presentation?.status === "available") {
    const displayPath = truncateReceiptLine(presentation.displayPath, 56);
    return {
      status: "available",
      text: `${displayPath} · ${mutationObservedLabel(presentation)} → verified installed after · ${mutationCoverageSummary(presentation)} · transition not atomic · concurrent mutation not excluded`,
    };
  }
  const unavailable =
    presentation?.status === "unavailable"
      ? mutationReviewUnavailableCopy(presentation.reason)
      : presentation?.status === "pending"
        ? "presentation did not settle"
        : "governed observation capture was unavailable";
  return {
    status: "unavailable",
    text: `${truncateLine(it.name, 32)} observation unavailable · ${unavailable}`,
  };
}

function truncateReceiptLine(value: string, max: number): string {
  const one = stripControlLine(value).trim().replace(/\s+/g, " ");
  const tailWidth = Math.min(32, Math.floor(max / 3));
  return truncateDisplayCells(one, max, { tailCells: tailWidth });
}

function receiptSummaryLines(lines: readonly string[]): readonly string[] {
  return lines
    .map((line) => stripControlLine(line).trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0);
}

function mergeAutoResolutionReceipt(
  summary: UiTurnSummary | undefined,
  automatic: readonly string[],
  attention: readonly string[],
): UiTurnSummary | undefined {
  const cleanAutomatic = receiptSummaryLines(automatic);
  const cleanAttention = receiptSummaryLines(attention);
  if (cleanAutomatic.length === 0 && cleanAttention.length === 0) return summary;
  const current: UiTurnSummary = summary ?? {
    title: cleanAttention.length > 0 ? "needs attention" : "done",
    changed: [],
    checked: [],
    attention: [],
  };
  const nextAutomatic = [...(current.automatic ?? []), ...cleanAutomatic];
  const nextAttention = [...current.attention, ...cleanAttention];
  return {
    ...current,
    title: nextAttention.length > 0 ? "needs attention" : current.title,
    ...(nextAutomatic.length > 0 ? { automatic: nextAutomatic } : {}),
    attention: nextAttention,
  };
}

/** Factual turn receipt for the Done card. It summarizes only observed artifacts from the view model:
 *  assistant answer text, ADR-0078 file observations, successful bash runs, and failed tools/notices.
 *  It never infers operation effects, verification, security, policy, or enforcement posture. */
export function buildTurnSummary(view: ViewModel): UiTurnSummary | undefined {
  const items = latestTurnItems(view.items);
  const recoveredFailures = recoveredExploratoryFailureIndexes(items);
  const answer = lastAssistantLine(items);
  const fileEvidence = items
    .filter(
      (it): it is Extract<ViewItem, { kind: "tool" }> =>
        it.kind === "tool" && it.status === "ok" && (it.name === "edit" || it.name === "write"),
    )
    .flatMap((it) => {
      const evidence = mutationReceiptEvidence(it);
      return evidence === undefined ? [] : [evidence];
    });
  const ran = items
    .filter(
      (it): it is Extract<ViewItem, { kind: "tool" }> =>
        it.kind === "tool" &&
        it.status === "ok" &&
        it.name === "bash" &&
        toolOutcome(it) === "done",
    )
    .map(toolReceipt);
  const failedTools = items
    .flatMap((it, index): Extract<ViewItem, { kind: "tool" }>[] =>
      it.kind === "tool" && it.status === "error" && !recoveredFailures.has(index) ? [it] : [],
    )
    .map(failedToolReceipt);
  const terminalNotices = items
    .filter(
      (it): it is Extract<ViewItem, { kind: "message" }> =>
        it.kind === "message" && it.role === "system" && it.content.startsWith("⚠ run ended"),
    )
    .map((it) => truncateLine(it.content, 96))
    .slice(0, 1);
  const attention = [...failedTools, ...terminalNotices];
  if (
    answer === undefined &&
    fileEvidence.length === 0 &&
    ran.length === 0 &&
    attention.length === 0
  ) {
    return undefined;
  }
  return {
    title: attention.length > 0 ? "needs attention" : "done",
    ...(answer !== undefined ? { answer } : {}),
    changed: [],
    checked: [],
    ...(fileEvidence.length > 0 ? { fileEvidence } : {}),
    ...(ran.length > 0 ? { ran } : {}),
    attention,
  };
}

/** Hard cap on a streamed live-output line (Epic 1.5c). A live line is one terminal row glance, not
 *  the artifact (the full output is the durable `tool-result`); bounding it here keeps a pathological
 *  mega-line from being control-stripped, stored, and re-rendered whole. The slice happens BEFORE the
 *  regex so the work is bounded even on a multi-megabyte chunk. */
const MAX_LIVE_OUTPUT_LEN = 512;

function cleanGitStatus(git: UiGitStatus): UiGitStatus {
  const cleaned: {
    branch?: string;
    added?: number;
    modified?: number;
    deleted?: number;
  } = {};
  if (git.branch !== undefined) cleaned.branch = stripControlLine(git.branch);
  if (git.added !== undefined) cleaned.added = git.added;
  if (git.modified !== undefined) cleaned.modified = git.modified;
  if (git.deleted !== undefined) cleaned.deleted = git.deleted;
  return cleaned;
}

function cleanPolicyStatus(policy: UiPolicyStatus): UiPolicyStatus {
  return {
    active: policy.active,
    ...(policy.label !== undefined ? { label: stripControlLine(policy.label) } : {}),
  };
}

export interface SeedPresentation {
  /** Internal session-ledger outcome metadata. Kept outside `ModelMessage` so the frozen provider
   *  contract is unchanged while resumed denials/failures retain their visible meaning. */
  readonly failedToolCallIds?: ReadonlySet<string>;
  /** Preferred occurrence-precise metadata. Provider call ids are not guaranteed unique across turns. */
  readonly failedToolMessageIndexes?: ReadonlySet<number>;
}

function resumedBashWasLimited(content: string): boolean {
  const json = content.startsWith("{")
    ? content
    : content.startsWith("warden warning:") || content.startsWith("warden modified tool args:")
      ? (content.split("\n\n", 2)[1] ?? "")
      : "";
  if (json === "") return false;
  try {
    const parsed: unknown = JSON.parse(json);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>)["limited"] === true
    );
  } catch {
    return false;
  }
}

/** Rehydrates only formats emitted by keel's executor. Arbitrary command stderr is inside a JSON
 * bash envelope, so policy-like text cannot cross this boundary as an authoritative outcome. */
function resumedToolOutcome(
  name: string,
  content: string,
  failed: boolean,
): ReturnType<typeof toolPresentationOutcome> {
  if (!failed) {
    if (name === "bash" && resumedBashWasLimited(content)) return "limited";
    return undefined;
  }
  if (content === INTERRUPTED_TOOL_RESULT || content === KERNEL_STRINGS.toolAborted)
    return "stopped";
  if (
    content === KERNEL_STRINGS.loopSkipped ||
    content.startsWith("not executed: an earlier tool in this turn requires review;") ||
    content.startsWith("keel's warden (enforcement) stopped;")
  ) {
    return "skipped";
  }
  if (isTerminalReviewWithoutLiveDecision(content)) return "blocked";
  if (content.startsWith("warden review required (not executed):")) return "review";
  if (content.startsWith("blocked by warden (not executed):")) return "blocked";
  const reviewSettlementOutcome = kernelReviewSettlementOutcome(content);
  if (reviewSettlementOutcome !== undefined) return reviewSettlementOutcome;
  if (
    (name === "write" || name === "edit") &&
    content.endsWith("; target may have changed — inspect it before retrying")
  ) {
    return "partial";
  }
  return "failed";
}

function workspaceEffectsUncaptured(
  name: string,
  outcome: ReturnType<typeof toolPresentationOutcome>,
): UiMutationPresentation | undefined {
  if (outcome === "review" || outcome === "blocked" || outcome === "skipped") return undefined;
  return name === "bash" || name.startsWith("mcp__") || name.startsWith("interactive_console.")
    ? { status: "unavailable", reason: "workspace-effects-not-captured" }
    : undefined;
}

function resumedMutationPresentation(
  name: string,
  outcome: ReturnType<typeof resumedToolOutcome>,
): UiMutationPresentation | undefined {
  if (
    (name === "write" || name === "edit") &&
    (outcome === undefined || outcome === "partial" || outcome === "failed")
  ) {
    return { status: "unavailable", reason: "live-observations-not-persisted" };
  }
  return workspaceEffectsUncaptured(name, outcome);
}

/** Map a seed conversation message to its view item (resumed tool history renders too). */
function seedItem(
  m: ModelMessageT,
  presentation: SeedPresentation,
  messageIndex: number,
  subject?: string,
): ViewItem | undefined {
  if (m.role === "tool") {
    const id = m.toolCallId ?? "";
    const name = stripControl(m.name ?? "");
    const failed =
      presentation.failedToolMessageIndexes !== undefined
        ? presentation.failedToolMessageIndexes.has(messageIndex)
        : presentation.failedToolCallIds?.has(id) === true;
    const outcome = resumedToolOutcome(name, m.content, failed);
    const reviewSettlementOutcome = failed ? kernelReviewSettlementOutcome(m.content) : undefined;
    const mutationPresentation = resumedMutationPresentation(name, outcome);
    const item: Extract<ViewItem, { kind: "tool" }> = {
      kind: "tool",
      id,
      name, // the model picks the tool name — data, never a format string
      status: failed ? "error" : "ok",
      summary: toolResultSummary(
        name,
        name === "edit" ? stripControl(firstLine(m.content)) : "",
        !failed,
        m.content,
        outcome,
      ),
      ...(subject !== undefined ? { subject } : {}),
      ...(mutationPresentation === undefined ? {} : { mutationPresentation }),
    };
    const withOutcome = outcome === undefined ? item : markToolPresentationOutcome(item, outcome);
    return reviewSettlementOutcome !== undefined && reviewSettlementOutcome === outcome
      ? markReviewSettlementPresentation(withOutcome, reviewSettlementOutcome)
      : withOutcome;
  }
  const content = stripControl(m.content);
  // Provider history keeps an assistant message for tool-call linkage even when it contains no prose.
  // The following tool result is the visible activity; rendering an empty assistant creates a stray
  // `keel` heading on resume and implies a response body that never existed.
  if (m.role === "assistant" && content.trim() === "") return undefined;
  if (m.role === "user" && isLoopContinuationMessage(m)) {
    return { kind: "message", role: "system", content, presentation: "notice" };
  }
  return { kind: "message", role: m.role, content };
}

/** The starting view: the seed conversation + ambient status + the honest posture. */
export function initialView(
  seed: readonly ModelMessageT[],
  config: ViewConfig = {},
  presentation: SeedPresentation = {},
): ViewModel {
  const pendingSubjects = new Map<string, (string | undefined)[]>();
  const items = seed.flatMap((message, messageIndex) => {
    for (const call of message.role === "assistant" ? (message.toolCalls ?? []) : []) {
      const key = `${call.id}\u0000${call.name}`;
      pendingSubjects.set(key, [
        ...(pendingSubjects.get(key) ?? []),
        toolInvocationSubject(call.name, call.args),
      ]);
    }
    const key =
      message.role === "tool"
        ? `${message.toolCallId ?? ""}\u0000${message.name ?? ""}`
        : undefined;
    const subjects = key === undefined ? undefined : pendingSubjects.get(key);
    const subject = subjects?.shift();
    if (key !== undefined && subjects !== undefined && subjects.length === 0)
      pendingSubjects.delete(key);
    const item = seedItem(message, presentation, messageIndex, subject);
    return item === undefined ? [] : [item];
  });
  return withDerived({
    items,
    status: {
      // model/cwd are data too (often from env) — strip control bytes here, the same single source
      // of "what to show" the reducer uses, so a crafted id can't smuggle an escape into the HUD
      // (ER-020 / §4.9.1 posture-spoof defense).
      ...(config.model !== undefined ? { model: stripControl(config.model) } : {}),
      ...(config.modelRoute !== undefined
        ? {
            modelRoute: {
              mode: config.modelRoute.mode,
              status: config.modelRoute.status,
              ...(config.modelRoute.selected !== undefined
                ? { selected: stripControlLine(config.modelRoute.selected) }
                : {}),
              ...(config.modelRoute.reason !== undefined
                ? { reason: stripControlLine(config.modelRoute.reason) }
                : {}),
              ...(config.modelRoute.lastDecisionId !== undefined
                ? { lastDecisionId: stripControlLine(config.modelRoute.lastDecisionId) }
                : {}),
            },
          }
        : {}),
      ...(config.cwd !== undefined ? { cwd: stripControl(config.cwd) } : {}),
      ...(config.git !== undefined ? { git: cleanGitStatus(config.git) } : {}),
      ...(config.context !== undefined ? { context: config.context } : {}),
      ...(config.cost !== undefined ? { cost: config.cost } : {}),
      ...(config.policy !== undefined ? { policy: cleanPolicyStatus(config.policy) } : {}),
      ...(config.startup !== undefined ? { startup: config.startup } : {}),
      ...(config.protectionRoute !== undefined ? { protectionRoute: config.protectionRoute } : {}),
      ...(config.workspaceTrust !== undefined ? { workspaceTrust: config.workspaceTrust } : {}),
      tokens: 0,
      posture: config.posture ?? ALL_OFF_POSTURE,
    },
    streaming: false,
    ...(config.recentSessions !== undefined ? { recentSessions: config.recentSessions } : {}),
    ...(config.usageDigest !== undefined ? { usageDigest: config.usageDigest } : {}),
    ...(config.lastWardenPendingReviews !== undefined
      ? { lastWardenPendingReviews: config.lastWardenPendingReviews }
      : {}),
    // Seed any carried presentation state (Tier-B QC) so a per-turn `/quiet`·`/diff` does not reset to
    // the default each turn. Only set when present — absent stays the honest automatic diff default.
    ...(config.density !== undefined ? { density: config.density } : {}),
    ...(config.diffMode !== undefined ? { diffMode: config.diffMode } : {}),
  });
}

/**
 * First-run brand banner content (§8.6 — the empty state teaches; tui-principles "fast and beautiful").
 * Structured into parts so the interactive renderer can give the wordmark + tagline real visual
 * hierarchy (bold accent · bright · dim) while the headless/mono surface renders the SAME words plainly
 * — one source, so the two can never drift.
 *
 * Honest by construction (§4.9.1): the banner deliberately carries NO posture/enforcement words. The
 * controller-bound protection truth lives in the status line, which BOTH renderers always draw — so
 * the screen is branded and honest at once, and the banner can never imply a guarantee that isn't
 * enforced. The ethos line states only what IS true today (local-first, zero telemetry, Apache-2.0).
 */
export const WELCOME = {
  wordmark: "keel",
  tagline: "coding agent for governed work",
  interactiveHeadline: "Type what you want changed.",
  headline: "Start: ask for a change, review, or explanation.",
  ethos: "local-first · zero telemetry · Apache-2.0",
  mark: ["   ▄▄▄", "▄█████▄", "   █", "   ▀"] as readonly string[],
  newTaskTitle: "Start",
  newTaskHint: "Ask for a change, review, or explanation.",
  examples: "fix a failing test · explain @src/loop.ts · add a --json flag",
  starts: ["fix a failing test", "explain @src/loop.ts", "add a --json flag"],
  examplesLabel: "Try",
  resumeTitle: "Resume latest",
  resumeContinue: "keel --continue",
  resumeSpecific: "keel --resume <id>",
  recentTitle: "Recent",
  recentEmpty: "No prior sessions in this workspace yet.",
  keyLines: [
    "/help shows commands. Tab completes slash commands and @files.",
    "Finished turns stay in terminal history.",
    "Protection: see the footer below for sandbox · egress guard · policy · audit.",
  ],
} as const;

export function welcomeResumeLine(recentSessions: readonly UiRecentSession[]): string | undefined {
  return recentSessions.length > 0
    ? `${WELCOME.resumeTitle}: ${WELCOME.resumeContinue}`
    : undefined;
}

function olderSessionsLine(count: number): string | undefined {
  if (count <= 0) return undefined;
  return `  More: ${count} older session${count === 1 ? "" : "s"} · keel sessions list`;
}

export function welcomeRecentLines(
  recentSessions: readonly UiRecentSession[] = [],
  maxWidth?: number,
): readonly string[] {
  if (recentSessions.length === 0) return [`  ${WELCOME.recentEmpty}`];
  const visible = recentSessions.slice(0, MAX_WELCOME_RECENT_ROWS);
  const bounded = (line: string): string =>
    maxWidth === undefined ? line : truncateDisplayLine(line, Math.max(1, Math.floor(maxWidth)));
  const older = olderSessionsLine(recentSessions.length - visible.length);
  return [
    ...visible.flatMap((s) => [
      bounded(`  ${recentSessionLine(s)}`),
      `    resume: ${s.resumeCommand}`,
    ]),
    ...(older === undefined ? [] : [bounded(older)]),
  ].filter((line): line is string => line !== undefined);
}

/** The first-run banner as plain mono text — the headless surface, and the word-source the Ink banner
 *  styles. The honest posture is appended by the renderers' always-present posture line, not here. */
export function welcomeText(
  recentSessions: readonly UiRecentSession[] = [],
  usageDigest?: UiUsageDigest,
): string {
  const resumeLine = welcomeResumeLine(recentSessions);
  const lines = [
    WELCOME.wordmark,
    WELCOME.headline,
    WELCOME.ethos,
    ...(usageDigest !== undefined ? [usageDigestLine(usageDigest)] : []),
    `${WELCOME.examplesLabel}: ${WELCOME.starts.join(" · ")}`,
    ...(resumeLine !== undefined ? [resumeLine] : []),
    ...WELCOME.keyLines,
    WELCOME.recentTitle,
  ];
  lines.push(...welcomeRecentLines(recentSessions));
  return lines.join("\n");
}

/** The opening empty state shown before the first prompt: honest posture + the brand banner. The banner
 *  is rendered FROM the `firstRun` flag (not seeded as a transcript item), so it never lingers in the
 *  conversation after the first turn — every renderer draws it itself and the words live in one place. */
export function firstRunView(config: ViewConfig = {}): ViewModel {
  return withDerived({ ...initialView([], config), firstRun: true });
}

function isUiSystemNotice(content: string): boolean {
  return (
    content.startsWith("about\n") ||
    content.startsWith("capabilities\n") ||
    content.startsWith("context\n") ||
    content.startsWith("model\n") ||
    content.startsWith("compact proposal\n") ||
    content.startsWith("reviews\n") ||
    content.startsWith("protections\n") ||
    content.startsWith("density: ") ||
    content.startsWith("diffs: ") ||
    content.startsWith("⏳ ") ||
    content.startsWith("⚡ ") ||
    content.startsWith("⏸ ") ||
    content.startsWith("⚠ ") ||
    content.startsWith("↩ ") ||
    content.startsWith("↻ ")
  );
}

function withoutStreamDeltas(items: readonly ViewItem[]): readonly ViewItem[] {
  return items.map((item) => {
    if (item.kind !== "message" || item.streamDeltas === undefined) return item;
    const { streamDeltas: _streamDeltas, ...settled } = item;
    void _streamDeltas;
    return settled;
  });
}

/**
 * A canonical run boundary proves that process-local tool liveness ended, but an absent tool result
 * proves neither execution nor host effects. Settle only still-running occurrences, preserving
 * truthful occurrence metadata while removing live-only fields. This remains UI-local: it emits no
 * provider message, session event, audit record, or synthetic tool result.
 */
function settleRunningToolsAtRunEnd(items: readonly ViewItem[]): readonly ViewItem[] {
  let changed = false;
  const settled = items.map((item): ViewItem => {
    if (item.kind !== "tool" || item.status !== "running") return item;
    changed = true;
    const mutationPresentation =
      item.mutationPresentation?.status === "pending"
        ? ({ status: "unavailable", reason: "occurrence-ended" } as const)
        : item.mutationPresentation;
    const activity: UiToolActivity = {
      kind: "tool",
      id: item.id,
      name: item.name,
      status: "error",
      summary: KERNEL_STRINGS.toolResultMissingAtRunEnd,
      ...(item.subject !== undefined ? { subject: item.subject } : {}),
      ...(item.diff !== undefined ? { diff: item.diff } : {}),
      ...(mutationPresentation !== undefined ? { mutationPresentation } : {}),
    };
    return markToolPresentationOutcome(activity, "stopped");
  });
  return changed ? settled : items;
}

/** Index of the first item that is NOT part of the leading SYSTEM preamble — the run's seeded
 *  scaffolding (system prompt · env snapshot · skills · AGENTS.md · backup note). BOTH renderers hide
 *  this unless verbose (it is context, not transcript). Only the LEADING run of system messages counts:
 *  a system NOTICE/panel (`⏸ interrupted`, `⚠ run ended`, `/context`, `/compact`) is not preamble and is
 *  always shown — so a failure, interrupt, or read-only panel is never hidden. One copy, both renderers. */
export function leadingSystemEnd(items: readonly ViewItem[]): number {
  let i = 0;
  for (; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind !== "message" || it.role !== "system") break;
    if (it.presentation === "notice") break;
    if (isUiSystemNotice(it.content)) break;
  }
  return i;
}

/**
 * Pure reducer: fold one loop `KernelEvent` or UI-input event into the view (the single source of
 * "what to show"). Streaming assistant text, interleaved tool activity, token/status updates, and
 * the §4.10 mid-run input indicator + injected-steering / interrupt notes.
 */
export function reduce(view: ViewModel, ev: KernelEventT | UiInputEventT): ViewModel {
  if (
    (view.activeApproval?.state === "confirmed" ||
      view.activeApproval?.state === "governed-deny" ||
      view.activeApproval?.state === "denied" ||
      view.activeApproval?.state === "indeterminate" ||
      view.activeApproval?.state === "failed") &&
    !ev.type.startsWith("approval-") &&
    ev.type !== "tool-result"
  ) {
    const settlementReceipt = settledApprovalReceipt(view.activeApproval);
    const {
      activeApproval: _activeApproval,
      pendingReviews: _pendingReviews,
      ...resumedView
    } = view;
    void _activeApproval;
    void _pendingReviews;
    return reduce(
      withDerived({
        ...resumedView,
        items: [
          ...resumedView.items,
          { kind: "message", role: "system", content: settlementReceipt },
        ],
      }),
      ev,
    );
  }
  switch (ev.type) {
    case "input-queued":
      // §4.10: pendingInputs + queuedInputs drive the live one-line acknowledgement. Keep it out
      // of transcript items: a token arriving after the queue event must extend the same assistant
      // message instead of starting a second response after an injected system notice.
      return withDerived({
        ...view,
        pendingInputs: (view.pendingInputs ?? 0) + 1,
        queuedInputs: [
          ...(view.queuedInputs ?? []),
          { class: ev.class, content: queueSummary(ev.content) },
        ],
      });
    case "input-applied": {
      // the queued steering is now part of the conversation — drop one from the indicator and
      // show it as a user message in the transcript. The prior turn's summary and idle boundary
      // cannot cross into this new turn: Static history is immutable and only the new turn may
      // derive its eventual receipt.
      const { turnSummary: _turnSummary, ...withoutPriorSummary } = view;
      void _turnSummary;
      return withDerived({
        ...withoutPriorSummary,
        awaitingInput: false,
        pendingInputs: Math.max(0, (view.pendingInputs ?? 0) - 1),
        queuedInputs: (view.queuedInputs ?? []).slice(1),
        items: [
          ...view.items,
          { kind: "message", role: "user", content: stripControl(ev.content) },
        ],
      });
    }
    case "turn-not-final": {
      // A loop pass ended only because queued steering or an interrupt reached its safe boundary.
      // Keep the settled content and usage, but never expose a final receipt that Ink could commit
      // to native scrollback before the logical user turn has actually finished.
      const { turnSummary: _turnSummary, ...continuing } = view;
      void _turnSummary;
      return withDerived(continuing);
    }
    case "turn-finalized":
      return withDerived({
        ...view,
        items: withoutStreamDeltas(view.items),
        turnSummary: ev.summary,
        streaming: false,
      });
    case "goal-validation-started":
      return withDerived(withGoalValidationAction(view, stripControlLine(ev.action)));
    case "goal-validation-finished":
      return withDerived(withGoalValidationAction(view, undefined));
    case "interrupted": {
      const { turnSummary: _turnSummary, ...continuing } = view;
      void _turnSummary;
      return withDerived({
        ...continuing,
        streaming: false,
        items: [...view.items, { kind: "message", role: "system", content: INTERRUPTED_NOTE }],
      });
    }
    case "awaiting-input":
      // Epic 1.23: the REPL turn finished and the session is idle, awaiting the next prompt. A pure
      // view-state flag (never narrated as a message) that the hint footer turns into the idle
      // "type to continue · /exit" affordance. Set true here; it is reset to false IMPLICITLY when the
      // next turn rebuilds a fresh view via `initialView()` — the flag is never carried across a turn,
      // so there is no explicit "false" event to emit.
      return withDerived({ ...view, awaitingInput: true });
    case "diff-mode-toggle": {
      // §8: flip the diff disclosure level (auto compact default ↔ full). The diff data stays on each
      // item — only the rendering changes. Callers pair this with a `system-notice` (`diffNotice`) so
      // the toggle is acknowledged in the transcript like the density commands; the footer alone only
      // labels `full`, leaving a toggle back to the `compact` default otherwise silent.
      const next = view.diffMode === "full" ? "compact" : "full";
      const { overlay: _overlay, ...base } = view;
      void _overlay;
      return withDerived({
        ...base,
        diffMode: next,
      });
    }
    case "density-set": {
      const { overlay: _densityOverlay, ...densityBase } = view;
      void _densityOverlay;
      return withDerived({
        ...densityBase,
        density: ev.density,
      });
    }
    case "capabilities-panel": {
      if (ev.prompt === undefined)
        return withDerived({ ...view, overlay: panelOverlay(capabilitiesPanel(view)) });
      const { overlay: _capabilitiesOverlay, ...capabilitiesBase } = view;
      void _capabilitiesOverlay;
      return withDerived({
        ...capabilitiesBase,
        items: [
          ...view.items,
          {
            kind: "message" as const,
            role: "user" as const,
            content: stripControl(ev.prompt),
          },
          { kind: "message", role: "system", content: capabilitiesPanel(view) },
        ],
      });
    }
    case "about-panel":
      return withDerived({ ...view, overlay: panelOverlay(aboutPanel(view)) });
    case "policies-panel":
      return withDerived({ ...view, overlay: panelOverlay(protectionsPanel(view)) });
    case "context-panel":
      return withDerived({ ...view, overlay: panelOverlay(contextPanel(view)) });
    case "model-panel":
      return withDerived({ ...view, overlay: panelOverlay(ev.content) });
    case "compact-review":
      return withDerived({ ...view, overlay: panelOverlay(compactReview(view)) });
    case "review-queue-panel":
      return withDerived({ ...view, overlay: panelOverlay(reviewQueuePanel(view)) });
    case "approval-opened": {
      const { overlay: _overlay, ...approvalBase } = view;
      void _overlay;
      return withDerived({
        ...approvalBase,
        pendingReviews: 1,
        activeApproval: {
          detail: boundedApprovalLine(ev.detail, 2_048, 512),
          sessionAvailable: ev.sessionAvailable,
          state: "pending",
          ...(ev.information === undefined
            ? {}
            : { information: sanitizedApprovalInformation(ev.information) }),
        },
      });
    }
    case "approval-message":
      return view.activeApproval === undefined
        ? view
        : withDerived({
            ...view,
            activeApproval: {
              ...view.activeApproval,
              message: boundedApprovalLine(ev.content, 240, 160),
            },
          });
    case "approval-submitted":
      return view.activeApproval === undefined
        ? view
        : withDerived({
            ...view,
            pendingReviews: 1,
            activeApproval: {
              ...view.activeApproval,
              state: "submitted",
              message: boundedApprovalLine(ev.content, 240, 160),
              ...(ev.choice === undefined ? {} : { selectedChoice: ev.choice }),
            },
          });
    case "approval-confirmed": {
      if (view.activeApproval === undefined) return view;
      const { pendingReviews: _pendingReviews, ...confirmedBase } = view;
      void _pendingReviews;
      return withDerived({
        ...confirmedBase,
        activeApproval: {
          ...view.activeApproval,
          state: "confirmed",
          message: boundedApprovalLine(ev.content, 240, 160),
        },
      });
    }
    case "approval-governed-deny": {
      if (view.activeApproval === undefined) return view;
      const { pendingReviews: _pendingReviews, ...governedDenyBase } = view;
      void _pendingReviews;
      return withDerived({
        ...governedDenyBase,
        activeApproval: {
          ...view.activeApproval,
          state: "governed-deny",
          message: boundedApprovalLine(ev.content, 240, 160),
        },
      });
    }
    case "approval-denied": {
      if (view.activeApproval === undefined) return view;
      const { pendingReviews: _pendingReviews, ...deniedBase } = view;
      void _pendingReviews;
      return withDerived({
        ...deniedBase,
        activeApproval: {
          ...view.activeApproval,
          state: "denied",
          message: boundedApprovalLine(ev.content, 240, 160),
        },
      });
    }
    case "approval-indeterminate": {
      if (view.activeApproval === undefined) return view;
      const { pendingReviews: _pendingReviews, ...indeterminateBase } = view;
      void _pendingReviews;
      return withDerived({
        ...indeterminateBase,
        activeApproval: {
          ...view.activeApproval,
          state: "indeterminate",
          message: boundedApprovalLine(ev.content, 240, 160),
        },
      });
    }
    case "approval-failed": {
      if (view.activeApproval === undefined) return view;
      const { pendingReviews: _pendingReviews, ...failedBase } = view;
      void _pendingReviews;
      return withDerived({
        ...failedBase,
        activeApproval: {
          ...view.activeApproval,
          state: "failed",
          message: boundedApprovalLine(ev.content, 240, 160),
        },
      });
    }
    case "approval-closed": {
      const {
        pendingReviews: _pendingReviews,
        activeApproval: _activeApproval,
        ...closedBase
      } = view;
      void _pendingReviews;
      void _activeApproval;
      const content = ev.content === undefined ? undefined : stripControlLine(ev.content);
      return withDerived({
        ...closedBase,
        ...(content !== undefined && content.length > 0
          ? { items: [...view.items, { kind: "message", role: "system", content }] }
          : {}),
      });
    }
    case "system-notice": {
      const { overlay: _noticeOverlay, ...noticeBase } = view;
      void _noticeOverlay;
      return withDerived({
        ...noticeBase,
        items: [
          ...view.items,
          {
            kind: "message",
            role: "system",
            content: stripControlLine(ev.content),
            presentation: "notice",
          },
        ],
      });
    }
    case "auto-resolution-receipt": {
      const summary = mergeAutoResolutionReceipt(view.turnSummary, ev.automatic, ev.attention);
      if (summary === view.turnSummary) return view;
      return summary === undefined ? view : withDerived({ ...view, turnSummary: summary });
    }
    case "text-delta": {
      const text = stripControl(ev.text);
      const last = view.items.at(-1);
      if (view.streaming && last?.kind === "message" && last.role === "assistant") {
        const streamDeltas = [
          ...(last.streamDeltas ?? []),
          { start: last.content.length, text },
        ].slice(-64);
        return withDerived({
          ...view,
          items: [...view.items.slice(0, -1), appendAssistantStream(last, text, streamDeltas)],
        });
      }
      return withDerived({
        ...view,
        items: [...view.items, beginAssistantStream(text, [{ start: 0, text }])],
        streaming: true,
      });
    }
    case "tool-call": {
      // A tool call ends the assistant's text turn and appends a running activity line. An edit may
      // show its requested path, but never request-derived old/new lines as execution evidence.
      const isEdit = ev.name === "edit";
      const path = ev.args["path"];
      const summary = isEdit && typeof path === "string" ? stripControl(path) : "";
      const subject = toolInvocationSubject(ev.name, ev.args);
      return withDerived({
        ...view,
        streaming: false,
        items: [
          ...view.items,
          {
            kind: "tool",
            id: ev.id,
            name: stripControl(ev.name), // the model picks the tool name — strip it (ER-020 / §4.9.1)
            status: "running",
            summary,
            ...(subject !== undefined ? { subject } : {}),
          },
        ],
      });
    }
    case "tool-output-delta": {
      // §4.9.7 purposeful liveness: surface a *running* tool's latest output line, as ONE capped row
      // at this single source of "what to show" (ER-020 / §4.9.1). The line MUST stay single-line and
      // bounded so a crafted chunk can neither (a) smuggle ANSI nor (b) paint a SECOND row that forges
      // an enforced-posture line above the honest HUD. So, like the `tool-result` summary: take the
      // first newline-delimited line (slice first to bound the work on a pathological mega-line),
      // control-strip it, collapse the Unicode line/paragraph separators stripControl leaves
      // (U+2028/U+2029 — they break lines in many terminals and reach here via the bash path), and
      // trim. A blank line is ignored (keep the prior one); only a running tool with this id whose line
      // actually CHANGES is updated — anything else returns the SAME view (no allocation, no re-render).
      const line = stripControl(firstLine(ev.chunk.slice(0, MAX_LIVE_OUTPUT_LEN)))
        .replace(/[\u2028\u2029]/g, " ")
        .trim();
      if (line === "") return view;
      const targetIndex = view.items.findIndex(
        (item) => item.kind === "tool" && item.id === ev.id && item.status === "running",
      );
      if (targetIndex < 0) return view;
      let changed = false;
      const items = view.items.map((it, index) => {
        if (index === targetIndex && it.kind === "tool" && it.liveOutput !== line) {
          changed = true;
          return { ...it, liveOutput: line };
        }
        return it;
      });
      return changed ? withDerived({ ...view, items }) : view;
    }
    case "tool-liveness": {
      if (!Number.isSafeInteger(ev.itemIndex) || ev.itemIndex < 0) return view;
      const target = view.items[ev.itemIndex];
      if (target?.kind !== "tool" || target.status !== "running" || target.id !== ev.id) {
        return view;
      }
      if (ev.elapsedMs === undefined) {
        if (target.liveness === undefined) return view;
        const { liveness: _liveness, ...withoutLiveness } = target;
        void _liveness;
        return withDerived({
          ...view,
          items: view.items.map((item, index) => (index === ev.itemIndex ? withoutLiveness : item)),
        });
      }
      const bounded = (value: number): number => {
        if (value === Number.POSITIVE_INFINITY) return 99 * 60 * 60 * 1_000;
        if (!Number.isFinite(value)) return 0;
        return Math.min(99 * 60 * 60 * 1_000, Math.max(0, Math.floor(value)));
      };
      const elapsedMs = bounded(ev.elapsedMs);
      const quietMs = bounded(ev.quietMs ?? ev.elapsedMs);
      const timeoutMs =
        ev.timeoutMs !== undefined && Number.isFinite(ev.timeoutMs) && ev.timeoutMs > 0
          ? bounded(ev.timeoutMs)
          : undefined;
      const liveness = {
        elapsedMs,
        quietMs,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
      if (
        target.liveness?.elapsedMs === liveness.elapsedMs &&
        target.liveness.quietMs === liveness.quietMs &&
        target.liveness.timeoutMs === liveness.timeoutMs
      ) {
        return view;
      }
      return withDerived({
        ...view,
        items: view.items.map((item, index) =>
          index === ev.itemIndex && item.kind === "tool" ? { ...item, liveness } : item,
        ),
      });
    }
    case "tool-result": {
      const targetIndex = view.items.findIndex(
        (item) => item.kind === "tool" && item.id === ev.id && item.status === "running",
      );
      if (targetIndex < 0) return view;
      // A resolver can decorate only a successful occurrence. Preserve this truth boundary in the
      // reducer as well as the Warden executor so a faulty future executor cannot turn failure into
      // verified mutation evidence.
      const hasPresentationResolver =
        ev.ok && mutationPresentationResolverForEvent(ev) !== undefined;
      const outcome = toolPresentationOutcome(ev);
      const reviewSettlementOutcome = ev.ok
        ? undefined
        : kernelReviewSettlementOutcome(stripControlLine(ev.output).trim());
      let settledActivity: import("@keel/shared").UiToolActivity | undefined;
      const next = withDerived({
        ...view,
        items: view.items.map((it, index) => {
          if (index !== targetIndex || it.kind !== "tool") return it;
          const uncapturedMutation = workspaceEffectsUncaptured(it.name, outcome);
          const settled = {
            // Reconstruct WITHOUT `liveOutput` (listed explicitly rather than `...it`): a settled
            // tool carries no live line, so the final view model is unchanged from pre-1.5c.
            kind: "tool" as const,
            id: it.id,
            name: it.name,
            status: ev.ok ? ("ok" as const) : ("error" as const),
            // keep an edit's path summary (its diff shows the change); else show the result — for a
            // FAILED tool, the meaningful output is the error, almost always the LAST line, not the
            // first (§3.9, slice 6); a successful tool keeps its calm first-line summary. Bound it the
            // same way the live path bounds a streamed line (MAX_LIVE_OUTPUT_LEN): a newline-less
            // mega-line would otherwise make firstLine/lastMeaningfulLine return the whole blob and be
            // stored + re-rendered whole. Slice the raw output to the bound FIRST (head for success's
            // first line, tail for a failure's last line) so the work is bounded too, then truncate.
            summary: toolResultSummary(it.name, it.summary, ev.ok, ev.output, outcome),
            ...(it.subject !== undefined ? { subject: it.subject } : {}),
            ...(it.diff !== undefined ? { diff: it.diff } : {}),
            ...(hasPresentationResolver
              ? { mutationPresentation: { status: "pending" as const } }
              : ev.ok && (it.name === "write" || it.name === "edit")
                ? {
                    mutationPresentation: {
                      status: "unavailable" as const,
                      reason: "executor-no-resolver" as const,
                    },
                  }
                : uncapturedMutation !== undefined
                  ? { mutationPresentation: uncapturedMutation }
                  : {}),
          };
          settledActivity =
            outcome === undefined ? settled : markToolPresentationOutcome(settled, outcome);
          if (reviewSettlementOutcome !== undefined && reviewSettlementOutcome === outcome) {
            settledActivity = markReviewSettlementPresentation(
              settledActivity,
              reviewSettlementOutcome,
            );
          }
          return settledActivity;
        }),
      });
      if (settledActivity !== undefined && hasPresentationResolver) {
        associateMutationPresentationActivity(ev, settledActivity);
      }
      return next;
    }
    case "run-finished": {
      const items = settleRunningToolsAtRunEnd(withoutStreamDeltas(view.items));
      const settledView = items === view.items ? view : { ...view, items };
      const summary = buildTurnSummary(settledView);
      // `run-finished.usage` is cumulative throughput/spend for the whole run, not active-window
      // occupancy. Never derive `ctx%` from it; only a separate active-window signal may populate
      // `status.context.percent`. The HUD labels cumulative usage as `total` to keep the boundary clear.
      return withDerived({
        ...settledView,
        ...(summary !== undefined ? { turnSummary: summary } : {}),
        streaming: false,
        status: {
          ...view.status,
          tokens: ev.usage.inputTokens + ev.usage.outputTokens,
        },
      });
    }
    case "turn-started":
      return view.streaming ? withDerived({ ...view, streaming: false }) : view;
    case "stop": {
      // Surface an abnormal terminal so a failed run is not silent (INT-2). `model-stop` is success
      // and `aborted` is the user interrupt (noticed via the `interrupted` event) — neither adds a
      // notice; every other reason ended the run WITHOUT finishing and must be visible.
      const base = view.streaming ? withDerived({ ...view, streaming: false }) : view;
      // The warden-death halt (P0-3) reuses reason "error" (no frozen StopReason change) but must NOT
      // be misattributed to the model/provider — its message is already a complete honest sentence.
      if (ev.code === "WARDEN_UNAVAILABLE" && ev.message) {
        return withDerived({
          ...base,
          status: {
            ...base.status,
            posture: ALL_OFF_POSTURE,
            policy: { active: false },
            startup: { phase: "protections-unavailable" },
          },
          items: [
            ...base.items,
            {
              kind: "message",
              role: "system",
              content: `⚠ run ended — ${stripControl(ev.message)}`,
            },
          ],
        });
      }
      // The terminal review tool card and evidence receipt already carry the exact non-execution and
      // recovery guidance. Keep the non-success stop for exit/session honesty without adding a second
      // generic provider-error notice to the transcript.
      if (ev.code === "REVIEW_REQUIRED" || ev.code === "BLOCKED") return base;
      const why = TERMINAL_FAILURE[ev.reason];
      if (why === undefined) return base;
      const detail = ev.reason === "error" && ev.message ? `: ${stripControl(ev.message)}` : "";
      return withDerived({
        ...base,
        items: [
          ...base.items,
          { kind: "message", role: "system", content: `⚠ run ended — ${why}${detail}` },
        ],
      });
    }
    default:
      return view; // injected nudges (slice 3) / infra-error → later
  }
}
