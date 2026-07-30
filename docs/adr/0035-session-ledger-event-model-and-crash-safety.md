# 0035 — Session ledger event model & crash-safety

**Status:** accepted
**Date:** 2026-06-14
**Relates to:** ADR-0008 (append-only JSONL + atomic-rename snapshots), MASTER_SPEC §4.7.1-A
(the immutable event ledger as source of truth), §4.10 (mid-run steering)

## Context

Epic 1.4 builds the session ledger — the canonical, append-only JSONL record from which the
active model context is regenerable (§4.7.1-A). It must persist a run, resume it (rebuild the
`ModelMessage[]` view), branch it, persist mid-run steering, survive a crash, and back a thin
`keel sessions` CLI. The Phase-0 `SessionEvent` schema was a designed stub explicitly marked
"refined when sessions land in Phase 1". Several decisions needed this durable record; executable
evidence lives in the public session-ledger tests.

## Decisions

**1. Persistence consumes the loop's public event stream (no loop change).** The recorder is a
passthrough generator that tees `runAgentLoop`'s `KernelEvent`s onward while *folding* them into
durable `SessionEvent`s. The merged Epic 1.1 loop is untouched (its own doc-comment already
declared "sessions reduce these into the durable JSONL log"). *Rejected:* adding a
`message-appended` hook to the loop — more faithful-by-construction but mutates a completed epic.
Fidelity is instead guaranteed by a **round-trip property**: `rebuild(record(loop)) ≡` the loop's
own final messages, over random simulator scripts (text / tools / verification / budget /
loop-detection injections). The two recorder↔loop couplings are deterministic and test-guarded:
tool-result `name` is recovered by id from the turn's tool-calls; loop-detection guidance comes
from `RecordConfig.loopGuidance` (default `KERNEL_STRINGS.loopGuidance`, mirroring the loop).

**2. The `SessionEvent` union is refined to mirror what the loop produces.** Message-bearing
events `user · assistant{content, toolCalls?} · tool_result{toolCallId, name, output, isError?} ·
system` map 1:1 to `ModelMessage`. The standalone `tool_call` event is **removed** (folded into
`assistant.toolCalls`). `tool_result` carries a string `output` + `name` (the executor yields
`{ok, output:string}`; the Phase-0 `result: JsonValue` was a guess). Metadata events
`session_meta` (first-line header: id, createdAt, cwd, optional `parent` lineage) · `run_status`
(once per run: `reason` + `usage`) · `steering` are **excluded from the rebuilt message history**.
This is a non-frozen schema change (the schema's own note authorized it); a consumer check
confirmed nothing depended on the old shapes.

**3. Crash-safety = single-write-per-line + a tolerant reader; durability = fsync.** The writer
holds an append-mode fd and writes each event in one buffer (looping only on a short syscall),
then `fsync`s — so a record is durable past power loss and a crash leaves at most a torn final
line. The reader drops a torn/invalid **final** line (at most the last event is lost) but throws
`SessionCorruptError` on any corrupt **non-final** line or a missing header — "never corrupt
beyond the final line", proven by a fast-check property over random truncation offsets. fsync is
per-event by default; a batched policy is a documented future lever if the recording path (not the
resume budget, which the spec gates and which is read+rebuild) ever stalls.

**4. Branch is copy-prefix, not copy-on-write.** `branch(id, atIndex)` copies the first `atIndex`
post-header events into a new session whose header records `parent {id, atIndex}`; the source is
never mutated. No shared mutable state — trivially correct and human-inspectable.

**5. `StopReason` relocates `@keel/kernel` → `@keel/shared`** so the durable `run_status` event and
the kernel's live `KernelEvent` share one vocabulary; the kernel re-exports it for back-compat.

**6. Steering fields use the union's camelCase idiom**, mapping §4.10's reserved snake_case names
(`input_id→inputId`, `inserted_at→insertedAt`, `changed_task_state→changedTaskState`,
`invalidated_plan→invalidatedPlan`; `class` kept). One convention across the union beats literal
name-parity. Phase 1 only **persists** steering (pending = `class==="queued" && insertedAt===null`,
rehydrated on resume); application at safe boundaries is Epic 1.5/1.6.

**7. Storage.** Sessions live at `KEEL_HOME ?? $XDG_CONFIG_HOME/keel ?? ~/.config/keel` +
`/sessions/<id>.jsonl` — one keel dir (not the workspace), trivially excludable from the sandbox
(Phase 2) and workspace ops (Epic 1.9). IDs are `ses_<ULID>` via a new dependency-free generator.

## Consequences

- No frozen interface/protocol/audit change. The ledger is **keel-internal and agent-writable** —
  it is *not* the warden audit chain (Phase 2A) and makes **no tamper-evidence claim**. Session
  logs are **not secret-redacted** in Phase 1 (Epic 1.9 / SEC-014) — recorded as a claim-ledger
  DOC-LIMIT.
- Resume/branch are pure functions of the ledger; the round-trip property is the load-bearing
  correctness guarantee and must stay green as the fold evolves.
- A future structured tool-result payload, snapshot/log-trim (compaction, Epic 1.6), and
  double-writer locking are deferred extensions; the schema is non-frozen so they are additive.
