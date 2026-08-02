import { EGRESS_ADDRESS_GUARD_LIMITS } from "../egress-resolver.js";

export const CLAIM_TRANSFER_BYTES = 500 * 1024 * 1024;
export const EGRESS_PROXY_BUDGET_PERCENT = 5;

export interface SampleStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface EgressMeasurementEnvironment {
  platform: string;
  release: string;
  arch: string;
  node: string;
  cpu: string;
  logicalCpus: number;
  totalMemoryBytes: number;
}

export interface EgressMeasurementConfiguration {
  latencySamples: number;
  loadRequests: number;
  connectionStormRequests: number;
  throughputRequests: number;
  transferBytes: number;
  transferPairs: number;
  budgetOriginRateBytesPerSecond: number;
  maxSettledRssGrowthBytes: number;
  maxSettledFileDescriptorGrowth: number;
  resourceBaselineDelayMs: number;
  resourceSampleIntervalMs: number;
  resourceSettleDelayMs: number;
  teardownToleranceMs: number;
}

export interface EgressTransferSamples {
  comparable: boolean;
  directMs: number[];
  proxyMs: number[];
}

export interface EgressAddressGuardMeasurementInput {
  sha: string;
  generatedAt: string;
  command: string;
  environment: EgressMeasurementEnvironment;
  configuration: EgressMeasurementConfiguration;
  measurements: {
    connectionLatencyMs: number[];
    requestThroughput: { requests: number; durationMs: number };
    resolver: {
      peakActiveLookups: number;
      peakQueuedLookups: number;
      queueFullRejections: number;
      completedLookups: number;
    };
    connectionStorm: {
      peakHeldConnections: number;
      overflowRejections: number;
      completedConnections: number;
      overflowOriginHits: number;
    };
    resources: {
      baselineRssBytes: number;
      peakRssBytes: number;
      settledRssBytes: number;
      baselineFileDescriptors: number;
      peakFileDescriptors: number;
      settledFileDescriptors: number;
    };
    audit: {
      denialRecords: number;
      quarantineRecords: number;
      retryRecords: number;
      bytesBefore: number;
      bytesAfter: number;
    };
    teardown: {
      drainedMs: number;
      hungMs: number;
      hungDrained: boolean;
      activeAfterLateCallback: number;
      lateDialCount: number;
    };
    budgetTransfers: EgressTransferSamples;
    saturationTransfers: EgressTransferSamples;
  };
}

export interface EgressTransferSummary {
  bytesPerTransfer: number;
  pairs: number;
  directDurationMs: SampleStats;
  proxyDurationMs: SampleStats;
  directThroughputMiBPerSecond: SampleStats;
  proxyThroughputMiBPerSecond: SampleStats;
  penaltyPercent: SampleStats;
  comparable: boolean;
  budgetPercent: number;
  comparator: string;
  status: "PASS" | "FAIL" | "PARTIAL";
}

export interface EgressAddressGuardMeasurementReport extends Omit<
  EgressAddressGuardMeasurementInput,
  "measurements"
> {
  connectionLatencyMs: SampleStats;
  requestThroughputPerSecond: number;
  resolver: EgressAddressGuardMeasurementInput["measurements"]["resolver"];
  connectionStorm: EgressAddressGuardMeasurementInput["measurements"]["connectionStorm"];
  resources: EgressAddressGuardMeasurementInput["measurements"]["resources"] & {
    settledRssGrowthBytes: number;
    settledFileDescriptorGrowth: number;
  };
  audit: EgressAddressGuardMeasurementInput["measurements"]["audit"] & {
    growthBytes: number;
  };
  teardown: EgressAddressGuardMeasurementInput["measurements"]["teardown"];
  budgetTransfers: EgressTransferSummary;
  saturationTransfers: EgressTransferSummary;
  summary: {
    status: "PASS" | "FAIL" | "PARTIAL";
    countsAsPass: boolean;
    reasons: string[];
  };
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function assertSamples(samples: readonly number[]): void {
  if (samples.length === 0) throw new Error("sample statistics require at least one sample");
  if (!samples.every((sample) => Number.isFinite(sample))) {
    throw new Error("measurement samples must be finite numbers");
  }
}

function assertPositiveSamples(samples: readonly number[]): void {
  assertSamples(samples);
  if (!samples.every((sample) => sample > 0)) {
    throw new Error("duration samples must be positive numbers");
  }
}

export function sampleStats(samples: readonly number[]): SampleStats {
  assertSamples(samples);
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (percentile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)]!;
  return {
    count: sorted.length,
    p50: rounded(pick(0.5)),
    p95: rounded(pick(0.95)),
    p99: rounded(pick(0.99)),
    max: rounded(sorted[sorted.length - 1]!),
  };
}

