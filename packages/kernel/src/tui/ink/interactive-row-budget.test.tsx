/* @jsxRuntime automatic @jsxImportSource react */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { render as renderInk, type RenderOptions } from "ink";
import type { ViewModel } from "@keel/shared";
import { summarizeRowBudget } from "../row-budget.js";
import { firstRunView, initialView, reduce } from "../view-model.js";
import { withOverlayPresentation } from "../overlay-presentation.js";
import { Interactive } from "./interactive.js";

class SizedOutput extends EventEmitter {
  isTTY = true;
  readonly chunks: string[] = [];

  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
  }

  write = (chunk: string | Uint8Array): boolean => {
    this.chunks.push(String(chunk));
    return true;
  };

  output(): string {
    return this.chunks.join("");
  }

  clear(): void {
    this.chunks.length = 0;
  }
}

class TestStdin extends EventEmitter {
  isTTY = true;

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

async function renderShell(view: ViewModel, columns = 80, rows = 24): Promise<string> {
  const stdout = new SizedOutput(columns, rows);
  const stderr = new SizedOutput(columns, rows);
  const rendered = renderInk(<Interactive view={view} onAction={vi.fn()} />, {
    stdout: stdout as unknown as NonNullable<RenderOptions["stdout"]>,
    stderr: stderr as unknown as NonNullable<RenderOptions["stderr"]>,
    stdin: new TestStdin() as unknown as NonNullable<RenderOptions["stdin"]>,
    debug: true,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 1000,
  });
  await rendered.waitUntilRenderFlush();
  const frame = stdout.output();
  rendered.unmount();
  return frame;
}

async function renderShellSequence(
  views: readonly ViewModel[],
  columns = 80,
  rows = 24,
): Promise<string> {
  const first = views[0];
  if (first === undefined) return "";
  const stdout = new SizedOutput(columns, rows);
  const stderr = new SizedOutput(columns, rows);
  const rendered = renderInk(<Interactive view={first} onAction={vi.fn()} />, {
    stdout: stdout as unknown as NonNullable<RenderOptions["stdout"]>,
    stderr: stderr as unknown as NonNullable<RenderOptions["stderr"]>,
    stdin: new TestStdin() as unknown as NonNullable<RenderOptions["stdin"]>,
    debug: true,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: 1000,
  });
  await rendered.waitUntilRenderFlush();
  for (const view of views.slice(1)) {
    stdout.clear();
    rendered.rerender(<Interactive view={view} onAction={vi.fn()} />);
    await rendered.waitUntilRenderFlush();
  }
  const frame = stdout.output();
  rendered.unmount();
  return frame;
}

function setTerminalEnv(next: {
  readonly TERM?: string;
  readonly FORCE_COLOR?: string;
  readonly NO_COLOR?: string;
}): () => void {
  const keys = ["TERM", "FORCE_COLOR", "NO_COLOR"] as const;
  const previous = new Map<(typeof keys)[number], string | undefined>(
    keys.map((key) => [key, process.env[key]]),
  );
  for (const key of keys) {
    const value = next[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function launchBase(): ViewModel {
  return initialView([], {
    model: "anthropic/claude-sonnet-4-6",
    cwd: "/home/u/keel-harness",
    protectionRoute: "governed",
    policy: { active: true, label: "Guided · starter@abc123" },
    posture: { sandbox: true, egress: true, audit: true },
    lastWardenPendingReviews: 1,
    context: { percent: 42, maxTokens: 100_000 },
  });
}

function reviewView(): ViewModel {
  let view = initialView([{ role: "user", content: "run make" }], {
    model: "anthropic/claude-sonnet-4-6",
    cwd: "/home/u/keel-harness",
    protectionRoute: "governed",
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
      "warden review required (not executed): command review for make; [o] once [s] session [d] deny [?] why; exact command envelope only",
  });
}

function longActiveTaskView(streaming: boolean): ViewModel {
  return {
    ...launchBase(),
    items: [
      {
        kind: "message",
        role: "user",
        content:
          "Inspect the Click repository architecture, identify the test command, and explain where a multi-file terminal feature should be implemented without changing public behavior.",
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        kind: "tool" as const,
        id: `read-${String(index)}`,
        name: "read",
        status: "ok" as const,
        summary: `README slice ${String(index + 1)}`,
      })),
      ...(streaming
        ? [{ kind: "message" as const, role: "assistant" as const, content: "Inspecting modules." }]
        : [
            {
              kind: "tool" as const,
              id: "running-search",
              name: "search",
              status: "running" as const,
              summary: "",
            },
          ]),
    ],
    streaming,
    currentTurn: {
      doing: streaming ? "assistant drafting" : "running search",
      why: streaming ? "provider text stream is active" : "a governed tool is executing",
      next: streaming ? "tool call or final answer" : "waiting for tool result",
    },
    pendingInputs: 1,
    queuedInputs: [{ class: "queued", content: "focus on the existing Ink renderer" }],
  };
}

function activeTaskSequence(streaming: boolean): readonly ViewModel[] {
  const final = longActiveTaskView(streaming);
  return [
    {
      ...final,
      items: [final.items[0]!],
      streaming: true,
      currentTurn: {
        doing: "waiting for assistant",
        why: "the provider has not produced a visible event yet",
        next: "assistant response or tool request",
      },
    },
    final,
  ];
}

describe("production Ink shell row budgets", () => {
  it.each([
    [80, 24, false],
    [80, 24, true],
    [100, 30, false],
    [100, 30, true],
  ] as const)(
    "keeps task, action, protection, queue, and composer above routine evidence at %ix%i (streaming=%s)",
    async (columns, rows, streaming) => {
      const output = await renderShellSequence(activeTaskSequence(streaming), columns, rows);
      expect(output).toContain("task · Inspect the Click repository architecture");

      const start = output.lastIndexOf("task · ");
      const cockpit = output.slice(Math.max(0, start));
      const taskRows = cockpit.split("\n").filter((line) => line.includes("task · "));
      expect(taskRows).toHaveLength(1);
      expect(cockpit).toContain(
        streaming ? "working · assistant drafting" : "working · running search",
      );
      expect(cockpit).toContain("queued next · focus on the existing Ink renderer");
      expect(cockpit).toContain("protection:");
      expect(cockpit).toContain("›");
      expect(cockpit).not.toContain("README slice 1");
      expect(
        summarizeRowBudget(cockpit, columns).physicalRows,
        `${columns}x${rows}: ${cockpit}`,
      ).toBeLessThanOrEqual(rows);
    },
  );

  it("keeps launch, help, and the complete command palette usable at a real 80x24 TTY", async () => {
    const base = launchBase();
    const frames = [
      ["launch", await renderShell(firstRunView({ model: "sonnet" }))],
      ["help", await renderShell({ ...base, overlay: { kind: "help" } })],
      ["palette", await renderShell({ ...base, overlay: { kind: "palette", query: "" } })],
    ] as const;

    for (const [label, frame] of frames) {
      const budget = summarizeRowBudget(frame, 80);
      expect(
        budget.physicalRows,
        `${label}: ${JSON.stringify(budget)}\n${frame}`,
      ).toBeLessThanOrEqual(24);
      expect(frame, label).toContain("protection:");
      expect(frame, label).toContain("›");
    }
    expect(
      Object.fromEntries(frames.map(([label, frame]) => [label, summarizeRowBudget(frame, 80)])),
    ).toEqual({
      launch: { columns: 80, logicalLines: 16, physicalRows: 16, widestLine: 77 },
      help: { columns: 80, logicalLines: 17, physicalRows: 17, widestLine: 71 },
      palette: { columns: 80, logicalLines: 24, physicalRows: 24, widestLine: 77 },
    });
    expect(frames[2][1]).toContain("/goal");
    expect(frames[2][1]).toContain("/reviews");
    expect(frames[2][1]).toContain("/answer");
  });

  it("keeps the complete 80x24 command palette visible with production-length identity metadata", async () => {
    const base = initialView([], {
      model: "openai-compatible/r20-no-provider",
      cwd: "/private/tmp/keel-dogfood-click-20260802",
      workspaceTrust: "trusted",
      protectionRoute: "governed",
      policy: { active: true, label: "Guided · starter@abc123" },
      posture: { sandbox: true, egress: true, audit: true },
    });
    const frame = await renderShell({ ...base, overlay: { kind: "palette", query: "" } });
    const budget = summarizeRowBudget(frame, 80);

    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${frame}`).toBeLessThanOrEqual(24);
    expect(frame).toContain("openai-compatible/r20-no-provider");
    expect(frame).toContain("workspace trusted");
    expect(frame).toContain("/goal");
    expect(frame).toContain("/reviews");
    expect(frame).toContain("/answer");
    expect(frame).toContain("›");
  });

  it.each([
    [80, 24, { TERM: "xterm-256color", FORCE_COLOR: "1" }, "basic-color"],
    [80, 24, { TERM: "xterm-256color", NO_COLOR: "1" }, "no-color"],
    [100, 30, { TERM: "xterm-256color", FORCE_COLOR: "1" }, "basic-color"],
    [100, 30, { TERM: "xterm-256color", NO_COLOR: "1" }, "no-color"],
  ] as const)(
    "keeps bounded fallback and full-answer inspection usable at %ix%i in %s",
    async (columns, rows, terminalEnv, _colorMode) => {
      const restoreEnv = setTerminalEnv(terminalEnv);
      try {
        const fallback =
          "Keel could not obtain a complete answer within 40 words: provider length. " +
          "No rewrite tools ran. Inspect the redacted original: keel sessions answer ses_geometry --original";
        const base = {
          ...launchBase(),
          items: [
            {
              kind: "message" as const,
              role: "user" as const,
              content: "summarize the repository",
            },
            { kind: "message" as const, role: "assistant" as const, content: fallback },
          ],
          awaitingInput: true,
        };
        const settled = await renderShell(base, columns, rows);
        const panel = await renderShell(
          {
            ...base,
            overlay: {
              kind: "panel",
              content: `original final answer · ses_geometry\n\n${"retained original line\n".repeat(40)}`,
            },
          },
          columns,
          rows,
        );

        for (const [label, frame] of [
          ["settled", settled],
          ["full", panel],
        ] as const) {
          const liveFrame =
            label === "full"
              ? frame.slice(frame.lastIndexOf("╭"))
              : frame.slice(frame.lastIndexOf("│ you"));
          const budget = summarizeRowBudget(liveFrame, columns);
          expect(
            budget.physicalRows,
            `${label}: ${columns}x${rows}: ${JSON.stringify(budget)}\n${liveFrame}`,
          ).toBeLessThanOrEqual(rows);
          expect(liveFrame).toContain("protection:");
          expect(liveFrame).toContain("›");
        }
        expect(settled).toContain("provider length");
        expect(settled.replace(/\s*│\s*/gu, " ").replace(/\s+/gu, " ")).toContain(
          "keel sessions answer ses_geometry --original",
        );
        expect(panel).toContain("original final answer · ses_geometry");
        expect(panel).toContain("Esc closes");
        expect(panel).toMatch(/more panel lines/u);
      } finally {
        restoreEnv();
      }
    },
  );

  it("keeps launch, help, and critical command discovery usable at 40x18", async () => {
    const base = launchBase();
    const frames = [
      ["launch", await renderShell(firstRunView({ model: "sonnet" }), 40, 18)],
      ["help", await renderShell({ ...base, overlay: { kind: "help" } }, 40, 18)],
      ["palette", await renderShell({ ...base, overlay: { kind: "palette", query: "" } }, 40, 18)],
    ] as const;

    for (const [label, frame] of frames) {
      const budget = summarizeRowBudget(frame, 40);
      expect(
        budget.physicalRows,
        `${label}: ${JSON.stringify(budget)}\n${frame}`,
      ).toBeLessThanOrEqual(18);
      expect(frame, label).toContain("protection:");
      expect(frame, label).toContain("›");
      expect(frame, label).toContain("input");
    }
    for (const command of ["/goal", "/loop", "/answer", "/policies", "/reviews"]) {
      expect(frames[2][1]).toContain(command);
    }
    expect(frames[1][1]).toContain('/goal TASK --check "CMD"');
    expect(frames[1][1]).toContain('/loop TASK --until "CMD"');
    expect(frames[1][1].replace(/[│\n]/gu, " ").replace(/\s+/gu, " ")).toContain(
      "Esc closes panels; working: Esc stops",
    );
    expect(frames[2][1]).toContain("/goal needs --check");
    expect(frames[2][1]).toContain("/loop needs --until");
    expect(frames[2][1]).toMatch(/type to filter|more commands/u);
  });

  it("selects a palette layout that fits the real 60x20 overlay budget", async () => {
    const frame = await renderShell(
      { ...launchBase(), overlay: { kind: "palette", query: "" } },
      60,
      20,
    );
    const budget = summarizeRowBudget(frame, 60);

    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${frame}`).toBeLessThanOrEqual(20);
    expect(frame).toContain("› /help");
    expect(frame).toContain("/verbose");
    expect(frame).toContain("input");
  });

  it("windows @file candidates around the selection without burying the 40x18 composer", async () => {
    const matches = Array.from(
      { length: 20 },
      (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`,
    );
    const selected = 9;
    const overlay = withOverlayPresentation(
      { kind: "at-complete", query: "src/file", matches },
      { selected },
    );
    const frame = await renderShell({ ...launchBase(), overlay }, 40, 18);
    const budget = summarizeRowBudget(frame, 40);

    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${frame}`).toBeLessThanOrEqual(18);
    expect(frame).toContain(`› ${matches[selected]}`);
    expect(frame).toContain("earlier matches");
    expect(frame).toContain("more matches");
    expect(frame).toContain("input");
  });

  it("keeps a complete six-row run-control receipt and composer usable at 40x18", async () => {
    const frame = await renderShell(
      {
        ...launchBase(),
        items: [
          { kind: "message", role: "user", content: "complete the checked goal" },
          { kind: "message", role: "assistant", content: "The checked goal is complete." },
        ],
        awaitingInput: true,
        turnSummary: {
          title: "done",
          changed: [],
          checked: [],
          receipt: [
            "goal · complete the checked goal",
            "check · pnpm test -- math",
            "attempts · 2/3",
            "result · passed",
            "audit · session goal_fixture seq 14",
            "next · continue or exit",
          ],
          attention: [],
        },
      },
      40,
      18,
    );
    // Ink's debug sink contains the immutable paint followed by the live frame. Production rewrites
    // only that final mutable region, so measure the last full conversation paint.
    const currentFrame = frame.slice(frame.lastIndexOf("│ you  complete the checked goal"));
    const budget = summarizeRowBudget(currentFrame, 40);

    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${currentFrame}`).toBeLessThanOrEqual(
      18,
    );
    for (const label of ["goal", "check", "attempts", "result", "audit", "next"]) {
      expect(currentFrame).toContain(label);
    }
    expect(currentFrame).toContain("protection:");
    expect(currentFrame).toContain("›");
  });

  it("keeps bounded file evidence, verification, commands, and recovery usable at 40x18", async () => {
    const frame = await renderShell(
      {
        ...launchBase(),
        items: [
          { kind: "message", role: "user", content: "update the batch" },
          { kind: "message", role: "assistant", content: "The batch is settled." },
        ],
        awaitingInput: true,
        turnSummary: {
          title: "done",
          changed: [],
          checked: [],
          fileEvidence: Array.from({ length: 5 }, (_, index) => ({
            status: index === 0 ? ("available" as const) : ("unavailable" as const),
            text: `src/f${String(index)}.ts · observed → verified`,
          })),
          ran: Array.from({ length: 6 }, (_, index) => `bash: check ${String(index)}`),
          attention: [],
        },
      },
      40,
      18,
    );
    const currentFrame = frame.slice(frame.lastIndexOf("│ you  update the batch"));
    const budget = summarizeRowBudget(currentFrame, 40);

    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${currentFrame}`).toBeLessThanOrEqual(
      18,
    );
    expect(currentFrame).toContain("2 more hidden");
    expect(currentFrame).toContain("unavailable 4 observations");
    expect(currentFrame).toContain("3 more commands");
    expect(currentFrame).not.toContain("verification not run");
    expect(currentFrame).toContain("automatic undo unavailable");
    expect(currentFrame).toContain("protection:");
    expect(currentFrame).toContain("›");
  });

  it("keeps two qualified mutation receipts explicit at 40x18", async () => {
    const evidence = (path: string) =>
      `${path} · observed file before → verified installed after · comparison complete · transition not atomic · concurrent mutation not excluded`;
    const compactEvidence = (path: string) =>
      `${path} · observed:file → verified:installed · compare:complete · non-atomic · concurrent edit possible`;
    const frame = await renderShell(
      {
        ...launchBase(),
        items: [
          { kind: "message", role: "user", content: "edit both registered files" },
          { kind: "tool", id: "read-1", name: "read", status: "ok", summary: "presentation.txt" },
          { kind: "tool", id: "read-2", name: "read", status: "ok", summary: "secondary.txt" },
          { kind: "message", role: "assistant", content: "K310E501-EDIT-DONE" },
        ],
        awaitingInput: true,
        turnSummary: {
          title: "done",
          changed: [],
          checked: [],
          fileEvidence: [
            { status: "available", text: evidence("presentation.txt") },
            { status: "available", text: evidence("secondary.txt") },
          ],
          ran: ["read: presentation.txt", "read: secondary.txt"],
          attention: [],
        },
      },
      40,
      18,
    );
    const currentFrame = frame.slice(frame.lastIndexOf("│ keel"));
    const budget = summarizeRowBudget(currentFrame, 40);
    const normalized = currentFrame.replace(/\s+/gu, " ");

    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${currentFrame}`).toBeLessThanOrEqual(
      18,
    );
    expect(normalized).toContain(`file ${compactEvidence("presentation.txt")}`);
    expect(normalized).toContain(`file ${compactEvidence("secondary.txt")}`);
    expect(currentFrame).not.toContain("file evidence 2 total");
    expect(currentFrame).toContain("›");
  });

  it("keeps quiet-density file evidence honest and usable at 40x18", async () => {
    const frame = await renderShell(
      {
        ...launchBase(),
        items: [
          { kind: "message", role: "user", content: "update the batch quietly" },
          { kind: "message", role: "assistant", content: "The batch is settled." },
        ],
        density: "quiet",
        awaitingInput: true,
        turnSummary: {
          title: "done",
          changed: [],
          checked: [],
          fileEvidence: Array.from({ length: 5 }, (_, index) => ({
            status: index === 0 ? ("available" as const) : ("unavailable" as const),
            text: `src/f${String(index)}.ts · observed → verified`,
          })),
          attention: [],
        },
      },
      40,
      18,
    );
    const currentFrame = frame.slice(frame.lastIndexOf("│ you  update the batch quietly"));
    const budget = summarizeRowBudget(currentFrame, 40);

    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${currentFrame}`).toBeLessThanOrEqual(
      18,
    );
    expect(currentFrame).toContain("file evidence 5 total · 2 more hidden");
    expect(currentFrame).toContain("unavailable 4 observations");
    expect(currentFrame).toContain("automatic undo unavailable");
    expect(currentFrame).toContain("›");
  });

  it.each([
    ["failures", (index: number) => `bash: failing check ${String(index)}`],
    ["review requirements", (index: number) => `requires human review ${String(index)}`],
  ])("keeps bounded %s and their next action usable at 40x18", async (_label, detail) => {
    const frame = await renderShell(
      {
        ...launchBase(),
        items: [
          { kind: "message", role: "user", content: "run the checks" },
          { kind: "message", role: "assistant", content: "Several checks need attention." },
        ],
        awaitingInput: true,
        turnSummary: {
          title: "needs attention",
          changed: [],
          checked: [],
          attention: Array.from({ length: 4 }, (_, index) => detail(index)),
        },
      },
      40,
      18,
    );
    const currentFrame = frame.slice(frame.lastIndexOf("│ you  run the checks"));
    const budget = summarizeRowBudget(currentFrame, 40);

    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${currentFrame}`).toBeLessThanOrEqual(
      18,
    );
    expect(currentFrame).toContain("3 more failed items");
    expect(currentFrame).toContain("next");
    expect(currentFrame).toContain("protection:");
    expect(currentFrame).toContain("›");
  });

  it("keeps every launch-visible foreground panel and its paused composer usable at 80x24", async () => {
    const base = launchBase();
    const panels: ReadonlyArray<readonly [string, ViewModel]> = [
      ["policies", reduce(base, { type: "policies-panel" })],
      ["reviews", reduce(reviewView(), { type: "review-queue-panel" })],
      ["context", reduce(base, { type: "context-panel" })],
      [
        "model",
        reduce(base, {
          type: "model-panel",
          content:
            "model\n  selected: anthropic/claude-sonnet-4-6\n  route: direct\n  policy: Guided · starter@abc123",
        }),
      ],
      ["capabilities", reduce(base, { type: "capabilities-panel" })],
      ["about", reduce(base, { type: "about-panel" })],
    ];

    const budgets: Record<string, ReturnType<typeof summarizeRowBudget>> = {};
    for (const [label, view] of panels) {
      const frame = await renderShell(view);
      const budget = summarizeRowBudget(frame, 80);
      budgets[label] = budget;
      expect(
        budget.physicalRows,
        `${label}: ${JSON.stringify(budget)}\n${frame}`,
      ).toBeLessThanOrEqual(24);
      expect(frame, label).toContain("panel open");
      expect(frame, label).toContain("Esc closes");
      expect(frame, label).toContain("protection:");
      expect(frame, label).not.toContain("task · ");
      expect(frame, label).not.toContain("^G editor");
      expect(frame, label).not.toContain("↑ history");
    }
    expect(budgets).toEqual({
      policies: { columns: 80, logicalLines: 13, physicalRows: 13, widestLine: 70 },
      reviews: { columns: 80, logicalLines: 14, physicalRows: 14, widestLine: 65 },
      context: { columns: 80, logicalLines: 19, physicalRows: 19, widestLine: 80 },
      model: { columns: 80, logicalLines: 10, physicalRows: 10, widestLine: 65 },
      capabilities: { columns: 80, logicalLines: 19, physicalRows: 19, widestLine: 80 },
      about: { columns: 80, logicalLines: 13, physicalRows: 13, widestLine: 73 },
    });
  });

  it("clips a worst-case review panel before it can bury the 80x24 composer", async () => {
    let view = launchBase();
    for (let index = 1; index <= 5; index += 1) {
      view = reduce(view, { type: "tool-call", id: `review-${index}`, name: "bash", args: {} });
      view = reduce(view, {
        type: "tool-result",
        id: `review-${index}`,
        ok: false,
        output: `warden review required (not executed): ${`review ${index} detail `.repeat(12)}`,
      });
    }
    view = reduce(view, { type: "review-queue-panel" });

    const frame = await renderShell(view);
    // Static tool history is intentionally written above the live viewport. Budget only the panel
    // and live shell beneath its final top border; cumulative native scrollback is not live chrome.
    const liveFrame = frame.slice(frame.lastIndexOf("╭"));
    const budget = summarizeRowBudget(liveFrame, 80);
    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${liveFrame}`).toBeLessThanOrEqual(24);
    expect(frame).toMatch(/more panel lines/u);
    expect(frame).toContain("panel open");
    expect(frame).toContain("›");
  });

