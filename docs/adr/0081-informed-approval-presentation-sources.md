# ADR-0081 — Informed approval presentation sources

**Status:** Accepted for Epic 3.10 Slice 8 by delegated owner decision on 2026-07-23.

**Date:** 2026-07-23

**Amends:** ADR-0033 and ADR-0073

**Relates to:** ADR-0017 (agent authority), ADR-0036 (pure TUI reducer), ADR-0076 (terminal
review mode), MASTER_SPEC §4.9.3/§8.5/§8.6, `docs/design/tui-principles.md` §3.7, and Epic 3.10
Slice 8.

## Context

The live approval controller currently concatenates the model-requested tool name with the
Warden-owned review summary and labels the result `Requested action`. That collapses distinct facts:
what the model asked for, what the Warden evaluated after normalization or policy rewrites, which
exact resource can receive reusable consent, why execution paused, and what each choice will do.
The fixed `ReviewRequired` response supplies only `reviewId`, `summary`, and `allowCommand`; it does
not carry a matched-rule explanation or an independent natural-language consequence model.

Those distinctions are authority-bearing presentation. Inferring a missing target from model
arguments, parsing prose into grant scope, or reconstructing a pending approval from transcript or
resume data could turn persuasive text into authority. Conversely, silently denying an otherwise
valid Warden review merely because its optional display summary is empty would change authority
behavior inside a presentation slice. The source and unavailable state of every displayed fact must
therefore be explicit before implementation.

## Options considered

1. **Render one combined sentence.** Rejected. It obscures provenance and forces the human to infer
   scope and consequence from prose.
2. **Derive all fields from the model invocation.** Rejected. The invocation is requested intent,
   may be stale after Warden normalization, may contain secrets or unbounded data, and is not grant
   authority.
3. **Parse the Warden summary for scope, reason, and consequence.** Rejected. The summary is bounded
   human display, not a stable authority grammar.
4. **Present separately sourced facts and explicit unavailable states while retaining the Warden
   request as the only decision authority.** Chosen.

## Decision

### 1. Source contract

The live controller may create additive, process-local structured approval presentation with these
fields:

| Human question | Source | Available value | Unavailable behavior |
|---|---|---|---|
| What was requested? | model `ToolInvocation.name` only | a bounded, control-stripped tool name | `requested action unavailable`; raw model arguments never substitute |
| What will the Warden act on? | Warden `ReviewRequired.summary` | a bounded, control-stripped effective-target summary, explicitly marked abbreviated when the Warden says bytes were omitted | `effective target unavailable`; model text never substitutes |
| Why did execution pause? | Warden verdict plus fixed controller semantics | `Warden requires human authorization before execution` | matched policy rule/detail is `not reported by protocol 1.1`; never invented from prose |
| What exact resource can be remembered? | strict parsing of Warden `allowCommand` using the same resource parser as executor-side session validation | exact domain, exact command-envelope SHA-256 key, or exact console target plus console key | `exact reusable scope unavailable`; once remains this review only |
| What can each choice affect? | fixed controller semantics plus the validated exact resource | the consequence text below | no broader scope is offered |
| What happens next? | controller-owned lifecycle state | the state-specific next step below | no optimistic confirmation |

`reviewId` and raw `allowCommand` are controller inputs, not default human-facing copy. Raw tool
arguments are never copied into the approval view. Every string is control-stripped and bounded
before entering the `ViewModel`.

### 2. Scope and consequence contract

- **Approve once:** submits this retained Warden review once. It creates no remembered authority.
- **Session:** offered only when the existing strict Warden-resource parser and revalidation accept a
  complete exact domain or command-envelope key. It remembers only that exact resource until the
  current Keel process ends. Each later matching action still re-enters Warden review resolution;
  policy, provenance, and audit remain active. An abbreviated summary disables session scope even if
  an exact key is present, preserving the existing rule.
- **Console and generic reviews:** once-only. A console target/key may be shown as exact reviewed
  identity, but this slice does not create a reusable console grant.
- **Deny:** submits no approval; the action does not run if the Warden confirms denial.
- **Explain:** changes presentation only and grants nothing.
- **Project:** never offered or accepted by live review. Durable authority remains an explicit
  Project Autopilot configuration flow.

The presentation does not promise the exact real-world effect of a command. It states the
Warden-reviewed target and the authority consequence of the human's choice.

### 3. Lifecycle and recovery contract

The controller preserves the selected decision in process-local presentation so later states remain
understandable without parsing status prose. The six states have distinct next steps:

- **pending:** inspect the facts, then choose once, an available exact session scope, deny, or
  explain; Escape stops the turn without approval;
- **submitted:** wait for Warden settlement; duplicate approval/denial input is inert;
- **confirmed:** the Warden authorized the governed action and Keel may resume;
- **denied:** the action did not run; revise the request or rerun deliberately if appropriate;
- **failed:** no approval is assumed; restart the governed session before deciding again; and
- **indeterminate:** the action may have executed; do not retry automatically; restart and inspect
  the audit record before recovery.

Recovery copy never recommends bypassing policy, reconstructing a grant, or automatically retrying
an indeterminate mutation.

### 4. Authority and compatibility boundary

- The retained `WardenReviewDecisionRequest`, executor validation, and Warden settlement remain the
  only authority path. `UiActiveApproval`, planner output, Ink props, headless text, transcript,
  replay, and resume state are non-authoritative.
- Forged or stale presentation data cannot submit a decision, broaden a resource, or recreate a
  pending review. Input is accepted only while the controller owns the matching live request, and
  session availability is re-derived from that request at submission.
- The frozen `UIPort` methods, protocol 1.1 `ReviewRequired`, `WARDEN_METHODS`, grant scopes, audit,
  session JSONL, eval trajectories, policy verdicts, and settlement semantics do not change.
  Structured fields are optional additive presentation under ADR-0073; older renderers may keep the
  bounded legacy `detail` safely.
- An empty/control-only Warden summary renders an explicit unavailable effective target but does not
  itself create a new deny rule. Once approval still acts on the retained Warden review. Changing
  that behavior requires a separate authority decision and protocol-quality source for the missing
  fact.

## Consequences

- Slice 8 starts with red controller/planner/reducer/Ink/headless tests for source separation,
  unavailable facts, scope revalidation, lifecycle states, narrow/mono layouts, focus restoration,
  replay isolation, and safe recovery.
- Human consent becomes more legible without claiming stronger Warden evidence than protocol 1.1
  provides.
- Command-envelope hashes are exact but not friendly. The normal view may visually de-emphasize or
  wrap them, but it may not replace them with model prose when describing reusable scope.
- This decision changes presentation only. It adds no authority, security claim, enforcement rule,
  durable carrier, dependency, public CLI flag, or frozen protocol field.
- Any future matched-policy explanation, Warden-owned session grant, reusable console grant, or
  fail-closed rejection for missing effective-target evidence is a separate protocol/authority
  decision.