function transferSummary(
  samples: EgressTransferSamples,
  bytes: number,
  budgetStatus: EgressTransferSummary["status"],
): EgressTransferSummary {
  assertPositiveSamples(samples.directMs);
  assertPositiveSamples(samples.proxyMs);
  if (samples.directMs.length !== samples.proxyMs.length) {
    throw new Error("direct and proxy measurements must have the same paired sample count");
  }
  const toThroughput = (durationMs: number): number => bytes / (1024 * 1024) / (durationMs / 1_000);
  const directThroughput = samples.directMs.map(toThroughput);
  const proxyThroughput = samples.proxyMs.map(toThroughput);
  const penalties = directThroughput.map((direct, index) =>
    rounded((1 - proxyThroughput[index]! / direct) * 100),
  );
  return {
    bytesPerTransfer: bytes,
    pairs: samples.directMs.length,
    directDurationMs: sampleStats(samples.directMs),
    proxyDurationMs: sampleStats(samples.proxyMs),
    directThroughputMiBPerSecond: sampleStats(directThroughput),
    proxyThroughputMiBPerSecond: sampleStats(proxyThroughput),
    penaltyPercent: sampleStats(penalties),
    comparable: samples.comparable,
    budgetPercent: EGRESS_PROXY_BUDGET_PERCENT,
    comparator: `p95 < ${String(EGRESS_PROXY_BUDGET_PERCENT)}%`,
    status: budgetStatus,
  };
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validateCounters(input: EgressAddressGuardMeasurementInput): void {
  const values = [
    input.environment.logicalCpus,
    input.environment.totalMemoryBytes,
    input.configuration.latencySamples,
    input.configuration.loadRequests,
    input.configuration.connectionStormRequests,
    input.configuration.throughputRequests,
    input.configuration.transferBytes,
    input.configuration.transferPairs,
    input.configuration.budgetOriginRateBytesPerSecond,
    input.configuration.maxSettledRssGrowthBytes,
    input.configuration.maxSettledFileDescriptorGrowth,
    input.configuration.resourceBaselineDelayMs,
    input.configuration.resourceSampleIntervalMs,
    input.configuration.resourceSettleDelayMs,
    input.configuration.teardownToleranceMs,
    input.measurements.requestThroughput.requests,
    input.measurements.requestThroughput.durationMs,
    input.measurements.resolver.peakActiveLookups,
    input.measurements.resolver.peakQueuedLookups,
    input.measurements.resolver.queueFullRejections,
    input.measurements.resolver.completedLookups,
    input.measurements.connectionStorm.peakHeldConnections,
    input.measurements.connectionStorm.overflowRejections,
    input.measurements.connectionStorm.completedConnections,
    input.measurements.connectionStorm.overflowOriginHits,
    input.measurements.resources.baselineRssBytes,
    input.measurements.resources.peakRssBytes,
    input.measurements.resources.settledRssBytes,
    input.measurements.resources.baselineFileDescriptors,
    input.measurements.resources.peakFileDescriptors,
    input.measurements.resources.settledFileDescriptors,
    input.measurements.audit.denialRecords,
    input.measurements.audit.quarantineRecords,
    input.measurements.audit.retryRecords,
    input.measurements.audit.bytesBefore,
    input.measurements.audit.bytesAfter,
    input.measurements.teardown.drainedMs,
    input.measurements.teardown.hungMs,
    input.measurements.teardown.activeAfterLateCallback,
    input.measurements.teardown.lateDialCount,
  ];
  if (!values.every(finiteNonNegative)) {
    throw new Error("measurement counters must be finite non-negative numbers");
  }
  if (input.measurements.requestThroughput.durationMs <= 0) {
    throw new Error("request throughput duration must be positive");
  }
  if (input.measurements.audit.bytesAfter < input.measurements.audit.bytesBefore) {
    throw new Error("audit byte count cannot decrease");
  }
  if (!/^[0-9a-f]{40}$/.test(input.sha)) throw new Error("measurement SHA must be 40 hex digits");
  if (input.command.trim() === "") throw new Error("measurement command is required");
  if (Number.isNaN(Date.parse(input.generatedAt)))
    throw new Error("generatedAt must be an ISO date");
}

export function buildEgressAddressGuardMeasurement(
  input: EgressAddressGuardMeasurementInput,
): EgressAddressGuardMeasurementReport {
  validateCounters(input);
  const failures: string[] = [];
  const partials: string[] = [];
  const { configuration, measurements } = input;
  assertPositiveSamples(measurements.connectionLatencyMs);
  const latency = sampleStats(measurements.connectionLatencyMs);

  if (latency.count !== configuration.latencySamples) {
    partials.push("connection-latency sample count does not match the recorded configuration");
  }
  if (
    measurements.requestThroughput.requests !== configuration.throughputRequests ||
    measurements.requestThroughput.durationMs <= 0
  ) {
    partials.push("request-throughput sample count does not match the recorded configuration");
  }

  if (configuration.transferBytes !== CLAIM_TRANSFER_BYTES) {
    partials.push("claim-grade proxy evidence must transfer exactly 500 MiB per sample");
  }
  if (!measurements.budgetTransfers.comparable) {
    partials.push("budget direct/proxy transfer environment is not comparable");
  }
  if (
    measurements.budgetTransfers.directMs.length !== configuration.transferPairs ||
    measurements.budgetTransfers.proxyMs.length !== configuration.transferPairs
  ) {
    partials.push("budget transfer pair count does not match the recorded configuration");
  }

  const budgetPenalty = transferSummary(
    measurements.budgetTransfers,
    configuration.transferBytes,
    "PARTIAL",
  );
  let budgetStatus: EgressTransferSummary["status"] = "PASS";
  if (partials.some((reason) => reason.includes("proxy evidence") || reason.includes("transfer"))) {
    budgetStatus = "PARTIAL";
  } else if (budgetPenalty.penaltyPercent.p95 >= EGRESS_PROXY_BUDGET_PERCENT) {
    budgetStatus = "FAIL";
    failures.push(
      `p95 proxy throughput penalty ${String(budgetPenalty.penaltyPercent.p95)}% is not below ${String(EGRESS_PROXY_BUDGET_PERCENT)}%`,
    );
  }

  const resolver = measurements.resolver;
  if (
    resolver.peakActiveLookups !== EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentLookups ||
    resolver.peakQueuedLookups !== EGRESS_ADDRESS_GUARD_LIMITS.maxQueuedLookups
  ) {
    failures.push(
      `resolver queue evidence must reach but never exceed ${String(EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentLookups)} active and ${String(EGRESS_ADDRESS_GUARD_LIMITS.maxQueuedLookups)} queued lookups`,
    );
  }
  if (
    resolver.queueFullRejections < 1 ||
    resolver.completedLookups !== configuration.loadRequests
  ) {
    failures.push("resolver saturation must complete the bounded load and reject queue overflow");
  }

  const connectionStorm = measurements.connectionStorm;
  if (
    configuration.connectionStormRequests !==
      EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentGuardedConnections ||
    connectionStorm.peakHeldConnections !==
      EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentGuardedConnections ||
    connectionStorm.overflowRejections < 1 ||
    connectionStorm.completedConnections !== configuration.connectionStormRequests ||
    connectionStorm.overflowOriginHits !== 0
  ) {
    failures.push(
      "guarded connection storm must hold the fixed cap, reject overflow, complete, and keep overflow from the origin",
    );
  }

  const audit = measurements.audit;
  if (
    audit.denialRecords !== EGRESS_ADDRESS_GUARD_LIMITS.denialBurstLimit ||
    audit.quarantineRecords !== 1
  ) {
    failures.push(
      "denial storm must record the bounded denial burst and one quarantine transition",
    );
  }
  if (audit.retryRecords !== 0)
    failures.push("retry audit growth must remain zero after quarantine");

  const teardown = measurements.teardown;
  if (teardown.drainedMs > configuration.teardownToleranceMs) {
    failures.push("drained teardown exceeded the recorded tolerance");
  }
  if (
    teardown.hungMs <
      EGRESS_ADDRESS_GUARD_LIMITS.shutdownTimeoutMs - configuration.teardownToleranceMs ||
    teardown.hungMs >
      EGRESS_ADDRESS_GUARD_LIMITS.shutdownTimeoutMs + configuration.teardownToleranceMs ||
    teardown.hungDrained
  ) {
    failures.push("hung resolver teardown did not stop at the fixed shutdown bound");
  }
  if (teardown.activeAfterLateCallback !== 0) {
    failures.push("late resolver callback left active guard work after teardown");
  }
  if (teardown.lateDialCount !== 0)
    failures.push("late dial count must remain zero after teardown");

  const resources = measurements.resources;
  const settledRssGrowthBytes = resources.settledRssBytes - resources.baselineRssBytes;
  const settledFileDescriptorGrowth =
    resources.settledFileDescriptors - resources.baselineFileDescriptors;
  if (
    resources.peakRssBytes < resources.baselineRssBytes ||
    resources.peakRssBytes < resources.settledRssBytes ||
    settledRssGrowthBytes > configuration.maxSettledRssGrowthBytes
  ) {
    failures.push(
      `settled RSS growth ${String(settledRssGrowthBytes)} bytes exceeded the recorded ${String(configuration.maxSettledRssGrowthBytes)}-byte resource bound`,
    );
  }
  if (
    resources.peakFileDescriptors < resources.baselineFileDescriptors ||
    resources.peakFileDescriptors < resources.settledFileDescriptors ||
    settledFileDescriptorGrowth > configuration.maxSettledFileDescriptorGrowth
  ) {
    failures.push(
      `settled file descriptor growth ${String(settledFileDescriptorGrowth)} exceeded the recorded ${String(configuration.maxSettledFileDescriptorGrowth)}-descriptor resource bound`,
    );
  }

  const reasons = [...failures, ...partials];
  const status = failures.length > 0 ? "FAIL" : partials.length > 0 ? "PARTIAL" : "PASS";
  return {
    sha: input.sha,
    generatedAt: input.generatedAt,
    command: input.command,
    environment: { ...input.environment },
    configuration: { ...configuration },
    connectionLatencyMs: latency,
    requestThroughputPerSecond: rounded(
      (measurements.requestThroughput.requests * 1_000) / measurements.requestThroughput.durationMs,
    ),
    resolver: { ...resolver },
    connectionStorm: { ...connectionStorm },
    resources: { ...resources, settledRssGrowthBytes, settledFileDescriptorGrowth },
    audit: { ...audit, growthBytes: audit.bytesAfter - audit.bytesBefore },
    teardown: { ...teardown },
    budgetTransfers: { ...budgetPenalty, status: budgetStatus },
    saturationTransfers: transferSummary(
      measurements.saturationTransfers,
      configuration.transferBytes,
      "PARTIAL",
    ),
    summary: { status, countsAsPass: status === "PASS", reasons },
  };
}

function mib(value: number): string {
  return `${(value / (1024 * 1024)).toFixed(3)} MiB`;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

export function renderEgressAddressGuardMeasurement(
  report: EgressAddressGuardMeasurementReport,
): string {
  const lines = [
    "# Epic 3.22 Slice 8 measurement",
    "",
    `- Status: **${report.summary.status}**`,
    `- SHA: \`${report.sha}\``,
    `- Generated: ${report.generatedAt}`,
    `- Command: \`${report.command}\``,
    `- Environment: ${report.environment.platform} ${report.environment.release} ${report.environment.arch}; Node ${report.environment.node}; ${report.environment.cpu}; ${String(report.environment.logicalCpus)} logical CPUs; ${mib(report.environment.totalMemoryBytes)} RAM`,
    `- Controlled workload: 500 MiB at ${(report.configuration.budgetOriginRateBytesPerSecond / (1024 * 1024)).toFixed(3)} MiB/s; ${String(report.budgetTransfers.pairs)} paired samples`,
    "- Performance scope: the p95 <5% result is scoped to this controlled workload; unthrottled saturation remains diagnostic and does not close the generic MASTER_SPEC performance budget.",
    "",
    "| Metric | Result |",
    "| --- | ---: |",
    `| Connection latency p50 / p95 / p99 (n=${count(report.connectionLatencyMs.count)}) | ${String(report.connectionLatencyMs.p50)} / ${String(report.connectionLatencyMs.p95)} / ${String(report.connectionLatencyMs.p99)} ms |`,
    `| Small-request throughput (${count(report.configuration.throughputRequests)} requests) | ${String(report.requestThroughputPerSecond)} requests/s |`,
    `| Resolver active / queued peak (${count(report.configuration.loadRequests)} lookups) | ${String(report.resolver.peakActiveLookups)} / ${String(report.resolver.peakQueuedLookups)} |`,
    `| Guarded connection storm (${count(report.configuration.connectionStormRequests)} held connections) | ${String(report.connectionStorm.peakHeldConnections)} peak; ${String(report.connectionStorm.overflowRejections)} overflow rejection(s); ${String(report.connectionStorm.overflowOriginHits)} overflow origin hit(s) |`,
    `| RSS baseline / peak / settled (${count(report.configuration.resourceBaselineDelayMs)} ms baseline delay; ${String(report.configuration.resourceSampleIntervalMs)} ms cadence; ${String(report.configuration.resourceSettleDelayMs)} ms settle delay) | ${mib(report.resources.baselineRssBytes)} / ${mib(report.resources.peakRssBytes)} / ${mib(report.resources.settledRssBytes)} |`,
    `| File descriptors baseline / peak / settled (${count(report.configuration.resourceBaselineDelayMs)} ms baseline delay; ${String(report.configuration.resourceSampleIntervalMs)} ms cadence; ${String(report.configuration.resourceSettleDelayMs)} ms settle delay) | ${String(report.resources.baselineFileDescriptors)} / ${String(report.resources.peakFileDescriptors)} / ${String(report.resources.settledFileDescriptors)} |`,
    `| RSS settled growth / limit | ${mib(report.resources.settledRssGrowthBytes)} / ${mib(report.configuration.maxSettledRssGrowthBytes)} |`,
    `| FD settled growth / limit | ${String(report.resources.settledFileDescriptorGrowth)} / ${String(report.configuration.maxSettledFileDescriptorGrowth)} |`,
    `| Audit growth | ${String(report.audit.growthBytes)} bytes; ${String(report.audit.denialRecords)} denials + ${String(report.audit.quarantineRecords)} quarantine + ${String(report.audit.retryRecords)} retry records |`,
    `| Teardown drained / hung (n=1 each) | ${String(rounded(report.teardown.drainedMs))} / ${String(rounded(report.teardown.hungMs))} ms |`,
    `| Controlled proxy throughput penalty p50 / p95 / p99 (n=${count(report.budgetTransfers.pairs)} pairs) | ${String(report.budgetTransfers.penaltyPercent.p50)}% / ${String(report.budgetTransfers.penaltyPercent.p95)}% / ${String(report.budgetTransfers.penaltyPercent.p99)}% (${report.budgetTransfers.status}) |`,
    `| Saturation proxy throughput penalty p50 / p95 / p99 (n=${count(report.saturationTransfers.pairs)} pair) | ${String(report.saturationTransfers.penaltyPercent.p50)}% / ${String(report.saturationTransfers.penaltyPercent.p95)}% / ${String(report.saturationTransfers.penaltyPercent.p99)}% (diagnostic only) |`,
    "",
  ];
  if (report.summary.countsAsPass) {
    lines.push("This run closes the measured Slice 8 contract for the recorded environment.", "");
  } else {
    lines.push("This run does not close Slice 8.", "", "Reasons:", "");
    for (const reason of report.summary.reasons) lines.push(`- ${reason}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
