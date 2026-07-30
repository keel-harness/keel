import { describe, expect, it } from "vitest";
import type { ModelMessageT, SessionEventT, TaskStateT } from "@keel/shared";
import { renderLedger } from "../tools/plan.js";
import { compact, estimateMessagesTokens } from "./compact.js";
import { LEDGER_NOTE_MARKER, runDeterministicPass } from "./compress/pass.js";

const ts = "2026-06-15T00:00:00.000Z";

/** A consistent (ledger, messages) pair: read src/slug.ts (a big body), edit it, then a final note. */
const events: SessionEventT[] = [
  { type: "user", v: 1, ts, content: "implement slugify" },
  {
    type: "assistant",
    v: 1,
    ts,
    content: "",
    toolCalls: [{ id: "r1", name: "read", args: { path: "src/slug.ts" } }],
  },
  { type: "tool_result", v: 1, ts, toolCallId: "r1", name: "read", output: "X".repeat(800) },
  {
    type: "assistant",
    v: 1,
    ts,
    content: "",
    toolCalls: [
      { id: "e1", name: "edit", args: { path: "src/slug.ts", oldString: "a", newString: "b" } },
    ],
  },
  { type: "tool_result", v: 1, ts, toolCallId: "e1", name: "edit", output: "edited 1 occurrence" },
  { type: "assistant", v: 1, ts, content: "slugify implemented" },
];

const messages: ModelMessageT[] = [
  { role: "system", content: "SYSTEM PROMPT — pinned" },
  { role: "user", content: "implement slugify" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "r1", name: "read", args: { path: "src/slug.ts" } }],
  },
  { role: "tool", content: "X".repeat(800), toolCallId: "r1", name: "read" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "e1", name: "edit", args: { path: "src/slug.ts", oldString: "a", newString: "b" } },
    ],
  },
  { role: "tool", content: "edited 1 occurrence", toolCallId: "e1", name: "edit" },
  { role: "assistant", content: "slugify implemented" },
];

/** A minimal TaskState with the factual fields populated (the rest empty). */
const mkTaskState = (over: Partial<TaskStateT>): TaskStateT => ({
  taskGoal: "implement slugify",
  currentStatus: "done",
  currentPhase: "review",
  constraints: [],
  plan: [],
  completedSteps: [],
  nextSteps: [],
  filesRead: [],
  filesModified: [],
  decisions: [],
  failedAttempts: [],
  testState: [],
  currentErrors: [],
  blockers: [],
  artifactRefs: [],
  policyNotes: [],
  provenanceNotes: [],
  memoryCandidates: [],
  unresolvedQuestions: [],
  ...over,
});

/** A faithful summarizer: claims exactly what the ledger backs (files read/modified). */
const faithful = (): TaskStateT =>
  mkTaskState({
    filesRead: [
      { path: "src/slug.ts", status: "read", summary: "the slug module", artifactRefs: [] },
    ],
    filesModified: [
      { path: "src/slug.ts", status: "modified", summary: "added slugify", artifactRefs: [] },
    ],
  });

describe("estimateMessagesTokens", () => {
  it("sums per-message content estimates plus a small structural overhead", () => {
    expect(estimateMessagesTokens([])).toBe(0);
    // 'X'*800 ≈ 200 tokens + 4 overhead, well above the others
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(200);
  });
});

