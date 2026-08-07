/** User-facing kernel strings — microcopy is a product surface (charter §6.4). */

/** Escalating loop-breaker guidance (F7 — **OPT-IN**, default off). The advisory loop-detection rail
 *  injects a nudge each time it trips; by default it repeats the flat L0 text (`loopGuidance`). When the
 *  caller opts in (`escalateGuidance` / `KEEL_LOOP_ESCALATION`) these levels push progressively harder —
 *  reconsider → rewrite the plan → switch strategy or honestly stop — while the rail stays NON-TERMINAL
 *  (Epic 1.13: advisory never halts; only the wording escalates). Default is flat because the bounded fix-validation run run
 *  measured the escalation net-negative (it regressed `tune-mjcf` + `schemelike`); the levels are kept so
 *  the behavior can be re-ablated. L0 is byte-identical to the flat single-trip guidance. */
const LOOP_GUIDANCE_L0 =
  "You appear to be repeating the same action without progress. Stop and reconsider your " +
  "approach: re-read the task and the latest output, form a different hypothesis, and try a " +
  "distinct step — do not repeat the previous action. If you cannot make progress, say so and stop.";
const LOOP_GUIDANCE_L1 =
  "You are STILL repeating similar actions after a prior nudge. Small variations are not working — " +
  "step back and rewrite your overall plan: name the actual blocker, then choose a fundamentally " +
  "different approach that avoids it. Do not make another minor variation of the same attempt.";
const LOOP_GUIDANCE_L2 =
  "Repeated attempts of this kind keep failing and are burning the budget. Either switch to a " +
  "fundamentally different strategy now, or — if you have genuinely exhausted your options — stop and " +
  "honestly report that you are stuck and why, instead of continuing variations that do not converge.";

