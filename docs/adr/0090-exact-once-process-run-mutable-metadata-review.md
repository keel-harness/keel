# ADR-0090 — Exact-once `process.run` review after mutable execution input

- **Status:** **Proposed.** Public issue
  [#157](https://github.com/keel-harness/keel/issues/157) authorizes this design pass but separately
  requires maintainer acceptance of this exact authority decision before implementation. No behavior
  code is authorized by this proposed status.
- **Date:** 2026-08-06.
- **Decider:** keel maintainer.
- **Governs:** a narrowly actionable review for ADR-0089 `process.run` requests whose sole review
  cause is ADR-0090/SEC-028 same-session mutable execution input. Relates to MASTER_SPEC §3.3, §4.2,
  §4.9, Appendix A, Appendix D, and SEC-028; ADR-0017, ADR-0024, ADR-0033, ADR-0038, ADR-0056,
  ADR-0076, ADR-0080, ADR-0081, ADR-0084, ADR-0087, ADR-0088, and ADR-0089.

## Acceptance and issue-alignment gate

Issue #157's post-edit inspection test originally requires the accepted path to be structurally
read-only. This proposal does **not** meet that oracle: it allows a human to approve exact
repository-controlled argv inside a strict process sandbox, and the approved process may write within
the displayed workspace and Warden temporary roots. Containment and informed exact-once consent are
not equivalent to read-only execution.

Before this ADR can become Accepted, the maintainer must explicitly accept this authority tradeoff and
amend that issue test from a read-only-inspection requirement to the contained exact-once process
review defined here. Until then, MASTER_SPEC and implementation remain unchanged. If the maintainer
retains the read-only oracle, reject this option and pursue a separately designed Warden-native inspection
surface instead.

## Context

SEC-028 treats package scripts, discovered tests, tool configuration and plugins, VCS attributes and
configuration, and other workspace files as possible executable control input. No path list can
cover every toolchain. After a successful or potentially committed governed workspace write, the
Warden therefore invalidates known-safe package/VCS classification for that session and process.
Later package and VCS commands route to `POL-003` review instead of silently executing.

That defense is correct. Its first implementation gap became launch-sensitive during a current-main,
live Anthropic TUI run for issue #157. Keel made a typed edit, ran the requested direct Node test
successfully, and then attempted the requested final `git diff`. Both the Bash and `process.run`
variants reached the SEC-028 review boundary, but `process.run` reviews were terminal because
ADR-0089 V1 had no exact review binding. No approval card could open. The controller truthfully ended
blocked even though the edit and test had succeeded. Independent host inspection proved the change
was correct, but the normal in-product edit → test → inspect workflow could not finish.

Special-casing Git as read-only would be unsafe. Git attributes can select clean filters, external
diff drivers, and text conversion programs; repository and user configuration can select other
helpers. An adversarial local probe demonstrated that a repository-selected clean filter still ran
under a heavily restricted `git diff` invocation with external diff and text conversion disabled.
Git documents these mechanisms separately in
[`gitattributes`](https://git-scm.com/docs/gitattributes),
[`git-diff`](https://git-scm.com/docs/git-diff), and
[`git-config`](https://git-scm.com/docs/git-config). Flags that suppress one mechanism do not prove
that the whole invocation is non-executable.

The control-plane gap is narrower than a Git problem. ADR-0089 already reserved use of the existing
review RPC when the Warden can bind and revalidate the complete exact argv vector. The current Warden
also already has once-only reviewed-command and exact-once MCP patterns. What is missing is a
`process.run`-specific eligibility rule, an exact binding, and a way to detect another same-session
Warden-observed invalidation event between review creation and resolution.

## Decision criteria

An acceptable design must:

- keep SEC-028 invalidation intact and never label mutated execution input safe;
- authorize one exact `process.run` occurrence, never a command family or reusable grant;
- retain the model-authored argv vector as data from request through sandbox launch;
- make the Warden the sole eligibility, binding, revalidation, execution, and audit authority;
- reject any second policy cause or effect involving egress, secrets, privilege, installation,
  destructive or irreversible behavior, external writes, or incomplete containment;
- make any later same-session Warden-observed invalidation event invalidate the pending approval;
- present the complete exact argv and material read/write/network/secret boundary without redaction,
  control characters, or truncation;
- fail closed for headless/no-handler, timeout, cancellation, disconnect, stale ID, replay, scope
  widening, audit failure, policy drift, sandbox drift, and Warden loss;
- preserve the frozen RPC and audit schemas if their existing open seams are sufficient; and
- remain understandable as one consequential human decision at 100×30.

## Decision

### 1. SEC-028 remains the boundary

Do not auto-allow `git diff`, package test commands, or any other command after a governed write. Do
not reset execution-metadata invalidation, infer safety from command names, rewrite argv with
supposedly safe flags, or restart the Warden to clear the state.

The Warden may instead offer one exact human review for an eligible `process.run` occurrence. Approval
means only: run these exact argv bytes once inside the revalidated displayed containment. It does not
mean the executable or workspace input is safe.

Bash remains terminal for this SEC-028 case. A shell string cannot be rebound to exact argv without
parsing, rewriting, or approximate equivalence. The model may choose `process.run` when one literal
argv invocation is sufficient; Keel does not silently convert between the tools.

### 2. Eligibility is deliberately narrow

Create a distinct internal `PendingProcessRunReview` only when all of the following are true:

1. The workspace is trusted, the Warden advertises `process-run/v1`, durable audit is active, an
   enforcing sandbox tier is available, and the active policy was loaded through a Warden-internal
   registered identity issued only by the compiled built-in starter-pack loader. A pack name, hash,
   or familiar rule IDs supplied by a custom `PolicyPort` cannot establish this identity.
2. ADR-0089's authoritative parser produced one valid, bounded exact argv vector and its canonical
   rendering passes a new argv-specific lossless bounded-display predicate: the displayed string is
   byte-for-byte the canonical rendering, with no whitespace collapse, redaction, sanitization,
   omitted bytes, or truncation. The existing `exactOneLineReviewText` is insufficient because it
   normalizes repeated spaces inside quoted argv data. Empty arguments, repeated spaces, and other
   visually subtle literal values receive property coverage; if lossless display is unavailable, the
   review stays terminal.
3. The built-in starter policy returned exactly `review`, proposed no modified args, and the sole
   classifier reason is `mutable_execution_metadata` for a command in SEC-028's existing recognized
   package/VCS set.
4. `POL-003` is the sole rule requiring human authority. A deny, another review cause, custom-pack
   ambiguity, or stronger result remains terminal.
5. The dynamic effect and every composition segment contain none of: network read/write, secret or
   unknown-sensitivity targets, home/system/external-service scope, privilege, installation,
   destructive, irreversible, persistent, or external-write behavior. The unknown/process markers
   caused solely by mutable execution input remain visible; they are not erased to satisfy this test.
6. The rebuilt sandbox profile denies all network access, contains reads and writes to approved roots,
   requires `workspaceSecretDenyReadComplete === true`, covers every enumerated home-credential root
   and every `.env*` root found by that complete bounded scan, denies Warden/audit roots, and has no
   policy/sandbox mismatch. An entry-cap hit, read error, or any other incomplete scan keeps the review
   terminal. Scan completeness does not claim that every non-standard sensitive workspace file is
   discovered or denied.

Eligibility is a pure Warden predicate with positive, negative, differential, and property tests. It
does not accept a model-provided reason, tool description, command label, or TUI state as evidence.

### 3. The binding covers the complete occurrence

The pending review stores the retained original execute request and a versioned hash over at least:

- public tool name and exact original structured args;
- exact ordered argv including empty arguments and canonical display rendering;
- canonical workspace root and session ID;
- policy pack name/hash, original verdict, matched rules, and classifier reasons;
- the complete normalized dynamic effect envelope and composition graph;
- the complete effective sandbox profile, required enumerated home-credential, discovered `.env*`,
  and audit deny roots, plus the required-true `workspaceSecretDenyReadComplete` bit;
- provenance context relevant to the decision;
- Warden-internal registered built-in policy identity and `process-run/v1` capability state;
- the session's current execution-metadata mutation generation.

The Warden mints a 120,000 ms internal TTL when it creates the pending review and includes the review
ID, monotonic creation time, and absolute monotonic expiry in this request binding. The expiry is
Warden-owned and cannot be extended by the model, UI, wall-clock changes, or resolve request.

`principal` is available only on the strict `warden.resolveReview` request, so authorization uses a
two-stage binding. A schema-valid approval for the matching live review extends the request binding
with the schema-validated principal and requested `scope:"once"`; that approval binding is recorded
before revalidation and recomputed for the launch decision. This binds the asserted local principal
for audit and exact occurrence matching; it does not claim a new authentication mechanism. Neither a
different principal nor an omitted or wider scope can reuse it.

The binding is not a reusable command key. It is valid for one unexpired pending review ID in one live
Warden process. `scope:"project"`, session reuse, persistence, export/import, or replay is rejected.

### 4. Mutation invalidation gains a generation

Extend the Warden's per-session execution-metadata state with a monotonic non-negative safe integer.
Every call to the existing `invalidateExecutionMetadataForPotentialWrite` hook increments the
generation, including later calls after the session is already invalidated. This deliberately keeps
the current conservative ordering: process execution invalidates immediately before durable intent,
and typed mutation invalidates in its pre-mutation callback. An intent-audit failure can therefore
advance the generation even when no child or file mutation follows. Requests denied before reaching
that hook do not increment it.

An approved `process.run` is a special conservative invalidation point because repository-controlled
helpers may write even when the classifier describes the requested command as read-only-looking. After
the current card passes generation/binding revalidation and is consumed, but before durable intent or
child launch, the Warden increments the generation unconditionally for that admitted process-run
attempt. This makes every other same-session pending review stale. The current occurrence uses only
its already-validated, consumed exact-once authority; it does not mint a binding at the new generation.

At the safe-integer bound the state becomes permanently poisoned for that session. It never wraps,
resets, or throws in a way that could hide an attempted invalidation. No later mutable-metadata review
is eligible in the poisoned state.

The generation is internal Warden state. It is not a claim about host, IDE, prior-process,
other-session, or otherwise unobserved mutations. Those SEC-028 residuals remain documented. A new
Warden process does not inherit the generation, and restart is not an approval or safety mechanism.

### 5. Resolution consumes first and revalidates everything

A schema-valid resolution naming an existing pending occurrence consumes it before approval work
begins. Denial, a wrong scope, expiry, or failed revalidation can never leave reusable authority.
Malformed wire requests are rejected by the frozen strict parser before lookup; stale and repeated IDs
find no pending authority. All three execute nothing, but this ADR does not falsely claim that an
unidentifiable or already-absent occurrence was consumed.

For an approval, the Warden then:

1. validates expiry, principal, and exact-once scope, then durably records the human's two-stage
   exact-once approval binding;
2. reparses the retained original tool args with the authoritative ADR-0089 parser;
3. rebuilds live secret coverage, sandbox profile, policy input, and policy decision;
4. recomputes the full binding and compares the mutation generation;
5. rejects any drift or loss of an eligibility precondition;
6. unconditionally advances the same-session generation, staling every sibling pending card;
7. durably records pre-execution intent;
8. launches the retained `SandboxInvocation.argv` exactly once; and
9. records the separate bounded outcome.

The base policy decision remains visible as SEC-028 `review`. For the one launched occurrence, audit
may add a Warden-owned `PROCESS-RUN-MUTABLE-METADATA-REVIEW-ONCE` application marker in existing open
payload/rule fields. It must not rewrite the original verdict history or claim safe classification.
If durable resolution or intent audit fails, no child starts. If the post-launch outcome is
indeterminate, Keel reports that truth and never automatically retries.

“Exact-once” means one exact retained occurrence with at most one admitted launch attempt. Expiry,
denial, drift, audit failure, sandbox failure, or launch failure can correctly result in zero child
executions; none permits a second attempt under the consumed review.

### 6. Existing frozen wire and audit shapes are sufficient

No new RPC method, protocol version, shared `ReviewRequired`, `PolicyInput`, `SideEffect`, or audit
record field is introduced. `warden.execute` returns the existing review envelope;
`warden.resolveReview` accepts only `scope:"once"`; and review-specific binding/application facts use
the audit payload's existing open object fields. `PendingProcessRunReview` and mutation generation are
Warden-internal structures.

If implementation discovers that exact binding or lifecycle truth requires a frozen shape change,
this ADR is insufficient. Stop for a separately versioned Appendix-A/B amendment and compatibility
analysis.

### 7. Human and model presentation state the real choice

Following ADR-0084's precedent, this ADR narrowly specializes ADR-0081's
`ReviewRequired.summary` presentation-source contract for this review kind. The summary remains
bounded Warden-authored display—not a stable grammar or a source of scope, policy-rule, eligibility,
or controller authority—but contains both the exact effective argv and a fixed material-risk
consequence. The controller renders it as the Warden's effective-target/risk text without parsing it.
ADR-0081's separate “why” field remains the fixed generic statement that the Warden requires human
authorization; the controller never infers `mutable_execution_metadata` from prose. `allowCommand`
continues to be strictly parsed only to prove that once is the sole available scope.

The Warden generates the summary only after eligibility proves that its statements match the live
profile. Its core message is:

> Workspace files changed. This exact argv may run changed repository-controlled code and may read or
> write the workspace and Warden temporary roots. Network access, enumerated home credentials,
> discovered `.env*` files, Warden/audit writes, and writes outside those roots remain denied. Other
> unrecognized sensitive workspace files may be readable. Approving runs it once: `<exact argv>`.

The complete summary must fit a Warden-owned 512 UTF-8 byte limit without omission, whitespace
normalization, redaction, or sanitization. If the argv plus the material boundary cannot fit, the
review stays terminal. “Workspace,” Warden temporary roots, runtime/dependency reads, network denial,
enumerated home-credential roots, discovered `.env*` roots and scan completeness, the undiscovered
workspace-sensitive-file residual, and Warden/audit denial are Warden-owned facts derived from the
eligible profile; implementation must not substitute a stronger static promise for a weaker live
profile.

Current controller/ViewModel/Ink helpers normalize or truncate generic review text, so implementation
must add a process-run-review-specific lossless presentation lane. Selection uses only the
controller-known retained `toolCall.name === "process.run"` plus strict parsing that the Warden's
`allowCommand` offers this review ID at `scope once`; it never parses summary prose or treats this
display-only discriminator as authority or eligibility. The Warden's summary passes unchanged through
controller state, ViewModel, planner, and Ink. Each boundary independently proves identity with the
input bytes and applies the same control/redaction/UTF-8 bound predicate. If any stage would strip,
redact, normalize, omit, or truncate a byte, the controller makes the card non-actionable and settles
the retained Warden review as denied. It never falls back to a lossy approval card.

The UI offers `Approve once`, `Deny`, and the existing explanation affordance. It does not offer
session/project approval or “always allow.” The exact argv, possibility of running changed
repository-controlled code, material read/write roots, network and enumerated-credential/`.env*`
denials, undiscovered-sensitive-file residual, and once-only blast radius stay visible at 100×30.
Repeated, leading, and trailing spaces plus empty args remain visually exact through a real-Ink test.
The model may explain the result but cannot author the approval basis.

Interactive Guided mode may settle the review through its existing decision bridge. Autopilot does
not auto-approve this boundary. One-shot `keel run -p`, missing review handlers, disconnects,
timeouts, cancellation, and shutdown settle without execution and report that no live approval was
available. A terminal review and an actionable pending review remain distinct controller states.

## Options considered

### Option 1 — exact-once `process.run` review with mutation-generation binding

**Selected.** It uses ADR-0089's literal argv and existing review seams, preserves SEC-028, and adds
only the state needed to make approval stale after another governed write.

### Option 2 — Warden-native change inspection without Git

**Deferred.** ADR-0078's Warden-observed typed-mutation artifacts could support a future non-Git
`changes.review` surface, but those artifacts intentionally are not model or ledger carriage and do
not cover every pre-existing, staged, untracked, renamed, or host-authored change. Amending that
contract is larger than the launch blocker.

### Option 3 — harden and auto-allow selected Git invocations

**Rejected.** Git has multiple separately configured execution mechanisms, and a flag set cannot
prove the entire workspace-controlled program inert. Rewriting model argv would also violate
ADR-0089 exactness.

### Option 4 — clear invalidation after a safe-looking write or Warden restart

**Rejected.** No complete safe-path list exists, and restart would launder precisely the process-local
state SEC-028 relies on.

### Option 5 — reuse session/project command grants

**Rejected.** The same argv can execute different workspace-controlled code after the next write.
Only an exact occurrence bound to the current mutation generation is acceptable.

### Option 6 — make all `process.run` reviews actionable

**Rejected.** Unknown programs, arbitrary code without complete containment, egress, destructive
actions, installs, privilege, secrets, and custom-policy cases have materially different authority.
This ADR resolves one known cause, not generic `POL-003` approval.

## Consequences and residual risk

- The normal edit → test/package check → exact change inspection workflow can ask one informed human
  question instead of ending at a terminal review.
- A repository-controlled program may run and may write within the displayed workspace/temporary
  roots after explicit approval. Safety comes from exact informed consent plus revalidated sandbox,
  network, secret, audit, expiry, and once-only boundaries—not from trusting the command name.
- A second same-session Warden-observed invalidation event makes the card stale, requiring a fresh
  decision for the new state.
- Bash remains unable to cross this boundary, and headless automation remains fail-closed.
- The Warden still does not observe host/IDE writes, another Warden session, or pre-existing hostile
  workspace input. Workspace trust and OS containment remain prerequisites; this ADR adds no claim
  that those residuals disappeared.
- Enumerated home credentials and discovered `.env*` roots are denied, but an unrecognized sensitive
  file inside the trusted workspace may remain readable by the approved repository-controlled code.
- Exact full display intentionally makes some long or secret-redacted argv terminal.
- A per-session generation adds small internal state and must be overflow-safe. Reaching the safe
  integer bound fails closed rather than wrapping.

## Required implementation evidence

After the acceptance gate above amends it, issue #157 is the public implementation plan.
Implementation is red-first and must prove at least:

1. typed write/edit → recognized `process.run` package/VCS command creates one pending, once-only
   review and executes no child before approval;
2. approval executes the exact retained argv at most once with ordered resolution → revalidation →
   unconditional generation advance → intent → outcome evidence;
3. deny, project scope, headless/no handler, timeout, cancellation, disconnect, shutdown, stale ID,
   duplicate resolution, audit failure, and sandbox loss execute no child;
4. every same-session call to the current Warden invalidation hook changes the generation—even if
   intent audit then fails—and makes the original approval fail closed; other-session/host writes
   remain an explicit residual;
5. after one approved card is revalidated and consumed, its pre-intent unconditional generation
   advance makes every concurrent same-session pending card stale, including when a Git/package helper
   is classified without `fs_write`; helper writes and intent-audit failure cannot preserve a sibling
   card's generation;
6. property mutation of every argv element/order, args, workspace, session, registered policy
   identity/pack/decision, effect/composition, sandbox/secret coverage, provenance, capability,
   generation, review ID, expiry, principal, or scope invalidates the relevant binding;
7. Git push/remote mutation, install, privilege, destructive, secret, egress, arbitrary unknown,
   custom-pack, combined-rule, Bash, truncated, redacted, and control-bearing cases remain terminal or
   stronger;
8. hostile `.gitattributes` filters, external diff/textconv helpers, package scripts, discovered
   tests/plugins, and another-write races execute nothing without approval and remain contained after
   approval on real Linux and macOS sandbox backends;
9. controller, ViewModel, planner, and TUI/real-Ink at 100×30 preserve exact summary bytes—including
   repeated/leading/trailing spaces and empty args—or settle denial; the card shows exact risk and
   once-only scope, while headless/session/resume/final copy distinguishes actionable, denied,
   terminal, and indeterminate outcomes; and
10. focused, coverage, security, real-sandbox, package, exact-carrier, exact-head CI, and independent
   spec/security, reliability, DX, and simplicity reviews pass before merge.

## Stop conditions

Stop rather than implement if exact argv must become a joined/reparsed string; approval cannot be
forced once-only; complete argv/risk cannot be shown; mutation, policy, effect, sandbox, provenance,
or secret-coverage drift cannot fail closed; execution can precede durable intent; headless paths can
leave pending authority; SEC-028 must be weakened; a dependency is proposed; or a frozen wire/audit
contract must change without a versioned ADR.
