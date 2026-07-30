import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, readSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactText } from "./secrets/redact.js";
import { minimalChildEnv } from "./tools/child-env.js";

export const DEFAULT_PRESTOP_CHECK_TIMEOUT_MS = 120_000;
export const MAX_PRESTOP_CHECK_TIMEOUT_MS = 600_000;
export const DEFAULT_PRESTOP_CHECK_MAX_OUTPUT_BYTES = 16_384;
export const MAX_PRESTOP_CHECK_MAX_OUTPUT_BYTES = 65_536;

export interface PreStopCheck {
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface PreStopCheckResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly output: string;
  readonly truncated: boolean;
}

export type PreStopCheckRunner = (
  check: PreStopCheck,
  signal?: AbortSignal,
) => Promise<PreStopCheckResult>;

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

function killProcess(childPid: number): void {
  try {
    process.kill(-childPid, "SIGKILL");
    return;
    /* c8 ignore next 3 -- best-effort platform fallback when process-group kill is unavailable. */
  } catch {
    // Fall through to killing the immediate child; the process may already be gone or the platform may
    // not support negative process-group pids.
  }
  /* c8 ignore next 6 -- best-effort fallback for platforms/races where process-group kill is unavailable. */
  try {
    process.kill(childPid, "SIGKILL");
  } catch {
    // Best-effort cleanup only.
  }
}

function readBoundedFile(path: string, maxBytes: number): { output: Buffer; truncated: boolean } {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    const bytesRead = readSync(fd, bytes, 0, bytes.byteLength, 0);
    return {
      output: bytes.subarray(0, Math.min(bytesRead, maxBytes)),
      truncated: bytesRead > maxBytes,
    };
  } catch {
    return { output: Buffer.alloc(0), truncated: false };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
        /* c8 ignore next 3 -- best-effort cleanup only; close races are not deterministic to force. */
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

function unlinkOptional(path: string): void {
  try {
    unlinkSync(path);
    /* c8 ignore next 3 -- best-effort cleanup only; the file may already be gone in platform races. */
  } catch {
    // Best-effort cleanup only.
  }
}

function rmOptional(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
    /* c8 ignore next 3 -- best-effort cleanup only; directory removal races are not deterministic. */
  } catch {
    // Best-effort cleanup only.
  }
}

