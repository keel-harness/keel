# 0062 — Bind eval runs and scoreboard entries to their claimed subset

**Status:** accepted
**Date:** 2026-06-24

## Context

The phases 0–1 audit found two measurement-honesty holes (the project's credibility rests on honest
benchmark numbers — §8.2 "measured-not-asserted is identity"; the charter's "no hidden green"):

- **EVAL-1.** `assertSubsetIntegrity()` — the ADR-0042 guard that proves the committed subsets are
  well-formed and that the held-out set is disjoint from the tuned set — has **zero non-test call
  sites**. The runner (`runMatrix`) accepts a free `taskNames` list and a free `suite`, and never
  cross-checks them against a pinned subset. Nothing structurally ties *what we claim we ran* (a
  subset label) to *what we actually ran* (the task ids); the overfit guard is advisory at run time.

- **EVAL-2.** `ScoreboardEntry` records `resolvedRate` and a `subset` string but **no denominator**.
  `parseHarborJobDir` throws only on *zero* trials, so a run where harbor completed 3 of 25 tasks
  yields `resolvedRate = nResolved/3`; recorded under `subset: "keel-tb2-25"` it reads as a 25-task
  score. A partial run is indistinguishable from a full-subset run.

Both reduce to the same missing invariant: a run/score must be bound to the subset it claims to be.

## Options

1. **Pre-run guard only (EVAL-1).** Validate `taskNames` against the pinned subset before spending.
   Closes the spend-side hole but a hand-built or post-hoc scoreboard entry can still misreport.
2. **Scoreboard refine only (EVAL-2).** Make a partial/mismatched score structurally unrecordable.
   Protects the published number — the thing reviewers actually read — but lets a mismatched run burn
   money before anything notices.
3. **Both, sharing one primitive (chosen).** A pinned-size source of truth plus a binding at each
   boundary: the run boundary (fail-closed before any paid batch) and the record boundary (the
   scoreboard schema refuses a dishonest entry).

## Decision

Add to `tb2/subsets.ts`:

- `SUBSET_TASK_COUNTS` — the pinned per-subset task counts (`keel-tb2-25`→25, `-5`→5,
  `-heldout`→10) as pure constants, with a drift test asserting they equal the committed lists'
  `taskCount`. Pure constants (not a file read) so the initial scoreboard denominator refine stays
  I/O-free.
- `assertRunMatchesSubset(subsetName, taskIds)` — fail-closed if `taskIds` are not exactly the pinned
  subset's committed task set (same membership and count). A custom/unknown subset name is allowed
  (nothing pinned to bind to).

Wire it:

- **EVAL-1:** `runMatrix` calls `assertRunMatchesSubset(config.subset, config.taskNames)` first, before
  `planMatrix` or any batch. `MatrixRunnerConfig` gains a required `subset` field so every run must
  declare what it claims to be.
- **EVAL-2:** `ScoreboardEntry` gains a required `nTasks` (the `resolvedRate` denominator) and a refine
  that, for a pinned subset name, `nTasks` must equal `SUBSET_TASK_COUNTS[subset]`. A custom subset is
  unconstrained but its `nTasks` is still recorded for audit.

## 2026-07-04 extension: full-89 and claim-grade run evidence

Epic 2.31a extended this ADR's invariant before the first claim-grade full-suite result:

- `keel-tb2-full-89` is now a committed pinned task list derived from the existing TB-2.1 catalog. The
  run-boundary guard accepts it only under that canonical name and rejects custom labels that alias the
  exact 89-task suite.
- `assertRunMatchesSubset` now rejects duplicate task ids for every run label. For pinned labels it still
  requires exact membership; for custom labels it remains permissive except for renamed full-89 aliases.
- `ScoreboardEntry` now requires structured `runEvidence`: commit SHA, binary/build id, provider id,
  run-profile id, cache settings, budget caps, compaction state, wall-clock aggregate, exact entry task
  ids, and exact per-run task ids. The record-time guard checks `taskIds.length === nTasks`, exact
  membership for pinned labels, per-run task membership/count for every retained per-run resolved rate,
  and the canonical full-89 name for full-suite task evidence.
- The scoreboard record-time guard also binds `resolvedRate` to the declared `median`/`mean` aggregate
  of `perRunResolvedRate`, requires `scorePct === resolvedRate × 100`, requires
  `aggregateQuality.nTrajectories === runs × nTasks`, and rejects contradictory cache/compaction metadata.
- Public scoreboard JSON is aggregate-only: `harnessConfig.notes` and `change.description` are required
  to be `null`, so raw trajectory snippets belong in reviewed docs or private trajectory artifacts, not
  the committed scoreboard.
- The scoreboard membership refine now reads committed local task-list JSON. This deliberately relaxes
  the earlier I/O-free implementation preference, not the security posture: the read is hermetic,
  repo-pinned data and avoids duplicating 89 task ids in code.

## Consequences

- **Frozen-ish surfaces touched:** `ScoreboardEntry` (the committed scoreboard schema, Appendix F /
  §8.2) gains required fields, and `MatrixRunnerConfig` gains a required field. Existing committed
  scoreboards with entries, if any, must add `nTasks` and `runEvidence`; in-repo there are none, and the
  schema is the right place for the guarantee because it holds no matter who builds an entry. This is a
  stop-and-ask change — recorded here.
- A 3-of-25 run can now neither be **dispatched** nor **recorded** as `keel-tb2-25`: it is refused
  before spending and unrepresentable in the scoreboard.
- A 3-of-89 run, wrong-membership 89-task run, duplicate-id run, per-run partial, or custom-renamed exact
  full-89 run can neither become canonical full-suite evidence nor be recorded as a claim-grade full-89
  score.
- The held-out-vs-tuned disjointness guard (ADR-0042) becomes load-bearing at run time, not just in a
  CI smoke over the committed JSON.
- Custom/ad-hoc subsets remain usable for debugging (unconstrained), so the binding does not get in
  the way of exploratory runs — it only constrains the pinned subsets whose numbers get published.
- Follow-up: the same `assertRunMatchesSubset` binding could be threaded into any future
  single-variant runner (`runGuardedBenchmark`) that gains a subset label; today only `runMatrix`
  carries one.
