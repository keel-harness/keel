import {
  CORE_HARNESS_ACCEPTANCE_ARTIFACT_FIXTURES,
  CORE_HARNESS_CONTEXT_PRESSURE_FIXTURES,
  CORE_HARNESS_LOOP_REPLAY_CORPUS_REQUIREMENTS,
  CORE_HARNESS_LOOP_REPLAY_FIXTURES,
  CORE_HARNESS_LOOP_REPLAY_METADATA,
  CORE_HARNESS_PROVIDER_TERMINAL_FIXTURES,
  CORE_HARNESS_SERVICE_LIFECYCLE_FIXTURES,
  type CoreHarnessAcceptanceArtifactFixture,
  type CoreHarnessContextPressureFixture,
  type CoreHarnessLoopReplayMetadata,
  type CoreHarnessProviderTerminalFixture,
  type CoreHarnessServiceLifecycleFixture,
} from "./core-harness-reliability-fixtures.js";
import { PROGRESS_CONTRACT_LOOP_CONFIG } from "./loop-detection.js";
import {
  calibrateLoopDetectionFixtures,
  type LoopDetectionCalibrationReport,
  type LoopDetectionReplayFixture,
} from "./loop-detection-replay.js";

/**
 * Slice 7 measurement gate over existing Epic 2.28 primitives. This is intentionally
 * internal and fixture-backed: it runs no external services, no live provider calls,
 * and no Terminal-Bench-specific logic.
 */

