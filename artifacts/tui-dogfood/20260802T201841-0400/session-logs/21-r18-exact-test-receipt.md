# R18 exact test-outcome receipt

Date: 2026-08-04

Tracking issue: #105

Candidate code commit: `5a299c3e21fbb7d4d3a1f23a0cb1f04141eaad6c`

External repository: `pallets/click` at `edda51f303625daa6084cd53490bbcf6c274bef5`

## Finding and boundary

R17 directly reproduced DF-024 with the exact installed npm carrier. The production Warden
returned a complete exit-zero bash envelope whose final pytest line was:

`1901 passed, 24 skipped, 31000 deselected, 1 xfailed in 2.75s`

The settled terminal card instead selected pytest progress rows, so the user had to leave the
one-screen completion state to recover the exact outcome. R18 is deliberately narrower than a new
completion protocol: it recognizes pytest's strict quiet terminal-summary grammar only after the
existing Warden envelope is complete, then lets the existing factual `ran` receipt present it.
Model prose, command names, and incomplete output are not evidence.

No Warden verdict, policy, grant, sandbox, egress, audit, RPC/shared schema, public CLI, provider,
or model-visible tool result changes. Ordinary bash remains `ran`, never `checked` or `verified`,
under ADR-0079. No ADR is needed because the change is kernel-internal presentation using existing
controller facts.

## Red-first record

1. Parser tests for the exact quiet pytest line and supported count categories failed **13/28**
   because the presentation recognizer did not exist.
2. View-model regressions for the complete live and resumed Warden envelope failed **2/189**: the
   selected output remained progress dots.
3. The signal adversarial regression failed because a parsed pass line was initially allowed to
   display `PASS` after a signal.
4. Five-lens adversarial review added leading-zero and contradictory exit-zero/failure-count cases.
   They failed **2/222**: a leading-zero count produced a fabricated summary and a contradictory
   envelope retained a green presentation state.
5. After the conservative status fix, one final regression stayed red because the contradictory
   failure card duplicated the test line as raw stdout. The retained implementation suppresses
   that duplicate while retaining stderr diagnostics.

No test was weakened, skipped, quarantined, or snapshot-updated blindly.

## Retained implementation

- `packages/kernel/src/tools/test-summary.ts` adds a strict, full-line quiet-pytest recognizer for
  positive safe-integer counts and the producer categories `failed`, `passed`, `skipped`,
  `deselected`, `xfailed`, `xpassed`, `warning(s)`, and `error(s)`.
- Unknown categories, malformed separators/durations, duplicate canonical categories, zero or
  leading-zero counts, unsafe integers, prose, `no tests ran`, and control-sequence contamination
  fall back to the existing output presentation.
- The existing model-facing `summarizeTestOutput` behavior is unchanged. A separate structured
  presentation analysis returns the exact line plus whether recognized failures/errors exist.
- `packages/kernel/src/tui/view-model.ts` consumes that analysis only for complete parsed Warden
  bash envelopes. Exit, signal, typed failed/limited/partial outcomes, warnings, containment, and
  stderr retain precedence.
- A contradictory exit-zero envelope containing `failed` or `error` counts is classified
  `needs attention` and displays `TEST SUMMARY (pytest): FAIL`; it cannot become a false success.
- Live and resumed rendering use the same reconciliation path, and the final receipt remains the
  existing `what ran` surface.

## Local verification

Focused retained behavior:

- test-summary parser: **30/30**;
- conversation receipt: **93/93**;
- headless TUI: **151/151**;
- view model: **192/192**;
- real Ink renderer: **171/171**;
- focused total: **637/637**.

Repository gates:

- `corepack pnpm typecheck` — pass;
- `corepack pnpm lint` — pass;
- `corepack pnpm format` — pass before evidence update;
- `corepack pnpm supply-chain:check` — pass across 7 manifests and 263 installed packages;
- `corepack pnpm build` — pass for all 6 packages;
- `corepack pnpm package` — pass for npm and all four Bun carriers;
- isolated `corepack pnpm test:cov` — **362 files passed, 4 skipped; 6,584 tests passed,
  20 skipped; 0 failed**; repository coverage was 97.99% statements/lines, 93.74% branches, and
  99.58% functions;
