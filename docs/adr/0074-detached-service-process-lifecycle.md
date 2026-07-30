# ADR-0074 — Detached / long-lived service process lifecycle

- **Status:** **Proposed** (2026-07-18). A **stop-and-ask** decision: it concerns production
  process-lifecycle behavior, the OS-sandbox model, and the scope of the no-orphan invariant
  (ADR-0023). Recorded before any production behavior change, for maintainer approval. It creates
  **no new security claim**.
- **Date:** 2026-07-18.
- **Deciders:** keel maintainer (proposed by Claude Opus 4.8 after a code-verified investigation of
  the kernel and warden process models).
- **Governs:** the lifecycle of processes a model backgrounds (`nohup server &`, `setsid … &`,
  bare `cmd &`) and whether/how a service may outlive the command — or the run — that started it,
  in each execution mode. Relates to ADR-0021 (ExecutorPort), ADR-0023 §3 (bash process model and
  the honest scope of the no-orphan guarantee), ADR-0050 (bash timeout recovery / kill semantics),
  ADR-0069/0070 (warden interactive console), and ADR-0005 (vendored sandbox-runtime). It does
  **not** touch a frozen interface.
- **Anchor:** the process-lifecycle investigation recorded in this ADR.

## Context

A recurring pattern: the model launches a background service (`nohup python app.py &`) expecting a
**separate later process** to reach it — in the eval harness the grader/verifier is a distinct
process; in real use it is a subsequent tool call or test. When the launching command is torn down,
the service dies before the consumer connects, and a correct implementation scores as a failure.

The naive framing — *"honor `nohup`/`setsid` detach so the service survives, like a normal shell"* —
does not survive contact with the code. keel has **three distinct execution modes** with three
different, code-verified process models:

### 1. Kernel `LocalExecutor` (Phase-1 honest-no-enforcement; also the eval-direct runtime)

A persistent `PipeShellSession` (`bash --norc --noprofile`) spawned **detached as a process-group
leader** ([shell-session.ts:226-234](../../packages/kernel/src/tools/shell-session.ts)). Teardown:

- `killGroup()` on `dispose()` SIGKILLs the **whole shell process group**
  (`process.kill(-pid, "SIGKILL")`, [shell-session.ts:251-261](../../packages/kernel/src/tools/shell-session.ts));
  `dispose()` runs at run end ([session-entry.ts:1579](../../packages/kernel/src/cli/session-entry.ts)).
