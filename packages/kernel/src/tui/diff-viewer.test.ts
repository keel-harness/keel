import { describe, expect, it } from "vitest";
import type { DiffLine, ViewItem } from "@keel/shared";
import {
  collectDiffViewerFiles,
  initialDiffViewerState,
  normalizeDiffViewerState,
  planDiffViewer,
  reduceDiffViewer,
  type DiffViewerState,
} from "./diff-viewer.js";

function changedLines(prefix: string, hunks = 1): DiffLine[] {
  return Array.from({ length: hunks }, (_, index) => [
    {
      kind: "context" as const,
      text: `${prefix}-context-${String(index)}`,
      observedBeforeLine: index * 10 + 1,
      installedAfterLine: index * 10 + 1,
      hunkStart: true,
    },
    {
      kind: "del" as const,
      text: `${prefix}-old-${String(index)}`,
      observedBeforeLine: index * 10 + 2,
    },
    {
      kind: "add" as const,
      text: `${prefix}-new-${String(index)}`,
      installedAfterLine: index * 10 + 2,
    },
  ]).flat();
}

function tool(
  id: string,
  path: string,
  diff: readonly DiffLine[] = changedLines(id),
  withPresentation = true,
): Extract<ViewItem, { readonly kind: "tool" }> {
  return {
    kind: "tool",
    id,
    name: "edit",
    status: "ok",
    summary: `requested:${path}`,
    diff,
    ...(withPresentation
      ? {
          mutationPresentation: {
            status: "available" as const,
            operation: "edit" as const,
            displayPath: path,
            observedBefore: {
              status: "file-observed" as const,
              bytes: 3,
              mode: 0o644,
              contentClass: "text" as const,
              finalNewline: true,
            },
            verifiedInstalledAfter: {
              status: "file-observed" as const,
              bytes: 3,
              mode: 0o644,
              contentClass: "text" as const,
              finalNewline: true,
            },
            coverage: "complete" as const,
            observedBeforeLines: 3,
            installedAfterLines: 3,
            shownLines: diff.length,
            hiddenLines: 0,
            transitionBinding: "not-atomic" as const,
            concurrentMutation: "not-excluded" as const,
          },
        }
      : {}),
  };
}

describe("focused diff viewer — bounded artifact selection", () => {
  it("collects only settled changed comparisons and uses the producer-redacted display path", () => {
    const items: ViewItem[] = [
      { kind: "message", role: "assistant", content: "done" },
      tool("a", "src/a.ts"),
      { ...tool("running", "src/running.ts"), status: "running" },
      { ...tool("failed", "src/failed.ts"), status: "error" },
      tool("context-only", "src/context.ts", [{ kind: "context", text: "same", hunkStart: true }]),
      tool("hostile", "src/\u0000safe.ts"),
    ];

    const collection = collectDiffViewerFiles(items);

    expect(collection.hiddenFiles).toBe(0);
    expect(collection.files.map((file) => file.id)).toEqual(["a", "hostile"]);
    expect(collection.files.map((file) => file.path)).toEqual(["src/a.ts", "src/safe.ts"]);
    expect(collection.files[0]?.evidence).toEqual({
      transitionBinding: "not-atomic",
      concurrentMutation: "not-excluded",
    });
  });

  it("retains the latest bounded file set and discloses the exact earlier count", () => {
    const collection = collectDiffViewerFiles(
      Array.from({ length: 35 }, (_, index) => tool(`tool-${String(index)}`, `src/${index}.ts`)),
    );

    expect(collection.files).toHaveLength(32);
    expect(collection.hiddenFiles).toBe(3);
    expect(collection.files[0]?.id).toBe("tool-3");
    expect(collection.files.at(-1)?.id).toBe("tool-34");
  });

  it("distinguishes repeated provider tool ids by their exact visible occurrence", () => {
    const collection = collectDiffViewerFiles([
      tool("reused", "src/first.ts"),
      tool("reused", "src/second.ts"),
    ]);
    const state = initialDiffViewerState(collection.files);

    expect(collection.files[0]?.occurrenceKey).not.toBe(collection.files[1]?.occurrenceKey);
    expect(state.files[0]?.occurrenceKey).not.toBe(state.files[1]?.occurrenceKey);
  });

  it("keeps ordinary comparisons evidence-free and applies reviewed generated-file folding", () => {
    const ordinary = tool("ordinary", "requested.ts", changedLines("ordinary"), false);
    const collection = collectDiffViewerFiles([
      { ...ordinary, subject: "src/ordinary.ts" },
      tool("lock", "pnpm-lock.yaml", changedLines("lock", 2)),
    ]);

    expect(collection.files[0]).toMatchObject({ path: "src/ordinary.ts" });
    expect(collection.files[0]?.evidence).toBeUndefined();
    expect(initialDiffViewerState(collection.files).files[1]?.collapsedHunks).toEqual([0, 1]);
  });

  it("neutralizes controls without erasing meaningful path whitespace", () => {
    const collection = collectDiffViewerFiles([tool("spaced", "  src/space name.ts  ")]);

    expect(collection.files[0]?.path).toBe("  src/space name.ts  ");
  });
});

