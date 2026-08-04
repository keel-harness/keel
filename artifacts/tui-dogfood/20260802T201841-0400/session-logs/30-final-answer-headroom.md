# Final-answer rewrite headroom

Date: 2026-08-04

Public work item: [issue #133](https://github.com/keel-harness/keel/issues/133).

## Observed exact-main defect

The first strict same-commit replay used the exact installed npm carrier from clean `main`
`01eca27303af3d8d4b860cd342df54da437589ce`, a fresh owner-private Keel home, the frozen Click
onboarding checkout `00e592cea702e0b2caa0dee42489fdb1c22cd845`, a real 100x30 PTY, spawned
production Warden, Guided policy, sandbox on, egress guard on, and
`anthropic/claude-sonnet-4-6`.

The 976-word original triggered ADR-0087's one tools-disabled rewrite. That rewrite contained 253
controller-counted words against the explicit 250-word hard maximum. Keel correctly retained the
original, rejected the rewrite, and settled `fallback-oversized`; it did not truncate, retry,
execute a rewrite tool, weaken the contract, or modify Click. The failure was honest but poor UX:
an otherwise useful answer missed an approximate model-side count by three words and became the
deterministic fallback.

The original runner's obsolete returned-composer predicate required manual process interruption
after the authoritative durable `run_status` existed, so no synthetic PASS report is manufactured.
The ledger records 12 provider routes, 361,144 input tokens (145,772 fresh, 83,572 cache write,
131,800 cache read), 4,441 output, and exact estimated cost USD 0.85686600. Three preceding runner
preflight failures made zero provider calls and remain retained outside the repository: credential
environment discovery, an obsolete `/answer` footer predicate, and a long-prompt echo predicate.

## Scoped design and TDD

Issue #133 preserves ADR-0087's typed hard word/byte contract, single tools-disabled rewrite,
output-token rail, controller validation, fallback, persistence, inspection, budget, and Warden
boundaries. It adds only a prompt-level preferred target at 90% of the hard word maximum and asks
the rewrite to omit unsupported runtime specifics. There is no second retry, truncation, silent
oversize acceptance, global style heuristic, dependency, schema, ModelPort, Warden, policy, audit,
sandbox, egress, or public CLI change.

Red-first evidence was retained twice:

- minimum/observed/maximum target tests failed three cases before the preferred-target prompt was
  implemented;
- after an accepted rewrite still repeated unsupported runtime prose, the stricter omission
  expectation failed before the implementation sentence changed.

The property test covers all allowed 40..2,000 word contracts across 200 generated values. It proves
the target is `floor(maxWords * 0.9)`, positive, and strictly below the unchanged hard maximum.
Boundary cases are 36/40, 225/250, and 1,800/2,000 words. Contract-absent execution is untouched.

## Rejected live candidates

Both rejected candidates used clean exact installed scripts-disabled npm carriers, fresh Keel
homes, the same frozen Click task, real 100x30 PTYs, and zero Warden reviews. They passed the
mechanical hard contract but failed human final-answer QC:

| Candidate | Original / rewrite | Settlement | Provider routes | Cost | Rejection |
| --- | --- | --- | ---: | ---: | --- |
| `398b108` | 916 / 212 words | `accepted-rewrite` | 12 | USD 1.07217240 | confidently claimed an unprobed character-iteration runtime behavior |
| `d71eda8` | 873 / 214 words | `accepted-rewrite` | 21 | USD 0.49859415 | labeled the same unsupported runtime claim unverified but still repeated and planned around it |

Mechanically compliant prose is not accepted as trustworthy merely because the controller returns
PASS. Both candidates remain rejected evidence, not score credit.

## Accepted candidate and live result

The retained code candidate is `305b8b16d61663f568b5557c348a97895b3f84de`, tree
`5d2b79f579a66c9843ed918b8369288a8a4b9c55`. Its exact scripts-disabled npm tarball SHA-256 is
`32b9f09d50a0d6cdb856356ee058fc5865b718255b403622e82ba83e7a0a7fc1`.

The v3 live run exited zero and settled `accepted-rewrite`. The original was 734 words / 5,666
UTF-8 bytes; the primary rewrite was 223 words / 1,854 bytes, below the unchanged 250-word / 16,000-
byte hard contract and the 225-word preferred target. Rewrite SHA-256 is
`302c42fa04deefbd738da75865700c9ebf3887ede8f6f8955e5a4f6d68382ca0`.

Independent source review confirmed the primary's claims against frozen Click:

- `src/click/termui.py` has the stated `str | Iterable[str] | None` overloads and exact
  `isinstance(filename, str)` branch before `Editor.edit_files`;
- `src/click/_termui_impl.py` has `Editor.edit_files(Iterable[str])`, `list(filenames)` in the
  `Popen` argv, and existing `os`/`Path` imports;
- `tests/test_termui.py` has the named edit/path-normalization tests with no PathLike variant;
- `pyproject.toml` confirms Python >=3.10, `flit_core`, pytest, mypy, and pyright commands.

The answer avoids the unsupported character-iteration claim and proposes a plausible minimal plan
without presenting a runtime probe as completed. Click remained byte-clean and detached at the
frozen commit. The production run records nine provider routes, zero Warden reviews, 278,769 input
tokens (80,129 fresh, 106,534 cache write, 92,106 cache read), 3,526 output, and exact cost USD
0.72041130. The sanitized report and transcript SHA-256 values are `3ee3f469…` and `9806bea4…`.

## Current-head verification

- `pnpm exec vitest run packages/kernel/src/final-answer.test.ts`: **15/15 passed**.
- Seven-file final-answer adjacency: **377/377 passed**.
- Nineteen-file final-answer/CLI/session/Ink adjacency: **1,114/1,114 passed**.
- `pnpm test`: **365 files / 6,673 passed / 20 intentional opt-in skips**.
- `pnpm test:cov`: exit 0; every enforced package threshold passed with the same **6,673 passed /
  20 intentional opt-in skips**.
- `pnpm lint`, `pnpm typecheck`, `pnpm format`, `pnpm supply-chain:check`, `pnpm build`,
  `pnpm package`, and `git diff --check`: passed.
- First `pnpm test:sandbox:real`: **13 passed / 5 skipped, exit 1** because Node had not started
  with the required vendored fixture CA; retained as a setup-preflight failure.
- Exact rerun with the documented non-secret `NODE_EXTRA_CA_CERTS` fixture: **18/18 passed**.

## Screenshot

`screenshots/70-final-answer-headroom-live.png` is a sanitized, visually inspected 1400x840
exact-text transcription of the final 100x30 live carrier viewport. It shows the factual bounded
answer tail, clean idle composer, provider/model label, workspace trust, and governed sandbox,
egress, policy, and audit posture. It is not claimed as a live-window capture. SHA-256:
`abf690d9e8fbe2c76968b14a3d6c661a43b7f0fd5c78cb2b42e3804498c697b8`.

No provider credential, username, user-home path, private runtime path, or sensitive environment
value appears in the image or committed text.

## Five-lens synthesis

- **Spec compliance — pass:** the typed hard contract, one rewrite, byte/output rails, fallback,
  inspection, task scope, and absent-contract behavior remain as accepted in ADR-0087; the target is
  an explicitly non-authoritative prompt preference.
- **Security/adversarial — pass:** tool schemas remain structurally absent from rewrites; no retry,
  acceptance widening, new Warden authority, sandbox/egress change, retained-byte exposure, or
  security claim is introduced. Real denial/TLS probes pass.
- **Reliability/edge cases — pass:** minimum/observed/maximum and full-range property cases preserve
  positive headroom; hard validation and fallback remain authoritative; two semantically poor but
  mechanically compliant candidates were rejected rather than hidden.
- **DX/usability — pass:** exact-main's three-word miss is replaced by a 223-word factual primary
  with the same hard boundary, clean completion state, and no unsupported runtime detail.
- **Simplicity/maintainability — pass:** one local ratio constant and two prompt sentences reuse the
  existing settlement path; no new state, interface, dependency, or abstraction.

No local must-fix remains for issue #133. Security claims affected: none. Additional ADR needed: no;
ADR-0087 already governs the unchanged contract. The candidate does not rescore onboarding because
it repairs reliability of the already credited #113 outcome. The strict all-six same-commit replay
remains open until publication and exact merged-carrier reruns.
