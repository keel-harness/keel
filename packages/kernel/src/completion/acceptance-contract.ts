import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { PreStopCheck, PreStopCheckResult } from "../prestop-check.js";
import { redactText } from "../secrets/redact.js";
import type { ProcessLease } from "../tools/process-lease.js";

export type AcceptanceContractSource =
  | "composite"
  | "operator-config"
  | "task-metadata"
  | "lifecycle-manifest"
  | "package-script"
  | "prompt-explicit-path"
  | "service/process-lease"
  | "model-authored-path"
  | "project-authored-script"
  | "none";

export type AcceptanceConfidence = "explicit" | "high" | "advisory";

export interface RequiredArtifactContract {
  readonly path: string;
  readonly source: AcceptanceContractSource;
  readonly confidence: AcceptanceConfidence;
  readonly provenance?: string;
}

export type AcceptanceCommandPurpose = "verification" | "liveness";

export interface RequiredCommandContract {
  readonly check: PreStopCheck;
  readonly source: AcceptanceContractSource;
  readonly confidence: AcceptanceConfidence;
  readonly provenance?: string;
  readonly purpose: AcceptanceCommandPurpose;
  readonly coversConfigurations?: readonly string[];
  /** Set for content-producing decisive checks where an exit code alone is not meaningful evidence.
   *  Leave unset for trusted exit-status-only checks such as `test -s artifact`. */
  readonly requireNonEmptyOutput?: boolean;
}

export interface AcceptanceContract {
  readonly source: AcceptanceContractSource;
  readonly confidence: AcceptanceConfidence;
  readonly provenance: string;
  readonly claimedConfigurations?: readonly string[];
  readonly requiredArtifacts?: readonly RequiredArtifactContract[];
  readonly requiredCommands?: readonly RequiredCommandContract[];
}

export interface ArtifactReadResult {
  readonly exists: boolean;
  readonly content?: string;
  readonly tooLarge?: boolean;
  readonly unreadableReason?: string;
}

export type ArtifactReader = (path: string) => Promise<ArtifactReadResult> | ArtifactReadResult;

export type AcceptanceCommandRunner = (
  check: PreStopCheck,
  signal?: AbortSignal,
) => Promise<PreStopCheckResult> | PreStopCheckResult;

export interface ArtifactReaderForRootOptions {
  readonly beforeOpen?: (path: string) => Promise<void> | void;
}

export type AcceptanceIssueKind =
  | "required-artifact-missing"
  | "required-artifact-empty"
  | "required-artifact-placeholder"
  | "required-artifact-too-large"
  | "required-artifact-unreadable"
  | "artifact-path-denied"
  | "artifact-source-denied"
  | "acceptance-contract-too-many-artifacts"
  | "advisory-artifact-not-checked"
  | "acceptance-command-failed"
  | "acceptance-command-not-run"
  | "acceptance-command-source-denied"
  | "acceptance-contract-too-many-commands"
  | "advisory-command-not-checked"
  | "claimed-configuration-not-run"
  | "acceptance-contract-too-many-configurations";

export interface AcceptanceIssue {
  readonly kind: AcceptanceIssueKind;
  readonly path: string;
  readonly source: AcceptanceContractSource;
  readonly confidence: AcceptanceConfidence;
  readonly detail: string;
}

export interface AcceptanceEvaluation {
  readonly ok: boolean;
  readonly blocking: readonly AcceptanceIssue[];
  readonly warnings: readonly AcceptanceIssue[];
  readonly receiptStatus: AcceptanceReceiptStatus;
}

export type AcceptanceReceiptStatus = "VERIFIED" | "FAILED" | "NOT_RUN";