describe("compact (§4.7.4 — fold the middle into the typed summary; keep pinned + recent verbatim)", () => {
  it("keeps the pinned system prompt, injects the typed summary, keeps the recent tail, shrinks tokens", async () => {
    const r = await compact({
      messages,
      events,
      budgetTokens: 1000,
      trigger: "token_soft",
      summarize: faithful,
      recentVerbatimTurns: 2,
      compactorModel: "sim",
    });

    // pinned system prompt stays first; the typed summary is the next message
    expect(r.messages[0]).toEqual({ role: "system", content: "SYSTEM PROMPT — pinned" });
    expect(r.messages[1]?.role).toBe("system");
    expect(r.messages[1]?.content).toContain("# Compacted Session State");
    expect(r.messages[1]?.content).toContain("src/slug.ts"); // the ledger-derived file survives the fold
    // the recent tail is preserved verbatim at the end
    expect(r.messages.at(-1)).toEqual({ role: "assistant", content: "slugify implemented" });
    // the big folded tool body is gone from the active context — but its derived fact remains
    expect(r.messages.some((m) => m.content.includes("X".repeat(800)))).toBe(false);
    expect(r.event.tokensAfter).toBeLessThan(r.event.tokensBefore);
    expect(estimateMessagesTokens(r.messages)).toBe(r.event.tokensAfter);
  });

  it("records an auditable CompactionEvent (trigger, token deltas, validation, fail-closed trust)", async () => {
    const r = await compact({
      messages,
      events,
      budgetTokens: 1000,
      trigger: "token_hard",
      summarize: faithful,
      recentVerbatimTurns: 2,
      compactorModel: "sim",
    });
    expect(r.event.type).toBe("compaction");
    expect(r.event.v).toBe(1);
    expect(r.event.compactionId.length).toBeGreaterThan(0);
    expect(r.event.trigger).toBe("token_hard");
    expect(r.event.compactorModel).toBe("sim");
    expect(r.event.validation).toBe("passed"); // faithful summary, nothing repaired
    expect(r.event.probesPassed).toBe(true);
    expect(r.event.trust).toBe("unknown"); // Phase-1 fail-closed (no taint tracking until Phase 3)
    expect(r.event.summaryHash.length).toBeGreaterThan(0);
    expect(r.event.tokensBefore).toBe(estimateMessagesTokens(messages));
  });

  it("strips a leading orphan tool result from the tail so the swapped history stays valid", async () => {
    // recentVerbatimTurns = 1 would make the tail begin at the final assistant; use 2 so the tail
    // would start with the edit's tool_result whose assistant turn is folded away → must be dropped.
    const r = await compact({
      messages,
      events,
      budgetTokens: 1000,
      trigger: "token_soft",
      summarize: faithful,
      recentVerbatimTurns: 2,
    });
    // no tool message may appear after the summary (the only retained tail message is the assistant note)
    const afterSummary = r.messages.slice(2);
    expect(afterSummary.every((m) => m.role !== "tool")).toBe(true);
  });

  it("repairs an invented file claim from the summarizer before it becomes context (anti-hallucination)", async () => {
    const lying = (): TaskStateT =>
      mkTaskState({
        filesModified: [
          { path: "src/slug.ts", status: "modified", summary: "real", artifactRefs: [] },
          { path: "ghost.ts", status: "modified", summary: "INVENTED", artifactRefs: [] },
        ],
      });
    const r = await compact({
      messages,
      events,
      budgetTokens: 1000,
      trigger: "token_soft",
      summarize: lying,
      recentVerbatimTurns: 2,
    });
    expect(r.event.validation).toBe("repaired"); // the invention was caught
    expect(r.event.probesPassed).toBe(true); // the swapped (repaired) state is invention-free
    expect(r.summary).not.toContain("ghost.ts"); // the lie never reaches the active context
    expect(r.summary).toContain("src/slug.ts"); // the real modification is kept
    expect(r.taskState.filesModified.map((f) => f.path)).toEqual(["src/slug.ts"]);
  });

  it("does not mutate the input ledger (the record that the calls occurred is never erased)", async () => {
    const before = JSON.stringify(events);
    await compact({
      messages,
      events,
      budgetTokens: 1000,
      trigger: "token_soft",
      summarize: faithful,
    });
    expect(JSON.stringify(events)).toBe(before);
  });
});

