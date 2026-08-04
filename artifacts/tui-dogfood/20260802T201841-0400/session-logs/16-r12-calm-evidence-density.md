# R12 calm routine evidence density

## Reproduction

The exact installed `main` carrier was run at 80x24 and 100x30 through a spawned Warden and a
non-secret loopback OpenAI-compatible fixture. The fixture requested eight trusted reads, four
trusted searches, then a final answer. Both runs made thirteen requests, exited 0, and returned the
idle composer. Each completion rendered twelve individual routine evidence rows.

## Retained behavior

Normal/calm completion evidence now groups only repeated successful exact `read` and `search`
entries. Each group begins with its exact occurrence count, includes at most two source-ordered
unique examples, and is bounded to 120 display cells. Quiet continues to omit successful routine
evidence. Verbose/debug preserve the exact twelve rows. Single observations, failures, reviews,
blocked/limited/partial results, mutations, and nonroutine tools are unchanged.

## Product-path comparison

The exact local tarball SHA-256 is
`651a5efe94e45fabc2592dffd61ad13e4babed6d2a66777d94752489bb929878`. Candidate runs at 80x24 and
100x30 each made thirteen requests, exited 0, returned the composer, and rendered exactly two groups.
Transcript hashes are `63f3fc2cf9f961f7ac559c53e6e9ccf70b854d3e1d6b4e0b131740b4452c6290`
and `eaeec91b18e84f02240d8e39e063dd87799fa425c1da2516cc6f8561ea57d60d`.

Screenshots `37-r12-routine-evidence-before.png` and
`38-r12-routine-evidence-after.png` are sanitized 1400x840 exact-text comparison transcriptions,
visually inspected after rasterization. They contain no credential, user-home path, or private
identifier. SHA-256 values are
`280da6a76ecfb224b13e277f72df2144c3823e25342c57b75c169eda374d8343` and
`4a5826db71cf71403f0d53d8a3215586f5a590fd7879f206a58dfcf56206a55d`.

## Evidence classes

- E2: focused 411/411, full TUI 1,357/1,357, unrestricted coverage, and final full suite 6,545/20
  pass; lint, typecheck, format, build, package, and diff gates pass.
- E3: exact installed carrier passes at both fixed terminal sizes.
- E4: screenshots 37–38 visually inspected.
- E5: NOT_RUN; deterministic presentation behavior used twenty-six loopback requests and zero
  Anthropic calls.

Security enforcement, Warden verdicts, frozen contracts, audit authority, model-visible results,
and provider behavior are unchanged.

Candidate `ea79cf5` passed exact reviewed-head CI `30863536934` and merged through PR #92 as
`2ca060e` with identical tree `8261e69`. Exact post-main CI `30863981683` passed, including
`ci-required` job `91852829645`; issue #91 closed and feature cleanup passed. The evidence-bound
aggregate is officially **3.87/5** (240/62), while the strict final six-workflow gate remains open.
