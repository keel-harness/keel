# R22 operator diagnostics and safe recovery

Date: 2026-08-04

Public work items:

- validation issue [#116](https://github.com/keel-harness/keel/issues/116);
- observed defect [#117](https://github.com/keel-harness/keel/issues/117);
- implementation [PR #118](https://github.com/keel-harness/keel/pull/118).

## Scope and carriers

R22 exercised seven legitimate operator failure/recovery paths through the exact installed npm
carrier at 100x30 and 80x24. It used owner-only task homes, the repository's real PTY harness,
allowlisted child environments, loopback-only provider fixtures, a spawned production Warden, and
process-group teardown. No provider credential was read, copied into a child, printed, logged, or
captured.

The immutable baseline was main `57bb07f7d8658394868180b338a82b251468c252`, version `0.1.1`,
with tarball SHA-256 `3b4d67bfe3bdc24acf9fe65ce724252c7743ca70c7e0069e5389860447dfc896`.
The exact clean retained candidate was commit `1480b53b235f574b69c1fe422dbe1bdfee224415`,
`keelSource.dirty: false`, version `0.1.1`, with tarball SHA-256
`e68f84f70c45c80af96d9cab66fd13ccffeb8f082d73abedd75e97626dfe162a`.
It installed offline with lifecycle scripts disabled and 57 packages.

## Baseline matrix

| Path | Result at 100x30 and 80x24 | Provider calls | Human reviews | Finding |
| --- | --- | ---: | ---: | --- |
| Missing Anthropic credential | PASS | 0 | 0 | Names `keel auth set anthropic`, the same-`KEEL_HOME` boundary, and exits before session/audit work. |
| Missing ripgrep toolchain | PASS | 0 | 0 | `keel doctor` explains why search needs ripgrep, gives one copyable install fix, and names the doctor rerun. |
| Active session writer | PASS | 0 | 0 | Fails before model work, preserves the live writer, and names exact `keel --continue` recovery. |
| Packaged Warden sibling missing | **FAIL** | 0 | 0 | Fail-closed, path-free, and stack-free, but emitted only `keel: packaged warden entry is unavailable`. |
| Provider returns HTTP 503 | PASS | 3 | 0 | Retries are bounded, the error remains scannable, the composer returns, and retry/continue recovery is visible. |
| Gross-token runway exhausted | PASS | 1 | 0 | Stops the next provider request preflight, retains the successful read, and names `keel --continue`. |
| Mutation presentation unavailable | PASS | 3 | 0 | The governed mutation completes, the UI truthfully says review presentation is unavailable, and suggests version-control/backup inspection without a false undo claim. |

All accepted scenario process groups were reaped. The matrix created no grantable decision and no
human review interrupt. The Warden-unavailable baseline transcript was stable and byte-identical at
both geometries with SHA-256 `04b36bdaac8a173f797287b31639f54f41dc7c83f63fd5adba629ffcebab0bca`.

## Red-first implementation

Issue #117 limited the behavior change to the two controller-owned missing-entry errors in
`resolveProductionWardenStart`. It explicitly excluded fallback resolution, policy, sandbox,
egress, audit, RPC/schema, CLI grammar, dependency, package layout, doctor, and automatic reinstall
changes.

The four negative resolution expectations were first changed to require exact what/why/recovery
copy. The full runtime suite was red with **3 failed / 46 passed** because the old messages lacked
the reason and safe recovery action. After the first implementation, one lowercase-regex assertion
still failed; it was tightened to the exact production message rather than weakened. A later
brevity revision was separately red on all four filtered cases before turning green.

The retained implementation uses three local constants and substitutes two existing throws. It
does not change resolution precedence or control flow. The public packaged diagnostic is 186 bytes
including the `keel:` prefix:

> keel: packaged Warden unavailable — this Keel installation is incomplete, so governed execution
> cannot start; reinstall Keel in the same package-manager scope, then rerun this command

Keel does not invent an exact npm command because the runtime cannot authoritatively distinguish a
local, global, or transient package-manager scope.

## Candidate replay

Removing only the installed candidate's private `bin/keel-warden.mjs` sibling passes at 100x30 and
80x24: exit 1, zero provider requests, zero reviews, no raw stack, no private path, and the complete
safe recovery action. Both sanitized transcripts are byte-identical with SHA-256
`a0f5577f5ea893fc98bafc0475d7bbe37f44dfe8bdbbf2a6aa7df3c39263ac0d`.

An intact-candidate active-writer control at 100x30 also passes. It proves the packaged Warden still
launches, the second process fails before model work, the primary exits cleanly, and the existing
`keel --continue` recovery is unchanged.

Screenshots 59 and 60 are sanitized 1400x840 fixed terminal transcriptions. The in-app browser was
unavailable, so the documented native Quick Look fallback rendered the evidence. They are not
claimed as live-window captures. Screenshot 59 SHA-256 is
`1920351ad70b5a481440b90dc96c78e8a3093b23470c97e341944ab17f33ba07`; screenshot 60 is
`20f7d9d551ea6a3d6af8433813a8d6286303ccc024a7b6e996530e4a33143392`.

## Verification

- focused Warden runtime: **49/49 passed**;
- Warden runtime plus public bin entry: **56/56 passed**;
- `corepack pnpm test:cov`: passed, exit 0, all enforced coverage gates green;
- `corepack pnpm lint`: passed, exit 0;
- `corepack pnpm typecheck`: passed, exit 0;
- `corepack pnpm format`: passed, exit 0;
- `corepack pnpm supply-chain:check`: passed, exit 0;
- `corepack pnpm build && corepack pnpm package`: passed; six package builds, npm carrier, and four
  Bun carriers completed;
- exact installed candidate fault replay: **2/2 geometries passed**;
- intact installed candidate control: **1/1 passed**.

Reviewed head `1480b53` passed exact-head CI run `30900073097`, including DCO, `ci-required`,
build/coverage, package, security, real sandbox, Node-next, egress-scale, and all three installed
egress-product lanes. Owner-authorized admin squash merged PR #118 as `4e774a0`; candidate and merge
share tree `06f2769c0ac4510ada77594172fabbc6f664484d`. Issue #117 closed and the remote feature branch,
local feature branch, and feature worktree were removed.

Exact post-main CI run `30900575475` passed, including `ci-required` job `91965181411`, Linux and
macOS build/coverage, both package lanes, both real-sandbox lanes, audit, security,
cross-architecture carrier smokes, Node-next, egress-scale, and all three installed-product
matrices. The run's GitHub Actions Node-deprecation and untrusted ambient Homebrew-tap annotations
did not fail a job, alter the source, or require a local/global trust change.

## Five-lens QC

- **Spec compliance:** matches the one-line what/why/how recovery contract in `MASTER_SPEC.md`
  section 8.6 and preserves ADR-0082's exact-sibling resolution boundary.
- **Security/adversarial:** planted project-relative, missing-sibling, and unknown-layout cases
  remain fail-closed; no path, argv, environment, policy detail, or new authority is exposed.
- **Reliability/edge cases:** four negative layouts and all positive source, built, packaged, and
  compiled resolution controls pass at both representative geometries.
- **DX/usability:** the dead end becomes actionable without fabricating package-manager scope.
- **Simplicity/maintainability:** three local constants and two throw substitutions; no new
  formatter, dependency, or cross-package abstraction.

There is no unresolved local must-fix. This checkpoint improves an operator diagnostic but is not
one of the six frozen canonical workflow rows, so it does not inflate the official **3.97/5** score
or **3.95/5** pooled diagnostic. R22 made zero Anthropic calls; cumulative spend remains USD
3.43403515.

## Explicit non-green setup evidence

- The fresh worktree's offline dependency install could not find one cached Zod tarball. The
  approved scripts-disabled online reuse succeeded; no dependency or lockfile changed.
- The first `npm pack` tried the unwritable global npm cache. The rerun used an isolated task cache
  and passed; no global configuration changed.
- One restricted outer-sandbox loopback bind returned `EPERM`. The approved unrestricted replay
  passed; this is harness-host permission, not a Keel product pass.
- Early comparator checks were rejected for case, article, whitespace, invalid offset, and recovery
  regex assumptions. Their corrected width-neutral assertions did not relax security or outcome
  requirements.
- One combined broad-gate output stream was lost by the command runner. Every exact command was
  rerun separately and only those recovered exit results are reported green.
