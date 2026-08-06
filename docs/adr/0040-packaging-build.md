# 0040 — Packaging build: bun-compile binaries + npx bundle

**Status:** accepted; amended 2026-08-06 for fail-closed optional-ripgrep bootstrap
**Date:** 2026-06-16
**Relates to:** ADR-0009 (bun-compile packaging — the format decision this implements), ADR-0031
(full-fidelity recording — the replay one-task smoke), ADR-0037 (avoid native modules that fight
`ignore-scripts`), and the public packaging tests.

## Context

ADR-0009 chose `bun build --compile` for self-contained binaries (macOS arm64/x64, Linux x64/arm64)
plus an `npx keel` path. Epic 1.10 implements it. Turning a pnpm **workspace** (kernel depends on
`@keel/shared` via `workspace:*`, resolved through the `@keel/source` export condition) into both a
publishable npm package and self-contained binaries raised four concrete decisions that ADR-0009
left open:

1. **How to make a publishable package** from a monorepo with `workspace:*` deps and a `private`
   kernel package.
2. **Ripgrep in a single binary.** `search` uses `@vscode/ripgrep`, whose JS resolves a **native**
   rg binary under `node_modules` — which cannot exist inside a `bun --compile` single file (its
   index even throws at load when its platform binary is absent).
3. **A hermetic "headless one-task run" smoke** (the §7 tests-first) without a live model or an API
   key in CI.
4. **Publication.** The product name (OQ-1) is unresolved and REL-001 (§9.3) is unchecked.

## Decision

1. **A bun-only build script (`packaging/build.ts`).** It runs under **Bun only** (a CI-only build
   dependency — dev/test stay on Node/pnpm/vitest, per ADR-0009; the script is never imported by the
   app). It bundles our own `@keel/*` **source** (via `conditions: ["@keel/source"]`) so there is no
   `workspace:*` left to publish, and emits two artifacts under `build/`:
   - **`build/npx/`** — a self-contained npm package: our code bundled, real npm deps normally left
     **external** and written into a **generated `package.json`** (non-`private`, version from
     `version.ts`, deps = the bundled workspace manifests minus `@keel/*`, plus the
     `@vscode/ripgrep` platform optionalDependencies). `npm`/`npx` installs those deps normally
     (including the native rg). Reviewed locally patched runtime dependencies are explicit bundled
     exceptions: as of 2026-07-21, `ink@7.0.5` is bundled so the npx path cannot silently install
     stock Ink. `cli-truncate@6.0.0` and `slice-ansi@9.0.0` are bundled beside it because they share
     Ink 7's Node >=22 package-engine declaration; `cli-boxes@4.0.1` is bundled because it narrows
     Node 20 to >=20.10 while Keel promises >=20. The four exact reviewed packages carry their MIT
     licenses and a machine-readable component inventory. Their remaining direct runtime
     dependency boundary is resolved from the reviewed installation, emitted as exact generated
     dependencies, and left external so npm ships those packages' own manifests/licenses. React is
     among those external dependencies, so application code and Ink share one runtime instance.
     License redistribution is independently derived from Bun's exact metafile input graph: every
     npm package that contributes bytes, plus the vendored sandbox runtime only when its path is in
     that graph, receives a versioned collision-free license/notice entry. Unsupported or missing
     license evidence fails the build closed. This graph inventory is deliberately broader than the
     four-package externalization exception.
   - **`build/bin/`** — `bun --compile` binaries per target, everything bundled.
2. **Ripgrep resolution is carrier-specific and fail-closed.** `search` gains `resolveRgPath`.
   An explicit operator `KEEL_RG_PATH` wins. The detected standalone binary then selects bare `"rg"`
   on PATH, which `keel doctor` checks. The npm carrier instead resolves its native optional package
   from the `@vscode/ripgrep` umbrella's dependency scope without executing the umbrella module. If
   that optional package is absent, help/version/doctor remain usable, doctor gives one reinstall
   action, and governed search fails before spawn; npm never silently widens to PATH. The binary build
   stubs only `react-devtools-core`, an optional Ink peer the bundler eagerly follows but that loads
   only under `DEV=true`, never in a shipped build.
3. **The `npx` mechanism is proven via a packed tarball** (`npm pack` → install into a fresh prefix
   → run `--version`/`doctor`), in CI on ubuntu + macOS. The one-task replay smoke (ADR-0031
   `Recording`, hermetic, no key) is part of the package-generation slice.