describe("focused diff viewer — pure focus reducer", () => {
  const collection = collectDiffViewerFiles([
    tool("a", "src/a.ts", changedLines("a", 2)),
    tool("b", "src/b.ts", changedLines("b", 2)),
  ]);

  it("retains each file's exact row/change/hunk position while tabbing away and back", () => {
    let state = initialDiffViewerState(collection.files);
    state = reduceDiffViewer(collection.files, state, { kind: "next-change" });
    state = reduceDiffViewer(collection.files, state, { kind: "next-row" });
    const firstFile = state.files[0];

    state = reduceDiffViewer(collection.files, state, { kind: "next-file" });
    state = reduceDiffViewer(collection.files, state, { kind: "next-row" });
    state = reduceDiffViewer(collection.files, state, { kind: "previous-file" });

    expect(state.fileIndex).toBe(0);
    expect(state.files[0]).toEqual(firstFile);
    expect(state.files[0]).toMatchObject({ selectedChange: 1, selectedHunk: 1 });
  });

  it("clamps row/change/file motion and folds only the selected hunk", () => {
    let state = initialDiffViewerState(collection.files);
    state = reduceDiffViewer(collection.files, state, { kind: "previous-row" });
    state = reduceDiffViewer(collection.files, state, { kind: "previous-change" });
    state = reduceDiffViewer(collection.files, state, { kind: "previous-file" });
    expect(state).toEqual(initialDiffViewerState(collection.files));

    state = reduceDiffViewer(collection.files, state, { kind: "toggle-hunk" });
    expect(state.files[0]?.collapsedHunks).toEqual([0]);
    state = reduceDiffViewer(collection.files, state, { kind: "toggle-hunk" });
    expect(state.files[0]?.collapsedHunks).toEqual([]);

    for (let index = 0; index < 20; index += 1) {
      state = reduceDiffViewer(collection.files, state, { kind: "next-file" });
      state = reduceDiffViewer(collection.files, state, { kind: "next-change" });
      state = reduceDiffViewer(collection.files, state, { kind: "next-row" });
    }
    expect(state.fileIndex).toBe(1);
    expect(state.files[1]).toMatchObject({ selectedLine: 5, selectedChange: 1, selectedHunk: 1 });
  });

  it("does not apply stale coordinates to a different visible occurrence", () => {
    const initial = initialDiffViewerState(collection.files);
    const stale: DiffViewerState = {
      fileIndex: 1,
      files: initial.files.map((file, index) => ({
        ...file,
        occurrenceKey: `stale-${String(index)}`,
        selectedLine: 999,
        selectedHunk: 999,
        selectedChange: 999,
        collapsedHunks: [999],
      })),
    };

    expect(normalizeDiffViewerState(collection.files, stale)).toEqual(initial);
  });

  it("treats a folded hunk as one visible row and expands a change selected inside a fold", () => {
    let state = initialDiffViewerState(collection.files);
    state = reduceDiffViewer(collection.files, state, { kind: "toggle-hunk" });

    state = reduceDiffViewer(collection.files, state, { kind: "next-row" });
    expect(state.files[0]).toMatchObject({ selectedLine: 3, selectedHunk: 1 });

    state = reduceDiffViewer(collection.files, state, { kind: "toggle-hunk" });
    expect(state.files[0]?.collapsedHunks).toEqual([0, 1]);
    state = reduceDiffViewer(collection.files, state, { kind: "previous-change" });
    expect(state.files[0]).toMatchObject({
      selectedLine: 1,
      selectedHunk: 0,
      selectedChange: 0,
      collapsedHunks: [1],
    });
  });
});

