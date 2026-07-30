import { describe, expect, it } from "vitest";
import type {
  CompactionEventT,
  ContextCompressionEventT,
  ModelMessageT,
  ModelUsageT,
  SessionEventT,
  TaskStateT,
} from "@keel/shared";
import { estimateMessagesTokens } from "../compact.js";
import type { ContextPressure } from "../pressure.js";
import type { Summarize } from "../compact.js";
import { budgetWarningMessage } from "../../strings.js";
import { PLAN_TOOL_NAME } from "../../tools/plan.js";
import { LEDGER_NOTE_MARKER } from "./pass.js";
import { createInLoopCompactor } from "./in-loop-compactor.js";
import type { CompactorStore, InLoopCompactorDeps } from "./in-loop-compactor.js";

const ts = "2026-06-15T00:00:00.000Z";

/** A log-shaped body the generic/log compressor collapses hard (duplicate lines). */
const REPEAT = (n: number): string =>
  Array.from({ length: n }, () => "duplicate log line").join("\n");
const toolMsg = (id: string, body: string, name = "bash"): ModelMessageT => ({
  role: "tool",
  name,
  toolCallId: id,
  content: body,
});

/** A capturing fake ledger sink (the structural subset the compactor needs). */
const fakeStore = (): { store: CompactorStore; events: SessionEventT[] } => {
  const events: SessionEventT[] = [];
  return { store: { append: (e) => events.push(e) }, events };
};

const usage = (input: number, output = 0): ModelUsageT => ({
  inputTokens: input,
  outputTokens: output,
});

const pressure = (
  over: Partial<ContextPressure> & { reason: ContextPressure["reason"] },
): ContextPressure => ({
  providerLastRequestInputTokens: { tokens: 0, source: "missing" },
  localCurrentViewTokens: 0,
  newObservationTokens: 0,
  overheadTokens: 0,
  cumulativeRunwayTokens: 0,
  contextWindow: { tokens: 10_000, source: "explicit-env" },
  ...over,
});

/** A consistent (ledger, messages) pair with a foldable middle of `bodySize` chars (read src/slug.ts,
 *  edit it, then a final note). Used for the fold-escalation cases. */
const foldFixture = (bodySize: number): { events: SessionEventT[]; messages: ModelMessageT[] } => {
  const body = "X".repeat(bodySize);
  const events: SessionEventT[] = [
    { type: "user", v: 1, ts, content: "implement slugify" },
    {
      type: "assistant",
      v: 1,
      ts,
      content: "",
      toolCalls: [{ id: "r1", name: "read", args: { path: "src/slug.ts" } }],
    },
    { type: "tool_result", v: 1, ts, toolCallId: "r1", name: "read", output: body },
    {
      type: "assistant",
      v: 1,
      ts,
      content: "",
      toolCalls: [
        { id: "e1", name: "edit", args: { path: "src/slug.ts", oldString: "a", newString: "b" } },
      ],
    },
    {
      type: "tool_result",
      v: 1,
      ts,
      toolCallId: "e1",
      name: "edit",
      output: "edited 1 occurrence",
    },
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
    { role: "tool", content: body, toolCallId: "r1", name: "read" },
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
  return { events, messages };
};

const emptyTaskState: TaskStateT = {
  taskGoal: "implement slugify",
  currentStatus: "done",
  currentPhase: "review",
  constraints: [],
  plan: [],
  completedSteps: [],
  nextSteps: [],
  filesRead: [
    { path: "src/slug.ts", status: "read", summary: "the slug module", artifactRefs: [] },
  ],
  filesModified: [
    { path: "src/slug.ts", status: "modified", summary: "added slugify", artifactRefs: [] },
  ],
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
};
const faithful: Summarize = () => emptyTaskState;
const throwing: Summarize = () => {
  throw new Error("summarizer blew up");
};

/**
 * A fixture for the cache net-gain guard: one AGED, highly-compressible tool body (REPEAT(600) ≈ 3000
 * tok → ~12 tok) followed by a LARGE recent-verbatim tail the pass never touches. So compressing the
 * aged body busts the cache for the whole large suffix → `rewrittenTokens` ≫ `savedTokensPerTurn`,
 * which is exactly when the guard's verdict (refuse vs accept) actually depends on the horizon/weight.
 * recentVerbatimTurns=5 keeps the 5 tail messages verbatim and leaves the body (index 1) clearable.
 */
const guardFixture = (): ModelMessageT[] => [
  { role: "user", content: "go" },
  toolMsg("old", REPEAT(600)),
  ...Array.from(
    { length: 5 },
    (_, i): ModelMessageT => ({ role: "assistant", content: `recent ${i} ${"z".repeat(4000)}` }),
  ),
];

const argumentGuardFixture = (): ModelMessageT[] => [
  { role: "user", content: "go" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "old-args",
        name: "bash",
        args: {
          command: `python - <<'PY'\n${"print('payload')\n".repeat(2_000)}PY`,
          cwd: "/app",
        },
      },
    ],
  },
  toolMsg("old-args", "ok"),
  ...Array.from(
    { length: 5 },
    (_, i): ModelMessageT => ({ role: "assistant", content: `recent ${i} ${"z".repeat(4000)}` }),
  ),
];

