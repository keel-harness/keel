# ADR-0078 — Warden-observed mutation review without model or ledger carriage

**Status:** Accepted for prerequisite implementation by owner decision on 2026-07-22. Protocol 1.1
is not effective until the Appendix A amendment, `PROTOCOL_VERSION` bump, and ADR-0012 compatibility
row land atomically in one commit. Epic 3.10 Slice 2B remains gated on that atomic amendment and the
independently landable SEC-310-01 typed-mutation hardening.

**Date:** 2026-07-22

**Relates to:** ADR-0012 (RPC versioning), ADR-0021 (`ExecutorPort`), ADR-0035 (session ledger),
ADR-0036 (pure TUI reducer), ADR-0072 (durable-format evolution), ADR-0073 (presentation evolution),
MASTER_SPEC `4.2`–`4.3` and frozen Appendix A, and Epic 3.10 Slice 2A.

## Context

Keel currently creates edit lines from the model's requested `oldString` and `newString` when the
`tool-call` event arrives. That is intent before policy, review, execution, audit, containment, and
settlement. A denied or failed request can therefore look like a completed change.

The governed typed-mutation path is the only eligible producer of stronger evidence, but the live
repository trace found two limits that the original proposal overstated:

1. The portable helper checks an edit hash and then performs an unconditional rename. `write` does
   not bind an expected preimage or expected absence. Another writer can change the path in the
   check-to-rename window, and a same-workspace symlink can cause the bytes read through the link to
   differ from the directory entry replaced by rename. Stable parent-directory identity is also not
   bound by the contained helper.
2. The handler's final audit append is not the outer production settlement boundary. The stdio
   transport performs a later sandbox-temporary-root postcheck and may replace an apparent success
   with `SANDBOX_TEMP_ROOT_POSTCHECK_FAILED` and `actionMayHaveExecuted:true`.

Consequently, the current portable producer can support a trustworthy statement about observations
it made, but not a linearizable statement about the exact object displaced by rename. This ADR does
not relabel that limitation as authoritative. It changes the proposed product contract to
**warden-observed before state → verified installed after state**, with the transition explicitly
marked `not-atomic` / concurrent mutation not excluded.

An exact operation-effect diff would require an atomically bound no-replace/exchange/CAS primitive,
no-follow target semantics, stable-parent binding, crash/recovery analysis, and cross-platform proof.
That is a separate security-sensitive architecture decision, not a styling task.

## Decision drivers

- The warden is the sole production producer; request args and post-hoc kernel reads are not truth.
- Presentation never changes a settled tool result, causes a retry, or delays the tool's execution
  deadline after settlement.
- The UI distinguishes observed evidence from an atomically proven transition.
- Raw pre/post images stay inside bounded warden memory and never cross the RPC boundary.
- Producer-only bytes do not enter model context, public serialized events, session/audit JSONL,
  eval trajectories, or internal application/debug/diagnostic logs and errors through this feature.
  Configured `UIPort` output is an explicit presentation sink and has its own retention contract.
- Protocol 1.0 peers pay no presentation capture, construction, latency, or storage cost.
- Every missing, unsupported, bounded, stale, and output-channel state is explicit without creating
  a cross-call store oracle.
- Ink and headless preserve the same consequential meaning without mutating committed scrollback.

## Options considered

### 1. Keep request-derived diffs

Rejected. Intent can contradict denial, review, execution, and final settlement.

### 2. Read the workspace from the kernel or TUI after execution

Rejected. It cannot recover the preimage, races external and symlink changes, and manufactures
authority outside the enforcement boundary.

### 3. Put a structured artifact in `ToolResult`, public `KernelEvent`, session, or audit

Rejected. Those serialized paths reach the model, durable ledger, eval consumers, or frozen public
contracts. The chosen design associates a lazy resolver with the exact in-process `ToolResult` and
`KernelEvent` through module-private `WeakMap`s; the resolver is not an object property or artifact
and is absent from every JSON/schema boundary.

### 4. Nest the artifact in generic `ExecuteResult.result`

Rejected. Older kernels stringify an unknown successful object into model context and session JSONL.

### 5. Add an optional field to the 1.0 execute envelopes

Rejected. Existing strict readers reject unknown top-level fields, and review settlement would need
a second changed envelope.

