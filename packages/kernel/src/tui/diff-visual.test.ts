import { describe, expect, it } from "vitest";
import type { DiffLine } from "@keel/shared";
import { MAX_DIFF_LAYOUT_ROWS, planDiffLayout, planDiffRender, visibleDiffText } from "./diff.js";
import { diffStylePlan, terminalColorCapability, THEME } from "./theme.js";

function rowsFor(
  diff: readonly DiffLine[],
  columns = 80,
): ReturnType<typeof planDiffLayout>["rows"] {
  return planDiffLayout(planDiffRender(diff, "full", "src/example.ts"), columns).rows;
}

function emphasizedText(row: ReturnType<typeof planDiffLayout>["rows"][number]): string {
  return row.spans
    .filter((span) => span.emphasized)
    .map((span) => span.text)
    .join("");
}

describe("Epic 3.10 Slice 3D intraline diff planning", () => {
  it("emphasizes only the changed grapheme middle of a paired one-line substitution", () => {
    const rows = rowsFor([
      {
        kind: "del",
        text: "return total + tax;",
        observedBeforeLine: 7,
        hunkStart: true,
      },
      { kind: "add", text: "return total - tax;", installedAfterLine: 7 },
    ]);
    const removed = rows.find((row) => row.kind === "del")!;
    const added = rows.find((row) => row.kind === "add")!;

    expect(removed.spans.map((span) => span.text).join("")).toBe(removed.text);
    expect(added.spans.map((span) => span.text).join("")).toBe(added.text);
    expect(emphasizedText(removed)).toBe("+");
    expect(emphasizedText(added)).toBe("-");
  });

  it("pairs replacement runs by stable ordinal and leaves an unpaired line at line emphasis only", () => {
    const rows = rowsFor([
      { kind: "del", text: "const alpha = 1;", hunkStart: true },
      { kind: "del", text: "const beta = 2;" },
      { kind: "add", text: "const alpha = 10;" },
      { kind: "add", text: "const beta = 20;" },
      { kind: "add", text: "const gamma = 30;" },
    ]);

    expect(rows.map(emphasizedText)).toEqual(["1", "2", "10", "20", ""]);
  });

  it("does not invent an intraline change for identical paired lines", () => {
    const rows = rowsFor([
      { kind: "del", text: "unchanged", hunkStart: true },
      { kind: "add", text: "unchanged" },
    ]);

    expect(rows.map(emphasizedText)).toEqual(["", ""]);
  });

  it("handles whitespace, tabs, combining marks, and emoji without splitting a grapheme", () => {
    const rows = rowsFor([
      { kind: "del", text: "const value = café;", hunkStart: true },
      { kind: "add", text: "const  value = cafe\u0301;" },
      { kind: "del", text: "\ticon = 👩🏽‍💻;", hunkStart: true },
      { kind: "add", text: "\ticon = 👩🏽‍🚀;" },
    ]);
    const removed = rows.filter((row) => row.kind === "del");
    const added = rows.filter((row) => row.kind === "add");

    expect(emphasizedText(removed[0]!)).toBe("value = café");
    expect(emphasizedText(added[0]!)).toBe(" value = cafe\u0301");
    expect(emphasizedText(removed[1]!)).toBe("👩🏽‍💻");
    expect(emphasizedText(added[1]!)).toBe("👩🏽‍🚀");
    expect(rows.some((row) => row.text.includes("\t"))).toBe(false);
  });

  it("expands a source tab to the next positional eight-cell stop", () => {
    const [row] = rowsFor([{ kind: "add", text: "1234567\tX", hunkStart: true }]);

    expect(row?.text).toBe("1234567 X");
  });

  it("projects intraline spans through wrapping while reconstructing every displayed row", () => {
    const prefix = `prefix-${"a".repeat(30)}`;
    const rows = rowsFor(
      [
        { kind: "del", text: `${prefix}OLD-suffix`, hunkStart: true },
        { kind: "add", text: `${prefix}NEW-suffix` },
      ],
      38,
    );

    for (const row of rows) {
      expect(row.spans.map((span) => span.text).join("")).toBe(row.text);
    }
    expect(
      rows
        .filter((row) => row.kind === "del")
        .map(emphasizedText)
        .join(""),
    ).toBe("OLD");
    expect(
      rows
        .filter((row) => row.kind === "add")
        .map(emphasizedText)
        .join(""),
    ).toBe("NEW");
  });
});

