import type { TaskStateT } from "@keel/shared";

/** Render a list of lines as markdown bullets, or "- (none)" when empty (honest, never fabricated). */
const bullets = (xs: readonly string[]): string =>
  xs.length > 0 ? xs.map((x) => `- ${x}`).join("\n") : "- (none)";

/**
 * Render a structured `TaskState` as the §4.7.5 typed compaction summary — the human-readable
 * markdown layer over the schema (the schema is the validated source of truth; this is the view the
 * model reads after a swap). Fixed sections, in the §4.7.5 order; empty sections say "(none)" rather
 * than inviting the model to fill a blank. Deterministic.
 */
export function renderCompactionSummary(s: TaskStateT): string {
  const files = (fs: TaskStateT["filesRead"]): string =>
    bullets(fs.map((f) => `${f.path}: ${f.summary || f.status}`));
  const todos = bullets([
    ...s.completedSteps.map((x) => `[x] ${x}`),
    ...s.plan.map((x) => `[ ] ${x}`),
  ]);
  return [
    "# Compacted Session State",
    `## User Goal\n${s.taskGoal}`,
    `## Current Status\n${s.currentStatus} (phase: ${s.currentPhase})`,
    `## Non-Negotiable Constraints\n${bullets(s.constraints)}`,
    `## Current Plan / TODOs\n${todos}`,
    `## Files Read\n${files(s.filesRead)}`,
    `## Files Modified\n${files(s.filesModified)}`,
    `## Important Decisions\n${bullets(s.decisions.map((d) => `${d.decision} — ${d.reason}`))}`,
    `## Failed Attempts / Dead Ends\n${bullets(
      s.failedAttempts.map((f) => `${f.attempt} → ${f.result}; ${f.reasonNotContinuing}`),
    )}`,
    `## Test and Verification State\n${bullets(
      s.testState.map((t) => `${t.command} — ${t.status}${t.summary ? `: ${t.summary}` : ""}`),
    )}`,
    `## Current Errors / Blockers\n${bullets([...s.currentErrors, ...s.blockers])}`,
    `## Next Best Actions\n${bullets(s.nextSteps)}`,
    `## Artifact References\n${bullets(
      s.artifactRefs.map((a) => `${a.artifactId} (${a.type}): ${a.summary}`),
    )}`,
    `## Policy / Trust Notes\n${bullets([...s.policyNotes, ...s.provenanceNotes])}`,
    `## Memory Candidates\n${bullets(
      s.memoryCandidates.map(
        (m) => `[${m.type}] ${m.content} (${m.confidence} · ${m.proposedScope})`,
      ),
    )}`,
    `## Open Questions\n${bullets(s.unresolvedQuestions)}`,
  ].join("\n\n");
}
