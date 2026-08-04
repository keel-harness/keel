# Keel TUI and Warden UX remediation plan

Status: proposed execution plan; no behavior changes authorized by this document.

Date: 2026-08-02

Umbrella issue: [keel-harness/keel#52](https://github.com/keel-harness/keel/issues/52)

Evidence baseline: live dogfood at Keel `a14133831f3a249a8e941c38c302f9effd61ce82`
against an isolated `pallets/click` checkout, using six workflow classes, a 100×30 Kitty
terminal, 23 successful Anthropic calls, and USD 2.71085115 in provider spend.

## Executive decision

Keel's governed execution foundation is promising, but the observed daily-driver experience is
not ready to be called excellent. The approximate baseline is **2.8/5**. The most serious gaps
are not decorative: the TUI can present an ungrantable review as an approval dead end, mark failed
commands as successful, lose successful mutation evidence, preserve obsolete denials, and let
model prose contradict controller-owned history.

The remediation goal is:

1. **Release gate: at least 3.8/5**, with no workflow or critical trust axis allowed to hide below
   an acceptable floor.
2. **Stretch gate: at least 4.0/5**, after the no-dead-end, truth, continuity, and calm-density
   work is proven with real users and real provider runs.
3. **No security discount:** fewer confusing interruptions must come from better policy precision,
   containment explanation, bounded scopes, and self-correction—not weaker enforcement.

The order is deliberate: first make Keel tell the truth and eliminate dead ends; then preserve
continuity and control; then reduce noise and improve the flagship review surfaces.

## Evidence boundary

This plan separates three evidence classes:

- **Directly observed:** reproduced in this dogfood run and recorded in `issues.md`, PTY/session
  logs, audit evidence, or screenshots.
- **Contract reconciliation:** an observed failure conflicts with an existing product rule in
  `MASTER_SPEC.md`, an accepted ADR, the policy guide, or `docs/design/tui-principles.md`.
- **Hypothesis:** likely valuable, but not directly validated in this run. Hypotheses remain below
  the P0/P1 remediation queue and require their own reproduction before implementation.

Important limitations:

- One external repository and one primary terminal shape were used.
- E3/E4 evidence was gathered in Kitty on macOS, mostly with a dark theme at 100×30.
- Light themes, no-color terminals, narrow terminals, Linux, screen readers, and a cohort of human
  evaluators were not yet tested.
- Arbitrary technical accuracy in model prose cannot be guaranteed by presentation code. Keel can,
  however, ensure its authoritative receipts never repeat or endorse claims unsupported by
  controller-owned evidence.

## Product rules for every slice

Every retained change must make these existing principles more true:

1. **Never lie.** Visual success, completion, verification, review actionability, and enforcement
   posture come from authoritative state—not optimistic icons or model narration.
2. **No dead ends.** Every surface either works now or says it is unavailable, why, and what safe
   next action exists.
3. **Show intent, hide noise, reveal evidence.** The objective and next useful action outrank old
   tool chatter; decisive evidence remains one action away.
4. **Controller facts beat transcript reconstruction.** Receipts and recovery state reconcile the
   latest authoritative outcome instead of replaying stale events as equally current.
5. **Interruptions are predictable.** The UI distinguishes interrupt-now, before-next-mutation,
   queued, blocked, and completed semantics.
6. **Security remains structural.** TUI copy cannot invent approval authority, expand a grant, or
   convert a deny/review into allow.
7. **One small vertical slice at a time.** Each slice begins with a failing test, repeats the live
   reproduction, and is retained only if the same scenario materially improves.

## Scoring contract

The baseline score remains comparable to `scorecard.md`: each workflow is the unweighted mean of
its applicable axes, `N/A` axes are excluded, and the overall score is the unweighted mean of the
six workflow means. Future runs must not silently change this formula.

### 3.8 release gate

All of the following must be true at the same candidate commit:

- Overall score is **at least 3.8/5**.
- Every workflow mean is **at least 3.5/5**.
- The Warden-heavy workflow is **at least 3.5/5**; a strong interruption workflow cannot mask a
  broken approval experience.
- Trust, user control, error recovery, and final-result confidence score **at least 4/5** in every
  workflow where they apply.
- There are no open P0 findings and no unmitigated P1 finding on a required scenario.
- No observed nonzero command displays a success glyph or success label.
- No terminal, stale, or ungrantable review appears actionable.
- Final receipts agree with the latest controller-owned tool, audit, mutation, verification,
  compaction, and interrupt facts in the test corpus.
- E2 automated, E3 PTY, E4 fixed-size visual, and E5 live-provider evidence all exist for the
  release candidate. Any missing class is reported as `NOT_RUN`, and the gate remains open.
- Keyboard input, history, scrolling, resize, resume, review decisions, urgent steering, and
  interrupt regression checks pass.
- Lint, typecheck, format, unit/property tests, and relevant real-sandbox probes pass without a
  weakened test or gate.

### 4.0 stretch gate

In addition to the 3.8 gate:

- Overall score is **at least 4.0/5** and no workflow is below **3.8/5**.
- Warden usefulness and Warden interruption burden each score **at least 4/5**.
- Progress visibility, user control, trust, and final-result confidence each have a cross-workflow
  mean of **at least 4.2/5**.
- At least three advanced-developer evaluations cover macOS and Linux, one terminal at or below
  80×24, dark and light themes, and a no-color run. The median meets the gate and no evaluator
  reports a P0 truth/control failure.
- The six canonical workflows pass twice from fresh isolated homes without manual repair or an
  unexplained state transition.

These are acceptance gates, not score forecasts. A 4.0 target must not be reached by generous
scoring; each score needs a note and observable evidence.

## Wave 0 — make comparison repeatable

This is enabling work, not a substitute for fixing the P0. Keep it small and time-boxed.

### R0. Freeze the dogfood scenarios and score mechanics

Status: merged through [PR #63](https://github.com/keel-harness/keel/pull/63) as `05452ec`; exact
reviewed-head and post-merge `main` CI passed and the trees are identical. The private eval/docs
slice freezes all six workflows and provides an offline controller/render contradiction comparator;
it does not score UX or make policy decisions.

- **Evidence:** score and screenshots exist, but several reproductions still depend on remembered
  prompt wording and manual ledger comparison.
- **Deliverable:** a sanitized scenario manifest containing external baseline commit, prompt,
  terminal dimensions, mode, expected policy posture, expected authoritative facts, expected user
  outcome, screenshot checkpoints, and cost ceiling for all six workflows.
- **Automated proof:** a comparator flags contradictions between structured bash envelopes,
  audit/review lifecycle, mutation capability, verification events, interrupt state, and rendered
  cards/receipts. It must not make policy decisions.
- **Manual proof:** one clean replay produces the same scorecard axes and safe screenshot names.
- **Time box:** one small docs/test-harness slice. Do not build a general benchmark platform.

## Stack-ranked P0/P1 remediation

The queue below covers every P0 and P1 in `issues.md`. Rankings are product priority, not an
instruction to combine findings into large commits.

### R1 · P0 — make review actionability truthful and remove the observed dead end

Findings: **DF-008**.

Candidate status: merged in [PR #55](https://github.com/keel-harness/keel/pull/55); exact executor
bytes and all enforcement surfaces remain unchanged.

#### Corrected diagnosis

Keel already has a live, controller-owned approval flow for genuinely pending, grantable reviews.
The observed `POL-003` outcomes were `grantable:false, pending:false`; `/reviews` was correctly
read-only. The failure is that an ungrantable `review` can still feel like an approval request even
though there is no decision the human can make. That violates the no-dead-ends bar.

#### User outcome

- A pending grantable review opens the existing focused decision surface with exact requested
  action, effective target, why, consequence, reusable scope if present, and once/session/deny/why
  choices.
- An ungrantable or terminal review is rendered as **blocked, no live decision available**—never
  `approval required`—with the exact controller-provided reason and safest supported rewrite or
  next step.
- The agent receives machine-readable recovery guidance and is expected to retry an atomic safe
  equivalent once before declaring the task blocked.
- Stale review receipts remain inspectable but cannot masquerade as buttons.

#### Small slices

1. Presentation-only lifecycle vocabulary and actionability tests for pending/grantable,
   ungrantable/terminal, resolved-allowed, resolved-denied, failed, and stale states.
2. Focus/keyboard/no-color tests proving only live pending reviews accept decisions.
3. Model-visible recovery guidance and one bounded self-correction attempt for safe atomic command
   rewrites; preserve terminal denial when no equivalent exists.
4. Separately investigate why routine contained diagnostic/test command shapes received terminal
   review. Any classifier, grantability, policy, or enforcement change requires a dedicated public
   security issue, positive/negative/adversarial tests, and human approval.

#### Likely surfaces

`packages/kernel/src/warden/approval.ts`, `review-decision.*`, `executor.ts`, TUI review view-model
and Ink components, plus adjacent approval/executor/real-TUI tests. Policy-precision investigation
may reach `packages/warden`, but must not be smuggled into the presentation slice.

#### Acceptance evidence

- Red-first lifecycle matrix tests; no-color meaning does not depend on hue.
- E3/E4 replay of one real pending grantable review and one real ungrantable review.
- Zero authority or audit/schema change in the presentation slice.
- Security/adversarial review proves no stale, model-authored, or ungrantable review can execute.

#### Score leverage

Warden-heavy control, recovery, trust, Warden usefulness, burden, and final confidence.

### R2 · P1 — render command outcome, not transport outcome

Findings: **DF-010**. This is the existing first slice in issue #52 and should follow immediately
after the P0 lifecycle clarification—or land first only if needed as a one-commit truth guard while
R1's public security boundary is being reviewed.

Candidate status: merged in [PR #57](https://github.com/keel-harness/keel/pull/57) after R1.

#### User outcome

A structured bash envelope with nonzero `exitCode`, termination signal, timeout, or equivalent
command failure renders as failed in live and resumed transcripts, even when the Warden/tool
transport completed normally. Exit zero remains successful. The failure is understandable without
color and exposes the most useful bounded stderr/stdout excerpt.

#### Likely surfaces

`packages/kernel/src/tui/view-model.ts`, bash/tool card components, headless renderer, resumed seed
logic, and adjacent view-model/headless/Ink tests.

#### Acceptance evidence

- Red tests for live and resumed exit 1, signal/timeout where represented, and exit 0 control.
- Authoritative envelope, audit record, tool protocol, and model-visible result remain unchanged.
- E3/E4 replay shows failing pytest and failing install as failed, not `✓ done`.

#### Score leverage

Feature/debugging clarity, error recovery, trust, and final confidence.

### R3 · P1 — make final state a reconciled controller receipt

Findings: **DF-006, DF-015, DF-019**.

Candidate status: the safe exact edit/write recovery slice merged in
[PR #59](https://github.com/keel-harness/keel/pull/59). Generic equivalent-bash recovery and
compaction ordering remain unavailable from existing TUI facts and were not manufactured.

#### User outcome

- The evidence rail represents latest authoritative lifecycle state: a denial followed by an
  allowed successful retry is shown as recovered, not left as the apparent final outcome.
- Verification facts reflect commands that actually completed, including partial/full distinction.
- Compaction and interrupt timing come from ledger order, not model reconstruction.
- The controller receipt is visually distinct from assistant prose. Unsupported technical analysis
  can remain prose, but it cannot become a `Verified` fact without evidence.

#### Small slices

1. Define deterministic reconciliation keys and precedence for tool attempts, review lifecycle,
   mutation completion, verification, compaction, and interrupt events already available to the
   UI.
2. Red tests for deny → corrective read → allowed edit → passing test, failed attempt → successful
   retry, partial verification, and post-completion compaction.
3. Render `recovered`, `superseded`, `not verified`, and `indeterminate` explicitly; keep full
   history inspectable on demand.
4. Prevent controller-owned receipt labels from being synthesized from assistant narrative.

#### Likely surfaces

`packages/kernel/src/tui/view-model.ts` (`buildTurnSummary`, result summaries, live reducer, resumed
seed), conversation/receipt components, runner/session reconstruction tests, and existing
controller fact sources. Stop if a frozen event, audit, or session schema would need to change.

#### Acceptance evidence

- Golden live/resume equivalence tests for each lifecycle sequence.
- A deliberately false assistant sentence never changes the authoritative receipt.
- E3 replay of the original read-before-edit recovery ends `recovered` with the successful edit and
  test visible.

#### Score leverage

All workflow trust and final-result confidence; debugging/refactor recovery.

### R4 · P1 — keep mutation evidence reviewable within bounded limits

Findings: **DF-009**.

Candidate status: merged through [PR #61](https://github.com/keel-harness/keel/pull/61) as
`01de241`; exact common edges are factored before bounded middle LCS, with every accepted ADR-0078
limit and the explicit no-resume-persistence boundary unchanged. Exact post-merge `main` CI run
`30786694570` passed.

#### User outcome

The user can review what changed after a successful edit even when the first observation exceeds a
presentation budget or the session resumes. The UI shows a bounded summary, affected paths,
truncation reason, recovery truth, and a supported way to inspect durable diff evidence. It never
claims rollback or full preimage ownership that Keel does not possess.

#### Small slices

1. Exercise the existing mutation presentation producer/capability/resolver path at its exact
   limits and fix any presentation-only loss before proposing a new contract.
2. Preserve a bounded durable reference or controller-owned capability already allowed by the
   accepted design; render a compact fallback when detailed evidence is unavailable.
3. Make live/resumed mutation states equivalent: `available`, `truncated with artifact`,
   `unavailable with reason`, and `effect indeterminate` are distinct.
4. Add diff-focused navigation only after the evidence remains trustworthy.

#### Likely surfaces

Kernel and Warden mutation-presentation helpers, TUI view-model/tool cards, typed-edit tests, and
resume tests. Any frozen schema, audit format, or new retained preimage design is a stop-and-ask.

#### Acceptance evidence

- Boundary tests just below, at, and above every presentation limit.
- Multi-file edits and interrupted edits retain honest path/effect state.
- E3/E4 replay makes the external Click edits inspectable without exposing private paths or
  claiming automatic undo.

#### Score leverage

Feature/refactor/interrupt trust, hierarchy, recovery, and final confidence.

### R5 · P1 — expose the Warden's useful reason and containment

Findings: **DF-012, DF-014**.

Candidate status: public parent [issue #64](https://github.com/keel-harness/keel/issues/64) splits
the work at the authority boundary. R5a merged through PR #65: tagged terminal denials surface exact
safe guidance with redaction, bounded rendering, live/resume parity, and a forged-text negative path.
R5b is locally validated for DF-012: only an exact Warden response derived from verified sandbox
facts can produce the two-fact containment line; no command, stdout, or presentation inference is
permitted.

#### User outcome

- Denials show `what · why · exact safe next action` from authoritative policy guidance.
- Allowed consequential commands explain the containment facts that made them acceptable, such as
  workspace/temp-only writes and deny-all network, without dumping internal policy structures.
- Missing or model-authored rationale says unavailable; it is never inferred.
- Equivalent routine allows collapse into a count, while consequential containment remains
  inspectable.

#### Likely surfaces

Kernel Warden presentation helpers, bash/tool cards, failure line, receipt/review components, and
existing policy/audit fact adapters. No policy decision changes.

#### Acceptance evidence

- Red tests for precise read-before-edit guidance, contained install, absent rationale, redaction,
  truncation, and no-color rendering.
- E3/E4 replay recovers from the edit denial without ledger inspection and explains why the
  contained install was allowed.

#### Score leverage

Warden-heavy clarity, recovery, trust, usefulness, and interruption burden.

### R6 · P1 — reject concurrent resume before spending provider tokens

Findings: **DF-011**.

#### User outcome

If another live process owns the authoritative audit-writer lock, `--continue` fails before model
invocation with the owning-session fact Keel can safely disclose and one exact recovery action.
Keel never deletes or steals a live lock. Stale-lock handling remains Warden-owned and fail-closed.

#### Likely surfaces

Session entry/runtime startup, Warden client startup, audit writer lock acquisition/preflight, and
CLI/PTY tests.

#### Acceptance evidence

- Red integration test proves zero ModelPort calls when the writer is already active.
- Two-process test covers active owner, clean release, restart, and stale/indeterminate failure.
- E3 replay shows the conflict before the composer accepts paid work.

#### Score leverage

Onboarding/debugging responsiveness, recovery, control, cost confidence, and trust.

### R7 · P1 — protect useful runway before the turn is already lost

Findings: **DF-016, DF-018**.

#### User outcome

Before starting another model turn, Keel shows whether the remaining gross-token runway is likely
insufficient and offers a concise safe continuation path. When optional compaction is enabled, it
runs early enough to help the current turn or states why it cannot. Completed deterministic test
evidence is never converted into a failed-looking task solely because summary generation hit the
gross budget.

#### Required diagnosis before design

- Reconcile gross-token enforcement order with in-loop compactor soft/hard thresholds.
- Distinguish context-window pressure from paid gross-token budget; they are not interchangeable.
- Verify whether the failure is trigger ordering, metric mismatch, an unavailable safe boundary,
  or another cause.
- Do not make compaction default-on. ADR-0049 requires paid ablation evidence for that change.

#### Small slices

1. Deterministic near-budget warning and fresh-session handoff from existing controller facts.
2. Ordering fix only if a red test proves enabled compaction misses an existing safe boundary.
3. Receipt logic that preserves completed verification while honestly reporting missing summary or
   remaining work.
4. Separately run the ADR-required paid ablation before proposing a default change.

#### Acceptance evidence

- Boundary tests around soft/hard context triggers and gross-token limits.
- No extra provider call after the controller knows the turn cannot fit.
- E5 replay at a deliberately small safe budget demonstrates warning, continuity, and accurate
  cost accounting.

#### Score leverage

Long-task responsiveness, progress, control, recovery, trust, and cost efficiency.

### R8 · P1 — keep the active objective above evidence noise

Findings: **DF-004**. Pair with, but do not expand into, the P2 evidence-density work in DF-005.

#### User outcome

At 100×30 and 80×24, an active task always shows a sanitized current objective, current phase or
plan item, current action/wait state, and the most useful next control. Historical reads and routine
tool evidence yield row budget first.

#### Likely surfaces

TUI view-model row prioritization, current-turn/task ledger, headless renderer, Ink layout, and
resize/scroll tests.

#### Acceptance evidence

- Golden 100×30 and 80×24 frames during long tool output retain the objective and truthful status.
- Full evidence remains reachable; suppression is presentation-only and counted.
- Typing, scrolling, review focus, and interrupts remain responsive.

#### Score leverage

Onboarding/feature/debugging hierarchy, load, progress visibility, and trust.

### R9 · P1 — restore useful input history on resume

Findings: **DF-003**.

#### User outcome

After `--continue`, Up/Down and reverse search include prior persisted user prompts in stable order,
subject to the same redaction and bounded-history rules as live input. Queued urgent controls are
not replayed as ordinary prompts, and secrets/private data excluded from history remain excluded.

#### Likely surfaces

`packages/kernel/src/tui/input.ts`, InputBar initialization, `session-entry.ts`, session replay,
and input/repl/interactive tests.

#### Acceptance evidence

- Red tests for prior prompts, duplicates, blank input, draft preservation, redacted/excluded
  entries, queued controls, and new-session control.
- E3 exit/resume replay retrieves and edits the last real task with one Up press.

#### Score leverage

Onboarding/recovery responsiveness, continuity, control, and cognitive load.

### R10 · P1 — make urgent steering semantics match the label

Findings: **DF-017**.

#### Corrected diagnosis

The existing contract says `/now` applies before the next mutating action; `Esc`/`Ctrl-C` is the
immediate interrupt. The observed wait can therefore be contract-correct while still being
surprising. Do not silently redefine `/now` as an immediate cancellation.

#### User outcome

- The acknowledgement says exactly when the correction will take effect: `queued urgently — before
  the next change`; it also says `Esc interrupts now` when immediate cancellation is available.
- A persistent badge shows urgent input pending/applied.
- No mutation begins after the safe-boundary event and before the urgent instruction is injected.
- If no mutation occurs and the turn ends or exhausts its budget, the UI says the correction was
  still pending and carries it across resume.

#### Likely surfaces

TUI runner steering queue, current-turn status, urgent control parser, resume reconstruction, and
runner-steering/real-PTY tests.

#### Acceptance evidence

- Deterministic tests for inference → urgent queue → pre-mutation injection, tool-in-flight,
  no-further-mutation, budget stop, interrupt, and resume.
- E3 replay confirms prompt typing remains live and the status transition is visible.

#### Score leverage

Interrupt/debugging control, responsiveness, trust, and progress visibility.

## P0/P1 completeness matrix

| Finding | Severity | Remediation rank | Primary acceptance proof |
| --- | --- | --- | --- |
| DF-003 resume history | P1 | R9 | E3 one-key prompt recovery after resume |
| DF-004 objective lost | P1 | R8 | 100×30 and 80×24 active-task goldens |
| DF-006 false final claim | P1 | R3 | controller receipt cannot inherit unsupported prose |
| DF-008 review dead end | P0 | R1 | pending vs terminal actionability E3/E4 matrix |
| DF-009 mutation evidence loss | P1 | R4 | bounded live/resume diff evidence |
| DF-010 false success card | P1 | R2 | nonzero live/resume card renders failed |
| DF-011 late audit-lock failure | P1 | R6 | zero provider calls before conflict failure |
| DF-012 hidden containment | P1 | R5 | contained install explains safe boundary |
| DF-014 hidden denial guidance | P1 | R5 | exact safe recovery visible in TUI |
| DF-015 obsolete denial | P1 | R3 | recovered latest-state receipt |
| DF-016 no token runway | P1 | R7 | pre-turn warning and safe continuation |
| DF-017 `/now` surprise | P1 | R10 | pre-mutation contract and precise microcopy |
| DF-018 late compaction | P1 | R7 | enabled compaction ordering boundary test |
| DF-019 invented timing | P1 | R3 | ledger-derived compaction receipt |

## Stack-ranked harness-wide improvement backlog

These begin only after the P0/P1 path is green, except where a tiny supporting change is required
by an earlier slice. Directly observed items remain ahead of hypotheses.

### R11 · P2 — atomic command recovery and one bounded self-correction

Findings: **DF-013, DF-020**. Make controller guidance easy for the model and human to apply without
turning the Warden into a shell rewriter. Present a copyable atomic alternative when the Warden
already knows it, allow one bounded retry, and stop with exact remaining work if it still fails.
Test composite-command review, quoted selectors, no-test matches, retry loops, and truly blocked
commands. Do not normalize away shell semantics or auto-run a materially different command.

Status: closed through PR #83 and the PR #85 release-observer repair. Exact post-main CI run
`30856149564` passed at `939b8c4`; the evidence-bound aggregate is officially **3.82/5**. The strict
release gate remains open until the final same-commit six-workflow replay satisfies every floor.

### R12 · P2 — calm evidence density and progressive disclosure

Finding: **DF-005**. Collapse repeated trusted reads and equivalent routine allows into semantic
groups; preserve failure, review, mutation, and verification evidence. Add `/tool`, `/log`, or the
smallest existing detail affordance rather than inventing a panel suite. Validate row budgets,
scrolling, raw-artifact reachability, no-color meaning, and objective persistence.

Status: closed under [issue #91](https://github.com/keel-harness/keel/issues/91) and
[PR #92](https://github.com/keel-harness/keel/pull/92). The smallest existing `/verbose`
affordance preserves every exact successful observation; normal/calm mode groups only repeated
successful exact `read` and `search` entries, while quiet continues to omit them. Counts precede at
most two source-ordered unique examples and every group is bounded to 120 display cells. Failures,
reviews, blocked/limited/partial results, mutations, and nonroutine tools remain exact. Focused
**411/411**, full TUI **1,357/1,357**, unrestricted coverage, typecheck, format, build, package, and
diff checks pass. The exact installed npm carrier passes the same thirteen-request onboarding
fixture at 80×24 and 100×30, reducing twelve rows to two with clean exit and composer recovery.
Candidate `ea79cf5` and merge `2ca060e` share tree `8261e69`; exact reviewed-head CI `30863536934`
and post-main CI `30863981683` passed. Cleanup passed and the evidence-bound aggregate is officially
**3.87/5** (240/62); the final release gate remains open.

### R13 · P2 — credential-recovery truth

Finding: **DF-007**. Prefer the smallest honest fix: after `auth set`, say whether the current
process reloaded credentials; if not, provide one exact restart/resume command before another paid
401. Hot reload is a separate design only if it can preserve secret handling and provider-client
ownership cleanly. Never expose or partially display the key.

Status: closed under [issue #94](https://github.com/keel-harness/keel/issues/94) and
[PR #95](https://github.com/keel-harness/keel/pull/95). Implementation commit `19a482a` adds exact
successful-set copy and matching getting-started/reference guidance without changing secret-store
semantics or provider ownership. Red-first auth coverage, adjacent CLI/secrets coverage,
unrestricted coverage, static/build gates, and exact installed-carrier 80x24/100x30 E3/E4 pass
with zero provider calls. Candidate and merge `1bbe977` share tree `ee7837f`; exact reviewed-head CI
`30866891254` and post-main CI `30867327223` passed. Cleanup passed and the evidence-bound aggregate
is officially **3.89/5** (241/62); the final release gate remains open.

### R14 · P2 — explicit interrupted-mutation state

Finding: **DF-021**. Preserve the successful `Esc` and `/before-next-edit` controls, but replace
ambiguous `execution status is unknown` with controller-derived `not started`, `in flight`,
`completed`, or `indeterminate` when those facts exist. Link to bounded mutation evidence and
honest recovery. Do not infer file state from the model's last sentence.

Status: closed under [issue #87](https://github.com/keel-harness/keel/issues/87) and
[PR #88](https://github.com/keel-harness/keel/pull/88). Exact runner occurrence state supplies `not
started`, `in flight`, or `completed without a recorded result`; direct/factless reducer settlement
remains `indeterminate`. Focused **576/576**, unrestricted coverage **6,539/20**,
static/build/package gates, installed-carrier urgent-control smoke, fixed 80x24/100x30 E3, and
sanitized E4 pass with zero paid calls. Candidate `03a6ad2` and merge `198f56f` share tree
`5d77488`; exact reviewed-head CI `30859417733` and post-main CI `30859848006` passed. Cleanup
passed and the evidence-bound aggregate is officially **3.85/5** (239/62); the final release gate
remains open.

### R15 · high-value flagship — durable diff review

Directly motivated by DF-009/DF-021 and the governing design contract. Once mutation evidence is
reliable, make `/diff` the fastest path to path summary, hunks, truncation/artifact state,
verification relation, and deliberate recovery guidance. Add keyboard navigation, narrow-terminal
fallback, and large-diff performance limits. Syntax color is secondary to structure and no-color
meaning.

Status: closed under [issue #97](https://github.com/keel-harness/keel/issues/97) and
[PR #98](https://github.com/keel-harness/keel/pull/98). The
pre-existing `/diff review` viewer already shipped the available-comparison navigation and bounded
layout skeleton. R15 retains successful edit/write observations whose producer presentation has no
review rows, makes explicit non-available settlement outrank contradictory activity diff bytes,
binds verification/recovery only to the selected latest-turn comparison, and opens an honest
all-unavailable focused state. Focused **57/57**, adjacent **382/382**, full TUI **1,368/1,368**,
unrestricted coverage **6,557 / 20 existing opt-in skips**, static/build/package gates, exact
installed-carrier 80x24/100x30 E3, sanitized E4, and five-lens QC pass. Reviewed head `686bd1d`
passed exact-head CI `30872462126`; squash-merge `76a45c3` has the same tree `93c19c1`; exact
post-main CI `30873064247`, issue closure, and feature cleanup passed. The evidence-bound aggregate
is officially **3.90/5** (242/62); the strict release gate remains open.

### R16 · high-value control — grantable-review queue and bounded batching

The live approval machinery exists; validate its human ergonomics with several genuinely grantable
equivalent actions. Show queue count, exact reusable scope, once/session/deny/why, submitted state,
and resolution. Batch only equivalent non-urgent reviews whose controller-provided scope proves the
same risk. Never group by text similarity or model intent.

Status: closed under [issue #100](https://github.com/keel-harness/keel/issues/100) and
[PR #101](https://github.com/keel-harness/keel/pull/101). Production evidence proves one active
review at a time, so the retained slice validates the existing exact session-scope grant as the
bounded equivalent-action mechanism instead of adding a fictional concurrent queue. The completed
Ink transcript now emits one controller-owned automatic receipt for the exact reuse; an unlike
domain still receives a fresh review and denial remains non-executing. Full TUI, unrestricted full
tests/coverage, static/build/package/supply-chain gates, exact installed 80x24/100x30 positive and
negative replays, sanitized E4, and five-lens QC pass with zero Anthropic calls. Exact reviewed-head
CI run `30877328734`, identical candidate/merge tree `0a916c1`, post-main CI run `30877686690`,
issue closure, and feature cleanup passed. The plan-defined score is officially **4.01/5**; the
strict same-commit final gate remains open.

### R17 · high-value progress — useful waiting and latency budgets

Measure startup, first visible response, provider wait, Warden decision, tool start, last meaningful
output, and input latency. Show elapsed time and last meaningful output for quiet long-running
tools. Define budgets from measurements before optimizing. Never display a fake percentage for
unbounded inference or tests.

Validation outcome under [issue #103](https://github.com/keel-harness/keel/issues/103): the exact
installed carrier passes without a product change. Twenty governed launch samples measured first-
paint p95 **40.666 ms**, governed-ready p95 **592.349 ms**, and idle-input p95 **7.102 ms**. Five
100x30 provider/Warden/Click samples measured active-input p95 **34.923 ms**, first controller
response p95 **10.754 ms**, visible request-to-execution p95 **16.333 ms**, and liveness reveal p95
**2,002.541 ms**. Every accepted long-tool frame showed coarse `2s` elapsed, explicit quiet truth,
timeout, and next event with no fabricated percentage. Initial observational budgets and rejected
sample boundaries are in `session-logs/20-r17-waiting-latency.md`; R23 owns cross-host confidence
and any future hard gate. The exact pytest count missing from the final card is DF-024 and belongs to
R18. R17 changes no score or runtime behavior.

### R18 · high-value completion — concise changed/verified/risk/next receipt

Build on R3 rather than creating a second summary system. The terminal completion state should make
changed files, tests and outcomes, denied/recovered actions, unresolved risks, cost, and next safe
action scannable in one screen, with full evidence on demand. A failed or partial test must remain
prominent even if the assistant says the task is done.

Candidate outcome under [issue #105](https://github.com/keel-harness/keel/issues/105): the directly
observed DF-024 test-outcome gap is fixed without a new summary authority. A strict, presentation-
only quiet-pytest recognizer consumes complete parsed Warden envelopes and lets the existing `ran`
receipt show exact counts. Failed/error counts, nonzero exits, signals, typed partial/limited/failed
outcomes, warnings, containment, and unknown output remain conservative. Focused **637/637**, full
coverage **6,584/20**, static/build/package/supply-chain gates, exact installed 80x24/100x30
before/after replays, sanitized E4, and five-lens QC pass. The broader changed/risk/next completion
aspiration stays bounded to existing R3/R14/R15 facts rather than expanding this slice. Publication
closed through PR #106 with exact-head CI `30883098433`, byte-identical candidate/merge tree
`a52f7a1`, post-main CI `30883516900`, issue closure, and feature cleanup. The official six-workflow
score stays 4.01 until its canonical same-commit replay.

### R19 · usability validation — composer, multiline, history, focus, and scrolling

Input remained usable in the observed run, but the full matrix was not covered. Validate draft
preservation while tools update, multiline editing, paste, command history, reverse search, focus
handoff to approvals/diffs, mouse independence, scroll anchoring, and resize. Treat dropped input or
focus ambiguity as P1 when reproduced.

Validation outcome under [issue #108](https://github.com/keel-harness/keel/issues/108): the clean
exact installed main carrier passes **10/10** selected real-PTY scenarios across 80x24 and 100x30.
Multiline paste, `Ctrl+J`, bounded paste, history draft/cursor restoration, reverse search, readline
editing, native terminal scrollback, bidirectional live resize, active-panel focus, live Warden
review focus, diff focus, keyboard closure, and exact draft restoration all pass. Review/editor/
paste/history/search keystrokes remain inert outside their owning surface; denied and interrupted
actions do not execute; every process group is reaped. Existing focused coverage passes **492/492**.
Actual mouse text selection remains **NOT_RUN**. No product defect was reproduced, so R19 makes no
runtime, score, contract, policy, or dependency change. Evidence is in
`session-logs/22-r19-input-usability.md` and screenshots 50-51.

Publication closed through PR #109 with exact-head CI `30887406100`, byte-identical candidate/merge
tree `dbb8508`, exact post-main CI `30887857950`, issue closure, and complete feature cleanup.

### R20 · accessibility and responsive terminal matrix

Hypothesis, not directly observed. Test 80×24, 100×30, 120×40, dark, light, no-color, high contrast,
common TERM capabilities, Kitty, Terminal.app, and at least one Linux terminal. State must never
depend on color, animation, Unicode width quirks, or mouse input. Fix semantic ambiguity before
brand polish.

### R21 · onboarding and first-task orientation

The observed onboarding was functional but noisy. After R8/R12, make first run answer: repository,
protection posture, current objective, plan, build/test commands found, and what Keel will do next.
Avoid a tutorial wall. Test unfamiliar repository, missing tests, untrusted workspace, auth failure,
and resume.

### R22 · operator diagnostics and safe recovery commands

Consolidate recurring actionable failures into one short `what · why · exact command` pattern.
Candidates include active writer, expired credentials, unavailable mutation evidence, provider
failure, missing toolchain, token runway, and Warden unavailable. Prefer one copyable fix over a
documentation wall. Do not add a catch-all `doctor` until repeated evidence justifies it.

### R23 · performance and resource confidence

Hypothesis until measured in this dogfood branch. Establish terminal input/render latency, retained
row count, long-output memory, startup time, and provider/tool overhead budgets on packaged code.
Profile before optimizing; do not claim responsiveness from subjective feel alone.

### R24 · human cohort and longitudinal dogfood

Run the fixed workflows with advanced developers who did not implement the fixes. Record success,
hesitations, erroneous interpretations, interventions, Warden decisions, task time, provider spend,
and score. Repeat on a Python CLI and a TypeScript tool so the score does not overfit Click.

## Target score trajectory

These are target floors for validation, not promises that a listed rank will automatically produce
the score.

| Workflow | Observed baseline | 3.8 release target | 4.0 stretch target | Main ranks |
| --- | ---: | ---: | ---: | --- |
| Repository onboarding | 2.9 | 3.8 | 4.0 | R6, R8, R9, R12, R21 |
| Small feature | 2.5 | 3.8 | 4.0 | R1–R5, R8, R11, R15 |
| Debugging | 2.7 | 3.8 | 4.0 | R2, R3, R5, R7, R10, R11 |
| Refactor with risk | 2.9 | 3.8 | 4.0 | R3, R4, R5, R15, R16, R18 |
| User interruption | 4.0 | 4.1 | 4.3 | R4, R10, R14, R19 |
| Warden-heavy | 1.9 | 3.5 minimum; aim 3.8 | 4.0 | R1, R3–R6, R11, R16 |
| **Overall** | **about 2.8** | **at least 3.8** | **at least 4.0** | all gate-critical ranks |

## Execution sequence and checkpoints

### Wave 1 — never lies, no dead ends

Execute: **R0 → R1 → R2 → R3 → R4 → R5**.

Exit conditions:

- No actionable/terminal review ambiguity.
- No false-success tool state.
- Latest controller outcome reconciles correctly in live/resume receipts.
- Successful mutations retain bounded review evidence or a precise honest fallback.
- Denials and consequential allows explain the useful controller-owned reason.
- Re-run feature, debugging, refactor, and Warden-heavy scenarios; no workflow may regress.

### Wave 2 — continuity and control

Execute: **R6 → R7 → R8 → R9 → R10 → R11 → R14**.

Exit conditions:

- No paid work begins behind an active writer conflict.
- Long tasks warn or compact at a useful boundary without overstating success.
- Objective, steering state, input history, and interrupted effect state survive long tasks/resume.
- Re-run onboarding, debugging, interruption, and long refactor scenarios.

### Wave 3 — calm, inspectable daily-driver experience

Execute evidence-supported parts of **R12 → R13 → R15 → R16 → R17 → R18 → R19 → R21 → R22**.
Run R20/R23/R24 as validation programs and convert reproduced gaps into their own issues.

Exit conditions:

- The 3.8 gate passes at one exact commit.
- At least one real grantable-review sequence and one bounded batching sequence are human-tested.
- Diff, completion, waiting, composer, narrow-screen, and no-color paths are proven.
- Only then assess the 4.0 stretch gate.

## Per-slice implementation protocol

Every behavior slice follows the repository charter:

1. Create or update a scoped public child issue under #52 with finding, non-goals, affected
   interfaces, red tests, security boundary, definition of done, and stop-and-ask triggers.
2. Reproduce the original failure at the exact baseline/candidate and save sanitized evidence.
3. Write the smallest failing test first. Security-related slices include positive, negative, and
   adversarial paths.
4. Pass the simplicity gate: prefer a presentation/reconciliation fix using existing authority over
   a new protocol, dependency, or broad architecture.
5. Implement one vertical behavior change; do not mix visual cleanup or unrelated refactors.
6. Run targeted tests, then lint/typecheck/format and the broadest relevant tests. Read and record
   the actual output; missing commands remain `NOT_RUN`.
7. Run five independent review lenses: spec compliance, security/adversarial, reliability/edges,
   DX/usability, and simplicity/maintainability.
8. Re-run the same E3/E4 scenario at the same terminal size. Compare before/after scores and note
   regressions in keyboard input, rendering, scrolling, resize, review, resume, and interrupt.
9. Keep the change only if the material workflow improves and enforcement is unchanged or stronger.
10. Commit the coherent slice separately and update test log, scorecard, Warden audit, changes,
    screenshots, and cost.

Suggested first commits, subject to red tests and issue approval:

- `fix(tui): distinguish terminal review outcomes`
- `fix(tui): render nonzero bash results as failed`
- `fix(tui): reconcile recovered tool outcomes in receipts`
- `fix(tui): preserve bounded mutation review evidence`
- `fix(tui): surface actionable warden rationale`

## Stop-and-ask boundaries

Stop before implementation if a slice would:

- change a frozen RPC, audit, event, session, mutation-presentation, policy, or CLI contract;
- make an ungrantable review grantable, change policy classification, or reinterpret an enforcement
  verdict;
- weaken sandbox, egress, provenance, audit, redaction, trust, or secret boundaries;
- persist a full preimage, claim automatic undo, or add a new recovery authority;
- make compaction default-on without ADR-0049's paid ablation evidence;
- add a dependency, alter a public security claim, weaken a test/gate, or span a large cross-package
  change that can be split;
- require provider credentials in logs, fixtures, screenshots, or model-visible evidence.

When one triggers, record the decision needed, affected contract/claim, options, safest default,
and consequence of waiting. Do not improvise around it.

## Reporting and score integrity

After every retained slice, append:

- exact candidate commit and dirty-state note;
- directly observed before/after behavior;
- tests added and exact commands/results;
- E2/E3/E4/E5 status, with `NOT_RUN` where applicable;
- workflow/axis score change and its evidence;
- Warden interrupts: total, necessary, excessive, grantable, ungrantable, batched, recovered;
- provider calls, input/output tokens, cost, and remaining reserve;
- security claims affected (`none` is explicit), ADR need, and deferred follow-ups.

No average may hide its underlying workflow rows. No model-generated summary is accepted as proof of
tests, policy, mutation, compaction, interruption, or cost. At the final gate, a fresh reviewer must
be able to reconstruct every score from the artifact set.

## Definition of done

This remediation program is complete only when:

- the 3.8 release gate passes at an exact clean commit;
- every P0/P1 above is resolved, explicitly downgraded with evidence, or escalated as an accepted
  risk by a human owner;
- all six realistic workflows have before/after evidence and no hidden green;
- every retained behavior change has red-first regression coverage and a same-scenario live replay;
- security enforcement, frozen contracts, audit authority, redaction, and recovery honesty are
  unchanged or stronger;
- the final Warden audit distinguishes necessary, excessive, ungrantable, grantable, batched, and
  self-corrected interruptions;
- broad local gates and proportionate real-sandbox tests pass at the exact candidate;
- at least USD 2 remained reserved until final regression, and total Anthropic spend stayed below
  USD 20;
- coherent validated improvements are committed separately, and unresolved hypotheses remain
  labeled as hypotheses rather than shipped claims.

The 4.0 stretch gate is a second milestone. It should be pursued only after the 3.8 candidate is
truthful, recoverable, and stable; polish cannot compensate for dead ends or false state.
