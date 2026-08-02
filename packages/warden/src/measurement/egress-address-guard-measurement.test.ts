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
      latencySamples: 100,
      loadRequests: 40,
      throughputRequests: 1_000,
      transferBytes: CLAIM_TRANSFER_BYTES,
      transferPairs: 3,
      budgetOriginRateBytesPerSecond: 250 * 1024 * 1024,
      maxSettledRssGrowthBytes: 16 * 1024 * 1024,
      maxSettledFileDescriptorGrowth: 2,
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

  it("renders the exact command, environment, sample sizes, p95 result, and non-pass reasons", () => {
    const input = passingInput();
    input.measurements.budgetTransfers.comparable = false;
    const markdown = renderEgressAddressGuardMeasurement(buildEgressAddressGuardMeasurement(input));

    expect(markdown).toContain(input.command);
    expect(markdown).toContain("linux 6.11.0 x64");
    expect(markdown).toContain("Node v24.7.0");
    expect(markdown).toContain("500 MiB");
    expect(markdown).toContain("3 paired samples");
    expect(markdown).toContain("p95");
    expect(markdown).toContain("does not close Slice 8");
    expect(markdown).toContain("not comparable");
  });
});
