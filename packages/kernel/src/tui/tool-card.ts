import type {
  UiMutationPresentation,
  UiMutationPresentationUnavailableReason,
  UiToolActivity,
  ViewModel,
} from "@keel/shared";
import { planDiffRender } from "./diff.js";
import { stripControlLine } from "./strip.js";
import { truncateDisplayCells } from "./display-cells.js";
import type { DiffRender } from "./diff.js";
import { toolOutcome } from "./tool-outcome.js";
import {
  reviewSettlementPresentation,
  reviewSettlementRecovery,
} from "./review-settlement-presentation.js";
import { TUI_TERMINAL_REVIEW_TRUTH } from "./strings.js";

export interface ToolCardPlan {
  readonly glyph: "⋯" | "✓" | "~" | "!" | "✗" | "○" | "■";
  readonly tone: "info" | "success" | "warning" | "danger";
  readonly title: string;
  readonly statusLabel:
    | "requested"
    | "checking"
    | "running"
    | "done"
    | "limited"
    | "partial"
    | "review needed"
    | "blocked"
    | "skipped"
    | "stopped"
    | "failed";
  readonly summaryLabel?: "result" | "error";
  readonly summary?: string;
  readonly recovery?: string;
  readonly liveOutput?: string;
  readonly diff?: DiffRender;
  readonly mutationReview?: {
    readonly lines: readonly string[];
  };
}

const PRESENTATION = {
  requested: { glyph: "⋯", tone: "info", statusLabel: "requested" },
  checking: { glyph: "⋯", tone: "info", statusLabel: "checking" },
  running: { glyph: "⋯", tone: "info", statusLabel: "running" },
  done: { glyph: "✓", tone: "success", statusLabel: "done" },
  limited: { glyph: "~", tone: "warning", statusLabel: "limited" },
  partial: { glyph: "~", tone: "warning", statusLabel: "partial" },
  review: { glyph: "!", tone: "warning", statusLabel: "review needed" },
  blocked: { glyph: "✗", tone: "danger", statusLabel: "blocked" },
  skipped: { glyph: "○", tone: "warning", statusLabel: "skipped" },
  stopped: { glyph: "■", tone: "warning", statusLabel: "stopped" },
  failed: { glyph: "✗", tone: "danger", statusLabel: "failed" },
} as const;

const RECOVERY = {
  limited: "next: narrow the request for complete output",
  partial: "next: inspect the target before retrying",
  review: "next: no live approval · simplify the request, then rerun",
  blocked: "next: change the request or command, then rerun",
  skipped: "next: change approach before retrying",
  stopped: "next: continue when ready",
  failed: "next: correct the input or revise the request, then retry",
} as const;
const MAX_TITLE = 40;
const MAX_SUMMARY = 120;
const MAX_LIVE_OUTPUT = 160;

function recoveryFor(item: UiToolActivity, outcome: string): string | undefined {
  const reviewRecovery = reviewSettlementRecovery(reviewSettlementPresentation(item));
  if (reviewRecovery !== undefined) return `next: ${reviewRecovery}`;
  if (outcome === "blocked" && item.summary.startsWith(TUI_TERMINAL_REVIEW_TRUTH.summaryPrefix)) {
    return `next: ${TUI_TERMINAL_REVIEW_TRUTH.recovery}`;
  }
  return outcome in RECOVERY ? RECOVERY[outcome as keyof typeof RECOVERY] : undefined;
}

function truncateDisplayLine(input: string, max: number): string {
  const line = stripControlLine(input).trim().replace(/\s+/g, " ");
  return truncateDisplayCells(line, max, { tailCells: Math.min(40, Math.floor(max / 3)) });
}

export function mutationReviewUnavailableCopy(
  reason: UiMutationPresentationUnavailableReason,
): string {
  switch (reason) {
    case "unsupported-peer":
      return "governed observation capture needs protocol 1.1";
    case "capability-unavailable":
      return "governed observation capture is not available";
    case "executor-no-resolver":
      return "governed observation capture is not connected";
    case "capture-unavailable":
      return "governed observation capture was unavailable";
    case "capture-budget":
      return "observation exceeded presentation limits";
    case "redaction-failed":
      return "safe display could not be produced";
    case "not-found-or-consumed":
      return "review artifact unavailable or already consumed";
    case "invalid-response":
    case "presentation-timeout":
    case "transport-failed":
      return "presentation channel did not settle";
    case "occurrence-ended":
      return "occurrence ended before display";
    case "workspace-effects-not-captured":
      return "workspace effects not captured for this tool";
    case "live-observations-not-persisted":
      return "live mutation observations were not persisted";
  }
}

type AvailableMutationPresentation = Extract<
  UiMutationPresentation,
  { readonly status: "available" }
>;
type FileImage = AvailableMutationPresentation["verifiedInstalledAfter"];

function modeText(mode: number): string {
  return Math.max(0, Math.trunc(mode)).toString(8).padStart(4, "0");
}

