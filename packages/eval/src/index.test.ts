import { describe, expect, it } from "vitest";
import * as evalPkg from "./index.js";

describe("@keel/eval barrel", () => {
  it("re-exports the Epic 0.4 surface", () => {
    for (const name of [
      "EvalConfig",
      "loadEvalConfig",
      "defaultEvalConfig",
      "CostCapError",
      "assertWithinCostCap",
      "assertConfigCostCap",
      "Trajectory",
      "TrajectoryEvent",
      "writeTrajectory",
      "readTrajectory",
      "replayModelToTrajectory",
      "replayToTrajectory",
      "BenchmarkResult",
      "ResultMismatchError",
      "TaskResult",
      "parseTerminalBenchResults",
    ]) {
      expect(name in evalPkg).toBe(true);
    }
  });
});
