# 0050 — Bash timeout recovery: terminate the command, keep the shell alive

**Status:** accepted
**Date:** 2026-06-20
**Relates to:** §4.3 (loop & tools), §4 (`ExecutorPort` swap-seam), §8.6 (kernel DX — one-line machine-
readable tool errors). Implements **Lever A** of the 2026-06-20 post-fix TB-2.1 analysis. The
executable evidence lives in the associated shell-session and timeout tests. This settles the
OS-privilege/process-handling assumption that the analysis flagged.

## Context

keel's bash tool runs one persistent `bash` (`PipeShellSession`, `shell-session.ts`) so that cwd, exported
env, shell vars, and activated venvs persist across commands — they live in that one long-lived process.
On a per-command timeout (default 120s) the session calls `recycle()`: it SIGKILLs the **whole** detached
process group (the shell included) and nulls `#child`, so the next command respawns a fresh `bash` at the
original root with a minimal env. **Every bit of accumulated cwd/env is lost.**

The post-fix benchmark analysis found this is keel's single most pervasive executor defect: it appeared in
~10 of 22 trials, **lost `mteb-leaderboard`** outright (a >120s `pip install mteb/datasets` was killed and
the shell reset on every retry, so the deliverable was never produced), and burned ~80% of one task's
wall-clock on repeated `python3 <<HEREDOC` resets. The reset is the *lazy-safe* recovery — it guarantees a
clean shell — but it throws away exactly the state a multi-step task depends on.

The fix must let a timeout **terminate only the timed-out command** while the persistent shell — and its
cwd/env — survive.

## Decision

On a per-command timeout, **terminate the command's process subtree and keep the shell process alive**, then
let the shell resync:

1. **Kill the shell's descendants, not the shell.** A new `ShellChild.killChildren()` enumerates every
   descendant process of the shell PID and signals them (SIGTERM → short grace → SIGKILL), **excluding the
   shell itself**. Enumeration is dependency-free: `/proc/<pid>/stat` PPID walk on Linux (production,
   linux-x64); `ps -A -o pid=,ppid=` parsed in-process on macOS (dev/CI). Commands keep running in the
   shell's foreground exactly as today, so builtins (`cd`, `export`, `source`, venv `activate`) still mutate
   the live shell.
2. **Resync on the marker.** With the foreground command's processes dead, the shell's own command line
   (`{ cmd ; } …; printf '\n%s:%s\n' marker $?`) completes naturally — `$?` is the kill's exit (≈137) — and
   the shell emits its marker. The session settles the run as `outcome: "timeout"` with the **shell retained**
   (cwd/env intact), ready for the next command.
3. **Fallback to the legacy reset if the shell wedges.** If the marker does not arrive within a bounded grace
   window, fall back to `recycle()` (SIGKILL the whole group + respawn) — the old behavior — so the session
   can **never hang**. A new `RunResult.shellReset` boolean is `true` only in this rare fallback; the bash
   tool renders "shell intact" vs "shell was reset (cwd/env lost)" accordingly.

`ExecutorPort` is untouched (the timeout/reset lives entirely in the adapter). No new dependency.

## Alternatives weighed

1. **Job control (`set -m`) + kill the foreground job's process group.** Each pipeline would get its own
   group we could `killpg`. **Rejected:** the foreground job's leader PID is not cleanly obtainable from
   outside the shell without *backgrounding* the command (`& ; wait $!`), and backgrounding breaks builtins —
   a backgrounded `cd`/`export` runs in a subshell and does **not** mutate the persistent shell, which defeats
   the entire purpose (cwd/env persistence).
2. **Snapshot cwd + env before each command, restore into a fresh shell after a reset.** **Rejected:**
   inherently lossy — it cannot capture shell functions, unexported vars, activated venvs, `trap`s, or
   background jobs. It would trade a total-loss bug for a silent partial-loss bug, which is worse (looks like
   it worked).
3. **`setsid` each command into its own session/group.** **Rejected:** `setsid` detaches the command so its
   builtins can't affect the shell — same `cd` breakage as (1).
4. **Vendor a tree-kill dependency (e.g. `tree-kill`, MIT).** **Rejected:** it kills the process tree
   *including the root* — the exact opposite of what we need (we must **exclude** the shell). A ~40-line
   descendant enumeration is simpler, dependency-free, and clears the AGENTS.md "no convenience dependency
   where a small stdlib implementation suffices" bar.

**Chosen:** (the descendant-subtree kill that keeps the shell) — the only option that preserves builtins
*and* targets just the command, with the legacy reset retained as a never-hang safety net.

## Process / OS assumptions this settles (the stop-and-ask)

- **Enumeration:** `/proc` PPID walk on Linux; `ps -A -o pid=,ppid=` on macOS — both ubiquitous; no
  capability beyond reading process metadata the agent already runs under.
- **Signalling:** `process.kill(pid, …)` per descendant, ESRCH ignored (already-gone). SIGTERM → grace →
  SIGKILL so well-behaved children can clean up; the existing `killGroup()` (whole-group SIGKILL) is retained
  for `dispose()`, abort, and the wedged-shell fallback.
- **Intentional detach preserved:** a deliberately detached daemon (`setsid <cmd> &`, a *new* session) is
  **not** a descendant of the shell and is intentionally **not** reaped — matching today's documented escape
  hatch for leaving a service running for a later grader check.
- **Residual risks (documented, not eliminated):** (a) a double-fork daemon that re-parents to `init` escapes
  the subtree — `setsid` is the supported intentional-daemon path, and the whole group is still reaped on
  `dispose()` at session end; (b) a process spawned *during* the kill could momentarily survive — mitigated
  by killing the full transitive subtree and the grace-window fallback; the no-orphan adversarial test gates
  this.

## Consequences

- **cwd/env survive a timeout** — a `cd`/`export`/venv-activate done before a slow command is no longer lost
  when that command is cut off; the model retries the slow step (or raises `timeoutMs`, or backgrounds it)
  from where it was.
- The **model-facing timeout message changes** from "the shell was reset (cwd/env lost)" to "the command was
  terminated; the shell and your cwd/env are intact" (and the legacy message only in the rare
  `shellReset: true` fallback). A minor model-facing contract change, covered by a golden assertion.
- The rare fallback **preserves today's exact behavior**, so the change is strictly an improvement: best case
  we keep the shell; worst case we do what we already did.
- Pairs with a complementary, lower-risk tuning (class-aware / raised default timeout) so resets fire far less
  often in the first place; the model-settable `timeoutMs` remains the override and the loop's per-tool infra
  backstop (660s) remains the run-level safety.
- No `ExecutorPort` or `@keel/shared` schema change; no new dependency.
