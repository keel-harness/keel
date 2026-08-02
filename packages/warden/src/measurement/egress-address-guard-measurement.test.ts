import { describe, expect, it } from "vitest";

import {
  buildEgressAddressGuardMeasurement,
  CLAIM_TRANSFER_BYTES,
  EGRESS_PROXY_BUDGET_PERCENT,
  renderEgressAddressGuardMeasurement,
  sampleStats,
  type EgressAddressGuardMeasurementInput,
} from "./egress-address-guard-measurement.js";

function passingInput(): EgressAddressGuardMeasurementInput {
  return {
    sha: "a".repeat(40),
    generatedAt: "2026-08-02T00:00:00.000Z",
    command: "corepack pnpm measure:egress-address-guard -- --pairs 3",
    environment: {
      platform: "linux",
      release: "6.11.0",
      arch: "x64",
      node: "v24.7.0",
      cpu: "Example CPU",
      logicalCpus: 4,
      totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    },
    configuration: {
      latencySamples: 5,
      loadRequests: 40,
      throughputRequests: 1_000,
      transferBytes: CLAIM_TRANSFER_BYTES,
      transferPairs: 3,
      budgetOriginRateBytesPerSecond: 250 * 1024 * 1024,
      maxSettledRssGrowthBytes: 16 * 1024 * 1024,
      maxSettledFileDescriptorGrowth: 2,
      resourceSampleIntervalMs: 5,
      resourceSettleDelayMs: 100,
      teardownToleranceMs: 750,
    },
    measurements: {
      connectionLatencyMs: [1, 2, 3, 4, 5],
      requestThroughput: { requests: 1_000, durationMs: 500 },
      resolver: {
        peakActiveLookups: 8,
        peakQueuedLookups: 32,
        queueFullRejections: 1,
        completedLookups: 40,
      },
      resources: {
        baselineRssBytes: 100 * 1024 * 1024,
        peakRssBytes: 112 * 1024 * 1024,
        settledRssBytes: 104 * 1024 * 1024,
        baselineFileDescriptors: 20,
        peakFileDescriptors: 90,
        settledFileDescriptors: 21,
      },
      audit: {
        denialRecords: 64,
        quarantineRecords: 1,
        retryRecords: 0,
        bytesBefore: 0,
        bytesAfter: 32_768,
      },
      teardown: {
        drainedMs: 4,
        hungMs: 5_050,
        hungDrained: false,
        activeAfterLateCallback: 0,
        lateDialCount: 0,
      },
      budgetTransfers: {
        comparable: true,
        directMs: [2_000, 2_010, 1_990],
        proxyMs: [2_040, 2_030, 2_050],
      },
      saturationTransfers: {
        comparable: true,
        directMs: [140],
        proxyMs: [380],
      },
    },
  };
}

