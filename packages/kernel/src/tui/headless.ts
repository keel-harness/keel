import type {
  Overlay,
  UIPort,
  UiCurrentTurn,
  UiQueuedInput,
  UserInput,
  ViewItem,
  ViewModel,
} from "@keel/shared";
import {
  assistantLivePreview,
  assistantLivePreviewNotice,
  renderAssistantProseText,
} from "./assistant-prose.js";
import { commandGroups, commandRow } from "./commands.js";
import {
  activeTurnRows,
  conversationPlan,
  isTerminalRunNotice,
  isRoutineSuccessfulTool,
  toolEvidenceLineForItem,
  transcriptCommitPlan,
  visibleConversationItemsWithIndexes,
  visibleTurnItemsWithIndexes,
  type AssistantPresentationRole,
  type ConversationPlan,
  type TurnEvidencePresentation,
  type TurnSummaryPresentation,
} from "./conversation-block.js";
import { responseSurfaceColumns } from "./row-budget.js";
import { terminalDisplayWidth, wrapDisplayLine } from "./display-cells.js";
import { compactStat, effectiveDiffMode, moreHint, visibleDiffText } from "./diff.js";
import { hintFooter } from "./hints.js";
import { hasSemanticZoomMutationReview, toolCardPlan } from "./tool-card.js";
import { toolOutcome } from "./tool-outcome.js";
import { visibleTerminalText } from "./visible-text.js";
import { renderPendingReviewCount } from "../warden/approval.js";
import { approvalNoticePlan, approvalNoticeRows } from "./approval-notice.js";
import {
  COMPLETION_TRUTH_NOTICE_PREFIX,
  HELP_LINES,
  statusRows,
  leadingSystemEnd,
  queuedInputLine,
  urgentSteeringLine,
  stripControl,
  stripControlLine,
  welcomeText,
} from "./view-model.js";

const DIFF_SIGN = { context: " ", add: "+", del: "-" } as const;

function wrapHeadlessLine(line: string, columns: number): readonly string[] {
  if (terminalDisplayWidth(line) <= columns) return [line];
  const rows: string[] = [];
  let remainder = line;
  const indent = /^\s*/u.exec(line)?.[0] ?? "";
  while (terminalDisplayWidth(remainder) > columns) {
    const hard = wrapDisplayLine(remainder, columns)[0]?.text ?? remainder;
    const boundary = hard.lastIndexOf(" ");
    if (boundary > Math.max(indent.length, 12)) {
      rows.push(hard.slice(0, boundary));
      remainder = `${indent}${remainder.slice(boundary + 1).trimStart()}`;
    } else {
      rows.push(hard);
      remainder = `${indent}${remainder.slice(hard.length).trimStart()}`;
    }
  }
  if (remainder.length > 0) rows.push(remainder);
  return rows;
}

