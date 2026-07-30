import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { IsoTimestamp, redactJsonValue } from "@keel/shared";
import { EvalInfra, ReasoningSandwich } from "./config.js";
import { AggregateQualityMetrics } from "./trajectory-metrics.js";
import { KEEL_TB2_FULL_89, SUBSET_TASK_COUNTS, loadTaskList } from "./tb2/subsets.js";

/**
 * The committed benchmark scoreboard (§8.2: "scoreboard committed to repo, public, including
 * regressions — measured-not-asserted is identity"). It records per-iteration scores for each harness
 * (keel + the reference) so the trajectory of improvement is public history, and it is the substrate
 * for the parity verdict and the >2-pt regression rule.
 *
 * Honesty by construction (the QC amendments):
 *  - **QR-5:** each entry records the harness's **reasoning + caching config** alongside its score — a
 *    reasoning-sandwiched keel vs a flat terminus-2 on "the same model" is a confound, so the configs
 *    must travel with the numbers. The reference baseline (3-run median, identical infra+model) is a
 *    hard precondition for any keel parity number; the scoreboard records both with their configs.
 *  - **QR-7:** the score is the median of the per-run **resolved rate** — derived from the TB-2 grader's
 *    verdict, never keel's exit code (a `stop(error)`/`max-turns` run still exits 0).
 *  - **QR-4:** an entry carries **aggregate metrics only** (the §8.2 `aggregateQuality`) — never raw
 *    trajectory content — and the writer routes the serialized scoreboard through the SEC-014
 *    `redactJsonValue` filter as defense-in-depth for structured identifiers.
 *  - **infra-aborts** are recorded distinctly (`infraAborts`), never silently retried into a pass.
 */

/** A harness's score-shaping configuration — recorded WITH the score (QR-5 confound control). The
 *  reasoning sandwich reuses the ONE `ReasoningSandwich` schema from `config.ts` (no drift). */
export const HarnessConfig = z
  .object({
    /** The reasoning sandwich, or `null` for a flat harness that does not vary reasoning effort. */
    reasoning: ReasoningSandwich.nullable(),
    /** Whether prompt-cache-stable context assembly was in effect (borrowed-techniques #6). */
    promptCaching: z.boolean(),
    /** Public scoreboard entries are aggregate-only; no free-text notes that can smuggle raw trajectories. */
    notes: z.null(),
  })
  .strict();
export type HarnessConfigT = z.infer<typeof HarnessConfig>;

/** What loop change produced this iteration (the §2.3 change discipline — trajectory IDs as evidence). */
export const ScoreboardChange = z
  .object({
    failureMode: z.string().nullable(),
    /** Trajectory IDs that motivated the change (QR-7 evidence — resolve to the store). */
    trajectoryEvidence: z.array(z.string()),
    /** Public scoreboard entries are aggregate-only; narrative belongs in PR/docs, not the JSON record. */
    description: z.null(),
  })
  .strict();
export type ScoreboardChangeT = z.infer<typeof ScoreboardChange>;

export const RunEvidence = z
  .object({
    /** Exact source commit used to build/run the harness under measurement. */
    commitSha: z.string().regex(/^[0-9a-f]{40}$/),
    /** Human-meaningful binary/build identifier; commit alone is not enough for release artifacts. */
    binaryBuildId: z.string().min(1),
    /** Provider selected for the run; keeps model label and provider routing from becoming ambiguous. */
    providerId: z.string().min(1),
    /** Stable run-profile/config id for comparing like with like across iterations. */
    runProfileId: z.string().min(1),
    cache: z
      .object({
        promptCaching: z.boolean(),
        cacheReadWeight: z.number().min(0).max(1),
      })
      .strict(),
    budgetCaps: z
      .object({
        maxEffectiveTokens: z.number().int().nonnegative().nullable(),
        maxGrossTokens: z.number().int().nonnegative().nullable(),
        maxOutputTokens: z.number().int().nonnegative().nullable(),
        maxTurns: z.number().int().positive().nullable(),
      })
      .strict(),
    compaction: z
      .object({
        enabled: z.boolean(),
        mode: z.string().min(1).nullable(),
      })
      .strict(),
    /** Aggregate wall time for the scored run(s), not per-trajectory raw content. */
    wallClockMs: z.number().nonnegative(),
    /** Exact task ids scored for this entry. Aggregate-only, but enough to bind the denominator. */
    taskIds: z.array(z.string().min(1)),
    /** Exact task ids scored in each run behind `perRunResolvedRate`. */
    perRunTaskIds: z.array(z.array(z.string().min(1))),
  })
  .strict()
  .refine((e) => new Set(e.taskIds).size === e.taskIds.length, {
    message: "taskIds must be unique",
    path: ["taskIds"],
  })
  .refine((e) => e.perRunTaskIds.every((ids) => new Set(ids).size === ids.length), {
    message: "perRunTaskIds entries must each be unique",
    path: ["perRunTaskIds"],
  })
  .refine((e) => (e.compaction.enabled ? e.compaction.mode !== null : e.compaction.mode === null), {
    message: "compaction.enabled and compaction.mode must agree",
    path: ["compaction", "mode"],
  });
