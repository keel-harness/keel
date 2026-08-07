import { describe, expect, it } from "vitest";
import type { UiCurrentTurn, UiTurnSummary, ViewItem, ViewModel } from "@keel/shared";
import {
  conversationPlan,
  currentTurnRows,
  reviewNeededDetails,
  screenAnatomyPlan,
  transcriptCommitPlan,
  turnSummaryPresentation,
  visibleTurnItemsWithIndexes,
} from "./conversation-block.js";
import { ALL_OFF_POSTURE, buildTurnSummary, initialView, reduce } from "./view-model.js";
import { terminalDisplayWidth } from "./display-cells.js";
import {
  markToolPresentationOutcome,
  type ToolPresentationOutcome,
} from "../tool-presentation-outcome.js";
import { markReviewSettlementPresentation } from "./review-settlement-presentation.js";

const status = { tokens: 0, posture: ALL_OFF_POSTURE };

function view(items: readonly ViewItem[], extra: Partial<ViewModel> = {}): ViewModel {
  return {
    items,
    status,
    streaming: false,
    ...extra,
  };
}

const user = (content: string): ViewItem => ({ kind: "message", role: "user", content });
const assistant = (content: string): ViewItem => ({ kind: "message", role: "assistant", content });
const bash = (id: string, summary: string): ViewItem => ({
  kind: "tool",
  id,
  name: "bash",
  status: "ok",
  summary,
});
const edit = (id: string, summary: string): ViewItem => ({
  kind: "tool",
  id,
  name: "edit",
  status: "ok",
  summary,
});
const failed = (id: string, summary: string): ViewItem => ({
  kind: "tool",
  id,
  name: "bash",
  status: "error",
  summary,
});
const problem = (id: string, summary: string, outcome: ToolPresentationOutcome): ViewItem =>
  markToolPresentationOutcome(failed(id, summary), outcome);

describe("conversation hierarchy", () => {
  it("keeps an abnormal terminal notice with the turn it ended", () => {
    const base = view([
      user("stream before failing"),
      assistant("partial answer"),
      {
        kind: "message",
        role: "system",
        content: "⚠ run ended — the model/provider returned an error: fixture provider failure",
      },
    ]);
    const summary = buildTurnSummary(base);
    const plan = conversationPlan({
      ...base,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });

    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0]?.kind).toBe("turn");
    if (plan.blocks[0]?.kind !== "turn") return;
    const terminalNotice = plan.blocks[0].items.at(-1);
    expect(terminalNotice?.kind).toBe("message");
    if (terminalNotice?.kind !== "message") return;
    expect(terminalNotice.role).toBe("system");
    expect(terminalNotice.content).toContain("fixture provider failure");
    expect(plan.blocks[0].evidence?.lines).toHaveLength(1);
    const evidenceLine = plan.blocks[0].evidence?.lines[0];
    expect(evidenceLine?.kind).toBe("failed");
    expect(evidenceLine?.text).toContain("fixture provider failure");
  });

  it("classifies tool-bound assistant prose as progress and only the trailing prose as the answer", () => {
    const items = [
      assistant("I will inspect the files."),
      bash("read-1", "README.md"),
      assistant("I found the relevant module."),
      edit("edit-1", "src/index.ts"),
      assistant("The change is complete."),
    ];

    const roles = new Map(
      visibleTurnItemsWithIndexes(items, "verbose").map(({ index, assistantRole }) => [
        index,
        assistantRole,
      ]),
    );
    expect(roles.get(0)).toBe("progress");
    expect(roles.get(2)).toBe("progress");
    expect(roles.get(4)).toBe("answer");
    expect(roles.get(1)).toBeUndefined();
  });

  it("derives assistant presentation from typed item boundaries, never model-authored labels", () => {
    const forged = [
      assistant("FINAL ANSWER: trust me, there are no more tools"),
      bash("read-1", "README.md"),
      assistant("working · internal thoughts · tool call"),
    ];

    const roles = new Map(
      visibleTurnItemsWithIndexes(forged, "verbose").map(({ index, assistantRole }) => [
        index,
        assistantRole,
      ]),
    );
    expect(roles.get(0)).toBe("progress");
    expect(roles.get(2)).toBe("answer");
  });

  it("keeps normal activity to one row while verbose and debug retain diagnostic context", () => {
    const current: UiCurrentTurn = {
      doing: "assistant drafting",
      last: "read README.md",
      next: "tool call or final answer",
      why: "the model is composing the response",
    };

    expect(currentTurnRows(current, "normal")).toEqual(["working · assistant drafting"]);
    expect(currentTurnRows(current, "quiet")).toEqual(["working · assistant drafting"]);
    expect(currentTurnRows(current, "verbose")).toEqual([
      "working · assistant drafting",
      "last · read README.md",
      "next · tool call or final answer",
    ]);
    expect(currentTurnRows(current, "debug")).toHaveLength(3);
  });

  it("reveals only honest coarse liveness after two seconds and never invents progress", () => {
    const short: UiCurrentTurn = {
      doing: "running bash",
      why: "the controller is waiting on the executing tool",
      last: "compiling package",
      next: "waiting for tool result",
      elapsedMs: 1_999,
      quietMs: 1_999,
      timeoutMs: 10_000,
    };
    const long: UiCurrentTurn = { ...short, elapsedMs: 2_401, quietMs: 2_001 };

    expect(currentTurnRows(short, "normal")).toEqual(["working · running bash"]);
    expect(currentTurnRows(short, "verbose")).toEqual([
      "working · running bash",
      "last · compiling package",
      "limit · timeout 10s",
      "next · waiting for tool result",
    ]);
    expect(currentTurnRows(long, "normal")).toEqual(["working · running bash · 2s"]);
    expect(currentTurnRows(long, "verbose")).toEqual([
      "working · running bash · 2s",
      "last · compiling package · quiet 2s",
      "limit · timeout 10s",
      "next · waiting for tool result",
    ]);
    expect(currentTurnRows(long, "debug").join("\n")).not.toContain("%");
  });

  it("bounds hostile duration values and reports quiet work without fabricating output", () => {
    const current: UiCurrentTurn = {
      doing: "running search",
      why: "the controller is waiting on the executing tool",
      next: "waiting for tool result",
      elapsedMs: Number.MAX_VALUE,
      quietMs: Number.POSITIVE_INFINITY,
      timeoutMs: Number.NaN,
    };

    expect(currentTurnRows(current, "verbose")).toEqual([
      "working · running search · 99h+",
      "quiet · 99h+ without output",
      "next · waiting for tool result",
    ]);
  });

  it("does not round a known sub-second timeout down to zero", () => {
    expect(
      currentTurnRows(
        {
          doing: "running read",
          why: "the controller is waiting on the executing tool",
          next: "waiting for tool result",
          timeoutMs: 500,
        },
        "verbose",
      ),
    ).toContain("limit · timeout 500ms");
  });
});

