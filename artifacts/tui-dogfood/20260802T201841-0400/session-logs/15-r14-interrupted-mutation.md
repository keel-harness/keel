# R14 interrupted-mutation evidence

Date: 2026-08-03
Issue: https://github.com/keel-harness/keel/issues/87
Branch: `fix/tui-interrupted-tool-state`
Baseline: `7680e7843facc2471f3799588ea21a8d004517dd`

## Observed defect and boundary

R10 proved `/before-next-edit` prevented the planned edit, but the activity card still said
`execution status is unknown`. The ledger had no edit result and Click stayed unchanged, yet the UI
did not distinguish “the executor was never invoked” from a genuinely indeterminate missing-result
case. R14 changes process-local presentation truth only. It does not add a KernelEvent, provider
message, session/audit record, RPC/shared schema, retry, undo, or file-effect inference.

## TDD and implementation

- Red-first focused tests failed **4 / 4 selected** against the old generic copy: one strings
  contract plus `/now`, `/before-next-edit`, and `/stop-after-current` runner paths.
- The runner now records the exact activity index and provider ID at `tool-call`, marks the
  occurrence immediately before executor invocation, observes promise settlement, removes it on an
  authoritative `tool-result`, and supplies missing-result state before generic `run-finished`
  settlement.
- Exact occurrence matching prevents a stale or reused provider ID from settling another card.
  Live output, liveness, and pending mutation-presentation residue are removed on settlement.
- State copy is intentionally asymmetric: `not started` says the tool did not execute; `in flight`
  and `completed without a recorded result` say effects remain indeterminate and require inspection;
  a direct reducer boundary with no runner facts remains conservatively indeterminate.

## Automated and package evidence

- Focused E2: **576/576** across strings, runner steering, view model, headless, and real Ink.
- Unrestricted full coverage: **6,539 passed / 20 existing opt-in skips**, 362 passing files and 4
  opt-in skipped files; overall 97.99% statements/lines and 93.71% branches. No threshold changed.
- Full lint, monorepo/package typecheck, repository formatting, build, package build, and
  `git diff --check` pass.
- A fresh scripts-disabled install of the locally packed carrier found zero npm vulnerabilities.
  Its canonical urgent-control smoke passed `/now`, `/before-next-edit`, and `/stop-after-current`:
  each made four local fixture requests, preserved the file, recorded only the read result, and
  exited cleanly.

## Fixed-size production replay

The installed npm carrier spawned the production Warden and a non-secret OpenAI-compatible
loopback fixture at exact 80x24 and 100x30 dimensions. Both `/before-next-edit` runs completed the
governed FIFO read, applied the urgent correction, made no edit result, preserved `target.txt`,
returned to the idle composer, completed one later ordinary turn, and reaped product/fixture process
groups cleanly. The transcript contained `not started` plus `this tool did not execute` and did not
contain the old ambiguous copy.

- 80x24 sanitized transcript SHA-256:
  `dd890043a1a0e222b99ad45eca6421c56846a91318ae8de7db48215414d70240`
- 100x30 sanitized transcript SHA-256:
  `a14f520c2d3aef3c54f5f590dc898f6676656f4ac7439647f5e9d3692de31d75`
- 80x24 ledger SHA-256:
  `62d65e215a6e767802d3439413eff1528c00021675ebc1655cb0e56d47ec7582`
- 100x30 ledger SHA-256:
  `3ca9cacd24a465bb69e4536a02ec841e202cee2e6f89fd0106b014f96aae30b6`

## Visual and cost evidence

`screenshots/36-r14-interrupted-mutation-after.png` is a sanitized 1400x840 terminal-frame
transcription of the exact 100x30 PTY text, visually inspected after rasterization. It shows the
not-started activity beside urgent-applied and governed-protection truth. SHA-256:
`1ac83da123830f4e29adcc813d69a3d662403f2ca827699b99424006b945ec24`.
R10 screenshot 29 is the directly comparable before frame.

E5 is **NOT_RUN** because execution occurrence state is provider-independent and the real provider
boundary was exercised by the local fixture. Twenty fixture requests made no Anthropic call.
Cumulative spend remains USD 2.74434625 with USD 17.25565375 remaining and the final USD 2 reserve
intact. Five-lens review found no unresolved must-fix locally. The candidate aggregate is **3.85/5**
(239/62); it is not official until reviewed-head and post-main CI pass.
