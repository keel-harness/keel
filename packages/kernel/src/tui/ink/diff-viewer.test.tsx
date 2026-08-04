import { afterEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { ViewItem } from "@keel/shared";
import {
  collectDiffViewerFiles,
  initialDiffViewerState,
  reduceDiffViewer,
} from "../diff-viewer.js";
import { terminalDisplayWidth } from "../display-cells.js";
import { DiffViewer } from "./diff-viewer.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function fixture(): ReturnType<typeof collectDiffViewerFiles> {
  const items: ViewItem[] = [
    {
      kind: "tool",
      id: "viewer-fixture",
      name: "edit",
      status: "ok",
      summary: "src/deep/example.ts",
      diff: Array.from({ length: 12 }, (_, index) => [
        {
          kind: "context" as const,
          text: `context-${index}`,
          observedBeforeLine: index * 10 + 1,
          installedAfterLine: index * 10 + 1,
          hunkStart: true,
        },
        {
          kind: "del" as const,
          text: `before-${index}-${"界".repeat(30)}`,
          observedBeforeLine: index * 10 + 2,
        },
        {
          kind: "add" as const,
          text: `after-${index}-${"👩🏽‍💻".repeat(20)}`,
          installedAfterLine: index * 10 + 2,
        },
      ]).flat(),
    },
  ];
  return collectDiffViewerFiles(items);
}

function chromeHeavyFixture(): ReturnType<typeof collectDiffViewerFiles> {
  return collectDiffViewerFiles(
    Array.from(
      { length: 35 },
      (_, fileIndex): ViewItem => ({
        kind: "tool",
        id: `viewer-${String(fileIndex)}`,
        name: "edit",
        status: "ok",
        summary: `requested-${String(fileIndex)}`,
        diff: Array.from({ length: 60 }, (_, lineIndex) => ({
          kind: lineIndex % 2 === 0 ? ("del" as const) : ("add" as const),
          text: `${lineIndex % 2 === 0 ? "old" : "new"}-${String(lineIndex)}-${"界".repeat(30)}`,
          ...(lineIndex === 0 ? { hunkStart: true } : {}),
        })),
        mutationPresentation: {
          status: "available",
          operation: "edit",
          displayPath: `src/${"deep/".repeat(15)}file-${String(fileIndex)}.ts`,
          observedBefore: {
            status: "file-observed",
            bytes: 100,
            mode: 0o644,
            contentClass: "text",
            finalNewline: true,
          },
          verifiedInstalledAfter: {
            status: "file-observed",
            bytes: 100,
            mode: 0o644,
            contentClass: "text",
            finalNewline: true,
          },
          coverage: "complete",
          observedBeforeLines: 60,
          installedAfterLines: 60,
          shownLines: 60,
          hiddenLines: 0,
          transitionBinding: "not-atomic",
          concurrentMutation: "not-excluded",
        },
      }),
    ),
  );
}

function unavailableFixture(): ReturnType<typeof collectDiffViewerFiles> {
  return collectDiffViewerFiles(
    [
      { kind: "message", role: "user", content: "inspect the generated file" },
      {
        kind: "tool",
        id: "unavailable-edit",
        name: "edit",
        status: "ok",
        summary: "request-only/private/generated.ts",
        mutationPresentation: { status: "unavailable", reason: "capture-budget" },
      },
    ],
    { title: "done", changed: [], checked: [], attention: [] },
  );
}