export const KERNEL_STRINGS = {
  /** Persistent banner when running with no warden (honest-YOLO; §4.2, ADR-0016). */
  yoloBanner: "NO ENFORCEMENT — sandbox off, policy off, audit off",
  /**
   * General (not task-specific — borrowed-technique #2) pre-completion verification rubric injected
   * once on the first completion attempt (Epic 1.1b; **STOP-biased redesign, Epic 1.16**). Targets the
   * dominant *false-completion* mode (the model asserts "done" without running the checks). The prior
   * CONTINUE-biased prompt was measured net-negative (claim-ledger 2026-06-18): its open-ended
   * "otherwise continue and fix it" pushed cleanly-stopped models into re-work until they burned the
   * gross cap (clean-stops 7→2, +49% output, 2 regressions). This version is execution-grounded (prove
   * by running, don't assert) and biases hard toward confirm-and-stop — continue ONLY for a check that
   * demonstrably failed, with the smallest fix, then stop.
   */
  verificationPrompt:
    "Before you finish, prove the task is done — don't assert it. For each requirement in the ORIGINAL " +
    "task, run the concrete check that demonstrates it (the test, the command, the script — actually " +
    "execute it and read the output). If your checks pass, you are done: say so and stop. Only keep " +
    "working for a requirement that demonstrably fails a check you just ran — make the smallest fix for " +
    "that specific failure, then stop. Do not refactor, polish, or re-verify work that already passed.",
  /**
   * Sharper, execution-grounded variant of `verificationPrompt`, injected when the model declared done
   * having only *inspected* its work (read/grep/ls) or run nothing at all (Epic 1.19 / Lever B). Same
   * STOP-bias (say-so-and-stop / smallest-fix-then-stop) — it does not invite open-ended rework — but it
   * names the specific gap (you have not run it) and removes the usual excuse (a missing toolchain is
   * installable), while still allowing a genuinely non-runnable deliverable to be confirmed-and-stopped.
   */
  verificationPromptUnverified:
    "Before you finish: you have not actually run your work this session — only inspected it (read / " +
    "grep / ls). Don't assert it's done; PROVE it. Run the concrete check that exercises each requirement " +
    "in the ORIGINAL task — execute the test, the command, or the deliverable itself, and read the output. " +
    "A missing interpreter or tool is installable (apt-get / pip / uv); 'I couldn't run it' is not a reason " +
    "to skip. If a check passes, say so and stop. If your deliverable genuinely cannot be executed (it is a " +
    "config or data file), confirm it matches the task's exact spec and stop. Only keep working for a check " +
    "that demonstrably fails — make the smallest fix for that specific failure, then stop.",
  /**
   * Injected when loop detection trips (Epic 1.1c). Tells the model to step back rather than keep
   * repeating; if a non-advisory loop persists after the forced-pivot rung, the run halts. `loopGuidance`
   * is BOTH the first-trip text and (by default) every advisory-trip text; non-advisory forced pivots use
   * `loopGuidanceEscalations[1]`. The advisory rail escalates through `loopGuidanceEscalations` on
   * successive trips only when `escalateGuidance` is opted in (F7), staying non-terminal.
   */
  loopGuidance: LOOP_GUIDANCE_L0,
  /** Advisory-trip-indexed escalation of `loopGuidance` (F7 — used only when `escalateGuidance` is opted
   *  in); the trip index clamps to the strongest level. */
  loopGuidanceEscalations: [LOOP_GUIDANCE_L0, LOOP_GUIDANCE_L1, LOOP_GUIDANCE_L2],
  /** Synthetic tool-result for calls skipped because loop detection tripped mid-turn (1.1c hardening). */
  loopSkipped: "skipped: loop detected — this call was not run while you reconsider your approach.",
  /** Injected after a provider `finish_reason="length"` so the next response is complete and safe. */
  lengthContinuation:
    "The previous response hit the output limit and was discarded before any tool call could run. " +
    "Continue from the last complete state, be concise, and emit any needed tool call in a complete " +
    "response. Do not repeat work that already succeeded.",
  /** Injected once when a provider returns an empty clean stop before any assistant content/tool call. */
  emptyAssistantStopContinuation:
    "The previous assistant response was empty, so keel could not treat it as a completed answer. " +
    "Continue from the last complete state now: either provide the final answer with the evidence you have, " +
    "or emit the next needed tool call. Do not return an empty response.",
  /**
   * One bounded, tool-disabled synthesis pass after terminal review, but only when the loop already
   * has successful typed read/search evidence. This cannot authorize or retry the reviewed action;
   * it lets the model answer from completed observations while reporting any blocked remainder.
   */
  terminalReviewSynthesis:
    "An action just reached terminal review and was not executed. Tools are disabled for this final " +
    "pass: do not call or retry them. Answer the user's original request now using only the successful " +
    "read/search evidence already completed. Clearly state any material limitation caused by the " +
    "blocked action. Do not offer an approval path or claim the action ran.",
  /**
   * One model-driven correction after a terminal no-handle result. The controller never derives a
   * shell rewrite: the model may choose one fresh atomic action, which remains Warden-gated.
   */
  terminalReviewRecovery:
    "The Warden confirmed the last action was not executed and no live decision exists. You have " +
    "one model-driven recovery attempt. Choose at most one smaller atomic tool call that preserves " +
    "the task intent, using exact Warden guidance already in the result when present. Do not repeat, " +
    "split, normalize, or mechanically rewrite the original action; do not invent approval or emit " +
    "multiple calls. The fresh call is still Warden-gated. If no safe call exists, state the exact " +
    "remaining work and stop.",
  /** Tool-disabled closeout after the sole bounded correction call completes. */
  terminalReviewRecoveryFinalization:
    "The one bounded correction attempt is complete. Tools are disabled. Report the observed result " +
    "and the exact remaining work. Do not claim the original reviewed action ran, and do not offer " +
    "another retry or approval path.",
  /** Controller-owned reason when Autopilot reaches exact-domain review without matching authority. */
  autopilotEgressReviewBoundary:
    "Autopilot did not auto-resolve this egress review because no matching exact-domain grant was active",
  /** Controller-owned reason for review shapes outside Autopilot's exact command-envelope lane. */
  autopilotIneligibleReviewBoundary:
    "Autopilot did not auto-resolve this review because only Warden-supplied exact command-envelope reviews are eligible",
  /** Fail-closed copy when a reviewed occurrence returns a non-terminal result after its deadline. */
  reviewDeadlineLateOutcome:
    "review outcome completed after the tool deadline; action may have executed; do not retry automatically; restart the governed session and inspect audit",
  /** Fail-closed copy when the reviewed occurrence's late result cannot be recovered. */
  reviewDeadlineOutcomeUnavailable:
    "review outcome unavailable after the tool deadline; action may have executed; do not retry automatically; restart the governed session and inspect audit",
  /** Fail-closed copy when an attempted approval still returns a pending review verdict. */
  reviewResolutionStillPending:
    "review resolution remains pending; do not retry automatically; restart the governed session before deciding again",
  /** Tool-result when the run was already cancelled before the tool ran (1.1e hardening). */
  toolAborted: "aborted: the run was cancelled before this tool executed.",
  /**
   * Process-local presentation settlement for an activity still open at the canonical end of a run.
   * `run-finished` proves only that the activity is no longer live; without a tool result it does not
   * establish whether execution started or what effects occurred.
   */
  toolResultMissingAtRunEnd:
    "indeterminate: run ended before a tool result was recorded; Keel cannot prove whether execution started or what effects occurred. Inspect the workspace and available audit evidence before retrying.",
} as const;

