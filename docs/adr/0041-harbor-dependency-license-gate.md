# 0041 — Harbor dependency: license gate + the keel TB-2 adapter

**Status:** accepted
**Date:** 2026-06-16
**Relates to:** ADR-0022 (OQ-3/OQ-4 pins — model, cost caps, reference harness `terminus-2 via
harbor@v0.13.2` + `mini-swe-agent` cross-check), ADR-0040 (the `bun --compile` glibc-linux binary the
adapter installs), ADR-0031 (the `Recording` that powers the offline walking skeleton), and the
adapter/license tests that provide executable evidence.

## Context

Epic 1.11 (the §2.2 kill-criterion parity gate) scores keel on **Terminal-Bench 2** via **Harbor**
(laude-institute), the TB-2 runner. keel plugs in as a Harbor *installed agent*: a small Python class
subclassing `BaseInstalledAgent`, registered with `harbor run --agent-import-path <module>:<class>`,
which Harbor installs into each task's Docker container and invokes per task. We also keep
`mini-swe-agent` as a documented reference cross-check (ADR-0022).

The charter's **license gate is binding before we depend on anything**: permissive only — Apache-2.0 /
MIT / BSD / ISC — never copyleft (GPL/AGPL/LGPL) or source-available (BSL/SSPL/Elastic). This must be
verified against ground truth *before* building the adapter on it (QR-6 moved the gate to slice 1).
Harbor (the runner), Terminal-Bench (the suite + the `terminus-2` reference agent), and `mini-swe-agent`
(the cross-check) are the third-party code we take a dependency on.

## Decision

**The license gate PASSES. We depend on Harbor.** Verified 2026-06-16 against the GitHub licensee API
and the `LICENSE`/`pyproject.toml` at the pinned tag:

| Dependency | Repo | License | How used |
|---|---|---|---|
| **Harbor** | `laude-institute/harbor` @ `v0.13.2` (`pyproject.toml: license = "Apache-2.0"`) | **Apache-2.0** | the TB-2 runner; the adapter imports `harbor.agents.installed.base.BaseInstalledAgent` and is run via `harbor run` |
| **Terminal-Bench** | `laude-institute/terminal-bench` + `harbor-framework/terminal-bench-2-1` (the **TB-2.1** dataset — ADR-0042) | **Apache-2.0** | the suite + the `terminus-2` reference agent (Apache-2.0-covered) |
| **mini-swe-agent** | `SWE-agent/mini-swe-agent` | **MIT** | the documented reference cross-check (ADR-0022); not imported by keel |

All three are permissive (Apache-2.0 / MIT) — they clear the gate. Harbor's own direct dependencies are
mainstream permissive Python libraries (pydantic, typer, litellm, jinja2, datasets, requests,
fastapi…); none are copyleft/source-available. **Harbor pinned exactly to `0.13.2`** (matching ADR-0022)
in the adapter's `pyproject.toml`.

**The adapter lives outside the TS tree** at `eval/harbor-adapter/` (`keel-harbor-agent`, Apache-2.0):

- `commands.py` — pure, **Harbor-free** shell-command builders (install system deps, install the
  glibc-linux binary, the headless `keel run` invocation, version probe). Harbor-free so the exact shell
  keel runs in a benchmark container — the security-sensitive surface — is hermetically unit-tested in
  isolation (`tests/test_commands.py`, stdlib `unittest`, no Harbor / Docker / network / spend).
- `agent.py` — `KeelAgent(BaseInstalledAgent)` composing the builders into Harbor's `install`/`run`
  lifecycle. Installs an owner-built Epic 1.10 `bun --compile` glibc-linux evaluation binary
  (ADR-0040) from `KEEL_BINARY_URL` only after verifying required `KEEL_BINARY_SHA256`, then runs
  `keel run -p "<task>" --trust` headless. keel's exit code is liveness-only — the TB-2 grader scores
  the task (QR-7).

The keel-side result pipeline (replay `ModelPort` → trajectory → store → results parser) is validated
**offline** through `@keel/eval` against a committed `Recording` (ADR-0031) at zero model cost.

## Consequences

- We may build on Harbor without a copyleft/commercialization risk. Re-verify the license on any Harbor
  major bump (the pin + an ADR are required to change `harbor@0.13.2` anyway, per ADR-0022).
- The adapter is **thin and replaceable**: all keel-specific logic is pure command construction behind a
  Harbor-free module, so if Harbor's interface churns (or we swap runners) only `agent.py`'s lifecycle
  wiring changes, not the tested command surface.
- **glibc floor (QR-3):** the `bun --compile` binary is glibc-linked and needs system `rg` + `bash` at
  runtime — the adapter installs those and fails closed on a non-apt (musl/Alpine) base. The full
  container-prep spec (base image, Anthropic-API egress, the CI linux build) is finalized in slice 8;
  the first live binary run in a clean glibc container is the pre-B1 hard gate.
- **Supply chain:** Harbor + its transitive deps are installed only in the **benchmark/eval environment**
  (Phase B), never in keel's own runtime or the npm package — keel's shipped surface is unchanged.

## 2026-07-22 provenance amendment

CI no longer uploads standalone executables. That mechanically enforces ADR-0040's publication hold
without removing binary build, architecture, warden, audit/export, Debian, or cross-architecture
runtime smoke. Phase-B evaluation instead uses a clean-commit, owner-built local Linux x64 artifact.
Every TypeScript planner, tracked live runner, and Python adapter path carries the owner-recorded
SHA-256; malformed provenance is rejected before Harbor spawn/container work, and mismatched bytes are
rejected before installation or execution. This is evaluation provenance, not release eligibility.