### 6. Add a negotiated one-shot presentation method plus lazy in-process resolver

Chosen. Protocol 1.1 adds a new method while preserving existing execute/review response bytes.
Retrieval begins only after the matching successful result survives the kernel deadline and is
durably recorded. The protocol change is not effective until its atomic amendment commit lands.

## Decision

### 1. Evidence semantics and producer

The only production producer is the enforcing warden typed-mutation path. When capture is supported
and bounded, it may report:

- `observedBefore`: `file-observed`, `absent-observed`, or `not-inspected`;
- `verifiedInstalledAfter`: a regular-file image verified after replacement;
- `transitionBinding:"not-atomic"`;
- `concurrentMutation:"not-excluded"`;
- a complete, truncated, summary-only, or unknown comparison between those two observations.

The schema and UI do **not** say `created`, `modified`, `removed`, or `exact operation diff` for this
producer. Red rows mean “observed before”; green rows mean “verified installed after.” `complete`
means the comparison between the two captured images completed within budget, not that no third
party wrote between observations.

For a stable regular file, the helper must enforce no-follow identity checks for the leaf and every
path component, reject dangling links, bind the parent directory identity across preparation and
settlement, check the expected hash or expected absence immediately before replacement, and verify
the installed postimage immediately afterward. If the platform/backend cannot enforce that complete
v1 identity contract, capture is unavailable and the capability is not advertised. Detected
identity, containment, parent, or postimage drift suppresses review evidence and follows the existing
failed/`mutationPossible` path. These checks narrow races; they do not upgrade `transitionBinding` to
atomic.

Same-workspace symlink targets are `uncaptured` in v1. A future schema may explicitly distinguish
editing a referent from replacing a symlink, but this ADR does not guess. Preimages over the capture
ceiling are `not-inspected`; no hash, binary classification, final-newline fact, unchanged claim, or
line comparison is emitted for bytes that were not fully read.

### 2. Mutation settlement is separate from presentation settlement

The typed-mutation runner must return an internal settlement structure that separates:

- mutation: `committed | failed | indeterminate`;
- optional bounded capture candidate or sanitized unavailability disposition;
- cleanup: `complete | retry-required`.

Mutation/identity/containment uncertainty remains execution-significant and may produce
`mutationPossible`. Diff construction, redaction, schema validation, store capacity, promotion, and
presentation cleanup are optional presentation work: after a committed mutation they cannot throw
through, rewrite, or retry the already determined tool result.

The existing payload cleanup defect is a prerequisite, not something this ADR hides. A cleanup
exception after a successful helper exit must not turn a committed mutation into a retryable false
failure. Private payload/capture files use owner-only bounded storage, never enter stdout/stderr or
error copy. The warden retains at most one cleanup-debt directory. Its exact disk ceiling is
`3 MiB + 128 KiB`: at most the existing 1 MiB request-frame payload, one 2 MiB captured preimage, and
128 KiB helper/metadata. Pending/final presentation images live in the separately bounded in-memory
store; no second raw capture file or postimage copy is allowed. The warden retries that debt before
accepting another typed mutation and fails closed for later mutations while the debt remains; the
already committed original mutation is never retried. Teardown retries once, reports only a sanitized
control-plane diagnostic if debt remains, and cannot accumulate a second directory. Tests inject
failure at every retained-file size, repeated deletion, and teardown failure; they prove exact disk
bytes, no second debt, and no payload bytes in diagnostics.

### 3. Two-phase outer-transport finalization

Captured images are initially an untakeable, bounded candidate. The production-only internal handler
performs the final execution audit append first and returns a transport-owned wrapper containing the
ordinary validated response and a separate internal candidate reference; exported/public response
helpers expose only the strict response. Expensive diff/redaction construction is not awaited on the
execute/review return path.

The production transport owns the candidate in an internal sidecar/wrapper that is not a property of
the public `RpcResponse` object and cannot be reached by response enumeration or reflection. It
finalizes a candidate in this order:

1. validate the ordinary response schema and serialize the unchanged response bytes;
2. pass the sandbox-temporary-root postcheck;
3. write the successful response and await the output stream's accepted write/flush callback;
4. promote a small pending presentation entry, schedule guarded cooperative construction, and only then
   release the server's serial request queue for a following `take`;
