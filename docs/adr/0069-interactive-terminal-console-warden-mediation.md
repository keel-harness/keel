# ADR-0069 - Interactive terminal console warden mediation

- **Status:** Accepted for Epic 2.34 implementation. Runtime slices are in progress;
  real adapter, dependency, frozen-interface, and benchmark-claim gates remain.
- **Date:** 2026-07-09.
- **Deciders:** keel maintainer approved implementation on 2026-07-09; remaining
  gated decisions are listed below.
- **Governs:** interactive terminal / PTY console surface, policy unit, sandbox and
  egress composition, audit/provenance/redaction, and PTY backend selection for Epic
  2.34.
- **Related:** `MASTER_SPEC.md` §§1.1, 1.2, 3.2, 3.3, 3.4, 4.2, 4.3, 4.8, 4.9, 5.3,
  Appendix A/B/D/E; ADR-0005, ADR-0012, ADR-0016, ADR-0017, ADR-0021, ADR-0024,
  ADR-0027, ADR-0033, ADR-0037, ADR-0039, ADR-0056, ADR-0061, ADR-0066, and
  ADR-0067.

## Context

Keel's shell tool is intentionally non-interactive. `shell-session.ts` keeps foreground
commands' stdin at EOF and returns marker-delimited output so commands cannot steal the
persistent shell protocol. That protects the harness, but it leaves keel unable to drive
a live VM console, login prompt, REPL, or TUI.

The gap was isolated in the 2026-07-09 same-infra Terminal-Bench 2.1 comparison: keel
34/59 vs terminus-2 36/59. The comparative review found one structural gap accounting
for two tasks, `qemu-startup` and `qemu-alpine-ssh`: both require raw keystrokes and live
screen polling. Terminus succeeds with a tmux-backed send/wait/read-screen shape; keel
falls back to brittle `expect` scripting.

An interactive console is a new privileged surface. Keystrokes are not a normal one-shot
command; screen reads are live model-visible input; a VM/SSH/telnet console can become
network egress or an opaque side-effect channel. Implementing this as a kernel-local PTY
or a patched `bash` mode would bypass keel's central claim that the warden mediates side
effects out of process.

## Decision

Adopt a **warden-owned interactive console session model**. The model may request console
operations; the warden creates, mediates, audits, and tears down the underlying session.

The model-facing operations are:

- `interactive_console.open`
- `interactive_console.send_keys`
- `interactive_console.read_screen`
- `interactive_console.release`
- `interactive_console.close`

They are routed through existing `warden.execute` in the first implementation. No new
`WARDEN_METHODS` entry or Appendix B event type is assumed for the first slice. If a
production-quality implementation cannot be completed through existing tool-call routing,
implementation stops and a protocol-bump ADR is required.

This routing requires a console-specific branch inside the warden. Current
`commandFromToolCall()` does not recognize `interactive_console.*`; implementation must
add a resolved console operation path, a console opaque policy builder, and a broker
dispatch path. Console operations must not be lowered to `bash` and must not fall through
to normal one-shot `SandboxPort.execute`.

The policy unit is a **target-scoped session grant plus bounded operations**, not a
claim that every keystroke can be semantically classified. The warden grants a console
only for a resolved target profile: target id, argv/profile, cwd, filesystem roots,
egress profile, tty size, TTL, idle timeout, key/screen budgets, and teardown policy.
`open` creates an opaque warden handle. `send_keys`, `read_screen`, `release`, and
`close` are valid only for a live, matching handle and are still individually policy
checked and audited. `release` is a narrow exception to default teardown: it is denied
unless the reviewed target profile explicitly declares that the target may persist for an
external grader. If the broker confirms release, the result must state that the released
process is no longer warden-controlled; if the broker does not release, the handle remains
live and the result must not claim loss of warden control.

The primary enforcement layers are:

1. exact human-approved target/session grant;
2. SRT sandbox containment of the target process where possible;
3. egress profile/review, default deny;
4. handle/budget/lifecycle fail-closed checks;
5. per-operation audit and provenance;
6. warden-side redaction before model return or durable write.

Per-keystroke policy remains a validation layer for shape, size, and explicitly forbidden
harness-level controls. It is not the security boundary for opaque guest effects.

