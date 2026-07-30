# ADR-0070 - Headless-reviewed interactive console grants

**Status:** Accepted for implementation. The maintainer approved the recommended path on
2026-07-10 and delegated the remaining implementation choices to Codex, with the
constraint that no security/usability corners be cut.
**Date:** 2026-07-10

## Context

ADR-0069 makes the interactive console a warden-owned surface. A model can request
`interactive_console.open`, but the warden requires an exact console target grant before
opening a live VM/terminal. That is the correct fail-closed boundary for a stream of
keystrokes and live screen reads.

The latest Epic 2.34 installed-adapter rerun proved that boundary in the product path:
`qemu-startup` reached an exact console review for target `qemu-startup`, with target
digest, sandbox profile, argv digest, loopback listener, and the
`host-qemu-process-governed_guest-os-ungoverned` boundary in audit. It still failed in
headless Harbor because no human can type the approval during the model run. That is a
real product gap, not a reason to weaken the grant model into target-name preapproval.

The existing console grant key in `packages/warden/src/interactive-console/grants.ts`
already binds material that matters:

- workspace root;
- session id;
- tool name;
- target id and target digest;
- sandbox profile id and sandbox plan digest;
- open operation geometry;
- target command, argv digest, cwd, filesystem scopes, declared temp roots, egress
  domains, and lifecycle limits;
- dynamic side-effect envelope;
- policy pack name/hash;
- matched review rules.

Any headless-reviewed mechanism must preserve that binding. If it strips out `sessionId`,
the target profile, the sandbox plan digest, policy pack hash, or open geometry, it is a
different security model and needs a separate approval.

## Options

### Option A - Target-name preapproval

Accept an env var or plan resource such as `console-target=qemu-startup` and auto-approve
the first matching console review.

This is rejected. It is too weak for keel's security posture because `targetId` alone
does not bind the target digest, command argv, disk paths, network/egress profile,
sandbox plan, lifecycle limits, policy pack, session id, or open geometry. It would also
make product config presence look like authority.

### Option B - Extend Plan Autopilot resources with `console-target`

Add console targets to the existing kernel-side exact-resource Plan Autopilot envelope.

This is rejected for the first slice. Plan Autopilot currently resolves exact domains and
command grant keys from live review text. Console approval requires warden-resolved
target and sandbox material before the run can be headless. Adding only a target name to
Plan Autopilot would duplicate Option A. Adding the full material to Plan Autopilot would
move warden grant construction into the kernel, which duplicates security logic outside
the warden.

### Option C - Per-keystroke or per-line policy approval

Ask the warden or human to approve every keystroke or line.

This is rejected as the primary boundary. It adds friction and false precision without
making opaque guest effects governable. Keystrokes are still shape/budget checked and
audited per operation under ADR-0069, but containment comes from an exact target grant,
the sandbox, egress review, lifecycle budgets, and audit.

### Option D - Pre-run warden-generated console grant envelope

Before a headless run starts, the operator asks the warden to resolve the same console
target material it would use at `interactive_console.open`, reviews the material, and
approves a one-use grant envelope. The later headless run passes that envelope to the
warden. At `open`, the warden recomputes the live grant key and applies the envelope only
if every bound field still matches.

This is the recommended model.

## Decision

Adopt a **Headless Reviewed Console Grant Envelope v1** as the proposed mechanism for
headless console authority.

The envelope is a parent-controlled, warden-generated, human-reviewed artifact. It is not
model-generated, not project-local config, and not a normal plan resource. It may be
loaded only through an explicit run option or the installed-adapter parent environment,
never through model tool arguments or project files.

The envelope authorizes exactly one `interactive_console.open` for one session, one
target, and one open geometry. It carries enough material for the warden to recompute the
same grant key already used for live console reviews. Minimum v1 fields:

- `version: "keel-headless-console-grant/v1"`;
- `sessionId`;
- `workspaceRoot`;
- `targetId`;
- `targetDigest`;
- `sandboxProfileId`;
- `sandboxPlanDigest`;
- `policyPack.name` and `policyPack.hash`;
- `operation.kind: "open"` plus `rows` and `cols`;
- target command, argv digest/count, cwd, declared temp roots, filesystem scopes, egress
  domains, lifecycle limits, VM network/profile metadata, and release permission;
- side-effect envelope and matched review rules;
- `grantKey`;
- `principal`;
- `reviewedAt`, `expiresAt`, and `maxUses: 1`;
- `reviewText`, suitable for human display before approval;
- `source`, either `local-console-grant-file` or `parent-reviewed-benchmark-env`;
- an envelope hash over canonical JSON.

