# Benchmark scoreboard

`eval/scoreboard.json` is the committed, public benchmark history (§8.2: "scoreboard committed to repo,
public, **including regressions** — measured-not-asserted is identity"). It currently has no entry that
meets the present claim-grade schema. The older, single-trial 59-task snapshot in
[`docs/benchmarks.md`](../docs/benchmarks.md) predates this schema and lacks the required structured
`runEvidence`; it remains published with its caveats and is not retroactively promoted into the
scoreboard.

Each entry (schema + writer in `@keel/eval/scoreboard.ts`) records one harness's score on one subset:

- **the score** — the declared aggregate (`median` or `mean`) of the per-run **resolved rate**, derived
  from the TB-2 grader's verdict, **never keel's exit code** (a `stop(error)`/`max-turns` run still exits
  0 — QR-7). The per-run trials are retained and the schema rejects a score that does not equal the
  declared aggregate.
- **the harness config (QR-5)** — the reasoning sandwich + prompt-caching, recorded *with* the score so
  a reasoning-sandwiched keel vs a flat reference harness on "the same model" is never a hidden confound.
- **the pinned infra block** — so a parity comparison can assert keel and the reference ran on identical
  infra (Appendix F).
- **`runEvidence`** — structured claim-grade metadata: source commit, binary/build id, provider id,
  run-profile id, cache settings, budget caps, compaction state, aggregate wall-clock, exact entry task
  ids, and exact per-run task ids. These fields are required for entries instead of hiding claim evidence
  in `harnessConfig.notes`.
- **`infraAborts`** — infra-aborted trials (`retries:0`) recorded distinctly, never retried into a pass.
- **`aggregateQuality`** — the §8.2 trajectory-quality metrics, **aggregate only** (no raw trajectory
  content; `nTrajectories` must equal `runs × nTasks`, and the serialized scoreboard is also routed
  through the SEC-014 redaction filter — QR-4).
- **`change`** — for a loop iteration, the failure mode it targeted + the trajectory IDs as evidence.
  Free-text notes/descriptions are not accepted in the committed scoreboard JSON.

Pinned subset names bind both the denominator and exact task membership. The canonical full-suite subset
is `keel-tb2-full-89`; a partial, wrong-membership, duplicate-id, or custom-renamed full-suite entry is
rejected before it can become public scoreboard evidence. A scoreboard file is suite-scoped: every entry
must use the same `suite` as the top-level scoreboard.

`addEntry` flags a **regression** when a harness's score drops more than `regressionThreshold` (2 pts)
vs its own prior entry on the same subset — the §8.2 ">2-pt drop vs last gate blocks merge" rule,
surfaced for the gate to act on. The parity verdict compares keel's median to **our** reference-harness
median on identical infra (never a leaderboard number).
