import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type GateStatus = "PASS" | "FAIL" | "PARTIAL" | "NOT_RUN" | "BLOCKED";

export interface GateResult {
  readonly id: string;
  readonly title: string;
  readonly status: GateStatus;
  readonly countsAsPass: boolean;
  readonly command?: string;
  readonly started?: string;
  readonly finished?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string | null;
  readonly reason?: string;
}

export interface PercentileStats {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface GateSummary {
  readonly status: "PASS" | "FAIL" | "BLOCKED";
  readonly countsAsPass: boolean;
  readonly total: number;
  readonly passed: number;
  readonly nonPassing: Array<{ id: string; status: GateStatus; reason: string | null }>;
}

export interface GateBundle {
  readonly sha: string;
  readonly generatedAt: string;
  readonly host: { readonly platform: string; readonly arch: string; readonly node: string };
  readonly gates: readonly GateResult[];
  readonly summary: GateSummary;
}

export function parseCommandEnvValue(rawCommand: string): readonly string[] {
  const trimmed = rawCommand.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("{")) {
    throw new Error("command JSON must be an array of argv strings");
  }
  if (!trimmed.startsWith("[")) return trimmed.split(/\s+/);

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`command JSON is invalid: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("command JSON must be an array of argv strings");
  }
  const parts = parsed as unknown[];
  if (parts.length === 0) return [];
  const command: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string" || part.trim() === "") {
      throw new Error("command JSON must contain only non-empty strings");
    }
    command.push(part);
  }
  return command;
}

export function stats(samples: readonly number[]): PercentileStats {
  if (samples.length === 0) {
    throw new Error("stats requires at least one sample");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (percentile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)]!;
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return {
    count: sorted.length,
    p50: round(pick(0.5)),
    p95: round(pick(0.95)),
    p99: round(pick(0.99)),
    max: round(sorted[sorted.length - 1]!),
  };
}

export function budgetResult(
  metric: number,
  threshold: number,
  comparator: "lt" | "lte" = "lt",
): {
  readonly status: "PASS" | "FAIL";
  readonly countsAsPass: boolean;
  readonly metric: number;
  readonly threshold: number;
  readonly comparator: "lt" | "lte";
} {
  const pass = comparator === "lte" ? metric <= threshold : metric < threshold;
  return {
    status: pass ? "PASS" : "FAIL",
    countsAsPass: pass,
    metric,
    threshold,
    comparator,
  };
}

export function commandGate({
  id,
  title,
  command,
  cwd = process.cwd(),
  timeoutMs,
}: {
  readonly id: string;
  readonly title: string;
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}): GateResult {
  const started = new Date().toISOString();
  if (command.length === 0 || command[0]?.trim() === "") {
    return {
      id,
      title,
      status: "FAIL",
      countsAsPass: false,
      command: command.join(" "),
      started,
      finished: new Date().toISOString(),
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      error: "commandGate requires a non-empty argv command",
    };
  }
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  const errorCode = (result.error as { readonly code?: unknown } | undefined)?.code;
  const timedOut = result.error?.name === "TimeoutError" || errorCode === "ETIMEDOUT";
  const passed =
    result.status === 0 && result.signal === null && !timedOut && result.error === undefined;
  const commandText = command.join(" ");
  const failureReason = passed
    ? undefined
    : timedOut
      ? `command timed out: ${commandText}`
      : result.error !== undefined
        ? `command failed to start: ${result.error.message}`
        : `command exited ${result.status === null ? `with signal ${String(result.signal)}` : `with code ${String(result.status)}`}: ${commandText}`;
  const gate: GateResult = {
    id,
    title,
    status: passed ? "PASS" : timedOut ? "BLOCKED" : "FAIL",
    countsAsPass: passed,
    command: commandText,
    started,
    finished: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error === undefined ? null : result.error.message,
  };
  return failureReason === undefined ? gate : { ...gate, reason: failureReason };
}

export function ownerGatedGate({
  id,
  title,
  commandEnv,
  allowEnv = "KEEL_PHASE2A_ALLOW_PAID",
}: {
  readonly id: string;
  readonly title: string;
  readonly commandEnv: string;
  readonly allowEnv?: string;
}): GateResult {
  const allowed = process.env[allowEnv] === "1";
  const rawCommand = process.env[commandEnv];
  if (!allowed || rawCommand === undefined || rawCommand.trim() === "") {
    return {
      id,
      title,
      status: "NOT_RUN",
      countsAsPass: false,
      reason: `${title} is owner/budget gated; set ${allowEnv}=1 and ${commandEnv} to run.`,
    };
  }
  try {
    return commandGate({ id, title, command: parseCommandEnvValue(rawCommand) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id,
      title,
      status: "FAIL",
      countsAsPass: false,
      command: rawCommand,
      error: `${commandEnv} must be a space-separated command or JSON argv array: ${message}`,
    };
  }
}

export function environmentGatedGate({
  id,
  title,
  commandEnv,
  allowEnv,
  reason,
}: {
  readonly id: string;
  readonly title: string;
  readonly commandEnv: string;
  readonly allowEnv: string;
  readonly reason: string;
}): GateResult {
  const allowed = process.env[allowEnv] === "1";
  const rawCommand = process.env[commandEnv];
  if (!allowed || rawCommand === undefined || rawCommand.trim() === "") {
    return {
      id,
      title,
      status: "BLOCKED",
      countsAsPass: false,
      reason: `${reason} Set ${allowEnv}=1 and ${commandEnv} to run a current external evidence command.`,
    };
  }
  try {
    return commandGate({ id, title, command: parseCommandEnvValue(rawCommand) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id,
      title,
      status: "FAIL",
      countsAsPass: false,
      command: rawCommand,
      error: `${commandEnv} must be a space-separated command or JSON argv array: ${message}`,
    };
  }
}

export function blockedGate({
  id,
  title,
  reason,
}: {
  readonly id: string;
  readonly title: string;
  readonly reason: string;
}): GateResult {
  return { id, title, status: "BLOCKED", countsAsPass: false, reason };
}

export function summarizeGates(gates: readonly GateResult[]): GateSummary {
  const nonPassing = gates.filter((gate) => gate.countsAsPass !== true);
  let status: GateSummary["status"] = "PASS";
  if (nonPassing.some((gate) => gate.status === "FAIL")) status = "FAIL";
  else if (nonPassing.length > 0) status = "BLOCKED";
  return {
    status,
    countsAsPass: status === "PASS",
    total: gates.length,
    passed: gates.filter((gate) => gate.countsAsPass === true).length,
    nonPassing: nonPassing.map((gate) => ({
      id: gate.id,
      status: gate.status,
      reason: gate.reason ?? gate.error ?? null,
    })),
  };
}

export function renderMarkdown(bundle: GateBundle): string {
  const cell = (value: string): string =>
    value.replaceAll("|", "\\|").replaceAll("\r\n", "<br>").replaceAll("\n", "<br>");
  const lines = [
    "# Epic 2.17b Phase-2A gate run",
    "",
    `Overall status: ${bundle.summary.status}.`,
    "",
    `- SHA: \`${bundle.sha}\``,
    `- Host: ${bundle.host.platform} ${bundle.host.arch}, Node \`${bundle.host.node}\``,
    `- Generated: ${bundle.generatedAt}`,
    "",
    "| Gate | Status | Counts as pass | Notes |",
    "|---|---|---:|---|",
  ];
  for (const gate of bundle.gates) {
    const note = gate.reason ?? gate.error ?? gate.command ?? "";
    lines.push(
      `| ${cell(gate.title)} | ${gate.status} | ${gate.countsAsPass ? "yes" : "no"} | ${cell(note)} |`,
    );
  }
  lines.push("");
  lines.push(
    bundle.summary.status === "PASS"
      ? "This run closes the measured Phase-2A gate set."
      : "This run does not close the Phase-2A gate.",
  );
  return `${lines.join("\n")}\n`;
}

export function writeGateArtifacts(outDir: string, bundle: GateBundle): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "phase2a-gates.json"), `${JSON.stringify(bundle, null, 2)}\n`);
  writeFileSync(join(outDir, "phase2a-gates.md"), renderMarkdown(bundle));
}
