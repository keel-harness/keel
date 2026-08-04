# Warden interrupt audit

## Counting rule

Count each operator decision request once. Distinguish policy denial from human review,
and distinguish one-time, session, and project scopes. A repeated prompt is equivalent
only when capability, resource boundary, reversibility, and supply-chain risk match.

| ID | Workflow | Requested action | Decision | Scope offered | Necessary? | Burden | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W-001 | Feature | composite pytest version probe | review; not executed | none; no live approval | avoidable shape | high | audit seq 47 |
| W-002 | Feature | `git diff` | review; not executed | none; no live approval | yes; mutable Git execution metadata | high | audit seq 68 |
| W-003 | Feature | `uv run … pytest …` | review; not executed | none; no live approval | yes; unknown tool/supply-chain setup | high | audit seq 78 |
| W-004 | Interrupt | `uv --version` | review; not executed | none; no live approval | excessive for version probe | high | audit seq 79 |
| W-005 | Refactor | composite pytest with `cd`, two node IDs, `-v`, and redirection | review; not executed | none; no live approval | avoidable shape | high | session 2 audit seq 10 |
| W-006 | Refactor | quoted collect-only selector piped to `tail` | review; not executed | none; no live approval | excessive/avoidable diagnostic | high | session 2 audit seq 13 |

Totals: 6 review interrupts; 2 judged necessary; 4 judged excessive/avoidable; 0 offered an
actionable live decision. A separate `pip install --user -e …` action was allowed because the real
sandbox constrained writes to workspace/temp and denied all network; it failed under PEP 668.

## Automatic denials (not counted as human review interrupts)

| ID | Workflow | Action | Verdict | Precision | Presentation |
| --- | --- | --- | --- | --- | --- |
| D-001 | Debugging | edit `CHANGES.md` before a current-session read | denied, then recovered | justified and narrowly scoped | poor: audit guidance named the exact prerequisite, but TUI hid it and later omitted the successful retry |

## R1 validation outcome

The six historical interrupt counts above are unchanged: the R1 replay exercised the same terminal
review class but offered no operator decision, so it is validation evidence rather than a seventh
human interrupt.

Before R1, the terminal result was labeled `review needed` and its evidence claimed a human decision
was required despite `grantable:false`, `pending:false`. After R1, the same Warden verdict and exact
executor bytes render as `blocked`, explicitly state that no live decision exists, and provide the
supported atomic rerun path. The stale terminal-only `ask for approval` clause is suppressed.

This improves timing, explanation, cognitive load, and recovery honesty. It does **not** reduce
review frequency, change policy precision, add approval scope, or weaken enforcement. Those remain
separate security-sensitive follow-ups.

## R3 validation outcome

R3 introduced no new human review interrupt, so the historical totals remain 6 total / 2 necessary
/ 4 excessive or avoidable. Its deterministic replay exercised automatic denial D-001 through the
real Warden path: the first edit was blocked before execution by read-before-edit, the corrective
read succeeded, and the exact retry completed.

Before R3, the final presentation could retain or silently suppress the obsolete block without
stating that the sequence recovered. After R3, normal/headless output shows the successful edit and
one controller-owned `recovered` fact; verbose/debug keeps the original blocked attempt. Warden
verdicts, policy, audit records, model-visible tool results, grantability, and enforcement are
unchanged.

## R4 validation outcome

R4 introduced no human review interrupt or automatic denial, so the historical totals remain 6
total / 2 necessary / 4 excessive or avoidable. The deterministic replay performed a current-session
read followed by one Warden-allowed typed edit of a 1,634-line file.

Before R4, the edit succeeded but the Warden's optional presentation constructor exhausted its
2,000,000 scalar-operation budget and the TUI could show only generic unavailability. After R4, the
same decision, mutation, audit sequence, and safety limits produce bounded controller evidence by
factoring exact common edges before the middle comparison. Genuinely divergent middles still settle
`capture-budget`; policy, grantability, enforcement, sandboxing, audit, redaction, frozen carriers,
and resume persistence are unchanged.

## R0 validation outcome

