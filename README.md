# keel

A governance-native, open-source agent harness.

<!-- "memory-first" is a roadmap goal, not a shipped feature. The durable memory plane is Phase 3
     and `packages/memory` is a placeholder; kept out of the tagline until it exists (P1-8). -->

keel runs a coding agent behind a wall its governed tool surface cannot talk its way through,
assuming the v1 kernel and OS user are not compromised. The model requests governed actions.
A separate **warden** process decides what runs, under a hash-pinned policy the model cannot
rewrite. Every governed action, allowed or denied, lands in a tamper-evident audit record the
agent cannot write through that tool surface.

The result is high autonomy inside boundaries that hold even when the model is wrong or
adversarially steered.

[![A real keel production TUI session launches, then its warden blocks an SSH private-key read before execution](site/demo.gif)](docs/demo/keel-deny-audit.cast)

_The production TUI and real kernel → warden → policy → audit path. A deterministic offline replay
supplies only the model turns—no provider key or network; [run it locally](docs/demo/run-deny-audit-demo.mjs)._

## What the boundary changes

A separate Warden process is not just an in-process permission check moved behind a prompt. In the
published product, the kernel cannot execute a governed action itself or fall back locally when the
Warden fails. The Warden independently owns policy evaluation, sandbox launch, and authoritative
audit writes. This boundary constrains the model's governed tool surface; it does not defend against
a compromised kernel, same-user malware, or an already-compromised OS account.

- **Trust before parse.** Keel reads no project files—not even `AGENTS.md`—until the user trusts the
  workspace.
- **The model requests; it never approves itself.** It cannot raise its autonomy mode, rewrite the
  hash-pinned policy, grant itself egress, or turn a denial into approval.
- **Intent before effect.** The Warden durably records intent before a side-effecting action begins;
  if that write fails, execution does not start.
- **Real containment gates.** Required Seatbelt and bubblewrap probes fail when the backend is
  unavailable instead of passing by skipping.
- **Connect-time egress checks.** On the governed SRT TCP path, the Warden resolves, classifies, and
  pins the destination immediately before connecting.
- **Current governed surface.** `bash`, trusted direct-argv `process.run`, the typed
  `read`/`search`/`write`/`edit` tools, trusted `lifecycle.run`, and reviewed local-stdio MCP all
  route through the Warden; the publication tools below are narrower still.
- **Typed publication authority.** `git.push` binds one approved repository, feature branch, and
  exact commit. `github.pr.create` is a distinct capability with a separate once-only approval.
- **Autopilot is not YOLO.** It can remove prompts only inside boundaries the Warden still enforces.

Keel vendors Anthropic's [`@anthropic-ai/sandbox-runtime`](NOTICE) v0.0.59 under Apache-2.0 to
orchestrate Seatbelt and bubblewrap. Keel adds the out-of-process Warden, policy mediation,
tamper-evident audit path, and connect-time address guard described in
[ADR-0005](docs/adr/0005-vendoring-sandbox-runtime.md).

## Quickstart

Apache-2.0 · Node 20+ · macOS or Linux (WSL2 on Windows) · no telemetry.

```bash
npm i -g keel-harness        # or run any command below as: npx keel-harness <command>
keel doctor                  # environment preflight
keel auth set <provider>     # choose a provider and securely store its key
export KEEL_PROVIDER=<provider>
export KEEL_MODEL=<model-id>
keel                         # start an interactive session
```

The angle-bracketed names are placeholders. Choose a supported provider and model from the
[getting-started guide](docs/guide/getting-started.md). Keel supports multiple provider adapters,
including OpenAI-compatible endpoints; setting both values explicitly makes the launch choice clear
and reproducible. The detailed [reference](docs/guide/reference.md) records every supported value,
provider-specific requirement, and the documented fallback when these variables are omitted.

The global or `npx` install above is the product path. A source checkout is for contributing and
development:

```bash
corepack enable && pnpm install
pnpm test
pnpm typecheck && pnpm lint && pnpm format
```

Do not treat `pnpm keel` pointed at Keel's own source tree as an enforcement demonstration: the
governed workspace could rewrite the Warden/runtime bytes it is testing, and `keel doctor` reports
that reduced-enforcement layout. The released carrier requires Node 20+ and ripgrep; its CI matrix
tests Node 20, 22, and 24. `keel doctor` checks the OS sandbox and prints one copy-paste fix when
something is missing.

New here: [getting started](docs/guide/getting-started.md) · [what keel is](docs/architecture.md)
· [the honest security model](docs/guide/security-model.md) ·
[status and limitations](docs/status.md).

> **PRE-ALPHA / AI-ASSISTED:** Keel is a solo-maintained AI-assisted personal learning project and
> executable security reference, not a feature-complete replacement for mature general-purpose
> coding agents. The maintainer defined the architecture, threat model, contracts, and evidence
> gates; AI assisted extensively with implementation, tests, review, and documentation. Structural
> enforcement is limited to the governed tool surface under the documented trust assumptions. Keel
> has not been independently audited, still has bugs, and should not be used for production,
> mission-critical, business-critical, or sensitive work.

