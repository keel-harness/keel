# AGENTS.md — keel engineering charter & operating rules

Operating standards for anyone — human or AI — who touches this codebase.

This file is the repo-level contributor contract: ethos, hard rules, and pointers. It
does not replace the authoritative docs below. Read the relevant ones before changing
anything.

## North star

keel aims to become the default harness for governed agents: secure enough for the NSA,
polished enough for Netflix, engineered to a Google + Anduril bar, and forkable for a
decade.

In ten years, keel should be to governed agent harnesses what Linux is to operating
systems: a durable, local-first, modular foundation that strangers can inspect, trust,
fork, and evolve.

Every change must move keel toward all four properties:

- **Secure** — enforced structurally, not by trusting model behavior.
- **Excellent** — correct, tested, deterministic, and maintainable.
- **Usable** — fewer prompts, clearer guidance, faster paths, better DX.
- **Evolvable** — modular, standards-aware, forkable, and easy to reason about.

Ambition does not justify abstraction. The best change is usually the smallest verified
vertical slice that makes one important claim more true.

## Authoritative docs

Read these before changing code:

- **`README.md`** — current supported product surface, install path, and quickstart.
- **`MASTER_SPEC.md`** — governing system spec: mission/non-goals, threat model,
  architecture, security claims, phase gates, and frozen interfaces.
- **`CONTRIBUTING.md`** — charter rule, ground rules, branch/PR workflow.
- **`docs/adr/`** — architectural decisions and rationale. The “why” must survive forks.
- **`docs/roadmap.md`** — public roadmap and explicitly deferred work.
- **Linked issues and pull requests** — current implementation scope, risks, and
  verification evidence. The master spec defines the system; the public work item
  defines the next safe slice.
- **Relevant code and tests** — do not infer behavior from names.

When docs conflict, use this order:

1. Accepted ADRs and frozen protocol/schema/interface docs for their scoped decisions.
2. `MASTER_SPEC.md` for system behavior, threat model, claims, and gates.
3. The approved public issue or pull-request plan for the current implementation slice,
   unless it conflicts with the spec or ADRs.
4. `CONTRIBUTING.md` for contribution workflow.
5. This file for daily contributor behavior.
6. Code and tests as ground truth for what currently exists.

If a conflict touches security, frozen contracts, public behavior, auditability,
sandboxing, dependency policy, or phase scope, stop and ask.

## Non-negotiables

- **Structural enforcement beats behavioral trust.** The model may request; the warden
  decides. Prompts, policy text, and model instructions are not enforcement.
- **Honesty over impressiveness.** Never claim a property the code does not structurally
  provide. Downgrade the claim, not the honesty.
- **Gates, not dates.** Do not start the next phase until the current gate passes. If a
  gate cannot pass, escalate with written analysis; never silently relax it.
- **TDD is law for behavior.** Bug fixes and behavior changes start with a failing test.
  Refactors preserve behavior under existing tests. Docs/config-only changes state why
  no test applies.
- **Claims map to tests.** Every security claim needs positive, negative, and
  adversarial coverage. No test means remove or downgrade the claim.
- **No hidden green.** A command not run is reported as not run. A partial run is
  reported as partial. Never imply CI passed when only a subset ran.
- **Forkability is a product requirement.** Apache-2.0, local-first, zero telemetry
  absent by default, no lock-in, clear ADRs, stable seams.
- **No scope creep.** If work pulls in a v1 non-goal or future phase, stop and re-scope.

## Default workflow

For normal implementation work:

1. **Orient**
   - Read `README.md` and the linked issue or pull request.
   - Read the relevant `MASTER_SPEC.md` section.
   - Read relevant ADRs.
   - Read nearby code and tests.

2. **Define the slice**
   - What behavior, claim, interface, or UX is changing?
   - What is explicitly out of scope?
   - What evidence will prove the change works?

3. **Write or identify the test**
   - Behavior change: write the failing test first.
   - Bug fix: write the regression test first.
   - Security work: include denied-path/adversarial tests.
   - Refactor: identify tests proving equivalence.
   - Docs/config-only: explain why no test applies.

