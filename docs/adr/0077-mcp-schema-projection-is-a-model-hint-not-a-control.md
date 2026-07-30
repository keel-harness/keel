# ADR-0077 — MCP tool-schema projection is a model hint, not a security control

**Status:** Accepted on 2026-07-21 during pre-OSS launch hardening. Records the decision behind the
provider-schema-compatibility projection added in the initial implementation and the F3 finding of the
2026-07-21 pre-launch readiness audit. Relates to ADR-0067 (governed MCP projection seam), ADR-0026
(trust-before-parse), ADR-0033 (Autopilot ≠ YOLO), and MASTER_SPEC §3.2, §4.3, §4.8.

**Date:** 2026-07-21

## Context

keel advertises trusted local-stdio MCP tools to the model through the same provider tool interface
as its built-in tools. Two facts collide:

1. **Provider tool schemas are constrained.** The Anthropic Messages API rejects a tool
   `input_schema` whose root is not a plain object or that uses top-level `oneOf`/`anyOf`/`allOf`
   (the recorded failure that motivated the initial compatibility fix). Other JSON Schema keywords
   (`$ref`/`$defs`, `const`, `dependencies`, `if`/`then`/`else`, `patternProperties`, …) are
   rejected or unsupported by one or more shipped providers. A single provider-invalid tool schema
   fails the *entire* request, disabling every tool for that turn.
2. **MCP servers author arbitrary schemas.** A third-party MCP server's `inputSchema` is outside
   keel's control and commonly uses exactly those constructs. keel's product goal is that a user can
   add *any* MCP server and it works.

If the advertised schema were treated as authoritative — passed through verbatim, or rejected when
non-conforming — either the provider request would break (a repeat of the total-outage class) or keel
would have to refuse servers, defeating the flexibility goal.

## Decision

**The advertised MCP tool schema is a non-authoritative, best-effort hint to the model. It is never
an enforcement surface, and no MCP server is ever refused for schema reasons.**

Projection (`mcpProjectionParameters` in `packages/kernel/src/mcp/local-stdio.ts`, using
`toProviderCompatibleJsonSchema` / `providerHostileSchemaPaths` in
`packages/kernel/src/providers/schema-compat.ts`):

- Provider-hostile keywords are stripped/normalized where the result is still a faithful, provider-
  valid schema (e.g. `const` → single-value `enum`).
- When a schema still contains provider-hostile constraints after normalization, the projection
  **falls back to an opaque object** — `{ type: "object", additionalProperties: true }` with an
  honest description ("treat arguments as opaque; the MCP server may reject invalid arguments").
- An over-size schema falls back to the same opaque object.

The fallback guarantees the flexibility goal: **projection never fails and never refuses a server.**
Worst case the model receives an opaque-args hint instead of typed fields.

**Enforcement is independent of this schema.** The warden governs every MCP tool call through
`buildMcpOpaquePolicyInput` (`packages/warden/src/mcp/policy.ts`), which models the call as a **broad,
conservative, opaque side effect** — all effect kinds (`fs_read`/`fs_write`/`network_read`/
`network_write`/`process_exec`), all scopes, `modifiers:["unknown"]`, `confidence:"conservative"`,
`broad:true`, `opaque:true` — and still inspects the **actual arguments the model sent** for path-like
and secret-like values. `withMcpSensitivityPolicy` downgrades any allow to **review** (POL-012-MCP)
when secret-sensitive data is entering the opaque call, and results are tagged untrusted. None of this
reads the advertised schema. Therefore flattening or opaque-fallback of the schema **cannot** widen
authority or weaken governance: the security narrative is schema-independent by construction.

## Consequences

- **Flexibility preserved.** Any local-stdio MCP server projects successfully; a hostile/oversize
  schema degrades to opaque args, never a refusal or a broken provider request.
- **Security narrative intact and honest.** The schema is explicitly a model hint. The Autopilot-≠-YOLO
  line holds: a mode never implies a schema-derived guarantee the warden does not enforce. Enforcement
  is the opaque broad-conservative model plus POL-012-MCP.
- **Usability tradeoff (tracked follow-up).** For a schema whose only provider-hostile keywords are
  `$ref`/`$defs` or combinators, the opaque fallback discards field structure the model could have
  used, so the model may call the tool with args the MCP server then rejects. A future enhancement can
  recover the common cases without touching enforcement: inline internal `$ref`/`$defs` (cycle- and
  depth-bounded) before the hostile-key check so pure-`$ref` schemas keep their structure, and hoist
  `oneOf`/`anyOf` branch `properties` into the parent (all-optional) so combinator schemas keep their
  field names. Both are model-hint quality improvements only; the opaque fallback remains the safety net
  for anything not safely simplifiable.

## Evidence

- Schema-independent opaque governance and secret-sensitive review:
  `packages/warden/src/mcp-local-stdio.test.ts` ("builds a broad opaque conservative side effect",
  "marks secret-looking arguments for POL-012-MCP review independent of provenance", "applies
  POL-012-MCP through a policy-port wrapper" → `verdict:"review"`, `matchedRules:["POL-012-MCP"]`).
- Projection never advertises provider-hostile keywords (recursive, all depths):
  `packages/kernel/src/mcp/local-stdio.test.ts` and `packages/kernel/src/warden/runtime.test.ts`
  (`providerHostileSchemaPaths(...).toEqual([])` over projected MCP specs and governed twins);
  `packages/kernel/src/providers/tools.test.ts` (opaque fallback + `const`→`enum`).
