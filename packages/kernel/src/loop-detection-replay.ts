import { effectiveTokens, grossTokens, type JsonObjectT, type ModelUsageT } from "@keel/shared";
import { estimateTokens } from "./context/system-prompt.js";
import { LoopDetector, type LoopDetectionConfig } from "./loop-detection.js";

export type LoopDetectionReplayLabel = "true-loop" | "legit-progress" | "ambiguous" | "unknown";
export type LoopDetectionCalibrationBlockingReason =
  | "missing-true-loop-fixtures"
  | "true-loop-missing-warning"
  | "true-loop-missing-terminal"
  | "unbounded-true-loop-recovery"
  | "clear-progress-terminal"
  | "clear-progress-warning"
  | "ambiguous-terminal"
  | "ambiguous-warning"
  | "known-good-preemption"
  | "known-good-warning-preemption"
  | "known-good-forced-pivot-preemption"
  | "clear-progress-forced-pivot"
  | "ambiguous-forced-pivot"
  | "insufficient-gross-token-savings"
  | "missing-gross-savings-baseline"
  | "missing-corpus-requirements"
  | "missing-corpus-metadata"
  | "insufficient-non-tb-heldout-fixtures"
  | "missing-required-root-cause"
  | "missing-required-non-tb-heldout-root-cause"
  | "missing-known-good-fixture";
type BlockingEntry = readonly [LoopDetectionCalibrationBlockingReason, readonly string[]];

export interface LoopDetectionReplayStep {
  readonly call: { readonly name: string; readonly args: JsonObjectT };
  readonly output: string;
  readonly usage?: ModelUsageT;
  readonly turnUsage?: {
    readonly usage: ModelUsageT;
    readonly toolCallCount: number;
  };
}

export interface LoopDetectionReplayFixture {
  readonly id: string;
  readonly label: LoopDetectionReplayLabel;
  readonly detector?: LoopDetectionConfig;
  readonly steps: readonly LoopDetectionReplayStep[];
  readonly historical?: {
    readonly terminalTurn?: number;
    readonly terminalTokens?: number;
    readonly terminalEffectiveTokens?: number;
  };
  readonly knownGoodTurn?: number;
}

export interface LoopDetectionReplayResult {
  readonly id: string;
  readonly label: LoopDetectionReplayLabel;
  readonly warningTurn?: number;
  readonly warningReason?: string;
  readonly forcedPivotTurn?: number;
  readonly forcedPivotReason?: string;
  readonly terminalTurn?: number;
  readonly terminalReason?: string;
  readonly terminalTokens?: number;
  readonly terminalEffectiveTokens?: number;
  readonly historicalTerminalTurn?: number;
  readonly historicalTokens?: number;
  readonly historicalEffectiveTokens?: number;
  readonly tokensSaved?: number;
  readonly effectiveTokensSaved?: number;
  readonly preemptsKnownGood: boolean;
}

export interface LoopDetectionCalibrationOptions {
  readonly detector?: LoopDetectionConfig;
  readonly minMedianTokenSavingsRatio?: number;
  readonly cacheReadWeight?: number;
  readonly corpusMetadata?: readonly LoopDetectionReplayCorpusMetadata[];
  readonly corpusRequirements?: LoopDetectionReplayCorpusRequirements;
}

export interface LoopDetectionReplayCorpusMetadata {
  readonly id: string;
  readonly rootCauseId?: string;
  readonly suite?: "tb2" | "non-tb";
  readonly heldOut?: boolean;
  readonly knownGoodProvenance?: string;
}

export interface LoopDetectionReplayCorpusRequirements {
  readonly minNonTbHeldOutFixtures?: number;
  readonly requiredRootCauseIds?: readonly string[];
  readonly requiredNonTbHeldOutRootCauseIds?: readonly string[];
  readonly requireKnownGoodFixture?: boolean;
}

