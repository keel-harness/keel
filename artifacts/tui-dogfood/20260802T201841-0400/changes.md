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
- Required Anthropic E5 passed after credential replacement. One governed read returned
  `## Version 8.5.0`; with 3,435 gross tokens used, the 6,500 cap stopped before the forecast
  3,164-input-token second request. `--continue` restored seven messages and a new no-tool
  instruction returned exactly `CONTINUED.`. Ledger usage was 3,346 input / 89 output, then 3,835
  input / 6 output; incremental cost was USD 0.0168 and cumulative spend is USD 2.7277. No external
  file changed and no human Warden interrupt occurred. Reviewed-head CI `30828066275` and
  post-merge `main` CI `30828529420` passed; PR #71 merged as `5e6999c` and was cleaned up.

## Keel — R8 persistent active-task candidate

- The mutable cockpit now pairs one source-faithful `task · …` row with the existing controller-owned
  `working · …` state during provider wait, Warden request checking, tool execution, and assistant
  streaming. The row is ANSI/control-safe, secret-redacted, invisible-scalar-safe, whitespace
  normalized, and clipped at a whole grapheme to the real response width.
- Routine evidence yields row priority at 80x24 and 100x30. Focused approvals and foreground panels
  still own the viewport; settled turns and one-shot machine output receive no task chrome.
- Red-first coverage produced 13 intended failures. Focused suites pass **430/430**; the final
  unrestricted full suite passes **6,492 / 20 existing opt-in skips**. Typecheck, lint, format,
  build, and `git diff --check` pass.
- Whole-repository coverage is honestly **non-green** because the instrumented local process was
  killed with exit 137 before summary. Bounded changed-file coverage passed **250/250**:
  `conversation-block.ts` is 98.38% statements/lines and 94.94% branches; `headless.ts` is 97.83%
  statements/lines and 93.11% branches. Both clear the kernel floor; Ink is policy-excluded and
  covered by real-render tests.
- Product replay: production source CLI, spawned Warden, external Click, fixed 80x24 and 100x30
  PTYs, and a non-secret local fixture. Four fixture requests covered provider wait and assistant
  stream at both sizes; each active frame contained exactly one task row, settlement removed it,
  both sessions exited 0, and Click stayed clean.
- Sanitized visual evidence: `screenshots/26-r8-active-objective-after.png`, visually inspected at
  1400x840, SHA-256 `28f37d0d67bddd6f0733f33c7bc4c3a8ab32c38663876dacc7305bad982cf8ba`.
- Required live Anthropic E5 passed at 100x30. The task row survived provider wait, read checking,
  successful read, next-provider wait, and assistant streaming, then disappeared at settlement.
  The read returned `## Version 8.5.0`; aggregate usage was 6,999 input / 110 output (4 fresh /
  3,735 cache write / 3,260 cache hit), incremental cost USD 0.0166, cumulative USD 2.7443. No
  Warden interrupt or external mutation occurred. Exact-head CI remains the merge gate.
- Five-lens review found no must-fix: issue scope, sanitization/focus boundaries, narrow-terminal and
  Unicode behavior, before/after developer utility, and implementation simplicity all pass without
  changing authority, contracts, or dependencies.
- Reconciled behavior/artifact tests pass **469/469**; the exact candidate passes repository
  typecheck, lint, format, build, and `git diff --check`.

