# R13 truthful credential recovery

## Reproduction

The exact installed main carrier ran `keel auth set anthropic` with isolated owner-only homes at
80x24 and 100x30. Both invocations exited 0 and wrote mode-`0600` credential files. The output
confirmed storage but did not explain that an already running session retained its existing
provider client or how to recover.

The baseline tarball SHA-256 is
`40bd8bee1097d4be947f48ba070b965e3c9f667cedca21def80116f832921598`. Both sanitized baseline
transcripts share SHA-256
`44b27f94e6979bd7b0de16a827891c60584cba439f2665756b43ce595beefaf0`.

## Retained behavior

Successful `keel auth set` output now contains two controller-owned facts:

1. the key was stored in the `0600` credentials file;
2. running Keel sessions were not reloaded, so recovery is to restart from the session workspace
   with `keel --continue`.

The change does not implement hot reload, replace provider clients, alter environment/store
precedence, validate keys, retry providers, or change Warden, policy, sandbox, egress, audit,
schema, dependency, or security-claim behavior. Empty input, cancellation, store failure,
provider validation, list, remove, and secret non-disclosure retain their existing behavior.

## Product-path comparison

Candidate implementation commit `19a482a4d6175c36374d5a3c8229ab23217fa0b3` produced a clean
exact installed tarball with SHA-256
`a0961431a8b539998e63fdd81958811515d42092f55c7aec10f25c42c701c5ab`. Candidate 80x24 and
100x30 invocations exit 0, preserve file mode `0600`, show the exact recovery boundary, and share
transcript SHA-256
`abf5e37f35b4054ced24bb58f46f18456eea26255ffdd868ee5d93ec4481834e`.

Screenshots `39-r13-credential-recovery-before.png` and
`40-r13-credential-recovery-after.png` are sanitized 1400x840 exact-text comparison
transcriptions, visually inspected after rasterization. Their SHA-256 values are
`42194b29bd32709b3a28d4de3f83f8ab3500c177cffc4af261426a263dd7b02e` and
`bdef1bd0c30b2a3739fd8fccac36cede6c14da93c575adfaf63367153241ab1e`.
Silent scans confirm the non-secret fixture, credential-shaped strings, username, and private paths
are absent from transcripts and screenshots.

## Evidence classes

- E2: red-first exact-output coverage failed 1/13 before implementation and passes 13/13 after;
  adjacent auth/store/runtime/entry coverage passes 59/59 and artifact consistency passes 21/21.
  Final full tests and coverage each pass 6,546/20 existing opt-in skips across 1,034 passing
  suites; coverage is 97.99% statements/lines and 93.72% branches. Lint, typecheck, format, build,
  all four package carriers, and diff checks pass. The first default-concurrency JSON run was killed
  with exit 137 before producing a report and is not counted green; the bounded-concurrency rerun
  completed the identical suite.
- E3: exact installed baseline and candidate carriers pass at both fixed terminal sizes.
- E4: screenshots 39–40 visually inspected.
- E5: **NOT_RUN**; deterministic local controller behavior used four carrier invocations and zero
  model/provider calls.

Security enforcement, secret-store semantics, Warden verdicts, frozen contracts, audit authority,
model-visible results, and provider behavior are unchanged. Cumulative Anthropic spend remains USD
2.74434625. Candidate `19a482a4d6175c36374d5a3c8229ab23217fa0b3` plus evidence head
`65ffe16d384ecbe97f82440832a2ff484d404661` passed exact reviewed-head CI `30866891254`, including
`ci-required` job `91861618047`. PR #95 squash-merged as
`1bbe9778d1d227f090226a3a3e07488498074d91`; both trees are
`ee7837f811f492983983ed986d6a3dcda8d58530`. Exact post-main CI `30867327223` passed, including
`ci-required` job `91863159620`. Issue #94 closed and feature cleanup passed. The directly observed
onboarding recovery cell rises from 4 to 5, making the evidence-bound aggregate officially
**3.89/5** (241/62); the strict final same-commit six-workflow gate remains open.