function indentBlock(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

/** Render one conversation item to plain text. Stable text labels mark each transcript kind; tool activity maps the gated
 *  `toolCardPlan` (status head, labeled summary/recovery, optional diff detail). */
function renderItem(
  it: ViewItem,
  diffMode: ViewModel["diffMode"],
  density: ViewModel["density"],
  options: {
    readonly livePreview?: boolean;
    readonly assistantRole?: AssistantPresentationRole | undefined;
    readonly terminalColumns?: number;
    readonly includeSemanticMutationReview?: boolean;
    readonly includeControllerEvidence?: boolean;
  } = {},
): string {
  if (it.kind === "message") {
    if (it.role === "user") return `you  ${it.content}`;
    if (it.role === "assistant") {
      const preview = options.livePreview === true ? assistantLivePreview(it.content) : undefined;
      const content = preview?.content ?? it.content;
      const lines = [
        ...(preview !== undefined && preview.hiddenLines > 0
          ? [assistantLivePreviewNotice(preview.hiddenLines)]
          : []),
        renderAssistantProseText(content),
      ].filter((line) => line.length > 0);
      const label = options.assistantRole === "progress" ? "keel · working" : "keel";
      return `${label}\n${indentBlock(lines.join("\n"))}`;
    }
    if (it.content.startsWith(COMPLETION_TRUTH_NOTICE_PREFIX)) {
      const columns = Math.max(1, Math.floor(options.terminalColumns ?? 80));
      const body = indentBlock(it.content)
        .split("\n")
        .flatMap((line) => wrapHeadlessLine(line, columns));
      return ["note", ...body].join("\n");
    }
    return `note\n${indentBlock(it.content)}`;
  }
  const card = toolCardPlan(it, effectiveDiffMode(density, diffMode));
  const compact = card.diff?.compact ? compactStat(card.diff.compact) : "";
  const head = `tool  ${card.glyph} ${card.title}  ${card.statusLabel}${compact}`;
  const lines: string[] = [head];
  const controllerEvidence =
    options.includeControllerEvidence === true && toolOutcome(it) !== "done"
      ? toolEvidenceLineForItem(it)
      : undefined;
  if (controllerEvidence !== undefined) {
    lines.push(`  what: ${controllerEvidence.text}`);
  } else if (card.summary !== undefined && card.summaryLabel !== undefined) {
    lines.push(`  ${card.summaryLabel}: ${card.summary}`);
  }
  if (card.diff?.triage !== undefined) {
    const t = card.diff.triage;
    lines.push(`  triage: ${t.kind} ${t.collapsed ? "collapsed" : "expanded"} — ${t.reason}`);
  }
  if (controllerEvidence?.why !== undefined) lines.push(`  why: ${controllerEvidence.why}`);
  if (controllerEvidence?.next !== undefined) lines.push(`  next: ${controllerEvidence.next}`);
  else if (card.recovery !== undefined) lines.push(`  ${card.recovery}`);
  if (
    card.mutationReview !== undefined &&
    (options.includeSemanticMutationReview !== false || !hasSemanticZoomMutationReview(it))
  ) {
    lines.push(...card.mutationReview.lines.map((line) => `  ${line}`));
  }
  // Non-TTY/headless mutation review is summary-only by default: never emit comparison lines.
  if (card.diff?.lines !== undefined && it.mutationPresentation === undefined) {
    lines.push("  diff");
    lines.push(...card.diff.lines.map((d) => `   ${DIFF_SIGN[d.kind]} ${visibleDiffText(d.text)}`));
  }
  if (card.diff?.hidden !== undefined && it.mutationPresentation === undefined) {
    lines.push(`   ${moreHint(card.diff.hidden, card.diff.hiddenHunks)}`);
  }
  if (density === "debug") lines.push(`  id: ${it.id}`);
  if (it.name !== "process.run") return lines.join("\n");
  const columns = Math.max(1, Math.floor(options.terminalColumns ?? 80));
  return lines.flatMap((line) => wrapHeadlessLine(line, columns)).join("\n");
}

/** The trust HUD (§4.9.1): normal output uses the same compact rows as Ink; debug uses the full cockpit. */
export function renderStatus(
  status: ViewModel["status"],
  density?: ViewModel["density"],
  diffMode?: ViewModel["diffMode"],
): string {
  return statusRows(status, { density, diffMode }).join("\n");
}

/** The conversation transcript as one block: messages get blank-line separation; consecutive tool
 *  lines stay tight. Factored out of `renderFrame` so the incremental streamer (HeadlessUI sink)
 *  reproduces exactly the same separators. `verbose` (default) shows everything; `false` drops the
 *  leading system preamble (the `keel run -p` scaffolding dump). */
function renderExpandedItems(
  items: readonly ViewItem[],
  view: ViewModel,
  initialPrevKind = "",
  startIndex = 0,
  suppressFailedTools = false,
  suppressEvidenceItems = false,
  suppressProblemTools = false,
  retainSuccessfulTools = false,
  suppressExploratoryFailures = false,
  terminalColumns = 80,
  retainConsequentialTools = false,
): string {
  const lines: string[] = [];
  let prevKind = initialPrevKind;
  const retainConsequentialEvidence =
    retainConsequentialTools &&
    items.some((item) => item.kind === "tool" && hasSemanticZoomMutationReview(item));
  for (const { item, index, assistantRole } of visibleTurnItemsWithIndexes(items, view.density, {
    suppressFailedTools,
    suppressEvidenceItems,
    suppressProblemTools,
    suppressExploratoryFailures,
    retainDiffTools: view.diffMode === "full",
    retainSuccessfulTools,
    retainConsequentialTools: retainConsequentialEvidence,
  })) {
    const livePreview =
      view.streaming &&
      item.kind === "message" &&
      item.role === "assistant" &&
      startIndex + index === view.items.length - 1;
    const rendered = renderItem(item, view.diffMode, view.density, {
      livePreview,
      assistantRole,
      terminalColumns,
      includeSemanticMutationReview: false,
      includeControllerEvidence: retainConsequentialEvidence,
    });
    if (rendered.length === 0) continue;
    if (lines.length > 0 && !(item.kind === "tool" && prevKind === "tool")) lines.push("");
    lines.push(rendered);
    prevKind = item.kind;
  }
  return lines.join("\n");
}

/** Headless streaming owns the stable mutation result as soon as execution settles. Semantic-zoom
 *  integrity rows are a monotonic turn supplement, so a later density change never requires stdout
 *  to retract a completed mutation or lose it on hard kill. */
function renderSemanticMutationReviews(items: readonly ViewItem[], view: ViewModel): string {
  return items
    .flatMap((item) => {
      if (item.kind !== "tool" || !hasSemanticZoomMutationReview(item)) return [];
      return (
        toolCardPlan(item, effectiveDiffMode(view.density, view.diffMode)).mutationReview?.lines ??
        []
      );
    })
    .map((line) => `  ${line}`)
    .join("\n");
}

function evidenceForMode(
  card: TurnEvidencePresentation,
  interactive: boolean,
  retainSuccessfulTools: boolean,
  items: readonly ViewItem[],
  density: ViewModel["density"],
  retainConsequentialTools = false,
): TurnEvidencePresentation | undefined {
  const rawToolEvidenceKind = (item: Extract<ViewItem, { kind: "tool" }>): string | undefined => {
    const outcome = toolOutcome(item);
    if (outcome === "done") {
      if (item.name === "bash" || item.name === "process.run") return "ran";
      if (item.name !== "edit" && item.name !== "write") return "tool";
      return undefined;
    }
    return outcome === "limited" ||
      outcome === "partial" ||
      outcome === "review" ||
      outcome === "blocked" ||
      outcome === "skipped" ||
      outcome === "failed" ||
      outcome === "stopped"
      ? outcome
      : undefined;
  };
  const normalized = (value: string): string =>
    stripControlLine(value).replace(/\s+/gu, " ").trim();
  const detailed = density === "verbose" || density === "debug";
  const lines = card.lines.filter((line) => {
    if (!interactive && retainSuccessfulTools && (line.kind === "ran" || line.kind === "tool"))
      return false;
    const consequential =
      line.kind === "limited" ||
      line.kind === "partial" ||
      line.kind === "review" ||
      line.kind === "blocked" ||
      line.kind === "skipped" ||
      line.kind === "failed" ||
      line.kind === "stopped";
    if (!detailed && !(retainConsequentialTools && consequential)) return true;
    return !items.some((item) => {
      if (item.kind !== "tool" || rawToolEvidenceKind(item) !== line.kind) return false;
      const rawEvidence = toolEvidenceLineForItem(item);
      if (rawEvidence === undefined || rawEvidence.kind !== line.kind) return false;
      const evidence = normalized(line.text).replace(/ \(\d+ times\)$/u, "");
      // Detailed headless output already carries this exact planner-owned fact in the raw tool card.
      // A shorter prefix can be an independent summary/attention fact and must remain visible.
      return normalized(rawEvidence.text) === evidence;
    });
  });
  return lines.length === 0 ? undefined : { ...card, lines };
}

function renderConversationPlan(
  view: ViewModel,
  plan: ConversationPlan,
  interactive: boolean,
  retainSuccessfulTools: boolean,
  terminalColumns: number,
): string {
  const blocks = plan.blocks.flatMap((block) => {
    if (block.kind === "items") {
      const rendered = renderExpandedItems(
        block.items,
        view,
        "",
        block.startIndex,
        false,
        false,
        block.suppressProblemTools,
        retainSuccessfulTools,
        false,
        terminalColumns,
        true,
      );
      const parts = rendered.length > 0 ? [rendered] : [];
      const evidence =
        block.evidence === undefined
          ? undefined
          : evidenceForMode(
              block.evidence,
              interactive,
              retainSuccessfulTools,
              block.items,
              view.density,
              block.items.some(
                (item) => item.kind === "tool" && hasSemanticZoomMutationReview(item),
              ),
            );
      if (evidence !== undefined) parts.push(renderTurnEvidence(evidence, terminalColumns));
      const mutationReviews = renderSemanticMutationReviews(block.items, view);
      if (mutationReviews.length > 0) parts.push(mutationReviews);
      return parts.length > 0 ? [parts.join("\n\n")] : [];
    }
    if (block.mode === "compact") {
      return [`${renderItem(block.user, view.diffMode, view.density)}\n  ${block.receipt}`];
    }
    const parts = [renderItem(block.user, view.diffMode, view.density)];
    const body = renderExpandedItems(
      block.items,
      view,
      "message",
      block.startIndex + 1,
      block.suppressFailedTools,
      block.suppressEvidenceItems,
      block.suppressProblemTools,
      retainSuccessfulTools,
      block.suppressExploratoryFailures,
      terminalColumns,
      true,
    );
    if (body.length > 0) parts.push(body);
    const evidence =
      block.evidence === undefined
        ? undefined
        : evidenceForMode(
            block.evidence,
            interactive,
            retainSuccessfulTools,
            block.items,
            view.density,
            block.items.some((item) => item.kind === "tool" && hasSemanticZoomMutationReview(item)),
          );
    if (evidence !== undefined) parts.push(renderTurnEvidence(evidence, terminalColumns));
    const mutationReviews = renderSemanticMutationReviews(block.items, view);
    if (mutationReviews.length > 0) parts.push(mutationReviews);
    if (!interactive && block.runControlReceipt !== undefined)
      parts.push(renderRunControlReceipt(block.runControlReceipt));
    if (interactive && block.currentTurn !== undefined)
      parts.push(
        renderCurrentTurn(
          block.currentTurn,
          view.density,
          view.overlay === undefined ? block.user.content : undefined,
          terminalColumns,
        ),
      );
    if (interactive && block.summary !== undefined)
      parts.push(renderTurnSummary(block.summary, terminalColumns));
    return [parts.join("\n\n")];
  });
  return blocks.join("\n\n");
}

/**
 * The non-transcript blocks below the conversation. `interactive` (Epic 1.24 Tier-A QC) gates the
 * INTERACTIVE-session chrome — the attention rail, current-turn pane, queued/pending steering, the
 * turn-summary card, the density line, and the keyboard-hint footer — OUT of one-shot `keel run -p`
 * (and piped/CI) machine output: those are live-TTY affordances, meaningless and noisy in a script or
 * pipe. The honest status/posture line always stays (it is factual). `interactive` is true for an
 * interactive session (including a degraded non-TTY one), false for a one-shot `run -p`.
 */
function renderTrailerBlocks(
  view: ViewModel,
  interactive: boolean,
  plan: ConversationPlan = conversationPlan(view),
  terminalColumns = 80,
): string[] {
  const blocks: string[] = [];
  const approvalOwnsViewport = view.activeApproval !== undefined;
  if (!approvalOwnsViewport && view.overlay !== undefined) blocks.push(renderOverlay(view.overlay));
  if (interactive) {
    if (approvalOwnsViewport && view.activeApproval !== undefined) {
      const approval = approvalNoticePlan(view.activeApproval);
      blocks.push(
        `${approval.heading}\n${indentBlock(
          approvalNoticeRows(approval)
            .map((row) => row.text)
            .join("\n"),
        )}`,
      );
    }
    if (
      !approvalOwnsViewport &&
      plan.showAttentionRail &&
      plan.attentionRail !== undefined &&
      plan.attentionRail.length > 0
    ) {
      blocks.push(
        `rail: ${plan.attentionRail
          .map((m) => `${stripControlLine(m.glyph)} ${stripControlLine(m.label)}`)
          .join(" · ")}`,
      );
    }
    if (!approvalOwnsViewport && view.queuedInputs !== undefined && view.queuedInputs.length > 0) {
      blocks.push(renderQueuedInputs(view.queuedInputs));
    }
    if (!approvalOwnsViewport) {
      const urgent =
        view.urgentSteering?.state === "applied" || view.queuedInputs?.[0]?.class !== "urgent"
          ? urgentSteeringLine(view.urgentSteering)
          : undefined;
      if (urgent !== undefined) blocks.push(urgent);
    }
    const pendingReviews = !approvalOwnsViewport
      ? renderPendingReviewCount(view.pendingReviews ?? 0)
      : undefined;
    if (pendingReviews !== undefined) blocks.push(pendingReviews);
    if (!approvalOwnsViewport && plan.standaloneCurrentTurn !== undefined) {
      blocks.push(renderCurrentTurn(plan.standaloneCurrentTurn, view.density));
    }
    if (!approvalOwnsViewport && plan.standaloneSummary !== undefined)
      blocks.push(renderTurnSummary(plan.standaloneSummary, terminalColumns));
  } else if (plan.standaloneRunControlReceipt !== undefined) {
    blocks.push(renderRunControlReceipt(plan.standaloneRunControlReceipt));
  }
  blocks.push(renderStatus(view.status, view.density, view.diffMode));
  if (interactive) blocks.push(hintFooter(view));
  return blocks;
}

function renderQueuedInputs(inputs: readonly UiQueuedInput[]): string {
  return queuedInputLine(inputs) ?? "";
}

function renderCurrentTurn(
  turn: UiCurrentTurn,
  density: ViewModel["density"],
  task?: string,
  terminalColumns = 80,
): string {
  return activeTurnRows(task ?? "", turn, density, responseSurfaceColumns(terminalColumns)).join(
    "\n",
  );
}

function renderTurnEvidence(card: TurnEvidencePresentation, terminalColumns = 80): string {
  const lines: string[] = [stripControlLine(card.title)];
  for (const line of card.lines) {
    lines.push(`  what: ${line.kind.replaceAll("-", " ")}: ${stripControlLine(line.text)}`);
    if (line.why !== undefined) lines.push(`  why: ${stripControlLine(line.why)}`);
    if (line.next !== undefined) lines.push(`  next: ${stripControlLine(line.next)}`);
  }
  const columns = Math.max(1, Math.floor(terminalColumns));
  return (columns < 80 ? lines.flatMap((line) => wrapHeadlessLine(line, columns)) : lines).join(
    "\n",
  );
}

function renderRunControlReceipt(lines: readonly string[]): string {
  return [
    "run outcome",
    ...lines.map((line) => `  ${visibleTerminalText(stripControlLine(line))}`),
  ].join("\n");
}

function renderTurnSummary(card: TurnSummaryPresentation, terminalColumns = 80): string {
  // Re-strip at the renderer (ER-020 defense-in-depth): `buildTurnSummary` already sanitizes, but the
  // Done card is the lone surface that otherwise trusts that upstream — every other surface re-strips,
  // so a crafted answer / tool receipt can never smuggle a control byte into machine output here either.
  const lines: string[] = [stripControlLine(card.title)];
  const automatic = card.automatic ?? [];
  if (card.changed.length > 0)
    lines.push(...card.changed.map((s) => `  changed: ${stripControlLine(s)}`));
  if (card.checked.length > 0)
    lines.push(...card.checked.map((s) => `  checked: ${stripControlLine(s)}`));
  if ((card.fileEvidence?.length ?? 0) > 0)
    lines.push(
      ...(card.fileEvidence ?? []).map(
        (entry) =>
          `  ${entry.status === "unavailable" ? "file evidence unavailable" : "file evidence"}: ${stripControlLine(entry.text)}`,
      ),
    );
  if ((card.verification?.length ?? 0) > 0)
    lines.push(...(card.verification ?? []).map((s) => `  ${stripControlLine(s)}`));
  if ((card.ran?.length ?? 0) > 0)
    lines.push(...(card.ran ?? []).map((s) => `  ran: ${stripControlLine(s)}`));
  if (automatic.length > 0)
    lines.push(...automatic.map((s) => `  automatic: ${stripControlLine(s)}`));
  if ((card.receipt?.length ?? 0) > 0)
    lines.push(...(card.receipt ?? []).map((s) => `  ${stripControlLine(s)}`));
  if ((card.recovery?.length ?? 0) > 0)
    lines.push(...(card.recovery ?? []).map((s) => `  recovery: ${stripControlLine(s)}`));
  if (card.attention.length > 0) {
    for (const detail of card.attention) {
      lines.push(
        `  what: ${stripControlLine(detail.what)}`,
        `  why: ${stripControlLine(detail.why)}`,
        `  next: ${stripControlLine(detail.next)}`,
      );
    }
  }
  const hiddenAttention = Math.max(
    0,
    (card.attentionCount ?? card.attention.length) - card.attention.length,
  );
  if (hiddenAttention > 0) {
    lines.push(
      `  more: ${String(hiddenAttention)} more ${hiddenAttention === 1 ? "failed item" : "failed items"} hidden`,
    );
  }
  if (card.answer !== undefined) lines.push(`  answer: ${stripControlLine(card.answer)}`);
  const columns = Math.max(1, Math.floor(terminalColumns));
  return lines
    .flatMap((line) =>
      line.startsWith("  ran: process.run:") ? wrapHeadlessLine(line, columns) : [line],
    )
    .join("\n");
}

/** Serialize a view to deterministic plain text (no ANSI) — for `keel run -p`, CI, and goldens.
 *  Messages get blank-line separation; consecutive tool lines stay tight. `verbose` defaults to `true`
 *  (every existing caller / golden unchanged); `false` hides the leading system preamble (DX bug a). */
export function renderFrame(
  view: ViewModel,
  verbose = true,
  interactive = true,
  terminalColumns = 80,
): string {
  const blocks: string[] = [];
  // The first-run brand banner leads the frame (plain mono here); the honest posture line follows in
  // the trailer. Rendered from the flag, not a transcript item, so it never lingers after the first turn.
  if (
    view.firstRun &&
    view.items.length === 0 &&
    view.overlay === undefined &&
    view.activeApproval === undefined
  )
    blocks.push(welcomeText(view.recentSessions ?? [], view.usageDigest));
  const plan = conversationPlan(view, { verbose, compactHistory: false });
  const items =
    interactive && view.activeApproval !== undefined
      ? ""
      : renderConversationPlan(view, plan, interactive, !interactive && verbose, terminalColumns);
  if (items.length > 0) blocks.push(items);
  const trailer = renderTrailerBlocks(view, interactive, plan, terminalColumns);
  // Foreground overlays are one compact shell surface in Ink; keep their status/composer rows
  // adjacent here as well so headless goldens measure the same complete 80x24 hierarchy.
  if (view.activeApproval === undefined && view.overlay !== undefined)
    blocks.push(trailer.join("\n"));
  else blocks.push(...trailer);
  return blocks.join("\n\n");
}

/** The separator before a streamed item — must match `renderItemsBlock`'s join: none before the first
 *  EMITTED item, a single newline between consecutive tools, else a blank line. Keyed on whether
 *  anything has streamed yet (`prevKind === ""`, set only on an emitted item), so it stays correct even
 *  when a leading preamble is skipped (the first visible item still gets no leading separator). */
function sepFor(prevKind: string, kind: ViewItem["kind"]): string {
  if (prevKind === "") return "";
  return kind === "tool" && prevKind === "tool" ? "\n" : "\n\n";
}

/** Render a discoverability overlay: the `/` palette (filtered commands), `?` help (keys), or the
 *  `Ctrl-R` reverse-search line (Epic 1.23 slice 3b). */
function renderOverlay(o: Overlay): string {
  if (o.kind === "help") {
    return ["help", ...HELP_LINES.map((l) => `  ${l}`)].join("\n");
  }
  if (o.kind === "panel") {
    return stripControl(o.content)
      .split("\n")
      .map((line) => stripControlLine(line))
      .join("\n");
  }
  if (o.kind === "reverse-search") {
    // ER-020: query + match are user-derived (`match` is a raw, possibly multi-line history entry) and
    // bypass the view-model reducer's strip, so normalize them HERE to a single safe line — collapsing
    // newlines too, so a match can never forge an extra row above the trust HUD (§4.9.1).
    const match = o.match !== undefined ? stripControlLine(o.match) : "";
    return `(reverse-i-search)\`${stripControlLine(o.query)}': ${match}`;
  }
  if (o.kind === "at-complete") {
    // ER-020: a filename is untrusted data — single-line-normalize each match so a control byte or a
    // newline in a path can't reach the terminal or forge an extra row.
    const head = `@${stripControlLine(o.query)}`;
    const matches = (o.matches ?? []).map((m) => `  ${stripControlLine(m)}`);
    return matches.length > 0 ? [head, ...matches].join("\n") : `${head}  (no matches)`;
  }
  const commandGroupList = commandGroups(o.query);
  const groups = commandGroupList.flatMap((group, index) => [
    index === 0 ? `commands · ${group.label}` : group.label,
    ...group.commands.map((command) => `  ${commandRow(command)}${command.danger ? " ⚠" : ""}`),
  ]);
  return groups.length > 0 ? groups.join("\n") : "commands";
}

/** A completed-immediately async iterable (no mid-run input in non-interactive mode). A plain
 *  iterator (not a generator) so it needs no yield and the runner's consumer ends at once. */
const EMPTY_INPUTS: AsyncIterable<UserInput> = {
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined }),
  }),
};

