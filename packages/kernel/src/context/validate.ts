import type { SessionEventT, TaskStateT } from "@keel/shared";
import { deriveTaskFacts } from "./derive.js";

/** The outcome of validating a (model-produced) `TaskState` against the ledger (§4.7.6). */
export interface ValidationResult {
  readonly ok: boolean;
  /** Human-readable invention violations (empty ⇒ clean). */
  readonly violations: string[];
  /** The claim with invented file/test entries removed — the swap-in candidate after a repair
   *  (§4.7.6: "repair, or keep existing context and mark failed"). Prose fields are preserved. */
  readonly repaired: TaskStateT;
}

/**
 * Validate a compaction's structured `TaskState` against the ledger (§4.7.6) — the anti-hallucination
 * gate. The model may write prose, but its LEDGER-CHECKABLE claims must match ground truth: a claimed
 * modified file must have a real edit/write event, a claimed read a real read, a claimed test a command
 * that actually ran AND (for a claimed `passed`) did not fail. Invented/contradicted claims are flagged
 * AND dropped in `repaired`, so a confidently-wrong summary cannot launder a fake file edit or a fake
 * test pass into task state.
 *
 * SCOPE (honest about what is NOT checked): only `filesRead` / `filesModified` / `testState` are
 * ledger-validated. Prose + secondary fields — `decisions`, `policyNotes`, `provenanceNotes`,
 * `artifactRefs`, `memoryCandidates`, `constraints`, `nextSteps` — are MODEL-AUTHORED and preserved
 * verbatim; they are NOT validated against the ledger in Phase 1 (e.g. a fabricated `artifactRef` id has
 * no artifact store to check against yet — that store is a deferred §4.7.4/§4.7.9 item; a prose
 * "the user approved X" is not a structural approval). The structural trust field on `CompactionEvent`
 * stays fail-closed `unknown` regardless, so prose cannot raise machine trust. Provenance/trust-upgrade
 * validation (§4.7.8) is reserved here and ENFORCED in Phase 3 (ADR-0010/0025).
 *
 * Constraint preservation across a swap is enforced separately, on the *steering* ledger (the only
 * authoritative source of a non-negotiable user constraint in Phase 1) — see `compact.ts`; this
 * validator owns the ledger-checkable invention checks.
 */
export function validateTaskState(
  claimed: TaskStateT,
  events: readonly SessionEventT[],
): ValidationResult {
  const facts = deriveTaskFacts(events);
  const readPaths = new Set(facts.filesRead.map((f) => f.path));
  const modifiedPaths = new Set(facts.filesModified.map((f) => f.path));
  const commands = new Set(facts.commandsRun);
  // Latest outcome per command (a re-run supersedes an earlier result) — the ground truth a claimed
  // `passed` is checked against, so a FAILED command cannot be laundered into a "test passed".
  const latestOk = new Map<string, boolean>();
  for (const o of facts.commandOutcomes) latestOk.set(o.command, o.ok);
  const violations: string[] = [];

  const filesModified = claimed.filesModified.filter((f) => {
    if (modifiedPaths.has(f.path)) return true;
    violations.push(
      `invented file modification: "${f.path}" has no edit/write event in the ledger`,
    );
    return false;
  });
  const filesRead = claimed.filesRead.filter((f) => {
    if (readPaths.has(f.path)) return true;
    violations.push(`invented file read: "${f.path}" was never read in the ledger`);
    return false;
  });
  const testState = claimed.testState.filter((t) => {
    if (!commands.has(t.command)) {
      violations.push(`invented test result: command "${t.command}" was never run in the ledger`);
      return false;
    }
    // A claimed PASS must not contradict the ledger: if the command's latest run indicated failure,
    // the model cannot launder it into a "test passed" (§4.7.6 "no invented test success").
    if (t.status === "passed" && latestOk.get(t.command) === false) {
      violations.push(`invented test success: command "${t.command}" did not pass in the ledger`);
      return false;
    }
    return true;
  });

  return {
    ok: violations.length === 0,
    violations,
    repaired: { ...claimed, filesModified, filesRead, testState },
  };
}
