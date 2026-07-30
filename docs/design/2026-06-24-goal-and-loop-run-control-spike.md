# /goal and /loop: audited run-control primitives (spike)

**Status:** Design spike. Graduated to **ADR-0060** (accepted 2026-06-24) — decision, honesty invariants, and the Epic 2.12 reservation. Implementation deferred per the phasing in §9.
**Date:** 2026-06-24.
**Scope:** Candidates **3** and **4** of the Claude Code run-control exploration. Candidates 1 (lifecycle
manifest) and 2 (validation posture) are in
`docs/design/2026-06-24-lifecycle-validation-posture-spike.md`; this doc reuses their seams and must be
read alongside it. Evaluate `/goal` (work until a concrete objective is complete, gated by an
evidence-backed completion audit) and `/loop` (bounded repeated execution until an exit condition) for
Phase 2 **without** building a scheduler, background daemon, remote orchestration service, or a second
policy engine.

## 1. Executive recommendation

### Candidate 3: `/goal` — structured completion mode

**Recommendation: build a thin version in Phase 2A now.** `/goal` is the highest-value of the four
run-control primitives because it converts "keep prompting until the model says done" into an
**evidence-adjudicated completion contract** — which is Keel's honesty thesis applied to the run
lifecycle. It is cheap because the load-bearing mechanism already exists: the execution-grounded verify
gate (`packages/kernel/src/verify-gate.ts`, `classifyCompletion()`) already refuses to accept "done"
that isn't backed by a real, non-read-only test result. `/goal` is that gate promoted from a single
nudge into a structured, multi-criterion **completion audit** over a first-class `Goal` run object. The
model may *work toward* the goal freely; it may **not** declare the goal complete — the kernel
adjudicates completion from execution evidence and warden-routed validation, never from model
self-report.

The one honest constraint: the completion audit's *validation execution* (running the repo's tests
through the warden) is only as strong as the `warden.execute` path, which today is a narrow opt-in probe
(Epic 2.2). So `/goal` ships in two honest steps — the goal contract + completion-audit structure over
the **existing** Phase-1 execution evidence now, with warden-routed validation upgrading in lockstep as
the `warden.execute` path matures (same gate as lifecycle execution).

### Candidate 4: `/loop` — bounded repeated execution

**Recommendation: schema + design now; bounded in-session implementation gated on the real
`warden.execute` path; scheduled/background loops remain out of scope.** `/loop`
is valuable but is the riskiest of the four (runaway cost, repeated side effects, repeated network
calls, approval fatigue, ambiguous stop conditions). The safe v1 is a **bounded control structure inside
an active run**, not a daemon: repeat a bounded sub-run until a **structurally checkable** exit condition
(a configured command exits 0, verified by the warden — *not* the model asserting "it's fixed"), hard-
bounded by iterations/cost/wall-clock, with a **required-progress stop** built on the existing
loop-detector. Because the exit condition and each iteration's effects must run through
`warden.execute`, a *real* `/loop` implementation is gated on the same Phase-2A warden maturity as
lifecycle execution. Until then: land the `LoopConfig` schema and the executor seam; do not build the
scheduler.

**Ranking across all four run-control primitives:** (1) `/goal` — build now if small; (2) lifecycle
manifest — schema now, behavior as warden matures; (3) validation posture — extend ADR-0033, no new
engine; (4) `/loop` — design now, bounded local impl when easy, scheduled loops much later.

## 2. The thesis: run-control, not chat loops

The Keel-specific version of these primitives is **not** "Claude Code has slash commands too." It is:

> `/goal` and `/loop` are **audited, policy-constrained run-control primitives** — structured `Run`
> objects, not prompt text. They give the agent *persistence* (keep working / keep repeating) while
> granting it **no new authority**: it still cannot declare a goal done, satisfy an exit condition,
> exceed a bound, or self-extend a run. Completion and exit are adjudicated **structurally**, from
> execution evidence and warden verdicts — never from model self-report.

This is "autonomy at the reasoning layer, determinism at the control layer" (§1.1) applied to the run
lifecycle, and it is the same honest-by-construction principle as the verify gate and the receipt
(ADR-0059). The four primitives compose into a real **run model**:

| Primitive | Question it answers | Authority |
|---|---|---|
| Lifecycle manifest | *How* does this repo run? | Repo intent (untrusted until trusted) |
| Validation posture | *How strict* should Keel be? | Human/policy posture over the warden |
| **`/goal`** | *What* is this run trying to complete? | A run contract; completion adjudicated by evidence |
| **`/loop`** | *How* does Keel repeat work until a condition? | A bounded control structure; exit adjudicated by the warden |

A `/goal` says *what done means*; the validation posture says *how hard to verify it*; the lifecycle
manifest supplies *the commands that produce the evidence*; `/loop` is *the bounded iteration* that runs
when the path to done is "repeat until green." Together they replace the chat loop with a contract.

## 3. Current-state codebase assessment

These primitives are mostly *composition* of seams that already exist. Build on them; do not reinvent.

- **Execution-grounded verify gate (implemented).** `packages/kernel/src/verify-gate.ts`
  (`classifyCompletion()`), wired at `packages/kernel/src/loop.ts`. On a model-stop it classifies
  `skip|sharpen|standard` from **execution-grounded** evidence (a `TEST SUMMARY … PASS` banner or
  opt-in pytest summary), counting only results from **non-read-only** commands — model confidence is
  never counted. This is `/goal`'s completion-audit kernel, today handling one criterion; `/goal`
  generalizes it to many.
- **Budget triad + bounds (implemented, ADR-0044).** `packages/kernel/src/loop.ts`,
  `packages/kernel/src/cli/session-entry.ts` (`productionLoopSafety`). Effective-cost cap
  (`KEEL_MAX_TOKENS`), gross backstop (`KEEL_MAX_GROSS_TOKENS`), output guard
  (`KEEL_MAX_OUTPUT_TOKENS`), turn cap (`KEEL_MAX_TURNS`), wall-clock deadline (`KEEL_MAX_WALL_SEC`).
  `StopReason ∈ {model-stop, max-turns, budget, aborted, error, loop-detected, length, deadline}`. Both
  `/goal` and `/loop` reuse these as their hard bounds and stop vocabulary.
- **Loop detection / escalation (implemented, Epic 1.22).** `packages/kernel/src/loop-detection.ts`:
  n-gram tool-call cycles + per-file edit churn + over-generation guard, emitting `loop-detected`. Note
  the measured result that **advisory escalation guidance was net-negative** (`KEEL_LOOP_ESCALATION`
  default OFF) — so `/loop`'s progress requirement should be a **structural stop signal**, not a
  nag-the-model loop.
- **Autonomy modes + scope budget (spec + kernel-side advisory, ADR-0033/§4.9).**
  `packages/kernel/src/autonomy/alignment.ts` (`evaluateAlignment()`) computes advisory signals
  (`scope_budget_exceeded`, `broad_rewrite`, `low_confidence`) — *not* enforcement (that is Phase-2A
  warden). `ScopeTier ∈ {small, medium, large}`, default `medium`. `/goal` and `/loop` inherit the
  active posture/scope; neither sets its own.
- **Mid-run steering / input queue (implemented, ADR-0034/§4.10).** `packages/kernel/src/cli/input-queue.ts`,
  `packages/shared/src/session/events.ts` (`SteeringEvent`, classes `queued|interrupt|urgent`). Mid-run
  `/goal`/`/loop` adjustments (narrow scope, stop after current) flow through this; durable, survives
  resume and compaction.
- **Audit model — frozen list + open payload (ADR-0035 ledger; Appendix B frozen at 2A).**
  `packages/shared/src/audit/record.ts` freezes `AuditEventType`
  (`tool.execute|tool.deny|review.*|egress.*|trust.grant|mode.change|memory.*|provenance.declassify|session.*|checkpoint`).
  The non-frozen session ledger (`packages/shared/src/session/events.ts`) is additive. The established
  pattern (ADR-0033/0034) adds new semantics via **existing events + the open `payload` marker** —
  no frozen-format change. `/goal`/`/loop` audit follows this exactly (§5).
