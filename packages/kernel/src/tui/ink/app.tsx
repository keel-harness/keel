/* @jsxRuntime automatic @jsxImportSource react */
// tsx (`pnpm keel`) ignores tsconfig `jsx:"react-jsx"` → force React's automatic JSX runtime so Ink
// renders without a React import (else "React is not defined"). No-op under tsc/vitest. Keep on every Ink .tsx.
import { Box, Static, Text, useStdout } from "ink";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type {
  Overlay,
  UiActiveApproval,
  UiAttentionMark,
  UiCurrentTurn,
  UiQueuedInput,
  UiRecentSession,
  UiStatus,
  UiToolActivity,
  UiUsageDigest,
  ViewItem,
  ViewModel,
} from "@keel/shared";
import {
  assistantLivePreview,
  assistantLivePreviewNotice,
  assistantInlineText,
  assistantProsePlan,
  type AssistantInline,
  type AssistantProseBlock,
  type AssistantProsePlan,
} from "../assistant-prose.js";
import { commandGroups, commandRow, paletteCommands } from "../commands.js";
import { approvalNoticePlan, approvalNoticeRows } from "../approval-notice.js";
import { compactStat, effectiveDiffMode, moreHint, planDiffLayout } from "../diff.js";
import type { DiffRender } from "../diff.js";
import {
  activeTurnRows,
  isRoutineSuccessfulTool,
  visibleTurnItemsWithIndexes,
  type ConversationBlock,
  type ConversationTurnBlock,
  type AssistantPresentationRole,
  type TurnEvidencePresentation,
  type TurnSummaryPresentation,
} from "../conversation-block.js";
import { hintFooter } from "../hints.js";
import {
  diffStylePlan,
  limitedTerminalMode,
  plainTerminalMode,
  terminalColorCapability,
  THEME,
  TUI_SPACING,
  TOOL_COLOR,
} from "../theme.js";
import { toolCardPlan } from "../tool-card.js";
import { renderPendingReviewCount } from "../../warden/approval.js";
import {
  HELP_LINES,
  WELCOME,
  queuedInputLines,
  urgentSteeringLine,
  stripControl,
  stripControlLine,
  statusRows,
  usageDigestLine,
  welcomeRecentLines,
  welcomeResumeLine,
} from "../view-model.js";
import { responseSurfaceColumns, terminalDisplayWidth } from "../row-budget.js";
import {
  truncateDisplayCells,
  wrapDisplayLine,
  wrapLosslessDisplayLine,
} from "../display-cells.js";
import { overlayPresentation } from "../overlay-presentation.js";
import {
  commitIncrementalTranscriptCandidate,
  createIncrementalTranscriptLedger,
  incrementalAssistantRangePlans,
  incrementalLiveLineLimit,
  planIncrementalTranscript,
  type AssistantProjectionCache,
  type AssistantProjectionFor,
  type IncrementalStaticUnit,
  type IncrementalTurnState,
  type InkStaticEntry,
} from "./incremental-transcript.js";

/** The full-mode per-line diff (a dumb map over the gated tool-card plan): the capped lines + an
 *  honest tail summary when the diff was too large to show whole (never silently truncated). */
function DiffView({ plan }: { plan: DiffRender }): React.JSX.Element {
  const { stdout } = useStdout();
  const terminalColumns = typeof stdout.columns === "number" ? stdout.columns : 80;
  const margin = TUI_SPACING.nested;
  const layout = planDiffLayout(plan, Math.max(20, terminalColumns - margin));
  const colorCapability = terminalColorCapability();
  return (
    <Box flexDirection="column" marginLeft={margin}>
      <Text>
        <Text bold>{layout.header.fileName}</Text>
        {layout.header.parentPath !== undefined ? (
          <Text dimColor> {` ${layout.header.parentPath}`}</Text>
        ) : null}
      </Text>
      {layout.header.hiddenCells > 0 ? (
        <Text dimColor>… {layout.header.hiddenCells} path cells hidden</Text>
      ) : null}
      {layout.rows.map((row, i) => {
        const lineStyle = diffStylePlan(row.kind, colorCapability, false);
        const padding = " ".repeat(Math.max(0, layout.columns - row.cells));
        return (
          <Box
            key={i}
            width={layout.columns}
            {...(row.hunkBoundaryBefore === true ? { marginTop: 1 } : {})}
          >
            <Text {...lineStyle}>
              <Text {...lineStyle} dimColor={colorCapability !== "mono"}>
                {row.observed} {row.installed} {row.marker}
              </Text>
              {row.spans.map((span, spanIndex) => (
                <Text
                  key={spanIndex}
                  {...diffStylePlan(row.kind, colorCapability, span.emphasized)}
                >
                  {span.text}
                </Text>
              ))}
              {padding}
            </Text>
          </Box>
        );
      })}
      {layout.hiddenLines > 0 ? (
        <Text dimColor>{moreHint(layout.hiddenLines, layout.hiddenHunks)}</Text>
      ) : null}
    </Box>
  );
}

/** A running tool's live line: stable text, the tool name, the edit diff (if any), and the latest
 *  streamed output line (dim). It deliberately avoids a timer/spinner so native scrollback is not
 *  repainted at animation cadence while a user is trying to read previous output. */