5. catch construction, redaction, validation, and store failures into a sanitized unavailable
   disposition; discard raw images promptly.

Postcheck failure, response validation/serialization failure, error substitution, output failure,
shutdown, bypass transport, audit failure, `mutationPossible`, or finalizer exception discards the
candidate. Promotion failure occurs after the execution response is settled and therefore yields
presentation unavailable without changing execution.

The capability is advertised only by a production transport that installs this finalizer. Direct
`handleRpcLine` users and test/bypass transports do no capture unless they install the same tested
finalization contract.

### 4. Protocol 1.1 carrier and negotiation

The protocol-amendment commit atomically amends frozen MASTER_SPEC Appendix A from `1.0.0` to
`1.1.0`, adds `warden.presentation.take`, bumps `PROTOCOL_VERSION`, and adds the ADR-0012
compatibility row. Protocol 1.1 becomes effective only when that exact commit lands and passes its
independent review and exact-head CI gate; Slice 2B cannot start earlier.

Protocol `1.1.0` adds hello capability `mutation-presentation/v1` and method
`warden.presentation.take {sessionId, toolCallId, auditSeq}`. The server persists the peer protocol
minor in connection context. Peer protocol `>=1.1`, successful capability negotiation, an active
audit writer, the enforcing typed-mutation runner, and the outer finalizer are all required before
capture or storage work starts. For a peer minor below 1.1, the warden omits
`mutation-presentation/v1` from hello. The hello response necessarily reports the warden's 1.1
protocol version, but every pre-existing **non-hello** method response envelope—especially execute
and resolve-review—remains byte-shape-identical, and that peer incurs zero presentation-only capture,
diff, redaction, construction, or store work. Mandatory typed-mutation identity-enforcement
hashing/hardening is an execution-security prerequisite for all peers and is excluded from this
presentation-compatibility promise.

`auditSeq` is an exact correlation component, not a signature or claim that audit commits to the
artifact. Sequence zero is valid when produced by an active writer and is not tested by truthiness.
The explicit `auditBound`/capability state distinguishes a real sequence-zero record from the
current no-writer sentinel, where capability is absent and no entry is registered.

The wire result is a strict `MutationPresentationTakeResultV1` union:

- `{status:"available", artifact: MutationPresentationV1}` — atomically returns and consumes the
  terminal entry;
- `{status:"pending", retryAfterMs}` where `retryAfterMs` is a finite integer from 1 through 25 —
  non-consuming and immediately bounded;
- `{status:"unavailable", reason}` where the closed v1 reasons are
  `not-found-or-consumed | capture-unavailable | capture-budget | redaction-failed`; a stored
  terminal unavailable disposition is atomically returned and consumed.

Wrong keys, never-present keys, expired/evicted entries, and duplicate takes all return the same
opaque `not-found-or-consumed` and never consume another entry. Adding a status or reason requires a
new capability/schema revision; a 1.1 client treats an unknown/invalid response locally as invalid,
not as execution failure.

`take` stays on the server's serial queue and never performs project I/O. A pending response is
immediate. The kernel uses one absolute monotonic 250 ms deadline, a 25 ms minimum per-call window,
and at most 11 total calls. Before each call, remaining budget below 25 ms settles local
`presentation-timeout`. Otherwise the ordinary Warden client call uses an explicit timeout of
`min(100 ms, remaining deadline)`; it never abandons an in-flight call with `Promise.race`. After a
completed pending response it waits `min(retryAfterMs, remaining deadline)`. When insufficient budget
remains between completed calls, it issues no new call. An in-flight call that exceeds its explicit
remaining timeout is a real transport failure and retains the existing fail-closed Warden-client
semantics.

### 5. Bounded store and construction

The store uses a per-warden-session secret to HMAC a length-prefixed composite key. Raw session IDs,
tool-call IDs, and paths are not retained as map keys or echoed in artifacts. The process-local UI
occurrence token is not sent over RPC; it is bound by the exact resolver-bearing result object.

Slice 2B pre-registers exported, tested limits:

- full inspection only when each observed image is at most 2 MiB;
- at most two pending raw candidates and 8 MiB total pending bytes;
- exactly one active constructor;
- at most 16 finalized artifact entries and 4 MiB serialized artifact/key bytes;
- a separate reserved lane of at most 64 terminal disposition entries and 64 KiB total fixed-key /
  disposition bytes so capacity refusal can return `capture-budget` rather than disappear; terminal
  state is therefore at most 80 entries and `4 MiB + 64 KiB` before the global ceiling;