4. **Run the simplicity gate**
   - Is this over-engineered?
   - Is there a smaller vertical slice?
   - Is there a simpler/safer way to prove the same claim?
   - Am I pulling future-phase work forward?

5. **Implement**
   - Match surrounding code style and naming.
   - Keep units focused and interfaces clear.
   - Prefer boring, explicit code.
   - Use typed, recoverable errors where recovery is possible.
   - Do not mix broad cleanup with feature work.

6. **Verify**
   - Run targeted tests first.
   - Run broader gates when relevant.
   - Read the output.
   - Report exactly what ran and what did not.

7. **Record**
   - Keep the linked issue or pull request current as gates pass and blockers appear.
   - Update the public roadmap or claim ledger when product status or evidence changes.
   - Add/update ADRs when a decision must outlive the implementation.
   - Record intentional follow-ups instead of quietly expanding scope.

## Epic protocol

An epic is multi-step work that touches multiple packages, interfaces, phases, security
claims, or product surfaces.

Before writing code for an epic, create or update a public tracking issue and put the
implementation plan in the issue or linked pull-request description.

The epic plan must include:

- scope;
- local non-goals;
- interfaces/packages touched;
- tests to write first;
- implementation slices;
- risk register;
- definition of done;
- stop-and-ask triggers;
- verification plan.

Do not implement directly from `MASTER_SPEC.md` when a public implementation plan is
missing. The spec is too large to be a work order; the issue or pull-request plan
defines the next safe slice.

Every epic starts with a walking skeleton: the smallest vertical end-to-end path that
proves the architecture across real package/interface boundaries. Thin vertical slice
beats complete horizontal layer.

Every epic ends with independent review passes before synthesis:

- **spec-compliance** — matches `MASTER_SPEC.md` and the epic plan;
- **security/adversarial** — attacks the change and includes denied-path probes;
- **reliability/edge cases** — failure modes, partial failure, limits;
- **DX/usability** — human- and model-facing surfaces;
- **simplicity/maintainability** — could a forker understand and change it?

Synthesize findings as: must-fix-before-merge/gate, should-fix-soon, acceptable-risk,
follow-up, or spec-issue. An epic is not done until every must-fix is resolved or
explicitly escalated.

## Security bar

- **Fail closed, fail fast, least privilege.** Deny by default; minimize sandbox profile,
  tool surface, CI token permissions, network egress, and filesystem access.
- **Warden authority.** The model cannot directly perform privileged actions. It can
  only request; the warden decides.
- **Autopilot is not YOLO.** Autopilot means high autonomy inside enforced boundaries.
  YOLO means reduced or absent enforcement. Never conflate them in code, docs, status
  lines, receipts, demos, or marketing copy.
- **The record survives the agent.** Audit must be tamper-evident, signed where
  specified, and out-of-process where specified. The agent cannot be trusted to write
  its own authoritative log.
- **Denied actions are first-class.** Log denied actions with the same fidelity as
  allowed actions.
- **Runtime trust boundary.** Runtime keel must not read project-local files before the
  warden grants trust according to the spec. Contributors may read repo files needed to
  perform changes; do not confuse contributor access with runtime behavior.
- **Trust-before-parse.** Treat project input as hostile until trust is established.
  Tag provenance and gate untrusted-derived data at egress.
- **Secrets stay secret.** Secrets live in the OS keychain or approved secret store and
  pass redaction before any write, log, audit event, fixture, exported artifact, or model-visible
  message. The sole retained-byte exception is ADR-0043's faithful run-start safety snapshot: it is
  permitted only post-trust inside an owner-only mode-`0700` `KEEL_HOME`, with the entire root denied
  to governed tools, no concrete path or contents disclosed to the model, and human-only host
  recovery. Until those conditions are executable and proven together, the exception is not green.
- **Supply chain from commit one.** Exact-pinned deps, committed lockfile,
  `ignore-scripts` where applicable, SHA-pinned GitHub Actions, minimum-release-age
  where supported, Dependabot, SBOM and signed releases at release time.
