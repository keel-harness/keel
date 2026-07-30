# Side-effect taxonomy — decision anchor (pre-Phase-2A)

**Status:** decision anchor — feeds (a) a **re-open of ADR-0024** and (b) a **new capability-manifest ADR**,
both ratified (human + third-party judge) **before** the Phase-2A audit/policy freeze (ADR-0027).
**Date:** 2026-06-21. **Inputs folded in:** the problem definition, GPT 5.5's design review, and the
adversarial synthesis. This doc is the *contract for the decision*, not a transcript of the debate.

## Guiding principle (the spine — do not deviate)

> **Freeze structure conservatively. Freeze primitives minimally. Derive composites in policy. Use
> classifier confidence for uncertainty. Use sandbox/egress as the hard backstop.**

The winning move is to **freeze the axes and the schema shape now**, then be **ruthless about which
primitive enum values get frozen**. Anything that can be *derived* (a composite risk signal) or *enforced*
(a guardrail) does **not** belong in the frozen primitive enums. This is a security/flexibility balance, not
a taxonomy beauty contest — **do not bikeshed the label set; settle the small checklist in §8 and ship.**

---

## 1. ADR-0024 must be RE-OPENED before the 2A freeze

ADR-0024 ("Accepted") is **directionally right but under-specified** — its `domains[] + modifiers[]` model
overloads *what* an action is with *where* it happens and *how* risky it is. This is **no longer a simple
implementation** of the accepted taxonomy; it is a re-design, and it touches dependent artifacts that must be
reconciled in the same change:

- **ADR-0028 / §4.3 (tiered retry)** — the retry carve-out keys off the taxonomy; the eligibility predicate
  changes under the multi-axis model (§ retry note below).
- **ADR-0006 (audit canonicalization)** — the `sideEffect` field is canonicalized into the hash-chained record.
- **§4.8 (normative side-effect text)** + **Appendix B (audit record)** + **Appendix D §D.1 (policy input)** —
  the two formats that freeze at 2A; both gain `sideEffect`.
- **OQ-8 / ADR-0013 (OAP mapping — Item 3)** — must be answered *with* this, not after (the OAP subject/
  action/resource/effect shape needs the `target[]` axis).
- **`packages/kernel/src/tools/registry.ts` `StaticCapability`** — the kernel-local precursor (which drifted by
  adding a `broad` sentinel) converges into the frozen schema here.

**Action:** the pre-warden session re-opens ADR-0024 with this anchor, reconciles the above, and re-ratifies.

## 2. Adopt the structural correction (freeze the AXES + the SHAPE)

Move from `domains[] + modifiers[]` to a **multi-axis** model. **These axes + this object shape are the
conservative freeze** (the part we commit to now); the enum *contents* are minimized in §3 and decided in §8.

- **effect kind** — *what* action occurs.
- **scope** — *where* it occurs.
- **target[]** — the *concrete resource(s)* involved (structured, not enumerated hosts/paths).
- **modifier[]** — *primitive* risk qualifiers (orthogonal to kind).
- **classifier confidence / disposition** — *how certain* the warden's classifier is.
- **taxonomy / schema version** — the contract this audit/policy-input obeys.

**`bash` "broad/unbounded" is static-capability ENVELOPE metadata, NOT an effect kind.** Represent it as
`staticCapability.broad = true` + an `effectEnvelope` listing the possible kinds — never a `broad` domain
value polluting the policy ontology.

**Agreed object shape (freeze the shape; values per §3/§8):**
```ts
SideEffect {
  taxonomyVersion: "side-effect-taxonomy/v1"
  staticCapability: { toolName, effectEnvelope: EffectKind[], broad: boolean }
  dynamic: {
    effectKinds: EffectKind[]          // ≥1
    scopes:      EffectScope[]         // ≥1
    targets:     SideEffectTarget[]    // structured; default []
    modifiers:   RiskModifier[]        // primitive only; default []
    classifier:  { name, version, confidence, reasons[] }
  }
  extensions?: Record<string, unknown> // additive; audit-only unless a pack opts in (§3)
}
SideEffectTarget {
  kind: "path"|"host"|"url"|"command"|"process"|"package"|"service"|"env_var"|"unknown"
  value: string; normalized?: string
  withinWorkspace?: boolean            // classifier CLAIM (§5), not ground truth
  sensitivity?: "public"|"internal"|"secret"|"unknown"  // classifier CLAIM (§5)
}
```