function fileImageText(label: "observed" | "verified", image: FileImage): string {
  return `${label} ${image.contentClass} · ${String(image.bytes)} B · mode ${modeText(image.mode)} · final newline ${image.finalNewline ? "present" : "missing"}`;
}

function mutationImageLine(presentation: AvailableMutationPresentation): string | undefined {
  const observed = presentation.observedBefore;
  const installed = presentation.verifiedInstalledAfter;
  const special =
    observed.status !== "file-observed" ||
    observed.contentClass === "binary" ||
    installed.contentClass === "binary" ||
    observed.mode !== installed.mode ||
    !observed.finalNewline ||
    !installed.finalNewline;
  if (!special) return undefined;
  const observedText =
    observed.status === "file-observed"
      ? fileImageText("observed", observed)
      : observed.status === "absent-observed"
        ? "observed absent"
        : "observed not inspected";
  return `image  ${observedText} → ${fileImageText("verified", installed)}`;
}

function countText(count: number | "unknown"): string {
  return typeof count === "number" ? String(count) : count;
}

function mutationCoverageLine(presentation: AvailableMutationPresentation): string | undefined {
  const shown = countText(presentation.shownLines);
  const hidden = countText(presentation.hiddenLines);
  switch (presentation.coverage) {
    case "complete":
      if (presentation.shownLines === 0) {
        if (typeof presentation.hiddenLines === "number" && presentation.hiddenLines > 0) {
          return `comparison  no differing rows · ${hidden} unchanged rows omitted`;
        }
        return presentation.hiddenLines === "unknown"
          ? "comparison  no differing rows · unchanged row count unknown"
          : "comparison  no differing rows";
      }
      return typeof presentation.hiddenLines === "number" && presentation.hiddenLines > 0
        ? `comparison  complete · ${shown} rows shown · ${hidden} unchanged rows omitted`
        : undefined;
    case "truncated":
      return `comparison  truncated · ${shown} rows shown · ${hidden} hidden`;
    case "summary-only":
      return "comparison  summary only · line content unavailable";
    case "unknown":
      return "comparison  unavailable · totals unknown";
  }
}

/** Pure tool-card presentation plan (Epic 1.24 slice 3). Renderers map this; they do not decide copy. */
export function toolCardPlan(item: UiToolActivity, diffMode: ViewModel["diffMode"]): ToolCardPlan {
  const outcome = toolOutcome(item);
  const presentation =
    outcome !== "running"
      ? PRESENTATION[outcome]
      : item.liveness === undefined
        ? PRESENTATION.requested
        : item.liveOutput === undefined
          ? PRESENTATION.checking
          : PRESENTATION.running;
  const title = truncateDisplayLine(item.name, MAX_TITLE);
  const summary = truncateDisplayLine(item.summary, MAX_SUMMARY);
  const liveOutput =
    item.liveOutput !== undefined
      ? truncateDisplayLine(item.liveOutput, MAX_LIVE_OUTPUT)
      : undefined;
  const diffPath =
    title === "edit"
      ? item.mutationPresentation?.status === "available"
        ? stripControlLine(item.mutationPresentation.displayPath)
        : summary
      : undefined;
  const diff =
    item.diff && item.diff.length > 0 ? planDiffRender(item.diff, diffMode, diffPath) : undefined;
  const mutationReview = (() => {
    const presentation = item.mutationPresentation;
    if (presentation === undefined) return undefined;
    if (presentation.status === "pending") {
      return { lines: ["review  preparing verified mutation observations"] };
    }
    if (presentation.status === "unavailable") {
      if (presentation.reason === "workspace-effects-not-captured") {
        return { lines: ["workspace effects  not captured for this tool"] };
      }
      return {
        lines: [`review  unavailable — ${mutationReviewUnavailableCopy(presentation.reason)}`],
      };
    }
    const image = mutationImageLine(presentation);
    const coverage = mutationCoverageLine(presentation);
    return {
      lines: [
        `review  ${presentation.displayPath}`,
        `evidence  observed before → verified installed after · ${String(presentation.observedBeforeLines)} → ${String(presentation.installedAfterLines)} lines`,
        ...(image === undefined ? [] : [image]),
        ...(coverage === undefined ? [] : [coverage]),
        "scope  transition not atomic · concurrent mutation not excluded",
      ],
    };
  })();
  const recovery = recoveryFor(item, outcome);
  return {
    glyph: presentation.glyph,
    tone: presentation.tone,
    title,
    statusLabel: presentation.statusLabel,
    ...(summary.length > 0
      ? { summaryLabel: item.status === "error" ? "error" : "result", summary }
      : {}),
    ...(recovery === undefined ? {} : { recovery }),
    ...(item.status === "running" && liveOutput !== undefined ? { liveOutput } : {}),
    ...(diff !== undefined ? { diff } : {}),
    ...(mutationReview !== undefined ? { mutationReview } : {}),
  };
}
