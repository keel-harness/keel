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
