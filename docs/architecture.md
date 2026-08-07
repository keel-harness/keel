# keel architecture — the one-page tour

A newcomer's map of how keel is put together. For the full governing spec see
[`../MASTER_SPEC.md`](../MASTER_SPEC.md) (deep — read it after this); for the engineering
rules see [`../AGENTS.md`](../AGENTS.md); for the doc index see [`README.md`](README.md).

## The core idea

keel is a **governed agent harness**: the model may *request* actions, but a separate,
out-of-process **warden** decides whether they run. Enforcement is **structural, not
behavioral** — it does not depend on trusting how the model behaves. The warden owns policy,
sandboxing, egress, and the tamper-evident audit record; the kernel (which holds the model
conversation) can only ask.

```
┌──────────────────────────┐         JSON-RPC over stdio          ┌────────────────────────────┐
│  kernel  (@keel/kernel)  │  ── warden.execute(request) ──▶      │  warden  (@keel/warden)    │
│  the agent loop + tools  │                                      │  the enforcement plane     │
│  + TUI + sessions + CLI  │  ◀── verdict + result ─────────      │  policy · sandbox · egress │
│  "the model's world"     │                                      │  · audit chain             │
└──────────────────────────┘                                      └────────────────────────────┘
  the model can only REQUEST                                      the warden DECIDES (allow / deny / modify)
```

## The two processes

- **kernel (`packages/kernel`)** — the thin agent loop, the core tools (read · search · write ·
  edit · bash · `process.run`), the model-provider adapters, the session ledger, the TUI, context
  discipline, and the CLI. `process.run` accepts one bounded literal argv vector; it adds no shell,
  environment, working-directory, stdin, or background authority. The kernel holds the model
  conversation and the provider API keys, so it is *inside* the trust boundary for credential
  access — but it has no path to execute a governed tool directly; every such action flows through
  `warden.execute`.
- **warden (`packages/warden`)** — the enforcement plane, in its own process. It evaluates a
  hash-pinned policy pack, owns governed execution, mediates network egress, checks the resolved
  address used by supported TCP connections, and writes the audit chain. `bash` and `process.run`
  launch through the OS sandbox; `write` and `edit` use a contained mutation helper on the enforcing
  Node/npm path; `read` and `search` are Warden-hosted guarded implementations, not equivalent
  physical-sandbox claims. The model cannot alter policy, because policy is not part of the model's
  writable world.

Shared, frozen contracts (RPC, audit, session, policy schemas) live in `packages/shared`;
`packages/simulator` is a scripted model for deterministic tests; `packages/eval` is the
benchmark runner; `packages/memory` is a placeholder for the future Phase-3 memory plane.

## Stable seams (ports)

Volatile dependencies sit behind stable interfaces so implementations can be swapped without
changing contracts: **ModelPort**, **UIPort**, **PolicyPort**, **SandboxPort**, **ExecutorPort**.
This is what makes a future Rust warden or a native sandbox backend a drop-in rather than a
rewrite.

## Egress is checked at the final dial

For governed TCP egress through the vendored SRT backend, allowing a hostname is only the first
gate. Before every new connection, the warden:

1. resolves the requested hostname;
2. classifies every returned address;
3. denies the whole attempt if any answer is unsafe, malformed, or not covered by a narrow
   operator exception; and
4. gives SRT only the vetted address set to use for the socket.

The original hostname remains the HTTP Host value and the TLS certificate/SNI name. This prevents
SRT from resolving the name again after the address check. Private-address exceptions require an
exact workspace, hostname, CIDR, and port match, and the hostname still needs its ordinary egress
grant. This is an `srt:vendored` TCP property, not a claim about provider API calls, UDP/QUIC, or
every future sandbox backend. NAT64 and other address-embedding transition prefixes are deliberately
hard-denied, so NAT64-dependent IPv6-only egress is not currently supported. See
[ADR-0086](adr/0086-warden-owned-egress-address-guard.md) and the
[security model](guide/security-model.md).

## The record survives the agent

Only the warden writes audit records. They are SHA-256 hash-chained with periodic
Ed25519-signed Merkle checkpoints, and can be exported as a one-command, offline-verifiable
evidence bundle. This is **tamper-evident** (post-hoc modification/deletion/reordering is
detectable) — *not* tamper-proof, and not a defense against same-user malware that can steal the
at-rest key. See the threat model in `MASTER_SPEC.md` §3.3 and the claim ledger
(`quality/claim-ledger.md`) for exactly what is and isn't proven.

## Autopilot is not YOLO

Autonomy modes are **policy postures over the warden's enforcement**, not promises about model
behavior. Autopilot removes the human prompt only for actions the warden has already proven
contained and low-risk. It never lets the model raise its own mode, change policy, or turn a
`deny` into an `allow`. "YOLO" means reduced or absent enforcement; keel never conflates the two.
See [concepts](guide/concepts.md) for the full model.

## Honest phasing

keel is pre-alpha. The status line, receipts, and docs are honest-by-construction about what is
actually enforced. [status.md](status.md) lists what keel governs today and what it does not
claim; [quality/claim-ledger.md](quality/claim-ledger.md) maps each claim to its evidence.
