# ADR-0060 — `/goal` and `/loop`: audited run-control primitives

- **Status:** **Accepted** (2026-06-24). Changes **no** frozen interface, schema, audit format, or
  security claim — it records a design decision derived from the run-control spike, binds the honesty
  invariants, reserves **Epic 2.12**, and places the build behind existing gates. The `MASTER_SPEC.md`
  §7/§10.1 reconciliation is applied in this change; the full epic plan is authored when the work starts.
- **Date:** 2026-06-24.
- **Deciders:** keel maintainer (proposed by Claude Opus 4.8).
- **Governs:** `/goal` and `/loop` as run-control primitives and their roadmap placement. Relates to
  MASTER_SPEC §1.1 (autonomy at the reasoning layer, determinism at the control layer), §3.2/§3.3
  (claims/limits), §4.9/§4.10 (autonomy & steering), §7 (Epic 2.7 receipt, Epic 2.8 integration, Epic
  2.11 lifecycle/posture, **Epic 2.12** reserved here), §10.1. Builds on ADR-0044 (budget triad),
  ADR-0033 (autonomy postures), ADR-0034 (steering), ADR-0035 (session ledger), ADR-0024 (side-effect
  taxonomy), ADR-0017 (agent authority — the "may not" list), ADR-0059 (honest receipt),
  ADR-0058 (lifecycle manifest + validation posture — Epic 2.11, the
  validation machinery `/goal` reuses).
- **Anchor:** `docs/design/2026-06-24-goal-and-loop-run-control-spike.md` (full spike — current-state
  seams, schemas, completion audit, security/UX analysis, PR sequence, open decisions).

## Context

We want two run-control primitives: `/goal` (work until a concrete objective is complete) and `/loop`
(repeat a bounded action until an exit condition). Done naively — "keep prompting until the model says
done" / "loop until the model says it's fixed" — both hand the agent more rope without more control,
which is the opposite of keel's thesis. The spike establishes the keel-specific version: **audited,
policy-constrained run-control primitives** that give the agent *persistence* without *authority*.
Completion and exit are adjudicated structurally, and the load-bearing mechanism already exists — the
execution-grounded verify gate (`packages/kernel/src/verify-gate.ts`, `classifyCompletion()`) already
refuses "done" that isn't backed by a real, non-read-only test result. This ADR records the decision so
the future build cannot drift into a chat loop.

## Options

1. **Don't build them / leave to ad-hoc prompting.** Rejected — the pattern is valuable and users
   hand-roll dangerous versions; a structured, audited form is squarely on-thesis.
2. **Build "keep prompting until done" + a background `/loop` scheduler.** Rejected — model-adjudicated
   completion is dishonest, and a scheduler/daemon introduces runaway cost, repeated side effects, and
   approval fatigue and a substantially larger lifecycle/authorization surface.
3. **Audited run-control primitives: structured `Goal`/`Loop` objects; completion/exit adjudicated by
   the warden/ledger; bounded; no new authority; no frozen change.** **Chosen.** Reserve Epic 2.12;
   build `/goal` after Epic 2.8; gate `/loop`'s runnable form on warden maturity; defer scheduled loops.

## Decision

Adopt `/goal` and `/loop` under these invariants:

1. **Run-control, not chat loops.** Both are first-class `Goal`/`Loop` objects in `@keel/shared`
   (`packages/shared/src/run/{goal,loop}.ts`), constructed by the slash command / CLI / inline form —
   **not** prompt text. They grant the agent *persistence*, never *authority*.
2. **`/goal` completion is adjudicated structurally.** The completion audit generalizes
   `classifyCompletion()` into objective → deliverables → evidence → validation → per-criterion claim →
   gaps → verdict. `command` criteria pass only on a real `warden.execute` exit code; `narrative`
   criteria require citations that **resolve** to real ledger/audit records; the audit **labels**
   machine-verified vs evidence-cited. The model authors the mapping; the **kernel/warden owns the
   verdict** — model confidence is never counted (as the verify gate already enforces). No
   `complete`/green status or receipt line renders without resolvable evidence; a goal with no
   validation reports **`unverified`**, honestly.
3. **No new authority (extends ADR-0017).** A goal/loop never changes a policy verdict, sandbox profile,
   or egress allowlist; validation and iteration commands are ordinary `warden.execute` (classified,
   policy-checked, sandboxed, audited). The model **may not** set `requiresCompletionAudit: false`,
   raise its own scope, mark its own goal complete, or satisfy an exit condition by assertion.
