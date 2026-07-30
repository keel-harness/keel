# ADR-0027 — Phase 2A / 2B split and the audit-format freeze boundary

- **Status:** Accepted
- **Date:** 2026-06-14
- **Sequencing update:** 2026-06-27 — MASTER_SPEC v1.18 keeps the 2A/2B architectural split and the
  2A audit-format freeze, but the current build chooses the stricter order: P2A, P2B, Epic 2.19
  closeout/readiness, private developer-preview feedback, then Phase 3. The original "2B may parallelize
  with Phase 3" allowance is not used unless the owner explicitly revises the sequence.
- **Deciders:** keel maintainers
- **Governs:** MASTER_SPEC §7 Phase 2 (2A/2B framing, Epics 2.1–2.9, Exit gates P2A/P2B, the developer-preview gate), §1.2 claim 2, §2.1, §3.3, Appendix B (audit record), Appendix D §D.1 (policy input). Relates to ADR-0024 (side-effect taxonomy — its pre-freeze gate is *this* freeze), ADR-0006 (crypto / audit canonicalization), ADR-0012 (protocol versioning), ADR-0010 (provenance, Phase 3), OQ-5 (signing-key custody), OQ-8 (OAP conformance).

## Context

Before MASTER_SPEC v1.4, Phase 2 (the trust plane, weeks 4–8) bundled the minimum viable warden together with evidence hardening — Ed25519 signing, Merkle checkpoints, the standalone offline verifier, redacted-bundle verification, and polished enterprise reports — under a single exit gate. The Phase-1-readiness review found two problems with that bundling:

1. **The first human feel-check is deferred too late.** The private developer preview sat after the *entire* trust plane, so we would not learn whether developers like the harness until weeks of hardening work were already sunk.
2. **The hardening is not load-bearing for the early claims.** The threat model's own §3.3 concedes that same-user malware can steal the at-rest signing key — so Ed25519 signing buys little marginal *threat* coverage. Its real value is **third-party, offline verifiability of exported bundles** (an enterprise-portability property). The defensible core of claim 2 ("the agent cannot write the record it is judged by") rests on the **hash chain + sandbox `denyWrite`**, which are cheap and structural. Likewise, the flagship injection demo (claim 1) needs only sandbox deny-read + egress allowlist + an audited denial — none of signing, Merkle, or provenance.

Bundling therefore delays both the demoable/credible warden and the developer-feel checkpoint behind work that is additive, not foundational.

## Decision

Split Phase 2 into **2A (minimum trust plane)** and **2B (evidence hardening)**, and **freeze the audit record format (Appendix B) and policy-input document (Appendix D §D.1) at the 2A boundary**.

- **Phase 2A** — warden process + RPC (Epic 2.1); tool execution through the warden; allow/deny/review/modify/warn verdicts (2.4); basic sandbox — Seatbelt/bwrap, deny-read/allow-write (2.2); egress allowlist + ecosystem presets (2.2/2.3); starter policy pack (2.5); **hash-chained** audit — warden-only writer, principal, redaction, denied-fidelity, side-effect class (the [2A] part of 2.6); simple/inspectable evidence export (the [2A] part of 2.7); warden↔kernel integration + status line (2.8); the live injection/exfiltration demo (the demo part of 2.9). *Goal: prove the security architecture.*
- **Phase 2B** — Ed25519 signing, Merkle checkpoints, the standalone offline verifier, redacted-bundle verification, polished enterprise evidence reports (the [2B] parts of 2.6/2.7). *Goal: harden the portable evidence story.* 2B is additive. This ADR originally allowed 2B to run in parallel with Phase 3; MASTER_SPEC v1.18 deliberately does not use that allowance for the current build.
- **Freeze boundary.** The Appendix B audit record — including the *as-yet-unpopulated* signature / Merkle-checkpoint fields and the §4.8 `sideEffect` field — and the Appendix D §D.1 policy input freeze at the end of 2A, so 2B introduces **no format change**. This is the gate ADR-0024's pre-freeze ratification depends on.
- **Gates and sequencing.** Separate exit gates **P2A** and **P2B**. The union of P2A + P2B equals the former single P2 gate — nothing is dropped, only sequenced. Current sequencing is stricter than the original allowance: Phase 3 implementation waits for P2A + P2B + Epic 2.19 closeout/readiness + cleared private developer-preview feedback + Epic 3.0's design gate, unless the owner explicitly revises the order.

## Alternatives considered

