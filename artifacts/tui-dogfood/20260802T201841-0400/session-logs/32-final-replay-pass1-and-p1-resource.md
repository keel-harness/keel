# Session 32 — final replay pass 1 and bounded P1 resource optimization

Date: 2026-08-04 through 2026-08-05.

## Exact-main replay pass 1

The exact scripts-disabled npm carrier at merged commit `4588bfa` ran from fresh private homes
against clean frozen Click workspaces at 100x30.

- Onboarding: mechanical PASS, human semantic PASS, exit 0, clean workspace, zero Warden reviews,
  11 provider requests, USD 0.38821650.
- Feature: mechanical PASS, human semantic FAIL, exit 0, unchanged workspace, zero human review
  prompts, ten provider requests, USD 0.65218245.

In the feature run, Warden correctly rejected a composite tooling probe as terminal `POL-003`,
offered no approval handle, and did not execute the original. The safe atomic correction
`python3 -m pytest --version` succeeded. Keel then disabled the remaining recovery tools; the model
listed intended work but performed no edit or feature test. Issue #139 records the P0. The raw PTY,
report, session, and audit files remain outside the repository; only sanitized outcomes are retained
here.

## P1-007 profile and #140

The exact installed-product protocol used 150 ordinary turns with a 12 KiB assistant payload per
turn. GC-normalized live heap was 61,998,278 bytes; Yoga's WebAssembly memory was the largest single
retained allocation at 16,777,216 bytes. Idle decay and type totals point to allocation/high-water
pressure, not one retained transcript.

Historical comparison localized one avoidable full resume-presentation projection for ordinary
turns with five empty typed collections. Six focused tests failed before implementation. The
retained pure helper skips only that empty projection and preserves all existing evidence whenever
any collection is nonempty.

Exact result hashes:

- candidate B1: `f0b887b8d8c22ff59a4a6da0569baa17bb661c0e7ab2dbb3cff80d6de3da94ef`;
- control A: `0a30173674664cf04f34c1166ca47bb4b42662a5fe967b1a5cd46dd3b70a4e03`;
- candidate B2: `ce49d73af4cf401177afd1b83972c05cb9274b382aff9a998e4b146b4f11aefa`;
- signed-head confirmation: `69659b34442bb65a6ebf341d784e3739dbc7d0b407b6e3d82c87e627e5972861`.

Control growth was 92,930,048 bytes. Candidate B1/B2 reduced normalized growth by 1,196,032 and
33,652,736 bytes, a mean 17,424,384-byte improvement. The signed-head confirmation grew 90,980,352
bytes. Workload, cadence, resource, idle, process, FD, exit, and cleanup checks passed; the absolute
`<150,000,000` product gate failed in every candidate. No calibration was discarded, threshold
changed, or GC forced into the product path.

Focused, adjacency, full coverage, static, build/package, supply-chain, exact-head CI, post-main CI,
and five-lens QC pass. PR #141 merged as `caa51dc`; P1-007 remains open. This entire profile and
optimization used zero Anthropic calls and zero Warden reviews.
