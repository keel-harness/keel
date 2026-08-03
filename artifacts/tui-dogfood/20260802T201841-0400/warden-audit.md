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
