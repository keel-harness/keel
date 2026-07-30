# ADR-0079 — Receipt recovery without unsafe automatic undo

**Status:** Accepted for Epic 3.10 Slice 4 by delegated owner decision on 2026-07-23.

**Date:** 2026-07-23

**Relates to:** ADR-0035 (session ledger), ADR-0036 (pure TUI reducer), ADR-0059 (honest receipt),
ADR-0073 (`UIPort` presentation evolution), ADR-0078 (warden-observed mutation review), MASTER_SPEC
§4.9.4, `docs/design/tui-principles.md` §3.5–3.6, and Epic 3.10 Slice 4.

## Context

The Master Spec required an Undo receipt line containing an “accurate `git restore`” derived from
the changed-file set. The current product cannot establish the preconditions that would make that
command safe:

- the typed-mutation producer observes a bounded preimage and verifies an installed postimage but
  explicitly does not prove an atomic transition or exclude concurrent mutation (ADR-0078);
- the kernel receives a bounded presentation artifact, not an owned full preimage suitable for
  restoration;
- Keel does not prove that a tracked path was clean relative to the index before the session;
- Keel does not own unrelated user edits made before, during, or after its mutation;
- `git restore` discards the current worktree image, while untracked-file recovery would require a
  separate destructive removal operation; and
- a request path or successful tool result is not authoritative file-transition evidence.

An unconditional command could therefore erase pre-existing or concurrent user work. Calling it
“undo” would violate the receipt's central honesty rule.

## Options

### 1. Hash-guarded automatic undo from an owned preimage

Rejected for v1. This could be safe only with a complete retained preimage or checkpoint, stable
path identity, an exact expected postimage immediately before restoration, explicit lifecycle and
retention bounds, and failure/cleanup semantics. The current presentation carrier deliberately does
not persist producer images. Adding that authority and storage is a separate security and privacy
design, not receipt polish.

### 2. Qualified `git restore`

Rejected for the current architecture. A safe qualification would require authoritative pre-session
index/worktree state for every path and a fresh post-session identity check. Keel records neither.
Even a correct path list cannot prove that restoring the index version preserves user work.

### 3. Explicitly unavailable automatic undo plus bounded manual recovery guidance

Chosen. The receipt distinguishes observed file evidence from operation-effect claims, states when
verification was not run, and says that automatic undo is unavailable because Keel did not retain an
owned preimage or exclude concurrent mutation. It directs the human to inspect the bounded diff and
recover deliberately from their version-control history or backup. It emits no destructive command.

## Decision

1. **No automatic undo or `git restore` command in v1 receipts.** Keel must not print `git restore`,
   `rm`, or an equivalent destructive recovery command from the current ledger/presentation facts.
   `keel undo <session>` remains future work and is not advertised as available.
2. **Evidence, not effect.** For an available ADR-0078 artifact, the receipt may name the producer-
   redacted display path and say `observed before → verified installed after`, including
   `transition not atomic` and `concurrent mutation not excluded`. It must not say created, modified,
   removed, exact diff, changed by Keel, or restored. Unavailable/uncaptured/indeterminate artifacts
   remain explicit and do not use request arguments as replacement evidence.
3. **Recovery copy is fixed and qualified.** When applicable, the receipt says automatic undo is
   unavailable and directs the user to review file evidence and recover deliberately from version
   control or a backup. The reason is controller-derived, not model-authored. A receipt with no file
   mutation evidence does not add recovery noise.
4. **Execution and verification remain separate.** A successful `bash` tool may be listed only as
   `ran`. It is `verified` only when a controller-owned validation/completion record binds the check
   and successful outcome. Otherwise a mutation receipt says `verification not run`. Failed,
   skipped, partial, truncated, unsupported, and indeterminate checks retain those states.
5. **No durable or frozen-format expansion.** Slice 4 may add internal additive presentation fields
   allowed by ADR-0073, but it does not add producer bytes, change `UIPort` methods, or change RPC,
   audit, session, grant, policy, or eval schemas. Recovery presentation is derived from facts already
   present in the live view/controller.
6. **Future automatic recovery is separately gated.** It requires a new or amended ADR covering
   preimage/checkpoint ownership, privacy and storage bounds, stable filesystem identity, concurrent
   mutation, dirty-baseline behavior, new files, crash recovery, authorization, and adversarial
   tests. It cannot be introduced by changing receipt copy alone.

## Consequences

- The receipt becomes less impressive and more trustworthy: users receive evidence and a safe next
  step, not a command that may erase work.
- The normative Master Spec and TUI principles change from `Undo`/`Changed` operation language to
  `File evidence`/qualified `Recovery` language for the current v1 producer.
- Existing successful edit/write intent summaries must no longer populate a truthful final receipt
  by themselves. Slice 4 must reconcile available, unavailable, partial, and uncaptured producer
  observations and report exact hidden counts.
- This decision changes no security claim or enforcement. It narrows a usability promise to what
  current structural evidence can support.
- Product code and behavior tests begin only after this ADR/spec amendment lands as a separate
  DCO-signed commit.
