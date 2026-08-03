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
