# R23 governed-ready startup-tail repair

- Date: 2026-08-04
- Public implementation plan: [issue #127](https://github.com/keel-harness/keel/issues/127)
- Parent validation: [issue #126](https://github.com/keel-harness/keel/issues/126)
- Starting main: `4103438ecd328c90c00f24f24fdb792970e2da3c`, tree
  `26f932c7e28cdee553a46b159c971f5ac7d7b25f`
- Exact accepted code commit: `e95032b671596961ff48106532fd4c75628128bc`, tree
  `2b1ad34781d9480bb48d2a6887bd1ec6789eb2cd`
- Exact scripts-disabled npm tarball SHA-256:
  `0798d3036ed17ff5b15c09e1cb91ff738f05dc8327f7eb6f2a3d90e0f6e69299`
- External workload: clean Click checkout at
  `edda51f303625daa6084cd53490bbcf6c274bef5`
- Geometry: `80x24`; `TERM=xterm-256color`

## Reproduced defect and fixed boundary

R23's two exact-main distributions established the defect: combined governed-ready p95 was
1,049.076 ms over 40 accepted launches, with 10/40 at or above the public `<750 ms` target and
3/40 above the R17 `<=1,000 ms` observational bound. A snapshot-disabled diagnostic reached p95
631.637 ms, and the faithful snapshot component itself measured p95 199.455 ms. That evidence
localized the tail to contention between Warden startup and the mandatory run-start snapshot.

Issue #127 froze the narrow repair boundary. The Warden must become ready before any trusted
workspace measurement or copy begins; snapshot settlement must still precede model input, queued
task work, resumed steering, and tools. The owner-private state root may be established before
Warden startup because that preflight reads no workspace bytes and creates no snapshot destination.
The ordinary physically external destination may use Node's native recursive copy; a Keel state
root nested in the workspace must retain explicit traversal so exclusion happens before descent.

The retained implementation also reduces a measured secondary source of startup process work: the
cosmetic trusted Git cockpit probe now obtains branch and porcelain counts from one bounded
`git status --porcelain --branch` process instead of two. It remains fail-soft, cancellable,
trust-gated, nonblocking, and concurrent with Warden startup.

## Red-first and rejected candidates

The ordering regression was written first. It failed for the intended reasons: the trusted backup
started before the gated Warden became ready, and a failing Warden startup still invoked the
backup. The copy-path test then failed because no ordinary/fallback strategy selector existed. A
separate Git scheduling test failed with observed order `warden gate -> backup -> Git` rather than
the required `Git -> Warden gate -> backup`. After implementation, the focused session-entry plus
snapshot suite passed 159/159.

The first clean candidate, `83e4f4c`, sequenced Warden then snapshot and used the native-copy path.
Its exact clean tarball SHA-256 was
`cd18bc8ab62ddac6c22d3b9137eec3bf977868b31e30e5089687685732880797`.
It remained rejected because its accepted 20-run governed-ready p95 was 780.438 ms. A
snapshot-disabled control on the same candidate reached p95 585.844 ms, proving that no threshold
change or snapshot weakening was justified.

Candidate `abbda07` moved the existing cosmetic Git probe alongside Warden startup. Its exact clean
tarball SHA-256 was
`ec70677bdbf85cf6a86ae7c4e5c5750a9bf85875561d6dd1dd6f133e6b26f713`.
The first 20-run distribution passed at p95 670.003 ms, but confirmation failed at p95 815.561 ms.
Combined p95 was 753.331 ms with 3/40 at or above 750 ms. It was not promoted from one passing
distribution.

A bounded-parallel metadata-walk experiment was intentionally left uncommitted and reverted. The
same 20-snapshot Click component benchmark worsened from the prior p95 98.947 ms to 141.737 ms.
The filesystem workload preferred the existing sequential walk, so that speculative optimization
was discarded.

The final red-first Git test required one call while preserving dirty counts, clean state,
upstream-decorated branches, unborn branches, detached-head omission, runner rejection, timeout,
cancellation, output caps, and process-group cleanup. It failed against the two-process
implementation, then passed after the single-process parser landed as `e95032b`.

## Exact installed-carrier acceptance

`pnpm package` built the npm package plus Darwin/Linux arm64/x64 binaries. The first `npm pack`
attempt was **not green** because npm selected the sandbox-inaccessible user cache. Repeating with
an isolated task-local cache passed. The local tarball installed 57 packages with lifecycle scripts
disabled; `keel --version` returned `keel 0.1.1`, and installed metadata recorded exact commit
`e95032b671596961ff48106532fd4c75628128bc` with `dirty: false`.

Each distribution used the registered product PTY observer, a spawned production Warden, the clean
external Click workspace, a fresh owner-private Keel home, and a loopback-only provider endpoint.
Every sample had to reach governed posture, render application-owned input, exit zero, and reap its
complete process group. There were no rejected samples.

| Metric | First distribution (n=20) | Confirmation (n=20) | Combined (n=40) | Frozen gate |
| --- | ---: | ---: | ---: | ---: |
| First-paint p95 | 41.156 ms | 40.641 ms | 41.119 ms | <200 ms |
| Governed-ready p50 | 589.521 ms | 575.692 ms | 584.230 ms | diagnostic |
| Governed-ready p95 | 673.149 ms | 718.369 ms | 714.515 ms | <750 ms per distribution |
| Governed-ready max | 751.393 ms | 828.473 ms | 828.473 ms | R17 <=1,000 ms observation |
| Idle-input p95 | 7.874 ms | 7.153 ms | 7.762 ms | <=50 ms |
| Clean exit and reap | 20/20 | 20/20 | 40/40 | required |

Two combined samples are at or above 750 ms, but percentile acceptance is not silently rewritten as
a per-sample maximum. Neither independent distribution crosses the frozen p95 threshold, combined
p95 is 714.515 ms, and no sample exceeds the separate 1,000 ms observation bound. The two report
SHA-256 values are
`1c5f20f11e0a1534fb02ca519b13ea6dddca6f62ac21f009b5a0c34765f63b9e` and
`ef5db9441f6d6481159ed5e68a17e330c8945d3b308942c99acd6c732a2d6773`.

## Verification

- Focused final regression: session entry, workspace snapshot, and Git status passed **3 files /
  176 tests**.
- Full unrestricted coverage: **365 files passed / 4 opt-in files skipped; 6,669 tests passed / 20
  intentional opt-in skips**. Aggregate coverage is 97.86% statements/lines, 93.63% branches, and
  99.59% functions. Workspace snapshot remains above its applicable branch floor at 90.56%.
- `pnpm lint`, `pnpm typecheck`, `pnpm format`, `pnpm build`, `pnpm package`, and final diff checks
  pass.
- E3/E4: exact scripts-disabled installed npm carrier, real 80x24 PTYs, spawned production Warden,
  external Click, fresh homes, and retained machine-readable distributions pass. A new screenshot
  would show the same truthful startup frames rather than the temporal improvement, so the retained
  distribution evidence is authoritative.
- E5: **NOT_RUN**. No task reached a provider; every endpoint was loopback-only.

## Five-lens QC

- **Spec compliance:** passes ADR-0043 and issue #127. Trust precedes workspace reads; Warden readiness
  precedes snapshot work; snapshot settlement still precedes every agent-controlled action. Default,
  opt-out, caps, fail-open result, human-only path withholding, and resume semantics are unchanged.
- **Security/adversarial:** no Warden verdict, policy, sandbox, egress, audit, grant, protocol, schema,
  or authority changes. Owner/mode checks, canonical containment, symlink fidelity, excluded Keel
  state, partial-copy cleanup, and whole-`KEEL_HOME` governed denial remain covered. Warden startup
  failure starts no snapshot and leaves no new workspace copy.
- **Reliability/edges:** explicit tests cover the gated order, a backup that settles late, failed
  Warden startup, snapshot opt-out, untrusted and resumed sessions, normal external copy, nested-state
  fallback, cap/failure cleanup, Git cancellation/timeout, detached and unborn repositories, and
  nonblocking input readiness. Both independent carrier distributions pass with complete teardown.
- **DX/usability:** first paint remains about 41 ms p95, input ownership about 8 ms p95, the governed
  status is never shown early, and the Git cockpit signal is retained. Median governed readiness
  falls from the rejected candidate's roughly 625-638 ms range to 576-590 ms.
- **Simplicity/maintainability:** three coherent commits reuse existing seams, add no dependency or
  protocol, retain the reviewed in-source copy path, and delete one redundant Git process. The
  parallel metadata experiment was rejected rather than adding complexity without benefit.

No must-fix remains in local QC. Security claims affected: **none**. ADR needed: **no**; the accepted
ADR-0043 behavior and public issue scope are preserved. P1-007/full-process-group RSS remains a
separate open residual. The official six-workflow usability score remains **4.04/5 candidate** and
**4.02/5 pooled diagnostic** until the strict same-commit replay, rather than gaining points from a
component-only performance fix.

## Cost and Warden audit

All accepted/rejected runs used local builds, local PTYs, local Git, the production local Warden,
and loopback-only endpoints. Incremental Anthropic input/output tokens and spend are zero.
Cumulative spend remains **USD 4.72508650**, USD 15.27491350 remains, and the final USD 2 reserve is
intact. The ambient credential was never read, printed, copied, logged, committed, or captured.

The startup distributions execute no governed task action and request zero human reviews. Issue
#127 adds **0 total / 0 necessary / 0 excessive** Warden interrupts and leaves the historical
dogfood total at **6 total / 2 necessary / 4 excessive or avoidable**.

Publication, exact-head CI, tree-identical merge proof, post-main CI, issue closure, and branch /
worktree / task-root cleanup remain pending.

## First exact-head CI correction

PR CI run `30946149289` exposed one real test-harness flake in the new ordering coverage under its
Node 22 full-suite load. The product assertions did not fail: the test's default one-second
`vi.waitFor` expired before the gated child had written its `warden.hello` marker. The test then
never opened its deliberate gate, so the otherwise-generous 15-second fake-Warden RPC budget later
expired and surfaced as an unhandled rejection. Node-next reported **1 failed / 6,669 passed**.

The correction changes only those two gated-marker waits to a 10-second harness budget. That stays
below the existing 15-second fake-Warden request budget and the suite's 20-second test ceiling; it
does not alter a production timeout, remove an assertion, or relax the required event order. The
complete session-entry file then passed 137/137, format and all workspace/packaging typechecks
passed, and the unrestricted full suite passed **365 files / 6,669 tests / 20 intentional opt-in
skips**. Updated exact-head CI remains pending.
