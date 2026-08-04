# Keel TUI dogfood — 2026-08-02

Status: in progress.

Public implementation plan: [keel-harness/keel#52](https://github.com/keel-harness/keel/issues/52).

Stack-ranked remediation program:
[ux-remediation-plan.md](./ux-remediation-plan.md). It makes the observed P0/P1 findings the first
implementation queue, defines an evidence-bound 3.8/5 release gate, and keeps 4.0/5 as a separate
stretch gate.

This evidence set records a live-provider dogfood loop against an isolated checkout of
`pallets/click`. The Keel source baseline is `a14133831f3a249a8e941c38c302f9effd61ce82`
(`v0.1.1`); live `origin/main` matched and exact-head CI run `30772162659` passed before
the branch was created.

Evidence classes are kept separate:

- E2: automated tests and headless rendering.
- E3: real PTY/product-path interaction.
- E4: fixed-size visual captures or exact-frame transcriptions, with provenance stated per slice.
- E5: live Anthropic provider calls with ledger-derived usage.

Secrets are never written to these artifacts. Captures must show neither provider
credentials nor user-home paths.

## Boundaries

- Remote work is limited to reviewable branches and pull requests; no PR merge, package publication,
  deployment, or production change is performed without the repository's independent review gates.
- External workload changes stay in a disposable local checkout.
- Keel behavior changes require red-first tests and the repo's public epic-plan gate.
- At least USD 2.00 remains reserved for final live regression testing.

## Current gate

All six requested workflow classes have live evidence. Evidence PR #53; implementation PRs #55,
#57, #59, #61, #65, #66, #68, #71, #73, and #75; repeatability PR #63; R6 evidence correction PR
#69; R10 PR #80 and closeout PR #81; R11 PR #83; PTY observer repair PR #85; dependency-
remediation PR #78; R14 PR #88; R12 PR #92; R13 PR #95; R15 PR #98; and R16 PR #101 were owner-approved,
squash-merged, and cleaned up.
Each UX
slice passed reviewed-head CI. R9's first post-merge run exposed a high `brace-expansion` advisory;
PR #78 repaired it. Exact current-main CI run `30856149564` passes at `939b8c4` after the later
validated slices and PTY observer repair. R14 then passed exact current-main CI run `30859848006`
at `198f56f`. Its evidence closeout merged through PR #89 as `6f20922`. Exact-main CI run
`30860586756` first failed before project execution when one Node 20 runner received HTTP 403 from
Microsoft's preinstalled apt repositories; the same commit's Node 22/24 lanes passed. A failed-jobs-
only rerun passed at attempt 2, including `ci-required`, so the transient remains visible without
being misreported as a product failure.

R3's safe first slice is tracked by [issue #58](https://github.com/keel-harness/keel/issues/58):
exact edit/write retries reconcile without hiding history, live and resumed receipts show
`recovered`, and malformed or ambiguous histories fail safe. Generic equivalent-bash recovery and
compaction timing remain unavailable from the existing controller facts and were not manufactured.

R4 is merged through [PR #61](https://github.com/keel-harness/keel/pull/61). Its reviewed head and
squash-merge commit have the same tree; exact PR-head CI run `30786255628` and post-merge `main` CI
run `30786694570` passed. The merged branch and worktree were removed.

R0 is merged through [PR #63](https://github.com/keel-harness/keel/pull/63) as `05452ec`. The private
eval harness parses `scenario-manifest.json` for exactly six workflows and compares normalized
controller facts with rendered claims without making policy decisions. Its credential-unset 100x30
PTY replay reproduced all eleven score axes, nineteen then-current safe screenshot checkpoint names,
and one intentional bash contradiction with zero provider calls. This is repeatability
infrastructure; it does not raise the current UX score.

R5 was tracked by [issue #64](https://github.com/keel-harness/keel/issues/64) and intentionally split
at the authority boundary. R5a merged through [PR #65](https://github.com/keel-harness/keel/pull/65):
an authenticated terminal Warden denial now exposes its exact safe recovery guidance, or explicitly
says guidance is unavailable, without changing the verdict, model-visible envelope, policy, audit,
or frozen contracts. R5b merged through [PR #66](https://github.com/keel-harness/keel/pull/66). It exposes the exact two-fact
containment rationale only when the Warden has verified sandbox-limited workspace/temp writes and
deny-all network egress. Exact reviewed-head and post-merge CI passed, and the branch/worktree were
removed.

R6 is merged through implementation [PR #68](https://github.com/keel-harness/keel/pull/68) and
evidence correction [PR #69](https://github.com/keel-harness/keel/pull/69). It acquires the existing
Warden audit writer before prompt/model work, so a concurrent resume fails with zero provider
requests, unchanged lock/ledger state, and an exact recovery command. Exact post-main CI run
`30801280763` passed; branches/worktrees were removed.

R7 merged through [PR #71](https://github.com/keel-harness/keel/pull/71) as `5e6999c`. Reviewed-head
CI run `30828066275` and post-merge `main` run `30828529420` passed; its branch/worktree were removed.
The bounded live read/continuation cost USD 0.0168 and preserved the final-test reserve.

R8 merged through [PR #73](https://github.com/keel-harness/keel/pull/73) as `fff2863`. Reviewed-head
CI run `30833015213` and post-merge `main` run `30833570464` passed; the branch/worktree were removed.
It keeps one sanitized, secret-redacted, grapheme-safe `task · …` row above controller activity
during provider wait, Warden request checking, tool execution, and assistant streaming. Routine
evidence yields row priority at 80x24 and 100x30; approvals and foreground panels retain focus;
settled and one-shot output omit the task chrome.

R9 merged through [PR #75](https://github.com/keel-harness/keel/pull/75) as `baf7db4`. It restores
bounded, sanitized ordinary prompt history after `--continue` and `--resume`, without adding
controller messages or steering to recall. Up/Down and Ctrl-R reuse the existing composer; an
unsent draft and cursor remain recoverable. Red-first E2, real 80x24/100x30 before/after E3, and two
visually inspected E4 frames pass. The provider-independent slice used only a non-secret local
fixture, so E5 is intentionally **NOT_RUN** and Anthropic spend is unchanged. Reviewed-head CI run
`30836483686` passed. Current `main`, including the advisory repair above, is green, so the
evidence-bound official score is **3.65/5**.

R10 is tracked by [issue #79](https://github.com/keel-harness/keel/issues/79) and merged through
[PR #80](https://github.com/keel-harness/keel/pull/80) as `d397bfa`. The published implementation
makes `/now` promise only `queued urgently — before the next change`, keeps `Esc interrupts now`
only while immediate cancellation is available, and renders controller-owned `pending` then
`applied` state. Esc stops without auto-dispatching queued work. If a controller budget cannot
start another provider turn, urgent steering remains unapplied and durable, the exact resume
command is shown, and a fresh process re-applies the urgent correction exactly once before work.
Focused E2, unrestricted full coverage, lint, typecheck, format, build, diff checks,
production-path 80x24/100x30 E3, and four visually inspected E4 frames pass with zero Anthropic
calls. Exact reviewed-head CI run `30845070144` and post-merge `main` run `30845526192` passed;
the candidate and squash-merge trees are both `686f579`, and the branch/worktree were removed. The
evidence-bound official score is now **3.73/5**.

The manifest now tracks thirty unique safe screenshot checkpoints after adding the four R10
pending/applied/budget/resume frames.

R11 is closed under [issue #82](https://github.com/keel-harness/keel/issues/82). An
exact process-local WardenExecutor marker now offers one model-driven recovery pass only after a
blocked, not-executed terminal review with no live handle. The controller neither parses nor
rewrites the reviewed command: it accepts at most one fresh model-authored call, sends that call
through the ordinary Warden path, skips siblings, and performs one tool-disabled closeout. Failed,
nonzero, no-test, reviewed, denied, indeterminate, absent, truncated, budget, and deadline paths
remain terminal.

The production-source CLI, spawned Warden, external Click checkout, non-secret loopback provider,
and real 80x24/100x30 PTYs passed the same scenario before and after. Baseline made one request,
executed no command, ended `BLOCKED`, and exited 1. Candidate made exactly three bounded requests,
kept the original command unexecuted, ran one model-authored `python3 -m pytest --version` through
Warden, recorded `pytest 9.1.1`, ended clean `model-stop`, and exited 0. The final TUI says `done`
with an explicit controller-derived recovery receipt; the original result stays in the ledger and
verbose history. Click stayed clean and no Anthropic call was made.

Three visually inspected sanitized 1400x840 transcriptions add before, active, and after evidence:
`screenshots/33-r11-command-recovery-before.png`,
`34-r11-command-recovery-active.png`, and `35-r11-command-recovery-after.png`. The manifest now
tracks thirty-three unique safe checkpoints. The evidence-bound official score is **3.82/5**
(237/62 applicable cells). The stricter release gate remains open on per-workflow
trust/control/final-confidence requirements and the final six-workflow exact-candidate replay.

Final adversarial review found one additional must-fix before publication: transport success could
clear the blocked state even when the real Warden JSON envelope reported a nonzero exit, signal, or
indeterminate exit. Six production-shaped negative cases failed red before the correction outcome
check was made fail-closed; a real zero-exit envelope remains the positive control. The reconciled
candidate now passes focused **825/825**, artifact evidence **21/21**, unrestricted full tests and
coverage **6,528 passed / 20 existing opt-in skips**, all enforced thresholds at 98.00% statements
and 93.73% branches overall, typecheck, lint, format, build, and `git diff --check`. The exact
80x24/100x30 PTY replay was repeated after this fix and retained result SHA-256 `97e78a47…` with
eight local-fixture requests, zero paid requests, and clean Click state.

R11 implementation commit `d371b53` passed exact reviewed-head CI run `30853223179`, then
squash-merged through [PR #83](https://github.com/keel-harness/keel/pull/83) as `cb15763` with
byte-identical tree `f763182`. The feature worktree and local/remote branch were removed. Exact
post-main run `30853723890` nevertheless failed: the
macOS installed-carrier PTY observer discarded a rendered governed status row when a later cursor
redraw arrived in the same OS read. The product rendered `sbx:on` and `net:on`; success depended on
PTY chunk timing.

The release-gate flake is tracked by [issue #84](https://github.com/keel-harness/keel/issues/84).
Its deterministic red-first fix keeps monotonic startup milestones on the bounded sanitized render
history while leaving interactive current-frame semantics unchanged. A newer unavailable/off row
still overrides older governed history. The exact installed carrier now passes six consecutive
macOS 80x24 samples with governed sandbox/egress truth and clean process-group teardown. This repair
changes no product behavior or score and uses no Anthropic call. Python **2/2**, focused **23/23**,
full tests and coverage **6,529 passed / 20 existing opt-in skips**, all enforced thresholds at
98.00% lines/statements and 93.73% branches overall, typecheck, lint, format, build, and
`git diff --check` pass locally. Repair candidate `80e5ee1` passed exact-head CI run `30855665108`
and squash-merged through [PR #85](https://github.com/keel-harness/keel/pull/85) as `939b8c4` with
byte-identical tree `16336f3`. Exact post-main run `30856149564` passed, including the formerly
failing macOS installed-carrier package job `91827544534` and `ci-required` job `91829961337`.
Issue #84 closed, the branch/worktree were removed, and R11's **3.82/5** aggregate is official.

R14 closed [issue #87](https://github.com/keel-harness/keel/issues/87). The merged implementation
replaces the blanket missing-result `execution status is unknown` card with occurrence-indexed,
process-local controller facts: `not started`, `in flight`, or `completed without a recorded
result`. A direct reducer boundary remains conservatively `indeterminate` when the runner has no
fact. No synthetic result, model message, durable event, audit claim, frozen schema, or Warden
authority is added.

Red-first E2 covers exact occurrence identity, reused IDs, pending mutation-presentation cleanup,
NO_COLOR headless/Ink rendering, and all three urgent controls. Focused **576/576**, unrestricted
full coverage **6,539 passed / 20 existing opt-in skips**, lint, typecheck, format, build, package,
and diff checks pass. The exact installed npm carrier passed all three urgent-control scenarios,
then the same `/before-next-edit` replay at fixed 80x24 and 100x30. The governed read completed,
the edit received no durable result, `target.txt` stayed unchanged, and the UI said `not started`
plus `this tool did not execute`; the old ambiguous copy was absent. All twenty fixture requests
were loopback-only and Anthropic spend stayed USD 2.74434625.

The visually inspected sanitized 1400x840 transcription
`screenshots/36-r14-interrupted-mutation-after.png` is the thirty-fourth manifest checkpoint and
compares directly with R10 screenshot 29. It raises interruption visual hierarchy and final-result
confidence by two observed points. Candidate `03a6ad2` passed exact reviewed-head CI run
`30859417733` and squash-merged through [PR #88](https://github.com/keel-harness/keel/pull/88) as
`198f56f`; both commits have tree `5d77488`. Exact post-main CI run `30859848006` passed, including
`ci-required` job `91840336493`. Issue #87 closed, the branch/worktree were removed, and the
evidence-bound official score is now **3.85/5** (239/62). The stricter final six-workflow release
gate remains open.

R12 closed [issue #91](https://github.com/keel-harness/keel/issues/91). The same
installed-carrier unfamiliar-repository fixture made thirteen deterministic loopback requests at
80x24 and 100x30. Baseline rendered eight individual reads plus four individual searches; the
candidate renders one read group and one search group with exact counts and bounded examples. The
final answer, governed footer, clean exit, and returned composer are unchanged. `/verbose` and debug
retain all exact rows, quiet retains its established omission, and consequential evidence never
groups.

Focused **411/411**, full TUI **1,357/1,357**, unrestricted full coverage and final full suite
**6,545 / 20 existing opt-in skips**, lint, typecheck, format, build, package, and
`git diff --check` pass. Screenshots 37–38 are visually inspected sanitized 1400x840 comparison
transcriptions. R12 made zero Anthropic calls, so cumulative spend remains USD 2.74434625. Candidate
`ea79cf5` passed exact reviewed-head CI run `30863536934` and squash-merged through
[PR #92](https://github.com/keel-harness/keel/pull/92) as `2ca060e`; both commits have tree
`8261e69`. Exact post-main CI run `30863981683` passed, including `ci-required` job `91852829645`.
Issue #91 closed and feature cleanup passed, so the evidence-bound official score is now
**3.87/5** (240/62). The stricter final six-workflow release gate remains open.

R13 closed [issue #94](https://github.com/keel-harness/keel/issues/94). Successful `keel auth set`
output now
separates the completed `0600` credentials-file write from the process-lifetime provider boundary:
running sessions were not reloaded, and recovery is to restart from the session workspace with
`keel --continue`. Secret-store precedence, permissions, errors, and provider construction are
unchanged.

Red-first auth coverage failed **1 / 13** before implementation and passes **13/13** after it;
adjacent auth/store/runtime/entry coverage passes **59/59**. Unrestricted coverage, lint,
typecheck, format, build, and all four package carriers pass. The final bounded-concurrency full
suite and coverage each pass **6,546 / 20 existing opt-in skips** across 1,034 passing suites;
coverage is 97.99% statements/lines and 93.72% branches overall. Clean exact installed baseline
and candidate npm carriers pass at 80x24 and 100x30 with file mode `0600`, clean exit, identical
per-carrier transcript hashes, and no credential in output. Screenshots 39–40 are visually
inspected sanitized 1400x840 comparison transcriptions. R13 makes zero Anthropic calls, so spend
remains USD 2.74434625. Candidate `19a482a` and PR head `65ffe16` passed exact reviewed-head CI run
`30866891254`; PR #95 squash-merged as `1bbe977`. Candidate and merge share tree `ee7837f`. Exact
post-main CI run `30867327223` passed, including `ci-required` job `91863159620`; feature cleanup
passed. R13 raises only observed onboarding recovery, so the evidence-bound official score is now
**3.89/5** (241/62). The stricter final six-workflow release gate remains open.

R15 closed [issue #97](https://github.com/keel-harness/keel/issues/97). The
existing `/diff review` available-comparison viewer remains intact; successful typed edit/write
observations that settle unavailable or summary-only now open an honest focused state instead of
the generic no-diffs note. Mixed reviews retain the selected comparison and disclose bounded
missing rows. Verification and recovery context appears only for the selected latest-turn
comparison and comes from existing controller facts. Explicit non-available producer settlement
outranks contradictory activity diff bytes, so request paths and assistant prose cannot become
review evidence.

Red-first focused **57/57**, adjacent **382/382**, full TUI **1,368/1,368**, unrestricted coverage
**6,557 / 20 existing opt-in skips** at 97.98% statements/lines and 93.70% branches, typecheck,
lint, format, build, all four package carriers, and diff checks pass. Exact installed baseline and
candidate npm carriers pass the same governed typed-write scenario at 80x24 and 100x30 with zero
paid calls. Screenshots 41–42 are visually inspected sanitized 1400x840 before/after
transcriptions. Five-lens QC has no unresolved local must-fix. The evidence-bound score is
**3.90/5** (242/62). Reviewed head `686bd1d` passed exact-head CI run `30872462126`; PR #98
squash-merged as `76a45c3`. Candidate and merge share tree `93c19c1`. Exact post-main CI run
`30873064247` passed, including `ci-required`; issue #97 closed and feature branch/worktree cleanup
passed. The evidence-bound score is now officially **3.90/5**. The onboarding final-confidence,
Warden-heavy control/progress, and strict final six-workflow gates remain open.

R16 closed [issue #100](https://github.com/keel-harness/keel/issues/100).
The exact installed main carrier proved a controller-correct but presentation-incomplete sequence:
one exact `example.com` session approval auto-resolved the next matching action, yet the final Ink
transcript omitted the durable automatic receipt. The retained fix marks only controller-owned
approval settlements with the existing notice presentation and keeps the latest incomplete turn
live until its authoritative summary arrives. Arbitrary system messages retain prior commit
behavior; Warden authority and scope semantics are unchanged.

Red-first Ink/planner coverage, the retained streaming property, affected **263/263** and
**84/84** groups, full TUI **1,372/1,372**, unrestricted full tests and coverage **6,561 / 20
existing opt-in skips**, typecheck, lint, format, build, all four package carriers, supply-chain,
and diff gates pass. The exact installed candidate passes equivalent-only and distinct-denial paths
at 80x24 and 100x30: exact reuse never prompts twice, a different domain always receives a fresh
decision, and the automatic receipt is visible in every accepted transcript. Screenshots 43–44 are
sanitized, visually inspected 1400x840 before/after transcriptions. Zero Anthropic calls were made.

R16 raises only Warden-heavy progress, control, and interruption burden. Reviewed head `6f4660c`
passed exact-head CI run `30877328734`; PR #101 squash-merged as `be4fb5e`. Candidate and merge share
tree `0a916c1`. Exact post-main CI run `30877686690` passed, including `ci-required` job
`91893411037`; issue #100 closed and feature branch/worktree cleanup passed. The remediation plan's
unweighted workflow-mean formula is now officially **4.01/5**; the historical pooled-cell
diagnostic is **3.98/5** (247/62). This formula mismatch is explicit rather than silently hidden.
The strict final gate remains open on per-axis and same-commit six-workflow evidence.

R17 is a validation-only measurement under [issue #103](https://github.com/keel-harness/keel/issues/103).
The exact installed main carrier passed **20/20** governed launch/input samples and **5/5** full
100x30 provider/Warden/Click samples. First paint p95 was 40.666 ms, governed-ready p95 592.349 ms,
idle input p95 7.102 ms, active input p95 34.923 ms, first controller response p95 10.754 ms, and
routine visible Warden request-to-execution p95 16.333 ms. Long quiet execution revealed at
2,002.541 ms p95 with elapsed/quiet/timeout/next truth and no fake percentage. Screenshot 45 is the
sanitized visually inspected frame. No runtime code or score changes.

The same replay directly observed DF-024 for R18: the Warden result retains exact pytest counts,
but the final visible card reduces stdout to progress dots. The plan-defined aggregate remains
**4.01/5** and the legacy pooled diagnostic remains **3.98/5** (247/62); strict final confidence and
same-commit replay gates remain open. R17 used zero Anthropic calls, so cumulative spend stays USD
2.74434625.

R18 closes DF-024 under
[issue #105](https://github.com/keel-harness/keel/issues/105). A strict presentation-only quiet-
pytest recognizer consumes only complete parsed Warden bash envelopes and puts the exact counts in
the settled tool card plus existing `ran` receipt. Failure/error counts, nonzero exits, signals,
typed partial/limited/failed states, warnings, containment, unknown output, raw authority, and
model-facing summaries remain conservative or unchanged.

Red-first regressions, focused **637/637**, unrestricted full coverage **6,584 / 20 existing
opt-in skips**, typecheck, lint, format, build, all package carriers, and supply-chain checks pass.
The clean exact npm carrier passes the same governed Click command at 80x24 and 100x30; screenshots
46-49 show progress dots before and the full `1901 passed, 24 skipped, 31000 deselected, 1 xfailed`
line after. Five-lens QC has no local must-fix. No Warden, frozen contract, dependency, security
claim, or Anthropic-cost change. Reviewed head `d7d6f2e` passed exact-head CI run `30883098433`;
[PR #106](https://github.com/keel-harness/keel/pull/106) squash-merged as `759a727`. Candidate and
merge share tree `a52f7a1`. Exact post-main CI run `30883516900` passed, including `ci-required` job
`91910698605`; issue #105 closed and the feature branch/worktree were removed. The exact checkpoint
improves, but the official six-workflow score stays **4.01/5** pending its final same-commit
canonical replay.

R19 is a validation-only input/focus matrix under
[issue #108](https://github.com/keel-harness/keel/issues/108). The clean exact installed main npm
carrier at `fa4a818` passes **10/10** selected real-PTY scenarios across 80x24 and 100x30 against
clean external Click. Multiline paste, `Ctrl+J`, history, reverse search, readline editing, native
scrollback, draft preservation through provider/tool activity and bidirectional resize, exclusive
active-panel/review/diff focus, keyboard closure, and exact draft restoration all pass. The two
genuine Warden reviews are narrowly scoped, denied, and not executed; panel interrupts start no
later tool; all process groups are reaped. Focused unchanged coverage passes **492/492**.

Screenshots 50-51 are sanitized, visually inspected 1400x840 evidence. Actual mouse text selection
is **NOT_RUN**; keyboard independence and native terminal history are proven without claiming that
surface. No product defect was reproduced, so there is no runtime, score, policy, security claim,
dependency, frozen-contract, public-CLI, or Anthropic-cost change. The official aggregate remains
**4.01/5**, the legacy pooled diagnostic remains **3.98/5** (247/62), and final same-commit
six-workflow E2-E5 proof remains open.

Reviewed head `551e97a` passed exact-head CI run `30887406100`; owner-authorized
[PR #109](https://github.com/keel-harness/keel/pull/109) squash-merged as `03de790` with identical
tree `dbb8508`. Exact post-main CI run `30887857950` passed, including `ci-required` job
`91924444645`; issue #108 closed and the feature branch/worktree were removed. Publication used
zero Anthropic calls and changes no R19 evidence boundary or score.

R21 validates unfamiliar-repository orientation under
[issue #111](https://github.com/keel-harness/keel/issues/111). The exact installed main carrier at
`8d451d6` passes deterministic 80x24/100x30 onboarding, missing-test-command, declined-trust,
missing-credential, and zero-provider-call resume controls. Startup, governed posture, persistent
objective/progress, grouped typed evidence, and recovery surfaces are strong.

The bounded live-main Anthropic result exposes DF-025: all six orientation headings are present, but
the answer is 822 words with code/tables, uses twelve shell inventory calls, performs no runtime
probe, and falsely says `pathlib.Path` is iterable. Two red-first prompt candidates improve tool
selection as far as zero bash + nineteen typed read/search calls but still fail the explicit
concision/table/probe contract. Prompt issue
[#112](https://github.com/keel-harness/keel/issues/112) therefore closed without PR or merge; its
clean branch/worktree were removed. Enforceable controller/output design is tracked by
[#113](https://github.com/keel-harness/keel/issues/113) and requires explicit public-behavior review.

Screenshots 52-58 are sanitized, visually inspected 1400x840 transcriptions. Three live R21 runs
cost exactly USD 0.68968890; cumulative spend is USD 3.43403515 and the final USD 2 reserve remains
intact. No product, Warden, policy, sandbox, egress, audit, frozen contract, dependency, public CLI,
or security-claim change is retained. Artifact consistency passes **21/21** and the unchanged focused
TUI regression passes **7 files / 819 tests**. Two earlier setup attempts remain explicitly
non-green: one failed collection without package-local dependencies, and one reached **787 passed /
32 failed** because the spawned Warden lacked its package-local workspace resolution. Onboarding
becomes **3.67/5**; the six-workflow score is corrected to **3.97/5** and the pooled diagnostic to
**3.95/5** (245/62). The 3.8 target remains green; the 4.0 stretch and strict same-commit final gate
remain open.

Reviewed head `4494978` passed exact-head CI run `30895021455`; owner-authorized
[PR #114](https://github.com/keel-harness/keel/pull/114) squash-merged as `15f991d` with identical
tree `23f203f`. Exact post-main CI run `30895569846` passed all 18 applicable or intentionally
skipped jobs, including `ci-required` job `91949010897`; issue #111 closed. The validation
branch/worktree and all six task-local roots, including every credential-store copy and audit key,
were removed after sanitized evidence merged. Publication used zero additional Anthropic calls and
does not change the R21 evidence boundary, corrected score, or open #113 must-fix.

R22 validates seven operator diagnostic/recovery paths under
[issue #116](https://github.com/keel-harness/keel/issues/116). Exact installed baseline replays at
80x24 and 100x30 passed missing credential, missing toolchain, active writer, provider failure,
token runway, and unavailable mutation-presentation paths. Removing only the private packaged
Warden sibling reproduced DF-026: Keel failed closed before provider/tool/review work and exposed no
stack or path, but gave the operator no cause or recovery action.

Issue [#117](https://github.com/keel-harness/keel/issues/117) constrained a red-first fix to the two
existing production-Warden resolution errors. The retained message explains that the installation
is incomplete/unsupported, that governed execution cannot start, and that the user should reinstall
Keel in the same package-manager scope before rerunning. Resolution order, fallback behavior,
Warden authority, policy, sandbox, egress, audit, frozen contracts, dependencies, and successful
launches are unchanged.

Focused **56/56**, full coverage, static, supply-chain, build/package, exact installed
80x24/100x30 fault replays, intact-Warden control, screenshots 59-60, and five-lens QC pass. Reviewed
head `1480b53` passed exact-head CI `30900073097`; owner-authorized
[PR #118](https://github.com/keel-harness/keel/pull/118) squash-merged as `4e774a0` with identical
tree `06f2769c`. Issue #117 closed and feature cleanup passed. R22 used zero Anthropic calls and
adds zero review interrupts. Because the diagnostic is outside the six frozen workflow rows, the
official score remains **3.97/5**, cumulative spend remains USD 3.43403515, and #113 plus the final
same-commit gate remain open.

Exact post-main CI run `30900575475` passed, including `ci-required` job `91965181411`, both
Linux/macOS build-and-coverage and package lanes, both real-sandbox lanes, audit, security,
cross-architecture carrier smokes, Node-next, egress-scale, and all three installed-product
matrices.
