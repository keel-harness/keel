# R23 publication and CRCRLF-safe PTY observer

Date: 2026-08-04

## Publication lineage

- Issue #127's final reviewed head was `b7524c118b1396295b43ae70cbf086910e928b10`, tree
  `ff67418ceaf88e4a9e7a5a86c4ada84e82bac34d`.
- Exact-head CI run `30946864248` passed every selected PR lane, including `ci-required`, DCO,
  Ubuntu build/coverage, macOS build/smoke, both package lanes, both real-sandbox lanes, security,
  Node-next, egress-scale, and the Node 20/22/24 installed-product matrix.
- The owner-authorized admin squash merged PR #129 as
  `be1c900c42b36208f930b678f254c1143297f7fb`. The merge tree is byte-identical to the reviewed
  tree. Issue #127 closed and the remote feature branch was deleted.
- Exact post-main run `30947409856` passed audit, security, Node-next, Ubuntu/macOS build lanes,
  both real-sandbox lanes, both cross-architecture runtime smokes, Ubuntu package, and egress-scale.
  It failed only macOS package job `92120753973`; `ci-required` correctly remained red and the
  dependent product matrices did not run.

## Observed failure

The installed npm-carrier production-renderer smoke reached governed readiness, accepted and
rendered the input probe, then timed out waiting for the blank composer after Ctrl-C dismissed the
palette. Forced cleanup reaped the process group. The failing raw stream had SHA-256
`9636a0e2672b269a97bf1d2528d7ac04518f6519e4c76ab2958db81e5f4033`.

Unrestricted reproduction against the exact installed carrier failed 4 of 8 observations. Every
failing byte stream showed that Keel had cleared the palette and redrawn the blank composer. Ink's
line ending passed through the PTY's ONLCR processing as `CR CR LF`. The observer treated the first
carriage return as a bare-CR redraw boundary when all three bytes arrived in one read, leaving only
`"\n"` as the current frame. Different read chunking passed. This was a release-observer race, not
a product input or renderer failure.

Public issue #130 scopes the repair to the packaging observer. Product timeouts, predicates,
retries, renderer behavior, Warden authority, policy, sandbox, egress, audit, and frozen contracts
are explicitly out of scope.

## Red first

The first exact regression added the captured `CRCRLF` blank-composer shape and failed as intended:

```text
AssertionError: input: type a task or /help not found in '\n'
```

Adjacent controls proved ordinary CRLF, bare-CR redraw, incomplete CSI, and malformed CSI behavior.

## Retained implementation

`sanitize_terminal` consumes one consecutive carriage-return run. A run immediately followed by
LF is one completed terminal line ending; a run not followed by LF remains the existing incremental
redraw boundary. Processing remains linear and inside the existing bounded raw-byte observer. No
retry, sleep, timeout, acceptance predicate, or product behavior changed.

Implementation commit: `546476a` (`fix(packaging): preserve CRCRLF terminal frames`).

## Validation

- Focused Python observer suite: **7/7 passed**.
- Packaging observer plus CI-wiring Vitest selection: **2 files / 30 tests passed**.
- Repeated real macOS-sandbox smoke against the exact installed pre-repair product carrier with the
  repaired observer: **20/20 passed**, including governed posture, input-probe rendering, blank
  composer recognition, `/exit`, exit zero, and complete process-group teardown.
- Lint, full workspace plus packaging typecheck, format, build, and `git diff --check`: **passed**.
- The first full coverage command ran inside the outer Codex sandbox and was **not green**: six
  destination-guard proxy cases received `listen EPERM` on `127.0.0.1`. The failure was retained.
- The same full coverage command outside that outer restriction passed **365 files / 6,669 tests /
  20 intentional opt-in skips**. Overall coverage is 97.86% statements/lines, 93.62% branches, and
  99.59% functions; all enforced package thresholds pass.
- `corepack pnpm package`: **passed**, producing all four native/cross binaries and the npm carrier.
- Fresh scripts-disabled installation of the exact current package passed the original real-PTY
  product smoke. Tarball SHA-256 is
  `51d8be350dbd231329a2fd09ce30dd9dd218fd697bbfaef1985dccf75bfe7fc5`; the run reached governed
  posture, acknowledged input, exited zero, and reaped its process group.

## Five-lens QC

- Spec compliance: packaging observation only; issue #130's scope and non-goals are preserved.
- Security/adversarial: the raw-byte cap remains; the parser is linear; malformed and incomplete
  control sequences remain rejected; no policy or approval authority changes.
- Reliability/edges: exact failing bytes reproduce before the repair, 20 repeated sessions plus a
  fresh exact carrier pass after it, and CRLF/bare-CR controls prevent overcorrection.
- DX/usability: removes a false release failure without hiding a real product failure or adding a
  retry that could mask one.
- Simplicity/maintainability: one local parser rule plus focused tests; no dependency or shared
  abstraction.

No local must-fix remains. Security claims affected: none. ADR needed: no. Workflow score change:
none; this is release-observer confidence rather than a new workflow outcome. E5 is **NOT_RUN**
because no provider behavior changed. Provider calls, input/output tokens, cost, and Warden reviews
are all zero; cumulative Anthropic spend remains USD 4.72508650.

## Publication closeout

- Exact reviewed head `259fdfc401e99b6a8fc1c0ca5e506c9c2552864c`, tree
  `03fd2f69c30481e91ac5ec4f49d13bdf64b15060`, passed PR CI run `30949551544`, including DCO,
  required aggregate `92129530917`, full build/coverage, npm package smoke, security, real sandbox,
  Node-next, egress-scale, and all Node 20/22/24 installed-product matrices.
- The owner-authorized admin squash merged PR #131 as
  `32f33466065020dff6714c19b3f269e0a3bc98bf`. The merge tree is exactly the reviewed tree; issue
  #130 closed and the remote feature branch was deleted.
- Exact post-main run `30950106016` passed required aggregate `92131701270`, audit, security,
  Linux/macOS build and coverage, both package lanes, both real-sandbox lanes, both cross-
  architecture runtime smokes, Node-next, egress-scale, and all three installed-product matrices.
  macOS package job `92129805024` is the direct green replay of the lane that exposed DF-030.

Publication is closed. Cleanup follows this durable evidence commit. The final same-commit six-
workflow replay remains open.
