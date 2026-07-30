# ADR-0013 — OAP conformance: stay an OAP-mappable superset, do not conform (OQ-8)

- **Status:** Accepted at the Phase-2A R1 audit/policy format freeze (ADR-0027) **with** ADR-0024 +
  ADR-0056. Resolves **OQ-8**.
- **Date:** 2026-06-22.
- **Deciders:** keel maintainers (+ third-party judge at ratification).
- **Governs:** MASTER_SPEC §1.2.1 (OAP cited as a standard to prefer), §10 ADR-0013 seed, OQ-8,
  Appendix B (audit record), Appendix D (policy input). Relates to ADR-0006 (crypto / canonicalization —
  the borrowed primitives), ADR-0024 (taxonomy — the `target[]` axis is what makes OAP mapping clean),
  ADR-0027 (freeze boundary), ADR-0012 (protocol versioning).
- **Research:** adversarial due-diligence on OAP, 2026-06-21 (sources at the end). Default posture:
  skeptic.

## Context

OQ-8 asks: should keel's audit/policy interface **conform** to the **Open Agent Passport (OAP)**
pre-action-authorization spec (interoperability + faster procurement credibility, at the cost of an
external dependency on an evolving spec), or ship a **bespoke** format? The §10 seed framed it as "if
conforming, Appendix B becomes an OAP profile." This must be decided **before Appendix B freezes**.

MASTER_SPEC §1.2.1 cites OAP favorably (synchronous pre-action authorization → signed audit record;
"~53 ms median; 0% attack success under restrictive policy vs 74.6% permissive in a bountied testbed")
as an opportunity, not just a threat. The decision requires a direct read of OAP's *maturity, license,
and record shape*, not the marketing summary.

## What the research found (default-skeptic; citations below)

- **OAP is real but immature and single-vendor.** Authoritative spec: `aporthq/aport-spec`, "OAP Spec
  v1.0 (draft)," authored by **APort Technologies Inc.** (founder Uchi Uchibeke). Anchored to a
  **non-peer-reviewed arXiv preprint** (2026-03-21). Spec repo: **3 stars, 1 contributor, 0 git tags**;
  reference impl ~22 stars, 1 contributor. **No independent adopters found**; package downloads are
  trial-level (~880/mo). Governance is **single-vendor** (no foundation, steering committee, or CLA).
- **License (permissive — passes keel's gate):** spec **MIT**; reference impl **Apache-2.0** on its OSS
  parts (open-core; the control plane is a hosted commercial service). The cross-source license metadata
  is self-contradictory (MIT vs Apache vs CC-BY across its own docs) — itself a maturity red flag. The
  **disqualifier is governance, not license.**
- **What OAP actually specifies (verified against the raw JSON Schemas):** a "Decision" record whose raw
  schema is internally inconsistent: `required` includes `decision_id`, `passport_id`, `policy_id`,
  `owner_id`, `assurance_level`, `allow`, `reasons`, `issued_at`, `expires_at`, `passport_digest`,
  `signature`, and `kid`, while the `properties` block also carries `agent_id`, `created_at`,
  `expires_in`, and `decision_token`. Signing: **Ed25519** over **JCS / RFC 8785** canonicalized payload;
  `passport_digest` = SHA-256 over JCS. Policy language: a **custom declarative JSON/YAML** language —
  **NOT Rego**. Capabilities are discrete registry IDs + per-capability limits + 6 assurance tiers —
  **no side-effect taxonomy** (no read/write/destructive/reversibility classification).
- **The load-bearing gap:** the OAP Decision schema has **no `prev_hash` / `seq` / Merkle field**. Its
  "hash-chained audit trail" is asserted **in prose, not present in the record**. It is a single,
  expiring, point-in-time *authorization decision* — **not** a tamper-evident sequential audit log.
- **The "53 ms / 0% / 74.6%" numbers** are **self-reported vendor results** (the author authored the
  spec, built the product, and ran the testbed); p50=53 ms is server-side-only at Cloudflare edge
  (self-hosted ref impl ~174 ms); the "bounty" was a public CTF game, not a software bug-bounty;
  non-peer-reviewed, single domain, single undisclosed model, "not a randomized controlled trial" by the
  paper's own admission.

## Options

1. **Conform** — adopt OAP's Decision record as keel's audit/policy format; Appendix B becomes an OAP
   profile. Rejected — OAP's record has **no hash-chain/seq/Merkle and no side-effect taxonomy**;
   conforming would mean **dropping keel's strongest structurally-enforced guarantees** (tamper-evident
   chain, side-effect classification, policy-pack hashing) to fit a weaker, single-vendor, untagged
   draft. Violates "structural, not behavioral" and "downgrade the claim, not the honesty."
