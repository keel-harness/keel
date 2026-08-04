# R21 unfamiliar-repository onboarding orientation

Date: 2026-08-04

Validation issue: #111

Rejected prompt-only behavior issue: #112

Enforceable follow-up design: #113

Exact main commit: `8d451d6344ddfb971c1b1a18478f6e53e56e4bfb`

External frozen Click commit: `00e592cea702e0b2caa0dee42489fdb1c22cd845`

## Decision

R21 reproduces a material live-provider onboarding defect but does not retain a product change. The
exact main carrier is strong at startup, persistent objective/progress, grouped typed-tool evidence,
trust refusal, missing-credential recovery, missing-test honesty, and zero-call resume. Its live
Anthropic final answer is not trustworthy enough: it is 822 words despite the explicit concise
request, uses twelve shell `find`/`grep` inventory calls instead of typed search, includes code blocks
and tables, performs no runtime probe, and falsely claims that `pathlib.Path` is iterable and yields
path parts.

Two red-first prompt-only candidates materially improve tool selection, ending at zero bash and
nineteen typed read/search calls. Neither enforces the final-answer or runtime-verification contract.
The strongest candidate still emits 568 words plus a table and runs no probe. Per #112's stop
boundary, both candidates are rejected; no PR, merge, score credit, or prompt change is retained.
Issue #113 owns a separately approved controller/output design. Adding a third prompt paragraph is
not treated as structural enforcement.

## Exact main carrier

- Canonical `main`, `origin/main`, and the live remote matched at
  `8d451d6344ddfb971c1b1a18478f6e53e56e4bfb` before the slice.
- All packages built and the four Bun carriers plus npm carrier packaged from a clean checkout.
- `build/npx/package.json` recorded exact commit `8d451d6` and `dirty: false`.
- The scripts-disabled npm tarball SHA-256 is
  `83aa740cf7b6e5ae858d2d182f13a4d2f1d25d68d4be50fbb6a470bfc557fbd9`.
- The exact isolated launcher reported `keel 0.1.1`; its run root was mode 0700.
- The first restricted dependency install was not green because DNS was unavailable. The approved
  retry installed 57 packages with scripts disabled.
- A task-scoped credential-store copy was mode 0600. Its value was never read, printed, logged,
  committed, or captured.

## Deterministic onboarding matrix

Both sessions launched the exact installed main carrier through a spawned production Warden in the
clean frozen Click worktree. The loopback fixture made eight real typed read/search requests plus a
final response. Every accepted run showed governed posture, persistent objective/activity,
controller-owned evidence, the idle composer, zero reviews, clean Click, and complete process-group
teardown.

| Geometry | Requests | Exit | Transcript SHA-256 | Startup / active / completion frame SHA-256 |
| --- | ---: | ---: | --- | --- |
| 80x24 | 9 | 0 | `f588aeb2a46d46fd32ebfe9cd55cc127e48d8676dafb4926c191cffd4b2ed7f4` | `8d060dac` / `673f0497` / `ac1be702` |
| 100x30 | 9 | 0 | `920364c1474efeb316f47278bf507d7cee9ea9211b58e954f9e4cbe1564b6596` | `f054860e` / `a13c320e` / `7038c1f2` |

The first 80x24 attempt was rejected because the driver required `2 lines hidden`; the valid narrow
composer reported `3 lines hidden · 7 total · 544 chars`. The retained width-neutral oracle requires
only the exact character count and preserves every substantive product assertion.

## Live main result

The bounded `anthropic/claude-sonnet-4-6` session used the exact main carrier at 100x30, exited zero,
kept Click clean, requested zero Warden reviews, recorded 18 logical tool results and 30 audit
`tool.execute` records, and reaped its process group. It satisfied the six orientation headings:
architecture, build/test, relevant files, compatibility risks, plan, and next action.

It nevertheless failed the user outcome:

- **822 words**, code blocks, and tables despite “Keep the final answer concise”;
- **12 bash + 6 read + 0 typed search**; all twelve bash commands were shell `find`/`grep`
  discovery;
- **0 runtime probes**;
- claimed a bare `pathlib.Path` is `Iterable[str]` and yields path parts;
- a direct read-only Python probe returned `hasattr(Path("a/b"), "__iter__") == False` and
  `list(Path("a/b"))` raised `TypeError`.

Provider usage: 99,217 input, 42,012 cache read, 15,439 cache write, and 3,455 output tokens. Fresh
input was 41,766 tokens. Exact estimated cost: **USD 0.24762285**.