const OPERATOR_CONFIG_PROVENANCE = "operator supplied KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS";
const OPERATOR_PRESTOP_PROVENANCE = "operator supplied KEEL_PRESTOP_CHECK_CMD";
const MAX_ARTIFACT_BYTES = 64 * 1024;
const MAX_ARTIFACT_PATH_CHARS = 512;
const MAX_COMMAND_CHARS = 2_000;
const MAX_REQUIRED_ARTIFACTS = 32;
const MAX_REQUIRED_COMMANDS = 8;
const MAX_CLAIMED_CONFIGURATIONS = 32;
const MAX_CONFIGURATION_LABEL_CHARS = 160;
const DEFAULT_ARTIFACT_READ_TIMEOUT_MS = 3_000;
const NOFOLLOW_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const PLACEHOLDER_PATTERN = /^(todo\b.*|tbd\b.*|stub\b.*|placeholder\b.*|replace me|n\/a|none)$/iu;

function isDeniedEvidenceSource(artifact: RequiredArtifactContract): boolean {
  return (
    artifact.source === "model-authored-path" ||
    artifact.source === "project-authored-script" ||
    artifact.source === "package-script" ||
    artifact.source === "none" ||
    looksHiddenGraderPath(artifact.path)
  );
}

function isDeniedCommandSource(command: RequiredCommandContract): boolean {
  return (
    command.source === "model-authored-path" ||
    command.source === "project-authored-script" ||
    command.source === "package-script" ||
    command.source === "none" ||
    looksHiddenGraderPath(command.check.command)
  );
}

function looksHiddenGraderPath(path: string): boolean {
  const normalized = path.replace(/\\/gu, "/").toLowerCase();
  const segments = normalized.split("/");
  return (
    segments.includes("hidden") ||
    segments.includes(".hidden") ||
    normalized === "hidden" ||
    normalized === ".hidden" ||
    normalized.startsWith("hidden/") ||
    normalized.startsWith(".hidden/") ||
    normalized.includes("/hidden/") ||
    normalized.includes("/.hidden/") ||
    normalized.includes("/tests/hidden") ||
    normalized.includes("/test/hidden") ||
    normalized.includes("hidden_grader") ||
    normalized.includes("hidden-grader")
  );
}

function looksGlobLike(path: string): boolean {
  return /[*?[\]{}]/u.test(path);
}

