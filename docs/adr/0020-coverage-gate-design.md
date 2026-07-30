# 0020 — Coverage gate design (per-file floor, per-package floors, measured property harness, seeded fast-check)

**Status:** accepted
**Date:** 2026-06-13

## Context

The Phase 0 hardening QC surfaced four related weaknesses in the coverage gate
(`vitest.config.ts`) — the mechanism the charter calls a *real, measured* gate
rather than an asserted one. The gate must structurally enforce, not merely claim,
the coverage floor.

**Finding C4 — the aggregate hides a 0%-covered file.** `coverage.thresholds`
used only global aggregate floors (`lines/functions/branches/statements: 90`).
v8 aggregates across every included file, so a brand-new file with **0% coverage**
passes the gate as long as the rest of the tree compensates — exactly the "shape
exists, feature untested" failure the charter forbids. Demonstrated: a throwaway
`packages/eval/src/_covhole.ts` (an unused, untested function) left the gate
**green** under the aggregate config despite contributing 0% on all four metrics.

**Finding I9 — the property/wire-round-trip harness was unmeasured.**
`coverage.exclude` carried a blanket `packages/*/src/testing/**`, which silently
ungated `packages/shared/src/testing/property.ts` — the very harness that proves
the wire-round-trip and parse-idempotency invariants for every schema. A test
harness with untested container-walk branches is a broken window: a bug in
`collectRegexStrings` would weaken *every* property test without any signal.

**Finding I6 — property-test failures were not replayable.** fast-check seeds
were unpinned, so a CI property failure could not be reproduced locally — the
audit/debug narrative was non-deterministic.

**Measured P0 — a property test exceeded the default test timeout.**
`packages/shared/src/simulator/script.test.ts`'s `assertRoundTrips(SimulatorScript)`
(a recursive schema whose `args` field is `JsonObject`, generated via unbounded
`fc.jsonValue()`, 200 runs) measured **5296ms** under v8 coverage instrumentation —
over vitest's 5000ms default `testTimeout`. That is a real CI failure, and a flaky
test is a P0 bug, never quarantined.

## Options

1. **`perFile: true` + keep the global floor (C4).** Every included file must
   individually clear the floor; the aggregate can no longer mask a 0% file.
   Per-package floors (MASTER_SPEC §6.1) are added as glob-keyed thresholds.
2. **Raise the global aggregate floor (e.g. to 99%).** Rejected — a high aggregate
   still mathematically permits a single 0% file if the tree is large enough; it
   raises the bar without closing the structural hole, and it churns on every minor
   coverage shift.
3. **Bespoke post-run script asserting per-file coverage from the lcov report.**
   Rejected — reinvents a feature vitest/v8 already provides (`perFile`), adding a
   custom parser to maintain for no gain (YAGNI; standards over bespoke).

For the harness defensive-branch problem, two sub-options:

A. **DRY-extract the defensive ternary into a tested helper** (`errorMessage`).
B. **`/* v8 ignore */` the defensive branch.** Rejected for this case — the branch
   is genuinely *coverable* (a non-`Error` throw), so ignoring it would hide a real,
   testable path. The sanctioned ignore is reserved for genuinely-*unreachable* code.

## Decision

**Option 1 + DRY helper.** Concretely:

- **Global floor + `perFile: true` (C4).** `coverage.thresholds` keeps the global
  `lines/functions/branches/statements: 90` baseline AND sets `perFile: true`, so
  every currently-included source file must clear 90 on each metric individually.
  Re-running the `_covhole.ts` probe under this config turned the gate **red**
  (`Coverage for lines (0%) does not meet global threshold (90%) for …/_covhole.ts`),
  proving the hole is closed; the probe was then deleted.

- **Per-package floors (MASTER_SPEC §6.1), commented until activation.** Glob-keyed
  thresholds for the higher-bar packages are written into the config but **commented
  out**, because `warden`/`kernel`/`memory` are still in `coverage.exclude` with no
  real code (only `export {}` placeholders). They are uncommented **at the same time**
  as removing the package from `exclude`, when it gains tested source:
  - `"packages/warden/src/**": { lines: 95, functions: 95, statements: 95, branches: 90 }`
  - `"packages/kernel/src/**": { lines: 85, functions: 85, statements: 85, branches: 85 }`
  - `"packages/memory/src/**": { lines: 90, functions: 90, statements: 90, branches: 90 }`

