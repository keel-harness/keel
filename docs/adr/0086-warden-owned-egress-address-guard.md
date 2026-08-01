# ADR-0086 — Warden-owned egress address guard

- **Status:** **Proposed** (2026-08-01). A **stop-and-ask** decision. Recorded before any production
  behavior change, for maintainer approval.
- **Date:** 2026-08-01.
- **Deciders:** keel maintainer (proposed by Claude Opus 5 after a code-verified investigation of the
  vendored SRT connection path, a prior-art study of `yc-software/qm`, and a six-pass adversarial
  review of an earlier draft of this ADR).
- **Governs:** connect-time **resolved-address** enforcement for sandboxed egress. Relates to
  ADR-0005 (vendored sandbox-runtime), ADR-0017 (agent authority model), ADR-0020 (coverage gate),
  ADR-0038 (workspace trust gate), ADR-0056 (capability manifest), ADR-0066 (secretless egress
  credential proxy), ADR-0080 (runtime truth vocabulary), and MASTER_SPEC §3.1/§3.2/§3.3/§4.2/§4.3.
  It does **not** touch a frozen interface, protocol, schema, audit format, CLI contract,
  `WARDEN_METHODS`, `AuditRecord`, `PolicyInput`, `SideEffect`, or grant scope.
- **Anchor:** `docs/design/2026-08-01-egress-address-guard-prior-art.md` (prior-art study and
  license gate).

### Stop-and-ask triggers this work has ALREADY tripped

Listed explicitly, because approval is being requested for each:

1. **Alters enforcement behind a security claim** — SEC-003.
2. **Changes public behavior users may depend on** — private-range egress becomes deny-by-default; a
   granted domain resolving into RFC1918 space stops working until an exception is recorded.
3. **Adds a listening socket to the warden** — a new local control-plane asset (MASTER_SPEC §3.1).
4. **Relies on assumptions about components keel does not own** — SRT's `parentProxy` capture
   semantics and loopback-bypass behavior; bwrap/Seatbelt network isolation.
5. **Edits MASTER_SPEC §3.3** — narrowing a "document, never hide" limitation is itself a
   security-claim edit (`docs/quality/claim-ledger.md`, Maintenance).

### Prerequisite

This ADR assumes the allowlist-layer fix that refuses loopback-form hosts (`localhost`,
`127.0.0.0/8`, `::1`, `::ffff:127.0.0.0/104`) as egress patterns and in
`credentialProxyAllowedDomains()` has already landed. **The guard is not a substitute for it** —
`shouldBypassParentProxy()` routes loopback-named destinations around the guard entirely, and that
behavior is not configurable. Neither this ADR nor its epic may be published before that fix ships.

## Context

keel's egress allowlist is enforced by **name**. The vendored SRT proxies validate the requested
hostname against `network.allowedDomains`, then dial that hostname — a second, independent
resolution performed by the OS at connect time:

- `socks-proxy.ts:75` calls `options.filter(port, hostname)`, then `:119` calls
  `dialDirect(host, port)`, which is `net.connect(port, host)` (`parent-proxy.ts:496`).
- `sandbox-manager.ts` `filterNetworkRequest()` performs careful **name** hygiene — control-character
  rejection and zone-ID refusal via `isValidHost` (`parent-proxy.ts:449-458`), `inet_aton`
  canonicalization via `canonicalizeHost` (`parent-proxy.ts:471-483`), and refusal of wildcard suffix
  matching against IP literals via `matchesDomainPattern` (`domain-pattern.ts:31-35`) — but never
  inspects a **resolved** address. (Named per file so a future SRT bump review knows what to diff.)

The name→address binding is unverified, and the address dialled is derived a second time. keel
records this honestly rather than hiding it:

- `packages/warden/src/egress-profile.ts` `describeDnsRebindingPosture()` returns
  `status: "documented-limitation"` with `requiredBackendControl: "deny-private-resolved-addresses"`
  **once any domain is granted**, and `status: "not-applicable"` while the allowlist is empty
  (`egress-profile.ts:79-91`).
