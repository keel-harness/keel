# UX scorecard

Scores use 1 (unusable) through 5 (excellent). `TBD` means the workflow has not yet run.

| Workflow | Phase | Clarity | Responsive | Progress | Control | Recovery | Hierarchy | Load | Trust | Warden value | Warden burden | Final confidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Onboarding | before | 3 | 3 | 4 | 3 | 3 | 3 | 2 | 3 | N/A | N/A | 2 |
| Onboarding | after R8 | 4 | 3 | 4 | 3 | 3 | 4 | 3 | 4 | N/A | N/A | 2 |
| Onboarding | after R9 (E2-E4) | 4 | 4 | 4 | 4 | 4 | 4 | 3 | 4 | N/A | N/A | 2 |
| Onboarding | after R12 (E2-E4) | 4 | 4 | 4 | 4 | 4 | 4 | 4 | 4 | N/A | N/A | 2 |
| Onboarding | after R13 (E2-E4) | 4 | 4 | 4 | 4 | 5 | 4 | 4 | 4 | N/A | N/A | 2 |
| Feature | before | 3 | 2 | 3 | 3 | 2 | 2 | 2 | 3 | 2 | 1 | 4 |
| Feature | after R1+R2 | 4 | 2 | 3 | 3 | 3 | 4 | 3 | 4 | 3 | 2 | 4 |
| Feature | after R1+R2+R6 | 4 | 3 | 3 | 3 | 4 | 4 | 3 | 4 | 3 | 2 | 4 |
| Feature | R7 candidate (E2-E5) | 4 | 3 | 4 | 4 | 4 | 4 | 3 | 4 | 3 | 2 | 4 |
| Feature | after R8 | 4 | 3 | 4 | 4 | 4 | 4 | 4 | 4 | 3 | 2 | 4 |
| Feature | after R11 (E2-E4) | 4 | 4 | 4 | 4 | 5 | 4 | 4 | 4 | 3 | 3 | 4 |
| Feature | R15 candidate (E2-E4) | 4 | 4 | 4 | 5 | 5 | 4 | 4 | 4 | 3 | 3 | 4 |
| Debugging | before | 3 | 2 | 4 | 2 | 3 | 2 | 2 | 3 | 2 | 3 | 4 |
| Debugging | after R3 | 4 | 2 | 4 | 2 | 4 | 4 | 3 | 4 | 3 | 3 | 4 |
| Debugging | after R3+R5 | 4 | 2 | 4 | 2 | 4 | 4 | 4 | 4 | 4 | 3 | 4 |
| Debugging | R7 candidate (E2-E5) | 4 | 3 | 4 | 3 | 4 | 4 | 4 | 4 | 4 | 3 | 4 |
| Refactor | before | 3 | 3 | 4 | 3 | 3 | 3 | 2 | 3 | 2 | 2 | 4 |
| Refactor | after R4 mutation review | 4 | 3 | 4 | 3 | 4 | 4 | 3 | 4 | 3 | 2 | 4 |
| Refactor | R7 candidate (E2-E5) | 4 | 3 | 4 | 4 | 4 | 4 | 4 | 4 | 3 | 2 | 4 |
| Interrupt | before | 4 | 4 | 4 | 5 | 4 | 4 | 3 | 4 | N/A | N/A | 4 |
| Interrupt | R10 candidate (E2-E4) | 5 | 4 | 5 | 5 | 5 | 4 | 4 | 5 | N/A | N/A | 4 |
| Interrupt | after R14 (E2-E4) | 5 | 4 | 5 | 5 | 5 | 5 | 4 | 5 | N/A | N/A | 5 |
| Warden-heavy | before | 2 | 2 | 2 | 1 | 2 | 2 | 2 | 2 | 2 | 1 | 3 |
| Warden-heavy | after R1 | 4 | 2 | 2 | 2 | 4 | 3 | 3 | 4 | 3 | 2 | 4 |
| Warden-heavy | after R1+R5 | 4 | 2 | 2 | 2 | 4 | 4 | 4 | 4 | 4 | 2 | 4 |
| Warden-heavy | after R11 (E2-E4) | 4 | 3 | 2 | 2 | 5 | 4 | 4 | 4 | 4 | 3 | 4 |
| Warden-heavy | after R16 (E2-E4) | 4 | 3 | 4 | 4 | 5 | 4 | 4 | 4 | 4 | 4 | 4 |

The evidence-weighted baseline across applicable cells was **2.77/5**. Applying the validated R1
Warden-heavy, R2 feature-workflow, R3 debugging-recovery, and R4 bounded mutation-review changes
raises that aggregate to **3.31/5**. R4 repeated the observed large-file mutation path, not the full
multi-file refactor workflow; unaffected axes retain their prior scores. This remains below the 3.8
release gate: responsiveness, progress visibility, durable/resumed mutation review, long-task
runway, input-history resume, and command-detail ranking remain unresolved.