- a 32 MiB global presentation-memory ceiling including raw images, worst-case decoded strings, line
  tables, diff frontier, redaction spans, output, keys, dispositions, and bookkeeping; reserve the
  worst-case active working set before construction;
- finalized artifact at most 256 KiB, 2,000 presented lines, 128 hunks, 8 KiB presented UTF-8 per
  line, and 512 bytes for the redacted display path;
- at most 20,000 indexed lines, 2,000,000 diff scalar operations, and 8 MiB of redaction byte visits;
- a 200 ms absolute construction deadline, with cooperative yield after at most 64 KiB of byte work,
  2,048 scalar operations, or 2 ms of monotonic wall time, whichever occurs first;
- pending construction TTL 2 seconds and finalized-entry TTL 30 seconds, both monotonic;
- deterministic oldest-registration-first eviction after expired entries are purged;
- no per-entry ref'd timers: injected monotonic lazy purge on reserve/promote/take plus shutdown
  clearing;
- exact accounting for fixed keys, candidates, artifacts, sanitized dispositions, and metadata.

Capacity is reserved before optional capture. Failure to reserve skips capture without changing the
mutation and records `capture-budget` in the reserved disposition lane when possible. Oversize
preimages may expose bounded stat metadata only; hashing or classifying an arbitrarily large
overwritten file is forbidden. Exact shown/hidden totals are emitted only when computed;
comparison-budget exhaustion uses a typed `unknown`, never a guess.

Construction runs after response settlement as an explicitly cooperative state machine, not a
synchronous task hidden behind a Promise timeout. Every pending entry has an opaque generation
token. Completion may compare-and-promote only if that exact token remains current, unexpired, and
not cancelled. Expiry, deterministic eviction, take, shutdown, and failure invalidate the token and
release its bytes exactly once; late completion discards output and cannot resurrect an entry.
Construction throw, redactor throw, work/deadline/allocation exhaustion, promotion failure, and
shutdown become sanitized unavailable outcomes. Shutdown cancels the constructor, reaches its next
bounded yield, drains it, clears every raw/final entry, and leaves no timer or pending promise.

Adversarial maximum-size/repeated-line tests inject the monotonic clock and cooperative scheduler,
prove no step exceeds its byte/operation/yield cap, and interleave `warden.status`, pending `take`,
shutdown, and a later execution before construction completes. A real integration probe requires
each to respond or begin within 250 ms—well below the default 5 s client timeout—and records event-loop
delay and peak transient memory under the 32 MiB presentation ceiling.

### 6. Process-local lazy resolver and exact occurrence ordering

`ExecutorPort`, `ExecutorExecutionOptions`, exported `AgentLoopInput`, and exported
`WardenExecuteClient` remain unchanged. Production runtime injects an optional presentation-take
closure into `WardenExecutorOptions` only after validated hello negotiation. Fake, alternate, and
external clients need not implement a new overload.

All direct, session-grant, plan/Autopilot, and live-human-review success paths first normalize to one
internal settled shape carrying the final `ExecuteResult|ResolveReviewResult` and rendered
`ToolResult`. One common decorator verifies a successful built-in `write|edit`, retains the **final**
audit sequence, and registers exactly one memoized lazy resolver in a module-private `WeakMap` keyed
by the exact result object. The active resolver is never an own property discoverable through
`Reflect.ownKeys`. Denied, terminal, cancelled, failed, indeterminate, audit-failed, or
`mutationPossible` outcomes get no success resolver.

Private helpers transfer the resolver from the exact result into a second module-private `WeakMap`
keyed by the exact public-shape `tool-result` event. `runSession` mints an opaque occurrence identity
unique for its entire lifetime—including every steering re-drive—and carries it through private
WeakMap associations for call, result, and `UiToolActivity`; provider IDs are never the correlation
key. JSON, zod parsing, provider mapping, session recording, and eval serialization see none of these
associations. A kernel-only infra timeout abandons the executor promise before any resolver reaches
the runner; a later warden success may leave an entry to expire, but it can never be folded or
rendered.