## Evidence

Where the claims stand, and how to verify them yourself:

| What | Where it stands | Reproduce |
| --- | --- | --- |
| Real OS sandbox | Seatbelt (macOS) + bubblewrap (Linux) denial probes gate CI; an unavailable backend fails instead of skipping | `pnpm test:sandbox:real` |
| Connect-time egress guard | The vendored SRT TCP backend resolves, checks, and pins every destination before a new connection | `pnpm test:egress-product` |
| Audit integrity | tamper-evident hash chain + Ed25519 checkpoints (local `0600` key, readable by the same OS user) + offline evidence-bundle verifier | `keel audit verify <bundle>` |
| Security suite | 1,123 adversarial / denied-path tests passed | `pnpm test:security` |
| Tests | 7,528 automated tests passed; 37 skipped | `pnpm test` |
| Coverage | 97.79% statements / 93.58% branches, enforced gate (per-file ≥90%; warden ≥95% lines/functions/statements) | `pnpm test:cov` |
| Capability benchmarks | TerminalBench numbers with full caveats: single-trial, subset, sandbox-off | [docs/benchmarks.md](docs/benchmarks.md) |

**Connect-time egress guard.** A hostname grant is not enough to open a socket. On the vendored SRT
TCP backend, the warden resolves the destination immediately before each new connection, rejects the
whole answer set if any address is unsafe or not covered by a narrow operator exception, and pins the
vetted set to the final dial. This scope does not include provider API calls, UDP/QUIC, or alternate
sandbox backends; see the [security model](docs/guide/security-model.md) and
[ADR-0086](docs/adr/0086-warden-owned-egress-address-guard.md).

The published TerminalBench comparison is a single trial over a 59-task subset with governance and
the OS sandbox disabled to isolate harness quality. It is not a security result or evidence that
enforcement has zero capability cost. Keel has not completed a comparable end-to-end measurement of
per-action Warden overhead, so it makes no general latency claim.

