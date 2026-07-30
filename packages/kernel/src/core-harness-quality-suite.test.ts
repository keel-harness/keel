import { describe, expect, it } from "vitest";
import {
  CORE_HARNESS_QUALITY_SCENARIO_IDS,
  CORE_HARNESS_QUALITY_SCENARIOS,
  evaluateCoreHarnessQualitySuite,
} from "./core-harness-quality-suite.js";
import {
  CORE_HARNESS_ACCEPTANCE_ARTIFACT_FIXTURES,
  CORE_HARNESS_CONTEXT_PRESSURE_FIXTURES,
  CORE_HARNESS_LOOP_REPLAY_FIXTURES,
  CORE_HARNESS_LOOP_REPLAY_METADATA,
  CORE_HARNESS_PROVIDER_TERMINAL_FIXTURES,
  CORE_HARNESS_SERVICE_LIFECYCLE_FIXTURES,
  type CoreHarnessAcceptanceArtifactFixture,
} from "./core-harness-reliability-fixtures.js";

const SLICE_7_SCENARIOS = [
  "long-local-http-service-probe",
  "long-running-background-job-poll",
  "generated-artifact-required-path",
  "dense-numeric-log-context-pressure",
  "slow-legitimate-compile-negative",
  "silent-successful-verifier-negative",
  "idempotent-service-control-negative",
  "edit-anchor-churn",
  "empty-turn-provider-replay",
] as const;

