import { describe, expect, it } from "vitest";
import { ALL_OFF_POSTURE, firstRunView, initialView, reduce } from "./view-model.js";
import { conversationPlan, transcriptCommitPlan } from "./conversation-block.js";
import { renderFrame } from "./headless.js";
import {
  responseSurfaceColumns,
  physicalRowCount,
  physicalRows,
  summarizeRowBudget,
  terminalDisplayWidth,
  visibleLineCount,
} from "./row-budget.js";
import type { ViewItem, ViewModel } from "@keel/shared";

const status = { model: "sonnet", tokens: 12, posture: ALL_OFF_POSTURE };

describe("responseSurfaceColumns", () => {
  it("caps the reading measure on wide terminals and preserves safe gutters when narrow", () => {
    expect(responseSurfaceColumns(160)).toBe(104);
    expect(responseSurfaceColumns(120)).toBe(104);
    expect(responseSurfaceColumns(80)).toBe(78);
    expect(responseSurfaceColumns(40)).toBe(38);
    expect(responseSurfaceColumns(1)).toBe(20);
  });
});

function firstAnswerView(): ViewModel {
  return {
    items: [
      { kind: "message", role: "user", content: "what is this project?" },
      { kind: "tool", id: "read-1", name: "read", status: "ok", summary: "# keel" },
      {
        kind: "message",
        role: "assistant",
        content:
          "This is keel, a local-first agent harness with warden-mediated tool execution and honest TUI receipts.",
      },
    ],
    status,
    streaming: false,
    awaitingInput: true,
    turnSummary: {
      title: "done",
      answer: "Explained the project.",
      changed: [],
      checked: [],
      ran: ["read: README.md"],
      attention: [],
    },
  };
}

function longSessionView(): ViewModel {
  const items: ViewItem[] = [];
  for (let i = 1; i <= 10; i += 1) {
    items.push({ kind: "message", role: "user", content: `turn ${i}: inspect one thing` });
    items.push({
      kind: "tool",
      id: `read-${i}`,
      name: "read",
      status: "ok",
      summary: `README slice ${i}`,
    });
    items.push({
      kind: "message",
      role: "assistant",
      content: `Turn ${i} answer. ${"Evidence stays calm. ".repeat(8)}`,
    });
  }
  return {
    items,
    status,
    streaming: false,
    awaitingInput: true,
    turnSummary: {
      title: "done",
      answer: "Finished the last inspection.",
      changed: [],
      checked: [],
      ran: ["read: README slice 10"],
      attention: [],
    },
  };
}