2. **Partially conform** — bend Appendix B toward OAP field names where cheap. Rejected for v1 — buys
   little (no adopters today) and couples a frozen format to a moving single-vendor target.
3. **Stay bespoke but OAP-mappable; borrow the good primitives.** Chosen.

## Decision

**Do not conform. Keep keel's audit record as the source-of-truth superset; make it OAP-mappable; borrow
OAP's well-chosen primitives.** Concretely:

- **Borrow** (these are standard and already on keel's path, so credit OAP for validation, not
  dependency): **JCS / RFC 8785 canonicalization** and **Ed25519** signing — both already the ADR-0006
  direction. Adopt JCS explicitly for the audit canonicalizer.
- **Stay a superset.** keel keeps hash-chaining (Phase-2A), Merkle checkpoints + Ed25519 (Phase-2B),
  the side-effect taxonomy (ADR-0024), and policy-pack hashing — none of which OAP's record carries.
- **Design for one-way OAP export.** The ADR-0024 **`target[]` axis** is shaped so a keel record maps
  cleanly to OAP's subject/action/resource/effect (subject=`principal`, action=`effectKind`,
  resource=`target`, effect=`verdict`). A future **one-way OAP "Decision" export profile** (behind the
  UIPort/audit-export seam) is then cheap **if/when a real adopter needs interop** — without keel ever
  depending on OAP as its source of truth.
- **OQ-8 resolution:** **Appendix B stays bespoke (OAP-mappable), NOT an "OAP profile."** This unblocks
  the Appendix-B freeze: no OAP enum constrains keel's frozen enums; the only forward-compat obligation
  (target⇒resource mappability) is already satisfied by ADR-0024.
- **Re-evaluate trigger:** revisit only if OAP moves to **neutral multi-vendor governance** (a
  foundation), **freezes a tagged, semver'd spec**, and gains **independent adopters**.

## Consequences

- **Unblocks the 2A freeze** coherently with ADR-0024: the `target[]` axis earns its complexity (it is
  the OAP-mappability seam) even though we are not conforming. Appendix B is frozen as keel's own format.
- **No external-dependency / moving-target risk** on a single-vendor 0-tag draft; no credibility trap of
  claiming conformance to an unproven standard.
- **Interop is preserved as an option, not a coupling** — a one-way export profile can be added later
  with no format change to the source-of-truth record.
- **Honesty:** keel does not claim "OAP-conformant." It may, post-export-profile, claim "OAP-mappable /
  exportable to OAP" — and only once that export + a round-trip test exist (no claim before the test).
- **ADR-0006 follow-through:** adopt JCS/RFC 8785 as the audit canonicalizer (the choice ADR-0006 left
  open), and Ed25519 (already chosen) — these are the borrowed primitives.

## Non-goals

- **Not** building the OAP export profile now (it is a reserved seam; build when an adopter needs it).
- **Not** adopting OAP's policy language (keel uses Rego — ADR-0004) or its assurance-tier model.
- **Not** a permanent rejection — it is a *not yet*, with explicit re-evaluation triggers.

## Sources

- Spec: https://github.com/aporthq/aport-spec · decision schema:
  https://raw.githubusercontent.com/aporthq/aport-spec/main/oap/decision-schema.json · capability
  registry: https://raw.githubusercontent.com/aporthq/aport-spec/main/oap/capability-registry.md
- Reference impl: https://github.com/aporthq/aport-agent-guardrails · vendor: https://aport.io/
- Preprint: https://arxiv.org/abs/2603.20953
- Maturity signals (GitHub API): https://api.github.com/repos/aporthq/aport-spec (3★, 0 tags, 1
  contributor) · https://api.github.com/repos/aporthq/aport-spec/tags
- RFC 8785 (JCS), the borrowed canonicalization standard.
