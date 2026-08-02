#!/usr/bin/env node
/* global AbortController */
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearInterval, setImmediate, setInterval, setTimeout } from "node:timers";
import { URL } from "node:url";
import { tsImport } from "tsx/esm/api";

const MIB = 1024 * 1024;
const HELP = `Usage: pnpm measure:egress-address-guard [options]

Runs Epic 3.22's hermetic resource and performance evidence against an address
already bound to the host (CI uses a disposable public-classified loopback alias).

Options:
  --fixture-address <ip>       Bound public-classified fixture address (default: 93.184.216.35)
  --output-dir <path>          Artifact directory (default: a new directory under the OS temp root)
  --pairs <count>              Paired 500 MiB budget transfers (default: 5)
  --latency-samples <count>    Guarded small-response samples (default: 200)
  --throughput-requests <n>    Guarded small requests in the throughput load (default: 1000)
  --help                       Print this help without loading the measurement modules

Every budget sample transfers exactly 500 MiB. Budget pairs use the same origin,
process, bytes, and alternating order at a pinned 250 MiB/s origin rate. A separate
unthrottled saturation pair is diagnostic and cannot erase a budget miss.
`;

function positiveInteger(raw, option) {
  if (!/^\d+$/.test(raw ?? "")) throw new Error(`${option} requires a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${option} requires a positive integer`);
  }
  return value;
}

function parseArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const options = {
    fixtureAddress: "93.184.216.35",
    outputDir: undefined,
    pairs: 5,
    latencySamples: 200,
    throughputRequests: 1_000,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help") return { help: true, options };
    const value = args[index + 1];
    if (arg === "--fixture-address") options.fixtureAddress = value ?? "";
    else if (arg === "--output-dir") options.outputDir = value;
    else if (arg === "--pairs") options.pairs = positiveInteger(value, arg);
    else if (arg === "--latency-samples") options.latencySamples = positiveInteger(value, arg);
    else if (arg === "--throughput-requests") {
      options.throughputRequests = positiveInteger(value, arg);
    } else {
      throw new Error(`unknown measurement option: ${arg ?? "<missing>"}`);
    }
    index += 1;
  }
  if (options.fixtureAddress === "") throw new Error("--fixture-address requires an address");
  return { help: false, options };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const root = new URL("../", import.meta.url);
const importOptions = { parentURL: import.meta.url, tsconfig: false };
const measurementModule = await tsImport(
  new URL("packages/warden/src/measurement/egress-address-guard-measurement.ts", root).href,
  importOptions,
);
const resolverModule = await tsImport(
  new URL("packages/warden/src/egress-resolver.ts", root).href,
  importOptions,
);
const auditModule = await tsImport(
  new URL("packages/warden/src/audit/writer.ts", root).href,
  importOptions,
);
const proxyModule = await tsImport(
  new URL("vendor/sandbox-runtime/src/sandbox/http-proxy.ts", root).href,
  importOptions,
);
const destinationDialModule = await tsImport(
  new URL("vendor/sandbox-runtime/src/sandbox/destination-dial.ts", root).href,
  importOptions,
);

const {
  buildEgressAddressGuardMeasurement,
  CLAIM_TRANSFER_BYTES,
  renderEgressAddressGuardMeasurement,
} = measurementModule;
const { createBoundedEgressAddressResolver, EGRESS_ADDRESS_GUARD_LIMITS } = resolverModule;
const { AuditChainWriter } = auditModule;
const { createHttpProxyServer } = proxyModule;
const { MAX_CONCURRENT_GUARDED_CONNECTIONS } = destinationDialModule;

const LOAD_REQUESTS =
  EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentLookups + EGRESS_ADDRESS_GUARD_LIMITS.maxQueuedLookups;
