# ADR-0089 — Governed argv-only process execution

- **Status:** **Accepted.** Explicitly accepted by the keel maintainer on 2026-08-05; implementation
  is authorized only within public issue
  [#153](https://github.com/keel-harness/keel/issues/153).
- **Date:** 2026-08-05.
- **Decider:** keel maintainer.
- **Governs:** the proposed trusted-product `process.run` tool convention over existing
  `warden.execute`. Relates to MASTER_SPEC §3.2, §4.2, §4.3, §4.8, Appendix A, Appendix D, and §8.6;
  ADR-0016, ADR-0017, ADR-0021, ADR-0024, ADR-0033, ADR-0038, ADR-0056, ADR-0058, ADR-0076,
  ADR-0088; and dogfood issues
  [#52](https://github.com/keel-harness/keel/issues/52) and
  [#149](https://github.com/keel-harness/keel/issues/149).

## Context

The external-repository dogfood loop has exhausted a prompt-only attempt to make routine verification
reliable. The final owner-authorized fresh-home Click replay proved that issue #149's narrow correction
copy can remove output wrappers from one reviewed pytest request. The direct correction passed, the
agent wrote two focused tests, observed the intended failure, and made two typed edits. Later, the model
needed the workspace-local `src` tree on Python's import path and requested:

```text
PYTHONPATH=src python3 -m pytest -q tests/test_termui.py
```

The Warden correctly returned non-grantable `POL-003` review. The progress-earned final correction
chose `pip install -e . -q && ...`, contrary to the locked-tool/no-install constraint; that request
remained governed and failed because `pip` was unavailable. Keel stopped honestly without a public
successful exit or changelog edit. Independent verification later passed the same local tree with:

```text
python3 -m pytest -o pythonpath=src -q tests/test_termui.py
```

The Warden was correct. Shell assignment, redirection, pipelines, quoting, expansion, and compound
control flow can materially alter effects; unknown shapes must fail closed. Widening `POL-003`,
rewriting model command bytes, or adding recovery credits would weaken the boundary or extend churn
without removing the root ambiguity.

The product currently gives the model two relevant choices:

1. `bash`, whose `command` is one shell-language string; or
2. `lifecycle.run`, whose argv comes from an already-trusted `.keel/lifecycle.yaml` and is resolved
   independently by the Warden.

`lifecycle.run` demonstrates the right intent/authority separation but cannot cover arbitrary external
repositories that do not ship the manifest. Having the controller synthesize a trusted lifecycle file
from model guesses would be semantic laundering: model-selected command bytes would acquire a trusted
configuration label.

The implementation already contains a smaller structural seam. `SandboxInvocation` accepts optional
`argv`; the SRT adapter validates it, rejects NUL, single-quotes each argument as data, and passes the
result through the same sandbox runtime. What is missing is a model-facing convention, Warden-owned
argument validation, policy construction from structured argv, and complete audit/presentation proof.

## Decision criteria

An acceptable design must:

- eliminate accidental shell composition structurally, not through more prompt wording;
- preserve the exact model-authored argv without controller transformation or semantic equivalence;
- keep Warden policy, sandbox, egress, review, and audit authoritative for every invocation;
- retain or strengthen every current destructive, privilege, install, egress, arbitrary-code,
  mutable-metadata, and unknown-shape verdict;
- preserve the frozen `deny > review > modify > warn > allow` precedence without silently rewriting
  argv;
- make unsafe syntax impossible to interpret as syntax on this surface;
- add no environment, PATH, cwd, stdin, background, or service authority in the first slice;
- avoid a new RPC method or frozen shared schema when generic `ToolCall` plus the open hello-capability
  list is sufficient;
- remain understandable at 100x30 in TUI, headless, session, resume, and receipts; and
- make no live-model efficacy claim without a separately authorized measured replay.

## Decision

Add an additive trusted-product model tool named **`process.run`**. It is a sixth governed tool
convention, not a replacement for or redefinition of the five core tools.

### 1. V1 has one structured argument

The model-facing shape is:

```json
{
  "argv": ["python3", "-m", "pytest", "-o", "pythonpath=src", "-q"]
}
```

`argv` is required, non-empty, and bounded to at most 64 entries. `argv[0]` is a non-empty executable
name or path. Later entries may be empty because an empty argument is legitimate process data. Every
entry is a well-formed Unicode scalar string of at most 1024 UTF-8 bytes and may not contain an
unpaired surrogate or a code point in Unicode general categories `Cc`, `Cf`, `Zl`, or `Zp`. This
deterministic deny set includes NUL, C0/C1/DEL controls, bidi and zero-width format controls, and line
or paragraph separators. It prevents JSON/Node encoding from silently replacing a code unit and
prevents invisible or line-shaping bytes from making the exact argv presentation misleading. The
Warden owns the authoritative parser; the provider JSON Schema is only a model hint.

V1 has no `command`, `env`, `cwd`, stdin, timeout override, interpolation, redirection, glob,
background, lease, or pipeline field. Every call begins at the canonical trusted workspace root.
Persistent cwd/env and deliberate shell composition remain `bash` responsibilities.

### 2. Generic RPC carries the convention

`process.run` uses the existing Appendix-A `warden.execute` request with generic
`toolCall:{id,name,args}`. The Warden advertises the additive open hello capability
`process-run/v1` only when its workspace is trusted, its durable audit writer exists, and its sandbox
is available at an enforced `sandbox:*` tier. The kernel advertises the model tool only when that exact
capability is present and its workspace is trusted. Protocol-major compatibility or package-version
inference is not enough. Capability absence on an older or currently unenforced peer leaves current
tools byte-behavior-identical.

No `WARDEN_METHODS`, protocol version, `ModelPort`, `ExecutorPort`, audit record, `PolicyInput`, or
`SideEffect` schema change is expected. The existing `HelloResult.capabilities: string[]` is already
the negotiated extension seam used by other product capabilities, so adding this capability value is
not a field/schema change. As with `lifecycle.run`, the tool name remains a convention carried by the
generic call after support is negotiated.

If implementation discovers that an existing frozen/shared contract must change, this ADR is not
sufficient: stop and obtain a separately reviewed versioned amendment.

### 3. The Warden owns exact resolution

The Warden parses the original args and creates a resolved command carrying both:

- the exact validated argv; and
- one canonical human/audit rendering produced by the same single-quote encoder used at the sandbox
  boundary.

Allowed execution calls the existing sandbox with:

```text
{ command: argv[0], argv, cwd: canonicalWorkspaceRoot }
```

`SandboxInvocation.argv` is the execution source; the rendered command is not reparsed as model
authority. Adversarial tests must prove that spaces, quotes, `$()`, backticks, semicolons, `&&`, `||`,
`|`, `2>&1`, globs, braces, leading dashes, and empty data arguments reach the child as literal
argument bytes and cannot start a sibling command or expansion. Property inputs include non-ASCII
scalar values; unpaired surrogates and `Cc`, `Cf`, `Zl`, or `Zp` code points are denied before policy
or execution.

### 4. Policy is constructed from structured argv

The Warden builds `PolicyInput.normalized.argv` directly from the validated vector. Composition is
`atomic`; shell-looking argument values are data, never graph edges. Existing semantic analyzers for
delete, Git mutation, package install, explicit egress, privilege, env reads, dangerous system tools,
arbitrary code, file reads/writes, utilities, and mutable execution metadata are reused or factored so
the structured and shell builders cannot drift silently.

The static capability and sandbox profile remain the governed-bash broad envelope because an argv-only
process can still read, write, execute, or attempt network access. The policy sees the public tool name
`process.run`, the original structured args, exact normalized argv, and actual dynamic effects. A label
such as `process.run` or an executable named `pytest` never grants safety by itself.

A differential property test is mandatory for every argv safely representable on both surfaces under
the built-in starter pack: `process.run` may not receive a weaker verdict or narrower relevant effect
than the canonical direct `bash` equivalent. The comparison uses the frozen
`allow < warn < modify < review < deny` precedence. Unknown executable/effect cases fail closed.
Sandbox-contained arbitrary code keeps the existing complete-containment preconditions. Package
install retains the starter pack's `POL-008` warn behavior plus sandbox/egress constraints; privilege,
destructive, and egress rules keep their current authority requirements. A custom pack remains free to
branch on the public tool name, so no cross-pack parity claim is made.

### 5. Policy modification cannot rewrite argv in V1

The Warden preserves all five verdicts and their precedence. `allow` executes; `warn` executes with
the warning preserved in response and audit; `deny` and non-authorized `review` do not execute.

A `modify` verdict for `process.run` is converted to an audited fail-closed denial before sandbox
launch. The audit retains the original argv, the policy-proposed `modifiedArgs`, matched rules, and
guidance, but neither vector executes. This mirrors other exact structured surfaces that reject
unsupported policy rewriting and preserves the V1 claim that the executed argv is exactly the
model-authored vector. Supporting Warden-authored structured argv transformation later requires its
own explicit schema, reclassification, review-binding, and original/effective audit decision.

### 6. Existing review authority does not widen

No new grant kind or scope is introduced. A `process.run` review may use an existing exact command or
egress review only if its binding includes the public tool name, exact original argv/tool args,
canonical rendering, workspace, policy pack, dynamic effect, sandbox profile, principal, expiry, and
current one/session/project rules. Resolution must revalidate those facts immediately before executing
the same argv.

If existing review storage or revalidation cannot preserve this exact vector without approximate
equivalence, that review is terminal in V1. It must not fall back to a less exact bash authorization.
Broader approval ergonomics would require a later issue.

### 7. Audit and execution truth remain Warden-owned

Potentially side-effecting allows retain a durable pre-execution intent before sandbox launch and a
separate outcome afterward. The original `process.run` args and exact argv remain visible in open audit
payload fields; the canonical rendering is presentation, not a substitute for structured evidence.
Separated/bounded stdout and stderr, exit code, signal, output limits, sandbox failures, audit failures,
abort, Warden loss, and indeterminate mutation truth follow the existing governed execution contract.

No kernel/provider prose can mark the call allowed, executed, or passed before the Warden/controller
evidence says so.

### 8. Controller evidence understands argv without overclaiming

`process.run` is a broad process-execution surface, not a typed workspace mutation. Kernel consumers
that currently special-case bash must receive an explicit argv-aware path rather than a lossy joined
string. This includes context derivation/compaction, loop signatures, progress classification,
verification and recovery evidence, finalize eligibility, goal audit, test summaries, containment
guidance, steering/scope classification, TUI/headless projection, session/resume, and final synthesis.

A successful Warden-owned execution envelope from a recognized direct test/build/check argv may carry
the same narrow strong-success evidence as an equivalent direct bash command. Nonzero or signaled
execution, malformed/warning-confused envelopes, inline interpreter or `bash -c` code, read-only probes,
arbitrary success prose, denied/reviewed/modified results, and untrusted evidence cannot. Goal criteria
match the exact argv. Loop/progress signatures hash the exact structured args. Test summaries derive
from the actual bounded stdout/stderr and exit status.

Because any process may mutate, `process.run` is mutating for urgent steering, scope, and workspace
novelty accounting. It does not count as ADR-0088's eligible typed `edit`/`write` recovery progress and
does not enter #149's bash-wrapper correction lane. No model or provider self-report can upgrade it to
completion evidence.

### 9. Product presentation teaches the division of labor

The tool description and compact system guidance prefer `process.run` for one direct executable
invocation, especially a build, test, lint, typecheck, or status check. They reserve `bash` for
deliberate shell composition or persistent shell state. They do not automatically convert one surface
to the other.

TUI, headless, session/resume, receipts, and final synthesis render a safely escaped exact argv with
requested/running/warned/reviewed/blocked/policy-modify-not-executed/failed/passed truth. The user must
not need to decode raw JSON, and the surface must not imply that argv-only syntax makes the invoked
program harmless.

### 10. Efficacy remains evidence-bound

Deterministic tests can prove exactness, containment, policy parity, audit fidelity, and UX state. They
cannot prove that a live model will choose the tool when useful or complete the previously failed Click
task. A fresh external replay requires a separate explicit owner authorization, scope, and monetary
ceiling below the remaining Anthropic hard budget. Until that replay passes, live-model efficacy is
`NOT_RUN`, not inferred.

## Options considered

### Option 1 — additive `process.run` with argv-only V1

**Selected.** It removes shell grammar from the routine one-process path, uses existing RPC and sandbox
seams, keeps actual effects under Warden authority, and is general across ecosystems without calling
arbitrary execution “verification-safe.”

### Option 2 — broaden `POL-003` for assignments, redirects, or pipelines

**Rejected.** It would expand ambiguous shell grammar globally. Output wrappers also obscure useful
exit status for no product benefit because Keel already separates and bounds streams.

### Option 3 — controller rewrite/split or automatic bash-to-argv conversion

**Rejected.** The controller cannot prove quoting, ordering, redirection, environment, or side-effect
equivalence. Command construction belongs to the model; policy decides the exact request.

### Option 4 — high-level `verify.run` runner enums

**Rejected for V1.** A “verification” label is not authority, ecosystem-specific command synthesis
would grow quickly, and hidden defaults could test an installed package instead of the workspace. A
generic process name is more honest; lifecycle manifests remain the higher-level trusted intent seam.

### Option 5 — synthesize or require `.keel/lifecycle.yaml`

**Rejected as the general dogfood fix.** Requiring config harms first use in arbitrary repos; generating
it from model guesses launders untrusted intent into a Warden-resolved trusted source. Repos that
already ship a reviewed manifest should continue using `lifecycle.run`.

### Option 6 — add argv mode to `bash`

**Rejected.** One tool would then have two materially different languages and state models: persistent
shell strings versus one-shot literal argv. Separate names make execution and audit intent explicit and
avoid a compatibility change to the shipped `bash` schema.

### Option 7 — add a new frozen RPC method or direct unsandboxed process runner

**Rejected.** Generic `warden.execute` and `SandboxInvocation.argv` already provide the needed seams.
A kernel/direct runner would bypass structural enforcement; a new RPC method would add version churn
without new authority or evidence value.

## Consequences

- Routine one-process work can avoid accidental shell control syntax by construction.
- Warden, policy, sandbox, egress, review, and audit remain the authority for the invoked program's
  actual effects; argv-only means “no shell interpretation,” not “safe program.”
- The trusted product surface grows by one public model tool and therefore needs claim-ledger,
  architecture, onboarding, TUI, package, and compatibility evidence before merge.
- The five original core tools and their schemas remain unchanged.
- V1 intentionally cannot set environment variables, change cwd, feed stdin, or manage long-lived
  processes. Useful cases that require those features continue through governed bash or a trusted
  lifecycle manifest until separately designed.
- The model may still choose `bash`; deterministic green does not establish live resolve-rate gain.
- A structured policy builder introduces under-classification risk. Differential and adversarial
  properties, real-sandbox probes, independent five-lens review, and fail-closed unknowns are merge
  gates, not follow-ups.

## Required implementation evidence

Issue #153 is the public implementation plan and full risk register. At minimum, implementation must
be red-first and prove:

1. `process-run/v1`-gated trusted-product advertisement and an end-to-end Warden/SRT/audit walking
   skeleton;
2. untrusted, older/capability-absent, incompatible, missing-Warden, missing-sandbox, and local-YOLO
   absence/fail-closed paths;
3. schema bounds and arbitrary-argument no-shell-interpretation properties;
4. full-precedence verdict/effect parity or stronger behavior against canonical direct bash, plus
   synthetic custom-pack `modify` non-execution;
5. destructive, install-warning, privilege, egress, arbitrary-code, unknown, and mutable-metadata
   cases;
6. exact review/grant revalidation or terminal V1 review when exact binding is unavailable;
7. durable pre-intent/outcome audit, redaction, bounded streams, abort/failure/indeterminate truth;
8. exact-argv context, compaction, loop, progress, verification, recovery, finalize, goal, summary,
   steering, and completion behavior without typed-mutation/recovery-credit confusion;
9. 100x30 real-Ink, headless, no-color, resume, scroll, input, interrupt, compaction, and final-result
   presentation;
10. the deterministic #149 reproduction and successful argv-only continuation; and
11. focused, coverage, lint, typecheck, format, build, package, supply-chain, real-sandbox, exact-head
    CI, scripts-disabled-carrier, and five-lens QC gates.

No provider call is authorized by accepting this ADR. A live replay remains separately scoped.
