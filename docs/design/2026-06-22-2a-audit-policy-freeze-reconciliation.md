# Phase-2A audit/policy freeze — spec reconciliation + threading record

**Status:** APPLIED at the Phase-2A R1 audit/policy format freeze. This is the frozen-format change for
the Phase-2A boundary (ADR-0027). It accompanies the ADR-0024 revision, ADR-0056, ADR-0013, and the
verified `@keel/shared` `SideEffect` schema. **Date:** 2026-06-22; applied 2026-06-23.

This document records: (1) the drifts found in the old spec; (2) the §4.8 / Appendix B / Appendix D §D.1
rewrite to the single multi-axis shape; (3) the `AuditRecord` / `PolicyInput` threading applied at R1;
and (4) the kernel `StaticCapability` convergence deliberately deferred to warden integration.

---

## 1. Drifts found (must be resolved at the freeze)

1. **Appendix B vs Appendix D vs ADR-0024 disagree on the `sideEffect` shape.**
   - Appendix B shows a **2-field** `sideEffect: { static, dynamic[] }` and **folds a modifier into
     `dynamic[]`** (`"dynamic": ["workspace_write", "destructive"]`).
   - Appendix D §D.1 shows a **3-field** `sideEffect: { static, dynamic[], modifiers[] }`.
   - ADR-0024 (original) defined the 3-field shape.
   All three are superseded by the revised multi-axis shape — so the rewrite *resolves the drift by
   construction* (one shape, both appendices).

2. **The kernel `StaticCapability` carries a `"broad"` sentinel the taxonomy enum never had.**
   `packages/kernel/src/tools/registry.ts` declares `StaticCapability = read_only | workspace_write |
   network_read | network_write | external_write | broad`. Under the revised model, `"broad"` is
   **static-envelope metadata** (`staticCapability.broad = true`), not an effect value. Convergence plan
   in §4.