describe("compact — the in-session task ledger survives a compaction verbatim (§4.9.7 / §8.6 golden)", () => {
  const ledger = renderLedger([
    { text: "reproduce failure", status: "done" },
    { text: "patch refresh-token expiry", status: "current" },
    { text: "run auth tests", status: "pending" },
  ]);

  // A session where the model set its plan early, then did work that pushes the plan into the
  // folded (older) region — exactly the case where a naive fold would drop the ledger.
  const withLedger: ModelMessageT[] = [
    { role: "system", content: "SYS" },
    { role: "user", content: "fix the auth bug" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "p1", name: "plan", args: { items: [] } }],
    },
    { role: "tool", content: ledger, toolCallId: "p1", name: "plan" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "r1", name: "read", args: { path: "a.ts" } }],
    },
    { role: "tool", content: "X".repeat(600), toolCallId: "r1", name: "read" },
    { role: "assistant", content: "patched it" },
    { role: "user", content: "now run the tests" },
  ];

  it("re-pins the latest ledger (a done step is not dropped; pending steps survive) and folds the rest", async () => {
    const r = await compact({
      messages: withLedger,
      events: [],
      budgetTokens: 1000,
      trigger: "token_soft",
      summarize: () => mkTaskState({}),
      recentVerbatimTurns: 2, // the plan is older than the tail → it would be folded without preservation
    });

    // the ledger is preserved EXACTLY (verbatim), as a pinned message — not summarized away
    expect(r.messages.some((m) => m.content === ledger)).toBe(true);
    // completed vs pending preserved: the done glyph and a pending step both survive
    const pinnedLedger = r.messages.find((m) => m.content === ledger)!;
    expect(pinnedLedger.content).toContain("✓ reproduce failure"); // a done step is not dropped
    expect(pinnedLedger.content).toContain("□ run auth tests"); // a pending step survives
    // the big folded tool body is gone; the recent tail is kept
    expect(r.messages.some((m) => m.content.includes("X".repeat(600)))).toBe(false);
    expect(r.messages.at(-1)).toEqual({ role: "user", content: "now run the tests" });
  });

  it("does not duplicate the ledger when it is already in the recent-verbatim tail", async () => {
    const r = await compact({
      messages: withLedger,
      events: [],
      budgetTokens: 1000,
      trigger: "token_soft",
      summarize: () => mkTaskState({}),
      recentVerbatimTurns: 8, // the whole rest (incl. the plan) stays in the tail
    });
    expect(r.messages.filter((m) => m.content === ledger)).toHaveLength(1);
  });
});

