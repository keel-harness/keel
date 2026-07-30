import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeFailures, classifyFailure } from "./failure-modes.js";
import { readTrajectory, writeTrajectory } from "./store.js";
import type { TrajectoryEventT, TrajectoryT } from "./trajectory.js";

// Synthetic failed trajectories — the §7 tests-first for the §2.3 failure-mode analysis workflow.
// Each fixture is crafted to exhibit exactly ONE root-cause signature; the analyzer must group + rank
// them deterministically and the report's trajectory refs must resolve to the stored trajectories.

const usage = { inputTokens: 10, outputTokens: 5 };
function traj(
  task: string,
  outcome: TrajectoryT["outcome"],
  events: TrajectoryEventT[],
  totals?: Partial<TrajectoryT["totals"]>,
): TrajectoryT {
  const toolCalls = events.filter((e) => e.type === "tool-call").length;
  const turns = events.filter((e) => e.type === "turn").length;
  return {
    schemaVersion: 1,
    runId: "run-A",
    task,
    suite: "terminal-bench-2",
    model: "keel-synthetic",
    startedAt: "2026-06-16T00:00:00.000Z",
    events,
    outcome,
    totals: {
      turns,
      toolCalls,
      wallClockMs: 0,
      inputTokens: 100,
      outputTokens: 40,
      ...totals,
    },
  };
}

const invalidArgs = traj("alpha-invalid-args", "unresolved", [
  { type: "tool-call", id: "c1", name: "bash", args: { command: "ls" }, argsValid: false },
  { type: "tool-result", id: "c1", ok: false, content: "bad args" },
  { type: "turn", index: 0, reason: "tool-calls", usage, wallClockMs: 0 },
]);
const premature = traj("bravo-premature", "unresolved", [
  { type: "assistant-text", text: "all done" },
  { type: "completion-attempt", accepted: true, intercepted: false },
  { type: "turn", index: 0, reason: "stop", usage, wallClockMs: 0 },
]);
const cascade = traj("charlie-cascade", "unresolved", [
  { type: "tool-call", id: "c1", name: "bash", args: { command: "make" }, argsValid: true },
  { type: "tool-result", id: "c1", ok: false, content: "err1" },
  { type: "tool-call", id: "c2", name: "bash", args: { command: "make again" }, argsValid: true },
  { type: "tool-result", id: "c2", ok: false, content: "err2" },
  { type: "turn", index: 0, reason: "stop", usage, wallClockMs: 0 },
]);
const ranOut = traj("delta-ran-out", "unresolved", [
  { type: "tool-call", id: "c1", name: "read", args: { path: "a.ts" }, argsValid: true },
  { type: "tool-result", id: "c1", ok: true, content: "..." },
  { type: "turn", index: 0, reason: "length", usage, wallClockMs: 0 },
]);
const redundant = traj("echo-redundant", "unresolved", [
  { type: "tool-call", id: "c1", name: "read", args: { path: "a.ts" }, argsValid: true },
  { type: "tool-result", id: "c1", ok: true, content: "x" },
  { type: "tool-call", id: "c2", name: "read", args: { path: "a.ts" }, argsValid: true },
  { type: "tool-result", id: "c2", ok: true, content: "x" },
  { type: "tool-call", id: "c3", name: "read", args: { path: "a.ts" }, argsValid: true },
  { type: "tool-result", id: "c3", ok: true, content: "x" },
  { type: "turn", index: 0, reason: "stop", usage, wallClockMs: 0 },
]);
const other = traj("foxtrot-other", "unresolved", [
  { type: "assistant-text", text: "I think the answer is 42" },
  { type: "turn", index: 0, reason: "stop", usage, wallClockMs: 0 },
]);
// A SECOND premature-completion, to exercise grouping + count ranking.
const premature2 = traj("golf-premature", "unresolved", [
  { type: "completion-attempt", accepted: true, intercepted: false },
  { type: "turn", index: 0, reason: "stop", usage, wallClockMs: 0 },
]);
const ok = traj("hotel-resolved", "resolved", [
  { type: "turn", index: 0, reason: "stop", usage, wallClockMs: 0 },
]);
const infra = traj("india-infra", "infra-error", [
  {
    type: "turn",
    index: 0,
    reason: "error",
    usage: { inputTokens: 0, outputTokens: 0 },
    wallClockMs: 0,
  },
]);

