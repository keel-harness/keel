# ADR-0033 — Autonomy modes and approval UX

- **Status:** Accepted
- **Date:** 2026-06-14
- **Deciders:** keel maintainers
- **Amended by:** ADR-0073, which supersedes the live-review `project` shortcut in Decision 5 while preserving
  durable project grants through explicit Project Autopilot configuration.
- **Amended by:** ADR-0079, which supersedes the `changed`/`undo` receipt wording in Decision 7.
  Current v1 receipts use bounded file evidence and qualified manual recovery, never an
  operation-effect or automatic-undo claim; ADR-0078's process-local presentation source stays out
  of model/session/audit/eval serialization.
- **Amended by:** ADR-0081, which binds live approval facts to explicit model/Warden/controller
  sources and unavailable states while preserving once, validated exact-resource session, deny,
  explain, and external Project Autopilot configuration.
- **Governs:** MASTER_SPEC §4.9 (normative), with cross-refs in §1.3 (developer positioning), §4.3 (tool-call flow), §4.8 (side-effect taxonomy), §2.1 (DX metrics), §8.5/§8.6 (UX gates), and Epics 1.5/1.6/2.3/2.4/2.5/2.8/3.4/3.7. Relates to ADR-0016 (single-agent durable loop — "the model requests, the warden decides"), ADR-0017 (agent authority model — extends its "may not" list), ADR-0024 (side-effect taxonomy — the structural input modes key off), ADR-0027 (Phase 2A/2B split — the audit/policy-input freeze the mode work must not churn), ADR-0012 (protocol versioning — governs any future `session` grant scope), ADR-0025 (context lifecycle — the receipt/ledger source of truth), ADR-0029 (memory vault — teach-from-corrections lands there).

## Context

keel's security thesis (§1.1, §3) is strong, but a harness that is *only* secure is not one developers reach for daily. The product gap was a **usability/autonomy story**: how does keel reduce interruptions enough to be joyful to run, without weakening the trust plane or sliding into "skip the prompts and hope the model behaves" (YOLO)?

The danger is conflation. "YOLO mode" (the §3.4/§4.2 honest escape hatch — enforcement reduced or off) is easy to mistake for "high autonomy". If a high-autonomy mode is built as *trusting the model more* rather than *letting the model act inside boundaries the warden still enforces*, it becomes security theater (ground rule 4): a "trust mode" with nothing structural behind it. The spec already had every primitive needed to do this correctly — out-of-process verdicts (§4.3), the side-effect taxonomy (§4.8/ADR-0024), workspace trust (Epic 1.7), provenance (§4.7.8), scoped grants and a `mode.change` audit event (Appendices A/B) — but no design tying them into a coherent, honest autonomy surface, and no statement of the Autopilot ≠ YOLO boundary.

Two forces made this worth specifying now rather than discovering ad hoc during the TUI/warden build:

1. **The surfaces are spread across phases** (status line and ledger in Epic 1.5/1.6; postures, scoped approvals, and the audit-backed receipt in Epic 2.x; teach-from-corrections in Epic 3.4). Without one normative section, each epic would re-derive the model and the honesty rules would drift.
2. **The freeze boundary.** Modes touch the policy-input document and audit record (frozen at the Phase-2A boundary, ADR-0027). Deciding *now* that modes ride on the **existing** `mode.change` event and `once`/`project` grant scopes — rather than inventing new schema — keeps the freeze clean.

## Decision

Adopt §4.9 as the normative design. The load-bearing commitments:

1. **A mode is a policy posture, not a model-behavior promise.** A mode resolves to a named policy posture (which verdicts auto-proceed vs. prompt) plus a set of standing scoped grants, **loaded and evaluated by the warden**. The model may *request*; it may **not** set or raise its own autonomy mode — this is a new entry on ADR-0017's "may not" list, enforced like the others. Every mode change emits a `mode.change` audit record.

2. **Four modes:** **Guided** (cautious default — risky/broad/network/external/destructive/memory/provenance-egress reviewed; secrets denied), **Autopilot** (contained low-risk actions proceed unprompted; everything risky still reviews-or-denies; audits everything), **Project Autopilot** (Autopilot + persisted project-scope grants, with a displayed authority summary, revocable), and **YOLO/Danger** (the existing honest-YOLO escape hatch — never default, banner, audited, never a security claim).

3. **Autopilot is not YOLO.** Autopilot is high autonomy *inside* enforced boundaries (warden fully on); YOLO is reduced/absent enforcement. They must be visibly distinct in copy, status line, and audit. Autopilot never changes the sandbox profile and never turns a `deny` into an `allow`.

