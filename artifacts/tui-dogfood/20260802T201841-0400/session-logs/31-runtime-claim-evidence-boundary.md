# Runtime-claim evidence boundary

Date: 2026-08-04

Public work item: [issue #136](https://github.com/keel-harness/keel/issues/136).

## Exact merged reproduction

The strict replay resumed from the exact scripts-disabled npm carrier built from clean `main`
`9a9e40adfed1815b5204e90caca71b2ddbddc2aa`. A fresh owner-private Keel home, frozen detached
Click checkout `00e592cea702e0b2caa0dee42489fdb1c22cd845`, real 100x30 PTY, production Warden,
Guided policy, sandbox, egress guard, audit, and `anthropic/claude-sonnet-4-6` were used.

The run mechanically passed and settled `accepted-rewrite`, but human semantic QC rejected its
primary. Source inspection showed that a bare `pathlib.Path` bypasses the `str` guard and reaches
`edit_files`, yet the answer stated that `Path` is iterable character by character. That runtime
mechanism was neither demonstrated by a preceding tool result nor true on the measured runtime.
The exact run made ten provider requests, requested zero Warden reviews, left Click clean, and cost
USD 0.42787605.

## Rejected ordinary-system-prompt candidates

Issue #136 initially constrained the repair to the ordinary system prompt. Three red-first prompt
variants were packaged and run through fresh homes and fresh frozen Click worktrees. All exited
zero, settled `accepted-rewrite`, requested zero reviews, and passed the mechanical runner. All
failed human semantic QC:

| Candidate | Requests | Exact cost | Human-QC failure |
| --- | ---: | ---: | --- |
| `8017d6c` | 12 | USD 0.45934575 | retained the false character-by-character iteration claim |
| `82dd275` | 12 | USD 0.44783460 | corrected the core claim but predicted an unproven list/type failure |
| `c38c979` | 13 | USD 0.61852755 | returned to the false character-iteration mechanism |

This is evidence that a global instruction alone did not reliably control a load-bearing claim in
the bounded final answer. No candidate was accepted merely because the harness said PASS.

## Approved scope extension and red-first proof

The owner approved extending #136 to ADR-0087's existing tools-disabled final-answer rewrite
instruction. The public scope amendment preserves one rewrite, tool absence, hard word/byte and
output rails, deterministic fallback, settlement persistence, and inspection. It explicitly
excludes a second request, retry, semantic classifier/grader, phrase filter, forced execution,
dependency, schema, ModelPort, Warden, policy, sandbox, egress, audit, grant, RPC, CLI, or security-
claim change.

Three focused assertions failed before implementation. The retained rewrite instruction now makes
three requirements explicit:

1. runtime behavior is unsupported without a preceding tool result that directly demonstrates it;
2. source text, types, the original answer, and an `unverified` label are not runtime evidence;
3. an unsupported prediction must become source-level control flow plus an explicit unknown, with
   no named failure mechanism.

The retained signed code commit is `a944839c1f67d28bfaab0ad2735fa1cfb031c48c`. Its diff against
the exact base changes only `packages/kernel/src/final-answer.ts` and its focused test.

## Independent accepted live validations

The exact scripts-disabled candidate tarball SHA-256 is
`6e60e4fb1f37e0d80a4f9d2ebeec0d70c823afdc4a31fdf6ad865102db00bf77`. Both independent runs used
fresh owner-private Keel homes and fresh detached Click worktrees at the frozen commit.

| Run | Requests | Settlement | Exact cost | Human semantic outcome |
| --- | ---: | --- | ---: | --- |
| live 1 | 12 | `accepted-rewrite` | USD 0.33683610 | pass: source branch and `list(filenames)` stated; runtime outcome left unknown |
| live 2 | 9 | `accepted-rewrite` | USD 0.82259265 | pass: source fall-through stated; list/Popen behavior explicitly unknown without execution |

Both exited zero, requested zero Warden reviews, retained the governed footer and idle composer,
and left Click byte-clean. The completion-frame SHA-256 values are
`6fdf7ed10d37a87a96a00493eb19af0a810244fc61a7b0f421385a09c3d8cdb0` and
`c9385722c8c29098722e796371e40c4f9c985eed10436ce0465838eb1180e282`.

## Verification

- Red-first focused test: **3 failed** before the retained prompt implementation.
- `corepack pnpm test packages/kernel/src/final-answer.test.ts packages/kernel/src/context/system-prompt.test.ts`:
  **2 files / 40 tests passed**.
- `corepack pnpm test`: **365 files passed / 4 skipped; 6,673 tests passed / 20 skipped**.
- `corepack pnpm test:cov`: exit 0 with every package threshold green; **365 files passed / 4
  skipped; 6,673 tests passed / 20 skipped**.
- `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm format`, `corepack pnpm build`,
  `corepack pnpm package`, and `git diff --check`: passed.
- Supply-chain, artifact-consistency, and exact-head CI remain publication gates at this point in
  the chronology.

## Screenshot

`screenshots/71-runtime-claim-boundary-live.png` is a sanitized, visually inspected 1400x840
exact-text transcription of a selected excerpt from live validation 2's final 100x30 viewport. It
shows the evidence-bound runtime unknown, concise plan, clean composer, and governed posture. It is
not claimed as a live-window capture. SHA-256:
`6371656d6b2dc8118bff80d6f0e8a4980757328b6702c04b5e42a4d381b86d3f`.

No provider credential, username, private home/runtime path, audit key, or sensitive environment
value appears in the image or committed text.

## Five-lens synthesis

- **Spec compliance — pass:** ADR-0087's typed contract and one-rewrite state machine are
  unchanged; only the existing tools-disabled instruction is more evidence-bound.
- **Security/adversarial — pass:** tools remain structurally absent; no retry, authority widening,
  acceptance relaxation, Warden/security surface, or new retained data exists.
- **Reliability/edge cases — pass:** three global-prompt failures remain visible; two fresh-home
  rewrite-boundary runs independently avoid a named unsupported failure mechanism.
- **DX/usability — pass:** the final answer preserves useful source-level control flow while making
  the unexecuted runtime outcome unmistakably unknown.
- **Simplicity/maintainability — pass:** three prompt sentences and focused assertions add no state,
  interface, dependency, heuristic, or second model call.

No local must-fix remains for the approved #136 slice. Security claims affected: none. Additional
ADR needed: no; ADR-0087 already governs the unchanged contract. The two accepted candidate runs
restore the provisional onboarding outcome to **4.11/5**, the candidate six-workflow mean to
**4.04/5**, and pooled diagnostic to **4.02/5 (249/62)**. Those are not promoted to official final
proof until publication and the exact merged all-six replay complete.
