# R25 — terminal-review recovery continuation and command-shaping blocker

Date: 2026-08-05
Terminal: 100 columns × 30 rows
External baseline: Click `00e592cea702e0b2caa0dee42489fdb1c22cd845`

## #139 implementation

Issue #139 was implemented on signed head `edc9ea59ef3cbbe48ff4b2a2ea7fce19897201f9`
and published as PR #142. The loop now returns only a sole authoritative bounded-correction success
to ordinary Warden-gated work. The monotonic recovery flag remains exhausted. Every failure,
ambiguous outcome, timeout, abort, no-call, truncation, second review, and sibling path retains the
existing terminal closeout. Presentation reconciles the immediate exact correction after later
ordinary history while preserving the explicit statement that the original reviewed action was not
executed and keeping later consequential failures visible.

The exact Click-shaped walking skeleton failed 4 cases before implementation because later ordinary
tools were absent. Same-response assistant narration then exposed and red-first fixed one
presentation-boundary defect. Final focused coverage passes 283/283; TUI adjacency passes
1,085/1,085. Unrestricted security passes 1,041/1,041. Full unrestricted coverage passes 6,689 tests
with 20 intentional opt-in skips at 97.87% statements and 93.63% branches overall. Lint, typecheck,
format, build, package, supply-chain, and diff checks pass. Warden/shared/frozen-contract files are
unchanged. Five-lens QC has no local must-fix. Security claims affected: none. ADR needed: no.

Invalid setup attempts remain explicit: missing isolated package dependency links invalidated one
typecheck/lint; outer sandbox loopback denial invalidated one security run; and package-level links
that resolved workspace packages through another checkout invalidated one coverage gate despite all
tests passing. Corrected exact reruns above are green.

Exact-head CI run `30969379058`, including required aggregate `92191180350`, passes. PR #142 is not
merged because its two required live user-outcome replays remain red.

## Outcome-oracle hardening

The private replay driver now separates process exit from scenario completion. A feature pass
requires exactly `CHANGES.md`, `src/click/termui.py`, and `tests/test_termui.py` to change, then
independently requires `git diff --check`, a direct single-and-iterable PathLike runtime probe, and
the complete `tests/test_termui.py` file. Its red self-test rejected exit zero with no mutation; the
untouched frozen Click baseline also fails because the runtime probe fails even though the existing
termui tests pass.

## Two exact-carrier live replays

The clean scripts-disabled carrier embeds `edc9ea59`, reports `dirty: false`, and has tarball SHA-256
`0e18ec03a2db4b44d0d1063f244cad01365c641376c1734c643abe513a766eae`.

- Replay A cost USD 0.74714715, opened zero human reviews, exited 1 with
  `BLOCKED_AFTER_SYNTHESIS`, and left Click clean. #139 worked: the first compound availability
  probe was reviewed, the sole pytest correction succeeded, and later atomic mypy and ruff probes
  executed. A second compound `which`/`pip show`/`grep` discovery request then reached another
  terminal review. The exhausted recovery flag correctly did not reopen.
- Replay B cost USD 0.74319465, opened zero human reviews, exited 1 with the same controller code,
  and left Click clean. After extensive source diagnosis, a compound `uv run` discovery request was
  reviewed. The model chose `uv run mypy --version` as its bounded correction; Warden correctly kept
  this dependency-capable action review-required, so the correction did not resume ordinary work.

Both runs failed the hardened mechanical and human outcome gates. Neither made the requested edits,
and neither is counted as feature completion. The two runs add USD 1.49034180, bringing cumulative
spend to USD 13.51688380. USD 4.48311620 remains usable before the protected final USD 2 reserve.

## Follow-up boundary

Public issue #143 records the repeatable ordinary-agent command-shaping defect. Its recommended
narrow slice is behavioral guidance only: keep unrelated shell intentions separate, use independent
parallel calls, and treat a missing optional checker as `NOT_RUN` rather than probing a package
manager unless dependency setup was requested. It explicitly forbids Warden relaxation, a second
recovery exception, or controller command transformation. Implementation is NOT_RUN pending owner
approval because it changes public ordinary-agent behavior.

## #143 prompt-only implementation and final replay

After owner approval, red-first prompt contracts named the exact recurring preflights and wrappers.
The first longer wording made two existing compaction folds non-shrinking; both failures reproduced
in isolation. The retained wording is 83 bytes shorter than the previous green prompt, keeps every
semantic contract, and restores all four compaction-wiring tests without touching their thresholds
or implementation.

Final head `38f21afb33423d63e2370e1ec73e0b99885f24b8` passes 27/27 prompt tests, 4/4 compaction wiring,
full coverage 6,691/6,691 with 20 opt-in skips, all static/build/package gates, and exact-head CI
`30973240684` with required aggregate `92202824574`. The clean scripts-disabled tarball SHA-256 is
`7eb2e06f15e8d51d875935c91a41b4dce3e98c3ee86f2549e9476b83f75906b9`.

The final fresh-home replay cost USD 0.36498810 and opened zero actionable reviews. It used none of
the newly named `--version`, `which`, `pip show`, `uv`, or package-manager fallback probes, but it
still ignored the prompt by issuing `find ... | head`, `grep ... | head`, and finally terminal
`find ... | xargs grep ... 2>/dev/null`. The sole atomic #139 correction executed and exited 1. The
model then described intended edits but made none; Click stayed clean and the independent oracle
failed.

This activates the prompt-only stop condition. The second final-candidate replay is NOT_RUN, PR #142
is not merged, and issue #143's definition of done is unmet. The #143 increment is USD 1.56105495;
cumulative spend is USD 15.07793875, leaving USD 2.92206125 before the protected final USD 2 reserve.
A structural continuation requires a separate approved scope.
