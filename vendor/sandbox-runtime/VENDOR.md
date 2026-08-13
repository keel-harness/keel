# Vendored Anthropic Sandbox Runtime

This directory vendors `@anthropic-ai/sandbox-runtime` for Keel's Warden sandbox adapter. SRT is the
default governed product sandbox backend; startup fails closed when the required backend is unavailable.
The destructive real-backend denial suite remains opt-in locally and mandatory in its dedicated CI gate.

## Upstream

- Repository: `https://github.com/anthropic-experimental/sandbox-runtime.git`
- Tag: `v0.0.59`
- Commit: `3f4233f173227ca2e9dfde8c4985bc31811a64fc`
- npm package: `@anthropic-ai/sandbox-runtime@0.0.59`
- npm tarball:
  `https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/-/sandbox-runtime-0.0.59.tgz`
- npm shasum: `532b8958d6a0904689a3a06ed5a4ebbdadbcafd6`
- npm integrity:
  `sha512-Rbmy6ooITyiW0lhnJu67HpEEnCO68Bpvkqsc1316CCs2DrpFD9G7xo3PgYVkjpiNhTvpH7v6EpQuog8xbg+Bjg==`

## Imported Subpaths

- `LICENSE`
- `README.md`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `tsconfig.test.json`
- `eslint.config.js`
- `src/`
- `test/`
- `vendor/`

## Excluded Upstream Subpaths

These are intentionally not vendored because they are upstream repo metadata or local editor/hook config,
not source needed for Keel's reviewed adapter path:

- `.git/`
- `.github/`
- `.husky/`
- `.vscode/`
- `.dockerignore`
- `.gitignore`
- `.npmrc`
- `.prettierrc.json`

## Local Keel Files

- `VENDOR.md`
- `patches/read-hidden-write-deny.patch`
- `patches/preserve-linux-hidden-authority.patch`
- `patches/wait-for-linux-proxy-readiness.patch`
- `patches/connect-time-destination-resolver.patch`
- `patches/reemit-macos-glob-read-denies.patch`
- `patches/flush-tls-loopback-response.patch`
- `patches/runtime-aware-http-proxy-close.patch`
- `patches/per-launch-srt-authority.patch`
- `patches/retry-released-endpoint-lease-locks.patch`
- `patches/preserve-posix-literal-argv.patch`
- `test/sandbox/linux-proxy-readiness.test.ts`
- `test/sandbox/destination-dial.test.ts`
- `test/sandbox/destination-guard-proxy.test.ts`
- `test/sandbox/http-server-lifecycle.test.ts`
- `test/sandbox/linux-bridge-process-group.test.ts`
- `test/sandbox/tls-loopback-lifecycle.test.ts`
- `test/sandbox/endpoint-lease-registry.test.ts`
- `test/sandbox/endpoint-lease-registry-aba.test.ts`
- `test/sandbox/endpoint-lease-child.ts`
- `test/sandbox/launch-authority-lifecycle.test.ts`
- `test/sandbox/launch-authority.test.ts`
- `test/sandbox/mandatory-deny-paths.test.ts`
- `test/sandbox/socks-server-lifecycle.test.ts`
- `test/sandbox/posix-shell-quote.test.ts`

## Local Patches

### Preserve write denial inside read-hidden Linux mounts

- Patch: `patches/read-hidden-write-deny.patch`
- Applied file: `src/sandbox/linux-sandbox-utils.ts`
- Reason: Linux represents a read-denied directory with a writable tmpfs. That hidden mount protected
  host bytes but let a governed command observe a false-successful ephemeral write when the same
  authority was explicitly write-denied.
- Security impact: hidden tmpfs mounts overlapping an explicit denyWrite are remounted read-only after
  mount stacking completes. Strict descendant write binds covered by the deny root are also re-bound
  read-only. Read-denied host bytes stay hidden and explicitly denied authority writes fail.
- Upstreamable status: minimal and intended for upstream submission after Keel's Linux conformance
  gate validates the end-to-end denial. It has not yet been submitted upstream.

### Preserve exact hidden Linux authority and bridge mount order

- Patch: `patches/preserve-linux-hidden-authority.patch`
- Applied files: `src/sandbox/linux-sandbox-utils.ts` and
  `test/sandbox/wrap-with-sandbox.test.ts`.
