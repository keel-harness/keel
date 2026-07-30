import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ScoreboardEntryT,
  addEntry,
  emptyScoreboard,
  loadScoreboard,
  writeScoreboard,
} from "./scoreboard.js";
import { KEEL_TB2_FULL_89, KEEL_TB2_HELDOUT, KEEL_TB2_TUNED, loadTaskList } from "./tb2/subsets.js";

const AGG = {
  nTrajectories: 75,
  meanToolCalls: 12,
  meanToolCallArgValidityRate: 1,
  totalRedundantToolCalls: 3,
  totalToolErrors: 4,
  meanErrorRecoveryRate: 0.9,
  totalPrematureCompletionIntercepts: 2,
  totalCompactions: 1,
  meanWallClockMs: 1000,
  meanInputTokens: 5000,
  meanOutputTokens: 1200,
};

const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

function taskIdsFor(subset: string, nTasks?: number): string[] {
  if (![KEEL_TB2_TUNED, KEEL_TB2_HELDOUT, KEEL_TB2_FULL_89].includes(subset)) {
    return Array.from({ length: nTasks ?? 7 }, (_, i) => `adhoc-${String(i + 1)}`);
  }
  return loadTaskList(subset).tasks;
}

function runEvidenceFor(
  subset: string,
  over: Partial<ScoreboardEntryT["runEvidence"]> = {},
  nTasks?: number,
  runs = 3,
): ScoreboardEntryT["runEvidence"] {
  const taskIds = over.taskIds ?? taskIdsFor(subset, nTasks);
  const perRunTaskIds = over.perRunTaskIds ?? Array.from({ length: runs }, () => [...taskIds]);
  return {
    commitSha: COMMIT_SHA,
    binaryBuildId: "keel-local-build-2026-07-04",
    providerId: "anthropic",
    runProfileId: "tb2-claim-grade-default",
    cache: {
      promptCaching: true,
      cacheReadWeight: 0.1,
    },
    budgetCaps: {
      maxEffectiveTokens: 400_000,
      maxGrossTokens: 1_200_000,
      maxOutputTokens: 80_000,
      maxTurns: 80,
    },
    compaction: {
      enabled: false,
      mode: null,
    },
    wallClockMs: 123_456,
    taskIds,
    perRunTaskIds,
    ...over,
  };
}

