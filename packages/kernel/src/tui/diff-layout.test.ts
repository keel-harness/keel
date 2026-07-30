import type { DiffLine } from "@keel/shared";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { terminalDisplayWidth } from "./display-cells.js";
import {
  MAX_DIFF_HUNKS,
  MAX_DIFF_LAYOUT_BYTES,
  MAX_DIFF_LAYOUT_ROWS,
  MAX_DIFF_LINE_BYTES,
  MAX_DIFF_LINE_ROWS,
  MAX_DIFF_LINES,
  planDiffLayout,
  planDiffRender,
} from "./diff.js";

function add(text: string, installedAfterLine: number, hunkStart = false): DiffLine {
  return {
    kind: "add",
    text,
    installedAfterLine,
    ...(hunkStart ? { hunkStart: true } : {}),
  };
}

describe("Epic 3.10 Slice 3B bounded semantic diff selection", () => {
  it("retains exact hidden line and wholly-hidden hunk counts at the hunk cap", () => {
    const diff = Array.from({ length: MAX_DIFF_HUNKS + 4 }, (_, index) =>
      add(`hunk ${index}`, index * 10 + 1, true),
    );

    const plan = planDiffRender(diff, "full", "src/components/example.ts");

    expect(plan.lines).toHaveLength(MAX_DIFF_HUNKS);
    expect(plan.hidden).toBe(4);
    expect(plan.hiddenHunks).toBe(4);
    expect(plan.path).toBe("src/components/example.ts");
  });

  it("keeps the existing line cap exact when one hunk is larger than the view", () => {
    const diff = Array.from({ length: MAX_DIFF_LINES + 5 }, (_, index) =>
      add(`line ${index}`, index + 1, index === 0),
    );

    const plan = planDiffRender(diff, "full");

    expect(plan.lines).toHaveLength(MAX_DIFF_LINES);
    expect(plan.hidden).toBe(5);
    expect(plan.hiddenHunks).toBeUndefined();
  });

  it("stops admitted semantic text at the byte budget without materializing later lines", () => {
    const exactLine = "x".repeat(MAX_DIFF_LINE_BYTES);
    const lineCountAtBudget = MAX_DIFF_LAYOUT_BYTES / MAX_DIFF_LINE_BYTES;
    const diff = Array.from({ length: lineCountAtBudget + 1 }, (_, index) =>
      add(exactLine, index + 1, index === 0),
    );

    const plan = planDiffRender(diff, "full");

    expect(plan.lines).toHaveLength(lineCountAtBudget);
    expect(plan.hidden).toBe(1);
    expect(plan.limits).toContain("bytes");
  });
});