const BUDGET_ORIGIN_RATE_BYTES_PER_SECOND = 250 * MIB;
const MAX_SETTLED_RSS_GROWTH_BYTES = 64 * MIB;
const MAX_SETTLED_FD_GROWTH = 2;
const RESOURCE_BASELINE_DELAY_MS = 1_000;
const RESOURCE_SAMPLE_INTERVAL_MS = 5;
const RESOURCE_SETTLE_DELAY_MS = 100;
const TEARDOWN_TOLERANCE_MS = 750;
const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PRINCIPAL = {
  osUser: "egress-measurement",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
};
const BODY_CHUNK = Buffer.alloc(256 * 1024, 0x6b);

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return { promise, resolve: resolvePromise };
}

function listen(server, address) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, address, () => {
      server.removeListener("error", reject);
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        reject(new Error("expected an internet socket address"));
        return;
      }
      resolveListen(bound.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose, reject) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else reject(error);
    });
  });
}

function writeBody(response, bytes, rateBytesPerSecond) {
  let remaining = bytes;
  const started = performance.now();
  const pump = () => {
    const sent = bytes - remaining;
    const allowance =
      rateBytesPerSecond === 0
        ? remaining
        : Math.max(
            0,
            Math.floor(((performance.now() - started) / 1_000) * rateBytesPerSecond) - sent,
          );
    let writable = allowance;
    while (remaining > 0 && writable > 0) {
      const size = Math.min(BODY_CHUNK.length, remaining, writable);
      remaining -= size;
      writable -= size;
      if (!response.write(size === BODY_CHUNK.length ? BODY_CHUNK : BODY_CHUNK.subarray(0, size))) {
        response.once("drain", pump);
        return;
      }
    }
    if (remaining === 0) response.end();
    else setTimeout(pump, 1);
  };
  pump();
}

function createOriginServer() {
  const hits = new Map();
  const heldResponses = new Set();
  const server = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? "/", "http://fixture.invalid");
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    if (url.pathname === "/small") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": "1",
        connection: "close",
      });
      response.end("k");
      return;
    }
    if (url.pathname === "/hold") {
      heldResponses.add(response);
      response.once("close", () => heldResponses.delete(response));
      return;
    }
    const bytes = Number(url.searchParams.get("bytes"));
    const rate = Number(url.searchParams.get("rate"));
    if (
      url.pathname !== "/bytes" ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      !Number.isSafeInteger(rate) ||
      rate < 0
    ) {
      response.writeHead(400, { "content-length": "0", connection: "close" });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(bytes),
      connection: "close",
    });
    writeBody(response, bytes, rate);
  });
  return {
    server,
    hits: (path) => hits.get(path) ?? 0,
    heldConnections: () => heldResponses.size,
    releaseHeld() {
      for (const response of [...heldResponses]) {
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": "1",
          connection: "close",
        });
        response.end("k");
      }
    },
  };
}

