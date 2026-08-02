# ADR-0086 — Warden-owned connect-time egress address guard

- **Status:** **Accepted** (2026-08-01) by explicit maintainer decision. Acceptance authorizes the
  architecture and its public Epic 3.22 plan; it is not implementation, claim-promotion, merge, or
  release authorization. Production behavior changes only through the plan's reviewed TDD slices.
- **Date:** 2026-08-01.
- **Decider:** keel maintainer.
- **Governs:** resolved-address enforcement for SRT-mediated sandbox egress. Relates to ADR-0005
  (vendored Sandbox Runtime), ADR-0017 (agent authority), ADR-0020 (coverage), ADR-0038 (workspace
  trust), ADR-0056 (capability manifest), ADR-0066 (secretless credential injection), ADR-0080
  (runtime truth), and MASTER_SPEC §3.1/§3.2/§3.3/§4.2/§4.3.
- **Anchor:** `docs/design/2026-08-01-egress-address-guard-prior-art.md`.
- **Implementation plan:** [Epic 3.22 — Warden-owned connect-time egress address guard](https://github.com/keel-harness/keel/issues/26).

This ADR changes no frozen RPC method, schema, policy input, side-effect taxonomy, audit record shape,
or grant scope. It does propose public egress behavior, a versioned operator configuration and CLI,
an additive `warden.hello.capabilities[]` value, a non-frozen `SandboxStatus` feature fact, and a
second documented patch to the vendored SRT source.

## Accepted decision

The maintainer accepted all of these stop-and-ask items as one security slice:

1. strengthen the enforcement behind SEC-003;
2. make private and other non-global resolved addresses deny-by-default, changing observable egress;
3. carry a minimal, upstreamable patch in the security-critical vendored SRT source;
4. add a versioned owner-only exception store and human-facing management commands;
5. update MASTER_SPEC §3.3 and the claim ledger only after the implementation evidence passes; and
6. scope the resulting claim to the SRT backend rather than imply every `SandboxPort` backend
   inherits it.

## Prerequisites

Before this epic may merge:

1. Hostname policy must make `localhost`, names beneath `.localhost`, IPv4 and IPv6 loopback
   literals, IPv4-mapped loopback, and non-canonical IP spellings ungrantable. The same refusal must
   cover credential-injection hosts. SRT currently routes loopback around a parent proxy, and host
   loopback is reachable from its host-side proxy process.
2. The public Epic 3.22 issue must retain the slices, red-first tests, risk register, stop triggers,
   verification matrix, and definition of done from this ADR throughout implementation.
3. ADR-0066's TLS-default credential-injection intent must be reconciled with the current adapter.
   `VendoredSrtRuntimeConfig` and `completeVendoredRuntimeConfig()` do not carry
   `network.tlsTerminate`, and Keel's real SRT credential fixture opts into plaintext. Before a
   release can rely on the secure credential path, a red test must prove real HTTPS injection with
   ordinary certificate verification, or the affected public claim must be narrowed. The chosen
   address hook supports that path; the rejected parent proxy does not.

There is deliberately no `allowLoopback` escape hatch in this epic. A future host-service bridge must
be a separately reviewed, exact-host, exact-port capability with its own threat model and evidence; a
generic loopback grant would reopen the boundary this ADR closes.

## Context

keel's current egress boundary authorizes a **name** and then lets the operating system resolve that
name during the later connection. A granted name can therefore resolve to a public address during
review and a private, loopback, link-local, or metadata address during execution. This is the DNS
rebinding gap recorded as SEC-003 `DOC-LIMIT` and in MASTER_SPEC §3.3.

The current residual is bounded but real:

- deny-all remains the default;
- direct IP-like grant patterns are rejected;
- redirect-to-IP is denied by requested-host filtering; but
- after a human grants a domain, the destination address used by the host-side proxy is not checked.

The pinned vendored SRT (`v0.0.59`) has four direct destination-dial paths:

| Path | Current outbound operation | Parent proxy covers it? |
|---|---|---:|
| Opaque HTTP `CONNECT` | `dialDirect()` → `net.connect(host)` | Yes, except bypasses |
| SOCKS5 CONNECT | `dialDirect()` → `net.connect(host)` | Yes, except bypasses |
| Absolute-form HTTP/HTTPS | `http.request` / `https.request` with `hostname` | Yes, except bypasses |
| TLS-terminated HTTPS | `https.request` with `host` and `agent:false` | **No** |

That last row is decisive. ADR-0066 requires TLS by default for host-side credential injection, and
SRT implements that path through TLS termination. SRT's TLS upstream leg explicitly does not honor
`parentProxy`; the same TODO remains in upstream release `v0.0.68`. A parent proxy would therefore
force keel to choose between the address guard and the intended secure credential path. It is not an
acceptable enforcement architecture.

The code audit also found that Keel does not currently expose `network.tlsTerminate` through its
vendored-runtime adapter. Existing end-to-end credential tests use the explicit plaintext-fixture
escape hatch. This is an adjacent release-readiness gap, not evidence against TLS termination or a
problem this ADR may hide. It is recorded as a prerequisite above and remains unproven until the real
HTTPS product path passes.

Other routes can also escape a parent-proxy-only design: `mitmProxy` owns its upstream connection;
`httpProxyPort` and `socksProxyPort` replace SRT's proxies; loopback bypasses the parent; and ambient
`HTTP_PROXY`/`HTTPS_PROXY` can silently change routing. The address decision must sit at SRT's final
direct destination dial, not one hop above it.

## Decision

keel will implement a **Warden-owned connect-time egress address guard** through a minimal vendored
SRT resolver seam. SRT continues to own its proxy endpoints and name allowlist. The Warden resolves
and classifies the requested destination, and SRT dials only the returned vetted address set.

### 1. Add one explicit, fail-closed SRT seam

The vendored SRT network configuration gains an optional host-side callback equivalent to:

```ts
type ResolveDestination = (
  hostname: string,
  port: number,
  signal: AbortSignal,
) => Promise<readonly { address: string; family: 4 | 6 }[]>;
```

The exact upstream-facing name may change during the red-first patch, but the contract may not:

- SRT invokes it for **every** TCP destination, including an IP literal.
- An exception, rejection, timeout, empty result, malformed answer, or closed signal denies before an
  upstream socket opens.
- The returned set is authoritative. SRT gives the original hostname plus a lookup function pinned to
  that exact set to `net.connect`, `http.request`, or `https.request`; it never falls back to a raw
  hostname dial or performs another resolution.
- The original hostname remains the HTTP `Host`, TLS certificate-verification name, and SNI value.
- SRT canonicalizes the destination once with its existing strict host parser before both the name
  filter and resolver. The Warden and exception CLI share a conformance corpus for that canonical
  ASCII form; policy comparison never mixes raw SOCKS bytes, URL output, and separately normalized
  strings.
- SRT validates every returned address with `net.isIP()` and rejects family mismatches, duplicates
  after normalization, and over-limit sets even if the consumer callback is defective.
- Direct request paths use an isolated one-shot agent (`agent:false`) in v1. This prevents the proxy
  from borrowing a process-global socket that may have been created outside the guard. Any later
  pooling must use guard-owned agents, be keyed to an immutable policy revision, and destroy all
  sockets when that revision retires.

The patch centralizes this behavior in a small `prepareDestinationDial()`-style helper and threads it
through opaque CONNECT, SOCKS, absolute-form HTTP/HTTPS, and TLS-terminated HTTPS. A source-contract
test forbids raw destination `net.connect`/`http.request`/`https.request` calls outside that helper.
This is a local patch under ADR-0005, recorded in `vendor/sandbox-runtime/VENDOR.md`, represented as a
reviewable patch file, verified after every vendor sync, and offered upstream.

The callback is initialization-scoped authority. `updateConfig`, per-execution `customConfig`, and
model-derived profiles may neither remove nor replace it. SRT's function-preserving clone path must
retain the original reference, and reset/reinitialize must clear the advertised feature until the
same Warden-owned resolver is installed again. Tests attempt each override explicitly.

When the guard is configured, SRT initialization rejects `mitmProxy`, external `httpProxyPort`,
external `socksProxyPort`, or a resolved parent proxy. Those components own or can delegate the final
dial and do not satisfy this contract. The patch also adds an explicit way to disable SRT's ambient
parent-proxy environment fallback; keel must use it. `tlsTerminate` remains supported and is a
mandatory integration-test path.

### 2. Resolve once per new connection and validate every answer

For a hostname, the Warden uses the operating-system resolver through `dns.lookup(hostname,
{all:true, verbatim:true})`. This matches normal `net.connect` name semantics, including `/etc/hosts`,
NSS, VPN, and split-DNS behavior. For an IP literal, it constructs the single normalized answer
without DNS but still applies the complete classifier.

The Warden denies the entire attempt if **any** answer is denied or not covered by the applicable
exception. It never selects the acceptable subset: doing so makes policy dependent on resolver order
and can conceal a hostile mixed answer set. When all answers are permitted, SRT retains the vetted
set so Node/Bun family failover remains available without re-resolution.

There is no cross-connection DNS cache in v1. A reused, guard-owned socket would already be bound to a
previously vetted address, but v1 uses one-shot agents to keep the rule simple and independently
testable: every new request connection is freshly resolved and vetted.

### 3. Classify from a pinned, generated address-policy table

The classifier is standard-library-only and data-driven. A build-time tool generates normalized
longest-prefix tables from pinned snapshots of the IANA IPv4 and IPv6 Special-Purpose Address
Registries plus the IANA IPv4 allocation and IPv6 global-unicast allocation registries. Runtime never
fetches registry data. The generated artifact records source URLs, snapshot date, digest, and
generator version; a deterministic regeneration test and reviewed diff gate prevent silent drift.
Overlapping entries use longest-prefix semantics. Space not identified by the pinned registries as
allocated global unicast is not treated as public merely because it missed a deny list.

Every syntactically valid address lands in exactly one class:

1. **Hard deny; never exceptable:** loopback, unspecified, link-local, multicast, broadcast,
   reserved-by-protocol addresses, deprecated site-local space, and translation/tunnel encodings that
   can hide another destination (`64:ff9b::/96`, `64:ff9b:1::/48`, 6to4, Teredo, and obsolete
   IPv4-compatible IPv6). IPv4-mapped IPv6 is decoded and the embedded IPv4 address is recursively
   classified rather than blanket-allowed or blanket-denied.
2. **Hard deny metadata endpoints:** at minimum `169.254.0.0/16`, AWS `fd00:ec2::254`, Google
   `fd20:ce::254`, Azure WireServer `168.63.129.16`, and Alibaba MetaServer `100.100.100.200`.
   `metadata.google.internal`, `metadata.goog`, and their subdomains are denied by normalized name
   before resolution. Exact provider endpoints remain hard denials even when nested inside an
   otherwise exceptable CIDR.
3. **Restricted; denied unless narrowly excepted:** RFC1918, CGNAT, IPv6 ULA, benchmarking,
   documentation, and every other IANA special-purpose prefix whose most-specific entry is not
   globally reachable but is meaningful as a destination.
4. **Public:** allocated ordinary global unicast not shadowed by a more-specific hard or restricted
   entry.

Malformed, zone-qualified, ambiguous, non-canonical, or unsupported address forms deny. The test
corpus includes IPv4 integer/octal/hex spellings, IPv4-mapped IPv6, upper/lowercase and compressed IPv6,
nested IANA exceptions, boundary addresses on both sides of every prefix, and fast-check properties
for normalization and longest-prefix selection.

IANA's `Globally Reachable` field is classification input, not the whole policy. Provider metadata
exact addresses and address-embedding transition mechanisms remain explicit hard denials. Updating
the pinned registry snapshot is a security-sensitive reviewed change.

### 4. Private-address exceptions are separate authority, not grants

Some legitimate enterprise endpoints resolve into private space. The exception store is versioned,
strict JSON at `$KEEL_HOME/egress-address-exceptions.v1.json`, keyed by the trusted workspace's
realpath. Its complete top-level shape is:

```json
{
  "version": 1,
  "workspaces": [
    {
      "realpath": "/absolute/trusted/workspace",
      "exceptions": [
        {
          "host": "registry.corp.example",
          "cidr": "10.20.0.0/16",
          "ports": [443]
        }
      ]
    }
  ]
}
```

The semantics are intentionally narrow:

- `host` is one normalized exact ASCII DNS name; no wildcard and no IP literal.
- `cidr` is one canonical network prefix and may cover only a restricted class, never a hard denial.
- `ports` is a non-empty, duplicate-free array of exact integers from 1 through 65535; no `*` and no
  ranges.
- An answer is excepted only when workspace realpath, requested host, requested port, and resolved
  address-in-CIDR all match.
- The ordinary name allowlist/grant must independently allow the host. An address exception grants no
  egress by itself.
- If a multi-answer response contains one uncovered address, the whole connection is denied.

The file is never project-local: governed tools can write the workspace, while `$KEEL_HOME` is denied
to them. The loader uses `lstat`/no-follow open/`fstat` on the same descriptor, requires a regular file
owned by the effective user with mode `0600` beneath an owner-only real `$KEEL_HOME`, caps file size
and entry counts before parse, rejects duplicate/unknown fields, and reads one immutable snapshot per
Warden process. Missing means no exceptions. Present-but-insecure, malformed, oversized, or changed
during open fails Warden startup; it never degrades to an empty or partially parsed policy.

Humans manage the file through `keel egress exception add|list|remove`. Mutations use an owner-only
lock, exclusive same-directory temporary file, `fsync` of file and parent, atomic rename, and
post-write revalidation. Commands require an explicit workspace and print no secret or unrelated
entries. `doctor` reports one copy-paste remediation. Direct manual editing remains possible but must
pass the same strict loader. A successful mutation says that the running Warden still holds its
immutable prior snapshot and gives the exact restart action required to activate the new revision;
there is no misleading hot-reload claim. These commands are public behavior and require acceptance
with this ADR.

### 5. Bound resolver, connection, audit, and shutdown work

The guard is part of the control plane and must remain available under hostile DNS and connection
storms:

- cap normalized answers per lookup;
- cap concurrent underlying `dns.lookup` calls and the waiting queue;
- apply a request deadline, but retain the semaphore slot until the uncancellable `getaddrinfo`
  callback actually returns, so timed-out work cannot accumulate invisibly;
- cap concurrent guarded connections and total dial time;
- reject new work immediately when a queue is full or shutdown begins;
- cancel queued work, ignore late callbacks safely, and prove teardown leaves no active guard work;
- bound error strings and never pass raw resolver diagnostics to the sandbox; and
- trip a deny-all circuit breaker after a bounded denial/audit rate rather than permit audit I/O or
  disk growth to become an availability attack.

The breaker is terminal for that Warden process: the triggering denial is appended, one bounded
`egress.deny` state-transition record marks quarantine, SRT's proxy listeners stop accepting new
connections, guarded queues and in-flight dials are cancelled, and new sandbox work is rejected until
an operator restarts the Warden. Requests that cannot reach a closed listener are transport failures,
not silently unaudited policy decisions. Tests must prove the transition is idempotent, the two
authoritative records survive teardown, no late resolver callback opens a socket, and repeated client
retries cannot create further audit growth.

The concrete limits are process-local constants, not workspace or model-controlled settings. The epic
plan records values chosen from the load tests; weakening them later is a security-behavior change.
The resolver uses no new dependency and no process-global DNS monkeypatch.

### 6. Audit denials without inventing attribution

Every address-policy denial uses the existing `egress.deny` audit event and open payload. The payload
contains bounded normalized host, port, reason code, address class, answer count, and exception-policy
revision digest. It does not contain request headers, credentials, raw DNS error text, exception-file
contents, or an exact private address. A human-only diagnostic command can re-resolve and display the
current address when needed.

Address-guard callbacks are Warden-process-scoped. Interactive consoles and local MCP processes can
produce egress outside `warden.execute`, and their traffic can overlap a normal tool execution.
Accordingly, the ADR makes **no per-execution attribution claim**. Guard denials use the existing
default Warden audit session unless a future authenticated proxy/session binding proves stronger
identity. They must not be appended to an arbitrary in-flight tool result.

The proxy returns a stable, secret-free denial code where the transport permits it: HTTP and CONNECT
receive 403 plus `X-Proxy-Error: blocked-address-policy`; SOCKS receives its standard not-allowed or
unreachable status. Detailed exception guidance is human-facing through the audit/doctor path. If the
authoritative audit append fails, the guard enters deny-all quarantine and the Warden reports the
audit failure; it never allows an unaudited connection.

### 7. Advertise only active, backend-specific truth

The non-frozen `SandboxStatus` gains an internal feature fact for the active address guard. The Warden
adds `egress-address-guard/v1` to the already-extensible `warden.hello.capabilities[]` only after:

- the exception snapshot and classifier load successfully;
- SRT accepts the strict resolver configuration;
- every incompatible route is absent; and
- the SRT proxy infrastructure initializes successfully.

Warden startup is reordered so `$KEEL_HOME`, the checkpoint key and authoritative audit writer, the
trusted-workspace exception snapshot, and the resolver exist before SRT initialization. No sandboxed
child or RPC request is admitted during that sequence. This lets initialization failures and every
later denial use the real audit sink without buffering unauthenticated pseudo-events.

`warden.status` remains unchanged. Kernel/TUI wording may derive “address guard on” only from the
capability; the existing domain-allowlist tier alone is insufficient. A non-SRT backend does not
inherit the feature and must implement and pass the same conformance suite before advertising it.

### 8. Evidence required before changing SEC-003

Implementation is TDD-first. The initial red walking skeleton is a real `curl` in a real sandbox,
using a deterministic resolver fixture whose granted hostname resolves to loopback, and a real
upstream listener that proves it received zero connections.

The merge gate then requires:

- positive, negative, and adversarial unit/property coverage for the classifier and exception store;
- mixed A/AAAA, last-answer-denied, empty, malformed, oversized, timeout, saturation, shutdown, and
  rebinding fixtures;
- proof that the actual socket uses only the vetted set and the resolver runs exactly once for that
  connection;
- IP-literal coverage proving classification occurs although Node/Bun skip a custom lookup for
  literals;
- end-to-end SRT coverage for CONNECT, SOCKS, absolute HTTP, absolute HTTPS, and TLS termination with
  real credential injection;
- fail-initialization tests for parent proxy, ambient proxy inheritance, `mitmProxy`, and external
  proxy ports;
- real Seatbelt/macOS and bwrap/Linux denial probes;
- Node 20/22/24 source-carrier and Bun compiled-carrier compatibility;
- load and teardown tests demonstrating bounded queue, RSS, file descriptors, audit behavior, and no
  late dial after cancellation; and
- a measured before/after egress benchmark. MASTER_SPEC's egress-proxy penalty budget is not claimed
  until measured.

Only after those gates pass may SEC-003 move from `DOC-LIMIT` to `PASS` for `srt:vendored` and
MASTER_SPEC §3.3 narrow its DNS-rebinding limitation. SEC-015 remains `DOC-LIMIT`.

## Non-goals

- Generic loopback or host-service access.
- UDP, QUIC/HTTP-3, ICMP, raw sockets, or proxy-unaware traffic. The OS sandbox continues to deny
  those paths; this ADR covers SRT-mediated TCP.
- DNS-query confidentiality or DNS-channel exfiltration by sandboxed code. The guard controls the
  host-side destination set used for connection; it does not claim that every platform resolver
  mechanism reveals no queried name.
- Request-body inspection, CONNECT/SNI equivalence, domain-fronting prevention, or Phase-4 MITM
  policy beyond the existing credential-injection path.
- Provider-model HTTP calls below `ModelPort`.
- Provenance-taint enforcement.
- Corporate parent-proxy support while the address guard is active. Supporting it safely requires a
  separately tested design that prevents the parent from re-resolving a hostname.

## Options considered

1. **Warden parent proxy. Rejected.** It adds another parser, listener, token, lifecycle, loopback hop,
   and connection pool; bypasses loopback; cannot govern TLS-terminated credential injection; can be
   displaced by external proxy modes; and depends on ambient proxy state. It is larger and less
   complete than the chosen patch.
2. **Minimal SRT connect-time resolver seam. Chosen.** It governs the final destination dial on every
   supported path, retains TLS hostname semantics and multi-address failover, adds no listener or
   dependency, and is small enough to re-review after a vendor bump.
3. **Process-global `dns.lookup` monkeypatch. Rejected.** It changes Warden DNS unrelated to sandbox
   egress, is order- and version-sensitive, and breaks backend modularity.
4. **Grant-time resolution. Rejected.** DNS can change after the grant; this is a usability warning,
   not rebinding enforcement.
5. **Replace both SRT proxy endpoints. Rejected.** It duplicates SRT's HTTP and SOCKS parsing,
   authentication, name policy, platform bridging, and TLS injection.
6. **Envoy/decision-service prior-art architecture. Rejected.** Its distributed capability-token and
   deployment machinery solves a multi-tenant service problem keel does not have.
7. **Metadata-only denial. Rejected.** It would leave private-service rebinding open while encouraging
   a stronger claim than the implementation supports.

## Consequences

- The design closes the name-to-address TOCTOU at the final host-side dial for the SRT backend without
  adding another proxy hop.
- The Warden becomes responsible for resolver availability, address classification, exception
  authority, and denial audit behavior; all are security-critical.
- Private/internal workflows require explicit host+CIDR+port exceptions and an independent name grant.
- Generic localhost access remains unavailable.
- Environments that require a corporate parent proxy remain unsupported under this guard until a
  separately reviewed pinned-address tunneling design exists.
- keel carries a second explicit SRT patch. Vendor verification and upstream submission are required;
  a future upstream release can remove the local patch only after the full conformance suite passes.
- The claim is backend-specific. A future Rust Warden or alternate sandbox gains no automatic credit
  from this TypeScript/SRT implementation.
- Residuals remain: a network can route an apparently public address to a sensitive service; an
  already-open vetted connection can continue to its original peer; destination identity above IP
  (SNI/HTTP semantics) is outside SEC-003; DNS-query-channel behavior is separate; and
  non-TCP/non-proxied paths remain the OS sandbox's job.
