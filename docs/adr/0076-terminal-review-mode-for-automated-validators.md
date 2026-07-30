# ADR-0076 — Terminal review mode for automated validators

**Status:** Accepted by owner direction on 2026-07-19 for Epic 3.8e. The owner approved fixing all
reproduced launch blockers and required production-grade downstream review. Packaged live Sonnet
dogfood then exposed the exact integration failure this decision closes.

**Date:** 2026-07-19

## Context

`/loop` runs a model turn and then evaluates its exit command through the governed `ExecutorPort`.
The interactive review controller is connected for the model turn and deliberately disconnects when
that turn ends. A review-required model tool call therefore has a visible, actionable approval panel.

The exit check runs immediately afterward. Before this decision it used the same executor without
declaring that no interactive decision surface remained. If the warden returned `review`, the
executor called the live approval hook. The controller stored the pending review but had no connected
presentation or input consumer, so the packaged TUI appeared idle while the bounded loop hung. The
warden correctly did not execute the command, but the product offered neither a visible decision nor
a terminal receipt. Earlier unit tests injected an already-rendered `ok:false` result and missed this
cross-boundary lifecycle.

Automatically approving the check, leaving the review pending, treating it as predicate-false, or
reconnecting a hidden approval panel would all be wrong. A loop predicate must not manufacture human
authority or consume another model turn when its evidence was never produced.

## Decision

Add an optional in-process execution context to `ExecutorPort`:

```ts
approvalMode?: "interactive" | "terminal"
```

- Omitted/`interactive` preserves existing model-tool behavior and the live approval controller.
- `terminal` still performs normal warden policy, sandbox, side-effect, audit, and exact existing
  session/project/Autopilot grant checks. It only forbids opening a *new* human-review prompt.
- If the final warden verdict remains `review`, the executor explicitly resolves the pending review
  as `approved:false` and returns terminal `ok:false`, not-executed guidance. A terminal validator
  must never strand authority merely because its human decision surface has detached.
- Bounded loop exit checks always request `terminal` mode because they execute after the turn-owned
  interactive controller disconnects.
- Interactive review abandonment follows the same settlement invariant. An absent decision hook,
  undefined decision, thrown hook, cancellation, unavailable requested scope, or already-aborted turn
  submits one denial using a fresh non-aborted control signal. The runtime retains a local principal
  only for denial settlement; this does not confer approval, grant, or Autopilot authority.
- A settled denial is presented and persisted as `blocked`, with explicit not-executed and
  no-review-pending recovery. It must not render `review needed` or advertise `/reviews` as a live
  surface after settlement.
- This option is process-local. It adds no RPC field, policy input, verdict, grant, audit/session
  record, CLI syntax, serialized schema, or provider-visible authority.

## Consequences

- A review-required loop check stops visibly after one model iteration instead of hanging or
  retrying.
- Cancellation, hook failure, and disconnected-controller paths close the warden's pending review
  instead of leaving stale authority in `/reviews` or session resume.
- Existing exact grants can still satisfy an automated check; the option does not downgrade an
  already-authorized command.
- Executors that never support interactive review may ignore the additive option without changing
  results. `WardenExecutor` is the authoritative implementation and must test that its live hook is
  not called in terminal mode.
- Future automated validators, health checks, or receipt probes must explicitly choose terminal mode
  whenever no connected human decision surface exists.

## Rejected alternatives

- **Treat `review` as a false predicate.** The check did not run; retrying would spend turns without
  evidence and could repeat an indeterminate side effect.
- **Return not-executed without settling the review.** This leaves a live pending authority object
  behind after the only decision surface has detached. Explicit denial is the fail-closed terminal
  settlement and is now required.
- **Keep the turn UI connected across the exit check.** This couples model-turn input/streaming
  lifecycle to control validation and makes loop receipts depend on a hidden second interaction
  phase.
- **Remove live approval from the executor globally.** This would regress the intentional approval
  path for model-requested actions.