R0 introduced no Warden action, review interrupt, automatic denial, provider call, or policy
classification, so the historical totals remain 6 total / 2 necessary / 4 excessive or avoidable.
Its comparator accepts only already-decided controller lifecycle facts paired with rendered states
and emits deterministic presentation mismatch codes. It cannot receive a command, grant scope, or
emit allow/review/deny. Policy, grantability, enforcement, audit, and frozen schemas are unchanged.

## R5a validation outcome

R5a introduced no human review interrupt, so the historical totals remain 6 total / 2 necessary /
4 excessive or avoidable. Its deterministic replay exercised automatic denial D-001: a typed edit
was denied before execution because the target had not been read in the current session.

Before R5a, the TUI reduced the precise Warden guidance to generic retry copy. After R5a, the same
tagged terminal denial and exact kernel-authored envelope render the safe prerequisite as `next`.
Empty or generic guidance reports that recovery guidance is unavailable; untagged failures and
model prose cannot create the authoritative recovery line. Guidance is control-stripped, redacted,
and display-bounded.

The verdict, classification, grantability, timing, model-visible denial envelope, policy, sandbox,
audit, and frozen carriers are unchanged. R5a improves an automatic denial's recovery precision; it
does not reduce interrupt frequency or address DF-012 containment rationale, which remains R5b.

## R5b validation outcome

R5b introduced no human review interrupt, so the historical totals remain 6 total / 2 necessary /
4 excessive or avoidable. Its real product replay exercised an allowed package-management-shaped
command under the production Warden and vendored SRT. The existing policy classified the command as
contained arbitrary code; the verified sandbox limited writes to workspace/temp and enforced strict
deny-all network egress.

Before R5b, the TUI showed a successful bash card without explaining why the action was safe. After
R5b, the Warden returns one response-only closed rationale and the TUI renders the calm two-fact
summary `contained: writes workspace/temp · network deny-all`. The Warden checks the existing
sandbox proof before emitting it. Kernel and presentation accept only the exact Warden string for
governed bash; near matches, arbitrary guidance, command output, control suffixes, and high-entropy
suffixes do not create controller evidence. Ordinary custom policy guidance that begins with the
reserved sentence is response-namespaced as policy guidance; the authoritative audit decision stays
unchanged and the copy cannot collide with verified containment.

Warn results preserve their policy warning separately. Nonzero commands remain failed and lead with
exit/stderr. The audit retains the original decision with no added guidance, its chain verifies, and
the sandbox profile is unchanged. R5b improves justification and trust without reducing review,
grant, policy, sandbox, or audit enforcement.

## R7 validation outcome

R7 introduced no human review interrupt or automatic denial, so historical totals remain 6 total /
2 necessary / 4 excessive or avoidable. Its production-path replay used the trusted typed `read`
tool through the spawned Warden; the bounded in-workspace read remained routine and completed
without asking for authority. The later bounded live-Anthropic E5 replay repeated that same governed
read and continuation path with no review interrupt, so the totals remain unchanged.

The new gross warning and pre-provider fit stop are kernel budget controls, not Warden decisions.
They cannot allow, deny, grant, batch, remember, or reinterpret an action. The second provider call
was prevented before any new tool request existed, while the existing successful read receipt stayed
visible. Policy, grantability, sandboxing, egress enforcement, audit format, and Warden RPC are
unchanged.

## R8 validation outcome

R8 introduced no human review interrupt or automatic denial, so historical totals remain 6 total /
2 necessary / 4 excessive or avoidable. The local and live product replays each used one trusted,
bounded in-workspace `read`; both completed through the spawned Warden without asking for authority.

R8 changes presentation only. It repeats the already-visible initiating user prompt in one bounded,
sanitized active-task row and does not change a Warden verdict, grant, batching rule, policy input,
sandbox profile, egress rule, RPC, audit record, or model-visible tool result. Focused approvals and
foreground panels retain viewport ownership.

## R9 validation outcome

R9 introduced no human review interrupt or automatic denial, so historical totals remain 6 total /
2 necessary / 4 excessive or avoidable. Its before/after product replay used ordinary no-tool
prompts through the spawned Warden startup path and a loopback provider; no action requested new
filesystem, network, package, Git, or shell authority.