Test and coverage figures were measured on 2026-08-14 at commit
[`b6d9434`](https://github.com/keel-harness/keel/commit/b6d9434fd4961bc4ba87d23396edf0f581b0841c).
Exact values, fractions, commands, and the staleness window live in the
[evidence-number ledger](docs/quality/evidence-numbers.json).

## Status

**keel is pre-alpha and publicly available.** `keel-harness@0.1.2` is published on npm and
tagged `latest`, with a matching [GitHub Release](https://github.com/keel-harness/keel/releases/tag/v0.1.2),
but this is **not a stable or public-alpha release**.

Keel is currently solo-maintained and has not received an independent security audit. Treat its
tests, claim ledger, and reproducible evidence as material for review, not as a substitute for one.

The public Git history begins with an import snapshot from 2026-07-30; earlier development rationale
is preserved in the ADR and dated design/research archives. Subsequent public work retains ordinary
commit and pull-request history. This project uses the `keel-harness` package, organization, and
domain names and is unrelated to other software named Keel.

Governed mode covers `bash`, capability-negotiated trusted direct-argv `process.run`, the trusted typed
file tools (`read`, `search`, `write`, `edit`), trusted `lifecycle.run` validation actions lowered to
governed bash, and reviewed, pinned local-stdio MCP calls through the spawned Warden. `process.run`
accepts one literal argv vector for a direct executable; it does not add shell composition,
environment, cwd, stdin, or background authority. The MCP proof is deliberately narrow: remote,
localhost, and unreviewed MCP transports, general plugin/registry APIs, reusable grants, and MCP
resources, prompts, sampling, and elicitation are not claimed. Session-helper/internal surfaces such
as `plan`, `skill`, and `retrieve`, provider API calls, and future tools are likewise not counted as
governed product execution proof.

The published `keel-harness@0.1.2` carrier includes two bounded publication paths for trusted interactive macOS/Linux
sessions. With Git 2.x (2.39 or newer), typed `git.push` can create or fast-forward one non-default
feature branch to one approved full commit OID over canonical HTTPS, through `srt:vendored` verified
TLS and connect-time address guarding. The Warden offers both publication tools only when
`srt-launch-authority/v1` establishes unique authenticated proxy endpoints and an immutable
credential/configuration snapshot for that launch; cleanup revokes and drains that authority.
Exact deny-all launches receive no proxy endpoint or credential authority at all; the immutable OS
sandbox profile is endpointless and network-denied.
After that head exists on GitHub.com, a separate typed
`github.pr.create` request can create one same-repository pull request with an exact title, body,
base, head OID, draft flag, and maintainer-modification flag. Each occurrence has its own complete,
once-only human approval; push approval never authorizes PR creation.

The Warden resolves an operator system/global Git credential helper without exposing its value,
records intent before either mutation, and independently verifies the resulting ref or pull request.
`keel doctor` checks only that the helper command has eligible system/global authority; it does not
look up or promise a path-scoped credential. If either publication tool reports
`credential-unavailable` before review or after approval, run
`gh auth login --git-protocol https && gh auth setup-git && keel doctor`, then submit a fresh request.
Force, deletion, tags, default-branch push, SSH, redirects, project credential helpers, reusable
grants, cross-repository PRs, arbitrary forge APIs, merge/auto-merge, labels, reviews, releases,
deployments, and automatic retry remain blocked. Raw `process.run git push` remains terminal.
The compact V2 registry makes the 25,536-port range—not serialized JSON size—the first bound and
permanently excludes retired network-bearing endpoints until a deliberate future migration. Exhausting
that finite space withholds publication rather than reusing authority; endpointless offline execution
remains available.

The npm and GitHub `0.1.2` tarballs are byte-identical to the inspected staged candidate. Current
source adds two fail-closed reliability/DX corrections that are not in `0.1.2`: expected credential-
broker readiness failures get actionable recovery, and GitHub's same-repository
`maintainerCanModify: false` normalization is accepted only after every consequential field verifies.
On `0.1.2`, those provider cases can surface as an internal or indeterminate result; do not retry
automatically—inspect GitHub and the audit record first.

**[docs/status.md](docs/status.md) is the full account** — every limitation, the audit and signing
boundaries, the release flow, and a note on running the test suite locally. Read it before you
rely on any claim here.

## Autonomy (Autopilot is not YOLO)

Autonomy in keel is a set of **policy postures over the warden's enforcement**, not a promise
about how the model behaves. In every mode the model can only *request*; the out-of-process
**warden decides** under a hash-pinned policy the model cannot rewrite.

- **Guided** (default): in an interactive terminal session, consequential actions may pause for your
  approval; the warden still enforces.
- **Autopilot**: the model acts *without a prompt*, but only for actions the warden has already
  proven contained and low-risk. It never lets the model declare itself safe, raise its own mode,
  change policy, or turn a `deny` into an `allow`. Boundary expansion still routes to review.

Existing scoped authority, such as an exact session or Plan grant or an eligible Autopilot rule,
may resolve a review before any prompt. If a one-shot `keel run -p` still needs a live human
decision, keel cannot ask: it attempts to close the review as denied and exits nonzero. A confirmed
denial means the action did not run. A failed or indeterminate settlement is labeled; do not retry
automatically, and inspect the audit record.

"YOLO" means reduced or absent enforcement. keel never conflates the two in the UI, receipts, or
docs. See the [policy guide](docs/guide/policy-guide.md) for modes, approvals, and grant scopes.

## Configuration

All optional, with sensible defaults. The most common:

| Variable | What it does | Default |
| --- | --- | --- |
| `KEEL_PROVIDER` | Model provider: `anthropic` · `openai` · `google` · `openai-compatible`. | `anthropic` |
| `KEEL_MODEL` | Model id (required for non-Anthropic providers). | pinned Anthropic Sonnet |
| `KEEL_MAX_TOKENS` | Per-run effective-cost token cap (the primary spend ceiling). Cached input is discounted, so this is cost-true, not a raw-token count. | unset |
| `KEEL_MAX_TURNS` | Hard cap on agent loop turns. Not a spend cap; pair with a token cap. | 50 |
| `KEEL_MAX_WALL_SEC` | Wall-clock budget in seconds; keel self-stops gracefully with a `deadline` outcome. | unset |
| `KEEL_HOME` | Where keel stores sessions, audit, and config. | `$XDG_CONFIG_HOME/keel`, else `~/.config/keel` |

The full list, including budget, compaction, verification, and tool-behavior knobs, is in
the [reference](docs/guide/reference.md).

## Documentation

- [docs/architecture.md](docs/architecture.md) is the one-page tour.
- [docs/guide/](docs/guide/) holds the guides: getting started, concepts, reference,
  policy and approvals, untrusted repos, the security model, and audit and sessions.
- [docs/status.md](docs/status.md) is what is and is not true today.
- [docs/quality/claim-ledger.md](docs/quality/claim-ledger.md) maps every security claim to
  its evidence and honest limits.
- [docs/README.md](docs/README.md) is the full index, by audience.

Going deeper: [`MASTER_SPEC.md`](MASTER_SPEC.md) is the full governing spec and
[`AGENTS.md`](AGENTS.md) is the engineering charter.

## Develop

Contributor CI tests Node 20, 22, and 24. pnpm is pinned via the `packageManager` field. Enable
[Corepack](https://nodejs.org/api/corepack.html) so you get the exact version. If the `corepack`
command is unavailable — including on Node 25+ by default — install Corepack separately first; do
not silently substitute an unpinned pnpm:

```bash
corepack enable   # pins pnpm to the version in package.json
pnpm install
pnpm test:cov     # unit + property tests + coverage gate
pnpm typecheck && pnpm lint && pnpm format
```

The repository layout is described in the
[architecture deep-dive](docs/guide/architecture.md#repository-layout).

`pnpm package` builds the npx package and the self-contained binaries into `build/`. Bun is a
build/CI-only tool; development and tests use Node/pnpm/vitest (ADR-0009).

License: Apache-2.0.