- changed `test-summary.ts` coverage: 100% statements/functions/lines and 92.85% branches;
- changed `view-model.ts` coverage: 97.68% statements/lines, 93.64% branches, 100% functions.

The first full-coverage attempt was **not green**: it ran concurrently with static gates and was
killed with exit 137 by local resource pressure before producing a test assertion result. The same
command was rerun alone and passed with the exact results above. This orchestration failure is
retained rather than reported as a passing attempt.

## Exact carrier and installed-terminal evidence

The candidate was committed before the final package build. `package-metadata.json` records exact
commit `5a299c3e21fbb7d4d3a1f23a0cb1f04141eaad6c` with `dirty: false`. The scripts-disabled npm
tarball installed 57 packages into an isolated prefix and has SHA-256
`e303abb86a41b29cb23c90a63e4478a5fa544bbc1096057d2da1b16fdee8b177`.

The clean external Click checkout ran the same command through the exact installed baseline and
candidate carriers, a spawned production Warden, real PTY, and loopback OpenAI-compatible fixture.
All four accepted runs exited zero, showed governed sandbox/egress posture, returned to the normal
idle composer, used only `ran` wording, and tore down the fixture/process group cleanly.

| Carrier | Terminal | Exact summary visible | Progress dots selected | Transcript SHA-256 | Frame SHA-256 |
| --- | --- | --- | --- | --- | --- |
| baseline | 80x24 | no | yes | `6ae56add754eccb0fbd1a626f79003270796365c74da84bb473d1be65962c160` | `d7e34697f67015f6ae4ac65c81b37d3003c98bdad8266a8c41f095b3d42ca792` |
| candidate | 80x24 | yes | no | `daf154d7596f2f034aa715e0bf03c8e0f7d33a2a2b2b1f5df95c8abc523a460c` | `4525000d6154787a0556ce26cb04121a4a1beb09890c5f21f3c3f069837ba0aa` |
| baseline | 100x30 | no | yes | `e260640752f2e1fa7c35e6b61f164e7964391d791c18b09e3ef53e9845b32b4c` | `1979044169bdb68acb71b2e0dd6e69bfb68f4782185178505c2e5df4e2286585` |
| candidate | 100x30 | yes | no | `987dbb3b6de5ffece6d12014c503ebe277d9d37973bdfa4229bfff766095c68a` | `da41e5e4362269678f61917f872d06bfd3a92402d4b96438103069c46c1d448f` |

Screenshots 46-49 are sanitized 1400x840 transcriptions of those accepted frames. The first render
used oversized artifact typography and clipped the 100-column candidate line; that artifact-only
attempt was rejected and regenerated. The retained four images were visually inspected: both
baselines show progress dots, both candidates show the full PASS/count line, and no credential,
username, user-home path, or private run path is visible.

## Five-lens synthesis

- **Spec compliance — pass:** the change improves final controller-fact visibility under
  `MASTER_SPEC.md` section 4.9.4 and preserves ADR-0079's `ran` versus verified boundary.
- **Security/adversarial — pass:** only complete parsed Warden envelopes are eligible; producer
  grammar is strict; malformed, duplicate, unsafe, controlled, signal, typed-outcome, and
  contradictory cases fail closed. Execution and policy authority are untouched.
- **Reliability/edge cases — pass:** live/resume parity, nonzero/signal/failure precedence,
  containment/warning retention, unrecognized fallback, raw authoritative output, and
  receipt-deduplication are covered.
- **DX/usability — pass:** at 80x24 and 100x30 the decisive counts replace low-value progress dots
  without a second panel or a false verification label. The composer and governed footer remain.
- **Simplicity/maintainability — pass:** one pure recognizer, one structured analysis helper, and
  the existing envelope/receipt path are sufficient; no dependency, schema, or alternate summary
  authority was added.

There is no unresolved local must-fix. This exact checkpoint's final-confidence score improves from
2 to 4, but the official six-workflow aggregate is held at **4.01/5** until a canonical same-commit
workflow replay supports changing one of its frozen rows. The legacy pooled diagnostic stays
**3.98/5** (247/62). E5 is **NOT_RUN** because the behavior is deterministic controller
presentation and the production provider boundary was exercised by the loopback fixture. Anthropic
spend remains USD 2.74434625.