// `scorePts` (0..100) sets scorePct + resolvedRate + the 3 per-run trials consistently, so every entry
// satisfies the schema's scorePct===resolvedRate*100 + perRunResolvedRate.length===runs refines.
function entry(scorePts = 60, over: Partial<ScoreboardEntryT> = {}): ScoreboardEntryT {
  const rate = scorePts / 100;
  const subset = over.subset ?? KEEL_TB2_TUNED;
  const nTasks = over.nTasks ?? taskIdsFor(subset).length;
  const runs = over.runs ?? 3;
  const perRunResolvedRate = over.perRunResolvedRate ?? Array.from({ length: runs }, () => rate);
  return {
    iteration: 0,
    recordedAt: "2026-06-16T00:00:00.000Z",
    harness: "keel",
    harnessConfig: {
      reasoning: { plan: "high", execute: "medium", verify: "high" },
      promptCaching: true,
      notes: null,
    },
    model: "claude-sonnet-4-6",
    suite: "terminal-bench-2",
    subset,
    infra: {
      cpus: 4,
      memoryGB: 8,
      taskTimeoutSec: 1800,
      networkPolicy: "task-default",
      retries: 0,
    },
    runs,
    aggregate: "median",
    nTasks,
    perRunResolvedRate,
    resolvedRate: rate,
    scorePct: scorePts,
    infraAborts: 0,
    aggregateQuality: { ...AGG, nTrajectories: runs * nTasks },
    costUSD: 18.4,
    runEvidence: runEvidenceFor(subset, {}, nTasks, runs),
    change: null,
    ...over,
  };
}

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "keel-sb-"));
  file = join(dir, "scoreboard.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scoreboard — addEntry + regression rule (§8.2)", () => {
  it("appends entries and flags no regression on the first", () => {
    const { scoreboard, regression } = addEntry(emptyScoreboard(), entry(60), 2);
    expect(scoreboard.entries).toHaveLength(1);
    expect(regression).toBeNull();
  });

  it("flags a >2-pt drop vs the prior same-harness entry", () => {
    const sb = addEntry(emptyScoreboard(), entry(60, { iteration: 0 }), 2).scoreboard;
    const r = addEntry(sb, entry(57, { iteration: 1 }), 2);
    expect(r.regression).not.toBeNull();
    expect(r.regression?.dropPts).toBe(3);
    expect(r.regression?.previousScorePct).toBe(60);
    expect(r.regression?.newScorePct).toBe(57);
  });

  it("does NOT flag a drop within the threshold, nor an improvement", () => {
    const sb = addEntry(emptyScoreboard(), entry(60), 2).scoreboard;
    expect(addEntry(sb, entry(58, { iteration: 1 }), 2).regression).toBeNull(); // exactly 2 ≤ 2
    expect(addEntry(sb, entry(65, { iteration: 1 }), 2).regression).toBeNull(); // up
  });

  it("isolates harnesses — a keel drop is not measured against a terminus-2 entry", () => {
    const sb = addEntry(emptyScoreboard(), entry(70, { harness: "terminus-2" }), 2).scoreboard;
    // First keel entry: no prior keel entry → no regression even though terminus-2 scored higher.
    const r = addEntry(sb, entry(60, { harness: "keel" }), 2);
    expect(r.regression).toBeNull();
  });

  it("isolates subsets — a held-out score is not measured against a tuned-subset score", () => {
    const sb = addEntry(emptyScoreboard(), entry(60, { subset: KEEL_TB2_TUNED }), 2).scoreboard;
    const r = addEntry(sb, entry(50, { subset: KEEL_TB2_HELDOUT }), 2);
    expect(r.regression).toBeNull();
  });

  it("REJECTS an entry whose scorePct diverges from resolvedRate×100 (QR-7 honesty)", () => {
    const bad: ScoreboardEntryT = { ...entry(60), scorePct: 80 }; // resolvedRate still 0.6
    expect(() => addEntry(emptyScoreboard(), bad, 2)).toThrow(/scorePct must equal/);
  });

  it("REJECTS an entry whose per-run trial count disagrees with `runs`", () => {
    const bad: ScoreboardEntryT = { ...entry(60), perRunResolvedRate: [0.6] }; // runs is 3
    expect(() => addEntry(emptyScoreboard(), bad, 2)).toThrow(/perRunResolvedRate must have/);
  });

  it("REJECTS an entry whose resolvedRate is not the declared median of per-run trials", () => {
    const bad: ScoreboardEntryT = {
      ...entry(100, {
        perRunResolvedRate: [0, 0, 1],
        resolvedRate: 1,
        scorePct: 100,
      }),
    };
    expect(() => addEntry(emptyScoreboard(), bad, 2)).toThrow(/resolvedRate must equal/);
  });

  it("ACCEPTS mean aggregation only when resolvedRate equals the mean of per-run trials", () => {
    expect(() =>
      addEntry(
        emptyScoreboard(),
        entry(50, {
          aggregate: "mean",
          perRunResolvedRate: [0, 0.5, 1],
          resolvedRate: 0.5,
          scorePct: 50,
        }),
        2,
      ),
    ).not.toThrow();
    expect(() =>
      addEntry(
        emptyScoreboard(),
        entry(100, {
          aggregate: "mean",
          perRunResolvedRate: [0, 0.5, 1],
          resolvedRate: 1,
          scorePct: 100,
        }),
        2,
      ),
    ).toThrow(/resolvedRate must equal/);
  });

  it("REJECTS a partial run recorded under a pinned subset (nTasks != the subset's pinned size) (EVAL-2)", () => {
    // The honesty hole: a run that scored only 3 of the 25 tuned tasks, labeled `keel-tb2-25`, would
    // read as a 25-task score. With nTasks bound to the pinned size, that entry is unrecordable.
    const partial: ScoreboardEntryT = { ...entry(60), subset: KEEL_TB2_TUNED, nTasks: 3 };
    expect(() => addEntry(emptyScoreboard(), partial, 2)).toThrow(
      /pinned size of the named subset/,
    );
  });

  it("ACCEPTS the pinned size for a pinned subset, and ANY nTasks for a custom subset (EVAL-2)", () => {
    expect(() =>
      addEntry(emptyScoreboard(), entry(60, { subset: KEEL_TB2_HELDOUT }), 2),
    ).not.toThrow();
    // A custom/ad-hoc subset name has no pinned size to bind to, so any nTasks is allowed (the
    // denominator is still recorded and auditable).
    expect(() =>
      addEntry(
        emptyScoreboard(),
        {
          ...entry(60, {
            subset: "adhoc-debug",
            nTasks: 7,
            aggregateQuality: { ...AGG, nTrajectories: 21 },
            runEvidence: runEvidenceFor(
              "adhoc-debug",
              { taskIds: taskIdsFor("adhoc-debug", 7) },
              7,
            ),
          }),
        },
        2,
      ),
    ).not.toThrow();
  });

  it("REJECTS a full-89 entry with partial task evidence even when nTasks claims 89", () => {
    const full = loadTaskList(KEEL_TB2_FULL_89);
    const partial: ScoreboardEntryT = {
      ...entry(60, {
        subset: KEEL_TB2_FULL_89,
        nTasks: 89,
        aggregateQuality: { ...AGG, nTrajectories: 267 },
        runEvidence: runEvidenceFor(KEEL_TB2_FULL_89, { taskIds: full.tasks.slice(0, 3) }, 89),
      }),
    };
    expect(() => addEntry(emptyScoreboard(), partial, 2)).toThrow(/taskIds must match/);
  });

  it("REJECTS a full-89 entry when any per-run task evidence is partial", () => {
    const full = loadTaskList(KEEL_TB2_FULL_89);
    const partialTrial: ScoreboardEntryT = {
      ...entry(60, {
        subset: KEEL_TB2_FULL_89,
        nTasks: 89,
        aggregateQuality: { ...AGG, nTrajectories: 267 },
        runEvidence: runEvidenceFor(
          KEEL_TB2_FULL_89,
          {
            perRunTaskIds: [full.tasks, full.tasks.slice(0, 3), full.tasks],
          },
          89,
        ),
      }),
    };
    expect(() => addEntry(emptyScoreboard(), partialTrial, 2)).toThrow(/perRunTaskIds/);
  });

  it("REJECTS a pinned subset entry with the right denominator but wrong task membership", () => {
    const tuned = loadTaskList(KEEL_TB2_TUNED);
    const heldout = loadTaskList(KEEL_TB2_HELDOUT);
    const wrongMembership: ScoreboardEntryT = {
      ...entry(60, {
        subset: KEEL_TB2_TUNED,
        nTasks: 25,
        runEvidence: runEvidenceFor(KEEL_TB2_TUNED, {
          taskIds: [...tuned.tasks.slice(1), heldout.tasks[0]!],
        }),
      }),
    };
    expect(() => addEntry(emptyScoreboard(), wrongMembership, 2)).toThrow(
      /pinned subset membership/,
    );
  });

  it("REJECTS aggregate quality whose trajectory count does not cover every run and task", () => {
    const bad: ScoreboardEntryT = {
      ...entry(60, { aggregateQuality: { ...AGG, nTrajectories: 0 } }),
    };
    expect(() => addEntry(emptyScoreboard(), bad, 2)).toThrow(/aggregateQuality.nTrajectories/);
  });

  it("REJECTS contradictory cache and compaction metadata", () => {
    expect(() =>
      addEntry(
        emptyScoreboard(),
        entry(60, {
          runEvidence: runEvidenceFor(KEEL_TB2_TUNED, {
            cache: { promptCaching: false, cacheReadWeight: 0.1 },
          }),
        }),
        2,
      ),
    ).toThrow(/promptCaching/);
    expect(() =>
      addEntry(
        emptyScoreboard(),
        entry(60, {
          runEvidence: runEvidenceFor(KEEL_TB2_TUNED, {
            compaction: { enabled: true, mode: null },
          }),
        }),
        2,
      ),
    ).toThrow(/compaction/);
  });

  it("REJECTS a renamed custom subset carrying the exact full-89 task ids", () => {
    const full = loadTaskList(KEEL_TB2_FULL_89);
    const renamed: ScoreboardEntryT = {
      ...entry(60, {
        subset: "adhoc-renamed-full-89",
        nTasks: 89,
        runEvidence: runEvidenceFor("adhoc-debug", { taskIds: full.tasks }),
      }),
    };
    expect(() => addEntry(emptyScoreboard(), renamed, 2)).toThrow(/canonical full-89 subset/);
  });

  it("REJECTS scoreboard entries without structured run evidence", () => {
    const missingEvidence: Partial<ScoreboardEntryT> = { ...entry(60) };
    delete missingEvidence.runEvidence;
    expect(() => addEntry(emptyScoreboard(), missingEvidence as ScoreboardEntryT, 2)).toThrow(
      /runEvidence/,
    );
  });

  it("REJECTS notes-only claim metadata instead of structured run evidence", () => {
    const invalidWithNotes = {
      ...entry(60),
      harnessConfig: {
        reasoning: { plan: "high", execute: "medium", verify: "high" },
        promptCaching: true,
        notes: JSON.stringify({
          commitSha: COMMIT_SHA,
          providerId: "anthropic",
          taskIds: taskIdsFor(KEEL_TB2_TUNED),
        }),
      },
    } as unknown as ScoreboardEntryT;
    const missingEvidence: Partial<ScoreboardEntryT> = { ...invalidWithNotes };
    delete missingEvidence.runEvidence;
    expect(() => addEntry(emptyScoreboard(), missingEvidence as ScoreboardEntryT, 2)).toThrow(
      /runEvidence/,
    );
  });

  it("REJECTS free-text scoreboard notes and change descriptions", () => {
    const invalidNotes = {
      ...entry(60),
      harnessConfig: {
        reasoning: { plan: "high", execute: "medium", verify: "high" },
        promptCaching: true,
        notes: "raw trajectory snippet should not be public scoreboard content",
      },
    } as unknown as ScoreboardEntryT;
    const invalidDescription = {
      ...entry(60),
      change: {
        failureMode: "premature-completion",
        trajectoryEvidence: ["t1"],
        description: "raw tool output should not be public scoreboard content",
      },
    } as unknown as ScoreboardEntryT;
    expect(() => addEntry(emptyScoreboard(), invalidNotes, 2)).toThrow(/notes/);
    expect(() => addEntry(emptyScoreboard(), invalidDescription, 2)).toThrow(/description/);
  });
});

