# Security Policy

> **Status: pre-alpha; open-source preparation.** keel now has a
> Phase-2 local trust-plane implementation for the documented governed tool
> surfaces, plus signed/offline evidence bundle verification for exported audit
> evidence. Reviewed, pinned local-stdio MCP calls have a bounded Warden-governed
> path; remote, localhost, and unreviewed MCP and richer MCP capabilities remain
> outside proof. This is not a stable or public-alpha release or a compliance
> claim. Reports should be
> evaluated against the current threat model and named limitations in
> `MASTER_SPEC.md` §3 and the claim ledger (`docs/quality/claim-ledger.md`),
> including same-user malware / at-rest key theft, provider API egress, future
> plugin/registry and unclaimed MCP surfaces, and the requirement to compare an
> evidence bundle's signer key with a published or out-of-band signer key before
> treating it as authentic.
> This policy exists so disclosures have a private channel from day one; a full
> policy (response targets, scope, safe-harbor) ships with the public alpha
> (`MASTER_SPEC.md` §9.3).

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — do **not** open a public
issue or pull request.

- Use GitHub **private vulnerability reporting** — the "Report a vulnerability"
  button under the repository's **Security** tab. This is the project's current
  monitored private reporting channel.

We will acknowledge your report within a reasonable time and keep you informed as
we investigate. Please give us a reasonable opportunity to address the issue
before any public disclosure.

To inspect the current enforcement paths, use the [security review map](docs/guide/reviewing-keel.md).
It points to the policy-decision, durable-audit, and sandbox-projection seams by function name.

## Scope

This repository is pre-alpha. Reports about code **present in this repository** are in
scope. Reports that a documented limitation is not covered by the current threat model
are still useful, but they should be framed as design or claim-honesty issues unless the
code claims or appears to enforce that property.