- `docs/quality/security-suite-v1.md` row **SEC-003** is `DOC-LIMIT (not pass)`.
- MASTER_SPEC §3.3 carries the corresponding "document, never hide" DNS-rebinding bullet.
- ADR-0066's Consequences defer "broader redirect/DNS/CONNECT/SNI hardening".

The residual exposure is bounded. keel's default network posture is deny-all
(`buildEgressNetworkProfile()` emits `deniedDomains: ["*"]` with `strictAllowlist` when nothing is
granted), and `normalizeDomainPattern()` refuses IP-like allowlist patterns, so a metadata address
cannot be granted directly (SEC-001). Redirect-to-IP is already denied by requested-host filtering
(SEC-002). The uncovered case is: **a human grants a domain, and that domain resolves — then, or
later — into link-local, cloud-metadata, or private address space.**

One related gap this ADR's item 6 closes incidentally: `resolveParentProxy(undefined)` runs today at
`srt-runtime-loader.ts:355`, so an ambient `HTTP_PROXY` in the **warden's** environment already
chains all sandbox egress through an operator-uncontrolled proxy.

### Prior art

`yc-software/qm` @ `7f2c916` (MIT) operates a forced egress proxy whose decision service resolves the
destination itself, checks every returned address against a block list, and returns the vetted
address so the data plane cannot re-resolve it. keel adopts the **mechanism** and re-implements it
independently, per the `docs/design/borrowed-techniques.md` posture; no code is copied. Two
deliberate divergences: qm's private-range denial is opt-in and policy-gated
(`egress-authz-main.ts:107-114`) where keel's is deny-by-default, and qm pins a single address where
keel retains the whole vetted set (see Decision 3).

### Why the check cannot live inside SRT's existing hooks

1. `sandboxAskCallback` — injectable, but short-circuited whenever `strictAllowlist` is set
   (`sandbox-manager.ts:161`), which keel always sets. It fires only for hosts keel already denies.
2. `network.filterRequest` — injectable, but runs only on plain HTTP and TLS-terminated HTTPS
   (`http-proxy.ts:316`). CONNECT tunnels and SOCKS never reach it, and keel does not terminate TLS.
3. `network.parentProxy` — consulted on the SOCKS path (`socks-proxy.ts:112-119`), the HTTP CONNECT
   path (`http-proxy.ts:195-215`), and the plain-HTTP absolute-URI path (`http-proxy.ts:298-305`).
   The only hook reaching every connection SRT proxies.

## Decision

keel adds a **warden-owned egress address guard**: a loopback HTTP forward proxy, owned and
lifecycled by the warden, installed as SRT's `network.parentProxy`. SRT's name allowlist is
unchanged; the guard adds the address-layer decision SRT does not make.

1. **Both proxy verbs, resolved per request.** The guard MUST handle `CONNECT host:port` **and**
   absolute-URI requests (`GET http://host/path`), because SRT's plain-HTTP path forwards the latter
   rather than tunnelling (`http-proxy.ts:351-372`). A CONNECT-only guard would leave every `http://`
   request unanswered. On the absolute-URI leg, Node's agent keep-alive means one connection carries
   requests for many hosts, so the decision MUST be made **per request**, never cached per
   connection.

2. **Placement and lifetime.** The guard binds `127.0.0.1` on an ephemeral port and MUST be started
   **before** SRT is initialized, with its URL supplied to `manager.initialize()`. `parentProxy` is
   captured by value when the proxy servers are constructed (`sandbox-manager.ts:434,462`) and
   upstream states that `updateConfig` changes "take effect only on re-initialize"
   (`sandbox-manager.ts:1254-1258`) — so delivering it on the per-execution path would be inert. The
   guard's lifetime is therefore **warden-process-scoped**, and its port MUST be pinned for the SRT
   lifetime; replacing the guard requires re-initializing SRT.

