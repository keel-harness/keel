# ADR-0088 — Progress-earned terminal-review recovery

- **Status:** **Proposed — maintainer decision required.** No implementation is authorized by this
  record until the maintainer accepts it and explicitly authorizes issue #145.
- **Date:** 2026-08-05.
- **Decider:** keel maintainer (pending).
- **Governs:** the process-local controller budget for model-authored correction after a
  non-grantable terminal-review result. Relates to ADR-0076 (terminal review after UI disconnect),
  ADR-0087 (controller-owned bounded settlement), MASTER_SPEC Appendix D `POL-003`, and issues
  [#139](https://github.com/keel-harness/keel/issues/139),
  [#144](https://github.com/keel-harness/keel/issues/144), and
  [#145](https://github.com/keel-harness/keel/issues/145).

This is a controller reliability and usability decision, not a security authority. It changes no
Warden verdict, policy rule, sandbox, egress decision, grant scope, RPC method, audit record,
frozen tool contract, command bytes, provider adapter, or public CLI surface.

## Context

Issues #139 and #144 introduced one tightly bounded recovery from a terminal-review result for which
no live human decision exists. The controller may ask the model for one fresh correction; that
correction remains an ordinary advertised tool call, goes through the Warden unchanged, must succeed
alone, and cannot recurse. A successful correction now returns to ordinary Warden-gated work.

The corrected R25 live replay on exact installed candidate `3b21d2a` exposed a later lifecycle
failure. An early compound tool-availability probe reached `POL-003` terminal review. Its atomic
model-authored correction succeeded, after which the model made two successful typed edits to the
external workspace. A later focused test command again reached correct, non-grantable,
non-pending `POL-003` review. The task-global `terminalReviewRecoveryAttempted` flag was already
spent, so Keel stopped `BLOCKED_AFTER_SYNTHESIS` despite the intervening authoritative mutation.

The failed run made 31 provider routes and cost USD 0.85785450. It preserved an honest partial diff
but did not execute the red test, implement the feature, update the changelog, or verify the result.
Restarting would repeat costly repository acquisition and work already proven by controller-owned
tool results.

The Warden behaved correctly in both cases. MASTER_SPEC Appendix D requires unknown or obfuscated
shell shapes to receive review plus simpler-command guidance. The defect is that the controller's
single lifetime credit cannot distinguish a repeatedly stuck agent from an agent that recovered,
made verified progress, and later encountered one independent command-shape review.

## Decision criteria

An acceptable design must satisfy all of these together:

- retain fail-closed `POL-003` and every Warden, sandbox, egress, and audit decision;
- execute only fresh, unchanged, model-authored tool calls through the ordinary executor;
- make the recovery budget finite, process-local, task-scoped, deterministic, and testable;
- require controller-observed successful progress before any additional credit exists;
- prevent reads, searches, prose, opaque bash, failures, no-ops, or correction success from earning
  credit;
- preserve sole-call success, sibling rejection, cancellation, timeout, turn, cost, loop, and
  finalization bounds;
- never infer semantic equivalence between an original command and a correction; and
- remain byte-behavior-identical for tasks that do not encounter the second eligible review.

## Options considered

### Option 1 — one progress-earned refresh, with a hard task cap of two corrections

Start with the existing single recovery credit. After that correction succeeds alone and ordinary
work resumes, exactly one successful typed workspace mutation may earn exactly one additional
credit. The task can therefore execute at most two bounded corrections and can refresh at most once.

**Selected if this ADR is accepted.** It addresses the observed failure with a small local state
transition, derives eligibility from controller-owned tool results, and retains a strict finite cap.

### Option 2 — classify non-grantable review as deny

**Rejected.** It would erase the distinction required by Appendix D, change Warden-visible policy
semantics globally, and turn a recoverable command-shape problem into a terminal refusal.

### Option 3 — broaden the `POL-003` allow classifier

**Rejected.** Both observed commands contained avoidable compound shell syntax. Teaching the
controller to survive one later review does not justify weakening or widening policy classification.

### Option 4 — have the controller rewrite or split the command

**Rejected.** Command construction belongs to the model. Rewriting shell text could alter quoting,
ordering, redirection, environment, or side effects and would violate the exact-command authority
boundary.

### Option 5 — keep the current one-per-task budget and require restart

**Rejected.** The live replay proves this is honest but materially unreliable and expensive after
meaningful progress. A restart also loses the user's ability to distinguish new work from repeated
context acquisition.

### Option 6 — refresh on any successful tool result or elapsed work

**Rejected.** Reads, searches, version probes, prose, and opaque bash can be repeated without moving
the user's task forward. Time, token spend, and model self-report are not authoritative progress.

## Proposed decision

Adopt a process-local **progress-earned terminal-review recovery budget** with one initial credit,
at most one refresh, and at most two correction attempts for the entire ordinary task.

### 1. State machine and accounting

The controller maintains explicit local state equivalent to:

```text
correctionAttempts = 0
refreshEarned = false
refreshConsumed = false
eligibleProgressSeen = false
```

The transitions are:

```text
first eligible terminal review
  -> consume initial credit; correctionAttempts = 1
  -> request one fresh model-authored sole correction

sole correction succeeds authoritatively
  -> return to ordinary advertised tools

successful eligible typed mutation after that return
  -> eligibleProgressSeen = true
  -> if refresh not previously earned or consumed: refreshEarned = true

later eligible terminal review with refreshEarned
  -> consume refresh; refreshEarned = false; refreshConsumed = true
  -> correctionAttempts = 2
  -> request one fresh model-authored sole correction

any later terminal review
  -> existing terminal synthesis or stop path; no third correction
```

The first correction does not itself earn the refresh. Progress before the first correction does not
pre-earn it. Multiple mutations cannot accumulate credits. The second successful correction cannot
earn another refresh. State is neither serialized nor carried into another user task or process.

### 2. Eligible progress is narrow and controller-observed

V1 eligible progress is a tool result that satisfies all of the following:

- it occurs during resumed ordinary work after the first sole correction succeeded;
- the advertised tool name is exactly `edit` or `write`;
- the executor result is authoritative and `ok: true`;
- the call was not skipped, stopped, timed out, terminally reviewed, or part of a bounded correction;
  and
- the existing typed tool contract reports successful completion.

The controller does not parse model prose or bash output to infer a mutation. It does not award a
credit for `read`, `search`, `bash`, MCP, interactive console, failed typed mutations, skipped
siblings, controller synthesis, or the correction call itself.

The existing `edit` tool rejects identical old/new text and fails when its exact old text is absent
or ambiguous, so those no-op and failed paths cannot earn credit. The existing `write` tool performs
an atomic replacement or creation before it reports success; even equal authored bytes are an
actual filesystem replacement, not a controller-invented progress fact. This ADR does not upgrade
that fact into a claim that the resulting content differs from a prior file. The implementation must
not parse prose or add a read/compare race to infer semantic change. Expanding eligible tools
requires a later decision with equivalent authority analysis.

### 3. Every correction keeps the existing safety envelope

Each of the at most two corrections:

- is requested by controller guidance but authored as one fresh model tool call;
- uses the ordinary advertised tool set and normal Warden/executor path;
- executes the model-authored name and arguments exactly once and unchanged;
- succeeds only when it is the sole call and existing authoritative success checks pass;
- skips siblings and closes the correction through the existing tool-disabled finalization path;
- cannot recursively recover if it is reviewed, denied, timed out, cancelled, ambiguous, failed, or
  accompanied by another call; and
- remains subject to ordinary turn, token, wall-clock, loop, interruption, and enforcement-liveness
  controls.

No approval is created or remembered. The original reviewed action remains not executed. A fresh
reviewed correction is still terminal. Existing blocked-action accounting and recovered-tool
presentation must reconcile each occurrence without hiding either original non-execution.

### 4. Presentation must expose the bounded state honestly

Controller guidance for an earned second opportunity must say that verified typed progress earned
the task's final correction, that only one fresh call is permitted, and that no further recovery is
available. TUI, headless output, recorded history, resume projection, and final synthesis must not
describe the original reviewed action as approved, denied, or executed.

The visible result after a successful second correction may say `recovered` only for that exact
occurrence. If the second correction fails or is reviewed, the result remains blocked and the exact
remaining work stays visible. No provider-derived status overrides controller and audit truth.

## Required implementation evidence

Implementation begins red-first and is not complete until all of the following pass:

1. first review -> sole successful correction -> successful typed `edit` -> later review -> one
   second correction -> ordinary work and final answer;
2. the same path with typed `write`;
3. no refresh for read, search, prose, bash, MCP, interactive console, failed mutation, skipped
   mutation, mutation before the first correction, correction success alone, or sibling mutation;
4. only one refresh after multiple eligible mutations, and never a third correction;
5. second correction review, failure, sibling, timeout, abort, Warden loss, and turn/budget exhaustion
   all close through existing terminal paths without recursive recovery;
6. exact command bytes and normal Warden execution are preserved for both corrections;
7. live and resumed TUI/headless history reconcile two distinct recovered occurrences without
   hiding blocked originals;
8. contract-absent and one-review task traces remain unchanged; and
9. property coverage proves `correctionAttempts <= 2`, refresh count `<= 1`, and no transition from
   non-eligible results can make a credit available.

Targeted loop, executor, presentation, session/resume, headless, and real-Ink tests must pass before
the full repository coverage, lint, typecheck, format, build, package, security, and real-sandbox
gates. Exact installed-carrier validation must repeat the failed external workflow at 100x30. At
least USD 2 of the existing Anthropic cap remains protected for final regression; no provider call
is authorized merely by accepting this ADR.

## Consequences

If accepted:

- a task that proves real typed mutation progress may survive one independent later terminal review;
- a stuck or repeatedly shape-unsafe task still terminates after a small fixed number of attempts;
- Warden policy and exact-command authority remain unchanged;
- controller state and presentation gain additional edge cases that require focused and property
  coverage; and
- the feature workflow can be replayed without forcing a full paid restart after the observed state.

This decision does not promise flawless model command selection, automatic command repair, task
completion after arbitrary reviews, fewer Warden decisions, semantic mutation detection, or
cross-process recovery-credit durability. Those claims remain out of scope.
