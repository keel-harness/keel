import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockedGate,
  budgetResult,
  commandGate,
  environmentGatedGate,
  ownerGatedGate,
  parseCommandEnvValue,
  renderMarkdown,
  stats,
  summarizeGates,
  writeGateArtifacts,
  type GateBundle,
  type GateResult,
} from "./phase2a-gate-lib.js";

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  delete process.env["KEEL_PHASE2A_ALLOW_PAID"];
  delete process.env["KEEL_PHASE2A_BENCHMARK_COMMAND"];
  delete process.env["KEEL_PHASE2A_ALLOW_ENV_GATES"];
  delete process.env["KEEL_PHASE2A_FRESH_LINUX_COMMAND"];
});

describe("phase2a gate harness", () => {
  it("keeps any failed, blocked, partial, or not-run gate from counting as Phase-2A pass", () => {
    const gates: GateResult[] = [
      { id: "ok", title: "ok", status: "PASS", countsAsPass: true },
      { id: "fail", title: "fail", status: "FAIL", countsAsPass: false },
      { id: "blocked", title: "blocked", status: "BLOCKED", countsAsPass: false },
      { id: "partial", title: "partial", status: "PARTIAL", countsAsPass: false },
      { id: "not-run", title: "not run", status: "NOT_RUN", countsAsPass: false },
    ];

    expect(summarizeGates(gates)).toMatchObject({
      status: "FAIL",
      countsAsPass: false,
      passed: 1,
      total: 5,
    });
  });

  it("reports owner-gated paid/provider work as NOT_RUN unless both allow flag and command are present", () => {
    expect(
      ownerGatedGate({
        id: "benchmark",
        title: "Live benchmark",
        commandEnv: "KEEL_PHASE2A_BENCHMARK_COMMAND",
      }),
    ).toMatchObject({ status: "NOT_RUN", countsAsPass: false });

    process.env["KEEL_PHASE2A_ALLOW_PAID"] = "1";
    process.env["KEEL_PHASE2A_BENCHMARK_COMMAND"] = "node --version";

    expect(
      ownerGatedGate({
        id: "benchmark",
        title: "Live benchmark",
        commandEnv: "KEEL_PHASE2A_BENCHMARK_COMMAND",
      }),
    ).toMatchObject({ status: "PASS", countsAsPass: true, exitCode: 0 });
  });

  it("keeps environment-gated external evidence blocked unless explicitly allowed and runnable", () => {
    expect(
      environmentGatedGate({
        id: "fresh-linux",
        title: "Fresh Linux first-task timing",
        commandEnv: "KEEL_PHASE2A_FRESH_LINUX_COMMAND",
        allowEnv: "KEEL_PHASE2A_ALLOW_ENV_GATES",
        reason: "Run on a fresh Linux VM.",
      }),
    ).toMatchObject({ status: "BLOCKED", countsAsPass: false });

    process.env["KEEL_PHASE2A_ALLOW_ENV_GATES"] = "1";
    process.env["KEEL_PHASE2A_FRESH_LINUX_COMMAND"] = "node --version";

    expect(
      environmentGatedGate({
        id: "fresh-linux",
        title: "Fresh Linux first-task timing",
        commandEnv: "KEEL_PHASE2A_FRESH_LINUX_COMMAND",
        allowEnv: "KEEL_PHASE2A_ALLOW_ENV_GATES",
        reason: "Run on a fresh Linux VM.",
      }),
    ).toMatchObject({ status: "PASS", countsAsPass: true, exitCode: 0 });
  });

  it("supports exact JSON argv owner commands and rejects malformed commands as gate failures", () => {
    expect(parseCommandEnvValue("node    --version")).toEqual(["node", "--version"]);
    expect(parseCommandEnvValue("[]")).toEqual([]);
    expect(() => parseCommandEnvValue("[")).toThrow("command JSON is invalid");
    expect(() => parseCommandEnvValue('{"cmd":"node"}')).toThrow("array of argv strings");
    expect(() => parseCommandEnvValue('["node",""]')).toThrow("non-empty strings");
    expect(
      parseCommandEnvValue('["node","--eval","console.log(process.argv[1])","hello world"]'),
    ).toEqual(["node", "--eval", "console.log(process.argv[1])", "hello world"]);

    process.env["KEEL_PHASE2A_ALLOW_PAID"] = "1";
    process.env["KEEL_PHASE2A_BENCHMARK_COMMAND"] =
      '["node","--eval","process.exit(process.argv[1] === \\"hello world\\" ? 0 : 1)","hello world"]';

    expect(
      ownerGatedGate({
        id: "benchmark",
        title: "Live benchmark",
        commandEnv: "KEEL_PHASE2A_BENCHMARK_COMMAND",
      }),
    ).toMatchObject({ status: "PASS", countsAsPass: true, exitCode: 0 });

    process.env["KEEL_PHASE2A_BENCHMARK_COMMAND"] = '["node",17]';

    const malformed = ownerGatedGate({
      id: "benchmark",
      title: "Live benchmark",
      commandEnv: "KEEL_PHASE2A_BENCHMARK_COMMAND",
    });

    expect(malformed).toMatchObject({ status: "FAIL", countsAsPass: false });
    expect(malformed.error).toContain("JSON argv array");

    process.env["KEEL_PHASE2A_BENCHMARK_COMMAND"] = "   ";

    expect(
      ownerGatedGate({
        id: "benchmark",
        title: "Live benchmark",
        commandEnv: "KEEL_PHASE2A_BENCHMARK_COMMAND",
      }),
    ).toMatchObject({ status: "NOT_RUN", countsAsPass: false });
  });

  it("records empty local commands as failed gates instead of throwing", () => {
    expect(commandGate({ id: "empty", title: "Empty command", command: [] })).toMatchObject({
      status: "FAIL",
      countsAsPass: false,
      exitCode: null,
      error: "commandGate requires a non-empty argv command",
    });
  });

  it("records nonzero command exits with a summary reason", () => {
    const failed = commandGate({
      id: "nonzero",
      title: "Nonzero command",
      command: ["node", "--eval", "process.exit(7)"],
    });

    expect(failed).toMatchObject({ status: "FAIL", countsAsPass: false, exitCode: 7 });
    expect(failed.reason).toContain("command exited with code 7");
  });

  it("records command start failures, timeouts, and signals explicitly", () => {
    const startFailure = commandGate({
      id: "missing",
      title: "Missing command",
      command: ["keel-phase2a-missing-command"],
    });

    expect(startFailure).toMatchObject({ status: "FAIL", countsAsPass: false, exitCode: null });
    expect(startFailure.reason).toContain("command failed to start");

    const timeout = commandGate({
      id: "timeout",
      title: "Timeout command",
      command: ["node", "--eval", "setTimeout(() => {}, 1000)"],
      timeoutMs: 1,
    });

    expect(timeout).toMatchObject({ status: "BLOCKED", countsAsPass: false });
    expect(timeout.reason).toContain("command timed out");

    const signaled = commandGate({
      id: "signal",
      title: "Signal command",
      command: ["node", "--eval", "process.kill(process.pid, 'SIGTERM')"],
    });

    expect(signaled).toMatchObject({ status: "FAIL", countsAsPass: false, exitCode: null });
    expect(signaled.reason).toContain("with signal");
  });

  it("classifies percentile budgets without rounding hidden failures away", () => {
    expect(() => stats([])).toThrow("stats requires at least one sample");
    expect(stats([3, 1, 2, 10])).toEqual({ count: 4, p50: 2, p95: 10, p99: 10, max: 10 });
    expect(budgetResult(1.999, 2)).toMatchObject({ status: "PASS", countsAsPass: true });
    expect(budgetResult(2, 2)).toMatchObject({ status: "FAIL", countsAsPass: false });
    expect(budgetResult(2.001, 2)).toMatchObject({ status: "FAIL", countsAsPass: false });
    expect(budgetResult(2, 2, "lte")).toMatchObject({ status: "PASS", countsAsPass: true });
  });

  it("marks all-pass bundles as closing the measured gate set", () => {
    const gates: GateResult[] = [
      { id: "ok", title: "ok | escaped", status: "PASS", countsAsPass: true, reason: "all\ngood" },
    ];
    const summary = summarizeGates(gates);
    const bundle: GateBundle = {
      sha: "sha",
      generatedAt: "2026-06-29T00:00:00.000Z",
      host: { platform: "linux", arch: "x64", node: "v20.14.0" },
      gates,
      summary,
    };
    const markdown = renderMarkdown(bundle);

    expect(summary).toMatchObject({ status: "PASS", countsAsPass: true });
    expect(markdown).toContain("This run closes the measured Phase-2A gate set.");
    expect(markdown).toContain("ok \\| escaped");
    expect(markdown).toContain("all<br>good");
  });

  it("writes machine-readable and human-readable artifacts with non-pass status intact", () => {
    dir = mkdtempSync(join(tmpdir(), "keel-phase2a-gates-"));
    const gates = [blockedGate({ id: "linux", title: "Fresh Linux", reason: "no daemon" })];
    const bundle: GateBundle = {
      sha: "sha",
      generatedAt: "2026-06-29T00:00:00.000Z",
      host: { platform: "darwin", arch: "arm64", node: "v20.14.0" },
      gates,
      summary: summarizeGates(gates),
    };

    writeGateArtifacts(dir, bundle);

    expect(JSON.parse(readFileSync(join(dir, "phase2a-gates.json"), "utf8"))).toMatchObject({
      summary: { status: "BLOCKED", countsAsPass: false },
    });
    expect(readFileSync(join(dir, "phase2a-gates.md"), "utf8")).toContain(
      "This run does not close the Phase-2A gate.",
    );
  });
});