Prompt history is presentation-only. The new kernel-internal sidecar cannot issue a tool request,
grant or remember approval, change policy input, alter a sandbox/egress profile, write an audit
record, or add a model message. Structured steering remains excluded from recall by exact durable
index and content. Warden verdicts, review burden, grantability, model/tool contracts, frozen UiPort,
session/audit schemas, and public CLI syntax are unchanged.

## R10 validation outcome

R10 introduced no human review interrupt or automatic denial, so historical totals remain **6
total / 2 necessary / 4 excessive or avoidable**. Its production-path replays used one trusted,
bounded in-workspace `read` before urgent steering prevented the planned edit. The normal and
budget/resume paths made zero Anthropic requests and requested no package, Git, broad shell,
external filesystem, or egress authority.

Urgent pending/applied state is kernel presentation derived from the durable steering ledger. It
cannot allow a tool, grant or batch a review, alter policy input, change the sandbox/egress profile,
or reinterpret a Warden verdict. Approval and foreground-overlay rows retain priority. The budget
preflight prevents further provider/goal work while leaving the correction unapplied; fresh resume
uses the existing durable marker to apply it exactly once.

The Warden decision, mutation classification, grantability, sandbox, egress, audit record, RPC,
and model-visible tool result are unchanged. The pending screenshot also retains the pre-existing
`execution status is unknown` line after interruption; R10 does not convert that ambiguity into a
false mutation fact. That finding remains R14.

## R11 validation outcome

R11 introduces no human review interrupt or automatic denial, so historical totals remain **6
total / 2 necessary / 4 excessive or avoidable**. Baseline and candidate replays exercise the same
legitimate composite pytest-version request through the spawned Warden. Baseline keeps the action
unexecuted, reports no live decision, ends `BLOCKED`, and exits 1.

Candidate does not reinterpret that decision. The exact process-local no-handle result permits one
model turn to propose at most one fresh action. The Warden receives that action through its ordinary
policy, sandbox, egress, execution, and audit path. The original bytes are never dispatched again;
the controller does not parse or rewrite them. At both terminal sizes, only
`python3 -m pytest --version` executes and the run finishes cleanly. A second review, denial,
nonzero/no-test result, indeterminate state, sibling call, or absent call remains terminal and
cannot recursively reopen recovery.

Final adversarial review proved that Warden transport success is not command success: real JSON
envelopes with nonzero `exitCode`, a termination signal, or an indeterminate `exitCode` initially
cleared the block. Those three tests failed red. Warning-decorated nonzero, untrusted apparent
success, and malformed-envelope cases were added before implementation. The controller now accepts
a governed bash correction as successful only for a complete envelope with safe-integer exit 0,
null signal, and string stdout/stderr; the legacy textual nonzero fallback also remains fail-closed.
This narrows completion truth without altering a Warden verdict or authority.

The recovery receipt is presentation-only reconciliation over controller-owned sequence facts. It
makes the successful correction dominant while stating that the original reviewed action was not
executed; ledger and verbose history remain intact. Warden verdicts, grantability, policy inputs,
sandbox/egress profiles, audit authority and format, RPC, shared schemas, model-visible tool
results, and approval batching are unchanged. R11 reduces operator burden after a terminal
decision; it does not reduce review frequency or create approval authority.

R11 candidate `d371b53` passed exact-head CI and merged through PR #83. Its post-main PTY observer
failure did not change a Warden verdict or interrupt count: Keel had rendered the correct governed
posture, but the packaging observer lost the row across a same-read redraw. The observer-only repair
merged through PR #85 and exact post-main CI `30856149564` passed, so this audit outcome is closed
without weakening review, sandbox, egress, policy, or approval behavior.

## R14 validation outcome

R14 introduces no human review interrupt or automatic denial, so historical totals remain **6
total / 2 necessary / 4 excessive or avoidable**. Its installed-carrier replays perform one
ordinary governed in-workspace read, then urgent steering prevents the proposed edit before the
executor is invoked. The target remains unchanged and the ledger contains only the read result.

