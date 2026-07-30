import type { TaskStateT } from "@keel/shared";
import type { SummarizeInput } from "./compact.js";

/** Bound a single command string in an error line so a pathological command can't re-bloat the view. */
const brief = (s: string): string => (s.length > 120 ? s.slice(0, 119) + "…" : s);

/**
 * The deterministic, model-free compaction summarizer — the OQ-10 seam's production default for the
 * Epic 1.6c PR-d slice-5 flip. It maps the LEDGER-DERIVED facts (`deriveTaskFacts`: files read/modified
 * + command outcomes) straight into a `TaskState` with **no model call**:
 *
 * - **Honest by construction.** Every field traces to the ledger, so `validateTaskState` keeps all of
 *   it (nothing invented, no trust laundering — SEC-023). `validation` lands `passed`.
 * - **Goal-preserving.** `taskGoal` is recovered from the FIRST user message in the ledger, so the fold
 *   never drops the original task even though the user turn itself is folded into the summary.
 * - **Needle-preserving.** A FAILED command (non-zero exit / executor error) becomes a `currentError`,
 *   so a failing test/build survives the fold (§4.7.6).
 * - **Zero extra cost / reproducible.** No second model round-trip; identical ledger → identical summary.
 *
 * A richer model-authored prose summarizer (the full OQ-10) is a tracked follow-up, gated on the
 * ablation showing this facts-only summary regresses resolve rate — measure, don't assume.
 */
export function deterministicFactsSummary(input: SummarizeInput): TaskStateT {
  const { facts } = input;
  const firstUser = input.events.find((e) => e.type === "user");
  const taskGoal = firstUser !== undefined && firstUser.type === "user" ? firstUser.content : "";
  const failed = facts.commandOutcomes.filter((c) => !c.ok);
  const currentPhase =
    facts.filesModified.length > 0 ? "edit" : facts.filesRead.length > 0 ? "inspect" : "intake";
  return {
    taskGoal,
    // Lead with the substantive activity counts the resuming model anchors on (read/modified/ran);
    // no implementation tag — the model reads task state, not how the summary was produced.
    currentStatus: `${String(facts.filesRead.length)} file(s) read · ${String(facts.filesModified.length)} modified · ${String(facts.commandsRun.length)} command(s) run${failed.length > 0 ? ` · ${String(failed.length)} failing` : ""}`,
    currentPhase,
    constraints: [],
    plan: [],
    completedSteps: [],
    nextSteps: [],
    filesRead: facts.filesRead,
    filesModified: facts.filesModified,
    decisions: [],
    failedAttempts: [],
    testState: [],
    currentErrors: failed.map((c) => `command failed: ${brief(c.command)}`),
    blockers: [],
    artifactRefs: [],
    policyNotes: [],
    provenanceNotes: [],
    memoryCandidates: [],
    unresolvedQuestions: [],
  };
}
