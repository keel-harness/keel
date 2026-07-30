import type { JsonObjectT } from "@keel/shared";

export type ProgressCommandClass =
  | "verifier"
  | "build"
  | "poll"
  | "idempotent"
  | "mutator"
  | "destructive"
  | "unknown";

export type ProgressSuccessSignal =
  | "silent_success"
  | "test_passed"
  | "build_passed"
  | "metric_improved";

export type ProgressNovelty = "observed" | "not_observed" | "unknown";

export interface ToolProgressEvidence {
  readonly commandClass: ProgressCommandClass;
  readonly patternSignature: string;
  readonly successSignal?: ProgressSuccessSignal;
  readonly benignRepeat: boolean;
}

export interface ToolProgressEvidenceOptions {
  readonly ok?: boolean;
  readonly durationMs?: number;
  readonly recoveryBoundaryId?: string;
  readonly workspaceNovelty?: boolean;
  readonly processNovelty?: boolean;
  readonly metricDelta?: number;
}

export interface ProgressLedgerEntry {
  readonly actionSignature: string;
  readonly patternSignature: string;
  readonly commandClass: ProgressCommandClass;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly stdoutHash: string;
  readonly stderrHash?: string;
  readonly errorFingerprint?: string;
  readonly successSignal?: ProgressSuccessSignal;
  readonly benignRepeat: boolean;
  readonly workspaceNovelty: ProgressNovelty;
  readonly processNovelty: ProgressNovelty;
  readonly metricDelta?: number;
  readonly recoveryBoundaryId?: string;
}

export class ProgressLedger {
  private readonly recorded: ProgressLedgerEntry[] = [];

  constructor(private readonly maxEntries = 64) {}

  record(
    call: { readonly name: string; readonly args: JsonObjectT },
    output: string,
    options: ToolProgressEvidenceOptions = {},
  ): ProgressLedgerEntry {
    const entry = buildProgressLedgerEntry(call, output, options);
    if (this.maxEntries > 0) {
      this.recorded.push(entry);
      if (this.recorded.length > this.maxEntries) this.recorded.shift();
    }
    return entry;
  }

  entries(): readonly ProgressLedgerEntry[] {
    return this.recorded;
  }

  clear(): void {
    this.recorded.length = 0;
  }
}

export function classifyToolCall(call: {
  readonly name: string;
  readonly args: JsonObjectT;
}): ProgressCommandClass {
  if (call.name !== "bash") return "unknown";
  const command = call.args["command"];
  return typeof command === "string" ? classifyBashCommand(command) : "unknown";
}

export function classifyBashCommand(command: string): ProgressCommandClass {
  const directNodeVerifier = isDirectNodeVerifierCommand(command.trim().toLowerCase());
  const normalized = normalizeCommand(command);
  if (normalized.length === 0) return "unknown";
  if (isDestructiveCommand(normalized)) return "destructive";
  if (isMutatorCommand(normalized)) return "mutator";
  if (isPollCommand(normalized)) return "poll";
  if (isIdempotentControlCommand(normalized)) return "idempotent";
  if (isVerifierCommand(normalized, directNodeVerifier)) return "verifier";
  if (isBuildCommand(normalized)) return "build";
  return "unknown";
}

export function progressEvidenceForToolResult(
  call: { readonly name: string; readonly args: JsonObjectT },
  output: string,
  options: ToolProgressEvidenceOptions = {},
): ToolProgressEvidence {
  const entry = buildProgressLedgerEntry(call, output, options);
  return {
    commandClass: entry.commandClass,
    patternSignature: entry.patternSignature,
    ...(entry.successSignal !== undefined ? { successSignal: entry.successSignal } : {}),
    benignRepeat: entry.benignRepeat,
  };
}