export interface LoopDetectionCalibrationReport {
  readonly results: readonly LoopDetectionReplayResult[];
  readonly trueLoopCount: number;
  readonly trueLoopWarningCount: number;
  readonly trueLoopTerminalCount: number;
  readonly clearProgressCount: number;
  readonly clearFalsePositiveCount: number;
  readonly clearFalsePositiveIds: readonly string[];
  readonly clearWarningIds: readonly string[];
  readonly clearForcedPivotIds: readonly string[];
  readonly ambiguousCount: number;
  readonly ambiguousTerminalCount: number;
  readonly ambiguousTerminalIds: readonly string[];
  readonly ambiguousWarningIds: readonly string[];
  readonly ambiguousForcedPivotIds: readonly string[];
  readonly knownGoodPreemptionCount: number;
  readonly knownGoodPreemptionIds: readonly string[];
  readonly knownGoodWarningPreemptionIds: readonly string[];
  readonly knownGoodForcedPivotPreemptionIds: readonly string[];
  readonly medianTrueLoopTokenSavingsRatio: number;
  readonly grossSavingsSampleCount: number;
  readonly grossSavingsMissingBaselineIds: readonly string[];
  readonly medianTrueLoopEffectiveSavingsRatio: number | undefined;
  readonly effectiveSavingsSampleCount: number;
  readonly effectiveSavingsMissingBaselineIds: readonly string[];
  readonly corpusBlockingReasons: readonly LoopDetectionCalibrationBlockingReason[];
  readonly missingCorpusMetadataIds: readonly string[];
  readonly missingRequiredRootCauseIds: readonly string[];
  readonly missingRequiredNonTbHeldOutRootCauseIds: readonly string[];
  readonly blockerFixtureIds: Readonly<
    Partial<Record<LoopDetectionCalibrationBlockingReason, readonly string[]>>
  >;
  readonly blockingReasons: readonly LoopDetectionCalibrationBlockingReason[];
  readonly outcomeEligible: boolean;
  readonly defaultOnEligible: boolean;
}

export function replayStepsFromModelTurn(
  steps: readonly Omit<LoopDetectionReplayStep, "usage" | "turnUsage">[],
  usage: ModelUsageT,
): LoopDetectionReplayStep[] {
  const toolCallCount = steps.length;
  if (toolCallCount === 0) return [];
  return steps.map((step) => ({
    ...step,
    turnUsage: { usage, toolCallCount },
  }));
}

/**
 * Counterfactual loop-detector replay over minimized fixtures. This is calibration-only:
 * it does not run tools, parse task names, or change production thresholds.
 */
export function replayLoopDetectionFixture(
  fixture: LoopDetectionReplayFixture,
  options: Pick<LoopDetectionCalibrationOptions, "cacheReadWeight"> = {},
): LoopDetectionReplayResult {
  const detector = new LoopDetector(fixture.detector);
  let recoveryTrips = 0;
  let warningTurn: number | undefined;
  let warningReason: string | undefined;
  let forcedPivotTurn: number | undefined;
  let forcedPivotReason: string | undefined;
  let terminalTurn: number | undefined;
  let terminalReason: string | undefined;
  let terminalTokens: number | undefined;
  let terminalEffectiveTokens: number | undefined;
  let cumulativeTokens = 0;
  let cumulativeEffectiveTokens = 0;

  for (const [i, step] of fixture.steps.entries()) {
    const cost = grossStepTokens(step);
    const effectiveCost = effectiveStepTokens(step, normalizedCacheReadWeight(options));
    cumulativeTokens += cost;
    cumulativeEffectiveTokens += effectiveCost;
    const turn = i + 1;
    const signal = detector.recordResult(step.call, step.output, { stepTokens: cost });
    if (signal === undefined) continue;
    if (signal.advisory === true) {
      detector.resetAdvisory();
      continue;
    }
    if (recoveryTrips === 0) {
      recoveryTrips += 1;
      warningTurn = turn;
      warningReason = signal.detail;
      detector.reset(signal);
      continue;
    }
    if (recoveryTrips === 1) {
      recoveryTrips += 1;
      forcedPivotTurn = turn;
      forcedPivotReason = signal.detail;
      detector.reset(signal);
      continue;
    }
    terminalTurn = turn;
    terminalReason = signal.detail;
    terminalTokens = cumulativeTokens;
    terminalEffectiveTokens = cumulativeEffectiveTokens;
    break;
  }

  const historicalTokens = fixture.historical?.terminalTokens;
  const historicalEffectiveTokens = fixture.historical?.terminalEffectiveTokens;
  const tokensSaved =
    terminalTokens !== undefined && historicalTokens !== undefined
      ? Math.max(0, historicalTokens - terminalTokens)
      : undefined;
  const effectiveTokensSaved =
    terminalEffectiveTokens !== undefined && historicalEffectiveTokens !== undefined
      ? Math.max(0, historicalEffectiveTokens - terminalEffectiveTokens)
      : undefined;

  return {
    id: fixture.id,
    label: fixture.label,
    ...(warningTurn !== undefined ? { warningTurn } : {}),
    ...(warningReason !== undefined ? { warningReason } : {}),
    ...(forcedPivotTurn !== undefined ? { forcedPivotTurn } : {}),
    ...(forcedPivotReason !== undefined ? { forcedPivotReason } : {}),
    ...(terminalTurn !== undefined ? { terminalTurn } : {}),
    ...(terminalReason !== undefined ? { terminalReason } : {}),
    ...(terminalTokens !== undefined ? { terminalTokens } : {}),
    ...(terminalEffectiveTokens !== undefined ? { terminalEffectiveTokens } : {}),
    ...(fixture.historical?.terminalTurn !== undefined
      ? { historicalTerminalTurn: fixture.historical.terminalTurn }
      : {}),
    ...(historicalTokens !== undefined ? { historicalTokens } : {}),
    ...(historicalEffectiveTokens !== undefined ? { historicalEffectiveTokens } : {}),
    ...(tokensSaved !== undefined ? { tokensSaved } : {}),
    ...(effectiveTokensSaved !== undefined ? { effectiveTokensSaved } : {}),
    preemptsKnownGood:
      terminalTurn !== undefined &&
      fixture.knownGoodTurn !== undefined &&
      terminalTurn < fixture.knownGoodTurn,
  };
}

