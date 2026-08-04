# R17 useful waiting and latency evidence

- Date: 2026-08-04
- Public plan: [issue #103](https://github.com/keel-harness/keel/issues/103)
- Exact main: `98d8dd72536c9a5cfd8539459c9f847984388890`
- Exact npm tarball SHA-256:
  `6dfdd0fc711dbe17fb96c7d35e57d76b8a407742bed506972ca468fe844da622`
- External workspace: sanitized local Click checkout, clean at
  `edda51f303625daa6084cd53490bbcf6c274bef5`
- Geometry: startup `80x24`; active phase replay `100x30`; `TERM=xterm-256color`

## Decision

R17 is a validation-only slice. Exact installed-carrier evidence passes the existing behavior:
sub-two-second tools remain timer-free; the long-running Click test shows coarse elapsed time,
explicit quiet time, the timeout boundary, and the next expected controller event; no fake
percentage is displayed. Active input remains responsive during a controlled provider wait. No
product code, dependency, policy, security claim, frozen contract, or public CLI behavior changes.

The separate completion observation—exact pytest counts exist in the authoritative Warden result
but the final card reduces visible stdout to progress dots—is routed to R18. It is not used to fail
R17 waiting behavior or to raise a workflow score here.

## Exact carrier preparation

- `pnpm build` — passed across all six buildable workspace packages.
- `pnpm package` — passed for npm plus Darwin/Linux arm64/x64 binaries.
- First `npm pack` attempt — **not green**: npm tried to write the sandbox-inaccessible user cache
  and returned `EPERM`; it produced no tarball.
- Repeated with task-scoped `npm_config_cache` under `/private/tmp` — passed; package size 779.3 kB,
  unpacked size 3.5 MB, sixteen files.
- Installed the local tarball into an isolated prefix with `--ignore-scripts --no-audit --no-fund`;
  57 packages installed and the exact launcher was executable.

## Governed launch and idle-input distribution

The repository-owned packaged PTY observer launched the exact installed npm carrier twenty times,
required the spawned production Warden to report governed protection, application-rendered a
non-submitted input probe, exited through the real composer, and reaped each process group.

| Metric | Minimum | p50 | p95 | Maximum | Initial observational budget |
| --- | ---: | ---: | ---: | ---: | ---: |
| First paint | 33.770 ms | 35.034 ms | 40.666 ms | 47.487 ms | p95 <= 100 ms |
| Governed ready | 462.854 ms | 480.128 ms | 592.349 ms | 989.550 ms | p95 <= 1,000 ms |
| Idle input echo | 4.909 ms | 5.378 ms | 7.102 ms | 17.734 ms | p95 <= 50 ms |

All **20/20** accepted samples passed. Each retained 4,288–4,289 terminal bytes, exited zero, and
left no process group. The budgets are deliberately looser than the single-host p95 and are
observational, not public compatibility or CI contracts. R23 owns cross-host resource confidence
and any future gate.

One earlier managed-sandbox sample rendered `sandbox off · egress guard off`; the observer rejected
it because it never reached governed-ready. The remaining loop was stopped immediately. That sample
is **NOT ACCEPTED** and absent from the distribution.

## Provider, Warden, tool, liveness, and active-input distribution

Five independent 100x30 sessions used a loopback OpenAI-compatible fixture with a controlled
3-second first response and 1-second settlement response. The fixture asked Keel to run the real
external command:

`python3 -m pytest -q -o pythonpath=src --ignore=tests/test_types.py`

Every Warden audit recorded one requested bash occurrence with verdict `allow`, zero review
interrupts, and one authoritative zero-exit result containing `1901 passed, 24 skipped, 31000
deselected, 1 xfailed`. The sample audit timestamps place request at `04:56:08.772Z` and result at
`04:56:11.904Z` for a representative 3.132-second governed execution. Click remained clean.

| Metric | p50 | p95 | Initial observational budget |
| --- | ---: | ---: | ---: |
| Governed launch to idle | 570.065 ms | 671.794 ms | p95 <= 1,000 ms |
| Active-turn input echo | 31.432 ms | 34.923 ms | p95 <= 100 ms |
| Submit to first controller response | 10.388 ms | 10.754 ms | p95 <= 100 ms |
| Submit to visible tool request | 3,080.915 ms | 3,098.336 ms | fixture delay + <= 100 ms |
| Visible request to visible execution | 14.998 ms | 16.333 ms | p95 <= 100 ms |
| Visible execution to liveness reveal | 2,001.879 ms | 2,002.541 ms | 2,000–2,250 ms |
| Controlled provider first wait | 3,003 ms | 3,004 ms | measured, no provider SLA claim |
| Controlled provider settlement wait | 1,002 ms | 1,003 ms | measured, no provider SLA claim |
| Submit to returned idle composer | 7,362.380 ms | 7,454.398 ms | diagnostic only |

All **5/5** samples passed with byte-identical sanitized transcript SHA-256
`2bf8bcf68741f2643849a166f54f8208c1915364a552e6afee78477822a4b429`. Every sample displayed
`working · checking bash execution · 2s`, `quiet · 2s without output`, the 11-minute timeout, and
the exact next controller expectation. The liveness row contained no `%`. The completed bash card
and final assistant response were visible, the composer returned, exit was zero, and teardown was
clean.

Provider latency is deliberately not assigned an artificial success SLA: Keel controls immediate
status and input responsiveness, not external inference time. Unbounded provider work and tests
must never receive a fabricated percentage.

## Rejected calibration attempts

Rejected attempts are kept out of all distributions:

1. The outer managed-sandbox launch never reached governed protection; correctly rejected.
2. The first active-input driver wrote before Ink consumed the task's Enter, appending the probe to
   the prompt; no measurement was accepted.
3. The next driver used `Ctrl+C` to clear the probe. Keel correctly treated it as an explicit
   interrupt, saved the session, and returned to input; no measurement was accepted. The final
   driver uses `Ctrl+U`, which clears the buffer without steering.
4. One product-valid calibration exited zero but the driver falsely required the exact pytest
   summary in the final card and failed to recognize the indented `quiet` row. It was excluded,
   then the assertions were separated into R17 truth checks and the R18 completion observation.

## Visual evidence

`screenshots/45-r17-measured-liveness.png` is a sanitized, visually inspected 1400x840 rendering of
an accepted 100x30 frame. SHA-256:
`d790030311036f0b2c8f1d514911efb1852ec947f7cfa918afd40dd45a5bce5c`. It shows task, execution
state, two-second elapsed time, explicit quiet state, timeout, next event, governed protection, and
active-composer guidance without a username, private path, credential, or environment secret.

The in-app browser was unavailable. The already validated local SVG -> Quick Look -> PNG fallback
was used and the final PNG was inspected at original resolution.

## Evidence boundary

- E2: no behavior test was changed. The artifact contract passes **21/21** and the unchanged
  purposeful-liveness, conversation, and runner-steering suites pass **162/162**. The first optional
  integration invocation was not green because the isolated docs worktree lacked its package-local
  `@keel/shared` dependency link: the pure suite passed 2/2 while two suites failed collection with
  zero tests. Adding only the matching ignored worktree-local dependency link made the identical
  command collect and pass; no source or test was changed.
- E3: exact installed npm carrier, spawned production Warden, external Click, loopback provider,
  real 80x24/100x30 PTYs.
- E4: visually inspected screenshot 45 plus sanitized transcript hashes.
- E5: **NOT_RUN**. Provider delays, Warden presentation, tool liveness, and input rendering are
  deterministic in this probe. Zero Anthropic calls; cumulative spend remains USD 2.74434625.

## Five-lens review

- Spec compliance: measures only existing controller/render behavior and preserves the no-fake-
  progress rule.
- Security/adversarial: governed posture is mandatory, rejected samples cannot become green,
  fixture credentials are placeholders, and no policy or enforcement is changed.
- Reliability/edges: five full phase samples plus twenty launches, monotonic application-rendered
  boundaries, deterministic fixture delays, clean teardown, and explicit rejected attempts.
- DX/usability: first status and input are responsive; the long quiet tool stays truthful and
  actionable. The completion-count gap is routed to R18.
- Simplicity/maintainability: evidence and initial budgets only; no redundant timer, telemetry,
  dependency, protocol, or flaky CI wall-clock gate.

No unresolved R17 must-fix remains.
