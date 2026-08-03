# Chronological test log

## 2026-08-02 — orientation

- `git status --short --branch`: clean `main...origin/main`.
- Local HEAD, local `origin/main`, and live `refs/heads/main`: all `a14133831f3a249a8e941c38c302f9effd61ce82`.
- Exact-head GitHub Actions CI: run `30772162659`, success.
- `pnpm keel auth list`: Anthropic credential present in the owner-only file store; no key value displayed.
- `pnpm keel doctor`: required checks passed; one expected reduced-enforcement warning because source is workspace-writable.
- Created local branch `dogfood/tui-agent-loop` after outer-sandbox escalation was required to write `.git/refs`.
- Terminal target: Kitty, 100 columns by 30 rows. Final dimensions are recorded from the PTY before each capture.
- Provider calls: **NOT_RUN**.

## 2026-08-02 — Workflow 1: repository onboarding

- First provider call: HTTP 401 `API key is invalid`; provider usage `0 in / 0 out`.
- Replacing the credential file did not affect the already-running process; a same-process retry
  produced a second zero-usage 401. Clean exit plus `--continue` loaded the new credential.
- Resume restored the transcript and showed `↻ resumed 5 messages`, but `↑` did not recall the
  prior prompt into the composer; the task had to be pasted again.
- Live onboarding then completed after 11 bash commands and six trusted reads. No files changed,
  no dependency installed, and no Warden decision prompt appeared.
- Active-state captures remained at 100×30 cells. The evidence rail showed liveness, but the current
  objective was no longer visible once tool evidence filled the viewport.
- A follow-up asking for status and stopping further exploration landed just after the first answer
  completed, so it became a new turn rather than an in-flight redirect. The second answer reused
  prior evidence and ran no tools.
- Provider usage: call 1 `193672 in / 4096 out`, including `116187` cache-hit and `19732`
  cache-write tokens; call 2 `20702 in / 1020 out`, including `19044` cache-hit and `1655`
  cache-write tokens.
- Estimated cost: **USD 0.3708**. Cumulative: **USD 0.3708**.
- Accuracy check: `Path_is_Iterable=False`. The answer's claim that `Path` would split into path
  components was false; the actual current behavior reaches an iteration attempt and raises.

## 2026-08-02 — Workflow 2: small feature implementation

- Keel verified the corrected `Path` failure twice, then attempted the composite baseline command
  `cd … && python3 -m pytest --version 2>&1`. Warden returned `POL-003 review` with no live approval.
- Operator redirect to atomic `python3 -m pytest --version` passed (`pytest 9.1.1`).
- Keel wrote two red-first tests. Mutation presentation was unavailable: `observation exceeded
  presentation limits`. The targeted red run produced one intended `TypeError` failure and one
  already-passing iterable case.
- Keel implemented `PathLike` normalization and widened the overload/implementation types, then hit
  its token budget before CHANGES or verification. It correctly reported failure and NOT_RUN checks.
- `git diff` and later `uv run …` / `uv --version` were all review-required with no live decision.
- Keel added the CHANGES entry, but the first pytest run imported Homebrew Click 8.4.1. It attempted
  `pip install --user -e …`; authoritative audit shows Warden allowed it only inside a sandbox with
  workspace/temp writes and network deny-all. PEP 668 rejected it before mutation.
- A concurrent `--continue` initially failed closed with `AUDIT_WRITE_FAILED`; the prior `/exit`
  command was still awaiting palette confirmation. Confirming exact stale sessions released the lock.
- Final zero-install verification used pytest `-o pythonpath=src`: new tests `2 passed, 244
  deselected`; full file `223 passed, 23 skipped, 0 failed`.
- `ruff`, `mypy`, and `pyright`: **NOT_RUN**, unavailable in the isolated environment.
- Local-only external commit: `941ab66 feat(termui): accept PathLike filenames in edit`.
- Estimated workflow cost: **USD 0.7218**. Cumulative: **USD 1.0926**.

## 2026-08-02 — Workflow 3: debugging a real failure

- Reproduced Click issue `#3571` deterministically: three manual updates of `7`, `7`, and `6`
  with `length=20`, `show_pos=True`, and `update_min_steps=7` left the final rendered position at
  `14/20`.