- Composition: incremental after `read-hidden-write-deny.patch` and the per-launch authority
  inventory. The patch records exact reviewed preimages and postimages for both files.
- Reason: restoring an exact allowWrite after a denyRead tmpfs exposed the complete host directory;
  the following exact denyWrite then exposed it read-only. Remounting only explicit denyWrite
  overlaps also left other read-hidden tmpfs decoys spuriously writable, while installing the two
  Linux bridge binds before the authority-root mask made approved egress fail with `ENOENT`.
- Security impact: exact-path write allows are never rebound across their own read-hiding tmpfs;
  only strict child carve-outs are restored. Hidden tmpfs mounts outside an exact allowWrite are
  read-only under allow-only write policy, explicit write denies remain authoritative, and the two
  authenticated per-launch socket files are inserted only after all masks and before the first
  read-only remount. No sibling authority-root entry is projected. Keel additionally rejects a
  workspace canonically equal to its authority root before producing a governed profile.
- Evidence: emitted-argv regressions cover exact equality and mask/socket/remount order; real macOS
  and privileged Linux product suites prove read and write denial under an exact authority-root
  write allow. The compiled-carrier smoke is the final packaged projection gate.
- Upstreamable status: minimal and intended for upstream submission with the preceding Linux mount
  patches after Keel's conformance gates remain green. Recorded 2026-08-12; not yet submitted.

### Re-emit macOS glob read denies after allowWithinDeny

- Patch: `patches/reemit-macos-glob-read-denies.patch`
- Applied file: `src/sandbox/macos-sandbox-utils.ts`
- Reason: `generateReadRules` emits `denyOnly` rules before the `allowWithinDeny` re-allows, then
  re-emits only the LITERAL denies afterwards so they win under SBPL last-match-wins. Glob denies were
  skipped, so a glob deny paired with an allowRead covering the matching files was present in the
  generated profile but enforced nothing. Keel's fail-closed workspace secret backstop
  (`<workspace>/**/.env*`, emitted when the bounded nested-`.env` enumeration cannot complete) is
  exactly that shape, so nested `.env` files were readable on macOS while Linux enforced them.
- Security impact: restores the intended deny precedence on macOS and brings it to parity with Linux,
  which already expands the same glob into concrete `--ro-bind` masks. `allowWithinDeny` still takes
  precedence for the paths it names: any allowed subpath the glob itself matches is re-allowed after
  the re-emitted deny, so an explicit re-allow cannot be silently overridden by a broad glob.
- Upstreamable status: minimal and upstreamable. The upstream comment justified the skip by pointing at
  a `denyReadAlways` schema lever, but no such field exists in `FsReadRestrictionConfig`
  (`{denyOnly, allowWithinDeny}`), so there was no alternative lever. Recorded 2026-08-01; not yet
  submitted upstream.

### Wait for Linux proxy listeners

- Patch: `patches/wait-for-linux-proxy-readiness.patch`
- Applied file: `src/sandbox/linux-sandbox-utils.ts`
- Reason: the upstream wrapper backgrounds both sandbox-local `socat` listeners and immediately starts the
  governed command. Under load, a client can reach the proxy ports before either listener has bound.
- Security impact: startup now waits for both loopback listeners and fails closed after a bounded interval;
  governed code does not start when its required proxy path is unavailable. This preserves the existing
  network-isolation and proxy-enforcement design.
- Upstreamable status: minimal and upstreamable. The race was still present on upstream `main` when this
  patch was recorded on 2026-08-01; it has not yet been submitted upstream.

### Connect-time destination resolver seam

- Patch: `patches/connect-time-destination-resolver.patch`
- Applied files: `src/index.ts`, `src/sandbox/destination-dial.ts`, `src/sandbox/http-proxy.ts`,
  `src/sandbox/parent-proxy.ts`, `src/sandbox/sandbox-config.ts`,
  `src/sandbox/sandbox-manager.ts`, `src/sandbox/socks-proxy.ts`, and
  `src/sandbox/tls-terminate-proxy.ts`.
- Reason: SRT previously authorized a requested hostname and then let each final direct dial resolve
  it independently. Keel ADR-0086 requires the Warden to resolve and classify once at connect time,
  with SRT dialing only the returned validated address set.
