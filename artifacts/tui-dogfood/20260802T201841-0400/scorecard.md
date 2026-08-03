# UX scorecard

Scores use 1 (unusable) through 5 (excellent). `TBD` means the workflow has not yet run.

| Workflow | Phase | Clarity | Responsive | Progress | Control | Recovery | Hierarchy | Load | Trust | Warden value | Warden burden | Final confidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Onboarding | before | 3 | 3 | 4 | 3 | 3 | 3 | 2 | 3 | N/A | N/A | 2 |
| Feature | before | 3 | 2 | 3 | 3 | 2 | 2 | 2 | 3 | 2 | 1 | 4 |
| Feature | after R1+R2 | 4 | 2 | 3 | 3 | 3 | 4 | 3 | 4 | 3 | 2 | 4 |
| Debugging | before | 3 | 2 | 4 | 2 | 3 | 2 | 2 | 3 | 2 | 3 | 4 |
| Debugging | after R3 | 4 | 2 | 4 | 2 | 4 | 4 | 3 | 4 | 3 | 3 | 4 |
| Refactor | before | 3 | 3 | 4 | 3 | 3 | 3 | 2 | 3 | 2 | 2 | 4 |
| Interrupt | before | 4 | 4 | 4 | 5 | 4 | 4 | 3 | 4 | N/A | N/A | 4 |
| Warden-heavy | before | 2 | 2 | 2 | 1 | 2 | 2 | 2 | 2 | 2 | 1 | 3 |
| Warden-heavy | after R1 | 4 | 2 | 2 | 2 | 4 | 3 | 3 | 4 | 3 | 2 | 4 |

The evidence-weighted baseline across applicable cells was **2.77/5**. Applying the validated R1
Warden-heavy, R2 feature-workflow, and R3 debugging-recovery changes raises that aggregate to
**3.21/5**. This is a meaningful truth/recovery gain, not the 3.8 release gate: responsiveness,
progress visibility, mutation review, long-task runway, input-history resume, and command-detail
ranking remain unresolved.