export const CORE_HARNESS_QUALITY_SCENARIO_IDS = [
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

export type CoreHarnessQualityScenarioId = (typeof CORE_HARNESS_QUALITY_SCENARIO_IDS)[number];

export type CoreHarnessQualityEvidenceKind =
  | "loop-replay"
  | "service-lifecycle"
  | "acceptance-artifact"
  | "context-pressure"
  | "provider-terminal";

export interface CoreHarnessQualityScenario {
  readonly id: CoreHarnessQualityScenarioId;
  readonly slice: "7";
  readonly evidenceKind: CoreHarnessQualityEvidenceKind;
  readonly fixtureIds: readonly string[];
  readonly expectedGate: string;
  readonly benchmarkSpecific: boolean;
  readonly executionMode: "fixture-only";
}

export const CORE_HARNESS_QUALITY_SCENARIOS = [
  {
    id: "long-local-http-service-probe",
    slice: "7",
    evidenceKind: "service-lifecycle",
    fixtureIds: ["non-tb-local-service-handoff"],
    expectedGate: "leased service survives runtime dispose until fresh-process probe and cleanup",
    benchmarkSpecific: false,
    executionMode: "fixture-only",
  },
  {
    id: "long-running-background-job-poll",
    slice: "7",
    evidenceKind: "loop-replay",
    fixtureIds: ["non-tb-background-job-poll"],
    expectedGate: "bounded polling of a progressing background job never becomes a loop halt",
    benchmarkSpecific: false,
    executionMode: "fixture-only",
  },
  {
    id: "generated-artifact-required-path",
    slice: "7",
    evidenceKind: "acceptance-artifact",
    fixtureIds: ["artifact-generated-required-path-present"],
    expectedGate:
      "visible required artifact path is recognized without proving semantic correctness",
    benchmarkSpecific: false,
    executionMode: "fixture-only",
  },
  {
    id: "dense-numeric-log-context-pressure",
    slice: "7",
    evidenceKind: "context-pressure",
    fixtureIds: ["non-tb-128k-window-dense-output"],
    expectedGate:
      "provider usage or new-observation pressure beats optimistic chars-per-token estimate",
    benchmarkSpecific: false,
    executionMode: "fixture-only",
  },
  {
    id: "slow-legitimate-compile-negative",
    slice: "7",
    evidenceKind: "loop-replay",
    fixtureIds: ["non-tb-slow-legitimate-progress", "non-tb-long-compile-repeated-output"],
    expectedGate: "slow compiles with build-unit progress avoid warning and terminal loop stops",
    benchmarkSpecific: false,
    executionMode: "fixture-only",
  },
  {
    id: "silent-successful-verifier-negative",
    slice: "7",
    evidenceKind: "loop-replay",
    fixtureIds: ["non-tb-silent-successful-verifier"],
    expectedGate:
      "silent successful verifier/build commands are treated as success evidence, not loops",
    benchmarkSpecific: false,
    executionMode: "fixture-only",
  },
  {
    id: "idempotent-service-control-negative",
    slice: "7",
    evidenceKind: "loop-replay",
    fixtureIds: ["non-tb-idempotent-service-control"],
    expectedGate: "repeated idempotent service-control output does not become a loop halt",
    benchmarkSpecific: false,
    executionMode: "fixture-only",
  },
  {
    id: "edit-anchor-churn",
    slice: "7",
    evidenceKind: "loop-replay",
    fixtureIds: ["non-tb-edit-anchor-churn"],
    expectedGate:
      "edit-anchor recovery churn remains eligible for feedback and progress, not blind halt",
    benchmarkSpecific: false,
    executionMode: "fixture-only",
  },
  {
    id: "empty-turn-provider-replay",
    slice: "7",
    evidenceKind: "provider-terminal",
    fixtureIds: ["provider-empty-stop"],
    expectedGate:
      "empty provider stop retries once or fails closed instead of mapping to clean model-stop",
    benchmarkSpecific: false,
    executionMode: "fixture-only",
  },
] as const satisfies readonly CoreHarnessQualityScenario[];

export interface CoreHarnessQualityScenarioReport extends CoreHarnessQualityScenario {
  readonly ok: boolean;
  readonly missingFixtureIds: readonly string[];
  readonly loopWarningIds: readonly string[];
  readonly loopForcedPivotIds: readonly string[];
  readonly loopTerminalIds: readonly string[];
  readonly semanticBlockingReasons: readonly string[];
  readonly benchmarkSpecificFixtureIds: readonly string[];
  readonly blockingReasons: readonly string[];
}

export interface CoreHarnessQualityReport {
  readonly ok: boolean;
  readonly scenarios: readonly CoreHarnessQualityScenarioReport[];
  readonly loopCalibration: LoopDetectionCalibrationReport;
  readonly nonTbReplayFixtureCount: number;
  readonly slice7ScenarioFixtureCount: number;
  readonly addedRuntimeProbeCount: 0;
  readonly blockingReasons: readonly string[];
}

export interface CoreHarnessQualityFixtureOverrides {
  readonly loopReplayFixtures?: readonly LoopDetectionReplayFixture[];
  readonly loopReplayMetadata?: readonly CoreHarnessLoopReplayMetadata[];
  readonly serviceLifecycleFixtures?: readonly CoreHarnessServiceLifecycleFixture[];
  readonly acceptanceArtifactFixtures?: readonly CoreHarnessAcceptanceArtifactFixture[];
  readonly contextPressureFixtures?: readonly CoreHarnessContextPressureFixture[];
  readonly providerTerminalFixtures?: readonly CoreHarnessProviderTerminalFixture[];
}

export interface CoreHarnessQualityEvaluationOptions {
  readonly fixtures?: CoreHarnessQualityFixtureOverrides;
}

interface CoreHarnessQualityFixtureSet {
  readonly loopReplayFixtures: readonly LoopDetectionReplayFixture[];
  readonly loopReplayMetadata: readonly CoreHarnessLoopReplayMetadata[];
  readonly serviceLifecycleFixtures: readonly CoreHarnessServiceLifecycleFixture[];
  readonly acceptanceArtifactFixtures: readonly CoreHarnessAcceptanceArtifactFixture[];
  readonly contextPressureFixtures: readonly CoreHarnessContextPressureFixture[];
  readonly providerTerminalFixtures: readonly CoreHarnessProviderTerminalFixture[];
}

export function evaluateCoreHarnessQualitySuite(
  options: CoreHarnessQualityEvaluationOptions = {},
): CoreHarnessQualityReport {
  const fixtures = qualityFixtureSet(options.fixtures);
  const loopCalibration = calibrateLoopDetectionFixtures(fixtures.loopReplayFixtures, {
    detector: PROGRESS_CONTRACT_LOOP_CONFIG,
    minMedianTokenSavingsRatio: 0.7,
    corpusMetadata: fixtures.loopReplayMetadata,
    corpusRequirements: CORE_HARNESS_LOOP_REPLAY_CORPUS_REQUIREMENTS,
  });
  const fixtureIdsByKind = fixtureIdSets(fixtures);
  const resultById = new Map(loopCalibration.results.map((result) => [result.id, result]));
  const metadataById = new Map(
    fixtures.loopReplayMetadata.map((metadata) => [metadata.id, metadata]),
  );
  const scenarios = CORE_HARNESS_QUALITY_SCENARIOS.map((scenario) => {
    const fixtureIdsForKind = fixtureIdsByKind[scenario.evidenceKind];
    const missingFixtureIds = scenario.fixtureIds.filter((id) => !fixtureIdsForKind.has(id));
    const loopResults =
      scenario.evidenceKind === "loop-replay"
        ? scenario.fixtureIds
            .map((id) => resultById.get(id))
            .filter((result) => result !== undefined)
        : [];
    const loopWarningIds = loopResults
      .filter((result) => result.warningTurn !== undefined)
      .map((result) => result.id);
    const loopForcedPivotIds = loopResults
      .filter((result) => result.forcedPivotTurn !== undefined)
      .map((result) => result.id);
    const loopTerminalIds = loopResults
      .filter((result) => result.terminalTurn !== undefined)
      .map((result) => result.id);
    const semanticBlockingReasons = semanticBlockers(scenario, fixtures, resultById, metadataById);
    const benchmarkSpecificFixtureIds = scenario.fixtureIds.filter((id) =>
      benchmarkSpecificFixtureId(id, scenario.evidenceKind, metadataById),
    );
    const blockingReasons = [
      ...missingFixtureIds.map((id) => `missing-fixture:${id}`),
      ...loopWarningIds.map((id) => `loop-warning:${id}`),
      ...loopForcedPivotIds.map((id) => `loop-forced-pivot:${id}`),
      ...loopTerminalIds.map((id) => `loop-terminal:${id}`),
      ...semanticBlockingReasons.map((reason) => `semantic:${reason}`),
      ...benchmarkSpecificFixtureIds.map((id) => `benchmark-specific-fixture:${id}`),
    ];

    return {
      ...scenario,
      ok: blockingReasons.length === 0,
      missingFixtureIds,
      loopWarningIds,
      loopForcedPivotIds,
      loopTerminalIds,
      semanticBlockingReasons,
      benchmarkSpecificFixtureIds,
      blockingReasons,
    };
  });
  const scenarioBlockingReasons = scenarios.flatMap((scenario) =>
    scenario.blockingReasons.map((reason) => `${scenario.id}:${reason}`),
  );
  const calibrationBlockingReasons = loopCalibration.blockingReasons.map(
    (reason) => `loop-calibration:${reason}`,
  );
  const loopFixtureIds = new Set(fixtures.loopReplayFixtures.map((fixture) => fixture.id));
  const nonTbReplayFixtureCount = new Set(
    fixtures.loopReplayMetadata
      .filter((metadata) => metadata.suite === "non-tb" && loopFixtureIds.has(metadata.id))
      .map((metadata) => metadata.id),
  ).size;
  const slice7ScenarioFixtureCount = new Set(
    CORE_HARNESS_QUALITY_SCENARIOS.flatMap((scenario) => scenario.fixtureIds),
  ).size;
  const blockingReasons = [...calibrationBlockingReasons, ...scenarioBlockingReasons];

  return {
    ok: blockingReasons.length === 0,
    scenarios,
    loopCalibration,
    nonTbReplayFixtureCount,
    slice7ScenarioFixtureCount,
    addedRuntimeProbeCount: 0,
    blockingReasons,
  };
}

function qualityFixtureSet(
  overrides: CoreHarnessQualityFixtureOverrides = {},
): CoreHarnessQualityFixtureSet {
  return {
    loopReplayFixtures: overrides.loopReplayFixtures ?? CORE_HARNESS_LOOP_REPLAY_FIXTURES,
    loopReplayMetadata: overrides.loopReplayMetadata ?? CORE_HARNESS_LOOP_REPLAY_METADATA,
    serviceLifecycleFixtures:
      overrides.serviceLifecycleFixtures ?? CORE_HARNESS_SERVICE_LIFECYCLE_FIXTURES,
    acceptanceArtifactFixtures:
      overrides.acceptanceArtifactFixtures ?? CORE_HARNESS_ACCEPTANCE_ARTIFACT_FIXTURES,
    contextPressureFixtures:
      overrides.contextPressureFixtures ?? CORE_HARNESS_CONTEXT_PRESSURE_FIXTURES,
    providerTerminalFixtures:
      overrides.providerTerminalFixtures ?? CORE_HARNESS_PROVIDER_TERMINAL_FIXTURES,
  };
}

function fixtureIdSets(
  fixtures: CoreHarnessQualityFixtureSet,
): Record<CoreHarnessQualityEvidenceKind, ReadonlySet<string>> {
  return {
    "loop-replay": new Set(fixtures.loopReplayFixtures.map((fixture) => fixture.id)),
    "service-lifecycle": new Set(fixtures.serviceLifecycleFixtures.map((fixture) => fixture.id)),
    "acceptance-artifact": new Set(
      fixtures.acceptanceArtifactFixtures.map((fixture) => fixture.id),
    ),
    "context-pressure": new Set(fixtures.contextPressureFixtures.map((fixture) => fixture.id)),
    "provider-terminal": new Set(fixtures.providerTerminalFixtures.map((fixture) => fixture.id)),
  };
}

function semanticBlockers(
  scenario: CoreHarnessQualityScenario,
  fixtures: CoreHarnessQualityFixtureSet,
  resultById: ReadonlyMap<string, { readonly label: string }>,
  metadataById: ReadonlyMap<string, CoreHarnessLoopReplayMetadata>,
): readonly string[] {
  switch (scenario.evidenceKind) {
    case "loop-replay":
      return scenario.fixtureIds.flatMap((id) =>
        validateLoopFixture(id, resultById.get(id), metadataById.get(id)),
      );
    case "service-lifecycle":
      return scenario.fixtureIds.flatMap((id) =>
        validateServiceFixture(
          id,
          fixtures.serviceLifecycleFixtures.find((fixture) => fixture.id === id),
        ),
      );
    case "acceptance-artifact":
      return scenario.fixtureIds.flatMap((id) =>
        validateArtifactFixture(
          id,
          fixtures.acceptanceArtifactFixtures.find((fixture) => fixture.id === id),
        ),
      );
    case "context-pressure":
      return scenario.fixtureIds.flatMap((id) =>
        validateContextFixture(
          id,
          fixtures.contextPressureFixtures.find((fixture) => fixture.id === id),
        ),
      );
    case "provider-terminal":
      return scenario.fixtureIds.flatMap((id) =>
        validateProviderTerminalFixture(
          id,
          fixtures.providerTerminalFixtures.find((fixture) => fixture.id === id),
        ),
      );
  }
}

function validateLoopFixture(
  id: string,
  result: { readonly label: string } | undefined,
  metadata: CoreHarnessLoopReplayMetadata | undefined,
): readonly string[] {
  const reasons: string[] = [];
  if (result?.label !== "legit-progress") reasons.push(`loop-not-legit-progress:${id}`);
  if (metadata?.suite !== "non-tb") reasons.push(`loop-not-non-tb:${id}`);
  if (metadata?.heldOut !== true) reasons.push(`loop-not-held-out:${id}`);
  if (metadata?.sourceArtifact !== undefined) reasons.push(`loop-has-source-artifact:${id}`);
  return reasons;
}

function validateServiceFixture(
  id: string,
  fixture: CoreHarnessServiceLifecycleFixture | undefined,
): readonly string[] {
  if (fixture === undefined) return [];
  const reasons: string[] = [];
  if (fixture.rootCauseId !== "non-tb-local-service-handoff") {
    reasons.push(`service-not-non-tb-root:${id}`);
  }
  if (fixture.boundary !== "kernel-runtime") reasons.push(`service-not-kernel-runtime:${id}`);
  if (!fixture.commandShape.includes("http.server")) reasons.push(`service-not-http-server:${id}`);
  if (fixture.trustedLeaseSource !== true) reasons.push(`service-untrusted-lease:${id}`);
  if (fixture.preservationScope !== "until-verifier-handoff") {
    reasons.push(`service-wrong-preservation-scope:${id}`);
  }
  for (const field of ["ownerToolCallId", "pid", "port", "startIdentity", "cleanupOwner"]) {
    if (!fixture.requiredLeaseFields.includes(field)) {
      reasons.push(`service-missing-lease-field:${id}:${field}`);
    }
  }
  if (fixture.mustSurviveRuntimeDispose !== true) {
    reasons.push(`service-must-survive-runtime-dispose:${id}`);
  }
  if (fixture.mustCleanupAfterProbe !== true)
    reasons.push(`service-must-cleanup-after-probe:${id}`);
  if (fixture.expectedDisposition !== "preserve-until-probe") {
    reasons.push(`service-not-preserve-until-probe:${id}`);
  }
  return reasons;
}

function validateArtifactFixture(
  id: string,
  fixture: CoreHarnessAcceptanceArtifactFixture | undefined,
): readonly string[] {
  if (fixture === undefined) return [];
  const reasons: string[] = [];
  if (fixture.rootCauseId !== "non-tb-generated-artifact") {
    reasons.push(`artifact-not-non-tb-root:${id}`);
  }
  if (fixture.path !== "artifacts/report.html") reasons.push(`artifact-path-not-exact:${id}`);
  if (fixture.source !== "explicit-task-path") {
    reasons.push(`artifact-source-not-explicit-task-path:${id}`);
  }
  if (fixture.confidence !== "high") reasons.push(`artifact-confidence-not-high:${id}`);
  if (fixture.modifiedByModel) reasons.push(`artifact-modified-by-model:${id}`);
  if (fixture.hiddenGraderLike) reasons.push(`artifact-hidden-grader-like:${id}`);
  if (fixture.virtualState.exists !== true) reasons.push(`artifact-not-present:${id}`);
  if (fixture.virtualState.content.trim().length === 0) reasons.push(`artifact-empty:${id}`);
  if (fixture.expectedVerdict !== "warn") reasons.push(`artifact-wrong-verdict:${id}`);
  if (fixture.semanticCorrectnessClaim !== "not-proven-by-existence") {
    reasons.push(`artifact-overclaims-semantics:${id}`);
  }
  return reasons;
}

function validateContextFixture(
  id: string,
  fixture: CoreHarnessContextPressureFixture | undefined,
): readonly string[] {
  if (fixture === undefined) return [];
  const reasons: string[] = [];
  if (fixture.desiredPressureSource === "local-estimate") {
    reasons.push(`context-uses-local-estimate:${id}`);
  }
  if (fixture.localEstimateTokens >= fixture.softWindowTokens) {
    reasons.push(`context-local-estimate-already-pressured:${id}`);
  }
  if (fixture.contextWindowTokens <= fixture.softWindowTokens) {
    reasons.push(`context-soft-window-out-of-range:${id}`);
  }
  if (
    fixture.desiredPressureSource === "provider-usage" &&
    fixture.providerLastRequestInputTokens <= fixture.softWindowTokens
  ) {
    reasons.push(`context-provider-usage-not-pressured:${id}`);
  }
  if (
    fixture.desiredPressureSource === "new-observation-estimate" &&
    fixture.newlyAppendedObservationEstimateTokens <= fixture.softWindowTokens
  ) {
    reasons.push(`context-observation-not-pressured:${id}`);
  }
  if (fixture.expectedAction === "compact-or-shape") {
    reasons.push(`context-action-too-ambiguous:${id}`);
  }
  return reasons;
}

function validateProviderTerminalFixture(
  id: string,
  fixture: CoreHarnessProviderTerminalFixture | undefined,
): readonly string[] {
  if (fixture === undefined) return [];
  const reasons: string[] = [];
  if (fixture.terminalKind !== "empty-stop") reasons.push(`provider-not-empty-stop:${id}`);
  if (fixture.mustNotMapTo !== "model-stop") reasons.push(`provider-maps-to-model-stop:${id}`);
  if (fixture.desiredHandling !== "retry-once") {
    reasons.push(`provider-empty-stop-not-retry-once:${id}`);
  }
  if (fixture.chunk.type !== "finish" || fixture.chunk.reason !== "stop") {
    reasons.push(`provider-empty-stop-not-clean-provider-stop:${id}`);
  }
  if (fixture.chunk.type === "finish" && fixture.chunk.usage.outputTokens !== 0) {
    reasons.push(`provider-empty-stop-has-output:${id}`);
  }
  return reasons;
}

function benchmarkSpecificFixtureId(
  id: string,
  evidenceKind: CoreHarnessQualityEvidenceKind,
  metadataById: ReadonlyMap<string, CoreHarnessLoopReplayMetadata>,
): boolean {
  if (id.startsWith("pool-") || id.startsWith("tb2-")) return true;
  const metadata = metadataById.get(id);
  if (metadata?.sourceArtifact !== undefined) return true;
  return evidenceKind === "loop-replay" && metadata?.suite !== "non-tb";
}