- Security impact: when the initialization-scoped resolver is active, every supported direct TCP
  path (CONNECT, SOCKS, absolute HTTP/HTTPS, and TLS-terminated HTTPS) uses one pinned lookup. Empty,
  malformed, duplicate, oversized, aborted, or rejected answers fail closed. Parent proxies,
  external proxy ports, `mitmProxy`, ambient proxy inheritance, and live route injection are
  incompatible. Guarded dials also use a fixed process-local limit of 64 concurrent connection
  leases and a fixed 30-second total dial deadline. A lease remains held through resolver and
  transport setup, transfers to the outbound request or socket after connection, and is released
  only on close or terminal failure. Sandbox-manager reset aborts all outstanding guarded work and
  restores the limiter. The original hostname remains the HTTP Host and TLS identity.
- Compatibility: consumers that omit `network.resolveDestination` retain upstream v0.0.59 routing.
  `network.inheritProxyEnv` defaults to the upstream-compatible enabled behavior and must be
  explicitly false with the resolver.
- Upstreamable status: minimal and intended for upstream submission after Keel's full Epic 3.22
  conformance matrix passes. It has not yet been submitted upstream.

### Flush TLS loopback responses before client teardown

- Patch: `patches/flush-tls-loopback-response.patch`
- Applied file: `src/sandbox/tls-terminate-proxy.ts`
- Reason: the TLS terminator destroyed the client whenever its internal loopback socket closed,
  including an ordinary close after the final response bytes had entered a backpressured client
  write. Destruction could truncate the response before those queued bytes flushed.
- Security impact: none. The normal-close path now relies on Node's pipe lifecycle to end the client
  after queued bytes flush, then idempotently releases the per-connection listener when the writable
  side finishes even if the peer withholds its FIN. An actual loopback error still destroys the
  client immediately. TLS verification, destination policy, request filtering, and sandbox
  enforcement are unchanged.
- Compatibility: complete responses can finish normally; error teardown remains fail-closed. The
  deterministic regression holds the client write callback to prove normal-close flushing and
  exactly-once cleanup without a peer FIN. A separate negative control proves loopback errors still
  destroy the client and clean up exactly once.
- Upstreamable status: minimal and upstreamable. Recorded 2026-08-06; not yet submitted upstream.

### Close HTTP proxy listeners in runtime-safe order

- Patch: `patches/runtime-aware-http-proxy-close.patch`
- Applied files: `src/sandbox/http-proxy.ts`, `src/sandbox/sandbox-manager.ts`
- Reason: Node can accept a new connection between `closeAllConnections()` and `close()`, and can
  deliver a connection already accepted by libuv after the initial JavaScript socket snapshot,
  leaving the close callback blocked indefinitely. Node also does not include HTTP
  `CONNECT`-upgraded sockets in `closeAllConnections()`. Bun detaches the server handle in `close()`
  and therefore requires the inverse order. The upstream unconditional Bun ordering and incomplete
  socket lifecycle intermittently wedged Warden shutdown after otherwise successful real Git push
  and GitHub PR product tests.
- Security impact: no policy, TLS-verification, credential, audit, or sandbox decision changes. Runtime
  detection now selects the safe listener/connection teardown order, so cleanup drains proxy authority
  instead of waiting for the kernel-side timeout and forced process reap.
- Compatibility: Bun retains its existing `closeAllConnections()`-before-`close()` behavior. Node stops
  acceptance first and then force-closes the fixed established-connection set, matching Node's API
  guidance. Both runtimes also destroy the proxy's explicit accepted-socket registry so upgraded
  tunnels drain. Entering teardown permanently marks that registry as draining, so a Node connection
  event delivered after the initial snapshot is destroyed on arrival; Bun repeats the snapshot after
  stopping acceptance. Deterministic tests preserve both orderings, the Node and Bun interleavings,
  and a real Node `CONNECT` upgrade.
- Upstreamable status: minimal and upstreamable. Recorded 2026-08-11; not yet submitted upstream.

### Bind proxy authority to one governed launch