The new execution-state tracker is process-local presentation observation. It is keyed by exact
view occurrence plus provider ID, cannot issue or approve a tool, cannot alter a policy verdict,
sandbox/egress profile, grant, audit record, durable session event, RPC/shared schema, or
model-visible result, and is cleared at the canonical run boundary. `not started` is asserted only
when the runner did not invoke the executor. In-flight and completed-without-result copies explicitly
say effects are indeterminate and require workspace/audit inspection before retry. A factless direct
boundary remains indeterminate. R14 therefore improves explanation without weakening or claiming
Warden authority. Candidate `03a6ad2` and merge `198f56f` share tree `5d77488`; exact reviewed-head
CI `30859417733` and post-main CI `30859848006` passed. Issue #87 closed and cleanup passed. The
interrupt totals remain unchanged.

## R12 validation outcome

R12 introduces no human review interrupt or automatic denial, so historical totals remain **6
total / 2 necessary / 4 excessive or avoidable**. Its exact installed-carrier replays perform eight
ordinary governed reads and four ordinary governed searches per terminal size; all complete without
requesting new authority.

Grouping runs only after controller settlement and changes presentation only. It cannot allow or
deny a tool, grant or batch a review, alter policy input, change sandbox or egress posture, write an
audit record, or synthesize a result. Reviews, blocked/limited/partial outcomes, failures, mutations,
and nonroutine tools are excluded. Verbose/debug preserve every exact observation. Warden verdicts,
grantability, audit, model-visible results, frozen contracts, and interrupt totals are unchanged.
Candidate `ea79cf5` and merge `2ca060e` share tree `8261e69`; exact reviewed-head CI `30863536934`
and post-main CI `30863981683` passed. Issue #91 closed and feature cleanup passed. The historical
interrupt totals remain unchanged.

## R13 validation outcome

R13 introduces no Warden action, human review interrupt, or automatic denial, so historical totals
remain **6 total / 2 necessary / 4 excessive or avoidable**. `keel auth set` stays on the existing
owner-only credentials-store path and preserves the `0600` write, provider validation, precedence,
cancel/error behavior, list/remove behavior, and secret non-disclosure.

The successful controller response now states only two process facts: storage completed, and
already running Keel sessions were not reloaded. The exact `keel --continue` recovery command is
qualified to the session workspace. This copy cannot reload a provider client, grant a tool, alter
a Warden verdict, change sandbox or egress posture, write an audit claim, or expose a credential.
Baseline and candidate exact-carrier runs at 80x24 and 100x30 use no Warden or provider request;
the non-secret fixture is absent from all captured evidence. Candidate `19a482a` and merge
`1bbe977` share tree `ee7837f`; exact reviewed-head CI `30866891254` and post-main CI `30867327223`
passed, issue #94 closed, and feature cleanup passed. Historical totals remain unchanged.

## R15 validation outcome

R15 introduces no human review interrupt or automatic denial, so historical totals remain **6
total / 2 necessary / 4 excessive or avoidable**. Each accepted installed-carrier replay performs
one ordinary governed typed `write` over a four-byte binary preimage. The spawned production Warden
settles the action once; no grantable review, terminal review, denial, reusable scope, or additional
authority is requested.

The focused diff surface consumes only process-local mutation-presentation facts after settlement.
It cannot execute or retry a tool, approve or batch a review, reinterpret a verdict, change policy
input, widen the sandbox or egress profile, write an audit record, or synthesize a model-visible
result. Explicit producer unavailability outranks contradictory activity diff bytes; request paths,
output, summaries, and assistant prose cannot become comparison evidence. Unavailable observations
are display-bounded, control-stripped, and paired only with the fixed non-destructive recovery
guidance already accepted by ADR-0079.

Baseline and candidate use the same governed action at 80x24 and 100x30. The difference is
presentation after settlement: baseline reports no settled diff, while candidate makes the
producer-owned limitation and safe next action inspectable. Eighteen loopback fixture requests,
including invalid presentation-oracle attempts, made zero Anthropic calls and no new Warden
interrupt. Warden verdicts, grantability, approval lifecycle, batching, audit, sandbox, egress,
RPC/shared schemas, and historical interrupt totals remain unchanged.