/**
 * Budget-awareness warning injected at a usage threshold (Epic 1.1d). Agents are poor
 * at time/budget estimation; a remaining-budget nudge pushes them to finish + verify.
 */
export function budgetWarningMessage(usedTokens: number, maxTokens: number): string {
  const remaining = Math.max(0, maxTokens - usedTokens);
  return (
    `Budget notice: effective-cost budget ~${String(usedTokens)} of ${String(maxTokens)} tokens used ` +
    `(~${String(remaining)} remaining). Prioritize finishing and verifying the task now — ` +
    `wrap up, avoid unnecessary steps, and make sure the result is correct before you run out.`
  );
}

/** Visible + model-visible cumulative gross-token runway warning. Unlike the effective-cost budget,
 * gross usage is a non-reclaimable emergency backstop; a fresh physical run receives a fresh cap. */
export function grossRunwayWarningMessage(usedTokens: number, maxTokens: number): string {
  const remaining = Math.max(0, maxTokens - usedTokens);
  return (
    `Gross-token runway notice: ~${String(usedTokens)} of ${String(maxTokens)} cumulative tokens used ` +
    `(~${String(remaining)} remaining). Finish the current path now. If another request cannot fit, ` +
    `Keel will stop before calling the provider; run keel --continue for a fresh budgeted run using ` +
    `the saved session evidence.`
  );
}

/** Controller-owned terminal guidance when the next request input cannot fit inside gross runway. */
export function grossRunwayPreflightMessage(input: {
  readonly usedTokens: number;
  readonly maxTokens: number;
  readonly estimatedInputTokens: number;
}): string {
  const remaining = Math.max(0, input.maxTokens - input.usedTokens);
  return (
    `Gross-token runway stopped before another provider call: ~${String(input.usedTokens)} of ` +
    `${String(input.maxTokens)} used (~${String(remaining)} remaining); the next request is estimated ` +
    `at ~${String(input.estimatedInputTokens)} input tokens before any answer. Prior tool and test ` +
    `evidence is saved. Run keel --continue for a fresh budgeted run.`
  );
}

export function turnLimitFinalizeMessage(input: {
  readonly maxTurns: number;
  readonly finalizeTurn: number;
  readonly maxFinalizeTurns: number;
  readonly evidence: string;
}): string {
  return (
    `Turn limit notice: reached the main cap of ${String(input.maxTurns)} turns, but recent ` +
    `typed progress was observed (${input.evidence}). Finalize turn ${String(input.finalizeTurn)} ` +
    `of ${String(input.maxFinalizeTurns)} is allowed. Finish the current successful path, run only ` +
    "essential final checks, and stop with evidence. Do not start a new broad approach."
  );
}

export function turnLimitProgressRunwayMessage(input: {
  readonly maxTurns: number;
  readonly progressRunwayTurn: number;
  readonly maxProgressRunwayTurns: number;
  readonly evidence: string;
}): string {
  return (
    `Turn limit notice: reached the main cap of ${String(input.maxTurns)} turns, but current ` +
    `verifier/build progress was observed (${input.evidence}). Progress runway turn ` +
    `${String(input.progressRunwayTurn)} of ${String(input.maxProgressRunwayTurns)} is allowed. ` +
    "Continue only the current progressing path, run the next essential step, and stop as soon as " +
    "the result is verified. Do not start a new broad approach."
  );
}

export function knownRedCompletionMessage(input: {
  readonly command: string;
  readonly detail: string;
}): string {
  return (
    "Known visible verification is still red. A real check failed and no later observed pass from " +
    `the same normalized command cleared that red signal. Command: ${input.command}. Failure: ` +
    `${input.detail}. Fix only the observed failure or rerun the same relevant check after your ` +
    "fix. Do not declare completion while this red signal is still current."
  );
}

/**
 * Structured result fed back to the model when a tool exceeds its infra deadline
 * (Epic 1.1e). Recovery is model-driven (§4.3): tell it not to wait again and to try
 * a different approach.
 */
export function infraTimeoutMessage(toolName: string, ms: number): string {
  return (
    `infra-timeout: tool '${toolName}' did not return within ${String(ms)}ms. ` +
    `Do not wait on it again — try a smaller step or a different approach.`
  );
}
