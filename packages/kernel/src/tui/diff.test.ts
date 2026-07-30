import { describe, expect, it } from "vitest";
import {
  editDiff,
  diffTriage,
  summarizeDiff,
  planDiffRender,
  compactStat,
  moreHint,
  MAX_DIFF_LINES,
} from "./diff.js";

describe("editDiff (minimal line diff from edit args)", () => {
  it("frames a one-line change with surrounding context", () => {
    expect(editDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "context", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "context", text: "c" },
    ]);
  });

  it("handles a pure replacement (no common context)", () => {
    expect(editDiff("x", "y")).toEqual([
      { kind: "del", text: "x" },
      { kind: "add", text: "y" },
    ]);
  });

  it("handles a pure addition (common prefix, new trailing line)", () => {
    expect(editDiff("a\nb", "a\nb\nc")).toEqual([
      { kind: "context", text: "a" },
      { kind: "context", text: "b" },
      { kind: "add", text: "c" },
    ]);
  });

  it("handles a pure deletion (removed middle line)", () => {
    expect(editDiff("a\nb\nc", "a\nc")).toEqual([
      { kind: "context", text: "a" },
      { kind: "del", text: "b" },
      { kind: "context", text: "c" },
    ]);
  });
});

describe("summarizeDiff (compact +A −D counts)", () => {
  it("counts added and deleted lines, ignoring context", () => {
    expect(summarizeDiff(editDiff("a\nb\nc", "a\nB\nc"))).toEqual({ added: 1, deleted: 1 });
    expect(summarizeDiff(editDiff("a\nb", "a\nb\nc"))).toEqual({ added: 1, deleted: 0 });
    expect(summarizeDiff(editDiff("a\nb\nc", "a\nc"))).toEqual({ added: 0, deleted: 1 });
  });

  it("is zero for an empty diff", () => {
    expect(summarizeDiff([])).toEqual({ added: 0, deleted: 0 });
  });
});

describe("planDiffRender (mode → what the renderers draw)", () => {
  const diff = editDiff("a\nb\nc", "a\nB\nc"); // context a · del b · add B · context c

  it("compact mode → just the magnitude", () => {
    expect(planDiffRender(diff, "compact")).toEqual({ compact: { added: 1, deleted: 1 } });
  });

  it("full mode (and undefined default) → the full per-line block, uncapped when small", () => {
    expect(planDiffRender(diff, "full")).toEqual({ lines: diff });
    expect(planDiffRender(diff, undefined)).toEqual({ lines: diff });
  });

  it("full mode over the cap → head lines + an honest tail summary (never silently dropped)", () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 5 }, (_, i) => ({
      kind: "add" as const,
      text: `l${i}`,
    }));
    const plan = planDiffRender(big, "full");
    expect(plan.lines).toHaveLength(MAX_DIFF_LINES);
    expect(plan.hidden).toBe(5); // count only — the magnitude lives in compact mode (QC F2)
  });

  it("at exactly the cap → no `hidden` (uncapped, all lines shown)", () => {
    const exact = Array.from({ length: MAX_DIFF_LINES }, (_, i) => ({
      kind: "add" as const,
      text: `l${i}`,
    }));
    const plan = planDiffRender(exact, "full");
    expect(plan.lines).toHaveLength(MAX_DIFF_LINES);
    expect(plan.hidden).toBeUndefined();
  });

  it("default-triages lockfiles to compact output, keeping the calm kind/collapsed hint only", () => {
    const plan = planDiffRender(diff, undefined, "pnpm-lock.yaml");
    expect(plan.lines).toBeUndefined();
    expect(plan.compact).toEqual({ added: 1, deleted: 1 });
    expect(plan.triage).toMatchObject({
      kind: "lockfile",
      collapsed: true,
      reason: "high-noise dependency lockfile",
    });
    // The chatty "risk labels deferred to phase 2" note is dropped from the triage card (Tier-C QC):
    // the honest no-risk-classification truth lives in the posture line, not on every diff.
    expect(JSON.stringify(plan.triage)).not.toMatch(/risk label|phase 2/i);
  });

  it("lets explicit full mode expand a triaged lockfile", () => {
    const plan = planDiffRender(diff, "full", "pnpm-lock.yaml");
    expect(plan.lines).toEqual(diff);
    expect(plan.triage).toMatchObject({ kind: "lockfile", collapsed: false });
  });
});

describe("diffTriage (file-level review hints, no Phase-1 risk badges)", () => {
  it("classifies lockfiles and generated files as default-collapsed", () => {
    expect(diffTriage("package-lock.json")).toMatchObject({
      kind: "lockfile",
      defaultCollapsed: true,
    });
    expect(diffTriage("src/client.generated.ts")).toMatchObject({
      kind: "generated",
      defaultCollapsed: true,
    });
  });

  it("treats ordinary source as source and never emits policy/risk verdict words", () => {
    const triage = diffTriage("src/app.ts");
    expect(triage).toMatchObject({ kind: "source", defaultCollapsed: false });
    expect(JSON.stringify(triage)).not.toMatch(/approved|policy|critical|safe|trusted/i);
  });
});

describe("compactStat (the `· +A -D` suffix — ASCII minus, suppress zero)", () => {
  it("formats +A -D with ASCII minus (copy/paste + grep friendly, matches the per-line sign)", () => {
    expect(compactStat({ added: 3, deleted: 1 })).toBe(" · +3 -1");
    expect(compactStat({ added: 0, deleted: 2 })).toBe(" · +0 -2");
  });
  it("is empty for a zero-magnitude (no-op / context-only) edit", () => {
    expect(compactStat({ added: 0, deleted: 0 })).toBe("");
  });
});

describe("moreHint (the honest cap footer)", () => {
  it("reports the hidden COUNT without promising a post-commit rewrite action", () => {
    expect(moreHint(20)).toBe("… 20 more lines hidden in this view");
    expect(moreHint(1)).toBe("… 1 more line hidden in this view"); // singular
  });

  it("reports wholly hidden hunk counts without confusing them with line counts", () => {
    expect(moreHint(12, 3)).toBe("… 12 lines · 3 hunks hidden");
    expect(moreHint(1, 1)).toBe("… 1 line · 1 hunk hidden");
  });
});
