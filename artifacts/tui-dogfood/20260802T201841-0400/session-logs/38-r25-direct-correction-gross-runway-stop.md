# R25 — #149 direct correction and gross-runway stop

- Date: 2026-08-05
- Terminal: 100x30
- External repository: Click at `00e592cea702e0b2caa0dee42489fdb1c22cd845`
- Keel candidate: PR #142 signed head `487ddf734a9074e2c747002d8f595c9721715e0f`
- Exact carrier SHA-256: `2fd3578a710629ca53106ee839d423ab41c21753d339ac5b533ac99a2f30be9b`
- Provider authorization: one fresh-home replay, maximum USD 1.00 additional spend, final USD 2
  reserve protected

## Candidate proof

#149 changed only the two existing terminal-review recovery messages and their kernel tests. Red-
first focused execution failed 5 cases before implementation. Focused green passed 5/5; controller,
context, presentation, and compaction adjacency passed 355/355. Full enforced coverage passed 365
files and 6,721 tests with 20 intentional opt-in test skips. Typecheck, lint, format, build, package,
supply-chain, diff, and real sandbox 18/18 passed. Exact-head CI run `31040649898` is green.

Warden, POL-003, policy, grants, sandbox, egress, audit, shared schemas, typed tools, frozen
contracts, exact command bytes, and public CLI behavior are unchanged. Security claims affected:
none. ADR required: no; this is the prompt-only slice explicitly scoped by issue #149.

The first installed candidate was rejected before provider use because it had been packaged before
the implementation commit and correctly reported source `9682fcf`, `dirty:true`. The rebuilt
scripts-disabled carrier reports exact `487ddf7`, `dirty:false`, and version 0.1.1.

## Live result

The model first requested:

```text
python3 -m pytest tests/test_termui.py::test_edit tests/test_termui.py::test_fast_edit -v 2>&1 | head -40
```

Warden returned a non-grantable/non-pending POL-003 review and did not execute it. The sole bounded
correction then requested:

```text
python3 -m pytest tests/test_termui.py -k "test_edit or test_fast_edit" -v
```

The correction contained no `--version`, `2>&1`, `| head`, or `| tail`, executed through the ordinary
Warden path, and passed. Ordinary agent work resumed. The model inspected Click, added genuine
PathLike red tests, observed the intended failures, and made typed edits to `src/click/termui.py`.

Keel then stopped before another provider call at the gross-runway preflight: 672,173 of 700,000
cumulative tokens used, with the next request estimated at 41,694 input tokens. The public process
exited 1. Click contained only:

```text
 M src/click/termui.py
 M tests/test_termui.py
```

The required `CHANGES.md` entry and `_termui_impl.py` behavior were absent. Diff check passed, but
the independent runtime probe and complete `tests/test_termui.py` verification failed. The strict
three-file outcome is therefore **FAIL**, not partial success.

## Cost, Warden, and verdict

The replay made 17 provider routes and reported 667,936 input tokens: 69,472 fresh, 50,243 cache-
write, and 548,221 cache-read, plus 4,237 output tokens. Estimated cost is **USD 0.62484855**.
Cumulative dogfood spend is **USD 17.52122260**; USD 2.47877740 remains below the hard cap and the
final USD 2 reserve is intact.

The run opened zero actionable human prompts. It produced one avoidable terminal diagnostic for the
wrapper-bearing pytest request; the direct correction succeeded without any Warden relaxation,
approval, or command rewrite. No credential value was printed, logged, committed, or captured.

Replay 2 is **NOT_RUN** under the one-run authorization. Issue #149's targeted wrapper behavior is
materially improved, but its strict live definition remains unmet. PR #142 stays open and unmerged
under **NO-GO**. The candidate score remains **4.04/5 candidate / 4.02 pooled** with no new credit.