describe("Epic 3.10 Slice 3D hunk rhythm and hostile display text", () => {
  it("charges later-hunk spacing to the existing physical-row budget", () => {
    const diff = Array.from(
      { length: 40 },
      (_, index): DiffLine => ({
        kind: "context",
        text: `line-${String(index)}`,
        observedBeforeLine: index + 1,
        installedAfterLine: index + 1,
        ...(index % 5 === 0 ? { hunkStart: true } : {}),
      }),
    );
    const layout = planDiffLayout(planDiffRender(diff, "full", "src/many.ts"), 80);

    expect(layout.physicalRows).toBeLessThanOrEqual(MAX_DIFF_LAYOUT_ROWS);
    expect(layout.rows.filter((row) => row.hunkBoundaryBefore).length).toBe(5);
    expect(layout.rows).toHaveLength(30);
    expect(layout.physicalRows).toBe(35);
    expect(layout.hiddenLines).toBe(10);
    expect(layout.hiddenHunks).toBe(2);
  });

  it("renders terminal controls and default-ignorable scalars as visible inert tokens but preserves tabs", () => {
    const hostile = `A\tB\r\u001b]8;;https://evil.example\u0007\u202e\u200b\u2060\u0301\ud800safe`;
    const visible = visibleDiffText(hostile);

    expect(visible).toBe(
      "A\tB␍␛]8;;https://evil.example␇‹U+202E›‹U+200B›‹U+2060›‹U+0301›‹U+D800›safe",
    );
    expect(visibleDiffText(visible)).toBe(visible);
    expect(
      [...visible].some((scalar) => {
        const codePoint = scalar.codePointAt(0) ?? 0;
        return (
          (codePoint <= 0x1f && codePoint !== 0x09) || (codePoint >= 0x7f && codePoint <= 0x9f)
        );
      }),
    ).toBe(false);
  });

  it("preserves semantic emoji joiners but exposes incomplete injected joiners", () => {
    expect(visibleDiffText("👩🏽‍💻 👩‍A A‍👩")).toBe("👩🏽‍💻 👩‹U+200D›A A‹U+200D›👩");
  });
});

describe("Epic 3.10 Slice 3D terminal-capability diff styling", () => {
  it.each([
    [{ TERM: "xterm-truecolor", FORCE_COLOR: "3" }, "extended"],
    [{ TERM: "xterm-256color", FORCE_COLOR: "2" }, "extended"],
    [{ TERM: "xterm-256color" }, "extended"],
    [{ TERM: "xterm-truecolor" }, "extended"],
    [{ TERM: "screen-direct" }, "extended"],
    [{ TERM: "xterm", COLORTERM: "truecolor" }, "extended"],
    [{ TERM: "xterm", COLORTERM: "24bit" }, "extended"],
    [{ TERM: "xterm", FORCE_COLOR: "1" }, "basic"],
    [{ TERM: "xterm-256color", NO_COLOR: "1" }, "mono"],
    [{ TERM: "xterm-256color", FORCE_COLOR: "0" }, "mono"],
    [{ TERM: "dumb" }, "mono"],
  ] as const)("maps %o to the %s diff capability", (env, expected) => {
    expect(terminalColorCapability(env)).toBe(expected);
  });

  it("uses restrained full-line surfaces only when extended color is available", () => {
    expect(diffStylePlan("add", "extended", false)).toEqual({
      color: THEME.diff.addText,
      backgroundColor: THEME.diff.addSurface,
    });
    expect(diffStylePlan("del", "extended", true)).toEqual({
      color: THEME.diff.removeEmphasisText,
      backgroundColor: THEME.diff.removeEmphasisSurface,
      bold: true,
    });
    expect(diffStylePlan("add", "extended", true)).toEqual({
      color: THEME.diff.addEmphasisText,
      backgroundColor: THEME.diff.addEmphasisSurface,
      bold: true,
    });
    expect(diffStylePlan("del", "extended", false)).toEqual({
      color: THEME.diff.removeText,
      backgroundColor: THEME.diff.removeSurface,
    });
    expect(diffStylePlan("add", "basic", false)).toEqual({ color: THEME.diff.add });
    expect(diffStylePlan("add", "basic", true)).toEqual({
      color: THEME.diff.add,
      bold: true,
      underline: true,
    });
    expect(diffStylePlan("del", "mono", false)).toEqual({});
    expect(diffStylePlan("del", "mono", true)).toEqual({});
    expect(diffStylePlan("context", "mono", true)).toEqual({});
    expect(diffStylePlan("context", "extended", true)).toEqual({ dimColor: true });
  });
});
