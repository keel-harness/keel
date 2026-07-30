import { describe, expect, it } from "vitest";
import { approvalNoticePlan } from "./approval-notice.js";
import { assistantStreamingProjection } from "./assistant-prose.js";
import { physicalRows, summarizeRowBudget, terminalDisplayWidth } from "./row-budget.js";
import { ALL_OFF_POSTURE, statusRows } from "./view-model.js";

describe("Epic 3.10 Slice 3B0 pre-extraction equivalence ledger", () => {
  it.each([
    ["plain ASCII", "keel", 4],
    ["combining mark", "e\u0301", 1],
    ["wide glyph", "界", 2],
    ["flag sequence", "🇨🇦", 2],
    ["skin-tone ZWJ sequence", "👩🏽‍💻", 2],
    ["tab stop", "a\tb", 9],
    ["final physical line", "wide\nx", 1],
  ] as const)("preserves the current %s cell result", (_label, value, expected) => {
    expect(terminalDisplayWidth(value)).toBe(expected);
  });

  it("preserves raw payload while wrapping at grapheme boundaries", () => {
    const source = "a\te\u0301🇨🇦界";
    const rows = physicalRows(source, 4);

    expect(rows.join("")).toBe(source);
    expect(rows).toEqual(["a", "\t", "e\u0301🇨🇦", "界"]);
    expect(summarizeRowBudget(source, 4)).toEqual({
      columns: 4,
      logicalLines: 1,
      physicalRows: 4,
      widestLine: 13,
    });
  });

  it("preserves assistant source bytes while retaining deterministic rendered tab expansion", () => {
    const source = "alpha\tbeta e\u0301 🇨🇦 👩🏽‍💻";
    const projection = assistantStreamingProjection(source, 12);

    expect(projection.source).toBe(source);
    expect(projection.lines.map((line) => line.text).join("")).toBe(
      source.replaceAll("\t", "    "),
    );
    expect(projection.lines.map((line) => [line.text, terminalDisplayWidth(line.text)])).toEqual([
      ["alpha    beta e\u0301 🇨🇦 ", 19],
      ["👩🏽‍💻", 2],
    ]);
  });

  it("preserves approval head/tail truncation at a grapheme boundary", () => {
    const detail = `command-head ${"界".repeat(1_100)} consequential-tail`;
    const plan = approvalNoticePlan({
      detail,
      sessionAvailable: false,
      state: "pending",
    });

    expect(plan.detail).toMatch(/^command-head /u);
    expect(plan.detail).toContain(" … ");
    expect(plan.detail).toMatch(/ consequential-tail$/u);
    expect(terminalDisplayWidth(plan.detail)).toBeLessThanOrEqual(2_048);
  });

  it("preserves current ASCII status rows before the shared-cell extraction", () => {
    expect(
      statusRows(
        {
          model: "anthropic/claude-sonnet-4-6",
          cwd: "/workspace/keel",
          tokens: 1_500,
          posture: ALL_OFF_POSTURE,
        },
        { columns: 60 },
      ),
    ).toEqual([
      "claude-sonnet-4-6 · 1.5k tokens",
      "protection: status not reported · do not infer enforcement",
      "sbx:off · net:off · p:off · aud:off",
    ]);
  });
});
