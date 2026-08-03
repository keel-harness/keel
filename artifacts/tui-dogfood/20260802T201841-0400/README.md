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
- E4: Kitty window captures at a fixed representative terminal size.
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

All six requested workflow classes have live evidence. Evidence PR #53 and implementation PRs #55,
#57, #59, and #61, plus repeatability PR #63, were owner-approved, squash-merged, and cleaned up.
R0 reviewed-head CI run `30788707053` and exact post-merge `main` CI run `30789072222` passed;
the reviewed and merge trees are identical.

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

R6 is tracked by [issue #67](https://github.com/keel-harness/keel/issues/67). Its candidate acquires
the existing Warden audit writer before prompt/model work, so a concurrent resume fails with zero
provider requests, unchanged lock/ledger state, and an exact recovery command. A real 100x30 PTY
and spawned-Warden replay passed; exact-head publication gates remain pending.
The manifest now tracks twenty-two safe screenshot checkpoints after adding the R6 after frame.
