# 0018 — Pin esbuild via pnpm override for GHSA-gv7w-rqvm-qjhr

**Status:** accepted (temporary remediation — remove when upstream catches up)
**Date:** 2026-06-12

## Context

The `audit` CI job (`pnpm audit --audit-level high`, runs on `main`/schedule, not PRs, to
stay hermetic — §6.5) went red immediately after Epic 0.3 merged. The cause was a
**newly-disclosed HIGH advisory, [GHSA-gv7w-rqvm-qjhr](https://github.com/advisories/GHSA-gv7w-rqvm-qjhr)**
— "esbuild: missing binary integrity verification … enables remote code execution via
`NPM_CONFIG_REGISTRY`" — affecting `esbuild >=0.17.0 <0.28.1`. It was **not introduced by
Epic 0.3** (which only added an already-locked `zod` devDep); the advisory was published
after the previous `main` audit run, and merging simply re-ran the job.

`esbuild` is pulled only by **dev/build tooling**, never shipped in any artifact:
- `tsx@4.22.4 → esbuild@0.28.0` (one patch below the fix), and
- `vitest@3.2.6 → vite@5.4.21 → esbuild@0.21.5` (several paths).

At disclosure time **no released `vite`/`vitest` depends on `esbuild >=0.28.1`**, so the
advisory cannot be cleared by a normal parent bump. Real exploitability here is low
(`esbuild` is dev-only; the repo installs with `ignore-scripts`), but the gate correctly
fails on any high advisory — "coverage is a floor; assume dependencies are hostile." We do
not weaken the gate.

## Options

1. **pnpm `overrides` forcing `esbuild` to the patched `0.28.1`** across the whole tree.
   Smallest change; deduplicates esbuild to one version. Risk: `vite@5.4` pins
   `esbuild ^0.21.3`, so forcing `0.28.1` could break vite's transform/optimizeDeps —
   must be verified, not assumed.
2. **Bump `vite`/`vitest`** to a line shipping patched esbuild — not available at disclosure
   time (no released vite depends on `esbuild >=0.28.1`); would also be a large toolchain
   bump subject to the minimum-release-age rule.
3. **Time-boxed `pnpm audit` ignore** for the GHSA — leaves the high advisory present and
   suppresses the signal. Rejected: that is gate-weakening / security theater, against
   ground rule 4 ("downgrade the claim, not the honesty").

## Decision

**Option 1.** Pin `pnpm.overrides.esbuild = "0.28.1"` (exact). Pinning a just-published
release normally violates the minimum-release-age rule, but this *is* the security patch
for an active high advisory, which is the explicit exception. Viability was **verified, not
assumed**: with the override in place, `vite@5.4` + `esbuild@0.28.1` runs the full suite
(59 tests) and the coverage gate (100%) green, and `typecheck`/`lint`/`format` pass.
`pnpm audit --audit-level high` then exits 0.

One **moderate** advisory remains below the high threshold and is knowingly accepted: a
`vite <=6.4.1` dev-server "Path Traversal in Optimized Deps" reachable only through a
long-lived `vite` dev server (keel runs `vitest run`, not a served dev instance). It is
dev-only and does not gate; it resolves when `vitest` moves to `vite >=6.4.2`.

## Consequences

- The `audit` gate is green again with no loss of strictness (high/critical still fail).
- The override is **temporary**. Remove it once `tsx` and `vite`/`vitest` transitively ship
  `esbuild >=0.28.1` — at that point the override is redundant and pinning it would only
  freeze an old esbuild. Revisit on the next dependency-bump cycle.
- The override is scoped to `esbuild` only; `tsx`/`vite`/`vitest` versions are unchanged.
  The lockfile shrinks (one esbuild version + one set of platform binaries instead of three).
- A fork inherits both the rationale and the removal condition from this ADR rather than an
  unexplained pin in `package.json` (which cannot carry a comment).