- The first long diagnosis exhausted Keel's configured gross-token budget before editing. A queued
  `/now` correction became the next turn rather than preempting the active provider turn.
- Red-first evidence: the focused test failed with the last rendered line containing `14/20`.
  The first patch flushed buffered steps but also called `finish()` unconditionally.
- Independent review found that this changed partial-exit semantics: an incomplete manual bar was
  marked finished. A second red-first test failed with `bar.finished is True` at `pos=7`; Keel then
  removed the unconditional `finish()` call.
- The one-line CHANGES edit was initially denied by read-before-edit. The authoritative audit
  contained the exact corrective instruction; the visible TUI only said to fix the request. Keel
  read the file, retried successfully in the same turn, but the final evidence rail continued to
  emphasize the obsolete denial and omitted the allowed edit.
- Final Keel-run verification: both focused tests passed; progress subset `39 passed, 209
  deselected`; full termui file `225 passed, 23 skipped, 0 failed`.
- Operator style-only cleanup was followed by a focused rerun: `2 passed`; `git diff --check`
  passed. Static checks remain **NOT_RUN**, unavailable.
- Local-only external commit: `21a08e3 fix(termui): flush buffered progress on exit`.
- Estimated workflow cost: **USD 0.6351**. Cumulative: **USD 1.7277**.

## 2026-08-02 — Workflows 4 and 5: risky refactor plus user interruption

- Started a fresh live session with in-loop compaction enabled. Persisted workspace trust removed
  the startup trust prompt while the recent-session card still offered explicit resume.
- Refactor goal: move `PathLike` normalization from public `click.edit` to the private
  `Editor.edit_files` subprocess/filesystem boundary across implementation, public wrapper, and tests.
- Submitted `/before-next-edit` while Keel was active, changing the requirement to forbid a helper
  or type alias and keep conversion inline. The TUI showed an urgent queued preview, stopped the
  pending edit at the boundary, injected the instruction as a new user turn, and the model
  acknowledged it before editing.
- A composite two-node pytest command was review-required with no live decision. The requested
  atomic `-k` alternative first selected zero tests; Keel stopped rather than correcting its own
  selector. A second correction found both behavior tests initially green because `Popen` already
  accepts `PathLike` values.
- Keel rewrote them as direct boundary-contract tests. An explicit `Esc` then interrupted the live
  turn; the TUI promptly showed `interrupted — the turn was stopped (the session is saved)`.
- Post-interrupt status was accurate: two tests edited, implementation untouched, prior green run
  identified. The next run produced the intended red because `PosixPath` reached `Popen`.
- Keel completed the three-file refactor. Audit evidence records: boundary `2 passed, 248
  deselected`; PathLike `4 passed, 246 deselected`; progress `39 passed, 211 deselected`; full termui
  `227 passed, 23 skipped, 0 failed`.
- The turn nevertheless exhausted its gross-token budget after those tests. Compaction triggered at
  the hard boundary, not early enough to prevent failure. The next no-tool turn used a 6k-token view
  and retained the steering constraint, but falsely described compaction as a mid-task resume.
- Independent review found duplicate standalone tests. Keel consolidated the two cases into the
  existing parameterized editor-path test and reran: editor normalization `16 passed`; PathLike `2
  passed`; full termui `227 passed, 23 skipped`.
- `git diff --check` passed. Static checks remain **NOT_RUN**, unavailable.
- Local-only external commit: `edda51f refactor(termui): normalize edit filenames at boundary`.
- Estimated workflow cost: **USD 0.9832**. Cumulative: **USD 2.7109**.

## 2026-08-02 — Keel implementation gate

- Read-only diagnosis located the misleading bash-success presentation in the live/resumed TUI
  reducer path. Structured bash envelopes already expose `exitCode`; successful Warden transport is
  currently used as the card status even when the governed command exits nonzero.
- Published the required public dogfood plan as
  [issue #52](https://github.com/keel-harness/keel/issues/52).
- First slice is presentation-only and TDD-scoped: nonzero bash envelopes render failed live and on
  resume, while the frozen event, audit, Warden verdict, model-visible output, and enforcement remain
  unchanged.
- Keel source implementation: **NOT_STARTED**, awaiting explicit human review required by the repo
  charter for a public TUI behavior change.
