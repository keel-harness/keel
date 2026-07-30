# Running keel on an untrusted repo

A repository you did not write is untrusted input. Its `AGENTS.md`, its files, and
anything the model reads from it can try to steer the agent. keel is built for
exactly this case. This guide covers what happens at each trust decision and how to
confirm enforcement is real.

## Before you trust: nothing is read

The first time you run keel in a directory, it stops and asks:

```
Trust this workspace? <path>
[y] trust    [N] decline (default)
```

Until you answer `y`, keel performs zero project-file reads. No `AGENTS.md`, no
skills, no `.keel/` config. Hostile content cannot reach the model before your
decision, because the code that would load it refuses to run first. This is
trust-before-parse.

Non-interactive runs (piped, `CI=true`, no TTY) fail closed to untrusted unless
you explicitly pass `--trust` or set `KEEL_TRUST=1`.

## Declining still works

Decline, and the agent runs with empty project context. It stays functional; it
just has no repo-derived instructions. Your trust choice is remembered per
workspace in your user config, never in the repo, so the repository cannot grant
itself trust on a later run.

## After you trust

Accepting loads project context as inert data: `AGENTS.md` becomes a system
message the model reads but cannot use to escalate privilege, skills appear,
and trusted `.keel/` config (lifecycle, credential proxy) becomes available. The
warden still governs every tool action either way. Trust unlocks reading; it does
not relax enforcement.

Trust is stored realpath-keyed in `<KEEL_HOME>/trust.json` at `0600`.

## Staying cautious inside a trusted repo

Trust is not autopilot. In the default `guided` mode, consequential actions still
pause for your approval. Keep unfamiliar repos in `guided` and let the reviews
come to you. Autopilot and Project Autopilot are opt-in, human-set, and
trusted-workspace only; a repo can never raise its own mode.

## Confirm enforcement is real

You do not have to take keel's word for it.

**See a denial happen.** Ask the agent to read something outside the workspace,
for example `cat ~/.ssh/id_rsa`. The warden denies it, the model gets a
"blocked by warden (not executed)" message, and the denial is recorded.

**Export the proof.** After the session:

```sh
keel audit export <session-id>
keel audit verify <bundle>
```

The bundle is a signed, self-contained record of every governed action, denials
included, and it verifies offline. Compare the printed signer key against a key
you obtained out of band to confirm it is your warden's record.

**Test the sandbox directly.** From a source checkout:

```sh
pnpm test:sandbox:real    # real Seatbelt / bubblewrap denial probes
```

An unavailable sandbox backend fails this suite rather than skipping it.

## Know the limits

keel constrains what a fooled agent can do through governed tools. It does not
make hostile code safe to run, and it is not an EDR: it does not defend against
malware already running as your user. The full boundary is in the
[security model](security-model.md). Trust a workspace only if you would run its
code yourself.
