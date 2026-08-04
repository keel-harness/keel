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

[![A real keel session: the warden denies an SSH-key read and writes the audit record](site/demo.gif)](docs/demo/keel-deny-audit.cast)

_Recorded from the real kernel → warden → policy → audit path. A deterministic offline replay
supplies only the model turns; [run it locally](docs/demo/run-deny-audit-demo.mjs)._

## Quickstart

```bash
npm i -g keel-harness        # or run any command below as: npx keel-harness <command>
keel doctor                  # environment preflight
keel auth set anthropic      # paste your API key (stored 0600, never echoed)
keel                         # start an interactive session
```

To run from a source checkout instead:

```bash
corepack enable && pnpm install
pnpm keel doctor
pnpm keel run -p "fix the failing test in src/foo.ts"
```

Node 20+ and ripgrep are required. `keel doctor` checks the OS sandbox and prints one
copy-paste fix when something is missing.

New here: [what keel is](docs/architecture.md) · [getting started](docs/guide/getting-started.md)
· [the honest security model](docs/guide/security-model.md) ·
[status and limitations](docs/status.md).

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
| Connect-time egress guard | The vendored SRT TCP backend resolves, checks, and pins every destination before a new connection | `pnpm test:egress-product` |
| Audit integrity | tamper-evident hash chain + Ed25519 checkpoints (local `0600` key, readable by the same OS user) + offline evidence-bundle verifier | `keel audit verify <bundle>` |
| Capability benchmarks | TerminalBench numbers with full caveats: single-trial, subset, sandbox-off | [docs/benchmarks.md](docs/benchmarks.md) |

**Connect-time egress guard.** A hostname grant is not enough to open a socket. On the vendored SRT
TCP backend, the warden resolves the destination immediately before each new connection, rejects the
whole answer set if any address is unsafe or not covered by a narrow operator exception, and pins the
vetted set to the final dial. This scope does not include provider API calls, UDP/QUIC, or alternate
sandbox backends; see the [security model](docs/guide/security-model.md) and
[ADR-0086](docs/adr/0086-warden-owned-egress-address-guard.md).

Test and coverage figures were measured on 2026-07-31 at commit
[`a22b127`](https://github.com/keel-harness/keel/commit/a22b127fd37858920d006205758e46cd037e8565).
Exact values, fractions, commands, and the staleness window live in the
[evidence-number ledger](docs/quality/evidence-numbers.json).

## Status

**keel is pre-alpha, in open-source preparation.** `keel-harness@0.1.1` is published on npm and
tagged `latest`, but this is **not a stable or public-alpha release**.

Governed mode covers `bash`, capability-negotiated trusted direct-argv `process.run`, the trusted typed
file tools (`read`, `search`, `write`, `edit`), and reviewed, pinned local-stdio MCP calls through the
spawned Warden. `process.run` accepts one literal argv vector for a direct executable; it does not add
shell composition, environment, cwd, stdin, or background authority. The MCP proof is deliberately
narrow: remote, localhost, and unreviewed MCP transports, general plugin/registry APIs, reusable
grants, and MCP resources, prompts, sampling, and elicitation are not claimed. Session-helper/internal
surfaces such as `plan`, `skill`, and `retrieve`, provider API calls, and future tools are likewise
not counted as governed product execution proof.

**[docs/status.md](docs/status.md) is the full account** — every limitation, the audit and signing
boundaries, the release flow, and a note on running the test suite locally. Read it before you
rely on any claim here.

## Autonomy (Autopilot is not YOLO)

Autonomy in keel is a set of **policy postures over the warden's enforcement**, not a promise
about how the model behaves. In every mode the model can only *request*; the out-of-process
**warden decides** under a hash-pinned policy the model cannot rewrite.

- **Guided** (default): consequential actions pause for your approval; the warden still enforces.
- **Autopilot**: the model acts *without a prompt*, but only for actions the warden has already
  proven contained and low-risk. It never lets the model declare itself safe, raise its own mode,
  change policy, or turn a `deny` into an `allow`.

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

Requires Node 20+. pnpm is pinned via the `packageManager` field. Enable
[Corepack](https://nodejs.org/api/corepack.html) so you get the exact version:

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