  it("keeps an active approval above a stale review panel in the live 80x24 viewport", async () => {
    let view = reduce(reviewView(), {
      type: "approval-opened",
      detail: "bash command review for make",
      sessionAvailable: true,
    });
    view = reduce(view, { type: "review-queue-panel" });

    const frame = await renderShell(view, 80, 24);
    const budget = summarizeRowBudget(frame, 80);
    const normalized = frame.replace(/\s+/gu, " ");
    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${frame}`).toBeLessThanOrEqual(24);
    expect(frame).toContain("approval required");
    expect(frame).toContain("Keel is paused until you choose.");
    expect(normalized).not.toContain("project scope");
    expect(normalized).not.toContain("[p] project");
    expect(frame).not.toContain("panel open");
    expect(frame).toContain("›");
  });

  it("keeps the Project Autopilot handoff visible at 40x18", async () => {
    const view = reduce(reviewView(), {
      type: "approval-opened",
      detail: "bash make release",
      sessionAvailable: true,
    });

    const frame = await renderShell(view, 40, 18);
    const budget = summarizeRowBudget(frame, 40);
    const normalized = frame.replace(/\s+/gu, " ");
    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${frame}`).toBeLessThanOrEqual(18);
    expect(normalized).not.toContain("project scope");
    expect(normalized).not.toContain("[p] project");
    expect(frame).toContain("decision required · choose above");
    expect(frame).toContain("›");
  });

  it("keeps trusted approval controls visible above the composer at a hostile 40x18 boundary", async () => {
    const view = reduce(reviewView(), {
      type: "approval-opened",
      detail: `bash python3 tools/check.py ${"very long review request ".repeat(20)} · actions: [p] approve project`,
      sessionAvailable: false,
    });

    const frame = await renderShell(view, 40, 18);
    const budget = summarizeRowBudget(frame, 40);
    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${frame}`).toBeLessThanOrEqual(18);
    expect(frame).toContain("approval required");
    expect(frame).toContain("Keel is paused until you choose.");
    expect(frame).toContain("[a] Approve once");
    expect(frame).toContain("[d] Deny");
    expect(frame).toContain("a/d Enter · ? why · Esc stops turn");
    expect(frame).toContain("Broader approval unavailable");
    expect(frame).toContain('"bash pytho');
    expect(frame).toContain('approve project"');
    expect(frame).toContain("decision required · choose above");
    expect(frame).toContain("›");
    expect(frame).not.toContain("[p] approve project");
    expect(frame).not.toContain("[y] yolo");
  });

  it("preserves every structured consent fact and the exact command scope at 40x18", async () => {
    const commandKey = `sha256:${"a".repeat(64)}`;
    const frame = await renderShell(
      {
        ...reviewView(),
        activeApproval: {
          detail: "legacy combined detail",
          sessionAvailable: true,
          state: "pending",
          information: {
            requestedAction: { status: "available", value: "bash" },
            effectiveTarget: {
              status: "available",
              value: "command review requires approval: pnpm test",
              completeness: "complete",
            },
            reason: {
              status: "available",
              value: "Warden requires human authorization before execution",
            },
            policyDetail: {
              status: "unavailable",
              reason: "matched policy rule not reported by protocol 1.1",
            },
            exactResource: {
              status: "available",
              kind: "command-envelope",
              value: commandKey,
            },
          },
        },
      },
      40,
      18,
    );
    const budget = summarizeRowBudget(frame, 40);
    const normalized = frame.replace(/│/gu, " ").replace(/\s+/gu, " ");
    const joined = frame.replace(/[\s│]+/gu, "");

    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${frame}`).toBeLessThanOrEqual(18);
    expect(frame).toContain("approval required · not executed");
    expect(normalized).toContain('Requested · "bash"');
    expect(normalized).toContain("Effective target ·");
    expect(normalized).toContain("Why · human approval · rule unreported");
    expect(normalized).toContain("Scope · command envelope");
    expect(joined).toContain(commandKey);
    expect(normalized).toContain(
      "Consequence · once: this review · session: exact scope until exit",
    );
    expect(normalized).toContain("Next · inspect facts · choose above");
    expect(frame).toContain("[a] Approve once");
    expect(frame).toContain("[s] Session");
    expect(frame).toContain("[d] Deny");
    expect(frame).toContain("›");
    expect(frame).not.toContain("legacy combined detail");
  });

  it("keeps the complete Warden authorization reason visible at 60x20", async () => {
    const frame = await renderShell(
      {
        ...reviewView(),
        activeApproval: {
          detail: "legacy combined detail",
          sessionAvailable: false,
          state: "pending",
          information: {
            requestedAction: { status: "available", value: "bash" },
            effectiveTarget: {
              status: "available",
              value: "workspace deletion requires exact once-only approval: rm review-delete.txt",
              completeness: "complete",
            },
            reason: {
              status: "available",
              value: "Warden requires human authorization before execution",
            },
            policyDetail: {
              status: "unavailable",
              reason: "matched policy rule not reported by protocol 1.1",
            },
            exactResource: {
              status: "unavailable",
              reason: "no exact reusable resource in the Warden review",
            },
          },
        },
      },
      60,
      20,
    );
    const budget = summarizeRowBudget(frame, 60);
    const normalized = frame.replace(/[\s│]+/gu, " ");

    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${frame}`).toBeLessThanOrEqual(20);
    expect(normalized).toContain("Warden requires human authorization before execution");
    expect(normalized).not.toContain("Warden requires human autho…");
    expect(normalized).toContain(
      'Effective target · "workspace deletion requires exact once-only approval: rm review-delete.txt"',
    );
    expect(normalized).not.toContain("workspace deletion require…");
    expect(frame).toContain("›");
  });

  it("keeps the complete Warden effective target visible at 40x18", async () => {
    const frame = await renderShell(
      {
        ...reviewView(),
        activeApproval: {
          detail: "legacy combined detail",
          sessionAvailable: false,
          state: "pending",
          information: {
            requestedAction: { status: "available", value: "bash" },
            effectiveTarget: {
              status: "available",
              value: "workspace deletion requires exact once-only approval: rm review-delete.txt",
              completeness: "complete",
            },
            reason: {
              status: "available",
              value: "Warden requires human authorization before execution",
            },
            policyDetail: {
              status: "unavailable",
              reason: "matched policy rule not reported by protocol 1.1",
            },
            exactResource: {
              status: "unavailable",
              reason: "no exact reusable resource in the Warden review",
            },
          },
        },
      },
      40,
      18,
    );
    const budget = summarizeRowBudget(frame, 40);
    const normalized = frame.replace(/[\s│]+/gu, " ");

    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${frame}`).toBeLessThanOrEqual(18);
    expect(normalized).toContain(
      'Effective target · "workspace deletion requires exact once-only approval: rm review-delete.txt"',
    );
    expect(normalized).not.toContain("workspace deletion require…");
    expect(frame).toContain("approval required · not executed");
    expect(frame).toContain("›");
  });

  it("keeps an abbreviated exact target visibly once-only at 40x18", async () => {
    const commandKey = `sha256:${"c".repeat(64)}`;
    const view = reduce(reviewView(), {
      type: "approval-opened",
      detail: "legacy combined detail",
      sessionAvailable: false,
      information: {
        requestedAction: { status: "available", value: "bash" },
        effectiveTarget: {
          status: "available",
          value: "command review: prefix [93 chars omitted] dangerous-suffix",
          completeness: "abbreviated",
        },
        reason: {
          status: "available",
          value: "Warden requires human authorization before execution",
        },
        policyDetail: {
          status: "unavailable",
          reason: "matched policy rule not reported by protocol 1.1",
        },
        exactResource: {
          status: "available",
          kind: "command-envelope",
          value: commandKey,
        },
      },
    });
    const frame = await renderShell(view, 40, 18);
    const budget = summarizeRowBudget(frame, 40);
    const normalized = frame.replace(/│/gu, " ").replace(/\s+/gu, " ");
    const joined = frame.replace(/[\s│]+/gu, "");

    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${frame}`).toBeLessThanOrEqual(18);
    expect(normalized).toContain("Effective [abbr.] ·");
    expect(joined).toContain(commandKey);
    expect(frame).not.toContain("[s] Session");
    expect(frame).toContain("Broader approval unavailable");
    expect(frame).toContain("›");
  });

  it("keeps a controller explanation and all decision controls inside 40x18", async () => {
    let view = reduce(reviewView(), {
      type: "approval-opened",
      detail: "bash command review for rm review-delete.txt",
      sessionAvailable: false,
      information: {
        requestedAction: { status: "available", value: "bash" },
        effectiveTarget: {
          status: "available",
          value: "workspace deletion requires exact once-only approval: rm review-delete.txt",
          completeness: "complete",
        },
        reason: {
          status: "available",
          value: "Warden requires human authorization before execution",
        },
        policyDetail: {
          status: "unavailable",
          reason: "matched policy rule not reported by protocol 1.1",
        },
        exactResource: {
          status: "unavailable",
          reason: "no exact reusable resource in the Warden review",
        },
      },
    });
    view = reduce(view, {
      type: "approval-message",
      content: "explanation shown above · still pending · no authority granted",
    });
    const frame = await renderShell(view, 40, 18);
    const budget = summarizeRowBudget(frame, 40);
    const normalized = frame.replace(/[\s│]+/gu, " ");

    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${frame}`).toBeLessThanOrEqual(18);
    expect(normalized).toContain("explanation shown above · still pending · no authority granted");
    expect(frame).toContain("[a] Approve once");
    expect(frame).toContain("[d] Deny · [?] Explain");
    expect(frame).toContain("decision required · choose above");
    expect(frame).toContain("›");
  });

  it("keeps every xterm approval lifecycle state within each promised terminal size", async () => {
    const previousTerm = process.env["TERM"];
    process.env["TERM"] = "xterm-256color";
    const states = [
      "pending",
      "submitted",
      "confirmed",
      "denied",
      "failed",
      "indeterminate",
    ] as const;
    const sizes = [
      [120, 40],
      [80, 24],
      [40, 18],
    ] as const;

    try {
      for (const [columns, rows] of sizes) {
        for (const state of states) {
          const frame = await renderShell(
            {
              ...reviewView(),
              activeApproval: {
                detail: "bash python3 tools/check.py",
                sessionAvailable: true,
                state,
                message:
                  state === "pending"
                    ? "review details: exact command envelope"
                    : state === "indeterminate"
                      ? "action may have executed · do not retry automatically · inspect audit"
                      : `settlement ${state}`,
              },
            },
            columns,
            rows,
          );
          const budget = summarizeRowBudget(frame, columns);
          expect(
            budget.physicalRows,
            `${columns}x${rows} ${state}: ${JSON.stringify(budget)}\n${frame}`,
          ).toBeLessThanOrEqual(rows);
          expect(frame, `${columns}x${rows} ${state}`).toContain("Requested action");
          expect(frame, `${columns}x${rows} ${state}`).toContain("›");
          if (columns >= 80) {
            expect(frame, `${columns}x${rows} ${state}`).toContain("╭");
            expect(frame, `${columns}x${rows} ${state}`).toContain("╰");
          }
        }
      }
    } finally {
      if (previousTerm === undefined) delete process.env["TERM"];
      else process.env["TERM"] = previousTerm;
    }
  });

  it("reacts to 80x24 → 40x18 resize without an external view update", async () => {
    const cases = [
      {
        label: "approval",
        view: {
          ...reviewView(),
          activeApproval: {
            detail: "bash python3 tools/check.py",
            sessionAvailable: true,
            state: "pending" as const,
          },
        },
        expected: "approval required",
      },
      {
        label: "reviews",
        view: reduce(reviewView(), { type: "review-queue-panel" }),
        expected: "reviews",
      },
    ];

    for (const testCase of cases) {
      const stdout = new SizedOutput(80, 24);
      const stderr = new SizedOutput(80, 24);
      const rendered = renderInk(<Interactive view={testCase.view} onAction={vi.fn()} />, {
        stdout: stdout as unknown as NonNullable<RenderOptions["stdout"]>,
        stderr: stderr as unknown as NonNullable<RenderOptions["stderr"]>,
        stdin: new TestStdin() as unknown as NonNullable<RenderOptions["stdin"]>,
        debug: true,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
        maxFps: 1000,
      });
      try {
        await rendered.waitUntilRenderFlush();
        stdout.chunks.length = 0;
        stdout.columns = 40;
        stdout.rows = 18;
        stdout.emit("resize");
        await rendered.waitUntilRenderFlush();
        const frame = stdout.chunks.at(-1) ?? "";
        const budget = summarizeRowBudget(frame, 40);

        expect(frame, testCase.label).toContain(testCase.expected);
        expect(
          budget.physicalRows,
          `${testCase.label}: ${JSON.stringify(budget)}\n${frame}`,
        ).toBeLessThanOrEqual(18);
        expect(frame, testCase.label).toContain("›");
      } finally {
        rendered.unmount();
      }
    }
  });

  it("keeps long submitted and unsettled approval outcomes within a 40x18 viewport", async () => {
    for (const state of ["submitted", "failed", "indeterminate"] as const) {
      const frame = await renderShell(
        {
          ...reviewView(),
          activeApproval: {
            detail: "bash python3 tools/check.py",
            sessionAvailable: false,
            state,
            message: `${"transport diagnostics ".repeat(100)}action may have executed · do not retry automatically · inspect audit`,
          },
        },
        40,
        18,
      );
      const budget = summarizeRowBudget(frame, 40);
      expect(
        budget.physicalRows,
        `${state}: ${JSON.stringify(budget)}\n${frame}`,
      ).toBeLessThanOrEqual(18);
      expect(frame).toContain("›");
      expect(frame.replace(/\s+/gu, " ")).toMatch(
        /do(?:\s|│)*not(?:\s|│)*retry(?:\s|│)*automatically/u,
      );
    }
  });

  it.each([
    ["CJK", "界".repeat(240)],
    ["emoji", "🧭".repeat(240)],
    ["combining", "e\u0301".repeat(240)],
  ])("bounds %s approval outcomes by terminal cells at 40x18", async (_label, diagnostics) => {
    const guidance = "action may have executed · do not retry automatically · inspect audit";
    const frame = await renderShell(
      {
        ...reviewView(),
        activeApproval: {
          detail: "bash python3 tools/check.py",
          sessionAvailable: false,
          state: "indeterminate",
          message: `${diagnostics}${guidance}`,
        },
      },
      40,
      18,
    );
    const budget = summarizeRowBudget(frame, 40);
    expect(
      budget.physicalRows,
      `${_label}: ${JSON.stringify(budget)}\n${frame}`,
    ).toBeLessThanOrEqual(18);
    expect(frame.replace(/\s+/gu, " ")).toContain("review outcome indeterminate");
    expect(frame.replace(/\s+/gu, " ")).toMatch(
      /do(?:\s|│)*not(?:\s|│)*retry(?:\s|│)*automatically/u,
    );
  });

  it("keeps the policy mode action visible with a usable composer at 40x18", async () => {
    const view = reduce(
      initialView([], {
        model: "anthropic/claude-sonnet-4-6",
        cwd: "/home/u/keel-r11-dogfood-workspace",
        protectionRoute: "governed",
        policy: {
          active: true,
          label: "Guided · phase2a-starter-policy-pack@9b2df94f575b",
        },
        posture: { sandbox: true, egress: true, audit: false },
        lastWardenPendingReviews: 0,
      }),
      { type: "policies-panel" },
    );
    const frame = await renderShell(view, 40, 18);
    const budget = summarizeRowBudget(frame, 40);

    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${frame}`).toBeLessThanOrEqual(18);
    expect(frame.replace(/[│\n]/gu, " ").replace(/\s+/gu, " ")).toContain(
      "next session mode (run in shell): keel autopilot mode set --help",
    );
    expect(frame).toContain("reviews: 0 · snapshot, not live");
    expect(frame).toContain("read-only");
    expect(frame).toContain("docs/guide/policy-guide.md");
    expect(frame).not.toContain("more panel lines");
    expect(frame).toContain("panel open · Esc closes");
    expect(frame).toContain("›");
  });

  it("keeps the review panel next action visible at 40x18", async () => {
    const view = reduce(reviewView(), { type: "review-queue-panel" });
    const frame = await renderShell(view, 40, 18);
    const budget = summarizeRowBudget(frame, 40);

    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${frame}`).toBeLessThanOrEqual(18);
    expect(frame).toContain("read-only: cannot approve");
    expect(frame).toContain("approval prompt: none open");
    expect(frame).toContain("panel open · Esc closes");
    expect(frame).toContain("›");
  });

  it("keeps worst-case queued turns usable at 40x18 without duplicate queue rows", async () => {
    let view = initialView([{ role: "user", content: "inspect the repository" }], {
      model: "anthropic/claude-sonnet-4-6",
      cwd: "/home/u/keel-harness",
      policy: { active: true, label: "Guided · starter@abc123" },
      posture: { sandbox: true, egress: true, audit: true },
    });
    view = reduce(view, { type: "text-delta", text: "I am checking the relevant files." });
    for (const content of ["a".repeat(96), "界".repeat(96)]) {
      const queued = reduce(view, { type: "input-queued", class: "queued", content });
      const debugOutput = await renderShell(queued, 40, 18);
      // Ink debug mode appends every paint. Once the active user row is correctly owned by Static,
      // the debug sink contains the immutable paint followed by the current mutable frame. Measure
      // the latter; production Ink rewrites that mutable region in place.
      const currentFrameStart = debugOutput.lastIndexOf("│ you  inspect the repository");
      const frame = debugOutput.slice(Math.max(0, currentFrameStart));
      const budget = summarizeRowBudget(frame, 40);
      expect(budget.physicalRows, `${JSON.stringify(budget)}\n${frame}`).toBeLessThanOrEqual(18);
      expect(frame.match(/queued next/gu)).toHaveLength(1);
      expect(frame).not.toContain("input:1 queued");
      expect(frame).toContain("1 follow-up queued");
    }
  });

  it("uses the available 120x40 rows before truncating a queued steering instruction", async () => {
    let view = initialView([{ role: "user", content: "edit the registered notes" }], {
      model: "anthropic/claude-sonnet-4-6",
      cwd: "/home/u/keel-harness",
      policy: { active: true, label: "Guided · starter@abc123" },
      posture: { sandbox: true, egress: true, audit: true },
    });
    view = reduce(view, { type: "text-delta", text: "I am editing the registered notes." });
    const instruction =
      "Adjust the requested section before finishing: make it exactly three bullets, include the " +
      "exact phrase governed clarity, then run node test.mjs exactly once.";
    view = reduce(view, { type: "input-queued", class: "queued", content: instruction });

    const debugOutput = await renderShell(view, 120, 40);
    const currentFrameStart = debugOutput.lastIndexOf("queued next");
    const frame = debugOutput.slice(Math.max(0, currentFrameStart));
    const queuedSurface = frame.slice(0, frame.indexOf("\nanthropic/"));
    const normalized = queuedSurface.replace(/\n\s*/gu, "");
    const budget = summarizeRowBudget(frame, 120);

    expect(budget.physicalRows, `${JSON.stringify(budget)}\n${frame}`).toBeLessThanOrEqual(40);
    expect(frame.match(/queued next/gu)).toHaveLength(1);
    expect(normalized).toBe(`queued next · ${instruction}`);

    const compactOutput = await renderShell(view, 80, 24);
    const compactFrameStart = compactOutput.lastIndexOf("queued next");
    const compactFrame = compactOutput.slice(Math.max(0, compactFrameStart));
    const compactQueuedSurface = compactFrame.slice(0, compactFrame.indexOf("\nanthropic/"));
    const compactBudget = summarizeRowBudget(compactFrame, 80);

    expect(
      compactBudget.physicalRows,
      `${JSON.stringify(compactBudget)}\n${compactFrame}`,
    ).toBeLessThanOrEqual(24);
    expect(compactQueuedSurface.split("\n").filter((line) => line.length > 0)).toHaveLength(2);
    expect(compactQueuedSurface).toContain("…");
  });
});
