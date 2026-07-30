import { describe, expect, it } from "vitest";
import type { UiToolActivity } from "@keel/shared";
import {
  markToolPresentationOutcome,
  type ToolPresentationOutcome,
} from "../tool-presentation-outcome.js";
import { terminalDisplayWidth } from "./display-cells.js";
import { toolCardPlan } from "./tool-card.js";
import { markReviewSettlementPresentation } from "./review-settlement-presentation.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const tool = (overrides: Partial<UiToolActivity> = {}): UiToolActivity => ({
  kind: "tool",
  id: "c0",
  name: "bash",
  status: "ok",
  summary: "41 passed",
  ...overrides,
});

type AvailableMutationPresentation = Extract<
  NonNullable<UiToolActivity["mutationPresentation"]>,
  { readonly status: "available" }
>;

const availableMutation = (
  overrides: Partial<AvailableMutationPresentation> = {},
): AvailableMutationPresentation => ({
  status: "available",
  operation: "edit",
  displayPath: "src/app.ts",
  observedBefore: {
    status: "file-observed",
    bytes: 12,
    mode: 0o644,
    contentClass: "text",
    finalNewline: true,
  },
  verifiedInstalledAfter: {
    status: "file-observed",
    bytes: 13,
    mode: 0o644,
    contentClass: "text",
    finalNewline: true,
  },
  coverage: "complete",
  observedBeforeLines: 3,
  installedAfterLines: 4,
  shownLines: 5,
  hiddenLines: 0,
  transitionBinding: "not-atomic",
  concurrentMutation: "not-excluded",
  ...overrides,
});