The presentation barrier settles one strict process-local `MutationPresentationResolutionV1` union:

- `{status:"available", artifact}` after strict client validation; or
- `{status:"unavailable", reason}` where the closed local reasons are
  `unsupported-peer | capability-unavailable | executor-no-resolver | capture-unavailable |
  capture-budget | redaction-failed | not-found-or-consumed | invalid-response |
  presentation-timeout | transport-failed | occurrence-ended`.

Wire reasons map to the same-named local capture/not-found reasons. A present memoized resolver
returns available or the wire/channel outcomes. `WardenExecutor` may synthesize `unsupported-peer`
without RPC only when the negotiated server protocol is below 1.1. Protocol 1.1+ without the
capability maps to `capability-unavailable`, not an old-peer claim. `runSession` synthesizes
`executor-no-resolver` when no resolver exists. Malformed wire data maps to `invalid-response`; local
budget expiry maps to `presentation-timeout` without abandoning an in-flight call; Warden client
failure maps to `transport-failed`; and steering/interrupt/teardown invalidation maps to
`occurrence-ended`. The ViewModel uses deterministic grouped copy: unsupported peer,
capability-unavailable, and no-resolver say why capture support was absent without inventing a diff;
capture budget or safe-redaction failure names that boundary; opaque not-found says only
`review artifact unavailable or already consumed`; channel invalid/timeout/failure says review
unavailable; occurrence-ended is folded only if the successful card remains live, otherwise the
invalid occurrence is dropped. New reasons require an explicitly versioned local union and exhaustive
reducer test.

After the recorder durably appends the public tool result, `runSession`:

1. reduces the exact occurrence into a settled-but-presentation-pending mutable card;
2. applies queued/urgent/interrupt boundary decisions before the first settled render;
3. if a boundary ends the occurrence, does not invoke the resolver, immediately folds
   `unavailable/occurrence-ended`, releases the barrier, and invalidates the token;
4. otherwise renders only a mutable pending card, starts the memoized resolver outside the executor
   deadline, and follows the exact 250 ms polling contract without passing the turn abort signal into
   the Warden RPC;
5. if steering, interrupt, stop, teardown, or UI failure arrives while waiting, immediately folds
   `unavailable/occurrence-ended`, releases the barrier, invalidates the token, and stops future
   polls; an already in-flight call is not aborted or abandoned—its promise remains observed and its
   eventual result is discarded;
6. on local expiry, first folds `unavailable/presentation-timeout` and releases the barrier, then
   invalidates the token so later completion is ignored;
7. folds one private strict resolution targeted by occurrence identity;
8. makes the card eligible for immutable/append-only renderer settlement.

An occurrence-end listener drives step 5 even during an inter-poll delay or in-flight call;
cancelling an inter-poll delay is safe, while every started RPC remains observed through settlement.
A transport failure may still close the current Warden client under its existing fail-closed
semantics: the durable successful tool result remains first, presentation says unavailable, and
subsequent enforcement liveness halts distinctly; no tool retry occurs.

Ink may show the pending card in its mutable live region, but neither Ink `Static` nor headless emits
a final card until the presentation barrier settles. Later governed freshness observations append a
new referenced observation; they never rewrite committed scrollback.

### 7. Artifact and redaction representation

`MutationPresentationV1` is strict, versioned, JSON-safe, and contains:

- producer `warden-typed-mutation`, operation `write|edit`, final `auditSeq`;
- redacted workspace-relative display path and opaque per-session keyed path identity;
- `observedBefore`, `verifiedInstalledAfter`, `transitionBinding:"not-atomic"`, and
  `concurrentMutation:"not-excluded"`;
- raw SHA-256, bytes, regular-file mode, text/binary class, and final-newline state only for a fully
  inspected image;
- deterministic `context | observed-before | installed-after` lines with source line numbers;
- `complete | truncated | summary-only | unknown` comparison coverage with exact or explicitly
  unknown totals;
- structured display segments `literal | redacted`, plus derived redaction counts;
- freshness `{basis:"warden-observation", currentWorkspace:"not-observed"}`.

