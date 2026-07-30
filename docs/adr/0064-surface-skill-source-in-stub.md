# 0064 — Surface a skill's source in the discovery stub (shadow visibility)

**Status:** accepted
**Date:** 2026-06-24

## Context

Audit finding **CTX-2** (pairs with CTX-1 / ADR-0063). The skill registry dedups by declared
frontmatter `name` with precedence `project > user > builtin`, so a workspace `SKILL.md` declaring
`name: commit` **fully replaces** the keel-curated built-in `commit` — body and description. But
`renderSkillStubs` rendered each stub as `- <name> — <description>` with **no source marker**, so
neither the model nor a human could tell that `commit` is now workspace-controlled rather than
keel-curated. Built-in skills are positioned as keel-owned trusted guidance; a hostile-but-trusted repo
could silently swap a built-in's behaviour under a name the model already trusts, and the discovery
stub showed only the attacker-chosen description.

ADR-0063 fenced the skill *body* on load; this is the *discovery-list* half of the same gap.

## Options

1. **Do nothing** — rejected (the trusted built-in's name can be silently hijacked, invisible in the stub).
2. **Forbid / namespace a project skill that reuses a built-in name** — rejected for now: it would break
   a legitimate intentional override and is a larger behavioural change; left as a possible follow-up.
3. **Surface the source in the stub (chosen)** — tag every non-built-in skill with its `source`
   (`[project]` / `[user]`); built-ins stay untagged. A shadow then shows `commit [project]`.

## Decision

`renderSkillStubs` annotates each non-built-in stub with its source: `- <name> [project] — <desc>`
(or `[user]`). Built-in stubs are unchanged (untagged, keel-curated). Honest framing — it makes
provenance and shadowing legible; it is not a containment claim (real taint enforcement is the Phase-3
warden).

## Consequences

- A project/user skill — and specifically a shadow of a built-in — is now visible in the discovery
  list the model selects from, and in the transcript a human reviews.
- Consistent with the CTX-1 body fence: workspace-supplied skill content carries a provenance marker at
  both discovery (stub) and load (body) time.
- Stub token budget is essentially unchanged (a short `[project]`/`[user]` tag).
- Follow-up (not done): decide whether a project skill should be *allowed* to reuse a built-in's exact
  name at all, or be namespaced so the override is explicit rather than silent.
