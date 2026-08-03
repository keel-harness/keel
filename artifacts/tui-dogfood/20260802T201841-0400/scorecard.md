# UX scorecard

Scores use 1 (unusable) through 5 (excellent). `TBD` means the workflow has not yet run.

| Workflow | Phase | Clarity | Responsive | Progress | Control | Recovery | Hierarchy | Load | Trust | Warden value | Warden burden | Final confidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Onboarding | before | 3 | 3 | 4 | 3 | 3 | 3 | 2 | 3 | N/A | N/A | 2 |
| Feature | before | 3 | 2 | 3 | 3 | 2 | 2 | 2 | 3 | 2 | 1 | 4 |
| Feature | after R1+R2 | 4 | 2 | 3 | 3 | 3 | 4 | 3 | 4 | 3 | 2 | 4 |
| Debugging | before | 3 | 2 | 4 | 2 | 3 | 2 | 2 | 3 | 2 | 3 | 4 |
| Debugging | after R3 | 4 | 2 | 4 | 2 | 4 | 4 | 3 | 4 | 3 | 3 | 4 |
| Debugging | after R3+R5 | 4 | 2 | 4 | 2 | 4 | 4 | 4 | 4 | 4 | 3 | 4 |
| Refactor | before | 3 | 3 | 4 | 3 | 3 | 3 | 2 | 3 | 2 | 2 | 4 |
| Refactor | after R4 mutation review | 4 | 3 | 4 | 3 | 4 | 4 | 3 | 4 | 3 | 2 | 4 |
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
