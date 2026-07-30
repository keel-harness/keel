/* @jsxRuntime automatic @jsxImportSource react */
// tsx (`pnpm keel`) ignores tsconfig `jsx:"react-jsx"` → keep the explicit automatic runtime.
import { Box, Text } from "ink";
import type { DiffViewerCollection, DiffViewerState } from "../diff-viewer.js";
import { planDiffViewer } from "../diff-viewer.js";
import { wrapDisplayLine } from "../display-cells.js";
import { diffStylePlan, terminalColorCapability, THEME, TUI_SPACING } from "../theme.js";

function WrappedMetadata({ text, columns }: { text: string; columns: number }): React.JSX.Element {
  return (
    <>
      {wrapDisplayLine(text, columns).map((row, index) => (
        <Text key={index} dimColor wrap="truncate-end">
          {row.text}
        </Text>
      ))}
    </>
  );
}

function SmallViewer({ columns }: { columns: number }): React.JSX.Element {
  return (
    <Box width={Math.max(1, columns)}>
      <Text color={THEME.accent} wrap="truncate-end">
        diff review · resize terminal · esc close
      </Text>
    </Box>
  );
}

/** Thin render-only Ink map over the covered viewer reducer/planner. */
export function DiffViewer({
  collection,
  state,
  columns,
  rows,
}: {
  collection: DiffViewerCollection;
  state: DiffViewerState;
  columns: number;
  rows: number;
}): React.JSX.Element {
  const innerColumns = columns - TUI_SPACING.nested;
  if (innerColumns < 20) return <SmallViewer columns={columns} />;
  let plan;
  try {
    plan = planDiffViewer(collection, state, { columns: innerColumns, rows });
  } catch (error) {
    if (error instanceof RangeError) return <SmallViewer columns={columns} />;
    throw error;
  }
  const capability = terminalColorCapability();
  return (
    <Box
      flexDirection="column"
      width={columns}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderLeftColor={THEME.accent}
      paddingLeft={TUI_SPACING.inset}
    >
      {plan.titleLines.map((line, index) => (
        <Text key={index} bold color={THEME.accent} wrap="truncate-end">
          {line}
        </Text>
      ))}
      <Text wrap="truncate-end">
        <Text bold>{plan.path}</Text>
        {plan.parentPath !== undefined ? <Text dimColor> {plan.parentPath}</Text> : null}
      </Text>
      {plan.fileSummaryLines.length === 1 ? (
        <Text wrap="truncate-end">
          <Text {...(capability === "mono" ? {} : { color: THEME.diff.add })}>
            +{plan.fileSummary.added}
          </Text>{" "}
          <Text {...(capability === "mono" ? {} : { color: THEME.diff.remove })}>
            -{plan.fileSummary.deleted}
          </Text>
          <Text dimColor> · {plan.fileSummary.rows} source rows</Text>
        </Text>
      ) : (
        <>
          <Text wrap="truncate-end">
            <Text {...(capability === "mono" ? {} : { color: THEME.diff.add })}>
              +{plan.fileSummary.added}
            </Text>{" "}
            <Text {...(capability === "mono" ? {} : { color: THEME.diff.remove })}>
              -{plan.fileSummary.deleted}
            </Text>
          </Text>
          <Text dimColor wrap="truncate-end">
            {plan.fileSummary.rows} source rows
          </Text>
        </>
      )}
      {plan.filePosition.hiddenEarlier > 0 ? (
        <WrappedMetadata
          text={`… ${String(plan.filePosition.hiddenEarlier)} earlier files outside this review`}
          columns={innerColumns}
        />
      ) : null}
      {plan.hiddenPathCells > 0 ? (
        <WrappedMetadata
          text={`… ${String(plan.hiddenPathCells)} path cells hidden`}
          columns={innerColumns}
        />
      ) : null}
      {plan.hiddenBefore > 0 ? (
        <WrappedMetadata
          text={`↑ ${String(plan.hiddenBefore)} earlier source rows`}
          columns={innerColumns}
        />
      ) : null}
      {plan.rows.map((row, index) => {
        if (row.kind === "hunk-summary") {
          return (
            <Text key={index} color={THEME.accent}>
              › {row.text}
            </Text>
          );
        }
        const style = diffStylePlan(row.layout.kind, capability, false);
        return (
          <Text key={index} {...style}>
            <Text {...(row.selected ? { color: THEME.accent } : {})}>
              {row.selected ? "›" : " "}
            </Text>{" "}
            <Text {...style} dimColor={capability !== "mono"}>
              {row.layout.observed} {row.layout.installed} {row.layout.marker}
            </Text>
            {row.layout.spans.map((span, spanIndex) => (
              <Text
                key={spanIndex}
                {...diffStylePlan(row.layout.kind, capability, span.emphasized)}
              >
                {span.text}
              </Text>
            ))}
          </Text>
        );
      })}
      {plan.hiddenAfter > 0 ? (
        <WrappedMetadata
          text={`↓ ${String(plan.hiddenAfter)} later source rows`}
          columns={innerColumns}
        />
      ) : null}
      {plan.evidenceLines.map((line, index) => (
        <Text key={index} dimColor wrap="truncate-end">
          {line}
        </Text>
      ))}
      {plan.footerLines.map((line, index) => (
        <Text key={index} dimColor wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
}
