# R6 concurrent-resume preflight

Date: 2026-08-03
Public plan: [issue #67](https://github.com/keel-harness/keel/issues/67)
Branch: `fix/tui-concurrent-resume-preflight`
Baseline: `38d925ea1a65e7d23d6712e94ea731fd6d16df77`

## Reproduced defect

A second `keel --continue` could accept a prompt and begin paid model work before the Warden opened
the authoritative audit chain and reported an active-writer conflict. The failure was safe for the
audit log but late for user time and provider spend.

## Red-first evidence

- Initial behavior regression: **5 failed / 104 skipped**. The writer did not classify ownership,
  startup did not acquire the chain, and concurrent resume reached the model.
- Real-RPC regression: **1 failed / 321 skipped**. `AUDIT_WRITE_FAILED` omitted the lock state needed
  for honest recovery copy.
- No test, threshold, policy, or security control was weakened.

## Implemented slice

- Every governed run acquires and caches the existing Warden audit writer during startup by
  appending the existing `session.start` event before model/prompt consumption.
- The existing `AUDIT_WRITE_FAILED` response carries additive, response-local
  `auditWriterLockState: active | indeterminate` metadata. No frozen RPC schema or audit event was
  added or changed.
- Active ownership reports the sanitized session ID and exact resume command. Indeterminate
  ownership fails closed and recommends a fresh session. Neither path exposes a PID or audit path,
  steals/deletes the lock, calls the model, or mutates the resumed ledger.
- Pending steering restored from a resume is applied only after the Warden startup preflight.
- Known-dead stale locks retain the existing one-time safe reclaim path.

## Verification

- Directly affected Warden/kernel suites: **431/431 passed**.
- Unrestricted full unit/property suite: **6,471 passed / 20 existing opt-in skips**, 359 passing
  files and 4 skipped files.
- Full local macOS coverage executed the same **6,471 / 20** tests but is not a valid green coverage
  gate: six outer-sandbox loopback tests failed with `listen EPERM`, and macOS does not exercise the
  Linux-only files that CI coverage gates. The changed writer nevertheless measured **95.95%
  statements/lines, 96.77% functions, and 93.33% branches**, above its configured Warden floors.
  Exact-head Linux CI remains the authoritative coverage gate.
- Final candidate checks passed: affected suites **431/431**, typecheck, lint, format, build,
  `git diff --check`, and real SRT denial/credential/address-guard probes **18/18**. Exact-head CI
  and publication are recorded in the chronological log when complete.

## Product and visual evidence

- A credential-unset production-source CLI run through a real **100x30 PTY**, spawned Warden, and
  external Click workspace held one owner open while a second resume attempted to start.
- Blocked resume: exit 1, **0 provider requests**, owner lock byte-for-byte unchanged.
- Owner clean exit: exit 0 and lock released. Retry: exit 0 and exactly one model request to the
  non-secret local fixture, with a valid audit chain.
- `screenshots/24-r6-concurrent-resume-after.png` is a visually inspected 1400x840 sanitized
  terminal-frame transcription of the exact PTY message, not a live window capture. SHA-256:
  `1bb042ed3c51f67f8478cbbddb7d16b97871512408ba929eb9458368da31d320`.
- E5: **NOT_RUN**. Anthropic input/output and spend are zero; cumulative spend remains USD 2.7109.

## Five-lens QC

- Spec compliance: existing Warden-owned writer and `session.start` event; no schema, policy,
  command, or audit-format change.
- Security/adversarial: live, malformed, and known-dead locks covered; active/indeterminate paths
  preserve lock bytes and perform zero model/ledger work; messages omit host paths and PIDs.
- Reliability: real two-process ownership, clean teardown, retry, and startup fixture behavior
  covered. The pre-existing PID-reuse/stale-lock design is not reinterpreted in this slice.
- DX/usability: failure arrives before paid work and gives the exact supported recovery command.
- Simplicity/maintainability: one startup append and one internal typed state; no dependency or new
  authority layer.

No unresolved must-fix was found before publication gating.