describe("egress address guard measurement contract", () => {
  it("computes nearest-rank p50/p95/p99 statistics without rounding hidden failures away", () => {
    expect(() => sampleStats([])).toThrow("at least one sample");
    expect(() => sampleStats([1, Number.NaN])).toThrow("finite numbers");
    expect(sampleStats([3, 1, 2, 10])).toEqual({
      count: 4,
      p50: 2,
      p95: 10,
      p99: 10,
      max: 10,
    });
  });

  it("counts only complete comparable 500 MiB evidence below the strict p95 proxy budget", () => {
    const report = buildEgressAddressGuardMeasurement(passingInput());

    expect(CLAIM_TRANSFER_BYTES).toBe(500 * 1024 * 1024);
    expect(EGRESS_PROXY_BUDGET_PERCENT).toBe(5);
    expect(report.summary).toEqual({ status: "PASS", countsAsPass: true, reasons: [] });
    expect(report.connectionLatencyMs).toMatchObject({ count: 5, p50: 3, p95: 5, p99: 5 });
    expect(report.requestThroughputPerSecond).toBe(2_000);
    expect(report.budgetTransfers).toMatchObject({
      bytesPerTransfer: CLAIM_TRANSFER_BYTES,
      pairs: 3,
      budgetPercent: 5,
      comparator: "p95 < 5%",
      status: "PASS",
    });
    expect(report.budgetTransfers.penaltyPercent.p95).toBeLessThan(5);
    expect(report.saturationTransfers.penaltyPercent.p95).toBeGreaterThan(50);
  });

  it.each([
    [
      "non-positive transfer duration",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.budgetTransfers.directMs[0] = 0;
      },
      "positive numbers",
    ],
    [
      "non-positive connection latency",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.connectionLatencyMs[0] = 0;
      },
      "positive numbers",
    ],
    [
      "zero throughput duration",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.requestThroughput.durationMs = 0;
      },
      "throughput duration must be positive",
    ],
    [
      "decreasing audit byte count",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.audit.bytesBefore = 1;
        input.measurements.audit.bytesAfter = 0;
      },
      "audit byte count cannot decrease",
    ],
    [
      "unpaired transfer durations",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.budgetTransfers.proxyMs.pop();
      },
      "same paired sample count",
    ],
    [
      "negative counter",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.resolver.completedLookups = -1;
      },
      "finite non-negative",
    ],
    [
      "invalid SHA",
      (input: EgressAddressGuardMeasurementInput) => {
        input.sha = "not-a-sha";
      },
      "40 hex digits",
    ],
    [
      "empty command",
      (input: EgressAddressGuardMeasurementInput) => {
        input.command = "   ";
      },
      "command is required",
    ],
    [
      "invalid timestamp",
      (input: EgressAddressGuardMeasurementInput) => {
        input.generatedAt = "not-a-date";
      },
      "ISO date",
    ],
  ])("rejects %s before it can become evidence", (_label, mutate, message) => {
    const input = passingInput();
    mutate(input);

    expect(() => buildEgressAddressGuardMeasurement(input)).toThrow(message);
  });

  it("marks a smaller or incomparable transfer as partial instead of laundering it into a pass", () => {
    const input = passingInput();
    input.configuration.transferBytes = CLAIM_TRANSFER_BYTES - 1;
    input.measurements.budgetTransfers.comparable = false;

    const report = buildEgressAddressGuardMeasurement(input);

    expect(report.summary.status).toBe("PARTIAL");
    expect(report.summary.countsAsPass).toBe(false);
    expect(report.summary.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("exactly 500 MiB"),
        expect.stringContaining("not comparable"),
      ]),
    );
  });

  it("fails at the budget boundary and when bounded-resource invariants drift", () => {
    const input = passingInput();
    input.measurements.budgetTransfers.directMs = [950, 950, 950];
    input.measurements.budgetTransfers.proxyMs = [1_000, 1_000, 1_000];
    input.measurements.resolver.peakQueuedLookups = 33;
    input.measurements.audit.retryRecords = 1;
    input.measurements.teardown.lateDialCount = 1;
    input.measurements.resources.settledFileDescriptors = 23;

    const report = buildEgressAddressGuardMeasurement(input);

    expect(report.budgetTransfers.penaltyPercent.p95).toBe(5);
    expect(report.budgetTransfers.status).toBe("FAIL");
    expect(report.summary.status).toBe("FAIL");
    expect(report.summary.countsAsPass).toBe(false);
    expect(report.summary.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("p95 proxy throughput penalty"),
        expect.stringContaining("resolver queue"),
        expect.stringContaining("retry audit growth"),
        expect.stringContaining("late dial"),
        expect.stringContaining("file descriptor"),
      ]),
    );
  });

  it.each([
    [
      "connection latency count",
      (input: EgressAddressGuardMeasurementInput) => {
        input.configuration.latencySamples += 1;
      },
      "connection-latency sample count",
    ],
    [
      "throughput request count",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.requestThroughput.requests -= 1;
      },
      "request-throughput sample count",
    ],
    [
      "transfer pair count",
      (input: EgressAddressGuardMeasurementInput) => {
        input.configuration.transferPairs += 1;
      },
      "budget transfer pair count",
    ],
  ])("marks mismatched %s evidence partial", (_label, mutate, reason) => {
    const input = passingInput();
    mutate(input);

    const report = buildEgressAddressGuardMeasurement(input);

    expect(report.summary.status).toBe("PARTIAL");
    expect(report.summary.countsAsPass).toBe(false);
    expect(report.summary.reasons).toContainEqual(expect.stringContaining(reason));
  });

  it.each([
    [
      "missing queue overflow rejection",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.resolver.queueFullRejections = 0;
      },
      "resolver saturation",
    ],
    [
      "incomplete resolver load",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.resolver.completedLookups -= 1;
      },
      "resolver saturation",
    ],
    [
      "wrong denial count",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.audit.denialRecords -= 1;
      },
      "denial storm",
    ],
    [
      "wrong quarantine count",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.audit.quarantineRecords = 0;
      },
      "denial storm",
    ],
    [
      "slow drained teardown",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.teardown.drainedMs = input.configuration.teardownToleranceMs + 1;
      },
      "drained teardown",
    ],
    [
      "slow hung teardown",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.teardown.hungMs = 5_751;
      },
      "hung resolver teardown",
    ],
    [
      "implausibly fast hung teardown",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.teardown.hungMs = 4_249;
      },
      "hung resolver teardown",
    ],
    [
      "falsely drained hung resolver",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.teardown.hungDrained = true;
      },
      "hung resolver teardown",
    ],
    [
      "late active lookup",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.teardown.activeAfterLateCallback = 1;
      },
      "late resolver callback",
    ],
    [
      "RSS peak below baseline",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.resources.peakRssBytes =
          input.measurements.resources.baselineRssBytes - 1;
      },
      "RSS growth",
    ],
    [
      "RSS peak below settled",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.resources.peakRssBytes =
          input.measurements.resources.settledRssBytes - 1;
      },
      "RSS growth",
    ],
    [
      "settled RSS over budget",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.resources.settledRssBytes =
          input.measurements.resources.baselineRssBytes +
          input.configuration.maxSettledRssGrowthBytes +
          1;
        input.measurements.resources.peakRssBytes = input.measurements.resources.settledRssBytes;
      },
      "RSS growth",
    ],
    [
      "FD peak below baseline",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.resources.peakFileDescriptors =
          input.measurements.resources.baselineFileDescriptors - 1;
      },
      "file descriptor growth",
    ],
    [
      "FD peak below settled",
      (input: EgressAddressGuardMeasurementInput) => {
        input.measurements.resources.peakFileDescriptors =
          input.measurements.resources.settledFileDescriptors - 1;
      },
      "file descriptor growth",
    ],
  ])("fails closed for %s", (_label, mutate, reason) => {
    const input = passingInput();
    mutate(input);

    const report = buildEgressAddressGuardMeasurement(input);

    expect(report.summary.status).toBe("FAIL");
    expect(report.summary.countsAsPass).toBe(false);
    expect(report.summary.reasons).toContainEqual(expect.stringContaining(reason));
  });

  it("renders the exact command, environment, sample sizes, p95 result, and non-pass reasons", () => {
    const input = passingInput();
    input.measurements.budgetTransfers.comparable = false;
    const markdown = renderEgressAddressGuardMeasurement(buildEgressAddressGuardMeasurement(input));

    expect(markdown).toContain(input.command);
    expect(markdown).toContain("linux 6.11.0 x64");
    expect(markdown).toContain("Node v24.7.0");
    expect(markdown).toContain("500 MiB");
    expect(markdown).toContain("3 paired samples");
    expect(markdown).toContain("n=5");
    expect(markdown).toContain("1,000 requests");
    expect(markdown).toContain("40 lookups");
    expect(markdown).toContain("5 ms cadence; 100 ms settle delay");
    expect(markdown).toContain("p95");
    expect(markdown).toContain("does not close Slice 8");
    expect(markdown).toContain("not comparable");
  });

  it("renders an explicit closeout only for a passing report", () => {
    const markdown = renderEgressAddressGuardMeasurement(
      buildEgressAddressGuardMeasurement(passingInput()),
    );

    expect(markdown).toContain("closes the measured Slice 8 contract");
    expect(markdown).not.toContain("does not close Slice 8");
  });
});
