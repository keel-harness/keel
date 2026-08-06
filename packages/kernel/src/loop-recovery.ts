import type { ToolInvocationT, ToolResultT } from "@keel/shared";
import { bashFullFileRewriteTarget } from "./loop-detection.js";
import { redactText } from "./secrets/redact.js";
import { isReadOnlyCommand } from "./verify-gate.js";
import { governedProcessEnvelope, processRunArgv, toolCommandIsReadOnly } from "./tool-command.js";

const MAX_EVIDENCE_CHARS = 1600;
const TRACEBACK_RE = /^Traceback \(most recent call last\):/m;
const FAILURE_LINE_RE =
  /\b(AssertionError|AttributeError|ModuleNotFoundError|FileNotFoundError|ImportError|TypeError|ValueError|RuntimeError|Exception)\b|^(FAILED|ERROR|FAIL)\b|^\s*assert\b/m;
const TEST_SUMMARY_PASS_RE = /^TEST SUMMARY \([^)]+\): PASS\b.*$/m;
const TEST_SUMMARY_FAIL_RE = /^TEST SUMMARY \([^)]+\): FAIL\b/m;
const PYTEST_SUMMARY_PASS_RE =
  /^=+\s+(?!.*\b\d+\s+(?:failed|error|errors)\b).*?\b([1-9]\d*)\s+passed\b.*?\bin\s+[\d.]+s.*?=+$/m;
const PYTEST_FAILURE_OUTPUT_RE =
  /\b\d+\s+(?:failed|error|errors)\b|^FAILED\b|^ERROR\b|^FAIL\b|\[exit code:\s*[1-9]\d*\]/m;

function truncateEvidence(value: string): string {
  const trimmed = redactText(value).trim();
  if (trimmed.length <= MAX_EVIDENCE_CHARS) return trimmed;
  return trimmed.slice(0, MAX_EVIDENCE_CHARS - 20).trimEnd() + "\n[truncated]";
}

function bashCommand(call: ToolInvocationT): string | undefined {
  if (call.name !== "bash") return undefined;
  const command = (call.args as { command?: unknown } | null | undefined)?.command;
  return typeof command === "string" ? command : undefined;
}

function excerptAround(output: string, index: number): string {
  const before = output.slice(0, index);
  const lineStart = Math.max(before.lastIndexOf("\n", Math.max(0, before.length - 300)), 0);
  return output.slice(lineStart, index + MAX_EVIDENCE_CHARS);
}

export function extractLoopFailureEvidence(
  result: Pick<ToolResultT, "ok" | "output">,
): string | undefined {
  if (!result.ok) return truncateEvidence(result.output);

  const traceback = TRACEBACK_RE.exec(result.output);
  if (traceback !== null) return truncateEvidence(result.output.slice(traceback.index));

  const failure = FAILURE_LINE_RE.exec(result.output);
  if (failure !== null) return truncateEvidence(excerptAround(result.output, failure.index));

  return undefined;
}

function commandCanCarryStrongSuccess(call: ToolInvocationT, mode: "pytest" | "banner"): boolean {
  const processArgv = processRunArgv(call);
  if (processArgv !== undefined) {
    if (toolCommandIsReadOnly(call) || processLooksInlineScript(processArgv)) return false;
    return processLooksLikeTestRun(processArgv, mode);
  }
  const command = bashCommand(call);
  if (command === undefined) return false;
  if (isReadOnlyCommand(command)) return false;
  if (commandLooksInlineScript(command)) return false;
  if (commandLooksCompound(command)) return false;

  if (mode === "pytest") return /\bpytest\b/.test(command);
  if (mode === "banner") return commandLooksLikeTestRun(command);
  return false;
}

function processLooksInlineScript(argv: readonly string[]): boolean {
  const executable = argv[0]!.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  return (
    (/^(?:python(?:\d+(?:\.\d+)?)?|node|ruby|perl|php)$/u.test(executable) &&
      ["-c", "-e"].includes(argv[1]?.toLowerCase() ?? "")) ||
    ((executable === "bash" || executable === "sh") && argv[1] === "-c")
  );
}

