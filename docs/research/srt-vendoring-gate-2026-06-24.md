# srt Vendoring Gate Research

Date: 2026-06-24.
Evidence: public vendoring, license, build, and real-sandbox tests.
Status: gate complete; owner approval received; pinned source imported under `vendor/sandbox-runtime`.

## Recommendation

Proceed with `@anthropic-ai/sandbox-runtime` as the Phase-2A sandbox adapter target, pinned to the
upstream `v0.0.59` tag at commit `3f4233f173227ca2e9dfde8c4985bc31811a64fc`.

Use the upstream Git source tree as the vendored source of truth, not the npm tarball. The npm package is
useful as a registry/integrity cross-check, but the published tarball contains compiled `dist/` output and
bundled helper binaries rather than the TypeScript source needed for Keel's vendor-and-review model.

Do not vendor or bundle `bubblewrap` or `socat` in Keel. Treat them as host prerequisites checked by
doctor/preflight and reported through the existing fail-fast sandbox tier. `bubblewrap` is the Linux
primitive under `srt`; it is not the Keel policy model by itself.

## Verified Upstream Coordinates

- Upstream repository: `https://github.com/anthropic-experimental/sandbox-runtime.git`.
- Upstream tag: `v0.0.59`.
- Upstream commit: `3f4233f173227ca2e9dfde8c4985bc31811a64fc`.
- npm package: `@anthropic-ai/sandbox-runtime@0.0.59`.
- npm tarball:
  `https://registry.npmjs.org/@anthropic-ai/sandbox-runtime/-/sandbox-runtime-0.0.59.tgz`.
- npm shasum: `532b8958d6a0904689a3a06ed5a4ebbdadbcafd6`.
- npm integrity:
  `sha512-Rbmy6ooITyiW0lhnJu67HpEEnCO68Bpvkqsc1316CCs2DrpFD9G7xo3PgYVkjpiNhTvpH7v6EpQuog8xbg+Bjg==`.

Local verification commands used for this packet:

```bash
npm view @anthropic-ai/sandbox-runtime --json
git ls-remote https://github.com/anthropic-experimental/sandbox-runtime.git HEAD refs/heads/main 'refs/tags/*'
npm pack @anthropic-ai/sandbox-runtime@0.0.59 --pack-destination /private/tmp/keel-srt-research --json
git clone --depth 1 --branch v0.0.59 https://github.com/anthropic-experimental/sandbox-runtime.git /private/tmp/keel-srt-research/sandbox-runtime-v0.0.59
git -C /private/tmp/keel-srt-research/sandbox-runtime-v0.0.59 tag --points-at HEAD
```

## License And Notice Review

- `sandbox-runtime` declares `Apache-2.0` and the upstream source tree contains a root `LICENSE`.
- No upstream root `NOTICE` file was found in the pinned source tree.
- Runtime npm dependencies from the pinned package metadata:
  - `@pondwader/socks5-server@1.0.10`: MIT.
  - `commander@12.1.0`: MIT.
  - `node-forge@1.4.0`: `(BSD-3-Clause OR GPL-2.0)`. Keel may use the BSD-3-Clause option, but
    `VENDOR.md` must record that choice explicitly.
  - `shell-quote@1.8.4`: MIT.
  - `zod@3.24.1`: MIT.
- The upstream source lockfile includes dev-only licenses outside the runtime path, including
  `Python-2.0` via a dev dependency. Do not rely on upstream dev tooling for Keel's build path until a
  full vendored-source dependency audit records those obligations.
- The upstream tree includes `vendor/seccomp-src` and `vendor/srt-win-src`. Treat those as source
  subtrees covered by the upstream Apache-2.0 repository unless a deeper file-level audit finds separate
  notices. Do not ship or build the Windows helper in Phase-2A without a separate Rust crate license and
  security review.

## Adapter Constraints

- Build a Keel-owned `SrtSandboxPort` behind the current warden `SandboxPort`; do not let kernel code call
  `srt` directly.
- Prefer the library API over shelling out to the `srt` CLI so the warden owns config generation, process
  spawning, and status/error normalization.
- Use `SandboxManager.wrapWithSandboxArgv(...)` where possible. It returns a spawn descriptor intended for
  `spawn(argv[0], argv.slice(1), { shell: false, env })`, which is a better final boundary for Keel than
  constructing a host shell command from untrusted bytes.
- The warden must generate sandbox config from trusted policy/capability state. It must not trust or merge
  project-local `.srt-settings.json` as an authority source.
- Keep `strictAllowlist: true` for network config in enforcement tests. Do not provide an interactive
  allow callback from inside the first warden adapter.
- Do not set `filesystem.disabled`, `allowAppleEvents`, `enableWeakerNestedSandbox`, or
  `enableWeakerNetworkIsolation` on any path that Keel describes as an enforcing sandbox tier.