Raw bytes, raw absolute paths, and unstructured redaction markers are not fields. The warden computes
hashes/diff structure within budget, then performs structured redaction over bounded multi-line
windows so catalog matches can cross line boundaries. Literal marker-shaped text remains a literal
segment; generated redactions are typed segments. UTF-8 boundary handling is overlap-safe. ESC/OSC,
CR, C0/C1 controls, bidi overrides, and U+2028/U+2029 are converted to visible inert segments in the
warden before truncation. Only then are per-line/hunk/payload ceilings applied.

The shared current string-only redactor cannot prove these properties. Slice 2B requires a red-first,
span-aware presentation redactor; it does not infer span counts by searching replacement markers.
Redaction remains defense in depth, not a proof that arbitrary source contains no secret.

### 8. Output, persistence, and replay

The resolver, structured artifact, hashes, path identity, occurrence token, and private event are
not internally persisted or serialized into model, session, audit, public event, or eval formats.
Selected redacted presentation text is intentionally emitted through the configured `UIPort` and may
be retained by a terminal, CI log, or custom UI implementation. Keel must not claim otherwise.

The recommended safe default is:

- interactive Ink: bounded redacted comparison text in compact/full disclosure;
- headless/non-TTY: redacted path/status/count summary only, with no line content;
- no new full-hunk CLI flag in Slice 2B; any opt-in is a separately reviewed public CLI change.

The owner accepted this headless default on 2026-07-22. Custom `UIPort` implementers receive redacted
ViewModel presentation and are responsible for their output retention.

Session JSONL retains only its existing redacted model-facing result string. Audit retains the
existing intent/result record and does not commit to the presentation. Resume/replay renders
`review unavailable — live mutation observations were not persisted`; it never reconstructs lines
from request args or the current workspace.

### 9. Mutation-path disposition

| Mutation source | Slice-2 disposition |
|---|---|
| Governed typed `edit`, stable regular file, bounded images | Warden-observed comparison with non-atomic transition caveat |
| Governed typed `write`, stable regular file, bounded images | Same; absence is only `absent-observed`, never an atomic create claim |
| Same-workspace symlink or unstable parent identity | Explicitly uncaptured in v1 |
| Oversize/binary preimage | Bounded summary; content identity/comparison unknown unless fully inspected |
| Local/eval typed tools | Explicitly uncaptured; no production authority |
| Governed bash | `workspace effects not captured for this tool` |
| MCP | `workspace effects not captured`; server patches remain untrusted output |
| Interactive console | `workspace effects not captured` |
| External/user/IDE mutation | No operation card; later governed observation may append divergence evidence |
| Simulator/test executor | Visibly test-only fixture resolver; never production authority |

The current request-derived `editDiffFromArgs` is removed from both live and resumed construction in
Slice 2B. A running card may show a control-neutralized target labeled `requested`; it shows no line
comparison before settlement.

## Security and claims

This ADR adds no sandbox, atomic-transition, current-workspace, durable-audit, tamper-evidence,
replay, or secret-absence claim. The improvement is narrower: for captured governed typed mutations,
model intent no longer masquerades as execution evidence, and the presented observations originate
inside the enforcing producer.

Isolation proof is differential. Presentation must introduce no **producer-only** bytes, canonical
paths, controls, or preimage content into model messages, public serialized events, session/audit
JSONL, eval records, or internal application/debug/diagnostic logs and errors beyond the pre-feature
baseline. Configured `UIPort` terminal/headless/custom output is excluded from that internal-carrier
claim and is tested separately for the bounded redacted/summary-only contract. Tests use a
preimage-only fake secret and canonical path absent from model args. Requested path/postimage text
already exists in model context and is governed by existing redaction; this ADR does not make the
impossible claim that it was never there.

## Required red-first proof before Slice 2B acceptance

- 1.0↔1.1 both directions; old peer receives identical pre-existing non-hello response envelopes and
  causes zero presentation-only capture/diff/redaction/construction/store work. Mandatory
  identity-enforcement hashing is tested separately and applies to all peers.
- Frozen Appendix A and generated protocol schemas agree on 1.1, capability, method, and compatibility.
- Direct, warn/modify, session grant, plan/Autopilot, and human review use the final audit sequence and
  one common resolver decorator; all denied/indeterminate paths cannot expose success presentation.
- Postcheck, response validation/serialization, output-write, promotion, construction, redaction,
  cleanup, and shutdown failures preserve the correct execution disposition and cannot leak a
  takeable success candidate.