export function buildProgressLedgerEntry(
  call: { readonly name: string; readonly args: JsonObjectT },
  output: string,
  options: ToolProgressEvidenceOptions = {},
): ProgressLedgerEntry {
  const commandClass = classifyToolCall(call);
  const exitCode = parseExitCode(output, options.ok);
  const failure = options.ok === false || isFailureOutput(output, exitCode);
  const successSignal = failure
    ? undefined
    : successSignalFor(commandClass, output, exitCode, options.metricDelta);
  const benignRepeat =
    !failure &&
    successSignal === undefined &&
    (commandClass === "poll" || commandClass === "idempotent");
  const stdoutHash = shortHash(output);
  const errorFingerprint = failure ? failureFingerprint(output, exitCode) : undefined;
  const patternSignature = [
    commandClass,
    successSignal ?? "no-success",
    benignRepeat ? "benign-repeat" : "ordinary",
    errorFingerprint ?? stdoutHash,
  ].join(":");

  return {
    actionSignature: `${call.name}:${shortHash(stableStringify(call.args))}`,
    patternSignature,
    commandClass,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(options.durationMs !== undefined
      ? { durationMs: Math.max(0, Math.floor(options.durationMs)) }
      : {}),
    stdoutHash,
    ...(errorFingerprint !== undefined ? { errorFingerprint } : {}),
    ...(successSignal !== undefined ? { successSignal } : {}),
    benignRepeat,
    workspaceNovelty: novelty(options.workspaceNovelty),
    processNovelty: novelty(options.processNovelty),
    ...(options.metricDelta !== undefined ? { metricDelta: options.metricDelta } : {}),
    ...(options.recoveryBoundaryId !== undefined
      ? { recoveryBoundaryId: options.recoveryBoundaryId }
      : {}),
  };
}

function normalizeCommand(command: string): string {
  return command.toLowerCase().replace(/\s+/g, " ").trim();
}

function isVerifierCommand(command: string, directNodeVerifier: boolean): boolean {
  return (
    /\b(pytest|vitest|jest|mocha|tox|ctest|go test|cargo test|mvn test|gradle test)\b/.test(
      command,
    ) ||
    /\b(pnpm|npm|yarn)\s+(run\s+)?(test|lint|typecheck|check)\b/.test(command) ||
    /\b(ruff|mypy|tsc|eslint|prettier)\b/.test(command) ||
    /\bmake\s+(test|check|verify)\b/.test(command) ||
    directNodeVerifier
  );
}

