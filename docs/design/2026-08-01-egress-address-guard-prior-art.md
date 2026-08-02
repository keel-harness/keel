# Prior-art and design validation — connect-time egress address guard

**Status:** design study supporting accepted ADR-0086. **Date:** 2026-08-01.

## Conclusion

The original Warden parent-proxy proposal is not safe to implement. It misses SRT's TLS-terminated
upstream connection—the path ADR-0066 needs for secure credential injection—and has additional
loopback, ambient-proxy, MITM, and external-proxy bypass surfaces.

The smallest complete design is a minimal vendored SRT seam that asks the Warden to resolve and vet
each final destination immediately before connection, then gives Node/Bun a lookup function pinned to
that exact vetted set. This preserves the original hostname for HTTP/TLS identity, preserves
multi-address failover, adds no listener or dependency, and prevents a second resolution. Executable
probes under Node, Bun, and a compiled Bun carrier support the mechanism. They are design evidence,
not implementation or SEC-003 completion evidence.

## Sources reviewed

Only primary sources, official documentation, and pinned source were used for security-relevant
claims.

| Source | What was checked | Result |
|---|---|---|
| `yc-software/qm` @ `7f2c916360` | `src/egress-authz-main.ts`, `src/util/network.ts`, `src/resolution/egress-policy.ts`, capability token, Envoy config, deployment files, tests, `SECURITY.md`, and `LICENSE` | Strong resolve/vet/pin prior art; distributed architecture not a fit |
| Vendored SRT `v0.0.59` @ `3f4233f1` | Every HTTP, CONNECT, SOCKS, TLS-termination, parent-proxy, external-proxy, config, update, and lifecycle path | Four direct destination-dial families; no address guard seam |
| Upstream SRT `v0.0.68` | Current release source and open issue history | TLS upstream still does not honor parent proxy; direct dial still resolves by name; IP/range policy remains open issue #65 |
| Node 20 network/DNS docs | `net.connect`, `http.request`, `https.request`, custom `lookup`, family auto-selection, `dns.lookup` implementation | Supported custom lookup and multi-address failover; `dns.lookup` uses OS `getaddrinfo` in libuv's pool |
| Bun 1.3.14 | Executable source and `bun build --compile` probes | Compatible with the required lookup callback and pinned-address mechanism in the tested carrier |
| OWASP SSRF Prevention Cheat Sheet | DNS-pinning guidance | Resolve and validate all returned A/AAAA addresses; deny if any violates policy |
| IANA IPv4/IPv6 special-purpose and allocation registries | Prefixes, overlap, allocation, `Globally Reachable`, registry update data | Generated longest-prefix snapshot is safer than a hand-maintained block list |
| AWS, Google Cloud, Microsoft Azure, Alibaba Cloud, and Oracle Cloud docs | Metadata endpoints and security significance | Provider-specific exact endpoints must supplement generic special-range policy |

No external code is copied. The qm source is MIT; SRT is Apache-2.0 and already vendored under
ADR-0005. The proposed change is an independently implemented patch to the existing SRT vendor tree.

Primary references:

- qm pinned prior art: <https://github.com/yc-software/qm/tree/7f2c916360>.
- SRT source, releases, and IP-policy request: <https://github.com/anthropic-experimental/sandbox-runtime>,
  <https://github.com/anthropic-experimental/sandbox-runtime/releases/tag/v0.0.68>, and
  <https://github.com/anthropic-experimental/sandbox-runtime/issues/65>.
- Node network and DNS APIs:
  <https://nodejs.org/download/release/latest-v20.x/docs/api/net.html>,
  <https://nodejs.org/download/release/latest-v20.x/docs/api/http.html>, and
  <https://nodejs.org/download/release/latest-v20.x/docs/api/dns.html>.
- OWASP SSRF prevention:
  <https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html>.
- IANA special-purpose registries:
  <https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml>
  and
  <https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml>.
- IANA allocation registries:
  <https://www.iana.org/assignments/ipv4-address-space/ipv4-address-space.xhtml> and
  <https://www.iana.org/assignments/ipv6-unicast-address-assignments/ipv6-unicast-address-assignments.xhtml>.
