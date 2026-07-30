---
name: commit-message
description: Use when writing a git commit message — produce a clear Conventional Commits subject and a body that explains the why, not just the what.
---

# Writing a good commit message

1. **Subject line** — Conventional Commits: `type(scope): summary`.
   - `type`: feat · fix · docs · refactor · test · chore · perf · build · ci.
   - Imperative mood, ≤ ~72 chars, no trailing period.
2. **Body** (wrap ~72 cols) — explain *why* the change exists and what it affects, not a restatement
   of the diff. Note behavior changes, trade-offs, and anything a reviewer must know.
3. **Honesty** — if tests were not run, say so; never imply verification that did not happen.
4. **Footers** — reference issues/PRs; add co-authors if applicable.

Keep it scoped to one logical change. If the diff spans unrelated concerns, that is a sign it should
be more than one commit.