function reviewNeededView(): ViewModel {
  let view = initialView([{ role: "user", content: "run make" }], {
    model: "anthropic/claude-sonnet-4-6",
    cwd: "/home/u/keel-harness",
    policy: { active: true, label: "Guided · starter@abc123" },
    posture: { sandbox: true, egress: true, audit: true },
    lastWardenPendingReviews: 1,
  });
  view = reduce(view, { type: "tool-call", id: "review-1", name: "bash", args: {} });
  return reduce(view, {
    type: "tool-result",
    id: "review-1",
    ok: false,
    output:
      "warden review required (not executed): command review: command review for make in workspace /repo; [o] once [s] session [p] project (requires Project Autopilot) [d] deny [?] why; exact command envelope only; allow: keel approve command_review_1 --scope once --command-key sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
}

function launchPanelFrames(): ReadonlyArray<readonly [string, string]> {
  const base = initialView([], {
    model: "anthropic/claude-sonnet-4-6",
    cwd: "/home/u/keel-harness",
    policy: { active: true, label: "Guided · starter@abc123" },
    posture: { sandbox: true, egress: true, audit: true },
    lastWardenPendingReviews: 1,
    context: { percent: 42, maxTokens: 100_000 },
  });
  const review = reviewNeededView();

  return [
    ["policies", renderFrame(reduce(base, { type: "policies-panel" }))],
    ["reviews", renderFrame(reduce(review, { type: "review-queue-panel" }))],
    ["context", renderFrame(reduce(base, { type: "context-panel" }))],
    [
      "model",
      renderFrame(
        reduce(base, {
          type: "model-panel",
          content:
            "model\n  selected: anthropic/claude-sonnet-4-6\n  route: direct\n  policy: Guided · starter@abc123",
        }),
      ),
    ],
    ["capabilities", renderFrame(reduce(base, { type: "capabilities-panel" }))],
    ["about", renderFrame(reduce(base, { type: "about-panel" }))],
  ];
}

describe("TUI Slice 0 row-budget baselines", () => {
  it("counts physical rows after terminal wrapping, including blank rows", () => {
    expect(visibleLineCount("one\n\n two ")).toBe(3);
    expect(physicalRows("123456789", 4)).toEqual(["1234", "5678", "9"]);
    expect(physicalRowCount("\u001b[31m123456789\u001b[0m", 4)).toBe(3);
  });

  it("keeps first-run, help, palette, and first-answer surfaces inside an 80x24 budget", () => {
    const frames = [
      ["first-run", renderFrame(firstRunView({ model: "sonnet" }))],
      ["help", renderFrame({ ...firstRunView({ model: "sonnet" }), overlay: { kind: "help" } })],
      [
        "palette",
        renderFrame({
          items: [],
          status,
          streaming: false,
          overlay: { kind: "palette", query: "" },
        }),
      ],
      ["first-answer", renderFrame(firstAnswerView())],
    ] as const;

    for (const [label, frame] of frames) {
      const budget = summarizeRowBudget(frame, 80);
      expect(budget.physicalRows, label).toBeLessThanOrEqual(24);
      expect(frame, label).toContain("protection:");
      if (label === "palette") {
        expect(frame).toContain("work controls");
        expect(frame).toContain("/goal");
        expect(frame).toContain("/loop");
        expect(frame).toContain("protections");
      }
    }
  });

  it("keeps a 10-turn settled session mostly static with a slim live tail", () => {
    const view = longSessionView();
    const plan = transcriptCommitPlan(view);
    const liveFrame = renderFrame({
      ...view,
      items: plan.livePlan.blocks.flatMap((block) => block.items),
    });

    expect({
      staticBlocks: plan.staticBlocks.length,
      liveBlocks: plan.livePlan.blocks.length,
      liveBudget: summarizeRowBudget(liveFrame, 80),
    }).toEqual({
      staticBlocks: 10,
      liveBlocks: 0,
      liveBudget: { columns: 80, logicalLines: 8, physicalRows: 8, widestLine: 76 },
    });
  });

  it("does not duplicate static block ids in a long-session commit plan", () => {
    const ids = conversationPlan(longSessionView()).blocks.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("documents the current baseline row counts as executable evidence", () => {
    expect({
      firstRun: summarizeRowBudget(renderFrame(firstRunView({ model: "sonnet" })), 80),
      help: summarizeRowBudget(
        renderFrame({ ...firstRunView({ model: "sonnet" }), overlay: { kind: "help" } }),
        80,
      ),
      palette: summarizeRowBudget(
        renderFrame({
          items: [],
          status,
          streaming: false,
          overlay: { kind: "palette", query: "" },
        }),
        80,
      ),
      firstAnswer: summarizeRowBudget(renderFrame(firstAnswerView()), 80),
    }).toEqual({
      firstRun: { columns: 80, logicalLines: 14, physicalRows: 14, widestLine: 77 },
      help: { columns: 80, logicalLines: 14, physicalRows: 14, widestLine: 76 },
      palette: { columns: 80, logicalLines: 23, physicalRows: 23, widestLine: 76 },
      firstAnswer: { columns: 80, logicalLines: 16, physicalRows: 17, widestLine: 104 },
    });
  });

  it("keeps launch-visible inspection panels inside an 80x24 budget without dead-end copy", () => {
    const expected = {
      policies: { columns: 80, logicalLines: 10, physicalRows: 10, widestLine: 72 },
      reviews: { columns: 80, logicalLines: 20, physicalRows: 22, widestLine: 136 },
      context: { columns: 80, logicalLines: 15, physicalRows: 16, widestLine: 89 },
      model: { columns: 80, logicalLines: 7, physicalRows: 7, widestLine: 72 },
      capabilities: { columns: 80, logicalLines: 15, physicalRows: 16, widestLine: 113 },
      about: { columns: 80, logicalLines: 10, physicalRows: 10, widestLine: 72 },
    };
    const frames = launchPanelFrames();

    expect(
      Object.fromEntries(frames.map(([label, frame]) => [label, summarizeRowBudget(frame, 80)])),
    ).toEqual(expected);

    for (const [label, frame] of frames) {
      const budget = summarizeRowBudget(frame, 80);
      expect(budget.physicalRows, label).toBeLessThanOrEqual(24);
      expect(frame, label).toContain("protection:");
      expect(frame, label).not.toMatch(/not wired|use CLI today|approve and remember/i);
      expect(frame, label).not.toMatch(/secure by construction|trusted by default/i);
    }
  });

  it("measures raw tabs at terminal eight-column stops", () => {
    expect(terminalDisplayWidth("a\tb")).toBe(9);
    expect(terminalDisplayWidth("wide\nx")).toBe(1);
    expect(physicalRows("12345678\t", 8)).toEqual(["12345678", "\t"]);
    expect(summarizeRowBudget("a\tb", 80)).toEqual({
      columns: 80,
      logicalLines: 1,
      physicalRows: 1,
      widestLine: 9,
    });
  });

  it("counts interior blank rows and terminal-width Unicode cells", () => {
    expect(summarizeRowBudget("alpha\n\n界🙂", 80)).toEqual({
      columns: 80,
      logicalLines: 3,
      physicalRows: 3,
      widestLine: 5,
    });
    expect(summarizeRowBudget("界🙂", 3)).toEqual({
      columns: 3,
      logicalLines: 1,
      physicalRows: 2,
      widestLine: 4,
    });
  });

  it("rejects a non-positive or non-integer column budget", () => {
    expect(() => physicalRows("x", 0)).toThrow(RangeError);
    expect(() => physicalRows("x", -4)).toThrow("columns must be a positive integer");
    expect(() => physicalRows("x", 2.5)).toThrow(RangeError);
  });
});