- **RunConfig surface (implemented).** Kernel: `AgentLoopInput`/`AgentLoopStop` (`loop.ts`). CLI:
  `KeelSessionOpts` + `productionLoopSafety(env)` (`session-entry.ts`). The natural home for `Goal`/`Loop`
  schemas is `@keel/shared`, alongside `LoopDetectionConfig` and the alignment inputs.
- **Lifecycle manifest + validation posture (spec-only, Epic 2.11).**
  `docs/design/2026-06-24-lifecycle-validation-posture-spike.md` — validation tiers + posture. `/goal`'s
  validation step *is* a validation-tier run; do not duplicate it.

**Net:** `/goal` is ~80% composition of existing kernel seams. `/loop` needs a new bounded executor but
reuses bounds, loop-detection, and the warden execute path. **No frozen-format change is required for
either** (§5).

## 4. Proposed minimal v1 design

### 4.1 `/goal` — the run contract + completion audit

**`Goal` is a first-class run object in `@keel/shared`, not prompt text.** The `/goal` slash command,
a `keel run --goal <file>`, or an inline form are all *constructors* of the same object; it is recorded
in the session ledger at run start and preserved through compaction as non-negotiable task state.

User-facing shape (YAML/slash surface; the `@keel/shared` zod schema is the camelCase equivalent):

```yaml
objective: "Implement side-effect taxonomy v1 and update the policy input schema"
doneWhen:                       # criteria — each is a CLAIM TO BE EVIDENCED, not a model self-grade
  - id: schemas-compile
    kind: command               # checkable: adjudicated by exit code
    check: { action: typecheck }      # a lifecycle action id, or an explicit argv
  - id: tests-pass
    kind: command
    check: { action: test.unit }
  - id: appendices-agree
    kind: narrative             # not mechanically checkable; model-claimed WITH cited evidence
    evidenceHint: "Appendix B and D both require sideEffect"
  - id: audit-has-sideeffect
    kind: command
    check: { argv: ["pnpm", "test", "packages/shared/src/audit"] }
validation:
  posture: standard             # selects a validation tier (lifecycle/posture spike, ADR-0033)
bounds:                         # ALL reuse ADR-0044 — no new bound primitives
  maxTurns: 20
  maxCostUsd: 5
  maxWallMinutes: 30
requiresCompletionAudit: true   # default true; cannot be set false under a strict posture
```

**The completion audit is the heart of `/goal`.** When the model signals done (a model-stop with no
tool calls), the kernel does **not** finalize the run. It runs a structured audit that generalizes
`classifyCompletion()`:

```
objective → deliverables → evidence → validation → per-criterion claim → remaining gaps → verdict
```

1. **Deliverables** — what the run actually produced, derived from the session ledger (files
   created/edited, commands run), not from the model's narration.
2. **Evidence** — for each `command` criterion, the kernel runs `check` (a lifecycle action or argv)
   **through `warden.execute`** and takes the **exit code / test verdict as ground truth**. Reuses the
   verify gate's existing rule: only results from non-read-only commands count. For each `narrative`
   criterion, the model must cite specific evidence (a ledger artifact / diff / command output) that
   **resolves to a real record**; an uncited or unresolvable claim fails the criterion.
3. **Validation** — the configured validation tier (lifecycle/posture) runs as ordinary
   `warden.execute` calls — classified, policy-checked, sandboxed, audited like any other command. A
   goal grants the agent **no** execution privilege; "being in a goal" never relaxes policy or sandbox.
4. **Per-criterion claim** — each `doneWhen` criterion is marked `satisfied | unsatisfied | unknown`,
   each with its citation. The audit explicitly **labels** `command` (machine-verified) vs `narrative`
   (evidence-cited, lower assurance) criteria — never blurs them.
5. **Verdict** — the goal is `complete` **only if** every criterion is `satisfied` *and* the validation
   tier passed. Otherwise the audit returns `incomplete` with the explicit **remaining gaps**.

**Honesty invariants (the whole point):**