1. **Keep Phase 2 monolithic.** Rejected — defers the developer-feel checkpoint and the demoable warden behind non-load-bearing hardening; this is the review's central sequencing finding.
2. **Ship signing in 2A** (because "the record survives the agent" sounds like it needs signatures). Rejected — §3.3 concedes same-user key theft, so signing does not defend the threat it appears to; the hash chain + `denyWrite` carries the defensible claim, and signing is for *portable, third-party-verifiable* bundles → 2B.
3. **Defer hash-chaining too (audit-light 2A).** Rejected — the hash chain is what makes the record tamper-*evident* against the agent's tool surface and is required for both the claim and the demo's "audit shows the denied attempts." It is cheap and structural, so it belongs in 2A.
4. **Freeze the audit format only at the end of 2B.** Rejected — that leaves 2A's records in a non-frozen format and forces the §4.8 `sideEffect` field and the signature/checkpoint fields to be retrofitted. Freezing the *format* once at 2A, with additive-but-unpopulated 2B fields, is the entire point.
5. **Make 2B a post-alpha Phase-4 hardening item.** Rejected — 2B is part of the launch evidence story (claim 2 portability; EU AI Act Article 12 / NIST AU artifacts) and should land before/around public alpha, not in the open-ended post-alpha backlog. Keeping it as 2B preserves that.

## Consequences

- **Positive:** a credible, demoable, audited warden can ship before the portable-evidence hardening; the audit format is frozen once, early, and additively. Under the current v1.18 sequencing, the developer preview de-risks the memory build after the full Phase-2 closeout rather than after P2A alone.
- **Format must be designed forward at 2A.** The Appendix B record must already carry the 2B fields as optional/additive (signature; `merkleRoot`/`range`; the checkpoint discriminated union). The spec already designs the checkpoint record as an additive discriminated union; the `AuditCheckpointRecord` field-duplication follow-up therefore has a concrete trigger: **resolve it before the 2A freeze.**
- **Honesty constraint (charter ground rule 4).** Between 2A and 2B the audit is hash-chained but *unsigned*. The status line and docs must say so — *tamper-evident against the agent, not yet offline-verifiable by a third party.* No "signed / offline-verifiable evidence" claim until 2B.
- **Claim mapping (ties to the §1.2 v1.4 wording).** Claim 1 (exfiltration resistance) is demoable at 2A; claim 2 (the agent cannot write the record) is *defensible* at 2A (hash chain + `denyWrite`) and *portable* at 2B (signed, offline-verifiable). The §1.2 headline already encodes "Hash-chained (Phase 2A), Ed25519-signed + Merkle-checkpointed (Phase 2B)."
- **Dependencies converge on the 2A freeze.** ADR-0024 (side-effect taxonomy) ratification, ADR-0006 (audit canonicalization), and OQ-8 (OAP mapping) must all be settled before the 2A freeze; OQ-5 (signing-key custody) must be settled before 2B.
- **Cost:** two gates instead of one, and the developer preview becomes a real go/no-go checkpoint with weight — modest added process for a large sequencing-risk reduction.

## Non-goals

- **Not** a change to the security *architecture*. There is still exactly one always-on security architecture (charter rule §1.3); 2A/2B is a **build-order split**, not a feature flag or a "lite mode." 2A is not a permanently-shippable reduced-enforcement tier.
- **Not** a deferral of provenance. Provenance/taint is Phase 3 (ADR-0010), independent of the 2A/2B line; the 2A injection demo relies on sandbox + egress, not provenance.
- **Not** a change to the frozen warden RPC (Appendix A, ADR-0012) — this concerns the *audit record* and *policy input* freeze timing only.
- **Not** a weakening of the exit criteria — P2A ∪ P2B equals the former P2 gate.
- **Not** making 2B optional for public alpha — 2B is not cut. Under the current v1.18 sequencing, 2B completes before Phase 3 starts unless the owner explicitly revises the order.

## Implementation implications

- **Phase-2 design doc** (when written) is structured 2A → 2B → final closeout/readiness → preview
  under MASTER_SPEC v1.18. The earlier 2A → preview → 2B allowance is retained only as historical
  rationale and requires explicit owner revision to re-enable.
- **Audit record schema (`@keel/shared`, Appendix B):** design with the 2B fields present-but-optional (signature; Merkle checkpoint discriminated union; `sideEffect`) and freeze at the 2A boundary; resolve the `AuditCheckpointRecord` field-duplication follow-up (shared base via `.merge()`) before that freeze.
- **Epic 2.6 splits:** [2A] hash chain + principal + redaction + denied-fidelity + `sideEffect`; [2B] Merkle + Ed25519 + `keel audit verify` (offline, standalone).
- **Epic 2.7 splits:** [2A] simple export (audit slice + policy-pack snapshot + config snapshot + a replay that renders); [2B] checkpoints + chain proofs + vendored verifier + redacted-bundle support.
- **Status line / docs honesty:** between 2A and 2B render the audit state as hash-chained-unsigned vs signed; never imply signed/offline-verifiable before 2B.
- **CI gating:** the `security` job is scoped to 2A at the P2A gate; the signed / offline / redacted tests gate P2B.
- **Freeze-dependency coordination:** ratify ADR-0024 and settle ADR-0006 + OQ-8 before the 2A freeze; settle OQ-5 (signing-key custody) before 2B.
