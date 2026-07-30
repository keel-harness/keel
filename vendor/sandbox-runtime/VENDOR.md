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

No upstream source files are patched in this import. Any future local source patch must be listed here with
the reason, security impact, and upstreamable status.

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