describe("Ink focused diff viewer", () => {
  it.each([
    [40, 18],
    [60, 20],
    [80, 24],
    [120, 40],
  ] as const)("keeps selection and disclosure bounded at %ix%i", (columns, rows) => {
    const collection = fixture();
    let state = initialDiffViewerState(collection.files);
    for (let index = 0; index < 11; index += 1) {
      state = reduceDiffViewer(collection.files, state, { kind: "next-change" });
    }
    const frame =
      render(
        <DiffViewer collection={collection} state={state} columns={columns} rows={rows} />,
      ).lastFrame() ?? "";
    const physical = frame.split("\n");

    expect(frame).toContain("change 12/12");
    expect(frame).toContain("›");
    expect(frame).toContain("earlier source rows");
    expect(physical.length).toBeLessThanOrEqual(rows);
    expect(physical.every((line) => terminalDisplayWidth(line) <= columns)).toBe(true);
  });

  it("keeps worst-case disclosure chrome inside the 40x18 physical budget", () => {
    const collection = chromeHeavyFixture();
    let state = initialDiffViewerState(collection.files);
    for (let page = 0; page < 4; page += 1) {
      state = reduceDiffViewer(collection.files, state, { kind: "page-down" });
    }

    const frame =
      render(
        <DiffViewer collection={collection} state={state} columns={40} rows={18} />,
      ).lastFrame() ?? "";
    const physical = frame.split("\n");

    expect(frame).toContain("3 earlier files outside this review");
    expect(frame).toContain("path cells hidden");
    expect(frame).toContain("+30 -30 · 60 source rows");
    expect(frame).toContain("transition not atomic");
    expect(frame).toContain("earlier source rows");
    expect(frame).toContain("later source rows");
    expect(physical.length).toBeLessThanOrEqual(18);
    expect(physical.every((line) => terminalDisplayWidth(line) <= 40)).toBe(true);
  });

  it.each([
    [12, 4],
    [40, 6],
  ] as const)("uses one bounded resize fallback row at %ix%i", (columns, rows) => {
    const collection = fixture();
    const frame =
      render(
        <DiffViewer
          collection={collection}
          state={initialDiffViewerState(collection.files)}
          columns={columns}
          rows={rows}
        />,
      ).lastFrame() ?? "";

    expect(frame).toContain("diff review");
    expect(frame.split("\n")).toHaveLength(1);
    expect(terminalDisplayWidth(frame)).toBeLessThanOrEqual(columns);
  });

  it.each([
    [{ NO_COLOR: "1" }, "no-color"],
    [{ FORCE_COLOR: "0" }, "force-color-zero"],
    [{ TERM: "dumb" }, "dumb"],
  ] as const)("retains markers and labels in %s mode", (env, _label) => {
    process.env = { ...originalEnv, ...env };
    const collection = fixture();
    const frame =
      render(
        <DiffViewer
          collection={collection}
          state={initialDiffViewerState(collection.files)}
          columns={60}
          rows={20}
        />,
      ).lastFrame() ?? "";

    expect(frame).toMatch(/\d\s+-\s*$/mu);
    expect(frame).toMatch(/\d\s+\+\s+after-/u);
    expect(frame).toContain("reviewing changes");
    expect(frame).toContain("esc close");
  });

  it("renders an all-unavailable review as a focused, bounded, non-destructive state", () => {
    const collection = unavailableFixture();
    const frame =
      render(
        <DiffViewer
          collection={collection}
          state={initialDiffViewerState(collection.files)}
          columns={80}
          rows={24}
        />,
      ).lastFrame() ?? "";

    expect(frame).toContain("review evidence unavailable");
    expect(frame).toContain("observation unavailable");
    expect(frame).toContain("exceeded presentation limits");
    expect(frame).toContain("verification not run");
    expect(frame).toContain("automatic undo unavailable");
    expect(frame).toContain("esc close");
    expect(frame).not.toMatch(/request-only|git restore|definitely safe/iu);
    expect(frame.split("\n").length).toBeLessThanOrEqual(24);
  });

  it.each([
    [{ NO_COLOR: "1" }, "no-color"],
    [{ TERM: "dumb" }, "dumb"],
  ] as const)("keeps unavailable meaning without color in %s mode", (env, _label) => {
    process.env = { ...originalEnv, ...env };
    const collection = unavailableFixture();
    const frame =
      render(
        <DiffViewer
          collection={collection}
          state={initialDiffViewerState(collection.files)}
          columns={40}
          rows={18}
        />,
      ).lastFrame() ?? "";

    expect(frame).toContain("unavailable");
    expect(frame).toContain("verification not run");
    expect(frame).toContain("esc close");
    expect(frame.split("\n").every((line) => terminalDisplayWidth(line) <= 40)).toBe(true);
  });
});