describe("Epic 2.28 Slice 7 core harness quality suite", () => {
  it("names every required non-TB harness-quality scenario exactly once", () => {
    expect(CORE_HARNESS_QUALITY_SCENARIO_IDS).toEqual(SLICE_7_SCENARIOS);
    expect(CORE_HARNESS_QUALITY_SCENARIOS.map((scenario) => scenario.id)).toEqual(
      SLICE_7_SCENARIOS,
    );
    expect(new Set(CORE_HARNESS_QUALITY_SCENARIO_IDS).size).toBe(
      CORE_HARNESS_QUALITY_SCENARIO_IDS.length,
    );
  });

  it("anchors each scenario in concrete fixtures without benchmark-specific evidence", () => {
    for (const scenario of CORE_HARNESS_QUALITY_SCENARIOS) {
      expect(scenario.slice).toBe("7");
      expect(scenario.evidenceKind).toMatch(
        /^(loop-replay|service-lifecycle|acceptance-artifact|context-pressure|provider-terminal)$/,
      );
      expect(scenario.fixtureIds.length).toBeGreaterThan(0);
      expect(scenario.expectedGate).toMatch(/\S/);
      expect(scenario.benchmarkSpecific).toBe(false);
    }
  });

  it("passes the suite only when loop negatives have no warning or terminal false positives", () => {
    const report = evaluateCoreHarnessQualitySuite();
    const replayScenarios = report.scenarios.filter(
      (scenario) => scenario.evidenceKind === "loop-replay",
    );

    expect(report.ok).toBe(true);
    expect(report.blockingReasons).toEqual([]);
    expect(replayScenarios.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining([
        "long-running-background-job-poll",
        "slow-legitimate-compile-negative",
        "silent-successful-verifier-negative",
        "idempotent-service-control-negative",
        "edit-anchor-churn",
      ]),
    );
    for (const scenario of replayScenarios) {
      expect(scenario.loopWarningIds).toEqual([]);
      expect(scenario.loopForcedPivotIds).toEqual([]);
      expect(scenario.loopTerminalIds).toEqual([]);
    }
  });

  it("validates non-loop fixture semantics instead of only checking fixture ids", () => {
    const report = evaluateCoreHarnessQualitySuite();

    for (const scenario of report.scenarios.filter(
      (candidate) => candidate.evidenceKind !== "loop-replay",
    )) {
      expect(scenario.semanticBlockingReasons).toEqual([]);
      expect(scenario.benchmarkSpecificFixtureIds).toEqual([]);
    }

    expect(
      scenarioBlockers(
        evaluateCoreHarnessQualitySuite({
          fixtures: {
            serviceLifecycleFixtures: CORE_HARNESS_SERVICE_LIFECYCLE_FIXTURES.map((fixture) =>
              fixture.id === "non-tb-local-service-handoff"
                ? { ...fixture, mustSurviveRuntimeDispose: false }
                : fixture,
            ),
          },
        }),
        "long-local-http-service-probe",
      ),
    ).toContain("semantic:service-must-survive-runtime-dispose:non-tb-local-service-handoff");
    expect(
      scenarioBlockers(
        evaluateCoreHarnessQualitySuite({
          fixtures: {
            acceptanceArtifactFixtures: CORE_HARNESS_ACCEPTANCE_ARTIFACT_FIXTURES.map((fixture) =>
              fixture.id === "artifact-generated-required-path-present"
                ? { ...fixture, confidence: "advisory" }
                : fixture,
            ),
          },
        }),
        "generated-artifact-required-path",
      ),
    ).toContain("semantic:artifact-confidence-not-high:artifact-generated-required-path-present");
    expect(
      scenarioBlockers(
        evaluateCoreHarnessQualitySuite({
          fixtures: {
            contextPressureFixtures: CORE_HARNESS_CONTEXT_PRESSURE_FIXTURES.map((fixture) =>
              fixture.id === "non-tb-128k-window-dense-output"
                ? { ...fixture, desiredPressureSource: "local-estimate" }
                : fixture,
            ),
          },
        }),
        "dense-numeric-log-context-pressure",
      ),
    ).toContain("semantic:context-uses-local-estimate:non-tb-128k-window-dense-output");
    expect(
      scenarioBlockers(
        evaluateCoreHarnessQualitySuite({
          fixtures: {
            providerTerminalFixtures: CORE_HARNESS_PROVIDER_TERMINAL_FIXTURES.map((fixture) =>
              fixture.id === "provider-empty-stop"
                ? { ...fixture, desiredHandling: "fail-closed" }
                : fixture,
            ),
          },
        }),
        "empty-turn-provider-replay",
      ),
    ).toContain("semantic:provider-empty-stop-not-retry-once:provider-empty-stop");
  });

  it("blocks weakened semantics across every fixture family", () => {
    expect(
      scenarioBlockers(
        evaluateCoreHarnessQualitySuite({
          fixtures: {
            loopReplayFixtures: CORE_HARNESS_LOOP_REPLAY_FIXTURES.map((fixture) =>
              fixture.id === "non-tb-background-job-poll"
                ? { ...fixture, label: "true-loop" }
                : fixture,
            ),
            loopReplayMetadata: CORE_HARNESS_LOOP_REPLAY_METADATA.map((metadata) =>
              metadata.id === "non-tb-background-job-poll"
                ? {
                    ...metadata,
                    suite: "tb2",
                    heldOut: false,
                    sourceArtifact: "fixture-source:reliability-calibration-v1#task",
                  }
                : metadata,
            ),
          },
        }),
        "long-running-background-job-poll",
      ),
    ).toEqual(
      expect.arrayContaining([
        "semantic:loop-not-legit-progress:non-tb-background-job-poll",
        "semantic:loop-not-non-tb:non-tb-background-job-poll",
        "semantic:loop-not-held-out:non-tb-background-job-poll",
        "semantic:loop-has-source-artifact:non-tb-background-job-poll",
        "benchmark-specific-fixture:non-tb-background-job-poll",
      ]),
    );

    expect(
      scenarioBlockers(
        evaluateCoreHarnessQualitySuite({
          fixtures: {
            serviceLifecycleFixtures: CORE_HARNESS_SERVICE_LIFECYCLE_FIXTURES.map((fixture) =>
              fixture.id === "non-tb-local-service-handoff"
                ? {
                    ...fixture,
                    rootCauseId: "tb2-service-killed-on-teardown",
                    commandShape: "node server.js",
                    boundary: "warden-sandbox",
                    trustedLeaseSource: false,
                    preservationScope: "none",
                    requiredLeaseFields: [],
                    mustSurviveRuntimeDispose: false,
                    mustCleanupAfterProbe: false,
                    expectedDisposition: "reap-unleased",
                  }
                : fixture,
            ),
          },
        }),
        "long-local-http-service-probe",
      ),
    ).toEqual(
      expect.arrayContaining([
        "semantic:service-not-non-tb-root:non-tb-local-service-handoff",
        "semantic:service-not-kernel-runtime:non-tb-local-service-handoff",
        "semantic:service-not-http-server:non-tb-local-service-handoff",
        "semantic:service-untrusted-lease:non-tb-local-service-handoff",
        "semantic:service-wrong-preservation-scope:non-tb-local-service-handoff",
        "semantic:service-missing-lease-field:non-tb-local-service-handoff:ownerToolCallId",
        "semantic:service-must-survive-runtime-dispose:non-tb-local-service-handoff",
        "semantic:service-must-cleanup-after-probe:non-tb-local-service-handoff",
        "semantic:service-not-preserve-until-probe:non-tb-local-service-handoff",
      ]),
    );

    expect(
      scenarioBlockers(
        evaluateCoreHarnessQualitySuite({
          fixtures: {
            acceptanceArtifactFixtures: CORE_HARNESS_ACCEPTANCE_ARTIFACT_FIXTURES.map((fixture) =>
              fixture.id === "artifact-generated-required-path-present"
                ? ({
                    ...fixture,
                    rootCauseId: "tb2-required-artifact-missing",
                    path: "tmp/out.txt",
                    source: "model-authored-path",
                    confidence: "denied",
                    modifiedByModel: true,
                    hiddenGraderLike: true,
                    virtualState: { exists: false, content: "   \n" },
                    expectedVerdict: "block",
                    semanticCorrectnessClaim: "claimed-correct",
                  } as unknown as CoreHarnessAcceptanceArtifactFixture)
                : fixture,
            ),
          },
        }),
        "generated-artifact-required-path",
      ),
    ).toEqual(
      expect.arrayContaining([
        "semantic:artifact-not-non-tb-root:artifact-generated-required-path-present",
        "semantic:artifact-path-not-exact:artifact-generated-required-path-present",
        "semantic:artifact-source-not-explicit-task-path:artifact-generated-required-path-present",
        "semantic:artifact-confidence-not-high:artifact-generated-required-path-present",
        "semantic:artifact-modified-by-model:artifact-generated-required-path-present",
        "semantic:artifact-hidden-grader-like:artifact-generated-required-path-present",
        "semantic:artifact-not-present:artifact-generated-required-path-present",
        "semantic:artifact-empty:artifact-generated-required-path-present",
        "semantic:artifact-wrong-verdict:artifact-generated-required-path-present",
        "semantic:artifact-overclaims-semantics:artifact-generated-required-path-present",
      ]),
    );

    expect(
      scenarioBlockers(
        evaluateCoreHarnessQualitySuite({
          fixtures: {
            contextPressureFixtures: CORE_HARNESS_CONTEXT_PRESSURE_FIXTURES.map((fixture) =>
              fixture.id === "non-tb-128k-window-dense-output"
                ? {
                    ...fixture,
                    localEstimateTokens: fixture.softWindowTokens,
                    contextWindowTokens: fixture.softWindowTokens,
                    providerLastRequestInputTokens: fixture.softWindowTokens,
                    expectedAction: "compact-or-shape",
                  }
                : fixture,
            ),
          },
        }),
        "dense-numeric-log-context-pressure",
      ),
    ).toEqual(
      expect.arrayContaining([
        "semantic:context-local-estimate-already-pressured:non-tb-128k-window-dense-output",
        "semantic:context-soft-window-out-of-range:non-tb-128k-window-dense-output",
        "semantic:context-provider-usage-not-pressured:non-tb-128k-window-dense-output",
        "semantic:context-action-too-ambiguous:non-tb-128k-window-dense-output",
      ]),
    );

    expect(
      scenarioBlockers(
        evaluateCoreHarnessQualitySuite({
          fixtures: {
            contextPressureFixtures: CORE_HARNESS_CONTEXT_PRESSURE_FIXTURES.map((fixture) =>
              fixture.id === "non-tb-128k-window-dense-output"
                ? {
                    ...fixture,
                    desiredPressureSource: "new-observation-estimate",
                    newlyAppendedObservationEstimateTokens: fixture.softWindowTokens,
                  }
                : fixture,
            ),
          },
        }),
        "dense-numeric-log-context-pressure",
      ),
    ).toContain("semantic:context-observation-not-pressured:non-tb-128k-window-dense-output");

    expect(
      scenarioBlockers(
        evaluateCoreHarnessQualitySuite({
          fixtures: {
            providerTerminalFixtures: CORE_HARNESS_PROVIDER_TERMINAL_FIXTURES.map((fixture) =>
              fixture.id === "provider-empty-stop"
                ? {
                    ...fixture,
                    terminalKind: "malformed-chunk",
                    desiredHandling: "fail-closed",
                    chunk: { type: "malformed", raw: "not-json" },
                  }
                : fixture,
            ),
          },
        }),
        "empty-turn-provider-replay",
      ),
    ).toEqual(
      expect.arrayContaining([
        "semantic:provider-not-empty-stop:provider-empty-stop",
        "semantic:provider-empty-stop-not-retry-once:provider-empty-stop",
        "semantic:provider-empty-stop-not-clean-provider-stop:provider-empty-stop",
      ]),
    );

    expect(
      scenarioBlockers(
        evaluateCoreHarnessQualitySuite({
          fixtures: {
            providerTerminalFixtures: CORE_HARNESS_PROVIDER_TERMINAL_FIXTURES.map((fixture) =>
              fixture.id === "provider-empty-stop"
                ? {
                    ...fixture,
                    chunk: {
                      type: "finish",
                      reason: "stop",
                      usage: { inputTokens: 10, outputTokens: 1 },
                    },
                  }
                : fixture,
            ),
          },
        }),
        "empty-turn-provider-replay",
      ),
    ).toContain("semantic:provider-empty-stop-has-output:provider-empty-stop");
  });

  it("reports missing scenario fixtures and accepts explicit full fixture overrides", () => {
    const explicit = evaluateCoreHarnessQualitySuite({
      fixtures: {
        loopReplayFixtures: CORE_HARNESS_LOOP_REPLAY_FIXTURES,
        loopReplayMetadata: CORE_HARNESS_LOOP_REPLAY_METADATA,
        serviceLifecycleFixtures: CORE_HARNESS_SERVICE_LIFECYCLE_FIXTURES,
        acceptanceArtifactFixtures: CORE_HARNESS_ACCEPTANCE_ARTIFACT_FIXTURES,
        contextPressureFixtures: CORE_HARNESS_CONTEXT_PRESSURE_FIXTURES,
        providerTerminalFixtures: CORE_HARNESS_PROVIDER_TERMINAL_FIXTURES,
      },
    });
    expect(explicit.ok).toBe(true);

    expect(
      scenarioBlockers(
        evaluateCoreHarnessQualitySuite({
          fixtures: {
            serviceLifecycleFixtures: [],
            acceptanceArtifactFixtures: [],
            contextPressureFixtures: [],
            providerTerminalFixtures: [],
          },
        }),
        "long-local-http-service-probe",
      ),
    ).toContain("missing-fixture:non-tb-local-service-handoff");
    expect(
      scenarioBlockers(
        evaluateCoreHarnessQualitySuite({
          fixtures: {
            serviceLifecycleFixtures: [],
            acceptanceArtifactFixtures: [],
            contextPressureFixtures: [],
            providerTerminalFixtures: [],
          },
        }),
        "generated-artifact-required-path",
      ),
    ).toContain("missing-fixture:artifact-generated-required-path-present");
    expect(
      scenarioBlockers(
        evaluateCoreHarnessQualitySuite({
          fixtures: {
            serviceLifecycleFixtures: [],
            acceptanceArtifactFixtures: [],
            contextPressureFixtures: [],
            providerTerminalFixtures: [],
          },
        }),
        "dense-numeric-log-context-pressure",
      ),
    ).toContain("missing-fixture:non-tb-128k-window-dense-output");
    expect(
      scenarioBlockers(
        evaluateCoreHarnessQualitySuite({
          fixtures: {
            serviceLifecycleFixtures: [],
            acceptanceArtifactFixtures: [],
            contextPressureFixtures: [],
            providerTerminalFixtures: [],
          },
        }),
        "empty-turn-provider-replay",
      ),
    ).toContain("missing-fixture:provider-empty-stop");
  });

  it("keeps the suite cost-aware by reporting replay token savings and fixture-only scope", () => {
    const report = evaluateCoreHarnessQualitySuite();

    expect(report.loopCalibration.defaultOnEligible).toBe(true);
    expect(report.loopCalibration.medianTrueLoopTokenSavingsRatio).toBeGreaterThanOrEqual(0.7);
    expect(report.nonTbReplayFixtureCount).toBeGreaterThanOrEqual(10);
    expect(report.slice7ScenarioFixtureCount).toBe(10);
    expect(report.addedRuntimeProbeCount).toBe(0);
    expect(report.scenarios.every((scenario) => scenario.executionMode === "fixture-only")).toBe(
      true,
    );
  });
});

function scenarioBlockers(
  report: ReturnType<typeof evaluateCoreHarnessQualitySuite>,
  id: (typeof SLICE_7_SCENARIOS)[number],
): readonly string[] {
  return report.scenarios.find((scenario) => scenario.id === id)?.blockingReasons ?? [];
}
