# R23 packaged performance and resource-confidence evidence

- Date: 2026-08-04
- Public plan: [issue #126](https://github.com/keel-harness/keel/issues/126)
- Exact source commit: `864474df3bb5c43e90b0dbf374dc5338260d697e`
- Exact source tree: `d783fb616e7034059e990cf5c52eedbdcec04cd6`
- Exact npm tarball SHA-256:
  `2dcd1b25652771f93ffe9a369110631dabedd9fa64996f7f2306f6b660c8648c`
- External workspace: clean Click checkout at
  `edda51f303625daa6084cd53490bbcf6c274bef5`
- Host: Darwin 25.2.0 arm64; Node v20.14.0; Python 3.13.4
- Geometry: startup `80x24`; active work `100x30`; `TERM=xterm-256color`

## Pre-confirmation resource bounds

These R23-only diagnostic alert bounds were frozen from the first accepted dense distribution
before the confirmation distribution ran. They are not public compatibility promises, CI wall-clock
gates, changes to `MASTER_SPEC.md`, or substitutes for the separate 200-turn Kernel soak:

| Scoped metric | First accepted p95 | Frozen R23 bound | Margin or rationale |
| --- | ---: | ---: | --- |
| Complete Kernel + Warden process-group peak RSS | 247,152 KiB | <= 256 MiB | 14,992 KiB / 6.1% |
| Complete process-group settled RSS | 198,992 KiB | <= 224 MiB | 30,384 KiB / 15.3% |
| Settled RSS growth from per-sample idle | -5,952 KiB | <= 16 MiB | permits host noise but catches retained growth |
| Returned active-frame physical rows at 100x30 | 12 | <= 16 | four-row / 33.3% margin |
| Retained terminal stream for a 185,202-character tool result | 17,932 bytes | <= 32 KiB | 14,836-byte / 82.7% margin |
| Surviving process groups | 0/30 | 0 | teardown is correctness, not a tunable budget |

The public cold-start target remains unchanged at `<200 ms` first paint and `<750 ms` interactive.
The R17 single-host observational budgets remain p95 `<=100 ms` first paint, `<=1,000 ms`
governed ready, `<=50 ms` idle input, `<=100 ms` active input/controller/display overhead, and a
truthful liveness reveal in the `2,000-2,250 ms` interval. Neither set is tuned after measurement.

## First accepted dense distribution

The scripts-disabled installed carrier completed 20/20 cold launches and 10/10 active verbose Click
runs with a 100 ms complete-process-group RSS sampling cadence. The loopback provider made zero
Anthropic calls. Every sample required real governed posture, a zero public exit, and complete
process-group reaping.

The retained report SHA-256 is
`a7cf7cc95b78a2fbf889d7edc690a6c155884c4f997922d00a2ffe6117c6992c`.

| Cold metric (n=20) | Minimum | p50 | p95 | Maximum | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| First paint | 39.216 ms | 40.921 ms | 44.667 ms | 93.488 ms | passes spec and R17 |
| Governed ready | 550.245 ms | 609.726 ms | 755.808 ms | 1,049.076 ms | passes R17; misses spec by 5.808 ms |
| Idle input echo | 5.393 ms | 6.242 ms | 11.131 ms | 16.631 ms | passes R17 |

| Active metric (n=10) | p50 | p95 | Verdict |
| --- | ---: | ---: | --- |
| Launch to governed idle | 662.807 ms | 864.042 ms | passes R17 |
| Active input echo | 33.830 ms | 46.779 ms | passes R17 |
| Submit to first visible controller state | 10.633 ms | 16.591 ms | passes R17 |
| Visible request to visible execution | 12.275 ms | 20.940 ms | passes R17 |
| Visible execution to liveness reveal | 2,010.524 ms | 2,023.361 ms | passes R17 |
| Process-group idle RSS | 210,880 KiB | 226,336 KiB | diagnostic |
| Process-group peak RSS | 235,744 KiB | 247,152 KiB | inside frozen R23 bound |
| Process-group settled RSS | 179,984 KiB | 198,992 KiB | inside frozen R23 bound |
| Settled RSS growth | -23,880 KiB | -5,952 KiB | inside frozen R23 bound |
| Returned visible rows | 12 | 12 | inside frozen R23 bound |
| Retained terminal bytes | 15,976 | 17,932 | inside frozen R23 bound |

All ten authoritative Warden tool results contained 185,202 characters, 1,901 `PASSED`
occurrences, and the exact pytest completion summary. The compact TUI returned to twelve physical
rows without losing the authoritative result. The liveness frame showed
`working · checking bash execution · 2s`, never a fabricated percentage. Representative retained
liveness/final frame SHA-256 values are
`b5db6eac5314c295d98931916b7377f303b483aaf7bb3a606893484e5e1d933a` and
`8a269d3bd15e8b89614172aadaad0039118bade55e85c196180219fc4b055281`.

This complete-process-group workload does **not** satisfy the separate `<150 MB` generic Kernel
200-turn budget and does not claim to be that soak. P1-007 remains failed. The measured peak is much
lower than ADR-0082's historical 414,810,112-byte aggregate peak, but cross-protocol numbers are not
presented as a regression percentage.

## Sparse timing control

Dense host-wide process enumeration can perturb event timing. A separate 1,000 ms sparse-sampling
control therefore ran one launch and ten active sessions against the identical carrier. Its report
SHA-256 is `151df9cbfaae134baa6b2d995ce4ea628cec431575eca58037b451b5a9cf3196`.

The first sparse attempt was correctly excluded: its oracle still required a sparsely sampled peak
to cover a separately observed idle value, which two otherwise-valid samples did not. The runner was
changed to label `resource` and `timing-control` modes explicitly; resource mode keeps the peak
coverage assertion, while timing-control mode marks RSS diagnostic and does not use it for a
verdict. The corrected control passed 10/10:

| Timing-control metric (n=10) | p50 | p95 | R17 budget |
| --- | ---: | ---: | ---: |
| Active input echo | 33.942 ms | 35.468 ms | <= 100 ms |
| Submit to first visible controller state | 12.255 ms | 14.138 ms | <= 100 ms |
| Provider first chunk to visible tool request | 28.458 ms | 31.634 ms | <= 100 ms |
| Visible request to visible execution | 12.792 ms | 14.276 ms | <= 100 ms |
| Visible execution to liveness reveal | 2,003.042 ms | 2,020.642 ms | 2,000-2,250 ms |
| Provider settlement chunk to visible final | 24.068 ms | 30.414 ms | <= 100 ms |

All ten sparse-control results again contained 185,202 tool-result characters, 1,901 `PASSED`
occurrences, the exact summary, twelve visible rows, zero exit, and complete process-group teardown.
Provider fixture delay is reported separately and has no Keel success SLA.

## Rejected and excluded attempts

No rejected sample contributes to a distribution:

1. Two initial cold calibrations omitted explicit trust and stopped at the legitimate trust prompt.
2. One single-sample calibration passed after the command was corrected to `--trust`; it was used
   only to validate the driver.
3. The first sparse control produced ten product-valid sessions but a non-green measurement verdict
   because the observer incorrectly treated sparse peak capture as resource evidence. It remains
   excluded rather than retroactively relabeled green.
4. One rerun inside the outer managed sandbox reported `sbx:off`; the harness refused governed-ready
   and retained no distribution. The host-level rerun reported `sbx:on` and passed. This matches
   R17's already documented nested-sandbox exclusion and is not a production Keel failure.

## Confirmation distribution

The unchanged exact carrier repeated 20 dense cold launches and ten dense active runs. The report
is internally `PASS` for product correctness and measurement integrity: all 30 sessions reached
governed posture, rendered owned input, exited zero, preserved the complete verbose result, and
reaped every process. Its SHA-256 is
`1a81d363a204ced8496b90637b88b93061064b55031d993fc7835e50b19760b9`.

It is **not fully green against the frozen confidence thresholds**:

| Confirmation metric | p50 | p95 | Frozen threshold | Verdict |
| --- | ---: | ---: | ---: | --- |
| First paint (n=20) | 41.870 ms | 68.067 ms | spec <200 ms; R17 <=100 ms | pass |
| Governed ready (n=20) | 714.111 ms | 1,050.430 ms | spec <750 ms; R17 <=1,000 ms | fail |
| Idle input echo (n=20) | 6.469 ms | 11.540 ms | R17 <=50 ms | pass |
| Active input echo (n=10) | 34.337 ms | 67.867 ms | R17 <=100 ms | pass |
| First controller state (n=10) | 10.988 ms | 25.490 ms | R17 <=100 ms | pass |
| Provider chunk to visible request (n=10) | 20.240 ms | 36.428 ms | R17 <=100 ms | pass |
| Request to execution (n=10) | 10.847 ms | 12.425 ms | R17 <=100 ms | pass |
| Execution to liveness (n=10) | 2,006.255 ms | 2,022.795 ms | 2,000-2,250 ms | pass |
| Provider settlement to visible final (n=10) | 16.329 ms | 24.141 ms | R17 <=100 ms | pass |
| Process-group peak RSS (n=10) | 234,088 KiB | 244,432 KiB | R23 <=256 MiB | pass |
| Process-group settled RSS (n=10) | 176,720 KiB | 225,952 KiB | R23 <=224 MiB | pass |
| Settled RSS growth (n=10) | -37,064 KiB | 26,176 KiB | R23 <=16 MiB | **fail** |
| Returned physical rows / terminal bytes | 12 / 15,976 | 12 / 17,932 | <=16 / <=32 KiB | pass |

The governed-ready tail is reproduced rather than a single-run anomaly. Across both accepted dense
distributions, combined `n=40` p95 is 1,049.076 ms, 10/40 samples are at or above 750 ms, and 3/40
exceed 1,000 ms. The worst confirmation sample is 1,962.969 ms. Issue
[#127](https://github.com/keel-harness/keel/issues/127) owns the smallest red-first product slice.

The settled-growth miss is one sample (`+26,176 KiB` from a low 199,776 KiB initial idle to a
225,952 KiB settled value); absolute settled RSS still passes the frozen 224 MiB bound. It is not
discarded as noise and the 16 MiB bound is not raised. This remains part of the already named failed
P1-007 resource residual, not a successful generic memory claim.

## Startup root-cause ablation

Issue #127 is backed by a causal, non-acceptance ablation. With only the disposable run-start
snapshot disabled, the same installed carrier passed 20/20 launches with first-paint p95 42.132 ms
and governed-ready p95 631.637 ms / max 673.559 ms. Report SHA-256:
`6d2b3fd6f68fa07ee685ae5500398cdc7d21256111d01ffd8ad5bb1ae6226a14`.

The snapshot remains mandatory in production; this ablation is not used to claim a fixed product.
A separate 20-sample component diagnostic measured the unchanged faithful 4,493,955-byte / 284-file
Click snapshot at p50 126.650 ms, p95 199.455 ms, and max 224.940 ms. A native recursive-copy probe
measured only that copy phase at p50 87.805 ms and p95 105.915 ms. Together with code inspection,
the evidence localizes the tail to contention between the currently overlapped Warden startup and
snapshot work. Issue #127 preserves the pre-action guarantee while testing sequential readiness and
the existing safe recursive-copy fast path; it may not disable snapshots or move them after action.

## Evidence boundary

- E2: unchanged focused Vitest coverage passed **5 files / 99 tests** across dogfood evidence,
  purposeful liveness, assistant prose, real-Ink row budgets, and the packaged PTY source contract.
  The direct Python observer suite passed **2/2**. The first Python invocation used a dotted module
  name even though `packaging/` is not a Python package and failed import with zero tests; the
  corrected direct-file command passed. Repository Prettier and diff checks pass. Product repair is
  deliberately separate under issue #127. Repository lint and all workspace plus packaging
  typechecks pass.
- E3: exact installed npm carrier, spawned production Warden, frozen Click checkout, deterministic
  loopback provider, real 80x24 and 100x30 PTYs.
- E4: secret-sanitized reports and retained frames; no new screenshot is expected to add evidence
  beyond R17/R18 because R23's new facts are distributions and process-group observations.
- E5: **NOT_RUN**. Zero Anthropic calls and USD 0.000000 incremental spend.

No product behavior, dependency, security claim, Warden policy, sandbox, audit surface, frozen
contract, or public CLI changes are proposed by this validation slice.

## R23 decision

R23 is a useful **partial pass**, not a blanket performance green. Input, controller/display,
liveness, long-output retention, row density, peak/absolute-settled RSS, and teardown are repeatably
inside their scoped bounds. Governed-ready tail and one per-sample settled-growth observation are
not. The official six-workflow usability score remains 4.04/5 candidate and receives no component-
validation credit.