const ALL = [invalidArgs, premature, cascade, ranOut, redundant, other, premature2, ok, infra];

describe("classifyFailure — one signature per crafted trajectory", () => {
  it.each([
    ["invalid-tool-args", invalidArgs],
    ["premature-completion", premature],
    ["error-cascade", cascade],
    ["ran-out-of-turns", ranOut],
    ["redundant-work", redundant],
    ["unresolved-other", other],
  ] as const)("classifies %s", (sig, t) => {
    expect(classifyFailure(t)).toBe(sig);
  });
});

describe("analyzeFailures — ranked failure-mode report (golden)", () => {
  it("groups, ranks (severity → count → signature), and counts resolved/unresolved/infra", () => {
    const report = analyzeFailures(ALL);
    expect(report.totalTrajectories).toBe(9);
    expect(report.resolved).toBe(1);
    expect(report.unresolved).toBe(7);
    expect(report.infraErrors).toBe(1);

    // High-severity modes first; within high, premature-completion (count 2) outranks the count-1
    // modes, then ties break by signature name (error-cascade < invalid-tool-args).
    expect(report.failureModes.map((f) => [f.signature, f.count, f.severity])).toEqual([
      ["premature-completion", 2, "high"],
      ["error-cascade", 1, "high"],
      ["invalid-tool-args", 1, "high"],
      ["ran-out-of-turns", 1, "medium"],
      ["redundant-work", 1, "medium"],
      ["unresolved-other", 1, "low"],
    ]);
    // The proposer slot is empty in the deterministic report.
    expect(report.failureModes.every((f) => f.proposedChange === null)).toBe(true);
    // Premature-completion groups both bravo + golf (sorted by task).
    const prem = report.failureModes.find((f) => f.signature === "premature-completion");
    expect(prem?.trajectories.map((t) => t.task)).toEqual(["bravo-premature", "golf-premature"]);
    // infra-error is excluded from the quality aggregate (recorded distinctly).
    expect(report.aggregateQuality.nTrajectories).toBe(8);
  });

  it("matches the committed golden report (regression guard)", async () => {
    const goldenPath = fileURLToPath(
      new URL("./fixtures/failure-modes.golden.json", import.meta.url),
    );
    // The golden is a GENERATED artifact. When `analyzeFailures`'s output legitimately changes, regenerate
    // it with:  GEN_GOLDEN=1 pnpm exec vitest run packages/eval/src/failure-modes.test.ts  — then review the diff.
    if (process.env["GEN_GOLDEN"] === "1") {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(goldenPath, JSON.stringify(analyzeFailures(ALL), null, 2) + "\n");
    }
    const golden: unknown = JSON.parse(await readFile(goldenPath, "utf8"));
    expect(analyzeFailures(ALL)).toEqual(golden);
  });

  it("empty input → a report with no failure modes (not a crash)", () => {
    const report = analyzeFailures([]);
    expect(report.failureModes).toEqual([]);
    expect(report.totalTrajectories).toBe(0);
    expect(report.aggregateQuality.nTrajectories).toBe(0);
  });

  it("all-resolved input → no failure modes", () => {
    const report = analyzeFailures([ok, traj("kilo-ok", "resolved", [])]);
    expect(report.failureModes).toEqual([]);
    expect(report.resolved).toBe(2);
    expect(report.unresolved).toBe(0);
  });
});

describe("report trajectory refs resolve to stored trajectories (§7)", () => {
  let base: string;
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "keel-fm-"));
    for (const t of ALL) await writeTrajectory(base, t);
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("every referenced trajectory in the report resolves to a stored, reloadable trajectory", async () => {
    const report = analyzeFailures(ALL);
    const refs = report.failureModes.flatMap((f) => f.trajectories);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const file = join(base, ref.suite, ref.runId, `${ref.task}.json`);
      const loaded = await readTrajectory(file);
      expect(loaded.task).toBe(ref.task);
      expect(loaded.outcome).toBe("unresolved");
    }
  });
});
