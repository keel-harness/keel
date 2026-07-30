# 0026 — Declarative-only extensibility in the alpha

**Status:** accepted
**Date:** 2026-06-16
**Governs:** `MASTER_SPEC.md` §7 Epic 1.7/1.8 (the declarative-only task) and §11 item 6 (the resequenced
executable Extension API). Relates to ADR-0016 (single-agent durable loop — "the model requests, the
warden decides"), ADR-0017 (agent authority), ADR-0038 (workspace trust gate — what trust unlocks),
and ADR-0027 (Phase 2A/2B split — the warden boundary executable extensions land behind).

> This ADR was seeded in §10.1 and written when SKILL.md / declarative extensibility actually landed
> (Epic 1.7), recording a decision the spec had already made (§7 line 888).

## Context

keel's long-term value includes composability — skills, tools, and extensions that users and the
ecosystem add. The danger is *when* and *how* arbitrary extension code runs. The kernel holds provider
API keys and, in Phase 1, has **no containment** (no warden, no sandbox; `bash` is unsandboxed). If a
project could load and run arbitrary in-kernel TypeScript before the warden exists, "trust to read a
workspace" and "trust to execute arbitrary plugins in the key-holding process" collapse into a single
prompt — exactly the trust-before-parse risk class (§3.2(4)) we otherwise refuse.

## Options

1. **Full executable extension API in the alpha** — projects register code-loading custom tools now.
   Rejected: arbitrary code in the unsandboxed, key-holding kernel before the warden exists.
2. **Declarative-only in the alpha; executable extensions resequenced behind the warden.** Chosen.
3. **No extensibility until Phase 2** — rejected: skills + AGENTS.md + config deliver most of the
   near-term value with no executable surface, and they pair naturally with trust-before-parse.

## Decision

**The alpha ships declarative-only extensibility.** Config, skills (SKILL.md), AGENTS.md, and other
non-executable metadata — all gated by trust-before-parse (ADR-0038, SEC-012). Concretely for Epic 1.7:

- A **skill is metadata + a markdown body, never executable code.** Discovery surfaces ~30–80-token
  stubs (name + description from agentskills.io-compatible frontmatter); the body loads lazily on an
  explicit trigger (the `skill` tool) and is returned to the model as **inert text** — there is no code
  path that executes a skill. AGENTS.md is likewise concatenated as data into a system message.
- **No in-process code loading in Phase 1.** A project must not be able to load and run arbitrary
  in-kernel TypeScript. Declarative tool/skill manifests with declared schemas may register *references*
  to existing gated primitives, but carry no executable body.
- **Executable / code-loading extensions (custom-tool modules) are resequenced to after Phase 2**,
  routed through the warden's per-action `execute` gate so every extension action is sandboxed,
  policy-checked, audited, attributed to a tool/source, and constrained by the side-effect taxonomy
  (§4.8) — the same projection seam governed MCP uses (§11 item 6).

## Consequences

- The long-term extensibility vision is preserved; only *executable* extensibility moves behind the
  trust plane. Near-term composability (skills, AGENTS.md, config) ships now, gated by trust.
- A reviewer must reject any Phase-1 change that adds a code path executing project-supplied content
  (eval, dynamic import of workspace files, running a skill body as code, honoring an AGENTS.md/skill
  instruction as an action keel itself takes). The SEC-012 "loaded as inert data, never executed"
  assertions guard this.
- When the executable Extension API lands (post-Phase-2), it does so on the warden `execute` seam with
  its own ADR; this decision does not design that surface, only fences it off for the alpha.
