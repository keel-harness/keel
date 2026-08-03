# R5b verified Warden containment rationale

Date: 2026-08-03

Keel baseline: `79f4b706e659d0ef559178aeac5d0295c7039950`

External workload: public `pallets/click` at local-only commit `edda51f`

Terminal: real PTY, 100 columns x 30 rows

Provider/network usage: no provider call; Anthropic/OpenAI/Google/GitHub credential variables were
explicitly unset. The governed command ran with Warden-enforced network deny-all.

## Scope

R5b addresses DF-012 only. It makes two already-enforced facts visible after an allowed or warned
governed-bash command: writes are limited to workspace/temp, and network egress is deny-all. The
Warden may emit the exact response-only line only after verifying its existing sandbox proof and
contained-arbitrary-code classification. Policy, grantability, sandbox profiles, audit decisions,
session/event/RPC schemas, model-visible tool JSON, and public CLI contracts are unchanged.

## Red-first sequence

1. Initial focused red failed 4 tests and passed 568: no Warden rationale or kernel carrier existed,
   live/resume output ignored the proposed prefix, and a nonzero command was incorrectly shown done.
2. The first implementation passed 572 focused tests.
3. The public issue was re-read; the copy was narrowed to exactly two user-facing facts and
   allow/warn, near-match, output-forgery, and nonzero precedence cases were added first.
4. The tightened suite failed 7 tests and passed 568.
5. Final focused Warden/executor/view-model/product-path/Ink verification passed 755 tests.
6. Final adversarial review found a custom-policy collision with the reserved containment prefix.
   Its regression failed 1 test with 320 skipped, then passed after the Warden response path
   namespaced the reserved copy without changing the authoritative audit decision.
7. The first post-collision typecheck/build caught an exact-optional-property type error in the
   response clone. The absence branch was made explicit; both gates then passed.

No failing test was weakened, skipped, or removed.

## Before and after

- Before: the observed package-install-shaped command showed `tool ✓ bash done` and ordinary output,
  but no reason why an apparently consequential command was safe.
- After: the same governed class renders `contained: writes workspace/temp · network deny-all`, then
  preserves stdout. Warned results retain a distinct Warden warning; failed commands lead with
  exit/stderr and remain failed.
- Sanitized after evidence: `screenshots/23-r5b-containment-after.png`, SHA-256
  `9e3a99f8f56223e42466d7d44a1fbc8845a92310b707f025b818014b58b63d0e`.

The PNG is a terminal-frame transcription of exact real-PTY text, visually inspected at 1400x840.
It is deliberately not described as a live Kitty-window capture.

## Evidence boundary

- E2: focused tests, spawned-Warden durable/audit regression, Ink no-color/TERM=dumb regression,
  full repository coverage, and real sandbox probes.
- E3: credential-unset production source CLI + spawned Warden + vendored SRT through a real 100x30
  PTY against the external Click checkout.
- E4: sanitized terminal-frame transcription at matching representative geometry.
- E5: **NOT_RUN**; zero Anthropic calls, tokens, and spend.

## Product replay

The exact governed command was `python3 -m pip --version`. It completed inside real SRT, displayed
the two containment facts and pip stdout, and generated a durable session plus two allowed
`tool.execute` audit records. The audit decision retained no response-only rationale and the chain
verified. A credential-pattern scan returned no matches. External Click's focused termui suite
passed 227 tests with 23 skips, and its worktree remained clean.

## Final local verification

- Focused Warden/executor/view-model/product-path/Ink: 755 passed.
- Full unrestricted repository coverage: 6,467 passed; 20 existing opt-in skips; 98.02% statements,
  93.73% branches, 99.58% functions, 98.02% lines.
- Real SRT gate with checked-in fixture CA configured before Node startup: 18 passed.
- Typecheck, lint, format, build, and `git diff --check`: passed.
- Restricted full test: **partial/invalid**, 6,461 passed and 20 skipped before six localhost proxy
  binds were denied by the outer sandbox. The unrestricted result above is authoritative.

## Five-lens QC

- **Spec compliance:** uses the existing optional response guidance carrier and preserves Warden
  authority, all decisions, and frozen schemas.
- **Security/adversarial:** requires the Warden's existing containment proof plus an exact closed
  string; near matches, arbitrary guidance, command/stdout text, control suffixes, and high-entropy
  suffixes cannot create the fact. Custom policy guidance cannot collide with the reserved prefix;
  audit retains the original decision.
- **Reliability/edges:** covers allow, warn, nonzero exit, live/resume parity, absent rationale,
  no-color/TERM=dumb, ordinary output, and output bounds.
- **DX/usability:** shows only the two useful facts, preserves warning/output hierarchy, and adds no
  review interrupt.
- **Simplicity/maintainability:** response-only helper plus small kernel/TUI parsers; no dependency,
  state, schema, policy adapter, or new authority.

No unresolved must-fix remained in local QC. Exact candidate CI and publication proof are recorded
on issue #64 and the eventual pull request after the candidate commit exists.
