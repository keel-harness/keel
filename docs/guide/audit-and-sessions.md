# Reviewing what keel did

keel records every governed action to a tamper-evident, per-session hash chain, and it
keeps an append-only ledger of each session. This guide covers how to read that history,
resume past sessions, and produce a portable, signed record you can verify offline.

For how the audit format works internally, see
[ADR-0006](../adr/0006-crypto-noble-and-audit-format.md) and
[ADR-0072](../adr/0072-durable-format-evolution.md); for what the tamper-evidence claim
does and does not prove, see the [claim ledger](../quality/claim-ledger.md) (SEC-008).

## Where keel keeps state

Everything lives under `KEEL_HOME` — resolved as `KEEL_HOME` → `$XDG_CONFIG_HOME/keel` →
`~/.config/keel`:

```
~/.config/keel/
├── sessions/<id>.jsonl          append-only session ledgers
├── audit/
│   ├── <sessionId>.jsonl        tamper-evident hash chain, one per session
│   ├── checkpoint-key.json      Ed25519 key that signs chain checkpoints
│   └── exports/bundle_<id>/     exported evidence bundles
├── trust.json                   which workspaces you've trusted
├── credentials.json             provider keys (0600)
└── …                            grants, mcp trust, config-change receipts
```

## Past sessions

```sh
keel sessions list               # id · directory · event count · created-at
keel sessions branch <id> <n>    # fork a ledger at event n
keel sessions answer <id> --original  # latest retained redacted bounded-answer original
```

To pick a session back up **live**, use the launch flags rather than
`keel sessions resume` (which is report-only today):

```sh
keel --continue                  # most recent session in this directory
keel --resume <id>               # a specific session
```

If a session was written by a newer keel than the one you're running, keel says so
honestly ("written by a newer keel; upgrade") rather than calling it corrupt.

## The audit log

Each session's audit chain is JSONL at `~/.config/keel/audit/<sessionId>.jsonl`. Every
record carries `prevHash`/`hash`, and periodic checkpoint records are Ed25519-signed, so
any edit, reorder, or deletion breaks the chain.

There is **no command that tails or pretty-prints the raw log** — read the `.jsonl`
directly if you want the stream. To verify integrity, or to hand the record to someone
else, export an evidence bundle (next).

## Evidence bundles (the portable, verifiable record)

Export a self-contained, signed bundle for one session:

```sh
keel audit export <session>            # writes to ~/.config/keel/audit/exports/
# → exported audit bundle: <path>
#   root hash: <hash>
```

The bundle holds the audit chain, signed checkpoints, a config snapshot, a redaction
report, the policy pack, and a vendored offline verifier. One honest limit of the
redaction filter: if a `/goal` done-when check command itself contains a long
secret-shaped token (44+ characters of high-entropy mixed text), that token is redacted
in the persisted `goal_started` record. The ledger stays valid and nothing re-executes
the redacted text, but the durable record of exactly what that check command was is
intentionally lossy in that case; secrets never win over evidence fidelity. Verify it
anywhere:

```sh
keel audit verify <bundle>             # in-process verifier
node <bundle>/verify/verify-bundle.mjs <bundle>   # standalone, no keel needed
```

A successful verify reports the root hash, record and checkpoint counts, and the signer
key:

```
verified audit bundle: <path>
root hash: <rootHash>
records: <n>
checkpoints: <n>
signer checkpoint key: <ed25519:…>
Compare the signer checkpoint key with the warden's published or out-of-band key
before treating this bundle as authentic.
```

That last line matters: verification proves the chain is **internally intact and signed
by whoever holds the checkpoint key**. To prove it's *your* warden's record, compare the
printed signer key against the key you obtained out of band — the bundle can't establish
that for you.

Export **fails closed**: if the chain, a checkpoint, or the policy pack doesn't check
out, no bundle is written.

## Receipts and the status line

You don't have to dig into the log for a quick read of what happened:

- **Turn summary / auto-resolution receipt** — after a run, keel summarizes what the
  warden auto-allowed and what still **needs attention**, each line tied back to an
  audit sequence number (`audit #<seq>`) so it traces to the chain above.
- **Status line** — a live posture indicator (sandbox / network on-off, audit
  on-unseen-off, active policy). `audit unseen` means the governed runtime has not yet observed a
  non-empty audit head; it does not claim that a write has succeeded. When enforcement is off, the
  status says so plainly.
- **`config-change-receipts.jsonl`** — a durable, at-rest log of autopilot/config
  changes, each with an undo command.

Inside a session, `/reviews` shows the review history and `/policies` shows the active
protections — both read-only.

## Going deeper

- [Getting started](getting-started.md) — commands, flags, and slash commands.
- [Policy and approval guide](policy-guide.md) — how reviews and grants work.
- [ADR-0006](../adr/0006-crypto-noble-and-audit-format.md),
  [ADR-0072](../adr/0072-durable-format-evolution.md), and the
  [claim ledger](../quality/claim-ledger.md) for the integrity model and its honest limits.
