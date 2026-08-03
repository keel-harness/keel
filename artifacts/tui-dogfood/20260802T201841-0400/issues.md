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
  frozen-contract decision, not part of this fix.
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
  evidence-bound aggregate is **3.85/5** (239/62).

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
