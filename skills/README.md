# Built-in skills

keel's curated built-in skills (Epic 1.7, §7). Each skill is a directory containing a `SKILL.md`
with [agentskills.io](https://agentskills.io)-compatible YAML frontmatter:

```markdown
---
name: a-short-name
description: One sentence — *when* to use this skill (this is what the model sees at discovery).
---

The full instructions (the body). Loaded lazily — only when the model invokes the `skill` tool
by name. Keep the description tight (~30–80 tokens as a stub) and the body actionable.
```

**Declarative only (ADR-0026).** A skill is metadata + markdown instructions, never executable code.
There is no code path that runs a skill; the body is text returned to the model on demand.

**Budget.** Built-in skills are capped at ~12 (curated small sets dramatically outperform sprawling
ones). User skills live under `<keelHome>/skills/`; project skills under `<workspace>/.keel/skills/`
(project skills load only after the workspace is trusted — trust-before-parse, §3.2(4)). The discovery
list warns past ~20 total.

The curated set is intentionally small for the alpha — these two are seed examples that exercise
discovery, the stub budget, and lazy body loading; more are content follow-ups, not architecture.