- A plain `nohup cmd &` / bare `cmd &` stays in the **shell's** group → SIGKILLed at dispose.
- A `setsid cmd &` daemon is a **new session, not a descendant**, so it is *intentionally left
  running* but **unmanaged** — no cleanup owner ([shell-session.ts:266-268](../../packages/kernel/src/tools/shell-session.ts);
  the bash tool spec calls detached processes "unmanaged unless started through the structured
  `lease` argument", [bash.ts:49](../../packages/kernel/src/tools/bash.ts)).
- The **`lease`** path (`startLeased`) launches the command under `setsid` with a recorded pid and
  a cleanup owner, scope `until-verifier-handoff`
  ([shell-session.ts:530-565](../../packages/kernel/src/tools/shell-session.ts);
  scopes in [process-lease.ts:6](../../packages/kernel/src/tools/process-lease.ts)) — so it both
  survives and is reap-able by the kernel.
- **Eval-only auto-lease (ADR-precedent, shipped):** in the eval-direct runtime *only*, a
  safely-rewritable backgrounded server is auto-promoted to that lease
  ([bash.ts](../../packages/kernel/src/tools/bash.ts), `autoLeaseBackgroundedServices`; set only by
  `createEvalDirectRuntime`, which is build- and run-time-gated per
  [eval-executor-gate.ts](../../packages/kernel/src/cli/eval-executor-gate.ts)). It is honest
  because eval-direct uses `new LocalExecutor()`
  ([runtime.ts:296](../../packages/kernel/src/cli/runtime.ts)) — **no warden, no sandbox** — so a
  `setsid` survivor is possible.

### 2. Governed (warden) mode — the production path

The kernel spawns an out-of-process warden; **`packages/warden` contains no `createBashTool` and no
`PipeShellSession`**. Every governed `bash` call is a **one-shot, per-command spawn** in its own
process group ([rpc-server.ts:2955](../../packages/warden/src/rpc-server.ts);
[srt-sandbox.ts:279-285](../../packages/warden/src/srt-sandbox.ts) — detached on POSIX), sandboxed
by the vendored sandbox-runtime. Two facts are load-bearing:

- **Governed bash explicitly rejects the `lease` argument**
  ([rpc-server.ts:399-402](../../packages/warden/src/rpc-server.ts): *"governed bash does not support
  service/job leases"*). The kernel's survivor mechanism does not exist in the warden.
- The process group is SIGTERM→SIGKILL'd **only on abort** (interrupt / warden teardown / stdin-EOF),
  **never on normal command completion** ([srt-sandbox.ts:311-354](../../packages/warden/src/srt-sandbox.ts);
  the `executionAbort` controller, [rpc-server.ts:5286-5419](../../packages/warden/src/rpc-server.ts)).

And the sandbox itself makes background survival **platform-asymmetric**:

- **Linux (bwrap):** the wrap uses `--unshare-pid --proc` + `--die-with-parent`
  ([linux-sandbox-utils.ts:1245,1379](../../vendor/sandbox-runtime/src/sandbox/linux-sandbox-utils.ts)),
  so the sandboxed bash is **init (PID 1) of a private PID namespace**. When it exits, the kernel
  tears down every process in the namespace. A backgrounded service **cannot outlive the command by
  construction.** This is a containment *feature*.
- **macOS (seatbelt):** `sandbox-exec` applies a syscall/policy profile only — **no PID namespace,
  no `--die-with-parent` analogue** ([macos-sandbox-utils.ts:887-898](../../vendor/sandbox-runtime/src/sandbox/macos-sandbox-utils.ts)).
  A fully-detached `nohup server &` from a **normal** (non-aborted) governed command is **not** reaped
  on completion; it lingers until the next warden abort group-kill. This is an inconsistency with
  Linux and an uncontrolled-orphan gap.

### 3. The only warden "survives the run" primitive

The interactive-console tmux broker (ADR-0069/0070) deliberately lets a **released** console session
outlive teardown via an explicit continuation-grant
([tmux-broker.ts:814-857](../../packages/warden/src/interactive-console/tmux-broker.ts);
[broker.ts:21-28](../../packages/warden/src/interactive-console/broker.ts)). It is warden-mediated,
policy-gated, and audited — and it is a **different tool** from bash, for interactive PTY work.

### The invariant that is (and is not) at stake

The no-orphan guarantee is **already scoped** to exclude intentional backgrounding. ADR-0023 §3:
*"The no-leak guarantee covers runaway/timeout/abort, **not** intentionally-backgrounded jobs (the
model's choice)"* ([0023:18](0023-epic-1.2-tool-dependencies.md)); MASTER_SPEC's "no orphan
processes" is scoped to `bash` **timeout** ([MASTER_SPEC.md:1012](../../MASTER_SPEC.md)). **No claim
in the claim ledger asserts "no surviving background service after a governed run."** So Option A is
less a *violation* of a guarantee than a decision about processes the guarantee already excludes.

## Options

1. **Keep governed bash lease-free + document the model + fix the macOS asymmetry.** The per-command
   disposable sandbox (a PID namespace on Linux) is the containment guarantee, not a bug to soften.
   Services that must outlive their launcher use the **same-command pattern** (start the service and
   run the checks in one `bash` call, so it lives for that command) or, for interactive/PTY needs,
   the **governed interactive console**. The one concrete code change is to **reap the command's
   subtree on normal completion on macOS too**, matching Linux — closing the uncontrolled-orphan gap
   and giving cross-platform parity. This **tightens** containment; it never loosens it.

2. **Build a warden-mediated service-lease primitive.** A new *governed* capability that runs a
   service in a separate, warden-owned, longer-lived sandboxed context (outside the per-command
   sandbox), reaped by the warden, gated by policy and audit — modeled on the interactive-console
   broker + continuation-grant. A real feature; significant; the *correct* way to support governed
   long-lived services **if and when** that becomes a product requirement.

3. **Honor detach idioms inside governed bash (the naive "Option A").** Let `nohup &`/`setsid &`
   survive a governed run "like a normal shell." **Rejected:** structurally impossible on governed
   Linux (the PID namespace tears the subtree down regardless), inconsistent to do on macOS only, and
   it would weaken the containment the per-command sandbox exists to provide.

## Decision (proposed)

1. **Reject Option 3.** Governed bash stays **lease-free** and **per-command-sandboxed**; the
   disposable PID namespace is a containment feature. keel will not add an in-bash mechanism to make
   `nohup &`/`setsid &` survive a governed run.
2. **Adopt Option 1 now:**
   - **Document** the model honestly: in governed mode a service does not outlive the command that
     started it; use the same-command pattern, or the interactive console for interactive work.
   - **Fix the macOS↔Linux asymmetry** (a separate, TDD'd slice): reap a governed command's process
     subtree on **normal** completion on platforms without a PID-namespace teardown, so a detached
     background process cannot linger uncontrolled — parity with Linux, and a **tightening** of the
     no-orphan posture, never a loosening.
   - **Keep** the eval-only auto-lease (it fixes the eval-measurement artifact, is gated to the
     warden-bypassing runtime, and is disclosed in `docs/benchmarks.md`); **keep** the production
     advisory hint.
3. **Defer Option 2** until a real product need for governed long-lived services appears. If built,
   model it on the interactive-console broker + continuation-grant — warden-mediated, policy-gated,
   audited, with explicit cleanup ownership — **not** a softening of per-command teardown, and with
   no "governed service isolation" claim until structure + tests prove it.

## Consequences

- **Positive:** honest and containment-preserving; no security property is weakened; the only code
  change (macOS reap) *tightens* the no-orphan posture and removes a real cross-platform
  inconsistency. The eval measurement is already honest and disclosed.
- **Cost / limitation:** a model that wants a service to outlive a governed command must use the
  same-command pattern or the interactive console. This is a documented limitation, not a defect —
  it is the direct consequence of per-command sandbox isolation.
- **Stop-and-ask surface (for the macOS-reap slice):** it touches the warden sandbox runner
  (`srt-sandbox.ts` / the vendored sandbox-runtime boundary) and process-lifecycle behavior, so it
  is its own slice with red-first no-orphan / denied-path tests + a macOS `test:sandbox:real` probe
  asserting a detached child does not outlive a normal governed command, and a check that **Linux
  behavior is unchanged** (the namespace already reaps). It is **not** bundled with this ADR.
- **Honesty:** no new security claim is created here. Any future Option-2 primitive must earn its
  claims with executable evidence.

## Non-goals

- Honoring bare `nohup &` / `setsid &` survival inside governed bash (Option 3 — rejected).
- A general process daemon / scheduler; scheduled/long-lived run structures are already deferred
  (ADR-0060 defers scheduled loops to Phase 5+).
- Changing the eval-only auto-lease (already shipped and scoped; ADR-0021 / eval-executor gate).
- Editing the frozen audit/RPC contracts.

## Implementation implications (only if Option 1's macOS-reap slice is approved)

- **macOS reap:** in the warden Node runner ([srt-sandbox.ts](../../packages/warden/src/srt-sandbox.ts)),
  on platforms without PID-namespace teardown, group-kill the command's subtree on the **normal
  `close`** path (today only the `onAbort` path group-kills). The runner already spawns detached with
  an injectable `spawn`/`kill`, so every branch is unit-testable without real processes (per
  ADR-0050's dependency-injection pattern), plus one macOS real-sandbox probe. Assert Linux is
  byte-for-byte unchanged.
- **Docs:** note the governed-service limitation and the same-command pattern in the MASTER_SPEC bash
  section and the getting-started / policy guides.