## 3. YAGNI pass on frozen enum values (be ruthless)

Every frozen enum value is a **permanent protocol commitment.** Apply the principle:

- **Prefer minimal primitive labels.** Start from the smallest orthogonal set that real policies need (§7
  examples are the demand signal), not every label imaginable.
- **Composites are policy-derived findings, NOT frozen primitives.** `exfiltration_risk`
  (= credential-read ∧ network_write) and `supply_chain` (= a pattern over process_exec + network + fs_write)
  must be **computed by the policy pack** from primitives — not frozen into the modifier enum. Same scrutiny
  for `credential_access`/`credential_adjacent` (likely *derivable* from `fs_read|fs_write` + a `secret`
  target/scope) and `external_state_write` (vs `network_write` + `external_service` scope) and `resource_use`
  (vs an `expensive` modifier) — **each is a §8 "primitive vs derived" decision.**
- **Versioning + extensions are the growth strategy — `unknown` is not.** `taxonomyVersion` is mandatory;
  additive growth goes through `extensions` (audit-only unless a pack explicitly supports the namespace) and a
  v1.x (additive) / v2 (semantic change) discipline. **Do not rely on the runtime `unknown` bucket as the
  migration plan** — `unknown` is a fail-closed safety value, not a protocol escape hatch. A *malformed* core
  enum value rejects; the *known* value `"unknown"` fails closed.

## 4. Disposition matrix = POLICY-PACK CONFIGURABLE (do not hardcode one global UX)

The classifier's `confidence` drives a disposition. The **secure default may deny** obfuscated / unknown
broad-tool effects and **force a rewrite to classifiable form** (better than asking a human to approve
gibberish — that just trains rubber-stamping). **But the thresholds are a policy-pack knob, not a frozen
constant**, because keel is a *coding* agent: heredocs, pipes-with-substitution, build scripts, package
managers, and shell wrappers are *legitimate* and often hard to parse — deny-by-default them and you cripple
usefulness (the over-classification trap).

- **Measure before hardcoding friction:** use the existing **73-trial command corpus trajectories**
  (committed fixtures and tests) as a real sample of the command distribution;
  calibrate the default disposition against what keel actually runs.
- The **frozen schema carries the `confidence`/`disposition` fields**; it does **not** hardcode the
  allow/review/deny mapping — that lives in the (swappable) policy pack, so an "Autopilot dev" posture and a
  locked-down posture can differ without a protocol change.

## 5. The classifier is the security-critical component (schema is necessary, not sufficient)

A richer schema only helps if the warden can **populate it soundly**. The classifier (shell-normalize +
path/symlink resolve + obfuscation-peel) is adversarially hard (§7), and lives in the **warden, never the
kernel/model** (ADR-0017: the model can only *request*; it cannot self-classify to dodge policy).

- **`targets[].sensitivity` / `withinWorkspace` are classifier CLAIMS with confidence, not absolute truth.**
- **The sandbox + egress allowlist are the AUTHORITATIVE backstop.** *Policy reasons over the classifier's
  labels; the sandbox enforces independently* — so a classifier mistake fails **safe** (the OS-level path/
  egress deny catches a mislabeled effect). Defense-in-depth, made explicit.
- **Match schema ambition to the classifier's realistic ceiling** — a field the classifier can rarely resolve
  just defaults to `ambiguous`/`unknown` → more denies; size the axes to what the classifier can actually fill.

## 6. The capability manifest gets its OWN companion ADR

The structural answer to policy/enforcement drift: a **single capability manifest** is the source of truth
that **generates or validates** all of: **policy rules · sandbox profile · egress allowlist · conformance
tests.** No hand-maintained policy/sandbox divergence. *Policy decides · sandbox is the physical guardrail ·
audit is the evidence · conformance tests prove the three agree* (incl. runtime reconciliation: a
policy-allow that the sandbox blocks emits a `policy_sandbox_mismatch` finding). This is a *new architectural
decision* — it warrants its **own ADR** (see §8 for sequencing vs the ADR-0024 revision).

## 7. Adversarial classifier test set (the proof obligation)

The **format** (`side-effect-taxonomy/v1` shape + Appendix B/D fields) freezes at R1 **before** the live
classifier exists. The **classification security claim** — that the warden's classifier reproduces these
labels — is a SEPARATE Phase-2A acceptance gate (QC re-review F8: do not conflate "format freeze" with
"classifier accepted"). That gate is met when the classifier passes a TDD suite over these — each with the
expected (kind, scope, target, modifier, confidence) and **none classifying *downward*** to a benign class
on parse failure:

