# Design archive

**These are dated snapshots, not current documentation.**

Each document here records how a decision was explored at a point in time. Accepted decisions live
in the ADRs they cite, and current behavior is described in the [guides](../guide/) and implemented
in code. Where an archive document and an accepted ADR disagree, the ADR wins. Code shows what is
implemented today; a conflict with an accepted ADR is a defect to reconcile, not an authority
reversal. Proposals that have not cleared their stated review gates remain pre-implementation.

They are kept because keel's charter treats the *why* as something that must survive a fork. They
are not kept as a reading path for newcomers. If you are trying to understand or use keel, start
with the [architecture one-pager](../architecture.md).

| Document | Produced |
| --- | --- |
| [2026-06-21-side-effect-taxonomy-problem.md](2026-06-21-side-effect-taxonomy-problem.md) | ADR-0024, ADR-0056 |
| [2026-06-22-side-effect-taxonomy-decisions.md](2026-06-22-side-effect-taxonomy-decisions.md) | ADR-0024, ADR-0056 |
| [2026-06-22-2a-audit-policy-freeze-reconciliation.md](2026-06-22-2a-audit-policy-freeze-reconciliation.md) | the Phase-2A audit/policy freeze |
| [2026-06-24-goal-and-loop-run-control-spike.md](2026-06-24-goal-and-loop-run-control-spike.md) | ADR-0060 |
| [2026-06-24-lifecycle-validation-posture-spike.md](2026-06-24-lifecycle-validation-posture-spike.md) | ADR-0058 |
| [2026-06-24-delegated-contexts-design.md](2026-06-24-delegated-contexts-design.md) | pre-implementation proposal; no accepted ADR |
| [2026-07-01-governed-mcp-integration-design.md](2026-07-01-governed-mcp-integration-design.md) | ADR-0067 |
| [2026-08-01-egress-address-guard-prior-art.md](2026-08-01-egress-address-guard-prior-art.md) | ADR-0086 |
| [borrowed-techniques.md](borrowed-techniques.md) | ADR-0025 and the Epic 1.x loop work |
| [tui-principles.md](tui-principles.md) | ADR-0036, ADR-0055, ADR-0079, ADR-0080, ADR-0081 |

`tui-principles.md` is the one document here that is still actively cited as the rationale behind
current TUI copy and layout decisions. The normative requirements it points at live in
`MASTER_SPEC.md`, not in the document itself.
