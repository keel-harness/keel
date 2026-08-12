import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import {
  GitCredentialAuthorityError,
  inspectGitCredentialHelperAuthority,
  prepareGitCredentialAuthority,
  resolveGitCredentialExecPath,
  type GitCredentialHelperAuthoritySnapshot,
} from "./git-credential-authority.js";

const BROKER_VERSION = "git-credential-broker/v1" as const;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024;
const MAX_CONFIGURATION_BYTES = 64 * 1024;
const UNSAFE_VALUE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export interface GitCredentialContext {
  readonly protocol: "https";
  readonly host: string;
  /** Canonical repository path without a leading slash. */
  readonly path: string;
}

export interface ParsedGitCredential {
  readonly username: string;
  readonly password: string;
}

export interface GitCredentialAuthorization {
  readonly scheme: "Basic";
  readonly secret: string;
}

export interface GitCredentialBearerAuthorization {
  readonly scheme: "Bearer";
  readonly secret: string;
}

export interface GitCredentialBrokerIdentity {
  readonly version: typeof BROKER_VERSION;
  readonly gitExecutableDigest: string;
  readonly configurationDigest: string;
  readonly helperDigest: string;
  readonly helperCount: number;
}

export interface GitCredentialProcessRequest {
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface GitCredentialProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  /** Exact retained stdout bytes for security-sensitive NUL framing. */
  readonly stdoutBytes?: Buffer;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputExceeded: boolean;
}

export type GitCredentialProcessRunner = (
  request: GitCredentialProcessRequest,
) => Promise<GitCredentialProcessResult>;

export interface GitCredentialBroker {
  readonly sourceClass: "operator Git credential helper (system/global config)";
  inspect(context: GitCredentialContext): Promise<GitCredentialBrokerIdentity>;
  resolve(
    context: GitCredentialContext,
    expectedIdentity: GitCredentialBrokerIdentity,
    signal?: AbortSignal,
  ): Promise<GitCredentialAuthorization>;
  resolveBearer?(
    context: GitCredentialContext,
    expectedIdentity: GitCredentialBrokerIdentity,
    signal?: AbortSignal,
  ): Promise<GitCredentialBearerAuthorization>;
}

export interface GitCredentialBrokerOptions {
  readonly gitExecutable: string;
  readonly tempRoot: string;
  readonly workspaceRoot: string;
  readonly denyRoots: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly runProcess?: GitCredentialProcessRunner;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export class GitCredentialBrokerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCredentialBrokerError";
  }
}

function validateContext(context: GitCredentialContext): void {
  const hostLabels = context.host.split(".");
  if (
    context.protocol !== "https" ||
    context.host.length > 253 ||
    isIP(context.host) !== 0 ||
    hostLabels.some(
      (label) => label === "" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
    ) ||
    context.path === "" ||
    context.path.startsWith("/") ||
    Buffer.byteLength(context.path, "utf8") > 384 ||
    !/^[A-Za-z0-9._~/-]+$/u.test(context.path) ||
    context.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new GitCredentialBrokerError("credential context is not one canonical HTTPS repository");
  }
}

/** Parse one bounded Git credential-protocol response without normalization or partial acceptance. */
export function parseGitCredentialOutput(
  output: string,
  expected: GitCredentialContext,
): ParsedGitCredential {
  validateContext(expected);
  if (Buffer.byteLength(output, "utf8") > DEFAULT_MAX_OUTPUT_BYTES) {
    throw new GitCredentialBrokerError("Git credential output exceeded its output bound");
  }
  if (!output.endsWith("\n") || output.includes("\r") || output.includes("\u0000")) {
    throw new GitCredentialBrokerError("Git credential output framing is malformed");
  }
  const lines = output.slice(0, -1).split("\n");
  const allowed = new Set(["protocol", "host", "path", "username", "password"]);
  const fields = new Map<string, string>();
  for (const line of lines) {
    const equals = line.indexOf("=");
    if (equals <= 0) throw new GitCredentialBrokerError("Git credential output is malformed");
    const key = line.slice(0, equals);
    const value = line.slice(equals + 1);
    if (!allowed.has(key) || fields.has(key)) {
      throw new GitCredentialBrokerError("Git credential output keys are not exact");
    }
    if (UNSAFE_VALUE.test(value)) {
      throw new GitCredentialBrokerError("Git credential output contains an unsafe value");
    }
    fields.set(key, value);
  }
  if (fields.size !== allowed.size) {
    throw new GitCredentialBrokerError("Git credential output is incomplete");
  }
  if (
    fields.get("protocol") !== expected.protocol ||
    fields.get("host") !== expected.host ||
    fields.get("path") !== expected.path
  ) {
    throw new GitCredentialBrokerError("Git credential output context does not match the request");
  }
  const username = fields.get("username")!;
  const password = fields.get("password")!;
  if (
    username === "" ||
    username.includes(":") ||
    password === "" ||
    Buffer.byteLength(username, "utf8") > 256 ||
    Buffer.byteLength(password, "utf8") > 4_096
  ) {
    throw new GitCredentialBrokerError("Git credential output is missing bounded credentials");
  }
  return { username, password };
}

