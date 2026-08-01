# Contributing to keel

## Charter rule (non-negotiable)
There is exactly **one** security architecture, always on. "Regulated mode" is only
a stricter policy pack + the air-gap bundle + documentation. A feature that serves
only one market goes in a policy pack or a doc — **never a fork of the core.**

## Local setup
Node 20+. Enable [Corepack](https://nodejs.org/api/corepack.html) so pnpm matches the
pinned `packageManager` version (the CI installs pnpm explicitly, so this only affects
local dev):
```bash
corepack enable
pnpm install
```

## Branch & PR workflow
Branch off `main` per change (`feat/…`, `fix/…`, `chore/…`), open a PR, and merge only
once CI is green (ground rule 7).

For anything beyond a small fix, read [AGENTS.md](AGENTS.md) first: it is the binding
engineering charter (TDD, the security bar, stop-and-ask triggers, and the completion-
evidence rules every change is held to). Behavior changes start with a failing test;
security-relevant work includes denied-path tests. New security claims map to executable
evidence in [`docs/quality/claim-ledger.md`](docs/quality/claim-ledger.md), or they get
downgraded.

Reviewing the trust plane rather than changing it? The [security review map](docs/guide/reviewing-keel.md)
gives a two-hour path through policy decisions, durable audit writes, and sandbox-profile
projection.

## Ground rules (from MASTER_SPEC §0.1)
1. **TDD is law.** No feature code before a failing test exists for it.
2. **Gates are hard.** Each phase ends with measurable exit criteria; do not start the
   next phase until the current gate passes. Escalate, never silently relax a gate.
3. **The warden RPC interface (Appendix A) is frozen.** Changes need a new protocol
   version + an ADR.
4. **Honesty over impressiveness.** Never claim an enforcement property the code does
   not structurally provide.
5. **No scope creep.** §1.4 lists what is deliberately NOT in v1.
6. **One ADR per significant decision** in `docs/adr/NNNN-title.md`.
7. **Conventional commits**, small PRs, CI green before merge.
8. **Supply-chain rules apply from commit one** (§5.3): committed lockfile,
   `ignore-scripts=true`, pinned exact versions, `pnpm audit` in CI.

## A note on load-sensitive test suites

A handful of warden suites spawn real child processes with handshake timing
budgets (`packages/kernel/src/warden/runtime.test.ts`,
`packages/kernel/src/cli/session-entry.test.ts`,
`packages/kernel/src/cli/git-status.test.ts`,
`packages/warden/src/rpc-server.test.ts`). On a heavily loaded machine the full
`pnpm test` run can fail these files with timeout-shaped errors
("timed out waiting for warden.hello") even though nothing is broken. If you
hit that: re-run the failing file on its own
(`pnpm exec vitest run <file>`); it should pass. CI on clean runners is the
authoritative signal. A red run whose failures all vanish in isolation is load,
not a bug; a failure that reproduces in isolation is a real bug and we want the
report.

### Supply-chain note: minimum release age
Policy: no dependency version younger than 7 days. The root `packageManager` pins
`pnpm@10.16.0`, `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080`, and CI runs
`pnpm run supply-chain:check` to fail closed if that enforcement drifts. Reviewers
still check dependency necessity, license, scripts, native code, network behavior,
and sandbox impact before accepting any dependency addition.
