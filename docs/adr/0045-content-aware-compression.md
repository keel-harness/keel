# 0045 — Content-aware context compression + `ContextCompressionEvent`

**Status:** accepted + SHIPPED (Epic 1.6c; env-gated `KEEL_COMPACTION` default-OFF; production-wiring decisions are recorded in ADR-0049)
**Date:** 2026-06-18
**Relates to:** `MASTER_SPEC.md` §4.7 (context lifecycle & compaction), §4.7.9 (large-output handling),
§4.7.11 (compaction evals); ADR-0025 (context lifecycle & compaction); SEC-023 (compaction laundering).
Executable evidence lives in the public compaction, compression, and retrieve tests. Paired with
**ADR-0046** (cache-aware reduction — the guard/trigger economics). Conceptual borrow from
Headroom (github.com/chopratejas/headroom, Apache-2.0); no code vendored.

## Context

keel's live loop has one wired context-reduction strategy: `compact()` — a lossy model summarization at
70% of the token budget. The cheaper deterministic path (`assemble.ts`) is dead code and all-or-nothing
(it replaces an entire tool result with a fixed stub). So a large aged tool output is either kept
verbatim or vaporized. There is no middle tier that mechanically shrinks aged tool bodies while
preserving the signal (errors, anchors), and nothing fills the §4.7.9 "structured truncation" gap
(ER-023). The canonical session ledger already retains every full tool output, so reversibility needs
no new store — the ledger *is* the backing store.

## Decision

Add a deterministic, content-aware compression tier (Epic 1.6c) that shrinks aged `clearable` tool
bodies **before** the lossy fold:

1. A `ContentCompressor` seam with three small units — `generic` (head/tail + consecutive-duplicate
   collapse), `log` (force-keep error/warn lines + head/tail anchors), `search` (per-file first/last +
   task-token overlap + dedup) — selected by a `router` keyed on tool `name` (+ a bounded `bash` sniff).
2. A new **`ContextCompressionEvent`** in the `@keel/shared` `SessionEvent` union, **distinct** from
   `CompactionEvent` (deterministic compression vs. lossy model fold must stay distinguishable in the
   record). It carries per-message `{kind,name,beforeChars,afterChars}`, aggregate token deltas,
   trigger, and `trust: "unknown"` (fail-closed, Phase 1). `rebuild` skips it (audit metadata, like
   `CompactionEvent`), so the full pre-compression history stays canonical.
3. Reversibility via the ledger; the compressed body carries an honest elision marker and **does not
   promise an in-session retrieve tool** (that is Epic 3.5). "Compress the model's view, never the
   record."

The frozen-schema change (the new event) is isolated in its own PR with this ADR.

## Consequences

- **+** Runway / context-window headroom: the lossy fold fires later and the hard ceiling arrives
  later (the value metric — see ADR-0046 §runway, not cost).
- **+** Deterministic, dependency-free, reversible-via-ledger, and audited by construction; preserves
  SEC-023 (no trust upgrade) since `trust` stays `unknown`.
- **−** Adds one additive frozen-schema event (audit-format surface).
- **−** The pass's **trigger/guard must be cache-aware** — compressing an aged body rewrites the
  the prompt-cache implementation's cached prefix; that economics is governed by **ADR-0046**, without which a naive trigger can be
  cost-negative.
