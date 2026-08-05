# R25 — accepted ADR-0088 exact-carrier wrapper stop

- Date: 2026-08-05
- Terminal: 100x30
- External repository: Click at `00e592cea702e0b2caa0dee42489fdb1c22cd845`
- Keel candidate: PR #142 signed head `5e2625f7f24d3d0b9cfc6172fcf73806464b7615`
- Exact carrier SHA-256: `e521609392dbdcf657011ec8d9f19ab743c262a5837758292dbe085cc87c047d`

## Candidate proof

The accepted ADR-0088 implementation passed its red-first focused and adversarial regressions,
325/325 focused tests, 915/915 adjacency tests, full enforced coverage with 6,717 passes and 20
intentional opt-in skips, typecheck, lint, format, build, package, supply-chain, diff, and the real
sandbox suite 18/18. Exact-head CI run `31022857084` is green. Warden, POL-003, shared schemas,
audit, sandbox, egress, frozen contracts, and tool implementations are byte-unchanged by #145.

## Live result

One fresh-home feature replay made 12 provider routes and cost USD 0.69344145. The ordinary agent's
first terminal request was:

    python3 -m pytest --version 2>&1 | head -3

Warden returned non-grantable, non-pending POL-003 and did not execute it. The bounded correction
then requested:

    python3 -m pytest tests/test_termui.py -x -q 2>&1 | tail -5

Warden returned the same terminal result and again did not execute it. The correction failed before
any ordinary typed mutation, so the accepted ADR-0088 controller correctly earned no refresh and
closed tools. Keel exited 1 with `BLOCKED_AFTER_SYNTHESIS`, opened zero actionable human reviews,
and left Click clean. The runtime and complete-file feature oracles failed.

## Decision

Replay 2 is **NOT_RUN** under the predeclared fail-first rule. Issue #149 scopes correction-local
prompt guidance that names the observed wrapper shapes without changing Warden policy, command
bytes, or recovery limits. PR #142 remains open and unmerged under a strict **NO-GO** verdict.

## Cost and secrecy

This replay reported 430,348 input tokens (43,587 fresh, 118,647 cache-write, 268,114 cache-read)
and 2,488 output tokens. Cumulative dogfood spend is USD 16.89637405; the final USD 2 reserve is
protected. No credential value was read, printed, logged, committed, or captured.