Console policy and audit use the existing side-effect taxonomy. `open` uses
`process_exec` plus the resolved target profile's conservative filesystem/network
envelope and `unknown` where opaque guest effects exist. `send_keys` inherits that target
envelope. `read_screen` is `unknown` scoped to the process/handle because it observes
untrusted live process state. `release` is `process_exec` plus `unknown` scoped to the
process/handle because it deliberately drops warden control while leaving the target
alive. `close` is process lifecycle cleanup. Every allowed or denied console operation
must append a schema-valid `sideEffect`.
Warden-initiated lifecycle/shutdown cleanup close attempts must also append a
schema-valid audit record before broker `close`; cleanup records carry
`cleanup.authority = "warden-structural"` so they are not confused with ordinary
policy-pack rule evaluation. If process identity is stale, missing, or unverifiable,
the warden appends a `tool.deny` cleanup-skipped record when audit is available and does
not call broker `close`. If the cleanup audit append itself fails, the broker close
effect is skipped and the stale handle is reaped from warden state.

## Sandbox and egress composition

The broker and target process are distinct.

- The broker is warden-owned control infrastructure. It owns the PTY/tmux/control
  channel, opaque handles, screen normalization, redaction, audit appends, and teardown.
- The target process is launched under the applicable sandbox profile. The target cannot
  read/write broker sockets, audit paths, keel config, secret sources, or other denied
  roots.
- Network egress defaults to empty. Loopback forwards used by VM tasks and any remote
  SSH/telnet endpoint are treated as egress and must be represented in the approved
  target profile.

The existing `SandboxPort.execute` contract is one-shot. A real console target therefore
needs a warden-internal long-lived sandbox launch/wrap seam that can produce a
sandbox-wrapped argv/env/cwd descriptor for the broker and defer cleanup until
close/abort/exit. If that cannot be implemented without weakening the current one-shot
`SandboxPort`, implementation stops for a sandbox-port ADR.

A VM console creates an honesty boundary. Keel can govern the host-side QEMU process,
disk paths, and host network egress. Keel cannot claim it governs arbitrary effects
inside the guest OS unless the guest is separately instrumented. Status lines, receipts,
and claim-ledger entries must say this plainly.

Some benchmark VM tasks require the VM to keep running after the agent process exits so
an external grader can connect. That is not ordinary cleanup. It requires an explicit
profile-gated `interactive_console.release` operation, audited before effect, after which
the warden handle is deleted only if the broker confirms release and the result says the
process is no longer warden-controlled. If the broker reports no release, the handle
remains live and warden-controlled. Default shutdown still reaps non-released handles.

QEMU host forwarding is not merely a domain allowlist. The local-VM target profile
therefore records explicit disk-image paths, loopback-only host forwards, loopback-only
local listeners, guest package download domains, and the audit-visible governance boundary
`host-qemu-process-governed_guest-os-ungoverned`. Host forwards/listeners are represented
as VM network targets, not ordinary domains; guest download domains are also surfaced
through the existing reviewed egress-domain path. This Slice 9 representation uses
internal console profile/audit extension metadata and does not change frozen shared
schemas. If later product evidence requires richer port/listener egress schemas or guest
instrumentation, that is a separate ADR.

## Audit, provenance, and redaction

The warden console path is the only raw console I/O chokepoint:

1. Broker reads raw console bytes.
2. Warden normalizes control bytes into a safe screen representation.
3. Warden redacts screen/key content before any model-visible result, session-ledger
   append, audit payload, snapshot, or public summary receives it.
4. Warden appends a hash-chain `tool.execute` or `tool.deny` record with JSON-safe
   payload, side-effect summary, target digest, handle identity, redacted frame/key
   summary, truncation flags, and policy/provenance fields.
5. Warden returns only the bounded, redacted screen to the kernel/model.

This requires a dedicated console result sanitizer before any RPC result is built. Audit
redaction is not enough: the kernel session ledger records the executor-returned
`ToolResult.output`, so console output must already be normalized and redacted before it
leaves the warden. Tests must cover the exact model/ledger string, not only the audit
payload.

Denied keystrokes and denied reads are audited with the same operation identity fidelity
as allowed operations. Screen buffers are untrusted model-visible input and must carry
`provenanceTag:"untrusted"` or the current equivalent open payload marker until a later
provenance-enforcement slice replaces that marker with claim-grade taint.

Post-plan hardening requires audit-before-effect for live operations: `open` writes a
sanitized intent record before broker launch, and `read_screen` writes the sanitized
returned frame before the frame is returned to the model. The returned `read_screen`
result must identify that sanitized-frame audit sequence, not only the pre-read request
event. Handle operations are session-bound at use time, partial broker `send_keys`
acceptance updates lifecycle budgets before retries, broker availability requires an
explicit broker status result, and `close` remains available as structural cleanup for
the opening session even if policy would deny ordinary console I/O. These are
implementation invariants, not behavioral promises left to the model.

