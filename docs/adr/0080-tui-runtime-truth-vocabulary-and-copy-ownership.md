# 0080 — TUI runtime truth vocabulary and copy ownership

**Status:** Accepted for Epic 3.10 Slice 6 by delegated owner decision on 2026-07-23.
**Date:** 2026-07-23
**Amends:** ADR-0003 and ADR-0036
**Relates to:** ADR-0033, ADR-0055, ADR-0073, Master Spec §4.9.1/§6.4/§8.6,
`docs/design/tui-principles.md`, and Epic 3.10 Slice 6.

## Context

ADR-0003 said that every user-facing string would live in one `strings.ts` per package. The real TUI
subsequently grew into covered pure planners plus thin Ink/headless renderers. Its reusable
controller/model guidance lives in `packages/kernel/src/strings.ts`, while TUI copy is intentionally
close to `view-model.ts`, `composer.ts`, `approval-notice.ts`, `commands.ts`, `hints.ts`, and other
covered planners. No `tui/strings.ts` exists. Applying ADR-0003 literally now would move hundreds of
unrelated labels and format strings into one package-level file, obscure ownership, and create a
large no-behavior rewrite immediately before launch.

The drift is not harmless, however. Several current surfaces still say `phase 1`, promise that the
warden “lands in phase 2,” or use different words for the same runtime state even though the shipped
product starts a real warden by default. Booleans for individual guarantees also cannot distinguish
an explicit eval-only direct route from a legacy/unreported view. Runtime truth must come from typed
controller state, not historical release labels, model prose, or renderer inference.

## Options considered

1. **Enforce ADR-0003 literally and move every string into `packages/kernel/src/strings.ts`.**
   Rejected. It creates a package-wide copy junk drawer, weakens subsystem ownership, and turns a
   focused truth-vocabulary slice into a risky mechanical migration.
2. **Leave copy co-located and rely only on golden tests.** Rejected. Cross-surface truth terms can
   continue to drift, and tests alone do not give a forker one reviewed vocabulary contract.
3. **Catalog cross-surface truth vocabulary at the smallest coherent subsystem boundary; keep
   one-off local copy beside covered planners.** Chosen.

## Decision

1. **Truth vocabulary has one TUI catalog.** `packages/kernel/src/tui/strings.ts` owns reusable
   cross-surface runtime-state names and sentences. Status, `/context`, `/capabilities`, `/policies`,
   welcome/status framing, and headless use that catalog. `packages/kernel/src/strings.ts` remains
   the owner of kernel/model/controller guidance and is not turned into a TUI copy warehouse.
2. **Local copy may remain local.** A one-off label, format string, or explanatory sentence may live
   beside the covered pure planner that owns its semantics. Reusable terminology, security-relevant
   truth copy, and wording rendered by multiple surfaces belongs in the subsystem catalog. Product
   prose must not originate in an Ink-only component when it can be planned in covered code.
3. **The controller names the execution route.** Add one optional presentation-only
   `UiProtectionRoute` to `UiStatus`: `governed` or `deliberately-unenforced`. The production warden
   status adapter supplies `governed`; the structurally gated eval-direct runtime supplies
   `deliberately-unenforced`. The existing startup lifecycle supplies `starting-protections` and
   `protections-unavailable`, which override the route while active. Absence is `not-reported` and
   must not be promoted to either route.
4. **The runtime state vocabulary is fixed for this slice.** The five presentation states are:
   `starting`, `governed`, `deliberately unenforced`, `unavailable — tools halted`, and `status not
   reported`. Individual sandbox, egress, policy, and audit facts remain separately visible. A
   governed route does not imply every dimension is on; an unavailable route is fail-closed, not
   unenforced; and an all-off/unreported posture never becomes a release-phase claim.
5. **No future-phase/runtime prophecy.** Current TUI surfaces do not say that a warden does not exist,
   promise a later phase, or use `phase 1`/`phase 2` as runtime state. Historical ADR/spec/epic text
   may retain its dated phase description. Manual compaction and other unavailable features state
   current product availability rather than an implementation phase.
6. **Trust modes remain structurally bound.** Guided/Autopilot/Project Autopilot terms may appear only
   from controller-owned governed policy posture. They are suppressed for deliberately unenforced,
   unavailable, starting, or unreported routes even if a caller supplies contradictory cosmetic
   labels. Autopilot is never a synonym for reduced enforcement.
7. **Compatibility is fail-safe.** The new route field is optional under ADR-0073 so older renderers
   may ignore it and older callers remain source-compatible. New product constructors populate it.
   A missing field renders `status not reported`; it does not inherit the old `phase 1` default.

## Consequences

- Slice 6 begins with red cross-surface tests for the five states, contradictory inputs, compact
  widths, mono/headless parity, and absence of stale phase prophecy. Only then does the catalog and
  controller wiring land.
- `UiProtectionRoute` is presentation state only. It grants no authority and changes no warden
  verdict, RPC, audit/session/eval format, policy, sandbox, grant, or security claim.
- ADR-0003's renderer isolation and microcopy-as-product-surface principles remain accepted. Its
  literal package-wide string-location rule is replaced by the smallest-coherent-subsystem rule.
- ADR-0036's reducer/thin-renderer and posture-honesty decisions remain accepted. Its Phase-1 output
  examples are historical, not current runtime vocabulary.
- A repository-wide copy relocation is expressly out of scope. Future touched copy follows this
  ownership rule without forcing unrelated churn.
