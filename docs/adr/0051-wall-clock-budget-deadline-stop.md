# 0051 — Wall-clock run budget + a `"deadline"` stop reason

**Status:** accepted
**Date:** 2026-06-20
**Amended:** 2026-07-29 by Epic 3.15 to make elapsed time fail closed across clock rollback and
host suspend while preserving the injected-clock test seam.
**Relates to:** §4.3 (loop & stop conditions), §8.6 (kernel DX — honest, complete records). Implements
**Lever C** of the 2026-06-20 post-fix TB-2.1 analysis; executable evidence lives in the associated
budget and deadline tests. Builds on ADR-0044 (the cost-aware
budget triad — this adds a *time* dimension alongside it) and pairs with the C-stream transcript change.

## Context

keel had **no notion of wall-clock time**: the loop terminates only on turns or the token triad (ADR-0044).
When the gross-token backstop was dropped, heavy non-converging runs churned until the harbor harness
SIGKILLed them at its hard 900s/1800s cap — an *ungraceful* death (and, before the C-stream fix, an empty
transcript). The harness cap is invisible to keel: harbor never passes it in.

A run should be able to **stop itself cleanly before an external hard cap**, and — generally, for any keel
user — a maximum wall-clock budget is a sensible control (don't let a runaway burn unbounded time, the way
`KEEL_MAX_TOKENS` bounds spend). This is not a benchmark hack: a CI job, a cron task, or an interactive user
all want "stop after N seconds, gracefully."

## Decision

1. **A wall-clock run budget.** New `KEEL_MAX_WALL_SEC` env → `AgentLoopStop.maxWallMs` (parsed parallel to
   `KEEL_MAX_TURNS`/`KEEL_MAX_TOKENS` in `productionLoopSafety`). Unset = no time bound (unchanged behavior).
2. **A fail-closed elapsed clock plus an injected test seam.** Production captures both
   `performance.now()` and `Date.now()` at physical run start and uses the greater of their
   non-negative elapsed deltas. The monotonic delta prevents civil-clock rollback from extending a
   run; the civil delta ensures host suspend and forward clock progress still count. The loop's
   `now?: () => number` test seam replaces that hybrid with one caller-supplied monotonic clock, so
   deadline paths remain **deterministically testable** without real timers.
3. **A graceful `"deadline"` stop.** A check at the top of the turn loop (alongside `maxTurns`/budget):
   when fail-closed elapsed time reaches `maxWallMs`, the loop stops with a **new `StopReason` value `"deadline"`** and
   falls through the single `run-finished` exit — so C-stream's incremental transcript + the runner's
   finalize flush a clean, honest record instead of a SIGKILL.
4. **Mid-turn enforcement.** Because the top-of-loop check only fires *between* turns, a deadline-armed
   `AbortController` (combined with any caller `signal`) is threaded to the model stream and tool execution,
   so a long in-flight turn is interrupted. An abort that coincides with the deadline having passed is
   reported as `"deadline"`, not `"aborted"` (one disambiguation rule at every abort site).

### The frozen-schema change (`StopReason` gains `"deadline"`)

`@keel/shared` `events.ts` `StopReason` is a frozen enum shared by the live `KernelEvent` and the durable
`run_status` ledger event. Adding `"deadline"` is additive and reviewed in its own commit. No consumer
exhaustively switches on it (the recorder remembers the reason as-is; the runner stores it; `bin.ts` maps
"not `model-stop`" → exit 1), so `"deadline"` flows through as an honest, incomplete-run exit (1) without
further change. Harbor forces exit 0 and grades from the verifier (QR-7), so the exit code is cosmetic for
the eval but correct for a script/CI caller.

## Alternatives weighed

1. **Reuse an existing reason (`"budget"` or `"aborted"`).** Avoids the schema change, but a time stop is
   neither a token-budget nor a caller-cancel — recording it as one is dishonest in the durable ledger and
   defeats the analysis value (you couldn't tell a wall-clock stop from a cancel). **Rejected:** the schema
   honesty (§8.6) is worth one additive enum value + an ADR.
2. **Let harbor keep SIGKILLing; rely only on C-stream for the transcript.** C-stream already saves the
   record, but the run still *churns to the hard kill* (wasted time/tokens) and dies ungracefully with no
   honest stop reason. **Rejected:** the graceful self-stop is the point of Lever C; C-stream is the safety
   net, not the mechanism.
3. **Between-turns check only (no mid-turn abort).** Simpler, but a single long tool (bounded only by the
   660s infra timeout) could overrun a between-turns deadline by minutes. **Rejected for the enforcement
   path** — the armed `AbortController` is what makes the deadline actually bind; the between-turns check is
   kept as the deterministic, testable common-case path.

## Consequences

- A run with `KEEL_MAX_WALL_SEC` set stops itself with `reason: "deadline"` at the budget, gracefully, with
  a flushed transcript — converting the prior "churn → SIGKILL → empty record" into an honest scored stop.
- **Owner action (not in this change):** for the deadline to engage in the benchmark, harbor must set
  `KEEL_MAX_WALL_SEC` slightly **below** its own 900s/1800s cap (a one-line `eval/harbor-adapter` config).
  Without it the feature is inert (and C-stream still preserves the transcript).
- The production hybrid elapsed clock fails closed across both civil-clock rollback and host
  suspend/forward progress. The injected monotonic clock keeps the loop deterministic/testable (no
  real-timer flake for the between-turns path).
- No change to the token triad, the per-tool infra timeout, or any other stop reason; `"deadline"` is
  additive and backward-compatible (absent `maxWallMs` = today's behavior exactly).
