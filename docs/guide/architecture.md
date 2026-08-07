# Architecture deep-dive

How keel is built, one layer below the [one-page tour](../architecture.md). For
the governing detail see `MASTER_SPEC.md`; for security specifically see the
[security model](security-model.md) and [claim ledger](../quality/claim-ledger.md).

## Two processes, one boundary

```
kernel (@keel/kernel)                 warden (@keel/warden)
  agent loop, tools                     policy pack (hash-pinned)
  provider adapters      JSON-RPC       OS sandbox for child execution
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
   - **review**: a pending review plus a `review.requested` record. Exact session or Plan grants and
     eligible Autopilot routing may resolve the review first. Otherwise an interactive terminal run
     pauses for a human. If a one-shot/headless review is still pending, keel attempts to close it as
     denied and exits nonzero. Only a confirmed denial proves the action did not run. A failed or
     indeterminate settlement is labeled; do not retry automatically, and inspect the audit record.
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

## One direct argv call, end to end

Trusted sessions whose Warden advertises `process-run/v1` also expose `process.run`. The model supplies
one bounded literal argv vector. The Warden validates every Unicode scalar and byte bound, constructs
policy input from the structured vector, and applies the same broad governed-bash sandbox envelope and
policy authority. The existing `SandboxInvocation.argv` path launches that exact vector; a canonical
single-quoted rendering is display and audit context, never reparsed authority.

Shell-looking values such as `$(...)`, `;`, `&&`, pipes, redirects, globs, quotes, and empty arguments
therefore reach the child only as argument data. This removes accidental shell composition; it does
not make the executable harmless. Destructive, install, privilege, egress, arbitrary-code, mutable
metadata, unknown-effect, review, audit, and sandbox rules still apply. Policy `modify` cannot rewrite
argv in V1 and becomes an audited fail-closed denial. V1 adds no environment, cwd, stdin, timeout,
background, or service authority. See [ADR-0089](../adr/0089-governed-argv-only-process-execution.md).

## Typed file tools, end to end

All four trusted typed file tools cross `warden.execute`, policy, and audit, but they do not share one
physical execution path:

- `read` is performed inside the Warden after canonical-path, realpath/identity, symlink, size, and
  secret-path checks. It has no separate OS-sandboxed child.
- `search` launches bounded ripgrep from the Warden with a minimal environment, workspace-scoped
  working directory, time/output limits, and canonical per-result filtering. It does not use
  `SandboxPort`.
- `write` and `edit` prepare and revalidate the mutation in the Warden, durably audit intent, and
  dispatch a contained helper through `SandboxPort` on the enforcing Node/npm path. If that runner
  is unavailable, mutation fails closed.

This is why the docs claim Warden routing for the whole typed bridge but physical OS-sandbox proof
only for the paths named above. The readable matrix and limits live in the
[security model](security-model.md).

## One governed TCP connection, end to end

The vendored SRT backend applies two separate egress gates. The ordinary grant or allowlist decides
whether the requested hostname is allowed. The connect-time address guard then decides whether the
address actually used by the socket is safe:

1. SRT passes the canonical hostname and port to a warden-owned resolver immediately before a new
   connection.
2. The warden resolves the hostname once and classifies every returned address. IP literals go
   through the same classifier without DNS.
3. If any answer is malformed, restricted, hard-denied, or not covered by a matching exception, the
   entire attempt is denied. The warden never hides a denied answer by selecting only the acceptable
   subset.
4. SRT receives only the vetted address set. That set is authoritative for the connection; SRT does
   not resolve the hostname again or fall back to a raw hostname dial.
5. HTTP Host, TLS certificate verification, and SNI continue to use the original hostname.

Private enterprise destinations can use an owner-managed exception keyed to the exact workspace,
hostname, CIDR, and port. An exception does not grant the hostname; the ordinary hostname grant must
also allow it. The exception file is loaded as one immutable snapshot when the warden starts, so a
CLI mutation requires a restart before it becomes active.

The warden advertises `egress-address-guard/v1` only after the exception store, classifier, resolver,
SRT proxy, and authoritative audit sink initialize successfully. The kernel can report egress as on
only from that capability. A different sandbox backend gets no credit from this implementation.

This mechanism covers SRT-mediated TCP. It does not cover provider API calls, UDP/QUIC,
proxy-unaware traffic, interactive-console guest activity, or CONNECT/SNI equivalence. See
[ADR-0086](../adr/0086-warden-owned-egress-address-guard.md).

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