3. **MASTER_SPEC §4.3 + ADR-0028 still state the OLD retry rule** (QC re-review F10). They require *both*
   the static AND dynamic class be read-only; ADR-0024's revision explicitly drops the static conjunct in
   favor of a **dynamic-only** eligibility predicate (`isRetryEligible`). The R1 rewrite MUST reconcile
   §4.3 (and ADR-0028's prose), not only §4.8 — else the live spec ships self-contradictory.

---

## 2. Applied §4.8 (normative) — replacement text

> **§4.8 Tool side-effect taxonomy (normative).** Every tool and every tool *invocation* carries a
> side-effect classification (the `SideEffect` schema, `@keel/shared`, `side-effect-taxonomy/v1`) used by
> policy (Appendix D), audit (Appendix B), retry (§4.3), review prompts (§8.5), evals (§8.2), and the
> autonomy postures (§4.9). **Two levels:** the **static envelope** declared per tool
> (`staticCapability{toolName, effectEnvelope[], broad}` — `bash` is `broad:true`), and the **dynamic
> resolved effect** the warden computes per invocation. The dynamic effect is **multi-axis**:
> `effectKinds[]` (*what*: `fs_read·fs_write·process_exec·network_read·network_write·unknown`),
> `scopes[]` (*where*: `workspace·home·system·temp·network·external_service·process·unknown`),
> `targets[]` (concrete resources; `path`/`env_var` targets carry a normative `sensitivity`),
> `modifiers[]` (`destructive·irreversible·persistent`), a `composition{kind, segments[], edges[]}` that
> preserves dataflow (`pipe`/`substitution`/`redirect`) vs ordering (`sequence`/`conditional`), and a
> `classifier{confidence, reasons[]}`. **Rules:** the kernel declares only the static envelope; the
> warden computes the dynamic effect (ADR-0017); composite risks (exfiltration, supply-chain, credential
> access, permission/privilege change, system config, resource exhaustion) are **policy-derived from
> these primitives, not frozen**; exfiltration covers same-segment secret upload plus data-carrying
> secret→external paths; **unknown/obfuscated fails closed** (non-retryable, review/deny per
> posture); **disposition (allow/review/deny) is policy-pack/posture configurable, not fixed**; the
> **sandbox + egress allowlist are the authoritative backstop** (resource exhaustion is sandbox-enforced,
> SEC-017). Defined frozen in `@keel/shared` (ADR-0024 revised; ADR-0056 capability manifest). The
> Phase-1 transitional snapshot net (ADR-0043) is unchanged.

## 3. Applied Appendix B (audit record) — `sideEffect` field

Replace the inline `sideEffect` line with the full `SideEffect` object (abbreviated here; full schema in
`@keel/shared`). Example for `rm -rf ./dist`:

```jsonc
"sideEffect": {
  "taxonomyVersion": "side-effect-taxonomy/v1",
  "staticCapability": { "toolName": "bash", "effectEnvelope": ["fs_read","fs_write","process_exec","network_read","network_write"], "broad": true },
  "dynamic": {
    "effectKinds": ["fs_write"],
    "scopes": ["workspace"],
    "targets": [{ "kind": "path", "value": "./dist", "normalized": "/repo/dist", "withinWorkspace": true, "sensitivity": "internal" }],
    "modifiers": ["destructive"],
    "composition": { "kind": "atomic", "segments": [{ "effectKinds":["fs_write"], "scopes":["workspace"], "targets":[/* … */], "modifiers":["destructive"] }], "edges": [] },
    "classifier": { "name": "shell-classifier", "version": "…", "confidence": "exact", "reasons": ["recursive_delete"] }
  }
}
```

Notes for the freeze:
- The field is **present on `tool.execute` and `tool.deny`** records (denied actions carry the same
  classification fidelity).
- It is **canonicalized into the hash** (ADR-0006) — adopt **JCS / RFC 8785** as the canonicalizer
  (the ADR-0013-borrowed primitive). JCS canonicalizes object KEYS but does NOT reorder array elements,
  so hash-stability also needs array-order determinism. **The `SideEffect` schema now OWNS this** (QC
  reliability F1): its transform sort+dedups the set-like arrays (`effectKinds`/`scopes`/`modifiers`/
  `effectEnvelope`) + `edges`, so two semantically-equal classifications canonicalize identically — the
  guarantee is structural in the schema, not delegated to the warden. (`segments`/`targets`/`reasons`
  retain the classifier's deterministic parse order.) **Pin the canonicalizer in ADR-0006 before the
  freeze** — a hash-chained schema cannot freeze while the bytes it commits to are undefined.
- **`policy_sandbox_mismatch` finding (ADR-0056):** decided at R1 as an open-payload `findings[]` marker
  on the existing audit event that observed the disagreement, not a new Appendix-B `eventType` (additive,
  forkable, and mirrors the ADR-0033 `sessionGrant` precedent).

## 4. Applied Appendix D §D.1 (policy input) — `sideEffect` field

Same `SideEffect` object as Appendix B (one shape, both homes). The §D.1 example's `sideEffect` line is
replaced with the full object. Policy rules reference `input.sideEffect.dynamic.*` and derive composites
(the ledger in the decision doc). The existing `normalized{argv, decodedLayers}` stays (the classifier
consumes it to produce `sideEffect`).

## 5. Threading plan (applied at R1)

The schema is exported from `@keel/shared` and threaded into the frozen-pending audit/policy records.

**`packages/shared/src/audit/record.ts`** — add the field to `AuditRecord` (and mirror optional support
into `AuditCheckpointRecord`, per its keep-in-sync note):

```ts
import { SideEffect } from "../policy/side-effect.js";
// Structural branches, not a post-parse optional-field convention:
// - tool.execute/tool.deny branch: sideEffect: SideEffect
// - non-tool non-checkpoint branch: sideEffect: SideEffect.optional()
// - checkpoint branch: sideEffect: SideEffect.optional()
```
- **REQUIRED on `tool.execute` / `tool.deny`** at R1 (QC re-review F2): denied-action audit fidelity is a
  core property (AGENTS.md — denied actions logged with the *same* fidelity as allowed ones), so a "may
  later require" stance is a freeze loophole (tightening it post-freeze is a breaking schema change).
  Optional only on non-tool events (`session.start`, `mode.change`, …). Remove the "NOT frozen until OQ-8"
  caveat at the top of the file (OQ-8 resolved by ADR-0013).

**`packages/shared/src/policy/input.ts`** — add to `PolicyInput`:

```ts
import { SideEffect } from "./side-effect.js";
// …in PolicyInput object:
sideEffect: SideEffect,  // required — the warden always classifies before a verdict
```
- **Required** here (every policy evaluation sees a classification; fail-closed `unknown` if undecodable).

**Both** changes are additive to the schemas, with gated tests: tool records missing `sideEffect` reject;
non-tool/checkpoint records may omit it; malformed `sideEffect` rejects at the policy boundary; and valid
records wire-round-trip.

## 6. `StaticCapability` convergence (kernel → `@keel/shared`) — at warden integration (Phase-2A)

- Today `packages/kernel/src/tools/registry.ts` declares a local `StaticCapability` **string union** and
  each tool sets `staticCapability: "read_only" | … | "broad"`.
- **Convergence (Phase-2A, not now):** the kernel imports the shared `staticCapability` **object** shape;
  each tool declares `{ toolName, effectEnvelope: EffectKind[], broad }`. The mapping is mechanical:
  `read/search/plan/skill/retrieve → {effectEnvelope:["fs_read"], broad:false}`; `write/edit →
  {["fs_write"], broad:false}`; `bash → {effectEnvelope:[all five kinds], broad:true}`. The drift-guard
  test in `registry.test.ts` is updated to the object shape.
- Done at warden integration so the kernel and warden share one definition; the standalone schema PR does
  **not** touch the kernel (keeps it separable and the kernel suite green).

## 7. Ratification checklist (what freezes together)

**Closed in the QC re-review hardening pass:**
- [x] `@keel/shared` `SideEffect` schema hardened + green: **F1** top-level-target drift refine + dedup,
      **F6** normative `normalized` on all path/host/url targets, **array-size caps** for hostile
      audit-import, **F4** forward-compat reader `parseSideEffectCompat`.
- [x] §7 corpus expanded to **46 cases** + an executable **anchor→fixture coverage table**.
- [x] ADR-0006 canonicalizer **pinned to JCS / RFC 8785** (F9).
- [x] ADR-0024 / anchor §7 / epic plan **split *format freeze* vs *classifier acceptance*** (F8).
- [x] ADR-0056 manifest **format de-scoped from R1** — only the decision + invariant ratify (F5).

**R1 ratification / freeze record:**
- [x] ADR-0024 revision re-ratified · ADR-0056 accepted · ADR-0013 accepted (OQ-8 resolved).
- [x] `@keel/shared` `SideEffect` schema merged (additive; verified green).
- [x] §7 classifier corpus accepted as the Phase-2A classifier **acceptance** obligation (not a format gate).
- [x] §4.8 / Appendix B / Appendix D §D.1 rewritten to the single shape (this doc) — resolves the drifts.
- [x] **§4.3 + ADR-0028 retry prose reconciled to the dynamic-only predicate (F10).**
- [x] **`sideEffect` REQUIRED on `tool.execute`/`tool.deny`** audit records (F2 refine).
- [x] `policy_sandbox_mismatch` audit representation decided: open-payload `findings[]` marker on the
      existing audit event, no new `eventType`.
- [x] Threading PR (AuditRecord + PolicyInput) merged; `StaticCapability` convergence scheduled for
      warden integration.

`side-effect-taxonomy/v1` + the Appendix B/D fields freeze at this point. The live classifier remains a
Phase-2A implementation and acceptance gate.

## 8. Field source-of-truth table (QC re-review F11)

Which fields policy may trust, and how each is kept from drifting. Policy + the exfil derivation reason
over the **authoritative** fields; the **derived** fields exist for cheap queries and are made
non-divergent by a refine + the canonicalizing transform; the **advisory** field is display-only.

| Field | Status | How drift / fail-open is prevented |
|---|---|---|
| `dynamic.composition.segments[]` + `edges[]` | **Authoritative** (dataflow) | the classifier's deterministic parse; everything else derives from it |
| `dynamic.effectKinds` / `scopes` / `modifiers` | Derived aggregate | refine: must equal the set-union of segments; transform sorts+dedups |
| `dynamic.targets` | **Derived from segments** (advisory bag for set queries) | **F1**: the transform RECOMPUTES it from `segments[].targets` with a collision-free (JSON) identity key, and the refine also rejects a drifted provided bag → authoritative-by-construction, so policy may read it safely |
| `targets[].normalized` | Classifier claim (enforcement key) | **F6** refine: required for path/host/url at all classifier confidences (else policy containment fails open) |
| `targets[].sensitivity` | Classifier claim (normative) | refine: required for path/env_var; secret namespaces must resolve `secret` (no downward) |
| `composition.kind` | **Advisory — display only** | NOT authoritative; policy + exfil MUST reason over `edges`, never `kind` |
| `classifier.confidence` | Classifier claim | drives fail-closed; the sandbox + egress allowlist are the authoritative backstop |
| `taxonomyVersion` | Contract pin | major-pinned; a newer minor is read via `parseSideEffectCompat` (F4 coercion to fail-closed `unknown`) |
