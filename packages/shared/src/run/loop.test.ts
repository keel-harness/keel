import { describe, expect, it } from "vitest";
import { LoopConfig, RUN_CONTROL_SCHEMA_VERSION, parseLoopConfigForProfile } from "./loop.js";

const loop = {
  schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
  id: "loop_tests",
  prompt: "Fix the unit tests until they pass",
  until: {
    kind: "command",
    check: { argv: ["pnpm", "test"] },
    satisfiedWhen: "exitZero",
  },
  bounds: { maxIterations: 5, maxWallMs: 1_200_000, maxEffectiveTokens: 100_000 },
  effects: {
    allow: ["fs_read", "fs_write", "process_exec"],
    deny: ["network_write"],
  },
  requireProgressEachIteration: true,
} as const;

describe("LoopConfig schema (Epic 2.12)", () => {
  it("accepts a bounded in-session loop with a structural command exit check", () => {
    const parsed = LoopConfig.parse(loop);

    expect(parsed.bounds.maxIterations).toBe(5);
    expect(parsed.until.satisfiedWhen).toBe("exitZero");
    expect(parsed.requireProgressEachIteration).toBe(true);
  });

  it("rejects scheduler/background shapes and missing structural exit checks", () => {
    expect(LoopConfig.safeParse({ ...loop, schedule: "*/5 * * * *" }).success).toBe(false);
    expect(LoopConfig.safeParse({ ...loop, until: undefined }).success).toBe(false);
    expect(
      LoopConfig.safeParse({
        ...loop,
        until: { kind: "model_assertion", satisfiedWhen: "modelSaysDone" },
      }).success,
    ).toBe(false);
  });

  it("requires effect envelopes to narrow the run rather than declare an empty envelope", () => {
    expect(LoopConfig.safeParse({ ...loop, effects: {} }).success).toBe(false);
    expect(LoopConfig.safeParse({ ...loop, effects: { deny: ["network_write"] } }).success).toBe(
      true,
    );
  });

  it("rejects effect envelopes that would widen the active profile", () => {
    const active = {
      allowedEffects: ["fs_read", "process_exec"],
    } as const;

    const malformed = parseLoopConfigForProfile({ ...loop, bounds: { maxIterations: 0 } }, active);
    expect(malformed.success).toBe(false);
    if (malformed.success) throw new Error("expected malformed loop config to fail");
    expect(malformed.error).toContain("greater than 0");
    expect(parseLoopConfigForProfile(loop, active).success).toBe(false);
    expect(
      parseLoopConfigForProfile(
        { ...loop, effects: { allow: ["fs_read", "process_exec"], deny: ["network_write"] } },
        active,
      ).success,
    ).toBe(true);
  });
});
