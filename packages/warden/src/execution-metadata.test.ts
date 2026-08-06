import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildPolicyInputForBash } from "./policy.js";
import {
  createExecutionMetadataState,
  executionMetadataGeneration,
  executionMetadataTrusted,
  invalidateExecutionMetadataForPotentialWrite,
  invalidateExecutionMetadataForReviewedProcess,
} from "./execution-metadata.js";

const SESSION_A = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SESSION_B = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW";

function policyInput(command: string) {
  return buildPolicyInputForBash(
    {
      sessionId: SESSION_A,
      toolCall: { id: "tc_generation", name: "bash", args: { command } },
      provenanceContext: { inputTags: ["workspace"] },
    },
    { workspaceRoot: "/repo", env: { HOME: "/home/alice" }, workspaceTrusted: true },
  );
}

describe("execution-metadata mutation generations", () => {
  it("starts trusted at generation zero and isolates sessions", () => {
    const state = createExecutionMetadataState();

    expect(executionMetadataGeneration(state, SESSION_A)).toEqual({
      generation: 0,
      poisoned: false,
    });
    expect(executionMetadataGeneration(state, SESSION_B)).toEqual({
      generation: 0,
      poisoned: false,
    });
    expect(executionMetadataTrusted(state, SESSION_A)).toBe(true);
    expect(executionMetadataTrusted(state, SESSION_B)).toBe(true);
  });

  it("advances for every same-session workspace-write invalidation, including after trust is gone", () => {
    const state = createExecutionMetadataState();
    const write = policyInput("printf changed > src/generated.ts");

    invalidateExecutionMetadataForPotentialWrite(state, SESSION_A, write);
    expect(executionMetadataGeneration(state, SESSION_A)).toEqual({
      generation: 1,
      poisoned: false,
    });
    expect(executionMetadataTrusted(state, SESSION_A)).toBe(false);

    invalidateExecutionMetadataForPotentialWrite(state, SESSION_A, write);
    expect(executionMetadataGeneration(state, SESSION_A)).toEqual({
      generation: 2,
      poisoned: false,
    });
    expect(executionMetadataGeneration(state, SESSION_B)).toEqual({
      generation: 0,
      poisoned: false,
    });
  });

  it("advances every potential-write hook invocation even for a read-only classified action", () => {
    const state = createExecutionMetadataState();

    invalidateExecutionMetadataForPotentialWrite(state, SESSION_A, policyInput("git status"));

    expect(executionMetadataGeneration(state, SESSION_A)).toEqual({
      generation: 1,
      poisoned: false,
    });
    expect(executionMetadataTrusted(state, SESSION_A)).toBe(true);
  });

  it("unconditionally advances and invalidates an admitted reviewed process attempt", () => {
    const state = createExecutionMetadataState();

    invalidateExecutionMetadataForReviewedProcess(state, SESSION_A);

    expect(executionMetadataGeneration(state, SESSION_A)).toEqual({
      generation: 1,
      poisoned: false,
    });
    expect(executionMetadataTrusted(state, SESSION_A)).toBe(false);
  });

  it("poisons permanently at the safe-integer bound instead of wrapping", () => {
    const state = createExecutionMetadataState();
    state.mutationGenerations.set(SESSION_A, Number.MAX_SAFE_INTEGER - 1);

    invalidateExecutionMetadataForReviewedProcess(state, SESSION_A);
    expect(executionMetadataGeneration(state, SESSION_A)).toEqual({
      generation: Number.MAX_SAFE_INTEGER,
      poisoned: true,
    });

    invalidateExecutionMetadataForReviewedProcess(state, SESSION_A);
    expect(executionMetadataGeneration(state, SESSION_A)).toEqual({
      generation: Number.MAX_SAFE_INTEGER,
      poisoned: true,
    });
    expect(executionMetadataTrusted(state, SESSION_A)).toBe(false);
  });

  it("advances to one below the safe-integer bound without poisoning", () => {
    const state = createExecutionMetadataState();
    state.mutationGenerations.set(SESSION_A, Number.MAX_SAFE_INTEGER - 2);

    invalidateExecutionMetadataForReviewedProcess(state, SESSION_A);

    expect(executionMetadataGeneration(state, SESSION_A)).toEqual({
      generation: Number.MAX_SAFE_INTEGER - 1,
      poisoned: false,
    });
  });

  it.each([Number.NaN, -1, Number.MAX_SAFE_INTEGER])(
    "fails closed for a malformed unpoisoned generation %s",
    (generation) => {
      const state = createExecutionMetadataState();
      state.mutationGenerations.set(SESSION_A, generation);

      expect(executionMetadataGeneration(state, SESSION_A)).toEqual({
        generation: Number.MAX_SAFE_INTEGER,
        poisoned: true,
      });
      expect(executionMetadataTrusted(state, SESSION_A)).toBe(false);
    },
  );

  it("is monotonic for a bounded sequence of qualifying invalidations", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000 }), (count) => {
        const state = createExecutionMetadataState();
        for (let index = 0; index < count; index += 1) {
          invalidateExecutionMetadataForReviewedProcess(state, SESSION_A);
        }
        expect(executionMetadataGeneration(state, SESSION_A)).toEqual({
          generation: count,
          poisoned: false,
        });
      }),
      { seed: 9_090, numRuns: 100 },
    );
  });
});
