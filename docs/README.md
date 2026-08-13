# keel documentation index

A map of the docs, by what you are trying to do. New here? Start with
[Getting started](guide/getting-started.md), then read the
[architecture one-pager](architecture.md).

## Start here

- **[guide/getting-started.md](guide/getting-started.md)** — install, authenticate, complete a
  governed change, and learn the everyday commands.
- **[architecture.md](architecture.md)** — the one-page tour: the kernel/warden split, the ports,
  connect-time egress checks, and the audit record.
- **[status.md](status.md)** — what is true today: the release status, what keel governs, and
  every limitation. Read this before relying on any claim.
- **[roadmap.md](roadmap.md)** — where keel is going, and the deliberate non-goals. Directional,
  not a commitment.

## Using keel

- **[guide/concepts.md](guide/concepts.md)** — the core ideas: the model/warden split, trust,
  autonomy postures, reviews, and evidence.
- **[guide/reference.md](guide/reference.md)** — every command, flag, environment variable, and
  file.
- **[guide/policy-guide.md](guide/policy-guide.md)** — autonomy modes, live approvals, and grant
  scopes.
- **[guide/untrusted-repos.md](guide/untrusted-repos.md)** — running keel on a repo you did not
  write, and confirming enforcement is real.
- **[guide/audit-and-sessions.md](guide/audit-and-sessions.md)** — audit logs, signed evidence
  bundles, and resuming past sessions.

## Understanding keel

- **[guide/security-model.md](guide/security-model.md)** — the threat model in plain language,
  including connect-time egress enforcement and its backend-specific limits.
- **[guide/architecture.md](guide/architecture.md)** — the deep-dive: processes, RPC, the
  enforcement chain, the audit chain, and the repository layout.
- **[guide/reviewing-keel.md](guide/reviewing-keel.md)** — a two-hour, function-by-function map
  for security reviewers.
- **[quality/claim-ledger.md](quality/claim-ledger.md)** — every security claim mapped to its
  evidence and its honest limits.
- **[benchmarks.md](benchmarks.md)** — capability numbers (TerminalBench) with every caveat.
  Capability only, not a security measure.

## Going deeper

- **[../MASTER_SPEC.md](../MASTER_SPEC.md)** — the full governing spec: mission, threat model §3,
  architecture, security claims, phase gates, frozen interfaces. Authoritative but long; read the
  architecture one-pager first.
- **[adr/](adr/)** — Architectural Decision Records: the *why* behind the design, so the reasoning
  survives forks.

## Contributing

- **[../CONTRIBUTING.md](../CONTRIBUTING.md)** — contribution workflow.
- **[../AGENTS.md](../AGENTS.md)** — the engineering charter and operating rules, binding for
  humans and agents alike.
- **[../SECURITY.md](../SECURITY.md)** — security policy and how to report a vulnerability.
- **[guide/releasing.md](guide/releasing.md)** — the npm carrier release runbook.

## Archive

[`design/`](design/) holds architectural explorations and retained design rationale.
[`research/`](research/) holds reproducible technical research, source analysis, and measured
spikes. Both are dated snapshots that produced the ADRs they cite — supporting material, not
current documentation. Epic execution plans and the contributor progress ledger are not part of
the public release.
