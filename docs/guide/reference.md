# Reference

Commands, flags, environment variables, and files. For a guided first run see
[getting started](getting-started.md); for concepts see [concepts](concepts.md).

The command is always `keel`. From a source checkout, `pnpm keel ...` runs the
same CLI.

## Commands

| Command | What it does |
| --- | --- |
| `keel` | Start an interactive session. Prompts for workspace trust on first use in a directory. |
| `keel run -p "<prompt>"` | Run one prompt headless and exit. `--print` is an alias of `-p`. |
| `keel --continue` / `-c` | Resume the most recent session in this directory (interactive only). |
| `keel --resume <id>` / `-r <id>` | Resume a specific session (interactive only). |
| `keel doctor` | Check Node, ripgrep, and the OS sandbox for this platform. |
| `keel auth set\|list\|remove <provider>` | Manage stored provider keys. |
| `keel sessions list` | List sessions: id, directory, event count, created-at. |
| `keel sessions resume <id>` | Inspect a session (read-only). To continue it live, use `keel --resume <id>`. |
| `keel sessions branch <id> <n>` | Fork a ledger at event index `n`. |
| `keel audit export <session> [--out <dir>]` | Write a signed evidence bundle (default under `<KEEL_HOME>/audit/exports`). |
| `keel audit verify <bundle>` | Verify a bundle offline; prints hashes, counts, and the signer key. |
| `keel autopilot mode status\|set <mode>\|clear` | View or set the persisted per-workspace autonomy mode. |
| `keel autopilot grants list\|revoke ...` | List or revoke persisted project grants. |
| `keel autopilot plan preview ...` | Preview an exact-resource plan envelope. Grants nothing. |
| `keel egress exception add\|list\|remove ...` | Manage exact private-address exceptions for one workspace. |
| `keel mcp review <server>` | Review and pin a local MCP server from `.keel/mcp.json`. |

**Exit codes.** Interactive and `run` sessions exit non-zero when the run stopped
for any reason other than the model finishing normally (provider error, turn cap,
budget, deadline). `doctor` exits non-zero if any check is missing (warnings do
not fail). Usage errors and unknown flags exit non-zero. One known gap: `keel auth`
usage errors print a message but exit zero today.

## Run flags

Available on `keel run`:

| Flag | Effect |
| --- | --- |
| `-p` / `--print <prompt>` | The prompt. Required. A flag-shaped prompt is rejected; dash-leading prose is fine. |
| `--verbose` | Show the seeded system preamble. |
| `--trust` | Trust the workspace for this run without prompting. |
| `--autopilot` | Request autopilot posture (trusted workspace only). |
| `--replay <file>` | Deterministic offline replay from a recording. No key, no network. |
| `--goal <objective>` with `--goal-check <cmd>` | Run a goal contract; see below. Also `--goal-max-turns`, `--goal-max-wall-ms`, `--goal-validation`. |
| `--loop-until <cmd>` | Run a bounded loop; also `--loop-max-iterations`, `--loop-max-wall-ms`. |
| `--plan-domain <d>` / `--plan-command-key <sha256:...>` | Pre-approve exact resources. `--plan-confirm` requires typing `approve`. |

`--autopilot`, `--replay`, and `--plan-*` are mutually exclusive where noted;
`--goal` and `--loop-until` cannot be combined.

## Goal and loop syntax

In an interactive session:

```
/goal <objective> --check "<cmd>" [--check "<cmd>"] [--max-turns <n>] [--max-wall-ms <ms>] [--validation minimal|standard|strict]
/loop <prompt> --until "<cmd>" [--max-iterations <n>] [--max-wall-ms <ms>]
```

A goal needs an objective and at least one `--check` command that supplies
completion evidence; validation defaults to `standard`. A loop needs `--until`
and defaults to 3 iterations (schema max 1000). The loop's `--until` command runs
as a governed exit check and stops the loop when it exits zero. Neither runs while
a `/plan` approval is queued.

## Environment variables

All optional. Integer knobs read base-10 digits only.

### State and trust

| Variable | Effect | Default |
| --- | --- | --- |
| `KEEL_HOME` | Where keel stores sessions, audit, and config. | `$XDG_CONFIG_HOME/keel`, else `~/.config/keel` |
| `KEEL_TRUST` | `1` trusts the workspace this run (same authority as `--trust`). | unset (fail closed) |
| `KEEL_RUN_SESSION_ID` | Pin a fresh run's session id (`ses_<ULID>`). | unset |

### Model and provider

| Variable | Effect | Default |
| --- | --- | --- |
| `KEEL_PROVIDER` | `anthropic` · `openai` · `google` · `openai-compatible`. | `anthropic` |
| `KEEL_MODEL` | Model id. Required for every provider except Anthropic. | pinned Anthropic Sonnet |
| `KEEL_BASE_URL` | Endpoint. Required for `openai-compatible`. | unset |
| `KEEL_CACHE_TTL` | Anthropic cache TTL: `5m` or `1h`. Any other value is an error. | `5m` |

Provider keys resolve from the stored `0600` credentials file first, then the
provider's environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`).

Key resolution happens when a Keel process starts. `keel auth set` does not reload an already
running session; restart from that session's workspace with `keel --continue`.

### Budget and loop safety