export function calibrateLoopDetectionFixtures(
  fixtures: readonly LoopDetectionReplayFixture[],
  options: LoopDetectionCalibrationOptions = {},
): LoopDetectionCalibrationReport {
  const replayOptions =
    options.cacheReadWeight === undefined ? {} : { cacheReadWeight: options.cacheReadWeight };
  const results = fixtures.map((fixture) =>
    replayLoopDetectionFixture(
      {
        ...fixture,
        detector: { ...options.detector, ...fixture.detector },
      },
      replayOptions,
    ),
  );
  const trueLoopResults = results.filter((r) => r.label === "true-loop");
  const clearResults = results.filter((r) => r.label === "legit-progress");
  const ambiguousResults = results.filter((r) => r.label === "ambiguous");
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const savingsRatios = trueLoopResults
    .flatMap((r) =>
      r.tokensSaved !== undefined && r.historicalTokens !== undefined && r.historicalTokens > 0
        ? [r.tokensSaved / r.historicalTokens]
        : [],
    )
    .sort((a, b) => a - b);
  const grossSavingsMissingBaselineIds = trueLoopResults
    .filter((r) => r.terminalTurn !== undefined && (r.historicalTokens ?? 0) <= 0)
    .map((r) => r.id);
  const effectiveSavingsRatios = trueLoopResults
    .flatMap((r) =>
      r.effectiveTokensSaved !== undefined &&
      r.historicalEffectiveTokens !== undefined &&
      r.historicalEffectiveTokens > 0
        ? [r.effectiveTokensSaved / r.historicalEffectiveTokens]
        : [],
    )
    .sort((a, b) => a - b);
  const effectiveSavingsMissingBaselineIds = trueLoopResults
    .filter(
      (r) =>
        r.terminalEffectiveTokens !== undefined &&
        r.historicalEffectiveTokens === undefined &&
        r.terminalTurn !== undefined,
    )
    .map((r) => r.id);
  const medianTrueLoopTokenSavingsRatio = median(savingsRatios);
  const medianTrueLoopEffectiveSavingsRatio =
    effectiveSavingsRatios.length > 0 ? median(effectiveSavingsRatios) : undefined;
  const trueLoopWarningCount = trueLoopResults.filter((r) => r.warningTurn !== undefined).length;
  const trueLoopTerminalCount = trueLoopResults.filter((r) => r.terminalTurn !== undefined).length;
  const trueLoopMissingWarningIds = trueLoopResults
    .filter((r) => r.warningTurn === undefined)
    .map((r) => r.id);
  const trueLoopMissingTerminalIds = trueLoopResults
    .filter((r) => r.terminalTurn === undefined)
    .map((r) => r.id);
  const unboundedTrueLoopRecoveryIds = trueLoopResults
    .filter(
      (r) =>
        r.warningTurn !== undefined &&
        r.terminalTurn !== undefined &&
        r.terminalTurn > r.warningTurn + 2,
    )
    .map((r) => r.id);
  const insufficientGrossSavingsIds = trueLoopResults
    .filter(
      (r) =>
        r.tokensSaved !== undefined &&
        r.historicalTokens !== undefined &&
        r.historicalTokens > 0 &&
        r.tokensSaved / r.historicalTokens < (options.minMedianTokenSavingsRatio ?? 0.7),
    )
    .map((r) => r.id);
  const clearFalsePositiveIds = clearResults
    .filter((r) => r.terminalTurn !== undefined)
    .map((r) => r.id);
  const clearWarningIds = clearResults.filter((r) => r.warningTurn !== undefined).map((r) => r.id);
  const clearForcedPivotIds = clearResults
    .filter((r) => r.forcedPivotTurn !== undefined)
    .map((r) => r.id);
  const ambiguousTerminalIds = ambiguousResults
    .filter((r) => r.terminalTurn !== undefined)
    .map((r) => r.id);
  const ambiguousWarningIds = ambiguousResults
    .filter((r) => r.warningTurn !== undefined)
    .map((r) => r.id);
  const ambiguousForcedPivotIds = ambiguousResults
    .filter((r) => r.forcedPivotTurn !== undefined)
    .map((r) => r.id);
  const knownGoodPreemptionIds = results.filter((r) => r.preemptsKnownGood).map((r) => r.id);
  const knownGoodWarningPreemptionIds = results
    .filter((r) => {
      const knownGoodTurn = fixtureById.get(r.id)?.knownGoodTurn;
      return (
        knownGoodTurn !== undefined && r.warningTurn !== undefined && r.warningTurn < knownGoodTurn
      );
    })
    .map((r) => r.id);
  const knownGoodForcedPivotPreemptionIds = results
    .filter((r) => {
      const knownGoodTurn = fixtureById.get(r.id)?.knownGoodTurn;
      return (
        knownGoodTurn !== undefined &&
        r.forcedPivotTurn !== undefined &&
        r.forcedPivotTurn < knownGoodTurn
      );
    })
    .map((r) => r.id);
  const clearFalsePositiveCount = clearFalsePositiveIds.length;
  const ambiguousTerminalCount = ambiguousTerminalIds.length;
  const knownGoodPreemptionCount = knownGoodPreemptionIds.length;
  const minSavings = options.minMedianTokenSavingsRatio ?? 0.7;
  const corpus = evaluateCorpusRequirements(fixtures, options);
  const outcomeBlockerEntries: BlockingEntry[] = [
    ...(trueLoopResults.length === 0 ? [["missing-true-loop-fixtures", []] as const] : []),
    ...(trueLoopMissingWarningIds.length > 0
      ? [["true-loop-missing-warning", trueLoopMissingWarningIds] as const]
      : []),
    ...(trueLoopMissingTerminalIds.length > 0
      ? [["true-loop-missing-terminal", trueLoopMissingTerminalIds] as const]
      : []),
    ...(unboundedTrueLoopRecoveryIds.length > 0
      ? [["unbounded-true-loop-recovery", unboundedTrueLoopRecoveryIds] as const]
      : []),
    ...(clearFalsePositiveCount > 0
      ? [["clear-progress-terminal", clearFalsePositiveIds] as const]
      : []),
    ...(clearWarningIds.length > 0 ? [["clear-progress-warning", clearWarningIds] as const] : []),
    ...(clearForcedPivotIds.length > 0
      ? [["clear-progress-forced-pivot", clearForcedPivotIds] as const]
      : []),
    ...(ambiguousTerminalCount > 0 ? [["ambiguous-terminal", ambiguousTerminalIds] as const] : []),
    ...(ambiguousWarningIds.length > 0
      ? [["ambiguous-warning", ambiguousWarningIds] as const]
      : []),
    ...(ambiguousForcedPivotIds.length > 0
      ? [["ambiguous-forced-pivot", ambiguousForcedPivotIds] as const]
      : []),
    ...(knownGoodPreemptionCount > 0
      ? [["known-good-preemption", knownGoodPreemptionIds] as const]
      : []),
    ...(knownGoodWarningPreemptionIds.length > 0
      ? [["known-good-warning-preemption", knownGoodWarningPreemptionIds] as const]
      : []),
    ...(knownGoodForcedPivotPreemptionIds.length > 0
      ? [["known-good-forced-pivot-preemption", knownGoodForcedPivotPreemptionIds] as const]
      : []),
    ...(grossSavingsMissingBaselineIds.length > 0
      ? [["missing-gross-savings-baseline", grossSavingsMissingBaselineIds] as const]
      : []),
    ...(savingsRatios.length > 0 && medianTrueLoopTokenSavingsRatio < minSavings
      ? [["insufficient-gross-token-savings", insufficientGrossSavingsIds] as const]
      : []),
  ];
  const blockerEntries: BlockingEntry[] = [...outcomeBlockerEntries, ...corpus.blockerEntries];
  const blockingReasons = blockerEntries.map(([reason]) => reason);
  const blockerFixtureIds = Object.fromEntries(
    blockerEntries.filter(([, ids]) => ids.length > 0),
  ) as Partial<Record<LoopDetectionCalibrationBlockingReason, readonly string[]>>;
  return {
    results,
    trueLoopCount: trueLoopResults.length,
    trueLoopWarningCount,
    trueLoopTerminalCount,
    clearProgressCount: clearResults.length,
    clearFalsePositiveCount,
    clearFalsePositiveIds,
    clearWarningIds,
    clearForcedPivotIds,
    ambiguousCount: ambiguousResults.length,
    ambiguousTerminalCount,
    ambiguousTerminalIds,
    ambiguousWarningIds,
    ambiguousForcedPivotIds,
    knownGoodPreemptionCount,
    knownGoodPreemptionIds,
    knownGoodWarningPreemptionIds,
    knownGoodForcedPivotPreemptionIds,
    medianTrueLoopTokenSavingsRatio,
    grossSavingsSampleCount: savingsRatios.length,
    grossSavingsMissingBaselineIds,
    medianTrueLoopEffectiveSavingsRatio,
    effectiveSavingsSampleCount: effectiveSavingsRatios.length,
    effectiveSavingsMissingBaselineIds,
    corpusBlockingReasons: corpus.blockingReasons,
    missingCorpusMetadataIds: corpus.missingCorpusMetadataIds,
    missingRequiredRootCauseIds: corpus.missingRequiredRootCauseIds,
    missingRequiredNonTbHeldOutRootCauseIds: corpus.missingRequiredNonTbHeldOutRootCauseIds,
    blockerFixtureIds,
    blockingReasons,
    outcomeEligible: outcomeBlockerEntries.length === 0,
    defaultOnEligible: outcomeBlockerEntries.length === 0 && corpus.blockerEntries.length === 0,
  };
}