R8 subsequently merged through [PR #73](https://github.com/keel-harness/keel/pull/73) as
`fff2863`; reviewed-head CI `30833015213` and post-merge `main` CI `30833570464` passed. Its branch
and worktree were removed.

## Keel — R9 resumed prompt history candidate

- `--continue` and `--resume` now seed the existing interactive composer with durable ordinary
  turn-opening prompts. Fresh sessions and one-shot output are unchanged; recalled text is
  presentation state only and is never an extra model message.
- Resume reconstruction excludes in-run controller-authored user-role messages and exact
  index/content-matched steering. A red-first torn-ledger regression prevents a stale applied
  steering index from hiding an unrelated later prompt.
- One shared live/resume normalizer strips terminal controls, redacts known secret shapes, removes
  blank entries, preserves stable duplicates, and retains only the newest 100 prompts. Live submit
  still sends the exact typed prompt while retaining only its safe recall copy.
- A kernel-internal optional symbol sidecar seeds capable interactive renderers before first paint;
  unsupported/headless UiPorts remain no-ops and a late seed cannot overwrite a live or dormant
  draft. No frozen UiPort, session event, policy, audit, Warden RPC, or public CLI syntax changed.
- Valid red evidence comprised three intended behavior failures after missing-module wiring was
  separated from product behavior. The focused implementation suite now passes **337/337**.
  Repository typecheck, lint, format, build, `git diff --check`, and the unrestricted full suite
  **6,502 passed / 20 existing opt-in skips** all pass.
- The first bounded coverage selection was honestly non-green: all 337 tests passed and aggregate
  coverage was 94.34%, but the pre-existing large `session-entry.ts` orchestrator reached only 86%
  function coverage under that narrow corpus. Expanding to every test that imports the orchestrator
  passed **377/377** and the enforced per-file gate: 96.40% statements/lines, 92.59% branches, and
  98.95% functions across all changed non-Ink files. Ink remains policy-excluded and is covered by
  real-render tests and PTY evidence.
- Product comparison: current `main` versus R9 through production source, spawned Warden, external
  Click, a non-secret local fixture, and real 80x24/100x30 PTYs. Before, Up after restart left the
  draft unchanged. After, Up recalled the prior prompt, Down restored the exact draft, a second Up
  recalled again, and an edited prompt submitted. All four resumes exited 0, six fixture requests
  completed, and Click stayed clean.
- Sanitized visual evidence: `screenshots/27-r9-resume-history-before.png` and
  `screenshots/28-r9-resume-history-after.png`, visually inspected at 1400x840. SHA-256:
  `b8d6d1079e99cfe20cf7bb405438509aadede052a57702197e931fc286444c46` and
  `3184a825c5c085d01ecf2010259fe4dc268a85411e694a24c3b0431000462dd9`.
- E5 is **NOT_RUN** because provider behavior is unchanged and the same production path is fully
  deterministic with a local fixture. Anthropic spend remains USD 2.74434625. Exact-head CI,
  merge, post-main CI, and cleanup remain required.

R9 subsequently merged through [PR #75](https://github.com/keel-harness/keel/pull/75) as
`baf7db4`; reviewed-head CI `30836483686` passed. Its first post-merge run exposed a high
`brace-expansion` advisory rather than an R9 behavior failure. The separate remediation merged
through PR #78 as `ba292e6`, and exact current-main CI `30839183270` passes. The R9 branch and
worktree were removed.

## Keel — R10 truthful urgent steering

- `/now`, `/before-next-edit`, and `/stop-after-current` retain the accepted pre-mutation contract.
  Their acknowledgement now promises only `queued urgently — before the next change`; the distinct
  `Esc interrupts now` hint appears only while immediate cancellation is available.
- One bounded, sanitized, no-color-dependent presentation state shows `pending` until the controller
  inserts the urgent message, then `applied — correction is in the active turn`. A later urgent item
  behind ordinary queued input stays pending rather than inheriting another item's applied state.
- Esc aborts the active turn without auto-dispatching queued or urgent steering. Pending ledger
  state remains durable for the next explicit turn; stale Esc copy is removed after interruption.
- The gross-runway/terminal-budget preflight preserves unapplied urgent steering in the ledger,
  skips post-stop goal validation and any new provider call, and displays the exact resume command.
  Fresh-process resume distinguishes urgent corrections from ordinary comments and applies each
  exactly once before model work.
- The implementation uses an additive optional `UiUrgentSteering` presentation field. It does not
  change a serialized session/RPC/audit schema, Warden verdict, policy, mutation classification,
  sandbox, provider budget, or model-visible tool contract.
- Red-first behavior coverage includes exact pending/applied copy, control stripping, mixed queues,
  narrow row budgets, active approvals/overlays, in-flight tools, no post-boundary mutation, Esc,
  terminal budget, no post-stop goal validation, same-process next-turn application, and
  fresh-process resume.
- Focused post-fix E2 passes **744/744** across view-model, headless, real Ink, runner steering,
  REPL, and CLI entrypoint suites. The preliminary unrestricted coverage run passes **6,511 / 20
  existing opt-in skips** and all repository coverage gates outside the outer sandbox; typecheck,
  format, and build passed at that candidate point.
- The managed full-coverage attempt was infrastructure-invalid for six loopback tests (`listen
  EPERM 127.0.0.1`). The exact unrestricted rerun passed. No test or threshold was weakened.
- The first 80-column production replay found an evidence-harness defect: the PTY waiter recognized
  only the wide governed footer. A valid Python red failed **1 / 7**, then an alternative wide-or-
  compact multiline matcher passed **7/7**. The earlier `python3 -m unittest` path was an invalid
  package invocation and is not counted as product evidence.
- E3 used the built production CLI, spawned Warden, external Click, deterministic loopback provider,
  and fixed 80x24/100x30 PTYs. Both sizes showed pending then applied state; the next edit did not
  execute; ordinary follow-up remained distinct; four fixture requests completed; Click stayed
  clean. A separate 100x30 terminal-budget run stopped with the correction pending, then resumed in
  a fresh process and applied it exactly once.
- E4 adds four visually inspected, sanitized 1400x840 exact-frame transcriptions:
  `screenshots/29-r10-urgent-pending.png`, `30-r10-urgent-applied.png`,
  `31-r10-budget-pending.png`, and `32-r10-resume-applied.png`. Their SHA-256 values are
  `db02077af4a1c355ddab7548ab0806343a6cb707cb3819108dd846c7256e0d71`,
  `8ca9780c971b3035864abb0b0ac135ff9eb05847f7f0615584290ee2eedc09db`,
  `423abbdb99823389a17a4bbbc4f46ac7ef59eda2c826179f58f2e003457d4b04`, and
  `c64e7ed192d11b1027b4e80b7533d69d37a4485f43567a5f1afbcfdcb645a095`.
- E5 is **NOT_RUN** because the changed behavior is controller-owned and the production-path local
  replay covers provider boundaries deterministically. R10 made zero Anthropic calls; cumulative
  spend remains USD 2.74434625.
- Five-lens QC found and repaired two must-fix controller errors before the candidate was accepted:
  Esc previously re-drove pending steering into a new turn, and budget-stranded urgent state could
  still start goal validation. Post-fix review finds no unresolved must-fix. R10 also directly
  reproduces the pre-existing ambiguous interrupted mutation state, which remains scoped to R14.
- The reconciled exact local candidate passes focused **744/744**, artifact/claim **192/192**,
  Python harness **7/7**, unrestricted full coverage **6,511 / 20 existing skips**, repository
  lint, typecheck, format, build, and `git diff --check`.
- Signed-off candidate `9a97083` merged through
  [PR #80](https://github.com/keel-harness/keel/pull/80) as `d397bfa`. Candidate and squash-merge
  trees are identical at `686f579`; exact reviewed-head CI run `30845070144` and exact post-merge
  `main` CI run `30845526192` passed. Issue #79 closed, and the local/remote branch and isolated
  worktree were removed.

## External workload — validated local-only feature

- Commit `941ab66 feat(termui): accept PathLike filenames in edit`.
- Changed `src/click/termui.py`, `tests/test_termui.py`, and `CHANGES.md`.
- Red evidence: single-Path test failed with `TypeError: 'PosixPath' object is not iterable` before
  implementation; iterable case passed incidentally through `subprocess.Popen`.
- Green evidence: focused `2 passed, 244 deselected`; full termui `223 passed, 23 skipped`.
- Static checks: ruff/mypy/pyright **NOT_RUN** because unavailable.

## Keel — R12 calm routine evidence density

- Published [issue #91](https://github.com/keel-harness/keel/issues/91) before implementation and
  reproduced the current installed carrier at 80x24 and 100x30: eight reads plus four searches
  became twelve uncapped completion rows.
- Added a presentation-only grouping pass for repeated successful exact `read` and `search`
  evidence in normal/calm mode. Each row starts with the exact occurrence count, keeps at most two
  source-ordered unique examples, and is bounded to 120 display cells.
- `/verbose` and debug retain exact individual rows; quiet retains omission. A failure, review,
  blocked/limited/partial outcome, mutation, or nonroutine tool remains ungrouped.
- Red-first regression failed **2 / 91 selected** for the expected twelve-row output. Focused
  behavior later passed **411/411** and the full TUI directory passed **1,357/1,357**.
- Unrestricted full coverage and the final unrestricted suite pass **6,545 tests / 20 existing
  opt-in skips** with zero failures; lint, typecheck, format, build, package, and `git diff --check`
  pass. The exact installed tarball SHA-256 is
  `651a5efe94e45fabc2592dffd61ad13e4babed6d2a66777d94752489bb929878`.
- Exact-carrier E3 passes at 80x24 and 100x30 with thirteen requests, exit 0, returned composer, one
  read group, and one search group. Transcript SHA-256 values are
  `63f3fc2cf9f961f7ac559c53e6e9ccf70b854d3e1d6b4e0b131740b4452c6290` and
  `eaeec91b18e84f02240d8e39e063dd87799fa425c1da2516cc6f8561ea57d60d`.
- E4 screenshots 37–38 are sanitized 1400x840 comparison transcriptions; E5 is **NOT_RUN** because
  grouping is deterministic controller presentation and the production provider boundary was
  exercised by the loopback fixture.
- Candidate `ea79cf5` passed exact reviewed-head CI `30863536934` and squash-merged through PR #92
  as `2ca060e`; both commits have tree `8261e69`. Exact post-main CI `30863981683` passed, issue
  #91 closed, feature cleanup passed, and the official aggregate is **3.87/5** (240/62).

## Keel — R13 truthful credential recovery

- Published [issue #94](https://github.com/keel-harness/keel/issues/94) before implementation and
  reproduced the successful `keel auth set anthropic` path through the exact installed main
  carrier at 80x24 and 100x30. Baseline confirmed the `0600` store only and gave no reload or
  recovery boundary.
- Added one exact controller-owned success line: already running sessions were not reloaded, and
  recovery is to restart from the session workspace with `keel --continue`. Getting-started and
  reference guidance state the same process-start resolution boundary.
- No hot reload, provider-client replacement, precedence change, key validation, retry, Warden
  decision, policy, sandbox, audit, schema, dependency, or security claim is added.
- Red-first exact-output coverage failed **1 / 13** before implementation and passes **13/13**.
  Adjacent auth/store/runtime/entry tests pass **59/59**; unrestricted coverage, lint, typecheck,
  format, build, and all four package carriers pass. Final full tests and coverage each pass
  **6,546 / 20 existing opt-in skips**; coverage is 97.99% statements/lines and 93.72% branches.
- Exact installed baseline tarball SHA-256 is
  `40bd8bee1097d4be947f48ba070b965e3c9f667cedca21def80116f832921598`; its 80x24 and
  100x30 transcripts share SHA-256
  `44b27f94e6979bd7b0de16a827891c60584cba439f2665756b43ce595beefaf0`.
- Exact installed candidate tarball SHA-256 is
  `a0961431a8b539998e63fdd81958811515d42092f55c7aec10f25c42c701c5ab`; its 80x24 and
  100x30 transcripts share SHA-256
  `abf5e37f35b4054ced24bb58f46f18456eea26255ffdd868ee5d93ec4481834e`.
- Both terminal sizes exit 0 and preserve credentials-file mode `0600`. Silent scans prove the
  non-secret fixture, credential-shaped strings, username, and private paths are absent from all
  transcripts and screenshots.
- E4 screenshots 39–40 are sanitized, visually inspected 1400x840 comparison transcriptions with
  SHA-256 `42194b29bd32709b3a28d4de3f83f8ab3500c177cffc4af261426a263dd7b02e` and
  `bdef1bd0c30b2a3739fd8fccac36cede6c14da93c575adfaf63367153241ab1e`.
- E5 is **NOT_RUN** because successful-set copy is deterministic local controller behavior. Four
  exact-carrier PTYs make zero provider calls; cumulative spend remains USD 2.74434625.
- The first post-evidence JSON-reporter run used repository-default concurrency and was killed with
  exit 137 before writing a report; it is recorded as **not green**. The identical suite rerun with
  four workers completed all 1,034 suites with zero failures. Bounded concurrency was retained for
  the coverage repeat, which also completed green.
- Candidate `19a482a` and evidence head `65ffe16` passed exact reviewed-head CI `30866891254`, then
  squash-merged through PR #95 as `1bbe977`; candidate and merge share tree `ee7837f`. Exact
  post-main CI `30867327223` passed, issue #94 closed, and feature cleanup passed. The
  evidence-bound official aggregate is **3.89/5** (241/62); the strict final six-workflow gate
  remains open.

## Keel — R14 explicit interrupted-mutation state

- Missing-result activities now distinguish exact process-local controller observation:
  `not started`, `in flight`, or `completed without a recorded result`. The generic reducer-only
  boundary remains `indeterminate` and directs the user to workspace/audit evidence.
- The runner keys each occurrence by exact view index and provider ID, changes state immediately
  before executor invocation and on promise settlement, and removes it on authoritative
  `tool-result`. Reused IDs cannot settle another activity.
- Settlement removes liveness/live output and converts pending mutation presentation to an honest
  occurrence-ended state. No synthetic result, model message, retry, undo, durable event, audit
  claim, Warden policy, frozen schema, or file-effect inference was added.
- Red-first selected tests failed **4/4** on the old generic copy. Focused tests now pass **576/576**;
  unrestricted full coverage passes **6,539 / 20 existing skips** at 97.99% statements/lines and
  93.71% branches overall. Lint, full typecheck, format, build, package, and diff checks pass.
- Fresh installed-carrier smoke passed all three urgent verbs. Fixed 80x24/100x30 replays passed
  the same `/before-next-edit` scenario with the file unchanged, no edit result, explicit
  not-started copy, and zero paid requests. Screenshot 36 is the visually inspected after frame.
- Candidate `03a6ad2` passed exact reviewed-head CI `30859417733` and squash-merged through PR #88
  as `198f56f`; both commits have tree `5d77488`. Exact post-main CI `30859848006` passed, issue
  #87 closed, cleanup passed, and the official aggregate is **3.85/5** (239/62).

## Keel — R11 bounded terminal-command recovery

- An exact process-local marker is created only by `WardenExecutor` when a review result is
  blocked, explicitly not executed, and has no live review handle. It is non-enumerable and absent
  from shared, RPC, audit, session, event, tool, and CLI contracts.
- The loop offers one model-driven recovery pass, accepts at most the first fresh model-authored
  call, sends it through the ordinary Warden path, skips siblings, and performs one tool-disabled
  closeout. Keel does not parse, split, normalize, modify, or replay the original call.
- Only a successful correction removes the original blocked count. Failure, nonzero/no-test output,
  another review or denial, indeterminate state, no call, truncation, budget, deadline, and max-turn
  paths remain needs attention and receive no second recovery.
- Live and resumed output require the exact authoritative same-turn sequence before making the
  correction dominant. The receipt says the original reviewed action was not executed; verbose
  history and the ledger retain the original block. Skipped siblings and unsuccessful corrections
  cannot manufacture recovery.
- Red-first execution coverage found and repaired a truncated-response retry loop. The live replay
  later exposed a false `needs attention` card after clean correction; a second red-first
  presentation slice repaired it without changing Warden or execution state.
- Final adversarial review then found that transport success could clear the blocked state for a
  production-shaped Warden JSON envelope reporting nonzero exit, signal, or indeterminate exit.
  Three initial red cases failed as expected; warning-decorated, untrusted-forgery, and malformed
  cases were added before the fail-closed fix. A real zero-exit Warden envelope remains the positive
  control.
- Exact local gates pass: focused **825/825**, artifact evidence **21/21**, unrestricted full tests
  **6,528 / 20 existing opt-in skips**, unrestricted enforced coverage **6,528 / 20** at 98.00%
  statements and 93.73% branches overall, typecheck, lint, format, build, and `git diff --check`.
- E3 uses production source, a spawned Warden, external Click, a non-secret loopback provider, and
  fixed 80x24/100x30 PTYs. Baseline executes no command, ends `BLOCKED`, and exits 1. Candidate
  executes only `python3 -m pytest --version` after the original non-execution, records
  `pytest 9.1.1`, ends clean `model-stop`, and exits 0 at both sizes. Click stays clean.
- E4 adds visually inspected sanitized screenshots 33–35. E5 is **NOT_RUN**; cumulative Anthropic
  spend remains USD 2.74434625. The same 80x24/100x30 PTY oracle was repeated after the final
  fail-closed correction and retained SHA-256 `97e78a47…`, eight local requests, zero paid requests,
  and clean Click state. Candidate `d371b53` passed exact-head CI `30853223179` and merged through
  PR #83 as `cb15763` with byte-identical tree `f763182`. After the PTY observer repair below passed
  exact post-main CI, the score became officially **3.82/5** (237/62).

## Keel — P0 PTY readiness observer repair

- R11 implementation commit `d371b53` passed reviewed-head CI run `30853223179` and merged through
  PR #83 as `cb15763`; candidate and squash-merge trees are both `f763182`. Its worktree and feature
  branches were removed.
- Exact post-main run `30853723890` exposed a P0 flaky release observer in macOS package job
  `91819749594`. Keel rendered the factual governed row, but a following incremental cursor redraw
  in the same PTY read made `current_frame` discard it before the launch probe checked readiness.
- Issue #84 scopes the repair to monotonic startup observation. The observer now checks bounded,
  secret-sanitized render history for first paint, latest protection truth, and its owned input
  probe. Interactive command waits and captured evidence retain current-frame behavior.
- A deterministic Python red plus Vitest carrier failed before the helper existed. Positive coverage
  reproduces the exact governed-row/redraw ordering; a negative control proves a later unavailable
  row cannot reuse older governed history.
- The exact installed npm carrier passes six consecutive governed 80x24 samples after the fix,
  with readiness in 471–615ms, clean exit 0, and process groups reaped. No timeout, retry, security
  assertion, test, or product behavior was weakened. Python **2/2**, focused **23/23**, unrestricted
  full tests and coverage **6,529 passed / 20 existing opt-in skips**, all enforced thresholds at
  98.00% lines/statements and 93.73% branches overall, typecheck, lint, format, build, and
  `git diff --check` pass.
- Repair candidate `80e5ee1` passed exact-head CI `30855665108` and merged through PR #85 as
  `939b8c4`; candidate and merge trees are both `16336f3`. Exact post-main CI `30856149564` passed,
  including macOS package job `91827544534`, `ci-required` job `91829961337`, both platform builds,
  security, audit, real-sandbox, cross-arch, Node-next, and egress matrices. Issue #84 closed and the
  local/remote feature branch and worktree were removed.

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

## Keel — R15 availability-aware focused diff review

- `/diff review` keeps the existing bounded available-comparison viewer and now retains successful
  typed `edit`/`write` observations whose producer presentation has no review rows.
- An all-unavailable review opens one focused state with exact producer-safe path/reason, explicit
  verification truth, ADR-0079's fixed non-destructive recovery, and Esc close. Mixed reviews retain
  the selected comparison and disclose bounded missing-row counts/reasons.
- Explicit non-available producer settlement outranks contradictory/stale activity diff bytes.
  Request paths, summaries, output, and assistant prose cannot manufacture a path, comparison,
  verification, or recovery fact.
- Latest-turn verification/recovery is shown only for a selected latest-turn comparison. Earlier
  selected files receive neither. Text is control-stripped, display-bounded, and word-wrapped
  without breaking grapheme clusters.
- Unavailable observations are capped at three with an exact hidden count. Existing 32-file and
  24-review-row caps, folds/navigation, narrow fallback, NO_COLOR/dumb semantics, dormant composer,
  and approval/active-turn focus priority remain intact.
- Red-first selected coverage failed **9 / 55** before implementation and passes **57 / 57** after
  the final producer-precedence adversarial repair. Adjacent **382 / 382**, full TUI
  **1,368 / 1,368**, unrestricted coverage **6,557 / 20 existing skips**, typecheck, lint, format,
  build, package, and diff checks pass.
- Exact installed baseline and candidate npm carriers pass at 80x24 and 100x30 through a real PTY,
  spawned Warden, and loopback provider. The same successful summary-only typed write yields a
  generic no-diffs note before and the focused availability/recovery state after. Accepted runs use
  eight fixture requests total and zero paid calls.
- E4 screenshots 41–42 are sanitized, visually inspected 1400x840 comparison transcriptions with
  SHA-256 `941d259467d387cf4d64755877e6057c0264f6d059a12078541819de953ab2db` and
  `2814b23ea8fb720fbb62c01f47bbb14c60a9e34ee0ce4fca5ff647548026308f`.
- No persistence, preimage, rollback, automatic undo, workspace reread, Git inference, Warden
  verdict, policy, sandbox, egress, audit, provider, dependency, frozen contract, or security claim
  changes. Five-lens QC has no unresolved local must-fix.
- The retained change raises only observed feature user control. Reviewed head
  `686bd1d4adb3188f69c92da4051afc753d433246` passed exact-head CI `30872462126`; PR #98
  squash-merged as `76a45c3bec8dff17306ace5474df42992060c57d`. Candidate and merge share tree
  `93c19c163106adcd49d992751d0ff11e017e9877`. Exact post-main CI `30873064247`, issue #97
  closure, and feature branch/worktree cleanup passed. The evidence-bound aggregate is officially
  **3.90/5** (242/62); the strict final gate remains open.

## R16 candidate — retain automatic approval receipts across Ink history commit

- Added a production-shaped Warden/review/session-grant sequence to both headless and real Ink REPL
  coverage. One human session approval covers the later exact domain; a distinct domain remains a
  fresh deniable review. Tests assert the exact resolve calls, single pending topology, settled
  count removal, lifecycle copy, automatic receipt, and truthful final attention.
- Tagged the two controller-owned approval-settlement message constructors with the existing
  `presentation: notice` value. The transcript commit planner keeps only the latest incomplete user
  turn live when such a tagged notice trails it, allowing the later authoritative summary to enter
  append-only Ink history exactly once.
- A broader any-system-message version failed the full streaming property and was discarded. The
  retained structural tag preserves arbitrary system-message parity and lets earlier turns commit
  as soon as a later user turn proves the boundary.
- Full TUI **1,372/1,372**, full tests/coverage **6,561/20**, all enforced coverage thresholds,
  typecheck, lint, format, build, four-carrier package, supply-chain check, and diff check pass.
- Exact installed 80x24/100x30 positive and negative PTY paths pass. Screenshots 43–44 show the
  missing baseline fact and the single candidate receipt. No Warden, policy, grant, sandbox,
  egress, audit, RPC/schema, dependency, public CLI, or security claim changes.
- The local candidate reaches **4.01/5** under the plan's unweighted workflow-mean formula and
  **3.98/5** under the legacy pooled-cell diagnostic. Publication and cleanup gates remain pending.
