import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts?: Record<string, unknown>;
};
const toolPath = resolve(root, "tools/measure-egress-address-guard.mjs");

describe("egress address guard measurement CLI", () => {
  it("is a named repository command with an exact claim-grade workload", () => {
    expect(packageJson.scripts?.["measure:egress-address-guard"]).toBe(
      "node --conditions=@keel/source tools/measure-egress-address-guard.mjs",
    );
    const source = readFileSync(toolPath, "utf8");
    expect(source).toContain("CLAIM_TRANSFER_BYTES");
    expect(source).toContain("createBoundedEgressAddressResolver");
    expect(source).toContain("createHttpProxyServer");
    expect(source).toContain("AuditChainWriter");
    expect(source).toContain("budgetOriginRateBytesPerSecond: 250 * MIB");
    expect(source).toContain("now: () => 1_000");
    expect(source).toContain("resourceSampleIntervalMs: RESOURCE_SAMPLE_INTERVAL_MS");
    expect(source).toContain("resourceSettleDelayMs: RESOURCE_SETTLE_DELAY_MS");
    expect(source).toContain("saturationTransfers");
    expect(source).toContain("budgetTransfers");
    expect(source).toContain("process.exitCode = report.summary.countsAsPass ? 0 : 1");
    expect(source).not.toContain("fetch(");
  });

  it("documents every environment- and sample-shaping argument without starting a measurement", () => {
    const output = execFileSync(process.execPath, [toolPath, "--help"], {
      cwd: root,
      encoding: "utf8",
    });
    for (const option of [
      "--fixture-address",
      "--output-dir",
      "--pairs",
      "--latency-samples",
      "--throughput-requests",
    ]) {
      expect(output).toContain(option);
    }
    expect(output).toContain("exactly 500 MiB");
    expect(output).toContain("250 MiB/s");
    expect(output).toContain("saturation");
  });

  it("accepts pnpm's one leading argument separator without relaxing unknown options", () => {
    const output = execFileSync(
      "corepack",
      ["pnpm", "measure:egress-address-guard", "--", "--help"],
      { cwd: root, encoding: "utf8" },
    );

    expect(output).toContain("Usage: pnpm measure:egress-address-guard");
    const rejected = spawnSync(process.execPath, [toolPath, "--", "--unknown"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("unknown measurement option");
  });
});
