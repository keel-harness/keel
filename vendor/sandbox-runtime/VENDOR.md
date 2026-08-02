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
- `test/sandbox/linux-proxy-readiness.test.ts`
- `test/sandbox/destination-dial.test.ts`
- `test/sandbox/destination-guard-proxy.test.ts`

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
