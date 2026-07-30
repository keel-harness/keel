import { terminalDisplayWidth, wrapDisplayLine } from "./display-cells.js";

export { expandTerminalTabs, terminalDisplayWidth } from "./display-cells.js";

export interface RowBudgetSummary {
  readonly columns: number;
  readonly logicalLines: number;
  readonly physicalRows: number;
  readonly widestLine: number;
}

/** A calm reading measure with one-cell gutters on ordinary terminals. The minimum mirrors Ink's
 * wrapping floor so pathological test streams still receive a valid layout width. */
export function responseSurfaceColumns(terminalColumns: number): number {
  return Math.min(104, Math.max(20, Math.floor(terminalColumns) - 2));
}

function stripAnsiCsiPreserveRows(value: string): string {
  let output = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 0x1b && value[i + 1] === "[") {
      i += 2;
      while (i < value.length) {
        const finalCode = value.charCodeAt(i);
        if (finalCode >= 0x40 && finalCode <= 0x7e) break;
        i += 1;
      }
      continue;
    }
    output += value.charAt(i);
  }
  return output;
}

function visibleText(value: string): string {
  // Keep newlines because row budgets are a layout property; strip terminal control bytes that are not
  // visible cells. This helper is intentionally measurement-only and not a sanitization boundary.
  return (
    stripAnsiCsiPreserveRows(value)
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex -- intentional terminal-control measurement filter.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
  );
}

function terminalLines(value: string): readonly string[] {
  if (value.length === 0) return [];
  const lines = visibleText(value).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function visibleLineCount(value: string): number {
  return terminalLines(value).length;
}

export function physicalRows(value: string, columns: number): readonly string[] {
  if (!Number.isInteger(columns) || columns <= 0) {
    throw new RangeError("columns must be a positive integer");
  }
  const rows: string[] = [];
  for (const line of terminalLines(value)) {
    rows.push(...wrapDisplayLine(line, columns).map((row) => row.text));
  }
  return rows;
}

export function physicalRowCount(value: string, columns: number): number {
  return physicalRows(value, columns).length;
}

export function summarizeRowBudget(value: string, columns: number): RowBudgetSummary {
  const logicalLines = terminalLines(value);
  return {
    columns,
    logicalLines: logicalLines.length,
    physicalRows: physicalRows(value, columns).length,
    widestLine: logicalLines.reduce((max, line) => Math.max(max, terminalDisplayWidth(line)), 0),
  };
}
