<!--
keel PR template. Keep it honest: report verification exactly as it ran (AGENTS.md →
"No hidden green"). Delete sections that genuinely do not apply, but do not delete a
section to avoid answering it.
-->

## Scope

What changed? Prefer one package or one concern. If this is a large PR, explain why it
could not be split.

## Spec reference

Which `MASTER_SPEC.md` section, public tracking issue, pull-request plan, or ADR does this
implement?

## Tests first

What failing tests were written **before** implementation (TDD is law)? Note the layer
(unit / property / integration / e2e / security).

## Verification

Commands run, with their **actual** results (not "should pass"). If a command was not
run, say so — never imply it passed. If a subset ran, say which.

- [ ] `pnpm test`
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test:cov` (coverage gate)
- [ ] package-specific tests: `pnpm --filter @keel/<pkg> <script>`

## Security impact

- [ ] No security claim affected
- [ ] Security claim affected — SEC test added/updated and the `docs/quality/claim-ledger.md` row updated
- [ ] Denied-path test included where applicable

## Interface / schema impact

- [ ] No frozen interface / schema / protocol / audit format / CLI contract touched
- [ ] Frozen interface touched — ADR + protocol-version decision linked (stop-and-ask)

## Dependencies

- [ ] No new dependency
- [ ] New dependency — license (permissive only) + supply-chain review included

## UX / DX impact

What changed for users or developers (prompts, output, errors, docs)?

## Residual risk / follow-ups

What is intentionally **not** solved here, and the named trigger to pick it up. Mirror
load-bearing items into the public tracking issue, `docs/roadmap.md`, and/or
`docs/quality/claim-ledger.md`.

## Overfit guard (Epic 1.11 benchmark-loop change-PRs only — delete this section otherwise)

For a harness change proposed by the §2.3 failure-mode loop. A change is **rejected in review** unless
all of these hold (generalization beats single-task wins — §8.2, §7 1.11b):

- [ ] **Targets a general failure mode, not a task's surface details.** No task name, fixture path, or
  magic string from a specific `keel-tb2-25` task is hard-coded or special-cased.
- [ ] **Expected to help the held-out set** (`keel-tb2-heldout`, disjoint from the tuned 25), not only
  the tuned subset. State *why it should generalize*.
- [ ] **Tagged with the failure mode + trajectory-ID evidence.** Names the `analyzeFailures` signature it
  targets and the trajectory IDs that motivated it (which resolve to stored trajectories).
- [ ] **One change per PR.** Not bundled with unrelated tuning.
- [ ] **Success was scored from the TB-2 grader's verdict / the trajectory, never `keel`'s exit code**
  (QR-7 — a `stop(error)`/`max-turns` run still exits 0).
- [ ] **No §8.2 trajectory-quality regression** (the >2-pt rule, and no degradation in tool-call/arg
  validity, error→recovery, redundant reads, or premature-completion intercepts that a passing score hides).
- [ ] **The scoreboard re-run is recorded** (per-iteration score + metrics, regressions included).
