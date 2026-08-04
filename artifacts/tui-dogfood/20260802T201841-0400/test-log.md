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

## 2026-08-02 — R1 terminal-review truth implementation

- Published this evidence set in [PR #53](https://github.com/keel-harness/keel/pull/53). Exact-head
  CI run `30778464017` passed all required jobs; the PR remains open for independent review.
- Reconciled issue #52 with the authoritative controller facts: the observed `POL-003` results were
  terminal (`grantable:false`, `pending:false`), while Keel already has a live controller for real
  pending grantable reviews. Opened scoped implementation issue
  [#54](https://github.com/keel-harness/keel/issues/54).
- Created isolated worktree branch `fix/tui-terminal-review-outcomes` from exact main
  `a14133831f3a249a8e941c38c302f9effd61ce82`.
- First red run: 4 failures and 451 passes. The executor, resume path, headless renderer, and
  conversation evidence all reproduced the false `review needed` / human-decision presentation.
- Implemented a presentation-only fix. A terminal review without a live handle retains the exact
  model-visible result but carries a process-local `blocked` outcome; resume recognizes the existing
  exact no-live markers; shared copy states that no live decision exists.
- First E3/E4 replay found a residual contradiction: starter-policy guidance still displayed
  `ask for approval`. A second red run failed 2 tests with 296 passes before the terminal-only
  presentation filter removed that stale clause. Genuine live-review guidance is unchanged.
- Final targeted regression: `455 passed`. Approval/controller/Ink/CLI regression set: `442 passed`.
- Final full current-head run outside the outer sandbox: `6,412 passed`, `20 skipped` by existing
  opt-in real-sandbox/Ollama gates. `typecheck`, `lint`, repository-wide `format`, and
  `git diff --check` passed.
- Offline deterministic product replay against the same disposable Click checkout reproduced
  `POL-003`, exited nonzero, and used no provider or network spend. The 100×30 Kitty capture
  `screenshots/16-r1-terminal-review-after.png` shows `blocked`, `no live decision available`, and
  the atomic rerun guidance, with no approval affordance or contradictory `ask for approval` text.
- Signed-off implementation commit:
  `26bf47bf41f43ba3afb0c46cc813e63f80f788f4 fix(tui): distinguish terminal review outcomes`.
  Published as [PR #55](https://github.com/keel-harness/keel/pull/55).
- Provider usage: **0 input / 0 output** for this implementation replay. Cumulative Anthropic cost
  remains **USD 2.7109**; the USD 2.00 final live-regression reserve remains intact.

## 2026-08-02 — R2 bash command-outcome truth

- Opened scoped issue [#56](https://github.com/keel-harness/keel/issues/56) and created isolated
  stacked branch `fix/tui-bash-command-outcomes` from R1 commit `26bf47b`. The stacked review must be
  retargeted to main only after R1 merges.
- Red-first result: 3 failures and 300 passes. Live nonzero and signaled bash commands retained
  `status:ok`; resumed/headless history rendered `tool ✓ bash done`.
- Implemented one presentation-only derivation from the complete outer bash result envelope. Nonzero
  exit or signal becomes a kernel-local failed presentation; exit zero remains done. Existing typed
  outcomes win, and non-bash or incomplete JSON remains ordinary data.
- Focused green: `303 passed`. Broader view-model/headless/conversation/tool-card/Ink/CLI set:
  `709 passed`.
- Final full current-head run outside the outer sandbox: `6,417 passed`, `20 skipped` by existing
  opt-in real-sandbox/Ollama gates. Full typecheck, lint, repository format, and diff check passed.
- Offline product replay used a legitimate Warden-allowed atomic pytest selector. The command exited
  5 after selecting no tests; Keel continued the replay and rendered `failed: bash: exit 5` rather
  than a success checkmark. Model-visible output, transport truth, loop behavior, Warden, audit, and
  completion eligibility were unchanged.
- Sanitized E4 capture: `screenshots/17-r2-bash-command-failure-after.png`, Kitty 100×30.
- Signed-off implementation commit:
  `884a27ad66893858f2942cffbcd914a643c0d999 fix(tui): derive bash cards from command outcomes`.
  Published as stacked [PR #57](https://github.com/keel-harness/keel/pull/57).
- Follow-up observed, not fixed in this slice: a benign pytest terminal warning can outrank the more
  useful stdout tail in compact failure detail.
- Provider usage: **0 input / 0 output**. Cumulative Anthropic cost remains **USD 2.7109**.

## 2026-08-03 — R3 recovered mutation receipts

- Verified clean synchronized `main` at `86a6c6e542dc420ae35c932803debc24f4215dad`; exact-head CI
  run `30782086893` was green. Opened scoped issue
  [#58](https://github.com/keel-harness/keel/issues/58) and isolated branch
  `fix/tui-reconcile-recovered-receipts` from that exact baseline.
- The first attempted test command was **NOT_RUN** because the fresh worktree lacked `vitest`.
  `pnpm install --frozen-lockfile --ignore-scripts` restored the exact lockfile graph without running
  package scripts. The first real red reproduced DF-015: 2 failures / 171 passes; live and resumed
  exact retries still ended `needs attention`.
- The first broad regression exposed four unchanged scaling tests: a second transcript pass made
  indexed reads super-linear. The implementation was reduced to one reverse reconciliation pass;
  the performance tests then passed without relaxation.
- Two product/review gaps were also captured red-first: one-shot output omitted the recovery receipt
  (1 failure / 134 skipped), and malformed overlapping resume IDs could manufacture a correlation
  (1 failure / 173 skipped). Both now fail safe and share the same visible recovery evidence.
- Final focused reducer/conversation/headless/Ink/row-budget regression: `590 passed`. Final full
  unrestricted suite: `6,426 passed`, `20 skipped` by existing opt-in real-sandbox/Ollama gates.
  The restricted full attempt was **invalid/partial** because six loopback proxy tests hit the outer
  harness's `listen EPERM`; the exact unrestricted rerun passed.
- Full repository `typecheck`, `lint`, `format`, and `git diff --check` passed. Five-lens review found
  and resolved the resume/ambiguity defects above. It also rejected a draft `verification not
  recorded` copy change because accepted ADR-0079 requires `verification not run`; R3 does not
  reinterpret that contract.
- Offline product replay drove the real kernel → Warden → policy → audit path against a disposable
  Click fixture: blocked edit → corrective read → exact successful edit → harmless governed shell
  marker → final answer. Before the one-shot fix the obsolete block was hidden without a recovery
  receipt; after it rendered `what: recovered: edit r3-recovery-fixture.txt completed after earlier
  blocked attempt` beside verified file evidence.
- External Click check: `227 passed, 23 skipped`. The sanitized matching E4 pair is
  `screenshots/18-r3-recovered-receipt-before.png` and
  `screenshots/19-r3-recovered-receipt-after.png`, both Kitty 100×30. Neither contains a
  credential, username, or private path.
- Provider usage: **0 input / 0 output**. The displayed 175 replay tokens came from the deterministic
  recording. Cumulative Anthropic cost remains **USD 2.7109**; the USD 2.00 reserve remains intact.

## 2026-08-03 — R4 bounded mutation review construction

- Verified synchronized `main` at `990f9904e791f74b80874100544930ace34c0e1a`; exact post-R3
  `main` CI run `30784690703` passed. Opened scoped issue
  [#60](https://github.com/keel-harness/keel/issues/60) and isolated branch
  `fix/warden-trim-common-mutation-context` from that exact baseline.
- Credential-unset offline reproduction against the Click workload edited a 68,669-byte,
  1,634-line `CHANGES.md`. The mutation succeeded, but live/headless output showed
  `observation exceeded presentation limits`. Whole-file 1,634 × 1,634 Hirschberg LCS required
  about 2.67 million comparisons and crossed ADR-0078's unchanged 2,000,000-operation ceiling.
- First real red: constructor `1 failed / 11 passed`; the new Click-sized regression threw
  `ConstructionBudgetExceededError` from scalar accounting.
- Implemented exact common-prefix/suffix factoring around the bounded middle LCS. Edge comparisons
  use the same scalar accountant. Repeated-line insertion keeps exact source numbers, randomized
  small comparisons retain reference-LCS cardinality, and a divergent 1,415 × 1,415 middle remains
  fail-closed.
- Focused green: constructor `15 passed`; all nine Warden mutation-presentation files `121 passed`;
  kernel product-path/TUI mutation regression `75 passed`.
- Full unrestricted unit/property suite: 358 files passed, 4 existing opt-in files skipped; 6,430
  tests passed and 20 skipped. Enforced coverage passed: Warden 97.61% statements / 91.66% branches;
  touched constructor 97.81% / 91.46%.
- Full repository `typecheck`, `lint`, `format`, and `git diff --check` passed. External Click:
  `227 passed, 23 skipped`.
- The exact replay after the fix showed `+1 -1`, 1,634 → 1,634 lines, five rows shown, 1,630
  unchanged rows omitted, and explicit `transition not atomic` / `concurrent mutation not excluded`.
  Matched sanitized evidence: `screenshots/20-r4-mutation-review-before.png` and
  `screenshots/21-r4-mutation-review-after.png`, Kitty 100×30.
- Five-lens review found no unresolved must-fix: accepted ADR-0078 semantics and bounds are
  preserved; adversarial work still fails closed; line identity/property tests are green; the
  original workflow is materially clearer; the implementation is one local factoring helper.
- Security claims affected: **none**. ADR needed: **no**, because no accepted decision or frozen
  surface changed. Durable/resumed mutation evidence remains explicitly deferred by ADR-0078.
- Provider usage: **0 input / 0 output**. The displayed 136 replay tokens are synthetic. Cumulative
  Anthropic cost remains **USD 2.7109**; the USD 2.00 reserve remains intact.

## 2026-08-03 — R4 publication closeout

- Reviewed head `6c2637eb30591834816397254f18949051af48a9` passed exact-head CI run
  `30786255628` and was owner-authorized for the separate admin merge only after recorded five-lens
  QC was green.
- PR [#61](https://github.com/keel-harness/keel/pull/61) squash-merged as
  `01de241ecd3ea275e7b075a5ebd8099524c68a92`. Reviewed-head and merge trees are identical at
  `20c6a75cc8f98d39de9abad35fb141c9b0c37e23`.
- Exact post-merge `main` CI run `30786694570` passed. The primary checkout was fast-forwarded and
  the merged local branch/worktree and deleted remote tracking ref were removed.

## 2026-08-03 — R0 repeatable dogfood scenarios

- Verified clean synchronized `main` at `01de241ecd3ea275e7b075a5ebd8099524c68a92` with exact
  post-R4 CI green. Opened scoped issue
  [#62](https://github.com/keel-harness/keel/issues/62) and isolated branch
  `test/eval-freeze-dogfood-scenarios` from that exact baseline.
- Worktree setup attempts were not counted as red behavior evidence: the empty worktree first lacked
  `vitest`; an offline frozen install stopped on the repository's patched-dependency lock mismatch;
  an offline lockfile-disabled install stopped on missing package metadata. Neither modified tracked
  files. Diagnosis found ambient pnpm 9.9 while the repository pins pnpm 10.16. Corepack 10.16 then
  installed the exact frozen lockfile with lifecycle scripts disabled; no dependency or lockfile
  changed.
- First real red: the focused suite failed to load missing module `dogfood-evidence.js`; no tests
  collected. This is the expected pre-implementation failure.
- Implemented one private eval schema/comparator and one committed sanitized manifest. The manifest
  fixes exact Click starting commits, sanitized prompts with explicit source-ledger/canonicalized
  provenance, terminal/mode, expected policy posture, authoritative facts/outcomes, screenshot
  checkpoints, cost ceilings, and all eleven score axes for exactly six workflows.
- Comparator output is deterministic across bash, review lifecycle, mutation capability,
  verification, and interrupt states. Strict schemas reject unknown fields, inconsistent lifecycle
  facts, unsafe screenshot paths, malformed baselines/costs, and duplicate workflows; a committed-
  artifact guard rejects credential or user-home markers. The comparator emits no policy decision.
- Final honesty review found that two replay prompts were canonical syntheses, not verbatim sanitized
  ledger inputs. Red evidence was **1 failed / 20 passed** with all six provenance fields absent;
  the manifest/schema now labels four `source-ledger` and two `canonicalized` prompts explicitly.
- Final focused manifest/comparator plus barrel run: **22 passed**. The new comparator file measured
  100% statements / branches / functions / lines. Full eval regression passed **293 tests**;
  `@keel/eval` typecheck/build passed. Repository-wide typecheck, lint, format, and
  `git diff --check` passed.
- The first restricted full run was **partial/invalid**: six loopback proxy cases failed at the outer
  harness boundary with `listen EPERM`; no application assertion failed. Exact-candidate unrestricted
  full coverage then passed **6,451 tests with 20 existing opt-in skips**. Coverage passed at 98.02%
  statements / 93.73% branches / 99.58% functions / 98.02% lines.
- Credential-unset real PTY replay at 100x30 produced 6 workflows, 11 axes, 19 existing safe
  checkpoint names, one intentional `bash-render-mismatch`, and 0 provider calls. A new E4 capture
  was **NOT_RUN** because R0 changes no runtime/visual behavior; E5 was **NOT_RUN** with zero spend.
- Provider usage: **0 input / 0 output**. Cumulative Anthropic cost remains **USD 2.7109**; remaining
  budget is **USD 17.2891**, including the intact USD 2.00 final-regression reserve.

## 2026-08-03 — R0 publication closeout

- Reviewed head `9e10c7fb0974076792fd7ee7b431d6ebbf1b8f7e` passed exact-head CI run
  `30788707053`.
- PR [#63](https://github.com/keel-harness/keel/pull/63) was squash-merged under the owner's separate
  admin authorization as `05452ec46eddcd7d09cdb4b342f8865ad93fb8a2`.
- Reviewed-head and merge trees are identical at `8f34d1c61ceff71237fea8368c55c11902a37863`.
- Exact post-merge `main` CI run `30789072222` passed. The primary checkout was fast-forwarded and
  the merged branch/worktree and deleted remote tracking ref were removed.

## 2026-08-03 — R5a actionable Warden denial guidance

- Verified clean synchronized `main` at `05452ec46eddcd7d09cdb4b342f8865ad93fb8a2` after exact
  post-R0 CI. Opened parent [issue #64](https://github.com/keel-harness/keel/issues/64) and isolated
  branch `fix/tui-warden-denial-guidance` from that exact baseline.
- A frozen offline install first stopped because a required package tarball was absent. The exact
  lockfile graph was then installed with `corepack pnpm install --frozen-lockfile --ignore-scripts`;
  no lifecycle script, dependency, or lockfile change occurred.
- First real red: **5 failed / 293 passed**. Exact read-before-edit guidance was not the visible safe
  next action, generic guidance had no honest unavailable state, and executor output did not redact
  a credential-shaped fixture.
- The first implementation passed **298 focused tests**. A credential-unset 100x30 real PTY replay
  then exposed a live-only edit-shortcut defect: live output remained generic while resume was exact.
- Second red: a realistic reducer regression failed **1 test / 135 skipped**. The ordering fix then
  passed, and final focused executor/conversation/headless/view-model regression passed **473 tests**.
- One initial final-focused command was **NOT_RUN** because `pnpm --filter ... exec vitest` changed
  the working directory while the selectors were root-relative; Vitest collected no files. The
  corrected root invocation above is the valid result.
- E3: deterministic controller replay through a real 100x30 PTY showed exact recovery guidance with
  no ANSI or secret output. E4: `screenshots/22-r5a-denial-guidance-after.png` is a visually inspected
  local rasterization of that sanitized PTY text; the in-app browser and detached Kitty window were
  unavailable, so it is not claimed as a live-window capture. E5: **NOT_RUN**, zero provider use.
- Full kernel regression passed **4,075 tests with 2 existing opt-in skips**. The first restricted
  repository coverage attempt was **partial/invalid** because six loopback proxy cases hit the outer
  harness's `listen EPERM`; it passed 6,449 tests with 20 skips before that boundary failure. The
  exact-code unrestricted rerun passed **6,456 tests with 20 existing opt-in skips**.
- Enforced coverage passed at 98.02% statements / 93.73% branches / 99.58% functions / 98.02%
  lines repository-wide; kernel measured 97.85% / 94.60% and Warden 97.61% / 91.68% for statements /
  branches.
- The first final static pass found one Prettier-only failure in the corrected live-denial condition;
  the formatter was applied to that file. Exact-candidate repository typecheck, lint, format, build,
  and `git diff --check` then passed. No test or gate was weakened.

## 2026-08-03 — R5b verified Warden containment rationale

- Started from clean synchronized `main` at `79f4b706e659d0ef559178aeac5d0295c7039950`, after R5a's
  exact post-merge CI passed. Isolated branch: `fix/tui-warden-containment-rationale`. External Click
  stayed on clean local-only commit `edda51f`.
- First real red: **4 failed / 568 passed**. The Warden emitted no containment rationale, the kernel
  did not carry one, and live/resume reducers ignored it and falsely treated a prefixed nonzero bash
  envelope as successful.
- After the first implementation reached **572 passed**, issue #64 was re-read and the output was
  narrowed to exactly two user-facing facts. Warn-path, near-match, command-output-forgery, and
  nonzero precedence cases were added first. Second real red: **7 failed / 568 passed**.
- Final focused Warden/executor/view-model/product-path/Ink run passed **755/755**. The product-path
  regression spawns a real Warden, uses an enforcing fake sandbox at that boundary, writes a durable
  session, and verifies the audit chain and unchanged original decision.
- E3: a credential-unset real PTY at exactly 100x30 ran the production source CLI, spawned Warden,
  and vendored SRT against the external Click checkout. `python3 -m pip --version` completed with
  `contained: writes workspace/temp · network deny-all` and real pip stdout. The audit contained two
  allowed `tool.execute` records with no response-only rationale in the policy decision. Credential
  pattern scanning found no matches. External Click verification passed **227 tests / 23 skips** and
  the worktree remained clean.
- E4: `screenshots/23-r5b-containment-after.png` is a visually inspected 1400x840 sanitized
  terminal-frame transcription of the exact PTY output at the representative 100x30 geometry. It is
  not claimed as a live Kitty/window capture. No credential, username, user-home path, or private
  temporary path is visible.
- E5: **NOT_RUN**. All provider credential variables were explicitly unset; provider calls, input
  tokens, output tokens, and Anthropic spend were zero. Cumulative spend remains **USD 2.7109** and
  the USD 2.00 final-regression reserve remains intact.
- The first restricted full repository test was **partial/invalid**: 6,461 tests passed with 20
  expected skips, but six loopback proxy tests failed to bind with `listen EPERM` under the outer
  sandbox. The exact-code unrestricted coverage rerun passed **6,467 tests / 20 existing opt-in
  skips** across 359 passing test files and 4 skipped files.
- Enforced coverage passed at **98.02% statements / 93.73% branches / 99.58% functions / 98.02%
  lines** repository-wide. Warden measured 97.61% statements / 91.72% branches; kernel measured
  97.85% / 94.65%.
- The first `test:sandbox:real` invocation was a transparent configuration failure: 13 tests passed
  but the credential-TLS suite required its checked-in fixture CA through `NODE_EXTRA_CA_CERTS`
  before Node startup. The corrected command passed all **18/18** real SRT denial/credential/address
  guard probes.
- Repository typecheck, lint, format, build, and `git diff --check` passed. No test, policy, security
  gate, coverage threshold, or frozen contract was weakened.
- Final adversarial QC found that a custom policy could reuse the reserved containment sentence as
  ordinary response guidance. The regression failed **1 test / 320 skipped** because the collision
  crossed unchanged. The Warden now namespaces only that reserved response prefix as policy guidance
  while preserving the original audit decision; the focused regression then passed.
- The first post-collision typecheck and build failed on `exactOptionalPropertyTypes`: the response
  clone's inferred type could contain `guidance: undefined`. The branch was made explicit so no
  clone is constructed when response guidance is absent; exact-candidate typecheck and build then
  passed. Lint, format, and diff check also passed.
- Five-lens local QC found no unresolved must-fix after that correction: the slice uses existing optional response
  guidance and no schema change; containment is exact and Warden-proven; allow/warn/nonzero/live/
  resume/no-color paths are covered; copy is two calm facts; and implementation adds no dependency,
  retained state, or duplicated policy authority.
- First exact-head CI run `30794975878` was **not green**: the Ubuntu package job failed in
  `smoke-installed-final-response.mjs` after all earlier carrier steps passed. The installed product
  correctly persisted the new closed containment prefix, but the oracle still attempted to parse the
  entire durable Bash output as raw JSON and reported an undefined silent-exit result.
- The packaging oracle's valid self-test fixture was updated first to match the new real carrier
  output. It failed locally with the same `did not settle silent exit-zero: undefined` error. The
  parser was then narrowed to require and remove only the exact closed Warden prefix; missing and
  near-match mutations are rejected, and the existing nonzero mutation remains rejected.
- Corrected oracle self-test passed all valid evidence and rejected 18 adversarial mutations. A
  fresh local `bun packaging/build.ts npx` carrier was packed, installed into an isolated temporary
  prefix with scripts disabled, and passed the strengthened real installed final-response smoke. The initial
  offline install attempt was **NOT_RUN to completion** because the clean task cache lacked registry
  dependencies; the permitted isolated install fetched them and reported zero vulnerabilities.

## 2026-08-03 — R5b publication closeout

- Corrected reviewed head `049fa7ea598b185128561abdc92ed8e9c579bbfe` passed exact-head CI run
  `30795625464`. PR [#66](https://github.com/keel-harness/keel/pull/66) was squash-merged under the
  owner's separate admin authorization as `38d925ea1a65e7d23d6712e94ea731fd6d16df77`.
- Reviewed and merge trees are identical at `c98696dc3d3463c155442874023879f6db0641bf`.
  Exact post-merge `main` CI run `30796233837` passed. Issue #64 was closed and the branch/worktree
  were removed.

## 2026-08-03 — R6 concurrent-resume preflight

- Started from clean synchronized `main` at `38d925ea1a65e7d23d6712e94ea731fd6d16df77` after exact
  post-R5 CI. Published the required plan as
  [issue #67](https://github.com/keel-harness/keel/issues/67) before code and created isolated branch
  `fix/tui-concurrent-resume-preflight`.
- Worktree dependency setup first stopped with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` because the
  ambient package graph did not match patched-dependency config. That command is **NOT_RUN to
  completion** and changed no tracked file. Existing ignored dependency trees were linked for the
  isolated worktree and are excluded from the candidate.
- First real red: **5 failed / 104 skipped**. Writer errors lacked ownership state, startup emitted no
  authoritative `session.start`, and true concurrent resumes reached the model. A separate real-RPC
  red failed **1 / 321 skipped** because `AUDIT_WRITE_FAILED` omitted safe recovery metadata.
- Implemented startup acquisition through the existing Warden `audit.append` and existing
  `session.start` event. Active/indeterminate errors become sanitized actionable CLI failures before
  prompt/model work; pending resumed steering is applied only after preflight. Existing stale-lock
  recovery remains fail-closed except for its known-dead single reclaim.
- Directly affected Warden/kernel suites passed **431/431**. The unrestricted full suite passed
  **6,471 tests / 20 existing opt-in skips**, 359 passing files and 4 skipped files.
- The local macOS coverage run executed those same tests but exited nonzero because six loopback
  tests could not bind under the outer sandbox and platform-conditional Linux files remained below
  their per-file thresholds; CI runs coverage on Linux and plain tests on macOS. The changed writer
  cleared its Warden floor at **95.95% statements/lines, 96.77% functions, 93.33% branches**.
- E3: a credential-unset production-source CLI run in a real 100x30 PTY, against external Click and
  a spawned Warden, proved blocked exit 1, **0 provider requests**, unchanged active lock, clean
  owner exit/release, recovered exit 0, exactly one local-fixture request, and a valid audit chain.
- E4: `screenshots/24-r6-concurrent-resume-after.png` is a visually inspected 1400x840 sanitized
  terminal-frame transcription of the exact PTY message. It is not claimed as a live-window
  capture. Corrected SHA-256 `bdb193d28c9db3b38b3fa6ceab3b7b37201cb6ba41015898d9b477bd51f7eea6`.
- E5: **NOT_RUN**; Anthropic usage and spend are zero. Cumulative spend remains **USD 2.7109** and
  the USD 2.00 final-regression reserve remains intact.
- Final candidate gates passed: affected suites **431/431**, repository typecheck, lint, format,
  build, `git diff --check`, and real SRT denial/credential/address-guard probes **18/18** with the
  checked-in fixture CA configured before Node startup.

## 2026-08-03 — R6 evidence-path correction

- Post-merge verification found that the image inspected before PR #68 was an untracked raster in
  the primary checkout, while the same relative path staged from the isolated worktree still held
  the earlier mostly blank crop. The implementation and PTY transcript were unaffected, but the E4
  claim and documented hash were invalid.
- Re-rasterized directly to the exact correction-worktree path, opened that same absolute file with
  the image inspector, and confirmed the full terminal message plus both bottom outcome lines are
  legible. The corrected PNG is 1400x840, 84,271 bytes, SHA-256
  `bdb193d28c9db3b38b3fa6ceab3b7b37201cb6ba41015898d9b477bd51f7eea6`.
- This is an evidence-only correction: no runtime, test, policy, schema, audit, security claim, or
  provider use changed. The manifest existence regression and repository format/diff checks pass;
  exact-head CI remains required before the correction merges.

## 2026-08-03 — R7 gross-token runway preflight

- Started from clean synchronized `main` at `dc662531476c4b08752d0c0b037715ad46b6c5ab`, after R6's
  corrected exact post-main CI passed. Published the required plan as
  [issue #70](https://github.com/keel-harness/keel/issues/70) and created isolated branch
  `fix/tui-gross-runway-preflight`.
- Diagnosis corrected the original compaction narrative: the existing hook already ran before the
  next provider request. It could shrink the active view but not reclaim cumulative gross spend.
  R7 therefore owns distinct gross warning identity plus a post-compaction input-fit preflight; it
  does not enable compaction or reinterpret a cap.
- The first red-test patch accidentally landed in the primary checkout while tests ran in the
  worktree, yielding a false **517/517 control green**. This was not accepted as red evidence. The
  exact patch was moved to the worktree and reversed from primary; primary `main` was verified clean.
  A syntax typo in the new loop test was also fixed before accepting behavioral evidence.
- The corrected red suite failed for the intended absent behaviors across loop/event/string/
  recorder/context/TUI/wiring. Valid loop red contained three intended failures: warning metric,
  gross warning, and second-call prevention. No production behavior was changed before that red.
- Focused green passed **524/524**. Added shared-state warning and invalid-threshold cases brought the
  full loop suite to **170/170**. A new end-to-end runner/recorder/reducer/headless/ledger walking
  skeleton passed **4/4** and proves successful tool evidence survives the stopped terminal.
- The restricted full run was **partial/invalid**: **6,473 passed / 20 existing skips**, while six
  proxy tests hit the outer sandbox's `listen EPERM`. The authorized unrestricted rerun passed
  **6,479 / 20**, with 359 passing files and 4 skipped files. After the final adversarial correction
  and two added regressions, the exact candidate unrestricted suite passed **6,481 / 20**.
- Full coverage executed those same tests but exited nonzero on pre-existing unrelated macOS
  per-file thresholds. Changed production coverage: loop 94.07% lines / 94.54% branches;
  view-model 97.48% / 93.43%; session-entry 94.67% / 91.40%; pressure 100% / 98.59%; recorder 100%
  / 94.23%; events and strings 100%. The aggregate command is not called green.
- E3: the production source CLI, spawned Warden, external Click checkout, non-secret local fixture,
  and real 100x30 PTY completed one governed read, showed a distinct 48k/50k warning, and stopped
  before a forecast 5,538-token second request with 2,000 remaining. Fixture count was exactly one.
  `keel --continue` restored prompt/read/warning evidence and completed a new instruction; final
  fixture count was exactly two. No external file changed and no human Warden interrupt occurred.
- E4: `screenshots/25-r7-gross-runway-after.png` is a visually inspected 1400x840 sanitized
  terminal-frame transcription at the exact worktree path, not a live-window capture. SHA-256
  `96e15ce2009e68791b786eb81ca23441922e911ac554b70319dbf2ae112fb703`.
- E5: **PASSED** after credential replacement. A production-source CLI at 100x30 used live
  `claude-sonnet-4-6` to request one trusted read of the first 20 `CHANGES.md` lines. The read
  returned `## Version 8.5.0`; after 3,435 gross tokens, Keel warned and stopped before a forecast
  3,164-input-token second request could consume the 3,065-token remainder of a 6,500 cap. The
  successful read stayed visible and durable.
- A fresh `--continue` run resumed seven messages. The new instruction `Reply with exactly
  CONTINUED. Do not call tools.` returned exactly `CONTINUED.` without a tool call. The two durable
  `run_status` events reported 3,346 input / 89 output tokens (3 fresh / 3,343 cache write) and
  3,835 input / 6 output (3 fresh / 489 cache write / 3,343 cache hit). Incremental Anthropic cost
  was **USD 0.0168**; cumulative spend is **USD 2.7277**, remaining budget **USD 17.2723**, and the
  USD 2 reserve remains intact. The credential value was never read, printed, logged, or captured.
- External Click stayed clean and no human Warden interrupt occurred. Live call count was exactly
  one at the runway stop and two after continuation.
- Five-lens review found one must-fix before commit: controller-notice recognition matched arbitrary
  user prose beginning `Budget notice:`. The new adversarial test failed **1 / 16 passed**, then
  passed **17/17** after recognition was narrowed to exact legacy/new controller prefixes.
- Final focused behavior and artifact-manifest regression passed **551/551**. Repository typecheck,
  lint, format, build, and `git diff --check` passed on the reconciled candidate.
- Local five-lens QC found no code must-fix: scope matches issue #70; provider prevention and metric
  identity are adversarially covered; exact boundaries, compaction, persistence, and resume are
  tested; the UI says stopped and preserves evidence; the change adds no dependency or authority.
  Live E5 now passes; publication remains blocked only on the updated evidence head's exact-head CI.
- Post-E5 evidence reconciliation passed the artifact guard **21/21**, Prettier checked all eight
  touched Markdown files, and `git diff --check` passed. No product code changed after the already
  green candidate gates; the new evidence head still requires full exact-head CI.

## 2026-08-03 — R8 persistent active task

- Started from clean synchronized `main` at `5e6999cd836fee1a341a9c8cd2955abf7959abd2` after R7's
  exact post-main CI passed. Published [issue #72](https://github.com/keel-harness/keel/issues/72)
  and created isolated branch `fix/tui-active-task-line`.
- Valid red-first coverage ended at **13 intended failures** across headless, real Ink, assistant
  streaming, Unicode/cell clipping, sanitization, ownership, and 80x24/100x30 row budgets. One
  impossible row fixture was corrected before accepting the red.
- Focused green passed **430/430**. Typecheck, lint, format, build, and `git diff --check` passed.
- The first unrestricted full suite was **6,491 passed / 20 skipped / 1 failed** and exposed a real
  80x24 `/reviews` collision. A focused panel-ownership regression stayed red until task chrome was
  suppressed under foreground focus. The corrected unrestricted suite passed **6,492 / 20** across
  359 passing files and 4 opt-in skipped files.
- E3: credential-unset production source, spawned Warden, external Click, a non-secret local
  fixture, and real 80x24/100x30 PTYs made four local requests. Task copy was present exactly once
  during wait/stream, absent after settlement, both exits were 0, and Click stayed clean.
- E4: `screenshots/26-r8-active-objective-after.png` is a visually inspected 1400x840 sanitized
  exact-frame transcription, SHA-256
  `28f37d0d67bddd6f0733f33c7bc4c3a8ab32c38663876dacc7305bad982cf8ba`.
- E5: a bounded live 100x30 Anthropic run showed the task through provider wait, Warden checking,
  successful read wait, and assistant streaming, then removed it on settlement. `CHANGES.md`
  returned `## Version 8.5.0`; no review or mutation occurred. Usage: 6,999 input / 110 output (4
  fresh / 3,735 cache write / 3,260 cache hit), incremental USD 0.01664625, cumulative USD
  2.74434625, USD 17.25565375 remaining.
- The whole-repository instrumented coverage command was **non-green**: it was killed with exit 137
  before Vitest emitted its summary. A bounded changed-file coverage run passed **250/250**;
  `conversation-block.ts` measured 98.38% statements/lines, 94.94% branches, 98.76% functions, and
  `headless.ts` measured 97.83% statements/lines, 93.11% branches, 100% functions. Ink remains
  excluded by the checked-in coverage policy and is covered by real-Ink render tests.
- Local five-lens QC found no must-fix. Spec: exact issue #72 scope and no frozen/shared change.
  Security: ANSI, controls, invisible scalars, secret shapes, and approval/panel ownership are
  adversarially covered. Reliability: 80/100 columns, CJK, emoji, combining marks, unbroken text,
  provider/tool/assistant phases, and settlement are covered. DX: the same workload is now
  self-identifying with no added Warden prompt. Simplicity: one presentation helper and an optional
  render-width input, no dependency or new authority.
- Post-evidence behavior/artifact regression passed **469/469**. The exact candidate then passed
  repository typecheck, lint, format, build, and `git diff --check`. Exact-head CI, merge, post-main
  CI, and cleanup remain required.

## 2026-08-03 — R9 resumed prompt history

- Started from clean synchronized `main` at `fff28637e84b051953b7431f00303648558edd27` after R8's
  post-main CI passed. Published [issue #74](https://github.com/keel-harness/keel/issues/74) and
  created isolated branch `fix/tui-resume-input-history`.
- Red-first tests covered ordinary-versus-controller prompt provenance, structured steering,
  duplicates, blanks, secret redaction, control stripping, the 100-entry bound, exact live submit,
  optional sidecar wiring, fresh/resumed REPL separation, and CLI continuation. Three intended
  behavior failures remained after the initial missing-module failures were separated from product
  behavior; no production behavior existed before the valid red.
- Adversarial review added a red torn-ledger case: an applied steering marker promised index 2 but
  its injected user event was absent; a later legitimate prompt reused index 2. Index-only matching
  hid the prompt. The fix requires exact index plus exact content and the regression now passes.
- Focused green: **337/337** across six files. Repository typecheck, lint, format, build, and
  `git diff --check` passed. The unrestricted full suite passed **6,502 / 20 existing opt-in skips**
  across 360 passing files and 4 skipped files.
- The first bounded coverage command was **non-green** despite **337/337** tests passing: aggregate
  was 94.34% statements/lines, 92.22% branches, and 92.70% functions, but `session-entry.ts` had
  only 86% functions under the narrow selection. No threshold was weakened. The expanded complete
  entrypoint corpus passed **377/377** and every changed non-Ink file cleared the per-file gate;
  aggregate was 96.40% statements/lines, 92.59% branches, and 98.95% functions.
- E3: current `main` and the R9 candidate each ran through the production source CLI, spawned
  Warden, external Click, a non-secret local OpenAI-compatible fixture, and real 80x24/100x30 PTYs.
  Before, Up after restart left `preserve this draft` unchanged. After, Up recalled the prior Click
  prompt, Down restored the exact draft, a second Up recalled again, and the edited recall
  submitted. All four resume runs exited 0; six fixture requests completed; Click stayed clean.
- E4: `screenshots/27-r9-resume-history-before.png` and
  `screenshots/28-r9-resume-history-after.png` are visually inspected 1400x840 sanitized
  exact-frame transcriptions of the 100x30 comparison, not live-window captures. SHA-256:
  `b8d6d1079e99cfe20cf7bb405438509aadede052a57702197e931fc286444c46` and
  `3184a825c5c085d01ecf2010259fe4dc268a85411e694a24c3b0431000462dd9`.
- E5: **NOT_RUN**. The slice does not change provider behavior and six deterministic loopback calls
  exercised the production path without reading the live credential. Anthropic spend remains USD
  2.74434625; USD 17.25565375 remains and the final USD 2 reserve is intact.
- Five-lens QC found no must-fix. Spec: exact issue #74 scope and no frozen/shared change. Security:
  history is bounded and sanitized, structured steering is excluded without policy heuristics, and
  exact live submission is separated from retained recall. Reliability: fresh/resume, unsupported
  ports, late seeds, duplicates, bounds, drafts, 80x24/100x30, and torn ordering are covered. DX:
  the main/candidate replay materially removes restart retyping. Simplicity: one small optional
  sidecar and shared initializer, no dependency or new authority. Exact-head CI, merge, post-main
  CI, and cleanup remain required.

## 2026-08-03 — R9 publication closeout

- Reviewed-head CI run `30836483686` passed and PR #75 squash-merged as `baf7db4`.
- The first post-merge `main` run `30837011412` failed a high `brace-expansion` advisory. This was a
  supply-chain gate, not an R9 behavior regression, and it was not ignored or reclassified green.
- The separate remediation merged through PR #78 as `ba292e6`. Exact current-main CI run
  `30839183270` passes. The R9 branch/worktree were removed and the official score is 3.65/5.

## 2026-08-03 — R10 truthful urgent steering

- Started from clean synchronized `main` at `ba292e6eb84d94410a2ad5bb15eb283d6fcf0798`, after the
  advisory repair's exact-main CI passed. Published
  [issue #79](https://github.com/keel-harness/keel/issues/79) and created isolated branch
  `fix/tui-urgent-steering-truth`.
- Red-first tests covered exact timing copy, pending/applied ownership, control stripping, mixed
  queues, terminal dimensions, foreground priority, in-flight tools, the pre-mutation boundary,
  terminal budget, resume, and interrupt behavior. The first implementation exposed two real QC
  must-fix defects: Esc auto-started a new provider turn for pending steering, and a budget stop
  could still enter goal validation. Both received failing regressions before correction.
- Post-fix focused E2 passes **744/744** across six test files. Repository typecheck, format, and
  build passed at the product candidate point.
- The first managed `corepack pnpm test:cov` completed with **6,505 passes / 20 skips / 6 failures**;
  every failure was a loopback listener rejected by the outer execution sandbox with `listen EPERM
  127.0.0.1`. The exact unrestricted rerun passed **6,511 / 20 existing skips** across 360 passing
  files and 4 opt-in skipped files, and all enforced coverage thresholds passed. No threshold or
  test was weakened. Because a later Python-only harness regression was added, final exact-candidate
  repository gates remain to be rerun.
- The first canonical PTY attempt used an unresolved temporary root and was infrastructure-invalid.
  After correcting that setup, 80x24 still timed out despite a visible compact governed footer. A
  valid Python regression failed **1 / 7** and proved `wait_for_idle` accepted only the wide footer.
  The first attempted fix incorrectly waited for wide and compact forms sequentially; the strengthened
  red required alternatives. The final multiline alternation passes **7/7**. An earlier
  `python3 -m unittest packaging/test_smoke_urgent_steering.py` command was an invalid module-path
  invocation and is recorded as such, not as product red evidence.
- E3 normal path: the built production CLI spawned Warden, used external Click and a deterministic
  OpenAI-compatible loopback fixture, and ran at fixed 80x24 and 100x30. Both runs exited cleanly;
  each showed urgent pending then applied, performed one governed read, did not execute the next
  edit, retained one ordinary follow-up, made four total fixture requests, and left Click unchanged.
  Sanitized transcript SHA-256 values are
  `0312d3288d8f23b4fae22655fffd85b0f3ebe297840cfbcd48015e2eb18464e3` and
  `026e7ec47c972c3269b2e2f284f12549ce5a9fee131850f5a717eab74eec4cfc`; ledger hashes are
  `a154e69b454e7587e31e291f004c4d038b67b54fbc1a3030e738ce3e3efa23ff` and
  `f0bafec55fc9a980457bea840e432c1510cddfeda9e4792da79452655c25f5bf`.
- E3 budget/resume path: at 100x30 with `KEEL_MAX_GROSS_TOKENS=5000`, the first process exited 1
  with the correction visibly pending, exact resume command present, and no stale Esc hint. The
  fresh process exited 0, displayed `1 urgent correction re-applied and dispatched`, made two local
  fixture requests total, and preserved exact durable markers `[insertedAt null, insertedAt 7]`.
  The first oracle expected nonexistent status fields even though the scenario succeeded; the
  corrected oracle checks the actual durable insertion contract and passes.
- E4: four sanitized 1400x840 exact-frame transcriptions were visually inspected. Screenshot
  SHA-256 values are: pending
  `db02077af4a1c355ddab7548ab0806343a6cb707cb3819108dd846c7256e0d71`; applied
  `8ca9780c971b3035864abb0b0ac135ff9eb05847f7f0615584290ee2eedc09db`; terminal-budget pending
  `423abbdb99823389a17a4bbbc4f46ac7ef59eda2c826179f58f2e003457d4b04`; resumed applied
  `c64e7ed192d11b1027b4e80b7533d69d37a4485f43567a5f1afbcfdcb645a095`.
- E5: **NOT_RUN**. The behavior is provider-independent, all provider boundary behavior ran through
  the production path with a loopback fixture, and R10 made zero paid calls. Cumulative spend stays
  USD 2.74434625 with USD 17.25565375 remaining and the final USD 2 reserve intact.
- Five-lens QC after the two corrections: spec/ADR matches MASTER_SPEC §4.10 and ADR-0034/0036;
  the optional presentation field follows ADR-0073 and changes no frozen carrier. Security keeps
  state controller/ledger-owned, bounded, sanitized, and subordinate to approval focus. Reliability
  covers mixed queues, in-flight work, no mutation, budget, no goal-validation re-entry, same/fresh
  resume, and 80/100 columns. DX makes pending/applied/immediate timing explicit and directly
  reproduces DF-021 for R14. Simplicity adds no dependency, policy, Warden behavior, or parallel
  summary system. No unresolved must-fix remains locally.
- Final exact local gate: focused **744/744**; artifact/claim consistency **192/192**; PTY harness
  **7/7**; unrestricted `corepack pnpm test:cov` **6,511 passed / 20 existing skips**, exit 0 with
  all enforced thresholds satisfied; `corepack pnpm lint`, `corepack pnpm typecheck`,
  `corepack pnpm format`, `corepack pnpm build`, and `git diff --check` all exit 0.
- Candidate `9a970834e777cbf091280e90aec3fa9ba135515a` passed exact-head CI run `30845070144`,
  merged through PR #80 as `d397bfac33342861ec2ee11f3e650eafd24d9adc`, and passed exact
  post-merge `main` CI run `30845526192`. Candidate and squash-merge trees are both
  `686f5796647f74b411372e0509345a3875ebdf8c`. The canonical checkout was fast-forwarded cleanly;
  issue #79 closed, and the local/remote feature branch and isolated worktree were removed.
- The publication closeout changes evidence documents only; no runtime behavior or contract changes.
  Its focused artifact/claim checks passed **175/175** across four files, repository formatting and
  `git diff --check` passed, and behavior tests were therefore not repeated locally. Exact PR CI
  remains the full repository gate for the closeout commit.

## 2026-08-03 — R11 bounded terminal-command recovery

- Started from clean synchronized `main` at `2df87299e2a53f0ca8bbdab2d2850221a1121b6b`. Published
  [issue #82](https://github.com/keel-harness/keel/issues/82) and created isolated branch
  `fix/kernel-bounded-command-recovery`.
- Valid initial red failed **4 tests / 245 passed** only on the absent process-local marker and
  bounded recovery behavior. The implementation then exposed an adversarial loop: a truncated
  recovery response could re-enter model work until the turn cap. A new red regression reproduced
  it before the recovery-truncation path was made terminal.
- The final execution design keeps the original action unexecuted, accepts at most one fresh
  model-authored call, skips siblings, reuses the ordinary Warden path, and disables tools for the
  one closeout. Generic reviews, live/pending handles, denials, partial or indeterminate results,
  dead Warden, timeout, budget, deadline, and max-turn behavior remain fail-closed.
- Initial focused execution green passed **253/253**. The first unrestricted coverage run passed
  **6,518 / 20 existing opt-in skips** across 361 passing and 4 skipped files; all repository
  thresholds passed at 98.00% statements and 93.74% branches overall. Kernel measured 97.52%
  statements and 94.62% branches; the marker file measured 100%.
- The 80x24 candidate replay then exposed a must-fix: the ledger ended clean `model-stop`, but the
  compact TUI retained the original block and said `needs attention`. Red-first reconciliation now
  requires the exact no-live result, exactly one later successful tool, and a final answer. Failed
  corrections and skipped siblings remain consequential. The initial post-presentation focused
  behavior run passed **742/742**.
- A second five-lens pass found another must-fix: `result.ok` plus absent textual failure evidence
  could clear the original block even when the real Warden JSON body reported nonzero exit, signal,
  or indeterminate exit. The three production-shaped regressions failed red. Warning-decorated
  nonzero, untrusted apparent-success, and malformed-envelope cases were added before the smallest
  fail-closed parser fix; the real zero-exit envelope and legacy textual-nonzero fallback remain
  covered. The exact targeted matrix then passed **8/8** and the eight-file focused matrix passed
  **825/825**.
- E3/E4 used the production-source CLI, spawned Warden, external clean Click checkout, isolated
  non-secret fixture, `KEEL_NO_SNAPSHOT=1`, and fixed 80x24/100x30 PTYs. Baseline at each size made
  one request, recorded only the original result, ended `error/BLOCKED`, and exited 1. Candidate
  made exactly original/correction/final requests, recorded only the original and atomic results,
  ended clean `model-stop` with no code, and exited 0.
- The first PTY attempt stalled because the harness polled its request log without draining Ink
  output; it was infrastructure-invalid. A later oracle incorrectly required baseline exit 0 and
  was corrected. Transient command/final-text visibility was separated from durable ledger proof.
  These invalid harness assumptions are not counted as product failures.
- Screenshots 33–35 are sanitized exact 100x30 frame transcriptions rendered at 1400x840 and
  visually inspected. SHA-256 values are
  `01b7a91005b220ef033263956992e051986780d69b4f4d1485852eae422c681a`,
  `2a4ee331eb33c43532f4648d329bd3cb46bc9d2618724aa6858e7d67e350fa97`, and
  `358a79c1eb71b11a529259ad3d47a0948293c3c237e266ebb43fc29995f949f1`.
- E5 is **NOT_RUN**. Eight deterministic loopback requests exercise the production provider
  boundary; R11 makes zero Anthropic calls. Cumulative spend remains USD 2.74434625, USD
  17.25565375 remains, and the final USD 2 reserve is intact.
- The exact PTY oracle was repeated after the final outcome fix: all four baseline/candidate runs at
  80x24 and 100x30 passed, the result retained SHA-256 `97e78a47c85ac139dd831499e69c46bfe35e389964446b58348da3da10b4e738`,
  Click remained clean, and the request/cost counts stayed eight local / zero paid.
- Final exact local gates: artifact evidence **21/21**; unrestricted `pnpm test` **6,528 passed / 20
  existing opt-in skips** across 361 passing and 4 skipped files; unrestricted `pnpm test:cov`
  **6,528 / 20**, overall 98.00% statements and 93.73% branches with all thresholds satisfied;
  repository typecheck, lint, format, build, and `git diff --check` all exit 0.
- Five-lens QC now has no unresolved code must-fix. Spec: issue #82 scope and no frozen/shared
  change. Security: non-wire eligibility, no rewrite/replay, one-call bound, ordinary Warden
  authority, recursive-review/sibling denied paths, and untrusted-result rejection. Reliability:
  response truncation, no-call, real envelope zero/nonzero/signal/indeterminate/malformed cases,
  timeout/budget/deadline/max-turn, live/resume, and 80x24/100x30. DX: the same scenario removes the
  operator redirect and ends with a truthful recovery receipt. Simplicity: one non-wire marker, one
  explicit loop state, one bounded outcome parser, and one linear presentation reconciliation; no
  dependency or new authority.
- Candidate `d371b53` passed reviewed-head CI `30853223179`, merged through PR #83 as `cb15763`, and
  was cleaned up. The exact post-main failure and subsequent observer repair are recorded below.

## 2026-08-03 — R11 publication and P0 PTY observer repair

- R11 candidate `d371b5382df60c5ade5090f97feddd2351b77ca5` passed exact reviewed-head CI run
  `30853223179`, including DCO, build/coverage, security, sandbox-real, package, Node-next, and the
  egress matrix. It merged through PR #83 as `cb15763cf847ed4d404edf834793b36265f70360`.
  Candidate and merge trees are both `f763182c43b038dcf820badcc23be0a329e45cba`; canonical main
  was fast-forwarded cleanly and the R11 worktree/local/remote feature branches were removed.
- Exact post-main CI run `30853723890` completed red. The only product job failure was macOS package
  job `91819749594`; `ci-required` correctly failed downstream. The installed production renderer
  timed out after 20s with raw SHA-256
  `2ec55c36050786f510e75d7badcf592bed429217a57dbe7fbc4e6a8e262287ab`.
- Raw-log and local exact-carrier diagnosis reproduced that SHA. The normal retained tail showed only
  the blank composer; a secret-safe full projection showed the complete governed `sbx:on/net:on`
  row immediately before a cursor-redraw boundary and incremental composer rows. `current_frame`
  discarded the factual row when both arrived in one `os.read`, so the input probe was never sent.
  The previous green main run `30846494256` observed the same status in 794ms.
- The local executor sandbox initially produced a different, valid `sbx:off` negative because it
  denied proxy binding with `listen EPERM 127.0.0.1`; that infrastructure result was not conflated
  with the CI defect. Direct unrestricted Warden probing returned `sandbox:srt`, and all exact
  installed-carrier validation used a secret-free loopback environment.
- Published issue #84 before code. The new Python regression and its Vitest carrier both failed red
  because launch-history observation did not exist. After the narrow helper and call-site change,
  Python passes **2/2** and the Vitest carrier passes **1/1**. The positive fixture puts governed
  truth and the following redraw in one byte buffer; the negative fixture puts a newer unavailable
  row after an older governed row.
- The exact installed npm carrier then passed **6/6** consecutive macOS 80x24 real-PTY samples.
  Every sample reported `sbx:on`, `net:on`, exit 0, clean process-group teardown, readiness in
  471–615ms, and probe render in 5–6ms. No Anthropic call was made.
- Final local gates pass: Python **2/2**, focused Vitest/product **23/23**, unrestricted full tests
  and coverage **6,529 passed / 20 existing opt-in skips**, all enforced thresholds at 98.00%
  lines/statements, 93.73% branches, and 99.59% functions overall, typecheck, lint, format, build,
  and `git diff --check`.
- Repair candidate `80e5ee148f43c285c48b7d157d4bac401ceb6ae1` passed exact-head CI run
  `30855665108`, including DCO, build/coverage, security, sandbox-real, package, Node-next, and
  egress gates. PR #85 squash-merged it as `939b8c4a6fb6b15cf2c07ae7be1fc4b5de37b7e1`;
  candidate and merge trees are both `16336f345e05b3ef4e9d1a09ff5c519910251b51`.
- Exact post-main run `30856149564` passed. The formerly failing installed-carrier macOS package job
  `91827544534`, macOS/Ubuntu builds and package jobs, security, audit, real-sandbox, cross-arch,
  Node-next, egress scale/product matrices, and `ci-required` job `91829961337` are green.
- Issue #84 auto-closed. Canonical `main` was fast-forwarded cleanly; only the canonical worktree and
  local `main` branch remain, and the remote feature branch was absent/pruned. R11's evidence-bound
  aggregate is officially **3.82/5**; the stricter final release gate remains open.

## 2026-08-03 — R14 explicit interrupted-mutation state

- Started from clean synchronized `main` at `7680e7843facc2471f3799588ea21a8d004517dd` after R11's
  closeout passed exact post-main CI. Published
  [issue #87](https://github.com/keel-harness/keel/issues/87) before implementation and created the
  isolated `fix/tui-interrupted-tool-state` worktree.
- Red-first focused selection failed **4/4** for the intended old-copy reason: one generic string
  test and three urgent-control runner cases. No unrelated selected test failed.
- The final five-file E2 suite passes **576/576**. It covers not-started/in-flight/completed states,
  factless indeterminate fallback, exact occurrence identity, reused IDs, pending mutation evidence,
  liveness cleanup, all urgent verbs, headless no-color, and real Ink `TERM=dumb` output.
- Full repository lint, monorepo plus packaging typecheck, format, build, package, and
  `git diff --check` pass. Unrestricted `corepack pnpm test:cov` passes **6,539 tests / 20 existing
  opt-in skips** across 362 passing and 4 skipped files; all thresholds pass at 97.99% overall
  statements/lines and 93.71% branches.
- The first fresh npm install stalled because the isolated cache could not reach the registry in the
  managed sandbox. It was cancelled, then the same exact local tarball installed with narrow network
  permission, scripts disabled, and no global npm change; npm reported zero vulnerabilities.
- The canonical installed-carrier smoke passed `/now`, `/before-next-edit`, and
  `/stop-after-current`, four loopback requests apiece, clean exits, one durable read only, and the
  target unchanged.
- The first custom 80x24 evidence assertion looked only at the helper's live composer frame after
  the activity had moved to terminal scrollback. That was an evidence-oracle error, not a product
  failure. The corrected oracle uses the sanitized full PTY transcript for static history and keeps
  current-frame checks for stale running state.
- E3: exact 80x24 and 100x30 installed-carrier runs through spawned Warden and loopback fixture each
  passed four requests, unchanged target, read-only ledger, clean later turn, and clean teardown.
  Both transcripts contain `not started` / `this tool did not execute` and exclude the legacy copy.
- E4: screenshot 36 is a sanitized exact-text 100x30 terminal-frame transcription rasterized at
  1400x840 and visually inspected. The in-app browser was unavailable; local Quick Look plus an
  exact top crop produced the PNG. Its SHA-256 is
  `1ac83da123830f4e29adcc813d69a3d662403f2ca827699b99424006b945ec24`.
- E5: **NOT_RUN**. Twenty local-fixture requests made zero Anthropic calls. Cumulative spend remains
  USD 2.74434625, USD 17.25565375 remains, and the final USD 2 reserve is intact.
- Five-lens QC: spec/ADR preserves the pre-mutation/interrupt contract; security adds no authority or
  durable claim; reliability covers exact occurrence reuse and factless fallback; DX makes the
  stopped edit immediately understandable; simplicity adds one process-local state tracker and one
  reducer event. No local must-fix remains.
- Candidate `03a6ad2beba7eaa023b823abf4958b8e39d557c2` with tree
  `5d77488d8c28f11d5da393d5e720134c09ec58a3` passed exact reviewed-head CI run `30859417733`,
  including `ci-required` job `91839083650`.
- Owner-authorized admin squash merged PR #88 as
  `198f56f8156426aebaa0029dd36c796701eead27`; merge tree
  `5d77488d8c28f11d5da393d5e720134c09ec58a3` exactly matches the candidate. Exact post-main CI run
  `30859848006` passed, including `ci-required` job `91840336493`. Issue #87 auto-closed. The
  feature worktree, local branch, remote branch, and stale remote-tracking ref were removed/pruned;
  only canonical `main` remained before this docs-only closeout branch was created. The
  evidence-bound score is officially **3.85/5** (239/62); the strict final six-workflow gate
  remains open.
- Closeout changes evidence only; no product behavior changed, so no new red test applies. The
  artifact consistency suite passes **21/21**, repository format check passes, and
  `git diff --check` passes in the isolated closeout worktree.
- Closeout candidate `892d19fbf3152baafcba0f9e4d9a9e904018f82e` passed exact-head CI run
  `30860515588` and owner-authorized PR #89 squash-merged as
  `6f2092274c597812ea31017918808bdb01b2228b`; candidate and merge trees are both
  `35d0268020ea6c1ba217dcf2604837211da6c90a`.
- Exact-main CI run `30860586756` attempt 1 was **not green**. Node 20 job `91841765561` stopped in
  prerequisite installation before project build or tests because GitHub's runner received HTTP
  403 responses from `packages.microsoft.com` during `apt-get update`. The same commit's Node 22
  and Node 24 egress-product lanes passed, as had all three lanes in implementation-main run
  `30859848006`. Failed jobs were rerun without changing repository bytes; attempt 2 passed,
  including Node 20 egress-product job `91842800657` and `ci-required`. This is recorded as a runner
  dependency transient, not hidden and not evidence of a product regression.

## 2026-08-03 — R12 calm routine evidence density

- Started from clean synchronized `main` at `90ba14a20eb20830fac2726bfe92b1e07d5ff852`. Published
  [issue #91](https://github.com/keel-harness/keel/issues/91) and created isolated branch
  `fix/tui-routine-evidence-density`.
- Baseline exact installed carrier at 80x24 and 100x30 made thirteen loopback requests, exited 0,
  returned the composer, and rendered eight individual read rows plus four individual search rows.
  Both sanitized transcripts had SHA-256
  `bb457b2074f85b89254d1f5369565d4636c54d63a616a3c753dc76eb3bbd2306`.
- Red-first targeted run failed **2 tests / 89 passed** for the expected absent grouping. The first
  broader implementation run exposed one detailed-density regression: verbose showed both grouped
  and exact evidence. A regression was retained before narrowing grouping to normal/calm only.
- The final presentation groups only repeated successful exact `read` and `search` evidence. Counts
  precede at most two source-ordered unique examples and each line is bounded to 120 display cells.
  Singles, failures, reviews, blocked/limited/partial outcomes, mutations, and nonroutine tools
  remain exact; quiet omits and verbose/debug preserve all individual rows.
- Focused E2 passes **411/411** across conversation, headless, and real Ink. The full TUI directory
  passes **1,357/1,357**, including row budgets, input, resize, scroll, NO_COLOR, Static settlement,
  and duplicate-rerender checks. Unrestricted full coverage passes **6,545 tests / 20 existing
  opt-in skips** with all enforced thresholds. A final unrestricted JSON-reporter run repeats
  **6,545 / 20** across 1,034 passing suites with zero failures. Repository lint, typecheck, format,
  build, package, and `git diff --check` pass.
- E3 exact installed carrier passes at 80x24 and 100x30. Each makes thirteen requests, exits 0,
  restores the composer, and renders exactly one read group plus one search group. Transcript hashes
  are `63f3fc2cf9f961f7ac559c53e6e9ccf70b854d3e1d6b4e0b131740b4452c6290` and
  `eaeec91b18e84f02240d8e39e063dd87799fa425c1da2516cc6f8561ea57d60d`.
- E4 screenshots 37–38 are visually inspected sanitized 1400x840 exact-text comparison
  transcriptions. Their SHA-256 values are
  `280da6a76ecfb224b13e277f72df2144c3823e25342c57b75c169eda374d8343` and
  `4a5826db71cf71403f0d53d8a3215586f5a590fd7879f206a58dfcf56206a55d`.
- E5 is **NOT_RUN**. Twenty-six loopback requests made zero Anthropic calls. Cumulative spend remains
  USD 2.74434625, USD 17.25565375 remains, and the final USD 2 reserve is intact.
- Five-lens QC: spec/ADR stays within established density and progressive-disclosure contracts;
  security changes no authority or controller fact; reliability covers singles, failures, reviews,
  nonroutine evidence, long/repeated examples, densities, NO_COLOR, Static rerender, and two terminal
  sizes; DX preserves counts and `/verbose` inspection while removing ten rows; simplicity adds one
  bounded grouping helper and no panel, dependency, protocol, or parallel evidence system. No local
  must-fix remains.
- Candidate `ea79cf59486212ef4e818e35b94c54c13ae239fd` with tree
  `8261e69c8a0ee206da2806bc84016431e8193dc1` passed exact reviewed-head CI run `30863536934`,
  including `ci-required` job `91851489863`.
- Owner-authorized admin squash merged PR #92 as
  `2ca060e796291c5ef3cfe9608c2b7c5f53c75771`; merge tree
  `8261e69c8a0ee206da2806bc84016431e8193dc1` exactly matches the candidate. Exact post-main CI run
  `30863981683` passed, including `ci-required` job `91852829645`. Issue #91 auto-closed. The
  feature worktree, local branch, remote branch, and stale remote-tracking ref were removed/pruned;
  only canonical `main` remained before this docs-only closeout branch was created. The
  evidence-bound score is officially **3.87/5** (240/62); the strict final six-workflow gate
  remains open.
- Closeout changes evidence only; no product behavior changed, so no new red test applies. The
  artifact consistency suite passes **21/21**, repository format check passes, and
  `git diff --check` passes in the isolated closeout worktree.

## 2026-08-03 — R13 truthful credential recovery

- Started from clean synchronized `main` at `d9989dead5464221ee8bd93399971c9a501da6f2`.
  Published [issue #94](https://github.com/keel-harness/keel/issues/94) and created isolated branch
  `fix/tui-credential-recovery-truth`.
- Exact installed main carriers at 80x24 and 100x30 reproduced DF-007: successful
  `keel auth set anthropic` confirmed only the durable `0600` file write. Both transcripts shared
  SHA-256 `44b27f94e6979bd7b0de16a827891c60584cba439f2665756b43ce595beefaf0`.
- Added an exact-output regression before implementation. The red run failed **1 test / 12 passed**
  because reload/recovery guidance was absent. After implementation, focused auth coverage passes
  **13/13** and adjacent auth/store/runtime/entry coverage passes **59/59**.
- The retained implementation adds one success-only line stating that running sessions were not
  reloaded and instructing restart from the session workspace with `keel --continue`. Public auth
  guidance records the same process-start boundary. Store precedence, permissions, cancel/error
  paths, list/remove behavior, provider ownership, and secret non-disclosure are unchanged.
- Artifact consistency passes **21/21**. The first post-evidence JSON-reporter run used default
  concurrency and was killed with exit 137 before it wrote a report; this run is **not green**.
  Rerunning the identical full suite with four workers passes **6,546 tests / 20 existing opt-in
  skips** across 1,034 passing suites with zero failures. Bounded-concurrency coverage repeats
  **6,546 / 20** at 97.99% statements/lines, 93.72% branches, and 99.58% functions overall.
  Lint, typecheck, format, build, all four package carriers, and the final diff check pass.
- Clean candidate commit `19a482a4d6175c36374d5a3c8229ab23217fa0b3` produced exact tarball
  SHA-256 `a0961431a8b539998e63fdd81958811515d42092f55c7aec10f25c42c701c5ab`.
  Fixed 80x24 and 100x30 PTYs exit 0, preserve file mode `0600`, and share transcript SHA-256
  `abf5e37f35b4054ced24bb58f46f18456eea26255ffdd868ee5d93ec4481834e`.
- E4 screenshots 39–40 were rendered as sanitized 1400x840 comparison transcriptions and visually
  inspected. SHA-256 values are
  `42194b29bd32709b3a28d4de3f83f8ab3500c177cffc4af261426a263dd7b02e` and
  `bdef1bd0c30b2a3739fd8fccac36cede6c14da93c575adfaf63367153241ab1e`.
  Silent scans found no fixture value, credential-shaped string, username, or private path.
- E5 is **NOT_RUN**. Four local installed-carrier invocations make zero Anthropic calls, so
  cumulative spend remains USD 2.74434625, USD 17.25565375 remains, and the final USD 2 reserve is
  intact.
- Five-lens QC: spec/ADR matches process-start credential resolution; security preserves
  non-disclosure and `0600`; reliability covers success plus adjacent error/cancel/list/remove
  paths; DX gives short what/boundary/exact-action copy; simplicity changes one controller return,
  one regression, and two docs paragraphs. No local must-fix remains.
- Candidate `19a482a4d6175c36374d5a3c8229ab23217fa0b3` plus evidence head
  `65ffe16d384ecbe97f82440832a2ff484d404661` passed exact reviewed-head CI run `30866891254`,
  including `ci-required` job `91861618047`. PR #95 squash-merged as
  `1bbe9778d1d227f090226a3a3e07488498074d91`; candidate and merge share tree
  `ee7837f811f492983983ed986d6a3dcda8d58530`.
- Exact post-main CI run `30867327223` passed, including `ci-required` job `91863159620`. Issue #94
  closed; the remote feature branch was absent and the clean local feature branch/worktree were
  removed. The directly observed onboarding recovery score rises one point, making **3.89/5**
  (241/62) official. The strict final same-commit six-workflow gate remains open.
- Closeout changes evidence only, so no new red behavior test applies. The isolated worktree
  initially had no dependencies: direct Vitest failed `Command "vitest" not found`; plain pnpm
  9.9 failed the pnpm-10 lockfile configuration check; pinned pnpm offline install stopped on a
  missing cached `zod` tarball; and an ESM `NODE_PATH` attempt could not resolve Vitest. Reusing the
  synchronized main checkout's exact installed dependency tree through a worktree-local symlink
  then passed artifact consistency **21/21**, repository format, and `git diff --check`. None of
  the setup failures collected a test or changed source, lockfile, dependency, or product behavior.

## 2026-08-03 — R15 availability-aware focused diff review

- Started from clean synchronized `main` at `9755816d5a8b9f4b9a797ef880430df1b06e134b` under
  [issue #97](https://github.com/keel-harness/keel/issues/97) on isolated branch
  `fix/tui-diff-review-availability`.
- Baseline `/diff review` omitted a successful summary-only typed-write observation and displayed
  only `No settled diffs available to review.` The retained slice keeps authoritative unavailable
  observations and opens a focused state containing the producer-safe path/reason, verification
  truth, ADR-0079 recovery guidance, and Esc control. Available comparisons keep the existing
  bounded viewer; mixed missing rows remain secondary to the selected comparison.
- Explicit non-available producer settlement outranks contradictory activity diff bytes. Request
  arguments, summaries, output, and assistant prose cannot manufacture review evidence. No
  persistence, preimage, rollback, Warden, policy, audit, provider, dependency, or frozen-contract
  behavior changes.
- The red-first selected run passed **46/55** and failed the expected **9** new behavior tests.
  Final focused coverage passes **57/57** and adjacent TUI coverage passes **382/382**.
- A full TUI run forced into thread workers was **not green** at **1,367/1,368** because its real
  Warden fixture invokes `process.chdir`, which Node worker threads forbid. The same failure
  reproduces on clean exact `main`. The repository-compatible fork-pool run passes **1,368/1,368**
  across 48 files; no test was weakened or changed to hide the thread-worker limitation.
- The first coverage run executed **6,557 tests / 20 existing opt-in skips** without a test failure
  but failed attribution thresholds because worktree dependency symlinks resolved package imports
  to canonical `main`. After an exact frozen worktree-local install with scripts disabled,
  unrestricted coverage passes **6,557/20** at 97.98% statements/lines, 93.70% branches, and
  99.58% functions. Typecheck, lint, format, build, all four package carriers, and
  `git diff --check` pass.
- Exact installed baseline and candidate npm carriers run through real PTYs, a spawned production
  Warden, and a loopback provider at 80x24 and 100x30. Each accepted run makes two fixture requests,
  performs one legitimate summary-only typed write, records one result, exits 0 at `model-stop`,
  and returns focus after Esc. Baseline/candidate tarball SHA-256 values are
  `e87205ccaba47726b2dcbfccbccd9232a22f6859965b63c8b20cc9256783d29b` and
  `c71a66c4314584483197544ccb1470939ddabccc9ae54b85d16169cd6fdf9140`.
- Two initial candidate evidence oracles were invalid because raw substring matching did not
  normalize Ink rail wrapping. The product frame already contained the expected text; the corrected
  oracle normalizes only visible line-prefix rails and retains exact raw-frame hashes. All eighteen
  requests, including invalid attempts, stayed on loopback and made zero Anthropic calls.
- E4 screenshots 41–42 are sanitized, visually inspected 1400x840 transcriptions with SHA-256
  `941d259467d387cf4d64755877e6057c0264f6d059a12078541819de953ab2db` and
  `2814b23ea8fb720fbb62c01f47bbb14c60a9e34ee0ce4fca5ff647548026308f`.
  E5 is **NOT_RUN** because the changed state is deterministic controller presentation. Cumulative
  Anthropic spend remains USD 2.74434625, USD 17.25565375 remains, and the USD 2 reserve is intact.
- Five-lens QC repaired one adversarial must-fix before final green: explicit producer
  unavailability now defeats contradictory request-derived activity bytes. Spec/ADR, security,
  reliability, TUI/DX, and simplicity passes have no unresolved local must-fix. The candidate score
  is **3.90/5** (242/62); publication and immutable reviewed-head/main evidence remain pending.

## 2026-08-04 — R15 publication closeout

- Evidence head `686bd1d4adb3188f69c92da4051afc753d433246` passed exact reviewed-head CI run
  `30872462126`. PR #98 squash-merged as `76a45c3bec8dff17306ace5474df42992060c57d`.
- Reviewed-head and merge trees are identical at
  `93c19c163106adcd49d992751d0ff11e017e9877`; no unreviewed runtime byte entered `main`.
- Exact post-merge `main` CI run `30873064247` passed every selected gate, including Linux/macOS
  build and test lanes, Node-next, package and cross-architecture carrier smokes, security, audit,
  real-sandbox probes, egress scale/product matrices, and `ci-required`.
- Issue #97 closed. The remote feature branch was absent, and the clean local feature
  branch/worktree were removed. R15 is officially **3.90/5** (242/62); the strict same-commit
  six-workflow release gate remains open.
- This closeout changes evidence only, so no new red behavior test applies. The isolated worktree's
  first artifact and format invocations were **NOT_RUN** because `vitest` and `prettier` were absent;
  no test collected and no tracked file changed. Reusing synchronized `main`'s exact installed
  dependency tree through a worktree-local ignored symlink then passed artifact consistency
  **21/21**, repository format, and `git diff --check`.

## 2026-08-04 — R16 visible exact session-grant reuse

- Started from synchronized `main` at `3e6e435af81dc8ade93ca1b299445a97061e3971` under
  [issue #100](https://github.com/keel-harness/keel/issues/100) on isolated branch
  `fix/tui-session-grant-receipt`.
- An exact installed main carrier through a 100x30 PTY, spawned production Warden, loopback model,
  and real documentation egress reproduced the defect. `example.com` was approved for the session;
  an exact reuse auto-resolved; `example.org` opened a fresh review and was denied. The ledger and
  audit were correct, but the final Ink transcript omitted the automatic receipt.
- The product-shaped headless test passed initially while the real Ink regression failed red. A
  planner test then failed red at the exact mid-turn settlement boundary. A first broad fix was
  rejected by the full TUI property suite at **1,371 passed / 1 failed**; the random blank-system-
  message counterexample is retained and the property was not weakened.
- The narrow retained fix tags only controller approval settlements as an existing presentation
  notice and delays commit only for the latest incomplete turn with such a trailing notice.
  Focused planner, reducer, Static, headless, real-Ink, and property coverage passes. Affected groups
  pass **263/263**, **84/84**, and **15/15**; full TUI passes **1,372/1,372**.
- The first managed coverage run is **not green**: six loopback destination-guard tests received
  `listen EPERM 127.0.0.1`. The unrestricted rerun passes **6,561 / 20 existing opt-in skips**
  across 1,034 suites at 97.99% statements/lines, 93.73% branches, and 99.58% functions. Full
  typecheck, lint, format, build, four-carrier package, supply-chain check, and diff check pass.
- The exact installed candidate tarball SHA-256 is
  `8f40bfe461da20ad9c9c0ffbb374ff7e22c5e9600155900eb6a145468500e23d`. Equivalent-only
  80x24/100x30 paths exit 0 with one reuse and no second prompt. Distinct-domain paths at both sizes
  retain one reuse receipt, request a fresh decision, deny without execution, and exit 1.
- One initial 80x24 oracle attempt is invalid evidence because it expected the wide-only
  `a/s/d Enter` hint; the correct compact approval panel was visible. The corrected geometry-aware
  oracle produced the four accepted runs without a product change.
- E4 screenshots 43–44 are sanitized, visually inspected 1400x840 exact-text transcriptions with
  SHA-256 `14e2f00210ca27d6e80cdf968165e8fd608a50dd9b9f57519ee6b21110a3c241`
  and `08c44aa414a14e9c4b1f458d76ceb85c79c4d226401c7bc7a5c443102244e975`.
- E5 is **NOT_RUN**. Fourteen accepted loopback requests made zero Anthropic calls. Spend remains
  USD 2.74434625; USD 17.25565375 remains and the USD 2 reserve is intact.
- Five-lens QC found no unresolved local must-fix. Candidate
  `6f4660c8c75b6fab893726eeb80b795d1b929b7f` passed exact-head CI run `30877328734`, including
  `ci-required` job `91892229133`. Owner-authorized admin squash merged PR #101 as
  `be4fb5e4497ab26dfe898c5918f6ed77195b658a`; candidate and merge share tree
  `0a916c1ff5a3e5a7703dcd7b9481d65bebf5ea1f`.
- Exact post-main CI run `30877686690` passed, including Linux/macOS full coverage, audit, real
  sandbox, cross-architecture carrier, installed-package, security, egress, and `ci-required` job
  `91893411037`. Issue #100 closed; the remote branch was absent and the clean local feature branch
  and worktree were removed. The plan-defined score is officially **4.01/5**; the legacy pooled
  diagnostic is **3.98/5** (247/62). The strict same-commit final gate remains open.
- This closeout changes evidence only, so no new red behavior test applies. Its first format
  invocation was **NOT_RUN** because the isolated worktree had no `prettier`; no file was formatted
  or changed. Reusing synchronized `main`'s exact installed dependency tree through a worktree-local
  ignored symlink then passed artifact consistency **21/21**, repository format, and
  `git diff --check`.

## 2026-08-04 — R17 useful waiting and latency budgets

- Started from clean synchronized `main` at
  `98d8dd72536c9a5cfd8539459c9f847984388890`, published issue #103, and created isolated branch
  `docs/tui-r17-latency-budgets`. Existing code inspection found interactive-only purposeful
  liveness with a two-second reveal, coarse monotonic buckets, elapsed/quiet/timeout rows, no fake
  percentage, and an existing packaged PTY launch/input observer.
- `pnpm build && pnpm package` passed. The first `npm pack` was **not green** because npm attempted
  the sandbox-inaccessible user cache and returned `EPERM`. A task-scoped `/private/tmp` cache then
  packed the exact npm carrier; SHA-256
  `6dfdd0fc711dbe17fb96c7d35e57d76b8a407742bed506972ca468fe844da622`. The local tarball installed
  57 packages into an isolated prefix with lifecycle scripts disabled.
- The first launch measurement was **not accepted**: the outer managed sandbox rendered
  `sandbox off · egress guard off`, so the governed-ready assertion failed and the remaining loop
  was stopped. The unrestricted production-boundary repeat passed **20/20** samples: first-paint
  p95 40.666 ms, governed-ready p95 592.349 ms, idle-input p95 7.102 ms, all exits/teardown clean.
- Direct external baseline `python3 -m pytest -q -o pythonpath=src` was **not green**: one known
  subprocess interpreter case imported host Click and failed after 1,944 passes. The bounded command
  used for R17, `python3 -m pytest -q -o pythonpath=src --ignore=tests/test_types.py`, passed **1,901
  / 24 skipped / 1 xfailed** in 2.75 seconds directly and in every governed sample.
- Three calibration paths were rejected: input sent before task-Enter settlement appended to the
  prompt; `Ctrl+C` correctly interrupted instead of clearing; and one product-valid run was
  excluded after driver expectations falsely required exact completion counts and missed the
  indented quiet row. The retained driver waits for the first application-rendered response and
  uses `Ctrl+U` to clear input without steering.
- Five repeated exact installed 100x30 sessions passed through the spawned production Warden, a
  controlled loopback provider, and real external Click tests. p95 values: active input 34.923 ms,
  first controller response 10.754 ms, submit-to-tool-request 3,098.336 ms against a 3,004 ms
  fixture delay, visible request-to-execution 16.333 ms, liveness reveal 2,002.541 ms, controlled
  settlement 1,003 ms, and full task-to-idle 7,454.398 ms. All transcript hashes were identical at
  `2bf8bcf68741f2643849a166f54f8208c1915364a552e6afee78477822a4b429`.
- Every accepted frame showed `working · checking bash execution · 2s`, `quiet · 2s without
  output`, timeout, next event, and no fake percentage. Audit recorded `allow`, one requested/result
  occurrence, exact zero-exit counts, and zero review interrupts. Click remained clean.
- Screenshot 45 was rendered from an accepted sanitized frame after the in-app browser proved
  unavailable, then visually inspected at 1400x840. SHA-256
  `d790030311036f0b2c8f1d514911efb1852ec947f7cfa918afd40dd45a5bce5c`.
- Artifact consistency passes **21/21**. The first optional targeted liveness invocation was **not
  green** because the isolated docs worktree's root dependency link did not provide the package-
  local `@keel/shared` link: the pure liveness suite passed 2/2 and two integration suites failed
  collection with no tests. Adding the matching ignored package-local dependency link and changing
  no source made the identical command pass **162/162** across purposeful liveness, conversation,
  and runner steering. Repository format and `git diff --check` pass.
- DF-024 records the separate R18 finding: the authoritative exact pytest summary is not scannable
  in the final card. R17 makes no product or score change. E5 is **NOT_RUN**; all fixture traffic was
  loopback-only and cumulative Anthropic spend remains USD 2.74434625.
