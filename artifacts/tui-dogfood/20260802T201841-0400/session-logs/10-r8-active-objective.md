# R8 persistent active task

Date: 2026-08-03

Public plan: [issue #72](https://github.com/keel-harness/keel/issues/72)

Keel baseline: `5e6999cd836fee1a341a9c8cd2955abf7959abd2`

External workload: public `pallets/click` at local-only commit `edda51f`

Terminals: real PTYs at 80x24 and 100x30

## Red-first sequence

The initial focused red had 12 intended failures across headless, real Ink, streaming ownership, and
row-budget coverage. One row-budget fixture was corrected because it attempted an impossible first
render with already-terminal-owned history; the valid red then had 13 intended failures. No
production code changed before the valid red.

The first implementation reduced the suite to five test-precision failures: two Unicode strings did
not exceed the measured cell budget, and three old transcript tests counted the new task copy as a
second immutable prompt. The corrected fixtures force clipping, and the ownership assertions now
prove the immutable `you` row and active `task` row exactly once each. They were not weakened to
accept duplication.

Focused green passed 430/430. The first full suite then found one real integration issue: the
headless `/reviews` panel grew from 22 to 23 physical rows at 80x24 because the active-task copy
competed with a foreground panel. An explicit panel-ownership regression failed before the narrow
fix. Both headless and real Ink now suppress task chrome while a panel owns focus; the original
baseline is restored without changing panel content.

## Product replay

- E3: a credential-unset production-source CLI, spawned Warden, external Click checkout, non-secret
  local OpenAI-compatible fixture, and real 80x24/100x30 PTYs made four fixture requests. Both sizes
  showed exactly one task row during provider wait and assistant streaming, removed it after
  settlement, exited 0, and left Click clean.
- E4: `screenshots/26-r8-active-objective-after.png` is a visually inspected 1400x840 sanitized
  terminal-frame transcription of the exact 100x30 facts, not a live-window capture. SHA-256
  `28f37d0d67bddd6f0733f33c7bc4c3a8ab32c38663876dacc7305bad982cf8ba`.
- E5: a live `claude-sonnet-4-6` run at 100x30 showed the task row during provider wait, Warden read
  checking, completed-read wait, and assistant streaming. The governed read returned
  `## Version 8.5.0`; settlement removed task chrome and the external worktree remained clean.
- The durable `run_status` reported 6,999 input / 110 output tokens: 4 fresh, 3,735 cache write, and
  3,260 cache hit. Incremental cost was USD 0.01664625; cumulative spend is USD 2.74434625 with USD
  17.25565375 remaining and the USD 2 reserve intact. The credential value was not inspected,
  printed, logged, or captured.

## Verification and boundary

- Focused behavior suite: 430/430 passed.
- Final unrestricted full suite: 6,492 passed / 20 existing opt-in skips; 359 passing files and 4
  skipped files.
- The whole-repository instrumented coverage command was **non-green**: the local process was killed
  with exit 137 before Vitest emitted a summary. A bounded rerun over the two changed
  coverage-gated source files passed 250/250 tests. `conversation-block.ts` reached 98.38%
  statements/lines, 94.94% branches, and 98.76% functions; `headless.ts` reached 97.83%
  statements/lines, 93.11% branches, and 100% functions. Ink is intentionally excluded by the
  repository coverage policy and is exercised through real-Ink rendering tests.
- Repository typecheck, lint, format, build, and `git diff --check` passed before evidence updates.
- After evidence reconciliation, the combined behavior/artifact regression passed 469/469 and the
  exact candidate again passed repository typecheck, lint, format, build, and `git diff --check`.
- Five-lens review found no must-fix: the change matches issue #72 and stays kernel-local; hostile
  terminal/control/secret inputs and focus ownership are covered; narrow-width, Unicode, streaming,
  settlement, and panel collision cases recover deterministically; the before/after comparison is
  materially clearer without adding approval burden; and the implementation adds one presentation
  helper plus an optional render-width input with no dependency or authority change.
- No shared UiPort, frozen schema, Warden decision, policy, sandbox, audit, session format, public CLI
  syntax, dependency, or authority changed. R8 is kernel-local presentation behavior.
- Exact-head CI, merge, post-main CI, and cleanup remain required.