- The model **authors the mapping** (which evidence backs which criterion); the kernel/warden **owns the
  verdict** (did the command exit 0; did validation pass). Model confidence is never counted — exactly
  as the verify gate already enforces.
- No `complete` verdict, status line, or receipt line renders unless its backing evidence exists and
  resolves. A goal with no configured validation reports **`unverified` honestly**, never a green
  "done."
- The agent may not set `requiresCompletionAudit: false`, raise its own scope, or mark its own goal
  complete (extends ADR-0017's "may not" list).

**Flow through the layers:**

- **TUI** — `/goal …` opens the goal; a goal HUD shows the objective, a live criterion checklist with
  each criterion's current evidence state, and bounds remaining. The completion audit renders as the
  objective→evidence→gaps map (this is the `/goal`-shaped face of the ADR-0059 receipt).
- **Kernel** — records the `Goal`; runs the normal loop toward it under ADR-0044 bounds; on model-stop,
  runs the completion audit instead of finalizing; continues, stops-and-reports, or completes per the
  verdict and posture.
- **Warden / policy / sandbox** — validation and `command`-criterion checks are ordinary
  `warden.execute`; the goal changes **no** verdict and **no** profile. A stricter validation posture
  may *require more* validation actions, never *fewer guarantees*.
- **Audit** — goal lifecycle as session-ledger events now; warden audit via existing events + `payload`
  markers; each evidence command is already its own `tool.execute` record that the audit cites (§5).

### 4.2 `/loop` — bounded in-session repetition

`LoopConfig` shape (user-facing; camelCase zod in `@keel/shared`):

```yaml
prompt: "Run the unit tests, inspect failures, and fix them"
until:                          # exit condition — STRUCTURALLY CHECKABLE, not model-asserted
  - kind: command
    check: { action: test.unit }
    satisfiedWhen: exitZero     # the warden runs it; its exit code is ground truth
bounds:
  maxIterations: 5
  maxCostUsd: 3
  maxWallMinutes: 20
effects:                        # DECLARED envelope — a NARROWING the warden enforces, never a relaxation
  allow: [fs_read, "fs_write:workspace", process_exec]
  deny: [network_write, external_service]
requireProgressEachIteration: true
```

**v1 is a bounded control structure inside an active run — not a scheduler.** Each iteration is a
bounded sub-run toward the exit condition. Between iterations the kernel checks, in order:

1. **Exit condition** — runs the configured `until` check **through `warden.execute`** and reads its
   **exit code**. The loop ends `succeeded` only on a real structural pass — never because the model
   says "fixed."
2. **Bounds** — iterations / cost / wall-clock, reusing ADR-0044; over-bound ends `loop-budget` /
   `loop-max-iterations` / `loop-deadline`.
3. **Progress** — reuses `loop-detection.ts`. If `requireProgressEachIteration` and an iteration
   produces a stagnation signal (same tool-call signature, no new evidence, exit condition no closer),
   the loop **stops** `loop-no-progress`. Structural stop, not a nag (per the net-negative escalation
   finding).

**Effect envelope is enforced, not honored.** The loop *declares* `allow`/`deny` effect classes (reusing
the ADR-0024 `EffectKind`/`EffectScope` taxonomy). This is an **additional narrowing** applied to the
warden's policy/sandbox profile for the loop's duration — it can only *tighten*. A loop that declares
`deny: [network_write]` but whose model attempts exfiltration is denied **by the warden**, as always;
the declaration is not an honor-system promise. A loop can never widen effects.

**Gating:** because both the exit-condition check and every iteration's actions run through
`warden.execute`, a *real* `/loop` implementation depends on the same warden maturity (live classifier +
policy + audit on the execute path) as lifecycle execution. Until that lands: ship the schema + the
bounded-executor seam; do not wire a runnable loop against the narrow probe path. **Scheduled /
background / cron loops are out of scope entirely.**

## 5. Audit records (and the frozen-format honesty point)

The desired records — goal create / iteration / completion-audit; loop iteration / stop / fail — are
**not** new frozen `AuditEventType`s. Appendix B is frozen at the 2A boundary, and these do not earn a
freeze. They are represented two ways, following the ADR-0033/0034 precedent:

- **Session ledger (non-frozen, additive) — now:** `goal_started`, `goal_audit`,
  `goal_completed`/`goal_failed`, `loop_iteration`, `loop_stopped` events, carrying the goal/loop id,
  criteria/exit state, bounds consumed, and stop reason. This is the same lane as `steering` and
  `run_status`.
- **Warden audit (frozen events + open `payload`) — as the warden matures:** goal/loop context rides
  the `payload` of existing events (`session.start`/`session.end`/`checkpoint`), and **every evidence /
  validation command is already its own `tool.execute` record**. The completion audit does not invent
  evidence — it **cites those existing `tool.execute` records**, so an offline reviewer can replay
  objective → cited `tool.execute` → exit code → verdict.

Promotion of goal/loop fields to first-class, validated audit fields happens **only** when a claim-grade
need exists, paired with an audit schema-version bump and its own stop-and-ask. **No
frozen-format change now.**

## 6. Security analysis

**Threats introduced.** Runaway cost / token churn (`/loop`); repeated side effects and network calls
(`/loop`); a model declaring a goal complete on weak or fabricated evidence; an "I'm in a goal/loop"
social justification for a risky command; an exit condition the model can satisfy by self-report; goal
config (if repo-sourced) used as an authority surface; audit claiming "validation passed" from
configured intent rather than observed results.

**Structural mitigations (not behavioral).**

- **Completion/exit is adjudicated by the warden/ledger, never the model.** A `command` criterion or
  `until` check is a real `warden.execute` whose exit code is ground truth; `narrative` criteria require
  resolvable citations. This is the core defense and it is structural.
- **No new authority.** A goal/loop never changes a policy verdict, sandbox profile, or egress
  allowlist. Validation and iteration commands are classified, policy-checked, sandboxed, and audited
  identically to any other command (extends the lifecycle spike's "the label never makes it safe").
- **`/loop` effects can only narrow.** The declared envelope tightens the warden profile for the loop;
  it cannot widen it. Repeated side-effecting actions get **no** standing approval — each call still
  faces the warden, and review/approval semantics (ADR-0033) apply per action, so policy can require
  per-iteration review for mutating/egress effects.
- **Hard bounds are structural.** ADR-0044 caps (cost/gross/output/turns/wall) plus loop iteration/
  duration caps bound runaway behavior regardless of model behavior; the loop self-stops with an honest
  reason.
- **Goal config as repo data follows trust-before-parse.** If a `.keel/goal.yaml` is supported, it is
  untrusted until workspace trust, parsed through a bounded schema with size caps, inert, with no env
  expansion and no shell execution at load (mirrors the lifecycle manifest rules). The *active* goal,
  like posture, is selected by the human/run config, never by repo authority and never by the model.

**Bypass risk — semantic laundering of "done."** The danger is a goal that *sounds* complete. Mitigation
is structural: completion requires `command` criteria to actually exit 0 through the warden and
`narrative` criteria to cite resolvable evidence; the audit labels assurance level; a goal with no
validation reports `unverified`, not `complete`.

**Required audit evidence.** For any completed goal, an offline reviewer must be able to answer: what was
the objective; which criteria were claimed; for each, which `tool.execute` record (command, exit code,
side effects, policy verdict, sandbox tier) backs it; which were machine-verified vs evidence-cited;
what validation tier ran and its pass/fail; and what gaps remained at completion.

## 7. Product / UX analysis

**Value.** `/goal` is the strongest DX-and-honesty win of the four: it turns "I think I'm done" into a
checkable contract, and the completion audit is exactly the artifact a reviewer (or a regulated buyer)
wants. `/loop` removes the tedium of "keep fixing until tests pass" while keeping it bounded and audited
— a genuinely safe version of a pattern users otherwise hand-roll dangerously.

**TUI surface.**

```text
Goal  Implement side-effect taxonomy v1 + policy input schema      ⟳ turn 7/20 · $1.80/5
  ✔ schemas-compile     typecheck → exit 0            (verified)
  ✔ tests-pass          test.unit → 2147 passed       (verified)
  • appendices-agree    cited: Appendix B,D require sideEffect   (evidence-cited)
  ▱ audit-has-sideeffect  not yet run
Validation posture: standard      VAL:pending
```

- The status line shows validation/goal state **only when real** (`VAL:standard`/`partial`/`none`), and
  never a `complete` badge before the audit's evidence resolves (§4.1 invariants).
- Honest "unverified" rendering when no validation is configured — never a fake green.
- Mid-run `/goal narrow`, `/goal stop-after-current`, `/loop stop` route through the steering queue
  (ADR-0034).

**Friction.** Do not require a goal for normal runs; `/goal` is opt-in. Do not require executable
criteria — a goal with only narrative criteria is allowed but honestly reported as lower-assurance.
Default `requiresCompletionAudit: true` so the safe behavior is the default, but keep the criteria
minimal so a goal is a one-liner plus a couple of checks.

## 8. Implementation plan if accepted

**Smallest safe PR sequence.**

1. **Design/ADR PR (this doc → ADR).** Record `/goal` and `/loop` as audited run-control primitives;
   the completion-audit and exit-condition honesty invariants; the no-new-authority and effects-only-
   narrow rules; phase placement. No schema/protocol change.
2. **`Goal` schema PR (`@keel/shared`).** `packages/shared/src/run/goal.ts` — objective, `doneWhen`
   (command/narrative), validation tier ref, bounds (reusing the existing budget fields), audit-required
   flag. Valid/malformed fixtures + wire/property tests + size caps. No execution.
3. **Completion-audit-over-verify-gate PR (kernel).** Generalize `classifyCompletion()` into a
   multi-criterion `evaluateGoalCompletion()` that runs `command` checks through the **current** execute
   path and emits the structured audit + `goal_*` ledger events. Reuses bounds + the existing
   model-stop interception. Tests: a goal completes only with real passing evidence; an uncited
   narrative criterion fails; model self-report never completes a goal.
4. **`LoopConfig` schema PR (`@keel/shared`).** `packages/shared/src/run/loop.ts` — prompt, `until`,
   bounds, declared effect envelope (reusing `EffectKind`/`EffectScope`), progress flag. Fixtures +
   tests proving effects can only narrow. No executor yet.
5. **Bounded `/loop` executor PR (kernel) — gated on a real `warden.execute`.** In-session iteration
   with warden-checked exit condition, ADR-0044 bounds, loop-detection progress stop, and the declared
   envelope applied as a warden profile narrowing. Denied-path tests: a loop cannot widen effects; an
   exfiltration attempt inside a `deny:[network_write]` loop is denied by the warden; the loop self-
   stops on no-progress and on each bound.
6. **TUI + receipt PR.** Goal HUD + criterion checklist + honest validation status line; the completion
   audit rendered as the `/goal` face of the ADR-0059 receipt; ledger/audit-derived only.

**Key denied-path / honesty tests (must exist):** model declares done with only read-only commands →
goal stays incomplete; `command` criterion that did not exit 0 → criterion unsatisfied; `/loop` exit
condition the model claims but the command fails → loop continues; goal/loop cannot change a policy
verdict or sandbox profile; no `complete`/green renders without resolvable evidence.

## 9. Phase placement

- **`/goal`:** Phase 2A. Goal schema + completion-audit-over-verify-gate ship now on the existing
  execution evidence; warden-routed validation strengthens in lockstep with `warden.execute` (Epic 2.2+
  / 2.8 integration). The completion audit + receipt is also a concrete early proof of the ADR-0059
  "honest receipt" thesis.
- **`/loop`:** schema + executor seam in Phase 2A; runnable bounded loop when the warden execute path is
  real (classifier + policy + audit); **scheduled/background/cron loops remain out of scope.**
- **Shared:** neither requires an Appendix A/B/D change in Phase 2A (§5).

## 10. Open decisions for the owner

1. **Goal constructors.** Slash-command-only, or also `keel run --goal <file>` and/or a repo
   `.keel/goal.yaml`? *Recommendation:* one first-class `Goal` object with several constructors;
   slash + inline now; a trust-gated repo file later (untrusted-until-trust, like lifecycle).
2. **`doneWhen` expressiveness.** *Recommendation:* support both `command` (machine-verified) and
   `narrative` (evidence-cited) criteria, but the audit must **label assurance level** and never let a
   narrative criterion alone yield `complete` under a strict posture.
3. **Audit failure behavior.** *Recommendation:* stop-and-report with explicit gaps by default
   (Guided); auto-continue up to bounds under Autopilot; never silently loop.
4. **Goal vs scope budget.** *Recommendation:* a goal may declare a higher scope tier, but that is an
   intent-alignment heuristic only (audited) — the warden still enforces per action (ADR-0033).
5. **`/loop` exit expressiveness in v1.** Single command-exit-0 vs boolean combinations of checks.
   *Recommendation:* single command-exit-0 in v1; add combinators only with fixtures.
6. **Naming.** `/goal` + `/loop` are good; confirm before they appear in `strings.ts`/tests.

## 11. Answers to the posed questions

- **Slash-only or first-class RunConfig?** First-class `Goal`/`Loop` objects in `@keel/shared`; the slash
  command is a constructor (decision 1).
- **Where do the schemas live?** `@keel/shared` — `packages/shared/src/run/{goal,loop}.ts`, beside the
  budget/alignment/loop-detection types they reuse.
- **Flow through TUI/kernel/warden/policy/audit/validation?** §4.1 (goal) and §4.2 (loop); validation =
  ordinary `warden.execute` under the lifecycle/posture machinery; audit = §5.
- **How does `/goal` interact with lifecycle + validation posture?** The goal selects a validation tier;
  the lifecycle manifest supplies the commands; the posture sets the requirement strength. The goal adds
  the objective and the per-criterion completion audit on top.
- **How does `/loop` avoid runaway behavior?** ADR-0044 bounds + loop iteration/duration caps +
  structural no-progress stop + per-action warden review for side-effecting/egress effects.
- **How does `/loop` prove progress?** Reuses `loop-detection.ts` stagnation signals as a **stop**
  condition (not a nag), plus "exit condition measurably closer."
- **Policy restrictions on repeated side effects?** No standing approval; each call faces the warden;
  the declared effect envelope can only narrow; policy may require per-iteration review for
  mutating/egress effects.
- **Audit records for create/iteration/completion/stop/fail?** Session-ledger events now; existing
  warden events + open `payload` + cited `tool.execute` records later. No frozen change (§5).
- **Minimal safe v1?** `/goal`: schema + completion-audit-over-verify-gate + honest receipt. `/loop`:
  schema + bounded executor seam, runnable when `warden.execute` is real. Neither is a scheduler.
- **Phase 2 vs later scope?** §9 — `/goal` now; `/loop` schema now + bounded implementation as the
  warden matures; scheduled loops remain out of scope.

## 12. References

- Keel: `MASTER_SPEC.md` §1.1/§3.2/§4.3/§4.8/§4.9/§4.10/§7; ADR-0044 (budget controller), ADR-0033
  (autonomy postures), ADR-0034 (steering), ADR-0035 (ledger), ADR-0024 (side-effect taxonomy), ADR-0017
  (agent authority), ADR-0059 (honest receipt). Code:
  `packages/kernel/src/verify-gate.ts`, `loop.ts`, `loop-detection.ts`, `autonomy/alignment.ts`,
  `cli/input-queue.ts`, `cli/session-entry.ts`; `packages/shared/src/{audit/record.ts,session/events.ts}`.
- Sibling spike: `docs/design/2026-06-24-lifecycle-validation-posture-spike.md` (candidates 1 & 2).
- External framing: Letta goal-mode's completion-audit-against-real-evidence principle (objective →
  deliverables → evidence → validation → claim); recent Claude Code/agent-workflow writing distinguishing
  `/goal` (complete an objective) from `/loop` (repeat on a cadence / until a monitored condition). These
  motivate the primitives; the Keel-specific contribution is making both **audited and warden-constrained**.
```