describe("compact — a LARGE plan ledger survives the deterministic pass + fold VERBATIM (§4.7.2 / §8.6 golden)", () => {
  // A plan rendered well over the generic compressor's 4096-byte truncation budget: 60 items × a
  // long label so `renderLedger` exceeds 4096 chars and the deterministic pass WOULD truncate it.
  const bigLedger = renderLedger(
    Array.from({ length: 60 }, (_, i) => ({
      text: `step ${String(i)}: ${"detail ".repeat(12)}item-${String(i)}`,
      status: i === 0 ? ("current" as const) : ("pending" as const),
    })),
  );

  // A large, highly-compressible NON-plan body (duplicate lines, well over the 4096-byte budget) — the
  // control proving the fix does not over-reach: this body MUST still compress.
  const bigRead = Array.from({ length: 400 }, () => "duplicate log line").join("\n");

  // The plan is set early then pushed into the aged (foldable) region by later work — exactly when a
  // naive pass would compress its body before `compact()` re-pins it.
  const withBigLedger: ModelMessageT[] = [
    { role: "system", content: "SYS" },
    { role: "user", content: "do the big task" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "p1", name: "plan", args: { items: [] } }],
    },
    { role: "tool", content: bigLedger, toolCallId: "p1", name: "plan" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "r1", name: "read", args: { path: "a.ts" } }],
    },
    { role: "tool", content: bigRead, toolCallId: "r1", name: "read" },
    { role: "assistant", content: "worked on it" },
    { role: "user", content: "keep going" },
  ];

  it("guards the fixture: the big ledger really exceeds the 4096-byte compression budget", () => {
    expect(bigLedger.length).toBeGreaterThan(4096);
  });

  it("the deterministic pass leaves the LATEST plan body verbatim (it is never compressed)", () => {
    // budget tiny + headroom 0 → target ≈ 0 → the pass tries to compress every aged clearable body.
    const r = runDeterministicPass({
      messages: withBigLedger,
      budgetTokens: 50,
      headroomTokens: 0,
      recentVerbatimTurns: 2, // the plan (index 3) is older than the tail → would be compressed
      trigger: "token_hard",
    });
    const planMsg = r.messages.find((m) => m.toolCallId === "p1")!;
    expect(planMsg.content).toBe(bigLedger); // VERBATIM — not truncated
    expect(planMsg.content).not.toContain(LEDGER_NOTE_MARKER); // no compression marker on the plan
    // the NON-plan aged read body still compresses (the fix must not over-reach)
    const readMsg = r.messages.find((m) => m.toolCallId === "r1")!;
    expect(readMsg.content).toContain(LEDGER_NOTE_MARKER);
  });

  it("after pass→fold, the re-pinned plan is the FULL original ledger (no truncation laundered in)", async () => {
    // Compose the real pipeline: the deterministic pass, then the model fold (`compact`).
    const passed = runDeterministicPass({
      messages: withBigLedger,
      budgetTokens: 50,
      headroomTokens: 0,
      recentVerbatimTurns: 2,
      trigger: "token_hard",
    });
    const r = await compact({
      messages: passed.messages,
      events: [],
      budgetTokens: 1000,
      trigger: "token_soft",
      summarize: () => mkTaskState({}),
      recentVerbatimTurns: 2, // the plan is older than the tail → it is re-pinned, not kept in the tail
    });
    // The re-pinned ledger is the FULL original string — every item line present, no elision marker.
    const pinned = r.messages.find((m) => m.content === bigLedger);
    expect(pinned).toBeDefined();
    expect(pinned!.content).toContain("□ step 59:"); // the last item survives (would be elided by truncation)
    expect(pinned!.content).not.toContain(LEDGER_NOTE_MARKER); // the PLAN pin carries no compression marker
  });
});

