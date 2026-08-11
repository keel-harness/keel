# Status and limitations

keel is **pre-alpha**. This page states what keel enforces today, what is published, and what
is not claimed. It is the long form of the status summary in the [`README.md`](../README.md).

The [claim ledger](quality/claim-ledger.md) maps each individual claim to the test that proves
it. Where this page and the ledger disagree, the ledger wins.

## Release status

`keel-harness@0.1.1` is published on npm and tagged `latest`. It was published on
2026-08-03. The package runs `keel --version` and `keel doctor` on Node 20.

Two earlier versions are not release carriers:

| Version | State |
| --- | --- |
| `0.1.0` | Staged on 2026-08-01 but never approved, so it never became public. The registry has no `0.1.0` tarball. |
| `0.0.1` | The original name-reservation placeholder. Superseded by `0.1.1`. |

This is **not a stable or public-alpha release**. It is a pre-alpha carrier published during
open-source preparation. Expect breaking changes.

Standalone Bun binaries remain test-only. ADR-0040 holds them back pending a review of linked
LGPL components. Every npm publication follows the staged, human-approved flow in the
[release runbook](guide/releasing.md): protected stage-only OIDC, staged-byte inspection, human
2FA approval, and live-registry verification. CI never publishes on its own.

## What keel governs today

The default `keel` CLI routes these actions through the out-of-process warden for policy checks,
sandbox and profile checks, and per-session audit:

- governed `bash`;
- capability-negotiated trusted direct-argv `process.run`;
- the trusted `read`/`search`/`write`/`edit` file tools;
- `lifecycle.run`;
- reviewed, pinned local-stdio MCP calls, under the bounded ADR-0084 contract;
- in current source, typed `git.push` for one once-only human-approved HTTPS feature-branch create or
  fast-forward in a trusted interactive macOS/Linux session;
- in current source, typed `github.pr.create` for one separately approved, same-repository GitHub.com
  pull request after the exact remote head is independently verified.

Phase 2B signed, offline-verifiable evidence bundles are implemented for exported audit evidence.

`process.run` accepts one bounded literal argv vector and routes it through Warden policy, the
existing broad process sandbox profile, and intent/outcome audit. It adds no shell interpolation,
model-controlled environment, working directory, stdin, or background authority, and does not make
the invoked executable inherently safe. Its live-model efficacy remains `NOT_RUN`; the shipped
evidence proves the governed product path, not that arbitrary models will choose it effectively.

`git.push` is deliberately narrower than a generic Git command. It binds one canonical HTTPS
repository, one exact non-default `refs/heads/*` destination, and one full commit OID; runs supported
Git 2.x (2.39 or newer) through `srt:vendored` verified TLS and the active address guard; and uses only operator
system/global credential-helper authority. Force, deletion, tags, default-branch push, SSH,
redirects, project helpers, reusable grants, and automatic retry are unavailable. Raw
`process.run git push` remains terminal. Indeterminate attempts require a restart followed by
independent remote-ref and audit inspection before a deliberate fresh request.

`github.pr.create` is a distinct authority, not a continuation of push approval. It binds the
canonical GitHub.com repository, current local branch and full SHA-1 OID, remote head and base,
title, body, draft state, and maintainer-modification flag into a separate lossless once-only review.
After approval, the Warden obtains a Bearer credential from the password field of the same
system/global Git credential-helper boundary, performs fixed GitHub REST preflights through
`srt:vendored`, sends at most one create request, and independently observes the exact pull request.
An exact existing PR is reported without mutation. Results distinguish `created`, `already-exists`,
`failed`, and `indeterminate`; there is no automatic retry.

The PR path is same-repository and GitHub.com-only. It does not support GitHub Enterprise, forks or
cross-repository heads, generic forge APIs, `gh`, combined push-and-PR approval, merge/auto-merge,
labels, assignees, reviewers or reviews, comments, releases, deployments, or branch mutation.
Repository permissions and protected-branch behavior remain server-enforced.

This describes current source, not the published `keel-harness@0.1.1` bytes, which predates both
typed publication capabilities. Published-carrier proof remains release-gated.

## What keel does not claim

**MCP.** The MCP proof is deliberately narrow. Reviewed, pinned local-stdio MCP calls route
through the spawned Warden. Remote, localhost, and unreviewed MCP transports are not claimed.
General plugin and registry APIs, reusable grants, and MCP resources, prompts, sampling, and
elicitation are not claimed either.

**Not counted as governed product execution proof.** Session-helper and internal surfaces such as
`plan`, `skill`, and `retrieve` do not count. Neither do arbitrary provider API calls or future
tools; only the bounded `github.pr.create` GitHub REST path above is included.

**Not built.** The following are roadmap items, not shipped features:

- provider API egress governance beyond the bounded `github.pr.create` path;
- remote, localhost, and unreviewed MCP;
- general plugin and registry governance;
- forge mutations beyond the bounded same-repository GitHub.com pull-request creation above;
- Phase-3 provenance;
- the durable "memory-first" plane — `packages/memory` is a placeholder, a Phase-3 roadmap goal;
- public compliance and full resource containment;
- a macOS audit-latency pass;
- a comparable live TB-2/TB-2.1 benchmark.

## Audit and signing limits

The audit chain is tamper-**evident**, not tamper-proof. It detects modification, deletion, and
reordering after the fact. It does not prevent them.

The checkpoint-signing key is an at-rest `0600` file readable by the same OS user. Bundle
verification proves "signed by that key," not "signed by an actor independent of the audited
host." Bundle authenticity still requires comparing the signer key with a published or
out-of-band signer key.

OS-keychain and hardware-backed/TPM key custody are future hardening and are not implemented.

Audit integrity does not guarantee that keel classified an action correctly. Integrity and
semantic accuracy are separate properties.

## Connect-time egress scope

The warden checks the resolved address before each new TCP connection on the vendored SRT
backend. See the [security model](guide/security-model.md) and
[ADR-0086](adr/0086-warden-owned-egress-address-guard.md) for the mechanism.

This scope does not include provider API calls, UDP/QUIC, or alternate sandbox backends.

## Platforms

Linux and macOS are the tested platforms, and CI runs both. Native Windows is unsupported. WSL2
is the supported path on Windows.

## Running the test suite locally

A few warden and TUI suites spawn real child processes under wall-clock handshake budgets. On a
busy or high-core machine, the full run can report timeout-shaped failures such as "timed out
waiting for warden.hello" while nothing is broken. Vitest scales its worker count to your CPU
count, and each worker spawns child processes of its own.

Re-run any failing file on its own with `pnpm exec vitest run <file>`; it should pass. **CI on
clean runners is the authoritative signal.**

A failure that still reproduces in isolation is a real bug, and we want the report. See
[CONTRIBUTING.md](../CONTRIBUTING.md#a-note-on-load-sensitive-test-suites).
