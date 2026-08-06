import type { GoalCompletionAuditT, GoalT, SessionEventT } from "@keel/shared";
import { GoalCompletionAudit, RUN_CONTROL_SCHEMA_VERSION } from "@keel/shared";
import { commandCriterionMatchesArgv } from "@keel/shared";
import { commandResultIndicatesFailure } from "../context/derive.js";
import { isReadOnlyCommand } from "../verify-gate.js";
import { renderToolCommand, toolCommandArgv, toolCommandIsReadOnly } from "../tool-command.js";

// TEST SUMMARY banners are a goal-audit-specific extension over the canonical
// `commandResultIndicatesFailure` (isError / `[exit code: N]`) helper. EXIT_CODE_RE stays local for
// the "no non-zero-exit marker present ⇒ satisfied" branch below, which has no canonical equivalent.
const PASS_RE = /^TEST SUMMARY \([^)]+\): PASS/m;
const FAIL_RE = /^TEST SUMMARY \([^)]+\): FAIL/m;
const EXIT_CODE_RE = /^\[exit code: ([1-9]\d*)\]$/m;

export interface GoalValidationResult {
  readonly status: "passed" | "failed" | "not_configured" | "not_run";
  readonly tier?: "minimal" | "standard" | "strict";
  /** Local diagnostic detail; persisted audits continue to record the stable status/tier contract. */
  readonly failedAction?: string;
  /** Kernel-local presentation category. This is deliberately stripped before the frozen audit. */
  readonly failureKind?: "review" | "blocked" | "stopped" | "failed";
}

export interface EvaluateGoalCompletionInput {
  readonly events: readonly SessionEventT[];
  readonly validation?: GoalValidationResult;
  readonly narrativeEvidence?: Readonly<Record<string, readonly string[]>>;
}

interface CommandEvidence {
  readonly toolCallId: string;
  readonly command: string;
  readonly argv: readonly string[];
  readonly readOnly: boolean;
  readonly output: string;
  /** `true` when the executor returned `!ok` (warden deny/review, timeout, abort, execution error). */
  readonly isError: boolean;
}

function commandEvidence(events: readonly SessionEventT[]): CommandEvidence[] {
  const commandById = new Map<
    string,
    {
      readonly name: string;
      readonly command: string;
      readonly argv: readonly string[];
      readonly readOnly: boolean;
    }
  >();
  const evidence: CommandEvidence[] = [];
  for (const event of events) {
    if (event.type === "assistant") {
      for (const call of event.toolCalls ?? []) {
        if (call.name !== "bash" && call.name !== "process.run") continue;
        const command = renderToolCommand(call);
        const argv = toolCommandArgv(call);
        if (command !== undefined && argv !== undefined) {
          commandById.set(call.id, {
            name: call.name,
            command,
            argv,
            readOnly:
              call.name === "bash" ? isReadOnlyCommand(command) : toolCommandIsReadOnly(call),
          });
        }
      }
    }
    if (event.type === "tool_result") {
      const command = commandById.get(event.toolCallId);
      if (command === undefined || event.name !== command.name) continue;
      evidence.push({
        toolCallId: event.toolCallId,
        command: command.command,
        argv: command.argv,
        readOnly: command.readOnly,
        output: event.output,
        isError: event.isError === true,
      });
    }
  }
  return evidence;
}

function hasResolvedCitation(ref: string, events: readonly SessionEventT[]): boolean {
  const toolPrefix = "tool_result:";
  if (ref.startsWith(toolPrefix)) {
    const toolCallId = ref.slice(toolPrefix.length);
    return events.some((event) => event.type === "tool_result" && event.toolCallId === toolCallId);
  }
  const eventPrefix = "session_event:";
  if (ref.startsWith(eventPrefix)) {
    const eventType = ref.slice(eventPrefix.length);
    return events.some((event) => event.type === eventType);
  }
  return false;
}

export function evaluateGoalCompletion(
  goal: GoalT,
  input: EvaluateGoalCompletionInput,
): GoalCompletionAuditT {
  const evidence = commandEvidence(input.events);
  const criteria = goal.doneWhen.map((criterion) => {
    if (criterion.kind === "command") {
      const match = evidence.find((candidate) =>
        commandCriterionMatchesArgv(criterion, candidate.argv),
      );
      if (match === undefined) {
        return {
          criterionId: criterion.id,
          status: "unsatisfied" as const,
          assurance: "unverified" as const,
          evidence: [],
          message:
            criterion.check.argv !== undefined
              ? `no ledger evidence for command: ${criterion.check.argv.join(" ")}`
              : `no lifecycle action evidence for: ${criterion.check.action}`,
        };
      }
      const ref = { kind: "session_event" as const, ref: `tool_result:${match.toolCallId}` };
      if (match.readOnly) {
        return {
          criterionId: criterion.id,
          status: "unsatisfied" as const,
          assurance: "unverified" as const,
          evidence: [ref],
          message:
            "matching command evidence is read-only and cannot verify completion; " +
            "for an exit-code predicate use /loop --until, or give /goal --check an executable proof",
        };
      }
      // A non-ok executor result (warden deny/review, timeout, abort, execution error) is a hard
      // failure even when its message carries neither a TEST SUMMARY banner nor an `[exit code: N]`
      // marker — completion evidence is executor-owned, never inferred from the absence of a marker.
      if (
        commandResultIndicatesFailure(match.output, match.isError) ||
        FAIL_RE.test(match.output)
      ) {
        return {
          criterionId: criterion.id,
          status: "unsatisfied" as const,
          assurance: "machine_verified" as const,
          evidence: [ref],
          message: "matching command evidence failed",
        };
      }
      if (PASS_RE.test(match.output) || !EXIT_CODE_RE.test(match.output)) {
        return {
          criterionId: criterion.id,
          status: "satisfied" as const,
          assurance: "machine_verified" as const,
          evidence: [ref],
        };
      }
    }

    const refs = [...(input.narrativeEvidence?.[criterion.id] ?? [])].filter((ref) =>
      hasResolvedCitation(ref, input.events),
    );
    if (refs.length === 0) {
      return {
        criterionId: criterion.id,
        status: "unsatisfied" as const,
        assurance: "unverified" as const,
        evidence: [],
        message: "narrative criterion requires resolvable ledger citations",
      };
    }
    return {
      criterionId: criterion.id,
      status: "satisfied" as const,
      assurance: "evidence_cited" as const,
      evidence: refs.map((ref) => ({ kind: "session_event" as const, ref })),
    };
  });

  const validationInput = input.validation ?? { status: "not_configured" as const };
  // Keep local diagnostic fields out of the frozen persisted audit schema.
  const validation = {
    status: validationInput.status,
    ...(validationInput.tier !== undefined ? { tier: validationInput.tier } : {}),
  };
  const gaps = criteria
    .filter((criterion) => criterion.status !== "satisfied")
    .map((criterion) => criterion.criterionId);
  const allSatisfied = gaps.length === 0;
  if (allSatisfied && validation.status !== "passed") gaps.push("validation");
  const verdict =
    allSatisfied && validation.status === "passed"
      ? "complete"
      : allSatisfied && validation.status === "not_configured"
        ? "unverified"
        : "incomplete";

  return GoalCompletionAudit.parse({
    schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
    goalId: goal.id,
    verdict,
    validation,
    criteria,
    gaps,
  });
}
