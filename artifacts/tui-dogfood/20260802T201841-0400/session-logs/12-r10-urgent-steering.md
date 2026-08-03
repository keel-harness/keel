# R10 urgent-steering evidence

Date: 2026-08-03
Issue: https://github.com/keel-harness/keel/issues/79
Branch: `fix/tui-urgent-steering-truth`
Baseline: `ba292e6eb84d94410a2ad5bb15eb283d6fcf0798`

## Contract and boundary

R10 keeps the accepted distinction between urgent steering and immediate interruption. `/now`,
`/before-next-edit`, and `/stop-after-current` apply before the next risky or mutating action.
Esc/Ctrl-C/`/interrupt` cancel immediately. The slice changes presentation and terminal/resume
orchestration only; it does not alter Warden policy, mutation classification, provider budgets, or
frozen session/RPC/audit formats.

## TDD and QC history

- Red-first cases covered pending/applied rendering, no-color text, control stripping, mixed
  queues, row budgets, focused panels, pre-mutation injection, in-flight tools, interrupt, terminal
  budget, and resume.
- QC caught an Esc path that auto-re-drove pending steering. The corrected regression requires an
  aborted outcome, no new model turn, and durable pending ledger state.
- QC caught post-budget goal validation that could start after urgent work was stranded. The
  corrected regression requires terminal stop before any additional controller/model work.
- The final focused suite passes 744/744. The preliminary unrestricted coverage suite passes
  6,511/20 outside the outer sandbox; the managed run's six loopback `EPERM` failures are recorded
  as infrastructure-only, not product failures.
- The fixed-size evidence harness initially recognized only the wide governed footer. A red Python
  test proved the compact 80-column footer failed. The final wide-or-compact multiline matcher
  passes 7/7.

## Production-path replay

The built production CLI spawned the Warden and used a deterministic local OpenAI-compatible
provider against the isolated external Click checkout. Terminal sizes were fixed at 80x24 and
100x30. No credential was read or displayed.

Both normal runs:

- showed `queued urgently — before the next change · Esc interrupts now`;
- transitioned to `urgent · applied — correction is in the active turn`;
- completed one governed read and did not execute the next edit;
- preserved one ordinary follow-up separately;
- exited cleanly and left Click unchanged.

Transcript SHA-256:

- 80x24: `0312d3288d8f23b4fae22655fffd85b0f3ebe297840cfbcd48015e2eb18464e3`
- 100x30: `026e7ec47c972c3269b2e2f284f12549ce5a9fee131850f5a717eab74eec4cfc`

Ledger SHA-256:

- 80x24: `a154e69b454e7587e31e291f004c4d038b67b54fbc1a3030e738ce3e3efa23ff`
- 100x30: `f0bafec55fc9a980457bea840e432c1510cddfeda9e4792da79452655c25f5bf`

## Terminal-budget and resume replay

At 100x30 with `KEEL_MAX_GROSS_TOKENS=5000`, the first process stopped with the urgent correction
pending, no stale Esc hint, and the exact resume command. It exited 1 because the configured budget
was terminal. The fresh process exited 0, displayed `1 urgent correction re-applied and dispatched`,
and represented the durable transition exactly once as `[insertedAt null, insertedAt 7]`. The
external checkout remained clean.

The first evidence oracle expected nonexistent status fields. The product scenario had succeeded;
the oracle was corrected to the actual durable insertion contract and rerun. This is recorded as
an invalid evidence assertion, not hidden as green.

## Visual evidence

All four images are sanitized 1400x840 exact-frame transcriptions of captured production frames,
visually inspected before inclusion:

- `screenshots/29-r10-urgent-pending.png` — `db02077af4a1c355ddab7548ab0806343a6cb707cb3819108dd846c7256e0d71`
- `screenshots/30-r10-urgent-applied.png` — `8ca9780c971b3035864abb0b0ac135ff9eb05847f7f0615584290ee2eedc09db`
- `screenshots/31-r10-budget-pending.png` — `423abbdb99823389a17a4bbbc4f46ac7ef59eda2c826179f58f2e003457d4b04`
- `screenshots/32-r10-resume-applied.png` — `c64e7ed192d11b1027b4e80b7533d69d37a4485f43567a5f1afbcfdcb645a095`

The pending frame also reproduces the pre-existing DF-021 ambiguous mutation status. That evidence
supports R14; R10 does not infer file state.

## Cost and current gate

E5 is **NOT_RUN**. Six deterministic loopback requests made no Anthropic call. Cumulative spend
remains USD 2.74434625, USD 17.25565375 remains, and the final USD 2 reserve is intact.

No local five-lens must-fix remains. The final candidate passes focused 744/744, artifact/claim
192/192, PTY harness 7/7, unrestricted full coverage 6,511/20, lint, typecheck, format, build, and
diff checks. Exact reviewed-head CI `30845070144`, merge `d397bfa`, identical candidate/merge tree
`686f579`, post-merge `main` CI `30845526192`, and branch/worktree cleanup all passed. R10 is
published and the evidence-bound score is 3.73/5.