4. **The decision model is structural.** Auto-proceed is a function of side-effect class (§4.8), warden verdict, sandbox tier, workspace trust, provenance, scoped grants, command normalization, memory auto-accept policy, and scope budget — **never** model confidence, NL intent classification, an unverified "low risk" label, or the absence of a scary command.

5. **Approval UX is rare, scoped, batched, and honest.** Prompts offer scopes (`once`/`session`/`project`/`deny`/`explain`) and state blast radius in one line; non-urgent reviews batch into a queue; denials teach the model first (§3.4). The `once`/`project` scopes are the **frozen** Appendix-A grant scopes; `session`/`deny`/`explain` are kernel-side UX over them. **Decided (resolving OQ-13b):** `session` is kernel-side over the frozen `once` primitive — the human's standing in-session consent for a *specific* resource, applied via `warden.resolveReview`/`egress.grant` and **audited on every application** (an open-payload `sessionGrant` marker; no Appendix A change), never auto-resolving a `deny`. A *warden-owned* `session` grant scope (the warden holding consent state, robust against a compromised kernel — already outside §3.3) is the reserved hardening upgrade, an additive enum gated by an ADR + protocol bump (ADR-0012); chosen kernel-side for v1 because it is freeze-clean **and** fully audited.

6. **Resolved defaults (OQ-13a).** **Guided** is the default on first run / unfamiliar repo / security-sensitive work; **Autopilot** is the recommended opt-in for a trusted repo; **Project Autopilot** the persistent opt-in. The mode persists in user/project-scope config (never project-file scope — an untrusted repo cannot raise its own autonomy, mirroring trust, Epic 1.7). Default **scope budget `medium`** (`small` ≤3 files/≤200 lines; `medium` ≤10/≤600; `large` ≤25/≤2,000), with the broad-rewrite structural signals (public-interface / frozen-schema / multi-package / dependency-add) firing **regardless of tier**. Thresholds and the trusted-repo default stay empirically tunable from the §7 gate-7 cohort.

7. **Autonomy is inspectable.** An end-of-task/session **receipt** (allowed / asked / blocked / changed / verified / not-verified / undo) is rendered from the session ledger and warden audit chain — **never model self-report** (consistent with §4.7 ledger-as-truth and the §8.6 final-answer honesty contract). The status line always reveals the current posture and **never inflates it** beyond what is enforced.

8. **Alignment ≠ security.** Scope budget, the broad-rewrite guard, and the low-confidence stop keep work matched to user intent; they are intent heuristics (riding on Epic 1.1 loop detection + the Epic 1.6 ledger + §8.6 contracts), explicitly **not** containment boundaries.

9. **Honest phasing.** Kernel-side surfaces (ledger, session-event receipt, scope budget, broad-rewrite guard, work-until-blocked, low-confidence stop, status-line honesty) are Phase 1; the enforcement postures, scoped approvals, audit-backed receipt fidelity, and status-line mode state are Phase 2A; teach-from-corrections is Phase 3; task presets and the richer permission forecast are later/optional. Phase-1 builds must never present a "trust mode" there is nothing to enforce.

The section adds **no new security claim and no new enforcement primitive** (§3.2 unchanged) — it is a usability layer over the existing trust plane.

## Alternatives considered

1. **A single "auto-approve / YOLO" toggle (the common harness shape).** Rejected — it is exactly the conflation this ADR forbids: it reduces prompts by *trusting the model*, not by enforcement, so the prompt economy is bought with security theater. Autopilot reduces prompts because the warden can *prove* an action is contained.
2. **Mode as a kernel-side flag the model can read/set.** Rejected — violates ADR-0016/0017 (the model would be granting itself authority). The mode is warden-owned policy state; setting it is a human authority recorded in audit.
3. **A new audit event type + a new grant-scope enum for modes.** Rejected — `mode.change` and `once`/`project` already exist and freeze cleanly at 2A (ADR-0027). Inventing schema for modes is needless churn; the `session`-scope question is resolved kernel-side over the frozen `once` primitive (OQ-13b), with a warden-owned `session` enum reserved as an explicit, ADR-gated hardening upgrade.
4. **A model "confidence" or NL "risk" signal driving auto-proceed.** Rejected — unverifiable and spoofable by injection; §1.4 already excludes a separate intent/risk classifier in favor of the per-action warden gate. Decisions must be structural (§4.9.2).
5. **A separate doc (`docs/design/autonomy-modes.md`) as the home of the design.** Rejected for the *normative* content — the Master Spec is the single source of truth and §4.9 must be binding, not advisory. A design doc may later hold extended rationale, but the contract lives in the spec.
6. **Defer the whole design to the TUI/warden epics.** Rejected — the cross-phase spread and the 2A freeze boundary (above) make a single up-front normative section cheaper than re-deriving it per epic and reconciling the honesty rules afterward.