| Variable | Effect | Default |
| --- | --- | --- |
| `KEEL_MAX_TOKENS` | Effective-cost token cap (cached input discounted). The primary spend ceiling. | unset |
| `KEEL_MAX_GROSS_TOKENS` | Raw input+output backstop; also the compaction runway trigger. | unset |
| `KEEL_MAX_OUTPUT_TOKENS` | Cumulative output-token guard. | unset |
| `KEEL_MAX_TURNS` | Hard cap on agent loop turns. Not a spend cap. | 50 |
| `KEEL_MAX_WALL_SEC` | Wall-clock budget; keel self-stops gracefully with a `deadline` outcome. | unset |
| `KEEL_MAX_RESPONSE_TOKENS` | Per-response output-token limit. | 16384 |

`KEEL_MAX_TOKENS` is a cost ceiling, not a raw-token one: a cached-heavy task runs
proportionally longer for the same number. Pair it with `KEEL_MAX_GROSS_TOKENS`
for a hard raw-token bound.

### Context and compaction

| Variable | Effect | Default |
| --- | --- | --- |
| `KEEL_COMPACTION` | `1` enables in-loop context compaction (compresses the model's view, not the ledger). | off |
| `KEEL_CONTEXT_WINDOW` | Context-window size in tokens. Used for the compaction budget and the live context meter. | provider metadata, else 200000 |
| `KEEL_COMPACTION_RECENT` | Recent turns kept verbatim. Only used when compaction is on. | 6 |

With compaction on and no `KEEL_MAX_GROSS_TOKENS` set, there is no hard overflow
backstop: a run can grow until the provider rejects it. Set a gross cap alongside
compaction for a real runway bound.

### Tool behavior (opt-outs)

| Variable | Effect | Default |
| --- | --- | --- |
| `KEEL_NO_SNAPSHOT` | Skip the run-start workspace backup. | backup on |
| `KEEL_NO_EDIT_CHECK` | Skip the post-edit/write code check. | check on |
| `KEEL_NO_SHELL_RESET_HINT` | Suppress the hint shown when the persistent shell resets. | hint on |
| `KEEL_NO_DAEMON_HINT` | Suppress the hint shown when a command backgrounds a server. | hint on |
| `KEEL_RG_PATH` | Override the ripgrep binary. | bundled, then PATH |

### Verification (opt-in, off by default)

`KEEL_VERIFY` enables a pre-completion verification turn; `KEEL_VERIFY_MODE`
selects `prompt` or `prestop` (the latter needs `KEEL_PRESTOP_CHECK_CMD`).
`KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS` lists exact workspace-relative paths that
must exist and be non-empty before a clean stop; it requires a trusted workspace.
These default off; earlier always-on versions measured net-negative.

## Egress address exceptions

The SRT connect-time guard denies private and other restricted addresses by default. If a trusted
enterprise service intentionally resolves into private space, a human can add one exact exception:

```sh
keel egress exception list --workspace /path/to/project
keel egress exception add --workspace /path/to/project \
  --host registry.corp.example --cidr 10.20.0.0/16 --port 443
keel egress exception remove --workspace /path/to/project \
  --host registry.corp.example --cidr 10.20.0.0/16 --port 443
```

An exception matches the resolved workspace, one exact hostname, one canonical CIDR, and one or more
exact ports. It accepts no wildcard hostname, IP-literal hostname, port wildcard, or port range.
Loopback, metadata, link-local, multicast, unspecified, and other hard-denied destinations cannot be
excepted. The hostname must also have its ordinary egress grant; the exception alone opens nothing.

The warden reads one immutable exception snapshot at startup. After `add` or `remove`, stop the
running warden and continue the workspace session as instructed by the command output. `keel doctor`
reports an unsafe or malformed exception store and prints one remediation.

## Files

Under `KEEL_HOME`:

| Path | Contents |
| --- | --- |
| `sessions/<id>.jsonl` | Append-only session ledgers. |
| `audit/<id>.jsonl` | Per-session tamper-evident audit chains. |
| `audit/checkpoint-key.json` | Ed25519 checkpoint signing key (`0600`, refused if group/other-readable). |
| `audit/exports/` | Default evidence-bundle output. |
| `trust.json` | Trusted workspaces, keyed by resolved path (`0600`). |
| `credentials.json` | Provider keys (`0600`). |
| `project-autopilot-modes.json` | Persisted per-workspace autonomy mode. |
| `egress-project-grants.json`, `command-project-grants.json` | Persisted project grants. |
| `egress-address-exceptions.v1.json` | Owner-managed private-address exceptions; strict versioned JSON, owner-only `0600`. |
| `mcp-trust.json` | Pinned MCP server trust. |
| `config-change-receipts.jsonl` | Redacted log of config changes, each with an undo command. |
| `snapshots/<session-id>/` | Faithful run-start workspace safety copy for human-only recovery. |

Run-start snapshots are byte-faithful and may therefore contain `.env`, secret-shaped files, and
symlink objects. Keel retains them only after trust, under an owner-only mode-`0700` `KEEL_HOME`.
The entire state root remains denied to governed bash and the typed file tools; Keel does not send a
snapshot's concrete path or contents to the model.

Recovery is a deliberate host-shell operation by the human. Locate the session under
`$KEEL_HOME/snapshots/<session-id>/`, inspect the exact named entry with `ls -ld`, and copy only a
regular file you recognize to a new workspace path. Do not bulk-copy the tree and do not copy or
follow a retained symlink: its target can be outside the original workspace. Keel provides no
automatic restore or `keel undo` command.

keel's own `KEEL_HOME` is denied to the file tools even when it sits inside a workspace.

Project-local files, read only after you trust the workspace: `AGENTS.md`,
`.keel/skills/`, `.keel/mcp.json`, `.keel/credential-proxy.json`,
`.keel/lifecycle.yaml`. An untrusted workspace loads none of them.
