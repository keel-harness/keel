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