Reviewed head `686bd1d` passed exact-head CI `30872462126`, merged through PR #98 as `76a45c3`
with identical tree `93c19c1`, and passed exact post-main CI `30873064247`. Issue #97 and feature
cleanup are closed. R15 therefore changes no interrupt count, approval authority, or Warden claim.

## R16 validation outcome

R16 directly exercises the live grantable-review path. In each accepted equivalent-only run, the
human makes one necessary `domain example.com` session decision and the second exact action
auto-resolves. In each distinct-domain run, the human makes the same initial decision and a second
necessary decision for `domain example.org`; denying it prevents execution. Across the four
accepted 80x24/100x30 candidate runs there are **6 human decisions, 4 exact automatic reuses, and 0
excessive equivalent-repeat prompts**. These are validation repetitions, so the original six
benchmark-workflow interrupt totals remain unchanged rather than being inflated by geometry runs.

The production topology exposes one active review at a time. R16 does not add a concurrent queue,
group unlike requests, infer equivalence, or expand session authority. The UI reports one pending
review while actionable, removes the optional count on settlement, and emits one automatic receipt
only from the controller/durable event path. `example.org` never consumes the `example.com` grant.

Baseline and candidate decisions, policy, grantability, scope identity, sandbox, egress guard,
audit requested/resolved records, and nonzero denial exit are identical. Candidate presentation
adds the previously missing exact reuse fact. The historical audit therefore remains **6 total / 2
necessary / 4 excessive or avoidable**, while the accepted R16 validation matrix demonstrates the
bounded reuse behavior needed to make future equivalent reviews non-fatiguing.

Reviewed head `6f4660c` passed exact-head CI `30877328734`, merged through PR #101 as `be4fb5e`
with identical tree `0a916c1`, and passed exact post-main CI `30877686690`. Issue #100 and feature
cleanup are closed. R16 changes presentation and observed burden, not interrupt authority or the
historical benchmark total.

## R17 validation outcome

R17 introduces no decision surface, human review, automatic grant, denial, or policy change. Five
accepted exact installed-carrier phase samples each asked the production Warden to run one ordinary
local Click test command. Every audit recorded the same `allow` verdict, one requested occurrence,
one zero-exit result, sandbox on, egress guard on, and **zero review interrupts**. A representative
audit spans `04:56:08.772Z` request to `04:56:11.904Z` result and retains the exact 1,901-pass
summary.

The TUI measured only controller presentation around that authority: visible tool request to
visible execution p95 was 16.333 ms, then the existing two-second liveness path reported quiet
execution without inventing progress. The user could type and clear a draft during the controlled
provider wait. R17 does not infer policy timing from model prose, persist a performance claim,
reinterpret the allow, or widen sandbox/egress access. Historical benchmark totals remain **6 total
/ 2 necessary / 4 excessive or avoidable**.

## R18 validation outcome

R18 introduces no human review interrupt, automatic grant, denial, decision surface, or policy
change. Each of the four accepted exact installed-carrier runs asks the production Warden to run
one ordinary local Click test command. Every run receives one allow, zero review interrupts, a
complete zero-exit result, sandbox on, egress guard on, and clean teardown.

The new recognizer acts only on the already-returned complete bash envelope. It cannot execute a
command, grant or batch authority, reinterpret an allow/deny/review verdict, change policy input,
widen sandbox or egress access, write an audit record, or synthesize a model-visible result.
Malformed/unknown output falls back unchanged; failure/error counts, exit, signal, typed failure,
partial, and limited outcomes remain needs-attention. The exact candidate summary remains in the
ordinary `ran` receipt and never claims `checked` or `verified`.

R18 therefore changes presentation and final confidence only. Historical benchmark totals remain
**6 total / 2 necessary / 4 excessive or avoidable**.

Reviewed head `d7d6f2e` passed exact-head CI run `30883098433`; PR #106 squash-merged as `759a727`
with byte-identical tree `a52f7a1`. Exact post-main CI run `30883516900`, issue closure, and feature
cleanup passed. These publication events add no Warden interrupt or authority.

