# Architecture deep-dive

How keel is built, one layer below the [one-page tour](../architecture.md). For
the governing detail see `MASTER_SPEC.md`; for security specifically see the
[security model](security-model.md) and [claim ledger](../quality/claim-ledger.md).

## Two processes, one boundary

```
kernel (@keel/kernel)                 warden (@keel/warden)
  agent loop, tools                     policy pack (hash-pinned)
  provider adapters      JSON-RPC       OS sandbox (Seatbelt / bwrap)
  session ledger        over stdio      egress control
  TUI, CLI              ───────────▶     audit chain + Ed25519 signing
  holds the model                        holds enforcement
```

The kernel spawns the warden as a child process and talks to it over
newline-framed JSON-RPC 2.0 on stdio. The handshake pins a protocol version; a
major-version mismatch is refused. The method registry is frozen at twelve
methods (`execute`, `resolveReview`, `egress.grant`, `audit.export`, `status`,
and so on); changing it requires a new protocol version and an ADR.

The kernel holds your provider key, so it is inside the trust boundary for
credential access. It is not inside the boundary for execution: there is no path
for the model's tool call to run except through `warden.execute`. In packaged
builds the local (unsandboxed) executor is structurally unreachable; a build-time
gate keeps it to eval-only use.

## The five ports

Volatile dependencies sit behind stable interfaces, so implementations can be
swapped without touching the contract:

- **ModelPort** wraps all provider access (`stream(input)`).
- **UIPort** takes a rendered view model; the kernel never imports the terminal
  library directly, which is how the headless renderer drives CI and golden
  tests.
- **ExecutorPort** is the seam the loop calls for every tool. Production wires it
  to the warden.
- **PolicyPort** and **SandboxPort** live inside the warden and wrap policy
  evaluation and the sandbox engine.

## One bash call, end to end

1. The loop calls `executor.execute(call)`.
2. The kernel sends `warden.execute` over RPC with the session id, the tool call,
   and provenance context.
3. The warden checks sandbox availability first and fails closed if it is
   missing. Then it builds the bash profile, scans for workspace-secret reads,
   and constructs the policy input.
4. The hash-pinned policy pack (compiled Rego, run as Wasm) returns a verdict.
   Precedence is `deny > review > modify > warn > allow`. The bash classifier
   models shell structure, so a `curl` uploading a secret path is treated as a
   secret read and denied.
5. The verdict routes:
   - **deny**: a `tool.deny` audit record, nothing executed.
   - **review**: a pending review plus a `review.requested` record; the run
     pauses for a human.
   - **modify**: the rewritten command is re-evaluated and re-denied if the new
     form is blocked.
   - **warn / allow**: execution proceeds. A cross-check denies anything policy
     allowed that the sandbox profile forbids.
6. Execution runs inside the sandbox (the vendored `@anthropic-ai/sandbox-runtime`:
   Seatbelt via `sandbox-exec` on macOS, bubblewrap on Linux).
7. Output is clamped: 256 KiB per stream to the model, up to 1 MiB per stream to
   the durable audit, head-and-tail truncation with an honest marker, all under a
   fatal 1 MiB RPC frame cap.
8. Audit append brackets execution. An intent record (`execution: "requested"`)
   is written and fsynced *before* the sandbox runs; the outcome record follows.
   The writer redacts every string leaf and key, then canonicalizes, then hashes,
   so the hash commits to already-redacted bytes.
9. The verdict envelope returns to the kernel. A deny becomes a
   "blocked by warden (not executed)" message with guidance for self-correction.

## The audit chain

Each record carries `prevHash` and `hash`, where the hash is SHA-256 over the
RFC 8785 canonical JSON of the record with `hash` and `sig` omitted. Periodic
checkpoints (default every 128 records) carry an Ed25519 signature over a
domain-separated Merkle root. The signing key lives at
`audit/checkpoint-key.json`, created `0600`; the loader refuses it if group or
other bits are set.

Verification detects sequence gaps, genesis mismatch, chain breaks, and hash
mismatches: a 100% detection corpus covers flips, deletes, reorders, dups, and
splices. It does not detect tail truncation at a valid boundary unless you supply
an out-of-band head anchor, which is documented in the verifier and proven both
ways in tests.

The warden process owns the writer under an exclusive lock. Writes loop until the
full line lands and fsync per record; a fault rolls back to the last durable
record and poisons the writer rather than continuing on a torn chain.

## Sessions versus audit

Two separate records, easy to confuse:

- The **session ledger** (`sessions/<id>.jsonl`) is kernel-owned, append-only,
  and redacted, but has no hash spine. It is not tamper-evident. It drives resume
  and the live receipts.
- The **audit chain** (`audit/<id>.jsonl`) is warden-owned and tamper-evident.
  It is the forensic record and the basis of evidence bundles.

## Evidence bundles

`keel audit export <session>` writes a self-contained
`bundle_<sessionId>/` directory: the audit chain, signed checkpoints, a config
snapshot, a redaction report, the policy pack, and a vendored offline verifier
(`verify/verify-bundle.mjs`) plus its manifest of per-file hashes. It verifies
with `keel audit verify`, or standalone with Node and no keel present. Export
fails closed: if the chain, a checkpoint, or the policy pack does not check out,
no bundle is written.

## Repository layout

- `packages/kernel`: the agent loop, the five core tools, provider adapters,
  sessions, TUI, context discipline, CLI.
- `packages/warden`: policy and sandbox mediation, egress, the audit chain, and
  evidence bundles.
- `packages/shared`: frozen zod schemas for RPC, audit, policy, and sessions.
- `packages/simulator`: a scripted ModelPort for deterministic tests.
- `packages/eval`: the benchmark runner and trajectory store.
- `packages/memory`: a placeholder for planned Phase-3 work.
- `vendor/sandbox-runtime`: the vendored sandbox engine (Apache-2.0; see
  `NOTICE`).