describe("conversationPlan", () => {
  it("groups the flat ViewModel stream into user-led turns", () => {
    const plan = conversationPlan(
      view([user("hi"), assistant("hello"), user("fix it"), assistant("on it"), bash("c0", "ok")]),
    );

    expect(plan.blocks.map((b) => b.kind)).toEqual(["turn", "turn"]);
    const [first, second] = plan.blocks;
    expect(first?.kind).toBe("turn");
    expect(second?.kind).toBe("turn");
    if (first?.kind !== "turn" || second?.kind !== "turn") return;
    expect(first.user.content).toBe("hi");
    expect(first.items.map((i) => (i.kind === "message" ? i.content : i.summary))).toEqual([
      "hello",
    ]);
    expect(second.user.content).toBe("fix it");
    expect(second.items.map((i) => (i.kind === "message" ? i.content : i.summary))).toEqual([
      "on it",
      "ok",
    ]);
  });

  it("attaches derived receipts and evidence to the latest turn only", () => {
    const base = view([
      user("first turn"),
      edit("edit-old", "src/old.ts"),
      failed("bash-old", "permission denied"),
      assistant("I hit a blocker."),
      user("second turn"),
      bash("bash-new", "second passed"),
      assistant("second answer"),
    ]);
    const turnSummary = buildTurnSummary(base);
    expect(turnSummary).toBeDefined();
    if (turnSummary === undefined) return;
    const plan = conversationPlan({
      ...base,
      awaitingInput: true,
      turnSummary,
    });

    const latest = plan.blocks.at(-1);
    expect(latest?.kind).toBe("turn");
    if (latest?.kind !== "turn") return;

    expect(latest.summary).toMatchObject({
      title: "done",
      changed: [],
      ran: ["bash: second passed"],
      attention: [],
    });
    expect(latest.summary).not.toHaveProperty("answer");
    expect(latest.evidence).toBeUndefined();
  });

  it("collapses older normal-mode turns while keeping recent and active turns expanded", () => {
    const currentTurn: UiCurrentTurn = {
      doing: "running bash",
      why: "latest visible event is a running tool",
      next: "waiting for tool result",
    };
    const plan = conversationPlan(
      view(
        [
          user("one"),
          assistant("answer one"),
          bash("c1", "old noisy output"),
          user("two"),
          assistant("answer two"),
          edit("c2", "src/two.ts"),
          user("three"),
          assistant("answer three"),
          user("four"),
          { kind: "tool", id: "c4", name: "bash", status: "running", summary: "" },
        ],
        { currentTurn },
      ),
    );

    const turns = plan.blocks.flatMap((b) => (b.kind === "turn" ? [b] : []));
    expect(turns.map((t) => t.mode)).toEqual(["compact", "expanded", "expanded", "expanded"]);
    expect(turns.map((t) => t.recency)).toEqual(["older", "recent", "recent", "active"]);
    expect(turns[0]?.receipt).toContain("done");
    expect(turns[0]?.receipt).toContain("ran 1");
    expect(turns[3]?.currentTurn?.doing).toBe("running bash");
  });

  it("retains an exact observation-gap count when an older mutation turn compacts", () => {
    const uncaptured: ViewItem = {
      kind: "tool",
      id: "uncaptured-old",
      name: "bash",
      status: "ok",
      summary: "rename complete",
      mutationPresentation: {
        status: "unavailable",
        reason: "workspace-effects-not-captured",
      },
    };
    const repeated = view([
      user("rename the file"),
      uncaptured,
      assistant("renamed"),
      user("second"),
      assistant("second answer"),
      user("third"),
      assistant("third answer"),
      user("fourth"),
      assistant("fourth answer"),
    ]);
    const first = conversationPlan(repeated).blocks[0];

    expect(first).toMatchObject({ kind: "turn", mode: "compact" });
    expect(first?.kind === "turn" ? first.receipt : "").toContain("observations unavailable 1");
  });

  it("keeps a streaming turn active in quiet density and preserves original visible-item indexes", () => {
    const plan = conversationPlan(
      view([user("explain"), bash("c1", "setup done"), assistant("partial answer")], {
        streaming: true,
        density: "quiet",
      }),
    );

    expect(plan.blocks).toHaveLength(1);
    const block = plan.blocks[0];
    expect(block?.kind).toBe("turn");
    if (block?.kind !== "turn") return;
    expect(block.recency).toBe("active");
    expect(block.mode).toBe("expanded");
    expect(visibleTurnItemsWithIndexes(block.items, "quiet")).toEqual([
      {
        item: assistant("partial answer"),
        index: 1,
        synthetic: false,
        assistantRole: "answer",
      },
    ]);
  });

  it("quiet density compacts prior successful turns but never compacts failed turns", () => {
    const plan = conversationPlan(
      view(
        [
          user("old success"),
          assistant("ok"),
          bash("c1", "passed"),
          user("old failure"),
          assistant("checking"),
          failed("c2", "permission denied"),
          user("active"),
          assistant("working"),
        ],
        {
          density: "quiet",
          currentTurn: {
            doing: "assistant drafting",
            why: "provider text stream is active",
            next: "final answer",
          },
        },
      ),
    );

    const turns = plan.blocks.flatMap((b) => (b.kind === "turn" ? [b] : []));
    expect(turns.map((t) => t.mode)).toEqual(["compact", "expanded", "expanded"]);
    expect(turns[1]?.receipt).toContain("failed");
    expect(turns[1]?.receipt).toContain("failed 1");
    expect(turns[1]?.receipt).toContain("next: review evidence before retrying");
    expect(turns[1]?.receipt).not.toContain("needs attention");
  });

  it("quiet density keeps the latest settled answer expanded", () => {
    const plan = conversationPlan(
      view(
        [
          user("older question"),
          assistant("older answer"),
          user("latest question"),
          assistant("latest answer"),
        ],
        { density: "quiet", awaitingInput: true },
      ),
    );

    const turns = plan.blocks.flatMap((block) => (block.kind === "turn" ? [block] : []));
    expect(turns.map((turn) => turn.mode)).toEqual(["compact", "expanded"]);
    expect(turns[1]?.items).toContainEqual(assistant("latest answer"));
  });

  it("normal density compacts repeated same-reason failed tools without changing receipts", () => {
    const repeated = view([
      user("what is in this repo?"),
      problem(
        "bash-1",
        "warden review required (not executed): POL-003 review: unclassified shell shape requires human review",
        "review",
      ),
      problem(
        "bash-2",
        "warden review required (not executed): POL-003 review: unclassified shell shape requires human review",
        "review",
      ),
      problem(
        "bash-3",
        "warden review required (not executed): POL-003 review: unclassified shell shape requires human review",
        "review",
      ),
      assistant(
        "This repo contains the kernel, warden, shared, simulator, eval, and memory packages.",
      ),
    ]);
    const plan = conversationPlan(repeated);
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;

    const visible = visibleTurnItemsWithIndexes(turn.items, repeated.density);
    expect(visible.map(({ item }) => (item.kind === "tool" ? item.id : item.content))).toEqual([
      "bash-1",
      "2 similar tool failures compacted · blocked until policy/approval changes",
      "This repo contains the kernel, warden, shared, simulator, eval, and memory packages.",
    ]);
    expect(turn.receipt).toContain("failed 3");
    expect(turn.evidence?.lines).toContainEqual({
      kind: "review",
      text: "bash: warden review required (not executed): POL-003 review: unclassified shell shape requires human review (3 times)",
      why: "the warden required a human decision; this result was not executed",
      next: "no live approval · simplify the request, then rerun",
    });
  });

  it("normal density lets the answer lead while preserving consequential and failed tools", () => {
    const uncapturedBash: ViewItem = {
      kind: "tool",
      id: "bash-uncaptured",
      name: "bash",
      status: "ok",
      summary: "rename complete",
      mutationPresentation: {
        status: "unavailable",
        reason: "workspace-effects-not-captured",
      },
    };
    const items: readonly ViewItem[] = [
      { kind: "tool", id: "read-1", name: "read", status: "ok", summary: "README.md" },
      bash("bash-1", "tests passed"),
      uncapturedBash,
      edit("edit-1", "src/app.ts"),
      failed("bash-2", "permission denied"),
      assistant("I updated the app and verified the focused tests."),
    ];

    expect(
      visibleTurnItemsWithIndexes(items, undefined).map(({ item }) =>
        item.kind === "tool" ? item.id : item.content,
      ),
    ).toEqual([
      "bash-uncaptured",
      "edit-1",
      "bash-2",
      "I updated the app and verified the focused tests.",
    ]);
    expect(visibleTurnItemsWithIndexes(items, "verbose").map(({ item }) => item.kind)).toEqual([
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
      "message",
    ]);
    expect(visibleTurnItemsWithIndexes(items, "debug").map(({ item }) => item.kind)).toEqual([
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
      "message",
    ]);
  });

  it("groups repeated successful read and search evidence without losing count or detailed mode", () => {
    const base = view([
      user("inspect the repository"),
      ...Array.from({ length: 8 }, (_, index) => ({
        kind: "tool" as const,
        id: `read-${String(index)}`,
        name: "read",
        status: "ok" as const,
        summary: `src/file-${String(index)}.ts`,
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        kind: "tool" as const,
        id: `search-${String(index)}`,
        name: "search",
        status: "ok" as const,
        summary: `symbol-${String(index)}`,
      })),
      assistant("Architecture explained."),
    ]);
    const plan = conversationPlan({ ...base, awaitingInput: true });
    const turn = plan.blocks.find((block) => block.kind === "turn");

    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;
    expect(turn.evidence?.lines).toEqual([
      {
        kind: "tool",
        text: "read: 8 successful observations · examples: src/file-0.ts; src/file-1.ts",
      },
      {
        kind: "tool",
        text: "search: 4 successful observations · examples: symbol-0; symbol-1",
      },
    ]);
    expect(
      visibleTurnItemsWithIndexes(turn.items, "verbose").filter(({ item }) => item.kind === "tool"),
    ).toHaveLength(12);

    const quiet = conversationPlan({ ...base, density: "quiet", awaitingInput: true });
    const quietTurn = quiet.blocks.find((block) => block.kind === "turn");
    expect(quietTurn?.kind === "turn" ? quietTurn.evidence : undefined).toBeUndefined();
  });

  it("keeps one successful read or search exact instead of manufacturing a group", () => {
    const plan = conversationPlan(
      view(
        [
          user("inspect two targets"),
          { kind: "tool", id: "read-1", name: "read", status: "ok", summary: "README.md" },
          {
            kind: "tool",
            id: "search-1",
            name: "search",
            status: "ok",
            summary: "src/cli.ts:main",
          },
          assistant("Done."),
        ],
        { awaitingInput: true },
      ),
    );
    const turn = plan.blocks.find((block) => block.kind === "turn");

    expect(turn?.kind === "turn" ? turn.evidence?.lines : []).toEqual([
      { kind: "tool", text: "read: README.md" },
      { kind: "tool", text: "search: src/cli.ts:main" },
    ]);
  });

  it("keeps grouped occurrence counts before bounded, source-ordered examples", () => {
    const long = `src/${"segment".repeat(100)}/module.ts`;
    const plan = conversationPlan(
      view(
        [
          user("inspect repeated targets"),
          { kind: "tool", id: "read-1", name: "read", status: "ok", summary: long },
          { kind: "tool", id: "read-2", name: "read", status: "ok", summary: long },
          { kind: "tool", id: "read-3", name: "read", status: "ok", summary: "README.md" },
          assistant("Done."),
        ],
        { awaitingInput: true },
      ),
    );
    const turn = plan.blocks.find((block) => block.kind === "turn");
    const line = turn?.kind === "turn" ? turn.evidence?.lines[0]?.text : undefined;

    expect(line).toMatch(/^read: 3 successful observations .* examples: src\//u);
    expect(terminalDisplayWidth(line ?? "")).toBeLessThanOrEqual(120);
  });

  it("never groups consequential read/search outcomes, mutations, or unrelated tools as success", () => {
    const blockedRead = markToolPresentationOutcome(
      {
        kind: "tool" as const,
        id: "read-blocked",
        name: "read",
        status: "error" as const,
        summary: "blocked by warden: outside workspace",
      },
      "blocked",
    );
    const limitedSearch = markToolPresentationOutcome(
      {
        kind: "tool" as const,
        id: "search-limited",
        name: "search",
        status: "ok" as const,
        summary: "first 50 matches shown",
      },
      "limited",
    );
    const base = view(
      [
        user("inspect and update"),
        { kind: "tool", id: "read-1", name: "read", status: "ok", summary: "README.md" },
        { kind: "tool", id: "read-2", name: "read", status: "ok", summary: "package.json" },
        blockedRead,
        limitedSearch,
        edit("edit-1", "src/app.ts"),
        { kind: "tool", id: "plan-1", name: "plan", status: "ok", summary: "2 steps" },
        assistant("The inspection needs attention."),
      ],
      { awaitingInput: true },
    );
    const summary = buildTurnSummary(base);
    const plan = conversationPlan({
      ...base,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });
    const turn = plan.blocks.find((block) => block.kind === "turn");

    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;
    expect(turn.evidence?.lines).toContainEqual({
      kind: "tool",
      text: "read: 2 successful observations · examples: README.md; package.json",
    });
    expect(turn.evidence?.lines.some((line) => line.kind === "blocked")).toBe(true);
    expect(turn.evidence?.lines.some((line) => line.kind === "limited")).toBe(true);
    expect(
      turn.evidence?.lines.some(
        (line) => line.kind === "file-evidence-unavailable" || line.kind === "file-evidence",
      ),
    ).toBe(true);
    expect(turn.evidence?.lines).toContainEqual({ kind: "tool", text: "plan: 2 steps" });
  });

  it("keeps a warden review consequential without labeling a recovered answer as blocked", () => {
    const base = view([
      user("what is in this repo?"),
      problem(
        "bash-review",
        "warden review required (not executed): POL-003 review: unclassified shell shape",
        "review",
      ),
      { kind: "tool", id: "read-1", name: "read", status: "ok", summary: "README.md" },
      assistant("The repository contains the kernel, warden, and shared packages."),
    ]);
    const summary = buildTurnSummary(base);
    const plan = conversationPlan({
      ...base,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });
    const turn = plan.blocks.find((block) => block.kind === "turn");

    expect(summary?.title).toBe("needs attention");
    expect(summary?.attention).not.toEqual([]);
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;
    expect(turn.receipt).toMatch(/^needs attention · answered/u);
    expect(turn.summary?.title).toBe("needs attention");
    const review = turn.evidence?.lines.find((line) => line.kind === "review");
    expect(review?.text).toContain("POL-003");
  });

  it("shows answered turns with blocked/review evidence as attention, not a false blocked outcome", () => {
    const base = view([
      user("what is in this repo?"),
      { kind: "tool", id: "read-1", name: "read", status: "ok", summary: "README.md" },
      problem(
        "bash-deny",
        "blocked by warden (not executed): POL-002 deny: write outside workspace",
        "blocked",
      ),
      problem(
        "bash-review",
        "warden review required (not executed): POL-003 review: unclassified shell shape",
        "review",
      ),
      assistant("The repository contains kernel, warden, shared, simulator, eval, and memory."),
    ]);
    const summary = buildTurnSummary(base);
    const plan = conversationPlan({
      ...base,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });
    const turn = plan.blocks.find((block) => block.kind === "turn");

    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;
    expect(turn.receipt).toMatch(/^needs attention · answered/u);
    expect(turn.receipt).not.toMatch(/^blocked|^review needed/u);
    expect(turn.summary?.title).toBe("needs attention");
    expect(turn.evidence?.lines.map((line) => line.kind)).toEqual(
      expect.arrayContaining(["blocked", "review"]),
    );
  });

  it("never recovers a failed mutating tool merely because later exploration succeeds", () => {
    const failedWrite = markToolPresentationOutcome(
      {
        kind: "tool",
        id: "write-1",
        name: "write",
        status: "error",
        summary: "permission denied",
      } as const,
      "failed",
    );
    const base = view([
      user("write the file"),
      failedWrite,
      { kind: "tool", id: "read-1", name: "read", status: "ok", summary: "README.md" },
      assistant("I could inspect the repository, but the write did not complete."),
    ]);

    expect(buildTurnSummary(base)?.title).toBe("needs attention");
  });

  it("makes an exact recovered edit dominant while verbose history retains the blocked attempt", () => {
    let base = initialView([{ role: "user", content: "update src/app.ts" }]);
    base = reduce(base, {
      type: "tool-call",
      id: "edit-blocked",
      name: "edit",
      args: { path: "src/app.ts", oldString: "before", newString: "after" },
    });
    base = reduce(
      base,
      markToolPresentationOutcome(
        {
          type: "tool-result",
          id: "edit-blocked",
          ok: false,
          output: "blocked by warden (not executed): read the file before editing",
        },
        "blocked",
      ),
    );
    base = reduce(base, {
      type: "tool-call",
      id: "edit-retry",
      name: "edit",
      args: { path: "src/app.ts", oldString: "before", newString: "after" },
    });
    base = reduce(base, {
      type: "tool-result",
      id: "edit-retry",
      ok: true,
      output: "edited",
    });
    base = reduce(base, { type: "text-delta", text: "The exact retry completed." });
    const summary = buildTurnSummary(base);
    const plan = conversationPlan({
      ...base,
      streaming: false,
      awaitingInput: true,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });
    const block = plan.blocks.find((candidate) => candidate.kind === "turn");

    expect(block?.kind).toBe("turn");
    if (block?.kind !== "turn") return;
    expect(block.receipt).toMatch(/^done/u);
    expect(block.summary?.receipt).toEqual([
      "recovered · edit src/app.ts completed after earlier blocked attempt",
    ]);
    expect(JSON.stringify(block.evidence)).not.toContain("read the file before editing");
    expect(
      visibleTurnItemsWithIndexes(block.items, undefined).map(({ item }) =>
        item.kind === "tool" ? item.id : item.content,
      ),
    ).not.toContain("edit-blocked");
    expect(
      visibleTurnItemsWithIndexes(block.items, "verbose").map(({ item }) =>
        item.kind === "tool" ? item.id : item.content,
      ),
    ).toContain("edit-blocked");
  });

  it("derives an explicit recovered receipt from resumed history without a stored turn summary", () => {
    const resumed = initialView(
      [
        { role: "user", content: "update src/app.ts" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "edit-blocked",
              name: "edit",
              args: { path: "src/app.ts", oldString: "before", newString: "after" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "edit-blocked",
          name: "edit",
          content: "blocked by warden (not executed): read the file before editing",
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "edit-retry",
              name: "edit",
              args: { path: "src/app.ts", oldString: "before", newString: "after" },
            },
          ],
        },
        { role: "tool", toolCallId: "edit-retry", name: "edit", content: "edited" },
        { role: "assistant", content: "The exact retry completed." },
      ],
      {},
      { failedToolMessageIndexes: new Set([2]) },
    );
    const block = conversationPlan({ ...resumed, awaitingInput: true }).blocks.find(
      (candidate) => candidate.kind === "turn",
    );

    expect(block?.kind).toBe("turn");
    if (block?.kind !== "turn") return;
    expect(block.receipt).toContain("recovered 1");
    expect(block.receipt).toMatch(/^done/u);
    expect(block.evidence?.lines).toContainEqual({
      kind: "recovered",
      text: "edit src/app.ts completed after earlier blocked attempt",
    });
    expect(JSON.stringify(block.evidence)).not.toContain("read the file before editing");
    expect(
      visibleTurnItemsWithIndexes(block.items, "verbose").map(({ item }) =>
        item.kind === "tool" ? item.id : item.content,
      ),
    ).toContain("edit-blocked");
  });

  it("recovers a non-mutating read failure only after a later exploratory success and answer", () => {
    const failedRead = markToolPresentationOutcome(
      {
        kind: "tool",
        id: "read-wide",
        name: "read",
        status: "error",
        summary: "selected range is too large",
      } as const,
      "failed",
    );
    const base = view(
      [
        user("summarize the repository"),
        failedRead,
        {
          kind: "tool",
          id: "read-small",
          name: "read",
          status: "ok",
          summary: "# keel",
          subject: "README.md",
        },
        assistant("The repository contains a kernel and warden."),
      ],
      { awaitingInput: true },
    );

    expect(buildTurnSummary(base)?.title).toBe("done");
    const block = conversationPlan(base).blocks[0];
    expect(block?.kind === "turn" ? block.receipt : "").toMatch(/^done/u);
    expect(block?.kind === "turn" ? block.evidence?.lines : []).toEqual([
      { kind: "tool", text: "read: README.md" },
    ]);
    expect(
      JSON.stringify(
        block?.kind === "turn" ? { evidence: block.evidence, summary: block.summary } : {},
      ),
    ).not.toContain("recovered attempt");
  });

  it("defers an exploratory read miss while the model can still self-correct", () => {
    const failedRead = markToolPresentationOutcome(
      {
        kind: "tool",
        id: "read-dir",
        name: "read",
        status: "error",
        summary: "read: 'packages' is a directory, not a file",
      } as const,
      "failed",
    );
    const active = view([user("summarize the repository"), failedRead], { streaming: true });
    const block = conversationPlan(active).blocks[0];

    expect(block?.kind).toBe("turn");
    if (block?.kind !== "turn") return;
    expect(block.evidence).toBeUndefined();
    expect(block.suppressExploratoryFailures).toBe(true);
    expect(
      visibleTurnItemsWithIndexes(block.items, "normal", {
        suppressExploratoryFailures: block.suppressExploratoryFailures === true,
      }),
    ).toEqual([]);

    const verboseBlock = conversationPlan({ ...active, density: "verbose" }).blocks[0];
    expect(verboseBlock?.kind).toBe("turn");
    if (verboseBlock?.kind !== "turn") return;
    expect(verboseBlock.suppressExploratoryFailures).toBeUndefined();
    expect(visibleTurnItemsWithIndexes(verboseBlock.items, "verbose")).toMatchObject([
      { item: { kind: "tool", id: "read-dir", status: "error" } },
    ]);
  });

  it("renders an unrecovered exploratory miss once the turn actually ends", () => {
    const failedRead = markToolPresentationOutcome(
      {
        kind: "tool",
        id: "read-missing",
        name: "read",
        status: "error",
        summary: "read: 'missing.md' does not exist",
      } as const,
      "failed",
    );
    const block = conversationPlan(
      view([user("read missing.md"), failedRead], { awaitingInput: true }),
    ).blocks[0];

    expect(block?.kind).toBe("turn");
    if (block?.kind !== "turn") return;
    expect(block.evidence?.lines).toContainEqual({
      kind: "failed",
      text: "read: read: 'missing.md' does not exist",
      why: "action did not complete cleanly",
      next: "fix the request or command, then retry",
    });
  });

  it("never recovers a blocked read or search as an ordinary exploratory miss", () => {
    for (const name of ["read", "search"] as const) {
      const denied = markToolPresentationOutcome(
        {
          kind: "tool",
          id: `${name}-blocked`,
          name,
          status: "error",
          summary: "blocked by warden (not executed): policy deny",
        } as const,
        "blocked",
      );
      const base = view([
        user("inspect safely"),
        denied,
        { kind: "tool", id: `${name}-ok`, name, status: "ok", summary: "README.md" },
        assistant("I found an alternate source."),
      ]);

      expect(buildTurnSummary(base)?.title).toBe("needs attention");
    }
  });

  it("keeps an executed bash failure consequential after a later exploratory success", () => {
    const base = view([
      user("summarize the repository"),
      problem("bash-failed", "command exited 1", "failed"),
      { kind: "tool", id: "read-ok", name: "read", status: "ok", summary: "README.md" },
      assistant("I found the repository documentation."),
    ]);

    expect(buildTurnSummary(base)?.title).toBe("needs attention");
  });

  it("keeps an unresolved review consequential when no alternate tool succeeds", () => {
    const base = view([
      user("summarize the repository"),
      problem("bash-review", "warden review required (not executed): command", "review"),
      assistant("I could not inspect the repository."),
    ]);

    expect(buildTurnSummary(base)?.title).toBe("needs attention");
  });

  it("keeps distinct failed-tool reasons visible and expands all failures in verbose/debug density", () => {
    const items = [
      problem(
        "review-1",
        "warden review required (not executed): POL-003 review: shell shape",
        "review",
      ),
      problem(
        "review-2",
        "warden review required (not executed): POL-003 review: shell shape",
        "review",
      ),
      problem(
        "deny-1",
        "blocked by warden (not executed): POL-002 deny: write outside workspace",
        "blocked",
      ),
      failed("ordinary-1", "permission denied"),
      failed("ordinary-2", "permission denied"),
    ];

    expect(
      visibleTurnItemsWithIndexes(items, undefined).map(({ item }) =>
        item.kind === "tool" ? item.id : item.content,
      ),
    ).toEqual([
      "review-1",
      "1 similar tool failure compacted · blocked until policy/approval changes",
      "deny-1",
      "ordinary-1",
      "1 similar tool failure compacted · try another way",
    ]);
    expect(visibleTurnItemsWithIndexes(items, "verbose").map(({ item }) => item.kind)).toEqual([
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
    ]);
    expect(visibleTurnItemsWithIndexes(items, "debug").map(({ item }) => item.kind)).toEqual([
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
    ]);
  });

  it("does not compact failures that share a policy code but target different resources or reasons", () => {
    const items = [
      problem(
        "write-a",
        "blocked by warden: POL-002 deny: write outside workspace /repo/a.txt",
        "blocked",
      ),
      problem(
        "write-b",
        "blocked by warden: POL-002 deny: write outside workspace /repo/b.txt",
        "blocked",
      ),
      problem(
        "read-a",
        "blocked by warden: POL-002 deny: read protected path /repo/a.txt",
        "blocked",
      ),
    ];

    expect(
      visibleTurnItemsWithIndexes(items, undefined).map(({ item }) =>
        item.kind === "tool" ? item.id : item.content,
      ),
    ).toEqual(["write-a", "write-b", "read-a"]);
  });

  it("suppresses a duplicate text-only Done card but keeps meaningful receipts", () => {
    const duplicate: UiTurnSummary = {
      title: "done",
      answer: "plain answer",
      changed: [],
      checked: [],
      attention: [],
    };
    const meaningful: UiTurnSummary = {
      title: "done",
      answer: "implemented it",
      changed: ["edit: src/app.ts"],
      checked: [],
      attention: [],
    };
    const automaticOnly: UiTurnSummary = {
      title: "done",
      answer: "auto-resolved it",
      changed: [],
      checked: [],
      automatic: ["Plan Autopilot plan_auth_fix allowed bash (audit #5)"],
      attention: [],
    };

    const duplicatePlan = conversationPlan(
      view([user("question"), assistant("plain answer")], {
        turnSummary: duplicate,
        awaitingInput: true,
      }),
    );
    const meaningfulPlan = conversationPlan(
      view([user("task"), assistant("implemented it")], {
        turnSummary: meaningful,
        awaitingInput: true,
      }),
    );
    const automaticPlan = conversationPlan(
      view([user("auto"), assistant("auto-resolved it")], {
        turnSummary: automaticOnly,
        awaitingInput: true,
      }),
    );

    const duplicateTurn = duplicatePlan.blocks.find((b) => b.kind === "turn");
    const meaningfulTurn = meaningfulPlan.blocks.find((b) => b.kind === "turn");
    const automaticTurn = automaticPlan.blocks.find((b) => b.kind === "turn");
    expect(duplicateTurn?.kind === "turn" ? duplicateTurn.summary : undefined).toBeUndefined();
    expect(meaningfulTurn?.kind === "turn" ? meaningfulTurn.summary : undefined).toEqual({
      title: "done",
      changed: [],
      checked: [],
      attention: [],
    });
    expect(automaticTurn?.kind === "turn" ? automaticTurn.summary : undefined).toEqual({
      title: "done",
      changed: [],
      checked: [],
      automatic: ["Plan Autopilot plan_auth_fix allowed bash (audit #5)"],
      attention: [],
    });
    expect(automaticTurn?.kind === "turn" ? automaticTurn.receipt : "").toContain("automatic 1");
  });

  it("shows the textual attention rail only in debug density", () => {
    const base = view([user("go"), assistant("done")], {
      attentionRail: [{ glyph: "U", label: "user", tone: "user" }],
    });

    expect(conversationPlan(base).showAttentionRail).toBe(false);
    expect(conversationPlan({ ...base, density: "debug" }).showAttentionRail).toBe(true);
  });

  it("keeps Phase-1 honesty copy out of presentation receipts", () => {
    const plan = conversationPlan(
      view([user("go"), assistant("done"), edit("c1", "src/app.ts"), bash("c2", "passed")]),
    );
    const text = JSON.stringify(plan);
    expect(text).not.toMatch(/approved|sandboxed|policy cleared|audit verified|risk reviewed/i);
    expect(text).not.toMatch(/trusted|autopilot|secure by construction/i);
  });

  it("uses specific problem vocabulary instead of the old attention affordance", () => {
    const plan = conversationPlan(
      view([user("fix it"), assistant("checking"), failed("c1", "permission denied")], {
        turnSummary: {
          title: "needs attention",
          changed: [],
          checked: [],
          attention: ["bash: permission denied"],
        },
      }),
    );

    const text = JSON.stringify(plan);
    expect(text).toContain("failed");
    expect(text).toContain("next: review evidence before retrying");
    expect(text).not.toContain("needs attention");
  });

  it("groups repeated review-needed details without hiding distinct failures", () => {
    const details = reviewNeededDetails([
      "bash: blocked by warden (not executed): POL-002 deny: write outside workspace",
      "bash: warden review required (not executed): POL-003 review: unclassified shell shape",
      "bash: blocked by warden (not executed): POL-002 deny: write outside workspace",
      "bash: warden review required (not executed): POL-003 review: unclassified shell shape",
      "bash: permission denied",
    ]);

    expect(details.map((detail) => detail.what)).toEqual([
      "bash: blocked by warden (not executed): POL-002 deny: write outside workspace (2 times)",
      "bash: warden review required (not executed): POL-003 review: unclassified shell shape (2 times)",
      "bash: permission denied",
    ]);
    expect(details.map((detail) => detail.next)).toEqual([
      "fix the request or command, then retry",
      "no live approval · simplify the request, then rerun",
      "fix the request or command, then retry",
    ]);
  });

  it("never downgrades a needs-attention summary with blank details to done", () => {
    const summary: UiTurnSummary = {
      title: "needs attention",
      changed: [],
      checked: [],
      attention: ["\u001b[2J"],
    };
    const emptySummary: UiTurnSummary = {
      title: "needs attention",
      changed: [],
      checked: [],
      attention: [],
    };

    expect(turnSummaryPresentation(summary).title).toBe("failed");
    expect(turnSummaryPresentation(emptySummary).title).toBe("failed");

    const plan = conversationPlan(
      view([user("fix it"), assistant("I could not complete it")], { turnSummary: summary }),
    );
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;
    expect(turn.summary?.title).toBe("failed");
    expect(turn.receipt).toContain("failed");
    expect(turn.receipt).not.toContain("done");
  });

  it("derives review and blocked titles from typed controller receipt rows", () => {
    const review = turnSummaryPresentation({
      title: "needs attention",
      changed: [],
      checked: [],
      receipt: ["result · review required", "next · approve or deny the exact request"],
      attention: [],
    });
    const blocked = turnSummaryPresentation({
      title: "needs attention",
      changed: [],
      checked: [],
      receipt: ["result · blocked by warden", "next · revise the command"],
      attention: [],
    });

    expect(review.title).toBe("review needed");
    expect(blocked.title).toBe("blocked");
  });

  it("bounds receipt categories with exact disclosure and keeps ran distinct from verified", () => {
    const presentation = turnSummaryPresentation({
      title: "needs attention",
      changed: [],
      checked: [],
      fileEvidence: Array.from({ length: 5 }, (_, index) => ({
        status: "available" as const,
        text: `src/${String(index)}.ts · observed`,
      })),
      ran: Array.from({ length: 6 }, (_, index) => `bash: command ${String(index)}`),
      attention: Array.from({ length: 4 }, (_, index) => `bash: failure ${String(index)}`),
    });

    expect(presentation.fileEvidence).toEqual([
      { status: "available", text: "src/0.ts · observed" },
      { status: "available", text: "src/1.ts · observed" },
      { status: "available", text: "src/2.ts · observed" },
      { status: "more", text: "… 2 more file observations" },
    ]);
    expect(presentation.ran).toEqual([
      "bash: command 0",
      "bash: command 1",
      "bash: command 2",
      "… 3 more commands",
    ]);
    expect(presentation.attention.map((detail) => detail.what)).toEqual([
      "bash: failure 0",
      "bash: failure 1",
      "bash: failure 2",
    ]);
    expect(presentation.attentionCount).toBe(4);
    expect(presentation.verification).toBeUndefined();
    expect(presentation.ran).toContain("bash: command 0");
    expect(JSON.stringify(presentation)).not.toContain("verification not run");
    expect(presentation.recovery).toEqual([
      "automatic undo unavailable — review file evidence and recover deliberately from version control or a backup",
    ]);
    expect(JSON.stringify(presentation)).not.toMatch(/git restore|\brm\b/u);
  });

  it("keeps unavailable observation status explicit when it falls beyond the file cap", () => {
    const presentation = turnSummaryPresentation({
      title: "done",
      changed: [],
      checked: [],
      fileEvidence: [
        ...Array.from({ length: 3 }, (_, index) => ({
          status: "available" as const,
          text: `src/${String(index)}.ts · observed`,
        })),
        ...Array.from({ length: 2 }, (_, index) => ({
          status: "unavailable" as const,
          text: `write ${String(index)} observation unavailable`,
        })),
      ],
      attention: [],
    });

    expect(presentation.fileEvidence?.at(-1)).toEqual({
      status: "more",
      text: "… 2 more file observations · 2 unavailable",
    });
  });

  it("bounds expanded evidence categories with exact hidden counts", () => {
    const base = view([
      user("perform a bounded batch"),
      ...Array.from({ length: 5 }, (_, index) =>
        edit(`edit-${String(index)}`, `src/${String(index)}.ts`),
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        bash(`bash-ok-${String(index)}`, `command ${String(index)}`),
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        failed(`bash-fail-${String(index)}`, `failure ${String(index)}`),
      ),
      assistant("batch settled"),
    ]);
    const summary = buildTurnSummary(base);
    const plan = conversationPlan({
      ...base,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;

    expect(
      turn.evidence?.lines.filter((line) => line.kind === "file-evidence-unavailable"),
    ).toHaveLength(1);
    expect(turn.evidence?.lines.filter((line) => line.kind === "failed")).toHaveLength(3);
    expect(
      turn.evidence?.lines.filter((line) => line.kind === "more").map((line) => line.text),
    ).toEqual(["… 4 more file observations · 4 unavailable", "… 1 more failed item"]);
    expect(turn.summary?.ran).toEqual([
      "bash: command 0",
      "bash: command 1",
      "bash: command 2",
      "… 3 more commands",
    ]);
    expect(turn.summary?.fileEvidence).toEqual([]);
  });

  it("retains the exact failed-item overflow count while a turn is still active", () => {
    const plan = conversationPlan(
      view(
        [
          user("run all checks"),
          ...Array.from({ length: 4 }, (_, index) =>
            failed(`bash-fail-${String(index)}`, `failure ${String(index)}`),
          ),
        ],
        { streaming: true },
      ),
    );
    const turn = plan.blocks.find((block) => block.kind === "turn");

    expect(turn?.kind === "turn" ? turn.evidence?.lines : []).toContainEqual({
      kind: "more",
      text: "… 1 more failed item",
      omitted: { group: "failed", count: 1 },
    });
  });

  it("does not orphan or duplicate a file-overflow row in quiet density", () => {
    const base = view([user("update files"), assistant("done")], {
      density: "quiet",
      turnSummary: {
        title: "done",
        changed: [],
        checked: [],
        fileEvidence: Array.from({ length: 5 }, (_, index) => ({
          status: "available" as const,
          text: `src/${String(index)}.ts · observed`,
        })),
        attention: [],
      },
    });
    const turn = conversationPlan(base).blocks.find((block) => block.kind === "turn");

    expect(turn?.kind === "turn" ? turn.evidence : undefined).toBeUndefined();
    expect(turn?.kind === "turn" ? turn.summary?.fileEvidence : undefined).toEqual([
      { status: "available", text: "src/0.ts · observed" },
      { status: "available", text: "src/1.ts · observed" },
      { status: "available", text: "src/2.ts · observed" },
      { status: "more", text: "… 2 more file observations" },
    ]);
  });

  it("uses controller verification rows and adds no recovery noise without file evidence", () => {
    const verified = turnSummaryPresentation({
      title: "done",
      changed: [],
      checked: [],
      fileEvidence: [
        {
          status: "available",
          text: "src/app.ts · observed file before → verified installed after",
        },
      ],
      ran: ["bash: tests passed"],
      receipt: ["verification · standard · passed"],
      attention: [],
    });
    expect(verified.verification).toBeUndefined();
    expect(verified.receipt).toContain("verification · standard · passed");

    const noMutation = turnSummaryPresentation({
      title: "done",
      changed: [],
      checked: [],
      ran: ["bash: tests passed"],
      attention: [],
    });
    expect(noMutation.verification).toBeUndefined();
    expect(noMutation.recovery).toBeUndefined();
  });

  it("counts summary-only unavailable file observations in the turn receipt", () => {
    const base = view([user("update the file"), assistant("The observation was unavailable.")], {
      turnSummary: {
        title: "done",
        changed: [],
        checked: [],
        fileEvidence: [
          {
            status: "unavailable",
            text: "write observation unavailable · safe display could not be produced",
          },
        ],
        attention: [],
      },
    });
    const turn = conversationPlan(base).blocks.find((block) => block.kind === "turn");

    expect(turn?.kind === "turn" ? turn.receipt : "").toContain("observations unavailable 1");
  });

  it("does not count blank file-observation rows that presentation discards", () => {
    const base = view([user("update the file"), assistant("No evidence was available.")], {
      turnSummary: {
        title: "done",
        changed: [],
        checked: [],
        fileEvidence: [
          { status: "available", text: " \n\t " },
          { status: "unavailable", text: "\u0000\u0001" },
        ],
        attention: [],
      },
    });
    const turn = conversationPlan(base).blocks.find((block) => block.kind === "turn");
    const receipt = turn?.kind === "turn" ? turn.receipt : "";

    expect(receipt).not.toContain("file evidence");
    expect(receipt).not.toContain("observations unavailable");
    expect(turn?.kind === "turn" ? turn.summary?.recovery : undefined).toBeUndefined();
  });

  it("reconciles receipt counts with sanitized visible summary rows", () => {
    const base = view([user("run it"), assistant("done")], {
      turnSummary: {
        title: "done",
        changed: [],
        checked: [" ", "\u0000", "bash: focused checks passed"],
        ran: [" ", "\u0001", "bash: build"],
        automatic: [" ", "queued input applied"],
        attention: [" ", "\u0000"],
      },
    });
    const turn = conversationPlan(base).blocks.find((block) => block.kind === "turn");
    const receipt = turn?.kind === "turn" ? turn.receipt : "";

    expect(receipt).toContain("checked 1");
    expect(receipt).toContain("ran 1");
    expect(receipt).toContain("automatic 1");
    expect(receipt).not.toContain("failed");
  });

  it.each([
    ["tracked dirty baseline", "available" as const],
    ["new file observed absent", "available" as const],
    ["stale or diverged postimage", "unavailable" as const],
    ["mutation observation unavailable", "unavailable" as const],
  ])("keeps recovery manual and non-destructive for %s", (text, status) => {
    const presentation = turnSummaryPresentation({
      title: "done",
      changed: [],
      checked: [],
      fileEvidence: [{ status, text }],
      attention: [],
    });

    expect(presentation.recovery).toEqual([
      "automatic undo unavailable — review file evidence and recover deliberately from version control or a backup",
    ]);
    expect(JSON.stringify(presentation.recovery)).not.toMatch(/git restore|\brm\b/u);
  });

  it("builds a compact evidence summary without promoting an unbound diff to changed", () => {
    const plan = conversationPlan(
      view(
        [
          user("fix the failing check"),
          assistant("I'll edit the file and run the check."),
          {
            kind: "tool",
            id: "edit-1",
            name: "edit",
            status: "ok",
            summary: "src/app.ts",
            diff: [
              { kind: "del", text: "old()" },
              { kind: "add", text: "new()" },
              { kind: "add", text: "alsoNew()" },
            ],
          },
          bash("bash-1", "41 passed"),
          bash("bash-3", "listed files"),
          failed("bash-2", "permission denied"),
        ],
        {
          turnSummary: {
            title: "needs attention",
            changed: ["edit: src/app.ts"],
            checked: ["bash: 41 passed"],
            attention: ["bash: permission denied"],
          },
          awaitingInput: true,
        },
      ),
    );

    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;

    expect(turn.evidence).toEqual({
      title: "evidence",
      lines: [
        {
          kind: "file-evidence-unavailable",
          text: "edit observation unavailable · governed observation capture was unavailable",
        },
        { kind: "checked", text: "bash: 41 passed" },
        { kind: "ran", text: "bash: listed files" },
        {
          kind: "failed",
          text: "bash: permission denied",
          why: "action did not complete cleanly",
          next: "fix the request or command, then retry",
        },
      ],
    });
    expect(JSON.stringify(turn.evidence)).not.toMatch(
      /approved|sandboxed|policy cleared|audit verified|trusted|autopilot/i,
    );
    expect(JSON.stringify(turn.evidence)).not.toMatch(/\/diff for details/i);
  });

  it("projects mutation evidence from the producer artifact without a changed-by-keel claim", () => {
    const available: ViewItem = {
      kind: "tool",
      id: "edit-observed",
      name: "edit",
      status: "ok",
      summary: "request/path.ts",
      mutationPresentation: {
        status: "available",
        operation: "edit",
        displayPath: "src/producer-redacted.ts",
        observedBefore: {
          status: "absent-observed",
        },
        verifiedInstalledAfter: {
          status: "file-observed",
          bytes: 8,
          mode: 0o600,
          contentClass: "text",
          finalNewline: true,
        },
        coverage: "summary-only",
        observedBeforeLines: 0,
        installedAfterLines: 1,
        shownLines: 0,
        hiddenLines: 1,
        transitionBinding: "not-atomic",
        concurrentMutation: "not-excluded",
      },
    };
    const unavailable: ViewItem = {
      kind: "tool",
      id: "write-uncaptured",
      name: "write",
      status: "ok",
      summary: "request/other.ts",
      mutationPresentation: { status: "unavailable", reason: "redaction-failed" },
    };
    const base = view([user("update two files"), available, unavailable, assistant("finished")]);
    const summary = buildTurnSummary(base);
    const plan = conversationPlan({
      ...base,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;

    const availableEvidence = turn.evidence?.lines.find((line) => line.kind === "file-evidence");
    expect(availableEvidence?.text).toContain("src/producer-redacted.ts");
    expect(turn.evidence?.lines).toContainEqual({
      kind: "file-evidence-unavailable",
      text: "write observation unavailable · safe display could not be produced",
    });
    expect(turn.evidence?.lines.some((line) => line.kind === "changed")).toBe(false);
    expect(JSON.stringify(turn.evidence)).not.toContain("request/path.ts");
    expect(JSON.stringify(turn.evidence)).not.toContain("request/other.ts");
    expect(turn.receipt).toContain("file evidence 1");
    expect(turn.receipt).toContain("observations unavailable 1");
    expect(turn.receipt).not.toContain("changed");
  });

  it("keeps unsupported mutation and indeterminate, skipped, limited states explicit", () => {
    const unsupported: ViewItem = {
      kind: "tool",
      id: "edit-unsupported",
      name: "edit",
      status: "ok",
      summary: "request-only.ts",
      mutationPresentation: { status: "unavailable", reason: "unsupported-peer" },
    };
    const partial = markToolPresentationOutcome(
      {
        kind: "tool" as const,
        id: "write-partial",
        name: "write",
        status: "error" as const,
        summary: "target may have changed",
      },
      "partial",
    );
    const skipped = markToolPresentationOutcome(
      {
        kind: "tool" as const,
        id: "bash-skipped",
        name: "bash",
        status: "error" as const,
        summary: "loop detected — this call was not run",
      },
      "skipped",
    );
    const limited = markToolPresentationOutcome(
      {
        kind: "tool" as const,
        id: "read-limited",
        name: "read",
        status: "ok" as const,
        summary: "first 64 KiB shown",
      },
      "limited",
    );
    const plan = conversationPlan(
      view([user("inspect outcomes"), unsupported, partial, skipped, limited], {
        awaitingInput: true,
      }),
    );
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;

    expect(turn.evidence?.lines.map((line) => line.kind)).toEqual([
      "file-evidence-unavailable",
      "limited",
      "partial",
      "skipped",
    ]);
    expect(turn.evidence?.lines[0]?.text).toBe(
      "edit observation unavailable · governed observation capture needs protocol 1.1",
    );
  });

  it("never recommends retrying a failed review settlement that may remain pending", () => {
    const base = view([
      user("run the reviewed action"),
      markReviewSettlementPresentation(
        problem(
          "review-still-pending",
          "review settlement failed · review may remain pending · do not retry automatically · restart session",
          "failed",
        ),
        "failed",
      ),
    ]);
    const summary = buildTurnSummary(base);
    const plan = conversationPlan({
      ...base,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;
    const failedLine = turn.evidence?.lines.find((line) => line.kind === "failed");

    expect(failedLine?.next).toBe("restart the governed session before deciding again");
    expect(failedLine?.next).not.toContain("retry");
  });

  it("explains an exact indeterminate review settlement without retry guidance", () => {
    const plan = conversationPlan(
      view([
        user("run the reviewed action"),
        markReviewSettlementPresentation(
          problem(
            "review-indeterminate",
            "review outcome indeterminate · action may have executed · do not retry automatically · inspect audit",
            "partial",
          ),
          "partial",
        ),
      ]),
    );
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;
    const partialLine = turn.evidence?.lines.find((line) => line.kind === "partial");

    expect(partialLine?.why).toBe(
      "review settlement crossed the deadline; final execution state is unknown",
    );
    expect(partialLine?.next).toBe("restart and inspect audit before deciding again");
  });

  it("keeps a partial edit path containing review language as mutation evidence", () => {
    const copiedPath = markToolPresentationOutcome(
      {
        kind: "tool" as const,
        id: "partial-edit",
        name: "edit",
        status: "error" as const,
        summary:
          "review outcome indeterminate · action may have executed · do not retry automatically · inspect audit",
      },
      "partial",
    );
    const plan = conversationPlan(view([user("edit the fixture"), copiedPath]));
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;
    const partialLine = turn.evidence?.lines.find((line) => line.kind === "partial");

    expect(partialLine?.why).toBe(
      "execution failed after mutation began; final target state is unknown",
    );
    expect(partialLine?.next).toBe("inspect the target before retrying");
  });

  it("keeps a failed edit path equal to pending-review copy as ordinary failure evidence", () => {
    const copiedPath = markToolPresentationOutcome(
      {
        kind: "tool" as const,
        id: "failed-edit",
        name: "edit",
        status: "error" as const,
        summary:
          "review settlement failed · review may remain pending · do not retry automatically · restart session",
      },
      "failed",
    );
    const plan = conversationPlan(view([user("edit the fixture"), copiedPath]));
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;
    const failedLine = turn.evidence?.lines.find((line) => line.kind === "failed");

    expect(failedLine?.why).toBe("action did not complete cleanly");
    expect(failedLine?.next).toBe("fix the request or command, then retry");
  });

  it("keeps stale review envelopes compact and non-actionable in evidence", () => {
    const plan = conversationPlan(
      view([
        user("run make"),
        problem(
          "bash-review",
          "warden review required (not executed): command review: command review for make in workspace /repo; [o] once [s] session [p] project (requires Project Autopilot) [d] deny [?] why; exact command envelope only; allow: keel approve command_review_1 --scope once --command-key sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "review",
        ),
      ]),
    );
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;

    const evidenceText = JSON.stringify(turn.evidence);
    expect(turn.evidence?.lines).toContainEqual({
      kind: "review",
      text: "bash: warden review required (not executed): command review: command review for make in workspace /repo",
      why: "the warden required a human decision; this result was not executed",
      next: "no live approval · simplify the request, then rerun",
    });
    expect(evidenceText).not.toContain("[o] once");
    expect(evidenceText).not.toContain("allow: keel approve");
    expect(turn.evidence?.lines.every((line) => line.text.length <= 120)).toBe(true);
  });

  it("explains a terminal review block without claiming a denial or pending human decision", () => {
    const plan = conversationPlan(
      view([
        user("run the diagnostic"),
        problem(
          "terminal-review",
          "blocked (not executed): no live decision available · POL-003 terminal review",
          "blocked",
        ),
      ]),
    );
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;

    expect(turn.receipt).toContain("blocked");
    expect(turn.receipt).not.toContain("review needed");
    expect(turn.evidence?.lines).toContainEqual({
      kind: "blocked",
      text: "bash: blocked (not executed): no live decision available · POL-003 terminal review",
      why: "no live decision is available; this result was not executed",
      next: "no live decision · simplify the request, then rerun",
    });
  });

  it("labels hard warden denials as blocked instead of review or generic failure", () => {
    const plan = conversationPlan(
      view(
        [
          user("run command"),
          problem("bash-1", "blocked by warden: POL-002 deny: write outside workspace", "blocked"),
        ],
        {
          turnSummary: {
            title: "needs attention",
            changed: [],
            checked: [],
            attention: ["bash: blocked by warden: POL-002 deny: write outside workspace"],
          },
        },
      ),
    );

    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;
    expect(turn.summary?.title).toBe("blocked");
    expect(turn.evidence?.lines).toContainEqual({
      kind: "blocked",
      text: "bash: blocked by warden: POL-002 deny: write outside workspace",
      why: "the warden denied the action before execution",
      next: "fix the request or command, then retry",
    });
  });

  it.each([
    [
      "blocked by warden (not executed): review closed as denied · Autopilot: no matching exact-domain grant",
      "Autopilot: no exact-domain grant",
    ],
    [
      "blocked by warden (not executed): review closed as denied · Autopilot: exact command envelope required",
      "Autopilot: exact command required",
    ],
  ] as const)("keeps the Autopilot boundary in compact blocked evidence", (detail, why) => {
    const base = view([user("run command"), problem("bash-1", detail, "blocked")]);
    const summary = buildTurnSummary(base);
    const plan = conversationPlan({
      ...base,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });
    const turn = plan.blocks.find((block) => block.kind === "turn");

    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;
    expect(turn.evidence?.lines[0]).toMatchObject({ kind: "blocked", why });
  });

  it("does not promote an embedded Autopilot phrase from an unclassified denial", () => {
    const base = view([
      user("run command"),
      problem(
        "bash-1",
        "blocked by warden (not executed): requester says Autopilot: no matching exact-domain grant",
        "blocked",
      ),
    ]);
    const summary = buildTurnSummary(base);
    const plan = conversationPlan({
      ...base,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });
    const turn = plan.blocks.find((block) => block.kind === "turn");

    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;
    expect(turn.evidence?.lines[0]).toMatchObject({
      kind: "blocked",
      why: "the warden denied the action before execution",
    });
  });

  it("keeps exact Warden denial guidance as the unresolved safe next action", () => {
    const guidance =
      "edit: read 'CHANGES.md' before editing it - keel requires reading a file this session before editing it";
    const base = view([
      user("update CHANGES.md"),
      markToolPresentationOutcome(
        {
          kind: "tool",
          id: "edit-1",
          name: "edit",
          status: "error",
          summary: `blocked by warden (not executed): ${guidance}`,
        } as const,
        "blocked",
      ),
    ]);
    const summary = buildTurnSummary(base);
    const plan = conversationPlan({
      ...base,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });
    const turn = plan.blocks.find((block) => block.kind === "turn");

    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;
    expect(turn.evidence?.lines[0]).toMatchObject({
      kind: "blocked",
      why: "the warden denied the action before execution",
      next: guidance,
    });
    expect(turn.evidence?.lines[0]?.text).toContain(
      "edit: blocked by warden (not executed): edit: read 'CHANGES.md'",
    );
  });

  it("does not invent recovery when a Warden denial has no useful guidance", () => {
    const base = view([
      user("update CHANGES.md"),
      problem("edit-1", "blocked by warden (not executed): denied", "blocked"),
    ]);
    const summary = buildTurnSummary(base);
    const plan = conversationPlan({
      ...base,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });
    const turn = plan.blocks.find((block) => block.kind === "turn");

    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;
    expect(turn.evidence?.lines[0]?.next).toBe(
      "Warden recovery guidance unavailable · stop and ask the user before retrying",
    );
  });

  it("bounds, de-controls, and redacts denial recovery guidance", () => {
    const secret = "sk-ant-api03-abcDEF123456789_ghijklmnop-qrstuvwxyz0123456789AA";
    const guidance = `POL-002 deny: ${secret} ${"wide ".repeat(40)}read CHANGES.md before editing\u001b[2J`;
    const base = view([
      user("update CHANGES.md"),
      problem("edit-1", `blocked by warden (not executed): ${guidance}`, "blocked"),
    ]);
    const summary = buildTurnSummary(base);
    const plan = conversationPlan({
      ...base,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });
    const turn = plan.blocks.find((block) => block.kind === "turn");

    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;
    const next = turn.evidence?.lines[0]?.next ?? "";
    expect(next).toContain("read CHANGES.md before editing");
    expect(next).toContain("[redacted:anthropic-key]");
    expect(next).not.toContain(secret);
    expect(next).not.toContain("\u001b");
    expect(terminalDisplayWidth(next)).toBeLessThanOrEqual(120);
  });

  it("does not repeat a long failed tool when its derived receipt is truncated", () => {
    const failure =
      "blocked by warden (not executed): POL-002 deny: write outside workspace; use a path under the workspace or declared temp root";
    const base = view([user("write outside"), problem("write-1", failure, "blocked")]);
    const summary = buildTurnSummary(base);
    expect(summary?.attention[0]).toContain("declared temp root");

    const plan = conversationPlan({
      ...base,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;

    expect(turn.evidence?.lines.filter((line) => line.kind === "blocked")).toHaveLength(1);
  });

  it("bounds wide Unicode denial receipts by cells while preserving the distinguishing path tail", () => {
    const failure = `blocked by warden (not executed): POL-002 deny: ${"界".repeat(100)} e\u0301 👩🏽‍💻 /outside/important-file.txt`;
    const base = view([user("write outside"), problem("write-wide", failure, "blocked")]);
    const summary = buildTurnSummary(base);
    const plan = conversationPlan({
      ...base,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;

    const blocked = turn.evidence?.lines.find((line) => line.kind === "blocked");
    expect(blocked).toBeDefined();
    expect(terminalDisplayWidth(blocked?.text ?? "")).toBeLessThanOrEqual(120);
    expect(blocked?.text).toContain("/outside/important-file.txt");
  });

  it("keeps distinct long denials visible when only their truncated middle differs", () => {
    const prefix = `blocked by warden (not executed): POL-002 deny: ${"same prefix ".repeat(12)}`;
    const suffix = `${"same suffix ".repeat(12)} retry with a workspace path`;
    const alpha = `${prefix}RESOURCE_ALPHA ${suffix}`;
    const beta = `${prefix}RESOURCE_BETA ${suffix}`;
    const base = view([
      user("try two resources"),
      problem("write-1", alpha, "blocked"),
      problem("write-2", beta, "blocked"),
    ]);
    const summary = buildTurnSummary(base);

    expect(summary?.attention).toHaveLength(2);
    expect(summary?.attention[0]).toContain("RESOURCE_ALPHA");
    expect(summary?.attention[1]).toContain("RESOURCE_BETA");

    const plan = conversationPlan({
      ...base,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;

    const blocked = turn.evidence?.lines.filter((line) => line.kind === "blocked") ?? [];
    expect(blocked).toHaveLength(2);
    expect(blocked.map((line) => line.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[distinct 1/2]"),
        expect.stringContaining("[distinct 2/2]"),
      ]),
    );
    expect(blocked.map((line) => line.text).join("\n")).toContain("RESOURCE_ALPHA");
    expect(blocked.map((line) => line.text).join("\n")).toContain("RESOURCE_BETA");
    expect(blocked.every((line) => !line.text.includes("(2 times)"))).toBe(true);
  });

  it("keeps distinct long denials visible when their prefixes match", () => {
    const prefix = `blocked by warden (not executed): POL-002 deny: ${"same reason ".repeat(12)}`;
    const base = view([
      user("try two paths"),
      problem("write-1", `${prefix}/outside/alpha.txt`, "blocked"),
      problem("write-2", `${prefix}/outside/beta.txt`, "blocked"),
    ]);
    const summary = buildTurnSummary(base);
    const plan = conversationPlan({
      ...base,
      ...(summary === undefined ? {} : { turnSummary: summary }),
    });
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;

    const blocked = turn.evidence?.lines.filter((line) => line.kind === "blocked") ?? [];
    expect(blocked).toHaveLength(2);
    expect(blocked.map((line) => line.text).join("\n")).toContain("alpha.txt");
    expect(blocked.map((line) => line.text).join("\n")).toContain("beta.txt");
    expect(blocked.every((line) => !line.text.includes("(2 times)"))).toBe(true);
  });

  it("never compacts distinct denials that collide under the legacy short hash", () => {
    const base = view([
      user("try two resources"),
      problem("write-1", "blocked by warden: pol-002 deny resource-25479", "blocked"),
      problem("write-2", "blocked by warden: pol-002 deny resource-31181", "blocked"),
    ]);
    const plan = conversationPlan(base);
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;

    const blocked = turn.evidence?.lines.filter((line) => line.kind === "blocked") ?? [];
    expect(blocked).toHaveLength(2);
    expect(blocked.map((line) => line.text).join("\n")).toContain("resource-25479");
    expect(blocked.map((line) => line.text).join("\n")).toContain("resource-31181");
    const visible = visibleTurnItemsWithIndexes(turn.items, undefined).map(({ item }) => item);
    expect(visible.filter((item) => item.kind === "tool")).toHaveLength(2);
    expect(
      visible.some(
        (item) =>
          item.kind === "message" && item.content.includes("similar tool failure compacted"),
      ),
    ).toBe(false);
  });

  it("never compacts denials for resources that differ only by case", () => {
    const base = view([
      user("try two case-sensitive resources"),
      problem("write-1", "blocked by warden: POL-002 deny /workspace/Secrets.txt", "blocked"),
      problem("write-2", "blocked by warden: POL-002 deny /workspace/secrets.txt", "blocked"),
    ]);
    const plan = conversationPlan(base);
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;

    const visible = visibleTurnItemsWithIndexes(turn.items, undefined).map(({ item }) => item);
    expect(visible.filter((item) => item.kind === "tool")).toHaveLength(2);
    expect(
      visible.some(
        (item) =>
          item.kind === "message" && item.content.includes("similar tool failure compacted"),
      ),
    ).toBe(false);
  });

  it("never treats review-like substrings in denied resource names as volatile IDs", () => {
    const base = view([
      user("try two review-named resources"),
      problem(
        "write-1",
        "blocked by warden: POL-002 deny /workspace/review_deadbeef.txt",
        "blocked",
      ),
      problem(
        "write-2",
        "blocked by warden: POL-002 deny /workspace/review_cafebabe.txt",
        "blocked",
      ),
    ]);
    const plan = conversationPlan(base);
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;

    const visible = visibleTurnItemsWithIndexes(turn.items, undefined).map(({ item }) => item);
    expect(visible.filter((item) => item.kind === "tool")).toHaveLength(2);
    expect(
      visible.some(
        (item) =>
          item.kind === "message" && item.content.includes("similar tool failure compacted"),
      ),
    ).toBe(false);
  });

  it("never compacts review denials for different exact command keys", () => {
    const alphaKey = `sha256:${"a".repeat(64)}`;
    const betaKey = `sha256:${"b".repeat(64)}`;
    const prefix =
      "warden review required (not executed): POL-003 review: exact command requires approval;";
    const base = view([
      user("try two exact commands"),
      problem("bash-1", `${prefix} --command-key ${alphaKey}`, "review"),
      problem("bash-2", `${prefix} --command-key ${betaKey}`, "review"),
    ]);
    const plan = conversationPlan(base);
    const turn = plan.blocks.find((block) => block.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;

    const visible = visibleTurnItemsWithIndexes(turn.items, undefined).map(({ item }) => item);
    expect(visible.filter((item) => item.kind === "tool")).toHaveLength(2);
    expect(
      visible.some(
        (item) =>
          item.kind === "message" && item.content.includes("similar tool failure compacted"),
      ),
    ).toBe(false);
  });
});

describe("visibleTurnItemsWithIndexes scaling", () => {
  it("does not rescan the remaining transcript for every routine tool", () => {
    const count = 400;
    const source: ViewItem[] = [
      ...Array.from({ length: count }, (_, index) => bash(`routine-${index}`, "done")),
      assistant("final answer"),
    ];
    let indexedReads = 0;
    const items = new Proxy(source, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) indexedReads += 1;
        const value = Reflect.get(target, property, receiver) as unknown;
        return value;
      },
    });

    expect(visibleTurnItemsWithIndexes(items, "normal").map(({ item }) => item)).toEqual([
      assistant("final answer"),
    ]);
    expect(indexedReads).toBeLessThan(count * 20);
  });

  it.each([
    { density: "quiet" as const, options: {} },
    { density: "verbose" as const, options: {} },
    { density: "debug" as const, options: {} },
    { density: "normal" as const, options: { retainSuccessfulTools: true } },
  ])(
    "does not build the unused answer-first suffix in $density density",
    ({ density, options }) => {
      const count = 400;
      const source: ViewItem[] = [
        ...Array.from({ length: count }, (_, index) => bash(`routine-${index}`, "done")),
        assistant("final answer"),
      ];
      let indexedReads = 0;
      const items = new Proxy(source, {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/u.test(property)) indexedReads += 1;
          const value = Reflect.get(target, property, receiver) as unknown;
          return value;
        },
      });

      visibleTurnItemsWithIndexes(items, density, options);

      expect(indexedReads).toBeLessThan(source.length * 2.5);
    },
  );
});

describe("transcriptCommitPlan", () => {
  it("does not detach an already-owned turn summary when planning a later suffix", () => {
    const summary: UiTurnSummary = {
      title: "done",
      answer: "old answer",
      changed: ["edit: src/old.ts"],
      checked: ["bash: old tests passed"],
      attention: [],
    };

    const suffix = transcriptCommitPlan(
      view([user("old"), assistant("old answer")], {
        awaitingInput: true,
        turnSummary: summary,
      }),
      { sourceOffset: 2 },
    );

    expect(suffix.staticBlocks).toHaveLength(0);
    expect(suffix.livePlan.blocks).toHaveLength(0);
    expect(suffix.livePlan.standaloneSummary).toBeUndefined();
    expect(conversationPlan(view([], { turnSummary: summary })).standaloneSummary).toBeDefined();
  });

  it("plans an append-only suffix with absolute block indexes and keeps a late system notice visible", () => {
    const nextTurn = transcriptCommitPlan(
      view([user("old"), assistant("old answer"), user("new"), assistant("partial")], {
        streaming: true,
      }),
      { sourceOffset: 2 },
    );
    expect(nextTurn.staticBlocks).toHaveLength(0);
    expect(nextTurn.livePlan.blocks[0]?.id).toMatch(/^turn:2:/);
    expect(nextTurn.livePlan.blocks[0]?.startIndex).toBe(2);

    const lateNotice = transcriptCommitPlan(
      view(
        [
          user("old"),
          assistant("old answer"),
          { kind: "message", role: "system", content: "fixture provider failure" },
        ],
        { awaitingInput: true },
      ),
      { sourceOffset: 2 },
    );
    expect(lateNotice.livePlan.blocks[0]?.kind).toBe("items");
    expect(lateNotice.livePlan.blocks[0]?.startIndex).toBe(2);
    expect(
      lateNotice.livePlan.blocks[0]?.kind === "items"
        ? lateNotice.livePlan.blocks[0].items[0]
        : undefined,
    ).toEqual({ kind: "message", role: "system", content: "fixture provider failure" });
  });

  it("commits only the settled leading prefix and keeps an active streaming turn live", () => {
    const active = transcriptCommitPlan(
      view([user("one"), assistant("answer one"), user("two"), assistant("partial answer")], {
        streaming: true,
      }),
    );

    expect(active.staticBlocks).toHaveLength(1);
    expect(active.staticBlocks[0]?.kind).toBe("turn");
    expect(active.staticBlocks[0]?.id).toMatch(/^turn:0:/);
    expect(active.livePlan.blocks).toHaveLength(1);
    const liveTurn = active.livePlan.blocks[0];
    expect(liveTurn?.kind).toBe("turn");
    if (liveTurn?.kind !== "turn") return;
    expect(liveTurn.id).toMatch(/^turn:2:/);
    expect(liveTurn.user.content).toBe("two");

    const updated = transcriptCommitPlan(
      view(
        [user("one"), assistant("answer one"), user("two"), assistant("partial answer plus more")],
        { streaming: true },
      ),
    );
    expect(updated.staticBlocks.map((block) => block.id)).toEqual(
      active.staticBlocks.map((block) => block.id),
    );
    expect(updated.livePlan.blocks[0]?.id).toBe(liveTurn.id);
  });

  it("withholds a running tool turn until the final receipt boundary has arrived", () => {
    const running = transcriptCommitPlan(
      view([
        user("run tests"),
        { kind: "tool", id: "c1", name: "bash", status: "running", summary: "" },
      ]),
    );

    expect(running.staticBlocks).toHaveLength(0);
    expect(running.livePlan.blocks).toHaveLength(1);

    const toolSettledBeforeReceipt = transcriptCommitPlan(
      view([user("run tests"), bash("c1", "41 passed")]),
    );
    expect(toolSettledBeforeReceipt.staticBlocks).toHaveLength(0);
    expect(toolSettledBeforeReceipt.livePlan.blocks).toHaveLength(1);

    const settled = transcriptCommitPlan(
      view([user("run tests"), bash("c1", "41 passed")], {
        turnSummary: {
          title: "done",
          changed: [],
          checked: ["bash: 41 passed"],
          attention: [],
        },
      }),
    );
    expect(settled.staticBlocks).toHaveLength(1);
    expect(settled.staticBlocks[0]?.id).toMatch(/^turn:0:/);
    expect(settled.livePlan.blocks).toHaveLength(0);
  });

  it("does not treat a mid-run system notice as an immutable boundary for a running tool", () => {
    const plan = transcriptCommitPlan(
      view(
        [
          user("run tests"),
          { kind: "tool", id: "c1", name: "bash", status: "running", summary: "" },
          { kind: "message", role: "system", content: "diff view: full for this session" },
        ],
        { streaming: true },
      ),
    );

    expect(plan.staticBlocks).toHaveLength(0);
    expect(plan.livePlan.blocks).toHaveLength(2);
    expect(plan.livePlan.blocks[0]?.kind).toBe("turn");
    expect(plan.livePlan.blocks[1]?.kind).toBe("items");
  });

  it("keeps the latest turn live across a mid-run controller notice until its summary arrives", () => {
    const items: ViewItem[] = [
      user("fetch the documentation pages"),
      bash("first", "stdout: first page"),
      {
        kind: "message",
        role: "system",
        presentation: "notice",
        content:
          "approval settled · approved exact session scope\n" +
          "history · earlier approval-required block is historical/resolved",
      },
      bash("second", "stdout: second page"),
    ];

    const betweenProviderTurns = transcriptCommitPlan(view(items));

    expect(betweenProviderTurns.staticBlocks).toHaveLength(0);
    expect(betweenProviderTurns.livePlan.blocks.map((block) => block.kind)).toEqual([
      "turn",
      "items",
    ]);

    const settled = transcriptCommitPlan(
      view(items, {
        awaitingInput: true,
        turnSummary: {
          title: "done",
          changed: [],
          checked: [],
          attention: [],
          automatic: [
            "session grant (until session exit) allowed bash via domain example.com " +
              "(review egress_review_2, audit #4)",
          ],
        },
      }),
    );
    const settledTurn = settled.staticBlocks.find((block) => block.kind === "turn");

    expect(settledTurn?.kind).toBe("turn");
    if (settledTurn?.kind !== "turn") return;
    expect(settledTurn.summary?.automatic).toEqual([
      "session grant (until session exit) allowed bash via domain example.com " +
        "(review egress_review_2, audit #4)",
    ]);

    const continued = transcriptCommitPlan(
      view([...items, user("start a distinct turn"), assistant("working")], {
        streaming: true,
      }),
    );
    expect(continued.staticBlocks.map((block) => block.kind)).toEqual(["turn", "items"]);
    expect(continued.livePlan.blocks).toHaveLength(1);
    expect(continued.livePlan.blocks[0]?.kind).toBe("turn");
  });

  it("keeps the current idle system panel live, then commits it after the next turn starts", () => {
    const complete = transcriptCommitPlan(
      view([user("inspect"), assistant("done")], { awaitingInput: true }),
    );
    expect(complete.staticBlocks).toHaveLength(1);
    const turnId = complete.staticBlocks[0]?.id;

    const withPanel = transcriptCommitPlan(
      view(
        [
          user("inspect"),
          assistant("done"),
          { kind: "message", role: "system", content: "context\n  window: n/a" },
        ],
        { awaitingInput: true },
      ),
    );

    expect(withPanel.staticBlocks).toHaveLength(1);
    expect(withPanel.staticBlocks[0]?.id).toBe(turnId);
    expect(withPanel.livePlan.blocks).toHaveLength(1);
    expect(withPanel.livePlan.blocks[0]?.kind).toBe("items");
    expect(withPanel.livePlan.blocks[0]?.id).toMatch(/^items:2:/);

    const withNextTurn = transcriptCommitPlan(
      view([
        user("inspect"),
        assistant("done"),
        { kind: "message", role: "system", content: "context\n  window: n/a" },
        user("next"),
        assistant("working"),
      ]),
    );
    expect(withNextTurn.staticBlocks).toHaveLength(2);
    expect(withNextTurn.staticBlocks[1]?.kind).toBe("items");
    expect(withNextTurn.staticBlocks[1]?.id).toMatch(/^items:2:/);
    expect(withNextTurn.livePlan.blocks).toHaveLength(1);
  });

  it("keeps only the latest idle system panel live while older panels move to static scrollback", () => {
    const plan = transcriptCommitPlan(
      view(
        [
          user("inspect"),
          assistant("done"),
          { kind: "message", role: "system", content: "context\n  window: n/a" },
          { kind: "message", role: "system", content: "model\n  current: sonnet" },
        ],
        { awaitingInput: true },
      ),
    );

    expect(plan.staticBlocks).toHaveLength(2);
    expect(plan.staticBlocks[1]?.kind).toBe("items");
    expect(plan.staticBlocks[1]?.kind === "items" ? plan.staticBlocks[1].items : []).toEqual([
      { kind: "message", role: "system", content: "context\n  window: n/a" },
    ]);
    expect(plan.livePlan.blocks).toHaveLength(1);
    expect(plan.livePlan.blocks[0]?.kind).toBe("items");
    expect(plan.livePlan.blocks[0]?.kind === "items" ? plan.livePlan.blocks[0].items : []).toEqual([
      { kind: "message", role: "system", content: "model\n  current: sonnet" },
    ]);
  });

  it("keeps all blocks after the first unsettled block live to preserve transcript order", () => {
    const plan = transcriptCommitPlan(
      view([
        user("active first"),
        { kind: "tool", id: "c1", name: "bash", status: "running", summary: "" },
        user("later"),
        assistant("already complete but after active work"),
      ]),
    );

    expect(plan.staticBlocks).toHaveLength(0);
    expect(plan.livePlan.blocks).toHaveLength(2);
    expect(plan.livePlan.blocks[0]?.id).toMatch(/^turn:0:/);
    expect(plan.livePlan.blocks[1]?.id).toMatch(/^turn:2:/);
  });
});

describe("screenAnatomyPlan", () => {
  it("defines a stable idle first-run anatomy with launch, status, composer, and hint regions", () => {
    const anatomy = screenAnatomyPlan(
      view([], {
        firstRun: true,
        recentSessions: [],
      }),
    );

    expect(anatomy.frame).toBe("idle");
    expect(anatomy.regions.map((region) => region.kind)).toEqual([
      "launch",
      "status",
      "composer",
      "hint",
    ]);
    expect(anatomy.regions.map((region) => region.label)).toEqual([
      "keel",
      "status",
      "input",
      "hint",
    ]);
  });

  it("defines running anatomy with settled transcript before the active turn", () => {
    const anatomy = screenAnatomyPlan(
      view(
        [
          user("explain this"),
          assistant("This is a harness."),
          user("run tests"),
          { kind: "tool", id: "c1", name: "bash", status: "running", summary: "" },
        ],
        {
          streaming: false,
          currentTurn: {
            doing: "running bash",
            why: "latest visible event is a running tool",
            next: "waiting for tool result",
          },
        },
      ),
    );

    expect(anatomy.frame).toBe("running");
    expect(anatomy.regions.map((region) => region.kind)).toEqual([
      "transcript",
      "active-turn",
      "status",
      "composer",
      "hint",
    ]);
    expect(anatomy.regions.find((region) => region.kind === "active-turn")).toMatchObject({
      label: "running",
      state: "running",
    });
  });

  it("defines review-needed anatomy with the review region before status and composer", () => {
    const anatomy = screenAnatomyPlan(
      view([user("run tests"), failed("c1", "permission denied")], {
        awaitingInput: true,
        turnSummary: {
          title: "needs attention",
          changed: [],
          checked: [],
          attention: ["bash: permission denied"],
        },
      }),
    );

    expect(anatomy.frame).toBe("review-needed");
    expect(anatomy.regions.map((region) => region.kind)).toEqual([
      "transcript",
      "review",
      "status",
      "composer",
      "hint",
    ]);
    expect(anatomy.regions.find((region) => region.kind === "review")).toMatchObject({
      label: "review needed",
      state: "review",
    });
  });

  it("classifies visible failed-tool receipts as review-needed before a final summary exists", () => {
    const anatomy = screenAnatomyPlan(
      view([user("run tests"), failed("c1", "permission denied")], {
        awaitingInput: true,
      }),
    );

    expect(anatomy.frame).toBe("review-needed");
    expect(anatomy.regions.map((region) => region.kind)).toEqual([
      "transcript",
      "review",
      "status",
      "composer",
      "hint",
    ]);
  });

  it("defines done anatomy with transcript, receipt, status, composer, and hint", () => {
    const anatomy = screenAnatomyPlan(
      view([user("what is this repo?"), assistant("It is keel.")], {
        awaitingInput: true,
        turnSummary: {
          title: "done",
          answer: "It is keel.",
          changed: [],
          checked: ["bash: 41 passed"],
          attention: [],
        },
      }),
    );

    expect(anatomy.frame).toBe("done");
    expect(anatomy.regions.map((region) => region.kind)).toEqual([
      "transcript",
      "receipt",
      "status",
      "composer",
      "hint",
    ]);
    expect(anatomy.regions.find((region) => region.kind === "receipt")).toMatchObject({
      label: "done",
      state: "done",
    });
  });
});
