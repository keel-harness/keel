# 0005 — Vendoring the sandbox runtime

**Status:** accepted
**Date:** 2026-06-11

## Context
KEEL's OS sandboxing layer is built on `@anthropic-ai/sandbox-runtime` (srt), which provides OS-level process isolation and a domain-allowlist proxy. The Anthropic sandbox-runtime study (2026-05) found an 84% reduction in permission prompts with OS sandboxing in place, making srt a high-confidence dependency for KEEL's Phase 2 security posture. However, srt is an upstream package whose security properties KEEL depends on — auto-updating it without review would introduce uncontrolled risk to the security boundary.

## Options
1. **Vendor at a pinned commit** — include the srt source under `vendor/sandbox-runtime`, track upstream monthly via a diff script, upgrade only via deliberate reviewed PRs.
2. **Install as a normal npm dependency** — simpler, but auto-updates on `pnpm update` can silently change the sandbox behavior and break the security test suite.
3. **Fork permanently** — too much maintenance burden; diverges unnecessarily from upstream improvements.

## Decision
Vendor `@anthropic-ai/sandbox-runtime` at a pinned upstream commit under `vendor/sandbox-runtime`. A `scripts/srt-sync.ts` script diffs against the upstream repository monthly. All upgrades are deliberate PRs with the security test suite (§8.1 catalog) as the regression gate. The upstream commit hash and any local patches are recorded in `vendor/sandbox-runtime/VENDOR.md`. Never auto-update. All warden code that invokes the sandbox does so behind a `SandboxPort` interface, enabling a Phase 4 native-backend swap (Firecracker, Rust port) without touching the kernel.

## Consequences
The vendored copy must preserve upstream LICENSE and NOTICE files (Apache-2.0 attribution obligations). Local patches, if any, are kept as `.patch` files and minimized. The monthly sync cadence is enforced by a CI reminder or cron; missed syncs are a security hygiene finding. Phase 4 introduces native sandbox backends (Firecracker) and the Rust warden port; `SandboxPort` is the seam that makes those transitions non-breaking.
