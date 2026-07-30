# 0073 — UIPort presentation evolution and live approval scope

**Status:** accepted
**Date:** 2026-07-16 (amended 2026-07-17)
**Amends:** ADR-0003, ADR-0033, ADR-0036
**Amended by:** ADR-0081, which defines separately sourced requested/effective/reason/resource/
consequence/next-step approval facts and their unavailable states without changing the live Warden
authority or settlement path.

## Context

ADR-0003 froze `UIPort` before the concrete TUI existed and said every new interaction pattern
would require a new method. ADR-0036 later established the implemented seam as
`render(view) · inputs() · close()` with interaction state represented by additive `ViewModel` and
`UserInput` types. Epic 3.8 needs typed, non-persisted approval presentation and a covered stream
projection planner without inventing renderer-specific authority or changing the warden protocol.

The approval surface must also match the accepted ADR-0033 scope contract. R12c review established
that a live project shortcut was not a reliable product path: exact resources alone do not establish
that durable project authority is available, while Project Autopilot already owns explicit project
configuration. Live review must therefore expose only authority it can settle immediately and
honestly. It must also distinguish a definitive pre-submission failure from transport loss after a
decision may have reached the warden.

## Options

1. Add a new `UIPort` method for each approval/streaming interaction.
2. Treat every additive presentation field as a frozen-interface revision.
3. Keep the three-method transport seam frozen while allowing backward-compatible presentation
   types to evolve under ADR-0036, with explicit ADR review for authority-bearing interactions.

## Decision

Choose option 3.

- The frozen `UIPort` method surface remains `render(view) · inputs() · close()`. A method removal,
  signature change, new required transport method, or wire/schema change still requires explicit
  compatibility analysis and versioning.
- Additive presentation fields and internal `ViewModel` event variants may evolve under ADR-0036
  when older renderers can safely ignore them. Required fields may be added to internal source
  types in the same atomic release because keel does not publish a separately versioned renderer
  package; this does not relax the frozen RPC, audit, or session schemas.
- Branching and projection logic stays in covered `tui/` modules. Ink remains a thin map over the
  reducer/planner. The reducer-owned stream lineage token is process-local, non-enumerable, and not
  serialized or treated as provenance authority.
- Live approvals are controller-owned, process-local presentation. Transcript, replay, model text,
  and resumed session content cannot reconstruct actionable approval state.
- Live review offers once, exact-resource session scope when available, or deny. It never offers
  project scope. Durable project grants are configured through the explicit Project Autopilot flow,
  and the executor rejects a human live-review `scope:"project"` before RPC even if a caller forges
  one.
- Approval focus preempts local overlays and resets buffered composer input. A submitted decision
  remains visible until authoritative settlement is resolved, denied, failed, or explicitly shown
  as indeterminate. Transport loss, input closure, or interruption after submission must say the
  action may have executed, forbid automatic retry, and direct the user to restart and inspect audit.
  A deny is never rendered as approval confirmation.
- Project-grant authority remains warden-owned. The warden records the human/project authorization
  before installing persistent authority and replaces the grant store before executing the current
  action. A failure before atomic replacement denies without executing. If replacement succeeds but
  parent-directory `fsync` fails, the warden treats the already-visible grant as installed rather
  than claiming a denial while authority exists; crash durability is not confirmed, and a later
  restart may safely require approval again. Revocation reports failure unless directory durability
  is confirmed. Open audit payload fields may distinguish authorization recorded from grant
  applied; no frozen audit schema changes.

## Consequences

- No `WARDEN_METHODS` schema, grant scope, audit format, session format, or Autopilot/YOLO meaning
  changes. The owner approved the warden settlement-order change on 2026-07-16: a failure before
  atomic grant-store replacement denies before execution instead of returning an error after an
  action may already have run. Post-replacement durability failure follows the authority already
  installed and does not overstate a denial.
- ADR-0003's instruction to add a new method for every interaction is superseded by the
  ADR-0036 reducer/type-extension model. Its renderer isolation and headless-testability decisions
  remain accepted.
- Approval UX remains honest by construction: the warden request and executor revalidation are
  authority; `UiActiveApproval` is display state only.
- Project-grant support is not removed; only the ambiguous live-review shortcut is removed.
- ADR-0033 Decision 5 is superseded only where it says a live prompt offers `project` scope. Its `once`, exact
  resource `session`, `deny`, and `explain` UX and its durable project-grant model remain accepted.
- New authority-bearing presentation still requires an ADR or an amendment to this one. Cosmetic,
  backward-compatible fields do not require protocol version churn.