/** A fixture for the fold path: a large recent-verbatim tail (≈7000 tok) the pass cannot shrink, so the
 *  context stays over the fold's hard threshold and the model fold is what acts. */
const foldOnlyFixture = (): ModelMessageT[] => [
  { role: "user", content: "go" },
  ...Array.from(
    { length: 7 },
    (_, i): ModelMessageT => ({ role: "assistant", content: `recent ${i} ${"z".repeat(4000)}` }),
  ),
];

const ccx = (e: SessionEventT): e is ContextCompressionEventT => e.type === "context_compression";
const cmp = (e: SessionEventT): e is CompactionEventT => e.type === "compaction";

/** Build deps with sane test defaults; override per case. */
const mkDeps = (
  over: Partial<InLoopCompactorDeps> & { store: CompactorStore },
): InLoopCompactorDeps => ({
  readEvents: () => [],
  budgetTokens: 200_000,
  maxGrossTokens: 400_000,
  summarize: faithful,
  headroomTokens: 0,
  recentVerbatimTurns: 1,
  ...over,
});

describe("createInLoopCompactor — cheap gate (runway OR window pressure)", () => {
  it("no pressure → returns the SAME array (no copy) and appends nothing", async () => {
    const { store, events } = fakeStore();
    const compactor = createInLoopCompactor(mkDeps({ store }));
    const messages: ModelMessageT[] = [{ role: "user", content: "go" }, toolMsg("a", REPEAT(20))];
    const out = await compactor(messages, usage(0, 0));
    expect(out).toBe(messages); // identical reference — the loop's `next !== messages` no-op
    expect(events).toHaveLength(0);
  });
});

describe("createInLoopCompactor — deterministic pass under WINDOW pressure", () => {
  it("uses typed provider last-request pressure when chars/4 local context is still below the soft window", async () => {
    const { store, events } = fakeStore();
    const compactor = createInLoopCompactor(
      mkDeps({
        store,
        budgetTokens: 10_000,
        headroomTokens: 9_500,
        maxGrossTokens: Number.POSITIVE_INFINITY,
      }),
    );
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      toolMsg("old", REPEAT(220)),
      { role: "assistant", content: "last" },
    ];

    await compactor(
      messages,
      usage(0, 0),
      undefined,
      pressure({
        providerLastRequestInputTokens: { tokens: 7_200, source: "provider-reported" },
        localCurrentViewTokens: estimateMessagesTokens(messages),
        reason: {
          kind: "provider-last-request",
          severity: "soft",
          tokens: 7_200,
          thresholdTokens: 7_000,
        },
      }),
    );

    expect(estimateMessagesTokens(messages)).toBeLessThan(7_000);
    expect(events.filter(ccx)).toHaveLength(1);
  });

  it("compresses aged tool bodies and appends a context_compression event (default weight 1.0)", async () => {
    const { store, events } = fakeStore();
    // budgetTokens small → window pressure even at gross 0; default cacheReadWeight 1.0 ⇒ no cache
    // penalty ⇒ the net-gain guard always accepts a shrinking pass.
    const compactor = createInLoopCompactor(
      mkDeps({ store, budgetTokens: 200, maxGrossTokens: 1e9 }),
    );
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      toolMsg("old", REPEAT(600)),
      { role: "assistant", content: "last" },
    ];
    const out = await compactor(messages, usage(0, 0));
    expect(events.filter(ccx)).toHaveLength(1);
    expect(events.filter(ccx)[0]!.trust).toBe("unknown"); // SEC-023 fail-closed at the boundary
    const old = out.find((m) => m.toolCallId === "old")!;
    expect(old.content.length).toBeLessThan(REPEAT(600).length);
    expect(old.content).toContain(LEDGER_NOTE_MARKER);
    expect(out[0]).toBe(messages[0]); // untouched user provenance survives the pass
  });

  it("does not mutate the input messages (pure; SEC-023 compress the view, not the record)", async () => {
    const { store } = fakeStore();
    const compactor = createInLoopCompactor(
      mkDeps({ store, budgetTokens: 200, maxGrossTokens: 1e9 }),
    );
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      toolMsg("old", REPEAT(600)),
      { role: "assistant", content: "last" },
    ];
    const snapshot = JSON.parse(JSON.stringify(messages)) as ModelMessageT[];
    await compactor(messages, usage(0, 0));
    expect(messages).toEqual(snapshot);
  });
});