export async function runFreshPreStopCheck(
  check: PreStopCheck,
  signal?: AbortSignal,
): Promise<PreStopCheckResult> {
  const command = check.command.trim();
  const timeoutMs = clampPositiveInt(
    check.timeoutMs,
    DEFAULT_PRESTOP_CHECK_TIMEOUT_MS,
    MAX_PRESTOP_CHECK_TIMEOUT_MS,
  );
  const maxOutputBytes = clampPositiveInt(
    check.maxOutputBytes,
    DEFAULT_PRESTOP_CHECK_MAX_OUTPUT_BYTES,
    MAX_PRESTOP_CHECK_MAX_OUTPUT_BYTES,
  );

  if (command.length === 0) {
    return {
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      output: "empty pre-stop check command",
      truncated: false,
    };
  }
  if (signal?.aborted === true) {
    return {
      ok: false,
      exitCode: null,
      signal: "ABORT_ERR",
      timedOut: false,
      output: "pre-stop check aborted before launch",
      truncated: false,
    };
  }

  return await new Promise<PreStopCheckResult>((resolve) => {
    let output: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const outputDir = mkdtempSync(join(tmpdir(), "keel-prestop-"));
    const outputPath = join(outputDir, "output.log");
    let outputFd: number | undefined;
    try {
      outputFd = openSync(
        outputPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      /* c8 ignore next 3 -- defensive fallback; temp-file creation failures are platform/race dependent. */
    } catch {
      // Fall back to ignored stdio below; the check still reports the true subprocess status.
    }

    /* c8 ignore next 6 -- Windows-only stdio capture path; POSIX uses the owned output file. */
    const appendOutput = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxOutputBytes - output.byteLength;
      if (remaining > 0) output = Buffer.concat([output, bytes.subarray(0, remaining)]);
      if (bytes.byteLength > remaining) truncated = true;
    };

    /* c8 ignore next 4 -- Windows-only stdio path plus temp-file-open fallback; POSIX owned-file capture is covered. */
    const stdio: StdioOptions =
      process.platform === "win32"
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", outputFd ?? "ignore", outputFd ?? "ignore"];

    const spawnOptions: SpawnOptions = {
      cwd: check.cwd,
      /* c8 ignore next -- Windows-only spawn option; POSIX detached process group is covered. */
      detached: process.platform !== "win32",
      env: { ...minimalChildEnv(), ...(check.env ?? {}) },
      /* c8 ignore next -- Windows-only spawn option; POSIX /bin/bash path is covered. */
      shell: process.platform === "win32" ? true : "/bin/bash",
      stdio,
    };
    const child: ChildProcess = spawn(command, spawnOptions);
    if (outputFd !== undefined) {
      try {
        closeSync(outputFd);
        outputFd = undefined;
        /* c8 ignore next 3 -- best-effort cleanup only; close races are not deterministic to force. */
      } catch {
        outputFd = undefined;
      }
    }

    const finish = (result: PreStopCheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      /* c8 ignore next 8 -- normally closed immediately after spawn; this is best-effort cleanup for close races. */
      if (outputFd !== undefined) {
        try {
          closeSync(outputFd);
        } catch {
          // Best-effort cleanup only.
        }
      }
      unlinkOptional(outputPath);
      rmOptional(outputDir);
      resolve(result);
    };

    const abort = (): void => {
      if (child.pid !== undefined) killProcess(child.pid);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killProcess(child.pid);
    }, timeoutMs);
    timer.unref();

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.on("error", (err: Error) => {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut,
        output: redactText(err.message),
        truncated,
      });
    });
    child.on("close", (code: number | null, closeSignal: NodeJS.Signals | null) => {
      const fileResult =
        /* c8 ignore next 2 -- Windows-only stdio capture path; POSIX reads the owned output file. */
        process.platform === "win32"
          ? { output, truncated }
          : readBoundedFile(outputPath, maxOutputBytes);
      output = fileResult.output;
      truncated = truncated || fileResult.truncated;
      const text = redactText(output.toString("utf8"));
      finish({
        ok: !timedOut && code === 0,
        exitCode: code,
        signal: closeSignal,
        timedOut,
        output: text,
        truncated,
      });
    });
  });
}

function oneLine(value: string, maxChars: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 1)}...`;
}

export function renderPreStopFailurePrompt(
  check: PreStopCheck,
  result: PreStopCheckResult,
): string {
  const timeoutMs = clampPositiveInt(
    check.timeoutMs,
    DEFAULT_PRESTOP_CHECK_TIMEOUT_MS,
    MAX_PRESTOP_CHECK_TIMEOUT_MS,
  );
  const status = result.timedOut
    ? `timed out after ${String(timeoutMs)}ms`
    : result.exitCode !== null
      ? `exit code ${String(result.exitCode)}`
      : result.signal !== null
        ? `signal ${result.signal}`
        : "failed before exit";
  const signal =
    result.signal !== null && !status.includes(result.signal) ? `; signal ${result.signal}` : "";
  const truncation = result.truncated ? " (output truncated)" : "";
  const redactedOutput = redactText(result.output).trimEnd();
  const output = redactedOutput.length > 0 ? redactedOutput : "(no output)";

  return [
    "Fresh pre-stop verification failed in a clean subprocess.",
    `Command: ${oneLine(check.command, 500)}`,
    `Result: ${status}${signal}${truncation}`,
    "Observed output:",
    output,
    "Fix the observed failure using the normal tools, rerun only what is needed, then stop.",
    "Do not rely on shell-local state that will not exist in a fresh verifier process.",
  ].join("\n");
}