function processLooksLikeTestRun(argv: readonly string[], mode: "pytest" | "banner"): boolean {
  const lower = argv.map((arg) => arg.toLowerCase());
  const executable = lower[0]!.split(/[\\/]/u).at(-1) ?? "";
  const pytest =
    executable === "pytest" ||
    executable === "py.test" ||
    (/^python(?:\d+(?:\.\d+)?)?$/u.test(executable) &&
      lower[1] === "-m" &&
      (lower[2] === "pytest" || lower[2] === "py.test"));
  if (mode === "pytest") return pytest;
  return (
    pytest ||
    ["vitest", "jest"].includes(executable) ||
    (executable === "cargo" && lower[1] === "test") ||
    (executable === "go" && lower[1] === "test") ||
    (["npm", "pnpm", "yarn", "bun"].includes(executable) &&
      (lower[1] === "test" || (lower[1] === "run" && lower[2] === "test"))) ||
    (executable === "make" && lower.slice(1).includes("test"))
  );
}

function commandLooksInlineScript(command: string): boolean {
  return (
    /\b(?:python(?:\d(?:\.\d+)?)?|node|ruby|perl|php)\s+-[ce]\b/.test(command) ||
    /<<-?\s*['"]?[A-Za-z_]/.test(command)
  );
}

function commandLooksCompound(command: string): boolean {
  return /[;\n|]|&&|\|\|/.test(command);
}

function commandLooksLikeTestRun(command: string): boolean {
  return (
    /\bpytest\b/.test(command) ||
    /\b(vitest|jest)\b/.test(command) ||
    /\bcargo\s+test\b/.test(command) ||
    /\bgo\s+test\b/.test(command) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/.test(command) ||
    /\bmake\s+(?:\S+\s+)*test\b/.test(command)
  );
}

export function extractStrongSuccessEvidence(
  call: ToolInvocationT,
  result: Pick<ToolResultT, "ok" | "output">,
): string | undefined {
  if (!result.ok) return undefined;

  const processEnvelope =
    processRunArgv(call) === undefined ? undefined : governedProcessEnvelope(result.output);
  if (
    processRunArgv(call) !== undefined &&
    (processEnvelope === undefined ||
      !processEnvelope.cleanContained ||
      processEnvelope.exitCode !== 0 ||
      processEnvelope.signal !== null)
  ) {
    return undefined;
  }
  const output =
    processEnvelope === undefined
      ? result.output
      : `${processEnvelope.stdout}\n${processEnvelope.stderr}`;
  if (TEST_SUMMARY_FAIL_RE.test(output) || PYTEST_FAILURE_OUTPUT_RE.test(output)) {
    return undefined;
  }
  const banner = TEST_SUMMARY_PASS_RE.exec(output);
  if (banner !== null && commandCanCarryStrongSuccess(call, "banner")) {
    return truncateEvidence(banner[0]);
  }

  const pytest = PYTEST_SUMMARY_PASS_RE.exec(output);
  if (pytest !== null && commandCanCarryStrongSuccess(call, "pytest")) {
    return truncateEvidence(pytest[0]);
  }

  return undefined;
}

export function callSuggestsArtifactWrite(call: ToolInvocationT): boolean {
  if (call.name === "write" || call.name === "edit") return true;

  const command = bashCommand(call);
  if (command === undefined) return false;
  return bashFullFileRewriteTarget(command) !== undefined;
}

export function renderLoopRecoveryGuidance(input: {
  readonly baseGuidance: string;
  readonly failureEvidence?: string;
  readonly successEvidence?: string;
  readonly hasArtifactWrite: boolean;
}): string {
  const parts = [input.baseGuidance];

  if (input.successEvidence !== undefined) {
    parts.push(
      `Recent verification/success evidence:\n${input.successEvidence}\nIf the task requirements and required artifacts are complete, stop now instead of re-running the same check.`,
    );
  }

  if (input.failureEvidence !== undefined) {
    parts.push(`Recent failing evidence:\n${input.failureEvidence}`);
  }

  if (!input.hasArtifactWrite) {
    parts.push(
      "If the task requires an output artifact, produce your best current artifact now before doing more diagnosis.",
    );
  }

  return parts.join("\n\n");
}