- Provider metadata documentation: [AWS EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html),
  [Google Compute Engine](https://docs.cloud.google.com/compute/docs/metadata/querying-metadata),
  [Microsoft Azure](https://learn.microsoft.com/en-us/azure/virtual-machines/metadata-security-protocol/overview),
  [Alibaba ECS/ECI](https://www.alibabacloud.com/help/en/eci/user-guide/obtain-the-metadata-from-a-container),
  and [Oracle Cloud](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/gettingmetadata.htm).

## Current SRT connection-path audit

### Pinned `v0.0.59`

| Client path | Name-policy point | Final outbound operation | Why a parent proxy is insufficient |
|---|---|---|---|
| HTTP `CONNECT` opaque tunnel | `http-proxy.ts` `options.filter(port, hostname)` | `dialDirect(hostname, port)` → `net.connect(port, host)` | Parent path bypasses loopback; external MITM can take precedence |
| SOCKS5 CONNECT | `socks-proxy.ts` ruleset validator | `dialDirect(host, port)` → `net.connect(port, host)` | Same loopback and parent behavior |
| Plain absolute-form HTTP | `http-proxy.ts` filter + optional request filter | `http.request({hostname, port})` | Parent receives and can resolve the hostname; global Agent is process-shared |
| Absolute-form HTTPS | Same | `https.request({hostname, port})` | Same; uncommon but supported and therefore in scope |
| TLS-terminated HTTPS | CONNECT name filter, then terminated request filter | `https.request({host: target.hostname, agent:false})` | Source contains a TODO to honor parent proxy; it always dials directly |
| `mitmProxy` match | SRT name filter | Unix-socket peer owns the destination dial | SRT cannot prove the peer's address decision |
| `httpProxyPort` / `socksProxyPort` | External implementation | External proxy owns all handling | Built-in proxy and any local hook are replaced |

SRT resolves `parentProxy` from the Warden process's ambient `HTTP_PROXY`, `HTTPS_PROXY`, and
`NO_PROXY` when explicit URLs are absent. An invalid URL is logged and ignored. This is useful for a
general library but incompatible with a claim-grade guard unless the ambient fallback is explicitly
disabled.

`SandboxManager.updateConfig()` preserves only `filterRequest` across `structuredClone`, so a new
function-valued resolver must receive the same treatment. The HTTP and SOCKS proxy constructors
capture routing configuration during initialize. Keel therefore installs one immutable resolver and
exception-policy snapshot before SRT initialization; per-execution network updates may narrow names
but may not replace address authority.

The Keel adapter audit exposed an adjacent claim/evidence gap: its `VendoredSrtRuntimeConfig` and
`completeVendoredRuntimeConfig()` carry name rules and credential values but not
`network.tlsTerminate`. The real SRT credential fixture sets `allowPlaintextInject:true` and uses
HTTP/localhost. ADR-0066 says TLS is the default product posture, so a real verified HTTPS credential
path is still required before release. This finding reinforces the architecture choice—address
enforcement must work on TLS termination—but does not count as its remediation.

### Current upstream

The public SRT release checked during this study was `v0.0.68` (2026-07-24). Its
`tls-terminate-proxy.ts` still carries `TODO(terminating-tls): honour parentProxy for the upstream
leg`, then calls `httpsRequest` directly. Its `parent-proxy.ts` still uses `netConnect(port, host)` in
`dialDirect()` and still unconditionally bypasses `localhost`, `127.0.0.0/8`, `::1`, and mapped
loopback. Open issue #65 asks for IP/range-based network rules and specifically calls out private,
link-local, loopback, and metadata protection. No upstream resolver/address-guard seam was found.

## Comparative architecture review

| Option | Complete across current SRT paths? | New parser/listener? | Secure TLS credential injection? | Re-resolution risk | Decision |
|---|---:|---:|---:|---:|---|
| Warden HTTP parent proxy | No | Yes | **No** | Parent/proxy can resolve again | Reject |
| Pass a raw Node-style `lookup` callback into existing calls | Almost | No | Yes | None for names; runtime skips it for IP literals | Reject as incomplete |
| Explicit `resolveDestination(host, port)` then pinned lookup | **Yes** | No | **Yes** | None on guarded paths | **Choose** |
| Process-global `dns.lookup` monkeypatch | Broad but uncontrolled | No | Yes | None where honored | Reject: affects Warden traffic and is order-sensitive |
| Replace SRT HTTP + SOCKS proxies | Potentially | Yes, two protocols | Only after reimplementation | Depends on implementation | Reject: duplicates too much security code |
| Envoy + decision service, as in qm | Yes in that deployment | Several services | Separate design | Prevented by vetted-address handoff | Reject for local-first keel |
| Grant-time resolution only | No | No | Irrelevant | DNS can change after grant | Reject |

The chosen helper must call the Warden resolver itself before creating the request/socket. Merely
placing a custom `lookup` option on Node/Bun calls is insufficient because runtimes skip lookup for an
IP literal. After vetting, a tiny callback returns the already-vetted set to the actual network API.
The actual request retains the original hostname for `Host`, SNI, and certificate verification.

Parent, external, and MITM proxy modes are rejected at SRT initialization while the hook is active.
Supporting a corporate parent safely would require CONNECTing to a vetted IP (including for plain
HTTP) while preserving the logical hostname; that is a separate architecture and compatibility
surface, not an escape hatch for this epic.

## Executable mechanism probes

The probes lived under temporary `design-probes/` in the isolated ADR worktree and are deliberately
not product code. They used loopback listeners only; no external destination was contacted.

### Runtime matrix

Environment:

- macOS/Darwin arm64;
- Node `v20.14.0`;
- Bun `1.3.14`; and
- Bun standalone executables produced by `bun build --compile`.

Commands exercised:

```text
node design-probes/lookup-hook-probe.mjs
bun design-probes/lookup-hook-probe.mjs
bun build --compile design-probes/lookup-hook-probe.mjs --outfile <probe-bin>
<probe-bin>

node design-probes/guarded-lookup-probe.mjs
bun design-probes/guarded-lookup-probe.mjs
bun build --compile design-probes/guarded-lookup-probe.mjs --outfile <guarded-probe-bin>
<guarded-probe-bin>
```

Observed results:

| Property | Node | Bun | Compiled Bun |
|---|---:|---:|---:|
| `net.connect` invokes supplied lookup for a hostname | Pass | Pass | Pass |
| `http.request` invokes supplied lookup for a hostname | Pass | Pass | Pass |
| `https.request` invokes supplied lookup before connection | Pass | Pass | Pass |
| Successful HTTPS round trip through supplied lookup | Pass | Pass | Mechanism covered before compile; full TLS round trip not run in compiled probe |
| Lookup receives `all:true` under family auto-selection | Pass | Pass | Pass |
| Multiple returned addresses retain connection failover | Pass | Pass | Pass |
| Runtime skips custom lookup for an IP literal | Confirmed | Confirmed | Confirmed |
| Explicit pre-classification catches the IP literal | Pass | Pass | Pass |
| Mixed answer set denies before any upstream connection | Pass | Pass | Pass |
| Resolve once, pin once; hostile hypothetical second answer is never requested | Pass | Pass | Pass |

The guarded prototype's key result was identical in all three carriers:

```json
{
  "resolveOnceAndPin": { "status": 200, "resolverCalls": 1 },
  "denyIfAnyAnswerDenied": { "denied": true, "upstreamConnections": 0 },
  "classifyIpLiteralFirst": { "denied": true, "classifications": 1 }
}
```

A successful Node and Bun HTTPS fixture also confirmed that the custom lookup can return a vetted
loopback address while the request retains a different logical hostname. Certificate verification
was disabled only in that mechanism probe; ADR-0086 requires the real TLS-termination integration
test to retain normal verification and SNI.

Node and Bun both treated IPv4-mapped loopback as matching an IPv4 subnet placed in `net.BlockList`
when checked as IPv6. The production classifier still decodes mapped addresses and recursively checks
the embedded IPv4 value because that rule is explicit, testable, and independent of undocumented
cross-family convenience.

### Pooling observation

The probe intentionally made two HTTP requests through a keep-alive Agent. Lookup occurred on socket
creation rather than as a per-request policy callback, and Node/Bun behavior was not identical in the
small fixture. This is expected network-client behavior, not a guard failure: a reused socket is
already bound to its vetted peer. It does expose a separate risk—SRT's plain HTTP path currently uses
the process-global Agent, which can share sockets with unrelated Warden code. ADR-0086 therefore uses
`agent:false` for guarded request paths in v1. Guard-owned pooling can be introduced only with an
immutable policy revision and its own conformance/performance proof.

## Resolver and scale findings

### Why `dns.lookup`

`dns.lookup(..., {all:true, verbatim:true})` uses the operating system's `getaddrinfo`, matching the
normal resolution behavior of `net.connect`, including hosts files, NSS, VPNs, and split DNS.
`dns.resolve4/resolve6` use a separate DNS implementation and ignore some of those sources. Because
the returned set becomes the only set SRT may dial, matching host resolver semantics is more useful
than separately querying authoritative-looking A/AAAA data the application would not normally use.

OWASP's important invariant still applies: validate every address returned by the chosen resolver and
deny the request if any one is unsafe. The documents and tests must say “all OS-resolver answers,” not
claim observation of every record that could exist at an authoritative DNS server.

### Bounded thread-pool work

Node documents `dns.lookup` as synchronous `getaddrinfo` work running in libuv's thread pool. It has no
AbortSignal. A JavaScript timeout can stop a client from waiting but cannot cancel the underlying
lookup. A correct limiter therefore holds its concurrency slot until the real callback arrives; if it
released on timeout, an attacker could create unbounded hidden work. A fixed in-flight cap, fixed wait
queue, late-result suppression, and shutdown tests are required. The values are selected and recorded
from the epic's load test, not exposed to workspace configuration.

### Connections and audit

The address hook adds no listener and no additional network hop. Work is per new outbound connection:
one OS lookup, classification over a bounded set, then the original SRT connection. A connection storm
can still pressure DNS, file descriptors, and authoritative audit writes, so the implementation needs
bounded guarded connections and a deny-all circuit breaker after a bounded denial/audit rate. The
load test must track p95 latency, throughput, RSS, open descriptors, queue depth, audit growth, and
shutdown completion; there is no performance claim before measurement.

## Address-policy research

### Generated IANA snapshot, not a handwritten list

The IANA registries contain overlaps. For example, `192.0.0.0/24` is generally non-global while
`192.0.0.9/32` and `192.0.0.10/32` are globally reachable anycast exceptions. IPv6 has the same kind
of nested allocations under broader special-purpose blocks. Flat checks and insertion-order
`BlockList` calls cannot express the policy clearly. A pinned generated longest-prefix table makes
the source, snapshot, exceptions, and diff review explicit.

The special-purpose registries are combined with IANA's IPv4 allocation and IPv6 global-unicast
allocation registries. That makes public access an affirmative property of allocated global space,
not the accidental remainder after a deny list. Newly allocated space remains fail-closed until a
reviewed snapshot refresh.

The registry is not sufficient by itself:

- provider metadata can occupy an address IANA otherwise considers ordinary or broadly private;
- NAT64, 6to4, Teredo, and obsolete compatible forms can embed or delegate another destination; and
- malformed or zone-qualified literals require parser policy before prefix classification.

ADR-0086 therefore layers explicit hard denials above the registry-derived public/restricted class.

### Provider metadata inventory

| Provider | Officially documented endpoint relevant here | Policy |
|---|---|---|
| AWS EC2 | `169.254.169.254`, IPv6 `fd00:ec2::254` | Hard deny |
| Google Compute Engine | `metadata.google.internal`, `169.254.169.254`, IPv6 `fd20:ce::254`; `metadata.goog` is also reserved for metadata use | Hard deny name and address |
| Microsoft Azure | IMDS `169.254.169.254`; WireServer `168.63.129.16` | Hard deny; WireServer needs an exact public-space rule |
| Alibaba ECS/ECI | MetaServer `100.100.100.200` and role credentials beneath it | Hard deny exact address even if a broad CGNAT exception exists |
| Oracle Cloud | IMDS `169.254.169.254` | Covered by hard link-local denial |

Provider lists evolve, which is why the IANA snapshot has a deterministic refresh process and the
provider exact set has a scheduled review test/documentation task. Runtime never fetches either list.

## qm technique register

| Technique from `yc-software/qm` | Keel posture | Reason |
|---|---|---|
| Resolve in the decision layer, validate, and give the data plane the vetted address | Adopt | Core anti-rebinding invariant |
| Deny if any returned answer is unsafe | Adopt | Prevents resolver-order and mixed-answer bypass |
| `node:net` address primitives and a small classifier | Adopt with changes | Keel uses a generated IANA snapshot plus provider/transition overlays |
| Unconditional metadata/link-local denial | Adopt and broaden | Keel includes exact Azure, Alibaba, AWS IPv6, and Google IPv6 endpoints |
| Fail closed on DNS error, empty set, or decision failure | Adopt and broaden | Also covers saturation, audit failure, shutdown, and unwired/incompatible routes |
| Pin only the first address | Reject | Returning the whole vetted set preserves family/address failover |
| Private-range denial only when an opt-in policy requests it | Reject | Keel defaults to deny and permits only host+CIDR+exact-port exceptions |
| Host-only private exceptions | Reject | Host alone could authorize loopback or an unrelated private subnet |
| Per-turn capability token | Reject | Keel's in-process Warden is already the authority; traffic lacks reliable execution identity |
| Envoy, Lua, ext-authz service, deployment firewall, and audit relay | Reject | Solves a hosted multi-tenant problem and conflicts with local-first/no-telemetry goals |
| Tokenless/open compatibility mode | Reject | Fail-open control |

The most useful qm test names the exact property: the data plane receives the vetted address and
cannot re-resolve. Keel's primary equivalent assertion must inspect the actual connection attempt,
not merely count resolver calls.

## What this study does and does not prove

It proves enough to choose the architecture:

- the parent-proxy design is incomplete;
- the current and latest reviewed SRT releases lack the required seam;
- a resolve/vet/pinned-lookup mechanism works under the relevant Node, Bun, and compiled Bun carrier;
- IP literals require explicit pre-classification; and
- the SRT patch can remain smaller than an additional proxy implementation.

It does **not** prove SEC-003, Linux/macOS sandbox enforcement, credential-injection compatibility,
bounded production load, performance, audit durability, or public CLI behavior. Those require the
red-first implementation and complete evidence matrix in ADR-0086. Until then SEC-003 stays
`DOC-LIMIT`; ADR acceptance records the design decision, not completion evidence.
