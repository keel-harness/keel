# 0054 — Workspace identity via `cwdHash` for `keel --continue`

**Status:** ACCEPTED — implemented with TDD after the resume-path adversarial QC pass.
**Date:** 2026-06-21
**Relates to:** ADR-0008 / ADR-0035 (append-only session ledger), SEC-014 (redaction-at-write), Epic 1.23 slice 2 (`--continue` / `--resume <id>` resume). **Frozen-schema change:** adds one **optional** field (`cwdHash`) to the `session_meta` ledger header — additive and backward-compatible (`schemaVersion` stays `1`; ledgers without it still parse). Reviewable in its own commit per the charter.

## Context

Epic 1.23 slice 2 added session resume. `keel --continue` resumes the most-recent session **for the current workspace**, scoping by directory. The first implementation matched on the `session_meta.cwd` field:

```ts
listSessions(env).filter((s) => s.cwd === redactText(cwd))
```

The adversarial QC pass found this is a **cross-workspace data-disclosure + cross-write defect**. `session_meta.cwd` is written through the SEC-014 redaction chokepoint (`redactJsonLine`), and the high-entropy net (`TOKEN_RUN = /[A-Za-z0-9_+/=-]{44,}/`, entropy ≥ 3.5, letters+digits) is **lossy and many-to-one**: an absolute path is one continuous run of token-alphabet characters (`/` is in the alphabet), so any path that is ≥ 44 chars and contains a digit collapses **entirely** to the single literal `[redacted:high-entropy]`. Measured against the real filter, ordinary deep project paths collapse:

```
/Users/alice/Documents/Code/2024_q3_migration_v2   -> [redacted:high-entropy]
/Users/jenny/repos/acme-platform/services/auth2     -> [redacted:high-entropy]
/workspace/monorepo/packages/app-frontend-v1        -> [redacted:high-entropy]
```

All such workspaces share **one** stored `cwd` key. So `keel --continue` in workspace B (which has never run keel) resolves to the globally-newest collapsed-cwd session — which can belong to a different workspace A. keel then (1) rebuilds A's conversation into B's model context (disclosure), and (2) `SessionStore.open(A.id)` and appends B's new turns into A's ledger (cross-write — one ledger now interleaves two unrelated workspaces under A's recorded cwd). The redacted value is a **lossy guard**, never an identity — using it as a matching key was the error.

(Paths without a digit, or shorter than the 44-char floor, stay verbatim — which is why the early tests using `/w` / `/other` never caught this.)

## Decision

Store a separate, **one-way** workspace identity in `session_meta` and match `--continue` on it, never on the redacted `cwd`:

1. **`cwdHash = SHA-256(cwd)`** (hex), written by `SessionStore.create`. A new `workspaceKey(cwd)` helper (`node:crypto`, no new dependency) is the single definition used both at write (store) and at match (`resolveResumeId`).
2. **`cwd` stays as-is** — redacted, **display-only** (`keel sessions`), never an identity key.
3. **`resolveResumeId({kind:"latest"})` matches `s.cwdHash === workspaceKey(cwd)`.** Distinct paths produce distinct hashes, so the collision is gone. Sessions written before the field exists have no `cwdHash` and are intentionally **not** `--continue`-matched (they remain resumable by explicit `--resume <id>`).
4. **Schema:** `cwdHash: z.string().optional()` on the `.strict()` `SessionMetaEvent`, `schemaVersion` unchanged at `1` — old ledgers (no field) and new ledgers (with field) both parse.

### Why a hash is safe under SEC-014 (no redaction regression)

The hash is **one-way**: it never reveals the path, so any secret a path might contain cannot be recovered from `cwdHash` — storing it is not a redaction bypass (unlike storing the raw `cwd`, which was rejected for exactly that reason). And as plain lowercase hex it is **spared by the redaction filter** (`looksLikeSecret` returns false for `/^[0-9a-f]+$/i`), so it round-trips through `redactJsonLine` intact rather than being itself redacted to a useless `[redacted:high-entropy]`.

## Alternatives considered

- **Refuse `--continue` when the cwd redacts lossily** (fall back to `--resume <id>`). No schema change and it closes the defect, but it disables the headline `--continue` for a large class of ordinary paths (any deep path with a digit). Rejected in favor of fully fixing scoping; kept mentally as the no-schema fallback.
- **Store the raw `cwd` for matching.** Rejected — a direct SEC-014 redaction regression (a path can contain a secret; the ledger must not hold it in recoverable form).
- **`realpath(cwd)` before hashing** (normalize symlink/relative variants). Deferred — adds a filesystem read and edge cases (cwd is keel's own launch dir, but resolution can still surprise). v1 hashes the cwd string as launched; symlinked/relative variants of the same directory are treated as distinct workspaces. A future refinement, not a correctness gap for the disclosure fix.

## Consequences

- `keel --continue` is now correctly and safely scoped to the launch directory; the cross-workspace resume/cross-write defect is closed. A regression test asserts two distinct collapsing-cwd workspaces do **not** cross-resolve.
- Ledgers created before this change are not `--continue`-resumable (no `cwdHash`); `--resume <id>` is unaffected. Acceptable — the field is days old and `--resume <id>` is the explicit escape hatch.
- One additive optional schema field; no version bump, no migration, fully backward-compatible.
- Symlinked/relative launches of the same directory are distinct workspaces until/unless realpath normalization is added.
