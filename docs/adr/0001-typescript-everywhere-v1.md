# 0001 — TypeScript everywhere in v1

**Status:** accepted
**Date:** 2026-06-11

## Context
KEEL is a solo-built, AI-assisted project that needs to move fast while maintaining correctness guarantees at process boundaries. The two viable language choices for v1 are TypeScript and Rust. The warden is the critical trust-boundary component; memory safety there would be valuable, but velocity and a single unified toolchain are equally important at this stage.

## Options
1. **TypeScript everywhere** — one toolchain, full type safety via strict TS + zod, fastest path to a working system.
2. **Rust for the warden, TypeScript for the rest** — memory safety at the trust boundary from day one, but two build systems, two test stacks, and FFI/IPC complexity from the start.
3. **Rust everywhere** — maximum safety guarantees but eliminates the AI-assisted velocity advantage and the rich ecosystem of LLM/TUI libraries.

## Decision
TypeScript everywhere in v1. The v1 security boundary is process separation plus OS sandboxing (via the vendored sandbox-runtime), which TypeScript provides equally. One toolchain maximizes solo AI-assisted development velocity. The frozen warden RPC interface (Appendix A) plus the frozen audit format are the explicit seams that make a Phase 4 Rust port a drop-in for the **enforcement process** behind them (Phase-4 gate: byte-identical RPC contract suite + audit-format compatibility + performance ≥ TS warden). The kernel links **no warden policy/enforcement-engine code and no bundle verifier** — the pure kernel↔warden data contracts and the offline `keel audit verify` verifier live in `@keel/shared`/`@keel/kernel`, not `@keel/warden` (ADR-0071). The remaining production kernel→`@keel/warden` imports are the sanctioned host-launch entry (`runWardenFromEnv`) and documented residuals (grant-store readers, credential-proxy parser) tracked for RPC-mediation/relocation; a lint boundary keeps that set from growing.

## Consequences
All packages (`kernel`, `warden`, `memory`, `simulator`, `eval`, `shared`) share one strict ESM TypeScript configuration. The Phase 4 Rust warden port adds memory safety at the trust boundary and enables a single-static-binary distribution — it is hardening, not a launch blocker. Any memory-safety argument must wait until the frozen RPC interface is in place and the full test suite can serve as the regression gate for the port.

**Amended by ADR-0071 (2026-07-15, launch-prep P1-10).** The original Decision said the Rust port is a drop-in "without touching the kernel or any other package." That overclaimed: the kernel statically imported warden TypeScript internals (MCP/proxy/env contracts + the offline evidence verifier), so a Rust `@keel/warden` would not have compiled the kernel. P1-10 relocated those pure contracts to `@keel/shared` and the `keel audit verify` verifier to `@keel/kernel`, and a lint boundary now keeps production kernel code free of warden-library imports. The honest drop-in scope is therefore the **enforcement process behind the frozen RPC + audit seams**. Two residuals remain, tracked as follow-ups: the single-binary (`bun --compile`) build still self-dispatches the warden engine inside the kernel executable (a packaging detail a native Rust binary supersedes), and a few grant-store/credential-proxy reaches await RPC-mediation. See ADR-0071 and the public boundary tests.
