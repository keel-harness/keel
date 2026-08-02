# Roadmap

**Directional, not a commitment.** This is where keel intends to go and roughly in what
order — not a schedule, and not a promise that any specific item ships. keel follows
"gates, not dates": a capability lands when it is correct, tested, and honestly
provable, not on a calendar. Items move between tiers as we learn.

For what is true *today* — including honest limitations — read the
[architecture one-pager](architecture.md), the [`README.md`](../README.md), and the
[claim ledger](quality/claim-ledger.md). The governing detail lives in
[`MASTER_SPEC.md`](../MASTER_SPEC.md).

## Shipped today

The parts of keel you can rely on now:

- **Kernel / warden split** — the model requests; an out-of-process warden decides. The
  agent cannot perform privileged actions directly.
- **Real sandboxing** — OS-level isolation on macOS (Seatbelt) and Linux (bwrap), with a
  real denied-path test suite in CI.
- **Tamper-evident audit** — a per-session hash chain with Ed25519-signed checkpoints,
  exportable as a signed evidence bundle and verifiable offline.
- **Autonomy postures** — `guided` (default) and `autopilot` / `project-autopilot`, all
  warden-evaluated. Autopilot is high autonomy *inside* enforced boundaries — never an
  enforcement-off switch.
- **Multiple model providers** — Anthropic, OpenAI, Google, and OpenAI-compatible
  endpoints behind a stable `ModelPort`.
- **Session persistence** — append-only session ledgers with `--continue` / `--resume`.
- **Governed tool surface** — governed bash, trusted file tools, and reviewed
  local-stdio MCP route through the warden; unreviewed tools fail closed.
- **Connect-time egress address guard** — the vendored SRT TCP path resolves destinations in the
  warden immediately before each connection, rejects unsafe or mixed answer sets, and pins the
  vetted addresses to the final dial. The claim is backend-specific.

See the [getting-started guide](guide/getting-started.md) for how to use these.

## Now — finishing for the first public release

- **TUI polish** to a "no dead-ends" bar: every surface either works or honestly says it
  is unavailable.
- **A first-class install path** and release packaging.
- **Documentation** newcomers can start from without reading the full spec.

## Next

- **Memory plane** — readable, reviewable, versioned agent memory. Today `packages/memory`
  is an honest placeholder; this is the next major capability.
- **Turn on model routing** — the model gateway already ships in single-model *locked*
  mode behind the frozen `ModelPort`. The next step is populating a multi-model catalog so
  routing can weigh cost and capability — without changing the interface above it.

## Later

- **Custom and org policy** — today the warden enforces one built-in, hash-pinned policy
  pack, tuned per project through grants. The direction is letting teams author their own
  rules, loaded with hash-pinning and a "narrow, never widen" enforcement invariant so a
  pack can only *tighten* the guarantees, never loosen them.
- **Admin-set posture floors** — a way to establish a minimum enforcement posture that a
  local user cannot silently lower, enforced structurally and reported honestly.

## Not planned — deliberate non-goals

Kept here so the boundaries are as clear as the ambitions:

- **Telemetry of any kind** — absent by default, not opt-out. keel does not phone home.
- **Multi-agent orchestration / workflow DAGs** — keel is a single durable agent loop.
- **Hosted / cloud execution** — keel is local-first.
- **Windows-native sandbox enforcement** — WSL2 is the supported path on Windows.
- **A model-selected tool router or intent-classifier stage** — routing decisions are
  governance decisions, not model decisions.

These are not "someday"; they are choices about what keel is. If one changes, it will
change here first, with the reasoning recorded in an ADR.