- Outer tool timeout, presentation timeout, transport failure, late completion, duplicate provider
  IDs across turns, steering, interrupt, and teardown preserve occurrence isolation and never retry.
- Sequence zero with active audit writer works; no-writer zero has no capability/work; wrong keys do
  not consume a real entry.
- TTL boundary, lazy purge, deterministic eviction, capacity rejection, huge tool-call ID, atomic
  take, duplicate take, and pending polling prove all entry/byte/work bounds.
- Regular overwrite, absent-observed write, identical-byte write comparison, identical edit
  validation refusal, pre-dirty/non-git/untracked, repeated edit, parent relocation, same-workspace
  symlink, postimage mismatch, external race fixture, binary, invalid UTF-8, missing final newline,
  long line, oversize image, and complexity exhaustion.
- Structured redaction covers UTF-8 cuts, multi-line/PEM/split credentials, marker-shaped literals,
  ESC/OSC, CR, C0/C1, bidi controls, and U+2028/U+2029 before truncation.
- The differential isolation fixture finds no new producer-only source in model, public event,
  session, audit, eval, or internal application/debug/diagnostic log/error carriers; configured
  `UIPort` output is verified separately against its redacted interactive/summary-only headless rule.
- Ink pending barrier/Static settlement, headless summary-only output, compact/full disclosure,
  narrow/no-color/`TERM=dumb`, resume degradation, and append-only later observations agree.

## Consequences and owner decisions

The owner accepted all four decisions on 2026-07-22, with these binding conditions:

1. Product meaning is `observed-before → verified-installed-after`, explicitly
   `transitionBinding:"not-atomic"` and `concurrentMutation:"not-excluded"`. This producer never
   emits `created`, `modified`, `removed`, or `exact-diff`.
2. Protocol `1.1.0`, `warden.presentation.take`, and Appendix A `1.0.0 → 1.1.0` use ADR-0012's
   additive-MINOR path. The Appendix A amendment, `PROTOCOL_VERSION` bump, and ADR-0012 row must land
   atomically in one commit. A contract test must prove hello reports 1.1 while `execute` and
   `resolve-review` response bytes remain identical for a 1.0 peer.
3. Headless/non-TTY mutation output is summary-only by default; full output requires an explicit
   opt-in contract.
4. SEC-310-01 hardening is independently landable and precedes the protocol amendment:
   no-follow leaf and component identity, stable-parent binding, expected hash/absence before
   replacement, verified postimage, and cleanup-after-commit settlement. It closes a pre-existing
   containment gap without upgrading the security claim or claiming an exact transition.

The module-private resolver isolation is load-bearing: a test must prove the artifact is absent from
JSON serialization, session JSONL, audit, and eval trajectories. Any producer byte reaching the
model, audit, session, or eval; a MAJOR protocol bump; or a typed-mutation security-claim change is a
new stop-and-ask.

Implementation sequencing required SEC-310-01 and the atomic protocol amendment to receive independent
review and exact-head CI before the first bounded stable-file edit flowed from Warden observations
through the resolver into Ink and summary-only headless output. Store caps and the full adversarial
suite followed as separately reviewed slices.

## Independent review record

The first contract, security, and reliability reviews all returned **REJECT** on the callback-based,
pre-postcheck, atomic-transition-claiming draft. The revision incorporated their required lazy
resolver, outer finalizer, occurrence, store, scheduler, redaction, output, bounds, cleanup, and claim
corrections. Final independent re-review returned **ACCEPT** under all three lenses on 2026-07-22:

- contract/compatibility: accepted the versioned method, old-peer zero-presentation-work boundary,
  private WeakMap carrier, strict wire/local unions, exact polling, and frozen-spec owner gate;
- security/claims: accepted the observation-only meaning, sidecar/finalizer, mandatory identity
  prerequisites, cooperative liveness bounds, structured redaction, differential isolation, and
  explicit output retention;
- reliability/bounds: accepted settlement separation, numeric scheduler/store/debt limits,
  generation invalidation, barrier ordering, append-only renderer rule, and failure/teardown proofs.

Product tests were `NOT_RUN` because this is a documentation-only architecture decision. The owner
accepted the decision on 2026-07-22. The atomic protocol amendment, standalone producer-hardening red
suite, their independent reviews, and exact-head CI remain open prerequisites before Slice 2B.
