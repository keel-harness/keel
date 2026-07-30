import { describe, expect, it } from "vitest";
import {
  Goal,
  GoalCompletionAudit,
  RUN_CONTROL_SCHEMA_VERSION,
  commandCriterionMatchesArgv,
} from "./goal.js";

const baseGoal = {
  schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
  id: "goal_smoke",
  objective: "Implement the run-control schema and prove it with tests",
  doneWhen: [
    {
      id: "typecheck",
      kind: "command",
      check: { argv: ["pnpm", "typecheck"] },
    },
    {
      id: "docs-updated",
      kind: "narrative",
      evidenceHint: "Plan and progress docs mention Epic 2.12",
    },
  ],
  validation: { tier: "standard" },
  bounds: { maxTurns: 20, maxWallMs: 1_800_000, maxEffectiveTokens: 200_000 },
  requiresCompletionAudit: true,
} as const;

describe("Goal schema (Epic 2.12)", () => {
  it("accepts command and narrative criteria and keeps completion audit required", () => {
    const parsed = Goal.parse(baseGoal);

    expect(parsed.id).toBe("goal_smoke");
    expect(parsed.doneWhen).toHaveLength(2);
    expect(parsed.requiresCompletionAudit).toBe(true);
    expect(parsed.validation?.tier).toBe("standard");
  });

  it("rejects disabled completion audit, empty criteria, malformed ids, and command ambiguity", () => {
    expect(Goal.safeParse({ ...baseGoal, requiresCompletionAudit: false }).success).toBe(false);
    expect(Goal.safeParse({ ...baseGoal, doneWhen: [] }).success).toBe(false);
    expect(Goal.safeParse({ ...baseGoal, id: "bad space" }).success).toBe(false);
    expect(
      Goal.safeParse({
        ...baseGoal,
        doneWhen: [
          {
            id: "ambiguous",
            kind: "command",
            check: { action: "test.unit", argv: ["pnpm", "test"] },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects an explicitly empty bounds object but accepts each individual bound shape", () => {
    expect(Goal.safeParse({ ...baseGoal, bounds: {} }).success).toBe(false);
    expect(Goal.safeParse({ ...baseGoal, bounds: { maxTurns: 20 } }).success).toBe(true);
    expect(Goal.safeParse({ ...baseGoal, bounds: { maxWallMs: 1_800_000 } }).success).toBe(true);
    expect(Goal.safeParse({ ...baseGoal, bounds: { maxEffectiveTokens: 200_000 } }).success).toBe(
      true,
    );
  });

  it("rejects duplicate criterion ids", () => {
    expect(
      Goal.safeParse({
        ...baseGoal,
        doneWhen: [
          {
            id: "duplicate",
            kind: "command",
            check: { argv: ["pnpm", "typecheck"] },
          },
          {
            id: "duplicate",
            kind: "narrative",
            evidenceHint: "The same id cannot be reused for a second proof point.",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("matches argv command criteria exactly enough for ledger evidence without shelling out", () => {
    const criterion = Goal.parse(baseGoal).doneWhen[0];
    expect(criterion).toBeDefined();
    if (criterion === undefined) throw new Error("expected first criterion");

    expect(commandCriterionMatchesArgv(criterion, ["pnpm", "typecheck"])).toBe(true);
    expect(commandCriterionMatchesArgv(criterion, ["pnpm", "lint"])).toBe(false);
    expect(commandCriterionMatchesArgv(criterion, ["pnpm typecheck"])).toBe(false);
  });

  it("validates completion audits and rejects green verdicts without passed validation", () => {
    const audit = {
      schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
      goalId: "goal_smoke",
      verdict: "complete",
      validation: { status: "passed", tier: "standard" },
      criteria: [
        {
          criterionId: "typecheck",
          status: "satisfied",
          assurance: "machine_verified",
          evidence: [{ kind: "session_event", ref: "tool_result:call_1" }],
        },
      ],
      gaps: [],
    };

    expect(GoalCompletionAudit.parse(audit).verdict).toBe("complete");
    expect(
      GoalCompletionAudit.safeParse({
        ...audit,
        validation: { status: "not_configured" },
      }).success,
    ).toBe(false);
  });
});
