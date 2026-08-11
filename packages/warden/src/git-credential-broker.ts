import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";

const BROKER_VERSION = "git-credential-broker/v1" as const;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024;
const MAX_CONFIGURATION_BYTES = 64 * 1024;
const MAX_HELPERS = 8;
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
}

export interface GitCredentialBrokerOptions {
  readonly gitExecutable: string;
  readonly tempRoot: string;
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

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exactFileDigest(path: string): string {
  const canonical = realpathSync(path);
  const stat = statSync(canonical, { bigint: true });
  if (!stat.isFile()) throw new GitCredentialBrokerError("Git executable is not an ordinary file");
  return sha256(
    [canonical, stat.dev, stat.ino, stat.size, stat.mtimeNs]
      .map((part) => String(part))
      .join("\u0000"),
  );
}

function exactDirectoryDigest(path: string): string {
  const canonical = realpathSync(path);
  const stat = statSync(canonical, { bigint: true });
  if (!stat.isDirectory()) {
    throw new GitCredentialBrokerError("Git credential helper exec path is not a directory");
  }
  return sha256(
    [canonical, stat.dev, stat.ino, stat.mode, stat.mtimeNs]
      .map((part) => String(part))
      .join("\u0000"),
  );
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

function parseHelperRecords(
  output: string,
): readonly { readonly key: string; readonly value: string }[] {
  if (output === "" || !output.endsWith("\u0000")) {
    throw new GitCredentialBrokerError("no operator Git credential helper is configured");
  }
  const records = output
    .slice(0, -1)
    .split("\u0000")
    .map((record) => {
      const newline = record.indexOf("\n");
      if (newline <= 0 || record.indexOf("\n", newline + 1) !== -1) {
        throw new GitCredentialBrokerError(
          "operator Git credential helper configuration is malformed",
        );
      }
      const key = record.slice(0, newline);
      const value = record.slice(newline + 1);
      if (
        !/^credential(?:\..+)?\.helper$/iu.test(key) ||
        Buffer.byteLength(key, "utf8") > 512 ||
        Buffer.byteLength(value, "utf8") > 2_048 ||
        (value !== "" && !/^[\x20-\x7e]+$/u.test(value))
      ) {
        throw new GitCredentialBrokerError(
          "operator Git credential helper configuration is malformed",
        );
      }
      return { key, value };
    });
  const helperCount = records.filter((record) => record.value !== "").length;
  if (helperCount < 1 || helperCount > MAX_HELPERS) {
    throw new GitCredentialBrokerError("operator Git credential helper count is outside the bound");
  }
  return records;
}

function parseGitExecPath(output: string): string {
  if (!output.endsWith("\n") || output.includes("\r") || output.includes("\u0000")) {
    throw new GitCredentialBrokerError("Git credential helper exec path is malformed");
  }
  const path = output.slice(0, -1);
  if (!path.startsWith("/") || path.includes("\n") || Buffer.byteLength(path, "utf8") > 1_024) {
    throw new GitCredentialBrokerError("Git credential helper exec path is malformed");
  }
  return realpathSync(path);
}

function executableOnPath(name: string, searchPath: string): string | undefined {
  if (name.startsWith("/")) return existsSync(name) ? realpathSync(name) : undefined;
  for (const directory of searchPath.split(":")) {
    if (!directory.startsWith("/")) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return undefined;
}

function helperExecutableDigests(
  helpers: readonly { readonly key: string; readonly value: string }[],
  gitExecPath: string,
  searchPath: string,
): readonly string[] {
  const identities = new Set<string>();
  if (existsSync("/bin/sh")) identities.add(exactFileDigest("/bin/sh"));
  identities.add(exactDirectoryDigest(gitExecPath));
  for (const helper of helpers) {
    if (helper.value === "") continue;
    const shellSnippet = helper.value.startsWith("!");
    const command = shellSnippet ? helper.value.slice(1).trimStart() : helper.value;
    const firstToken = /^([^\s"'\\]+)(?:\s|$)/u.exec(command)?.[1];
    if (firstToken === undefined) continue;
    const executable = shellSnippet
      ? executableOnPath(firstToken, searchPath)
      : firstToken.startsWith("/")
        ? executableOnPath(firstToken, searchPath)
        : executableOnPath(`git-credential-${firstToken}`, `${gitExecPath}:${searchPath}`);
    if (executable !== undefined) identities.add(exactFileDigest(executable));
  }
  return [...identities].sort();
}

function safeOperatorEnv(input: NodeJS.ProcessEnv, brokerRoot: string): Record<string, string> {
  const env: Record<string, string> = {};
  const allowed = new Set([
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TERM",
    "USER",
    "XDG_CONFIG_HOME",
  ]);
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && (allowed.has(key) || key.startsWith("LC_"))) env[key] = value;
  }
  env["PATH"] = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  env["LANG"] = env["LANG"] ?? "C";
  env["LC_ALL"] = "C";
  env["TMPDIR"] = brokerRoot;
  env["GIT_TERMINAL_PROMPT"] = "0";
  env["GIT_ASKPASS"] = "/usr/bin/false";
  env["SSH_ASKPASS"] = "/usr/bin/false";
  env["GCM_INTERACTIVE"] = "never";
  env["GIT_CEILING_DIRECTORIES"] = brokerRoot;
  env["GIT_DISCOVERY_ACROSS_FILESYSTEM"] = "0";
  env["GIT_TRACE"] = "0";
  env["GIT_TRACE_PACKET"] = "0";
  env["GIT_TRACE_CURL"] = "0";
  env["GIT_CURL_VERBOSE"] = "0";
  return env;
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
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
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
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
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

/** Construct the parent-side, system/global-only ADR-0091 credential authority. */
export function createGitCredentialBroker(
  options: GitCredentialBrokerOptions,
): GitCredentialBroker {
  const gitExecutable = realpathSync(options.gitExecutable);
  const tempRoot = realpathSync(options.tempRoot);
  const rootStat = statSync(tempRoot);
  if (!rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0) {
    throw new GitCredentialBrokerError("credential broker temporary root must be owner-only");
  }
  const brokerRoot = join(tempRoot, "git-credential-broker");
  mkdirSync(brokerRoot, { recursive: true, mode: 0o700 });
  chmodSync(brokerRoot, 0o700);
  const env = safeOperatorEnv(options.env ?? process.env, brokerRoot);
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
    argv: readonly string[],
    stdin: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<GitCredentialProcessResult> =>
    await runProcess({
      command: gitExecutable,
      argv,
      cwd: brokerRoot,
      env,
      stdin,
      timeoutMs,
      maxOutputBytes: limit,
      ...(signal === undefined ? {} : { signal }),
    });

  const inspect = async (context: GitCredentialContext): Promise<GitCredentialBrokerIdentity> => {
    validateContext(context);
    const configuration = checkedResult(
      await invoke(
        ["config", "--null", "--show-origin", "--show-scope", "--list"],
        "",
        MAX_CONFIGURATION_BYTES,
      ),
      "configuration",
    );
    const helperOutput = checkedResult(
      await invoke(
        ["config", "--null", "--get-regexp", "^credential(\\..*)?\\.helper$"],
        "",
        maxOutputBytes,
      ),
      "helpers",
      true,
    );
    const helpers = parseHelperRecords(helperOutput);
    const gitExecPath = parseGitExecPath(
      checkedResult(await invoke(["--exec-path"], "", maxOutputBytes), "executable"),
    );
    const executableDigests = helperExecutableDigests(helpers, gitExecPath, env["PATH"]!);
    return {
      version: BROKER_VERSION,
      gitExecutableDigest: exactFileDigest(gitExecutable),
      configurationDigest: sha256(configuration),
      helperDigest: sha256(
        `${helperOutput}\u0000${gitExecPath}\u0000${executableDigests.join("\u0000")}`,
      ),
      helperCount: helpers.filter((helper) => helper.value !== "").length,
    };
  };

  return {
    sourceClass: "operator Git credential helper (system/global config)",
    inspect,
    async resolve(context, expectedIdentity, signal) {
      if (resolving) {
        throw new GitCredentialBrokerError("Git credential resolution is already in progress");
      }
      resolving = true;
      try {
        const currentIdentity = await inspect(context);
        if (!identityEqual(currentIdentity, expectedIdentity)) {
          throw new GitCredentialBrokerError("Git credential helper identity changed after review");
        }
        const stdin = `protocol=https\nhost=${context.host}\npath=${context.path}\n\n`;
        const output = checkedResult(
          await invoke(
            ["-c", "credential.useHttpPath=true", "credential", "fill"],
            stdin,
            maxOutputBytes,
            signal,
          ),
          "resolution",
        );
        const credential = parseGitCredentialOutput(output, context);
        return {
          scheme: "Basic",
          secret: Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString(
            "base64",
          ),
        };
      } finally {
        resolving = false;
      }
    },
  };
}
