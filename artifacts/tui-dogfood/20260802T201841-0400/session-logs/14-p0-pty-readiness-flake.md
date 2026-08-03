# Session 14 — P0 PTY readiness flake

Date: 2026-08-03

Scope: R11 publication proof and issue #84 observer repair

Provider: none; exact local npm carrier and GitHub CI evidence only

Anthropic cost: USD 0.00

## Outcome

R11 passed reviewed-head CI and merged with an exact-tree match, but its first post-main run exposed
a P0 macOS package-gate flake. Keel had rendered governed sandbox and egress truth. The PTY observer
discarded that row when the next cursor redraw arrived in the same OS read, then waited 20 seconds
for a state already visible on the terminal.

## Evidence

- R11 candidate: `d371b5382df60c5ade5090f97feddd2351b77ca5`
- reviewed-head CI: `30853223179` green
- PR / merge: #83 / `cb15763cf847ed4d404edf834793b36265f70360`
- candidate and merge tree: `f763182c43b038dcf820badcc23be0a329e45cba`
- failed post-main CI: `30853723890`
- failed macOS package job: `91819749594`
- failing raw SHA-256: `2ec55c36050786f510e75d7badcf592bed429217a57dbe7fbc4e6a8e262287ab`
- tracking issue: #84

The secret-safe projected history contains `protection: governed · sbx:on · net:on ·
policy:Guided · audit:on` before an incremental redraw boundary. The legacy current-frame projection
contains only the composer after that boundary. The preceding green main run saw readiness in 794ms,
proving output correctness was unchanged while read chunking differed.

## TDD and validation

- Python/Vitest regression red: 2 Python errors and 1 Vitest failure because no bounded launch-
  history observer existed.
- Python regression green: 2/2.
- Vitest carrier green: 1/1.
- Exact installed-carrier macOS stress: 6/6 at 80x24, readiness 471–615ms, probe 5–6ms, exit 0,
  governed `sbx:on/net:on`, and no surviving process group.
- Newer unavailable protection state remains negative; the fix does not accept reduced enforcement.
- Unrestricted full tests and coverage: 6,529 passed / 20 existing opt-in skips; all enforced
  thresholds pass at 98.00% lines/statements, 93.73% branches, and 99.59% functions overall.
- Typecheck, lint, format, build, and `git diff --check`: pass.
- Exact reviewed-head and post-main CI: pending.

## Boundaries

No TUI product behavior, Warden behavior, sandbox policy, timeout, retry, public CLI, frozen schema,
audit format, dependency, or security claim changed. Interactive waits still use current-frame
semantics; only monotonic launch milestones read the full bounded, secret-sanitized render history.
