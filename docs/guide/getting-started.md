# Getting started

How to run keel: authenticate, launch a session, and use the commands. For what keel *is*, read
the [architecture one-pager](../architecture.md) first. For install, see the top-level
[`README.md`](../../README.md).

## 1. Authenticate

keel talks to a model provider with a key you supply. Store it once in keel's `0600` credentials
file:

```sh
keel auth set anthropic      # prompts for the key, no echo
keel auth list               # show which providers have a key
keel auth remove anthropic   # delete a stored key
```

Four providers are supported: `anthropic` (the default), `openai`, `google`, and
`openai-compatible`. Select one with `KEEL_PROVIDER`. Every provider except `anthropic` also needs
a model id in `KEEL_MODEL`. If nothing is stored, keel falls back to a key in the environment
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`).

keel reads credentials when the process starts. Replacing a key does not reload a running session.
Restart from that session's workspace with `keel --continue`.

Before your first run, check that your machine has the tools keel needs:

```sh
keel doctor                  # verifies node, ripgrep, and the OS sandbox
```

## 2. Launch a session

```sh
keel                         # interactive multi-turn session (the usual way in)
keel --trust                 # start already trusting this workspace (see below)
keel run -p "fix the failing test"   # one-shot: unresolved live review stops nonzero
keel --continue              # resume the most recent session in this directory
keel --resume <id>           # resume a specific session by id
```

**Trust.** On first use in a directory keel asks whether to trust the workspace. Trust
is a human-only act — it unlocks project context (`AGENTS.md`, skills), the trusted
file tools (`read`/`write`/`edit`/`search`), and capability-negotiated direct-argv
`process.run`. Governed bash routes through the warden either way. keel **fails closed**:
an untrusted or non-interactive run stays untrusted
unless you pass `--trust` (or set `KEEL_TRUST=1`).

For one direct executable invocation, especially a build, test, lint, typecheck, or status check,
`process.run` passes a literal argument vector through Warden policy, audit, and the OS sandbox.
Shell-looking arguments stay data. Deliberate pipelines, redirection, expansion, or persistent shell
state remain `bash` work; `process.run` does not make the invoked program inherently safe.

## 3. Autonomy at a glance

keel runs in a **policy posture** that the warden evaluates. It is not a model setting. Higher
autonomy means fewer prompts inside enforced boundaries. It never means weaker enforcement.

| Posture | What it means |
| --- | --- |
| `guided` *(default)* | The warden may ask before risky, broad, external, or destructive actions. |
| `autopilot` | May auto-resolve eligible contained in-workspace actions. Boundary expansion still requires a live review; a one-shot stops nonzero if that review remains unresolved. Requires a **trusted** workspace and an explicit human opt-in. |
| `project-autopilot` | `autopilot` plus persisted, revocable project-scope grants. Trusted projects only. |

Set the posture per run with `--autopilot`, or persist it:

```sh
keel autopilot mode status
keel autopilot mode set autopilot          # or: guided | project-autopilot
keel autopilot mode clear
keel autopilot grants list                 # persisted project grants
keel autopilot grants revoke --domain <domain>
```

There is **no YOLO or "enforcement-off" mode**. It is deliberately not wired. For the full model —
mode labels, live approvals, and grant scopes — read the
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

When the warden waits on a decision, respond in place with `/approve`, `/deny`, or `/why`. The
one-key forms are `a`, `d`, and `?`. To steer mid-run, use `/now`, `/before-next-edit`, or
`/stop-after-current`.

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

## Going deeper

- [Reference](reference.md) — every CLI command, run flag, environment variable, and file.
- [Policy and approval guide](policy-guide.md) — modes, live reviews, grant scopes.
- [Reviewing what keel did](audit-and-sessions.md) — audit logs, evidence bundles, sessions.
- [Architecture one-pager](../architecture.md) and the [`MASTER_SPEC.md`](../../MASTER_SPEC.md).