- Patch: `patches/per-launch-srt-authority.patch`
- Applied files: `src/sandbox/endpoint-lease-registry.ts`, `src/sandbox/http-proxy.ts`,
  `src/sandbox/linux-sandbox-utils.ts`, `src/sandbox/sandbox-manager.ts`,
  `src/sandbox/socks-proxy.ts`, `src/sandbox/tls-terminate-proxy.ts`, and the listed lifecycle and
  mandatory-denial regression postimages.
- Reason: process-scoped proxy tokens, mutable proxy configuration, and shared credential helpers let
  one surviving governed profile retain or borrow authority prepared for a later launch. ADR-0091
  requires a unique token and immutable policy/credential snapshot per launch, with authority absent
  whenever that lifecycle cannot be structurally established.
- Security impact: each network-bearing launch gets exclusive authenticated HTTP/SOCKS endpoints, a
  pinned resolver, launch-local credential/TLS state, and a durable endpoint lease outside governed
  profiles. An exact deny-all launch instead gets an endpointless network-denied OS profile and no
  token, listener, bridge, TLS authority, credential projection, or lease. Revocation deactivates
  authentication first, aborts pending resolution, persistently drains late client accepts, closes
  tracked TLS children and Linux bridges, and fails closed after a fixed two-second bound. Terminal
  callers then settle the process before releasing Linux mount/placeholder state; explicit console
  release is the sole live-process authority-transfer exception and carries no continuing
  filesystem-containment claim.
  Keel removes the upstream manager's competing process `exit`/`SIGINT`/`SIGTERM` reset hooks;
  Warden-owned bounded shutdown is the sole teardown controller. The Linux process-exit fallback
  now preserves deny-mount sources whenever a sandbox count remains active, so an unconfirmed child
  cannot lose inherited filesystem enforcement during forced Warden exit.
  Separate owner-only generation markers distinguish live peer Wardens from crash residue; the public
  registry contains no token, credential, request, or process detail. Compact registry V2 uses a
  fixed retired-port bitmap and exact active port pairs, conservatively migrates V1 exclusions, and
  stays below four MiB even at the theoretical 12,768-pair port limit. Preparation and reset share one
  lifecycle queue; Linux bridge cleanup targets the complete detached process group; and
  generated nested-deny bind sources follow per-invocation ownership and are removed after
  confirmed process settlement or failed preparation without disturbing concurrent launches.
  On Linux, filesystem masks are installed before the two exact authenticated bridge-socket binds,
  and an allow-only write policy remounts the containing hidden tmpfs read-only after those bind
  destinations exist. This preserves the owner-root read/write denial without hiding the only two
  endpoints needed by the sandbox-side bridge or exposing any other authority-root entry;
  weaker/external/parent-proxy routes cannot establish this capability.
- Compatibility: consumers that do not request Keel's launch lifecycle keep the upstream process-level
  path. Keel advertises `srt-launch-authority/v1` only with this exact API, durable registry, pinned
  destination resolver, two-phase async revoke/cleanup, and successful initialization. Windows does
  not advertise it.
- Evidence: deterministic registry, capacity/migration, deadline, HTTP/SOCKS pre-activation and
  late-accept, TLS-child/listener, process-group, loader-quarantine, revoke-process-cleanup ordering,
  startup/RPC shutdown-debt, process-exit mount retention, competing-hook absence, failed-wrap count
  balancing, invocation-owned stale-path deletion under concurrent wrapping, generated nested-deny source
  cleanup after successful settlement and failed preparation, authenticated bridge-bind ordering
  across a masked/read-only authority root, and lifecycle-race tests plus real macOS Seatbelt and
  Linux bubblewrap product suites. The Linux launch oracle distinguishes its inner 3128/1080
  listeners from the host authority ports. The real launch probe includes positive own-authority
  controls and adversarial exact peer-token HTTP/SOCKS attempts; the compiled-carrier smoke also
  proves positive approved egress through a profile that denies the complete authority root.
- Upstreamable status: Keel-specific lifecycle extension over the pinned permissive upstream. Recorded
  2026-08-11; not yet submitted upstream.

### Retry endpoint lease mutations after a released lock

- Patch: `patches/retry-released-endpoint-lease-locks.patch`
- Applied files: `src/sandbox/endpoint-lease-registry.ts` and
  `test/sandbox/endpoint-lease-registry-aba.test.ts`.
- Composition: incremental after the per-launch SRT authority patch. This records the accepted #218
  postimages that were initially merged without refreshing the vendor-integrity pins.
