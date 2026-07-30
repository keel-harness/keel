# 0007 — Embedding runtime for memory index

**Status:** proposed — spike pending
**Date:** 2026-06-11

## Context
KEEL's memory vault (Phase 3) requires a local embedding model to power `sqlite-vec` semantic search over memory entries. The embedding model must run entirely offline (no API calls), produce stable vectors across runs (deterministic output for the same input), and be fast enough not to dominate memory retrieval latency. Two candidate runtimes exist: fastembed-js (a Node.js binding to the fastembed library) and transformers.js (HuggingFace's JS port of the transformers library). Critically, the memory vault must be functional without the embedding index — it degrades gracefully to exact/keyword search if the embedding runtime is unavailable.

## Options
1. **fastembed-js** — lighter runtime, purpose-built for fast local embeddings, smaller model footprint; built-in coverage and API stability need verification for Phase 3 requirements.
2. **transformers.js** — broader model support (any ONNX model from HuggingFace Hub), larger community; heavier runtime, larger install footprint, more configuration surface.
3. **External embedding API** — defeats the offline requirement and adds latency; rejected outright.

## Decision
Spike pending (Phase 3). Before implementing the memory index, run a spike comparing fastembed-js and transformers.js on: embedding quality on a representative memory-entry corpus, cold-start time, p99 query latency with `sqlite-vec`, and total install size impact. The spike result determines which runtime is adopted. The vault works without the embedding index (falls back to keyword search) so this decision does not block Phase 2 or Phase 3 vault initialization — only the semantic search capability.

## Consequences
The `@keel/memory` package must implement a `MemoryIndex` abstraction that the embedding runtime sits behind, so the spike result can be committed without changing any consumer code. If neither runtime meets the latency and quality bar, the semantic index is deferred and the vault ships with keyword search only. This ADR is updated with the spike result before the memory index implementation begins.