describe("createInLoopCompactor — source-side shaping for newly appended observations", () => {
  it("shapes a giant trailing tool observation before the next provider call even when prior provider usage is low", async () => {
    const { store, events } = fakeStore();
    const compactor = createInLoopCompactor(
      mkDeps({
        store,
        budgetTokens: 200_000,
        maxGrossTokens: Number.POSITIVE_INFINITY,
        observationMaxBytes: 1_024,
      }),
    );
    const giant = `${"head\n".repeat(200)}${"middle\n".repeat(2_000)}${"tail\n".repeat(200)}`;
    const messages: ModelMessageT[] = [
      { role: "user", content: "run tests" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "bash-1", name: "bash", args: { cmd: "pytest -q" } }],
      },
      toolMsg("bash-1", giant, "bash"),
    ];

    const out = await compactor(
      messages,
      usage(100, 5),
      undefined,
      pressure({
        providerLastRequestInputTokens: { tokens: 100, source: "provider-reported" },
        localCurrentViewTokens: estimateMessagesTokens(messages),
        newObservationTokens: estimateMessagesTokens([messages[2]!]),
        reason: {
          kind: "new-observation",
          severity: "soft",
          tokens: estimateMessagesTokens([messages[2]!]),
          thresholdTokens: 1_000,
        },
      }),
    );

    expect(events.filter(ccx)).toHaveLength(1);
    const shaped = out.find((m) => m.role === "tool" && m.toolCallId === "bash-1")!;
    expect(shaped.content.length).toBeLessThan(giant.length);
    expect(shaped.content).toContain("head");
    expect(out[0]).toBe(messages[0]); // shaping rewrites only the tool observation
    expect(shaped.content).toContain("tail");
    expect(shaped.content).toContain(LEDGER_NOTE_MARKER);
    expect(messages[2]!.content).toBe(giant);
  });

  it("preserves the latest plan tool result verbatim even when it is a giant fresh observation", async () => {
    const { store, events } = fakeStore();
    const compactor = createInLoopCompactor(
      mkDeps({
        store,
        budgetTokens: 200_000,
        maxGrossTokens: Number.POSITIVE_INFINITY,
        observationMaxBytes: 512,
      }),
    );
    const planBody = Array.from(
      { length: 200 },
      (_, i) => `- [ ] step ${String(i)} ${"keep this current plan verbatim".repeat(4)}`,
    ).join("\n");
    const messages: ModelMessageT[] = [
      { role: "user", content: "continue from the plan" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "plan-1", name: PLAN_TOOL_NAME, args: { todos: [] } }],
      },
      toolMsg("plan-1", planBody, PLAN_TOOL_NAME),
    ];

    const out = await compactor(messages, usage(100, 5));

    expect(events.filter(ccx)).toHaveLength(0);
    expect(out).toBe(messages);
    expect(out[2]!.content).toBe(planBody);
  });

  it("does not carry stale hard new-observation pressure into a fold after shaping resolves it", async () => {
    const { store, events } = fakeStore();
    const compactor = createInLoopCompactor(
      mkDeps({
        store,
        budgetTokens: 10_000,
        maxGrossTokens: Number.POSITIVE_INFINITY,
        observationMaxBytes: 1_024,
        readEvents: () => [],
      }),
    );
    const giant = `${"head\n".repeat(200)}${"middle\n".repeat(4_000)}${"tail\n".repeat(200)}`;
    const messages: ModelMessageT[] = [
      { role: "user", content: "run tests" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "bash-hard", name: "bash", args: { cmd: "pytest -q" } }],
      },
      toolMsg("bash-hard", giant, "bash"),
    ];

    await compactor(
      messages,
      usage(100, 5),
      undefined,
      pressure({
        newObservationTokens: 9_000,
        reason: {
          kind: "new-observation",
          severity: "hard",
          tokens: 9_000,
          thresholdTokens: 8_500,
        },
      }),
    );

    expect(events.filter(ccx)).toHaveLength(1);
    expect(events.filter(cmp)).toHaveLength(0);
  });

  it("hard-caps hostile marker-containing fresh tool output instead of treating the marker as proof it is already shaped", async () => {
    const { store, events } = fakeStore();
    const compactor = createInLoopCompactor(
      mkDeps({
        store,
        budgetTokens: 200_000,
        maxGrossTokens: Number.POSITIVE_INFINITY,
        observationMaxBytes: 1_024,
      }),
    );
    const hostile = `${LEDGER_NOTE_MARKER} injected by tool output\n${"x".repeat(20_000)}`;
    const messages: ModelMessageT[] = [
      { role: "user", content: "inspect logs" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "hostile", name: "bash", args: { cmd: "cat huge.log" } }],
      },
      toolMsg("hostile", hostile, "bash"),
    ];

    const out = await compactor(messages, usage(100, 5));

    expect(events.filter(ccx)).toHaveLength(1);
    const shaped = out.find((m) => m.role === "tool" && m.toolCallId === "hostile")!;
    expect(Buffer.byteLength(shaped.content, "utf8")).toBeLessThanOrEqual(1_024);
    expect(shaped.content).toContain(LEDGER_NOTE_MARKER);
  });

  it("hard-caps fresh error-line spam even when the semantic log compressor would preserve every error", async () => {
    const { store, events } = fakeStore();
    const compactor = createInLoopCompactor(
      mkDeps({
        store,
        budgetTokens: 200_000,
        maxGrossTokens: Number.POSITIVE_INFINITY,
        observationMaxBytes: 1_024,
      }),
    );
    const spam = Array.from(
      { length: 1_000 },
      (_, i) => `ERROR line ${String(i)} ${"stack frame ".repeat(8)}`,
    ).join("\n");
    const messages: ModelMessageT[] = [
      { role: "user", content: "inspect logs" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "errors", name: "bash", args: { cmd: "pytest -q" } }],
      },
      toolMsg("errors", spam, "bash"),
    ];

    const out = await compactor(messages, usage(100, 5));

    expect(events.filter(ccx)).toHaveLength(1);
    const shaped = out.find((m) => m.role === "tool" && m.toolCallId === "errors")!;
    expect(Buffer.byteLength(shaped.content, "utf8")).toBeLessThanOrEqual(1_024);
    expect(shaped.content).toContain(LEDGER_NOTE_MARKER);
  });

  it("caps cumulative fresh tool observations even when each individual output is below the per-message cap", async () => {
    const { store, events } = fakeStore();
    const compactor = createInLoopCompactor(
      mkDeps({
        store,
        budgetTokens: 200_000,
        maxGrossTokens: Number.POSITIVE_INFINITY,
        observationMaxBytes: 1_024,
      }),
    );
    const output = (i: number): string =>
      [`tool ${String(i)} head`, "x".repeat(700), `tool ${String(i)} tail`].join("\n");
    const messages: ModelMessageT[] = [
      { role: "user", content: "run a build matrix" },
      {
        role: "assistant",
        content: "",
        toolCalls: [0, 1, 2, 3].map((i) => ({
          id: `medium-${String(i)}`,
          name: "bash",
          args: { cmd: `build shard ${String(i)}` },
        })),
      },
      ...[0, 1, 2, 3].map((i) => toolMsg(`medium-${String(i)}`, output(i), "bash")),
    ];

    const out = await compactor(messages, usage(100, 5));

    expect(events.filter(ccx)).toHaveLength(1);
    const shaped = out.filter(
      (m) => m.role === "tool" && m.toolCallId?.startsWith("medium-") === true,
    );
    expect(shaped).toHaveLength(4);
    expect(
      shaped.reduce((sum, message) => sum + Buffer.byteLength(message.content, "utf8"), 0),
    ).toBeLessThanOrEqual(1_024);
    expect(shaped.every((message) => message.content.includes(LEDGER_NOTE_MARKER))).toBe(true);
    expect(messages.slice(2).every((message) => message.content.length > 700)).toBe(true);
  });

  it("normalizes carriage-return progress spam before source-side byte capping", async () => {
    const { store, events } = fakeStore();
    const compactor = createInLoopCompactor(
      mkDeps({
        store,
        budgetTokens: 200_000,
        maxGrossTokens: Number.POSITIVE_INFINITY,
        observationMaxBytes: 768,
      }),
    );
    const progress = Array.from({ length: 801 }, (_, i) => `download ${String(i)}%`).join("\r");
    const messages: ModelMessageT[] = [
      { role: "user", content: "build" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "progress", name: "bash", args: { cmd: "make" } }],
      },
      toolMsg("progress", `phase: fetch\n${progress}\nphase: done`, "bash"),
    ];

    const out = await compactor(messages, usage(100, 5));

    expect(events.filter(ccx)).toHaveLength(1);
    const shaped = out.find((m) => m.role === "tool" && m.toolCallId === "progress")!;
    expect(Buffer.byteLength(shaped.content, "utf8")).toBeLessThanOrEqual(768);
    expect(shaped.content).toContain("phase: fetch");
    expect(shaped.content).toContain("phase: done");
    expect(shaped.content).toContain("download 800%");
    expect(shaped.content).not.toContain("download 0%");
    expect(shaped.content).toContain(LEDGER_NOTE_MARKER);
  });

  it("still shapes a fresh tool observation when a budget-warning user message follows it", async () => {
    const { store, events } = fakeStore();
    const compactor = createInLoopCompactor(
      mkDeps({
        store,
        budgetTokens: 200_000,
        maxGrossTokens: Number.POSITIVE_INFINITY,
        observationMaxBytes: 1_024,
      }),
    );
    const giant = `${"head\n".repeat(200)}${"middle\n".repeat(2_000)}${"tail\n".repeat(200)}`;
    const messages: ModelMessageT[] = [
      { role: "user", content: "run tests" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "warned", name: "bash", args: { cmd: "pytest -q" } }],
      },
      toolMsg("warned", giant, "bash"),
      { role: "user", content: budgetWarningMessage(8, 10) },
    ];

    const out = await compactor(messages, usage(8, 0));

    expect(events.filter(ccx)).toHaveLength(1);
    const shaped = out.find((m) => m.role === "tool" && m.toolCallId === "warned")!;
    expect(shaped.content.length).toBeLessThan(giant.length);
    expect(shaped.content).toContain(LEDGER_NOTE_MARKER);
  });
});

