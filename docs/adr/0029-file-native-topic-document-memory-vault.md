# ADR-0029 — File-native topic-document memory vault

- **Status:** Accepted
- **Date:** 2026-06-14
- **Deciders:** keel maintainers
- **Governs:** MASTER_SPEC §7 Epic 3.2 (vault), 3.4 (diffs/consolidation), 3.5 (retrieval), Appendix C (memory frontmatter), §4.7.1 E + §4.7.7 (compaction ↔ memory candidates), §8.2 (memory evals), SEC-024/026. Relates to ADR-0025 (context lifecycle — `ArtifactRef` / event-ledger IDs, `TrustLevel`), ADR-0010 (provenance, Phase 3), ADR-0015 (decay rejected), ADR-0007 (embedding runtime) and ADR-0014 (hybrid scoring) — both eval-gated acceleration, not v1.

## Context

MASTER_SPEC v1.5 made the file-native topic-document memory thesis explicit but deliberately left one architectural fork open (the §10.1 ADR-0029 seed): the **physical storage shape** of the durable vault. The Appendix C frontmatter schema works for either shape, so the choice is purely about how facts are laid out on disk — and it determines whether the vault reads as a *maintained knowledge base* or a *fragmented record store*.

The forces: the memory thesis ("maintained project knowledge," and the claim *"memory you can trust because you can read it"*) plus the human review/consolidation workflow (Epic 3.4) pull toward coherent **documents**; machine-write simplicity and finer git-diff granularity pull toward **per-entry files**. We must also preserve machine addressability — supersession, redaction, hard-delete, and retrieval all need a stable per-fact handle.

## Decision

Adopt **entries-as-addressable-blocks-within-topic-documents** as the v1 physical layout.

- **Layout:**
  ```
  .keel/
    memory/
      index.md            # generated human-readable TOC — NOT the source of truth
      project.md
      repo-conventions.md
      test-and-build.md
      architecture.md
      decisions.md
      environment.md
      flaky-tests.md
      security-and-policy.md
      user-preferences.md
    memory-candidates/
      <session-id>.md      # staged, human-readable candidates (Epic 3.4)
  ```
- **Each durable fact is an addressable *block*** inside a topic document, carrying a **stable memory ID** (ULID — preserves machine addressability even though the block lives inside a doc) plus the Appendix C metadata: `evidence` refs, `trust`/provenance, `state`, `confidence`, `scope`, validity (`valid_from`/`valid_until`/`invalidated_by`), `category`, `entities`.
- **`index.md` is a generated TOC** — for inspection/navigation only, a pure function of the topic docs, regenerable at any time; never canonical.
- **No `memory-log.jsonl` in v1.** Git history + the warden audit/event ledger are the append-only, tamper-evident memory record. A dedicated memory log, if later justified by performance or replay ergonomics, is added as an **acceleration/index layer, not the source of truth.**
- **Evidence refs bind to ADR-0025's `ArtifactRef` / event-ledger IDs.** Memory evidence points to canonical ledger/artifact references; it does **not** invent a separate evidence namespace. The `ses_<id>#artifact_<id>` placeholder (Appendix C) is acceptable until ADR-0025 standardizes the final ref scheme.
- **Canonical category set (snake_case wire form):** `project_fact · procedural · decision · environment_quirk · flaky_test · security_policy · preference · other`.

## Alternatives considered

1. **Per-entry ULID files (one fact = one file), grouped/indexed by topic.** Rejected as the v1 shape — simpler machine writes and finer git-diff granularity, but it pushes the vault toward fragmented record storage rather than maintained documents, weakening the review/consolidation workflow and the "memory you can trust because you can read it" claim. We keep its one real advantage — addressability — via per-block IDs.
2. **Topic docs with prose-only blocks (no per-block IDs).** Rejected — supersession, redaction, hard-delete, and precise evidence-linking all need a stable per-fact handle; prose-only blocks cannot be invalidated or cited precisely. The block ID is exactly what lets a document stay human-readable *and* machine-addressable.
3. **A database/JSONL store as the source of truth, markdown as a view.** Rejected — inverts the thesis; the source of truth must be the readable files, and any DB/index is a disposable acceleration layer (ADR-0007/0014, Epic 3.5).
4. **A dedicated `memory-log.jsonl`.** Rejected for v1 — redundant with git history + the audit/event ledger, and a third record to keep consistent (drift risk). Reconsider only as an acceleration/index layer if replay ergonomics demand it.

