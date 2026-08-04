# Controller-enforced final-answer contract

Date: 2026-08-04

Public work items:

- defect and implementation issue [#113](https://github.com/keel-harness/keel/issues/113);
- accepted design [ADR-0087](../../../../docs/adr/0087-controller-enforced-final-answer-contracts.md);
- design-acceptance [PR #120](https://github.com/keel-harness/keel/pull/120).

## Decision and scope

The owner accepted ADR-0087 and authorized #113 exactly as scoped by merged PR #120. The retained
candidate makes one explicit, task-scoped final-answer bound enforceable by the controller. It does
not apply a global style heuristic, silently truncate prose, repeat tools, or reinterpret model,
Warden, test, or audit truth.

The contract accepts 40 through 2,000 words. It may be armed for the next ordinary interactive task
with `/answer N`, cleared with `/answer clear`, or applied to one headless run with
`--final-max-words N`. A compliant original is primary without another request. An overlong original
is retained but hidden from primary output, and Keel makes at most one tools-disabled rewrite with a
derived byte rail, smaller output cap, and cumulative task budget. Length, error, cancellation,
budget, enforcement-loss, empty, or tool-call terminals settle to deterministic honest fallback
copy. `/answer full` and `keel sessions answer <id> --original` provide explicit redacted inspection.

The implementation persists typed original/rewrite attempt metadata, settlement identity/outcome,
and rewrite usage so crash-prefix replay and completed-session resume do not duplicate, rerun, or
promote the retained original. It changes no Warden verdict, policy, sandbox, egress, grant, audit
schema, frozen ModelPort/RPC interface, dependency, or security claim.

## Red-first and implementation evidence

- Contract, loop, durable-event, recorder, resume, CLI, headless, real-Ink, presentation, palette,
  geometry, cancellation, budget, provider-error, provider-length, attempted-tool-call, forged-text,
  terminal-review, known-red, and crash-prefix cases were added before their production paths.
- A focused final-answer/TUI set passed **19 files / 925 tests** during implementation.
- The first exact 80x24 carrier replay exposed an additional P1: the generic panel viewport counted
  an overlong single logical line as taller than its body, so no offset could render that line.
  `/answer full` showed only its title and overflow disclosure. A production-shaped real-Ink
  regression failed before the viewport began grapheme-safe physical-row wrapping.
- The retained panel correction makes navigation offsets physical rows, preserves the title/body
  budget, and keeps all read-only panels inspectable. Focused post-fix Ink/geometry coverage passes
  **3 files / 244 tests**.
- Repository-wide `pnpm test:cov` passes **365 files / 6,665 tests**, with **20 intentional opt-in
  real/integration skips**. Enforced aggregate coverage remains **97.85% statements/lines, 93.63%
  branches, and 99.59% functions**.
- `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm package`, and `git diff --check` pass.

## Exact installed carrier

The clean npm carrier records commit `b1c5f7021b144828430c35aee59500c07f2d0b14`, version `0.1.1`,
and `dirty: false`. Its scripts-disabled tarball SHA-256 is
`75c7d366d0ddae96e4d3e1b267d11a6f6b59236b7abc4eec51d06bc39786274c`; the isolated install contains
57 packages.

Headless exact-carrier cases all preserve the 568-word original outside primary output:

| Case | Exit | Provider attempts | Tool results | Settlement |
| --- | ---: | ---: | ---: | --- |
| accepted rewrite | 0 | 2 | 0 | `accepted-rewrite`; 66-word primary |
| rewrite length | 1 | 2 | 0 | `fallback-length` |
| rewrite provider error | 1 | 2 | 0 | `fallback-error` |
| rewrite emits `read` call | 1 | 2 | 1 skipped | `fallback-tool-call`; call not executed |

The explicit original-inspection command returns the retained redacted original. Completed-session
inspection reports five messages and the expected settlement without changing the primary result.

## Real PTY and controller controls

The exact installed carrier ran against a loopback-only OpenAI-compatible fixture and a spawned
production Warden in the clean external Click checkout. The ordinary request advertised five
tools; the rewrite request advertised zero. Both geometries exited cleanly, displayed the rewrite
state, rendered one bounded primary answer, returned to the idle composer, opened the retained
original at its first physical row, scrolled by physical row, and reaped the process group.

| Geometry | Requests | Exit | Settled transcript SHA-256 | Completion / full / scrolled frame SHA-256 |
| --- | ---: | ---: | --- | --- |
| 80x24 | 2 | 0 | `642a9a204d8db5c19fbc9be6fc146f0def4e604c40dfbb287749edbb33a419e6` | `9da92263` / `539bebb4` / `1f2c7b72` |
| 100x30 | 2 | 0 | `d40f3a5d2f98e3174c0dc7fcebf18116e4193f943c5500f48cfc7add81752e8d` | `12b195f4` / `f6717bb1` / `2f75fd6e` |

Additional exact-carrier controls pass:

- held-candidate Escape at 80x24 and 100x30 makes one ordinary provider request, exposes no held
  bytes, executes no rewrite tool or side effect, returns to input, records `fallback-cancelled`,
  and truthfully exits 1 for the needs-attention turn;
- completed-session 80x24 resume shows the bounded primary once, hides the retained original, makes
  **zero provider requests**, and exits 0;
- default interactive trust decline persists one untrusted decision, reaches governed idle with
  **zero provider requests**, and writes only session metadata with no project-context or safety-
  snapshot field;
- missing Anthropic credential exits 1 with exact `keel auth set anthropic` recovery and creates
  **zero session or audit files**;
- the existing exact-installed Warden symlink/outside-write smoke passes: typed and Bash canaries
  remain absent, both denials are attributable, Bash remains `POL-002`, no review route appears,
  and the process group is reaped.

## Live Anthropic result

One read-only unfamiliar-repository onboarding run used the exact installed candidate, frozen Click,
and `anthropic/claude-sonnet-4-6`. It exited zero, kept Click clean, made **18 provider requests** and
32 tool results (22 read, 9 search, and 1 shell inventory), requested **zero Warden reviews**, and
settled `accepted-rewrite`.

The original was 1,273 words. The primary rewrite was 241 words, within the 250-word contract, and
its SHA-256 is `58580432eada7e4e8e6f1543eb54c25319bed7f53691d9e97f69d81ae3ec9091`. It names architecture,
documented test/build commands, likely implementation seams, a focused plan, and explicitly marks
the runtime behavior it did not probe as unverified. The original remains available only through
the explicit inspection path.

Ledger usage is 777,375 total input tokens, decomposed as 214,531 fresh, 112,387 five-minute cache
write, and 450,457 cache read, plus 6,058 output. At the checked global Sonnet 4.6 rates, exact cost
is **USD 1.29105135**. Cumulative dogfood spend is **USD 4.72508650**; USD 15.27491350 remains and
the final USD 2 reserve is intact. The credential was never read, copied, printed, logged,
committed, or captured.

## Screenshots

Screenshots 61-64 are sanitized, visually inspected 1400x840 transcriptions of exact 100x30 carrier
frames. The in-app browser was unavailable, so the established native Quick Look square-pad and
deterministic center-crop fallback rendered them; they are not claimed as live-window captures.

| Screenshot | Purpose | SHA-256 |
| --- | --- | --- |
| `61-final-answer-rewrite.png` | visible tools-disabled rewrite state | `5818e94862ab9fe10069e898fa19407ac918af4a18849bdcf8329fe0c6bb1739` |
| `62-final-answer-complete.png` | one bounded primary and idle composer | `772786f442492a0f15dede5a24820614f7859964f47c3610c47f923eaf115639` |
| `63-final-answer-inspection.png` | first retained physical row plus bounded overflow | `567a3708f11bbf824d8b197c3236b4d55f0470c7ac230a86aef88dba53609659` |
| `64-final-answer-cancelled.png` | honest cancellation with no rewrite side effect | `9174bc06f7339e78fe828ada5a9ce2cd27ea37588cee8abe0b378284dc172517` |

Text/source scans contain no API-key name or value, credential marker, username, user-home path, or
private run path.

## Score impact

The same onboarding task directly raises cognitive load from 3 to 4, trust from 3 to 4, and final
confidence from 2 to 4. Other axes remain unchanged. The onboarding mean becomes **4.11/5**. The
six-workflow unweighted mean becomes **4.04/5**, and the historical pooled-cell diagnostic becomes
**4.02/5 (249/62)**. This clears the 4.0 stretch checkpoint for the tested candidate; the strict
release gate still requires the final same-commit six-workflow replay and publication proof.

## Five-lens synthesis

- **Spec compliance — pass:** the explicit opt-in, one rewrite, bounded cost, durable inspection,
  deterministic fallback, and absent-contract byte-neutral rules match accepted ADR-0087 and #113.
- **Security/adversarial — pass:** tool schemas are structurally absent from rewrite requests,
  attempted calls are skipped, forged prose cannot activate the contract, retained bytes stay
  redacted and non-primary, and existing Warden denial behavior is unchanged.
- **Reliability/edge cases — pass:** accept, oversize, byte rail, length, error, cancellation,
  budget, enforcement loss, empty output, tool call, crash prefixes, terminal review, known-red,
  resume, inspection, narrow geometry, and overlong panel rows are covered.
- **DX/usability — pass:** objective and drafting remain visible, rewrite state is explicit, the
  primary result is concise, fallback copy says what/why/inspection, and the full original is
  reachable without duplicating it in normal history.
- **Simplicity/maintainability — pass:** one loop settlement state machine emits typed events;
  recorder and UI consume them. There is no second word heuristic, speculative tool rerun, or new
  dependency.

There is no unresolved local must-fix. Exact-head CI `30929433667` passed every executable PR lane;
DCO remained explicitly non-green and was covered by the owner's authorized admin squash rather
than a candidate-invalidating rewrite. PR #121 merged as `7c8ff68`; candidate and merge share tree
`99d8fda9`, issue #113 closed, and exact post-main CI `30929922987` passed every applicable lane.
Remote/local feature branches, the feature worktree, and six exact task-scoped temporary roots were
removed after sanitized evidence merged. Only the final same-commit six-workflow replay remains
open.
