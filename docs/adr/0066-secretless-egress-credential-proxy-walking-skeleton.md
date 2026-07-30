# ADR-0066 - Secretless egress credential proxy

- **Status:** **Accepted** (2026-06-27). Records the Epic 2.10 governed-bash
  secretless-egress credential proxy. Changes **no** frozen interface, protocol, schema,
  audit format, CLI contract, Appendix A/B/D/E entry, `WARDEN_METHODS`, `AuditRecord`,
  `PolicyInput`, `SideEffect`, grant scope, or all-tool public product claim.
- **Date:** 2026-06-27.
- **Deciders:** keel maintainer direction for the Epic 2.10 build.
- **Governs:** parent-side credential resolution and SRT Authorization-header injection
  for governed `bash` only. Relates to MASTER_SPEC
  §3.2(1)/(6), §3.3, §4.2, §4.3, §4.8, §4.9, ADR-0005, ADR-0016, ADR-0017, ADR-0039,
  ADR-0056, and ADR-0061.

## Context

Epic 2.10 is the secretless egress credential proxy: a sandboxed tool should be able to
authenticate to an allowlisted host without the sandbox ever receiving the real token.
The original plan was staged because the warden, `SandboxPort`, egress proxy, and egress
grant UX did not exist yet. That blocker is now stale: the Phase-2A foundation provides
the governed-bash warden path, SRT-backed sandbox, and egress profile needed to prove a
governed-bash product slice.

The remaining danger is overclaiming. This slice is not the all-tool typed-tool bridge,
not real-model product-path governance, and not broad request-level MITM hardening. It is
a governed-bash proof that the current kernel trust gate, warden, and SRT boundary can
load a trusted secretless-egress config, resolve credentials parent-side, inject or swap
an Authorization header on the bound host, block placeholder leaks, and keep the real
secret out of sandbox-visible and kernel-visible serialized surfaces.

The existing secret-handling ADR (ADR-0039) owns redaction, `0600` storage, and future
secret-store adapters. This ADR does not replace it. For this walking skeleton, the only
implemented credential sources are `{kind:"env"}`, `{kind:"file"}`, and
`{kind:"command"}` resolved in the parent warden process. Command sources are argv-only
and require absolute command paths; shell-string command sources are intentionally not
accepted.

## Decision

For Epic 2.10, keel implements a warden-owned credential-proxy rule path:

1. A `CredentialProxyRule` is warden-owned configuration, not a frozen shared schema.
   Trusted project config lives in `.keel/credential-proxy.json` and is read only after
   workspace trust. The kernel forwards that secret-free JSON to the warden child.
2. The rule shape supports `mode:"swap_on_access"` and `mode:"placeholder"`, `host`,
   `scheme`, `source:{env|file|command}`, and optional plaintext fixture opt-in.
   Placeholder mode requires a named sandbox env var; the value placed there is a
   generated `keelcred_*` placeholder, never the real secret.
3. The warden resolves the source parent-side immediately before execution. If the source
   is missing or empty, the request fails closed with a `tool.deny` audit record before
   sandbox execution. The audit payload contains only a secret-free rule summary.
4. Configured credential hosts are folded into the sandbox egress profile so the request
   can reach the host without asking the model or user for a separate grant.
5. File sources are added to the sandbox profile's deny-read set so a workspace-visible
   secret file is not readable by governed bash while still being resolvable by the
   parent warden.
6. The resolved secret is passed only as a host-side SRT per-call runtime credential
   (`credentials.authorizationHeaders` / `credentials.authorizationPlaceholders`). It is
   stripped from child spawn descriptors and runner options.
7. Vendored SRT installs stable dynamic request filtering and mutation that read the
   latest per-call runtime config. Swap-on-access injects `Authorization:
   <scheme> <secret>` only when the destination host matches a configured host.
   Placeholder mode swaps only a known placeholder bound to that host and scheme.
8. Wrong-host and unknown `keelcred_*` placeholder values receive 403 before upstream
   dial. Existing non-placeholder `Authorization` headers are forwarded untouched.
9. TLS is still the default requirement for credential injection. Plaintext injection is
   allowed only behind an explicit `allowPlaintextInject` flag used by the local fixture
   tests; it is not the product posture.
10. `keel doctor` validates explicitly supplied credential-proxy JSON without echoing
    source details. The frozen warden status schema and product HUD are unchanged.
11. The resolved secret must not appear in sandbox env, argv, profile/policy input, audit
   payloads, RPC responses, status, receipts, public summaries, or kernel-visible
   surfaces.

## Options Considered

1. **Promote the config into a frozen shared schema.** Rejected for this slice. The
   product path needs governed-bash proof first; frozen/public schemas should wait until
   the all-tool typed bridge and longer-term compatibility story are ready.
2. **Pull Phase-4 request-level MITM forward.** Rejected. The needed mechanism is
   Authorization-header injection only; request body inspection and per-API rules remain
   Phase 4.
3. **Inject the secret into sandbox env and rely on redaction.** Rejected. That violates
   the entire secretless-egress claim: redaction is not an enforcement boundary.
4. **Warden-owned project config plus SRT host-memory header injection.** Chosen. It is
   the smallest vertical proof through the real kernel trust gate, warden, and SRT
   boundary while avoiding frozen contract churn.

## Consequences

- Epic 2.10 gives keel a real governed-bash proof that a fixture upstream sees the
  injected/swapped `Authorization` header while the sandbox does not receive the real
  token.
- Missing sources fail closed before side effects, and the denial is audited without
  serializing the secret.
- The implementation intentionally underclaims: no all-tool governance, no real-model
  product path, no status/HUD indicator, no keychain source, no signed/offline evidence,
  no CONNECT/SNI hardening, and no provenance-taint enforcement.
- Because no frozen contract changed, downstream callers cannot depend on the internal
  rule shape as a public protocol. A future shared `CredentialProxySpec` must receive a
  separate stop-and-ask review before landing.
- The SRT mutator is host-bound and no-clobber by construction, but this does not solve
  broader redirect/DNS/CONNECT/SNI hardening or provenance-taint enforcement. Those
  remain in the existing egress/security backlog.

## Evidence

Epic 2.10 is covered by:

- `packages/warden/src/credential-proxy.test.ts`
- `packages/warden/src/srt-sandbox.test.ts`
- `packages/warden/src/srt-runtime-loader.test.ts`
- `packages/warden/src/rpc-server.test.ts`
- `packages/kernel/src/warden/runtime.test.ts`
- `packages/kernel/src/cli/doctor.test.ts`
- `packages/kernel/src/cli/security-suite-inventory.test.ts`

The focused suite proves parent-side env/file/absolute-command source resolution,
trusted product config forwarding, fail-closed missing source, source-file deny-read, no
secret in child descriptors/runner options/public summaries/profile/policy/audit/response
surfaces, real SRT fixture Authorization injection/swap when the host allows SRT,
wrong-host and unknown-placeholder 403 leak guard, wrong-host no-injection, existing
Authorization no-clobber, and SEC-027 inventory coverage.

In the Codex filesystem sandbox, vendored SRT cannot bind its loopback proxy and reports
`listen EPERM: operation not permitted 127.0.0.1`; the focused suite takes the
fail-closed unavailable path there. The same focused suite was rerun outside that sandbox
and exercised the real SRT injection path successfully.