describe("Epic 3.10 Slice 3B width-aware diff layout", () => {
  it("renders a filename-first header, subdued parent path data, and stable old/new gutters", () => {
    const source: DiffLine[] = [
      {
        kind: "context",
        text: "alpha",
        observedBeforeLine: 9,
        installedAfterLine: 9,
        hunkStart: true,
      },
      { kind: "del", text: "   ", observedBeforeLine: 105 },
      { kind: "add", text: "beta", installedAfterLine: 106 },
    ];
    const plan = planDiffRender(source, "full", "src/components/example.ts");
    const layout = planDiffLayout(plan, 38);

    expect(layout.header).toMatchObject({
      fileName: "example.ts",
      parentPath: "src/components/",
      hiddenCells: 0,
    });
    expect(layout.gutterWidth).toBe(3);
    expect(
      layout.rows.map(({ observed, installed, marker, text }) => ({
        observed,
        installed,
        marker,
        text,
      })),
    ).toEqual([
      { observed: "  9", installed: "  9", marker: "  ", text: "alpha" },
      { observed: "105", installed: "   ", marker: "- ", text: "   " },
      { observed: "   ", installed: "106", marker: "+ ", text: "beta" },
    ]);
    expect(layout.rows.every((row) => row.cells <= layout.columns)).toBe(true);
  });

  it("keeps the filename visible and reports exact parent-path cells omitted at narrow width", () => {
    const parent = "very/long/parent/path/with/many/segments/";
    const layout = planDiffLayout(
      planDiffRender([add("value", 1, true)], "full", `${parent}example.ts`),
      38,
    );

    expect(layout.header.fileName).toBe("example.ts");
    expect(layout.header.parentPath?.endsWith("…")).toBe(true);
    expect(layout.header.cells).toBeLessThanOrEqual(38);
    expect(layout.header.hiddenCells).toBe(
      terminalDisplayWidth(parent) - terminalDisplayWidth(layout.header.parentPath!.slice(0, -1)),
    );
  });

  it("preserves source tabs and graphemes while display rows expand tabs and wrap explicitly", () => {
    const source = `\t${"界e\u0301".repeat(12)}`;
    const plan = planDiffRender([add(source, 2, true)], "full", "src/wide.ts");
    const layout = planDiffLayout(plan, 40);

    expect(plan.lines?.[0]?.text).toBe(source);
    expect(layout.rows[0]?.marker).toBe("+ ");
    expect(layout.rows.slice(1).some((row) => row.marker === "+↳")).toBe(true);
    expect(layout.rows.every((row) => !row.text.includes("\t"))).toBe(true);
    expect(layout.rows.every((row) => row.cells <= 40)).toBe(true);
    expect(layout.rows.every((row) => !row.text.startsWith("\u0301"))).toBe(true);
  });

  it("clips an invalid oversize internal line with exact byte and cell disclosure", () => {
    const source = "界".repeat(MAX_DIFF_LINE_BYTES);
    const plan = planDiffRender([add(source, 1, true)], "full", "src/minified.ts");
    const layout = planDiffLayout(plan, 40);
    const omission = layout.rows.at(-1);

    expect(plan.lines?.[0]?.text).toBe(source);
    expect(layout.rows).toHaveLength(MAX_DIFF_LINE_ROWS);
    expect(omission).toMatchObject({ marker: "+…", continuation: true });
    const admittedWholeGraphemeBytes =
      MAX_DIFF_LINE_BYTES - (MAX_DIFF_LINE_BYTES % Buffer.byteLength("界", "utf8"));
    expect(omission?.hiddenBytes).toBe(
      Buffer.byteLength(source, "utf8") - admittedWholeGraphemeBytes,
    );
    expect(omission?.hiddenCells).toBeGreaterThan(0);
    expect(layout.rows.every((row) => row.cells <= 40)).toBe(true);
  });

  it("keeps the physical row budget exact and reports source lines omitted after wrapping", () => {
    const diff = Array.from({ length: MAX_DIFF_LINES }, (_, index) =>
      add("x".repeat(200), index + 1, index === 0),
    );
    const layout = planDiffLayout(planDiffRender(diff, "full", "src/large.ts"), 40);

    expect(layout.rows).toHaveLength(MAX_DIFF_LAYOUT_ROWS);
    expect(layout.hiddenLines).toBe(30);
    expect(layout.rows.every((row) => row.cells <= 40)).toBe(true);
  });

  it.each([40, 60, 80, 120])("keeps every planned row within %i terminal cells", (columns) => {
    const source = `\t${"A界e\u0301👩🏽‍💻".repeat(40)}`;
    const layout = planDiffLayout(
      planDiffRender([add(source, 20_000, true)], "full", "very/long/parent/path/example.ts"),
      columns,
    );

    expect(layout.rows.every((row) => row.cells <= columns)).toBe(true);
    expect(
      layout.rows.every(
        (row) =>
          terminalDisplayWidth(`${row.observed} ${row.installed} ${row.marker}${row.text}`) <=
          columns,
      ),
    ).toBe(true);
  });

  it("falls back to exact summary counts when a terminal is too narrow for stable gutters", () => {
    const layout = planDiffLayout(
      planDiffRender(
        [
          {
            kind: "add",
            text: "x".repeat(20_000),
            installedAfterLine: 20_000,
            hunkStart: true,
          },
        ],
        "full",
        "src/narrow.ts",
      ),
      20,
    );

    expect(layout.rows).toEqual([]);
    expect(layout.hiddenLines).toBe(1);
    expect(layout.hiddenHunks).toBe(1);
    expect(layout.limits).toContain("rows");
  });

  it("preserves exact source accounting and cell bounds for generated Unicode diff shapes", () => {
    const segment = fc.constantFrom("a", " ", "\t", "界", "e\u0301", "👩🏽‍💻");
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom("context" as const, "add" as const, "del" as const),
            parts: fc.array(segment, { maxLength: 80 }),
            line: fc.integer({ min: 1, max: 20_000 }),
            hunkStart: fc.boolean(),
          }),
          { maxLength: 80 },
        ),
        fc.integer({ min: 40, max: 120 }),
        (generated, columns) => {
          const diff: DiffLine[] = generated.map((entry) => ({
            kind: entry.kind,
            text: entry.parts.join(""),
            ...(entry.kind !== "add" ? { observedBeforeLine: entry.line } : {}),
            ...(entry.kind !== "del" ? { installedAfterLine: entry.line } : {}),
            ...(entry.hunkStart ? { hunkStart: true } : {}),
          }));
          const plan = planDiffRender(diff, "full", "src/property.ts");
          const layout = planDiffLayout(plan, columns);
          const shownSourceLines = layout.rows.filter((row) => !row.continuation).length;

          expect((plan.lines?.length ?? 0) + (plan.hidden ?? 0)).toBe(diff.length);
          expect(shownSourceLines + layout.hiddenLines).toBe(diff.length);
          expect(layout.rows.length).toBeLessThanOrEqual(MAX_DIFF_LAYOUT_ROWS);
          expect(
            layout.rows.every(
              (row) =>
                terminalDisplayWidth(`${row.observed} ${row.installed} ${row.marker}${row.text}`) <=
                columns,
            ),
          ).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });
});