function readResponse(options, expectedBytes) {
  return new Promise((resolveResponse, reject) => {
    const started = performance.now();
    const outgoing = request({ ...options, agent: false }, (response) => {
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
      });
      response.once("error", reject);
      response.once("end", () => {
        if (response.statusCode !== 200 || bytes !== expectedBytes) {
          reject(
            new Error(
              `unexpected measurement response: status=${String(response.statusCode)} bytes=${String(bytes)}`,
            ),
          );
          return;
        }
        resolveResponse(performance.now() - started);
      });
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function directRequest(address, port, path, expectedBytes) {
  return readResponse({ hostname: address, port, path, method: "GET" }, expectedBytes);
}

function proxyRequest(proxyPort, logicalHost, originPort, path, expectedBytes) {
  const absoluteUrl = `http://${logicalHost}:${String(originPort)}${path}`;
  return readResponse(
    {
      hostname: "127.0.0.1",
      port: proxyPort,
      path: absoluteUrl,
      method: "GET",
      headers: { host: `${logicalHost}:${String(originPort)}` },
    },
    expectedBytes,
  );
}

function deniedProxyRequest(proxyPort, logicalHost, originPort, path) {
  const absoluteUrl = `http://${logicalHost}:${String(originPort)}${path}`;
  return new Promise((resolveResponse, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port: proxyPort,
        path: absoluteUrl,
        method: "GET",
        headers: { host: `${logicalHost}:${String(originPort)}` },
        agent: false,
      },
      (response) => {
        response.resume();
        response.once("error", reject);
        response.once("end", () => {
          if (
            response.statusCode !== 403 ||
            response.headers["x-proxy-error"] !== "blocked-address-policy"
          ) {
            reject(
              new Error(
                `unexpected overflow response: status=${String(response.statusCode)} reason=${String(response.headers["x-proxy-error"])}`,
              ),
            );
            return;
          }
          resolveResponse();
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function waitFor(predicate, description, timeoutMs = 5_000) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

function fileDescriptorCount() {
  const directory = existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd";
  if (!existsSync(directory))
    throw new Error("cannot measure process file descriptors on this host");
  return readdirSync(directory).length;
}

function resourcePoint() {
  return { rssBytes: process.memoryUsage().rss, fileDescriptors: fileDescriptorCount() };
}

function startResourceSampler() {
  const baseline = resourcePoint();
  let peakRssBytes = baseline.rssBytes;
  let peakFileDescriptors = baseline.fileDescriptors;
  const sample = () => {
    const point = resourcePoint();
    peakRssBytes = Math.max(peakRssBytes, point.rssBytes);
    peakFileDescriptors = Math.max(peakFileDescriptors, point.fileDescriptors);
  };
  const timer = setInterval(sample, RESOURCE_SAMPLE_INTERVAL_MS);
  return {
    baseline,
    async finish() {
      clearInterval(timer);
      await new Promise((resolveWait) => setTimeout(resolveWait, RESOURCE_SETTLE_DELAY_MS));
      sample();
      const settled = resourcePoint();
      return {
        baselineRssBytes: baseline.rssBytes,
        peakRssBytes,
        settledRssBytes: settled.rssBytes,
        baselineFileDescriptors: baseline.fileDescriptors,
        peakFileDescriptors,
        settledFileDescriptors: settled.fileDescriptors,
      };
    },
  };
}

async function measureResolverLoad() {
  const callbacks = [];
  const audit = [];
  const resolver = createBoundedEgressAddressResolver({
    lookup: (_hostname, _options, callback) => callbacks.push(callback),
    audit: { append: (record) => audit.push(record) },
    onQuarantine: () => {},
  });
  const requests = Array.from({ length: LOAD_REQUESTS }, (_, index) =>
    resolver.resolveDestination(`load-${String(index)}.example`, 443, new AbortController().signal),
  );
  const peak = resolver.snapshot();
  let queueFullRejections = 0;
  try {
    await resolver.resolveDestination("overflow.example", 443, new AbortController().signal);
  } catch (error) {
    if (error?.code !== "resolver-queue-full") throw error;
    queueFullRejections += 1;
  }
  let callbackIndex = 0;
  while (callbackIndex < LOAD_REQUESTS) {
    const callback = callbacks[callbackIndex];
    if (callback === undefined) {
      await Promise.resolve();
      continue;
    }
    callback(null, [{ address: "93.184.216.35", family: 4 }]);
    callbackIndex += 1;
  }
  await Promise.all(requests);
  const shutdownStarted = performance.now();
  const shutdown = await resolver.shutdown();
  const drainedMs = performance.now() - shutdownStarted;
  if (!shutdown.drained || resolver.snapshot().activeLookups !== 0) {
    throw new Error("resolver load did not drain cleanly");
  }
  return {
    resolver: {
      peakActiveLookups: peak.activeLookups,
      peakQueuedLookups: peak.queuedLookups,
      queueFullRejections,
      completedLookups: requests.length,
    },
    drainedMs,
  };
}

async function measureAuditStorm() {
  const directory = mkdtempSync(join(tmpdir(), "keel-egress-audit-measurement-"));
  const auditPath = join(directory, "egress.jsonl");
  const writer = AuditChainWriter.open({ path: auditPath, principal: PRINCIPAL });
  let denialRecords = 0;
  let quarantineRecords = 0;
  const resolver = createBoundedEgressAddressResolver({
    audit: {
      append(record) {
        writer.append({
          eventType: "egress.deny",
          sessionId: SESSION_ID,
          payload: {
            host: record.host,
            port: record.port,
            reason: record.reason,
            addressClass: record.addressClass,
            answerCount: record.answerCount,
            exceptionPolicyRevision: record.exceptionPolicyRevision,
          },
        });
        if (record.kind === "quarantine") quarantineRecords += 1;
        else denialRecords += 1;
      },
    },
    onQuarantine: () => {},
    now: () => 1_000,
  });
  try {
    const bytesBefore = existsSync(auditPath) ? statSync(auditPath).size : 0;
    for (let index = 0; index < EGRESS_ADDRESS_GUARD_LIMITS.denialBurstLimit; index += 1) {
      try {
        await resolver.resolveDestination("127.0.0.1", 443, new AbortController().signal);
      } catch {
        // The denial is the measured behavior; its durable record is counted below.
      }
    }
    const beforeRetries = denialRecords + quarantineRecords;
    for (let index = 0; index < 100; index += 1) {
      try {
        await resolver.resolveDestination("8.8.8.8", 443, new AbortController().signal);
      } catch {
        // Quarantined retries must fail without adding another durable record.
      }
    }
    const retryRecords = denialRecords + quarantineRecords - beforeRetries;
    writer.close();
    return {
      denialRecords,
      quarantineRecords,
      retryRecords,
      bytesBefore,
      bytesAfter: statSync(auditPath).size,
    };
  } finally {
    try {
      writer.close();
    } catch {
      // The writer may already be closed by the successful path.
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

async function measureHungResolverTeardown(origin, originPort) {
  const lookupStarted = deferred();
  let lateCallback;
  const resolver = createBoundedEgressAddressResolver({
    lookup: (_hostname, _options, callback) => {
      lateCallback = callback;
      lookupStarted.resolve();
    },
    audit: { append: () => {} },
    onQuarantine: () => {},
  });
  const proxy = createHttpProxyServer({
    filter: () => true,
    resolveDestination: (host, port, signal) => resolver.resolveDestination(host, port, signal),
  });
  const proxyPort = await listen(proxy, "127.0.0.1");
  const beforeHits = origin.hits("/small");
  try {
    const requestPromise = proxyRequest(proxyPort, "late.example", originPort, "/small", 1).catch(
      () => undefined,
    );
    await lookupStarted.promise;
    const started = performance.now();
    const shutdownPromise = resolver.shutdown();
    await requestPromise;
    const shutdown = await shutdownPromise;
    const hungMs = performance.now() - started;
    lateCallback?.(null, [{ address: parsed.options.fixtureAddress, family: 4 }]);
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    return {
      hungMs,
      hungDrained: shutdown.drained,
      activeAfterLateCallback: resolver.snapshot().activeLookups,
      lateDialCount: origin.hits("/small") - beforeHits,
    };
  } finally {
    await closeServer(proxy);
  }
}

async function measureConnectionStorm(origin, proxyPort, originPort) {
  const requests = Array.from({ length: MAX_CONCURRENT_GUARDED_CONNECTIONS }, () =>
    proxyRequest(proxyPort, "measure.example", originPort, "/hold", 1),
  );
  const completion = Promise.all(requests);
  void completion.catch(() => {});
  try {
    await waitFor(
      () => origin.heldConnections() === MAX_CONCURRENT_GUARDED_CONNECTIONS,
      "the guarded connection cap",
    );
    const peakHeldConnections = origin.heldConnections();
    const beforeOverflowHits = origin.hits("/small");
    await deniedProxyRequest(proxyPort, "measure.example", originPort, "/small");
    const overflowOriginHits = origin.hits("/small") - beforeOverflowHits;
    origin.releaseHeld();
    await completion;
    return {
      peakHeldConnections,
      overflowRejections: 1,
      completedConnections: requests.length,
      overflowOriginHits,
    };
  } catch (error) {
    origin.releaseHeld();
    await completion.catch(() => {});
    throw error;
  }
}

async function measureLatencyAndThroughput(proxyPort, originPort) {
  for (let index = 0; index < 10; index += 1) {
    await proxyRequest(proxyPort, "measure.example", originPort, "/small", 1);
  }
  const connectionLatencyMs = [];
  for (let index = 0; index < parsed.options.latencySamples; index += 1) {
    connectionLatencyMs.push(
      await proxyRequest(proxyPort, "measure.example", originPort, "/small", 1),
    );
  }
  let next = 0;
  const started = performance.now();
  const workers = Array.from(
    { length: Math.min(32, parsed.options.throughputRequests) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= parsed.options.throughputRequests) return;
        await proxyRequest(proxyPort, "measure.example", originPort, "/small", 1);
      }
    },
  );
  await Promise.all(workers);
  return {
    connectionLatencyMs,
    requestThroughput: {
      requests: parsed.options.throughputRequests,
      durationMs: performance.now() - started,
    },
  };
}

async function transferPair(address, proxyPort, originPort, rate, proxyFirst) {
  const path = `/bytes?bytes=${String(CLAIM_TRANSFER_BYTES)}&rate=${String(rate)}`;
  let directMs;
  let proxyMs;
  if (proxyFirst) {
    proxyMs = await proxyRequest(
      proxyPort,
      "measure.example",
      originPort,
      path,
      CLAIM_TRANSFER_BYTES,
    );
    directMs = await directRequest(address, originPort, path, CLAIM_TRANSFER_BYTES);
  } else {
    directMs = await directRequest(address, originPort, path, CLAIM_TRANSFER_BYTES);
    proxyMs = await proxyRequest(
      proxyPort,
      "measure.example",
      originPort,
      path,
      CLAIM_TRANSFER_BYTES,
    );
  }
  return { directMs, proxyMs };
}

async function measureTransfers(address, proxyPort, originPort, pairs, rate) {
  const directMs = [];
  const proxyMs = [];
  for (let index = 0; index < pairs; index += 1) {
    const pair = await transferPair(address, proxyPort, originPort, rate, index % 2 === 1);
    directMs.push(pair.directMs);
    proxyMs.push(pair.proxyMs);
  }
  return { comparable: true, directMs, proxyMs };
}

const outputDir = resolve(
  parsed.options.outputDir ?? mkdtempSync(join(tmpdir(), "keel-egress-measurement-")),
);
mkdirSync(outputDir, { recursive: true });
await new Promise((resolveWait) => setTimeout(resolveWait, RESOURCE_BASELINE_DELAY_MS));
const resources = startResourceSampler();
const origin = createOriginServer();
let originPort;
let guardedProxy;
let guardedResolver;
try {
  try {
    originPort = await listen(origin.server, parsed.options.fixtureAddress);
  } catch (error) {
    throw new Error(
      `fixture address ${parsed.options.fixtureAddress} is not bound; configure a disposable host alias before measuring`,
      { cause: error },
    );
  }
  guardedResolver = createBoundedEgressAddressResolver({
    lookup: (_hostname, _options, callback) => {
      void Promise.resolve().then(() =>
        callback(null, [{ address: parsed.options.fixtureAddress, family: 4 }]),
      );
    },
    audit: {
      append(record) {
        throw new Error(`positive measurement unexpectedly denied: ${record.reason}`);
      },
    },
    onQuarantine: () => {},
  });
  guardedProxy = createHttpProxyServer({
    filter: (_port, host) => host === "measure.example",
    resolveDestination: (host, port, signal) =>
      guardedResolver.resolveDestination(host, port, signal),
  });
  const proxyPort = await listen(guardedProxy, "127.0.0.1");

  const load = await measureResolverLoad();
  const audit = await measureAuditStorm();
  const teardown = await measureHungResolverTeardown(origin, originPort);
  const connectionStorm = await measureConnectionStorm(origin, proxyPort, originPort);
  const latencyAndThroughput = await measureLatencyAndThroughput(proxyPort, originPort);
  const saturationTransfers = await measureTransfers(
    parsed.options.fixtureAddress,
    proxyPort,
    originPort,
    1,
    0,
  );
  const budgetTransfers = await measureTransfers(
    parsed.options.fixtureAddress,
    proxyPort,
    originPort,
    parsed.options.pairs,
    BUDGET_ORIGIN_RATE_BYTES_PER_SECOND,
  );

  await closeServer(guardedProxy);
  guardedProxy = undefined;
  await guardedResolver.shutdown();
  guardedResolver = undefined;
  await closeServer(origin.server);
  originPort = undefined;
  const resourceMeasurements = await resources.finish();
  const command =
    process.env.KEEL_MEASUREMENT_COMMAND ??
    [process.execPath, ...process.execArgv, process.argv[1], ...process.argv.slice(2)]
      .map((part) => JSON.stringify(part))
      .join(" ");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: new URL(".", root),
    encoding: "utf8",
  }).trim();
  const report = buildEgressAddressGuardMeasurement({
    sha,
    generatedAt: new Date().toISOString(),
    command,
    environment: {
      platform: platform(),
      release: release(),
      arch: arch(),
      node: process.version,
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    configuration: {
      latencySamples: parsed.options.latencySamples,
      loadRequests: LOAD_REQUESTS,
      connectionStormRequests: MAX_CONCURRENT_GUARDED_CONNECTIONS,
      throughputRequests: parsed.options.throughputRequests,
      transferBytes: CLAIM_TRANSFER_BYTES,
      transferPairs: parsed.options.pairs,
      budgetOriginRateBytesPerSecond: 250 * MIB,
      maxSettledRssGrowthBytes: MAX_SETTLED_RSS_GROWTH_BYTES,
      maxSettledFileDescriptorGrowth: MAX_SETTLED_FD_GROWTH,
      resourceBaselineDelayMs: RESOURCE_BASELINE_DELAY_MS,
      resourceSampleIntervalMs: RESOURCE_SAMPLE_INTERVAL_MS,
      resourceSettleDelayMs: RESOURCE_SETTLE_DELAY_MS,
      teardownToleranceMs: TEARDOWN_TOLERANCE_MS,
    },
    measurements: {
      ...latencyAndThroughput,
      resolver: load.resolver,
      connectionStorm,
      resources: resourceMeasurements,
      audit,
      teardown: { drainedMs: load.drainedMs, ...teardown },
      budgetTransfers,
      saturationTransfers,
    },
  });
  const jsonPath = join(outputDir, "egress-address-guard-measurement.json");
  const markdownPath = join(outputDir, "egress-address-guard-measurement.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderEgressAddressGuardMeasurement(report));
  process.stdout.write(readFileSync(markdownPath, "utf8"));
  process.stdout.write(`Artifacts: ${jsonPath}\n${markdownPath}\n`);
  process.exitCode = report.summary.countsAsPass ? 0 : 1;
} finally {
  if (guardedProxy !== undefined) await closeServer(guardedProxy).catch(() => {});
  if (guardedResolver !== undefined) await guardedResolver.shutdown().catch(() => {});
  if (originPort !== undefined) await closeServer(origin.server).catch(() => {});
}