- Scrub or deny sensitive environment variables before process spawn. Claude's own sandbox docs note that
  sandboxed subprocesses inherit the parent environment by default; Keel should not treat filesystem
  isolation as sufficient for secret protection.
- Serialize or explicitly isolate `SandboxManager` lifecycle in the warden. The upstream library has
  process-level manager state for config and proxies, so concurrent config mutation needs tests before
  Keel allows parallel sandbox profiles.

## First OS-Backed Probe Shape

After the completed source import, the first enforcing slice should still be minimal:

1. Keep `vendor/sandbox-runtime/VENDOR.md` and `tools/vendor/verify-sandbox-runtime.mjs` as the import
   integrity gate.
2. Load the vendored runtime through a reviewed adapter path, not directly from kernel code.
3. Run one harmless command through `warden.execute` with a schema-valid allow result.
4. Run one denied filesystem write probe through the same warden path and assert the physical write did
   not happen.
5. If the current platform cannot provide the backend, assert `TIER_UNAVAILABLE`; do not skip into local
   execution and do not claim enforcement on that platform.

The initial config should be intentionally narrow:

- network: deny by default, empty allowlist, strict allowlist enabled;
- filesystem: allow read/write only to the workspace and declared temp area needed for the probe;
- deny read/write to Keel config, policy, audit paths, `.env`, shell credential paths, and Git hook/config
  paths unless a later manifest decision explicitly grants them;
- no custom proxy, TLS termination, Apple Events, Docker passthrough, or unsandboxed command fallback.

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| `srt` is a research preview with evolving APIs | Adapter churn or unstable semantics | Pin source, keep a thin Keel wrapper, and require explicit sync reviews |
| npm tarball lacks source and carries compiled artifacts/binaries | Supply-chain opacity | Vendor upstream Git source, record tarball integrity only as cross-check evidence |
| Dual `node-forge` license expression | Commercialization/licensing ambiguity | Record the BSD-3-Clause choice in `VENDOR.md` and keep license scans in CI |
| Linux depends on host `bubblewrap`, `socat`, and user namespace/AppArmor posture | Hidden reduced tier or CI-only green | Doctor/preflight checks plus fail-fast `TIER_UNAVAILABLE`; real denied probe required before claim |
| Built-in proxy does not inspect TLS and can be vulnerable to broad-domain policy errors | Egress exfiltration path | Keep allowlists narrow; treat TLS-aware proxying as later egress hardening, not first-slice scope |
| Parent environment is inherited by default | Secrets can bypass filesystem restrictions | Scrub credentials before spawn and add a regression before enabling real tool traffic |
| Project-local sandbox settings are convenient but untrusted | Policy widening by workspace content | Warden-owned config only; capability manifest later becomes the trusted generator |
| Upstream manager has shared process state | Cross-session/profile contamination | Single owner lifecycle in the warden and concurrency tests before parallel profiles |
| macOS, Linux, and WSL2 differ materially | False cross-platform claim | Backend-specific status strings and probes; Windows native remains non-enforcing/reduced |
| `bubblewrap` is only a primitive | Security depends on generated arguments | Keel validates config/arguments behind `SandboxPort`; denied-path probes gate claims |

## OSS Reference Notes

- Anthropic's `srt` is the pragmatic short-term target because it already maps a small JS API onto macOS
  Seatbelt and Linux `bubblewrap`, with proxy-mediated network filtering.
- Claude's sandboxing docs are useful operationally, not authority for Keel's claims. They validate the
  same host prerequisites and call out important limitations: native Windows is unsupported, broad domains
  are dangerous, Unix sockets are sensitive, Apple Events weaken macOS isolation, and environment variables
  inherit by default.
- `bubblewrap` itself is not a complete policy system. Its maintainers state that the caller's arguments
  define the actual sandbox security model, which supports Keel keeping the policy/config layer inside the
  warden.
- `socat` is a practical dependency for Linux proxy bridging because it relays bidirectional streams between
  address endpoints.
- Sandlock is worth tracking as a later Linux/Rust hardening candidate: it is Apache-2.0, Rust-based, and
  uses Landlock/seccomp primitives for process confinement. It is not a Phase-2A replacement for `srt`
  because that would reopen ADR-0005, introduce a Linux-only backend choice, and delay the frozen
  kernel-to-warden integration slice.

## External Sources

- Anthropic Sandbox Runtime:
  <https://github.com/anthropic-experimental/sandbox-runtime>
- Claude Code sandboxing docs:
  <https://code.claude.com/docs/en/sandboxing>
- Anthropic engineering note on sandboxing:
  <https://www.anthropic.com/engineering/claude-code-sandboxing>
- `bubblewrap` README:
  <https://github.com/containers/bubblewrap>
- `socat` manual:
  <https://man7.org/linux/man-pages/man1/socat.1.html>
- Sandlock repository:
  <https://github.com/multikernel/sandlock>
- Sandlock paper:
  <https://arxiv.org/abs/2605.26298>
