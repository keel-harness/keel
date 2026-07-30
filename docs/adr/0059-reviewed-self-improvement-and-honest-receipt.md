# ADR-0059 — Reviewed durable learning and evidence-derived receipts

- **Status:** Accepted (2026-06-24). Amended by ADR-0079.
- **Date:** 2026-06-24.
- **Deciders:** keel maintainer.
- **Governs:** durable memory/skill proposals and end-of-run receipt presentation.
- **Relates to:** ADR-0017 (agent authority), ADR-0026 (inert declarative extensions),
  ADR-0029 (memory lifecycle), ADR-0033 (approval grants), ADR-0039 (redaction), and
  MASTER_SPEC §4.7, §4.9, and §7.

## Context

Durable learning and operational receipts are useful only when their authority and evidence are
clear. An agent may identify a reusable lesson, but it must not silently change durable memory,
skills, policy, or trust state. Likewise, a receipt must be a projection of controller-owned
records rather than a narrative supplied by the model.

The existing memory lifecycle, audit chain, session ledger, and approval model provide the right
primitives. This ADR binds them into two public product rules without adding a new authority path or
security claim.

## Decision

1. **Durable learning is proposed and reviewed.** Keel may propose a memory or inert-markdown skill
   as a small diff with provenance, evidence, scope, and a reason to retain it. The proposal becomes
   durable only after human acceptance or an explicit scoped grant governed by policy.
2. **No silent self-modification.** The model cannot write audit records, change policy, grant
   egress, declassify provenance, mark content trusted, or execute a proposed skill as code.
   Auto-accept remains off by default and may never apply to security-policy, trust, or provenance
   changes.
3. **Receipts are evidence-derived.** End-of-run receipts and replay views render controller-owned
   session, file-evidence, Warden-verdict, and audit facts. Model self-report is never accepted as
   proof. Missing or unverified facts remain explicit.
4. **Presentation cannot strengthen the evidence.** Terms such as `contained`, `verified`, or
   `tamper-evident` appear only when the corresponding sandbox, validation, or chain verification
   actually ran. All output passes the existing redaction boundary.
5. **Sequencing follows existing gates.** The functional receipt belongs with audit/evidence work;
   visual polish follows as a separate UI slice. Durable-memory and skill proposals belong with the
   memory lifecycle. This ADR does not pull later work into an earlier phase.
6. **No frozen-format change.** These are projections and workflow constraints over existing
   records and authority boundaries. Any durable schema or protocol change requires its own ADR and
   compatibility review.

## Consequences

- Users can inspect why a durable lesson was proposed and retain ownership of the resulting state.
- Receipts remain useful for review without implying evidence the runtime did not produce.
- Implementations must preserve provenance through proposal review and test denied paths for silent
  writes, forged evidence, trust elevation, and unredacted output.
- ADR-0079 further limits file-operation recovery language: current receipts provide bounded file
  evidence and qualified manual guidance, not automatic undo.

## Non-goals

- Autonomous self-modifying memory, policy, or executable extensions.
- Treating a model completion statement as validation evidence.
- Adding a new audit writer, approval path, or grant scope.
- Claiming that planned memory features are already implemented.