Controller session SHA-256:
`e7b7fe771e5ef32eab514ebae987443daec2be910a14054e0b5aea07d08c4363`.
Final-answer SHA-256:
`cb5f8b704ec6881b73d7c8908099d7646e995dec6bf0dba6baafa52b7dac56bf`.

## Rejected prompt-only candidates

### Candidate 1 · `aea89f1`

The first red run had 3 intended failures and 25 passes. The first green added the existing typed
discovery, runtime-claim, and bounded-orientation clauses. Focused 28/28, broader context/provider/
loop 464/464, typecheck, lint, format, and build passed. The exact deterministic carrier remained
byte-identical to main.

Live tool selection improved to 2 bash + 9 read + 7 search, and the final diagnosis became correct.
It still made two shell `find` inventories, ran no runtime probe, and emitted 687 words with code
blocks and tables. Provider usage was 97,658 input, 44,710 cache read, 15,042 cache write, and 3,083
output; cost **USD 0.22978350**. The initial repository-architecture predicate incorrectly required
one specific manifest filename and was rejected as an oracle error; manual orientation coverage was
complete, but the material acceptance failures remained.

### Candidate 2 · `263f511`

The strengthened red again had 3 intended failures and 25 passes. It explicitly prohibited shell
`find`/`grep`, distinguished source reading from runtime verification, and required at most 250 words
with no code block/table unless requested. Retained focused coverage passed 28/28. The broader set
passed 44 files with one existing skip, 828 tests with one existing skip. Typecheck, lint, format,
build, and diff checks passed; the prompt estimate was 1,683 tokens under the 2,000-token gate.

The exact clean npm carrier recorded `263f5112152137f0e3c67a4ac88f10e64a80ef2a`, `dirty: false`,
and SHA-256 `a03aa7665d90a56f615b197a5c6b5184b5c75ecb5a49eec2560ebf6dbc65c33b`.
Its deterministic 100x30 transcript and all three frame hashes were byte-identical to main.

The live run improved further to 0 bash + 10 read + 9 search. It exited zero, kept Click clean,
requested zero reviews, and correctly self-corrected to `Path` not being iterable. It still returned
568 words and a Markdown table and ran zero runtime probes. The original automated phrase predicate
marked the correct `not directly iterable` wording false; that predicate was corrected without
changing the decisive no-probe/concision failures. Usage was 103,970 input, 55,421 cache read,
12,939 cache write, and 2,687 output; cost **USD 0.21228255**.

Issue #112 was closed as not planned with the full evidence. Its clean local branch/worktree were
removed. No remote branch or PR was created.

## Negative and recovery controls

| Control | Geometry | Result | Authoritative evidence |
| --- | --- | --- | --- |
| no discovered test command | 100x30 | PASS | 4 loopback calls; final explicitly says no test directory/dependency/config/command, no test ran, no exact build command was documented; worktree clean; transcript `86b6e1fb…` |
| workspace trust declined | 100x30 | PASS | governed sandbox/egress ready; workspace untrusted; 0 environment/project-context events, 0 snapshot files, 0 tool audit records; transcript `b0616a15…` |
| credential absent | non-TTY preflight | PASS | exit 1; exact `keel auth set anthropic` recovery; 0 provider calls, sessions, audits, or snapshots |
| resume completed onboarding | 80x24 | PASS | resumed 21 messages; controller ledger unchanged; only new `session.start` + `checkpoint` audit lifecycle; 0 provider calls; governed `sbx:on`/`net:on`; transcript `d345c310…` |

Three no-tests calibrations were rejected: one same-redraw completion assumption, one transient
active-state ordering assumption, and one overly literal `not documented` phrase predicate. A
restricted resume sample was also rejected because the outer managed sandbox forced `sbx:off` and
`net:off`; the retained approved production-path rerun requires and shows both guards on. None is
counted as product green or hidden.

## Screenshots

Seven sanitized exact-text terminal transcriptions were rendered at 1400x840 and visually inspected
at original resolution:

| Screenshot | SHA-256 |
| --- | --- |
| `52-r21-startup.png` | `ee542aab630cad3454f32e758b22d2f055d10359d5a7b7e7d6973744164493c7` |
| `53-r21-active-onboarding.png` | `9e21262031a2045662ed2b12345d072a76cddccc897da3a044ad5e7bf26dbf9f` |
| `54-r21-live-baseline-defect.png` | `dba06b7fd2b57a46231dd257bff84b55a1a264d7e324a319bdd798f512d8293f` |
| `55-r21-live-candidate-rejected.png` | `25ff804e679f97cde461d67f80a619fa3960fa00128a326e7e1294789dde903e` |
| `56-r21-untrusted-workspace.png` | `28cf861f1019c4acca449994dd34619f62ca0f04d307e2c405d0057c9dc4adfb` |
| `57-r21-no-tests-resume.png` | `392c9ba71e84e5d70baec6073ed52c58567be7bd58c2594226011918502cd15d` |
| `58-r21-auth-failure.png` | `6fcb301097f1e7df8b84cdc81a40024ce0989659db7558a29785e9e660683e4f` |

The in-app browser was unavailable. The retained images use the same native Quick Look square-pad
plus deterministic center-crop fallback as prior accepted slices. No credential, token, username,
user-home path, private run path, or environment value is visible.

## Local regression evidence

- Artifact consistency passes **1 file / 21 tests**.
- The first unchanged seven-suite TUI run was **NOT GREEN**: six suites failed collection because
  the isolated documentation worktree lacked package-local dependency resolution; the system-prompt
  suite alone passed 25 tests.
- A second run after linking the canonical kernel install was also **NOT GREEN**: **787 passed / 32
  failed**, plus seven unhandled errors, because the spawned Warden lacked its package-local
  workspace resolution. This was a validation-setup failure, not a source edit or product failure.
- With both ignored task-local dependency links in place, `session-entry.test.ts` passed **128/128**
  and the full unchanged set passed **7 files / 819 tests**: system prompt, session entry, view model,
  REPL, headless, conversation block, and real-Ink app.
- Repository formatting and `git diff --check` pass after reconciliation. The task-local links are
  excluded from the commit and removed before publication.

## Score impact

The current main onboarding row is now directly scored **3.67/5** across its nine applicable axes:
clarity 4, responsiveness 4, progress 4, control 4, recovery 5, hierarchy 4, cognitive load 3,
trust 3, and final confidence 2. Cognitive load falls from 4 to 3 because the canonical live answer
is 822 words plus code/tables and twelve shell inventory calls. Trust falls from 4 to 3 because the
final answer states a false runtime property without a probe. Final confidence remains 2.

This evidence correction changes the six-workflow unweighted mean from 4.01 to **3.97/5**. The
historical pooled-cell diagnostic changes from 247/62 (3.98) to **245/62 (3.95)**. The 3.8 release
target remains met; the 4.0 stretch target and strict same-commit final gate are not green. The
rejected candidate earns no score credit.

## Cost and evidence boundary

- E2: focused prompt tests and broader context/provider/loop gates were run on rejected candidates;
  unchanged product coverage is separately represented by the exact installed controls.
- E3: exact installed main, spawned production Warden, frozen Click, 80x24/100x30 positive,
  no-tests, trust-decline, credential, and resume paths.
- E4: screenshots 52-58 plus exact raw transcript/controller/frame hashes.
- E5: three bounded live Anthropic sessions (main plus two rejected prompt candidates), 58 provider
  turns total, exact incremental cost **USD 0.68968890**.

Cumulative spend is **USD 3.43403515**. USD 16.56596485 remains; the final USD 2 reserve is intact.

## Five-lens synthesis

- **Spec compliance — partial:** startup, objective, progress, trust, missing-test, auth, and resume
  behavior match the existing contracts. The explicit concise/factual final-result outcome fails.
- **Security/adversarial — pass for retained main:** no pre-trust project context or snapshot, no
  review, mutation, dependency install, or network tool action, clean external worktrees, and no
  credential disclosure. Rejected prompt changes did not alter enforcement.
- **Reliability/edges — pass with rejected oracles disclosed:** two terminal sizes, clean teardown,
  missing tests, declined trust, missing credential, resume, exact carrier provenance, and
  deterministic/live separation are covered.
- **DX/usability — must-fix remains:** orientation headings and progress are strong, but the live
  final answer is too long and factually wrong. Advanced users cannot treat it as a confident plan.
- **Simplicity/maintainability — pass on decision:** two small prompt iterations were tested and
  discarded when evidence showed the abstraction lacks authority. Issue #113 requires a reviewed
  controller design rather than speculative prompt accumulation.

No Warden policy, review/grant, sandbox, egress, audit, RPC/shared schema, dependency, public CLI,
or security claim changes. No ADR was needed for this validation/rejection. An ADR may be required
before #113 implementation depending on its selected public-output and transcript-retention design.
