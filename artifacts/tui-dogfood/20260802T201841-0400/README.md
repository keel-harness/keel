# Keel TUI dogfood — 2026-08-02

Status: in progress.

Public implementation plan: [keel-harness/keel#52](https://github.com/keel-harness/keel/issues/52).

Stack-ranked remediation program:
[ux-remediation-plan.md](./ux-remediation-plan.md). It makes the observed P0/P1 findings the first
implementation queue, defines an evidence-bound 3.8/5 release gate, and keeps 4.0/5 as a separate
stretch gate.

This evidence set records a live-provider dogfood loop against an isolated checkout of
`pallets/click`. The Keel source baseline is `a14133831f3a249a8e941c38c302f9effd61ce82`
(`v0.1.1`); live `origin/main` matched and exact-head CI run `30772162659` passed before
the branch was created.

Evidence classes are kept separate:

- E2: automated tests and headless rendering.
- E3: real PTY/product-path interaction.
- E4: fixed-size visual captures or exact-frame transcriptions, with provenance stated per slice.
- E5: live Anthropic provider calls with ledger-derived usage.

Secrets are never written to these artifacts. Captures must show neither provider
credentials nor user-home paths.

## Boundaries

- Remote work is limited to reviewable branches and pull requests; no PR merge, package publication,
  deployment, or production change is performed without the repository's independent review gates.
- External workload changes stay in a disposable local checkout.
- Keel behavior changes require red-first tests and the repo's public epic-plan gate.
- At least USD 2.00 remains reserved for final live regression testing.

## Current gate

All six requested workflow classes have live evidence. Evidence PR #53; implementation PRs #55,
#57, #59, #61, #65, #66, #68, #71, #73, and #75; repeatability PR #63; R6 evidence correction PR
#69; R10 PR #80 and closeout PR #81; R11 PR #83; PTY observer repair PR #85; and dependency-
remediation PR #78 were owner-approved, squash-merged, and cleaned up. Each UX
slice passed reviewed-head CI. R9's first post-merge run exposed a high `brace-expansion` advisory;
PR #78 repaired it. Exact current-main CI run `30856149564` passes at `939b8c4` after the later
validated slices and PTY observer repair.

R3's safe first slice is tracked by [issue #58](https://github.com/keel-harness/keel/issues/58):
exact edit/write retries reconcile without hiding history, live and resumed receipts show
`recovered`, and malformed or ambiguous histories fail safe. Generic equivalent-bash recovery and
compaction timing remain unavailable from the existing controller facts and were not manufactured.

R4 is merged through [PR #61](https://github.com/keel-harness/keel/pull/61). Its reviewed head and
squash-merge commit have the same tree; exact PR-head CI run `30786255628` and post-merge `main` CI
run `30786694570` passed. The merged branch and worktree were removed.

R0 is merged through [PR #63](https://github.com/keel-harness/keel/pull/63) as `05452ec`. The private
eval harness parses `scenario-manifest.json` for exactly six workflows and compares normalized
controller facts with rendered claims without making policy decisions. Its credential-unset 100x30
PTY replay reproduced all eleven score axes, nineteen then-current safe screenshot checkpoint names,
and one intentional bash contradiction with zero provider calls. This is repeatability
infrastructure; it does not raise the current UX score.

R5 was tracked by [issue #64](https://github.com/keel-harness/keel/issues/64) and intentionally split
at the authority boundary. R5a merged through [PR #65](https://github.com/keel-harness/keel/pull/65):
an authenticated terminal Warden denial now exposes its exact safe recovery guidance, or explicitly
says guidance is unavailable, without changing the verdict, model-visible envelope, policy, audit,
or frozen contracts. R5b merged through [PR #66](https://github.com/keel-harness/keel/pull/66). It exposes the exact two-fact
containment rationale only when the Warden has verified sandbox-limited workspace/temp writes and
deny-all network egress. Exact reviewed-head and post-merge CI passed, and the branch/worktree were
removed.

R6 is merged through implementation [PR #68](https://github.com/keel-harness/keel/pull/68) and
evidence correction [PR #69](https://github.com/keel-harness/keel/pull/69). It acquires the existing
Warden audit writer before prompt/model work, so a concurrent resume fails with zero provider
requests, unchanged lock/ledger state, and an exact recovery command. Exact post-main CI run
`30801280763` passed; branches/worktrees were removed.

R7 merged through [PR #71](https://github.com/keel-harness/keel/pull/71) as `5e6999c`. Reviewed-head
CI run `30828066275` and post-merge `main` run `30828529420` passed; its branch/worktree were removed.
The bounded live read/continuation cost USD 0.0168 and preserved the final-test reserve.

R8 merged through [PR #73](https://github.com/keel-harness/keel/pull/73) as `fff2863`. Reviewed-head
CI run `30833015213` and post-merge `main` run `30833570464` passed; the branch/worktree were removed.
It keeps one sanitized, secret-redacted, grapheme-safe `task · …` row above controller activity
during provider wait, Warden request checking, tool execution, and assistant streaming. Routine
evidence yields row priority at 80x24 and 100x30; approvals and foreground panels retain focus;
settled and one-shot output omit the task chrome.

R9 merged through [PR #75](https://github.com/keel-harness/keel/pull/75) as `baf7db4`. It restores
bounded, sanitized ordinary prompt history after `--continue` and `--resume`, without adding
controller messages or steering to recall. Up/Down and Ctrl-R reuse the existing composer; an
unsent draft and cursor remain recoverable. Red-first E2, real 80x24/100x30 before/after E3, and two
visually inspected E4 frames pass. The provider-independent slice used only a non-secret local
fixture, so E5 is intentionally **NOT_RUN** and Anthropic spend is unchanged. Reviewed-head CI run
`30836483686` passed. Current `main`, including the advisory repair above, is green, so the
evidence-bound official score is **3.65/5**.

R10 is tracked by [issue #79](https://github.com/keel-harness/keel/issues/79) and merged through
[PR #80](https://github.com/keel-harness/keel/pull/80) as `d397bfa`. The published implementation
makes `/now` promise only `queued urgently — before the next change`, keeps `Esc interrupts now`
only while immediate cancellation is available, and renders controller-owned `pending` then
`applied` state. Esc stops without auto-dispatching queued work. If a controller budget cannot
start another provider turn, urgent steering remains unapplied and durable, the exact resume
command is shown, and a fresh process re-applies the urgent correction exactly once before work.
Focused E2, unrestricted full coverage, lint, typecheck, format, build, diff checks,
production-path 80x24/100x30 E3, and four visually inspected E4 frames pass with zero Anthropic
calls. Exact reviewed-head CI run `30845070144` and post-merge `main` run `30845526192` passed;
the candidate and squash-merge trees are both `686f579`, and the branch/worktree were removed. The
evidence-bound official score is now **3.73/5**.

The manifest now tracks thirty unique safe screenshot checkpoints after adding the four R10
pending/applied/budget/resume frames.

R11 is closed under [issue #82](https://github.com/keel-harness/keel/issues/82). An
exact process-local WardenExecutor marker now offers one model-driven recovery pass only after a
blocked, not-executed terminal review with no live handle. The controller neither parses nor
rewrites the reviewed command: it accepts at most one fresh model-authored call, sends that call
through the ordinary Warden path, skips siblings, and performs one tool-disabled closeout. Failed,
nonzero, no-test, reviewed, denied, indeterminate, absent, truncated, budget, and deadline paths
remain terminal.

The production-source CLI, spawned Warden, external Click checkout, non-secret loopback provider,
and real 80x24/100x30 PTYs passed the same scenario before and after. Baseline made one request,
executed no command, ended `BLOCKED`, and exited 1. Candidate made exactly three bounded requests,
kept the original command unexecuted, ran one model-authored `python3 -m pytest --version` through
Warden, recorded `pytest 9.1.1`, ended clean `model-stop`, and exited 0. The final TUI says `done`
with an explicit controller-derived recovery receipt; the original result stays in the ledger and
verbose history. Click stayed clean and no Anthropic call was made.

Three visually inspected sanitized 1400x840 transcriptions add before, active, and after evidence:
`screenshots/33-r11-command-recovery-before.png`,
`34-r11-command-recovery-active.png`, and `35-r11-command-recovery-after.png`. The manifest now
tracks thirty-three unique safe checkpoints. The evidence-bound official score is **3.82/5**
(237/62 applicable cells). The stricter release gate remains open on per-workflow
trust/control/final-confidence requirements and the final six-workflow exact-candidate replay.

Final adversarial review found one additional must-fix before publication: transport success could
clear the blocked state even when the real Warden JSON envelope reported a nonzero exit, signal, or
indeterminate exit. Six production-shaped negative cases failed red before the correction outcome
check was made fail-closed; a real zero-exit envelope remains the positive control. The reconciled
candidate now passes focused **825/825**, artifact evidence **21/21**, unrestricted full tests and
coverage **6,528 passed / 20 existing opt-in skips**, all enforced thresholds at 98.00% statements
and 93.73% branches overall, typecheck, lint, format, build, and `git diff --check`. The exact
80x24/100x30 PTY replay was repeated after this fix and retained result SHA-256 `97e78a47…` with
eight local-fixture requests, zero paid requests, and clean Click state.

R11 implementation commit `d371b53` passed exact reviewed-head CI run `30853223179`, then
squash-merged through [PR #83](https://github.com/keel-harness/keel/pull/83) as `cb15763` with
byte-identical tree `f763182`. The feature worktree and local/remote branch were removed. Exact
post-main run `30853723890` nevertheless failed: the
macOS installed-carrier PTY observer discarded a rendered governed status row when a later cursor
redraw arrived in the same OS read. The product rendered `sbx:on` and `net:on`; success depended on
PTY chunk timing.

The release-gate flake is tracked by [issue #84](https://github.com/keel-harness/keel/issues/84).
Its deterministic red-first fix keeps monotonic startup milestones on the bounded sanitized render
history while leaving interactive current-frame semantics unchanged. A newer unavailable/off row
still overrides older governed history. The exact installed carrier now passes six consecutive
macOS 80x24 samples with governed sandbox/egress truth and clean process-group teardown. This repair
changes no product behavior or score and uses no Anthropic call. Python **2/2**, focused **23/23**,
full tests and coverage **6,529 passed / 20 existing opt-in skips**, all enforced thresholds at
98.00% lines/statements and 93.73% branches overall, typecheck, lint, format, build, and
`git diff --check` pass locally. Repair candidate `80e5ee1` passed exact-head CI run `30855665108`
and squash-merged through [PR #85](https://github.com/keel-harness/keel/pull/85) as `939b8c4` with
byte-identical tree `16336f3`. Exact post-main run `30856149564` passed, including the formerly
failing macOS installed-carrier package job `91827544534` and `ci-required` job `91829961337`.
Issue #84 closed, the branch/worktree were removed, and R11's **3.82/5** aggregate is official.

R14 is tracked by [issue #87](https://github.com/keel-harness/keel/issues/87). The local candidate
replaces the blanket missing-result `execution status is unknown` card with occurrence-indexed,
process-local controller facts: `not started`, `in flight`, or `completed without a recorded
result`. A direct reducer boundary remains conservatively `indeterminate` when the runner has no
fact. No synthetic result, model message, durable event, audit claim, frozen schema, or Warden
authority is added.

Red-first E2 covers exact occurrence identity, reused IDs, pending mutation-presentation cleanup,
NO_COLOR headless/Ink rendering, and all three urgent controls. Focused **576/576**, unrestricted
full coverage **6,539 passed / 20 existing opt-in skips**, lint, typecheck, format, build, package,
and diff checks pass. The exact installed npm carrier passed all three urgent-control scenarios,
then the same `/before-next-edit` replay at fixed 80x24 and 100x30. The governed read completed,
the edit received no durable result, `target.txt` stayed unchanged, and the UI said `not started`
plus `this tool did not execute`; the old ambiguous copy was absent. All twenty fixture requests
were loopback-only and Anthropic spend stayed USD 2.74434625.

The visually inspected sanitized 1400x840 transcription
`screenshots/36-r14-interrupted-mutation-after.png` is the thirty-fourth manifest checkpoint and
compares directly with R10 screenshot 29. It raises interruption visual hierarchy and final-result
confidence by two observed points, yielding a **3.85/5 candidate** (239/62). This score is not
official until reviewed-head and post-main CI pass; the stricter final six-workflow release gate
remains open.