describe("createInLoopCompactor — cache net-gain guardrail (ADR-0046)", () => {
  // Large window (no window pressure / no fold) + large headroom (small pass target so the aged body
  // compresses) + runway pressure to open the cheap gate — isolates the guard's accept/refuse verdict.
  const guardDeps = (over: Partial<InLoopCompactorDeps> & { store: CompactorStore }) =>
    mkDeps({
      budgetTokens: 100_000,
      headroomTokens: 99_000,
      maxGrossTokens: 400_000,
      cacheReadWeight: 0.1,
      recentVerbatimTurns: 5,
      ...over,
    });

  it("REFUSES a net-negative rewrite under SOFT pressure with a realistic cache weight (no event, no swap)", async () => {
    const { store, events } = fakeStore();
    const compactor = createInLoopCompactor(guardDeps({ store, expectedRemainingReads: 1 }));
    const messages = guardFixture();
    const out = await compactor(messages, usage(300_000, 0)); // soft runway (≥280k), NOT hard (<340k)
    expect(events).toHaveLength(0); // refused: nothing appended
    expect(out).toBe(messages); // no swap
  });

  it("ACCEPTS a profitable rewrite under soft pressure when the amortization horizon is long enough", async () => {
    const { store, events } = fakeStore();
    const compactor = createInLoopCompactor(guardDeps({ store, expectedRemainingReads: 100_000 }));
    await compactor(guardFixture(), usage(300_000, 0)); // long horizon ⇒ saved·reads·w outweighs rewrite
    expect(events.filter(ccx)).toHaveLength(1);
  });

  it("applies the same cache-cost guard to aged tool-call argument compaction", async () => {
    const { store, events } = fakeStore();
    const compactor = createInLoopCompactor(guardDeps({ store, expectedRemainingReads: 1 }));
    const messages = argumentGuardFixture();
    const out = await compactor(messages, usage(300_000, 0)); // soft runway, but net-negative rewrite

    expect(events).toHaveLength(0);
    expect(out).toBe(messages);
  });

  it("accepts a net-negative deterministic pass under hard context-window pressure", async () => {
    const { store, events } = fakeStore();
    const compactor = createInLoopCompactor(
      mkDeps({
        store,
        budgetTokens: 10_000,
        headroomTokens: 9_500,
        maxGrossTokens: Number.POSITIVE_INFINITY,
        cacheReadWeight: 0.1,
        expectedRemainingReads: 1,
        recentVerbatimTurns: 5,
      }),
    );
    const messages = argumentGuardFixture();

    const out = await compactor(messages, usage(0, 0));

    expect(events.filter(ccx)).toHaveLength(1);
    expect(events.filter(cmp)).toHaveLength(0);
    expect(out).not.toBe(messages);
    const assistant = out.find(
      (m) => m.role === "assistant" && m.toolCalls?.[0]?.id === "old-args",
    );
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.toolCalls?.[0]?.args["command"]).toContain(
      "[keel: tool-call argument compressed",
    );
  });

  it("OVERRIDES the guard under HARD runway pressure (runway trumps a marginal cache shave)", async () => {
    const { store, events } = fakeStore();
    const compactor = createInLoopCompactor(guardDeps({ store, expectedRemainingReads: 1 }));
    await compactor(guardFixture(), usage(350_000, 0)); // hard runway (≥340k) — net-negative is overridden
    expect(events.filter(ccx)).toHaveLength(1); // compressed despite the net-negative cache forecast
  });
});

