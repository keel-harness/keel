# 0006 — Crypto: audit hashing, Ed25519, and audit record canonicalization

**Status:** accepted; amended 2026-06-30 for compiled-binary Ed25519; amended 2026-07-16 for the
concrete audit `schemaVersion` + golden-vector freeze (ADR-0072)
**Date:** 2026-06-11 · 2026-06-23 (canonicalizer pinned) · 2026-06-30 · 2026-07-16

## Context
KEEL's tamper-evident audit chain (Appendix B) requires hashing audit records (SHA-256) and signing them (Ed25519). The audit chain is a core security property — any implementation dependency that introduces a native build step or is poorly audited creates supply-chain risk. The canonicalization format for the JSON records being hashed must be deterministic across platforms, Node.js versions, and object key insertion orders.

## Options
1. **`@noble/hashes` + `@noble/ed25519`** — pure TypeScript/JavaScript, no native binaries, actively security-audited (Paul Miller's noble-cryptography), MIT license, zero dependencies.
2. **Node.js built-in `crypto` module** — available without install; Ed25519 signing API is less ergonomic but avoids bundler-side hash-hook drift and matches the standalone bundle verifier's crypto implementation.
3. **`@aws-crypto` or `jose`** — heavier bundles, more surface area, designed for different use cases (AWS or JWT workflows).

## Decision
Adopt `@noble/hashes` (SHA-256) for audit-chain hashing. For canonicalization, **pin RFC 8785 JSON Canonicalization Scheme (JCS)** (QC re-review F9 — this supersedes the earlier "JCS *or* a documented stable-stringify" deferral; a hash-chained schema cannot freeze while the bytes it commits to are undefined). **JCS canonicalizes object KEYS but does NOT reorder array elements**, so array-order determinism is owned by the schemas being hashed: the `@keel/shared` `SideEffect` transform sort+dedups its set-like arrays + edges (and dedups the top-level target bag) so two semantically-equal records canonicalize to identical bytes.

**2026-06-30 amendment:** use built-in `node:crypto` for Phase-2B Ed25519 checkpoint signing and verification, while preserving the existing Appendix B record shape, `ed25519:<base64-signature>` text encoding, 32-byte stored seed, and 32-byte public key encoding. The implementation imports those raw bytes through standard Ed25519 PKCS#8/SPKI DER wrappers so it works on Node 20 and in Bun-compiled binaries. This replaces the initial `@noble/ed25519` implementation after a release-artifact regression showed a `bun --compile` Linux binary could fail during checkpoint-key initialization with `invalid inverse`. The vendored offline bundle verifier already used `node:crypto`; the runtime signer now uses the same crypto provider class.

The format is documented in Appendix B. The audit format is implementation-agnostic so the hash function or signing algorithm can be upgraded via a new audit schema version without breaking existing records.

**2026-07-16 amendment (ADR-0072, P1-12).** The "new audit schema version" this ADR anticipated is now concrete: audit records carry an additive-optional, hash-committed **`schemaVersion`** field (`@keel/shared` `AUDIT_SCHEMA_VERSION = 1`), stamped by the warden writer on every new record (including checkpoints) and mirrored into the checkpoint branch under a structural drift guard. Because it is additive-optional it changes forward writes only and never invalidates an already-written (legacy, no-`schemaVersion`) record. Committed **golden hash vectors** (`golden-vectors.test.ts`) now pin the canonicalize→hash→Merkle→Ed25519 pipeline for both legacy and with-`schemaVersion` records, so any silent change to the bytes this ADR commits to fails CI as the MAJOR break it would be. Durable readers are tolerant of additive fields / novel event types (ADR-0072 §1/§4) while preserving tamper-evidence; the in-process readers and the vendored `verify-bundle.mjs` share the ADR-0072 §2 normative invariants (raw-object hash; reject duplicate + digest-excluded `{hash,sig}` + top-level prototype keys).

## Consequences
No native build step is required for crypto — this is critical for `ignore-scripts=true` supply-chain compliance. `@noble/hashes` remains an exact-pinned runtime dependency for SHA-256; `@noble/ed25519` is not required after the 2026-06-30 amendment. The Ed25519 implementation now depends on the platform runtime's built-in `node:crypto`, which must be covered by compiled-binary package smoke because tsx/node unit tests alone do not prove the release artifact. The canonicalization is now **pinned to RFC 8785 (JCS)** at R1 (resolving the earlier deferral); any change after the first real audit record is written requires a migration and a new audit schema version. The public key for audit verification is distributed alongside the binary per Appendix B.
