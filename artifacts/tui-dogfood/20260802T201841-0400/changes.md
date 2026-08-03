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
- Signed-off reviewed head `9e10c7f` passed exact-head CI run `30788707053`; PR #63 squash-merged
  as `05452ec`. Candidate and merge trees are identical, exact post-merge `main` CI run
  `30789072222` passed, and the branch/worktree were removed.

## Keel — validated R5a actionable Warden denial guidance

- Public parent issue [#64](https://github.com/keel-harness/keel/issues/64) splits denial recovery
  from allowed-action containment so each slice uses only existing authoritative facts.
- A terminal `blocked` tool result in the exact kernel-authored
  `blocked by warden (not executed):` envelope now renders `what · why · next`, with the Warden's
  safe guidance as `next`. Empty or generic guidance says recovery guidance is unavailable and
  points to `/why-blocked`; it is never inferred.
- Promotion requires the controller-owned `blocked` presentation tag as well as the closed envelope.
  An ordinary or model-authored failed edit that copies the text cannot manufacture Warden evidence.
- Guidance is ANSI/control stripped, redacted at the executor boundary and again at presentation,
  normalized to one line, and bounded to 120 display cells. Existing terminal-review recovery copy
  still takes precedence.
- A real 100x30 PTY reducer replay exposed and fixed a live-edit ordering defect that the initial
  direct-view test missed. Live and resumed history now present the same exact recovery.
- Product evidence is `screenshots/22-r5a-denial-guidance-after.png`, a sanitized terminal-frame
  transcription of the real-PTY replay. It is not labeled as a live Kitty capture.
- Green evidence: focused **473 passed**; full kernel **4,075 passed / 2 existing skips**; unrestricted
  full suite **6,456 passed / 20 existing opt-in skips** with enforced coverage at 98.02% statements
  / 93.73% branches. Repository typecheck, lint, format, build, and diff check passed.
- Provider usage is zero. Policy verdicts, grantability, Warden enforcement, model-visible result
  bytes except secret redaction, audit/session/event/RPC schemas, and CLI behavior are unchanged.
- Signed-off reviewed head `ce11311` passed exact-head CI run `30791324344`; PR #65 squash-merged
  as `79f4b70`. Candidate and merge trees are identical, exact post-merge `main` CI run
  `30791689948` passed, and the branch/worktree were removed.

## Keel — R5b verified containment rationale candidate

- The Warden now attaches one exact response-only containment rationale to an allowed or warned
  governed-bash result only when its existing proof verifies sandbox enforcement, nonempty bounded
  filesystem roots, strict deny-all egress, and the contained-arbitrary-code policy classification.
- The exact public copy contains only two facts: `writes limited to workspace/temp` and `network
  egress deny-all`. It does not expose policy-pack internals, path roots, or profile structure.
- Kernel promotion is bash-only and exact-match. Near matches, arbitrary allow guidance, command
  stdout that copies the line, control-byte suffixes, and high-entropy suffixes cannot manufacture
  containment evidence.
- Final adversarial QC found and fixed a reserved-prefix collision: ordinary custom policy guidance
  that begins with the closed containment sentence is now response-namespaced as policy guidance
  before it crosses the Warden boundary. Its authoritative audit value is unchanged, and it cannot
  masquerade as a verified containment fact.
- Live and resumed TUI paths parse the existing governed-bash envelope after removing only the exact
  closed rationale. Nonzero commands remain failed; warning guidance, stderr, stdout, and output
  limits retain their existing precedence and bounds.
- The Warden audits the original policy decision before constructing the response-only view. A
  spawned-Warden product test proves the durable session receives the exact rationale while the
  signed audit decision remains unchanged and the chain verifies.
- Red-first evidence: initial focused red **4 failed / 568 passed**; after tightening the public copy
  and adding allow/warn adversarial cases, second red **7 failed / 568 passed**. Final QC added a
  third red for the reserved-prefix collision (**1 failed / 320 skipped**) before its focused green.
  Final focused green across Warden, executor, reducer, product-path, and Ink was **755 passed**.
- Full unrestricted coverage passed **6,467 tests / 20 existing opt-in skips** at 98.02% statements,
  93.73% branches, 99.58% functions, and 98.02% lines. Real SRT probes passed **18/18** after the
  checked-in test CA was configured before Node startup. Typecheck, lint, format, build, and diff
  check passed.
- Product evidence: a credential-unset 100x30 real PTY run through the production source CLI,
  spawned Warden, and vendored SRT executed `python3 -m pip --version` in the external Click
  workspace. The TUI showed the two verified facts plus real stdout; the Click test file remained
  green at **227 passed / 23 skipped** and its worktree stayed clean.
- Exact-head CI's first package job exposed a stale carrier oracle that parsed durable Bash output
  as raw JSON. Its self-test was changed first and failed on the real closed containment prefix; the
  parser now requires and removes only that exact prefix, rejects missing and near-match forms, and
  preserves its nonzero oracle. A freshly built, packed, installed local npm carrier then passed the
  strengthened exact final-response smoke.
- `screenshots/23-r5b-containment-after.png` is a visually inspected 1400x840 sanitized
  terminal-frame transcription of the exact PTY text, not a live window capture; SHA-256
  `9e3a99f8f56223e42466d7d44a1fbc8845a92310b707f025b818014b58b63d0e`.
- Provider usage is zero and the historical Warden interrupt count is unchanged. Policy verdicts,
  grantability, enforcement, sandbox profiles, model/tool contracts, audit/session/event schemas,
  and public CLI contracts are unchanged.

## Keel — R6 concurrent-resume preflight candidate

- Every governed run now acquires the existing Warden-owned audit writer during startup by appending
  the existing `session.start` event before prompt consumption or model work.
- Concurrent resume fails before paid work with a sanitized session ID and exact supported recovery
  command. Active and indeterminate ownership preserve the existing lock, make zero model calls,
  and do not mutate the resumed ledger. A known-dead lock retains the existing one-time reclaim.
- The existing `AUDIT_WRITE_FAILED` response adds only response-local lock-state metadata; no RPC
  schema, audit event, policy verdict, enforcement rule, or public CLI contract changed.
- Red evidence: **5 failed / 104 skipped**, then an RPC red of **1 failed / 321 skipped**. Green:
  directly affected suites **431/431**; unrestricted full suite **6,471 passed / 20 existing opt-in
  skips**; changed writer **95.95% statements/lines, 96.77% functions, 93.33% branches**.
- Product evidence: real production-source CLI, spawned Warden, external Click checkout, and
  100x30 PTY. The blocked run exited 1 with zero provider requests and unchanged owner lock; clean
  owner exit released it; retry exited 0 with one local-fixture request and a valid audit chain.
- Sanitized visual evidence: `screenshots/24-r6-concurrent-resume-after.png`, SHA-256
  `bdb193d28c9db3b38b3fa6ceab3b7b37201cb6ba41015898d9b477bd51f7eea6`. The exact committed
  absolute path was visually inspected after correcting the initial bad crop. Provider usage: zero.

## Keel — R7 gross-token runway preflight candidate

- Gross-token runway now has a separate one-shot warning identity from the effective-cost budget.
  Both the human and model receive the same bounded controller copy with used, cap, remaining, and
  continuation semantics.
- After the existing optional compactor boundary and before `model.stream`, Keel estimates the exact
  next request's messages and tools. If estimated input alone consumes the remaining gross cap, it
  makes no provider call and emits `GROSS_RUNWAY_PREFLIGHT` with saved-evidence guidance.
- The terminal outcome renders as `stopped`, keeps a successful read/test receipt successful, and
  includes `keel --continue`; the recorder persists the exact controller warning already sent to
  the model. Compaction stays default-off.
- Red-first coverage exercised metric identity, separate/one-shot/shared-state warnings,
  equal/one-token-fit boundaries, post-compaction fit, invalid thresholds, durable copy, TUI
  hierarchy, and production wiring. Focused green was **524/524**, final loop **170/170**, and the
  end-to-end walking skeleton **4/4**.
- Unrestricted full suite: **6,481 passed / 20 existing opt-in skips**. Local macOS coverage executed
  the suite but remains non-green on unrelated existing per-file gaps; all changed production files
  exceed the kernel floor. Final candidate typecheck, lint, format, build, and diff check passed.
- Product evidence: production source CLI, spawned Warden, external Click, local non-secret fixture,
  and a fixed 100x30 PTY. One governed read succeeded; a distinct 48k/50k warning appeared; the
  5,538-token forecast stopped the second call with 2,000 remaining; `--continue` restored evidence
  and completed in one fresh run. Fixture counter: exactly one request at stop, two after resume.
- Sanitized visual evidence: `screenshots/25-r7-gross-runway-after.png`, visually inspected at its
  exact worktree path, 1400x840, SHA-256
  `96e15ce2009e68791b786eb81ca23441922e911ac554b70319dbf2ae112fb703`.
- Required Anthropic E5 is **BLOCKED**: the configured credential was present but rejected as invalid
  on the first bounded measurement call. It reported zero usage, was not retried or exposed, and
  cumulative spend remains USD 2.7109. The candidate is not merge-ready until E5 and exact-head CI.

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