function hasControlCharacter(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function hasParentTraversal(path: string): boolean {
  return path.replace(/\\/gu, "/").split("/").includes("..");
}

function oneLine(value: string, maxChars: number): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 1)}...`;
}

function safePathLabel(path: string): string {
  return redactText(oneLine(path, 240));
}

function safeCommandLabel(command: string): string {
  return redactText(oneLine(command, 240));
}

function configurationKey(configuration: string): string {
  return configuration.replace(/\s+/gu, " ").trim();
}

function safeConfigurationLabel(configuration: string): string {
  const key = configurationKey(configuration);
  return key.length > 0
    ? redactText(oneLine(key, MAX_CONFIGURATION_LABEL_CHARS))
    : "[empty configuration]";
}

function uniqueConfigurationKeys(configurations: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const configuration of configurations) {
    const key = configurationKey(configuration);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  return unique;
}

function deniedPathDetail(path: string): string | undefined {
  if (path.length === 0) return "artifact path is empty";
  if (path.length > MAX_ARTIFACT_PATH_CHARS) return "artifact path is too long";
  if (hasControlCharacter(path)) return "artifact path contains control characters";
  if (looksGlobLike(path)) return "artifact path must be an exact path, not a glob";
  if (isAbsolute(path)) return "artifact path must be relative to the task workspace";
  if (hasParentTraversal(path)) return "artifact path must stay inside the task workspace";
  return undefined;
}

function deniedCommandDetail(command: string): string | undefined {
  if (command.trim().length === 0) return "acceptance command is empty";
  if (command.length > MAX_COMMAND_CHARS) return "acceptance command is too long";
  if (hasControlCharacter(command)) return "acceptance command contains control characters";
  return undefined;
}

function issue(
  artifact: RequiredArtifactContract,
  kind: AcceptanceIssueKind,
  detail: string,
): AcceptanceIssue {
  return {
    kind,
    path: artifact.path,
    source: artifact.source,
    confidence: artifact.confidence,
    detail,
  };
}

function commandIssue(
  command: RequiredCommandContract,
  kind: AcceptanceIssueKind,
  detail: string,
): AcceptanceIssue {
  return {
    kind,
    path: command.check.command,
    source: command.source,
    confidence: command.confidence,
    detail,
  };
}

async function defaultArtifactReader(path: string): Promise<ArtifactReadResult> {
  try {
    return await readRegularFileByHandle(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      return { exists: true, unreadableReason: "symbolic link artifacts are not accepted" };
    }
    return { exists: true, unreadableReason: "artifact could not be read" };
  }
}

function pathIsWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

export function artifactReaderForRoot(
  root: string,
  opts: ArtifactReaderForRootOptions = {},
): ArtifactReader {
  return async (path: string) => {
    if (isAbsolute(path)) {
      return {
        exists: false,
        unreadableReason: "absolute artifact paths are outside the workspace",
      };
    }
    if (hasParentTraversal(path)) {
      return { exists: false, unreadableReason: "artifact path is outside the workspace" };
    }
    const resolvedRoot = resolve(root);
    const resolved = resolve(resolvedRoot, path);
    if (!pathIsWithinRoot(resolvedRoot, resolved)) {
      return { exists: false, unreadableReason: "artifact path is outside the workspace" };
    }
    try {
      const realRoot = await realpath(resolvedRoot);
      const realArtifact = await realpath(resolved);
      if (!pathIsWithinRoot(realRoot, realArtifact)) {
        return { exists: true, unreadableReason: "artifact real path is outside the workspace" };
      }
      const expectedStat = await stat(realArtifact);
      if (!expectedStat.isFile()) {
        return { exists: true, unreadableReason: "required artifact is not a regular file" };
      }
      return await readRegularFileByHandle(resolved, {
        realRoot,
        expectedIdentity: { dev: expectedStat.dev, ino: expectedStat.ino },
        ...(opts.beforeOpen === undefined ? {} : { beforeOpen: opts.beforeOpen }),
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
      if ((err as NodeJS.ErrnoException).code === "ELOOP") {
        return { exists: true, unreadableReason: "symbolic link artifacts are not accepted" };
      }
      return { exists: true, unreadableReason: "artifact could not be read" };
    }
  };
}

async function realpathForOpenFile(handle: FileHandle): Promise<string | undefined> {
  for (const fdPath of [`/proc/self/fd/${String(handle.fd)}`, `/dev/fd/${String(handle.fd)}`]) {
    try {
      return await realpath(fdPath);
    } catch {
      // Try the next platform fd path.
    }
  }
  return undefined;
}

async function readRegularFileByHandle(
  path: string,
  opts: {
    readonly realRoot?: string;
    readonly expectedIdentity?: { readonly dev: number; readonly ino: number };
    readonly beforeOpen?: (path: string) => Promise<void> | void;
  } = {},
): Promise<ArtifactReadResult> {
  await opts.beforeOpen?.(path);
  const handle = await open(path, NOFOLLOW_OPEN_FLAGS);
  try {
    const openedStat = await handle.stat();
    if (
      opts.expectedIdentity !== undefined &&
      (openedStat.dev !== opts.expectedIdentity.dev || openedStat.ino !== opts.expectedIdentity.ino)
    ) {
      return { exists: true, unreadableReason: "artifact changed while opening" };
    }
    if (opts.realRoot !== undefined) {
      const realOpenedFile = await realpathForOpenFile(handle);
      if (
        realOpenedFile !== undefined &&
        !realOpenedFile.startsWith("/dev/fd/") &&
        !pathIsWithinRoot(opts.realRoot, realOpenedFile)
      ) {
        return { exists: true, unreadableReason: "artifact real path is outside the workspace" };
      }
    }
    return await readOpenedRegularFileBounded(handle, openedStat);
  } finally {
    await handle.close();
  }
}

async function readOpenedRegularFileBounded(
  handle: FileHandle,
  openedStat?: Awaited<ReturnType<FileHandle["stat"]>>,
): Promise<ArtifactReadResult> {
  const fileStat = openedStat ?? (await handle.stat());
  if (!fileStat.isFile()) {
    return { exists: true, unreadableReason: "required artifact is not a regular file" };
  }
  if (fileStat.size > MAX_ARTIFACT_BYTES) {
    return { exists: true, tooLarge: true };
  }
  const buffer = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  if (bytesRead > MAX_ARTIFACT_BYTES) {
    return { exists: true, tooLarge: true };
  }
  return { exists: true, content: buffer.subarray(0, bytesRead).toString("utf8") };
}

function isPlaceholderContent(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length > 256) return false;
  return PLACEHOLDER_PATTERN.test(trimmed);
}

function commandFailureDetail(
  command: RequiredCommandContract,
  result: PreStopCheckResult,
): string {
  const status = result.timedOut
    ? command.check.timeoutMs === undefined
      ? "timed out"
      : `timed out after ${String(command.check.timeoutMs)}ms`
    : result.exitCode !== null
      ? `exit code ${String(result.exitCode)}`
      : result.signal !== null
        ? `signal ${result.signal}`
        : "failed before exit";
  const truncation = result.truncated ? " (output truncated)" : "";
  const output = result.output.trim().length > 0 ? oneLine(result.output, 500) : "(no output)";
  return `acceptance ${command.purpose} command returned ${status}${truncation}; output: ${output}`;
}

function commandUnavailableDetail(
  command: RequiredCommandContract,
  result: PreStopCheckResult,
): string | undefined {
  const exitUnavailable = result.exitCode === 126 || result.exitCode === 127;
  const output = result.output.toLowerCase();
  const shellLaunchUnavailable =
    exitUnavailable &&
    (/(?:^|\n)(?:\/bin\/)?(?:sh|bash|zsh|dash):(?:\s*line\s+\d+:)?\s*[^:\n]+:\s*(?:command not found|not found|permission denied|cannot execute|not executable|no such file or directory)\b/u.test(
      output,
    ) ||
      /(?:^|\n)env:\s*[^:\n]+:\s*(?:no such file|permission denied)\b/u.test(output) ||
      /(?:^|\n)(?:\/bin\/)?(?:sh|bash|zsh|dash):.*\bbad interpreter\b.*\bno such file\b/u.test(
        output,
      ) ||
      /(?:^|\n)'?[^'\r\n]+'?\s+is not recognized as\b/u.test(output));
  if (!shellLaunchUnavailable) return undefined;
  const status =
    result.exitCode !== null
      ? `exit code ${String(result.exitCode)}`
      : result.signal !== null
        ? `signal ${result.signal}`
        : "failed before exit";
  const truncation = result.truncated ? " (output truncated)" : "";
  const outputLabel = result.output.trim().length > 0 ? oneLine(result.output, 500) : "(no output)";
  return `acceptance ${command.purpose} command was unavailable in the fresh verifier context (${status})${truncation}; output: ${outputLabel}`;
}

function isNotRunIssue(issue: AcceptanceIssue): boolean {
  return (
    issue.kind === "artifact-path-denied" ||
    issue.kind === "artifact-source-denied" ||
    issue.kind === "acceptance-command-not-run" ||
    issue.kind === "acceptance-command-source-denied" ||
    issue.kind === "acceptance-contract-too-many-commands" ||
    issue.kind === "claimed-configuration-not-run" ||
    issue.kind === "acceptance-contract-too-many-configurations"
  );
}

export function hasAuthoritativeAcceptanceEvidence(contract: AcceptanceContract): boolean {
  if (contract.confidence === "advisory") return false;
  const artifacts = contract.requiredArtifacts ?? [];
  const commands = contract.requiredCommands ?? [];
  return (
    artifacts.some(
      (artifact) => artifact.confidence !== "advisory" && !isDeniedEvidenceSource(artifact),
    ) ||
    commands.some((command) => command.confidence !== "advisory" && !isDeniedCommandSource(command))
  );
}

function receiptStatusFor(
  contract: AcceptanceContract,
  blocking: readonly AcceptanceIssue[],
  warnings: readonly AcceptanceIssue[],
): AcceptanceReceiptStatus {
  if (blocking.some(isNotRunIssue)) return "NOT_RUN";
  if (blocking.length > 0) return "FAILED";
  if (hasAuthoritativeAcceptanceEvidence(contract)) return "VERIFIED";
  if (warnings.length > 0) return "NOT_RUN";
  return "NOT_RUN";
}

function finishEvaluation(
  contract: AcceptanceContract,
  blocking: readonly AcceptanceIssue[],
  warnings: readonly AcceptanceIssue[],
): AcceptanceEvaluation {
  return {
    ok: blocking.length === 0,
    blocking,
    warnings,
    receiptStatus: receiptStatusFor(contract, blocking, warnings),
  };
}

async function readArtifactBounded(
  readArtifact: ArtifactReader,
  path: string,
  opts: { readonly signal?: AbortSignal; readonly timeoutMs: number },
): Promise<ArtifactReadResult> {
  if (opts.signal?.aborted === true) {
    return { exists: true, unreadableReason: "artifact read was aborted" };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  let timedOut = false;
  const read = Promise.resolve().then(() => readArtifact(path));
  const timeout = new Promise<ArtifactReadResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve({
        exists: true,
        unreadableReason: `artifact read exceeded ${String(opts.timeoutMs)}ms`,
      });
    }, opts.timeoutMs);
    timer.unref?.();
  });
  const abort =
    opts.signal === undefined
      ? undefined
      : new Promise<ArtifactReadResult>((resolve) => {
          const onAbort = (): void =>
            resolve({ exists: true, unreadableReason: "artifact read was aborted" });
          opts.signal?.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = (): void => opts.signal?.removeEventListener("abort", onAbort);
        });
  try {
    return await Promise.race(abort === undefined ? [read, timeout] : [read, timeout, abort]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener?.();
    if (timedOut) read.catch(() => {});
  }
}

export async function evaluateAcceptanceContract(
  contract: AcceptanceContract,
  opts: {
    readonly readArtifact?: ArtifactReader;
    readonly runCommand?: AcceptanceCommandRunner;
    readonly readTimeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<AcceptanceEvaluation> {
  const readArtifact = opts.readArtifact ?? defaultArtifactReader;
  const readTimeoutMs = opts.readTimeoutMs ?? DEFAULT_ARTIFACT_READ_TIMEOUT_MS;
  const blocking: AcceptanceIssue[] = [];
  const warnings: AcceptanceIssue[] = [];
  const artifacts = contract.requiredArtifacts ?? [];
  const commands = contract.requiredCommands ?? [];
  const claimedConfigurations = uniqueConfigurationKeys(contract.claimedConfigurations ?? []);
  const coveredConfigurations = uniqueConfigurationKeys(
    commands.flatMap((command) => command.coversConfigurations ?? []),
  );
  if (artifacts.length > MAX_REQUIRED_ARTIFACTS) {
    blocking.push({
      kind: "acceptance-contract-too-many-artifacts",
      path: "[acceptance contract]",
      source: contract.source,
      confidence: contract.confidence,
      detail: `acceptance contract has too many required artifacts; maximum is ${String(
        MAX_REQUIRED_ARTIFACTS,
      )}`,
    });
    return finishEvaluation(contract, blocking, warnings);
  }
  if (commands.length > MAX_REQUIRED_COMMANDS) {
    blocking.push({
      kind: "acceptance-contract-too-many-commands",
      path: "[acceptance contract]",
      source: contract.source,
      confidence: contract.confidence,
      detail: `acceptance contract has too many required commands; maximum is ${String(
        MAX_REQUIRED_COMMANDS,
      )}`,
    });
    return finishEvaluation(contract, blocking, warnings);
  }
  if (claimedConfigurations.length > MAX_CLAIMED_CONFIGURATIONS) {
    blocking.push({
      kind: "acceptance-contract-too-many-configurations",
      path: "[acceptance contract]",
      source: contract.source,
      confidence: contract.confidence,
      detail: `acceptance contract has too many claimed configurations; maximum is ${String(
        MAX_CLAIMED_CONFIGURATIONS,
      )}`,
    });
    return finishEvaluation(contract, blocking, warnings);
  }
  if (coveredConfigurations.length > MAX_CLAIMED_CONFIGURATIONS) {
    blocking.push({
      kind: "acceptance-contract-too-many-configurations",
      path: "[acceptance contract]",
      source: contract.source,
      confidence: contract.confidence,
      detail: `acceptance contract has too many covered configurations; maximum is ${String(
        MAX_CLAIMED_CONFIGURATIONS,
      )}`,
    });
    return finishEvaluation(contract, blocking, warnings);
  }
  for (const artifact of artifacts) {
    if (isDeniedEvidenceSource(artifact)) {
      blocking.push(
        issue(
          artifact,
          "artifact-source-denied",
          "artifact source is model/project-controlled or hidden-grader-looking",
        ),
      );
      continue;
    }
    const pathDenied = deniedPathDetail(artifact.path);
    if (pathDenied !== undefined) {
      blocking.push(issue(artifact, "artifact-path-denied", pathDenied));
      continue;
    }
    if (artifact.confidence === "advisory") {
      warnings.push(
        issue(
          artifact,
          "advisory-artifact-not-checked",
          "advisory artifact evidence is not authoritative completion proof",
        ),
      );
      continue;
    }
    let result: ArtifactReadResult;
    try {
      result = await readArtifactBounded(readArtifact, artifact.path, {
        timeoutMs: readTimeoutMs,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
    } catch (err) {
      blocking.push(
        issue(
          artifact,
          "required-artifact-unreadable",
          `required artifact could not be read: ${oneLine(
            redactText(err instanceof Error ? err.message : String(err)),
            160,
          )}`,
        ),
      );
      continue;
    }
    if (!result.exists) {
      blocking.push(issue(artifact, "required-artifact-missing", "required artifact is missing"));
      continue;
    }
    if (result.tooLarge === true) {
      blocking.push(
        issue(artifact, "required-artifact-too-large", "required artifact is too large to inspect"),
      );
      continue;
    }
    if (result.unreadableReason !== undefined) {
      blocking.push(issue(artifact, "required-artifact-unreadable", result.unreadableReason));
      continue;
    }
    const content = result.content ?? "";
    if (content.length === 0 || content.trim().length === 0) {
      blocking.push(issue(artifact, "required-artifact-empty", "required artifact is empty"));
      continue;
    }
    if (isPlaceholderContent(content)) {
      blocking.push(
        issue(artifact, "required-artifact-placeholder", "required artifact is a placeholder"),
      );
    }
  }
  if (blocking.length > 0) {
    return finishEvaluation(contract, blocking, warnings);
  }
  const verifiedConfigurations = new Set<string>();
  for (const command of commands) {
    if (isDeniedCommandSource(command)) {
      blocking.push(
        commandIssue(
          command,
          "acceptance-command-source-denied",
          "acceptance command source is model/project-controlled or hidden-grader-looking",
        ),
      );
      continue;
    }
    const commandDenied = deniedCommandDetail(command.check.command);
    if (commandDenied !== undefined) {
      blocking.push(commandIssue(command, "acceptance-command-not-run", commandDenied));
      continue;
    }
    if (command.confidence === "advisory") {
      warnings.push(
        commandIssue(
          command,
          "advisory-command-not-checked",
          "advisory command evidence is not authoritative completion proof",
        ),
      );
      continue;
    }
    if (opts.runCommand === undefined) {
      blocking.push(
        commandIssue(
          command,
          "acceptance-command-not-run",
          "acceptance command runner is unavailable in this verifier context",
        ),
      );
      continue;
    }
    let result: PreStopCheckResult;
    try {
      result = await opts.runCommand(command.check, opts.signal);
    } catch (err) {
      blocking.push(
        commandIssue(
          command,
          "acceptance-command-not-run",
          `acceptance command could not be run: ${oneLine(
            redactText(err instanceof Error ? err.message : String(err)),
            160,
          )}`,
        ),
      );
      continue;
    }
    if (!result.ok) {
      const unavailableDetail = commandUnavailableDetail(command, result);
      blocking.push(
        commandIssue(
          command,
          unavailableDetail === undefined
            ? "acceptance-command-failed"
            : "acceptance-command-not-run",
          unavailableDetail ?? commandFailureDetail(command, result),
        ),
      );
      continue;
    }
    if (command.requireNonEmptyOutput === true && result.output.trim().length === 0) {
      blocking.push(
        commandIssue(
          command,
          "acceptance-command-failed",
          `acceptance ${command.purpose} command succeeded but produced no output; this contract requires non-empty verifier output`,
        ),
      );
      continue;
    }
    if (command.purpose === "verification") {
      for (const configuration of command.coversConfigurations ?? []) {
        const key = configurationKey(configuration);
        if (key.length > 0) verifiedConfigurations.add(key);
      }
    }
  }
  if (blocking.length === 0) {
    for (const configuration of claimedConfigurations) {
      if (configuration.length === 0 || !verifiedConfigurations.has(configuration)) {
        blocking.push({
          kind: "claimed-configuration-not-run",
          path: safeConfigurationLabel(configuration),
          source: contract.source,
          confidence: contract.confidence,
          detail:
            "claimed configuration was not covered by a successful authoritative acceptance command",
        });
      }
    }
  }
  return finishEvaluation(contract, blocking, warnings);
}

export function requiredArtifactsFromEnv(value: string | undefined): RequiredArtifactContract[] {
  if (value === undefined || value.trim() === "") return [];
  const paths = value
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (paths.length > MAX_REQUIRED_ARTIFACTS) {
    throw new Error(
      `KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS accepts at most ${String(
        MAX_REQUIRED_ARTIFACTS,
      )} artifact paths`,
    );
  }
  return paths.map((path) => {
    if (looksGlobLike(path)) {
      throw new Error(
        `KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS accepts exact paths, not globs: ${safePathLabel(path)}`,
      );
    }
    if (looksHiddenGraderPath(path)) {
      throw new Error(
        `KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS cannot point at hidden grader paths: ${safePathLabel(
          path,
        )}`,
      );
    }
    const pathDenied = deniedPathDetail(path);
    if (pathDenied !== undefined) {
      throw new Error(
        `KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS accepts only safe relative workspace paths (${pathDenied}): ${safePathLabel(
          path,
        )}`,
      );
    }
    return {
      path,
      source: "operator-config",
      confidence: "explicit",
      provenance: OPERATOR_CONFIG_PROVENANCE,
    };
  });
}

export function acceptanceContractFromRequiredArtifacts(
  artifacts: readonly RequiredArtifactContract[],
): AcceptanceContract | undefined {
  if (artifacts.length === 0) return undefined;
  return {
    source: "operator-config",
    confidence: "explicit",
    provenance: OPERATOR_CONFIG_PROVENANCE,
    requiredArtifacts: artifacts,
  };
}

export function acceptanceContractFromPreStopCheck(check: PreStopCheck): AcceptanceContract {
  return {
    source: "operator-config",
    confidence: "explicit",
    provenance: OPERATOR_PRESTOP_PROVENANCE,
    requiredCommands: [
      {
        check,
        source: "operator-config",
        confidence: "explicit",
        provenance: OPERATOR_PRESTOP_PROVENANCE,
        purpose: "verification",
      },
    ],
  };
}

export function acceptanceContractFromProcessLeases(
  leases: readonly ProcessLease[],
  opts: { readonly cwd?: string } = {},
): AcceptanceContract | undefined {
  const includedLeaseIds: string[] = [];
  const commands = leases.flatMap((lease): RequiredCommandContract[] => {
    const command =
      lease.kind === "service"
        ? (lease.healthCommand ?? lease.statusCommand)
        : (lease.statusCommand ?? lease.healthCommand);
    if (command === undefined) return [];
    includedLeaseIds.push(lease.id);
    return [
      {
        check: { command, ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }) },
        source: "service/process-lease",
        confidence: "advisory",
        provenance: `process lease ${lease.id} ${lease.kind} ${
          lease.kind === "service" ? "health" : "status"
        } command (model-supplied; advisory only)`,
        purpose: "liveness",
      },
    ];
  });
  if (commands.length === 0) return undefined;
  return {
    source: "service/process-lease",
    confidence: "advisory",
    provenance: `process lease liveness probes are model-supplied advisory hints: ${includedLeaseIds.join(
      ", ",
    )}`,
    requiredCommands: commands,
  };
}

export function mergeAcceptanceContracts(
  first: AcceptanceContract | undefined,
  second: AcceptanceContract | undefined,
): AcceptanceContract | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return {
    source: first.source === second.source && first.source !== "none" ? first.source : "composite",
    confidence:
      first.confidence === "advisory" && second.confidence === "advisory" ? "advisory" : "explicit",
    provenance: `${first.provenance}; ${second.provenance}`,
    claimedConfigurations: uniqueConfigurationKeys([
      ...(first.claimedConfigurations ?? []),
      ...(second.claimedConfigurations ?? []),
    ]),
    requiredArtifacts: [...(first.requiredArtifacts ?? []), ...(second.requiredArtifacts ?? [])],
    requiredCommands: [...(first.requiredCommands ?? []), ...(second.requiredCommands ?? [])],
  };
}

export function renderAcceptanceFailurePrompt(
  contract: AcceptanceContract,
  evaluation: AcceptanceEvaluation,
): string {
  const isDeniedEvidenceIssue = (item: AcceptanceIssue): boolean =>
    item.kind === "artifact-source-denied" ||
    item.kind === "artifact-path-denied" ||
    item.kind === "acceptance-command-source-denied";
  const issues = evaluation.blocking.slice(0, 8).map((item) => {
    const label = isDeniedEvidenceIssue(item)
      ? "[denied evidence omitted]"
      : item.kind.startsWith("acceptance-command")
        ? safeCommandLabel(item.path)
        : safePathLabel(item.path);
    const detail = isDeniedEvidenceIssue(item)
      ? "denied evidence cannot be used as completion evidence"
      : item.detail;
    return `- ${label}: ${detail} (${item.source}, ${item.confidence})`;
  });
  const more =
    evaluation.blocking.length > issues.length
      ? [`- ... ${String(evaluation.blocking.length - issues.length)} more issue(s)`]
      : [];
  const hasDeniedEvidence = evaluation.blocking.some(isDeniedEvidenceIssue);
  const hasClaimedConfigurationNotRun = evaluation.blocking.some(
    (item) => item.kind === "claimed-configuration-not-run",
  );
  const hasNotRun = evaluation.receiptStatus === "NOT_RUN";
  const nextStep = hasDeniedEvidence
    ? "Denied evidence cannot be used as completion evidence. Use visible operator-approved artifacts or commands, or report blocked if none exist."
    : hasClaimedConfigurationNotRun
      ? "Run or add an operator-approved acceptance command covering each claimed configuration, or report blocked/downgrade the claim; do not count unrun configurations as verified."
      : hasNotRun
        ? "Provision the required fresh verifier context or use visible operator-approved evidence; do not count NOT_RUN checks as passing."
        : "Create or fix the required visible artifact(s), command(s), or liveness target(s), then stop again.";
  return [
    "Acceptance contract failed.",
    `Receipt: ${evaluation.receiptStatus}`,
    `Source: ${contract.source} (${contract.confidence})`,
    `Provenance: ${
      hasDeniedEvidence ? "[denied evidence omitted]" : oneLine(contract.provenance, 240)
    }`,
    "Blocking evidence:",
    ...issues,
    ...more,
    nextStep,
    "Artifact existence or command success does not prove semantic correctness; it only satisfies the explicit completion contract.",
  ]
    .map((line) => redactText(line))
    .join("\n");
}
