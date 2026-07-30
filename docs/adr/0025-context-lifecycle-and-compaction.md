# ADR-0025 — Context lifecycle and compaction architecture

- **Status:** Accepted
- **Date:** 2026-06-14
- **Deciders:** keel maintainers
- **Governs:** MASTER_SPEC §4.7 (normative), Epic 1.6, §8.6 (read-before-edit / final-answer honesty), §8.1 SEC-023 (compaction laundering) + SEC-025 (resume-from-stale). Relates to ADR-0008 (session JSONL), ADR-0016 (single-agent durable loop), ADR-0010 (provenance design, Epic 3.0 — to be written).

## Context

Phase 1 must manage the model's context window. Before MASTER_SPEC v1.4, compaction was scattered across Epics 1.1/1.3/1.4/1.6 and `borrowed-techniques.md` technique C as prose, with no normative contract — an implementation agent would have to invent the architecture, and v1.4's two new dependencies (the §4.7.8 provenance seam and the §8.6 read-before-edit invariant) would have nowhere to anchor.

The failure modes of naive "summarize when the window is full" compaction are well documented: lost task state, invented details (hallucinated file edits / test passes), thrashing (re-reading already-summarized files), and — load-bearing for the security thesis — **laundering** untrusted content into trusted-looking task state. The 2026 evidence (technique C; the ETH context-file finding that auto-accumulated context *hurt* performance; the KIRA/Meta-Harness compaction patterns) favors compaction-at-task-boundaries with structured state over threshold-triggered summarization.

Two forces make this a **now** decision, not a later one:

1. **Cross-phase format seam.** §4.7's format is a Phase-3 provenance dependency. If Phase-1 compaction freezes a format that cannot carry taint, Phase-3 reworks it. Reserving the fields now is nearly free; retrofitting them is not.
2. **Epic 1.6 replan.** Epic 1.6 is about to be replanned and must build from a stable architecture, not re-derive one.

## Decision

Adopt the §4.7 architecture as the normative, buildable contract. The load-bearing commitments:

1. **Compaction is state preservation under a token budget, not summarization.** The append-only session/event ledger (ADR-0008) plus persisted tool artifacts are the canonical source of truth; the active model context is a disposable, regenerable working set.
2. **Five context layers** — immutable event ledger · active model context · structured task state · tool artifacts · durable memory — each with an explicit compaction posture; **eight retention classes** (pinned / active / recent_verbatim / summarizable / clearable / retrievable / promotable / expired_or_superseded) classify every item.
3. **Compaction prefers task/semantic boundaries.** Token-budget overflow (soft 70% / hard 85%, ≥16K reserved headroom) is a *fallback* trigger, not the primary one.
4. **A typed compaction summary plus a schema-driven `TaskState`** (not prose-only) is produced, **validated against the ledger** (no invented paths/tests/approvals; no trust upgrade), and **probed** (recall / artifact / continuation / decision / verification / constraint / provenance / memory) before it replaces active context. A failed validation or required probe repairs the summary or aborts the swap (keep prior context, record the failure).
5. **Provenance/taint invariants are reserved from Phase 1** (§4.7.8): a summary inherits the **maximum** taint of its inputs; unknown provenance fails closed to untrusted; compaction never launders untrusted content into trusted state and never writes durable memory (it only *proposes* candidates). Enforcement is Phase 3 (ADR-0010); the *format* carries the fields now.
6. **Every compaction emits an auditable compaction event.** Large outputs are truncated-with-artifact plus a retrieval handle; resume re-validates file freshness (mtime/hash) to drive the §8.6 read-before-edit invariant.

## Alternatives considered

1. **Threshold-triggered LLM summarization (the status quo of most harnesses).** Rejected — loses state, hallucinates, thrashes, and has nowhere to carry provenance; the §4.7 evidence base shows boundary-based structured compaction wins.
2. **Prose-only compacted summary (no structured `TaskState`).** Rejected — a paragraph cannot be validated against the ledger and probes need typed fields. Prose is kept as the *human-readable* layer atop the schema, not instead of it.
3. **Defer the provenance fields to Phase 3.** Rejected — that is the exact cross-phase trap §4.7.8 exists to avoid; adding taint to a frozen compaction format later is rework, while reserving optional fields now is nearly free.
4. **Treat the context as the source of truth (no separate ledger reliance).** Rejected — contradicts ADR-0008/0016 and makes resume, audit, and replay impossible; the ledger must be canonical.
5. **Model-driven compaction with no validation/probes.** Rejected — the whole failure mode is the model confidently producing a *wrong* summary; validation against ground truth is the point, not an add-on.

