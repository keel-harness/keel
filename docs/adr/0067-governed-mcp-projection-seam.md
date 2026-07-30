# ADR-0067 - Governed MCP projection seam

- **Status:** Accepted for Epic 2.26 local-stdio MCP slice only; remote MCP remains gated.
- **Date:** 2026-07-01.
- **Deciders:** keel maintainer direction for the Phase 2.5 MCP track.
- **Governs:** governed MCP design and sequencing. Relates to MASTER_SPEC §1.1, §1.4, §4.3, §4.8,
  §4.9, §7 Phase 2/2.5/3, ADR-0016, ADR-0017, ADR-0024, ADR-0026, ADR-0033, ADR-0038, ADR-0056,
  ADR-0058, ADR-0065, and ADR-0066.

## Context

MCP has become table-stakes for agent tooling. The master spec already reserved governed MCP as a
future code-mode surface, but the roadmap placed it too late relative to developer expectations.

The security problem is that a normal MCP client turns third-party server definitions, local
processes, remote endpoints, server logs, server prompts, server resources, and server-originated
requests into authority-adjacent inputs. That would violate keel's core rule if implemented as a
simple SDK integration: the model would receive new tools whose real effects are opaque, often backed
by arbitrary local code or remote services, while the kernel holds provider credentials.

The supplied design in
`docs/design/2026-07-01-governed-mcp-integration-design.md` proposes the correct direction: MCP is a
new governed tool source, not a second enforcement model. The codebase review in
`docs/design/2026-07-01-governed-mcp-integration-design.md` confirms the main existing seams are usable,
while identifying a missing implementation primitive: the current warden has one-shot
`SandboxPort.execute`, not a long-lived stdio server supervisor.

## Decision

Pull governed MCP forward into a **Phase 2.5** track, before Phase 3 implementation, with strict
scope:

1. **MCP v1 is tools-only.** Resources, prompts, sampling, and elicitation are refused with typed
   capability-not-supported errors. No config knob enables them in v1.
2. **Pre-Phase-3 runtime scope is local stdio only.** Remote Streamable HTTP, localhost HTTP, remote
   roots, and argument egress to server-controlled hosts are hard-gated on Phase 3 provenance
   enforcement.
3. **Every advertised MCP tool call goes through `warden.execute` or fails closed.** The model never
   invokes an ungoverned MCP transport path in the governed product mode.
4. **Server definitions are pinned data, not authority.** Tool descriptions, schemas, annotations,
   `_meta`, notifications, and logs never widen capability, downgrade verdicts, or grant trust.
5. **Unknown MCP effects use the conservative floor.** Opaque MCP tools receive a broad static
   envelope and conservative dynamic classification until a pin-bound, trusted capability manifest
   narrows them.
6. **Server trust and invocation permission are separate.** Trusting a server advertises pinned tools;
   it does not auto-approve risky invocations.
7. **Audit uses open payload markers in Phase 2.5.** No new Appendix B event type is introduced for
   the initial slice.
8. **No `WARDEN_METHODS` change is assumed.** The first implementation epic must prove the MCP
   lifecycle can be implemented production-grade through existing `warden.execute` routing and
   warden-internal ownership. If that proof fails, implementation stops and a separate protocol-bump
   ADR is required.

## Why local stdio can precede Phase 3

Local stdio MCP is still arbitrary code, so it must be sandboxed like governed bash. But it can be
bounded before provenance enforcement because:

- no remote transport is advertised;
- server egress defaults to empty;
- resource links are rendered inert and never followed;
- secrets paths and sensitive arguments are reviewed/denied by a new POL-012-MCP rule;
- existing governed bash and typed-tool egress defenses remain in force for other tools.

This is a useful developer feature and a real ecosystem compatibility slice without asserting the
full remote-MCP confused-deputy defense.

## Why remote MCP waits

Remote MCP arguments are egress payloads. A malicious tool result can influence the model to send
untrusted-derived or secret-derived data to a granted host. Without Phase 3 provenance semantics,
especially conservative taint on model-authored arguments when untrusted content is in context, the
remote confused-deputy claim would be theater.

Remote Streamable HTTP therefore waits until Epic 3.1 implements provenance enforcement and POL-011.

## Consequences

- The master spec should no longer frame all MCP as a Phase 4 item. Broad MCP remains future work, but
  governed local stdio MCP is a Phase 2.5 track.
- The first runtime epic starts with a walking skeleton around one fixture stdio server and one tool,
  not a marketplace, registry, or broad connector story.
- Warden implementation must grow an MCP server lifecycle strategy. The preferred path is warden-owned
  process execution/supervision addressed through existing `warden.execute` tool-name routing. A new
  RPC method is not allowed without a follow-up ADR and owner approval.
- Capability manifests become the long-term way to earn quiet Autopilot behavior for known MCP
  servers, but default opaque tools stay review-heavy by design.
- The claim ledger must continue to exclude MCP governance until the SEC-MCP tests are executable and
  green for the specific slice shipped.

## Non-goals

- No remote MCP in Phase 2.5.
- No server registry or marketplace.
- No preloaded MCP schema firehose.
- No prompts/resources/sampling/elicitation support in v1.
- No extension API/code-loading implementation.
- No provider API egress enforcement claim.
- No frozen RPC/audit/schema/CLI change without a separate ADR and stop-and-ask review.

## Evidence Required Before Acceptance

Owner ratification should require:

- review of this ADR;
- review of the implementation evidence summarized in this ADR;
- agreement that Phase 2.5 may gate Phase 3 entry;
- agreement that remote MCP stays gated on Phase 3 provenance enforcement;
- agreement on whether the first implementation may proceed without a frozen RPC change.