export type RunEvidenceT = z.infer<typeof RunEvidence>;

function sameMembership(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function pinnedTaskSet(subset: string): ReadonlySet<string> | null {
  if (SUBSET_TASK_COUNTS[subset] === undefined) return null;
  return new Set(loadTaskList(subset).tasks);
}

function isCanonicalFullSuite(taskIds: readonly string[]): boolean {
  return sameMembership(new Set(taskIds), new Set(loadTaskList(KEEL_TB2_FULL_89).tasks));
}

function aggregateResolvedRate(values: readonly number[], aggregate: "median" | "mean"): number {
  if (values.length === 0) return 0;
  if (aggregate === "mean") return values.reduce((sum, value) => sum + value, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6;
}

export const ScoreboardEntry = z
  .object({
    /** Loop iteration index (0 = baseline, before any loop change). */
    iteration: z.number().int().nonnegative(),
    recordedAt: IsoTimestamp,
    harness: z.string().min(1), // "keel" | "terminus-2" | "mini-swe-agent" | …
    harnessConfig: HarnessConfig,
    model: z.string().min(1),
    suite: z.string().min(1),
    subset: z.string().min(1),
    infra: EvalInfra,
    runs: z.number().int().positive(),
    aggregate: z.enum(["median", "mean"]),
    /** Number of tasks actually scored — the DENOMINATOR behind `resolvedRate` (EVAL-2). Recorded so a
     *  partial run is auditable and, for a pinned subset, structurally bound to that subset's size by the
     *  refine below — a 3-of-25 run can never be recorded as a full `keel-tb2-25` score. */
    nTasks: z.number().int().nonnegative(),
    /** The per-run resolved rates (0..1) — the raw trials behind the aggregate. */
    perRunResolvedRate: z.array(z.number().min(0).max(1)),
    /** The aggregate resolved rate (0..1) — from the grader's verdict (QR-7), not the exit code. */
    resolvedRate: z.number().min(0).max(1),
    /** The score in POINTS (0..100) — the unit of the ±5 parity gate + the >2-pt regression rule. */
    scorePct: z.number().min(0).max(100),
    /** Infra-aborted trials (retries:0) recorded distinctly — never counted as a task failure or a pass. */
    infraAborts: z.number().int().nonnegative(),
    aggregateQuality: AggregateQualityMetrics, // §8.2 aggregate ONLY (no raw trajectory content)
    costUSD: z.number().nonnegative().nullable(),
    runEvidence: RunEvidence,
    change: ScoreboardChange.nullable(),
  })
  .strict()
  // Honesty-by-construction (QR-7): the binding `scorePct` (the ±5 parity + >2-pt regression unit) must
  // equal the grader-derived `resolvedRate` × 100 — they cannot drift; and the per-run trials must match
  // the declared `runs`. A writer cannot record a score that diverges from the grader verdict.
  .refine((e) => approxEqual(e.scorePct, e.resolvedRate * 100), {
    message:
      "scorePct must equal resolvedRate × 100 (the score is the grader-derived rate, not a free number)",
    path: ["scorePct"],
  })
  .refine((e) => e.perRunResolvedRate.length === e.runs, {
    message:
      "perRunResolvedRate must have exactly `runs` entries (the raw trials behind the aggregate)",
    path: ["perRunResolvedRate"],
  })
  .refine(
    (e) => approxEqual(e.resolvedRate, aggregateResolvedRate(e.perRunResolvedRate, e.aggregate)),
    {
      message: "resolvedRate must equal the declared aggregate of perRunResolvedRate",
      path: ["resolvedRate"],
    },
  )
  // Honesty-by-construction (EVAL-2): a score recorded under a PINNED subset name must have scored that
  // subset's full pinned task count — so a partial run (e.g. 3 of 25 tasks) cannot be recorded as a
  // full-subset score. A custom/ad-hoc subset name has no pinned size and is unconstrained here (its
  // `nTasks` denominator is still recorded for audit).
  .refine(
    (e) => SUBSET_TASK_COUNTS[e.subset] === undefined || e.nTasks === SUBSET_TASK_COUNTS[e.subset],
    {
      message:
        "nTasks must equal the pinned size of the named subset (a partial run cannot be recorded as a full-subset score)",
      path: ["nTasks"],
    },
  )
  .refine((e) => e.runEvidence.taskIds.length === e.nTasks, {
    message: "runEvidence.taskIds must match nTasks (the recorded denominator)",
    path: ["runEvidence", "taskIds"],
  })
  .refine((e) => e.runEvidence.perRunTaskIds.length === e.runs, {
    message: "runEvidence.perRunTaskIds must have exactly `runs` entries",
    path: ["runEvidence", "perRunTaskIds"],
  })
  .refine((e) => e.runEvidence.perRunTaskIds.every((ids) => ids.length === e.nTasks), {
    message: "runEvidence.perRunTaskIds must match nTasks for every run",
    path: ["runEvidence", "perRunTaskIds"],
  })
  .refine(
    (e) =>
      e.runEvidence.perRunTaskIds.every((ids) =>
        sameMembership(new Set(ids), new Set(e.runEvidence.taskIds)),
      ),
    {
      message: "runEvidence.perRunTaskIds must match the entry taskIds for every run",
      path: ["runEvidence", "perRunTaskIds"],
    },
  )
  .refine(
    (e) => {
      const pinned = pinnedTaskSet(e.subset);
      return pinned === null || sameMembership(new Set(e.runEvidence.taskIds), pinned);
    },
    {
      message: "runEvidence.taskIds must match the pinned subset membership",
      path: ["runEvidence", "taskIds"],
    },
  )
  .refine(
    (e) =>
      SUBSET_TASK_COUNTS[e.subset] !== undefined || !isCanonicalFullSuite(e.runEvidence.taskIds),
    {
      message: `full-suite task evidence must use the canonical full-89 subset ${KEEL_TB2_FULL_89}`,
      path: ["subset"],
    },
  )
  .refine((e) => e.aggregateQuality.nTrajectories === e.runs * e.nTasks, {
    message: "aggregateQuality.nTrajectories must equal runs × nTasks",
    path: ["aggregateQuality", "nTrajectories"],
  })
  .refine((e) => e.harnessConfig.promptCaching === e.runEvidence.cache.promptCaching, {
    message: "harnessConfig.promptCaching must match runEvidence.cache.promptCaching",
    path: ["runEvidence", "cache", "promptCaching"],
  });
export type ScoreboardEntryT = z.infer<typeof ScoreboardEntry>;

export const Scoreboard = z
  .object({
    schemaVersion: z.literal(1),
    suite: z.string().min(1),
    entries: z.array(ScoreboardEntry),
  })
  .strict()
  .refine((s) => s.entries.every((entry) => entry.suite === s.suite), {
    message: "entries must match scoreboard suite",
    path: ["entries"],
  });
export type ScoreboardT = z.infer<typeof Scoreboard>;

/** An empty scoreboard for a suite (the committed Phase-A starting state — no runs yet). */
export function emptyScoreboard(suite = "terminal-bench-2"): ScoreboardT {
  return { schemaVersion: 1, suite, entries: [] };
}

/** A flagged regression: this entry's score dropped more than `thresholdPts` vs the prior SAME-harness
 *  entry (the §8.2 ">2-pt drop vs last gate blocks merge" rule, surfaced for the gate to act on). */
export interface Regression {
  readonly harness: string;
  readonly previousScorePct: number;
  readonly newScorePct: number;
  readonly dropPts: number;
  readonly thresholdPts: number;
}

/**
 * Append `entry`, returning the new scoreboard + any regression vs the most recent prior entry for the
 * SAME harness+subset (a drop greater than `thresholdPts`). Pure — does not write. The regression is
 * SURFACED, not silently swallowed; the gate (CI/review) decides what to do with it (§8.2 blocks merge).
 */
export function addEntry(
  scoreboard: ScoreboardT,
  entry: ScoreboardEntryT,
  thresholdPts: number,
): { scoreboard: ScoreboardT; regression: Regression | null } {
  // Validate at the entry boundary (the refines fire here): a divergent scorePct/resolvedRate or a
  // perRunResolvedRate that doesn't match `runs` is rejected before it ever reaches the scoreboard.
  const valid = ScoreboardEntry.parse(entry);
  const prior = [...scoreboard.entries]
    .reverse()
    .find((e) => e.harness === valid.harness && e.subset === valid.subset);
  let regression: Regression | null = null;
  if (prior) {
    const dropPts = prior.scorePct - valid.scorePct;
    if (dropPts > thresholdPts) {
      regression = {
        harness: valid.harness,
        previousScorePct: prior.scorePct,
        newScorePct: valid.scorePct,
        dropPts,
        thresholdPts,
      };
    }
  }
  return {
    scoreboard: { ...scoreboard, entries: [...scoreboard.entries, valid] },
    regression,
  };
}

/** Read + validate the committed scoreboard (parse, don't validate-by-hope). */
export async function loadScoreboard(file: string): Promise<ScoreboardT> {
  return Scoreboard.parse(JSON.parse(await readFile(file, "utf8")) as unknown);
}

/**
 * Persist the scoreboard. The structured value is routed through the SEC-014 `redactJsonValue` filter
 * (QR-4) before serializing — the scoreboard carries aggregate metrics only, and redaction remains
 * defense-in-depth for structured identifiers. Redacting before stringify keeps the pretty-printed JSON
 * valid by construction (F1 integrity): redacting an already-serialized line could split a JSON escape.
 */
export async function writeScoreboard(file: string, scoreboard: ScoreboardT): Promise<void> {
  const valid = Scoreboard.parse(scoreboard);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(redactJsonValue(valid), null, 2)}\n`, "utf8");
}