describe("tool-card plan", () => {
  it("turns a successful tool into a collapsed result card", () => {
    expect(toolCardPlan(tool(), undefined)).toMatchObject({
      glyph: "✓",
      tone: "success",
      title: "bash",
      statusLabel: "done",
      summaryLabel: "result",
      summary: "41 passed",
    });
  });

  it("turns a failed tool into an error card with recovery copy", () => {
    const plan = toolCardPlan(tool({ status: "error", summary: "permission denied" }), undefined);
    expect(plan).toMatchObject({
      glyph: "✗",
      tone: "danger",
      statusLabel: "failed",
      summaryLabel: "error",
      summary: "permission denied",
    });
    expect(plan.recovery).toMatch(/next:/i);
  });

  it("never adds retry guidance to an indeterminate timed-out review", () => {
    const item = markReviewSettlementPresentation(
      markToolPresentationOutcome(
        tool({
          status: "error",
          summary:
            "review outcome indeterminate · action may have executed · do not retry automatically · inspect audit",
        }),
        "partial",
      ),
      "partial",
    );

    expect(toolCardPlan(item, undefined).recovery).toBe(
      "next: restart and inspect audit before deciding again",
    );
    expect(toolCardPlan(item, undefined).recovery).not.toContain("retry");
  });

  it("does not turn successful tool content into controller-owned review recovery", () => {
    const plan = toolCardPlan(
      tool({
        name: "read",
        summary: "document says do not retry automatically; inspect audit",
      }),
      undefined,
    );

    expect(plan.statusLabel).toBe("done");
    expect(plan.recovery).toBeUndefined();
  });

  it("keeps copied review phrases inside an ordinary failure on generic recovery", () => {
    const plan = toolCardPlan(
      markToolPresentationOutcome(
        tool({
          status: "error",
          summary: "stderr: do not retry automatically; inspect audit",
        }),
        "failed",
      ),
      undefined,
    );

    expect(plan.statusLabel).toBe("failed");
    expect(plan.recovery).toBe("next: correct the input or revise the request, then retry");
  });

  it.each([
    {
      outcome: "partial" as const,
      summary:
        "review outcome indeterminate · action may have executed · do not retry automatically · inspect audit",
      recovery: "next: inspect the target before retrying",
    },
    {
      outcome: "failed" as const,
      summary:
        "review settlement failed · review may remain pending · do not retry automatically · restart session",
      recovery: "next: correct the input or revise the request, then retry",
    },
  ])(
    "does not authenticate an ordinary $outcome edit from a canonical-looking path",
    ({ outcome, summary, recovery }) => {
      const item = markToolPresentationOutcome(
        tool({ name: "edit", status: "error", summary }),
        outcome,
      );

      expect(toolCardPlan(item, undefined).recovery).toBe(recovery);
    },
  );

  it("distinguishes a requested tool from executor-confirmed liveness", () => {
    expect(
      toolCardPlan(
        tool({ status: "running", summary: "", liveOutput: "compiling foo.ts" }),
        undefined,
      ),
    ).toMatchObject({
      glyph: "⋯",
      tone: "info",
      statusLabel: "requested",
      liveOutput: "compiling foo.ts",
    });
    expect(
      toolCardPlan(
        tool({
          status: "running",
          summary: "",
          liveness: { elapsedMs: 200, quietMs: 20 },
        }),
        undefined,
      ),
    ).toMatchObject({
      glyph: "⋯",
      tone: "info",
      statusLabel: "checking",
    });
    expect(
      toolCardPlan(
        tool({
          status: "running",
          summary: "",
          liveOutput: "compiling foo.ts",
          liveness: { elapsedMs: 200, quietMs: 20 },
        }),
        undefined,
      ),
    ).toMatchObject({
      glyph: "⋯",
      tone: "info",
      statusLabel: "running",
      liveOutput: "compiling foo.ts",
    });
    expect(toolCardPlan(tool({ liveOutput: "stale" }), undefined).liveOutput).toBeUndefined();
  });

  it.each([
    ["limited", "ok", "output was truncated", "limited", "~", "warning", "limited"],
    [
      "partial",
      "error",
      "target may have changed; inspect before retrying",
      "partial",
      "~",
      "warning",
      "partial",
    ],
    [
      "review",
      "error",
      "warden review required (not executed): POL-003 review",
      "review",
      "!",
      "warning",
      "review needed",
    ],
    [
      "blocked",
      "error",
      "blocked by warden (not executed): POL-002 deny outside workspace",
      "blocked",
      "✗",
      "danger",
      "blocked",
    ],
    [
      "skipped",
      "error",
      "skipped: loop detected — this call was not run",
      "skipped",
      "○",
      "warning",
      "skipped",
    ],
    [
      "stopped",
      "error",
      "aborted: the run was cancelled before this tool executed.",
      "stopped",
      "■",
      "warning",
      "stopped",
    ],
  ] as const)(
    "renders a color-independent %s outcome",
    (_name, status, summary, outcome, glyph, tone, statusLabel) => {
      const item = markToolPresentationOutcome(
        tool({ status, summary }),
        outcome as ToolPresentationOutcome,
      );
      expect(toolCardPlan(item, undefined)).toMatchObject({
        glyph,
        tone,
        statusLabel,
      });
    },
  );

  it("keeps policy-like text from an ordinary failed tool non-authoritative", () => {
    const plan = toolCardPlan(
      tool({
        status: "error",
        summary: "exit 1 · stderr: blocked by warden; pending approval",
      }),
      undefined,
    );

    expect(plan.statusLabel).toBe("failed");
    expect(plan.glyph).toBe("✗");
  });

  it("uses /diff as the semantic zoom control for edit details", () => {
    const item = tool({
      name: "edit",
      summary: "src/app.ts",
      diff: [
        { kind: "del", text: "old" },
        { kind: "add", text: "new" },
      ],
    });
    expect(toolCardPlan(item, "compact").diff).toEqual({ compact: { added: 1, deleted: 1 } });
    expect(toolCardPlan(item, "full").diff).toMatchObject({
      lines: [
        { kind: "del", text: "old" },
        { kind: "add", text: "new" },
      ],
    });
  });

  it("keeps the bounded redacted producer path intact for filename-first full layout", () => {
    const displayPath = `src/${"nested/".repeat(20)}example.ts`;
    const plan = toolCardPlan(
      tool({
        name: "edit",
        summary: "requested-path-that-is-not-authority.ts",
        diff: [{ kind: "add", text: "verified", installedAfterLine: 1, hunkStart: true }],
        mutationPresentation: availableMutation({ displayPath }),
      }),
      "full",
    );

    expect(plan.summary).not.toBe(displayPath);
    expect(plan.diff?.path).toBe(displayPath);
  });

  it("labels observed and verified mutation evidence without claiming an exact transition", () => {
    const plan = toolCardPlan(
      tool({
        name: "edit",
        summary: "src/app.ts",
        mutationPresentation: availableMutation(),
      }),
      "full",
    );

    expect(plan.mutationReview?.lines).toEqual([
      "review  src/app.ts",
      "evidence  observed before → verified installed after · 3 → 4 lines",
      "scope  transition not atomic · concurrent mutation not excluded",
    ]);
    expect(JSON.stringify(plan)).not.toMatch(/exact diff|created|modified|removed/iu);
  });

  it.each([
    ["complete", 3, 4, "comparison  complete · 3 rows shown · 4 unchanged rows omitted"],
    ["complete", 0, "unknown", "comparison  no differing rows · unchanged row count unknown"],
    ["summary-only", 0, "unknown", "comparison  summary only · line content unavailable"],
    ["unknown", "unknown", "unknown", "comparison  unavailable · totals unknown"],
  ] as const)(
    "discloses %s comparison coverage with shown=%s and hidden=%s",
    (coverage, shownLines, hiddenLines, expected) => {
      const lines =
        toolCardPlan(
          tool({
            name: "edit",
            mutationPresentation: availableMutation({ coverage, shownLines, hiddenLines }),
          }),
          "full",
        ).mutationReview?.lines ?? [];

      expect(lines).toContain(expected);
    },
  );

  it.each([
    ["capability-unavailable", "governed observation capture is not available"],
    ["capture-budget", "observation exceeded presentation limits"],
    ["redaction-failed", "safe display could not be produced"],
    ["not-found-or-consumed", "review artifact unavailable or already consumed"],
    ["transport-failed", "presentation channel did not settle"],
    ["occurrence-ended", "occurrence ended before display"],
  ] as const)("turns %s into calm user-facing copy", (reason, expected) => {
    const plan = toolCardPlan(
      tool({
        name: "edit",
        summary: "src/app.ts",
        mutationPresentation: { status: "unavailable", reason },
      }),
      "full",
    );

    expect(plan.mutationReview?.lines.join("\n")).toContain(expected);
    expect(plan.mutationReview?.lines.join("\n")).not.toContain(reason);
  });

  it.each(["workspace-effects-not-captured", "live-observations-not-persisted"] as const)(
    "renders the %s gap as an explicit non-authority state",
    (reason) => {
      const copy =
        toolCardPlan(
          tool({ mutationPresentation: { status: "unavailable", reason } }),
          "full",
        ).mutationReview?.lines.join("\n") ?? "";

      expect(copy).toContain(
        reason === "workspace-effects-not-captured"
          ? "workspace effects  not captured for this tool"
          : "review  unavailable — live mutation observations were not persisted",
      );
      expect(copy).not.toContain(reason);
    },
  );

  it("triages high-noise edit files as compact by default without risk verdicts", () => {
    const item = tool({
      name: "edit",
      summary: "pnpm-lock.yaml",
      diff: [
        { kind: "del", text: "old" },
        { kind: "add", text: "new" },
      ],
    });
    const diff = toolCardPlan(item, undefined).diff;
    expect(diff?.compact).toEqual({ added: 1, deleted: 1 });
    expect(diff?.lines).toBeUndefined();
    expect(diff?.triage).toMatchObject({
      kind: "lockfile",
      collapsed: true,
    });
    expect(JSON.stringify(diff)).not.toMatch(/approved|policy review|trusted|critical/i);
  });

  it("bounds and sanitizes tool-chosen labels and summaries before renderers map them", () => {
    const plan = toolCardPlan(
      tool({
        name: `bash${ESC}[2J`,
        status: "error",
        summary: `${ESC}[31m${"x".repeat(600)}${BEL}`,
        liveOutput: `${ESC}[2J${"y".repeat(600)}`,
      }),
      undefined,
    );

    expect(plan.title).toContain("bash");
    expect(plan.title).not.toContain(ESC);
    expect(plan.summary).toBeDefined();
    expect(plan.summary!.length).toBeLessThanOrEqual(121);
    expect(plan.summary).toContain("…");
    expect(JSON.stringify(plan)).not.toContain(ESC);
    expect(JSON.stringify(plan)).not.toContain(BEL);
    expect(JSON.stringify(plan).length).toBeLessThan(600);
  });

  it("preserves the distinguishing tail of a long tool result", () => {
    const plan = toolCardPlan(
      tool({
        status: "error",
        summary: `blocked ${"same middle ".repeat(20)}/outside/important-file.txt`,
      }),
      undefined,
    );

    expect(plan.summary).toContain("…");
    expect(plan.summary).toContain("/outside/important-file.txt");
  });

  it("bounds wide and joined Unicode tool copy by terminal cells without losing the recovery tail", () => {
    const plan = toolCardPlan(
      tool({
        name: `edit-${"界".repeat(30)}-👩🏽‍💻`,
        status: "error",
        summary: `blocked ${"界".repeat(80)} e\u0301 👩🏽‍💻 /outside/important-file.txt`,
      }),
      undefined,
    );

    expect(terminalDisplayWidth(plan.title)).toBeLessThanOrEqual(40);
    expect(terminalDisplayWidth(plan.summary ?? "")).toBeLessThanOrEqual(120);
    expect(plan.summary).toContain("/outside/important-file.txt");
    expect(plan.title).not.toMatch(/[\uD800-\uDFFF]$/u);
    expect(plan.summary).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
  });
});
