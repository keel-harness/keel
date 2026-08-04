# Getting started

A one-page tour of how to run keel: authenticate, launch a session, and the commands
you can type. For what keel *is*, read the [architecture one-pager](../architecture.md)
first. For install, see the top-level [`README.md`](../../README.md).

## 1. Authenticate

keel talks to a model provider with a key you supply. Store it once in keel's
`0600` credentials file:

```sh
keel auth set anthropic      # prompts for the key, no echo
keel auth list               # show which providers have a key
keel auth remove anthropic   # delete a stored key
```

Providers: `anthropic` (default), `openai`, `google`, `openai-compatible`. Select a
different one with `KEEL_PROVIDER`. A key in the environment
(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`) is used as a
fallback when nothing is stored.

Credentials are resolved when a Keel process starts. Replacing a key does not reload an already
running session; restart from that session's workspace with `keel --continue`.

Before your first run, check your machine has the tools keel needs:

```sh
keel doctor                  # verifies node, ripgrep, and the OS sandbox
```

## 2. Launch a session

```sh
keel                         # interactive multi-turn session (the usual way in)
keel --trust                 # start already trusting this workspace (see below)
keel run -p "fix the failing test"   # one-shot: run a single prompt and exit
keel --continue              # resume the most recent session in this directory
keel --resume <id>           # resume a specific session by id
```

**Trust.** On first use in a directory keel asks whether to trust the workspace. Trust
is a human-only act — it unlocks project context (`AGENTS.md`, skills) and the trusted
file tools (`read`/`write`/`edit`/`search`). Governed bash routes through the warden
either way. keel **fails closed**: an untrusted or non-interactive run stays untrusted
unless you pass `--trust` (or set `KEEL_TRUST=1`).

## 3. Autonomy at a glance

keel runs in a **policy posture**, evaluated by the warden — not a model setting.
Higher autonomy means *fewer prompts inside enforced boundaries*, never weaker
enforcement.

| Posture | What it means |
| --- | --- |
| `guided` *(default)* | The warden may ask before risky, broad, external, or destructive actions. |
| `autopilot` | Auto-approves contained in-workspace actions; boundary expansion still prompts. Requires a **trusted** workspace and an explicit human opt-in. |
| `project-autopilot` | `autopilot` plus persisted, revocable project-scope grants. Trusted projects only. |

Set it per run with `--autopilot`, or persist it:

```sh
keel autopilot mode status
keel autopilot mode set autopilot          # or: guided | project-autopilot
keel autopilot mode clear
keel autopilot grants list                 # persisted project grants
keel autopilot grants revoke --domain <domain>
```

There is **no YOLO / "enforcement-off" mode** — it is deliberately not wired. Autopilot
is high autonomy inside enforced boundaries, not the absence of a warden. For the full
model — mode labels, live approvals, and grant scopes — read the
[policy and approval guide](policy-guide.md).

## 4. Inside the session: slash commands

Type `/` at the prompt to open the command palette. The everyday commands:

| Command | Does |
| --- | --- |
| `/help` | Help and keyboard shortcuts. |
| `/policies` | Read-only view of the active protections. |
| `/reviews` | What the warden reviewed this session (read-only, not an approval surface). |
| `/context` | Session details. |
| `/model` | Model selection and route status. |
| `/capabilities` | What keel can do in this workspace. |
| `/diff` | Toggle compact vs. full diffs. |
| `/quiet`, `/verbose` | Less / more tool detail. |
| `/goal <objective>` | Set what keel keeps working toward. |
| `/loop <check>` | Continue under current protections with a bounded check. |
| `/answer <40..2000>` | Bound only the next ordinary task's final answer; use `clear` or `full` to disarm or inspect the original. |
| `/about` | Product basics. |
| `/exit` | End the session. |

When the warden is waiting on a decision, respond in place — `/approve`, `/deny`, or
`/why` (or the one-key `a` / `d` / `?`). To steer mid-run: `/now`,
`/before-next-edit`, `/stop-after-current`.

## 5. Keyboard essentials

| Key | Action |
| --- | --- |
| `Ctrl-C` | Interrupt the current turn; at an idle prompt, press twice to quit. |
| `Esc` | Interrupt while running, or close the palette / help overlay. |
| `/` | Open the command palette. |
| `@` | File-path completion (trusted workspaces). |
| `↑` / `Ctrl-R` | History recall / reverse-search. |
| `Ctrl-G` | Edit the current draft in `$VISUAL` / `$EDITOR`. |

Standard Emacs line editing (`Ctrl-A/E/U/K/W/Y`, `Alt-B/F`) works at the prompt.

## 6. Command reference

| Command | Purpose |
| --- | --- |
| `keel` | Interactive session. |
| `keel run -p <prompt>` | One-shot run, honest exit code. |
| `keel autopilot mode …` | Read/set/clear the persisted autonomy posture. |
| `keel autopilot grants …` | List/revoke persisted project grants. |
| `keel autopilot plan preview …` | Preview exact Plan-Autopilot resources (grants nothing). |
| `keel egress exception add\|list\|remove …` | Manage exact private-address exceptions for one workspace. |
| `keel audit export <session>` | Export a signed evidence bundle. |
| `keel audit verify <bundle>` | Verify a bundle offline. |
| `keel sessions <list\|resume\|answer\|branch>` | Inspect session ledgers and retained bounded-answer originals. |
| `keel mcp review <server>` | Review and pin a local-stdio MCP server. |
| `keel auth <set\|list\|remove>` | Manage provider keys. |
| `keel doctor` | Check required local tools. |
| `keel --version` / `--help` | Version / help. |

Reviewing what keel did afterward — audit logs, evidence bundles, past sessions — has
its own guide: [reviewing what keel did](audit-and-sessions.md).

## 7. Environment variables

| Variable | Purpose |
| --- | --- |
| `KEEL_PROVIDER` | `anthropic` (default), `openai`, `google`, `openai-compatible`. |
| `KEEL_MODEL` | Model id. Optional for anthropic (has a default); required for other providers. |
| `KEEL_BASE_URL` | Endpoint URL; required for `openai-compatible`. |
| `KEEL_CACHE_TTL` | Anthropic prompt-cache TTL: `5m` (default) or `1h`. |
| `KEEL_HOME` | Where keel stores state (`KEEL_HOME` → `$XDG_CONFIG_HOME/keel` → `~/.config/keel`). |
| `KEEL_TRUST=1` | Trust the workspace without the `--trust` flag. |
| `VISUAL` / `EDITOR` | External editor for the `Ctrl-G` draft editor. |
| `NO_COLOR` | Disable colored output. |

## Going deeper

- [Policy and approval guide](policy-guide.md) — modes, live reviews, grant scopes.
- [Reviewing what keel did](audit-and-sessions.md) — audit logs, evidence bundles, sessions.
- [Architecture one-pager](../architecture.md) and the [`MASTER_SPEC.md`](../../MASTER_SPEC.md).
