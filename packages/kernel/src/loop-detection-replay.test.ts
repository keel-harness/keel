import { effectiveTokens } from "@keel/shared";
import { describe, expect, it } from "vitest";
import {
  CORE_HARNESS_KNOWN_GOOD_PREEMPTION_COUNTERFACTUAL_FIXTURE,
  CORE_HARNESS_LOOP_REPLAY_FIXTURES,
  CORE_HARNESS_LOOP_REPLAY_CORPUS_REQUIREMENTS,
  CORE_HARNESS_LOOP_REPLAY_METADATA,
} from "./core-harness-reliability-fixtures.js";
import { PROGRESS_CONTRACT_LOOP_CONFIG } from "./loop-detection.js";
import {
  calibrateLoopDetectionFixtures,
  replayLoopDetectionFixture,
  replayStepsFromModelTurn,
} from "./loop-detection-replay.js";

describe("loop-detection replay calibration", () => {
  it("counterfactually reports warning, halt, and token savings for a high-burn true loop", () => {
    const result = replayLoopDetectionFixture({
      id: "generic-high-burn",
      label: "true-loop",
      historical: { terminalTurn: 8, terminalTokens: 8000 },
      detector: {
        maxToolRepeats: 99,
        maxOutcomeRepeats: 8,
        highBurnOutcomeRepeats: 2,
        highBurnOutputBytes: 32,
      },
      steps: Array.from({ length: 8 }, (_, i) => ({
        call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
        output: "FAILED tests/test_video.py::test_takeoff_landing\n".repeat(4),
        usage: { inputTokens: 450, outputTokens: 550 },
      })),
    });

    expect(result).toMatchObject({
      id: "generic-high-burn",
      label: "true-loop",
      warningTurn: 2,
      forcedPivotTurn: 3,
      terminalTurn: 4,
      terminalTokens: 4000,
      historicalTerminalTurn: 8,
      historicalTokens: 8000,
      tokensSaved: 4000,
    });
    expect(result.terminalReason).toContain(
      "bash high-burn equivalent outcome repeated after warning",
    );
  });

  it("uses per-step usage to shorten tiny-output high-cost repeated outcomes", () => {
    const result = replayLoopDetectionFixture({
      id: "tiny-output-high-cost-repeat",
      label: "true-loop",
      historical: { terminalTurn: 8, terminalTokens: 480_000 },
      detector: {
        maxToolRepeats: 99,
        maxOutcomeRepeats: 8,
        highBurnOutcomeRepeats: 2,
        highBurnOutputBytes: 4096,
        highBurnStepTokens: 50_000,
      },
      steps: Array.from({ length: 8 }, (_, i) => ({
        call: { name: "bash", args: { command: `python search.py --attempt=${String(i + 1)}` } },
        output: "(command produced no output; exit code 0)\n",
        usage: { inputTokens: 55_000, outputTokens: 5_000 },
      })),
    });

    expect(result.warningTurn).toBe(2);
    expect(result.forcedPivotTurn).toBe(3);
    expect(result.terminalTurn).toBe(4);
    expect(result.terminalTokens).toBe(240_000);
    expect(result.tokensSaved).toBe(240_000);
    expect(result.terminalReason).toContain("high-burn equivalent outcome");
  });

  it("does not halt monotonic metric progress in a clear-progress replay", () => {
    const result = replayLoopDetectionFixture({
      id: "monotonic-loss",
      label: "legit-progress",
      detector: {
        maxToolRepeats: 99,
        maxOutcomeRepeats: 2,
        maxObjectiveStallTurns: 2,
      },
      steps: [0.9, 0.8, 0.7, 0.6, 0.5].map((loss, i) => ({
        call: { name: "bash", args: { command: `python train.py --attempt=${String(i + 1)}` } },
        output: `validation loss: ${loss.toFixed(1)}\n`,
      })),
    });

    expect(result.warningTurn).toBeUndefined();
    expect(result.terminalTurn).toBeUndefined();
    expect(result.terminalTokens).toBeUndefined();
  });

  it("marks preemption when a replay would halt before known-good evidence", () => {
    const result = replayLoopDetectionFixture({
      id: "preempted-good",
      label: "ambiguous",
      knownGoodTurn: 6,
      detector: {
        maxToolRepeats: 99,
        maxOutcomeRepeats: 8,
        highBurnOutcomeRepeats: 2,
        highBurnOutputBytes: 16,
      },
      steps: Array.from({ length: 6 }, (_, i) => ({
        call: { name: "bash", args: { command: `benchmark --attempt=${String(i + 1)}` } },
        output: "same noisy benchmark failure\n",
        usage: { inputTokens: 100, outputTokens: 100 },
      })),
    });

    expect(result.forcedPivotTurn).toBe(3);
    expect(result.terminalTurn).toBe(4);
    expect(result.preemptsKnownGood).toBe(true);
  });

  it("keeps post-solution churn distinct from preempting a known-good state", () => {
    const result = replayLoopDetectionFixture({
      id: "largest-eigenval-style-post-solution-churn",
      label: "true-loop",
      knownGoodTurn: 2,
      historical: { terminalTurn: 8, terminalTokens: 4000 },
      detector: {
        maxToolRepeats: 99,
        maxOutcomeRepeats: 8,
        highBurnOutcomeRepeats: 2,
        highBurnOutputBytes: 16,
      },
      steps: Array.from({ length: 8 }, (_, i) => ({
        call: { name: "bash", args: { command: `python benchmark.py --run=${String(i + 1)}` } },
        output: "benchmark variance within tolerance; answer already written\n",
        usage: { inputTokens: 250, outputTokens: 250 },
      })),
    });

    expect(result).toMatchObject({
      warningTurn: 2,
      forcedPivotTurn: 3,
      terminalTurn: 4,
      terminalTokens: 2000,
      tokensSaved: 2000,
      preemptsKnownGood: false,
    });
  });

  it("estimates terminal tokens when replay steps omit provider usage", () => {
    const result = replayLoopDetectionFixture({
      id: "usage-missing",
      label: "true-loop",
      detector: {
        maxToolRepeats: 99,
        maxOutcomeRepeats: 8,
        highBurnOutcomeRepeats: 2,
        highBurnOutputBytes: 16,
      },
      steps: Array.from({ length: 4 }, (_, i) => ({
        call: { name: "bash", args: { command: `pytest -q --run=${String(i + 1)}` } },
        output: "same failure output with no usage report\n",
      })),
    });

    expect(result.forcedPivotTurn).toBe(3);
    expect(result.terminalTurn).toBe(4);
    expect(result.terminalTokens).toBeGreaterThan(0);
  });

  it("does not let cached-only partial usage suppress the terminal-token estimate", () => {
    const result = replayLoopDetectionFixture({
      id: "partial-usage",
      label: "true-loop",
      detector: {
        maxToolRepeats: 99,
        maxOutcomeRepeats: 8,
        highBurnOutcomeRepeats: 2,
        highBurnOutputBytes: 16,
      },
      steps: Array.from({ length: 4 }, (_, i) => ({
        call: { name: "bash", args: { command: `pytest -q --run=${String(i + 1)}` } },
        output: "same failure output with partial usage only\n",
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 25 },
      })),
    });

    expect(result.forcedPivotTurn).toBe(3);
    expect(result.terminalTurn).toBe(4);
    expect(result.terminalTokens).toBeGreaterThan(0);
  });

  it("does not let output-only partial usage suppress the terminal-token estimate", () => {
    const result = replayLoopDetectionFixture({
      id: "output-only-usage",
      label: "true-loop",
      detector: {
        maxToolRepeats: 99,
        maxOutcomeRepeats: 8,
        highBurnOutcomeRepeats: 2,
        highBurnOutputBytes: 16,
      },
      steps: Array.from({ length: 4 }, (_, i) => ({
        call: { name: "bash", args: { command: `pytest -q --run=${String(i + 1)}` } },
        output: "same failure output with output usage only\n",
        usage: { inputTokens: 0, outputTokens: 7 },
      })),
    });

    expect(result.forcedPivotTurn).toBe(3);
    expect(result.terminalTurn).toBe(4);
    expect(result.terminalTokens).toBeGreaterThan(28);
  });

  it("reports gross and effective terminal cost separately for cache-heavy replay steps", () => {
    const result = replayLoopDetectionFixture(
      {
        id: "cache-heavy-loop",
        label: "true-loop",
        historical: {
          terminalTurn: 8,
          terminalTokens: 1_200_000,
          terminalEffectiveTokens: 1_100_000,
        },
        detector: {
          maxToolRepeats: 99,
          maxOutcomeRepeats: 8,
          highBurnOutcomeRepeats: 2,
          highBurnOutputBytes: 16,
          highBurnStepTokens: 20_000,
        },
        steps: Array.from({ length: 4 }, (_, i) => ({
          call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
          output: "same cached failure output\n",
          usage: { inputTokens: 100_000, outputTokens: 10_000, cachedInputTokens: 90_000 },
        })),
      },
      { cacheReadWeight: 0.1 },
    );

    expect(result.terminalTurn).toBe(4);
    expect(result.terminalTokens).toBe(440_000);
    expect(result.terminalEffectiveTokens).toBe(116_000);
    expect(result.historicalEffectiveTokens).toBe(1_100_000);
    expect(result.tokensSaved).toBe(760_000);
    expect(result.effectiveTokensSaved).toBe(984_000);
  });

  it("uses the shared effective-token clamps for replay reporting", () => {
    const hostileProviderUsage = { inputTokens: 100, outputTokens: 10, cachedInputTokens: -50 };
    const result = replayLoopDetectionFixture(
      {
        id: "shared-effective-clamp",
        label: "true-loop",
        detector: {
          maxToolRepeats: 99,
          maxOutcomeRepeats: 8,
          highBurnOutcomeRepeats: 2,
          highBurnOutputBytes: 16,
          highBurnStepTokens: 1,
        },
        steps: Array.from({ length: 4 }, (_, i) => ({
          call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
          output: "same hostile provider usage output\n",
          usage: hostileProviderUsage,
        })),
      },
      { cacheReadWeight: 0.1 },
    );

    expect(result.terminalTurn).toBe(4);
    expect(result.terminalEffectiveTokens).toBe(4 * effectiveTokens(hostileProviderUsage, 0.1));
  });

  it.each([
    ["negative", -1, 80],
    ["above one", 5, 440],
    ["NaN", Number.NaN, 440],
    ["infinite", Number.POSITIVE_INFINITY, 440],
  ] as const)(
    "clamps invalid cacheReadWeight values for replay reporting: %s",
    (_label, cacheReadWeight, expectedTerminalEffectiveTokens) => {
      const result = replayLoopDetectionFixture(
        {
          id: `invalid-cache-weight-${_label}`,
          label: "true-loop",
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "same invalid cache weight output\n",
            usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 90 },
          })),
        },
        { cacheReadWeight },
      );

      expect(result.terminalTurn).toBe(4);
      expect(result.terminalEffectiveTokens).toBe(expectedTerminalEffectiveTokens);
    },
  );

  it("can replay multi-call model turns with runtime per-call token parity", () => {
    const steps = replayStepsFromModelTurn(
      Array.from({ length: 4 }, (_, i) => ({
        call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
        output: "same multi-call turn output\n",
      })),
      { inputTokens: 400_000, outputTokens: 40_000, cachedInputTokens: 360_000 },
    );
    const result = replayLoopDetectionFixture(
      {
        id: "multi-call-turn",
        label: "true-loop",
        detector: {
          maxToolRepeats: 99,
          maxOutcomeRepeats: 8,
          highBurnOutcomeRepeats: 2,
          highBurnOutputBytes: 16,
          highBurnStepTokens: 20_000,
        },
        steps,
      },
      { cacheReadWeight: 0.1 },
    );

    expect(result.terminalTurn).toBe(4);
    expect(result.terminalTokens).toBe(440_000);
    expect(result.terminalEffectiveTokens).toBe(116_000);
  });

  it("reports false-positive and known-good preemption fixture ids in calibration reports", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "clear-progress-would-terminal",
          label: "legit-progress",
          detector: {
            maxToolRepeats: 1,
            maxOutcomeRepeats: 1,
            highBurnOutcomeRepeats: 1,
            highBurnOutputBytes: 1,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `status --step=${String(i + 1)}` } },
            output: "same clear progress marker\n",
            usage: { inputTokens: 100, outputTokens: 25 },
          })),
        },
        {
          id: "known-good-would-preempt",
          label: "ambiguous",
          knownGoodTurn: 6,
          detector: {
            maxToolRepeats: 1,
            maxOutcomeRepeats: 1,
            highBurnOutcomeRepeats: 1,
            highBurnOutputBytes: 1,
          },
          steps: Array.from({ length: 6 }, (_, i) => ({
            call: { name: "bash", args: { command: `benchmark --attempt=${String(i + 1)}` } },
            output: "same benchmark output\n",
            usage: { inputTokens: 100, outputTokens: 25 },
          })),
        },
      ],
      { minMedianTokenSavingsRatio: 0.7 },
    );

    expect(report.outcomeEligible).toBe(false);
    expect(report.defaultOnEligible).toBe(false);
    expect(report.clearFalsePositiveIds).toEqual(["clear-progress-would-terminal"]);
    expect(report.knownGoodPreemptionIds).toEqual(["known-good-would-preempt"]);
    expect(report.blockerFixtureIds["clear-progress-terminal"]).toEqual([
      "clear-progress-would-terminal",
    ]);
    expect(report.blockerFixtureIds["known-good-preemption"]).toEqual(["known-good-would-preempt"]);
    expect(report.blockingReasons).toEqual(
      expect.arrayContaining(["clear-progress-terminal", "known-good-preemption"]),
    );
  });

  it("blocks default-on when non-terminal loop guidance would hit clear progress", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "true-loop-high-savings",
          label: "true-loop",
          historical: { terminalTurn: 20, terminalTokens: 100_000 },
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "same true-loop failure output\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
        {
          id: "clear-progress-warning-only",
          label: "legit-progress",
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 2 }, (_, i) => ({
            call: { name: "bash", args: { command: `status --step=${String(i + 1)}` } },
            output: "same clear progress marker\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
      ],
      { minMedianTokenSavingsRatio: 0.7 },
    );

    expect(report.clearWarningIds).toEqual(["clear-progress-warning-only"]);
    expect(report.blockerFixtureIds["clear-progress-warning"]).toEqual([
      "clear-progress-warning-only",
    ]);
    expect(report.blockingReasons).toContain("clear-progress-warning");
    expect(report.outcomeEligible).toBe(false);
    expect(report.defaultOnEligible).toBe(false);
  });

  it("blocks default-on when loop guidance preempts a known-good turn", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "true-loop-high-savings",
          label: "true-loop",
          historical: { terminalTurn: 20, terminalTokens: 100_000 },
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "same true-loop failure output\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
        {
          id: "known-good-warning-only",
          label: "ambiguous",
          knownGoodTurn: 4,
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 2 }, (_, i) => ({
            call: { name: "bash", args: { command: `benchmark --step=${String(i + 1)}` } },
            output: "same benchmark output before known-good evidence\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
      ],
      { minMedianTokenSavingsRatio: 0.7 },
    );

    expect(report.knownGoodWarningPreemptionIds).toEqual(["known-good-warning-only"]);
    expect(report.blockerFixtureIds["known-good-warning-preemption"]).toEqual([
      "known-good-warning-only",
    ]);
    expect(report.blockingReasons).toContain("known-good-warning-preemption");
    expect(report.outcomeEligible).toBe(false);
    expect(report.defaultOnEligible).toBe(false);
  });

  it("blocks default-on when forced-pivot loop guidance hits clear or ambiguous progress", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "true-loop-high-savings",
          label: "true-loop",
          historical: { terminalTurn: 20, terminalTokens: 100_000 },
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "same true-loop failure output\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
        {
          id: "clear-progress-forced-pivot",
          label: "legit-progress",
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 3 }, (_, i) => ({
            call: { name: "bash", args: { command: `status --step=${String(i + 1)}` } },
            output: "same clear progress output before forced pivot\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
        {
          id: "ambiguous-forced-pivot",
          label: "ambiguous",
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 3 }, (_, i) => ({
            call: { name: "bash", args: { command: `benchmark --step=${String(i + 1)}` } },
            output: "same ambiguous benchmark output before forced pivot\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
      ],
      { minMedianTokenSavingsRatio: 0.7 },
    );

    expect(report.clearForcedPivotIds).toEqual(["clear-progress-forced-pivot"]);
    expect(report.ambiguousForcedPivotIds).toEqual(["ambiguous-forced-pivot"]);
    expect(report.blockerFixtureIds["clear-progress-forced-pivot"]).toEqual([
      "clear-progress-forced-pivot",
    ]);
    expect(report.blockerFixtureIds["ambiguous-forced-pivot"]).toEqual(["ambiguous-forced-pivot"]);
    expect(report.blockingReasons).toEqual(
      expect.arrayContaining(["clear-progress-forced-pivot", "ambiguous-forced-pivot"]),
    );
    expect(report.outcomeEligible).toBe(false);
    expect(report.defaultOnEligible).toBe(false);
  });

  it("blocks default-on when forced-pivot loop guidance preempts a known-good turn", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "true-loop-high-savings",
          label: "true-loop",
          historical: { terminalTurn: 20, terminalTokens: 100_000 },
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "same true-loop failure output\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
        {
          id: "known-good-forced-pivot",
          label: "ambiguous",
          knownGoodTurn: 4,
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 3 }, (_, i) => ({
            call: { name: "bash", args: { command: `benchmark --step=${String(i + 1)}` } },
            output: "same benchmark output before known-good forced pivot\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
      ],
      { minMedianTokenSavingsRatio: 0.7 },
    );

    expect(report.knownGoodForcedPivotPreemptionIds).toEqual(["known-good-forced-pivot"]);
    expect(report.blockerFixtureIds["known-good-forced-pivot-preemption"]).toEqual([
      "known-good-forced-pivot",
    ]);
    expect(report.blockingReasons).toContain("known-good-forced-pivot-preemption");
    expect(report.outcomeEligible).toBe(false);
    expect(report.defaultOnEligible).toBe(false);
  });

  it("calibrates median effective savings separately from gross context savings", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "cache-heavy-true-loop",
          label: "true-loop",
          historical: {
            terminalTurn: 8,
            terminalTokens: 1_200_000,
            terminalEffectiveTokens: 1_100_000,
          },
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 20_000,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "same cached failure output\n",
            usage: { inputTokens: 100_000, outputTokens: 10_000, cachedInputTokens: 90_000 },
          })),
        },
      ],
      { cacheReadWeight: 0.1, minMedianTokenSavingsRatio: 0.7 },
    );

    expect(report.medianTrueLoopTokenSavingsRatio).toBeCloseTo(760_000 / 1_200_000, 6);
    expect(report.medianTrueLoopEffectiveSavingsRatio).toBeCloseTo(984_000 / 1_100_000, 6);
    expect(report.grossSavingsSampleCount).toBe(1);
    expect(report.grossSavingsMissingBaselineIds).toEqual([]);
    expect(report.effectiveSavingsSampleCount).toBe(1);
    expect(report.effectiveSavingsMissingBaselineIds).toEqual([]);
    expect(report.defaultOnEligible).toBe(false);
    expect(report.blockingReasons).toContain("insufficient-gross-token-savings");
  });

  it("reports missing effective baselines separately from measured zero savings", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "gross-only-true-loop",
          label: "true-loop",
          historical: { terminalTurn: 20, terminalTokens: 100_000 },
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "same gross-only failure output\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
      ],
      { minMedianTokenSavingsRatio: 0.7 },
    );

    expect(report.effectiveSavingsSampleCount).toBe(0);
    expect(report.effectiveSavingsMissingBaselineIds).toEqual(["gross-only-true-loop"]);
    expect(report.medianTrueLoopEffectiveSavingsRatio).toBeUndefined();
  });

  it("reports missing gross baselines separately from measured low gross savings", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "missing-gross-baseline",
          label: "true-loop",
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "same missing baseline output\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
      ],
      { minMedianTokenSavingsRatio: 0.7 },
    );

    expect(report.grossSavingsSampleCount).toBe(0);
    expect(report.grossSavingsMissingBaselineIds).toEqual(["missing-gross-baseline"]);
    expect(report.blockerFixtureIds["missing-gross-savings-baseline"]).toEqual([
      "missing-gross-baseline",
    ]);
    expect(report.blockingReasons).toContain("missing-gross-savings-baseline");
  });

  it("reports fixture ids for true-loop blocker reasons", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "missing-warning-and-terminal",
          label: "true-loop",
          historical: { terminalTurn: 10, terminalTokens: 100_000 },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `status --step=${String(i + 1)}` } },
            output: `progress step ${String(i + 1)}\n`,
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
        {
          id: "unbounded-recovery",
          label: "true-loop",
          historical: { terminalTurn: 20, terminalTokens: 100_000 },
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 0,
            maxObjectiveStallTurns: 2,
          },
          steps: [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8].map((loss, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: `validation loss: ${loss.toFixed(1)}\n`,
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
        {
          id: "low-savings",
          label: "true-loop",
          historical: { terminalTurn: 5, terminalTokens: 10_000 },
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "same low savings output\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
      ],
      { minMedianTokenSavingsRatio: 0.7 },
    );

    expect(report.blockerFixtureIds["true-loop-missing-warning"]).toEqual([
      "missing-warning-and-terminal",
    ]);
    expect(report.blockerFixtureIds["true-loop-missing-terminal"]).toEqual([
      "missing-warning-and-terminal",
    ]);
    expect(report.blockerFixtureIds["unbounded-true-loop-recovery"]).toEqual([
      "unbounded-recovery",
    ]);
    expect(report.blockerFixtureIds["insufficient-gross-token-savings"]).toEqual(["low-savings"]);
  });

  it("ignores advisory-only detector signals during calibration", () => {
    const result = replayLoopDetectionFixture({
      id: "advisory-over-generation",
      label: "legit-progress",
      detector: {
        maxToolRepeats: 99,
        maxLargeRewrites: 1,
        largeRewriteBytes: 16,
      },
      steps: [
        {
          call: {
            name: "bash",
            args: { command: "cat <<EOF > build_gates.py\nprint('large enough')\nEOF" },
          },
          output: "wrote build_gates.py\n",
        },
      ],
    });

    expect(result.warningTurn).toBeUndefined();
    expect(result.terminalTurn).toBeUndefined();
  });

  it("reports outcome eligibility separately from default-on corpus eligibility", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "tb2-overfull-hbox-minimized",
          label: "true-loop",
          historical: { terminalTurn: 200, terminalTokens: 50_000 },
          steps: [
            54.68654, 16.90868, 16.90868, 16.90868, 16.90868, 16.90868, 16.90868, 16.90868,
            16.90868, 16.90868, 16.90868, 16.90868, 16.90868, 16.90868, 16.90868,
          ].map((pt, i) => ({
            call: { name: "bash", args: { command: `pdflatex main.tex # ${String(i + 1)}` } },
            output: `Overfull \\hbox (${pt.toFixed(5)}pt too wide) in paragraph at lines 7--8\n`,
            usage: { inputTokens: 1500, outputTokens: 500 },
          })),
        },
        {
          id: "tb2-large-scale-text-editing-minimized",
          label: "true-loop",
          historical: { terminalTurn: 183, terminalTokens: 1_000_000 },
          steps: Array.from({ length: 8 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "FAILED tests/test_large_scale.py::test_output_matches\n".repeat(96),
            usage: { inputTokens: 40_000, outputTokens: 20_000 },
          })),
        },
        {
          id: "tb2-largest-eigenval-post-solution-churn",
          label: "true-loop",
          knownGoodTurn: 2,
          historical: { terminalTurn: 80, terminalTokens: 900_000 },
          steps: Array.from({ length: 8 }, (_, i) => ({
            call: {
              name: "bash",
              args: { command: `python benchmark_solution.py --run=${String(i + 1)}` },
            },
            output:
              "benchmark variance within tolerance; solution file already contains answer\n".repeat(
                80,
              ),
            usage: { inputTokens: 30_000, outputTokens: 15_000 },
          })),
        },
        {
          id: "clear-progress-monotonic-test-fixes",
          label: "legit-progress",
          steps: [12, 9, 6, 3, 1, 0].map((failed, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: `${String(failed)} failed\n`,
            usage: { inputTokens: 1000, outputTokens: 100 },
          })),
        },
        {
          id: "clear-progress-latex-context-switch",
          label: "legit-progress",
          steps: [
            ["intro.tex", 10],
            ["intro.tex", 1],
            ["appendix.tex", 50],
            ["appendix.tex", 40],
            ["appendix.tex", 30],
            ["appendix.tex", 20],
          ].map(([file, pt], i) => ({
            call: { name: "bash", args: { command: `pdflatex ${file} # ${String(i + 1)}` } },
            output: `Overfull \\hbox (${String(pt)}pt too wide) in ${file} at lines 12--13\n`,
            usage: { inputTokens: 1000, outputTokens: 100 },
          })),
        },
        {
          id: "video-processing-ground-truth-ambiguous-sensitivity",
          label: "ambiguous",
          historical: { terminalTurn: 120, terminalTokens: 7_500_000 },
          steps: [
            [48, 75],
            [5, 6],
            [48, 73],
            [48, 72],
            [47, 75],
            [46, 75],
            [49, 73],
            [48, 74],
            [47, 73],
            [49, 75],
            [48, 72],
            [46, 74],
            [49, 73],
            [48, 75],
          ].map(([takeoff, landing], i) => ({
            call: {
              name: "bash",
              args: { command: `python jump_analyzer.py --attempt=${String(i + 1)}` },
            },
            output: `Takeoff: ${String(takeoff)}\nLanding: ${String(landing)}\n`,
            usage: { inputTokens: 250_000, outputTokens: 50_000 },
          })),
        },
      ],
      {
        detector: PROGRESS_CONTRACT_LOOP_CONFIG,
        minMedianTokenSavingsRatio: 0.7,
      },
    );

    expect(report.outcomeEligible).toBe(true);
    expect(report.corpusBlockingReasons).toEqual(["missing-corpus-requirements"]);
    expect(report.blockingReasons).toContain("missing-corpus-requirements");
    expect(report.defaultOnEligible).toBe(false);
    expect(report.clearFalsePositiveCount).toBe(0);
    expect(report.knownGoodPreemptionCount).toBe(0);
    expect(report.trueLoopTerminalCount).toBe(3);
    expect(report.trueLoopWarningCount).toBe(3);
    expect(report.medianTrueLoopTokenSavingsRatio).toBeGreaterThanOrEqual(0.7);
    expect(report.ambiguousTerminalCount).toBe(0);
  });

  it("does not declare default-on eligibility when an ambiguous fixture terminal-halts", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "true-loop-high-burn",
          label: "true-loop",
          historical: { terminalTurn: 20, terminalTokens: 20_000 },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "FAILED tests/test_large_scale.py::test_output_matches\n".repeat(96),
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
        {
          id: "ambiguous-stable-video-vector",
          label: "ambiguous",
          detector: {
            maxNumericVectorStallTurns: 5,
            numericVectorBand: 5,
          },
          steps: Array.from({ length: 10 }, (_, i) => ({
            call: {
              name: "bash",
              args: { command: `python jump_analyzer.py --attempt=${String(i + 1)}` },
            },
            output: "Takeoff: 48\nLanding: 75\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
      ],
      {
        detector: {
          highBurnOutcomeRepeats: 2,
          highBurnOutputBytes: 32,
        },
      },
    );

    expect(report.trueLoopTerminalCount).toBe(1);
    expect(report.ambiguousTerminalCount).toBe(1);
    expect(report.ambiguousTerminalIds).toEqual(["ambiguous-stable-video-vector"]);
    expect(report.blockingReasons).toContain("ambiguous-terminal");
    expect(report.defaultOnEligible).toBe(false);
  });

  it("runs the Epic 2.28 Slice 0 corpus as a default-on gate", () => {
    const report = calibrateLoopDetectionFixtures(CORE_HARNESS_LOOP_REPLAY_FIXTURES, {
      detector: PROGRESS_CONTRACT_LOOP_CONFIG,
      minMedianTokenSavingsRatio: 0.7,
      corpusMetadata: CORE_HARNESS_LOOP_REPLAY_METADATA,
      corpusRequirements: CORE_HARNESS_LOOP_REPLAY_CORPUS_REQUIREMENTS,
    });

    expect(report.trueLoopCount).toBeGreaterThanOrEqual(3);
    expect(report.trueLoopTerminalCount).toBe(report.trueLoopCount);
    expect(report.clearFalsePositiveCount).toBe(0);
    expect(report.knownGoodPreemptionCount).toBe(0);
    expect(report.corpusBlockingReasons).toEqual([]);
    expect(report.missingRequiredRootCauseIds).toEqual([]);
    expect(report.missingRequiredNonTbHeldOutRootCauseIds).toEqual([]);
    expect(report.outcomeEligible).toBe(true);
    expect(report.defaultOnEligible).toBe(true);
  });

  it("blocks default-on when corpus requirements are narrower than the calibration claim", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "tb-only-true-loop",
          label: "true-loop",
          historical: { terminalTurn: 20, terminalTokens: 100_000 },
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "same tb-only output\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
      ],
      {
        minMedianTokenSavingsRatio: 0.7,
        corpusMetadata: [
          {
            id: "tb-only-true-loop",
            rootCauseId: "tb2-high-burn-varied-nonprogress-loop",
            suite: "tb2",
            heldOut: false,
          },
        ],
        corpusRequirements: {
          minNonTbHeldOutFixtures: 1,
          requiredRootCauseIds: [
            "tb2-high-burn-varied-nonprogress-loop",
            "non-tb-slow-legitimate-progress",
          ],
          requiredNonTbHeldOutRootCauseIds: ["non-tb-slow-legitimate-progress"],
          requireKnownGoodFixture: true,
        },
      },
    );

    expect(report.corpusBlockingReasons).toEqual(
      expect.arrayContaining([
        "insufficient-non-tb-heldout-fixtures",
        "missing-required-root-cause",
        "missing-required-non-tb-heldout-root-cause",
        "missing-known-good-fixture",
      ]),
    );
    expect(report.missingRequiredRootCauseIds).toEqual(["non-tb-slow-legitimate-progress"]);
    expect(report.missingRequiredNonTbHeldOutRootCauseIds).toEqual([
      "non-tb-slow-legitimate-progress",
    ]);
    expect(report.blockingReasons).toEqual(
      expect.arrayContaining([...report.corpusBlockingReasons]),
    );
    expect(report.defaultOnEligible).toBe(false);
  });

  it("blocks default-on when required corpus metadata is missing", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "metadata-missing",
          label: "true-loop",
          historical: { terminalTurn: 20, terminalTokens: 100_000 },
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "same metadata missing output\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
      ],
      {
        minMedianTokenSavingsRatio: 0.7,
        corpusRequirements: {
          requiredRootCauseIds: ["tb2-high-burn-varied-nonprogress-loop"],
        },
      },
    );

    expect(report.corpusBlockingReasons).toEqual(
      expect.arrayContaining(["missing-corpus-metadata", "missing-required-root-cause"]),
    );
    expect(report.missingCorpusMetadataIds).toEqual(["metadata-missing"]);
    expect(report.defaultOnEligible).toBe(false);
  });

  it("does not let TB metadata satisfy a required non-TB held-out root cause", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "mislabeled-non-tb-root",
          label: "true-loop",
          historical: { terminalTurn: 20, terminalTokens: 100_000 },
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "same mislabeled output\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
      ],
      {
        minMedianTokenSavingsRatio: 0.7,
        corpusMetadata: [
          {
            id: "mislabeled-non-tb-root",
            rootCauseId: "non-tb-slow-legitimate-progress",
            suite: "tb2",
            heldOut: true,
          },
        ],
        corpusRequirements: {
          minNonTbHeldOutFixtures: 1,
          requiredRootCauseIds: ["non-tb-slow-legitimate-progress"],
          requiredNonTbHeldOutRootCauseIds: ["non-tb-slow-legitimate-progress"],
        },
      },
    );

    expect(report.missingRequiredRootCauseIds).toEqual([]);
    expect(report.missingRequiredNonTbHeldOutRootCauseIds).toEqual([
      "non-tb-slow-legitimate-progress",
    ]);
    expect(report.corpusBlockingReasons).toEqual(
      expect.arrayContaining([
        "insufficient-non-tb-heldout-fixtures",
        "missing-required-non-tb-heldout-root-cause",
      ]),
    );
    expect(report.defaultOnEligible).toBe(false);
  });

  it("does not count missing or unknown suites as non-TB held-out negative coverage", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "unknown-suite-root",
          label: "true-loop",
          historical: { terminalTurn: 20, terminalTokens: 100_000 },
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "same unknown suite output\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
        {
          id: "missing-suite-root",
          label: "true-loop",
          historical: { terminalTurn: 20, terminalTokens: 100_000 },
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --missing-suite=${String(i + 1)}` } },
            output: "same missing suite output\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
      ],
      {
        minMedianTokenSavingsRatio: 0.7,
        corpusMetadata: [
          {
            id: "unknown-suite-root",
            rootCauseId: "non-tb-slow-legitimate-progress",
            suite: "custom" as "non-tb",
            heldOut: true,
          },
          {
            id: "missing-suite-root",
            rootCauseId: "non-tb-slow-legitimate-progress",
            heldOut: true,
          },
        ],
        corpusRequirements: {
          minNonTbHeldOutFixtures: 1,
          requiredNonTbHeldOutRootCauseIds: ["non-tb-slow-legitimate-progress"],
        },
      },
    );

    expect(report.corpusBlockingReasons).toEqual(
      expect.arrayContaining([
        "insufficient-non-tb-heldout-fixtures",
        "missing-required-non-tb-heldout-root-cause",
      ]),
    );
    expect(report.defaultOnEligible).toBe(false);
  });

  it("does not count non-TB true-loop metadata as held-out negative coverage", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "non-tb-true-loop-root",
          label: "true-loop",
          historical: { terminalTurn: 20, terminalTokens: 100_000 },
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "same non-tb true-loop output\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
      ],
      {
        minMedianTokenSavingsRatio: 0.7,
        corpusMetadata: [
          {
            id: "non-tb-true-loop-root",
            rootCauseId: "non-tb-slow-legitimate-progress",
            suite: "non-tb",
            heldOut: true,
          },
        ],
        corpusRequirements: {
          minNonTbHeldOutFixtures: 1,
          requiredNonTbHeldOutRootCauseIds: ["non-tb-slow-legitimate-progress"],
        },
      },
    );

    expect(report.corpusBlockingReasons).toEqual(
      expect.arrayContaining([
        "insufficient-non-tb-heldout-fixtures",
        "missing-required-non-tb-heldout-root-cause",
      ]),
    );
    expect(report.defaultOnEligible).toBe(false);
  });

  it("requires an executable known-good turn instead of metadata-only provenance", () => {
    const report = calibrateLoopDetectionFixtures(
      [
        {
          id: "metadata-only-known-good",
          label: "true-loop",
          historical: { terminalTurn: 20, terminalTokens: 100_000 },
          detector: {
            maxToolRepeats: 99,
            maxOutcomeRepeats: 8,
            highBurnOutcomeRepeats: 2,
            highBurnOutputBytes: 16,
            highBurnStepTokens: 1,
          },
          steps: Array.from({ length: 4 }, (_, i) => ({
            call: { name: "bash", args: { command: `pytest -q --attempt=${String(i + 1)}` } },
            output: "same metadata known-good output\n",
            usage: { inputTokens: 1000, outputTokens: 1000 },
          })),
        },
      ],
      {
        minMedianTokenSavingsRatio: 0.7,
        corpusMetadata: [
          {
            id: "metadata-only-known-good",
            rootCauseId: "tb2-known-good-preemption",
            suite: "tb2",
            heldOut: false,
            knownGoodProvenance: "explicit-fixture-oracle",
          },
        ],
        corpusRequirements: {
          requiredRootCauseIds: ["tb2-known-good-preemption"],
          requireKnownGoodFixture: true,
        },
      },
    );

    expect(report.corpusBlockingReasons).toContain("missing-known-good-fixture");
    expect(report.defaultOnEligible).toBe(false);
  });

  it("keeps the known-good preemption case as a counterfactual outside the production gate", () => {
    const result = replayLoopDetectionFixture(
      CORE_HARNESS_KNOWN_GOOD_PREEMPTION_COUNTERFACTUAL_FIXTURE,
    );

    expect(result.preemptsKnownGood).toBe(true);
    expect(result.terminalTurn).toBeLessThan(
      CORE_HARNESS_KNOWN_GOOD_PREEMPTION_COUNTERFACTUAL_FIXTURE.knownGoodTurn,
    );
  });
});
