# ADR-0056 — Capability manifest: one source of truth for policy ⇄ sandbox ⇄ egress ⇄ conformance

- **Status:** Accepted at the Phase-2A R1 audit/policy format freeze, **alongside the ADR-0024 revision**
  and ADR-0013. R1 ratifies the decision/invariant and the `policy_sandbox_mismatch` audit
  representation; the manifest schema/generator lands during Phase 2A.
- **Date:** 2026-06-22.
- **Deciders:** keel maintainers (+ third-party judge at ratification).
- **Governs:** MASTER_SPEC §4.2 (warden owns policy/sandbox/egress), §4.8 (side-effect taxonomy),
  Appendix D (policy pack), §3.2(1) (OS sandbox), §7 Epics 2.2–2.5. Relates to ADR-0024 (taxonomy —
  this is its enforcement companion), ADR-0005 (vendored srt sandbox / `SandboxPort`), ADR-0004 (policy
  engine / `PolicyPort`), ADR-0017 (agent authority), ADR-0026 (declarative-only extensibility).
- **Anchor:** §6 of `docs/design/2026-06-21-side-effect-taxonomy-problem.md`; decision detail in
  `docs/design/2026-06-22-side-effect-taxonomy-decisions.md` §3.9.

## Context

keel's trust plane has three enforcement surfaces that must agree: the **policy pack** (decides
allow/deny/review/modify/warn), the **sandbox profile** (the physical filesystem/process guardrail,
ADR-0005), and the **egress allowlist** (the network guardrail). The side-effect taxonomy (ADR-0024) is
the shared vocabulary they reason over. If these are authored independently — a Rego rule here, a
Seatbelt/bwrap profile there, an allowlist in a third file — they **drift**: a policy can `allow` what
the sandbox blocks (a confusing dead rule), or `deny` what the sandbox would have permitted (false
friction), and nothing proves the audit record reflects what physically happened.

A richer taxonomy only helps if enforcement stays consistent with it. The structural answer is a single
**capability manifest** that is the authoritative source the other surfaces are *generated from or
validated against*.

This is **distinct from** the deferred user-facing `keel.policy.yaml` (MASTER_SPEC §11 item 11) — that is
a no-Rego *authoring* DX surface, deferred until real Rego-authoring friction shows up in the developer
preview. The capability manifest here is an **internal build-time source of truth**, not an end-user file.

## Options

1. **Hand-maintain policy, sandbox profile, and egress allowlist separately.** Rejected — guaranteed
   drift; no structural proof the three agree; the audit can't honestly claim policy⇄sandbox parity.
2. **Generate everything from one manifest (single source of truth).** Chosen — the manifest declares
   the per-tool static envelope, the expected sandbox profile (allow-write roots, deny-read paths), the
   default egress allowlist, and the policy-rule bindings; a build step *generates or validates* each
   surface from it, and conformance tests prove they agree.
3. **Derive the manifest the other way (infer it from the existing Rego/profiles).** Rejected — inference
   from three artifacts is lossy and re-introduces the drift it's meant to remove.

## Decision

Adopt a **single capability manifest** as the source of truth that **generates or validates** all of:
**policy rules · sandbox profile · egress allowlist · conformance tests.**

Governing principle: ***policy decides · the sandbox is the physical guardrail · audit is the evidence ·
conformance tests prove the three agree.*** Concretely:

- The manifest is expressed over the **ADR-0024 frozen taxonomy** (effect kinds · scopes · target kinds
  · sensitivity). It declares, per tool / effect-class: the static envelope, the sandbox allow/deny
  posture, the egress defaults, and which policy rules bind.
- **Generation or validation, not duplication.** A build/CI step either emits the sandbox profile +
  egress allowlist + policy-rule scaffolding from the manifest, or validates hand-written ones against
  it (the exact direction is an implementation choice for Phase-2A; either removes hand-maintained
  divergence). The manifest is **hash-pinned** like the policy pack (SEC-019).
- **Conformance tests** prove the three surfaces agree over a corpus of `(toolCall → expected SideEffect
  → expected verdict → expected sandbox outcome)` — the §7 classifier corpus (ADR-0024) is the
  classification half; the manifest cross-checks generate the policy⇄sandbox⇄egress agreement half.
- **Runtime reconciliation (defense-in-depth made observable):** when policy and sandbox disagree at
  runtime — a policy-`allow` the sandbox physically blocks, or a policy-`deny` the sandbox would have
  permitted — the warden emits a **`policy_sandbox_mismatch`** finding into the audit chain. The sandbox
  remains authoritative (fail-safe); the finding flags a manifest/policy bug for repair.

## Consequences

- **No hand-maintained policy/sandbox/egress drift**; the audit can honestly assert the three are
  reconciled, and a classifier mistake fails *safe* (the sandbox catches a mislabeled effect).
- **Freeze coordination (QC re-review F5).** What ratifies at **R1** is only this **decision + the
  invariant** (*policy ⇄ sandbox ⇄ egress are generated-or-validated from one source, and a runtime
  disagreement emits a `policy_sandbox_mismatch` finding*). The manifest **format is explicitly NOT part of
  the R1 freeze**: no manifest schema exists yet, and even the generate-vs-validate direction is undecided —
  freezing an unwritten format would be freezing a placeholder (which the re-review correctly flagged). The
  manifest schema is **authored and frozen during Phase-2A** (Epics 2.2–2.5) in its own ADR-pinned change,
  with namespaced overlays so a fork/enterprise extends it additively without editing keel core. The one
  R1 decision here is the `policy_sandbox_mismatch` **audit representation**: an open-payload
  `findings[]` marker on the existing audit event that observed the disagreement, not a new Appendix-B
  `eventType`.
- **Sequencing.** The **decision** lands **alongside** the ADR-0024 revision (anchor §8 recommendation);
  the **manifest format + generator** are built in Phase-2A (Epics 2.2–2.5). This ADR fixes the *decision*
  and the *invariant*, NOT a frozen format.
- **Honest scope.** This ADR adds **no new security claim** — it is a consistency/anti-drift mechanism
  over the existing sandbox (ADR-0005) and policy (ADR-0004) enforcement. It does not itself enforce
  anything; it keeps the enforcers in agreement and makes disagreements observable.

## Non-goals

- **Not** the user-facing `keel.policy.yaml` authoring surface (§11 item 11; deferred).
- **Not** a new enforcement primitive or security claim (§3.2 unchanged).
- **Not** the policy engine choice (ADR-0004) or the sandbox backend (ADR-0005) — it sits *above* both,
  on the `PolicyPort` / `SandboxPort` seams.
- **Not** the side-effect taxonomy itself (ADR-0024) — this is its enforcement companion.

## Implementation implications

- Define the manifest schema (over the ADR-0024 taxonomy) in `@keel/shared` **in Phase-2A** (NOT at R1),
  with namespaced fork overlays; hash-pin it (SEC-019). One fork/enterprise overlay fixture proving
  additive extension without editing keel core is the acceptance evidence.
- Build the generate-or-validate step in CI (Phase-2A) and the conformance corpus that proves
  policy ⇄ sandbox ⇄ egress agreement.
- Wire the runtime `policy_sandbox_mismatch` finding into the warden's audit append path using the R1
  representation: an open-payload `findings[]` marker on the existing event, with the sandbox remaining
  authoritative.
