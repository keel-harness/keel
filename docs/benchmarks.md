# Benchmarks

Reproducible capability numbers for keel, with the caveats stated. These measure whether the
agent finishes coding tasks. They are not a security measure; security is documented in the
[claim ledger](quality/claim-ledger.md).

> Every number here is a **single trial (n=1)** on a **59-task subset**, run with keel's
> **warden sandbox disabled** (the eval-only executor). Treat small differences as noise.
>
> **Platform caveat:** these runs require **x86-64 (amd64)**. The TerminalBench task
> images are amd64-only; under emulation on ARM hosts (Apple Silicon works via a
> configured amd64 platform, but bare qemu on some ARM boxes does not) the harness
> verifier can crash, so results are not reproducible there. Reproduction needs an
> amd64-capable box, the harbor adapter under `eval/`, and an `ANTHROPIC_API_KEY`.

## Result

TerminalBench 2.1, identical 59-task subset, model Claude Sonnet-4-5
(`claude-sonnet-4-5-20250929`), single trial, same host class:

| Harness    |     Score | Tasks solved | Date       |
| ---------- | --------: | -----------: | ---------- |
| terminus-2 |     61.0% |      36 / 59 | 2026-07-09 |
| **keel**   | **54.2%** |  **32 / 59** | 2026-07-08 |

Gap: 4 tasks (6.8 points). Not a strict ordering — keel solved 5 tasks terminus failed;
terminus solved 9 keel failed.

## What the run measured

keel ran under `KEEL_EVAL_DIRECT_EXEC`, the eval-only executor that bypasses the sandbox, so
these numbers reflect the agent loop (model orchestration, context, tools, loop control), not
policy enforcement. terminus has no sandbox either, so both sides ran ungoverned agent loops
on the same model and tasks — a capability comparison only.

This says nothing about the cost of enforcement: capability with the sandbox on was not
measured here. keel's security properties are evidenced separately — the security test
catalog, real OS sandbox-denial probes, and the tamper-evident audit chain.

**Eval-mode ≠ production, in two ways.** The eval-direct runtime (1) disables the sandbox
and (2) auto-promotes a backgrounded server (`nohup server &`) to a surviving lease so it
outlives keel's exit for the separate verifier — a convenience the shipped/governed binary
does **not** perform (production keeps a no-orphans teardown and only *advises* the model to
use an explicit lease). So a future eval "pass" on a task that needs a surviving service
reflects eval-harness behavior, not a shipped capability. (The 54.2% run above predates the
auto-promotion; it is noted here so later re-runs are not misread.)

## Methodology

- **59-task subset, not the full suite** — to cap API spend. Both harnesses ran the identical
  59 tasks (verified task-for-task).
- **Single trial (n=1), no retries** — also to cap spend. TerminalBench tasks are
  high-variance; a few points either way is noise. There is no error bar on these numbers.
- **Matched:** same model, same dataset, same 59 tasks. The runs were a day apart (keel
  2026-07-08, terminus 2026-07-09) on the same host class. Turn and time budgets were each
  harness's own defaults, not normalized.
- **Head:** keel as of 2026-07-08. `main` has moved since; this number is not re-verified on
  current `main`.

### Harness fixes during preparation

While preparing the run we used single-task executions to find and fix harness bugs (a
loop-breaker, a bash heredoc wedge, a daemon-survival issue). Those are merged code changes,
already reflected in the 54.2% — not added to it, and no task is counted twice. Passing tasks
were not re-run. An earlier working note showed ~57%; that was wrong — the three fixed tasks
were already wins in the 54.2% baseline, so counting them again double-counted. The number is
54.2%.

## Task-level detail

- **keel solved, terminus failed (5):** chess-best-move, count-dataset-tokens, db-wal-recovery,
  reshard-c4-data, tune-mjcf.
- **terminus solved, keel failed (9):** break-filter-js-from-html,
  financial-document-processor, hf-model-inference, kv-store-grpc, mailman,
  openssl-selfsigned-cert, pytorch-model-recovery, qemu-alpine-ssh, qemu-startup.

## Not yet done

- A multi-trial run (≥3) for an error bar.
- The full task suite.
- A current-`main` re-run.
- Capability measured with enforcement on.

This page is updated when those runs exist.

## Reproduce

The adapter and runner are in [`packages/eval`](../packages/eval). The run used the
TerminalBench harness against a keel binary with the eval-only direct executor
(`KEEL_EVAL_DIRECT_EXEC`), which is build-gated out of release binaries (see
[ADR-0021](adr/0021-executor-port.md)). Model `claude-sonnet-4-5-20250929`; dataset
`terminal-bench-2-1`, 59-task subset.
