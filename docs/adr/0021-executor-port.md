# 0021 — ExecutorPort: the kernel↔execution swap seam

**Status:** accepted
**Date:** 2026-06-13

## Context
The kernel agent loop (Epic 1.1) must dispatch model-issued tool calls. The §4.2 process model and
ADR-0016 require that the kernel can only *request* execution — enforcement (sandbox, policy, audit)
lives out-of-process in the warden (Phase 2). Phase 1 has no warden, so tools run directly, but the
loop must already be written against the seam the warden will later occupy, so swapping enforcement in
is a drop-in with no loop changes.

## Options
1. Loop calls tool functions directly (no port) — fast, but rewrites the loop in Phase 2 and bakes the
   "no enforcement" assumption into the core. Rejected (no-broken-windows; ADR-0016 seam).
2. Reuse the warden RPC `warden.execute` shape now — couples Phase 1 to the frozen wire contract and
   drags RPC concerns into a local call. Rejected as premature.
3. A minimal `ExecutorPort` interface in `@keel/shared` with `LocalExecutor` (Phase 1) and
   `WardenExecutor` (Phase 2) implementations. Chosen.

## Decision
Define `ExecutorPort` in `@keel/shared/src/ports/executor-port.ts` (beside `ModelPort`):
`execute(call: ToolInvocation, opts?: {signal?}) => Promise<ToolResult>`, with `ToolResult.ok:false`
as the structured-error channel. `LocalExecutor` implements it in Phase 1 (direct execution, honest-YOLO
banner, no enforcement). The port is **not frozen** until the Phase-2 warden integration interposes
`WardenExecutor`; freezing it then gets its own ADR.

## Consequences
- The kernel loop is enforcement-agnostic from day one; Phase 2 swaps the implementation, not the loop.
- The Phase-1 shape is intentionally minimal (`{ok, output}`); richer results (provenance tags, verdict,
  modified args) are added when `WardenExecutor` lands, behind the same call site.
- `ToolInvocation` mirrors the model's `tool-call` chunk fields; convergence with the RPC `ToolCall`
  shape is handled at warden integration.