describe("focused diff viewer — bounded viewport plan", () => {
  it("keeps the selected late change visible and reports exact omitted rows at narrow height", () => {
    const lines = changedLines("many", 18);
    const collection = collectDiffViewerFiles([tool("many", "src/many.ts", lines)]);
    let state = initialDiffViewerState(collection.files);
    for (let index = 0; index < 17; index += 1) {
      state = reduceDiffViewer(collection.files, state, { kind: "next-change" });
    }

    const plan = planDiffViewer(collection, state, { columns: 60, rows: 10 });

    expect(plan.filePosition).toEqual({ current: 1, total: 1, hiddenEarlier: 0 });
    expect(plan.hunkPosition).toEqual({ current: 18, total: 18 });
    expect(plan.changePosition).toEqual({ current: 18, total: 18 });
    expect(plan.fileSummary).toEqual({ added: 18, deleted: 18, rows: 54 });
    expect(plan.rows.length).toBeLessThanOrEqual(6);
    expect(plan.rows.some((row) => row.selected)).toBe(true);
    expect(plan.hiddenBefore + plan.hiddenAfter).toBeGreaterThan(0);
    expect(plan.evidenceLine).toBe(
      "observed before → verified installed after · transition not atomic · concurrent mutation not excluded",
    );
  });

  it("replaces an expanded hunk with one mono-safe summary row when collapsed", () => {
    const collection = collectDiffViewerFiles([tool("a", "src/a.ts", changedLines("a", 2))]);
    const state = reduceDiffViewer(collection.files, initialDiffViewerState(collection.files), {
      kind: "toggle-hunk",
    });

    const plan = planDiffViewer(collection, state, { columns: 80, rows: 18 });

    expect(plan.rows).toHaveLength(1);
    const summary = plan.rows[0];
    expect(summary?.kind).toBe("hunk-summary");
    if (summary?.kind !== "hunk-summary") throw new Error("expected a folded hunk summary");
    expect(summary.selected).toBe(true);
    expect(summary.text).toMatch(/^▶ hunk 1\/2 · \+1 -1 · 3 rows$/);
  });

  it("rejects invalid terminal geometry instead of producing an ambiguous layout", () => {
    const collection = collectDiffViewerFiles([tool("a", "src/a.ts")]);
    const state = initialDiffViewerState(collection.files);

    expect(() => planDiffViewer(collection, state, { columns: 19, rows: 10 })).toThrow(RangeError);
    expect(() => planDiffViewer(collection, state, { columns: 80, rows: 5 })).toThrow(RangeError);
  });

  it("splits counts and semantic chrome deliberately at the detail-width floor", () => {
    const collection = collectDiffViewerFiles([tool("a", "src/a.ts")]);
    const plan = planDiffViewer(collection, initialDiffViewerState(collection.files), {
      columns: 20,
      rows: 30,
    });

    expect(plan.fileSummaryLines).toEqual(["+1 -1", "3 source rows"]);
    expect(plan.titleLines.length).toBeGreaterThan(1);
    expect(plan.evidenceLines.join("")).toContain("transition not atomic");
    expect(plan.footerLines.join("")).toContain("enter/space fold · esc close");
  });
});
