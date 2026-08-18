# Getting started

The shortest path from install to a useful governed coding session. For the system design, read
the [architecture one-pager](../architecture.md); for every option, use the
[reference](reference.md).

## 1. Install and check your machine

The released npm carrier is the product path. It requires Node 20 or newer and `ripgrep`:

```sh
npm i -g keel-harness        # or prefix commands with: npx keel-harness
keel doctor                  # checks Node, ripgrep, credentials, and the OS sandbox
```

Use a source checkout for contribution and development, not as the enforcement demo. The top-level
[`README.md`](../../README.md) explains why and has the contributor commands.

## 2. Authenticate

keel talks to a model provider with a key you supply. Store it once in keel's `0600` credentials
file:

```sh
keel auth set <provider>      # choose a provider; prompts for the key, no echo
keel auth list                # show which providers have a key
keel auth remove <provider>   # delete that provider's stored key
export KEEL_PROVIDER=<provider>
export KEEL_MODEL=<model-id>
```

The angle-bracketed names are placeholders; replace them with your provider and model IDs. Four
providers are supported: `anthropic`, `openai`, `google`, and `openai-compatible`. The compatible
adapter also needs `KEEL_BASE_URL`; the [reference](reference.md#model-and-provider) records the
complete requirements.

If `KEEL_PROVIDER` is omitted, the documented fallback is `anthropic`; every other provider requires
an explicit model id in `KEEL_MODEL`. If nothing is stored, keel falls back to a key in the environment
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`).

keel reads credentials when the process starts. Replacing a key does not reload a running session.
Restart from that session's workspace with `keel --continue`.

## 3. Launch a session

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

## 4. Run one bounded first task

Start with a narrow request that exercises the ordinary read, edit, and verification loop without
publishing anything:

```text
Inspect this project and fix <specific issue>. Make the smallest justified change,
run the narrowest relevant checks, and show me the diff. Do not commit or publish anything.
```

You can ask in ordinary language; you do not need to select tools yourself. Before any project
context is read, keel asks for workspace trust. After trust, the model can request typed file tools
and governed execution, while the warden independently applies policy, audit, and sandbox controls.
A consequential boundary crossing may pause with the exact request for you to approve or deny.
Nothing in the prompt grants that authority.

After the turn, use `/diff` to inspect the change, `/reviews` to see what the warden reviewed, and
`/policies` to revisit the active protections. Only move on to commit or publication when the local
result and its checks are clear.

## 5. Take a change through a pull request

The everyday workflow is **edit → verify → commit → publish**. Ask naturally; keel chooses governed
tools and shows consequential decisions in the TUI:

```text
Fix the failing parser test, run the relevant checks, show me the diff, commit it,
push the current feature branch, and open a pull request.
```

Local edits, tests, and the commit remain governed work. Publishing is deliberately split into two
typed capabilities: `git.push` can create or fast-forward the current non-default feature branch,
then `github.pr.create` can open a same-repository GitHub.com pull request for that exact remote
commit. They require **separate, once-only human approvals**; approving a push never approves a pull
request. Force pushes, default-branch pushes, forks, merges, releases, and automatic retries are not
included.

Before the first publication request, give Git an eligible system/global HTTPS credential helper:

```sh
gh auth login --git-protocol https
gh auth setup-git
keel doctor
```

If publication reports a failed or indeterminate result, do not retry automatically. Inspect the
remote and the audit record first, repair credentials if needed, then make a deliberate fresh
request. A one-shot `keel run -p` cannot settle a live review; use interactive `keel` when an action
may need approval. The [reference](reference.md) gives the complete boundary.

## 6. Autonomy at a glance

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

## 7. Inside the session: slash commands

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

## 8. Keyboard essentials

| Key | Action |
| --- | --- |
| `Ctrl-C` | Interrupt the current turn; at an idle prompt, press twice to quit. |
| `Esc` | Interrupt while running, or close the palette / help overlay. |
| `/` | Open the command palette. |
| `@` | File-path completion (trusted workspaces). |
| `↑` / `Ctrl-R` | History recall / reverse-search. |
| `Ctrl-G` | Edit the current draft in `$VISUAL` / `$EDITOR`. |

Standard Emacs line editing (`Ctrl-A/E/U/K/W/Y`, `Alt-B/F`) works at the prompt.

## Common first-run fixes

| What you see | What to do |
| --- | --- |
| `doctor` reports a missing prerequisite | Run the single fix it prints, then rerun `keel doctor`. |
| A replaced API key is not picked up | Restart keel in the workspace with `keel --continue`. |
| A one-shot stops because review is required | Start interactive `keel` and submit the task there. |
| Publication says the credential is unavailable | Run the three `gh` / `doctor` commands above, then submit a fresh request. |

## Going deeper

- [Reference](reference.md) — every CLI command, run flag, environment variable, and file.
- [Policy and approval guide](policy-guide.md) — modes, live reviews, grant scopes.
- [Reviewing what keel did](audit-and-sessions.md) — audit logs, evidence bundles, sessions.
- [Architecture one-pager](../architecture.md) and the [`MASTER_SPEC.md`](../../MASTER_SPEC.md).