describe("scoreboard — persistence + QR-4 redaction", () => {
  it("round-trips through write/load", async () => {
    const sb = addEntry(emptyScoreboard(), entry(60), 2).scoreboard;
    await writeScoreboard(file, sb);
    expect(await loadScoreboard(file)).toEqual(sb);
  });

  it("redacts a secret in structured fields before write (QR-4 defense-in-depth)", async () => {
    const key = "sk-ant-api03-abcDEF123456789_ghijklmnop-qrstuvwxyz0123456789AA";
    const sb = addEntry(
      emptyScoreboard(),
      entry(60, {
        runEvidence: runEvidenceFor(KEEL_TB2_TUNED, { binaryBuildId: `build-${key}` }),
      }),
      2,
    ).scoreboard;
    await writeScoreboard(file, sb);
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain(key);
    expect(raw).toContain("[redacted:anthropic-key]");
    // still valid + reloadable
    expect((await loadScoreboard(file)).entries).toHaveLength(1);
  });

  it("records the QR-5 harness config (reasoning + caching) alongside the score", async () => {
    const sb = addEntry(emptyScoreboard(), entry(60), 2).scoreboard;
    await writeScoreboard(file, sb);
    const loaded = await loadScoreboard(file);
    expect(loaded.entries[0]?.harnessConfig.reasoning).toEqual({
      plan: "high",
      execute: "medium",
      verify: "high",
    });
    expect(loaded.entries[0]?.harnessConfig.promptCaching).toBe(true);
    // QR-7: the score is the resolved-rate aggregate, with the per-run trials retained (length === runs).
    expect(loaded.entries[0]?.perRunResolvedRate).toEqual([0.6, 0.6, 0.6]);
  });

  it("records claim-grade run evidence as structured fields, not notes", async () => {
    const sb = addEntry(emptyScoreboard(), entry(60), 2).scoreboard;
    await writeScoreboard(file, sb);
    const loaded = await loadScoreboard(file);
    expect(loaded.entries[0]?.harnessConfig.notes).toBeNull();
    expect(loaded.entries[0]?.runEvidence).toEqual(runEvidenceFor(KEEL_TB2_TUNED));
  });

  it("REJECTS a scoreboard whose suite disagrees with an entry suite", async () => {
    const scoreboard = addEntry(
      emptyScoreboard(),
      entry(60, { suite: "terminal-bench-2.1" }),
      2,
    ).scoreboard;
    await expect(
      writeScoreboard(file, { ...scoreboard, suite: "terminal-bench-2" }),
    ).rejects.toThrow(/entries must match scoreboard suite/);
  });
});
