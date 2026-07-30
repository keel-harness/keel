# 0039 — Secrets handling (redaction · 0600 secret store · config-dir guard)

**Status:** accepted
**Date:** 2026-06-16
**Governs:** `MASTER_SPEC.md` §3.2(6) (secrets hygiene), §7 Epic 1.9, SEC-014, POL-001 (Phase 2). Relates
to ADR-0008/0035 (the session ledger the redaction filter hooks), ADR-0002/0030/0032 (provider factories
that take the resolved key), ADR-0037 (the native-module precedent).

## Context

§3.2(6) requires: (1) provider API keys in the **OS keychain** with a `0600`-file fallback; (2) a
**redaction filter** on session JSONL + audit before write; (3) the keel config dir **off-limits** to
tool operations. The initial secrets-handling implementation delivered the **redaction filter** + the **config-dir guard**
(dependency-free, at the single `SessionStore.append` chokepoint and the `Workspace` path chokepoint;
SEC-014 Proven Phase 1). This ADR records the secrets architecture and decides the **key-storage
backend** — a credential-path decision, so it is judged against keel's *value proposition*, not just a
mechanical dependency gate.

## Options (key-storage backend)

`keytar` is deprecated. The 2026 landscape:

- **(A) `@napi-rs/keyring`** — the maintained, keytar-compatible Rust/napi binding (Azure/MSAL adopted
  it). Native keychain access. **A prebuilt, opaque, third-party native binary.**
- **(B) Shell out to `security` / `secret-tool`** — uses the OS's own (system-provided, auditable)
  tools; no third-party binary; but a brief secret-in-argv exposure on macOS write + per-platform CLIs.
- **(C) `0600`-file store, pure TypeScript** — owner-only file under `keelHome`; zero new dependency;
  fully auditable source.

## Decision

**Ship (C): a pure-TypeScript `0600`-file secret store behind a small `SecretStore` port, with `keel
auth` to manage keys.** Reads resolve **store → provider env var** (an empty/whitespace stored value is
treated as absent so it never masks a valid env key). The OS keychain is a **deliberately-vetted future
adapter behind the same port** — and when added we will prefer the OS's own tools (B) over a
third-party native binary.