/**
 * Headless `UIPort`: keeps the latest rendered frame as plain text. Used by `keel run -p`,
 * `CI=true`/non-TTY runs, and golden tests — never emits ANSI or touches a terminal.
 *
 * Epic 1.20 (C-stream): an optional `sink` makes the transcript STREAM incrementally — each settled
 * conversation item is written as it finalizes, so a hard kill (the harbor wall-clock SIGKILL) leaves
 * a partial transcript instead of an empty one. Without a sink, behavior is unchanged (buffer + `frame()`).
 */
export class HeadlessUI implements UIPort {
  #frame = "";
  readonly #sink: ((chunk: string) => void) | undefined;
  readonly #verbose: boolean; // false → hide the leading system preamble (a `keel run -p` without --verbose)
  readonly #interactive: boolean; // false (one-shot `run -p`/CI) → omit interactive chrome from the trailer
  #streamedCount = 0; // leading items already written to the sink, in order
  #streamedPrevKind = ""; // kind of the last EMITTED item — for separator continuity
  #streamedEvidenceByBlock = new Map<string, Map<string, string>>();
  #streamedMutationReviewsByBlock = new Set<string>();
  #streamedRunControlReceipts = new Set<string>();
  #lastView: ViewModel | undefined;
  #finalized = false; // finalize() flushes the trailer exactly once
  #streamedNonEmpty = false; // any non-empty item chunk streamed (so the trailer needs a blank separator)