## R19 validation outcome

R19 changes no Warden policy, review semantics, grant scope, sandbox, egress guard, audit format,
or execution path. The ten selected installed-carrier sessions required governed posture. The
selected audit set contains four allowed bash `tool.execute` records across two active/resize
sessions, six allowed diff-path `tool.execute` records across two diff sessions, and zero tool
events across two active-panel interrupt sessions.

The two live-review sessions each produced one `review.requested` and one denied
`review.resolved` event for exact scope `domain example.com`. Both interrupts were necessary: the
requested `curl https://example.com` action crossed the established network boundary. The prompt
showed the exact command, impact, scope, once/session/deny choices, and consequence; review-focused
paste, editor, history, and search probes remained inert. Denial restored the exact draft and the
action did not execute.

These two controlled validation prompts are not added to the frozen historical six-workflow
benchmark total, which remains **6 total / 2 necessary / 4 excessive or avoidable**. For the R19
matrix itself the audit is **2 total / 2 necessary / 0 excessive**, with no automatic grant or
session reuse exercised. Publication-only actions add no Warden interrupt or authority.

Reviewed head `551e97a` passed exact-head CI `30887406100`; PR #109 merged as `03de790` with
byte-identical tree `dbb8508`; exact post-main CI `30887857950`, issue closure, and feature cleanup
passed. These publication and cleanup actions add no governed product interrupt or authority.

## R21 validation outcome

R21 changes no Warden policy, review/grant semantics, sandbox, egress guard, audit format, or
execution authority. The accepted exact-main deterministic onboarding sessions use eight ordinary
typed read/search actions each. The live main session records 18 logical tool results and 30 audit
`tool.execute` rows (bash request/result pairs account for the higher audit count); all are routine
read-only discovery, with sandbox and egress guards on and **zero review interrupts**.

The two rejected prompt candidates likewise request zero reviews. Candidate 1 records 18 logical
tools and 20 audit tool rows; candidate 2 records 19 logical typed read/search tools and 19 audit
tool rows. Their failure is model-output quality, not Warden classification. No action edits a file,
installs a dependency, or requests network access; frozen Click remains clean.

The no-tests control records one search and two reads with no review. The declined-workspace control
records zero project-context events, zero snapshots, and zero tool audit rows while governed
protection reaches ready state. The missing-credential control fails before provider, session,
audit, or workspace activity. The retained resume control makes zero provider/tool calls, leaves the
controller ledger unchanged, and adds only `session.start` plus `checkpoint` lifecycle audit rows.

R21 therefore adds **0 total / 0 necessary / 0 excessive** review interrupts to its validation
matrix and does not change the frozen historical benchmark total of **6 total / 2 necessary / 4
excessive or avoidable**. Issue #113 is constrained from hiding Warden outcomes or repeating tools;
any future output-controller implementation remains a separate public-behavior review boundary.

Reviewed head `4494978` passed exact-head CI `30895021455`; PR #114 merged as `15f991d` with
byte-identical tree `23f203f`. Exact post-main CI `30895569846`, issue closure, and validation
branch/worktree plus credential-root cleanup passed. These publication and cleanup actions add no
governed product interrupt, grant, or execution authority.

## R22 validation outcome

R22 changes no Warden policy, review/grant semantics, sandbox, egress guard, audit format, or
execution authority. The accepted matrix exercises three zero-provider startup/preflight failures,
one doctor failure, one bounded provider failure, one token-runway stop after a governed read, and
one successful governed mutation with unavailable presentation.

The missing-Warden fault removes only the installed private sibling before startup. Both baseline
and candidate exit 1 before provider work, create zero grantable decisions, and execute zero tools.
The change is controller-owned diagnostic copy after the same failed resolution check; it cannot
start a Warden, choose a fallback, grant authority, reinterpret a verdict, or weaken fail-closed
behavior. The intact-candidate active-writer control proves the packaged Warden still launches and
the existing controlled recovery path remains unchanged.

