# 0061 — Audit-event payloads use `JsonObject`, not `z.record(z.unknown())`

**Status:** accepted
**Date:** 2026-06-24

## Context

The phases 0–1 audit (finding **SCH-1**) found that the two warden-bound audit-event
payloads in `packages/shared/src/rpc/events.ts` —

- `KernelAuditEvent.payload` (submitted via `warden.audit.append`, Appendix A / `methods.ts`), and
- `WardenEvent.payload` (async `warden.event` notifications)

— are typed `z.record(z.string(), z.unknown())`. That accepts `NaN`, `±Infinity`, `bigint`,
and `undefined` (verified by probe: `KernelAuditEvent.safeParse({ eventType: "session.start",
payload: { x: NaN, y: undefined, z: 10n } })` → `success: true`).

This **diverges from the rest of the audit/RPC contract's own discipline.** `AuditRecord.payload`
(Appendix B, `audit/record.ts`) is deliberately `JsonObject` "so no NaN/undefined/±Infinity can
cross the warden JSON-RPC wire or corrupt a hash-over-canonical-JSON," with a dedicated wire test.
The audit-event payloads — which become audit-chain *content* once the warden's `audit.append`
handler is built — get no such guarantee. A producer that constructs one of these events in memory
and validates it as "wire-safe" before serializing gets a false assurance: a `bigint` throws on
`JSON.stringify`, and `NaN`/`±Infinity`/`undefined` silently corrupt or drop in a
hash-over-canonical-JSON — the exact failure the rest of the contract is hardened against.

It is **latent today** (the warden `audit.append` handler is a `WARDEN_NOT_READY` stub, and
over-the-wire requests are already `JSON.parse`'d so a non-JSON value cannot *arrive*), but Phase 2
will build the real audit writer on this schema. Fixing it now — before that handler exists — costs
nothing and removes a frozen-contract inconsistency.

A companion finding (**SCH-2**) is that `events.test.ts` and `methods.test.ts` assert with
`assertRoundTrips` (parse-idempotency, which a `z.unknown()` field passes trivially) rather than
`assertWireRoundTrips` (the helper written precisely to catch JSON-unsafe fields). So the test that
*should* have flagged SCH-1 is not applied to the schemas that have the weakness.

## Options

1. **Leave it** — it's latent. Rejected: the charter forbids letting a frozen contract diverge from
   its own stated invariant ("honesty over impressiveness"; "no broken windows"), and Phase 2 would
   inherit the hole.
2. **Bump the protocol major version** to signal a breaking schema change. Rejected as unnecessary:
   the change only *rejects* values (`NaN`/`±Infinity`/`bigint`/`undefined`) that can never appear in
   a value produced by `JSON.parse`, so **no valid wire message changes meaning**. This is a
   compatible tightening, not a semantic break — the same posture under which `AuditRecord.payload`
   already uses `JsonObject` without a dedicated version gate.
3. **Use `JsonObject` (chosen).** Replace `z.record(z.string(), z.unknown())` with the existing
   `JsonObject` (`z.record(z.string(), JsonValue)`) on both payloads, and switch the round-trip tests
   to `assertWireRoundTrips`.

## Decision

Type both `KernelAuditEvent.payload` and `WardenEvent.payload` as `JsonObject`, matching
`AuditRecord.payload` and `ToolCall`. Switch the `events.test.ts` round-trip assertions to
`assertWireRoundTrips`, and add explicit assertions that a `NaN`/`Infinity`/`undefined`-bearing
payload is rejected.

`methods.test.ts` is deliberately left on `assertRoundTrips`: it loops over *all* warden methods,
and `assertWireRoundTrips` on the whole set would trip the **intentional** `JsonRpcError.data`
`.passthrough()` (a forward-tolerant, opaque error field, not audit-chain content). A method-by-method
wire-safety pass is a worthwhile follow-up but is out of this finding's scope — `AuditAppendParams`
embeds the now-`JsonObject` `KernelAuditEvent`, so the audit-append payload is transitively wire-safe
regardless.

No protocol-major bump: the change is a compatible tightening that rejects only values which were
never representable on the JSON wire. The protocol version is unchanged.

## Consequences

- The two audit-event payloads now carry the same JSON-safety guarantee as the audit record they
  feed, so a producer can validate a wire-safe event before serializing and trust the result.
- `assertWireRoundTrips` on these schemas is the executable proof of the property (closes SCH-2);
  a future regression to a JSON-unsafe field is caught by the test, not in production.
- Phase 2's `warden.audit.append` handler is built on a payload that cannot smuggle a
  hash-corrupting value into the audit chain.
- Strictly additive for every real caller: any payload that survives `JSON.parse` (i.e. every
  payload that has ever crossed the wire) is still accepted.