3. **Resolve once per request; validate every answer; dial only vetted addresses.** The guard
   resolves the destination once (`dns.lookup`, `all: true`), classifies **every** returned address,
   and denies if **any** answer is denied — never "some answers were acceptable". Allowed requests
   are dialled against the vetted addresses, in order, so DNS failover survives. The guard MUST NOT
   fall back to dialling by name on any error path. Pinning a single address, as the prior art does,
   is rejected because it removes failover for no additional guarantee.

4. **Unconditional denials.** Link-local (`169.254.0.0/16`, `fe80::/10`), the AWS IPv6 IMDS address
   (`fd00:ec2::254`), Azure's wireserver `168.63.129.16` (which sits in *public* space and no CIDR
   rule catches), and the cloud metadata names (`metadata.google.internal`, `metadata.goog`, and
   subdomains) are denied regardless of policy, grant, autonomy posture, or configuration. Loopback
   is its own unconditional class — an exception MUST NOT reach it.

5. **Private ranges denied by default, with host+range-scoped exceptions.** RFC1918, CGNAT
   (`100.64.0.0/10`), ULA (`fc00::/7`), and the other non-public ranges are denied unless an
   exception permits that specific host for that specific range. Exceptions are `{host, cidr}` pairs
   — keying on host alone would let an exception for an internal registry also reach loopback.
   The classifier MUST additionally cover the IPv6 transition ranges an address-only check misses:
   NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo `2001::/32`, IPv4-compatible `::/96`, plus
   `0.0.0.0/8`, `192.0.0.0/24`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`, `fec0::/10`,
   `ff00::/8`. IPv4-mapped forms are covered by checking one combined `BlockList` with the family
   from `isIP()`, not two separate lists.

6. **Exceptions live outside the workspace.** The exception store is
   `$KEEL_HOME/egress-private-hosts.json`, keyed by workspace realpath — the shape
   `egress-project-grants.json` already uses (`egress-grants.ts:31-33`). It MUST NOT live in
   `<workspace>/.keel/`: governed tools hold `allowWrite: ["workspace"]`
   (`capability-manifest.ts:71,125,143`) and the `keel_config` deny-write token expands to
   `$KEEL_HOME` (`capability-manifest.ts:367`), not the workspace, so a workspace-local file would be
   model-writable — letting the model widen its own egress policy, contrary to ADR-0017 and SEC-011.
   ADR-0066's `.keel/credential-proxy.json` precedent is therefore explicitly **not** followed here.

7. **Ambient environment may not route around the guard.** keel MUST supply `http`, `https`, and an
   explicit empty `noProxy`, so no ambient variable reaches `resolveParentProxy`'s env fallback
   (`parent-proxy.ts:67-78`). The empty string must be threaded with `=== undefined` checks, never
   truthiness, or the fallback silently returns.

8. **Fail closed, including when the guard is configured but not honoured.** A guard that cannot bind
   fails warden startup. A DNS error, empty answer set, missing or wrong proxy-auth token, or
   unreachable guard denies. Denials MUST occur before any upstream socket is opened. Because
   `resolveParentProxy` swallows a URL parse failure and returns `undefined`
   (`parent-proxy.ts:96-110`) — dialling direct, logged only at debug — keel MUST validate the guard
   URL before handing it over, and MUST generate the proxy-auth token in a URL-safe alphabet (hex or
   base64url; plain base64 yields `/` with high probability, which throws on parse).
   `network.tlsTerminate` and `network.mitmProxy` MUST be asserted unset while the guard is the
   enforcement mechanism: the TLS-terminated upstream leg does not honour `parentProxy`
   (`tls-terminate-proxy.ts:251`, an upstream TODO) and would silently bypass it.

9. **A startup self-test proves the guard is on the path.** After initialization, keel MUST drive one
   real connection through SRT's proxy to a sentinel destination and confirm the guard observed it,
   failing warden startup otherwise. This is the only construct that closes items 2, 7, and 8
   together, and it converts "the config has the right shape" — which a passing unit test can assert
   while the guard sits idle — into "a connection was observed".

10. **Bounded work per connection.** A maximum vetted-set size, a total per-connection dial budget,
    a cap on concurrent guard connections, and a bound on in-flight resolutions. Without these, a
    granted domain under attacker DNS control can hold the warden — the control plane — across many
    connections at up to 30s per dial attempt (`parent-proxy.ts:38`).

11. **Denials are audited immediately; guidance is buffered separately.** Each denial is recorded as
    an existing `egress.deny` audit event carrying the destination host, a reason class
    (`link_local_metadata` | `loopback` | `private_network`), and the resolved address, using
    `DEFAULT_AUDIT_SESSION_ID` as both existing emissions already do
    (`rpc-server.ts:1099`, `:6711`). Per-execution attribution is **not** claimed: the interactive
    console (`tmux-broker.ts:648`) and MCP local-stdio (`mcp/local-stdio.ts:722`) emit sandboxed
    egress outside any `warden.execute`, and one loopback socket with a per-warden token carries no
    execution identity. Separately, denials ARE buffered per execution for a different purpose — as
    the **user-facing guidance channel** (Consequences below). The guard MUST NOT log, buffer, or
    audit request headers: keel's credential injection places a real secret in a plaintext
    `Authorization` header on the very path the guard now sees (`sandbox-manager.ts:206-208`).

12. **Scope of the claim.** This work, once implemented and tested, would make SEC-003 provable and
    would narrow — not delete — the MASTER_SPEC §3.3 DNS-rebinding bullet to its residual. It claims
    nothing else. It does **not** claim CONNECT-host or SNI-mismatch enforcement (SEC-015 stays
    `DOC-LIMIT`), request inspection or MITM (Phase 4), provider-API egress governance, or
    provenance-taint enforcement.

## Non-goals

- Mediating destinations the client itself names as loopback — see Consequences.
- UDP, QUIC/HTTP-3, ICMP, or raw sockets. The guard is TCP-and-proxied-only; those are denied at the
  OS layer, by components keel does not own.
- Replacing SRT's name allowlist. The guard is **name-unaware**: it validates addresses only.
- A CLI surface for exceptions.

## Options Considered

1. **Patch the vendored SRT dial path.** Smallest diff. Rejected on cost, not architecture:
   `VENDOR.md` records that no upstream source is patched, so this creates the first local patch to a
   security-critical vendored dependency, to be re-applied and re-reviewed at every bump. (An earlier
   draft argued the patch would sit "below the `SandboxPort` seam"; that argument is withdrawn — the
   chosen design's *activation* also depends on undocumented vendored internals, so the code sits
   above the seam but the trust does not.) Worth offering upstream independently.

2. **Intercept the resolver instead of the connection.** Every dial SRT makes happens in the warden
   process, so a validating `lookup` would need no listener, port, token, or lifecycle — materially
   smaller. Rejected: SRT never threads a `lookup` option into `net.connect`, so keel's only lever is
   a process-global `dns.lookup` monkeypatch, which also rewrites DNS for the warden's own traffic
   and is version-fragile; and it dies the moment the sandbox backend moves out of process. Doing it
   cleanly requires a one-line upstream change, i.e. Option 1 with extra steps. **This is the
   strongest upstream contribution to offer `anthropic-experimental/sandbox-runtime`.**

3. **Validate at grant time only.** Roughly thirty lines, no runtime component. Rejected: the grant
   persists while DNS may change afterward, so it does not address rebinding and would leave SEC-003
   at `DOC-LIMIT`. A usability guard, not enforcement.

4. **Own both proxy endpoints** via `network.httpProxyPort`/`socksProxyPort`
   (`sandbox-manager.ts:573-590`), which makes SRT start no proxies at all. Rejected: it means
   reimplementing the SOCKS server and the entire name-allowlist path. Recorded because it also
   constitutes a bypass surface (Consequences).

5. **Port the prior art's architecture** — external forced proxy, decision service, capability
   tokens. Rejected: the tokens answer a question keel does not have (the warden is already the
   in-process authority), and the deployment machinery contradicts the local-first and no-telemetry
   non-goals in `docs/roadmap.md`.

6. **Metadata-only v1** — ship item 4 and defer item 5 with its whole exception apparatus. Recorded
   as deliberately declined: it would flip the credential-theft threat at roughly a third of the
   surface, but the honest control name is `deny-private-resolved-addresses` and internal-service
   rebinding is a real threat.

**Chosen: the warden-owned parent proxy** — the smallest change that reaches every connection SRT
proxies, requires no vendored patch, changes no frozen contract, and survives a backend swap.

## Consequences

- SEC-003 becomes provable, and MASTER_SPEC §3.3's DNS-rebinding bullet narrows to its residual.
- Every sandboxed connection gains one loopback hop and one keel-performed DNS resolution. MASTER_SPEC
  §8.3 budgets an egress-proxy throughput penalty under 5%; this must be **measured**, before and
  after, not asserted.
- **The guard does not mediate destinations the client itself names as loopback.**
  `shouldBypassParentProxy()` returns true for `localhost`, `127.0.0.0/8`, `::1`, and
  `::ffff:127.0.0.0/104` before any configuration is consulted (`parent-proxy.ts:189-227`), and that
  is not configurable. This is why the prerequisite allowlist-layer fix is a prerequisite and not a
  follow-up: it removes loopback-form hosts from the set that can be granted at all. An earlier draft
  of this ADR argued bwrap and Seatbelt narrowed the residual — **that reasoning was wrong**, because
  the bypassing dial is performed by the SRT proxy inside the warden, on the host, which neither
  sandbox constrains.
- Four further bypass surfaces exist and each needs a guard test or an explicit "keel does not set
  this" assertion: ambient `HTTP_PROXY`/`NO_PROXY`; an unparseable guard URL; `network.tlsTerminate`
  and `network.mitmProxy` taking precedence; and `network.httpProxyPort`/`socksProxyPort` replacing
  SRT's proxies entirely.
- The guard's listener is **not** reachable from inside the sandbox on either platform — Seatbelt
  permits outbound only to SRT's two proxy ports (`macos-sandbox-utils.ts:716,729`), and bwrap's
  `--unshare-net` leaves only the socat bridges. The proxy-auth token therefore is not sandbox
  defense; it protects **audit integrity**, since the guard produces `egress.deny` records and an
  unauthenticated loopback listener would let any local process inject fabricated ones. Compare with
  `timingSafeEqual`.
- Deny-by-default for private ranges will break workflows whose granted domain resolves into private
  space until an exception is recorded. **The denial reason cannot reach the sandboxed process over
  HTTPS**: SRT discards the guard's status line and body, surfacing a bare 502
  (`http-proxy.ts:219-227`) or SOCKS `HOST_UNREACHABLE` (`socks-proxy.ts:140-145`), so the user sees
  only a generic connection failure. The actionable message must therefore be delivered through the
  executor's guidance line and the audit/event channel. With no CLI for exceptions, that message is
  the sole discovery path for the exception store, and it must name the destination, the resolved
  address, and the exact entry that would allow it — while never offering an exception for the
  unconditional classes.
- `posture.egress` is currently an alias for "enforcement tier ≠ none"
  (`packages/kernel/src/warden/status.ts:40-52`), so the HUD would report `egress guard on` whether
  or not the address guard bound. A distinct guard fact must be carried on the wire and the posture
  derived from it, per ADR-0080's runtime-truth vocabulary.
- `$KEEL_HOME/egress-private-hosts.json` is warden-owned configuration, not a public schema.
  Promoting it to a frozen shared schema requires a separate stop-and-ask review.
- A future Rust warden or non-SRT sandbox backend inherits this control, because it lives above
  `SandboxPort` rather than inside the vendored runtime.
- The guard parses untrusted HTTP request heads. MASTER_SPEC's research rule prefers mature
  implementations over hand-rolled parsers for exactly this category; the implementation should use
  `node:http`'s own `connect`/`request` events rather than parsing bytes, and must record why that
  discharges the parser risk.

## Evidence

**Pending test — nothing in this ADR is implemented.** SEC-003 stays `DOC-LIMIT` until the tests
below exist and pass. Planned coverage:

- `packages/warden/src/egress-address-policy.test.ts` — classification across IPv4-mapped,
  `inet_aton` shorthand, `127.1`, zone-ID, bracketed and trailing-dot forms; every range in
  Decision 4-5 including the IPv6 transition prefixes and `168.63.129.16`; multi-answer denial where
  only a later answer is denied; `{host, cidr}` exceptions widening only their own range and never
  reaching the unconditional classes; a `fast-check` property whose generator samples *from* the
  denied ranges rather than the whole address space.
- `packages/warden/src/egress-guard.test.ts` — the resolve-once property asserted **on the dialer's
  arguments** (it must receive an IP literal, never the hostname — a call-count assertion alone
  would pass against an implementation that re-resolves inside libuv); no upstream socket on denial;
  two sequential keep-alive requests for different hosts each get their own decision; proxy-auth
  rejection before resolution, so the guard is not a DNS oracle; DNS error, empty-answer, and
  never-settling resolution denials; no name-based dial on any error path; connection and dial-budget
  caps; no request header ever recorded.
- `packages/warden/src/egress-private-hosts.test.ts` — load from `$KEEL_HOME` keyed by workspace
  realpath; malformed-config fail-closed; no widening of unconditional classes; the store is not
  writable by governed tools.
- `packages/warden/src/srt-runtime-loader.test.ts` — the guard URL reaches
  `manager.initialize()`'s argument (spying on the manager, **not** on an intermediate config shape,
  because three separate whitelists rebuild `network` field-by-field); `noProxy` stays `""` under a
  hostile ambient `NO_PROXY`; a malformed guard URL fails closed; `tlsTerminate`/`mitmProxy` asserted
  unset.
- `packages/warden/src/srt-sandbox.test.ts` — `parentProxy` projection (necessary, but not evidence
  the control is live).
- `packages/warden/src/egress-profile.test.ts` — `describeDnsRebindingPosture()` reports the enforced
  status only when the guard is active, with "active" derived from the same value handed to
  `initialize()` so a wiring regression downgrades the claim automatically; both existing branches
  preserved.
- `packages/warden/src/rpc-server.test.ts` — `egress.deny` emission with reason class; the startup
  self-test failing closed. Socket-free, because this suite is already load-sensitive
  (`CONTRIBUTING.md`).
- `packages/warden/src/srt-sandbox.real.test.ts` — opt-in real-backend probe
  (`KEEL_REQUIRE_REAL_SANDBOX`), in the walking skeleton rather than at the end, because it is the
  only test that detects inert wiring. Requires a positive control (an allowed, publicly-resolving
  host transits the guard) to prove the guard was installed, since `SandboxManager` is a module
  singleton whose `initialize()` early-returns. Must not use `--noproxy '*'`, which bypasses the
  proxy and yields a false green.
- `packages/kernel/src/cli/security-suite-inventory.test.ts` and `docs-claim-consistency.test.ts` —
  the SEC-003 transition, and MASTER_SPEC §3.3 narrowed rather than deleted (an executable assertion
  pins the bullet's presence).
- `package.json` — the three new `egress-*` suites added to `test:security`, which is an explicit
  file list; without this SEC-003 would flip to PASS while its evidence never ran in the security CI
  job.
