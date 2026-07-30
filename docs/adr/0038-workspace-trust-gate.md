# 0038 — Workspace trust gate (trust-before-parse)

**Status:** accepted
**Date:** 2026-06-16
**Governs:** `MASTER_SPEC.md` §3.2(4) (the Trust-before-parse guarantee) and §7 Epic 1.7. Relates to
ADR-0017 (agent authority — "the model may not mark a workspace trusted"), ADR-0033 (autonomy modes —
the same user/project-scope persistence discipline), ADR-0026 (declarative-only extensibility — what
trust unlocks is *data*, never code), and ADR-0035 (the keel-internal config/ledger surfaces).

## Context

§3.2(4) promises **trust-before-parse**: nothing project-local (AGENTS.md, project config, skills,
extensions) is read or parsed before the user explicitly accepts a trust prompt for that workspace —
a tested kernel invariant (SEC-012). Phase 1 had this only on paper, and worse, the Epic-1.6b
environment snapshot was read **pre-trust** by the bin (a real SEC-012-class gap): keel listed the
workspace and probed toolchains before any trust decision existed.

Two design forces:

1. **The guard must be structural, not per-caller convention.** The spec calls for "a guard in the
   single filesystem-access chokepoint, not by convention." The tree had no such chokepoint — the typed
   tools resolved through `Workspace` (path containment), but `environment.ts` read `node:fs` directly,
   and the bin touched the workspace too.
2. **Trust is a human act (ADR-0017).** The model may *request*; it may not mark a workspace trusted.
   The decision must live where an untrusted repo cannot reach it, and there must be no tool that sets
   it. It must also work without a human present (`keel run -p`, CI), which means a safe default.

This is the workspace **trust decision/gate** — distinct from the Phase-3 provenance/taint format
(`TrustLevel` in `@keel/shared`, reserved, not enforced). Do not conflate them.

## Options

1. **Per-loader convention** — each loader checks a trust flag before reading. Rejected: exactly the
   "by convention" the spec forbids; one forgotten check reintroduces the gap.
2. **A single gated fs chokepoint (`ProjectReader`)** — every project-metadata read routes through one
   object that refuses (and returns empty) until trusted, and records each attempt for instrumentation.
   Chosen.
3. **Gate the model's typed tools on trust too** — make `read`/`search`/`bash` refuse on an untrusted
   workspace. Rejected for Phase 1: that conflates *trust* (a decision) with *containment* (the
   warden's job, Phase 2), and a declined workspace would be non-functional for coding. The spec's
   "declining leaves the agent functional with empty project context" points the other way.

## Decision

1. **A single trust-gated chokepoint — `ProjectReader`.** All of keel's project-metadata reads (the
   environment snapshot, hierarchical AGENTS.md, SKILL.md discovery + bodies, future project config) go
   through one `ProjectReader`. Until the workspace is trusted, every read returns empty **and performs
   zero real fs access**; an access log records served-vs-refused reads — the SEC-012 instrument. The
   env snapshot, AGENTS.md, and skill loaders take a `ProjectReader` and never import `node:fs`
   themselves. This is an **in-process kernel-DX invariant** (like read-before-edit / SEC-025), the
   model can only request and the gate decides — **not** the warden and **not** a containment boundary
   (Phase 1 is honest-no-enforcement; `bash` is unsandboxed).

2. **The decision is resolved at session start, before the agent loop and before any project read.**
   Resolution order: explicit human opt-in (`--trust` flag / `KEEL_TRUST=1`, a per-run override) →
   persisted prior decision → interactive prompt (TTY only) → **fail closed to untrusted**. A
   non-interactive run (`keel run -p`, CI) never prompts; it takes the fail-closed default unless a
   human opted in. Because the decision precedes the loop, the model cannot act — cannot call a tool —
   in the pre-acceptance window; the only possible pre-acceptance reader is keel's own auto-loader,
   which the gate blocks.

