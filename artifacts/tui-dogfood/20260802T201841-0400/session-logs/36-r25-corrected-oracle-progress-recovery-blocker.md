# R25 — corrected oracle exposes later-progress recovery blocker

Date: 2026-08-05
Terminal: 100 columns × 30 rows
External baseline: Click `00e592cea702e0b2caa0dee42489fdb1c22cd845`
Exact Keel carrier: `3b21d2a250e57ac7996937293faba3666f13eca8`

## Corrected evidence contract

The owner authorized a validation-only amendment after the first #144 replay exposed contradictory
dependency wording. A red-first dogfood-manifest regression failed 1/1 before the correction. The
manifest now requires existing locked tooling only, forbids dependency installation/setup for
optional typing and formatting tools, requires direct requested checks, and requires an unavailable
optional checker to be reported `NOT_RUN` while implementation continues. The same focused test
passes 1/1; the complete dogfood evidence suite passes 22/22; the private driver self-test passes.
No Keel candidate byte changed.

An evidence-provenance review then found that the corrected feature prompt could no longer honestly
retain `source-ledger` provenance. A second focused expectation failed 1/1 with the manifest still
reporting `source-ledger`; the feature entry now reports `canonicalized`. The focused case and full
22/22 dogfood suite pass after correction. The onboarding, debugging, and refactor prompts retain
their actual source-ledger labels; interruption and Warden-heavy remain canonicalized.

## Corrected replay 1

The fresh-home/fresh-Click 100x30 replay made 31 provider routes, opened zero actionable human
reviews, and cost USD 0.85785450. Usage was 878,379 input tokens: 67,697 fresh, 91,462 cache write,
and 719,220 cache read, plus 6,401 output tokens.

The first avoidable compound availability request was:

```text
cd <CLICK_WORKSPACE> && python3 -m pytest --version 2>&1 | head -3
```

Warden correctly returned non-grantable, non-pending POL-003 review and did not execute it. The sole
#139 correction `python3 -m pytest --version` succeeded, and ordinary tools resumed. Direct mypy
and ruff checks then exited 1 because both optional modules were absent; the model correctly
continued.

The agent performed meaningful TDD progress through typed tools:

- added `pathlib` to `tests/test_termui.py`;
- added focused single-PathLike and iterable-of-PathLike tests;
- left exactly `tests/test_termui.py` modified.

It then requested the required red test as:

```text
cd <CLICK_WORKSPACE> && python3 -m pytest <two exact node ids> -v 2>&1
```

Warden again correctly returned POL-003 because the classifier recorded
`fail_closed_command_shape`; audit truth was `grantable:false`, `pending:false`, and the action was
not executed. The process-global recovery flag was already exhausted by the earlier probe, so it
did not reopen after the intervening typed mutation. Controller synthesis honestly reported the
partial state and stopped `BLOCKED_AFTER_SYNTHESIS`, exit 1.

The strict oracle failed: only one of the required three files changed; `git diff --check` passed;
the independent runtime probe and complete termui test file failed. No implementation or changelog
edit occurred. Replay 2 is **NOT_RUN** under the fail-first rule.

## Diagnosis and boundary

This is not a #144 file-discovery failure and not evidence for Warden relaxation. It is a distinct
P0 recovery-lifetime defect: one low-value terminal review consumes the only correction for the
entire user task, even after a later authoritative typed workspace mutation proves meaningful
progress. The advanced user receives an honest partial result, but autonomous feature completion
still collapses and the paid restart cost is high.

The smallest candidate design is one additional recovery credit earned only after a successful
typed workspace mutation, with a task-wide cap, unchanged one-call/Warden gating, no command
transformation, no Warden/policy change, and no reset from reads, prose, opaque bash, failed tools,
or the correction itself. This changes the normative recovery budget explicitly forbidden by
#139/#144, so an accepted ADR and separately approved public issue are required before code.

The #144 live increment is now USD 1.12499385, leaving USD 0.12500615 under its USD 1.25 cap.
Cumulative dogfood spend is USD 16.20293260. All Anthropic use is stopped pending the architectural
decision.

## Public decision slice

Issue #145 now carries the bounded implementation scope. Proposed ADR-0088 is published as docs-only
PR #146 on signed head `222cf693a8b9a533a2e677b2c40aeefa395e1e0a`. It retains the initial
correction, permits at most one additional correction after a successful post-recovery typed
`edit`/`write`, and hard-caps the task at two corrections and one refresh. Every call remains fresh,
unchanged, model-authored, and ordinarily Warden-gated; a third review is terminal.

Local full formatting and 144/144 docs-claim tests pass. Exact-head CI run `31016337581`, docs job
`92341438924`, and required aggregate `92341536526` pass. Behavior implementation, provider replay,
score change, and merge are **NOT_RUN** pending explicit maintainer acceptance of ADR-0088. The docs
slice adds USD 0 and changes no security claim, Warden/policy behavior, frozen contract, or tool
implementation.
