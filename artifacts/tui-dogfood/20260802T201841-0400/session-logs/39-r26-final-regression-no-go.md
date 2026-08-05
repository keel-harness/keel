# R26 — final-regression exact-carrier NO-GO

- Date: 2026-08-05
- Terminal: 100x30
- External repository: Click at `00e592cea702e0b2caa0dee42489fdb1c22cd845`
- Keel candidate: closed PR #142 exact head `175f3dd35e6dccc4306bce9dfaad1e6dfd05cd3c`
- Exact carrier SHA-256: `f26f630fe002215ae0977ad39cb301f41cd952b39e4ba6616039a7c6e3b0fed3`
- Provider authorization: exactly one final-regression replay, maximum USD 1.00 additional spend

## Deterministic and carrier proof

The candidate merged exact `origin/main` into the PR branch before validation. Focused controller,
context, presentation, and TUI tests passed 355/355. Full enforced coverage passed 365 files with
four intentional opt-in file skips: 6,721 tests passed and 20 intentional opt-in tests skipped;
overall coverage was 97.87% statements / 93.64% branches, and Warden coverage was 97.61% / 91.72%.

Typecheck, lint, format, build, package, supply-chain, diff check, and the correctly configured real
sandbox suite (18/18) passed. Prohibited Warden/shared/kernel-tool/kernel-Warden diffs were empty.
Exact-head CI run `31044498815`, including required aggregate `92438324768`, passed.

The clean source package reported exact head `175f3dd`, `dirty:false`. An independent scripts-
disabled install reported version 0.1.1 and the same exact source metadata. The tarball SHA-256 is
recorded above.

## One authorized live replay

The model first requested `python3 -m pytest --version 2>&1 | head -3` alongside a similarly wrapped
ruff probe. Warden correctly returned a non-grantable/non-pending POL-003 result for the first call,
executed nothing, and skipped its sibling. The fresh bounded correction then emitted the direct
wrapper-free requested pytest command. It executed successfully and ordinary typed work resumed.
This revalidates issue #149's narrow correction-local behavior.

The agent added two focused PathLike tests, observed the intended single-Path `TypeError`, and made
typed edits to `tests/test_termui.py` and `src/click/termui.py`. Later test commands imported the
installed Click package instead of local `src`. A direct `PYTHONPATH=src ...` request received a
second non-grantable/non-pending POL-003 result. The progress-earned final correction then requested
`pip install -e . -q && ...`, contrary to the task's locked-tooling/no-install instruction. Warden
kept the higher-impact request visible under POL-008 and executed it inside the governed sandbox;
bash exited 127 because `pip` was not available as a command.

The controller synthesized an honest partial result, but the public process did not exit zero. Its
run status was `BLOCKED_AFTER_SYNTHESIS` with `finalAnswer:null`. Click ended with exactly:

```text
 M src/click/termui.py
 M tests/test_termui.py
```

`CHANGES.md` was unchanged. The exact partial diff SHA-256 was
`04fdce61995bb218a5f74fcf1fefac654685825c0fff0d0bfbd2d495519c8d14`.

## Independent verification and oracle repair

- `git diff --check`: pass.
- PathLike runtime probe against local `src`: pass.
- `python3 -m pytest -o pythonpath=src -q tests/test_termui.py`: 223 passed / 23 skipped.
- Exact workspace gate: fail; two changed files instead of the required `CHANGES.md`,
  `src/click/termui.py`, and `tests/test_termui.py`.
- Public exit gate: fail; no zero exit was observed.
- Actionable human approval prompts: 0.
- Terminal diagnostics: 2 total / 0 task-necessary / 2 avoidable through direct locked-tool command
  shaping. Warden's fail-closed decisions were correct.

Post-verdict inspection found a private-oracle defect: the command helper used `.strip()`, removing
the first status column from Git porcelain. A new self-test failed before the repair. Newline-only
trimming then passed all six private workflow self-tests. The original report remains immutable;
its SHA-256 is `d35abab38a9b5205f00861627bcae2d1ce92faa4f2a7cb25226d596fefac403a`.
The oracle defect did not affect the verdict because the unchanged third file and absent successful
public exit independently failed the strict gate.

## Cost, publication, and cleanup

The replay reported 63,659 fresh input, 94,385 cache-write input, 983,708 cache-read input, and 5,847
output tokens for **USD 0.92773815**, below the authorized USD 1.00 ceiling. Cumulative dogfood spend
is **USD 18.44896075**; USD 1.55103925 remains under the USD 20 hard cap. This final regression used
the previously protected reserve; no further provider call is authorized or run.

The exact no-go evidence was published on PR #142 and issue #149. Deterministic spec, security, and
simplicity lenses pass; live reliability and DX lenses fail with an unresolved must-fix. The owner-
defined merge condition was not met, so PR #142 was closed unmerged. Post-main CI and issue closure
are **NOT_RUN**. Issue #149 remains open as the public blocker.

The closed PR branch and worktree, remote branch, and disposable fresh Click worktree were removed.
The discarded partial Click edits remain reconstructable from the retained owner-private session and
audit evidence; their exact diff and report hashes are recorded above. No security claim, Warden
authority, policy, grant, sandbox, egress, audit, frozen contract, typed tool, or command byte was
changed or weakened.
