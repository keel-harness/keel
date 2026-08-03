# Changes implemented

## Keel — validated R1 terminal-review presentation truth

- Signed-off commit `26bf47b fix(tui): distinguish terminal review outcomes`; review candidate
  [PR #55](https://github.com/keel-harness/keel/pull/55).
- Terminal Warden reviews without a live review handle now render as blocked rather than a pending
  human decision, live and after resume.
- Exact executor output, Warden verdict, policy, grantability, audit, RPC/schema contracts, and real
  pending approval behavior remain unchanged.
- One shared truth-copy catalog drives tool cards and conversation evidence. Terminal-only
  presentation removes the contradictory `ask for approval` clause and offers the supported atomic
  rerun path.
- Red evidence: initial 4 failures / 451 passes; E4-discovered copy regression 2 failures / 296
  passes.
- Green evidence: targeted 455 passes; full current-head 6,412 passes with 20 existing opt-in skips;
  typecheck, lint, repository format, and diff check passed.
- Product evidence: offline deterministic Warden replay against Click plus a sanitized 100×30 Kitty
  capture. Anthropic usage: zero.

## Keel — validated R2 bash command-outcome truth

- Signed-off commit `884a27a fix(tui): derive bash cards from command outcomes`; stacked review
  candidate [PR #57](https://github.com/keel-harness/keel/pull/57).
- A complete governed-bash envelope with nonzero exit or termination signal now renders failed live
  and after resume, while exit zero remains done.
- Typed control-plane outcomes retain precedence; non-bash and incomplete JSON cannot manufacture
  command status.
- Durable transport metadata, model-visible output, loop/completion behavior, Warden, policy, audit,
  and frozen interfaces are unchanged.
- Red evidence: 3 failures / 300 passes. Green evidence: focused 303; broader 709; full current-head
  6,417 passes with 20 existing opt-in skips; all static gates passed.
- Product evidence: Warden-allowed pytest command exited 5 and rendered failed in a sanitized 100×30
  Kitty capture. Anthropic usage: zero.

## Keel — validated R3 recovered mutation receipts

- Signed-off commit `a2189c7 fix(tui): reconcile recovered edit outcomes`; merged through
  [PR #59](https://github.com/keel-harness/keel/pull/59) as `990f990`. Exact post-merge `main` CI
  run `30784690703` passed and the branch/worktree were removed.
- Exact process-local operation/path identity reconciles only a terminal non-executed blocked
  `edit`/`write` with a later successful exact retry. Ordinary failed, partial, stopped, ambiguous,
  and different-target attempts remain consequential.
- Normal, quiet, headless, and resumed receipts explicitly say `recovered`; verbose/debug history
  retains the prior block. Receipt detail is capped at three lines plus exact overflow disclosure.
- Recovery identity is reconstructed from existing tool-call arguments on resume, is never rendered
  or persisted, transfers across live immutable activity clones, and is discarded when duplicate
  unresolved provider IDs make occurrence identity ambiguous.
- Assistant prose cannot create verification or compaction-timing facts. Successful bash remains
  factual `ran`; accepted ADR-0079's `verification not run` wording is unchanged.
- Red evidence: 2 lifecycle failures / 171 passes; 4 unchanged performance-test failures; one-shot
  receipt 1 failure / 134 skipped; ambiguous resume 1 failure / 173 skipped. No test was weakened.
- Green evidence: focused 590; full current-head 6,426 passed with 20 existing opt-in skips; full
  typecheck, lint, repository format, and diff check passed.
- Product evidence: real offline Warden replay against Click, external Click `227 passed, 23
  skipped`, and sanitized matching Kitty 100×30 captures
  `screenshots/18-r3-recovered-receipt-before.png` and
  `screenshots/19-r3-recovered-receipt-after.png`. Anthropic usage: zero.

## Keel — validated R4 bounded mutation review construction

- Signed-off implementation commit
  `6c2637e fix(warden): preserve bounded mutation review evidence`; review issue
  [#60](https://github.com/keel-harness/keel/issues/60), merged through
  [PR #61](https://github.com/keel-harness/keel/pull/61) as `01de241`.
- The Warden constructor now factors exact common prefix/suffix line pairs before running bounded
  Hirschberg LCS on the disjoint middle. Every edge and middle comparison still passes through the
  existing cooperative scalar accountant.
- The observed 68,669-byte, 1,634-line Click changelog edit falls from the whole-file 2.67 million
  comparison shape to bounded common-edge work, so live output retains exact 1,634 → 1,634 totals,
  five shown rows, 1,630 omitted unchanged rows, and the non-atomic/concurrent-mutation caveats.
- Repeated-line source numbering and randomized LCS cardinality remain exact. A genuinely divergent
  middle still fails closed at the unchanged 2,000,000-operation ceiling.
- Red evidence: `1 failed / 11 passed` with `ConstructionBudgetExceededError` at scalar accounting.
  Green evidence: constructor `15 passed`; all mutation-presentation Warden tests `121 passed`;
  kernel product/TUI regression `75 passed`; unrestricted full suite `6,430 passed` with 20 existing
  opt-in skips; enforced coverage passed at Warden 97.61% statements / 91.66% branches and touched
  constructor 97.81% / 91.46%.
- Full typecheck, lint, repository format, and diff check passed. External Click remained green at
  `227 passed, 23 skipped`.
- Product evidence: credential-unset offline Warden replay plus matched sanitized Kitty 100×30
  captures `screenshots/20-r4-mutation-review-before.png` and
  `screenshots/21-r4-mutation-review-after.png`. Anthropic usage: zero.
- ADR-0078's process-local/no-resume-persistence rule, every quantitative limit, RPC/audit/session/
  event schema, redaction, policy, enforcement, and security claims remain unchanged.
- Exact reviewed-head CI run `30786255628` and exact post-merge `main` CI run `30786694570` passed;
  the reviewed and merge trees are identical and the merged branch/worktree were removed.

## Keel — R0 repeatable dogfood evidence foundation

- Public child issue [#62](https://github.com/keel-harness/keel/issues/62) scopes the work to a
  private eval/docs slice with no runtime, frozen-contract, Warden, policy, or security-claim change.
- `scenario-manifest.json` freezes sanitized prompts with explicit source-ledger/canonicalized
  provenance, external Click starting commits,
  100x30 terminal, Guided posture, controller facts, intended outcomes, existing screenshot
  checkpoints, eleven score axes, and a USD 11 aggregate replay ceiling across all six workflows.
- `@keel/eval` parses the manifest and reports deterministic mismatches between already-decided
  controller facts and bash, review, mutation, verification, or interrupt rendering. It accepts no
  action arguments and emits no allow/review/deny decision.
- First real red: the focused suite failed because `dogfood-evidence.js` did not exist. A final
  honesty review added a second red proving prompt provenance was missing before distinguishing
  source-ledger text from canonical replay syntheses. Final focused green is 22 tests; the new
  comparator file reaches 100% statements/branches/functions/lines; full coverage passes at 98.02%
  statements / 93.73% branches repository-wide. Exact publication proof is recorded in
  `test-log.md` as it completes.
- A credential-unset real PTY replay at 100x30 reproduced 6 workflows, 11 score axes, 19 safe
  checkpoint basenames, the expected `bash-render-mismatch`, and 0 provider calls. No new visual
  capture was needed because R0 changes the test harness rather than the TUI.

## External workload — validated local-only feature

- Commit `941ab66 feat(termui): accept PathLike filenames in edit`.
- Changed `src/click/termui.py`, `tests/test_termui.py`, and `CHANGES.md`.
- Red evidence: single-Path test failed with `TypeError: 'PosixPath' object is not iterable` before
  implementation; iterable case passed incidentally through `subprocess.Popen`.
- Green evidence: focused `2 passed, 244 deselected`; full termui `223 passed, 23 skipped`.
- Static checks: ruff/mypy/pyright **NOT_RUN** because unavailable.

## External workload — validated local-only bug fix

- Commit `21a08e3 fix(termui): flush buffered progress on exit`.
- Changed `src/click/_termui_impl.py`, `tests/test_termui.py`, and `CHANGES.md`.
- First red: stale final progress rendered `14/20`; first green reached `20/20`.
- Adversarial red: the initial patch incorrectly marked an incomplete bar finished at `pos=7`.
- Final implementation flushes pending intervals and renders once, relying on `make_step()` to mark
  only a genuinely complete bar finished.
- Final Keel-run checks: focused `2 passed`; progress subset `39 passed, 209 deselected`; full
  termui `225 passed, 23 skipped`. Operator post-style focused rerun: `2 passed`.
- Static checks: ruff/mypy/pyright **NOT_RUN** because unavailable.

## External workload — validated local-only refactor

- Commit `edda51f refactor(termui): normalize edit filenames at boundary`.
- Changed `src/click/_termui_impl.py`, `src/click/termui.py`, and `tests/test_termui.py`.
- `Editor.edit_files` now performs inline `os.fspath` normalization immediately before subprocess
  invocation; `click.edit` retains only scalar-versus-iterable dispatch.
- Two PathLike cases were consolidated into the existing parameterized subprocess-boundary test
  after review removed 37 lines of duplicated standalone tests.
- Final Keel-run checks: editor normalization `16 passed`; PathLike `2 passed`; full termui `227
  passed, 23 skipped`. The immediately preceding implementation run also had progress `39 passed`.
- Static checks: ruff/mypy/pyright **NOT_RUN** because unavailable.
