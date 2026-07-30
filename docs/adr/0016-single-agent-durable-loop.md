# 0016 — Single-agent durable loop

**Status:** accepted
**Date:** 2026-06-11

## Context
The 2026 production-agent literature (LangGraph, CrewAI, AutoGen, Magentic-One) pushes workflow-graph runtimes as the architecture for reliable agents: explicit DAGs, multi-agent handoffs, separate intent classifiers, and tool routers. These systems achieve reliability through structural decomposition of agency. At the same time, KEEL's governing principle (§1.1) is *autonomy at the reasoning layer, determinism at the control layer* — the model reasons freely, but the control plane (warden, policy engine, audit chain) is deterministic and structurally enforced. The question is whether KEEL should adopt the reliability *and* the orchestration surface of these frameworks, or only the reliability posture.

## Options
1. **Adopt workflow-graph orchestration** — DAGs, multi-agent graphs, intent classifier, tool router. Maximum structural decomposition; high implementation complexity; fights the single-agent reasoning model; each graph edge is a new audit surface.
2. **Single-agent durable loop with reliability posture adopted** — durable session state, approval gates, trajectory evals, memory write gates, no-auto-retry on failed tools. Reasoning is monolithic (one context window, one agent); control-plane enforcement is structural (kernel/warden split).
3. **Minimal loop, no reliability infrastructure** — fastest to build, but violates the Phase 0 exit gate and produces no meaningful eval baseline.

## Decision
Adopt the *reliability posture* of the 2026 production-agent literature — durable state, approval gates, trajectory evals, memory write gates, structured no-auto-retry (a failed or denied tool returns machine-readable guidance; the model drives recovery) — but reject its *orchestration surface*. No workflow DAGs, no multi-agent graphs, no separate intent classifier, no tool routers. The kernel/warden split is the mechanism: the kernel is a single durable agent loop; the warden is the deterministic control plane that enforces policy, manages approval gates, and writes the audit chain. Subagents are Phase-4-only; DAGs are never introduced.

## Consequences
The §1.4 exclusions are enforced by this decision: no multi-agent framework, no DAG executor, no intent router. Every reliability property (resumability, approval gates, audit trail, memory safety) is implemented as a first-class kernel or warden feature, not as a graph-topology artifact. This keeps the audit narrative faithful — a single agent context window means the full reasoning trace is always available. The single-agent constraint must be re-evaluated in Phase 4 if benchmark results show a consistent multi-agent gap that cannot be closed by harness improvements.
