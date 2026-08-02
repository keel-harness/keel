# keel documentation index

A map of the docs, by what you're trying to do. New here? Start with the
[architecture one-pager](architecture.md), then the top-level [`README.md`](../README.md).

## Start here

- **[architecture.md](architecture.md)**: the one-page tour: the kernel/warden split, the ports,
  connect-time egress checks, the audit record, and honest phasing.
- **[../README.md](../README.md)**: what it is, how to try it, configuration, and the honest
  status/limitations.
- **[roadmap.md](roadmap.md)**: where keel is going and roughly in what order: what's shipped,
  what's next, and the deliberate non-goals. Directional, not a commitment.

## Using keel

- **[guide/getting-started.md](guide/getting-started.md)**: authenticate, launch a session, and
  the everyday commands.
- **[guide/concepts.md](guide/concepts.md)**: the core ideas: the model/warden split, trust,
  autonomy postures, reviews, and evidence.
- **[guide/reference.md](guide/reference.md)**: every command, run flag, environment variable,
  operator-managed egress exception, and file.
- **[guide/policy-guide.md](guide/policy-guide.md)**: autonomy modes, live approvals, and grant
  scopes: what the footer, `/policies`, Autopilot, and YOLO mean.
- **[guide/untrusted-repos.md](guide/untrusted-repos.md)**: running keel on a repo you did not
  write, and confirming enforcement is real.
- **[guide/audit-and-sessions.md](guide/audit-and-sessions.md)**: reviewing what keel did: audit
  logs, signed evidence bundles, and resuming past sessions.

## Understanding keel

- **[guide/security-model.md](guide/security-model.md)**: the threat model in plain language,
  including connect-time egress enforcement and its backend-specific limits.
- **[guide/architecture.md](guide/architecture.md)**: the deep-dive: processes, RPC, the
  enforcement chain, and the audit chain. (For the short version, the
  [one-pager](architecture.md).)
- **[guide/reviewing-keel.md](guide/reviewing-keel.md)**: a two-hour, function-by-function map of
  policy decisions, durable audit writes, and sandbox-profile projection for security reviewers.

## Understanding the design (deeper)

- **[../MASTER_SPEC.md](../MASTER_SPEC.md)**: the full governing spec (mission, threat model §3,
  architecture, security claims, phase gates, frozen interfaces). Authoritative but long; read the
  architecture one-pager first.
- **[quality/claim-ledger.md](quality/claim-ledger.md)**: every security claim mapped to its
  evidence and its honest limits. The place to check what is actually proven vs. planned.
- **[benchmarks.md](benchmarks.md)**: honest, reproducible capability numbers (TerminalBench),
  with every caveat: single-trial, subset, sandbox-off. Capability only, not a security measure.
- **[adr/](adr/)**: Architectural Decision Records: the *why* behind the design, so the reasoning
  survives forks.

## Contributing

- **[../AGENTS.md](../AGENTS.md)**: the engineering charter and operating rules (binding for humans
  and agents alike).
- **[../CONTRIBUTING.md](../CONTRIBUTING.md)**: contribution workflow.
- **[../SECURITY.md](../SECURITY.md)**: security policy and how to report a vulnerability.
- **[guide/releasing.md](guide/releasing.md)**: the stage-only npm carrier release runbook and its
  human 2FA/verification boundary.

## Design and research archive

`design/` contains architectural explorations and retained design rationale. `research/`
contains reproducible technical research, source analysis, and measured spikes. They are
public supporting material rather than the primary path for using keel. Epic execution
plans, capability specs, and the contributor progress ledger are curated out of the public
release.