## Consequences

- **Positive:** the vault reads as maintained documents — review, consolidate, and correct knowledge in one place; this directly backs the readability claim. Consolidation (Epic 3.4) merges/supersedes blocks *within* a doc rather than spawning files; a human edits a coherent topic doc, not a directory of fragments.
- **Concurrency is at topic-doc granularity, not per-entry.** Two sessions consolidating into `repo-conventions.md` need lockfile/merge discipline — this raises the importance of Epic 3.2's "vault survives concurrent sessions" test. Git-diffs are coarser (a doc, not a file per fact), which is acceptable and arguably more reviewable.
- **The consolidation algorithm becomes load-bearing.** Locating a block by ID and merging / superseding / redacting it *inside* a markdown doc (and regenerating `index.md`) is more than file create/delete — it needs the short design note already flagged as an Epic 3.4 follow-up (merge, dedup, conflict handling).
- **A block-anchor syntax must be chosen at implementation** (Epic 3.2): how a block ID is embedded in markdown (e.g., an HTML-comment anchor `<!-- mem:01J… -->` or a per-block frontmatter fence) — greppable, stable across edits, not visually intrusive. Recorded as an implementation detail, not frozen here.
- **Evidence single-sourced with ADR-0025** — no parallel namespace; provenance/evidence survive proposal → review → consolidation → retrieval (§4.7.8, SEC-024).
- `index.md` regeneration is a pure function of the topic docs — the same "rebuildable from the files" property the Epic 3.5 index has; a regeneration test applies.

## Non-goals

- **Not** a frozen on-disk format — the block-anchor syntax and the topic-doc set can evolve; the *thesis* (readable docs are the source of truth; indexes are acceleration) is the durable commitment.
- **Not** a fixed topic-doc list — the docs above are the v1 starting set; new topics and the category→doc mapping can be added, with `other` catching the unmapped.
- **Not** a DB / vector / graph decision — that stays Epic 3.5 / ADR-0007 / ADR-0014, eval-gated.
- **Not** the evidence-ref scheme itself — that is ADR-0025; this ADR only **binds** memory evidence to it.
- **Not** the consolidation/merge algorithm — flagged as a separate Epic 3.4 design note.

## Implementation implications

- **Appendix C frontmatter** is the **per-block** metadata within a topic doc (already reframed in v1.5); pick the greppable, stable block-anchor syntax at Epic 3.2.
- **`@keel/shared`:** the memory-block schema (`id`, `topic`, `category` ∈ the 8-value snake_case enum, `trust` ∈ `TrustLevel`, `evidence` ∈ ADR-0025 `ArtifactRef` / ledger IDs, `state`, `confidence`, `scope`, `valid_from`/`valid_until`/`invalidated_by`, `entities`) single-sources `TrustLevel` and the evidence-ref type with ADR-0025.
- **Epic 3.2:** vault read/write operates on topic docs + blocks; `index.md` is generated; concurrency uses doc-granularity lockfile/merge.
- **Epic 3.4:** consolidation = locate-block-by-id → merge / supersede / redact within the doc → regenerate `index.md` → git commit + audit record; the design note covers merge / dedup / conflict.
- **Epic 3.5:** retrieval ranks over blocks (frontmatter + FTS5/grep over the topic docs); any index is rebuilt from the docs.
- **No `memory-log.jsonl`** in v1; git history + the audit/event ledger remain canonical.
