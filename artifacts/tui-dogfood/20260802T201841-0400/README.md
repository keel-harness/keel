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
#69; and dependency-remediation PR #78 were owner-approved, squash-merged, and cleaned up. Each UX
slice passed reviewed-head CI. R9's first post-merge run exposed a high `brace-expansion` advisory;
PR #78 repaired it, and exact current-main CI run `30839183270` passes at `ba292e6`.

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

R10 is tracked by [issue #79](https://github.com/keel-harness/keel/issues/79). The local candidate
makes `/now` promise only `queued urgently — before the next change`, keeps `Esc interrupts now`
only while immediate cancellation is available, and renders controller-owned `pending` then
`applied` state. Esc stops without auto-dispatching queued work. If a controller budget cannot
start another provider turn, urgent steering remains unapplied and durable, the exact resume
command is shown, and a fresh process re-applies the urgent correction exactly once before work.
Focused E2, unrestricted full coverage, lint, typecheck, format, build, diff checks,
production-path 80x24/100x30 E3, and four visually inspected E4 frames pass with zero Anthropic
calls. Reviewed-head CI, merge, post-main CI, and cleanup remain.

The manifest now tracks thirty unique safe screenshot checkpoints after adding the four R10
pending/applied/budget/resume frames.