4. **`/goal` validation reuses Epic 2.11.** The validation step selects a validation tier from the
   lifecycle/posture machinery (ADR-0058); the goal adds the objective and the per-criterion audit. No
   second validation engine.
5. **`/loop` is a bounded in-session control structure, never a scheduler.** The exit condition is
   **structurally checkable** (a `warden.execute` command exit code, not a model assertion). Hard bounds
   reuse the ADR-0044 triad plus iteration/duration caps. Progress reuses the loop detector
   (`loop-detection.ts`) as a **structural stop** (`loop-no-progress`), not a nag (per the measured
   net-negative escalation finding). The declared **effect envelope can only narrow** the warden profile
   for the loop's duration — enforced by the warden, never an honor-system promise; it can never widen.
   **Scheduled / background / cron loops are out of scope.**
6. **No frozen-format change.** Goal/loop lifecycle rides non-frozen session-ledger events now
   (`goal_started`/`goal_audit`/`goal_completed`/`goal_failed`/`loop_iteration`/`loop_stopped`), and
   existing warden audit events + the open `payload` marker later — the completion audit **cites the
   per-command `tool.execute` records** rather than inventing evidence (ADR-0033/0034 precedent).
7. **Phasing + Epic 2.12.** Reserve **Epic 2.12**. `/goal` builds after **Epic 2.8** (warden-kernel
   integration + receipt), where its audit becomes warden-routed and it doubles as a concrete proof of
   the ADR-0059 honest receipt. `/loop` lands as schema + bounded executor seam gated on the same live
   classifier+policy+audit execute path as Epic 2.11. The full epic plan is authored when the work
   starts; **nothing is pulled into the in-flight Epic 2.2.**

## Consequences

- **Positive:** turns "I think I'm done" into an evidence-adjudicated completion contract (an artifact a
  reviewer / regulated buyer wants); gives a safe, bounded, audited version of "loop until green";
  reuses existing seams (verify gate, budget triad, loop detector, lifecycle/posture) so `/goal` is
  mostly composition; `/goal`'s audit is an early concrete proof of ADR-0059.
- **Cost / obligations:** `/goal`'s warden-routed validation is only as strong as `warden.execute`
  (matures across Epic 2.2/2.8); a reviewer must hold the no-model-adjudication and effects-only-narrow
  lines; `/loop`'s runnable form waits on warden maturity.
- **Honesty:** creates **no** new security claim. Both surface/compose existing guarantees; the
  completion audit and receipt render only what the ledger/warden actually produced.

## Non-goals

- **Not** building either now — Epic 2.12, after Epic 2.8 (`/goal`) and warden-execute maturity
  (`/loop`).
- **Not** a scheduler, daemon, cron, or any always-on/background loop.
- **Not** model-adjudicated completion or exit — ever (invariants 2, 5).
- **Not** new agent authority — a goal/loop never relaxes policy/sandbox/egress (invariant 3).
- **Not** an Appendix A/B/D change — session-ledger events + open `payload` + cited `tool.execute`
  (invariant 6).
- **Not** pulled into the in-flight Epic 2.2 (sandbox/egress) work.

## Implementation implications

- **Shared schemas:** `packages/shared/src/run/goal.ts` and `run/loop.ts`, beside the budget/alignment/
  loop-detection types they reuse; bounds reuse the existing budget fields; `/loop` effects reuse the
  ADR-0024 `EffectKind`/`EffectScope`.
- **Kernel:** generalize `classifyCompletion()` into a multi-criterion `evaluateGoalCompletion()`
  emitting the structured audit + `goal_*` ledger events; the bounded `/loop` executor (warden-checked
  exit, ADR-0044 bounds, loop-detector progress stop, envelope-as-narrowing) lands when `warden.execute`
  is real.
- **TUI:** goal HUD + criterion checklist + honest validation status line; the completion audit rendered
  as the `/goal` face of the ADR-0059 receipt — ledger/audit-derived only.
- **Reconciliation:** §7 (Epic 2.12 reserved) and §10.1 (ADR registry) are reconciled in this change;
  the README ADR index gains a row; the full Epic 2.12 plan is authored at phase start.
