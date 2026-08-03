# R9 resumed prompt history

Date: 2026-08-03

Public plan: [issue #74](https://github.com/keel-harness/keel/issues/74)

Keel baseline: `fff28637e84b051953b7431f00303648558edd27`

External workload: public `pallets/click` at local-only commit `edda51f`

Terminals: real PTYs at 80x24 and 100x30

## Red-first sequence

The first implementation tests established ordinary prompt reconstruction, exclusion of in-run
controller messages and applied steering, duplicates, blanks, safe history normalization, the
100-entry bound, exact live submission, optional renderer wiring, fresh/resume separation, and CLI
continuation. Once missing-module errors were separated from behavior, three intended failures
proved the resume seed did not yet exist. No production behavior changed before that red.

The first green reached 332/332. Adversarial review then found that index-only steering exclusion
could suppress a legitimate prompt after a torn marker reused its promised message index. The new
test failed 1/33 for that exact reason. Matching both durable index and exact steering content fixed
the issue. Direct sidecar and repeated-submit bounds brought final focused green to 337/337.

## Product replay

- E3 compared clean `main` with R9 through the production source CLI, a spawned Warden, external
  Click, a non-secret loopback provider, and isolated state at 80x24 and 100x30.
- Each variant created a session, completed one ordinary prompt, exited, and restarted with
  `--continue`. The resumed composer began with an unsent `preserve this draft` value before Up.
- Before R9, Up was a no-op and the draft remained visible. After R9, Up recalled the prior prompt,
  Down restored the exact draft, a second Up recalled again, and appending ` revised` submitted the
  edited recall successfully.
- Six local provider requests completed; all four resumed sessions exited 0; the external Click
  checkout remained byte-clean. The isolated child environment contained only the fixture
  placeholder and never inherited or exposed a live provider credential.
- E4 frames are `screenshots/27-r9-resume-history-before.png` and
  `screenshots/28-r9-resume-history-after.png`. Both are sanitized exact-frame transcriptions at
  1400x840 and were visually inspected. SHA-256:
  `b8d6d1079e99cfe20cf7bb405438509aadede052a57702197e931fc286444c46` and
  `3184a825c5c085d01ecf2010259fe4dc268a85411e694a24c3b0431000462dd9`.
- E5 is **NOT_RUN** because the behavior is provider-independent and the same production path was
  fully exercised by the local fixture. Anthropic spend remains USD 2.74434625.

## Verification and boundary

- Focused behavior suite: 337/337 passed.
- Unrestricted full suite: 6,502 passed / 20 existing opt-in skips; 360 passing files and 4 skipped
  files.
- The first narrow coverage selection passed all 337 tests but was honestly non-green because the
  large existing `session-entry.ts` file reached only 86% function coverage. Adding every test that
  imports that orchestrator passed 377/377 and the configured per-file gate: aggregate 96.40%
  statements/lines, 92.59% branches, and 98.95% functions across changed non-Ink files.
- Repository typecheck, lint, format, build, and `git diff --check` passed. Ink is intentionally
  excluded from line coverage and is exercised through its real-render suites and PTY evidence.
- Five-lens review found no must-fix. The slice is issue-scoped and kernel-local; hostile controls,
  known secret shapes, steering provenance, torn ordering, bounds, duplicates, fresh/resume ports,
  late seeding, and draft restoration are covered; the comparison is materially faster to use; and
  the implementation adds no dependency or authority.
- No shared UiPort, frozen session/audit/policy schema, Warden decision, sandbox/egress behavior,
  model context, public CLI syntax, dependency, or security claim changed.
- Exact-head CI, merge, post-main CI, and branch/worktree cleanup remain required.
