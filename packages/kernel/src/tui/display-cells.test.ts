import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assistantStreamingProjection } from "./assistant-prose.js";
import {
  graphemeSpans,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
  takeDisplayCells,
  terminalCellWidth,
  terminalDisplayWidth,
  truncateDisplayCells,
  wrapDisplayLine,
} from "./display-cells.js";
import { ALL_OFF_POSTURE, statusRows } from "./view-model.js";

const COMPLEX_GRAPHEMES = ["a", "界", "e\u0301", "🇨🇦", "👩🏽‍💻", "क्‍ष", "\u200b", "\t"] as const;

describe("Epic 3.10 Slice 3B0 shared grapheme and display-cell contract", () => {
  it("returns payload-preserving extended-grapheme spans and UTF-16 boundaries", () => {
    const value = "Ae\u0301🇨🇦👩🏽‍💻क्‍षZ";
    const spans = graphemeSpans(value);

    expect(spans.map((span) => span.text)).toEqual(["A", "e\u0301", "🇨🇦", "👩🏽‍💻", "क्‍ष", "Z"]);
    expect(spans.map(({ start, end }) => [start, end])).toEqual([
      [0, 1],
      [1, 3],
      [3, 7],
      [7, 14],
      [14, 18],
      [18, 19],
    ]);
    expect(spans.map((span) => value.slice(span.start, span.end)).join("")).toBe(value);
  });

  it("moves to whole-grapheme boundaries and recovers safely from edge or invalid offsets", () => {
    const value = "Ae\u0301🇨🇦👩🏽‍💻क्‍षZ";

    expect(previousGraphemeBoundary(value, 14)).toBe(7);
    expect(previousGraphemeBoundary(value, 13)).toBe(7);
    expect(nextGraphemeBoundary(value, 7)).toBe(14);
    expect(nextGraphemeBoundary(value, 8)).toBe(14);
    expect(previousGraphemeBoundary(value, -20)).toBe(0);
    expect(previousGraphemeBoundary(value, Number.POSITIVE_INFINITY)).toBe(18);
    expect(nextGraphemeBoundary(value, Number.POSITIVE_INFINITY)).toBe(value.length);
    expect(nextGraphemeBoundary(value, Number.NaN)).toBe(1);
    expect(previousGraphemeBoundary("", 9)).toBe(0);
    expect(nextGraphemeBoundary("", -9)).toBe(0);
  });

  it.each([
    ["combining sequence", "e\u0301", 1],
    ["flag", "🇨🇦", 2],
    ["skin-tone ZWJ emoji", "👩🏽‍💻", 2],
    ["Devanagari cluster", "क्‍ष", 1],
    ["Devanagari spacing mark", "कि", 1],
    ["zero-width space", "\u200b", 0],
    ["bidi control", "\u202e", 0],
    ["wide glyph", "界", 2],
  ] as const)("measures %s with the pinned terminal-cell policy", (_label, value, cells) => {
    expect(terminalDisplayWidth(value)).toBe(cells);
  });

  it("measures tabs positionally and resets the final-line column after a newline", () => {
    expect(terminalCellWidth("\t", 0)).toBe(8);
    expect(terminalCellWidth("\t", 1)).toBe(7);
    expect(terminalCellWidth("\t", 8)).toBe(8);
    expect(terminalDisplayWidth("a\tb")).toBe(9);
    expect(terminalDisplayWidth("wide\nx")).toBe(1);
  });

  it("wraps without rewriting payload or splitting a grapheme", () => {
    const value = "a\te\u0301🇨🇦界";
    const rows = wrapDisplayLine(value, 4);

    expect(rows.map((row) => row.text)).toEqual(["a", "\t", "e\u0301🇨🇦", "界"]);
    expect(rows.map((row) => row.cells)).toEqual([1, 8, 3, 2]);
    expect(rows.map((row) => row.text).join("")).toBe(value);
    expect(rows.flatMap((row) => graphemeSpans(row.text)).map((span) => span.text)).toEqual([
      "a",
      "\t",
      "e\u0301",
      "🇨🇦",
      "界",
    ]);
  });

  it("reports exact hidden cells for a grapheme-safe prefix", () => {
    expect(takeDisplayCells("a界e\u0301🇨🇦", 4)).toEqual({
      text: "a界e\u0301",
      cells: 4,
      hiddenCells: 2,
      truncated: true,
    });
    expect(takeDisplayCells("a\tb", 8)).toEqual({
      text: "a\t",
      cells: 8,
      hiddenCells: 1,
      truncated: true,
    });
    expect(takeDisplayCells("e\u0301", 1)).toEqual({
      text: "e\u0301",
      cells: 1,
      hiddenCells: 0,
      truncated: false,
    });
  });

  it("truncates head-only and head-tail lines within an exact cell budget without splitting graphemes", () => {
    const source = `request ${"界".repeat(20)} e\u0301 👩🏽‍💻 /outside/important-file.txt`;
    const headOnly = truncateDisplayCells(source, 24);
    const headTail = truncateDisplayCells(source, 40, { tailCells: 28 });

    expect(terminalDisplayWidth(headOnly)).toBeLessThanOrEqual(24);
    expect(headOnly).toMatch(/…$/u);
    expect(source.startsWith(headOnly.slice(0, -1))).toBe(true);
    expect(terminalDisplayWidth(headTail)).toBeLessThanOrEqual(40);
    expect(headTail).toContain("…");
    expect(headTail).toMatch(/\/outside\/important-file\.txt$/u);
    const [head = "", tail = ""] = headTail.split("…");
    expect(source.startsWith(head.trimEnd())).toBe(true);
    expect(source.endsWith(tail.trimStart())).toBe(true);
    expect(
      graphemeSpans(head)
        .map((span) => span.text)
        .join(""),
    ).toBe(head);
    expect(
      graphemeSpans(tail)
        .map((span) => span.text)
        .join(""),
    ).toBe(tail);
    expect(truncateDisplayCells(`abcdef${"\u200b".repeat(1_000)}`, 4)).toBe("abc…");
  });

  it("bounds invisible suffixes and pathological single graphemes as well as visible cells", () => {
    const invisible = "\u200b".repeat(1_000);
    const tail = truncateDisplayCells(`abcdef${invisible}`, 4, { tailCells: 2 });
    const otherwiseFits = truncateDisplayCells(`abc${invisible}`, 4, { tailCells: 2 });
    const giantCluster = truncateDisplayCells(`a${"\u0301".repeat(1_000)}`, 4, {
      tailCells: 2,
    });

    expect(tail.length).toBeLessThanOrEqual(32);
    expect(otherwiseFits.length).toBeLessThanOrEqual(32);
    expect(giantCluster.length).toBeLessThanOrEqual(32);
    expect(terminalDisplayWidth(tail)).toBeLessThanOrEqual(4);
    expect(terminalDisplayWidth(otherwiseFits)).toBeLessThanOrEqual(4);
    expect(terminalDisplayWidth(giantCluster)).toBeLessThanOrEqual(4);
    expect(tail).toContain("…");
    expect(otherwiseFits).toContain("…");
    expect(giantCluster).toContain("…");
  });

  it("rejects invalid layout budgets", () => {
    expect(() => wrapDisplayLine("x", 0)).toThrow(RangeError);
    expect(() => wrapDisplayLine("x", 2.5)).toThrow(RangeError);
    expect(() => takeDisplayCells("x", -1)).toThrow(RangeError);
    expect(() => takeDisplayCells("x", 1.5)).toThrow(RangeError);
    expect(() => truncateDisplayCells("x", -1)).toThrow(RangeError);
    expect(() => truncateDisplayCells("x\ny", 2)).toThrow(RangeError);
    expect(() => truncateDisplayCells("long", 2, { tailCells: 1.5 })).toThrow(RangeError);
  });

  it("keeps segmentation, wrapping, and clipping payload-preserving under generated clusters", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...COMPLEX_GRAPHEMES), { maxLength: 80 }),
        fc.integer({ min: 1, max: 24 }),
        (parts, columns) => {
          const value = parts.join("");
          const spans = graphemeSpans(value);
          expect(spans.map((span) => span.text).join("")).toBe(value);
          expect(
            wrapDisplayLine(value, columns)
              .map((row) => row.text)
              .join(""),
          ).toBe(value);
          const clipped = takeDisplayCells(value, columns);
          expect(value.startsWith(clipped.text)).toBe(true);
          expect(clipped.cells + clipped.hiddenCells).toBe(terminalDisplayWidth(value));
          const truncated = truncateDisplayCells(value, columns, {
            tailCells: Math.floor(columns / 2),
          });
          expect(terminalDisplayWidth(truncated)).toBeLessThanOrEqual(columns);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("keeps assistant physical rows within their declared cell budget after tab/Unicode wrapping", () => {
    const source = "alpha\tbeta e\u0301 🇨🇦 👩🏽‍💻";
    const projection = assistantStreamingProjection(source, 12);

    expect(projection.columns).toBe(20);
    expect(
      projection.lines.every((line) => terminalDisplayWidth(line.text) <= projection.columns),
    ).toBe(true);
    expect(projection.lines.map((line) => line.text).join("")).toBe(
      source.replaceAll("\t", "    "),
    );
  });

  it("keeps Unicode status rows inside the declared terminal width", () => {
    const rows = statusRows(
      {
        model: "界".repeat(40),
        cwd: "/workspace/keel",
        tokens: 1_500,
        posture: ALL_OFF_POSTURE,
      },
      { columns: 60, density: "quiet", diffMode: "full" },
    );

    expect(rows.every((row) => terminalDisplayWidth(row) <= 60)).toBe(true);
    expect(rows[0]).toContain("view quiet");
    expect(rows[0]).toContain("diff full");
  });
});
