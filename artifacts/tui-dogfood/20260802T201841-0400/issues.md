# Issues found

## Confirmed setup findings

### DF-001 — public epic plan is absent

- Severity: gate/blocker for implementation, not for observational testing.
- Status: planning prerequisite resolved by public issue
  [#52](https://github.com/keel-harness/keel/issues/52). The corrected R1 slice has scoped issue
  [#54](https://github.com/keel-harness/keel/issues/54) and review candidate
  [PR #55](https://github.com/keel-harness/keel/pull/55); independent review remains required.
- Evidence: the only open public issues at orientation were release issue `#49` and compiled-proxy bug `#42`.
- Impact: repo charter forbids implementation of this cross-surface dogfood epic directly from the master spec.
- Safest action: prepare a public issue plan and obtain authorization before posting it; continue read-only dogfooding meanwhile.

### DF-002 — source-run requires outer-sandbox IPC permission

- Severity: environment/infrastructure.
- Evidence: `pnpm keel ...` initially failed with `listen EPERM` for the `tsx` IPC socket; the same commands worked outside the outer sandbox.
- Product attribution: not a Keel defect until reproduced without the outer harness sandbox.

## Workflow 1 findings

### DF-003 — resumed transcript does not seed interactive input history

- Severity: P1 usability.
- Status: fixed by R9, merged through [PR #75](https://github.com/keel-harness/keel/pull/75) as
  `baf7db4`. Resume reconstruction selects only
  ordinary turn-opening prompts, excludes structurally marked steering and in-run controller
  messages, and seeds the existing composer through a kernel-internal optional sidecar. The shared
  live/resume initializer removes terminal controls, redacts known secret shapes, removes blanks,
  preserves stable duplicates, and keeps the newest 100 entries. E2/E3/E4 and reviewed-head CI
  pass; exact current-main CI `30839183270` is green after separate dependency remediation.
- Direct evidence: after clean exit and `keel --continue`, the transcript displayed both prior
  prompts, but pressing `↑` left the composer empty. Re-pasting the task was required.
- Impact: recovery after restart is visually successful but operationally lossy; an advanced user
  cannot quickly retry or revise the last task.
- Implemented slice: seed prompt recall without changing model context, frozen UiPort, session
  schema, Warden authority, or public CLI syntax.

### DF-004 — active viewport loses the current objective under evidence volume

- Severity: P1 usability/trust.
- Status: fixed by R8, merged through [PR #73](https://github.com/keel-harness/keel/pull/73) as
  `fff2863`. One bounded active-task row now
  survives provider wait, Warden request checking, tool execution, and assistant streaming at
  80x24 and 100x30. Approval/overlay focus, settled turns, and one-shot output remain unchanged.
  E2/E3/E4/E5, exact-head CI `30833015213`, and post-merge CI `30833570464` pass.
- Direct evidence: at 100×30, the running screen showed old tool evidence and `working · assistant
  drafting`, but no current-task summary. The user had to remember which request was active.
- Impact: long tasks remain visibly alive but not self-identifying.
- Candidate fix: reserve one compact, sanitized current-objective line in the running trailer, or
  make the current-turn card outrank old evidence in the row budget.

### DF-005 — routine read-only bash evidence is repetitive and dominates the viewport

- Severity: P2 cognitive load.
- Status: fixed by R12 under [issue #91](https://github.com/keel-harness/keel/issues/91), merged
  through [PR #92](https://github.com/keel-harness/keel/pull/92) as `2ca060e`. Exact reviewed-head
  CI `30863536934` and post-main CI `30863981683` passed; issue #91 closed and feature cleanup
  passed. Normal/calm completion evidence
  groups repeated successful `read` and `search` observations by exact tool name with occurrence
  counts and two bounded examples. Verbose/debug retain exact rows; failures, reviews, mutations,
  partial/limited results, and nonroutine tools never enter the group. Exact installed-carrier
  80×24 and 100×30 replays reduce twelve routine rows to two without changing requests, Warden
  decisions, final answer, or composer recovery. The official evidence-bound aggregate is
  **3.87/5** (240/62).
- Direct evidence: the onboarding screen repeated long absolute file lists, a `what more … 11 more
  commands` row, and six separate trusted-read rows. The useful state line occupied less space than
  historical activity.
- Impact: command visibility exists, but scanning cost is high and the objective disappears.

### DF-006 — final technical summary contained a confidently false runtime claim

- Severity: P1 final-result confidence; primarily model/output quality, not yet attributed to TUI.
- Direct evidence: Keel claimed `pathlib.Path` is `Iterable[str]` and would split into components;
  a local runtime probe returned `Path_is_Iterable=False`.
- Impact: the proposed code direction may still be workable, but the stated failure mechanism and
  risk analysis are unreliable without independent verification.

### DF-007 — same-process credential replacement is not reloaded

- Severity: P2 recovery/DX.
- Status: fixed by R13 under [issue #94](https://github.com/keel-harness/keel/issues/94) and merged
  through [PR #95](https://github.com/keel-harness/keel/pull/95) as `1bbe977`. Successful
  `keel auth set` output now
  distinguishes the durable `0600` write from the unchanged running process and gives one exact
  recovery action: restart from the session workspace with `keel --continue`. Exact installed
  baseline/candidate carriers pass at 80×24 and 100×30 with the credential absent from output and
  evidence. Exact reviewed-head CI `30866891254` and post-main CI `30867327223` passed; issue #94
  closed and feature cleanup passed.
- Direct evidence: `auth set` updated the isolated credential file, but retrying in the already
  running session produced another 401; clean restart loaded the key successfully.
- Impact: the UI does not explain that credential changes require restart, causing a predictable
  duplicate failure during auth recovery.

## Workflow 2 findings

### DF-008 — review-required bash actions have no live approval path

- Severity: P0 workflow/control; enforcement remained fail-closed.
- Status: R1 presentation fix merged in PR #55. Terminal reviews are now truthfully blocked with no
  live-decision claim; policy precision and safe command-shape recovery remain open.
- Direct evidence: four `POL-003` review verdicts all carried `grantable:false, pending:false`; TUI
  copy said `no live approval` and `/reviews` was read-only.
- Impact: legitimate work dead-ends. The operator cannot inspect the exact command, approve once,
  deny, or grant a bounded equivalent scope; the model often stops instead of narrowing the shape.
- Security note: do not auto-allow these commands. The fix must connect authoritative review handles
  to the focused approval surface or explain why the action is permanently non-grantable.

### DF-009 — mutation review disappears when observation exceeds presentation limits

- Severity: P1 trust/review.
- Status: the R4 slice merged through [PR #61](https://github.com/keel-harness/keel/pull/61) as
  `01de241`. A 68,669-byte, 1,634-line mostly unchanged edit now retains bounded live evidence under
  unchanged ADR-0078 limits. Exact post-merge `main` CI run `30786694570` passed. Resume still
  truthfully says that live observations were not persisted; durable review is a separate
  frozen-contract decision, not part of this fix. R15 candidate issue
  [#97](https://github.com/keel-harness/keel/issues/97) closes the remaining process-local dead end:
  `/diff review` retains authoritative unavailable or summary-only observations, shows the exact
  producer-safe reason/path plus non-destructive recovery, and discloses mixed missing rows without
  displacing an available comparison. Local E2-E4 and five-lens QC pass; reviewed-head/main proof is
  pending.
- Direct evidence: every edit card showed `review unavailable — observation exceeded presentation
  limits`; after resume, it changed to `live mutation observations were not persisted`.
- Impact: files can change successfully while the operator sees neither a bounded diff nor durable
  mutation evidence. Recovery guidance then asks the user to review evidence that is unavailable.

### DF-010 — bash cards show a success checkmark for nonzero command exits

- Severity: P1 error comprehension.
- Status: fixed and merged in [PR #57](https://github.com/keel-harness/keel/pull/57); E2/E3/E4,
  exact-head CI, and exact post-merge `main` CI passed.
- Direct evidence: targeted pytest (`exitCode:1`) and `pip install` (`exitCode:1`) rendered as
  `tool ✓ bash done`; failure was discoverable only in truncated stdout/stderr or later prose.
- Impact: transport success is visually conflated with command success, weakening trust during the
  exact failure/revision loop this product is meant to support.

### DF-011 — concurrent resume reaches provider work before detecting audit-writer conflict

- Severity: P1 recovery/cost.
- Status: fixed by R6, merged through [PR #68](https://github.com/keel-harness/keel/pull/68), with
  evidence correction [PR #69](https://github.com/keel-harness/keel/pull/69). Every governed startup acquires
  the existing Warden audit writer before prompt/model work. Active or indeterminate ownership
  performs zero model calls and zero resumed-ledger mutation, preserves the lock, and gives a
  sanitized exact recovery command; known-dead recovery retains the existing one-time reclaim.
- Direct evidence: a second `--continue` accepted a user prompt and invoked the provider, then the
  first tool failed `AUDIT_WRITE_FAILED … already has an active writer lock`.
- Impact: the user spends tokens before learning that another session owns the authoritative audit
  writer. Preflight should detect the active session before provider invocation and show the exact
  recovery action.

### DF-012 — containment rationale is invisible for allowed package-install commands

- Severity: P1 Warden usefulness/trust.
- Status: fixed by R5b, merged through
  [PR #66](https://github.com/keel-harness/keel/pull/66) as `38d925e`; exact-head CI run
  `30795625464` and exact post-merge `main` CI run `30796233837` passed. The Warden emits one exact response-only
  rationale only after verifying the existing sandbox proof: writes are limited to workspace/temp
  and network egress is deny-all. Kernel/TUI presentation recognizes only that closed string for
  governed bash; near matches, command output, ordinary guidance, and malformed profiles cannot
  manufacture containment evidence. Its reviewed-head and post-merge CI gates passed, and the
  branch/worktree were removed.
- Direct evidence: audit allowed `python3 -m pip install --user -e …` because sandbox writes were
  workspace/temp-only and network was deny-all, but the TUI merely showed a checkmarked bash card.
- Impact: users cannot tell whether Keel allowed a risky global/network operation or safely contained
  it. The decision was structurally safe; its presentation did not communicate why.

### DF-013 — model stops after recoverable review instead of applying shown guidance

- Severity: P2 agent/workflow reliability.
- Status: fixed by R11 under
  [issue #82](https://github.com/keel-harness/keel/issues/82). Only an exact trusted
  blocked/not-executed no-handle result can offer one tools-enabled model pass; at most one fresh
  call executes through the ordinary Warden, followed by one tools-disabled closeout. The original
  action is never controller-replayed, split, normalized, or rewritten. E2 and production-path
  80x24/100x30 E3/E4 plus final full tests/coverage pass. PR #83 merged as `cb15763`; the release-
  gate observer repair in PR #85 passed exact post-main CI `30856149564`, making the 3.82 aggregate
  official.
- Direct evidence: after the first reviewed composite command, the agent reported the entire feature
  blocked instead of retrying `python3 -m pytest --version`; an operator redirect immediately worked.
- Impact: good Warden guidance does not preserve momentum when the agent fails to act on it.

## Workflow 3 findings

### DF-014 — policy denial guidance is omitted from the visible TUI

- Severity: P1 recovery/Warden usefulness.
- Status: fixed by R5a, merged through
  [PR #65](https://github.com/keel-harness/keel/pull/65) as `79f4b70`. Exact Warden guidance now appears as
  the controller-owned `next` action only for a tagged terminal denial in the kernel-authored
  envelope; absent/generic guidance remains explicitly unavailable and forged prose is not promoted.
  Exact reviewed-head CI run `30791324344` and post-merge `main` CI run `30791689948` passed.
- Direct evidence: read-before-edit denied a CHANGES edit. Audit seq 115 contained the exact action
  `read '.../CHANGES.md' before editing it`; the TUI exposed only `fix the request or command, then retry`.
- Impact: the security control was precise and recoverable, but the human-facing surface hid the
  information needed to recover safely.

### DF-015 — evidence rail preserves an obsolete denial and omits the successful retry

- Severity: P1 trust/audit comprehension.
- Status: R3 implementation candidate validated under
  [issue #58](https://github.com/keel-harness/keel/issues/58), merged in
  [PR #59](https://github.com/keel-harness/keel/pull/59) at `990f990`. Normal/headless output makes
  the exact successful retry dominant and emits a controller-owned `recovered` receipt;
  verbose/debug history retains the prior block. Exact post-merge `main` CI run `30784690703`
  passed.
- Direct evidence: audit seq 115 denied the edit, seq 116 read the file, and seq 117/118 allowed and
  completed the edit. The final evidence rail listed only the denial and read, then labeled the run
  `needs attention` / `verification not run` even though the edit and full test file succeeded.
- Impact: authoritative state and visible completion state contradict each other. A user may undo a
  valid change or rerun already completed work.

### DF-016 — gross-token exhaustion repeatedly cuts off verification without useful runway

- Severity: P1 progress/control under long tasks.
- Status: fixed by R7, merged through [PR #71](https://github.com/keel-harness/keel/pull/71) under
  [issue #70](https://github.com/keel-harness/keel/issues/70). Keel identifies cumulative gross
  runway separately from effective-cost budget, warns visibly once, and estimates the exact
  post-compaction next request before provider work. If input alone consumes the remaining cap, the
  run stops with saved-evidence and `keel --continue` guidance while successful tool/test receipts
  remain successful. E2/E3/E4/E5 and exact reviewed-head/post-merge CI passed.
  One live governed read completed, the gross preflight prevented a second call, and a fresh-budget
  continuation restored evidence and completed without another tool action.
- Direct evidence: two debugging turns stopped at the configured 300k gross-token boundary after
  making edits and running only part of the requested checks. The persistent HUD showed a large
  token count but no actionable warning before the turn began.
- Impact: long sessions consume another provider call merely to finish one or two deterministic
  commands. A pre-turn runway warning, automatic safe compaction when enabled, or a concise fresh-
  session handoff would preserve momentum.

### DF-017 — queued `/now` correction does not preempt the active model turn

- Severity: P1 user control.
- Status: fixed by R10 under [issue #79](https://github.com/keel-harness/keel/issues/79), merged
  through [PR #80](https://github.com/keel-harness/keel/pull/80) as `d397bfa`. `/now` now promises the existing
  pre-mutation boundary rather than implied cancellation, shows controller-owned pending/applied
  state, and leaves Esc as the explicit immediate control. Esc no longer auto-dispatches pending
  steering. A correction stranded by terminal budget remains durable and is re-applied exactly
  once after fresh-process resume. E2/E3/E4 and all exact local repository gates pass. Exact
  reviewed-head CI `30845070144` and post-merge `main` CI `30845526192` passed; candidate and merge
  trees are identical, and the branch/worktree were removed.
- Direct evidence: `/now Stop repeating the diagnosis...` was entered while the task was active,
  but it executed only after the current run exhausted its token budget.
- Impact: the name and interaction suggest immediacy, but the old line of work continues to spend
  tokens and can mutate files before the correction takes effect.

## Workflows 4 and 5 findings

### DF-018 — compaction triggers too late to save an otherwise completed turn

- Severity: P1 progress/cost.
- Status: diagnosis corrected and fixed by merged R7. The compactor already ran at
  the safe pre-request boundary; it cannot reclaim cumulative spend. R7 retains that ordering and
  evaluates fit from the compacted message/tool view before the provider call. Compaction remains
  opt-in and no claim is made that it reduces past gross usage.
- Direct evidence: with `KEEL_COMPACTION=1` and a 200k context target, the refactor turn completed
  all four test commands, then failed at 304k gross tokens. The `token_hard` compaction event was
  recorded immediately before the budget status; only the next turn benefited (6k-token HUD).
- Impact: compaction preserved later continuity and the steering constraint, but did not prevent the
  current turn from ending as failed or requiring another provider call for its summary.

### DF-019 — completion synthesis fabricates compaction timing

- Severity: P1 final-result confidence.
- Direct evidence: after post-failure compaction, the model claimed the session was “compacted
  mid-task” and resumed with a residual edit. Ledger ordering shows compaction happened after every
  requested test completed and just before the budget result.
- Impact: the product successfully preserved state but the final narrative misreported how recovery
  occurred. Completion claims need control-plane facts, not model reconstruction.

### DF-020 — command-shape recovery remains model-dependent and brittle

- Severity: P2 workflow burden.
- Status: fixed by R11 without granting a retry loop. A successful
  one-call correction can finish cleanly with a controller-derived `recovered` receipt; a failed,
  nonzero, no-test, reviewed/denied, indeterminate, missing, truncated, or multi-call correction
  remains needs attention and receives no second attempt. Real Warden JSON nonzero, signal,
  indeterminate, warning-decorated, untrusted, and malformed outcomes now fail closed under red-first
  tests. PR #83 merged as `cb15763`; exact post-main CI `30856149564` passed after PR #85 repaired
  the PTY readiness observer.
- Direct evidence: Keel proposed a composite command with `cd`, two node IDs, `-v`, and stderr
  redirection; after review it proposed a quoted selector plus pipe/tail. Both were non-actionable.
  The operator-provided atomic selector first matched zero tests, and Keel stopped again.
- Impact: equivalent local test work required three paid turns and manual knowledge of exact test
  names even though Warden correctly allowed the final atomic commands.

### DF-021 — successful interrupt controls are undermined by ambiguous tool-state evidence

- Severity: P2 trust; control itself worked.
- Status: fixed by R14 under [issue #87](https://github.com/keel-harness/keel/issues/87), merged
  through [PR #88](https://github.com/keel-harness/keel/pull/88) as `198f56f`. Exact reviewed-head
  CI `30859417733` and post-main CI `30859848006` passed; issue #87 closed and cleanup passed. R10's
  production-path pending frame independently reproduced the old
  `execution status is unknown` evidence while proving that urgent steering and Esc work.
- Direct evidence: `/before-next-edit` visibly queued and was applied at the requested boundary;
  `Esc` promptly produced a durable saved-session interrupt note. However, the boundary event also
  rendered `edit ... execution status is unknown`, and later mutation reviews were unavailable.
- Impact: the user can steer and stop reliably, but must inspect the diff independently to know
  whether the interrupted edit happened.
- Repair: the runner tracks exact tool-card index plus provider ID from request through invocation
  and executor settlement. Missing-result activities render `not started`, `in flight`, or
  `completed without a recorded result` only from those observed process-local facts; factless
  reducer settlement stays `indeterminate` and tells the user to inspect workspace/audit evidence.
  The UI emits no synthetic tool result and makes no file-effect or undo claim.
- Validation: five focused suites pass **576/576**; unrestricted coverage passes **6,539 / 20
  existing opt-in skips**; the installed carrier passes all three urgent verbs and fixed
  80x24/100x30 replays with the file unchanged, no edit result, and zero paid requests. Screenshot
  36 is the sanitized after frame; R10 screenshot 29 is the before comparison. The official
  evidence-bound aggregate is **3.85/5** (239/62). R15 separately makes a later authoritative
  unavailable/summary-only observation inspectable through `/diff review` rather than falling into
  the generic no-diffs note; exact candidate E3/E4 passes locally under issue #97.

### DF-022 — installed-renderer readiness smoke depends on PTY read chunking

- Severity: P0 flaky release gate.
- Status: fixed under [issue #84](https://github.com/keel-harness/keel/issues/84). Candidate
  `80e5ee1` passed exact-head CI `30855665108`, merged through PR #85 as `939b8c4` with byte-identical
  tree `16336f3`, and passed exact post-main CI `30856149564`. The formerly failing macOS package
  job `91827544534` and `ci-required` job `91829961337` are green.
- Direct evidence: exact R11 post-main run `30853723890`, macOS package job `91819749594`, failed
  after 20s with raw SHA-256 `2ec55c36050786f510e75d7badcf592bed429217a57dbe7fbc4e6a8e262287ab`.
  A secret-safe full projection proves Keel rendered
  `protection: governed · sbx:on · net:on · policy:Guided · audit:on`; the observer kept only the
  composer fragment after a same-read cursor boundary. The immediately prior green main run saw
  readiness in 794ms.
- Impact: byte-equivalent correct TUI output can pass or fail the package gate solely because the OS
  split the same PTY bytes differently. Rerunning can hide the defect and falsely bless main.
- Repair: monotonic launch milestones inspect bounded sanitized history and choose the
  latest protection row. A later unavailable/off row remains negative. Six consecutive exact-carrier
  macOS samples pass after the change with clean teardown and no reduced-enforcement acceptance.

### DF-023 — exact session-grant reuse is durable but absent from Ink transcript

- Severity: P1 Warden trust and interruption burden.
- Status: fixed by R16 under [issue #100](https://github.com/keel-harness/keel/issues/100), merged
  through [PR #101](https://github.com/keel-harness/keel/pull/101) as `be4fb5e`. Exact reviewed-head
  CI `30877328734` and post-main CI `30877686690` passed; candidate and merge trees are identical,
  and feature cleanup passed.
- Direct evidence: the installed main carrier accepted one exact `domain example.com` session
  approval, auto-resolved the second matching action, and opened a fresh review for
  `domain example.org`. The session ledger contained one `warden_auto_resolved` event and the audit
  contained all requested/resolved pairs, but the completed Ink transcript omitted the reuse fact.
- Impact: the correct lack of a second prompt looked unexplained. A developer could not distinguish
  bounded controller reuse from a skipped check or silent policy widening without reading the
  ledger.
- Root cause: an approval-settlement system message split the latest user turn into a trailing loose
  block. Ink committed that turn before `run-finished` attached its authoritative automatic
  summary, then discarded its incremental state.
- Repair: tag only controller-owned settlement notices with the existing presentation type and keep
  the latest incomplete turn live across that notice. No grant, equivalence, policy, or enforcement
  behavior changes.
- Validation: full TUI **1,372/1,372**, unrestricted full tests/coverage **6,561/20**, static/build
  gates, exact installed 80x24/100x30 positive/negative matrix, sanitized E4, and five-lens QC pass.

### DF-024 — exact test outcome is not scannable in the completion state

- Severity: P1 final-result confidence; repaired by R18 under
  [issue #105](https://github.com/keel-harness/keel/issues/105).
- Status: fixed by R18 in [PR #106](https://github.com/keel-harness/keel/pull/106), merged as
  `759a727`. Exact reviewed-head CI `30883098433` and post-main CI `30883516900` passed; candidate
  and merge trees are identical, issue #105 closed, and feature cleanup passed.
- Direct evidence: five exact installed-carrier sessions ran the same Click command successfully.
  The authoritative Warden result retained `1901 passed, 24 skipped, 31000 deselected, 1 xfailed`
  with exit zero. The final bash card showed a success state but reduced visible stdout to progress
  dots, while the deterministic model fixture said only that the suite completed. The exact counts
  were absent from every byte-identical visible transcript.
- Impact: the user can tell the command succeeded, but cannot verify the test total, skips, or
  expected failure from the one-screen completion state. This weakens the existing onboarding
  final-confidence floor and supports R18's requirement for concise controller-owned
  `changed / verified / risk / next` evidence.
- Constraint: R18 must derive test truth from the existing authoritative tool/controller result,
  preserve failed/partial prominence, and build on R3 rather than treating model prose as proof or
  creating a second summary authority.
- Repair: a strict presentation-only quiet-pytest recognizer consumes only complete parsed Warden
  bash envelopes. The settled tool card and existing `ran` receipt show every recognized count in
  producer order; unknown output falls back unchanged. Exit, signal, typed failure/limited/partial,
  warning, containment, and contradictory failure-count truth remain dominant.
- Validation: red-first parser/view/Ink cases, focused **637/637**, unrestricted full coverage
  **6,584/20**, static/build/package/supply-chain gates, and the exact installed-carrier 80x24 and
  100x30 before/after matrix pass. Screenshots 46-49 show progress dots before and the full
  `1901 passed, 24 skipped, 31000 deselected, 1 xfailed` line after. No Warden or frozen contract
  changes; five-lens QC has no unresolved local must-fix.

### DF-025 — explicit concise onboarding can end long and factually ungrounded

- Severity: P1 final-result confidence, cognitive load, and trust.
- Status: fixed under [issue #113](https://github.com/keel-harness/keel/issues/113), merged through
  [PR #121](https://github.com/keel-harness/keel/pull/121) as `7c8ff68`. Exact reviewed-head CI
  `30929433667` and exact post-main CI `30929922987` passed; candidate and merge share tree
  `99d8fda9`; issue #113 closed and feature branch/worktree/task-root cleanup passed. R21 validation
  [issue #111](https://github.com/keel-harness/keel/issues/111) closed through merged evidence
  [PR #114](https://github.com/keel-harness/keel/pull/114).
  The prompt-only behavior issue [#112](https://github.com/keel-harness/keel/issues/112) was closed
  without merge after two live candidates failed its acceptance gate. Enforceable public-output
  design is tracked by [issue #113](https://github.com/keel-harness/keel/issues/113).
- Direct evidence: the exact installed main carrier completed the frozen Click onboarding prompt
  with zero review, clean exit, and all six orientation headings, but used 12 shell `find`/`grep`
  calls, no typed search, no runtime probe, and an 822-word answer with code blocks and tables. It
  falsely said `pathlib.Path` is iterable and yields path parts; the direct Python probe shows no
  `__iter__` and `list(Path(...))` raises `TypeError`.
- Impact: the user can follow activity and find architecture/build/test sections, but cannot trust
  the proposed compatibility plan without independently validating runtime claims, and must scan
  several screens despite asking for concise output.
- Failed repair evidence: red-first prompt candidate `263f511` reduced discovery to 0 bash + 10
  read + 9 search and correctly self-corrected the failure description. It still emitted 568 words
  plus a table and ran zero probes. Focused 28/28, broader 828/1 existing skip, static/build, exact
  package, deterministic PTY, and live E5 evidence passed around the prompt change, but the actual
  user contract did not.
- Constraint: do not add more prompt prose, silently truncate output, hide failure/Warden evidence,
  re-execute tools, or add an unbounded rewrite call. Preserve the raw redacted transcript and
  controller-owned outcome truth. Any controller/public-output change needs explicit owner review.
- Repair candidate: accepted ADR-0087 adds an explicit task-scoped 40–2,000-word contract, at most
  one tools-disabled bounded rewrite, durable original/rewrite/settlement metadata, deterministic
  fallbacks, `/answer N|clear|full`, one-shot `--final-max-words`, and explicit original inspection.
  It neither silently truncates nor repeats a tool. An exact-carrier PTY exposed and fixed a generic
  overlong-single-line panel defect before the candidate was accepted.
- Validation: full coverage passes **6,665 / 20 intentional opt-in skips**; static/package gates,
  exact installed accept/length/error/tool/cancel/resume/trust/auth/Warden-denial controls, and
  80x24/100x30 real PTY pass. One live exact-carrier run rewrites a 1,273-word original to a
  241-word primary, requests zero Warden reviews, and marks unprobed behavior unverified.
- Score candidate: onboarding cognitive load and trust return from 3 to 4; final confidence rises
  from 2 to 4. The onboarding mean is **4.11/5**, the six-workflow unweighted candidate mean is
  **4.04/5**, and the pooled diagnostic is **4.02/5 (249/62)**. Publication gates are green; the
  strict same-commit replay remains open.

### DF-026 — packaged-Warden startup failure is fail-closed but not recoverable by the operator

- Severity: P1 error recovery and operator trust.
- Status: fixed under [issue #117](https://github.com/keel-harness/keel/issues/117), merged through
  [PR #118](https://github.com/keel-harness/keel/pull/118) as `4e774a0`. Exact reviewed-head CI run
  `30900073097` and exact post-main CI run `30900575475` passed; candidate and merge share tree
  `06f2769c`; issue #117 closed and feature branch/worktree cleanup passed.
- Direct evidence: the exact installed baseline was copied to an owner-only fault root and only its
  private `bin/keel-warden.mjs` sibling was removed. At both 100x30 and 80x24 Keel exited 1 before
  any provider call or human review, emitted no path or stack, but said only
  `keel: packaged warden entry is unavailable`.
- Impact: security stayed fail-closed, but the user could not tell that the installation was
  incomplete or how to recover. The safest likely response was guesswork: retrying could not help,
  while deleting state or bypassing the Warden would be wrong.
- Repair: the same two controller throws now identify the unavailable Warden, explain that governed
  execution cannot start from an incomplete/unsupported installation, and direct the user to
  reinstall Keel in the same package-manager scope before rerunning. The runtime deliberately does
  not guess a local/global/transient npm command.
- Validation: red-first negative-layout tests, all positive resolution controls, focused **56/56**,
  full coverage and static/build/package gates, exact clean installed 80x24/100x30 fault replays,
  intact-Warden control, sanitized screenshots 59-60, and five-lens QC pass. Resolution order,
  fail-closed control flow, Warden authority, frozen contracts, dependencies, and security claims
  are unchanged.

### DF-027 — production-length identity metadata hides the 80x24 composer

- Severity: P1 responsive usability and command discoverability.
- Status: closed through [issue #123](https://github.com/keel-harness/keel/issues/123) and
  [PR #124](https://github.com/keel-harness/keel/pull/124). Candidate `1a46d01` and merge `67e317d`
  share reviewed tree `2474522`; exact-head and post-main CI are green.
- Direct evidence: exact installed main rendered the complete command palette as 25 physical rows
  at an 80x24 terminal. Its 83-cell model/workspace/trust identity wrapped `trusted` onto a second
  line and pushed the composer outside the viewport. The existing row-budget fixture used a short
  model and masked the defect.
- Repair: whenever a known width above the existing narrow breakpoint cannot hold the full metadata
  line, reuse the established fact-priority candidates and grapheme-safe truncator. Unknown-width
  output and <=60-column ordering remain unchanged.
- Validation: intended red **3 failed / 233 passed**; focused green **236/236**; compatibility
  **247/247**; full tests and coverage **6,668/6,668 with 20 intentional opt-in skips**; exact
  nine-profile installed matrix; real Kitty 100x30; real Apple Terminal 100x30 to 80x24 resize;
  screenshots 65-69; five-lens QC. The repaired palette is 24 rows and retains model identity,
  workspace trust, protection truth, keyboard guidance, and composer.
- Publication: exact-head run `30936094264` and exact post-main run `30936677719` passed. Issue
  #123 closed automatically with the merge.
- Boundaries: no Warden verdict, policy, sandbox, egress, grant, audit, public CLI, frozen contract,
  dependency, or security-claim change. Native Linux terminal-emulator validation is **NOT_RUN**.

### DF-028 — mandatory snapshot contention pushes governed-ready tail over budget

- Severity: P1 perceived-startup responsiveness.
- Status: fixed and merged under [issue #127](https://github.com/keel-harness/keel/issues/127) and
  [PR #129](https://github.com/keel-harness/keel/pull/129) as `be1c900`. Exact reviewed-head CI
  `30946864248` passed and the reviewed/merge trees are identical. Exact post-main CI exposed the
  separate release-observer DF-030; product startup evidence remains green.
- Direct evidence: exact-carrier distributions total 40 governed launches. Combined governed-ready
  p95 is 1,049.076 ms; 10/40 samples are at or above the spec's 750 ms target and 3/40 exceed the
  R17 1,000 ms observational bound. All samples still render honest first paint, reach governed
  posture, accept application-owned input, exit zero, and reap their process group.
- Diagnosis: disabling only the disposable run-start snapshot for a diagnostic 20-launch ablation
  yields p95 631.637 ms / max 673.559 ms. The production snapshot is mandatory and remains enabled;
  code inspection and component timing show it currently contends with parallel Warden startup.
- Retained repair: sequence Warden readiness before the still-pre-action snapshot, use the safe
  recursive-copy fast path only when the private destination is outside the workspace, overlap the
  cosmetic Git probe with Warden, and collapse its branch/status work to one bounded process. The
  snapshot still settles before any model, steering, task, or tool action.
- Validation: exact clean carrier `e95032b`, tarball SHA-256
  `0798d3036ed17ff5b15c09e1cb91ff738f05dc8327f7eb6f2a3d90e0f6e69299`, passes two independent
  20-run distributions at governed-ready p95 673.149/718.369 ms. Combined p95 is 714.515 ms; first
  paint, input ownership, exit, and complete process-group teardown pass. Full coverage passes 6,669
  tests with 20 intentional opt-in skips. Two earlier candidates and one uncommitted metadata-
  concurrency experiment remain rejected rather than threshold-adjusted.
- Boundaries: no snapshot default/opt-out, post-action backup, timeout/retry, threshold change,
  Warden/enforcement/audit change, dependency, telemetry, frozen contract, or public CLI change.

### DF-029 — packaged full-process-group RSS remains outside generic confidence

- Severity: P1 resource confidence; existing named residual P1-007.
- Status: open/accepted only as a named pre-alpha residual; R23 and the bounded #140 optimization do
  not promote it to green.
- Direct evidence: first/confirmation dense peak p95 values are 247,152/244,432 KiB for the complete
  Kernel + Warden group—inside the scoped 256 MiB R23 alert bound but not the separate `<150 MB`
  generic Kernel 200-turn target. The protocols are not identical, so no cross-protocol percentage
  claim is made.
- Settlement evidence: absolute settled p95 passes the frozen 224 MiB R23 bound in both runs, but
  one confirmation sample grows 26,176 KiB from its own initial idle, exceeding the frozen 16 MiB
  allowance. It is retained as a failure rather than discarded or normalized away.
- Issue #140 evidence: production-shape profiling found 61,998,278 bytes of GC-normalized live heap
  and localized one avoidable empty ordinary-turn presentation projection. PR #141 removes only
  that work. Two 150-turn × 12 KiB comparisons improve normalized growth by 1,196,032 and
  33,652,736 bytes versus control, a 17,424,384-byte mean, but the exact signed-head confirmation
  still grows 90,980,352 bytes and exceeds the absolute product gate. #140 is closed; P1-007 is not.
- Boundaries: no threshold relaxation, heap/RSS conflation, compatibility claim, or optimization
  without a separately scoped performance issue and exact measurement.

### DF-030 — PTY release observer loses a CRCRLF-terminated current frame

- Severity: P0 flaky release gate; product behavior remained correct.
- Status: fixed under [issue #130](https://github.com/keel-harness/keel/issues/130), merged through
  [PR #131](https://github.com/keel-harness/keel/pull/131) as `32f3346`. Reviewed head `259fdfc`
  passed exact-head CI `30949551544`; reviewed and merge trees are identical; exact post-main CI
  `30950106016` passed the original macOS package lane and every required aggregate.
- Direct evidence: exact post-main run `30947409856` failed only macOS package job `92120753973`.
  The raw stream showed the palette cleared and blank composer rendered, but a `CRCRLF` sequence
  projected to only `"\n"` when delivered in one read. The unmodified observer failed 4/8 local
  reproductions.
- Impact: a correct installed carrier can block release nondeterministically, destroying trust in
  the gate and skipping dependent product matrices.
- Repair: candidate `546476a` consumes one consecutive CR run, interprets a following LF as a
  completed line ending, and preserves bare-CR redraw plus malformed/incomplete-control rejection.
- Validation: red-first exact captured frame; focused 7/7 Python and 30/30 Vitest; 20/20 repeated
  exact-carrier PTYs; unrestricted full coverage 6,669 passed with 20 intentional skips; static,
  build, package, fresh scripts-disabled carrier, teardown, and five-lens QC green.
- Boundaries: no retry, relaxed timeout/predicate, renderer/product behavior, Warden authority,
  security claim, frozen contract, dependency, score, or provider spend change.

### DF-031 — a near-bound rewrite falls into honest but unhelpful fallback

- Severity: P1 final-result reliability and cognitive load.
- Status: fixed under [issue #133](https://github.com/keel-harness/keel/issues/133), merged through
  [PR #134](https://github.com/keel-harness/keel/pull/134) as `8f0363f`; exact merged-carrier
  all-six replay remains pending.
- Direct evidence: exact installed `main` at `01eca273` produced a 976-word onboarding original and
  one 253-word tools-disabled rewrite against ADR-0087's 250-word hard maximum. Keel correctly
  settled `fallback-oversized`, retained the original, ran no rewrite tool, requested no Warden
  review, and left Click clean. A three-word approximate counting miss nevertheless removed the
  otherwise useful primary answer.
- Diagnosis: the controller rewrite prompt stated only the hard maximum, leaving no tolerance for
  approximate model-side word counting. Controller enforcement and fallback were correct and are
  not weakened.
- Retained local repair: preserve the exact hard word/byte limits while asking for a deterministic
  90% preferred word target. Omit unsupported runtime specifics rather than repeating them with an
  `unverified` label. Minimum/observed/maximum tests and a 200-case full-range property preserve
  positive headroom.
- Validation: two mechanically compliant candidates were rejected for unsupported runtime prose.
  Candidate `305b8b1` produces a factual 223-word / 1,854-byte primary under the 250-word / 16,000-
  byte contract, keeps Click clean, and requests zero reviews. Focused **15/15**, final-answer
  adjacency **1,114/1,114**, full **6,673 passed / 20 intentional skips**, coverage, static,
  build/package, exact live E5, screenshot 70, and correctly configured real sandbox **18/18** pass.
- Publication: reviewed head `147cd75` passed exact-head CI `30956020646`; candidate and merge share
  exact tree `351d42d`; exact post-main CI `30956531938` passed required aggregate `92152127274` and
  every selected lane. Issue closure and feature branch/worktree cleanup passed.
- Boundaries: no retry, truncation, oversize acceptance, typed contract, schema, ModelPort, Warden,
  policy, sandbox, egress, audit, dependency, public CLI, or security-claim change. No score credit
  is added; this repairs reliability of the already credited #113 onboarding outcome.

### DF-032 — bounded final answer invents an unsupported runtime mechanism

- Severity: P0 trust/final-result confidence for repository onboarding.
- Status: fixed under [issue #136](https://github.com/keel-harness/keel/issues/136), merged through
  [PR #138](https://github.com/keel-harness/keel/pull/138) as `4588bfa`; the first exact merged
  onboarding repetition passes human semantic review. Full all-six repetition remains pending.
- Direct evidence: exact merged carrier `9a9e40a` passed its mechanical oracle but claimed that a
  bare `pathlib.Path` iterates character by character. The run had inspected only source; no
  preceding tool result demonstrated a runtime mechanism. The statement is also false on the
  measured runtime.
- Failed approaches: three ordinary-system-prompt candidates exited zero and met the hard answer
  contract, but human QC rejected false character iteration, an unproved list/type failure, and a
  return to the original false mechanism. A harness PASS is not treated as semantic truth.
- Repair: with explicit owner approval, retain one tools-disabled rewrite but require direct
  preceding tool evidence for runtime claims; source, types, original prose, and an `unverified`
  label do not count. Unsupported predictions become source-level control flow plus an explicit
  unknown without a named failure mechanism.
- Validation: red-first 3-case failure; focused 40/40; full and coverage 6,673 passed / 20 existing
  opt-in skips; static/build/package; exact candidate tarball; two independent live runs with zero
  reviews, clean Click, exit zero, factual primary answers, and exact costs USD 0.33683610 and USD
  0.82259265. Screenshot 71 and session log 31 retain sanitized evidence.
- Publication: reviewed head `c1cb8d7` passed exact-head CI `30961206113`; exact post-main CI
  `30961587248`, issue closure, and branch/worktree cleanup passed.
- Boundaries: no second model call, retry, semantic grader/classifier, phrase filter, forced
  execution, hard-limit change, new state, dependency, schema, ModelPort, Warden, policy, sandbox,
  egress, audit, grant, RPC, public CLI, or security-claim change.

### DF-033 — successful terminal correction disables the feature's remaining tool lane

- Severity: P0 task-completion trust, feature workflow, and controlled recovery.
- Status: open under [issue #139](https://github.com/keel-harness/keel/issues/139); implementation is
  **NOT_RUN pending explicit owner authorization** because the change affects public recovery
  behavior adjacent to Warden terminal-review handling.
- Direct evidence: in the first exact-main feature replay, Warden correctly rejected a composite
  tooling probe as terminal `POL-003` with no approval handle and did not execute it. Keel allowed
  one safe atomic correction, `python3 -m pytest --version`, which succeeded. It then disabled tools
  for the recovery lane. The model described intended edits/tests, the TUI rendered completion and
  exited zero, but the frozen Click workspace remained unchanged.
- Impact: the user receives a clean completion surface for a feature that was neither implemented
  nor tested. Warden's correct least-privilege decision becomes a dead end, so task trust and
  recovery control fail even though security enforcement worked.
- Required boundary: preserve terminal no-handle semantics, original non-execution, atomic-shape
  correction, policy authority, audit fidelity, and bounded recovery. The next safe slice must let
  ordinary work continue after the successful correction without converting terminal review into
  an approval or weakening Warden.

- Current status: implemented and locally validated on signed PR #142 head `edc9ea59`; exact-head CI
  passes. Publication is held because two required live user-outcome replays remain red. The first
  proves the corrected continuation path before a later second terminal review; the second keeps a
  review-required `uv run` correction terminal. #139 code has no unresolved local must-fix, but its
  end-to-end definition of done is unmet.

### DF-034 — routine tooling discovery repeatedly drives the agent into terminal review

- Severity: P0 feature-completion reliability and Warden-friction interaction.
- Status: prompt-only implementation is complete and locally/CI green on PR #142 head `38f21afb`,
  but live validation failed and the PR remains unmerged. A structural continuation is **NOT_RUN
  pending separate owner approval** because controller transformation and another recovery pass are
  explicit #143 non-goals.
- Direct evidence: two exact-carrier #139 replays performed extensive read-only diagnosis but no
  edit. One resumed successfully after the first correction, then stopped on a later compound
  `which`/`pip show`/`grep` query. The other selected `uv run mypy --version` as its bounded
  correction, which correctly remained review-required. Both exited 1 with clean Click.
- Safest boundary: shape unrelated discovery/version/status intentions into separate calls and
  report unavailable optional checkers `NOT_RUN`; do not relax Warden, add recovery attempts, or
  transform commands in the controller.
- Prompt-only outcome: the final exact carrier removed named version/package-manager preflights from
  the observed trajectory but did not make the model obey the broader rule. It still emitted two
  `| head` pipelines and `find ... | xargs grep ... 2>/dev/null`; the last correctly reached terminal
  POL-003, the single atomic correction exited 1, and the model stopped with a clean workspace.
  This is evidence that prompt text alone is insufficient for the P0 completion outcome.
- Structural diagnosis: Warden's result is correct and must remain unchanged. The smallest safe
  continuation is situational guidance in the existing controller-owned one-call recovery message:
  route read-only file discovery to typed `search`/`read`, whose no-match result is a successful
  observation, while reserving bash for one atomic requested command. This adds no retry, rewrite,
  authority, or Warden change. It remains **NOT_RUN pending separate owner authorization**; the full
  contract trace, rejected alternatives, TDD matrix, and USD 1.25 validation cap are recorded in
  session log 34.

### DF-035 — feature replay prompt confounds recovery validation with dependency setup

- Severity: P0 feature-completion reliability; P1 cognitive load and cost.
- Status: open; directly observed on exact signed #144 candidate `3b21d2a`; public issue #144 and PR
  #142 remain open.
- Direct evidence: the model requested `pip show ... 2>&1 | grep ...` availability inventory even
  though the ordinary system prompt says not to inventory tools. Warden correctly returned a
  terminal POL-003 no-handle review without execution. Recovery then batched four
  `python3 -m ... --version` checks with `&&`; the call exited 1 on missing mypy, so the monotonic
  #139 recovery correctly closed terminally.
- User impact: after 18 provider calls and USD 0.26713935, Keel produced a plausible implementation
  plan but no edit. Click stayed clean, the independent runtime probe remained red, and the TUI
  settled `needs attention` with `BLOCKED_AFTER_SYNTHESIS`.
- What worked: exact controller wiring is deterministic; the original reviewed action did not run;
  the correction remained Warden-gated; a failed correction did not reopen recovery; zero human
  prompts were shown.
- Confounder: #144 targets terminal *file-discovery* recovery, but this run reached a dependency/tool
  availability review. The scenario says to request narrow setup if dependencies are missing, while
  its expected outcome says unavailable static checks should be reported. The result therefore does
  not isolate #144's intended branch.
- Boundary: #144 forbids Warden relaxation, another recovery, tool filtering, or controller command
  transformation. The second live replay is NOT_RUN under #144's predeclared stop rule; any
  corrected-oracle replay or structural product slice needs separate review.

### DF-036 — one task-global recovery credit expires despite later verified progress

- Severity: P0 feature-completion reliability; P1 cost and user-control burden.
- Status: directly reproduced by corrected-oracle replay on exact `3b21d2a`; implementation NOT_RUN
  pending an accepted recovery-budget decision.
- Direct evidence: an early compound pytest-version probe received non-grantable, non-pending
  POL-003 review. Its one atomic correction succeeded and ordinary tools resumed. The agent then
  made two typed edits to `tests/test_termui.py`, proving meaningful workspace progress. A later
  requested pytest command included redundant `cd` and `2>&1`, received another correct POL-003
  result, and could not use recovery because the process-global flag remained exhausted.
- User impact: after 31 provider routes and USD 0.85785450, Keel stopped with an honest plan and one
  reviewable test-file diff but did not run the red test, implement the feature, update CHANGES, or
  verify the outcome. Restarting would repeat costly context acquisition and TDD work.
- Warden judgment: both actions were `grantable:false`, `pending:false`, not executed, and avoidable
  through simpler commands. Policy remained fail-closed; no Warden relaxation is supported.
- Recommended bounded design: earn at most one additional task-wide recovery credit only after an
  authoritative successful typed workspace mutation. Preserve one model-authored call per credit,
  ordinary Warden gating, sibling rejection, exact command bytes, and terminal closeout for every
  failed/ambiguous/reviewed correction. Reads, searches, prose, opaque bash, failures, and correction
  success alone must not refresh credit.
- Boundary: this changes #139/#144's normative monotonic recovery budget and therefore requires an
  accepted ADR and explicit owner authorization before implementation. Reclassifying POL-003,
  broadening its allow set, automatic command rewriting, unlimited retries, and semantic-equivalence
  inference are rejected.
- Decision status: public issue #145 and proposed ADR-0088 PR #146 now define the bounded slice.
  Signed docs head `222cf69` passes exact-head CI `31016337581` and required aggregate
  `92341536526`. Behavior implementation remains **NOT_RUN** pending explicit ADR acceptance.

### DF-037 — bounded correction repeats forbidden output wrappers before useful progress

- Severity: P0 feature-completion reliability; P1 cost efficiency.
- Status: directly reproduced on exact PR #142 head `5e2625f`; public issue #149 scopes the smallest
  follow-up. Implementation and another provider replay are **NOT_RUN** pending explicit approval.
- Direct evidence: the ordinary agent requested `python3 -m pytest --version 2>&1 | head -3`.
  Warden returned a non-grantable, non-pending POL-003 result and did not execute it. The bounded
  correction then requested `python3 -m pytest tests/test_termui.py -x -q 2>&1 | tail -5`, receiving
  the same correct terminal result.
- ADR-0088 judgment: the first correction failed and no ordinary typed mutation occurred. The new
  controller therefore correctly earned no final credit and closed tools. This run neither refutes
  nor validates the progress-earned refresh path.
- User impact: 12 provider routes and USD 0.69344145 were spent before repository inspection or
  mutation produced a reviewable result. Click remained clean and the feature outcome stayed red.
- Recommended smallest slice: correction-local prompt guidance that explicitly prohibits the
  observed `--version`, `2>&1`, `| head`, and `| tail` shapes and asks for one direct requested test
  command. Do not relax or rewrite Warden policy, widen recovery, or alter command bytes.
- Stop rule: permit at most one newly budgeted replay after deterministic prompt regressions and
  explicit owner approval. If the same class fails again, stop prompt-only iteration and plan a
  separately reviewed typed verification-intent architecture.

### DF-037 validation update — targeted behavior fixed, strict workflow still red

- Status: implemented on PR #142 head `487ddf7`; deterministic/full/security/carrier gates and
  exact-head CI `31040649898` pass. The one authorized provider replay is complete.
- Direct positive evidence: Warden rejected one pytest request containing `2>&1 | head -40`; the
  fresh bounded correction removed both wrapper components, emitted the direct requested pytest
  command, succeeded, and returned to ordinary typed work. No `--version`, `2>&1`, `| head`, or
  `| tail` appeared in the correction. This is a material improvement over `5e2625f`.
- Remaining strict blocker: the same run stopped at gross-runway preflight after 672,173/700,000
  cumulative tokens, with the next request estimated at 41,694. It left a two-file partial diff,
  omitted `CHANGES.md` and `_termui_impl.py`, exited 1, and failed the independent runtime and test
  oracle. Thus #149's complete three-file definition is unmet despite fixing its targeted command
  shape.
- User impact: useful red-first work and two typed edits now survive the review boundary, but the
  developer still receives a partial unverified implementation and must reason about continuation.
  The run cost USD 0.62484855 and opened zero actionable human prompts.
- Verdict: no prompt-only rollback is justified by this evidence, but no merge or score promotion is
  justified either. A second replay is NOT_RUN under the explicit one-run authorization. Any next
  product slice or additional provider validation requires a separate owner decision.

### DF-037 final-regression closeout — local fix retained, end-to-end gate failed

- Status: final owner-authorized replay completed on exact PR #142 head `175f3dd`; PR #142 is closed
  unmerged, while issue #149 remains open.
- Direct positive evidence: the first wrapper-bearing pytest-version request was correctly not
  executed, and its fresh correction ran the direct requested pytest command successfully. Typed
  red-first tests and edits followed. This independently confirms the narrow #149 behavior.
- Remaining P0 reliability defect: after progress, the agent's local-source test request used an
  environment-assignment shell shape that received terminal POL-003 review. Its final correction
  then requested `pip install -e . -q && ...`, violating the task's explicit no-install boundary,
  and exited 127. Keel synthesized an honest partial result but did not produce a successful public
  exit.
- Strict outcome: only `src/click/termui.py` and `tests/test_termui.py` changed; `CHANGES.md` did not.
  Independent runtime and full termui tests passed against local `src`, but the exact three-file and
  public-exit gates failed.
- Warden judgment: zero actionable human prompts; two avoidable terminal diagnostics. Warden's
  fail-closed decisions were correct, and no policy relaxation is supported.
- Verdict: prompt-only iteration is exhausted under the published stop rule. Any continuation should
  be a separately reviewed typed verification-intent/tool architecture rather than more recovery
  prose, shell-byte rewriting, or weaker POL-003 classification. Implementation and additional
  provider validation are **NOT_RUN** pending a new public scope and owner authorization.