R22 therefore adds **0 total / 0 necessary / 0 excessive** review interrupts to its validation
matrix and does not change the frozen historical benchmark total of **6 total / 2 necessary / 4
excessive or avoidable**. Screenshots 59-60 compare only recovery presentation. PR #118, issue
closure, and feature cleanup add no governed product interrupt or authority.

## Issue #113 validation outcome

Issue #113 changes no Warden verdict, policy input, review/grant semantics, sandbox, egress guard,
audit schema, or execution authority. The final-answer controller observes only model terminal bytes
and existing controller state. Its optional rewrite request advertises zero tools; an adversarial
fixture-emitted `read` call is recorded as skipped and never reaches the executor or Warden.

The exact installed candidate's positive 80x24/100x30 sessions use ordinary read-only task requests
followed by one tools-disabled rewrite. Cancellation makes one ordinary request and no rewrite. A
completed resume and interactive trust decline make zero provider/tool requests. The existing
installed-carrier symlink/outside-write control still denies both typed and Bash canaries before
execution, retains `POL-002` attribution for Bash, creates no review route, and reaps the process
group.

The one live Anthropic onboarding session records 32 tool results (22 read, 9 search, and 1 shell
inventory) with governed sandbox and egress protection and requests **zero human reviews**. No file
is edited, dependency installed, or network tool requested. The rewrite cannot hide Warden outcome
evidence because no rewrite tool can run and existing controller-owned warnings/evidence remain
outside the model-authored primary.

Issue #113 therefore adds **0 total / 0 necessary / 0 excessive** review interrupts to its
validation matrix and does not change the frozen historical benchmark total of **6 total / 2
necessary / 4 excessive or avoidable**. PR #121 publication, issue closure, exact post-main CI, and
feature/task-root cleanup passed and add no governed product interrupt or authority.

## R20 validation outcome

R20 changes only responsive metadata presentation. It does not change policy input, verdicts,
reviews, grants, sandboxing, egress, audit, Warden authority, or any execution path. The exact
installed candidate's nine PTY profiles and native Kitty/Apple Terminal sessions reached governed
protection without submitting a provider task or requesting a human decision, then exited cleanly.

R20 therefore adds **0 total / 0 necessary / 0 excessive** review interrupts and leaves the frozen
historical benchmark total at **6 total / 2 necessary / 4 excessive or avoidable**.

PR #124 publication, issue #123 closure, tree-identical merge `67e317d`, and exact post-main CI
`30936677719` add no governed product interrupt or authority.

## R23 validation outcome

R23 runs the existing production Warden against a deterministic loopback provider and the existing
starter policy. All 20 accepted active Click sessions are routine governed Bash allows; no action is
grantable, no human review is requested, and no policy/grant/authority behavior changes. The two
dense distributions plus sparse control and launch ablation add **0 total / 0 necessary / 0
excessive** review interrupts. The frozen historical dogfood total remains **6 total / 2 necessary /
4 excessive or avoidable**.

Issue #127 may change only startup/snapshot scheduling and copy mechanics. It is explicitly barred
from changing Warden readiness truth, policy, sandbox, egress, audit, grant, or review behavior.

## Issue #127 validation outcome

Issue #127 changes Kernel-owned startup scheduling, snapshot copy mechanics, and the cosmetic Git
probe only. The Warden still fully starts and reports governed posture before the UI can remove its
startup marker. Snapshot work begins after that readiness and still settles before any model input,
queued task, resumed steering, or tool action. No verdict, policy input, review route, grant,
sandbox, egress, audit, protocol, schema, authority, or governed command changes.

The two accepted exact-carrier startup distributions perform no governed task action and request no
human decision. All 40 launches reach governed posture, exit zero, and reap their complete process
groups. Failed Warden startup deterministically starts no backup. The nested-state copy path,
whole-`KEEL_HOME` denial, path withholding, symlink fidelity, caps, cleanup, and fail-open snapshot
semantics remain covered.

Issue #127 therefore adds **0 total / 0 necessary / 0 excessive** review interrupts and leaves the
frozen historical dogfood total at **6 total / 2 necessary / 4 excessive or avoidable**. Publication
and post-main CI remain pending.
