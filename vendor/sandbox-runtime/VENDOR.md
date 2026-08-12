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
- `patches/wait-for-linux-proxy-readiness.patch`
- `patches/connect-time-destination-resolver.patch`
- `patches/reemit-macos-glob-read-denies.patch`
- `patches/flush-tls-loopback-response.patch`
- `patches/runtime-aware-http-proxy-close.patch`
- `test/sandbox/linux-proxy-readiness.test.ts`
- `test/sandbox/destination-dial.test.ts`
- `test/sandbox/destination-guard-proxy.test.ts`
- `test/sandbox/http-server-lifecycle.test.ts`
- `test/sandbox/tls-loopback-lifecycle.test.ts`

## Local Patches

### Preserve write denial inside read-hidden Linux mounts

- Patch: `patches/read-hidden-write-deny.patch`
- Applied file: `src/sandbox/linux-sandbox-utils.ts`
- Reason: Linux represents a read-denied directory with a writable tmpfs. When the same authority
  was also write-denied, the hidden mount protected the host bytes but let the governed command
  observe a false-successful write into ephemeral storage.
- Security impact: overlapping hidden tmpfs mounts are remounted read-only after read/write mount
  stacking is complete. Explicitly re-bound write children covered by the same deny root are also
  re-bound read-only. Read-denied host bytes stay hidden and authority writes now fail structurally.
- Upstreamable status: minimal and intended for upstream submission after Keel's Linux conformance
  gate validates the end-to-end denial. It has not yet been submitted upstream.

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