## Consequences

- **Positive:** Epic 1.6 is buildable directly from §4.7; the provenance seam is reserved with no Phase-3 dependency; compaction quality becomes *measured* (§4.7.11 evals, SEC-023/025) rather than asserted; read-before-edit and final-answer honesty (§8.6) anchor here.
- **Cost / scope:** more Phase-1 surface than a thin loop — a structured `TaskState`, a validator, probes, and an artifact store with stable IDs/hashes. This grows Epic 1.6; justified by output quality plus the security seam, and partly offset by deferring the Epic 1.8 executable extension API.
- **Schema commitment:** `TaskState`, `ArtifactRef`, and the compaction-event shape become `@keel/shared` zod schemas, parsed at boundaries per §6.4. The `TrustLevel` enum (`user | workspace | untrusted | mixed | unknown`) is **shared** with the provenance work (ADR-0010) — it must be one type, not two.
- **Determinism:** compaction output is model-generated and therefore non-deterministic; tests assert *invariants* (preservation, no-invention, no-laundering) over simulator-driven sessions, not byte-equality — consistent with §6.2.
- **Tunables, not architecture:** OQ-10 (compactor model — pinned vs cheaper) and OQ-12 (`recent_verbatim` default) are recorded per compaction event and tuned empirically.

## Non-goals

- **Not** multi-agent context handoff or shared context across agents (ADR-0016 keeps a single agent; subagents are Phase 4).
- **Not** provenance *enforcement* (Phase 3, ADR-0010) — only the carried format plus the no-launder / no-trust-upgrade invariants.
- **Not** a retrieval/RAG system over the ledger (the memory index is Epic 3.5); the `retrievable` class is on-demand fetch, not semantic search.
- **Not** durable-memory writes — compaction only proposes candidates; the memory diff/review workflow (Epic 3.4) owns writes.
- **Not** a permanently-frozen `TaskState` schema — §4.7.7 is illustrative; the schema stabilizes when Epic 1.6 lands. It is an internal `@keel/shared` schema, not a frozen cross-process protocol like the warden RPC (Appendix A).

## Implementation implications

- **`@keel/shared`:** add zod schemas for `TaskState`, `ArtifactRef`, `FileState`, `TestState`, `Decision`, `FailedAttempt`, `MemoryCandidate`, `TrustLevel`, and `CompactionEvent`, with serialize→parse round-trip + malformed-reject tests (the Epic 0.2 pattern).
- **Session JSONL (ADR-0008):** add `compaction` event records and artifact references; persist raw tool outputs as artifacts *outside* context with `artifact_id` / `sha256` / truncation metadata. The ledger stays append-only and crash-safe (Epic 1.4 invariants); clearing a context body never deletes the artifact or erases that the call occurred.
- **Epic 1.6 replan** builds from §4.7 in order (layers → retention → triggers → algorithm → typed summary → validation → probes → swap → event). The eight retention classes subsume the existing tool-result-clearing and task-ledger work from Epics 1.1/1.6.
- **§8.6 read-before-edit + resume staleness (§4.7.10)** interact with the `edit` tool (Epic 1.2) and session resume (Epic 1.4): track per-file read/validate state in `TaskState.filesRead`.
- **Evals (§4.7.11)** are simulator-driven (no API cost): constraint / modified-files / test-status / artifact / failed-attempt preservation, memory-candidate separation, compaction-laundering (SEC-023), resume-staleness (SEC-025). They gate Epic 1.6 and feed the §8.2 trajectory metrics.
- **Coordinate with ADR-0010 (provenance, Epic 3.0):** Phase 3 consumes the reserved taint fields and adds *enforcement*, not *format*. Keep the `TrustLevel` type single-sourced.