4. **No publication this epic.** Publishing to npm / GitHub Releases / Homebrew is **gated on OQ-1
   (product name) + REL-001 (§9.3)**. 1.10 ships the *mechanism* and CI-proves it; the package name
   is a placeholder. The claim-ledger states this scope explicitly (ground rule 4).

## Consequences

- The binary depends on **system ripgrep** (not a bundled copy) — a deliberate, doctor-checked
  requirement; the `npx` package keeps the bundled `@vscode/ripgrep` so it is self-contained.
- `oven-sh/setup-bun` is added to CI (SHA-pinned, bun version pinned — same supply-chain discipline
  as the other actions, per ADR-0009 "Bun must be pinned in CI").
- Cross-arch binaries (`linux-arm64`, `darwin-x64`) are built + type-checked in the regular `package`
  job. **Update 2026-06-23:** ER-028 is closed by the push-to-main `cross-arch-runtime-smoke` job,
  which runs `linux-arm64` on `ubuntu-24.04-arm` and `darwin-x64` on `macos-15-intel` with
  `--version`, `doctor`, and the hermetic replay probe.
- `packaging/` is excluded from the ESLint type-aware program and the per-package `tsc` (it is a
  Bun-target script); it is validated by **running it** (locally + the CI `package` job). A
  dependency-projection regression test keeps the generated `build/npx/package.json` aligned with
  the runtime dependency manifests for every bundled workspace package, so adding a shared/warden
  runtime dependency cannot silently produce an install-time-missing npx package.
- A regression in the bundle (e.g. an eagerly-resolved optional dep, or a double shebang) surfaces at
  the CI smoke, not at runtime for a user — the smoke is the gate.
- The npx tarball carries Keel's `LICENSE` and `NOTICE`, every license and notice discovered for the
  exact Bun bundle graph, and machine-readable graph/component metadata. Artifact names include
  package versions and flatten scoped names, so simultaneous versions cannot overwrite one another.
  The build fails if a contributing package lacks supported license evidence, the reviewed Ink
  resize marker is absent, a bundled runtime re-enters generated external dependencies, or the
  remaining direct boundary cannot be externalized at its reviewed exact versions.
- When the name clears, publication is additive: point the release pipeline (§9.2) at `build/`.

## 2026-07-21 release-licensing hold for standalone binaries

The npx carrier has a graph-derived permissive-license closure and is eligible for package/release
verification. Standalone `bun --compile` binaries are **not release-eligible** from the present
evidence. Bun 1.3.14's own redistribution notice identifies statically linked LGPL-covered
JavaScriptCore/WebKit and relinking obligations; repository policy requires explicit approval for
LGPL dependencies. ADR-0009 and this ADR selected the mechanism but did not record that approval or
an application-object/relinking distribution design. Building binaries for evaluation remains
mechanically possible, but publication, signing, and claims of license-complete binary
redistribution are held pending a separately reviewed licensing ADR/approval or a replacement
carrier. This hold does not alter the public npx runtime contract.

The hold is mechanically enforced in CI as of 2026-07-22: package jobs still build, architecture-check,
and runtime-smoke standalone binaries, but no workflow artifact step may upload `build/bin/keel-*`.
`packages/kernel/src/cli/ci-workflow.test.ts` protects both halves of that invariant. Owner-approved
Harbor evaluation may use a clean-commit local build authenticated by its recorded SHA-256; that
private evaluation path is not publication, signing, or a claim of release eligibility.

## 2026-07-24 process-specific npx amendment

ADR-0082 replaces the npx carrier's one generated JavaScript bundle with three named entries behind
the unchanged public `keel: ./bin/keel.mjs` map. The public file is a small paint-first launcher;
private `keel-kernel.mjs` and `keel-warden.mjs` bundles contain the process-specific runtime graphs.
The Kernel launches only that exact sibling Warden with `process.execPath`, while the Warden entry
installs the bundled vendored SRT runtime before starting the existing host. Redistribution evidence
is derived from the sorted union of both Bun metafile graphs, so splitting process loads does not
split or narrow the legal inventory.

The `bun --compile` carrier still uses `packaging/cli-entry.js` and retains its packaging-owned
single-file hidden-Warden dispatch. Its release-licensing hold above is unchanged. This amendment
changes no public npm command, dependency projection, runtime authority, performance budget, or
binary-publication decision.