function terminateProcess(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid, "SIGKILL");
    else process.kill(-pid, "SIGKILL");
  } catch {
    // The process may have exited between the bound firing and the kill.
  }
}

async function defaultRunProcess(
  request: GitCredentialProcessRequest,
): Promise<GitCredentialProcessResult> {
  return await new Promise((resolve) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let outputExceeded = false;
    let stdinFailed = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      const exactStdout = Buffer.concat(stdout);
      resolve({
        exitCode,
        stdout: exactStdout.toString("utf8"),
        stdoutBytes: exactStdout,
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputExceeded,
      });
    };
    const onAbort = (): void => terminateProcess(child?.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcess(child?.pid);
    }, request.timeoutMs);
    timer.unref();
    try {
      child = spawn(request.command, [...request.argv], {
        cwd: request.cwd,
        env: { ...request.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch {
      finish(null);
      return;
    }
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      terminateProcess(child.pid);
      finish(null);
      return;
    }
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const retain = (chunks: Buffer[], chunk: Buffer, current: number): number => {
      const next = current + chunk.length;
      if (next <= request.maxOutputBytes) chunks.push(chunk);
      else {
        outputExceeded = true;
        terminateProcess(child.pid);
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = retain(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = retain(stderr, chunk, stderrBytes);
    });
    child.stdin.once("error", () => {
      // A timeout/abort can close the child's read end before Node flushes stdin, which emits EPIPE
      // asynchronously on Linux. Keep the listener installed for empty-input inspection commands as
      // well, and fail closed for the credential-bearing fill request only after the child group has
      // been signalled and its close event proves reap completion.
      if (request.stdin === "") return;
      stdinFailed = true;
      terminateProcess(child.pid);
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(stdinFailed ? null : code));
    child.stdin.end(request.stdin);
    if (request.signal?.aborted === true) onAbort();
  });
}

function identityEqual(
  left: GitCredentialBrokerIdentity,
  right: GitCredentialBrokerIdentity,
): boolean {
  return (
    left.version === right.version &&
    left.gitExecutableDigest === right.gitExecutableDigest &&
    left.configurationDigest === right.configurationDigest &&
    left.helperDigest === right.helperDigest &&
    left.helperCount === right.helperCount
  );
}

function checkedResult(
  result: GitCredentialProcessResult,
  phase: "configuration" | "executable" | "helpers" | "resolution",
  allowMissingHelpers = false,
): string {
  if (result.timedOut) throw new GitCredentialBrokerError(`Git credential ${phase} timed out`);
  if (result.outputExceeded) {
    throw new GitCredentialBrokerError(`Git credential ${phase} exceeded its output bound`);
  }
  if (
    (result.exitCode !== 0 && !(allowMissingHelpers && result.exitCode === 1)) ||
    result.stderr !== ""
  ) {
    throw new GitCredentialBrokerError(`Git credential ${phase} failed`);
  }
  return result.stdout;
}

function checkedBytes(
  result: GitCredentialProcessResult,
  phase: "configuration" | "executable",
): Buffer {
  checkedResult(result, phase);
  return result.stdoutBytes ?? Buffer.from(result.stdout, "utf8");
}

/** Construct the parent-side, system/global-only ADR-0091 credential authority. */
export function createGitCredentialBroker(
  options: GitCredentialBrokerOptions,
): GitCredentialBroker & {
  resolveBearer: NonNullable<GitCredentialBroker["resolveBearer"]>;
} {
  const tempRoot = realpathSync(options.tempRoot);
  const rootStat = statSync(tempRoot);
  if (!rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0) {
    throw new GitCredentialBrokerError("credential broker temporary root must be owner-only");
  }
  const brokerRoot = join(tempRoot, "git-credential-broker");
  mkdirSync(brokerRoot, { recursive: true, mode: 0o700 });
  chmodSync(brokerRoot, 0o700);
  const envSource = options.env ?? process.env;
  const runProcess = options.runProcess ?? defaultRunProcess;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS) {
    throw new GitCredentialBrokerError("credential broker timeout is outside the bound");
  }
  if (
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > DEFAULT_MAX_OUTPUT_BYTES
  ) {
    throw new GitCredentialBrokerError("credential broker output limit is outside the bound");
  }
  let resolving = false;

  const invoke = async (
    command: string,
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
    stdin: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<GitCredentialProcessResult> =>
    await runProcess({
      command,
      argv,
      cwd: brokerRoot,
      env,
      stdin,
      timeoutMs,
      maxOutputBytes: limit,
      ...(signal === undefined ? {} : { signal }),
    });

  const buildInspection = async (
    context: GitCredentialContext,
  ): Promise<{
    readonly identity: GitCredentialBrokerIdentity;
    readonly snapshot: GitCredentialHelperAuthoritySnapshot;
    readonly gitExecutable: string;
  }> => {
    validateContext(context);
    try {
      const base = prepareGitCredentialAuthority({
        gitExecutable: options.gitExecutable,
        inspectionCwd: brokerRoot,
        temporaryRoot: brokerRoot,
        workspaceRoot: options.workspaceRoot,
        denyRoots: options.denyRoots,
        env: envSource,
      });
      const gitExecPath = resolveGitCredentialExecPath(
        base,
        checkedBytes(
          await invoke(
            base.gitExecutable.canonicalPath,
            ["--exec-path"],
            base.inspectionEnv,
            "",
            maxOutputBytes,
          ),
          "executable",
        ),
      );
      const configuration = checkedBytes(
        await invoke(
          base.gitExecutable.canonicalPath,
          ["config", "--null", "--includes", "--show-origin", "--show-scope", "--list"],
          base.inspectionEnv,
          "",
          MAX_CONFIGURATION_BYTES,
        ),
        "configuration",
      );
      const snapshot = inspectGitCredentialHelperAuthority({
        base,
        gitExecPath,
        configurationOutput: configuration,
        context,
      });
      return {
        identity: {
          version: BROKER_VERSION,
          gitExecutableDigest: snapshot.gitExecutableDigest,
          configurationDigest: snapshot.configurationDigest,
          helperDigest: snapshot.helperDigest,
          helperCount: snapshot.helperCount,
        },
        snapshot,
        gitExecutable: base.gitExecutable.canonicalPath,
      };
    } catch (error) {
      if (error instanceof GitCredentialBrokerError) throw error;
      if (error instanceof GitCredentialAuthorityError) {
        throw new GitCredentialBrokerError(
          `Git credential helper authority is unavailable (${error.code})`,
        );
      }
      throw new GitCredentialBrokerError("Git credential helper authority inspection failed");
    }
  };

  const inspect = async (context: GitCredentialContext): Promise<GitCredentialBrokerIdentity> =>
    (await buildInspection(context)).identity;

  const resolveCredential = async (
    context: GitCredentialContext,
    expectedIdentity: GitCredentialBrokerIdentity,
    signal?: AbortSignal,
  ): Promise<ParsedGitCredential> => {
    if (resolving) {
      throw new GitCredentialBrokerError("Git credential resolution is already in progress");
    }
    resolving = true;
    try {
      const current = await buildInspection(context);
      if (!identityEqual(current.identity, expectedIdentity)) {
        throw new GitCredentialBrokerError("Git credential helper identity changed after review");
      }
      const stdin = `protocol=https\nhost=${context.host}\npath=${context.path}\n\n`;
      const output = checkedResult(
        await invoke(
          current.gitExecutable,
          [
            "-c",
            "credential.helper=",
            "-c",
            `credential.helper=${current.snapshot.helper.normalizedExecutionValue}`,
            "-c",
            "credential.useHttpPath=true",
            "credential",
            "fill",
          ],
          current.snapshot.fillEnv,
          stdin,
          maxOutputBytes,
          signal,
        ),
        "resolution",
      );
      return parseGitCredentialOutput(output, context);
    } finally {
      resolving = false;
    }
  };

  return {
    sourceClass: "operator Git credential helper (system/global config)",
    inspect,
    async resolve(context, expectedIdentity, signal) {
      const credential = await resolveCredential(context, expectedIdentity, signal);
      return {
        scheme: "Basic",
        secret: Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString(
          "base64",
        ),
      };
    },
    async resolveBearer(context, expectedIdentity, signal) {
      const credential = await resolveCredential(context, expectedIdentity, signal);
      return { scheme: "Bearer", secret: credential.password };
    },
  };
}