**Why not the native binding (A), even though it passes the mechanical gate.** We *did* evaluate
`@napi-rs/keyring@1.3.0` against the supply-chain bar and it **passed**: MIT; published 2026-04-30
(≥7-day); **no `postinstall`/`install` script** (safe under our mandatory `ignore-scripts`); prebuilt
per-platform binaries (no build-from-source — so ADR-0037's node-pty objection does not apply); a real
macOS Keychain round-trip verified. We still **declined it for v1** because keel's value proposition is
**auditability + minimal, hostile-assumed dependencies** ("secure by construction"; "assume dependencies
are hostile"; an NSA-grade audit). An **opaque third-party native binary sitting in the credential
path** is precisely what such an audit flags — a binary blob you cannot meaningfully diff, whose
compromised release would run native code in keel's key-holding process — and its marginal benefit over
a `0600` file is partly *outside* keel's own threat model (§3.3 already concedes same-user malware,
which is most of what an OS keychain buys over an owner-only file). For a single-user developer machine,
an owner-only `0600` file is the right, honest protection level, and pure TypeScript is auditable
line-by-line. A first attempt that shipped the native binding also tripped a real failure mode (eager
import throws at module load on a binary-less platform, defeating "graceful degradation") — surfaced by
the end-of-epic security review — reinforcing that the binary adds sharp edges for little gain here.

**The `SecretStore` port keeps this honest, not limiting:** the OS keychain (via B, or A re-evaluated)
is a clean swap-in when there is a real need; the decision is reversible without touching callers.

## Redaction filter (initial implementation, recorded for completeness)

`redactText` runs at the single `SessionStore.append` write chokepoint: a **provider-key format
catalog** (sk-ant / sk / AIza / AKIA / ghp / xox / PEM private-key blocks); **contextual** patterns
(URL-embedded `user:pass@host` credentials, `Authorization:` Bearer/Basic/Token headers — added by the
end-of-epic QC, S7); and a conservative **entropy heuristic** (≥44-char mixed-charset, Shannon ≥3.5
bits/char) with **false-positive guards** so benign high-entropy ids (ULID session ids, uuids,
sha/git-SHAs, pure numbers) survive.

**F1 integrity correction (structured-redaction regression).** The initial implementation redacted the
*already-serialized* JSON line and asserted
"markers are JSON-safe, so the redacted line still parses." That was **false**: a JSON-safe *marker* is
not enough, because a redaction match can begin or end **inside a JSON escape** — the entropy net
matched the `n` of an escaped `\n` separating two grep hits, redacting `\nSECRET…` to
`\[redacted:high-entropy]` and leaving an orphan `\` (an invalid `\[`). A strict parser (`jq` /
`json.loads`) then **silently dropped** the whole `tool_result` line. The fix redacts the **structured
value before serialization** (`redactJsonValue`, or `redactJsonLine` which parse→redact→re-serialize a
compact line): `JSON.stringify` (re)introduces every escape *after* redaction, so the line is valid JSON
**by construction** with identical redaction power. All six write chokepoints (the session ledger plus
the eval trajectory/scoreboard/spend-ledger/matrix stores) were routed through it.

**Honest scope (ground rule 4) — best-effort defense-in-depth, NOT a guarantee.** It is **not** a
guarantee against novel secret shapes, and it has known, documented blind spots — the QC enumerated
them so the catalog never *implies* coverage it lacks:

- the **AWS secret access key** (40 chars, contains `/` — below the 44-char entropy floor and not a
  fixed prefix) leaks even though the AWS access-key **ID** (`AKIA…`) is caught — the catalog's `AKIA`
  entry covers the *ID*, never its paired *secret*;
- a **standalone JWT** outside an `Authorization:` header (only a ≥44-char segment is hit; header JWTs
  are fully redacted via the contextual pattern);
- **hex-only / digits-only** secrets (spared as hashes/ids) and **short (<44-char) keys with no known
  prefix**; secrets **split across fields**.

The entropy floor is a **false-positive guard, not a security boundary** — its blind spots form a
known, evadable oracle. Long base64 blobs may be over-redacted (errs safe). Redaction protects the
**ledger at rest only**; a secret in a tool result is still **model-visible in context** regardless.
Audit-record redaction reuses this filter in Phase 2A.

## Config-dir guard (initial implementation, recorded here)

The typed `read`/`write`/`edit`/`search` tools refuse the keel config dir via `Workspace` `deniedRoots`.
An equal/ancestor `keelHome` is dropped (it would brick the whole workspace); descendants **and**
out-of-workspace roots (the default `~/.config/keel`) are kept. On the normal `resolve` path the denied
root is checked against the **realpath**; on the `read --followSymlink` path — which deliberately opts
out of workspace containment — the guard **resolves the real target and refuses if it lands in the
config dir** (the end-of-epic QC closed a bypass here, SEC-5: the earlier check was *lexical*, so an
in-workspace symlink to the config dir slipped through). In-process Phase-1 guard; the OS-sandbox
deny-read (POL-001) is Phase 2; **`bash` stays unsandboxed in P1 and bypasses this guard** (honest
DOC-LIMIT — the warden closes it in Phase 2).

## Consequences

- **§3.2(6):** redaction + config-dir guard + a `0600` key store are **Proven (Phase 1)**. The literal
  **"OS keychain"** part is honestly **deferred** (a future adapter behind `SecretStore`) — the
  claim-ledger says so; v1 ships the `0600` store the spec lists as the fallback, elevated to the
  default, which is sufficient for the §3.3 threat model.
- **No new dependency** — the credential path is pure, auditable TypeScript. No native binary, no
  platform binary packages in the lockfile.
- **`keel auth`** (`set`/`list`/`remove`) reads the secret from **stdin, not argv** (no `ps` exposure),
  with **no terminal echo** on a TTY, and **never prints** the secret; `list` shows only set/unset.
- **Forward seam:** `SecretStore` is the swap point for the OS-keychain adapter; the redaction filter is
  reused by the Phase-2A audit chain.
