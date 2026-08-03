# R5a actionable Warden denial guidance

Date: 2026-08-03

Keel baseline: `05452ec46eddcd7d09cdb4b342f8865ad93fb8a2`

External workload: public `pallets/click`, using sanitized `CHANGES.md` edit semantics

Terminal: real PTY, 100 columns x 30 rows

Provider/network usage: none; Anthropic/OpenAI/Google/GitHub credential variables were explicitly
unset for the replay

## Scope

R5a addresses DF-014 only. It promotes the Warden's existing safe denial guidance into the TUI's
`next` line when, and only when, a controller-owned `blocked` result carries the exact
kernel-authored `blocked by warden (not executed):` envelope. R5b separately owns allowed-action
containment rationale. No policy, grantability, audit, session/event/RPC schema, or CLI contract is
changed.

## Red-first sequence

1. The first focused behavior run failed 5 tests and passed 293: exact guidance was absent from the
   conversation/headless recovery surface, generic guidance was not distinguished, and executor
   output did not redact an Anthropic-shaped fixture key.
2. The first implementation passed 298 focused tests.
3. A real 100x30 PTY replay then found a missed product-path edge: live `edit` cards took the path
   shortcut before parsing the tagged denial, so live output still showed generic recovery while
   resumed history showed the exact guidance.
4. A reducer-level regression was added first and failed 1 test with 135 skipped. Moving tagged
   denial handling ahead of the edit shortcut fixed the same live path; the focused regression
   passed.
5. Final adversarial coverage also proves an untagged edit failure that copies the closed envelope
   cannot promote its text as authoritative Warden guidance.

No failing test was weakened, skipped, or removed.

## Before and after

- Before: the observed read-before-edit denial retained exact recovery in the audit/model-visible
  result, but the terminal showed `fix the request or command, then retry`. The earlier sanitized
  workflow capture is `screenshots/18-r3-recovered-receipt-before.png`.
- After: the same controller-tagged denial renders:
  - `what`: the bounded blocked edit;
  - `why`: `the warden denied the action before execution`;
  - `next`: `edit: read 'CHANGES.md' before editing it - keel requires reading a file this session
    before editing it`.
- Sanitized after evidence: `screenshots/22-r5a-denial-guidance-after.png`.

The after PNG is a sanitized terminal-frame transcription of the real PTY reducer replay, with
wrapping adjusted to prevent clipped evidence and the synthetic policy-pack hash omitted. It is
deliberately not described as a live Kitty-window screenshot because detached Kitty windows were not
exposed to the macOS automation session. The real PTY execution and the visual capture are recorded
as separate evidence classes.

## Evidence boundary

- E2: focused executor/view-model/conversation/headless tests, plus full kernel and repository gates.
- E3: credential-unset deterministic controller replay through a real 100x30 PTY.
- E4: visually inspected local terminal-frame transcription of the sanitized PTY replay at the same
  representative dimensions.
- E5: **NOT_RUN**; zero Anthropic calls, tokens, and spend.

## Final local verification

- Focused executor/conversation/headless/view-model: 473 passed.
- Full kernel: 4,075 passed; 2 existing opt-in skips.
- Full unrestricted repository coverage: 6,456 passed; 20 existing opt-in skips; 98.02% statements,
  93.73% branches, 99.58% functions, and 98.02% lines.
- Repository typecheck, lint, format, build, and `git diff --check`: passed after one mechanical
  Prettier correction to the changed condition.
- Restricted coverage was partial/invalid because six loopback proxy tests could not bind under the
  outer harness; the exact unrestricted rerun above is the valid result.

## Five-lens QC

- **Spec compliance:** preserves Warden authority and the existing denial envelope; presentation
  consumes only controller-tagged outcome plus existing guidance.
- **Security/adversarial:** requires both the `blocked` presentation tag and closed prefix; generic,
  empty, untagged, and model-authored text is not elevated. Control bytes and credential-like text
  are stripped/redacted before presentation, and guidance is bounded to 120 display cells.
- **Reliability/edges:** covers live/replay parity, edit shortcut ordering, missing/generic guidance,
  structured findings after the first line, existing terminal-review recovery precedence, and
  recovery reconciliation after an exact retry.
- **DX/usability:** the original recovery no longer requires audit-ledger inspection, adds no new
  interrupt, and preserves calm one-line evidence.
- **Simplicity/maintainability:** two small presentation helpers and one ordering correction; no new
  schema, dependency, retained state, policy adapter, or duplicated recovery authority.

No unresolved must-fix remained in the local five-lens review. Exact candidate CI/publication proof
is recorded in `test-log.md` after the candidate commit exists.
