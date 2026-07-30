# 0012 — Warden RPC Protocol Versioning Policy

**Status:** accepted
**Date:** 2026-06-13

## Context

The warden RPC (Appendix A, `MASTER_SPEC.md`) is declared frozen before Phase 1. Several
issues were surfaced by the Phase 0 adversarial QC review that required amending the
frozen contract before the P0 gate could be honestly called passed:

- The `ErrorCode` enum in `primitives.ts` was labelled "Frozen set for v1; new codes
  require a protocol version bump + ADR", yet the wire field (`JsonRpcError.data.code`)
  accepted only the exact enum members, making the protocol brittle: any future code
  addition would be a breaking change for receivers that silently reject unknown codes.
- `sessionId` fields in `ExecuteParams` and `AuditExportParams` were typed
  `z.string().min(1)`, losing the `ses_<ULID>` format constraint visible elsewhere in
  the shared package.
- `RpcId` accepted any `number` including floats and ±Infinity, which are not
  JSON-safe (a 1.5 id would survive the schema but corrupt over the wire if the
  transport rounds integers).
- Hash fields (`AuditExportResult.rootHash`, `StatusResult.auditHead.hash`,
  `PolicyPackRef.hash`) accepted any non-empty string rather than the `sha256:<64 hex>`
  format defined in `common/formats.ts`.
- There was no machine-checked notification registry to match `WARDEN_METHODS`, leaving
  the `warden.event` notification without a validatable contract.
- JSON-crossing value fields (`ToolCall.args`, `ExecuteResult.result`/`modifiedArgs`,
  `ResolveReviewResult.result`) used `z.unknown()` / `z.record(z.unknown())`, admitting
  `undefined`, `NaN`, and `±Infinity` that silently drop or corrupt over JSON.

These are all pre-P0-gate amendments; the P0 exit gate has not yet passed, so changing
the frozen interface is in-window. This ADR records the versioning policy that governs
all future changes.

## Options

1. **Strict closed enum** — `ErrorCode` wire type remains the enum; adding a code is a
   breaking (MAJOR) change. Simple, but makes evolution unnecessarily costly.
2. **Open string** — the wire type is `z.string().min(1)` with no recognized set.
   Forward-tolerant, but loses the curated recognized set that gives consumers a precise
   list of codes to handle.
3. **Recognized set + forward-tolerant wire (chosen)** — keep `ErrorCode` as the
   curated set of recognized codes; the wire field is `ErrorCode.or(z.string().min(1))`.
   Consumers parse recognized codes exactly; unknown codes pass as opaque strings.
   Adding a recognized code is a MINOR bump.

## Decision

**Versioning tiers:**

| Change                                          | Version bump |
|-------------------------------------------------|-------------|
| Adding a recognized `ErrorCode` value           | MINOR        |
| Adding a new method to `WARDEN_METHODS`         | MINOR        |
| Adding a new notification to `WARDEN_NOTIFICATIONS` | MINOR    |
| Removing or renaming a method/notification      | MAJOR        |
| Changing the shape of a field (type narrowing or widening that breaks existing values) | MAJOR |
| Additive optional field on an existing schema   | MINOR        |
| Bumping `PROTOCOL_VERSION` in `primitives.ts`   | Required for any MINOR or MAJOR change |

**Wire forward-tolerance for `ErrorCode`:** `JsonRpcError.data.code` accepts
`ErrorCode.or(z.string().min(1))`. Receivers MUST treat unrecognized codes as opaque
and MUST NOT fail hard on them. The recognized `ErrorCode` enum is the v1 curated set;
adding an entry there requires a MINOR bump and an update to this ADR.

**`WARDEN_METHODS` and `WARDEN_NOTIFICATIONS` are the machine-checked contract
surface.** Every callable method and every async notification MUST appear in the
respective registry. The Phase 2 contract suite validates every call/response and
notification frame against these registries.

**Constrained types on the wire:** All fields that cross the JSON-RPC wire are
constrained to JSON-safe types (`JsonValue` / `JsonObject` from `common/json.ts`),
`SessionId` for session identifiers, and `Sha256` for content hashes. Unconstrained
`z.unknown()` is not permitted on wire-crossing fields.

This resolves the MASTER_SPEC Appendix A open "…" in the error-code set.

**Compatibility ledger:**

| From | To | Classification | Required compatibility behavior |
|---|---|---|---|
| `1.0.0` | `1.1.0` | MINOR — adds `warden.presentation.take` and capability `mutation-presentation/v1` | A 1.0 peer is accepted; hello reports server `1.1.0` without the new capability; every pre-existing non-hello response envelope remains byte-shape-identical; and the peer incurs zero presentation-only capture, diff, redaction, construction, or store work. |

## Consequences

- Adding a new recognized error code is a MINOR protocol bump: update `ErrorCode` in
  `primitives.ts`, update `PROTOCOL_VERSION` minor digit, add a row to this ADR's
  recognized-set table, and note it in the PR.
- Removing an existing recognized code is a MAJOR bump (even though the wire accepts
  unknown strings, removing from the recognized set signals to consumers that they
  should stop handling it).
- The `WARDEN_NOTIFICATIONS` registry (added in the same hardening commit) is the
  canonical source of truth for all warden→kernel async notifications. Phase 2
  implementers MUST add entries here when adding new notification types.
- `JsonValue` / `JsonObject` constraints on wire-crossing fields mean callers CANNOT
  pass `undefined`, `NaN`, `±Infinity`, or `bigint` through those fields. This is a
  correctness constraint, not a behavioral one: the JSON-RPC transport would silently
  corrupt such values anyway.
