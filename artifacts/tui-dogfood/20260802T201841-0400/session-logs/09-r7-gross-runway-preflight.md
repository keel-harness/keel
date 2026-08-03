# R7 gross-token runway preflight

Date: 2026-08-03

Public plan: [issue #70](https://github.com/keel-harness/keel/issues/70)

Keel baseline: `dc662531476c4b08752d0c0b037715ad46b6c5ab`

External workload: public `pallets/click` at local-only commit `edda51f`

Terminal: real PTY, 100 columns x 30 rows

## Diagnosis and scope

The observed `token_hard` event was not proof that the compactor ran after the provider request. The
existing loop invokes optional compaction at the safe pre-request boundary, but compaction can shrink
only the next active request; it cannot reclaim cumulative gross spend. R7 therefore adds two
separate controls: a visible cumulative gross-runway warning and a post-compaction fit preflight that
stops before `model.stream` when the estimated input alone consumes the remaining gross cap.

Effective-cost budget, cumulative gross-token runway, and context-window pressure remain distinct.
Compaction stays default-off. No Warden decision, sandbox, policy, grant, shared frozen schema, audit
format, provider price, cap meaning, dependency, or public CLI syntax changed.

## Red-first sequence

1. The first test patch was accidentally applied to the primary checkout while the focused command
   ran in this isolated worktree. That run's 517 passing tests were a **control result, not red
   evidence**. The exact patch was moved to the worktree and reversed from the primary checkout;
   primary `main` was immediately verified clean. No user work was overwritten.
2. The corrected focused red failed for the intended missing behaviors across loop, event, string,
   recorder, pressure, TUI, and production wiring tests. A syntax typo in the new loop test was fixed
   before behavioral evidence was accepted; the valid loop red then contained three intended
   failures: no metric identity, no gross warning, and an extra provider call at the fit boundary.
3. The implementation passed the seven-file focused suite at **524/524**. Shared control-state and
   invalid-threshold adversarial cases were then added; the loop suite passed **170/170**.
4. A simulator-driven loop-to-recorder-to-reducer-to-headless-to-ledger walking skeleton proves one
   successful tool receipt remains visible and durable while the second provider call is prevented.
5. Final five-lens review found a broad controller-notice prefix that could misclassify ordinary user
   prose beginning `Budget notice:`. Its adversarial regression failed **1 / 16 passed**, then passed
   **17/17** after matching was narrowed to exact legacy/new controller prefixes.

No existing test was weakened, skipped, removed, or reclassified.

## Product replay

- A production-source interactive CLI run spawned the Warden in the isolated Click checkout and
  used a non-secret local OpenAI-compatible fixture through a real fixed 100x30 PTY.
- The first and only provider request asked for a governed read of the first 200 `CHANGES.md` lines
  and reported controlled synthetic usage. The read completed successfully and displayed
  `## Version 8.5.0`.
- Keel then displayed a distinct `48000 of 50000` cumulative gross warning. The exact next-request
  estimate was 5,538 tokens with 2,000 remaining, so Keel emitted the controller-owned stopped
  terminal before any second provider call.
- The fixture request counter was exactly **1** at the stop. `keel --continue` restored the original
  prompt, successful read receipt, and gross warning; a new instruction completed in one fresh run.
  The counter was then exactly **2**. The external Click worktree was not mutated.
- No human Warden interrupt occurred: the trusted bounded read remained governed and routine.

## Evidence boundary

- E2: targeted tests, simulator-driven end-to-end walking skeleton, full test suite, changed-file
  coverage, typecheck, lint, format, build, and diff check.
- E3: production source CLI, spawned Warden, external Click checkout, local fixture, and real 100x30
  PTY proving warning, no second call, saved evidence, and successful continuation.
- E4: `screenshots/25-r7-gross-runway-after.png` is a visually inspected 1400x840 sanitized
  terminal-frame transcription of exact PTY facts. The in-app browser was unavailable, so it is not
  claimed as a live window capture. SHA-256:
  `96e15ce2009e68791b786eb81ca23441922e911ac554b70319dbf2ae112fb703`.
- E5: **BLOCKED / zero usage**. Keel's configured Anthropic credential was present in its secret
  store, but the provider rejected the first bounded measurement request and one later controlled
  validity recheck as `API key is invalid`. The value was never read, printed, copied, logged, or
  captured. No Anthropic usage was reported, no further retry will be made until replacement, and
  cumulative spend remains USD 2.7109.

## Verification

- Focused behavior suite: **524/524 passed** before the added walking-skeleton case; final loop suite
  **170/170** and walking skeleton **4/4** passed.
- Restricted full suite: **6,473 passed / 20 existing skips**, with only six outer-sandbox localhost
  binds failing `listen EPERM`; this is partial/invalid, not green.
- Final unrestricted full suite: **6,481 passed / 20 existing opt-in skips**, 359 passing files and 4
  skipped files.
- Full local coverage executed all **6,479 / 20** tests. The command remains non-green on existing
  macOS per-file gaps in unrelated shared/Warden files. Every changed production file clears the
  kernel floor: loop 94.07% lines / 94.54% branches; view-model 97.48% / 93.43%; session-entry
  94.67% / 91.40%; pressure 100% / 98.59%; recorder 100% / 94.23%; events and strings 100%.
- Final candidate typecheck, format, build, lint, and `git diff --check` passed after artifact
  reconciliation. The final focused behavior/manifest suite passed **551/551**.

## Five-lens QC

- **Spec compliance:** implements issue #70's exact warning and post-compaction boundary; effective,
  gross, and context metrics stay separate; compaction remains opt-in.
- **Security/adversarial:** preflight makes no provider call, estimator copy is explicitly
  approximate, hard caps remain authoritative, warnings are one-shot across shared control state,
  and no controller text grants authority or changes Warden behavior.
- **Reliability/edges:** exact equal/one-token-fit boundaries, valid compaction shrink, invalid
  thresholds, resumed/shared state, durable recorder copy, and full-suite regression are covered.
- **DX/usability:** the human sees what budget is running out, why another call did not start, the
  successful evidence already obtained, and one exact continuation command; the outcome is
  `stopped`, not a failed test or false completion.
- **Simplicity/maintainability:** one additive kernel-local optional metric, two copy helpers, one
  threshold set, and one pre-stream guard; no dependency, new service, schema migration, or policy
  adapter.

No local five-lens must-fix remains. Publication and merge remain blocked only on the explicitly
required valid-credential E5 replay and then exact-head CI.
