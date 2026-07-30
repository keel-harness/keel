import { describe, expect, it } from "vitest";
import type { ToolInvocationT, ToolResultT } from "@keel/shared";
import { LIFECYCLE_MANIFEST_VERSION, LifecycleManifest } from "@keel/shared";
import { runGoalValidation } from "./goal-validation.js";
import { markToolPresentationOutcome } from "../tool-presentation-outcome.js";

const manifest = LifecycleManifest.parse({
  schemaVersion: LIFECYCLE_MANIFEST_VERSION,
  actions: {
    "test.unit": { argv: ["pnpm", "test"] },
    lint: { argv: ["pnpm", "lint"] },
  },
  validationTiers: {
    standard: { required: ["test.unit", "lint"] },
  },
});

function recordingExecutor(outcome: (action: string) => boolean) {
  const calls: ToolInvocationT[] = [];
  return {
    calls,
    execute: (call: ToolInvocationT): Promise<ToolResultT> => {
      calls.push(call);
      const action = (call.args as { action?: string }).action ?? "";
      return Promise.resolve({ ok: outcome(action), output: `${action}: done` });
    },
  };
}

describe("runGoalValidation", () => {
  it("returns not_configured and runs nothing when the goal has no validation", async () => {
    const ex = recordingExecutor(() => true);
    const result = await runGoalValidation({ validation: undefined, manifest, executor: ex });
    expect(result).toEqual({ status: "not_configured" });
    expect(ex.calls).toHaveLength(0);
  });

  it("runs every required tier action as lifecycle.run and passes when all are ok", async () => {
    const ex = recordingExecutor(() => true);
    const result = await runGoalValidation({
      validation: { tier: "standard" },
      manifest,
      executor: ex,
    });
    expect(result).toEqual({ status: "passed", tier: "standard" });
    expect(ex.calls.map((c) => [c.name, (c.args as { action?: string }).action])).toEqual([
      ["lifecycle.run", "test.unit"],
      ["lifecycle.run", "lint"],
    ]);
  });

  it("fails on the first non-ok action and does not run the rest (no false pass)", async () => {
    const ex = recordingExecutor((action) => action !== "test.unit");
    const result = await runGoalValidation({
      validation: { tier: "standard" },
      manifest,
      executor: ex,
    });
    expect(result).toEqual({
      status: "failed",
      tier: "standard",
      failedAction: "test.unit",
      failureKind: "failed",
    });
    expect(ex.calls).toHaveLength(1);
  });

  it("reports each governed lifecycle action as it starts", async () => {
    const ex = recordingExecutor(() => true);
    const started: string[] = [];
    await runGoalValidation({
      validation: { tier: "standard" },
      manifest,
      executor: ex,
      onActionStart: (action) => started.push(action),
    });

    expect(started).toEqual(["test.unit", "lint"]);
  });

  it("skips a configured tier (honest not_run) without running anything when interrupted", async () => {
    const ex = recordingExecutor(() => true);
    const result = await runGoalValidation({
      validation: { tier: "standard" },
      manifest,
      executor: ex,
      skip: true,
    });
    expect(result).toEqual({ status: "not_run", tier: "standard" });
    expect(ex.calls).toHaveLength(0);
  });

  it("starts no validation action when the signal is already aborted", async () => {
    const ex = recordingExecutor(() => true);
    const abort = new AbortController();
    abort.abort();

    const result = await runGoalValidation({
      validation: { tier: "standard" },
      manifest,
      executor: ex,
      signal: abort.signal,
    });

    expect(result).toEqual({ status: "not_run", tier: "standard" });
    expect(ex.calls).toHaveLength(0);
  });

  it("starts no later action when interruption lands as an action settles", async () => {
    const abort = new AbortController();
    const calls: ToolInvocationT[] = [];
    const result = await runGoalValidation({
      validation: { tier: "standard" },
      manifest,
      signal: abort.signal,
      executor: {
        execute: (call) => {
          calls.push(call);
          abort.abort();
          return Promise.resolve({ ok: true, output: "settled while interrupted" });
        },
      },
    });

    expect(result).toEqual({ status: "not_run", tier: "standard" });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["review", "review"],
    ["blocked", "blocked"],
    ["failed", "failed"],
  ] as const)(
    "preserves the local %s failure category for exact recovery guidance",
    async (tag, failureKind) => {
      const result = await runGoalValidation({
        validation: { tier: "standard" },
        manifest,
        executor: {
          execute: () =>
            Promise.resolve(
              markToolPresentationOutcome({ ok: false, output: `${tag} validation result` }, tag),
            ),
        },
      });

      expect(result).toEqual({
        status: "failed",
        tier: "standard",
        failedAction: "test.unit",
        failureKind,
      });
    },
  );

  it("reports not_run (never passed) when no manifest declares the tier", async () => {
    const ex = recordingExecutor(() => true);
    const undeclaredTier = await runGoalValidation({
      validation: { tier: "strict" },
      manifest,
      executor: ex,
    });
    expect(undeclaredTier).toEqual({ status: "not_run", tier: "strict" });
    const noManifest = await runGoalValidation({
      validation: { tier: "standard" },
      executor: ex,
    });
    expect(noManifest).toEqual({ status: "not_run", tier: "standard" });
    expect(ex.calls).toHaveLength(0);
  });
});