describe("createInLoopCompactor — fold escalation", () => {
  it("under HARD RUNWAY pressure with a sub-window context, folds the middle and shrinks (runway value)", async () => {
    const { store, events } = fakeStore();
    const { events: ledger, messages } = foldFixture(8000); // ~2000-tok read body, ctx ≪ window
    const compactor = createInLoopCompactor(
      mkDeps({
        store,
        budgetTokens: 200_000, // window hard = 170k; ctx ≈ 2k ⇒ NOT window pressure
        maxGrossTokens: 400_000, // runway hard = 340k
        readEvents: () => ledger,
        recentVerbatimTurns: 2,
      }),
    );
    const before = estimateMessagesTokens(messages);
    const out = await compactor(messages, usage(350_000, 0));
    expect(events.filter(cmp)).toHaveLength(1); // the fold fired on runway pressure alone
    expect(estimateMessagesTokens(out)).toBeLessThan(before); // it actually reclaimed
  });

  it("appends a `failed` compaction event and keeps the context when the summarizer throws (ER-021 fail-soft)", async () => {
    const { store, events } = fakeStore();
    const { events: ledger, messages } = foldFixture(8000);
    const compactor = createInLoopCompactor(
      mkDeps({
        store,
        budgetTokens: 200_000,
        maxGrossTokens: 400_000,
        readEvents: () => ledger,
        summarize: throwing,
        recentVerbatimTurns: 2,
      }),
    );
    const out = await compactor(messages, usage(350_000, 0));
    const folds = events.filter(cmp);
    expect(folds).toHaveLength(1);
    expect(folds[0]!.validation).toBe("failed");
    expect(estimateMessagesTokens(out)).toBe(estimateMessagesTokens(messages)); // no swap
  });

  it("honors an aborted signal during the fold (no swap, failed event) — ER-021", async () => {
    const { store, events } = fakeStore();
    const { events: ledger, messages } = foldFixture(8000);
    const compactor = createInLoopCompactor(
      mkDeps({
        store,
        budgetTokens: 200_000,
        maxGrossTokens: 400_000,
        readEvents: () => ledger,
        recentVerbatimTurns: 2,
      }),
    );
    const controller = new AbortController();
    controller.abort();
    const out = await compactor(messages, usage(350_000, 0), controller.signal);
    expect(events.filter(cmp)).toHaveLength(1);
    expect(events.filter(cmp)[0]!.validation).toBe("failed");
    expect(estimateMessagesTokens(out)).toBe(estimateMessagesTokens(messages));
  });
});