describe("compact — a user's mid-run steering instruction is never summarized away (§4.10.2 / §8.6)", () => {
  const CONSTRAINT = "do not touch the generated files"; // a queued comment
  const URGENT = "keep the public API backward compatible"; // an urgent override
  const INTERRUPT = "abort the current work entirely"; // an interrupt — NOT a standing constraint

  // The user steered mid-run; `applySteering` injected each as an exact `user` message AND recorded a
  // steering ledger event with the same content. Here the instructions are OLDER than the recent tail.
  const steer = (inputId: string, cls: "queued" | "urgent" | "interrupt", content: string) =>
    ({
      type: "steering" as const,
      v: 1 as const,
      ts,
      inputId,
      class: cls,
      content,
      insertedAt: 1,
      changedTaskState: false,
      invalidatedPlan: false,
    }) satisfies SessionEventT;
  const events: SessionEventT[] = [
    { type: "user", v: 1, ts, content: "refactor the parser" },
    steer("inp_1", "queued", CONSTRAINT),
    steer("inp_2", "urgent", URGENT),
    steer("inp_3", "interrupt", INTERRUPT),
  ];
  const messages: ModelMessageT[] = [
    { role: "system", content: "SYS" },
    { role: "user", content: "refactor the parser" },
    { role: "user", content: CONSTRAINT }, // the injected steering instructions (older than the tail)
    { role: "user", content: URGENT },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "r1", name: "read", args: { path: "p.ts" } }],
    },
    { role: "tool", content: "Z".repeat(700), toolCallId: "r1", name: "read" },
    { role: "assistant", content: "done refactoring" },
    { role: "user", content: "now add a test" },
  ];

  it("re-pins folded queued + urgent instructions (but not an interrupt); the swap probe passes", async () => {
    const r = await compact({
      messages,
      events,
      budgetTokens: 1000,
      trigger: "token_soft",
      summarize: () => mkTaskState({}),
      recentVerbatimTurns: 2, // the instructions are older than the tail → folded without preservation
    });
    // both standing instructions (queued + urgent) survive verbatim somewhere in the compacted context
    expect(r.messages.some((m) => m.content.includes(CONSTRAINT))).toBe(true);
    expect(r.messages.some((m) => m.content.includes(URGENT))).toBe(true);
    // an interrupt is not a standing constraint — it is not re-pinned
    expect(r.messages.some((m) => m.content.includes(INTERRUPT))).toBe(false);
    // the big folded body is gone, but the user constraints are not
    expect(r.messages.some((m) => m.content.includes("Z".repeat(700)))).toBe(false);
    // the swap constraint-preservation probe confirms it structurally
    expect(r.event.probesPassed).toBe(true);
  });

  it("does not duplicate a steering instruction already preserved in the recent tail", async () => {
    const r = await compact({
      messages,
      events,
      budgetTokens: 1000,
      trigger: "token_soft",
      summarize: () => mkTaskState({}),
      recentVerbatimTurns: 8, // the constraint stays in the tail verbatim
    });
    expect(r.messages.filter((m) => m.content === CONSTRAINT)).toHaveLength(1);
  });
});

describe("compact ER-021 production guards (fail-soft · abort · progress)", () => {
  it("fail-soft: a summarizer that THROWS keeps the existing context + records validation:failed", async () => {
    const r = await compact({
      messages,
      events,
      budgetTokens: 1000,
      trigger: "token_soft",
      summarize: () => {
        throw new Error("provider exploded");
      },
    });
    expect(r.messages).toEqual(messages); // unchanged — no corruption
    expect(r.messages.every((message, index) => message === messages[index])).toBe(true);
    expect(r.event.validation).toBe("failed");
    expect(r.event.probesPassed).toBe(false);
    expect(r.event.tokensAfter).toBe(r.event.tokensBefore); // no swap happened
  });

  it("fail-soft: a malformed summarizer return (not a TaskState) keeps context + records failed", async () => {
    const r = await compact({
      messages,
      events,
      budgetTokens: 1000,
      trigger: "token_soft",
      // @ts-expect-error — deliberately wrong shape to exercise the TaskState.parse guard
      summarize: () => ({ not: "a task state" }),
    });
    expect(r.messages).toEqual(messages);
    expect(r.event.validation).toBe("failed");
  });

  it("abort: an already-aborted signal skips the swap (no compaction mid-abort)", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await compact({
      messages,
      events,
      budgetTokens: 1000,
      trigger: "token_soft",
      summarize: faithful,
      signal: controller.signal,
    });
    expect(r.messages).toEqual(messages);
    expect(r.event.validation).toBe("failed");
  });

  it("progress guard: a fold that would not shrink keeps the original context (no counterproductive swap)", async () => {
    // A tiny conversation: everything is pinned/recent, so injecting a summary only GROWS it.
    const small: ModelMessageT[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ];
    const r = await compact({
      messages: small,
      events: [{ type: "user", v: 1, ts, content: "hi" }],
      budgetTokens: 1000,
      trigger: "token_soft",
      summarize: () => mkTaskState({}),
      recentVerbatimTurns: 6, // keeps the whole tiny convo as tail; the summary only adds bytes
    });
    expect(r.messages).toEqual(small); // no swap
    expect(r.event.validation).toBe("failed");
    expect(r.event.tokensAfter).toBe(r.event.tokensBefore);
  });
});
