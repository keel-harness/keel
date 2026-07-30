# 0002 — Provider abstraction via Vercel AI SDK behind ModelPort

**Status:** accepted
**Date:** 2026-06-11

## Context
KEEL needs to call LLM providers (Anthropic, OpenAI, Google, Ollama-compatible local models) in a way that keeps the kernel loop decoupled from any single vendor's SDK. The kernel must stream tokens, send tool results, and enforce context-discipline policies (compaction triggers, headroom) regardless of which model is in use. Provider SDKs change frequently and have divergent streaming and tool-calling APIs.

## Options
1. **Vercel AI SDK (`ai` package) behind a `ModelPort` interface** — a maintained unified SDK covering all major providers; pi-ai patterns for tiered cache-friendly context are documented and borrowable.
2. **Raw provider SDKs per-provider** — maximum control, no abstraction layer, but requires a custom adapter for each provider and diverges immediately from upstream improvements.
3. **LangChain / LlamaIndex** — heavier framework with its own abstraction model that conflicts with KEEL's explicit architectural constraints (no tool routers, no DAGs, single-agent loop per ADR-0016).

## Decision
Adopt the Vercel AI SDK (`ai`) as the implementation behind a `ModelPort` interface defined in `@keel/shared`. All provider access flows through `ModelPort`; the kernel never imports provider-specific code directly. Pi-ai cache-friendly context patterns (tiered context packing, prompt-caching discipline) are borrowed for the context-discipline subsystem in Phase 1.

## Consequences
Provider swaps require only a new `ModelPort` adapter — the kernel loop, simulator, and all tests are unaffected. The `ModelPort` interface must be frozen (or versioned) before Phase 1 work starts, since `@keel/simulator` implements it independently. The Vercel AI SDK is a runtime dependency; its versioning follows the supply-chain rules (§5.3): pinned exactly, no auto-update.