function RunningToolLine({
  item,
  diffMode,
  density,
}: {
  item: UiToolActivity;
  diffMode: ViewModel["diffMode"];
  density: ViewModel["density"];
}): React.JSX.Element {
  const card = toolCardPlan(item, effectiveDiffMode(density, diffMode));
  const compact = card.diff?.compact ? compactStat(card.diff.compact) : "";
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>tool </Text>
        <Text color={TOOL_COLOR.running}>{card.statusLabel}</Text> {card.title}
        {compact}
      </Text>
      {card.diff?.lines ? <DiffView plan={card.diff} /> : null}
      {/* the live line: indented under the tool name (marginLeft 2 = glyph+space gutter) and truncated
          to one row (wrap="truncate-end") so a long line never wraps to column 0 and breaks the calm
          subordinate read — it's a glance, the full output is the durable tool-result */}
      {card.liveOutput ? (
        <Box marginLeft={2}>
          <Text dimColor wrap="truncate-end">
            {card.liveOutput}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function NoteBlock({ content }: { content: string }): React.JSX.Element {
  const lines = stripControl(content).split("\n");
  return (
    <Box flexDirection="column">
      <Text dimColor>note</Text>
      <Box flexDirection="column" marginLeft={2}>
        {lines.map((line, i) => (
          <Text key={i} dimColor>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function ApprovalSettlementBlock({ content }: { content: string }): React.JSX.Element {
  const [heading = "approval settled", ...lines] = stripControl(content).split("\n");
  const { stdout } = useStdout();
  const columns = typeof stdout.columns === "number" ? stdout.columns : 80;
  const noColor = plainTerminalMode();
  const railOnly = columns < 50 || limitedTerminalMode();
  const lower = heading.toLowerCase();
  const tone = lower.includes("approved")
    ? THEME.state.success
    : lower.includes("unknown")
      ? THEME.state.warning
      : THEME.state.danger;
  const contentRows = (
    <>
      <Text bold {...(noColor ? {} : { color: tone })}>
        {heading}
      </Text>
      {lines.map((line, index) => (
        <Text
          key={index}
          bold={line.startsWith("authority ·")}
          dimColor={line.startsWith("detail ·")}
          {...(noColor || line.startsWith("detail ·") ? {} : { color: THEME.surface.decisionText })}
        >
          {line}
        </Text>
      ))}
    </>
  );
  if (railOnly) {
    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        {...(noColor ? {} : { borderLeftColor: tone })}
        paddingLeft={1}
      >
        {contentRows}
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      width={Math.max(20, Math.min(88, columns - 1))}
      borderStyle="round"
      {...(noColor ? {} : { borderColor: tone })}
      paddingX={1}
    >
      {contentRows}
    </Box>
  );
}

function ApprovalBlock({ approval }: { approval: UiActiveApproval }): React.JSX.Element {
  const plan = approvalNoticePlan(approval);
  const { stdout } = useStdout();
  const columns = typeof stdout.columns === "number" ? stdout.columns : 80;
  const terminalRows = typeof stdout.rows === "number" ? stdout.rows : 24;
  const compact = columns < 50;
  // Exact process evidence uses one stable semantic layout at every height. A row-count threshold
  // would let a one-row resize switch back to Ink's generic whitespace-normalizing wrapper while
  // the review remains actionable.
  const exactProcessRunConstrained = plan.losslessProcessRunSummary !== undefined;
  const constrained =
    compact || (terminalRows <= 24 && columns <= 80) || exactProcessRunConstrained;
  // A standard 24-row terminal has four live-shell rows beneath the decision surface. Keep the
  // full approval wording and bounded box, but remove decorative section gaps so a controller
  // explanation cannot bury the decision prompt or composer.
  const condensedSpacing = compact || terminalRows <= 24 || exactProcessRunConstrained;
  const noColor = plainTerminalMode();
  const railOnly = compact || limitedTerminalMode();
  const approvalSurfaceColumns = Math.max(20, Math.min(88, columns - 1));
  const approvalContentColumns = railOnly
    ? Math.max(1, columns - 2)
    : Math.max(1, approvalSurfaceColumns - 4);
  const tone =
    plan.state === "confirmed"
      ? THEME.state.success
      : plan.state === "denied" || plan.state === "failed"
        ? THEME.state.danger
        : THEME.state.warning;
  const rows = approvalNoticeRows(plan, {
    compact: constrained,
    preserveDecisionEvidence: constrained && !compact,
  });
  const content = (
    <>
      <Text bold {...(noColor ? {} : { color: tone })}>
        {plan.heading}
      </Text>
      {rows.map((row, index) => {
        const exactProcessRunEvidence =
          plan.losslessProcessRunSummary !== undefined &&
          row.kind === "evidence" &&
          row.text === `Effective target · ${plan.losslessProcessRunSummary}`
            ? wrapLosslessDisplayLine(plan.losslessProcessRunSummary, approvalContentColumns)
            : undefined;
        const keyMatch = row.kind === "action" ? /^(\[[^\]]+\])(.*)$/u.exec(row.text) : null;
        const marginTop =
          condensedSpacing ||
          !(row.kind === "label" || (row.kind === "action" && rows[index - 1]?.kind === "detail"))
            ? 0
            : 1;
        return (
          <Box key={index} marginTop={marginTop}>
            {exactProcessRunEvidence !== undefined ? (
              <Box flexDirection="column">
                <Text dimColor>Effective target</Text>
                {exactProcessRunEvidence.map((evidenceRow, evidenceIndex) => (
                  <Text key={evidenceIndex} wrap="truncate-end">
                    {evidenceRow.text}
                  </Text>
                ))}
              </Box>
            ) : keyMatch !== null ? (
              <Text wrap="wrap">
                <Text bold {...(noColor ? {} : { color: tone })}>
                  {keyMatch[1]}
                </Text>
                <Text {...(noColor || railOnly ? {} : { color: THEME.surface.decisionText })}>
                  {keyMatch[2]}
                </Text>
              </Text>
            ) : (
              <Text
                bold={(row.kind === "status" && plan.state === "pending") || row.kind === "message"}
                {...(row.kind === "message"
                  ? noColor || railOnly
                    ? {}
                    : { color: THEME.state.info }
                  : row.kind === "warning"
                    ? noColor
                      ? {}
                      : { color: THEME.state.warning }
                    : noColor || railOnly
                      ? {}
                      : { color: THEME.surface.decisionText })}
                dimColor={row.kind === "label"}
                wrap={row.kind === "detail" && constrained ? "truncate-middle" : "wrap"}
              >
                {row.text}
              </Text>
            )}
          </Box>
        );
      })}
    </>
  );

  if (railOnly) {
    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        {...(noColor ? {} : { borderLeftColor: tone })}
        paddingLeft={1}
      >
        {content}
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      width={approvalSurfaceColumns}
      borderStyle="round"
      {...(noColor ? {} : { borderColor: tone, backgroundColor: THEME.surface.decision })}
      paddingX={1}
    >
      {content}
    </Box>
  );
}

function AssistantResponseSurface({
  children,
  label = true,
  role = "answer",
}: {
  children: ReactNode;
  label?: boolean;
  role?: AssistantPresentationRole;
}): React.JSX.Element {
  const { stdout } = useStdout();
  const columns = typeof stdout.columns === "number" ? stdout.columns : 80;
  const railOnly = plainTerminalMode() || columns < 50;
  const labelStyle = assistantLabelStyle(role);
  const content = (
    <>
      {label ? (
        <Text bold={labelStyle.bold} dimColor={labelStyle.dimColor} color={labelStyle.color}>
          keel{role === "progress" ? " · working" : ""}
        </Text>
      ) : null}
      {children}
    </>
  );
  if (railOnly) {
    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeftColor={THEME.identity.assistant}
        paddingLeft={1}
      >
        {content}
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      width={responseSurfaceColumns(columns)}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderLeftColor={THEME.identity.assistant}
      paddingX={1}
      backgroundColor={THEME.surface.response}
    >
      {content}
    </Box>
  );
}

function AssistantProgress({ content }: { content: string }): React.JSX.Element {
  return (
    <AssistantResponseSurface role="progress">
      <AssistantProse content={content} tone="muted" />
    </AssistantResponseSurface>
  );
}

function Item({
  item,
  diffMode,
  density,
  livePreview = false,
  assistantRole = "answer",
}: {
  item: ViewItem;
  diffMode: ViewModel["diffMode"];
  density: ViewModel["density"];
  livePreview?: boolean;
  assistantRole?: AssistantPresentationRole | undefined;
}): React.JSX.Element | null {
  if (item.kind === "message") {
    if (item.role === "user") {
      return (
        <Text>
          <Text color={THEME.accent}>you </Text>
          <Text>{item.content}</Text>
        </Text>
      );
    }
    if (item.role === "assistant") {
      const preview = livePreview ? assistantLivePreview(item.content) : undefined;
      const content = preview?.content ?? item.content;
      if (assistantRole === "progress") return <AssistantProgress content={content} />;
      return (
        <AssistantResponseSurface>
          <Box flexDirection="column">
            {preview !== undefined && preview.hiddenLines > 0 ? (
              <Text dimColor>{assistantLivePreviewNotice(preview.hiddenLines)}</Text>
            ) : null}
            <AssistantProse content={content} tone="surface" />
          </Box>
        </AssistantResponseSurface>
      );
    }
    return item.content.startsWith("approval settled ·") ? (
      <ApprovalSettlementBlock content={item.content} />
    ) : (
      <NoteBlock content={item.content} />
    );
  }
  // A running tool gets the live (animated) line; settled tools render statically below (Epic 1.5c).
  if (item.status === "running")
    return <RunningToolLine item={item} diffMode={diffMode} density={density} />;
  const card = toolCardPlan(item, effectiveDiffMode(density, diffMode));
  const compact = card.diff?.compact ? compactStat(card.diff.compact) : "";
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>tool </Text>
        <Text color={THEME.state[card.tone]}>{card.glyph}</Text> {card.title} {card.statusLabel}
        {compact}
      </Text>
      {card.summary !== undefined && card.summaryLabel !== undefined ? (
        <Box marginLeft={2}>
          <Text dimColor>
            {card.summaryLabel} {card.summary}
          </Text>
        </Box>
      ) : null}
      {card.diff?.triage !== undefined ? (
        <Box marginLeft={2}>
          <Text dimColor>
            triage {card.diff.triage.kind} {card.diff.triage.collapsed ? "collapsed" : "expanded"} —{" "}
            {card.diff.triage.reason}
          </Text>
        </Box>
      ) : null}
      {card.recovery !== undefined ? (
        <Box marginLeft={2}>
          <Text color={THEME.state.warning}>{card.recovery.replace(/^next:\s*/, "next  ")}</Text>
        </Box>
      ) : null}
      {card.mutationReview?.lines.map((line) => (
        <Box key={line} marginLeft={2}>
          <Text dimColor>{line}</Text>
        </Box>
      ))}
      {card.diff?.lines ? <DiffView plan={card.diff} /> : null}
      {density === "debug" ? (
        <Box marginLeft={2}>
          <Text dimColor>id {item.id}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export type AssistantProseTone = "normal" | "muted" | "surface";

export function assistantLabelStyle(role: AssistantPresentationRole): {
  readonly bold: boolean;
  readonly dimColor: boolean;
  readonly color: string;
} {
  return {
    bold: role === "answer",
    dimColor: role === "progress",
    color: THEME.identity.assistant,
  };
}

export function assistantHeadingStyle(
  tone: AssistantProseTone,
  level: number,
): { readonly bold: boolean; readonly dimColor: boolean; readonly color?: string } {
  if (tone === "muted") return { bold: false, dimColor: true };
  const color =
    level === 1
      ? THEME.identity.assistant
      : tone === "surface"
        ? THEME.surface.responseText
        : level === 2
          ? THEME.accent
          : undefined;
  return {
    bold: level <= 2,
    ...(color === undefined ? {} : { color }),
    dimColor: level >= 3,
  };
}

function InlineProse({
  segments,
  tone = "normal",
}: {
  segments: readonly AssistantInline[];
  tone?: AssistantProseTone;
}): React.JSX.Element {
  return (
    <Text
      dimColor={tone === "muted"}
      {...(tone === "surface" ? { color: THEME.surface.responseText } : {})}
    >
      {segments.map((segment, i) => {
        if (segment.kind === "strong")
          return (
            <Text key={i} bold>
              {segment.text}
            </Text>
          );
        if (segment.kind === "code")
          return (
            <Text key={i} {...(tone === "muted" ? {} : { color: THEME.accent })}>
              {segment.text}
            </Text>
          );
        if (segment.kind === "emphasis")
          return (
            <Text key={i} italic>
              {segment.text}
            </Text>
          );
        return <Text key={i}>{segment.text}</Text>;
      })}
    </Text>
  );
}

function AssistantTable({
  block,
  tone,
}: {
  block: Extract<AssistantProseBlock, { kind: "table" }>;
  tone: AssistantProseTone;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginLeft={1}>
      {block.rows.map((row, rowIndex) => (
        <Text
          key={rowIndex}
          dimColor={tone === "muted"}
          {...(tone === "surface" ? { color: THEME.surface.responseText } : {})}
        >
          {row[0] !== undefined ? <InlineProse segments={row[0]} tone={tone} /> : null}
          {row.slice(1).map((cell, i) => {
            const header = assistantInlineText(block.headers[i + 1] ?? []).trim();
            return (
              <Text key={i}>
                {i === 0 ? "  " : " · "}
                {header.length > 0 ? <Text dimColor>{`${header} `}</Text> : null}
                <InlineProse segments={cell} tone={tone} />
              </Text>
            );
          })}
        </Text>
      ))}
    </Box>
  );
}

function AssistantProseBlockView({
  block,
  tone,
}: {
  block: AssistantProseBlock;
  tone: AssistantProseTone;
}): React.JSX.Element | null {
  if (block.kind === "rule") return null;
  if (block.kind === "heading") {
    const style = assistantHeadingStyle(tone, block.level);
    return (
      <Text
        bold={style.bold}
        dimColor={style.dimColor}
        {...(style.color === undefined ? {} : { color: style.color })}
      >
        {assistantInlineText(block.text)}
      </Text>
    );
  }
  if (block.kind === "paragraph") return <InlineProse segments={block.text} tone={tone} />;
  if (block.kind === "list") {
    return (
      <Box flexDirection="column" marginLeft={1}>
        {block.items.map((item, i) => (
          <Text
            key={i}
            dimColor={tone === "muted"}
            {...(tone === "surface" ? { color: THEME.surface.responseText } : {})}
          >
            <Text dimColor>{item.marker === "ordered" ? `${item.ordinal}. ` : "• "}</Text>
            <InlineProse segments={item.text} tone={tone} />
          </Text>
        ))}
      </Box>
    );
  }
  if (block.kind === "code") {
    return (
      <Box flexDirection="column" marginLeft={2}>
        {block.lines.map((line, i) => (
          <Text
            key={i}
            dimColor={tone !== "surface"}
            {...(tone === "surface" ? { color: THEME.surface.responseText } : {})}
          >
            {line}
          </Text>
        ))}
      </Box>
    );
  }
  return <AssistantTable block={block} tone={tone} />;
}

function AssistantProse({
  content,
  tone = "normal",
}: {
  content: string;
  tone?: AssistantProseTone;
}): React.JSX.Element {
  return <AssistantProsePlanView plan={assistantProsePlan(content)} tone={tone} />;
}

function AssistantProsePlanView({
  plan,
  tone = "normal",
}: {
  plan: AssistantProsePlan;
  tone?: AssistantProseTone;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {plan.blocks.map((block, i) => {
        if (block.kind === "rule") return null;
        return (
          <Box
            key={i}
            marginTop={(plan.spacing?.[i] ?? (i === 0 ? "tight" : "section")) === "section" ? 1 : 0}
          >
            <AssistantProseBlockView block={block} tone={tone} />
          </Box>
        );
      })}
    </Box>
  );
}

/** The first-run brand banner (rendered only when `view.firstRun`): the wordmark in the bold brand
 *  accent, the tagline + ethos bright (default weight), the affordance hints dim. The visual hierarchy
 *  lives here (chrome is Ink-only); the WORDS live once in the shared `WELCOME`. The honest posture is
 *  NOT here — the always-rendered `StatusLine` carries it (§4.9.1), so the banner can't imply a
 *  guarantee. Coverage-exempt (ADR-0003); snapshot-tested via ink-testing-library. */
function WelcomeBanner({
  recentSessions = [],
  usageDigest,
  columns,
  rows,
}: {
  recentSessions?: readonly UiRecentSession[];
  usageDigest?: UiUsageDigest;
  columns: number;
  rows: number;
}): React.JSX.Element {
  const compact = columns <= 50 || rows <= 18;
  const recentRows = welcomeRecentLines(recentSessions, Math.max(1, columns - 1));
  const resumeLine = welcomeResumeLine(recentSessions);

  if (compact) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={THEME.brand}>
          {WELCOME.wordmark}
        </Text>
        <Text>{WELCOME.interactiveHeadline}</Text>
        <Text dimColor>/help shows commands · Tab completes</Text>
        <Text dimColor>Finished turns stay in terminal history.</Text>
        <Text dimColor>Protection details are shown below.</Text>
        {resumeLine !== undefined ? (
          <Text dimColor wrap="truncate-end">
            {resumeLine}
          </Text>
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row">
        <Box flexDirection="column" width={10}>
          {WELCOME.mark.map((line) => (
            <Text key={line} bold color={THEME.brand}>
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold color={THEME.brand}>
            {WELCOME.wordmark}
          </Text>
          <Text>{WELCOME.tagline}</Text>
          <Text>{WELCOME.interactiveHeadline}</Text>
          <Text dimColor>{WELCOME.ethos}</Text>
        </Box>
      </Box>
      {usageDigest !== undefined ? <Text dimColor>{usageDigestLine(usageDigest)}</Text> : null}
      <Text dimColor>{`${WELCOME.examplesLabel}: ${WELCOME.starts.join(" · ")}`}</Text>
      {resumeLine !== undefined ? <Text dimColor>{resumeLine}</Text> : null}
      {WELCOME.keyLines.map((line) => (
        <Text key={line} dimColor>
          {line}
        </Text>
      ))}
      <Box flexDirection="column">
        <Text color={THEME.accent}>{WELCOME.recentTitle}</Text>
        {recentRows.map((line) => (
          <Text key={line} dimColor>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function FinalCard({ card }: { card: TurnSummaryPresentation }): React.JSX.Element {
  const { stdout } = useStdout();
  const columns = typeof stdout.columns === "number" ? stdout.columns : 80;
  const rows = typeof stdout.rows === "number" ? stdout.rows : 24;
  const compact = columns <= 50 || rows <= 18;
  const compactFileEvidence = compact && (card.fileEvidenceCount ?? 0) > 0;
  const compactQualifiedFileEvidence =
    compactFileEvidence &&
    (card.fileEvidenceCount ?? 0) <= 2 &&
    (card.fileEvidenceHidden ?? 0) === 0 &&
    (card.fileEvidenceUnavailableCount ?? 0) === 0 &&
    (card.fileEvidence?.length ?? 0) === card.fileEvidenceCount;
  const compactAttention = compact ? card.attention.slice(0, 1) : card.attention;
  const compactVerification = compact ? card.verification?.[0] : undefined;
  const hiddenAttention = Math.max(
    0,
    (card.attentionCount ?? card.attention.length) - compactAttention.length,
  );
  const compactAttentionText = (label: string, value: string): string => {
    const clean = stripControlLine(value);
    const budget = Math.max(1, columns - terminalDisplayWidth(label) - 1);
    return truncateDisplayCells(clean, budget);
  };
  const tone =
    card.title === "done"
      ? THEME.state.success
      : card.title === "blocked" || card.title === "failed"
        ? THEME.state.danger
        : THEME.state.warning;
  return (
    <Box flexDirection="column" marginTop={compact ? 0 : 1}>
      <Text color={tone}>
        {stripControlLine(card.title)}
        {compactVerification === undefined ? "" : ` · ${stripControlLine(compactVerification)}`}
      </Text>
      {card.changed.map((s, i) => (
        <Text key={`changed-${i}`}>
          <Text dimColor>changed </Text>
          {stripControlLine(s)}
        </Text>
      ))}
      {card.checked.map((s, i) => (
        <Text key={`checked-${i}`}>
          <Text dimColor>checked </Text>
          {stripControlLine(s)}
        </Text>
      ))}
      {compactQualifiedFileEvidence ? (
        (card.fileEvidence ?? []).map((entry, i) => (
          <Text key={`file-evidence-${i}`}>
            <Text dimColor>file evidence </Text>
            {stripControlLine(entry.text)}
          </Text>
        ))
      ) : compactFileEvidence ? (
        <>
          <Text>
            <Text dimColor>file evidence </Text>
            {`${String(card.fileEvidenceCount)} total${(card.fileEvidenceHidden ?? 0) > 0 ? ` · ${String(card.fileEvidenceHidden)} more hidden` : ""}`}
          </Text>
          {(card.fileEvidenceUnavailableCount ?? 0) > 0 ? (
            <Text color={THEME.state.warning}>
              <Text dimColor>unavailable </Text>
              {`${String(card.fileEvidenceUnavailableCount)} ${(card.fileEvidenceUnavailableCount ?? 0) === 1 ? "observation" : "observations"}`}
            </Text>
          ) : null}
        </>
      ) : (
        (card.fileEvidence ?? []).map((entry, i) => (
          <Text key={`file-evidence-${i}`}>
            <Text dimColor>
              {entry.status === "unavailable" ? "file evidence unavailable " : "file evidence "}
            </Text>
            {stripControlLine(entry.text)}
          </Text>
        ))
      )}
      {(compact ? (card.verification ?? []).slice(1) : (card.verification ?? [])).map((s, i) => (
        <Text key={`verification-${i}`} color={THEME.state.warning}>
          {stripControlLine(s)}
        </Text>
      ))}
      {compact && (card.ranCount ?? 0) > 0 ? (
        <Text>
          <Text dimColor>ran </Text>
          {`${String(card.ranCount)} commands${(card.ranHidden ?? 0) > 0 ? ` · ${String(card.ranHidden)} more commands hidden` : ""}`}
        </Text>
      ) : (
        (card.ran ?? []).map((s, i) => (
          <Text key={`ran-${i}`}>
            <Text dimColor>ran </Text>
            {stripControlLine(s)}
          </Text>
        ))
      )}
      {(card.automatic ?? []).map((s, i) => (
        <Text key={`automatic-${i}`}>
          <Text dimColor>automatic </Text>
          {stripControlLine(s)}
        </Text>
      ))}
      {(card.receipt ?? []).map((s, i) => {
        const line = stripControlLine(s);
        const separator = line.indexOf(" · ");
        const label = separator >= 0 ? line.slice(0, separator) : line;
        const detail = separator >= 0 ? line.slice(separator + 3) : "";
        return (
          <Text key={`receipt-${i}`}>
            <Text dimColor>{label}</Text>
            {detail.length > 0 ? ` · ${detail}` : ""}
          </Text>
        );
      })}
      {(card.recovery ?? []).map((s, i) => (
        <Text key={`recovery-${i}`} color={THEME.state.warning}>
          <Text dimColor>recovery </Text>
          {stripControlLine(
            compact ? "automatic undo unavailable · recover from version control/backup" : s,
          )}
        </Text>
      ))}
      {compactAttention.flatMap((detail, i) => [
        <Text key={`attention-${i}-what`} color={THEME.state.warning}>
          <Text dimColor>what </Text>
          {compact ? compactAttentionText("what", detail.what) : stripControlLine(detail.what)}
        </Text>,
        <Text key={`attention-${i}-why`}>
          <Text dimColor>why </Text>
          {compact ? compactAttentionText("why", detail.why) : stripControlLine(detail.why)}
        </Text>,
        <Text key={`attention-${i}-next`} color={THEME.state.warning}>
          <Text dimColor>next </Text>
          {compact ? compactAttentionText("next", detail.next) : stripControlLine(detail.next)}
        </Text>,
      ])}
      {hiddenAttention > 0 ? (
        <Text color={THEME.state.warning}>
          <Text dimColor>more </Text>
          {`${String(hiddenAttention)} more ${hiddenAttention === 1 ? "failed item" : "failed items"} hidden`}
        </Text>
      ) : null}
      {card.answer !== undefined ? (
        <Text>
          <Text dimColor>answer </Text>
          {stripControlLine(card.answer)}
        </Text>
      ) : null}
    </Box>
  );
}

function compactEvidenceLines(
  lines: readonly TurnEvidencePresentation["lines"][number][],
): readonly TurnEvidencePresentation["lines"][number][] {
  const fileLines = lines.filter(
    (line) =>
      line.kind === "file-evidence" ||
      line.kind === "file-evidence-unavailable" ||
      line.omitted?.group === "file",
  );
  const fileHidden = fileLines.reduce(
    (total, line) => total + (line.omitted?.group === "file" ? line.omitted.count : 0),
    0,
  );
  const fileUnavailable = fileLines.reduce(
    (total, line) =>
      total +
      (line.kind === "file-evidence-unavailable" ? 1 : 0) +
      (line.omitted?.group === "file" ? (line.omitted.unavailableCount ?? 0) : 0),
    0,
  );
  const fileVisible = fileLines.filter((line) => line.omitted?.group !== "file").length;
  const fileTotal = fileVisible + fileHidden;
  const preserveQualifiedFileEvidence =
    fileTotal > 0 && fileTotal <= 2 && fileHidden === 0 && fileUnavailable === 0;
  const fileSummary =
    fileTotal > 0
      ? {
          kind: "file-evidence" as const,
          text: `${String(fileTotal)} total${fileHidden > 0 ? ` · ${String(fileHidden)} more hidden` : ""}`,
        }
      : undefined;
  const unavailableSummary =
    fileUnavailable > 0
      ? {
          kind: "file-evidence-unavailable" as const,
          text: `${String(fileUnavailable)} ${fileUnavailable === 1 ? "observation" : "observations"}`,
        }
      : undefined;

  const failureKinds = new Set<TurnEvidencePresentation["lines"][number]["kind"]>([
    "limited",
    "partial",
    "review",
    "blocked",
    "skipped",
    "failed",
    "stopped",
  ]);
  const failureLines = lines.filter(
    (line) => failureKinds.has(line.kind) || line.omitted?.group === "failed",
  );
  const failureHiddenFromCap = failureLines.reduce(
    (total, line) => total + (line.omitted?.group === "failed" ? line.omitted.count : 0),
    0,
  );
  const visibleFailures = failureLines.filter((line) => line.omitted?.group !== "failed");
  const firstFailure = visibleFailures[0];
  const failureTotal = visibleFailures.length + failureHiddenFromCap;
  const hiddenFailures = Math.max(0, failureTotal - (firstFailure === undefined ? 0 : 1));

  const output: TurnEvidencePresentation["lines"][number][] = [];
  let insertedFile = false;
  let insertedFailure = false;
  for (const line of lines) {
    const file =
      line.kind === "file-evidence" ||
      line.kind === "file-evidence-unavailable" ||
      line.omitted?.group === "file";
    if (file) {
      if (preserveQualifiedFileEvidence) {
        output.push(line);
      } else if (!insertedFile && fileSummary !== undefined) {
        output.push(fileSummary);
        if (unavailableSummary !== undefined) output.push(unavailableSummary);
      }
      insertedFile = true;
      continue;
    }
    const failure = failureKinds.has(line.kind) || line.omitted?.group === "failed";
    if (failure) {
      if (!insertedFailure) {
        if (firstFailure !== undefined) output.push(firstFailure);
        if (hiddenFailures > 0) {
          output.push({
            kind: "more",
            text: `… ${String(hiddenFailures)} more ${hiddenFailures === 1 ? "failed item" : "failed items"}`,
            omitted: { group: "failed", count: hiddenFailures },
          });
        }
      }
      insertedFailure = true;
      continue;
    }
    output.push(line);
  }
  return output;
}

function compactQualifiedMutationEvidence(value: string): string {
  return value.replace(
    " · observed file before → verified installed after · comparison complete · transition not atomic · concurrent mutation not excluded",
    " · observed:file → verified:installed · compare:complete · non-atomic · concurrent edit possible",
  );
}

function EvidenceCard({ card }: { card: TurnEvidencePresentation }): React.JSX.Element {
  const { stdout } = useStdout();
  const columns = typeof stdout.columns === "number" ? stdout.columns : 80;
  const rows = typeof stdout.rows === "number" ? stdout.rows : 24;
  const compact = columns <= 50 || rows <= 18;
  const lines = compact ? compactEvidenceLines(card.lines) : card.lines;
  const compactText = (prefix: string, value: string): string => {
    const clean = stripControlLine(value);
    const budget = Math.max(1, columns - TUI_SPACING.nested - terminalDisplayWidth(prefix));
    return truncateDisplayCells(clean, budget);
  };
  return (
    <Box
      flexDirection="column"
      marginTop={compact ? 0 : TUI_SPACING.sectionRows}
      marginLeft={compact ? 0 : TUI_SPACING.nested}
    >
      {!compact ? <Text dimColor>{stripControlLine(card.title)}</Text> : null}
      {lines.flatMap((line, i) => {
        const kindLabel = line.kind.replaceAll("-", " ");
        const compactFile =
          compact && (line.kind === "file-evidence" || line.kind === "file-evidence-unavailable");
        const fullCompactFileEvidence =
          compact && line.kind === "file-evidence" && !/^\d+ total(?:\s|$)/u.test(line.text);
        const visibleLabel = fullCompactFileEvidence
          ? "file"
          : compactFile
            ? line.kind === "file-evidence-unavailable"
              ? "unavailable"
              : "file evidence"
            : kindLabel;
        const prefix = `${compactFile ? "" : "what "}${visibleLabel} `;
        const lineText = fullCompactFileEvidence
          ? compactQualifiedMutationEvidence(line.text)
          : line.text;
        return [
          <Text key={`${i}-line`}>
            {!compactFile ? <Text dimColor>what </Text> : null}
            <Text
              {...(line.kind === "blocked" || line.kind === "failed"
                ? { color: THEME.state.danger }
                : line.kind === "limited" ||
                    line.kind === "partial" ||
                    line.kind === "review" ||
                    line.kind === "file-evidence-unavailable" ||
                    line.kind === "skipped" ||
                    line.kind === "stopped"
                  ? { color: THEME.state.warning }
                  : {})}
            >
              {visibleLabel}{" "}
            </Text>
            {compact && !fullCompactFileEvidence
              ? compactText(prefix, lineText)
              : stripControlLine(lineText)}
          </Text>,
          ...(line.why !== undefined
            ? [
                <Text key={`${i}-why`}>
                  <Text dimColor>why </Text>
                  {compact ? compactText("why ", line.why) : stripControlLine(line.why)}
                </Text>,
              ]
            : []),
          ...(line.next !== undefined
            ? [
                <Text key={`${i}-next`} color={THEME.state.warning}>
                  <Text dimColor>next </Text>
                  {compact ? compactText("next ", line.next) : stripControlLine(line.next)}
                </Text>,
              ]
            : []),
        ];
      })}
    </Box>
  );
}

function railColor(mark: UiAttentionMark): string {
  if (mark.tone === "error") return THEME.state.danger;
  if (mark.tone === "queue") return THEME.state.warning;
  if (mark.tone === "success") return THEME.state.success;
  if (mark.tone === "user") return THEME.accent;
  return THEME.info;
}

function AttentionRail({
  marks,
  columns,
}: {
  marks: readonly UiAttentionMark[];
  columns: number;
}): React.JSX.Element {
  const prefix = "rail ";
  const fullWidth =
    terminalDisplayWidth(prefix) +
    marks.reduce(
      (width, mark, index) =>
        width +
        terminalDisplayWidth(index > 0 ? " · " : "") +
        terminalDisplayWidth(mark.glyph) +
        terminalDisplayWidth(` ${mark.label}`),
      0,
    );
  if (fullWidth > columns) {
    let remaining = Math.max(0, columns - terminalDisplayWidth(prefix));
    let visibleStart = marks.length;
    for (let index = marks.length - 1; index >= 0; index -= 1) {
      const mark = marks[index];
      if (mark === undefined) continue;
      const width = terminalDisplayWidth(mark.glyph) + (visibleStart < marks.length ? 1 : 0);
      if (width > remaining && visibleStart < marks.length) break;
      remaining -= width;
      visibleStart = index;
    }
    const visible = marks.slice(Math.min(visibleStart, Math.max(0, marks.length - 1)));
    return (
      <Box marginTop={TUI_SPACING.sectionRows}>
        <Text dimColor>{prefix}</Text>
        {visible.map((mark, index) => (
          <Text key={`${index}-${mark.label}`} color={railColor(mark)}>
            {index > 0 ? " " : ""}
            {mark.glyph}
          </Text>
        ))}
      </Box>
    );
  }
  return (
    <Box marginTop={TUI_SPACING.sectionRows}>
      <Text dimColor>{prefix}</Text>
      {marks.map((m, i) => (
        <Text key={`${i}-${m.label}`}>
          {i > 0 ? <Text dimColor> · </Text> : null}
          <Text color={railColor(m)}>{m.glyph}</Text>
          <Text dimColor>{` ${m.label}`}</Text>
        </Text>
      ))}
    </Box>
  );
}

function CurrentTurn({
  turn,
  density,
  task,
}: {
  turn: UiCurrentTurn;
  density: ViewModel["density"];
  task?: string;
}): React.JSX.Element {
  const { stdout } = useStdout();
  const columns = typeof stdout.columns === "number" ? stdout.columns : 80;
  const rows = activeTurnRows(task ?? "", turn, density, responseSurfaceColumns(columns));
  return (
    <Box flexDirection="column" marginLeft={2}>
      {rows.map((row) => {
        const label = row.startsWith("task · ")
          ? "task"
          : row.startsWith("working · ")
            ? "working"
            : undefined;
        return (
          <Text key={row} dimColor={label === undefined}>
            {label !== undefined ? (
              <Text color={label === "task" ? THEME.accent : THEME.info}>{label}</Text>
            ) : null}
            {label === undefined ? row : row.slice(label.length)}
          </Text>
        );
      })}
    </Box>
  );
}

function UserPrompt({ item }: { item: ConversationTurnBlock["user"] }): React.JSX.Element {
  const { stdout } = useStdout();
  const columns = typeof stdout.columns === "number" ? stdout.columns : 80;
  const lines = stripControl(item.content)
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u2028\u2029]/gu, "\n")
    .split("\n");
  return (
    <Box
      flexDirection="column"
      width={responseSurfaceColumns(columns)}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderLeftColor={THEME.brand}
      paddingLeft={TUI_SPACING.inset}
      marginBottom={TUI_SPACING.sectionRows}
    >
      <Box flexDirection="row">
        <Text bold color={THEME.accent}>
          you
        </Text>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} marginLeft={TUI_SPACING.labelGap}>
          {lines.map((line, index) => (
            <Text key={`${index}-${line}`}>{line}</Text>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

function TurnBlock({
  block,
  view,
}: {
  block: ConversationTurnBlock;
  view: ViewModel;
}): React.JSX.Element {
  if (block.mode === "compact") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <UserPrompt item={block.user} />
        <Box marginLeft={2}>
          <Text dimColor>{block.receipt}</Text>
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <UserPrompt item={block.user} />
      {visibleTurnItemsWithIndexes(block.items, view.density, {
        suppressFailedTools: block.suppressFailedTools === true,
        suppressEvidenceItems: block.suppressEvidenceItems === true,
        suppressProblemTools: block.suppressProblemTools === true,
        suppressExploratoryFailures: block.suppressExploratoryFailures === true,
        retainDiffTools: view.diffMode === "full",
      }).map(({ item, index, assistantRole }, i) => (
        <Box key={i} marginTop={i === 0 || item.kind === "tool" ? 0 : 1}>
          <Item
            item={item}
            diffMode={view.diffMode}
            density={view.density}
            assistantRole={assistantRole}
            livePreview={
              view.streaming &&
              item.kind === "message" &&
              item.role === "assistant" &&
              block.startIndex + 1 + index === view.items.length - 1
            }
          />
        </Box>
      ))}
      {block.evidence !== undefined ? <EvidenceCard card={block.evidence} /> : null}
      {block.currentTurn !== undefined ? (
        <CurrentTurn turn={block.currentTurn} density={view.density} task={block.user.content} />
      ) : null}
      {block.summary !== undefined ? <FinalCard card={block.summary} /> : null}
    </Box>
  );
}

function ItemsBlock({
  block,
  view,
}: {
  block: Extract<ConversationBlock, { kind: "items" }>;
  view: ViewModel;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {visibleTurnItemsWithIndexes(block.items, view.density, {
        suppressProblemTools: block.suppressProblemTools === true,
        retainDiffTools: view.diffMode === "full",
      }).map(({ item, index, assistantRole }, j) => (
        <Box key={j} marginBottom={item.kind === "message" ? 1 : 0}>
          <Item
            item={item}
            diffMode={view.diffMode}
            density={view.density}
            assistantRole={assistantRole}
            livePreview={
              view.streaming &&
              item.kind === "message" &&
              item.role === "assistant" &&
              block.startIndex + index === view.items.length - 1
            }
          />
        </Box>
      ))}
      {block.evidence !== undefined ? <EvidenceCard card={block.evidence} /> : null}
    </Box>
  );
}

function ConversationBlockView({
  block,
  view,
}: {
  block: ConversationBlock;
  view: ViewModel;
}): React.JSX.Element {
  return block.kind === "turn" ? (
    <TurnBlock block={block} view={view} />
  ) : (
    <ItemsBlock block={block} view={view} />
  );
}

function IncrementalStaticUnitView({
  unit,
  view,
}: {
  unit: IncrementalStaticUnit;
  view: ViewModel;
}): React.JSX.Element {
  if (unit.kind === "user") return <UserPrompt item={unit.item} />;
  if (unit.kind === "item") {
    return <Item item={unit.item} diffMode={view.diffMode} density={view.density} />;
  }
  if (unit.kind === "assistant-plans") {
    return (
      <AssistantResponseSurface label={unit.label} role={unit.role}>
        {unit.plans.map((plan, planIndex) => (
          <AssistantProsePlanView
            key={planIndex}
            plan={plan}
            tone={unit.role === "progress" ? "muted" : "surface"}
          />
        ))}
      </AssistantResponseSurface>
    );
  }
  if (unit.kind === "evidence") return <EvidenceCard card={unit.card} />;
  return <FinalCard card={unit.card} />;
}

function IncrementalLiveTurn({
  block,
  state,
  view,
  currentWrapColumns,
  projectionFor,
}: {
  block: ConversationTurnBlock;
  state: IncrementalTurnState;
  view: ViewModel;
  currentWrapColumns: number;
  projectionFor: AssistantProjectionFor;
}): React.JSX.Element {
  const visible = visibleTurnItemsWithIndexes(block.items, view.density, {
    suppressFailedTools: block.suppressFailedTools === true,
    suppressEvidenceItems: block.suppressEvidenceItems === true,
    suppressProblemTools: block.suppressProblemTools === true,
    suppressExploratoryFailures: block.suppressExploratoryFailures === true,
    retainDiffTools: view.diffMode === "full",
  }).filter(({ item, index }) => {
    if (state.committedItems.has(index)) return false;
    return !(
      view.density !== "quiet" &&
      view.density !== "verbose" &&
      view.density !== "debug" &&
      isRoutineSuccessfulTool(item)
    );
  });
  return (
    <Box flexDirection="column" marginBottom={1}>
      {visible.map(({ item, index, assistantRole }) => {
        if (item.kind === "message" && item.role === "assistant") {
          const committed = state.committedAssistantLines.get(index) ?? 0;
          const projection = projectionFor(block.id, index, item, state.wrapColumns, committed);
          const end = projection.totalLines;
          // Between four-row promotions, retain the small pending prefix so the user never sees a
          // semantic gap. A resize-only render may temporarily show only the conservative reflowed
          // tail; it cannot promote those hidden rows because source content did not advance.
          const start =
            currentWrapColumns === state.wrapColumns
              ? committed
              : Math.max(
                  committed,
                  end - incrementalLiveLineLimit(state.wrapColumns, currentWrapColumns),
                );
          if (end <= start) return null;
          const role = assistantRole ?? "answer";
          const plans = incrementalAssistantRangePlans(projection, start, end);
          return (
            <AssistantResponseSurface
              key={index}
              label={!state.labeledAssistants.has(index)}
              role={role}
            >
              {plans.map((plan, planIndex) => (
                <AssistantProsePlanView
                  key={`${start}:${planIndex}`}
                  plan={plan}
                  tone={role === "progress" ? "muted" : "surface"}
                />
              ))}
            </AssistantResponseSurface>
          );
        }
        return (
          <Item
            key={index}
            item={item}
            diffMode={view.diffMode}
            density={view.density}
            assistantRole={assistantRole}
          />
        );
      })}
      {block.evidence !== undefined ? <EvidenceCard card={block.evidence} /> : null}
      {block.currentTurn !== undefined ? (
        <CurrentTurn turn={block.currentTurn} density={view.density} task={block.user.content} />
      ) : null}
    </Box>
  );
}

function QueuedInputs({
  inputs,
  columns,
  rows,
}: {
  inputs: readonly UiQueuedInput[];
  columns: number;
  rows: number;
}): React.JSX.Element {
  const lines = queuedInputLines(inputs, columns, rows <= 18 ? 1 : 2);
  return lines.length === 0 ? (
    <></>
  ) : (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} color={THEME.state.warning}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

function UrgentSteering({
  steering,
  columns,
}: {
  steering: ViewModel["urgentSteering"];
  columns: number;
}): React.JSX.Element {
  const line = urgentSteeringLine(steering, columns);
  return line === undefined ? <></> : <Text color={THEME.state.warning}>{line}</Text>;
}

/** The trust HUD — normal density maps compact rows; debug maps the full cockpit. Both are generated
 *  from structured status, so presentation density cannot invent enforcement. */
function StatusLine({
  status,
  density,
  diffMode,
  compact = false,
  hideMeta = false,
}: {
  status: UiStatus;
  density: ViewModel["density"];
  diffMode: ViewModel["diffMode"];
  compact?: boolean;
  hideMeta?: boolean;
}): React.JSX.Element {
  const { stdout } = useStdout();
  const columns = typeof stdout.columns === "number" ? stdout.columns : undefined;
  const rows = statusRows(status, {
    density,
    diffMode,
    ...(columns !== undefined ? { columns } : {}),
  });
  const visibleRows = hideMeta && rows.length > 1 ? rows.slice(1) : rows;
  return (
    <Box flexDirection="column" marginTop={compact ? 0 : 1}>
      {visibleRows.map((line, i) => (
        <Text key={i} dimColor={!line.startsWith("protection:")}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

/** The `/` command palette — discoverable, grouped by workflow, and filtered as you type. */
function PaletteOverlay({
  query,
  columns,
  maxRows,
  selected,
}: {
  query: string;
  columns: number;
  maxRows: number;
  selected: number;
}): React.JSX.Element {
  const groups = commandGroups(query);
  const ordered = paletteCommands(query);
  const selectedCommand = ordered[Math.min(Math.max(0, selected), Math.max(0, ordered.length - 1))];
  const innerColumns = Math.max(1, columns - 2);
  // The first group shares the title row. This retains workflow grouping while reserving one row
  // for the task-scoped `/answer` control at a representative 80x24 terminal.
  const groupedRows = groups.reduce(
    (total, group) =>
      total +
      1 +
      group.commands.reduce(
        (rows, command) =>
          rows +
          Math.max(
            1,
            Math.ceil(
              terminalDisplayWidth(`  ${commandRow(command)}${command.danger ? " ⚠" : ""}`) /
                innerColumns,
            ),
          ),
        0,
      ),
    0,
  );
  const compact = groupedRows > maxRows;
  if (compact) {
    const commands = ordered;
    const selectedIndex = Math.min(Math.max(0, selected), Math.max(0, commands.length - 1));
    const bodyRows = Math.max(1, maxRows - 1);
    const oneDisclosureCapacity = Math.max(1, bodyRows - 1);
    let start = 0;
    let end = commands.length;
    if (commands.length > bodyRows) {
      if (selectedIndex < oneDisclosureCapacity) {
        end = oneDisclosureCapacity;
      } else if (selectedIndex >= commands.length - oneDisclosureCapacity) {
        start = commands.length - oneDisclosureCapacity;
      } else {
        const bothDisclosureCapacity = Math.max(1, bodyRows - 2);
        start = Math.max(1, selectedIndex - bothDisclosureCapacity + 1);
        end = Math.min(commands.length - 1, start + bothDisclosureCapacity);
      }
    }
    const visible = commands.slice(start, end);
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>commands</Text>
        {start > 0 ? <Text dimColor>{`↑ ${start} earlier commands`}</Text> : null}
        {visible.map((command) => {
          const isSelected = command === selectedCommand;
          const detail =
            command.name === "/goal" || command.name === "/loop"
              ? command.availability
              : command.description;
          return (
            <Text key={command.name} wrap="truncate-end">
              <Text color={THEME.accent}>{isSelected ? "› " : "  "}</Text>
              <Text color={THEME.brand} inverse={isSelected}>
                {command.name}
              </Text>{" "}
              {detail}
            </Text>
          );
        })}
        {end < commands.length ? (
          <Text dimColor>{`… ${commands.length - end} more commands · type to filter`}</Text>
        ) : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      {groups.map((g, groupIndex) => (
        <Box key={g.id} flexDirection="column">
          <Text dimColor>{groupIndex === 0 ? `commands · ${g.label}` : g.label}</Text>
          {g.commands.map((c) => {
            const isSelected = c === selectedCommand;
            return (
              <Text key={c.name}>
                <Text color={THEME.accent}>{isSelected ? "› " : "  "}</Text>
                <Text color={THEME.brand} inverse={isSelected}>
                  {commandRow(c)}
                </Text>
                {c.danger ? <Text color={THEME.state.warning}> ⚠</Text> : null}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

const COMPACT_HELP_LINES = [
  "Type task; Enter sends. @ adds files.",
  '/goal TASK --check "CMD"',
  '/loop TASK --until "CMD"',
  "/policies /reviews · /diff /context",
  "Tab completes · ^G editor",
  "↑/↓ history · /exit quits",
  "Esc closes panels; working: Esc stops",
] as const;

function helpLines(columns: number, maxRows: number): readonly string[] {
  return columns <= 50 || maxRows <= 14 ? COMPACT_HELP_LINES : HELP_LINES;
}

/** The `?` help overlay — the durable key reference (mapped from the shared `HELP_LINES`). */
function HelpOverlay({
  columns,
  maxRows,
  offset,
}: {
  columns: number;
  maxRows: number;
  offset: number;
}): React.JSX.Element {
  const lines = helpLines(columns, maxRows);
  const capacity = Math.max(1, maxRows - 3);
  const start = Math.min(Math.max(0, offset), Math.max(0, lines.length - 1));
  const available = Math.max(1, capacity - (start > 0 ? 1 : 0));
  let visible = lines.slice(start, start + available);
  if (start + visible.length < lines.length && visible.length > 1) visible = visible.slice(0, -1);
  const omitted = lines.length - start - visible.length;
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Text dimColor>help</Text>
      {start > 0 ? <Text dimColor>{`↑ ${start} earlier lines`}</Text> : null}
      {visible.map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
      {omitted > 0 ? <Text dimColor>{`… ${omitted} more help lines`}</Text> : null}
    </Box>
  );
}

function panelViewport(
  content: string,
  columns: number,
  maxRows: number,
): {
  readonly title: string;
  readonly lines: readonly string[];
  readonly bodyRows: number;
  readonly rowCost: (line: string) => number;
} {
  const [title = "panel", ...logicalLines] = stripControl(content).split("\n");
  const innerColumns = Math.max(1, columns - 4);
  const contentRows = Math.max(2, maxRows - 2);
  // Navigation offsets address physical rows. Pre-wrap each logical line so one long paragraph can
  // never consume more than the viewport and disappear behind a permanent "more lines" disclosure.
  const lines = logicalLines.flatMap((line) =>
    wrapDisplayLine(stripControlLine(line), innerColumns).map((row) => row.text),
  );
  const titleRows = wrapDisplayLine(stripControlLine(title), innerColumns).length;
  const rowCost = (): number => 1;
  return {
    title,
    lines,
    bodyRows: Math.max(1, contentRows - titleRows),
    rowCost,
  };
}

function PanelOverlay({
  content,
  columns,
  maxRows,
  offset,
}: {
  content: string;
  columns: number;
  maxRows: number;
  offset: number;
}): React.JSX.Element {
  const { title, lines, bodyRows, rowCost } = panelViewport(content, columns, maxRows);
  const start = Math.min(Math.max(0, offset), Math.max(0, lines.length - 1));
  const visible: string[] = [];
  let used = start > 0 ? 1 : 0;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    const cost = rowCost(line);
    const reserveDisclosure = index < lines.length - 1 ? 1 : 0;
    if (used + cost + reserveDisclosure > bodyRows) break;
    visible.push(line);
    used += cost;
  }
  const omitted = lines.length - start - visible.length;
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Text dimColor>{stripControlLine(title)}</Text>
      {start > 0 ? <Text dimColor>{`↑ ${start} earlier lines`}</Text> : null}
      {visible.map((line, i) => (
        <Text key={i}>{stripControlLine(line)}</Text>
      ))}
      {omitted > 0 ? <Text dimColor>{`… ${omitted} more panel lines`}</Text> : null}
    </Box>
  );
}

/** The `Ctrl-R` reverse-search line (Epic 1.23 slice 3b): `(reverse-i-search)`query': match`. The
 *  query + match are user-derived (`match` is a raw history entry), so both are control-stripped here
 *  before rendering (ER-020) — the overlay bypasses the view-model reducer's strip. */
function ReverseSearchOverlay({
  overlay,
}: {
  overlay: { readonly query: string; readonly match?: string };
}): React.JSX.Element {
  const match = overlay.match !== undefined ? stripControlLine(overlay.match) : "";
  return (
    <Box width="100%">
      <Text wrap="truncate-middle">
        <Text dimColor>{`(reverse-i-search)\`${stripControlLine(overlay.query)}': `}</Text>
        <Text color={THEME.accent}>{match}</Text>
      </Text>
    </Box>
  );
}

/** The `@file` path-completion overlay (Epic 1.23 slice 5): the query + the trust-gated matches. Each
 *  match is a filename (untrusted data), so it is single-line control-stripped before rendering (ER-020). */
function AtCompleteOverlay({
  overlay,
  selected,
  maxRows,
}: {
  overlay: { readonly query: string; readonly matches?: readonly string[] };
  selected: number;
  maxRows: number;
}): React.JSX.Element {
  const matches = overlay.matches ?? [];
  const selectedIndex = Math.min(Math.max(0, selected), Math.max(0, matches.length - 1));
  const listRows = Math.max(1, maxRows - 3);
  const oneDisclosureCapacity = Math.max(1, listRows - 1);
  let start = 0;
  let end = matches.length;
  let combinedDisclosure = false;
  if (matches.length > listRows) {
    if (listRows === 1) {
      start = selectedIndex;
      end = selectedIndex + 1;
    } else if (listRows === 2 && selectedIndex > 0 && selectedIndex < matches.length - 1) {
      start = selectedIndex;
      end = selectedIndex + 1;
      combinedDisclosure = true;
    } else if (selectedIndex < oneDisclosureCapacity) {
      end = oneDisclosureCapacity;
    } else if (selectedIndex >= matches.length - oneDisclosureCapacity) {
      start = matches.length - oneDisclosureCapacity;
    } else {
      const bothDisclosureCapacity = Math.max(1, listRows - 2);
      start = Math.max(1, selectedIndex - bothDisclosureCapacity + 1);
      end = Math.min(matches.length - 1, start + bothDisclosureCapacity);
    }
  }
  const visible = matches.slice(start, end);
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Text dimColor wrap="truncate-end">{`@${stripControlLine(overlay.query)}`}</Text>
      {matches.length === 0 ? (
        <Text dimColor>(no matches)</Text>
      ) : (
        <>
          {!combinedDisclosure && start > 0 ? (
            <Text dimColor>{`↑ ${start} earlier matches`}</Text>
          ) : null}
          {visible.map((m, index) => {
            const absoluteIndex = start + index;
            const isSelected = absoluteIndex === selectedIndex;
            return (
              <Text key={absoluteIndex} wrap="truncate-end">
                <Text color={THEME.accent}>{isSelected ? "› " : "  "}</Text>
                <Text inverse={isSelected}>{stripControlLine(m)}</Text>
              </Text>
            );
          })}
          {combinedDisclosure ? (
            <Text dimColor>{`… ${matches.length - visible.length} other matches`}</Text>
          ) : end < matches.length ? (
            <Text dimColor>{`… ${matches.length - end} more matches`}</Text>
          ) : null}
        </>
      )}
    </Box>
  );
}

/** Highest meaningful line offset for the current physical overlay viewport. */
export function overlayScrollLimitForViewport(
  overlay: Overlay,
  columns: number,
  maxRows: number,
): number {
  if (overlay.kind === "help") {
    const lines = helpLines(columns, maxRows);
    const capacity = Math.max(1, maxRows - 3);
    return lines.length <= capacity ? 0 : Math.max(0, lines.length - 1);
  }
  if (overlay.kind === "panel") {
    const { lines, bodyRows, rowCost } = panelViewport(overlay.content, columns, maxRows);
    const allRows = lines.reduce((total, line) => total + rowCost(line), 0);
    return allRows <= bodyRows ? 0 : Math.max(0, lines.length - 1);
  }
  return 0;
}

function OverlayView({
  overlay,
  columns,
  rows,
}: {
  overlay: Overlay;
  columns: number;
  rows: number;
}): React.JSX.Element {
  const presentation = overlayPresentation(overlay);
  if (overlay.kind === "palette")
    return (
      <PaletteOverlay
        query={overlay.query}
        columns={columns}
        maxRows={rows}
        selected={presentation.selected ?? 0}
      />
    );
  if (overlay.kind === "panel")
    return (
      <PanelOverlay
        content={overlay.content}
        columns={columns}
        maxRows={rows}
        offset={presentation.offset ?? 0}
      />
    );
  if (overlay.kind === "reverse-search") return <ReverseSearchOverlay overlay={overlay} />;
  if (overlay.kind === "at-complete")
    return (
      <AtCompleteOverlay overlay={overlay} selected={presentation.selected ?? 0} maxRows={rows} />
    );
  return <HelpOverlay columns={columns} maxRows={rows} offset={presentation.offset ?? 0} />;
}

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    columns: typeof stdout.columns === "number" ? stdout.columns : 80,
    rows: typeof stdout.rows === "number" ? stdout.rows : 24,
  }));

  useEffect(() => {
    const update = (): void => {
      const next = {
        columns: typeof stdout.columns === "number" ? stdout.columns : 80,
        rows: typeof stdout.rows === "number" ? stdout.rows : 24,
      };
      setSize((current) =>
        current.columns === next.columns && current.rows === next.rows ? current : next,
      );
    };
    stdout.on("resize", update);
    update();
    return () => {
      stdout.off("resize", update);
    };
  }, [stdout]);

  return size;
}

interface AppProps {
  readonly view: ViewModel;
  readonly verbose?: boolean;
  /** Interactive owns contextual composer guidance; suppress its duplicate footer while an overlay is open. */
  readonly showHintFooter?: boolean;
}

/** Measure the owning terminal for standalone App consumers. */
export function App(props: AppProps): React.JSX.Element {
  const terminalSize = useTerminalSize();
  return <AppWithTerminalSize {...props} terminalSize={terminalSize} />;
}

/** Physical rows available to an overlay after the live cockpit reserves its own rows. */
export function overlayRowBudget(view: ViewModel, terminalSize: TerminalSize): number {
  const statusRowCount = statusRows(view.status, {
    density: view.density,
    diffMode: view.diffMode,
    columns: terminalSize.columns,
  }).length;
  return Math.max(4, terminalSize.rows - statusRowCount - 2);
}

/** Render conversation, immutable terminal history, overlays, trust HUD, and contextual hints. */
export function AppWithTerminalSize({
  view,
  verbose = false,
  showHintFooter = true,
  terminalSize: { columns: terminalColumns, rows: terminalRows },
}: AppProps & { readonly terminalSize: TerminalSize }): React.JSX.Element {
  const wrapColumns = Math.max(20, terminalColumns - 2);
  const ledgerRef = useRef(createIncrementalTranscriptLedger());
  const projectionCacheRef = useRef<AssistantProjectionCache>(new Map());
  const candidate = planIncrementalTranscript({
    previousLedger: ledgerRef.current,
    previousProjectionCache: projectionCacheRef.current,
    view,
    verbose,
    wrapColumns,
  });
  const { ledger, projectionCache, commitPlan, staticEntries, projectionFor } = candidate;
  // Ink's public type is a full readonly Array even though the pinned implementation only reads
  // `length` and `slice`. Keep the compatibility assertion local to this audited seam.
  const inkStaticEntries = staticEntries as unknown as InkStaticEntry[];
  useLayoutEffect(() => {
    commitIncrementalTranscriptCandidate(candidate);
    ledgerRef.current = ledger;
    projectionCacheRef.current = projectionCache;
  }, [candidate, ledger, projectionCache]);

  const plan = commitPlan.livePlan;
  const activeApproval = view.activeApproval;
  const approvalOwnsViewport = activeApproval !== undefined;
  const overlayOwnsViewport = view.overlay !== undefined && !approvalOwnsViewport;
  const pendingReviewCount = renderPendingReviewCount(view.pendingReviews ?? 0);
  const overlayRows = overlayRowBudget(view, {
    columns: terminalColumns,
    rows: terminalRows,
  });
  return (
    <Box flexDirection="column">
      {view.firstRun && view.items.length === 0 && view.overlay === undefined ? (
        <WelcomeBanner
          recentSessions={view.recentSessions ?? []}
          {...(view.usageDigest !== undefined ? { usageDigest: view.usageDigest } : {})}
          columns={terminalColumns}
          rows={terminalRows}
        />
      ) : null}
      <Static items={inkStaticEntries}>
        {(entry) =>
          entry.kind === "conversation" ? (
            <ConversationBlockView key={entry.id} block={entry.block} view={view} />
          ) : (
            <IncrementalStaticUnitView key={entry.id} unit={entry.unit} view={view} />
          )
        }
      </Static>
      {!overlayOwnsViewport && !approvalOwnsViewport
        ? plan.blocks.map((block) => {
            // A block may become temporarily commit-eligible before the reducer's final
            // awaiting-input event moves it back into the live plan. Once native history owns
            // that stable block id, never paint it again in the mutable frame.
            if (ledger.committedBlocks.has(block.id)) return null;
            const state = ledger.turns.get(block.id);
            return block.kind === "turn" && state !== undefined ? (
              <IncrementalLiveTurn
                key={block.id}
                block={block}
                state={state}
                view={view}
                currentWrapColumns={wrapColumns}
                projectionFor={projectionFor}
              />
            ) : (
              <ConversationBlockView key={block.id} block={block} view={view} />
            );
          })
        : null}
      {!overlayOwnsViewport && activeApproval !== undefined ? (
        <ApprovalBlock approval={activeApproval} />
      ) : null}
      {overlayOwnsViewport && view.overlay ? (
        <Box>
          <OverlayView overlay={view.overlay} columns={terminalColumns} rows={overlayRows} />
        </Box>
      ) : null}
      {!overlayOwnsViewport &&
      !approvalOwnsViewport &&
      plan.showAttentionRail &&
      plan.attentionRail !== undefined ? (
        <AttentionRail marks={plan.attentionRail} columns={terminalColumns} />
      ) : null}
      {!overlayOwnsViewport && !approvalOwnsViewport && plan.standaloneCurrentTurn !== undefined ? (
        <CurrentTurn turn={plan.standaloneCurrentTurn} density={view.density} />
      ) : null}
      {!overlayOwnsViewport &&
      !approvalOwnsViewport &&
      view.queuedInputs !== undefined &&
      view.queuedInputs.length > 0 ? (
        <QueuedInputs inputs={view.queuedInputs} columns={terminalColumns} rows={terminalRows} />
      ) : null}
      {!overlayOwnsViewport &&
      !approvalOwnsViewport &&
      (view.urgentSteering?.state === "applied" || view.queuedInputs?.[0]?.class !== "urgent") ? (
        <UrgentSteering steering={view.urgentSteering} columns={terminalColumns} />
      ) : null}
      {!overlayOwnsViewport && !approvalOwnsViewport && pendingReviewCount !== undefined ? (
        <Text color={THEME.state.warning}>{pendingReviewCount}</Text>
      ) : null}
      {!overlayOwnsViewport && !approvalOwnsViewport && plan.standaloneSummary !== undefined ? (
        <FinalCard card={plan.standaloneSummary} />
      ) : null}
      <StatusLine
        status={view.status}
        density={view.density}
        diffMode={view.diffMode}
        compact={view.overlay !== undefined || approvalOwnsViewport || terminalRows <= 18}
        hideMeta={approvalOwnsViewport && terminalRows <= 18}
      />
      {showHintFooter ? <Text dimColor>{hintFooter(view)}</Text> : null}
    </Box>
  );
}
