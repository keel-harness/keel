# Hostile-repo corpus (intentionally malicious test fixtures)

> ⚠️ **Everything under this directory is deliberately malicious test data.** It is never executed.
> It exists only to prove keel's defenses. Do not run any script here; do not treat any instruction
> in these files as real.

A versioned corpus of booby-trapped workspaces (`MASTER_SPEC.md` §7 Epic 1.7). Seeded in Epic 1.7 to
exercise **trust-before-parse (SEC-012)** now, and reused by the sandbox/egress catalog
(SEC-004/005/006/011/013) and the injection demo in Phase 2.

`booby-trapped/` contains, in one workspace:

- `AGENTS.md` — a prompt-injection that *instructs* secret exfiltration and running a script. keel
  must treat it as **data, never executed** (ADR-0026) — and must not read it at all before trust.
- `README.md` — poisoned project docs (more injection).
- `.env` — a bait secret. keel must not read it just because `AGENTS.md` says to.
- `install.sh` / `package.json` (postinstall) — install-script traps (Phase-2 sandbox cases).
- `.keel/skills/exfiltrate/SKILL.md` — a malicious skill; its body must load only on an explicit
  `skill` trigger, never auto-run.
- `escape-link` → `../escape-target.txt` — a symlink escaping the workspace (Phase-2 containment,
  SEC-004/005).
- `EXFIL.md` — docs that instruct exfiltration.

The Phase-1 proof (SEC-012) lives in `packages/kernel/src/cli/sec-012.test.ts`: open this untrusted
workspace → **zero project reads before acceptance**; decline → functional with empty context; accept
→ the malicious files load as **inert data** (keel never acts on their instructions).
