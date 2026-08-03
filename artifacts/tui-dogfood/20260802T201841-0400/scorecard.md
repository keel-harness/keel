# UX scorecard

Scores use 1 (unusable) through 5 (excellent). `TBD` means the workflow has not yet run.

| Workflow | Phase | Clarity | Responsive | Progress | Control | Recovery | Hierarchy | Load | Trust | Warden value | Warden burden | Final confidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Onboarding | before | 3 | 3 | 4 | 3 | 3 | 3 | 2 | 3 | N/A | N/A | 2 |
| Onboarding | after R8 | 4 | 3 | 4 | 3 | 3 | 4 | 3 | 4 | N/A | N/A | 2 |
| Onboarding | R9 candidate (E2-E4) | 4 | 4 | 4 | 4 | 4 | 4 | 3 | 4 | N/A | N/A | 2 |
| Feature | before | 3 | 2 | 3 | 3 | 2 | 2 | 2 | 3 | 2 | 1 | 4 |
| Feature | after R1+R2 | 4 | 2 | 3 | 3 | 3 | 4 | 3 | 4 | 3 | 2 | 4 |
| Feature | after R1+R2+R6 | 4 | 3 | 3 | 3 | 4 | 4 | 3 | 4 | 3 | 2 | 4 |
| Feature | R7 candidate (E2-E5) | 4 | 3 | 4 | 4 | 4 | 4 | 3 | 4 | 3 | 2 | 4 |
| Feature | after R8 | 4 | 3 | 4 | 4 | 4 | 4 | 4 | 4 | 3 | 2 | 4 |
| Debugging | before | 3 | 2 | 4 | 2 | 3 | 2 | 2 | 3 | 2 | 3 | 4 |
| Debugging | after R3 | 4 | 2 | 4 | 2 | 4 | 4 | 3 | 4 | 3 | 3 | 4 |
| Debugging | after R3+R5 | 4 | 2 | 4 | 2 | 4 | 4 | 4 | 4 | 4 | 3 | 4 |
| Debugging | R7 candidate (E2-E5) | 4 | 3 | 4 | 3 | 4 | 4 | 4 | 4 | 4 | 3 | 4 |
| Refactor | before | 3 | 3 | 4 | 3 | 3 | 3 | 2 | 3 | 2 | 2 | 4 |
| Refactor | after R4 mutation review | 4 | 3 | 4 | 3 | 4 | 4 | 3 | 4 | 3 | 2 | 4 |
| Refactor | R7 candidate (E2-E5) | 4 | 3 | 4 | 4 | 4 | 4 | 4 | 4 | 3 | 2 | 4 |
| Interrupt | before | 4 | 4 | 4 | 5 | 4 | 4 | 3 | 4 | N/A | N/A | 4 |
| Warden-heavy | before | 2 | 2 | 2 | 1 | 2 | 2 | 2 | 2 | 2 | 1 | 3 |
| Warden-heavy | after R1 | 4 | 2 | 2 | 2 | 4 | 3 | 3 | 4 | 3 | 2 | 4 |
| Warden-heavy | after R1+R5 | 4 | 2 | 2 | 2 | 4 | 4 | 4 | 4 | 4 | 2 | 4 |

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
by three points, producing a local candidate score of **3.65/5** (226/62). This remains a candidate
until exact-head CI and merge proof pass; the official score remains **3.60/5**.
