# Prior-art study — resolved-address egress enforcement

**Status:** design study supporting ADR-0086. **Date:** 2026-08-01.

Follows the `borrowed-techniques.md` posture: study real code, record the license gate, adopt
*techniques* re-implemented independently, and say plainly what is not taken.

## Source studied

| Scaffold | What it is | License | Reuse posture |
|---|---|---|---|
| `yc-software/qm` @ `7f2c916` (2026-07-31) | A multiplayer agent harness for organizations. Operates a forced egress proxy for its sandboxes: Envoy data plane + a Node decision service, deployed as its own service. | **MIT** — verified by reading `LICENSE` at the pinned commit; full MIT text, "Copyright (c) 2026 QM contributors". In the charter's permissive allowlist. | Ideas adopted, re-implemented independently. **No code copied.** MIT would permit code reuse with attribution; the primitives are small enough that independent implementation is cleaner than vendoring. |

Files actually read: `src/egress-authz-main.ts`, `src/util/network.ts`,
`src/resolution/egress-policy.ts`, `src/auth/capability-token.ts`, `deploy/egress-proxy/envoy.yaml`,
`deploy/egress-proxy/{Dockerfile,start.sh,fly.toml}`, `test/egress-authz.test.ts`, `SECURITY.md`.

## Technique register

Legend — Adopt: ✅ adopt · ⚠️ adopt-the-idea-with-changes · ❌ don't.

| # | Technique | Adopt | Note (mechanism → keel re-implementation) |
|---|---|---|---|
| 1 | **Resolve in the decision layer, validate every answer, hand the vetted address to the dialer** so the data plane cannot re-resolve. `egress-authz-main.ts:92-119`; `envoy.yaml:107-113` consumes it via an `ORIGINAL_DST` cluster keyed on `x-egress-upstream-address`. | ✅ | The core anti-rebinding mechanism, and the thing keel lacks. keel's guard resolves and dials in one process, so no address-passing header is needed — which also removes the header-spoofing class qm must strip in Lua (`envoy.yaml:69`). |
| 2 | **Deny if *any* resolved answer is denied** (`egress-authz-main.ts:108-117`), not just the first. | ✅ | Subtle and load-bearing. keel adds a test where only the *last* answer is denied. |
| 3 | **A `node:net` `BlockList` over resolved addresses** (`src/util/network.ts`, 46 lines, stdlib-only). | ⚠️ | Adopt the shape; keel's range list is broader — qm omits NAT64 `64:ff9b::/96` (it has only the local-use `64:ff9b:1::/48`), 6to4 `2002::/16`, Teredo `2001::/32`, IPv4-compatible `::/96`, and Azure's `168.63.129.16`, which sits in public space and no CIDR catches. |
| 4 | **Unconditional metadata/link-local denial no policy can override**, applied at multiple layers (`envoy.yaml:27-47` static routes, `egress-authz-main.ts:97`, `start.sh` iptables). | ✅ | keel applies it in the guard and keeps the OS sandbox as the independent second layer. |
| 5 | **Fail closed everywhere** — DNS error, empty answers, decision service unreachable (`egress-authz-main.ts:101-106`; `envoy.yaml:83-90`). | ✅ | Extended: keel also fails closed when the guard is *configured but not honoured*, which qm's architecture cannot express and which is the likelier failure here. |
| 6 | **Pin a single address** (`egress-authz-main.ts:118` returns `ips[0]`). | ❌ | Rejected. keel retains the whole vetted set and dials in order, preserving DNS failover with the same guarantee. |
| 7 | **Private-range denial as opt-in policy** with `privateNetworkAllowedHosts` (`egress-authz-main.ts:107-114`). | ⚠️ | keel inverts the default to deny, and scopes exceptions as `{host, cidr}` pairs rather than host-only — a host-only exception could otherwise reach loopback. keel's posture is stricter than the prior art's, not equal to it. |
| 8 | **Per-turn capability tokens** carrying the egress policy (`auth/capability-token.ts`). | ❌ | Answers a question keel does not have: qm has many mutually-untrusting scopes behind one boundary, so the proxy must learn *whose* policy applies. keel's warden is already the in-process authority. |
| 9 | **Envoy data plane + Lua ext-authz.** | ❌ | Hosted multi-tenant architecture. keel is one process pair, local-first. |
| 10 | **Batched signed audit relay to a central API** (`createRelayAuditSink`). | ❌ | keel has its own tamper-evident local audit chain; a relay would contradict the no-telemetry non-goal. |
| 11 | **`EGRESS_TOKENLESS=open` compatibility escape hatch** (`egress-authz-main.ts:241`). | ❌ | A fail-open switch. keel must not have one. |
| 12 | **Cloud network policy forcing traffic to the proxy port**, with the honest "port leak" note in `deploy/egress-proxy/fly.toml`. | ❌ | keel's equivalent is the OS sandbox (bwrap `--unshare-net`, Seatbelt), which is destination-scoped rather than port-scoped and therefore does not have the leak. Worth recording that qm documents its own residual plainly — the same posture keel aims for. |

## Honest read

The transferable content is four ideas — resolve-in-the-decider, validate-every-answer,
deny-any-bad, fail-closed — plus a range list, none of which requires the architecture around them.
Roughly 80 lines of the studied system generalizes; the remaining several hundred are a deployment
model keel's non-goals rule out. The most useful thing the study surfaced was not a technique but a
*test name*: qm's `"authorization returns the vetted upstream address so the data plane cannot
re-resolve it"` names the property precisely, and keel's equivalent assertion — on the dialer's
arguments, never on a resolver call count — is the single most important test in ADR-0086.