- **Permissive licenses only.** Apache-2.0, MIT, BSD, ISC are acceptable. GPL, AGPL,
  LGPL, BSL, SSPL, Elastic, source-available, proprietary, custom, or unclear licenses
  require explicit approval.

Security claims require executable evidence. Coverage is a floor, not proof of security.

## Quality bar

- Read like the surrounding code.
- Names describe what a thing does, not how.
- Keep files and functions small enough to reason about.
- Prefer clear interfaces and single-responsibility units.
- Test behavior, not mocks.
- Use property tests with `fast-check` for invariants such as RPC framing, policy
  verdicts, audit verification, path handling, provenance transitions, parser/serializer
  round trips, and simulator determinism.
- A flaky test is a P0 bug. Do not quarantine, skip, or weaken it to get green.
- Do not update snapshots blindly. Read the diff and confirm the new output is correct.
- Fix root causes, not symptoms.
- Leave touched code better than you found it, but do not sprawl beyond the task.
- Do not assert performance without measurement.
- Do not assert determinism without deterministic tests.
- Do not assert compatibility without compatibility tests.

Coverage gates are enforced by CI/spec and must not be lowered without approval.
Current expectations include:

- `warden` ≥95% statements / ≥90% branches;
- `kernel` ≥85%;
- `memory` ≥90%;
- new packages coverage-gated by default.

## Research and dependency rule

For high-risk or high-complexity work, research before building. This especially applies
to sandboxing, OS isolation, crypto, signing, parsers, protocol/format implementations,
policy engines, audit logs, provenance, package publishing, cross-platform filesystem
behavior, PTYs, and untrusted input handling.

Prefer official docs, standards, mature permissively licensed libraries, and known
failure-mode research over hand-rolled implementations. Reuse beats reinvention when it
improves correctness, security, and maintainability.

Record important findings in the epic plan, ADR, PR notes, or docs. Do not paste
secrets, private code, sensitive architecture, credentials, or user data into external
services.

Before adding a dependency, check necessity, license, maintenance, install scripts,
native/transitive code, network behavior, sandbox/security impact, and whether an ADR is
needed.

## Modularity and evolvability

Volatile dependencies sit behind stable ports:

- `ModelPort`
- `UIPort`
- `PolicyPort`
- `SandboxPort`
- `ExecutorPort`

Swap implementations, not contracts.

Frozen/versioned protocols, schemas, audit formats, and CLI contracts require explicit
versioning, tests, migration/compatibility analysis, an ADR, and human review before
implementation.

Prefer standards when they fit and reduce long-term risk: `AGENTS.md`, `SKILL.md`, MCP,
OAP, NIST/OWASP mappings. Do not adopt a standard merely to look compliant; a tiny
internal format can be better when it is sufficient, documented, tested, and low-risk.

## Usability and DX

Fewer prompts should come from stronger enforcement, not weaker safety.

Denials should teach the model when safe: machine-readable reason, allowed alternatives,
and exact boundary hit. Humans are interrupted only for genuinely consequential
decisions.

Human-facing messages should be short and useful:

    what · why · exact command/action to allow or fix it

`doctor` should emit one copy-paste fix where possible, not a wall of docs.

First run should be fast, local-first, transparent, and free of hidden telemetry or
mystery network access. Microcopy, diffs, receipts, status lines, and errors are product
surfaces: clear, honest, and polished.

## Stop and ask first

Pause and get human review before proceeding when a change would:

- alter, add, remove, weaken, or reinterpret a security claim;
- alter enforcement behind a security claim;
- touch a frozen interface, protocol, schema, audit format, or CLI contract;
- change public behavior users, scripts, packages, or forks may depend on;
- weaken, delete, skip, quarantine, or `xfail` a test;
- relax CI, coverage, lint, type, security, or release gates;
- add a dependency with unclear or non-permissive licensing;
- rely on unsettled assumptions about crypto, sandboxing, parser security, OS privilege,
  provenance, or audit integrity;