R0 does not change a workflow score. It freezes these eleven axes and the six scenario inputs so
later score changes must compare like with like; the evidence-weighted aggregate remains **3.31/5**.

R5a materially improves the reproduced DF-014 denial-recovery checkpoint: the before frame exposed
only generic retry copy, while the same tagged denial now shows the exact controller-owned safe next
action in live and resumed output. R5b repeats the Warden-heavy package-command path through the
production Warden/SRT boundary and adds only a verified two-fact containment line while preserving
command output, warnings, nonzero failure status, audit content, and zero new interrupts. The two
materially rerun checkpoints raise debugging cognitive load/Warden usefulness and Warden-heavy
hierarchy/load/usefulness by five applicable points. Across the latest like-for-like rows, the
evidence-weighted aggregate is now **3.39/5** (210/62), still below the 3.8 release gate.

R6 repeats the observed concurrent-resume failure through the production startup and Warden
boundary. Rejecting the conflict before prompt/model work materially raises feature responsiveness
and recovery by two applicable points without changing other axes. The latest like-for-like
aggregate is **3.42/5** (212/62), still below the 3.8 release gate.

R7's production-path E2-E5 replays materially improve long-task progress visibility and control for
feature work, debugging responsiveness/control, and refactor control/cognitive load. The local
fixture and bounded live Anthropic replay both proved a successful governed read, distinct warning,
zero second provider call, stopped hierarchy, saved evidence, and working `--continue` recovery.
Those rows score **3.52/5** (218/62). R7's exact-head and post-merge gates passed, so this is now the
evidence-bound official aggregate.

R8's same-scenario 80x24/100x30 E2-E5 replay makes onboarding self-identifying during provider,
Warden, tool, and streaming states and makes routine evidence yield to that hierarchy. It raises the
directly observed onboarding clarity/hierarchy/load/trust cells and feature cognitive load by five
points. R8's exact-head and post-merge gates passed, so **3.60/5** (223/62) is now the official
evidence-bound aggregate.

R9's main-versus-candidate 80x24/100x30 E2-E4 replay makes a completed onboarding prompt directly
recallable after process restart, preserves an unsent draft through Up/Down navigation, and submits
an edited recall. It raises the directly observed onboarding responsiveness/control/recovery cells
by three points. Reviewed-head CI passed, PR #75 merged, and current-main CI is green after the
separate dependency remediation, so **3.65/5** (226/62) is now the official evidence-bound score.

R10's production-path 80x24/100x30 E2-E4 replay makes the urgent boundary exact, preserves a
controller-owned pending/applied state, stops immediately on Esc without silently starting new
model work, and carries a budget-stranded urgent correction across fresh-process resume exactly
once. This materially raises the directly observed interruption clarity, progress, recovery,
cognitive load, and trust cells by five points. Exact reviewed-head CI run `30845070144`, merge
`d397bfa`, exact-tree equivalence, post-merge `main` run `30845526192`, and cleanup all passed, so
**3.73/5** (231/62) is now the official evidence-bound score.

R11 repeats the original Click composite-command failure at 80x24 and 100x30. Baseline stops after
one terminal no-handle review and needs an operator redirect. R11 offers exactly one
model-driven Warden-gated correction, executes only the atomic call, and ends cleanly with an
explicit recovery receipt; failed and unsafe paths retain needs-attention truth. This directly
raises feature responsiveness, recovery, and Warden-interruption burden plus Warden-heavy
responsiveness, recovery, and interruption burden. The latest rows add six applicable points
overall. Candidate `d371b53` passed exact-head CI `30853223179` and merged through PR #83 as
`cb15763`; PTY observer repair `80e5ee1` passed exact-head CI `30855665108`, merged through PR #85
as `939b8c4`, and passed exact post-main CI `30856149564`. Cleanup passed. The evidence-bound
official aggregate is **3.82/5** (237/62); the unweighted mean of the six latest workflow means is
**3.84/5**. Passing the aggregate target alone does not pass the stricter release gate:
per-workflow user-control, trust, recovery, final-confidence, and the final exact-candidate
six-workflow replay remain required.

R14 repeats R10's urgent pre-edit scenario through the installed carrier at 80x24 and 100x30. The
same read completes, the edit stays without a durable result, and the file remains unchanged; the
new receipt says `not started` and `this tool did not execute` instead of making the user interpret
generic unknown state. Synthetic reducer cases prove in-flight/completed-but-unrecorded outcomes
remain indeterminate about effects and direct factless settlement stays conservative. This raises
the directly observed interruption visual-hierarchy and final-confidence cells by two points.
Candidate `03a6ad2` passed exact-head CI `30859417733`, merged through PR #88 as `198f56f` with
identical tree `5d77488`, and passed exact post-main CI `30859848006`. Cleanup passed, so the
evidence-bound aggregate is officially **3.85/5** (239/62). The strict final six-workflow gate
remains open.