ADR-0039 still applies: redaction is best-effort and format-based, not a perfect secrecy
guarantee. This console ADR improves the chokepoint by redacting before model return,
not merely before audit write. It does not claim novel secret formats cannot leak.

## PTY backend decision

Use a small internal `ConsoleBrokerPort` so backend risk is isolated.

The preferred first real backend family, if approved, is a **system `tmux` private-socket
broker** with:

- private warden socket;
- no user tmux server;
- no user/project tmux config;
- broker files denied to the target sandbox;
- doctor/unavailable diagnostics;
- no console tool advertisement when the adapter is unavailable.

This is not a final packaging commitment. The local macOS checkout used for this plan
does not have `tmux` installed. If CI/release packaging requires installing or vendoring
tmux or another PTY helper, that is a separate dependency/supply-chain approval.

The first implementation slice uses discrete argv-array `tmux` commands
(`new-session`, `display-message`, `send-keys`, `capture-pane`, `kill-session`) rather
than a persistent control-mode client. This is the smaller safety slice: it proves the
adapter boundary and unavailable-honesty path while avoiding a long-lived
control-protocol parser in the warden. A persistent control-mode client remains an
available follow-up if command-invocation latency, screen fidelity, or benchmark evidence
requires it.

If system `tmux` is approved, the adapter must clear inherited `TMUX`, use a sanitized
environment, use a fixed config path, pass target argv through a tested argv-array layer,
record the resolved binary/version, tie adapter availability to the sandbox launch-preparer
status, reject target launch descriptors that could make tmux parse a single shell-command
string instead of direct-exec argv, redact private socket/config paths from diagnostics, and
include injection tests for target ids, argv, cwd, socket names, and key strings.

Product wiring tightens that boundary further: product configuration must provide an
explicit absolute `tmuxPath` without shell syntax; the warden must not resolve tmux through
project/user-controlled `PATH`; inherited `TMUX` and `PATH` are excluded from the broker
environment; and broker disposal must run during warden shutdown/close after live-handle
cleanup so private socket/config roots do not survive only because no model-visible handle
was open. Product-configured QEMU targets must also provide an absolute QEMU executable
path; bare executable names remain available only to internal reviewed profiles, not to
parent-env product config.

Do not add `node-pty` for this epic without a separate dependency ADR and human approval.
ADR-0037 already rejected `node-pty` in the TUI test context because its native install
build conflicts with keel's `ignore-scripts=true` supply-chain invariant.

## Options considered

### Patch `bash` to be interactive

Rejected. This would weaken the deliberate `shell-session.ts` protocol isolation and let
foreground commands compete with the shell marker/control channel. The current bash tool
should remain one-shot, terminating, and marker-delimited.

### Kernel-local PTY side channel

Rejected. A kernel-local PTY would bypass the out-of-process warden mediation model and
would create a privileged side effect path not covered by policy, sandbox, egress, or
audit.

### Session grant only, no per-operation audit

Rejected. A stream is still a sequence of security-relevant operations. Denied and
allowed keystrokes/read attempts need durable audit records so the record survives the
agent.

### Per-keystroke semantic policy as the main boundary

Rejected. Byte streams into a VM, shell, or TUI are too opaque to classify accurately.
This would create security theater. Keystroke validation is useful for bounds and
syntax, but structural sandbox/egress/target grants are the real control.

### Rely on `expect` scripts

Rejected as a claim-grade harness solution. `expect` is useful userland automation, but
model-authored scripts do not give keel first-class screen/keystroke audit, provenance,
redaction, target grants, or reliable live screen polling.

### Add `node-pty`

Rejected for this epic. It conflicts with the existing `ignore-scripts=true` supply-chain
posture unless separately reviewed and approved.

### System `tmux` private-socket broker

Recommended first adapter if approved. It matches the prior-art affordance from the
terminus trajectories and avoids an npm install-script dependency. The tradeoff is
packaging and binary-availability risk; the tool must be hidden or reported `NOT_RUN`
when no approved broker is available.

### Vendored PTY helper or vendored tmux

Deferred. It may be more reproducible than a system dependency, but it introduces
compiled/native supply-chain and platform-maintenance work. It needs its own ADR.

## Consequences

- Interactive console support becomes a first-class governed tool family rather than a
  side channel.
- The first implementation can reuse existing `warden.execute` and `tool.execute` /
  `tool.deny` audit records, reducing frozen-interface churn.