- Reason: a registry object released its exclusive lock after one mutation, then reused the released
  lock object and rejected a later valid operation instead of reacquiring the lock.
- Security impact: the registry now treats a released lock as absent and reacquires exclusive authority
  before a later mutation. Compare-and-swap, generation ownership, permanent endpoint retirement, and
  fail-closed behavior are unchanged.
- Evidence: the ABA regression covers multiple operations through one registry instance and the vendor
  verifier pins both exact accepted postimages.
- Upstreamable status: part of Keel's per-launch authority extension. Recorded 2026-08-12; not yet
  submitted upstream.

### Preserve literal argv through POSIX sandbox wrapping

- Patch: `patches/preserve-posix-literal-argv.patch`
- Applied files: `src/sandbox/posix-shell-quote.ts`, `src/sandbox/macos-sandbox-utils.ts`,
  `src/sandbox/linux-sandbox-utils.ts`, and `test/sandbox/posix-shell-quote.test.ts`.
- Composition: incremental after the per-launch SRT authority patch. The vendor verifier pins the
  resulting source and regression postimages.
- Reason: `shell-quote` double-quotes an already-rendered command string containing whitespace and
  single quotes, then emits `\!`. POSIX shells retain that backslash inside double quotes, so a trusted
  direct-argv `process.run` request containing `!` reached the contained child with an extra byte even
  though the Warden retained and audited the exact original argv.
- Security impact: restores byte-for-byte direct argv at the existing shell bridge. Values containing
  `!` use lossless POSIX single-quote rendering at every nested macOS/Linux sandbox command layer;
  other values keep upstream rendering. Validation, policy, sandbox profiles, review binding, audit,
  no-retry behavior, TLS verification, credential handling, and process.run authority are unchanged.
- Evidence: deterministic two-layer shell round-trip coverage plus the real macOS Seatbelt literal-argv
  probe cover `!`, `!==`, a pre-existing backslash before `!`, embedded quotes, and injection-looking
  neighbors without sibling effects.
- Upstreamable status: minimal and upstreamable. Recorded 2026-08-12; not yet submitted upstream.

## License And Notice

- Upstream project license: Apache-2.0.
- Upstream root `NOTICE`: none present at the pinned commit.
- Runtime dependency license notes from upstream `package-lock.json`:
  - `@pondwader/socks5-server@1.0.10`: MIT.
  - `commander@12.1.0`: MIT.
  - `node-forge@1.4.0`: `(BSD-3-Clause OR GPL-2.0)`. Keel uses the BSD-3-Clause option.
  - `shell-quote@1.8.4`: MIT.
  - `zod@3.24.1`: MIT.

Keel resolves the vendored TypeScript source through the workspace root. The runtime packages used by
the warden adapter are pinned in the root `package.json`/`pnpm-lock.yaml`: `@pondwader/socks5-server`
`1.0.10` (MIT), `node-forge` `1.4.0` (BSD-3-Clause option), `shell-quote` `1.9.0` (MIT), `zod`
`3.25.76` (MIT), and `tsx` `4.22.4` (MIT) for the built warden loader's TypeScript import fallback.
The `shell-quote` and `zod` runtime pins are newer than the upstream lockfile entries but preserve the
same permissive license posture.

The upstream lockfile contains dev-only dependencies that are not part of Keel's runtime adapter path.
Do not build or distribute upstream helper binaries from this tree until the relevant dependency and
platform-specific license review is recorded.

## Verification

Run the Keel vendor metadata check after import or sync:

```bash
node tools/vendor/verify-sandbox-runtime.mjs
```

The check validates the pinned package metadata, required imported subpaths, excluded upstream metadata,
license/NOTICE posture, and runtime dependency license expectations.

## Sync Procedure

1. Clone or fetch upstream at the pinned tag in a temporary directory.
2. Verify `git rev-parse HEAD` equals `3f4233f173227ca2e9dfde8c4985bc31811a64fc`.
3. Copy the imported subpaths listed above into `vendor/sandbox-runtime/`.
4. Preserve this `VENDOR.md`.
5. Run `node tools/vendor/verify-sandbox-runtime.mjs`.
6. Record any upstream source changes, local patches, or license changes in this file and the pull request.