R12 repeats a read/search-heavy unfamiliar-repository onboarding turn through the exact installed
npm carrier at 80x24 and 100x30. Baseline emits eight individual read rows and four individual
search rows. The candidate emits one count-preserving read group and one count-preserving search
group, with the same thirteen provider-fixture requests, final answer, clean exit, governed posture,
and returned composer. Verbose/debug retain the twelve exact rows and quiet retains the established
omission behavior. This directly raises only onboarding cognitive load by one point. Candidate
`ea79cf5` passed exact reviewed-head CI `30863536934`, merged through PR #92 as `2ca060e` with
identical tree `8261e69`, and passed exact post-main CI `30863981683`. Cleanup passed, so the
evidence-bound aggregate is officially **3.87/5** (240/62). Onboarding final-result confidence and
the strict final six-workflow gate remain open.

R13 repeats the observed successful credential-replacement command through clean exact installed
baseline and candidate carriers at 80x24 and 100x30. Baseline confirms only the durable store and
leaves the user to infer that the active process still owns the old provider client. Candidate
states that running sessions were not reloaded and gives the exact workspace-qualified
`keel --continue` recovery action. The credential never appears in output or evidence. This
directly raises only onboarding error recovery by one point. Candidate `19a482a` and merge
`1bbe977` share tree `ee7837f`; exact reviewed-head CI `30866891254` and post-main CI `30867327223`
passed, and cleanup passed. The evidence-bound aggregate is officially **3.89/5** (241/62). The
onboarding final-confidence floor and strict same-commit six-workflow gate remain open.

R15 repeats the missing-review-row mutation path through clean exact installed baseline and
candidate carriers at 80x24 and 100x30. Both perform the same successful governed typed overwrite
of a binary preimage and produce the same authoritative summary-only observation. Baseline reduces
`/diff review` to a generic no-diffs note. Candidate opens a focused state with the producer-safe
path, exact limitation, `verification not run`, fixed non-destructive recovery guidance, and an Esc
close control that returns to the preserved composer. This directly raises only feature user
control by one point. Local E2-E4 and five-lens QC pass, so the aggregate is **3.90/5**
(242/62). Reviewed head `686bd1d` passed exact-head CI `30872462126`, merged through PR #98 as
`76a45c3` with identical tree `93c19c1`, and passed exact post-main CI `30873064247`. Issue #97
closed and feature cleanup passed, so **3.90/5** is now the official evidence-bound aggregate. The
onboarding final-confidence, Warden-heavy control/progress, and strict same-commit six-workflow
gates remain open.

R16 repeats a genuinely grantable external-documentation sequence through the exact installed npm
carrier at 80x24 and 100x30. One exact `domain example.com` session approval covers the second
equivalent action without another prompt and now emits one controller-owned automatic receipt. A
later `domain example.org` action opens a fresh review and remains independently deniable. The
production controller proves one active review at a time, so no unsupported concurrent queue or
text-similarity batch surface was added. This directly raises Warden-heavy progress and control from
2 to 4 and interruption burden from 3 to 4. Local E2-E4, the exact installed-carrier matrix, and
five-lens QC pass.

The remediation plan defines the overall score as the unweighted mean of six workflow means. On
that formula R16 is officially **4.01/5**. The scorecard's historical pooled-cell diagnostic is
**3.98/5** (247/62). Both are recorded to expose the pre-existing formula mismatch rather than
silently switching the series. Reviewed head `6f4660c` passed exact-head CI `30877328734`, merged
through PR #101 as `be4fb5e` with identical tree `0a916c1`, and passed exact post-main CI
`30877686690`. Issue closure and feature cleanup passed. The strict release gate remains open:
onboarding final confidence, debugging control, the same-commit six-workflow replay, and required
final E5 evidence are not yet green.

R17 validates rather than changes the current product. Twenty exact installed-carrier launch/input
samples and five deterministic 100x30 provider/Warden/Click samples meet the measured initial
budgets for first paint, governed readiness, first controller response, active input, routine
Warden request-to-execution, and two-second liveness reveal. Every accepted long-tool frame shows
explicit elapsed/quiet/timeout/next truth and no fake percentage. Existing progress and
responsiveness scores therefore remain supported but are not raised. The plan-defined aggregate
stays **4.01/5** and the legacy pooled diagnostic stays **3.98/5** (247/62). DF-024—the exact pytest
summary missing from the final visible card—keeps onboarding final confidence and R18 open.
