# keel

A governance-native, open-source agent harness.

<!-- "memory-first" is a roadmap goal, not a shipped feature. The durable memory plane is Phase 3
     and `packages/memory` is a placeholder; kept out of the tagline until it exists (P1-8). -->

keel runs a coding agent behind a wall its governed tool surface cannot talk its way through,
assuming the v1 kernel and OS user are not compromised. The model requests governed actions;
a separate **warden** process decides what runs, under a hash-pinned policy the model cannot
rewrite. Every governed action, allowed or denied, lands in a tamper-evident audit record the
agent cannot write through that tool surface. The result is high autonomy inside boundaries
that hold even when the model is wrong or adversarially steered.

```bash
corepack enable && pnpm install
pnpm keel doctor                    # environment preflight
pnpm keel auth set anthropic        # paste your API key (stored 0600, never echoed)
pnpm keel run -p "fix the failing test in src/foo.ts"
```

New here: [what keel is](docs/architecture.md) · [getting started](docs/guide/getting-started.md)
· [the honest security model](docs/guide/security-model.md).

> **DISCLAIMER:** This note is the only thing in this repo that was not written by or with AI -
> while keel aspires to be one of the most secure agent harnesses available, it should not be
> used for mission or business critical applications until/unless vetted rigorously by the OSS
> community. My goals in building keel were to 1) learn more about harness engineering, and 2)
> attempt to address a gap I saw in the harness market vis a vis native runtime security that
> cannot be circumvented by an LLM. As such, this harness is also likely not for users who
> prefer to run agents fully on 'auto' mode - while we do have an Autopilot mode that reduces
> agent / human interrupts, this harness aims to solve a different problem and is much more
> human-in-the-loop centric by design.

## Evidence

Where the claims stand, and how to verify them yourself:

| What | Where it stands | Reproduce |
| --- | --- | --- |
| Tests | 6,072 automated tests passed; 12 skipped | `pnpm test` |
| Coverage | 97.89% statements / 93.74% branches, enforced gate (per-file ≥90%; warden ≥95% lines/functions/statements) | `pnpm test:cov` |
| Security suite | 990 adversarial / denied-path tests passed | `pnpm test:security` |
| Real OS sandbox | Seatbelt (macOS) + bubblewrap (Linux) denial probes run in CI | `pnpm test:sandbox:real` |
| Audit integrity | tamper-evident hash chain + Ed25519 checkpoints (local `0600` key, readable by the same OS user) + offline evidence-bundle verifier | `keel audit verify <bundle>` |
| Capability benchmarks | TerminalBench numbers with full caveats: single-trial, subset, sandbox-off | [docs/benchmarks.md](docs/benchmarks.md) |

The checkpoint-signing key is an at-rest `0600` file readable by the same OS user. Bundle
verification proves "signed by that key," not "signed by an actor independent of the audited
host." OS-keychain and hardware-backed/TPM custody are future hardening and are not implemented.