- **Measure the property harness (I9).** `coverage.exclude` drops the blanket
  `packages/*/src/testing/**` and becomes
  `["**/*.test.ts", "packages/kernel/src/**", "packages/warden/src/**", "packages/memory/src/**"]`.
  This makes `packages/shared/src/testing/property.ts` **measured** (now 100% lines /
  96.92% branch — above floor; its container-walk branches for ZodObject/Array/
  Optional/Nullable/Default/Union/DiscriminatedUnion/Record/Tuple/Effects/Branded/
  Pipeline/Lazy are exercised by `property.test.ts`, and `safe()`'s catch and
  String() fallback branches are now covered). `packages/simulator/src/testing/drain.ts`
  is measured too and was already **100%** (used by many sim tests) — left measured,
  no exclude.

- **DRY `errorMessage(e)` helper (perFile follow-on).** `perFile: true` exposed two
  files just under the branch floor — `loader.ts` (88.88%) and `matcher.ts` (87.5%) —
  each carrying the same defensive `e instanceof Error ? e.message : String(e)`
  ternary whose `: String(e)` arm is hard to drive (JS engines throw only
  `SyntaxError extends Error` from `new RegExp`). Rather than ignore the branch in
  two places, the ternary is DRY-extracted to `errorMessage(e)` in
  `packages/simulator/src/errors.ts` and covered **once** by `errors.test.ts`
  (`errorMessage(new Error("x")) === "x"` and `errorMessage("plain") === "plain"` —
  both branches). loader.ts and matcher.ts now reach 100% branch.

- **Single sanctioned `/* v8 ignore */` policy.** A scoped
  `/* v8 ignore next -- <reason> */` is allowed **only** on a single line of
  documented-*unreachable* defense-in-depth code, with a justifying comment — never
  to paper over a coverable path or to relax the gate. As of this ADR none is in
  use: the once-cited candidate (`packages/eval/src/store.ts`'s post-mkdir realpath
  TOCTOU backstop, lines 101-104) sits at 93.75% lines per-file, comfortably above
  the 90 floor, so it needs no ignore. The two remaining uncovered partial branches
  in `property.ts` (the `?? []` nullish guard on a ZodString's internal `_def.checks`,
  and the `isNegZero` early-return in `containsNegZero`) are likewise above floor and
  are left as honest measured-but-uncovered branches rather than ignored.

- **Pinned fast-check seed + numRuns (I6).** `vitest.setup.ts` (wired via
  `test.setupFiles`) calls `fc.configureGlobal({ seed, numRuns: 200 })` with a fixed
  default seed (`424242`), overridable via `process.env.FAST_CHECK_SEED`. This makes
  a CI property failure replayable locally by exporting the reported seed, and lets a
  scheduled fuzz job rotate the seed deliberately. `numRuns: 200` mirrors the
  `assertRoundTrips`/`assertWireRoundTrips` default. A test in `property.test.ts`
  asserts `fc.readConfigureGlobal().seed` is a finite number, proving the seed is wired.

- **Property-test timeout headroom + bounded JSON depth (P0).** `test.testTimeout`
  is raised to **20000ms**: property tests generate hundreds of values per run and,
  under v8 coverage instrumentation, the recursive-schema generators need headroom
  past vitest's 5s default. Independently, the JSON arbitraries in `property.ts`
  (`jsonValueArb`, `jsonObjectArb`) are bounded to `fc.jsonValue({ maxDepth: 3 })`.
  Depth-3 JSON still exercises real nesting and still catches the NaN/Infinity/
  undefined wire bugs the harness exists for, but cuts generation cost — and unlike
  the seed (which only fixes *this* run's duration), the depth bound keeps the cost
  bounded under `FAST_CHECK_SEED` rotation. `script.test.ts` dropped from a measured
  5296ms (timeout) to ~2.1s under coverage across three consecutive runs.

## Consequences

- A new source file is coverage-gated *individually* by default — adding one with
  no test now fails the gate immediately (C4 closed), structurally, not by reviewer
  vigilance. The global floor was **not lowered** to achieve this.
- The property harness is held to the same per-file floor as the code it tests; a
  regression in `collectRegexStrings`/`assertWireRoundTrips` now shows up in coverage.
- When `warden`/`kernel`/`memory` gain real code, the activation step is mechanical
  and documented: uncomment the matching per-package threshold block and remove the
  package from `exclude` together.
- Property-test failures are reproducible (pinned seed) and no longer flaky on time
  (20s timeout + bounded depth). Rotating `FAST_CHECK_SEED` (e.g. a scheduled fuzz)
  stays within the timeout because depth — not seed luck — bounds generation cost.
- The `errorMessage` helper is the single tested home for the catch-normalisation
  branch; future try/catch sites reuse it rather than re-introducing the
  hard-to-cover ternary.