describe("createInLoopCompactor — re-compaction bound (fires infrequently, not every turn)", () => {
  it("does not re-attempt a just-failed fold every call while the context has not grown", async () => {
    const { store, events } = fakeStore();
    // A large recent-verbatim tail (≈7000 tok) the pass cannot touch keeps the context over the fold's
    // hard threshold; the summarizer throws so every fold fails-soft (context stays large).
    const messages = foldOnlyFixture();
    const compactor = createInLoopCompactor(
      mkDeps({
        store,
        budgetTokens: 8000, // window hard = 6800; ctx ≈ 7000 tok ⇒ over hard
        maxGrossTokens: 1e9,
        readEvents: () => [],
        summarize: throwing,
        recentVerbatimTurns: 7,
        minRefoldGrowthTokens: 500,
      }),
    );
    await compactor(messages, usage(0, 0));
    await compactor(messages, usage(0, 0)); // same (un-grown) context
    await compactor(messages, usage(0, 0));
    expect(events.filter(cmp)).toHaveLength(1); // bounded — not one per call
  });

  it("does not fold again on the next turn after a successful fold returns a small context", async () => {
    const { store, events } = fakeStore();
    const { events: ledger, messages } = foldFixture(8000);
    const compactor = createInLoopCompactor(
      mkDeps({
        store,
        budgetTokens: 200_000,
        maxGrossTokens: 400_000,
        readEvents: () => ledger,
        recentVerbatimTurns: 2,
      }),
    );
    const out = await compactor(messages, usage(350_000, 0)); // folds → small context
    expect(events.filter(cmp)).toHaveLength(1);
    // Drive the next turn from the returned (small) context at the same gross — no second fold.
    await compactor(out, usage(350_000, 0));
    expect(events.filter(cmp)).toHaveLength(1);
  });
});