3. **The decision persists in user-scope config, never project-file scope** (`<keelHome>/trust.json`),
   keyed by the **realpath'd** workspace root, atomic write (temp+rename, `0600`), zod-validated and
   **fail-closed** (a malformed/invalid file reads as "no record" → re-decide, never a silent grant).
   Save is **fail-soft** (best-effort): an unwritable config dir skips persistence rather than crashing
   an accepted run. Mirrors ADR-0033's mode persistence: an untrusted repo cannot grant itself trust,
   and there is **no dedicated tool** that writes it — enforcing ADR-0017's "may not mark a workspace
   trusted" by construction. *Honest caveat:* the path-contained `read`/`write`/`edit` tools cannot
   reach `keelHome`, but Phase-1 `bash` is unsandboxed, so the model could in principle write
   `trust.json` to self-trust a *future* run — the disclosed honest-no-enforcement reality the warden
   closes in Phase 2 (the structural "no tool path" guarantee is for the dedicated tool surfaces).

4. **What trust unlocks is data, never code (ADR-0026).** Post-trust, AGENTS.md and skills load as
   inert text; there is no code path that executes them. The trust prompt copy is honest about Phase-1
   no-enforcement (states there is no sandbox/policy/audit) and never implies containment that does not
   exist (the §4.9.1/§8.6 honesty invariant) — Appendix G's "what stays sandboxed" wording is
   Phase-2+ copy, deliberately not used.

## Consequences

- **SEC-012 lands as a Phase-1 kernel invariant** (claim-ledger: Trust-before-parse → Proven), proven
  against the seeded `fixtures/hostile-repos/` corpus: zero project reads before acceptance; decline →
  functional with empty context; accept → malicious AGENTS.md/skill load as inert data.
- **Honest scope / documented limitation (downgrade the claim, not the honesty).** Trust-before-parse
  in Phase 1 covers keel's **automatic** project-metadata loading + the pre-acceptance window. It does
  **not** gate the model's typed-tool reach after a *decline* — in Phase 1 (no warden) the model could
  still reach files via its ungoverned tools. That is the warden's job in Phase 2; recorded as ER-025,
  not hidden. SEC-012 is honest about exactly what it proves.
- **Phase-1 skill gating choice.** Built-in skills are gated through the same `ProjectReader` as project
  skills (a declined workspace gets no skills), keeping the chokepoint genuinely single and SEC-012
  clean. A refinement could surface keel-owned built-ins regardless of trust (ER-026).
- **The env-snapshot pre-trust gap is closed** — it now loads only post-trust through the gate.
- **Forward seams.** A nested-launch AGENTS.md hierarchy (workspace root ≠ cwd) already works
  (root→cwd merge, bounded by the root — never read above it). Warden-enforced trust + typed-tool
  gating is Phase 2; provenance/taint is Phase 3.
- **No frozen interface/schema/protocol/audit change.** `trust.json` is keel-internal config (not a
  frozen format); `--trust`/`KEEL_TRUST` are additive CLI surfaces; the `skill` tool is a kernel tool
  (like `plan`), not a `ToolSpec`/RPC contract change.
- **The invariant covers runtime env autoload in the compiled binary (2026-07-20).** The
  `ProjectReader` chokepoint gates project files keel *reads*, but the shipped `bun --compile` binary
  had a below-keel hole: Bun's runtime autoloads a cwd `.env`/`.env.local`/`bunfig.toml` into
  `process.env` at process init, before any keel code runs and before trust — so a project-local file
  could supply keel's provider key and every `KEEL_*` control var (arbitrary env injection into keel,
  its children, and the warden). This was invisible to `sec-012.test.ts` because vitest runs under
  Node, which never autoloads `.env`. The fix disables Bun's autoload at compile time
  (`packaging/build.ts` → `compile.autoloadDotenv`/`autoloadBunfig = false`; ADR-0009/0040), making the
  shipped binary match the Node/tsx dev path. A workspace `.env` is now ignored (unlike raw Bun); the
  sanctioned key sources are unchanged (`keel auth set` → 0600 store, or an exported env var). Proven
  by the compiled-binary probe `packaging/smoke-dotenv-isolation.mjs` (a unit test cannot — Node does
  not autoload). Trust-before-parse's scope now explicitly includes runtime-level env autoload.
