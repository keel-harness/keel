# Concepts

What "governed" means in keel, and the small set of ideas everything else builds on.
Skim this before the [reference](reference.md); read the
[security model](security-model.md) for what is proven versus planned.

## The model requests. The warden decides.

keel splits into two processes:

- The **kernel** holds the model conversation: the agent loop, tools, sessions, the
  TUI, and your provider key. It has no code path that executes a governed tool
  directly.
- The **warden** is a separate process the kernel spawns. It owns policy, the OS
  sandbox, egress control, and the audit record. On the vendored SRT TCP path it also checks and
  pins the destination's resolved addresses immediately before connect. Every governed tool call
  crosses a JSON-RPC boundary to the warden, which returns a verdict: `allow`, `deny`, `review`,
  `warn`, or `modify`.

This is structural enforcement. It does not depend on the model behaving well,
because the process that runs actions is not the process the model talks through.
The policy pack is hash-pinned; the warden refuses to start if the pack on disk
does not match the pinned hash.

A `review` verdict pauses the run and asks you. A `deny` returns an honest
"blocked by warden (not executed)" message to the model, with guidance, so the
model can self-correct. Denied actions are recorded with the same fidelity as
allowed ones.

## Trust is a human act

The first time you run keel in a directory, it asks whether to trust the
workspace. Until you say yes, keel reads nothing from the project: no `AGENTS.md`,
no skills, no config files. This is trust-before-parse: hostile repo content never
reaches the model before a human decision.

Declining still works. The agent runs with empty project context. Trust is
remembered per workspace in your user config, never in the repo itself, so a
repository cannot grant itself trust. Non-interactive runs fail closed to
untrusted unless you pass `--trust` or set `KEEL_TRUST=1`.

## Autonomy is a policy posture, not a model setting

Modes change how often keel asks you, never what is enforced:

| Mode | What changes |
| --- | --- |
| `guided` (default) | Consequential actions pause for your approval. |
| `autopilot` | Reviews for already-contained, in-workspace actions resolve automatically. Boundary expansion still asks. Requires a trusted workspace and an explicit human opt-in. |
| `project-autopilot` | `autopilot` plus persisted, revocable project-scope grants. |

A mode is set by a human, from the CLI (`--autopilot`, or
`keel autopilot mode set ...`), never from chat: the `/autopilot` and `/yolo`
slash commands are informational notices only. Every mode change is audited and
prints a config-change receipt with an undo command.

**Autopilot is not YOLO.** Autopilot means fewer prompts inside enforced
boundaries. Reduced enforcement is a different thing, and when enforcement is off
keel says so in a persistent banner instead of showing a trust word.

## Reviews and scopes

When the warden wants a human decision, keel shows one focused approval card and
pauses. Your options:

- `a` or `/approve once`: this exact action, one time.
- `s` or `/approve session`: the exact resource (a domain or a command key) for
  the rest of this session. Only offered when the warden has a validated exact
  resource to grant.
- `d` or `/deny`: the action does not run.
- `?` or `/why`: explain the review before deciding.

Project-wide grants are never made from a live review. They exist only through
Project Autopilot configuration, are stored in your user config, and are listed
and revoked with `keel autopilot grants`. Invalid or ambiguous decisions fail
closed to deny.

## Evidence over self-report

keel's answer to "what did the agent do?" is a record, not a summary:

- Every governed action lands in a per-session, hash-chained audit log written by
  the warden process. The agent has no write path to it.
- `keel audit export` produces a signed, self-contained evidence bundle that
  verifies offline, on a machine without keel installed.
- The status line and receipts render from recorded state. Where nothing
  structural backs a posture, the UI says so rather than implying protection.

What this proves, and what it deliberately does not, is itemized per claim in the
[claim ledger](../quality/claim-ledger.md).

## Where to go next

- [Getting started](getting-started.md): install, auth, first run.
- [Policy and approval guide](policy-guide.md): reviews, grants, and scopes in
  detail.
- [Running on untrusted repos](untrusted-repos.md): the trust decision and how to
  confirm enforcement is real.
- [Security model](security-model.md): the threat model in plain language.
- [Architecture](architecture.md): how the processes, RPC, and audit chain work.
