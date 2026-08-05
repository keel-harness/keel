# R25 — controller recovery-guidance implementation and live stop

Date: 2026-08-05
Terminal: 100 columns × 30 rows
External baseline: Click `00e592cea702e0b2caa0dee42489fdb1c22cd845`

## Authorized scope

The owner authorized a separate controller recovery-guidance continuation, including its public
issue and implementation on PR #142. Public issue #144 limits the slice to the existing
`terminalReviewRecovery` controller instruction: read-only discovery should use typed `search` or
`read`; a typed no-match is a completed observation; and a requested test/check/command should use
one atomic bash call. It forbids Warden/POL-003 changes, a second recovery, controller rewriting,
tool filtering, command-specific exit reinterpretation, dependency changes, frozen-contract
changes, and security-claim changes. Its live protocol permits one first replay and requires an
immediate stop on failure.

## TDD and implementation

Before the production string changed, the exact focused command failed two intended cases and
skipped 213: the new string contract failed, and the loop did not inject the required exact
controller message. The retained change touches only `packages/kernel/src/strings.ts`,
`packages/kernel/src/strings.test.ts`, and `packages/kernel/src/loop.test.ts`.

The same focused command then passed 2/2. Full string/loop coverage passed 215/215; adjacent system
prompt, compaction, typed search/schema, terminal review, executor, resume, steering, and headless
coverage passed 479/479. Unrestricted full coverage passed 365 files with 6,692 tests and 20
intentional opt-in skips at 97.87% statements / 93.63% branches overall; Warden remained 97.61% /
91.72%. Lint, typecheck, format, supply-chain, build, package, and diff checks passed. Five-lens QC
found no local must-fix. Security claims affected: none. ADR needed: no.

Signed head `3b21d2a250e57ac7996937293faba3666f13eca8` passed exact-head CI run
`30976412151`, including required aggregate `92212176409`, build/coverage, package, Node-next,
security, real sandbox, egress scale, and all three installed-product egress matrices.

## Exact carrier gate

The first attempted carrier was correctly rejected before provider use: an old `build/npx` tree
reported source `38f21af`, `dirty: true`. Rebuilding from the clean signed head produced an exact
scripts-disabled carrier reporting `3b21d2a`, `dirty: false`, with tarball SHA-256
`aefbff8d37cf4a27a813b55d3024d91ba55b0654445050ee347db5aa91f6f7d2`. The installed bundle
contains the new controller recovery instruction.

## First live replay and stop

The single permitted first replay made 18 provider requests, opened zero actionable human review
prompts, and cost USD 0.26713935. It reported 186,889 input tokens: 20,763 fresh, 30,779 cache
write, and 135,347 cache read, plus 3,255 output tokens.

The model ignored the ordinary prompt's existing command-shaping rules and requested
`pip show pytest mypy pyright ruff 2>&1 | grep ...`. Warden correctly returned a terminal POL-003
no-handle review and did not execute it. The bounded recovery then used one bash call, but batched
four availability checks with `&&`. Pytest reported 9.1.1; the call exited 1 when mypy was absent.
Because the sole correction failed, #139 correctly retained terminal closeout. The model listed
intended edits and treated dependency installation as a prerequisite but changed no file. The
scenario itself says to request narrow setup when dependencies are missing, while its expected
outcome says unavailable static checks should be reported explicitly; that ambiguity is a material
validation confounder.

The public process exited 1 with `BLOCKED_AFTER_SYNTHESIS`. Click remained clean. `git diff --check`
and the existing termui test file passed, but the independent PathLike runtime probe failed and the
required three-file mutation was absent. The strict feature outcome is **FAIL**.

This does not invalidate the deterministic #144 wiring proof, but it does invalidate #144's live
definition of done and provides no user-outcome or score credit. The run did not reproduce the
targeted terminal *file-discovery* shape; it entered a distinct tool-availability branch encouraged
by ambiguous scenario wording. It therefore cannot isolate whether #144 improves the intended
`find`/`grep` recovery. More product prompt text would be speculative on this evidence, while tool
filtering or command transformation is explicitly outside #144. Per the public stop condition, the
second replay is **NOT_RUN**, all Anthropic use is stopped, and PR #142 remains unmerged pending a
separately reviewed validation decision.
