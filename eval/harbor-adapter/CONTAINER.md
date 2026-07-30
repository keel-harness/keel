# Container readiness (QR-3) — the keel Harbor adapter

The Terminal-Bench task container is built by Harbor; the keel adapter's `install()` runs **inside** it.
This is the hard spec for what that container must provide and how the adapter handles it. The first
live run through the compiled binary (B1) is the gate that proves it end-to-end — Phase A only builds
and asserts the pieces.

## 1. glibc base floor

The keel binary is `bun --compile` output, which is **glibc-linked** — it does **not** run on
musl/Alpine. The base image must be **glibc/Debian-family** (the TB-2 default task images are).

- The adapter's `glibc_preflight_command()` runs **first** in `install()`: it detects Alpine
  (`/etc/alpine-release`) or a musl `ldd` and **fails closed** with an actionable message, rather than
  installing a binary that cannot execute.
- `system_deps_command()` also fails closed if `apt-get` is absent.
- Musl escape hatch (if a musl base is ever unavoidable): run keel via the **npx package on a
  glibc Node** instead of the compiled binary, or add `gcompat`. Not used by default; documented so a
  forker has the option.

## 2. Runtime + fetch system dependencies (not bundled / not guaranteed)

`install()` adds these in one `apt-get install -y` pass before downloading the binary. **Runtime** deps
the compiled binary does not bundle:

- **ripgrep** — keel's `search` tool shells out to the system `rg` on the standalone-binary build (the
  bundled `@vscode/ripgrep` is only on the npx/dev path). Override path via `KEEL_RG_PATH` if vendored.
- **bash** — keel's `bash` tool needs a real bash (the marker-protocol completion detection).

**Fetch-time** deps the TB-2 task images do **not** guarantee (verified missing on the stock
terminal-bench-2 images during initial bounded Harbor probe — `curl: command not found`, install exit 127):

- **curl** — `install_binary_command` downloads the binary with `curl -fsSL`.
- **ca-certificates** — lets curl verify TLS for an HTTPS binary URL.
- **coreutils** — provides `sha256sum` and the same-filesystem move used by the authenticated atomic
  install.

The adapter installs these itself rather than assuming the base provides them (`commands.FETCH_PACKAGES`).

Interactive-console runtime deps are conditional. When `KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG`
or `KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64` is present, `install()` also installs:

- **tmux** — the approved system-tmux broker backend;
- **bubblewrap** — required by the SRT sandbox launch preparer inside the container;
- **socat** — required by QEMU telnet/stdio console fixtures that bridge local loopback endpoints.

Ordinary benchmark runs do not install those console-only packages, and
`KEEL_WARDEN_SANDBOX=srt` by itself is not enough to trigger them. The adapter also
validates extra env before launch: it allows only `KEEL_WARDEN_SANDBOX=srt` and the
interactive-console config keys plus `KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64`, rejects
the grant env unless reviewed interactive-console product config is also present, rejects
unsupported `KEEL_WARDEN_*`, and rejects all `KEEL_INTERNAL_*` keys so a benchmark
invocation cannot inject private warden stdio or policy internals.

## 3. The linux binary (provenance)

- CI (`.github/workflows/ci.yml`, `package` job) continues to build, architecture-check, and
  runtime-smoke the Linux binaries, but it **does not upload or publish standalone executables**.
  ADR-0040 holds those binaries from release while Bun's linked LGPL/relinking obligations remain
  unresolved; a workflow regression forbids executable artifact uploads.
- For an owner-approved Phase-B evaluation, start from the clean intended source commit, run
  `pnpm package`, inspect and retain `build/bin/build-manifest.json`, compute the SHA-256 of
  `build/bin/keel-linux-x64`, and serve that local build to Harbor. A macOS-target binary will not run
  in the container; the file must be the `linux-x64` target.
- The runner supplies both **`KEEL_BINARY_URL`** and required **`KEEL_BINARY_SHA256`**. The adapter
  downloads into a same-directory temporary file, verifies the lowercase 64-hex digest before any
  execution, runs the authenticated temporary binary's `--version`, and only then atomically replaces
  `/usr/local/bin/keel`. A missing/malformed digest fails before container side effects; a mismatch
  cannot replace or execute the destination.

## 4. Anthropic-API egress

keel calls the provider HTTP endpoint directly (Phase 1 is honest-no-enforcement — no warden/egress
proxy yet). The TB-2 task's pinned `networkPolicy` (Appendix F: `task-default`) **must allow egress to
the Anthropic API** (`api.anthropic.com`). `ANTHROPIC_API_KEY` is injected by Harbor and forwarded by
`run()`. If the network policy blocks it, the live run fails fast at the first model call.

**Observed (initial bounded Harbor probe, harbor 0.13.2):** the stock terminal-bench-2 tasks resolve to an **effective network
policy of `public`** — egress is unrestricted, so both the binary download and the `api.anthropic.com`
call succeed without any allowlist. Harbor's run-specific `--allow-environment-host` /
`--allow-agent-host` flags are therefore **no-ops** under these tasks (Harbor warns and ignores them);
they matter only if a task ships a restrictive policy. There is no egress *enforcement* in Phase 1 — the
reference harness runs under the same `public` task condition, so parity is preserved.

## 5. `--trust`

`run()` invokes `keel run -p "<task>" --trust`. In Phase 1 there is no sandbox, so `--trust` only opts
the workspace into project-context loading (AGENTS.md/skills, Epic 1.7) — it is **not** an enforcement
control here. The task repo is the (trusted) benchmark workspace.

## B1 hard gate (pre-spend, Phase B)

Before any paid benchmark run: **one** live `keel run` through the compiled **linux** binary in a clean
glibc container against the real model (one cheap task) — proving the provider-HTTP path bundles and the
egress is allowed. The offline `--replay` skeleton validates wiring, NOT the live provider path in a
container. This is owner-gated (slice 9).