  constructor(sink?: (chunk: string) => void, verbose = true, interactive = true) {
    this.#sink = sink;
    this.#verbose = verbose;
    this.#interactive = interactive;
  }

  render(view: ViewModel): void {
    this.#frame = renderFrame(view, this.#verbose, this.#interactive);
    this.#lastView = view;
    if (this.#sink !== undefined) this.#stream(view, false);
  }

  /** Emit settled items in order. An item is *settled* once it can no longer change: a tool whose
   *  status has left `running`, or a message that is not the still-streaming last item. `flushAll`
   *  forces the remainder out at end-of-run. */
  #stream(view: ViewModel, flushAll: boolean): void {
    const sink = this.#sink;
    if (sink === undefined) return;
    const skip = this.#verbose ? 0 : leadingSystemEnd(view.items);
    const semanticMutationIndexes = new Set<number>();
    for (const block of conversationPlan(view, {
      verbose: this.#verbose,
      compactHistory: false,
    }).blocks) {
      if (block.items.some((item) => item.kind === "tool" && hasSemanticZoomMutationReview(item))) {
        for (let index = block.startIndex; index <= block.endIndex; index += 1)
          semanticMutationIndexes.add(index);
      }
    }
    const visibleItems = new Map(
      visibleConversationItemsWithIndexes(view, {
        verbose: this.#verbose,
        retainSuccessfulTools: !this.#interactive && this.#verbose,
        retainConsequentialTools: true,
      }).map((entry) => [
        entry.index,
        {
          item: entry.item,
          synthetic: entry.synthetic,
          assistantRole: entry.assistantRole,
        },
      ]),
    );
    while (this.#streamedCount < view.items.length) {
      const i = this.#streamedCount;
      // Hidden leading preamble (non-verbose -p): advance past it WITHOUT emitting and WITHOUT touching
      // the separator state, so the first visible item gets no leading separator (matches renderFrame).
      if (i < skip) {
        this.#streamedCount += 1;
        continue;
      }
      const it = view.items[i] as ViewItem;
      // An abnormal stop is provisional until the runner emits `run-finished`: queued steering or
      // goal validation may immediately continue the same logical turn. Keep the notice out of the
      // append-only sink until finality is known, but allow an awaiting-input/finalize fail-safe so a
      // missing settlement event cannot make an actual terminal failure disappear.
      if (
        !flushAll &&
        isTerminalRunNotice(it) &&
        i === view.items.length - 1 &&
        view.turnSummary === undefined &&
        view.awaitingInput !== true
      ) {
        break;
      }
      const visible = visibleItems.get(i);
      if (
        !flushAll &&
        it.kind === "tool" &&
        it.status !== "running" &&
        toolOutcome(it) !== "done" &&
        (view.density === "verbose" || view.density === "debug") &&
        (view.streaming || view.currentTurn !== undefined)
      ) {
        break;
      }
      // Normal answer-first output cannot retract an emitted routine success after the final answer
      // makes it suppressible. Hold these low-signal tools until the turn either answers (skip) or
      // finalizes without an answer (flush), preserving stream/frame parity.
      if (
        (this.#interactive || !this.#verbose) &&
        !flushAll &&
        isRoutineSuccessfulTool(it) &&
        visible !== undefined &&
        (view.streaming || view.currentTurn !== undefined)
      ) {
        break;
      }
      if (visible === undefined) {
        this.#streamedCount += 1;
        this.#streamEvidenceForCompletedBlocks(view, flushAll);
        continue;
      }
      const visibleItem = visible.item;
      const isLast = i === view.items.length - 1;
      const presentationPending =
        it.kind === "tool" && it.mutationPresentation?.status === "pending";
      const settled = presentationPending
        ? false
        : flushAll
          ? true
          : it.kind === "tool"
            ? it.status !== "running"
            : !(isLast && view.streaming);
      if (!settled) break;
      if (!flushAll && isLast && visible.synthetic) break;
      const rendered = renderItem(visibleItem, view.diffMode, view.density, {
        assistantRole: visible.assistantRole,
        includeSemanticMutationReview: false,
        includeControllerEvidence: semanticMutationIndexes.has(i),
      });
      if (rendered.length === 0) {
        this.#streamedCount += 1;
        continue;
      }
      const chunk = sepFor(this.#streamedPrevKind, visibleItem.kind) + rendered;
      if (chunk.length > 0) this.#streamedNonEmpty = true;
      sink(chunk);
      this.#streamedPrevKind = visibleItem.kind;
      this.#streamedCount += 1;
      this.#streamEvidenceForCompletedBlocks(view, flushAll);
    }
  }

  #streamEvidenceForCompletedBlocks(view: ViewModel, flushAll = false): void {
    const sink = this.#sink;
    if (sink === undefined) return;
    const options = { verbose: this.#verbose, compactHistory: false } as const;
    const commitPlan = transcriptCommitPlan(view, options);
    const committedBlockIds = new Set(commitPlan.staticBlocks.map((block) => block.id));
    const blocks =
      flushAll || view.streaming ? conversationPlan(view, options).blocks : commitPlan.staticBlocks;
    for (const block of blocks) {
      if (block.endIndex >= this.#streamedCount) continue;
      const semanticMutation = block.items.some(
        (item) => item.kind === "tool" && hasSemanticZoomMutationReview(item),
      );
      // The stable result has already streamed. Hold the mode-dependent receipt/detail suffix until
      // settlement so normal↔verbose and compact↔full remain monotonic and byte-identical to frame().
      if (semanticMutation && !flushAll && !committedBlockIds.has(block.id)) continue;
      if (block.evidence !== undefined) {
        const evidence = evidenceForMode(
          block.evidence,
          this.#interactive,
          !this.#interactive && this.#verbose,
          block.items,
          view.density,
          semanticMutation,
        );
        if (evidence !== undefined) {
          const streamedLines =
            this.#streamedEvidenceByBlock.get(block.id) ?? new Map<string, string>();
          const unseenLines = evidence.lines.filter((line) => {
            const identity = JSON.stringify({
              ...line,
              text: line.text.replace(/ \(\d+ times\)$/u, ""),
            });
            const renderedLine = JSON.stringify(line);
            const previous = streamedLines.get(identity);
            if (previous !== undefined && (!flushAll || previous === renderedLine)) return false;
            streamedLines.set(identity, renderedLine);
            return true;
          });
          if (unseenLines.length > 0) {
            const rendered = renderTurnEvidence({ ...evidence, lines: unseenLines });
            if (rendered.length > 0) {
              const chunk = (this.#streamedPrevKind === "" ? "" : "\n\n") + rendered;
              this.#streamedNonEmpty = true;
              sink(chunk);
              this.#streamedPrevKind = "evidence";
              this.#streamedEvidenceByBlock.set(block.id, streamedLines);
            }
          }
        }
      }
      if (semanticMutation && !this.#streamedMutationReviewsByBlock.has(block.id)) {
        const rendered = renderSemanticMutationReviews(block.items, view);
        if (rendered.length > 0) {
          const chunk = (this.#streamedPrevKind === "" ? "" : "\n\n") + rendered;
          this.#streamedNonEmpty = true;
          sink(chunk);
          this.#streamedPrevKind = "mutation-review";
        }
        this.#streamedMutationReviewsByBlock.add(block.id);
      }
      if (
        !this.#interactive &&
        block.kind === "turn" &&
        block.runControlReceipt !== undefined &&
        !this.#streamedRunControlReceipts.has(block.id)
      ) {
        const rendered = renderRunControlReceipt(block.runControlReceipt);
        const chunk = (this.#streamedPrevKind === "" ? "" : "\n\n") + rendered;
        this.#streamedNonEmpty = true;
        sink(chunk);
        this.#streamedPrevKind = "run-control-receipt";
        this.#streamedRunControlReceipts.add(block.id);
      }
    }
  }

  /** End-of-run flush: emit withheld items, stable failure-count updates, and the trailer. Stable and
   *  non-streaming paths remain byte-identical to `frame()`; active failure evidence may already be in
   *  the append-only sink so a hard kill cannot erase it. No-op without a sink. */
  finalize(): void {
    const sink = this.#sink;
    if (this.#finalized || sink === undefined || this.#lastView === undefined) return;
    this.#finalized = true;
    this.#stream(this.#lastView, true);
    this.#streamEvidenceForCompletedBlocks(this.#lastView, true);
    const trailer = renderTrailerBlocks(
      this.#lastView,
      this.#interactive,
      conversationPlan(this.#lastView, { verbose: this.#verbose, compactHistory: false }),
    ).join("\n\n");
    // A blank separator before the trailer only when the items block is non-empty — matching
    // renderFrame, which omits an all-empty items block (e.g. a single empty-content message).
    sink((this.#streamedNonEmpty ? "\n\n" : "") + trailer + "\n");
  }

  /** Non-interactive: `keel run -p` / CI take no mid-run input, so the stream is empty and
   *  completes immediately (the runner's input consumer ends at once — no steering, no hang). */
  inputs(): AsyncIterable<UserInput> {
    return EMPTY_INPUTS;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** The latest rendered frame (the deterministic output goldens assert against). */
  frame(): string {
    return this.#frame;
  }
}