## Consequences

- **Positive:** one coherent, honest autonomy surface; the prompt-economy story is structural, not trust-based; modes reuse existing audit/grant machinery so the 2A freeze stays clean; the Autopilot ≠ YOLO boundary is written down before it can be blurred in marketing or code.
- **Authority-model alignment.** ADR-0017's "may not" list now includes "set or raise the autonomy mode";
  the Phase-2A warden gains the corresponding enforced check when mode changes become product-active (a
  model-emitted mode change is refused, like a model-emitted egress grant).
- **Honesty constraint (ground rule 4).** In Phase 1 (no warden) the only honest enforcement state is none; the status line and receipt must say so. A mode UI must not appear as a trust posture before the warden exists.
- **Freeze coordination.** The mode design must not add fields to the Appendix B audit record or Appendix D §D.1 policy input beyond what already exists; the `session`-scope decision (OQ-13) must land before the 2A freeze if it is wanted in v1, else it stays a post-freeze additive change.
- **Scope discipline.** Scope budget / broad-rewrite guard / low-confidence stop are documented as *alignment*, never security — a reviewer must reject any code or copy that describes them as containment.
- **Cost:** added Phase-1 DX surface (status-line honesty, ledger receipt, the three alignment heuristics) and added Phase-2A posture/approval surface. Justified by the §2.1 human-usability gate (gate 7) and the prompt-economy targets; partially shares machinery with existing loop-detection, ledger, and policy work.

## Non-goals

- **Not** a new enforcement primitive or a change to §3.2's guarantees — purely a usability posture over the existing warden.
- **Not** a relaxation of the sandbox or policy in any mode except the pre-existing YOLO; Autopilot never turns a `deny` into an `allow`.
- **Not** a change to a frozen interface — modes reuse `mode.change` (Appendix B) and `once`/`project` scopes (Appendix A); the v1 `session` scope is kernel-side over `once` (no Appendix A change), and a *warden-owned* `session` scope is an explicitly ADR-gated, protocol-versioned hardening upgrade (ADR-0012), not part of this decision.
- **Not** a model-confidence or NL-intent classifier (§1.4) — auto-proceed is structural only.
- **Not** the memory workflow itself (Epic 3.4 / ADR-0029) — teach-from-corrections reuses that path; it does not introduce a new write surface.
- **Not** a task-preset system for the alpha — presets are future-facing (§4.9.7) and deliberately under-specified.

## Implementation implications

- **Epic 1.5 (TUI):** autonomy status line (honest-no-enforcement in P1), quiet vs. verbose, the live task ledger, and the session-event receipt skeleton; golden-tested for posture honesty and receipt accuracy (§8.6).
- **Epic 1.6 (context):** scope budget, broad-rewrite guard, work-until-blocked, and low-confidence stop atop the in-session ledger + Epic 1.1 loop detection + §8.6 read-before-edit/final-answer contracts — intent heuristics, not enforcement.
- **Epics 2.3/2.4/2.5 (egress UX / policy gate / pack):** modes as named policy postures (+ standing grants) loaded by the warden; scoped approvals with blast-radius one-liners; the review queue; `/why-blocked` over `keel policy why`.
- **Epic 2.8 (status line + integration):** status-line mode state + memory-write posture; audit-backed receipt fidelity (allowed/asked/blocked/mode-change).
- **Epic 3.4 (memory diffs):** teach-from-corrections staged through the diff/review path (stated-fact bypass; inferred-rule second-occurrence gate; compaction never writes).
- **Epic 3.7 (polish):** optional task presets + receipt/quiet-mode beauty pass (future-facing).
- **ADR-0017:** the "may not set/raise autonomy mode" bullet is present; wire the enforced check when mode
  changes become product-active.
- **OQ-13 (resolved 2026-06-14):** **Guided** default; **Autopilot** the trusted-repo opt-in; **Project Autopilot** persistent opt-in; default scope budget **`medium`** (`small` ≤3/≤200 · `medium` ≤10/≤600 · `large` ≤25/≤2,000; structural guard fires regardless of tier, §4.9.6). `session` scope **kernel-side** over the frozen `once` primitive, **audited on every application** (open-payload marker; no Appendix A change); a warden-owned `session` enum is the reserved hardening upgrade. Thresholds and the trusted-repo default stay tunable from the §7 gate-7 cohort.