- introduce telemetry, analytics, crash reporting, network egress, or remote services;
- expose secrets, credentials, tokens, private user data, or sensitive repo context;
- pull scope outside `MASTER_SPEC.md` v1 non-goals;
- change release signing, SBOM, provenance, or package publishing behavior;
- make a large cross-package change that could be split into safer slices.

When blocked, do not improvise. Write a blocker note with the decision needed, affected
files/contracts/claims, options considered, safest default, and consequence of waiting.

## Common agent failure modes

Do not do these:

- **Placeholder-as-done** — a stub, mock, interface shape, or TODO is not a completed
  feature.
- **TODO-driven completion** — do not leave TODOs where real behavior, error handling,
  or security handling is required.
- **Test weakening** — do not loosen, delete, skip, quarantine, or `xfail` tests to get
  green.
- **Cleanup sprawl** — do not broaden scope for nearby refactors; record follow-ups.
- **Inference from names** — do not guess behavior from symbols; read code and tests.
- **Unproven claims** — do not assert security, determinism, performance, hermeticity,
  compatibility, or isolation without executable evidence.
- **Convenience dependencies** — do not add a dep where a small standard-library
  implementation is clearer, safer, and sufficient.
- **Silent contract changes** — do not quietly change public interfaces, schemas, CLI
  behavior, audit formats, policy verdicts, or protocol semantics.
- **Hidden green** — do not imply checks passed unless they ran and you read the output.
- **Model self-report as truth** — use control-plane state, tests, logs, receipts, or
  signed/tamper-evident records for status/security/audit truth.

## Completion evidence

Do not simply say “done.” Show evidence.

When claiming completion, state:

- **What changed** — units touched and behavior changed.
- **Tests added/updated** — including denied-path tests for security work.
- **Commands run** — exact commands and actual results.
- **Security claims affected** — added, changed, removed, or not affected.
- **ADR needed?** — yes/no and why.
- **Follow-ups deferred** — what was intentionally not done.

Rules:

- A command not run is reported as **not run**.
- A skipped test is listed with reason.
- A partial run is called **partial**.
- “Tests pass” means the stated tests ran and passed.
- “CI passes” means CI actually passed.
- Do not claim coverage, performance, security, or determinism unless measured/tested.

## Commands

    corepack enable && pnpm install      # pnpm pinned via packageManager
    pnpm test                            # unit + property tests
    pnpm test:cov                        # tests + enforced coverage gate
    pnpm test:sandbox:real               # opt-in REAL bwrap/seatbelt denial probes (needs bwrap·socat·ripgrep)
    pnpm typecheck                       # tsc --noEmit across packages
    pnpm lint                            # eslint flat config
    pnpm format                          # prettier --check
    pnpm format:write                    # prettier write/fix
    pnpm --filter @keel/<pkg> <script>   # run a script in one package

CI in `.github/workflows/ci.yml` runs lint, typecheck, format, and test+coverage on
Ubuntu and macOS. `audit` runs on `main`/schedule, not PRs, to stay hermetic.

Use targeted commands while developing. Before claiming completion, run the broadest
verification appropriate to the change and report exactly what did or did not run.

## Repo map

The package and directory layout is documented once, in the
[architecture deep-dive](docs/guide/architecture.md#repository-layout). Read it there. If the
layout changes, update that section in the same PR as the structural change.

Two contributor-facing directories are not covered there:

    docs/design, docs/research
      Dated design and research archives. Each has a README explaining what it is
      and what supersedes it. Not current documentation.

    docs/quality
      Public claim ledger, security-suite inventory, and verification guidance.
      Update the claim ledger whenever evidence or product status changes.

## Final rule

Make one claim more true.

A good keel change is smaller than expected, tested before implementation, honest about
what it proves, clear about what it does not prove, secure by structure, easy to review,
easy to fork, and easy to resume from its public issue or pull request.

Do not optimize for looking impressive. Optimize for making the system safer, more
correct, more usable, and more evolvable.
