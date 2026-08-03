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

All six requested workflow classes have live evidence. Evidence PR #53 and implementation PRs #55
and #57 were owner-approved, squash-merged, and cleaned up. Exact post-R2 `main` CI run
`30782086893` passed at `86a6c6e542dc420ae35c932803debc24f4215dad` before R3 began.

The third presentation-truth slice is tracked by
[issue #58](https://github.com/keel-harness/keel/issues/58). Its local E2/E3/E4 gates are green:
exact edit/write retries reconcile without hiding history, live and resumed receipts show
`recovered`, malformed or ambiguous histories fail safe, and the original Click workflow is clearer
at the same 100×30 terminal size. Publication, independent review, merge, and exact post-merge CI
remain pending.
