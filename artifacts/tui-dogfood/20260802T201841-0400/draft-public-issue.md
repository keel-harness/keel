# Public epic issue body: live external-repository TUI and approval dogfood

Published as [GitHub issue #52](https://github.com/keel-harness/keel/issues/52) on 2026-08-02.

## Scope

Run Keel repeatedly against an isolated open-source repository, capture E3/E4/E5 evidence,
and land only small TUI or approval-presentation changes that materially improve an observed
workflow without weakening enforcement.

## Directly observed evidence

- A governed bash result with `exitCode: 1` rendered `tool ✓ bash done`; only truncated output or
  later assistant prose revealed failure.
- Six review-required commands offered no actionable live decision; four were avoidable command
  shapes and two were consequential, but all looked like the same dead end.
- Read-before-edit supplied exact recovery guidance in the audit while the final TUI exposed only a
  generic retry instruction and preserved the obsolete denial after the edit succeeded.
- Mutation review repeatedly became unavailable after presentation limits, and completed test runs
  were later summarized as `verification not run`.
- `/before-next-edit` and `Esc` both worked and preserved state; these are positive controls to keep.

## First implementation slice

Presentation-only: when a structured bash result envelope reports a nonzero `exitCode` or signal,
render the tool activity as failed in both the live reducer and resumed transcript, even when the
warden transport itself completed successfully. Keep the authoritative envelope, audit record,
policy verdict, tool protocol, and model-visible result unchanged.

Tests start red for live and resumed nonzero bash envelopes, preserve exit-zero cards, and prove the
failure glyph/label is understandable without color. Same-scenario E3/E4 replay must show a failing
pytest command as failed rather than `✓ done`.

## Local non-goals

- No frozen RPC, audit schema, session schema, policy semantics, sandbox strength, provider
  egress, publishing, multi-agent orchestration, telemetry, or memory-plane changes.
- No upstream change to the external workload.
- No speculative redesign and no approval-count reduction without risk equivalence.
- The first slice does not implement live review approval, alter policy classification, reinterpret
  command success for the model, or change frozen tool-result/event schemas.

## Interfaces and packages

- Expected: `packages/kernel/src/tui/**`, presentation-only approval helpers under
  `packages/kernel/src/warden/**`, adjacent tests, and dogfood evidence.
- Stop for human review if evidence points to `packages/shared` frozen schemas,
  `packages/warden` enforcement/policy, public CLI contract, or audit format.

## Tests first

- Add the smallest failing renderer/input/approval-presentation regression for each observed issue.
- Preserve no-color/headless meaning and denied-path visibility.
- Reproduce in a real PTY before and after.

## Slices

1. Establish sanitized fixed-size PTY/Kitty capture and exact provider usage accounting.
2. Run onboarding; fix at most one highest-value observed issue.
3. Run feature/debug/refactor/interrupt/approval scenarios; iterate one issue at a time.
4. Complete five-lens review, broad local gates, immutable evidence, and local commits.

## Risks

- Screenshots or logs leak credentials/private paths: sanitize before capture and reject unsafe artifacts.
- Approval copy outruns enforcement: derive only from authoritative warden results.
- Cost exceeds budget: ledger-derived accounting after every run; preserve USD 2 for regression.
- External task damages data: disposable checkout and isolated owner-only `KEEL_HOME` only.
- Candidate drifts: bind every comparison to branch HEAD and capture timestamps.

## Definition of done

- Required six workflows attempted or honestly blocked.
- Before/after evidence for every retained change.
- Relevant tests plus typecheck, lint, format, and proportionate broader tests pass.
- Five independent review lenses synthesized; every must-fix resolved or escalated.
- No provider spend above USD 20 and no upstream mutation.

## Stop-and-ask triggers

Frozen contracts, enforcement/claim changes, test weakening, dependency changes, release/publish
behavior, external production effects, secret exposure, or a large cross-package change.

## Verification

Targeted red/green tests, same-scenario E3/E4/E5 replay, keyboard/scroll/resize/interrupt checks,
then broad repo gates and final cost/session/audit reconciliation.
