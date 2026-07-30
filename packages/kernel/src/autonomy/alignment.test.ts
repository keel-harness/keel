import { describe, expect, it } from "vitest";
import type { SessionEventT } from "@keel/shared";
import { evaluateAlignment } from "./alignment.js";

const ts = "2026-06-15T00:00:00.000Z";

/** A confirmed edit to `path` (assistant tool-call + its tool_result) — what `deriveTaskFacts` counts. */
function editPair(id: string, path: string): SessionEventT[] {
  return [
    {
      type: "assistant",
      v: 1,
      ts,
      content: "",
      toolCalls: [{ id, name: "edit", args: { path, oldString: "a", newString: "b" } }],
    },
    { type: "tool_result", v: 1, ts, toolCallId: id, name: "edit", output: "edited" },
  ];
}

const session = (...pairs: SessionEventT[][]): SessionEventT[] => [
  { type: "user", v: 1, ts, content: "do the task" },
  ...pairs.flat(),
];

describe("evaluateAlignment (§4.9.6 — non-security intent-alignment heuristics over the ledger)", () => {
  it("a session within the (default medium) scope budget raises no signal", () => {
    const signals = evaluateAlignment({
      events: session(editPair("e1", "a.ts"), editPair("e2", "b.ts")),
    });
    expect(signals).toEqual([]);
  });

  it("scope budget: exceeding the medium file budget (>10) triggers a review signal", () => {
    const pairs = Array.from({ length: 11 }, (_, i) =>
      editPair(`e${String(i)}`, `f${String(i)}.ts`),
    );
    const signals = evaluateAlignment({ events: session(...pairs) });
    const scope = signals.find((s) => s.kind === "scope_budget_exceeded");
    expect(scope).toBeDefined();
    expect(scope?.detail).toMatch(/11 files/);
  });

  it("scope budget: the small tier is stricter (>3 files)", () => {
    const pairs = Array.from({ length: 4 }, (_, i) =>
      editPair(`e${String(i)}`, `f${String(i)}.ts`),
    );
    const signals = evaluateAlignment({ events: session(...pairs), tier: "small" });
    expect(signals.some((s) => s.kind === "scope_budget_exceeded")).toBe(true);
  });

  it("broad-rewrite guard: a dependency-manifest change always fires (even within budget)", () => {
    const signals = evaluateAlignment({ events: session(editPair("e1", "package.json")) });
    const broad = signals.find((s) => s.kind === "broad_rewrite");
    expect(broad?.detail).toMatch(/dependenc/i);
  });

  it("broad-rewrite guard: edits spanning multiple packages fire the multi-package signal", () => {
    const signals = evaluateAlignment({
      events: session(
        editPair("e1", "packages/kernel/src/x.ts"),
        editPair("e2", "packages/warden/src/y.ts"),
      ),
    });
    const broad = signals.find((s) => s.kind === "broad_rewrite");
    expect(broad?.detail).toMatch(/package/i);
  });

  it("low-confidence stop: the same file edited repeatedly is a thrash signal", () => {
    const signals = evaluateAlignment({
      events: session(
        editPair("e1", "loop.ts"),
        editPair("e2", "loop.ts"),
        editPair("e3", "loop.ts"),
      ),
    });
    const lc = signals.find((s) => s.kind === "low_confidence");
    expect(lc?.detail).toMatch(/loop\.ts/);
    expect(lc?.recommendation.length).toBeGreaterThan(0);
  });

  it("every signal carries an actionable recommendation and is advisory (no verdict/deny semantics)", () => {
    const pairs = Array.from({ length: 11 }, (_, i) =>
      editPair(`e${String(i)}`, `f${String(i)}.ts`),
    );
    const signals = evaluateAlignment({ events: session(...pairs) });
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) {
      expect(s.recommendation.length).toBeGreaterThan(0);
      expect(["scope_budget_exceeded", "broad_rewrite", "low_confidence"]).toContain(s.kind);
    }
  });
});