function isDirectNodeVerifierCommand(command: string): boolean {
  // A compound shell expression can perform unrelated work after the test process. Keep this
  // classifier deliberately narrower than the executor/policy parser: it only decides whether an
  // observed exit-zero result may earn a bounded final-response turn.
  if (/[\r\n;&|<>`$()]/.test(command)) return false;
  if (/^node\s+--test(?:\s|$)/.test(command)) return true;

  const directScript = /^node\s+(["']?)([^\s"']+)\1(?:\s+.*)?$/.exec(command);
  if (directScript === null) return false;
  const path = directScript[2]!;
  const basename = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  return /^(?:tests?|.+\.(?:test|spec))\.[cm]?[jt]s$/.test(basename);
}

function isBuildCommand(command: string): boolean {
  return (
    /\b(make|ninja)\b/.test(command) ||
    /\b(cargo build|cmake --build|go build|mvn package|gradle build)\b/.test(command) ||
    /\b(pnpm|npm|yarn)\s+(run\s+)?build\b/.test(command) ||
    /\b(python|python3)\s+setup\.py\s+(build|build_ext|bdist_wheel)\b/.test(command)
  );
}

function isPollCommand(command: string): boolean {
  return (
    /^(ps|pgrep|jobs)\b/.test(command) ||
    /^tail\b(?=[^;&|]*(?:\s-f\b|\s--follow\b))/.test(command) ||
    /^john\b[^;&|]*\s--show\b/.test(command) ||
    /^hashcat\b[^;&|]*\s--show\b/.test(command) ||
    isSafeCurlPoll(command)
  );
}

function isIdempotentControlCommand(command: string): boolean {
  return (
    /\b(service|systemctl)\s+\S+\s+(status|reload)\b/.test(command) ||
    /\bpostfix\s+(status|reload)\b/.test(command) ||
    /\bmailman(?:ctl)?\s+(status|reload)\b/.test(command)
  );
}

function isMutatorCommand(command: string): boolean {
  return (
    /\b(pnpm|npm|yarn|pip|pip3|apt-get|apt|brew)\s+(install|add|update)\b/.test(command) ||
    /\bcurl\b[^;&|]*(?:\s-x\s*(post|put|patch|delete)\b|--request\s+(post|put|patch|delete)\b|\s-d\b|--data(?:-\w+)?\b|--form\b)/.test(
      command,
    )
  );
}

function isDestructiveCommand(command: string): boolean {
  return (
    /\brm\b(?=[^;&|]*\s-[a-z]*r)(?=[^;&|]*\s-[a-z]*f)/.test(command) ||
    /\bmkfs\b|\bdd\s+.*\bof=/.test(command) ||
    /(^|[;&|]\s*)(kill|pkill|killall)\b/.test(command)
  );
}

function isSafeCurlPoll(command: string): boolean {
  if (!/^curl\b/.test(command)) return false;
  if (!/\b(health|ready|status|metrics)\b/.test(command)) return false;
  if (
    /\bcurl\b[^;&|]*(?:\s-x\s*(post|put|patch|delete)\b|--request\s+(post|put|patch|delete)\b|\s-d\b|--data(?:-\w+)?\b|--form\b)/.test(
      command,
    )
  ) {
    return false;
  }
  return !/[;&|]/.test(command);
}

function successSignalFor(
  commandClass: ProgressCommandClass,
  output: string,
  exitCode: number | undefined,
  metricDelta: number | undefined,
): ProgressSuccessSignal | undefined {
  if (metricDelta !== undefined && metricDelta > 0) return "metric_improved";
  if (commandClass !== "verifier" && commandClass !== "build") return undefined;
  if (exitCode !== undefined && exitCode !== 0) return undefined;
  const text = output.toLowerCase();
  if (/\(command produced no output;\s*exit code 0\)/i.test(output)) return "silent_success";
  if (/\btest summary\b.*\bpass\b/i.test(output)) return "test_passed";
  if (/\b\d+\s+passed\b/.test(text) || /\b0\s+(failed|failures|errors?)\b/.test(text)) {
    return "test_passed";
  }
  if (/\bno\s+(failed|failures|errors?)\b/.test(text)) return "test_passed";
  // `result.ok` is executor-owned exit status, not model prose. Once the command itself is typed as a
  // verifier and failure-shaped output has been rejected, exit zero is sufficient evidence for the
  // tiny final-response grace window; it does not satisfy an acceptance contract or prove correctness.
  if (commandClass === "verifier" && exitCode === 0) return "test_passed";
  if (/\b(finished|built|compiled|build succeeded|successfully built)\b/.test(text)) {
    return "build_passed";
  }
  return undefined;
}

function parseExitCode(output: string, ok: boolean | undefined): number | undefined {
  const explicit = /^\[exit code:\s*(\d+)\]$/m.exec(output);
  if (explicit !== null) return Number.parseInt(explicit[1]!, 10);
  if (/\(command produced no output;\s*exit code 0\)/i.test(output)) return 0;
  if (ok === true) return 0;
  return undefined;
}

function isFailureOutput(output: string, exitCode: number | undefined): boolean {
  return (
    (exitCode !== undefined && exitCode !== 0) ||
    hasPositiveFailureCount(output) ||
    looksLikeFailure(removeZeroFailureCounts(output))
  );
}

function hasPositiveFailureCount(output: string): boolean {
  const text = output.toLowerCase();
  return (
    /\b[1-9]\d*\s+(failed|failures|errors?)\b/.test(text) ||
    /\b(failed|failures|errors?)\s*[:=]\s*[1-9]\d*\b/.test(text)
  );
}

function looksLikeFailure(output: string): boolean {
  return /\b(failed|failure|fail|error|traceback|assertionerror)\b/i.test(output);
}

function removeZeroFailureCounts(output: string): string {
  return output
    .toLowerCase()
    .replace(/\b0\s+(failed|failures|errors?)\b/g, "")
    .replace(/\bno\s+(failed|failures|errors?)\b/g, "");
}

function failureFingerprint(output: string, exitCode: number | undefined): string {
  const text = output.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 160);
  return `${exitCode !== undefined ? `exit-${String(exitCode)}` : "failure"}:${shortHash(text)}`;
}

function novelty(value: boolean | undefined): ProgressNovelty {
  if (value === true) return "observed";
  if (value === false) return "not_observed";
  return "unknown";
}

function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableStringify(value: JsonObjectT): string {
  const stringify = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(stringify).join(",")}]`;
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, child]) => `${JSON.stringify(k)}:${stringify(child)}`).join(",")}}`;
  };
  return stringify(value);
}
