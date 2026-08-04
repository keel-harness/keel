# Changelog

All notable changes to keel will be documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with 0.x pre-release semantics (minor bumps may break).

## [Unreleased]

## [0.1.1] — 2026-08-03

The first public pre-alpha npm carrier. `keel-harness@0.1.1` is published and tagged `latest`.

### Added

- Published the `keel-harness@0.1.1` pre-alpha npm carrier with public source metadata, an exact npm
  shrinkwrap, graph-complete SPDX/CycloneDX SBOMs, GitHub attestations, and a stage-only trusted-
  publishing workflow with separate human 2FA approval.
- Added installed-carrier verification across the pinned Node 20, 22, and 24 lines.
- Added Warden-owned connect-time resolved-address enforcement for the vendored SRT TCP carrier,
  including narrow operator-managed private-address exceptions and exact product-path evidence.

The `0.1.0` candidate was staged but never approved or made public; the registry serves no `0.1.0`.
`0.0.1` was a name-reservation placeholder and is superseded.

### Security

Hardening from an internal pre-release security review of how the warden consumes model-writable
workspace configuration. All items predate the first public carrier, so no released version shipped
them.

- **Credential-proxy project config.** `.keel/credential-proxy.json` is now parsed under a restricted
  provenance: only a realpath-contained, workspace-local `file` source is accepted (command/env
  sources and out-of-workspace/`~` paths are refused, re-validated at read time), and governed tools
  can no longer write the workspace `.keel/` project-config directory. Operator-supplied
  credential-proxy configuration (`KEEL_WARDEN_CREDENTIAL_PROXY_RULES`) is unchanged.
- **MCP review trust gate.** `keel mcp review` now requires the workspace to be trusted before it
  reads project MCP config or launches a server (trust-before-parse, SEC-012).
- **Workspace `.env` deny-read.** The nested-`.env` deny-read scan now fails closed rather than
  dropping protection when its bounded enumeration cannot complete; an unreadable subdirectory is
  skipped instead of aborting the scan. One narrow Linux residual is documented in the code.