Test and coverage figures were measured on 2026-07-31 at commit
[`a22b127`](https://github.com/keel-harness/keel/commit/a22b127fd37858920d006205758e46cd037e8565).
Exact values, fractions, commands, and the staleness window live in the
[evidence-number ledger](docs/quality/evidence-numbers.json).

> **Running `pnpm test` locally?** A handful of warden and TUI suites spawn real child processes
> under wall-clock handshake budgets, so on a busy or high-core machine the full run can report
> timeout-shaped failures ("timed out waiting for warden.hello") while nothing is actually broken —
> vitest scales its worker count to your CPU count, and each worker spawns children of its own.
> Re-run any failing file on its own (`pnpm exec vitest run <file>`); it should pass. **CI on clean
> runners is the authoritative signal.** A failure that still reproduces in isolation is a real bug
> and we want the report — see [CONTRIBUTING.md](CONTRIBUTING.md#a-note-on-load-sensitive-test-suites).

> **Status: pre-alpha; open-source preparation.** The default `keel` CLI routes governed
> `bash` plus trusted `read`/`search`/`write`/`edit` actions through the out-of-process warden for
> policy, sandbox/profile checks, and per-session audit. Phase 2B signed offline evidence bundles are
> implemented for exported audit evidence. Reviewed, pinned local-stdio MCP calls also route through
> the spawned Warden under the bounded ADR-0084 contract. This is **not a stable or public-alpha
> release**: provider API egress; remote, localhost, and unreviewed MCP; general plugin/registry
> governance; Phase-3 provenance; **the durable "memory-first" plane
> (`packages/memory` is a placeholder, a Phase-3 roadmap goal, not built)**, public compliance, full
> resource containment, a macOS audit-latency pass, and a comparable live TB-2/TB-2.1 benchmark are
> not claimed. Bundle authenticity
> still requires comparing the signer key with a published or out-of-band signer key.

## Requirements

Node 20+ and ripgrep. `pnpm keel ...` runs the agent straight from source. Linux and
macOS are the tested platforms (CI runs both); native Windows is unsupported, and WSL2
is the supported path on Windows. `keel doctor` checks the OS sandbox (`bubblewrap`/`socat`
on Linux, `sandbox-exec` on macOS) and prints one copy-paste fix per platform when
something is missing.

Governed mode covers `bash`, the trusted typed file tools (`read`, `search`, `write`, `edit`), and
reviewed, pinned local-stdio MCP calls through the spawned Warden. The MCP proof is deliberately
narrow: remote, localhost, and unreviewed MCP transports, general plugin/registry APIs, reusable
grants, and MCP resources, prompts, sampling, and elicitation are not claimed. Session-helper/internal
surfaces such as `plan`, `skill`, and `retrieve`, provider API calls, and future tools are likewise
not counted as governed product execution proof.

## Documentation

- [docs/architecture.md](docs/architecture.md) is the one-page tour.
- [docs/README.md](docs/README.md) is the full index, by audience.
- [docs/guide/](docs/guide/) holds the guides: getting started, concepts, reference,
  policy and approvals, untrusted repos, the security model, and audit and sessions.
- [docs/quality/claim-ledger.md](docs/quality/claim-ledger.md) maps every security claim to
  its evidence and honest limits.

Going deeper: [`MASTER_SPEC.md`](MASTER_SPEC.md) is the full governing spec and
[`AGENTS.md`](AGENTS.md) is the engineering charter.

## Autonomy (Autopilot is not YOLO)

Autonomy in keel is a set of **policy postures over the warden's enforcement**. Not promises
about how the model behaves. In every mode the model can only *request*; the out-of-process
**warden decides** (execute vs. deny) under a hash-pinned policy the model cannot rewrite.

- **Guided** (default): consequential actions pause for your approval; the warden still enforces.
- **Autopilot**: the model acts *without a prompt*, but **only for actions the warden has already
  proven contained and low-risk**. Autopilot never lets the model declare itself safe, raise its own
  mode, change policy, or turn a `deny` into an `allow`; it only removes the prompt for actions
  enforcement already permits. A human sets the mode; every change is audited.

**Autopilot ≠ YOLO.** Autopilot is *high autonomy inside enforced boundaries*. "YOLO" means *reduced
or absent enforcement*. keel never conflates the two in the UI, receipts, or docs. Because the modes
are postures *over* enforcement, they are honest only once the warden is enforcing; where there is
nothing structural behind a posture the status line says so plainly rather than showing a trust word.

## Configuration (environment)

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

## Packaging (npx release carrier + binary build mechanism)

```bash
pnpm package        # → build/bin/ (bun --compile binaries) + build/npx/ (the npm package)
```

The build produces an `npx`-installable package and mechanically testable self-contained binaries
(macOS arm64/x64, Linux x64/arm64). Both paths are smoke-tested in CI (`--version`, `doctor`, a
hermetic one-task run). The compiled binary uses your system ripgrep; the npx package bundles its
own. Bun is a build/CI-only tool; development and tests use Node/pnpm/vitest (ADR-0009).

The graph-audited `0.1.0` npx package is the current release-eligible carrier. Epic 3.21 adds its
public package identity, exact shrinkwrap, deterministic one-pack candidate builder, SPDX and
CycloneDX closure checks, and a tag-only, stage-only OIDC workflow. The same candidate tarball has
passed isolated pnpm global/dlx, doctor, replay, Warden, and pre-trust `.env` probes on the pinned
Node 20, 22, and 24 lines. That proves release readiness, not publication: the workflow has not run
from the public repository and no real package has been staged or approved.

Standalone Bun-compiled
binaries are **not release-eligible** pending explicit review of Bun's linked LGPL components and
relinking obligations; CI builds and exercises them as test mechanisms but does not upload or publish
the executables. See ADR-0040. The registry's current `keel-harness@0.0.1` is a name-reservation
placeholder; do not use it as the release carrier. A real public npx carrier remains gated on the
curated public repository, protected release configuration, staged-byte inspection, human 2FA
approval, and live-registry verification. The source-checkout commands above remain the supported
path during open-source preparation. See the [release runbook](docs/guide/releasing.md).

## Layout
- `packages/kernel`: the agent: loop, five tools, providers, sessions, TUI, context, CLI
- `packages/shared`: frozen RPC/audit/memory/policy/simulator schemas (zod)
- `packages/simulator`: scripted ModelPort for deterministic tests
- `packages/eval`: benchmark runner wrapper + trajectory store
- `packages/warden`: warden RPC, policy/sandbox mediation, audit, and evidence bundles
- `packages/memory`: placeholder for later Phase 3 memory work
- `docs/`: ADRs, design notes, research + source ledger

## Develop

Requires Node 20+. pnpm is pinned via the `packageManager` field. Enable
[Corepack](https://nodejs.org/api/corepack.html) so you get the exact version:

```bash
corepack enable   # pins pnpm to the version in package.json
pnpm install
pnpm test:cov     # unit + property tests + coverage gate
pnpm typecheck && pnpm lint && pnpm format
```

License: Apache-2.0.