describe("createInLoopCompactor — option plumbing & defaults", () => {
  it("forwards taskTokens + compactorModel and applies defaults when the optional knobs are omitted", async () => {
    const { store, events } = fakeStore();
    // No cacheReadWeight / softFraction / hardFraction / headroomTokens / recentVerbatimTurns /
    // expectedRemainingReads / minRefoldGrowthTokens — all defaulted. budget 8000 ⇒ default headroom
    // 16384 ⇒ target 0; the large recent tail keeps ctx over the fold's hard threshold ⇒ the fold runs.
    const compactor = createInLoopCompactor({
      store,
      readEvents: () => [],
      budgetTokens: 8000,
      maxGrossTokens: 1e9,
      summarize: faithful,
      taskTokens: ["slug"],
      compactorModel: "sim-v1",
    });
    await compactor(foldOnlyFixture(), usage(0, 0));
    const folds = events.filter(cmp);
    expect(folds).toHaveLength(1);
    expect(folds[0]!.compactorModel).toBe("sim-v1"); // threaded onto the audit event
  });

  it("honors custom soft/hard fractions for the trigger", async () => {
    const { store, events } = fakeStore();
    const compactor = createInLoopCompactor(
      mkDeps({
        store,
        budgetTokens: 200,
        maxGrossTokens: 1e9,
        softFraction: 0.5,
        hardFraction: 0.6,
      }),
    );
    const messages: ModelMessageT[] = [
      { role: "user", content: "go" },
      toolMsg("old", REPEAT(600)),
      { role: "assistant", content: "last" },
    ];
    await compactor(messages, usage(0, 0)); // ctx ≫ 0.5·200 ⇒ window pressure ⇒ pass fires
    expect(events.filter(ccx)).toHaveLength(1);
  });
});