- The model receives only opaque handles and redacted, bounded screen frames.
- Live handle operations must append a durable sanitized audit record before the broker
  sends keys, reads a screen, or closes/deletes a handle. If that audit append fails, the
  broker is not called and handle state is not mutated. Broker failures after a successful
  pre-effect audit are separately audited as denied console attempts with redacted
  diagnostics.
- Autopilot cannot open a console merely because it is confident; exact target grants and
  structural containment remain required.
- Console grants bind to the resolved authorization contract, not only to a display name:
  session/workspace, target id, target digest, sandbox profile, approved open geometry,
  lifecycle limits, target command/cwd/filesystem/egress profile, policy pack,
  side-effect envelope, and matched rules. The approval principal is stored on the
  warden-owned grant/handle state and audited; it is not accepted from model-supplied
  console operation arguments.
- Opened handles carry broker-returned process identity and warden-owned lifecycle
  counters. Successful opens append a second sanitized audit record containing that
  process identity before the handle becomes live; if that audit append fails, the broker
  handle is closed and no live handle is registered. Live handle operations must recheck
  that process identity before keystroke, screen-read, release, or close effects; broker
  `live` is advisory and is accepted only when the broker also returns an observed
  identity that canonically equals the stored identity. Stale, missing, or mismatched
  identity fails closed and is audited before the warden handle is reaped. Cleanup and
  shutdown close attempts must also verify identity first for non-pending handles; stale or unverifiable handles are reaped from
  warden state without issuing a close through that handle.
- Release is target-profile gated, not a model preference. If `allowRelease` is absent or
  false, the operation is denied and audited without calling the broker. If release is
  allowed, the broker may preserve the target session for an external grader, but keel
  must not claim continued warden enforcement over a broker-confirmed released process.
  If the broker reports `released:false`, keel keeps the handle and reports that the
  target remains warden-controlled. The audit stream records both the pre-effect release
  request and the post-broker outcome `{ released, wardenControlled }`.
- Console reviews use a console-specific review/grant store. The existing
  command-review grant store is bash-command-shaped and must not be reused for console
  authority. If the existing `review.allowCommand` field is too misleading for a console
  target summary, a typed-review protocol ADR is required.
- `warden.hello` may advertise an additive console capability string such as
  `interactive-console:v1`, but kernels must not advertise console tools unless that
  capability is present, the broker is available, and the workspace is trusted.
- Keel can pursue the two qemu benchmark tasks after the mediation model is implemented,
  but it cannot claim that uplift until current-head reruns pass.
- Remote consoles remain review-only/out of scope until provenance and egress enforcement
  can honestly support them.
- Guest VM internals remain outside keel's governance claim unless separately
  instrumented.
- Packaging/CI for a real PTY backend remains an explicit open decision.

## Required evidence before accepting an implementation

- Denied-path tests for missing grant, forged handle, expired handle, target mismatch,
  budget exhaustion, forbidden key chunk, remote egress, audit failure, redaction failure,
  broker unavailable, and stale process identity.
- Positive walking skeleton through real warden routing, target sandbox, redaction,
  provenance, audit, and close/reap.
- Secret/control-sequence adversarial tests proving no raw probe appears in tool result,
  session ledger, audit payload, snapshot, or public summary.
- Tool-advertisement tests proving unsupported/ungoverned runtimes do not expose console
  operations.
- Optional real-adapter smoke reported separately as pass or `NOT_RUN`.
- At least one approved real adapter passing on a named platform before any usable-console
  claim. Fake-broker tests prove policy/audit behavior only.
- Current-head qemu reruns before any qemu benchmark uplift claim.

## Decision defaults and remaining gates

In the 2026-07-09 planning review turn, the maintainer accepted the recommended defaults:

- use this grant + sandbox/egress + per-operation audit model;
- use system `tmux` as the first real backend family only if doctor/CI/packaging review
  approves it, with discrete private-socket commands as the first slice and persistent
  control mode only if later evidence requires it;
- keep ADR-0069 for console and leave ADR-0068 available for process-lease reconciliation;
- start through existing `warden.execute` and stop for a protocol ADR if the existing
  review/RPC shape is insufficient;
- use redacted normalized screen frames only, with no raw forensic mode in the first
  slice.

This ADR is accepted for the approved slice-by-slice Epic 2.34 implementation. The
remaining gates are concrete implementation gates: stop for a protocol ADR if existing
`warden.execute` routing is insufficient, stop for dependency approval before any
native/install-script PTY backend, and keep real-adapter, QEMU, and guest-governance
claims unmade until current-head evidence proves them. Any released VM evidence must be
reported as external-grader persistence after warden release, not as continued warden
control.
