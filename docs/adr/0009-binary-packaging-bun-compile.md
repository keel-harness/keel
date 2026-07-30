# 0009 — Binary packaging via bun build --compile

**Status:** accepted
**Date:** 2026-06-11

## Context
KEEL targets developers who want a single `keel` binary they can install without a Node.js runtime. The binary must work on macOS (arm64, x86_64) and Linux (x86_64, arm64) and must be buildable in CI without manual steps. Several approaches exist: bundling via esbuild/rollup and shipping a Node.js installer, using `pkg` (unmaintained), using Bun's native compile mode, or using Deno compile. The project already uses the Node.js/pnpm ecosystem for development, so the runtime bundler should not require switching the development toolchain.

## Options
1. **`bun build --compile` per platform** — produces a single self-contained binary per platform target; Bun embeds a JS runtime; works with the existing TypeScript source; supports cross-compilation in CI.
2. **`pkg` (Vercel)** — unmaintained since 2023; rejected.
3. **`nexe`** — bundles Node.js; large binary size; limited cross-compilation support in CI.
4. **`npx keel` (npx path)** — no compilation needed; works as a fallback for users who have Node.js; slower cold start; not a self-contained binary.

## Decision
Adopt `bun build --compile` to produce per-platform self-contained binaries (macOS arm64, macOS x86_64, Linux x86_64, Linux arm64). An `npx keel` path is also provided via the package's `bin` field for users who prefer npm installation. Binary builds are CI jobs in the Phase 1 build matrix; the Phase 1 exit gate includes a smoke test (`keel --version`, `keel doctor`) on each platform binary. Bun is a CI-only build dependency — development and testing continue to use Node.js/pnpm/vitest.

## Consequences
Bun must be pinned in CI (same supply-chain discipline as other tools). The binary build step is added to the CI workflow in Phase 1 (Epic 0.4 / Plan 2 scope); Phase 0 only records the decision. The vendored sandbox-runtime and any native modules must be accounted for in the Bun compile step — any incompatibility surfaces during the Phase 1 binary smoke test and must be resolved before the Phase 1 gate passes.

**Runtime env autoload is disabled at compile time (2026-07-20).** The compiled binary sets `compile.autoloadDotenv: false` and `compile.autoloadBunfig: false` (Bun v1.3.3+). By default Bun's runtime autoloads a cwd `.env`/`.env.local`/`bunfig.toml` into `process.env` at process init — before any keel code runs and before workspace trust — which let a project-local file supply keel's provider key and `KEEL_*` control vars (a SEC-012 / ADR-0038 trust-before-parse violation; see ADR-0038 Consequences). Disabling it makes the shipped binary match the Node/tsx dev path, which never autoloads `.env`. A dedicated compiled-binary CI smoke (`packaging/smoke-dotenv-isolation.mjs`) guards the regression, since a Node/vitest unit test cannot observe Bun's autoload.