function grossStepTokens(step: LoopDetectionReplayStep): number {
  if (step.turnUsage !== undefined) {
    return (
      grossTokens(step.turnUsage.usage) / normalizedToolCallCount(step.turnUsage.toolCallCount)
    );
  }
  const usage = step.usage;
  if (usage !== undefined && usage.inputTokens > 0) {
    return grossTokens(usage);
  }
  if (usage !== undefined && usage.outputTokens > 0) {
    return estimateTokens(JSON.stringify(step.call.args)) + usage.outputTokens;
  }
  return estimateTokens(JSON.stringify(step.call.args)) + estimateTokens(step.output);
}

function effectiveStepTokens(step: LoopDetectionReplayStep, cacheReadWeight: number): number {
  if (step.turnUsage !== undefined) {
    return (
      effectiveTokens(step.turnUsage.usage, cacheReadWeight) /
      normalizedToolCallCount(step.turnUsage.toolCallCount)
    );
  }
  const usage = step.usage;
  if (usage !== undefined && usage.inputTokens > 0) {
    return effectiveTokens(usage, cacheReadWeight);
  }
  return grossStepTokens(step);
}

function normalizedCacheReadWeight(
  options: Pick<LoopDetectionCalibrationOptions, "cacheReadWeight">,
): number {
  const weight = options.cacheReadWeight ?? 1;
  if (!Number.isFinite(weight)) return 1;
  return Math.min(1, Math.max(0, weight));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const midpoint = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[midpoint]!;
  return (values[midpoint - 1]! + values[midpoint]!) / 2;
}

function normalizedToolCallCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function evaluateCorpusRequirements(
  fixtures: readonly LoopDetectionReplayFixture[],
  options: LoopDetectionCalibrationOptions,
): {
  readonly blockingReasons: readonly LoopDetectionCalibrationBlockingReason[];
  readonly blockerEntries: readonly BlockingEntry[];
  readonly missingCorpusMetadataIds: readonly string[];
  readonly missingRequiredRootCauseIds: readonly string[];
  readonly missingRequiredNonTbHeldOutRootCauseIds: readonly string[];
} {
  const requirements = options.corpusRequirements;
  if (requirements === undefined) {
    return {
      blockingReasons: ["missing-corpus-requirements"],
      blockerEntries: [["missing-corpus-requirements", []]],
      missingCorpusMetadataIds: [],
      missingRequiredRootCauseIds: [],
      missingRequiredNonTbHeldOutRootCauseIds: [],
    };
  }

  const metadataById = new Map(
    (options.corpusMetadata ?? []).map((metadata) => [metadata.id, metadata]),
  );
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const includedMetadata = fixtures.flatMap((fixture) => {
    const metadata = metadataById.get(fixture.id);
    return metadata === undefined ? [] : [metadata];
  });
  const missingCorpusMetadataIds = fixtures
    .filter((fixture) => !metadataById.has(fixture.id))
    .map((fixture) => fixture.id);
  const nonTbHeldOutMetadata = includedMetadata.filter(
    (metadata) =>
      metadata.suite === "non-tb" &&
      metadata.heldOut === true &&
      fixtureById.get(metadata.id)?.label === "legit-progress",
  );
  const nonTbHeldOutCount = nonTbHeldOutMetadata.length;
  const presentRootCauseIds = new Set(
    includedMetadata.flatMap((metadata) =>
      metadata.rootCauseId === undefined ? [] : [metadata.rootCauseId],
    ),
  );
  const missingRequiredRootCauseIds = (requirements.requiredRootCauseIds ?? []).filter(
    (rootCauseId) => !presentRootCauseIds.has(rootCauseId),
  );
  const presentNonTbHeldOutRootCauseIds = new Set(
    nonTbHeldOutMetadata.flatMap((metadata) =>
      metadata.rootCauseId === undefined ? [] : [metadata.rootCauseId],
    ),
  );
  const missingRequiredNonTbHeldOutRootCauseIds = (
    requirements.requiredNonTbHeldOutRootCauseIds ?? []
  ).filter((rootCauseId) => !presentNonTbHeldOutRootCauseIds.has(rootCauseId));
  const hasKnownGoodFixture = fixtures.some((fixture) => fixture.knownGoodTurn !== undefined);

  const blockerEntries: BlockingEntry[] = [
    ...(missingCorpusMetadataIds.length > 0
      ? [["missing-corpus-metadata", missingCorpusMetadataIds] as const]
      : []),
    ...(nonTbHeldOutCount < (requirements.minNonTbHeldOutFixtures ?? 0)
      ? [["insufficient-non-tb-heldout-fixtures", []] as const]
      : []),
    ...(missingRequiredRootCauseIds.length > 0
      ? [["missing-required-root-cause", []] as const]
      : []),
    ...(missingRequiredNonTbHeldOutRootCauseIds.length > 0
      ? [["missing-required-non-tb-heldout-root-cause", []] as const]
      : []),
    ...(requirements.requireKnownGoodFixture === true && !hasKnownGoodFixture
      ? [["missing-known-good-fixture", []] as const]
      : []),
  ];

  return {
    blockingReasons: blockerEntries.map(([reason]) => reason),
    blockerEntries,
    missingCorpusMetadataIds,
    missingRequiredRootCauseIds,
    missingRequiredNonTbHeldOutRootCauseIds,
  };
}
