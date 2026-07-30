import { effectiveTokens, grossTokens } from "@keel/shared";
import { describe, expect, it } from "vitest";
import { PROGRESS_CONTRACT_LOOP_CONFIG } from "./loop-detection.js";
import { calibrateLoopDetectionFixtures } from "./loop-detection-replay.js";
import {
  CORE_HARNESS_ACCEPTANCE_ARTIFACT_FIXTURES,
  CORE_HARNESS_CONTEXT_PRESSURE_FIXTURES,
  CORE_HARNESS_GAP_FIXTURES,
  CORE_HARNESS_LOOP_REPLAY_FIXTURES,
  CORE_HARNESS_LOOP_REPLAY_CORPUS_REQUIREMENTS,
  CORE_HARNESS_LOOP_REPLAY_METADATA,
  CORE_HARNESS_PROVIDER_TERMINAL_FIXTURES,
  CORE_HARNESS_SERVICE_LIFECYCLE_FIXTURES,
  REQUIRED_SLICE_0_FIXTURE_IDS,
  SLICE_2_5_LOOP_FIXTURE_IDS,
} from "./core-harness-reliability-fixtures.js";

describe("Epic 2.28 Slice 0 core harness reliability fixtures", () => {
  it("commits a fixture for every Slice 0 root-cause class before behavior changes", () => {
    const ids = new Set(CORE_HARNESS_GAP_FIXTURES.map((fixture) => fixture.id));

    expect(ids).toEqual(new Set(REQUIRED_SLICE_0_FIXTURE_IDS));
  });

  it("keeps every concrete primitive fixture linked to a Slice 0 root cause", () => {
    const rootIds = new Set(REQUIRED_SLICE_0_FIXTURE_IDS);
    const linkedIds = [
      ...CORE_HARNESS_CONTEXT_PRESSURE_FIXTURES.map((fixture) => fixture.rootCauseId),
      ...CORE_HARNESS_SERVICE_LIFECYCLE_FIXTURES.map((fixture) => fixture.rootCauseId),
      ...CORE_HARNESS_ACCEPTANCE_ARTIFACT_FIXTURES.map((fixture) => fixture.rootCauseId),
      ...CORE_HARNESS_PROVIDER_TERMINAL_FIXTURES.map((fixture) => fixture.rootCauseId),
      ...CORE_HARNESS_LOOP_REPLAY_METADATA.map((fixture) => fixture.rootCauseId),
    ];

    for (const id of linkedIds) expect(rootIds.has(id)).toBe(true);
  });

  it("keeps the replay corpus broader than Terminal-Bench", () => {
    const nonTbFixtures = CORE_HARNESS_GAP_FIXTURES.filter((fixture) => fixture.suite !== "tb2");
    const tbFixtures = CORE_HARNESS_GAP_FIXTURES.filter((fixture) => fixture.suite === "tb2");

    expect(tbFixtures.length).toBeGreaterThanOrEqual(5);
    expect(nonTbFixtures.length).toBeGreaterThanOrEqual(7);
    expect(nonTbFixtures.map((fixture) => fixture.id)).toEqual(
      expect.arrayContaining([
        "non-tb-slow-legitimate-progress",
        "non-tb-long-compile-repeated-output",
        "non-tb-local-service-handoff",
        "non-tb-generated-artifact",
        "non-tb-broad-scalar-metric",
        "non-tb-monotonic-noisy-improvement",
        "non-tb-edit-anchor-churn",
      ]),
    );
  });

  it("reports inspectable per-fixture replay outcomes for default-on loop tuning", () => {
    const report = calibrateLoopDetectionFixtures(CORE_HARNESS_LOOP_REPLAY_FIXTURES, {
      detector: PROGRESS_CONTRACT_LOOP_CONFIG,
      minMedianTokenSavingsRatio: 0.7,
      corpusMetadata: CORE_HARNESS_LOOP_REPLAY_METADATA,
      corpusRequirements: CORE_HARNESS_LOOP_REPLAY_CORPUS_REQUIREMENTS,
    });
    const resultById = new Map(report.results.map((result) => [result.id, result]));

    expect(resultById.get("tb2-large-scale-text-editing-minimized")?.terminalTurn).toBeDefined();
    expect(resultById.get("tb2-largest-eigenval-post-solution-churn")?.terminalTurn).toBeDefined();
    expect(resultById.get("tb2-high-burn-varied-nonprogress-loop")?.terminalTurn).toBeDefined();
    expect(resultById.get("tb2-known-good-preemption")?.preemptsKnownGood).toBe(false);
    for (const id of [
      "non-tb-slow-legitimate-progress",
      "non-tb-long-compile-repeated-output",
      "non-tb-local-service-handoff",
      "non-tb-generated-artifact",
      "non-tb-broad-scalar-metric",
      "non-tb-monotonic-noisy-improvement",
      "non-tb-cache-heavy-progress",
      "non-tb-edit-anchor-churn",
    ]) {
      expect(resultById.get(id)?.terminalTurn).toBeUndefined();
    }
    expect(report.clearFalsePositiveCount).toBe(0);
    expect(report.clearFalsePositiveIds).toEqual([]);
    expect(report.knownGoodPreemptionCount).toBe(0);
    expect(report.knownGoodPreemptionIds).toEqual([]);
    expect(report.ambiguousTerminalIds).toEqual([]);
    expect(report.clearWarningIds).toEqual([]);
    expect(report.knownGoodWarningPreemptionIds).toEqual([]);
    expect(report.corpusBlockingReasons).toEqual([]);
    expect(report.blockingReasons).toEqual([]);
    expect(report.defaultOnEligible).toBe(true);
  });

  it("keeps cache-heavy replay usage contract-valid while exercising gross context pressure", () => {
    const fixture = CORE_HARNESS_LOOP_REPLAY_FIXTURES.find(
      (candidate) => candidate.id === "non-tb-cache-heavy-progress",
    );
    if (fixture === undefined) throw new Error("missing cache-heavy replay fixture");

    for (const step of fixture.steps) {
      if (step.usage?.cachedInputTokens !== undefined) {
        expect(step.usage.cachedInputTokens).toBeLessThanOrEqual(step.usage.inputTokens);
      }
    }

    const gross = fixture.steps.reduce(
      (sum, step) => sum + (step.usage === undefined ? 0 : grossTokens(step.usage)),
      0,
    );
    const effective = fixture.steps.reduce(
      (sum, step) => sum + (step.usage === undefined ? 0 : effectiveTokens(step.usage, 0.1)),
      0,
    );
    const report = calibrateLoopDetectionFixtures(CORE_HARNESS_LOOP_REPLAY_FIXTURES, {
      detector: PROGRESS_CONTRACT_LOOP_CONFIG,
      minMedianTokenSavingsRatio: 0.7,
      cacheReadWeight: 0.1,
      corpusMetadata: CORE_HARNESS_LOOP_REPLAY_METADATA,
      corpusRequirements: CORE_HARNESS_LOOP_REPLAY_CORPUS_REQUIREMENTS,
    });
    const result = report.results.find((candidate) => candidate.id === fixture.id);

    expect(gross).toBeGreaterThan(700_000);
    expect(effective / gross).toBeLessThan(0.25);
    expect(result?.terminalTurn).toBeUndefined();
    expect(report.clearFalsePositiveIds).not.toContain(fixture.id);
    expect(report.clearWarningIds).not.toContain(fixture.id);
  });

  it("keeps Slice 2.5 harvest loop fixtures artifact-concrete and task-name-free in production", () => {
    const metadataById = new Map(
      CORE_HARNESS_LOOP_REPLAY_METADATA.map((metadata) => [metadata.id, metadata]),
    );
    const fixtureById = new Map(
      CORE_HARNESS_LOOP_REPLAY_FIXTURES.map((fixture) => [fixture.id, fixture]),
    );

    for (const id of SLICE_2_5_LOOP_FIXTURE_IDS) {
      const metadata = metadataById.get(id);
      const fixture = fixtureById.get(id);
      if (metadata === undefined || fixture === undefined) {
        throw new Error(`missing Slice 2.5 loop fixture metadata: ${id}`);
      }
      const sourceArtifact = "sourceArtifact" in metadata ? metadata.sourceArtifact : undefined;
      const originalTerminalReason =
        "originalTerminalReason" in metadata ? metadata.originalTerminalReason : undefined;
      const currentReplayExpectation =
        "currentReplayExpectation" in metadata ? metadata.currentReplayExpectation : undefined;
      const targetReplayExpectation =
        "targetReplayExpectation" in metadata ? metadata.targetReplayExpectation : undefined;
      expect(sourceArtifact).toMatch(/^fixture-source:reliability-calibration-v1#/);
      expect(originalTerminalReason).toMatch(/\S/);
      expect(currentReplayExpectation).toMatch(/^(warn-or-terminal|no-terminal)$/);
      expect(targetReplayExpectation).toMatch(/^(warn-or-terminal|no-terminal)$/);
      expect(JSON.stringify(fixture.steps)).not.toContain(`"${id}"`);
    }
  });

  it("keeps Slice 2.5 clear-progress harvest fixtures out of terminal loop stops", () => {
    const clearProgressIds = SLICE_2_5_LOOP_FIXTURE_IDS.filter(
      (id) => id !== "pool-true-high-burn-no-progress-traceback",
    );
    const report = calibrateLoopDetectionFixtures(CORE_HARNESS_LOOP_REPLAY_FIXTURES, {
      detector: PROGRESS_CONTRACT_LOOP_CONFIG,
      minMedianTokenSavingsRatio: 0.7,
      corpusMetadata: CORE_HARNESS_LOOP_REPLAY_METADATA,
      corpusRequirements: CORE_HARNESS_LOOP_REPLAY_CORPUS_REQUIREMENTS,
    });
    const resultById = new Map(report.results.map((result) => [result.id, result]));

    for (const id of clearProgressIds) {
      expect(resultById.get(id)?.warningTurn).toBeUndefined();
      expect(resultById.get(id)?.terminalTurn).toBeUndefined();
    }
    expect(resultById.get("pool-true-high-burn-no-progress-traceback")?.terminalTurn).toBeDefined();
    expect(report.clearFalsePositiveCount).toBe(0);
    expect(report.knownGoodPreemptionCount).toBe(0);
  });

  it("captures context-pressure blind spots as numeric executable scenarios", () => {
    expect(CORE_HARNESS_CONTEXT_PRESSURE_FIXTURES.length).toBeGreaterThanOrEqual(3);

    for (const fixture of CORE_HARNESS_CONTEXT_PRESSURE_FIXTURES) {
      expect(fixture.localEstimateTokens).toBeLessThan(fixture.softWindowTokens);
      expect(fixture.desiredPressureSource).not.toBe("local-estimate");
      expect(fixture.provider).toMatch(/^[a-z0-9-]+$/);
      expect(fixture.model).toMatch(/\S/);
      expect(fixture.contextWindowTokens).toBeGreaterThan(fixture.softWindowTokens);
      if (fixture.desiredPressureSource === "provider-usage") {
        expect(fixture.providerLastRequestInputTokens).toBeGreaterThan(fixture.softWindowTokens);
      }
      if (fixture.desiredPressureSource === "new-observation-estimate") {
        expect(fixture.newlyAppendedObservationEstimateTokens).toBeGreaterThan(
          fixture.softWindowTokens,
        );
      }
      expect(fixture.expectedAction).toMatch(/^(compact|shape|compact-or-shape)$/);
    }
    expect(CORE_HARNESS_CONTEXT_PRESSURE_FIXTURES.map((fixture) => fixture.id)).toEqual(
      expect.arrayContaining([
        "tb2-dense-context-under-count",
        "tb2-newly-appended-giant-observation",
        "non-tb-128k-window-dense-output",
      ]),
    );
  });

  it("captures service teardown fixtures with lease identity and adversarial cleanup requirements", () => {
    expect(CORE_HARNESS_SERVICE_LIFECYCLE_FIXTURES.map((fixture) => fixture.id)).toEqual(
      expect.arrayContaining([
        "tb2-service-killed-on-teardown",
        "non-tb-local-service-handoff",
        "service-unleased-background-reaped",
        "service-warden-abort-fail-closed",
        "service-pid-reuse-rejected",
        "service-fork-during-kill-reaped",
      ]),
    );
    expect(
      CORE_HARNESS_SERVICE_LIFECYCLE_FIXTURES.map((fixture) => fixture.expectedDisposition),
    ).toEqual(
      expect.arrayContaining(["preserve-until-probe", "reap-unleased", "fail-closed-reap"]),
    );
    for (const fixture of CORE_HARNESS_SERVICE_LIFECYCLE_FIXTURES) {
      expect(fixture.requiredLeaseFields).toEqual(
        expect.arrayContaining(["ownerToolCallId", "pid", "startIdentity", "cleanupOwner"]),
      );
      if (fixture.expectedDisposition === "preserve-until-probe") {
        expect(fixture.trustedLeaseSource).toBe(true);
        expect(fixture.mustSurviveRuntimeDispose).toBe(true);
        expect(fixture.mustCleanupAfterProbe).toBe(true);
      } else {
        expect(fixture.trustedLeaseSource).toBe(false);
        expect(fixture.mustSurviveRuntimeDispose).toBe(false);
      }
    }
  });

  it("captures artifact acceptance edge cases, provenance, and denied evidence sources", () => {
    expect(CORE_HARNESS_ACCEPTANCE_ARTIFACT_FIXTURES.map((fixture) => fixture.contentKind)).toEqual(
      expect.arrayContaining([
        "missing",
        "zero-byte",
        "whitespace-only",
        "tiny-stub",
        "semantic-unknown",
      ]),
    );
    expect(CORE_HARNESS_ACCEPTANCE_ARTIFACT_FIXTURES.map((fixture) => fixture.id)).toEqual(
      expect.arrayContaining([
        "artifact-model-authored-path-denied",
        "artifact-project-fake-pass-script-denied",
        "artifact-mutated-package-script-denied",
        "artifact-hidden-grader-path-denied",
      ]),
    );
    for (const fixture of CORE_HARNESS_ACCEPTANCE_ARTIFACT_FIXTURES) {
      expect(fixture.semanticCorrectnessClaim).toBe("not-proven-by-existence");
      if (fixture.confidence === "denied") {
        expect(fixture.expectedVerdict).toBe("deny-source");
        expect(
          fixture.modifiedByModel ||
            fixture.hiddenGraderLike ||
            fixture.source === "project-authored-script",
        ).toBe(true);
      } else {
        expect(fixture.modifiedByModel).toBe(false);
        expect(fixture.hiddenGraderLike).toBe(false);
      }
    }
  });

  it("captures malformed terminal chunks that must not become clean model-stop", () => {
    expect(CORE_HARNESS_PROVIDER_TERMINAL_FIXTURES.map((fixture) => fixture.terminalKind)).toEqual([
      "empty-stop",
      "unknown-finish",
      "content-filter",
      "malformed-chunk",
    ]);
    for (const fixture of CORE_HARNESS_PROVIDER_TERMINAL_FIXTURES) {
      expect(fixture.mustNotMapTo).toBe("model-stop");
      expect(fixture.rootCauseId).toBe("tb2-empty-malformed-model-stop");
      expect(fixture.chunk).toBeDefined();
    }
  });

  it("links replay metadata to the executable replay corpus", () => {
    expect(CORE_HARNESS_LOOP_REPLAY_METADATA.map((metadata) => metadata.id).sort()).toEqual(
      CORE_HARNESS_LOOP_REPLAY_FIXTURES.map((fixture) => fixture.id).sort(),
    );
    expect(
      CORE_HARNESS_LOOP_REPLAY_METADATA.filter(
        (metadata) => metadata.suite === "non-tb" && metadata.heldOut === true,
      ).length,
    ).toBeGreaterThanOrEqual(6);
    expect(
      CORE_HARNESS_LOOP_REPLAY_METADATA.some(
        (metadata) => metadata.suite === "non-tb" && metadata.highBurn === true,
      ),
    ).toBe(true);
    expect(
      CORE_HARNESS_LOOP_REPLAY_METADATA.filter(
        (metadata) => metadata.costExpectation === "gross-context-not-effective-cost",
      ).map((metadata) => metadata.id),
    ).toEqual(["non-tb-cache-heavy-progress"]);
    expect(
      CORE_HARNESS_LOOP_REPLAY_METADATA.find(
        (metadata) => metadata.id === "tb2-known-good-preemption",
      )?.knownGoodProvenance,
    ).toBe("explicit-fixture-oracle");
  });
});