`eval` · `bash -c` / `sh -c` / `zsh -c` · command substitution `$( )` / backticks · process substitution
`<( )` · heredocs · base64/hex/url-decoded payloads · `curl | bash` / `bash <(curl …)` · package managers
(`npm/pnpm/pip/npx install`) · `git push` / `git fetch` · symlinks · path traversal (`src/../.env`) · `.env`
· `~/.aws` · `~/.ssh` · `/proc/self/environ` · `env` / `printenv` · `chmod` / `chown` · background jobs /
`nohup &` · fork/resource bombs (`:(){ :|:& };:`, `dd`, busy-loops) · destructive (`rm` / `truncate` /
`find -delete` / `git reset --hard`).

Expected dispositions (defaults; §4 makes them policy-configurable): obfuscated → deny-unless-override;
unknown on a broad/network/external/system effect → deny; unknown on an explicitly low-risk read → review.

## 8. OPEN DECISIONS — close these (and only these) before any frozen schema lands

A small, reviewable checklist. Each is a ratified (human + judge) decision; **resolve, don't re-debate the axes.**

- [ ] **Final primitive `EffectKind` enum** — minimal orthogonal set (candidate start: `fs_read`, `fs_write`,
  `process_exec`, `network_read`, `network_write`, `unknown`; **decide** whether `process_control`,
  `system_config`, `credential_access`, `external_state_write`, `resource_use` are *primitive* or *derived/
  modifier*).
- [ ] **Final primitive `EffectScope` enum** — candidate start: `workspace`, `home`, `system`, `temp`,
  `network`, `external_service`, `process`, `unknown`; decide if `repo_metadata` is primitive or a workspace
  sub-scope.
- [ ] **Final primitive `RiskModifier` enum** — primitives only (candidate: `destructive`, `irreversible`,
  `persistent`, `permission_change`, `expensive`, `ambiguous`, `obfuscated`, `unknown`); **explicitly exclude**
  the composites `exfiltration_risk`, `supply_chain` (→ policy-derived) and decide `credential_adjacent` /
  `background` (primitive vs derived).
- [ ] **`SideEffectTarget` shape** — final `kind` set; confirm `normalized`/`withinWorkspace`/`sensitivity`
  are classifier-output (advisory, per §5).
- [ ] **Classifier `confidence`/disposition schema** — the value set (`exact`/`conservative`/`ambiguous`/
  `obfuscated`/`unknown`) and the `reasons[]` contract.
- [ ] **Primitive-vs-policy-derived line** — the authoritative list of which signals are frozen primitives vs
  computed in the policy pack (the YAGNI ledger from §3).
- [ ] **Default dev posture vs locked-down posture** — the two (or more) shipped disposition mappings,
  *calibrated against the 73-trial command corpus command distribution* (§4).
- [ ] **Conformance-test strategy** — how the manifest generates/validates policy ⇄ sandbox ⇄ egress (§6) and
  the runtime `policy_sandbox_mismatch` behavior.
- [ ] **ADR sequencing** — does the **capability-manifest ADR** land *before* or *alongside* the ADR-0024
  revision? (Recommendation: alongside — the manifest is what makes the taxonomy enforceable, and both freeze
  at 2A.)

### Retry note (ADR-0028 reconciliation)
Under the multi-axis model the retry carve-out becomes: retry-eligible **iff** `effectKinds ⊆ {fs_read}` **∧**
`scopes ⊆ {workspace, temp}` **∧** modifiers exclude every risk tag **∧** no touched target is `secret`
**∧** `classifier.confidence ∈ {exact, conservative}`. Everything else (write / network / process /
external / system / credential / `unknown` / obfuscated) is non-retryable. Finalized by the §8 decision
record and ADR-0024 revision (`repo_metadata` was dropped as a scope).

---

**Definition of ready-to-freeze:** §8 closed + ratified; the `@keel/shared` schema (shape per §2, values per
§8) implemented with round-trip/malformed-reject tests; the §7 classifier suite green; the capability-manifest
ADR accepted; OQ-8/ADR-0013 (OAP) answered coherently. **Then — and only then — freeze
`side-effect-taxonomy/v1` and the Appendix B/D fields.**

**R1 closure (2026-06-23): satisfied.** The format freeze is now applied; the §7 corpus remains the
Phase-2A live-classifier acceptance gate.