For local product runs, the preferred approval path is:

1. The CLI allocates or accepts a concrete `sessionId` before approval.
2. The warden resolves the target/profile/sandbox/policy material for that session and
   open geometry.
3. The CLI renders the exact review text and requires the human to type `approve`.
4. The approved envelope is written outside the workspace under `$KEEL_HOME` with owner
   only permissions.
5. If the approval and run share the local audit/checkpoint key, the envelope is signed
   with the existing Ed25519 checkpoint-key primitive and verified against the same local
   key before use.

The signature is a local tamper-evidence aid, not a new remote identity system. It is
valid only when the verifier has a trusted local key anchor. A headless benchmark runner
that cannot share that key must still use a parent-controlled grant path and must be
honest in audit/status that the authority source was an operator-reviewed parent
envelope, not a locally signed grant file.

At runtime the warden must fail closed when:

- no grant envelope is supplied and no live human review is possible;
- the envelope schema is invalid;
- the envelope is expired or already consumed;
- `sessionId`, workspace root, target id, target digest, open geometry, sandbox profile,
  sandbox plan digest, policy pack, side-effect envelope, lifecycle limits, release
  permission, or grant key differs from the live resolved material;
- workspace trust, audit writer, broker availability, SRT launch-preparer availability,
  or sandbox status is not enforcing;
- the grant file is project-local or has unsafe permissions in the local-file mode;
- the installed-adapter parent-env path contains unsupported `KEEL_WARDEN_*` or any
  `KEEL_INTERNAL_*` key;
- the console operation asks for a different target, rows/cols, release behavior, or
  session.

The first matching `interactive_console.open` must not silently seed
`sessionGrants`. It must append audit evidence that is at least as useful as a live
`warden.resolveReview` approval:

- either route through the same lower-level approval helper used by live console reviews;
- or append a `review.resolved` open-payload record with
  `source: "headless-reviewed-console-grant"`, `grantEnvelopeHash`, `grantKey`,
  `principal`, `reviewedAt`, `targetId`, `targetDigest`, `sessionId`, and
  `requestedScope: "once"`.

If the current Appendix B event vocabulary or review payload shape cannot represent this
honestly, implementation must stop for an audit/protocol ADR. No new audit event type is
assumed by this decision.

The envelope does not change the console's live operation semantics. `send_keys`,
`read_screen`, `release`, and `close` remain handle-bound, budgeted, redacted, and
audited per ADR-0069. The envelope only replaces the human's live response to the exact
target-open review.

This decision also does not solve SRT namespace availability. QEMU parity still requires
a container/host that can run the SRT profile. A normal Docker container that denies
`bubblewrap` namespace creation remains fail-closed even with a valid console grant.

## Consequences

The smallest safe implementation is a vertical slice that preloads exactly one signed or
parent-reviewed open grant into the warden and proves that the first matching open
consumes it. This avoids new model-facing tools and avoids changing
`warden.resolveReview` in v1, but it still changes enforcement behind a security claim
and therefore requires maintainer approval before code.

The CLI contract needs review. Recommended names are deliberately explicit:

- `keel console-grant preview --target <id> --rows <n> --cols <n> --session-id <ses_...>`;
- `keel console-grant approve --target <id> ... --out <path>`;
- `keel run --console-grant-file <path>`;
- installed-adapter-only `KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64`.

The exact spelling can change at implementation review, but the surface must make clear
that this is reviewed authority, not product config.

Required tests include matching-grant success, malformed grant denial, target drift,
sandbox-plan drift, policy-pack drift, expired/reused grant denial, project-local grant
file denial, unsupported parent env denial, audit-unavailable denial, and a model/tool
argument attempting to install or modify a grant. The Terminal-Bench QEMU rerun is a
verification step, not the unit of design.

Implementation status as of 2026-07-10:

- The maintainer approved the one-use, session-bound grant envelope policy unit and the
  installed-adapter parent-env path for implementation.
- The warden apply path, parent-env loader/pass-through, deterministic Terminal-Bench
  grant generation, kernel session pinning, matrix/Harbor emission, and adapter env
  validation are implemented locally with focused and broad verification.
- The implementation uses existing `warden.execute` and Appendix B event vocabulary; no
  new frozen RPC method or audit event type was required for these slices.
- The local signed-file CLI path and final CLI spelling remain future work. They still
  require the file-permission, project-local-path, and local-key-anchor checks described
  above before they can be implemented.
- QEMU benchmark success remains unclaimed until a rebuilt binary is tested on
  current-head `qemu-startup` and `qemu-alpine-ssh` in an SRT-capable environment.
