import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readSandboxStatus, type SandboxProfile, type SandboxPort } from "./sandbox.js";
import { createWardenSandboxTempRoot } from "./sandbox-temp-root.js";
import {
  TypedToolDeniedError,
  TypedToolError,
  type PreparedLeafExpectation,
  type PreparedPathIdentity,
  type PreparedTypedMutation,
} from "./typed-tools.js";

const HELPER_STDERR_LIMIT = 2048;
const HELPER_FAILED_NO_MUTATION_EXIT_CODE = 41;
const HELPER_FAILED_MUTATION_POSSIBLE_EXIT_CODE = 42;
export const TYPED_MUTATION_MAX_PAYLOAD_BYTES = 1_048_576;
const HELPER_SOURCE = String.raw`
import { createHash, randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

const READ_MAX_FILE_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const FAILED_NO_MUTATION = ${String(HELPER_FAILED_NO_MUTATION_EXIT_CODE)};
const FAILED_MUTATION_POSSIBLE = ${String(HELPER_FAILED_MUTATION_POSSIBLE_EXIT_CODE)};
let mutationPossible = false;

function fail(message) {
  console.error(message);
  process.exit(mutationPossible ? FAILED_MUTATION_POSSIBLE : FAILED_NO_MUTATION);
}

function isInside(root, target) {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

function lstatOrUndefined(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function identity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameIdentity(stat, expected) {
  return String(stat.dev) === expected.dev && String(stat.ino) === expected.ino;
}

function assertDirectoryIdentity(path, expected, message) {
  const stat = lstatOrUndefined(path);
  if (
    stat === undefined ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    !sameIdentity(stat, expected)
  ) {
    throw new Error(message);
  }
  return stat;
}

function hashRegularFileNoFollow(path, expectedIdentity) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error("typed mutation no-follow identity is unavailable");
  }
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(opened, expectedIdentity)) {
      throw new Error("typed mutation no-follow target identity changed after preparation");
    }
    if (opened.size > BigInt(READ_MAX_FILE_BYTES)) {
      throw new Error("typed mutation target exceeds maximum size");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      total += bytes;
      if (total > READ_MAX_FILE_BYTES) {
        throw new Error("typed mutation target exceeds maximum size");
      }
      digest.update(buffer.subarray(0, bytes));
    }
    const current = lstatOrUndefined(path);
    if (
      current === undefined ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameIdentity(current, identity(opened))
    ) {
      throw new Error("typed mutation target identity changed while hashing");
    }
    return digest.digest("hex");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertStringRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("typed mutation request must be an object");
  }
  return value;
}

function assertExactKeys(record, expected, key) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    fail("typed mutation request has invalid " + key);
  }
}

function readPayloadBounded(fd) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const remaining = ${String(TYPED_MUTATION_MAX_PAYLOAD_BYTES + 1)} - total;
    const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, remaining));
    const bytes = readSync(fd, buffer, 0, buffer.length, null);
    if (bytes === 0) break;
    total += bytes;
    if (total > ${String(TYPED_MUTATION_MAX_PAYLOAD_BYTES)}) {
      fail("typed mutation request is invalid");
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytes)));
  }
  return Buffer.concat(chunks, total);
}

function stringField(record, key) {
  const value = record[key];
  if (typeof value !== "string" || value.includes("\u0000")) {
    fail("typed mutation request has invalid " + key);
  }
  return value;
}

function identityField(value, key) {
  const record = assertStringRecord(value);
  assertExactKeys(record, ["dev", "ino"], key);
  const dev = stringField(record, "dev");
  const ino = stringField(record, "ino");
  if (!/^\d+$/.test(dev) || !/^\d+$/.test(ino)) {
    fail("typed mutation request has invalid " + key);
  }
  return { dev, ino };
}

function identityArrayField(record, key) {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0) {
    fail("typed mutation request has invalid " + key);
  }
  return value.map((entry, index) => identityField(entry, key + "[" + String(index) + "]"));
}

function leafExpectationField(record) {
  const value = assertStringRecord(record.expectedLeaf);
  const state = stringField(value, "state");
  if (state === "absent") {
    assertExactKeys(value, ["state"], "expectedLeaf");
    return { state };
  }
  if (state !== "regular-file") fail("typed mutation request has invalid expectedLeaf state");
  assertExactKeys(value, ["state", "dev", "ino", "hash", "mode"], "expectedLeaf");
  const hash = stringField(value, "hash");
  const mode = value.mode;
  const dev = stringField(value, "dev");
  const ino = stringField(value, "ino");
  if (
    !/^\d+$/.test(dev) ||
    !/^\d+$/.test(ino) ||
    !/^[0-9a-f]{64}$/.test(hash) ||
    !Number.isInteger(mode) ||
    mode < 0 ||
    mode > 0o777
  ) {
    fail("typed mutation request has invalid expectedLeaf");
  }
  return {
    state,
    dev,
    ino,
    hash,
    mode,
  };
}

function parentSegments(root, lexical) {
  const rel = relative(root, dirname(lexical));
  if (rel === "") return [];
  if (rel === ".." || rel.startsWith(".." + sep)) {
    throw new Error("typed mutation target resolves outside workspace");
  }
  return rel.split(sep).filter((part) => part.length > 0);
}

function bindPreparedParents(realRoot, lexical, preparedIdentities) {
  const segments = parentSegments(realRoot, lexical);
  if (preparedIdentities.length > segments.length + 1) {
    throw new Error("typed mutation parent identity contract is invalid");
  }
  const stable = [];
  const rootExpected = preparedIdentities[0];
  if (rootExpected === undefined) {
    throw new Error("typed mutation parent identity contract is invalid");
  }
  assertDirectoryIdentity(realRoot, rootExpected, "typed mutation root changed after preparation");
  process.chdir(realRoot);
  const enteredRoot = lstatSync(".", { bigint: true });
  if (!sameIdentity(enteredRoot, rootExpected) || realpathSync(".") !== realRoot) {
    throw new Error("typed mutation root changed after preparation");
  }
  stable.push({ path: realRoot, expected: rootExpected });

  let current = realRoot;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    current = resolve(current, segment);
    const expected = preparedIdentities[index + 1];
    if (expected !== undefined) {
      assertDirectoryIdentity(
        segment,
        expected,
        "typed mutation parent changed after preparation",
      );
      stable.push({ path: current, expected });
      process.chdir(segment);
      const entered = lstatSync(".", { bigint: true });
      if (
        !sameIdentity(entered, expected) ||
        !isInside(realRoot, realpathSync("."))
      ) {
        throw new Error("typed mutation parent changed after preparation");
      }
      continue;
    }
    if (lstatOrUndefined(segment) !== undefined) {
      throw new Error("typed mutation parent changed after preparation");
    }
    mutationPossible = true;
    mkdirSync(segment);
    const created = lstatOrUndefined(segment);
    if (created === undefined || created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error("typed mutation parent identity is unsafe after creation");
    }
    const createdIdentity = identity(created);
    stable.push({ path: current, expected: createdIdentity });
    process.chdir(segment);
    const entered = lstatSync(".", { bigint: true });
    if (
      !sameIdentity(entered, createdIdentity) ||
      !isInside(realRoot, realpathSync("."))
    ) {
      throw new Error("typed mutation parent identity is unsafe after creation");
    }
  }
  return stable;
}

function assertStableParents(realRoot, stable) {
  for (const component of stable) {
    assertDirectoryIdentity(
      component.path,
      component.expected,
      "typed mutation parent changed after preparation",
    );
    const real = realpathSync(component.path);
    if (!isInside(realRoot, real)) {
      throw new Error("typed mutation parent escaped workspace");
    }
  }
  const parent = stable[stable.length - 1];
  const cwd = lstatSync(".", { bigint: true });
  if (!sameIdentity(cwd, parent.expected) || !isInside(realRoot, realpathSync("."))) {
    throw new Error("typed mutation parent changed after preparation");
  }
}

function verifyExpectedLeaf(targetName, expected) {
  const current = lstatOrUndefined(targetName);
  if (expected.state === "absent") {
    if (current !== undefined) throw new Error("typed mutation target changed after preparation");
    return;
  }
  if (
    current === undefined ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameIdentity(current, expected) ||
    Number(current.mode & 0o777n) !== expected.mode
  ) {
    throw new Error("typed mutation target changed after preparation");
  }
  if (hashRegularFileNoFollow(targetName, expected) !== expected.hash) {
    throw new Error("typed mutation target changed after preparation");
  }
}

function atomicWrite(
  realRoot,
  lexical,
  content,
  preparedIdentities,
  expectedLeaf,
  installedHash,
  installedMode,
) {
  const stableParents = bindPreparedParents(realRoot, lexical, preparedIdentities);
  assertStableParents(realRoot, stableParents);
  const targetName = basename(lexical);
  verifyExpectedLeaf(targetName, expectedLeaf);
  const tmpName = "." + targetName + "." + randomBytes(6).toString("hex") + ".tmp";
  let fd;
  let renamed = false;
  try {
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      throw new Error("typed mutation no-follow identity is unavailable");
    }
    fd = openSync(
      tmpName,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    mutationPossible = true;
    const openedTemp = fstatSync(fd, { bigint: true });
    if (!openedTemp.isFile()) throw new Error("typed mutation temporary file is unsafe");
    fchmodSync(fd, installedMode);
    writeFileSync(fd, content, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertStableParents(realRoot, stableParents);
    verifyExpectedLeaf(targetName, expectedLeaf);
    renameSync(tmpName, targetName);
    renamed = true;
    assertStableParents(realRoot, stableParents);
    const installed = lstatOrUndefined(targetName);
    if (
      installed === undefined ||
      installed.isSymbolicLink() ||
      !installed.isFile() ||
      Number(installed.mode & 0o777n) !== installedMode ||
      hashRegularFileNoFollow(targetName, identity(installed)) !== installedHash
    ) {
      throw new Error("typed mutation installed postimage verification failed");
    }
    const parentFd = openSync(".", fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      if (!sameIdentity(fstatSync(parentFd, { bigint: true }), stableParents[stableParents.length - 1].expected)) {
        throw new Error("typed mutation parent changed after replacement");
      }
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
    if (!renamed) {
      try {
        rmSync(tmpName, { force: true });
      } catch {}
    }
  }
}

try {
  const payloadPath = process.argv[2];
  if (typeof payloadPath !== "string" || payloadPath === "") fail("typed mutation payload path missing");
  let decodedRequest;
  let payloadFd;
  try {
    const payloadStat = lstatSync(payloadPath, { bigint: true });
    if (
      typeof fsConstants.O_NOFOLLOW !== "number" ||
      payloadStat.isSymbolicLink() ||
      !payloadStat.isFile() ||
      payloadStat.size > BigInt(${String(TYPED_MUTATION_MAX_PAYLOAD_BYTES)})
    ) {
      fail("typed mutation request is invalid");
    }
    payloadFd = openSync(payloadPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const openedPayload = fstatSync(payloadFd, { bigint: true });
    if (
      !openedPayload.isFile() ||
      openedPayload.size > BigInt(${String(TYPED_MUTATION_MAX_PAYLOAD_BYTES)}) ||
      !sameIdentity(openedPayload, identity(payloadStat))
    ) {
      fail("typed mutation request is invalid");
    }
    const payloadBytes = readPayloadBounded(payloadFd);
    const currentPayload = lstatSync(payloadPath, { bigint: true });
    if (
      payloadBytes.length > ${String(TYPED_MUTATION_MAX_PAYLOAD_BYTES)} ||
      currentPayload.isSymbolicLink() ||
      !currentPayload.isFile() ||
      !sameIdentity(currentPayload, identity(openedPayload))
    ) {
      fail("typed mutation request is invalid");
    }
    decodedRequest = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    fail("typed mutation request is invalid");
  } finally {
    if (payloadFd !== undefined) closeSync(payloadFd);
  }
  const request = assertStringRecord(decodedRequest);
  assertExactKeys(
    request,
    [
      "tool",
      "workspaceRoot",
      "path",
      "content",
      "preparedRoot",
      "preparedParentIdentities",
      "expectedLeaf",
      "expectedInstalledHash",
      "expectedInstalledMode",
    ],
    "fields",
  );
  const tool = stringField(request, "tool");
  const workspaceRoot = stringField(request, "workspaceRoot");
  const preparedRoot = stringField(request, "preparedRoot");
  const path = stringField(request, "path");
  const content = stringField(request, "content");
  const preparedParentIdentities = identityArrayField(request, "preparedParentIdentities");
  const expectedLeaf = leafExpectationField(request);
  const expectedInstalledHash = stringField(request, "expectedInstalledHash");
  const expectedInstalledMode = request.expectedInstalledMode;
  if (!/^[0-9a-f]{64}$/.test(expectedInstalledHash)) {
    fail("typed mutation request has invalid expectedInstalledHash");
  }
  if (
    !Number.isInteger(expectedInstalledMode) ||
    expectedInstalledMode < 0 ||
    expectedInstalledMode > 0o777 ||
    (expectedLeaf.state === "regular-file" && expectedInstalledMode !== expectedLeaf.mode)
  ) {
    fail("typed mutation request has invalid expectedInstalledMode");
  }
  if (tool !== "write" && tool !== "edit") fail("typed mutation tool is unsupported");
  const realRoot = realpathSync(workspaceRoot);
  if (realRoot !== preparedRoot) fail("typed mutation workspace changed after preparation");
  const lexical = resolve(realRoot, path);
  if (!isInside(realRoot, lexical)) fail("typed mutation target resolves outside workspace");
  atomicWrite(
    realRoot,
    lexical,
    content,
    preparedParentIdentities,
    expectedLeaf,
    expectedInstalledHash,
    expectedInstalledMode,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
`;

export interface TypedMutationRunnerRequest {
  readonly tool: "write" | "edit";
  readonly workspaceRoot: string;
  readonly profile: SandboxProfile;
  readonly mutation: PreparedTypedMutation;
  readonly signal?: AbortSignal;
  readonly capturePresentation?: boolean;
}

export interface TypedMutationPresentationFileObservation {
  readonly content: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mode: number;
}

export type TypedMutationWritePresentationObservedBefore =
  | {
      readonly status: "file-observed";
      readonly content: Uint8Array;
      readonly sha256: string;
      readonly bytes: number;
      readonly mode: number;
    }
  | { readonly status: "absent-observed" }
  | { readonly status: "not-inspected" };

export interface TypedMutationPresentationCandidate {
  readonly operation: "edit";
  readonly displayPath: string;
  readonly observedBefore: TypedMutationPresentationFileObservation;
  readonly verifiedInstalledAfter: {
    readonly content: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly mode: number;
  };
}

export interface TypedMutationWritePresentationCandidate {
  readonly operation: "write";
  readonly displayPath: string;
  readonly observedBefore: TypedMutationWritePresentationObservedBefore;
  readonly verifiedInstalledAfter: TypedMutationPresentationCandidate["verifiedInstalledAfter"];
}

export type TypedMutationPresentationCandidateV1 =
  | TypedMutationPresentationCandidate
  | TypedMutationWritePresentationCandidate;

function installedPresentationContent(content: string): string {
  // Node writes strings as UTF-8, replacing lone UTF-16 surrogates. Normalize the retained image
  // through those exact bytes so presentation never describes the pre-encoding JS string instead
  // of the postimage whose hash the helper verified.
  return Buffer.from(content, "utf8").toString("utf8");
}

export type TypedMutationOutcome = "committed" | "failed" | "indeterminate";

export interface TypedMutationCommitSettlement {
  readonly mutation: "committed";
  readonly cleanup: "complete" | "retry-required";
  readonly presentationCandidate?: TypedMutationPresentationCandidateV1;
}

export interface TypedMutationFailureSettlement {
  readonly mutation: "failed" | "indeterminate";
  readonly cleanup: "complete" | "retry-required";
  readonly error: TypedToolError;
}

export type TypedMutationSettlement =
  | TypedMutationCommitSettlement
  | TypedMutationFailureSettlement;

export interface TypedMutationCleanupSettlement {
  readonly cleanup: "complete" | "retry-required";
}

export interface TypedMutationRunner {
  assertReady(): void;
  execute(
    request: TypedMutationRunnerRequest,
  ): Promise<TypedMutationSettlement> | TypedMutationSettlement;
  quarantine(): TypedMutationCleanupSettlement;
  close(): TypedMutationCleanupSettlement;
}

export interface TypedMutationPayloadRoot {
  readonly path: string;
  assertOwned(): void;
  cleanup(): void;
}

export interface SandboxTypedMutationRunnerOptions {
  readonly sandbox: SandboxPort;
  /** General sandbox roots are accepted for construction compatibility but deliberately never
   * used for mutation payloads: governed tools can read/write `declared_temp`. */
  readonly declaredTempRoots: readonly string[];
  readonly execPath?: string;
  readonly createPayloadRoot?: () => TypedMutationPayloadRoot;
  readonly createDirectory?: (prefix: string) => string;
  readonly writePrivateFile?: typeof writeFileSync;
  readonly removeDirectory?: (path: string) => void;
}

interface HelperPayload {
  readonly tool: "write" | "edit";
  readonly workspaceRoot: string;
  readonly path: string;
  readonly content: string;
  readonly preparedRoot: string;
  readonly preparedParentIdentities: readonly PreparedPathIdentity[];
  readonly expectedLeaf: PreparedLeafExpectation;
  readonly expectedInstalledHash: string;
  readonly expectedInstalledMode: number;
}

function helperProfile(profile: SandboxProfile, invocationRoot: string): SandboxProfile {
  const filesystem = profile.filesystem ?? {};
  return {
    ...profile,
    filesystem: {
      ...filesystem,
      allowRead: [...new Set([...(filesystem.allowRead ?? []), invocationRoot])],
      ...(filesystem.allowWrite === undefined
        ? {}
        : { allowWrite: filesystem.allowWrite.filter((path) => path !== invocationRoot) }),
      denyWrite: [...new Set([...(filesystem.denyWrite ?? []), invocationRoot])],
    },
  };
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const unresolved: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const canonicalPrefix = realpathSync(current);
      return unresolved.length === 0 ? canonicalPrefix : join(canonicalPrefix, ...unresolved);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      unresolved.unshift(basename(current));
      current = parent;
    }
  }
}

function containsPath(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertPrivatePayloadRootIsolated(
  rootPath: string,
  request: TypedMutationRunnerRequest,
  declaredTempRoots: readonly string[],
): void {
  const root = canonicalPath(rootPath);
  const filesystem = request.profile.filesystem ?? {};
  const authorities = [
    request.workspaceRoot,
    ...declaredTempRoots,
    ...(filesystem.allowRead ?? []),
    ...(filesystem.allowWrite ?? []),
  ].map(canonicalPath);
  const overlappingAuthority = authorities.find(
    (authority) => containsPath(authority, root) || containsPath(root, authority),
  );
  if (overlappingAuthority !== undefined) {
    throw new TypedToolDeniedError(
      "typed mutation private payload root is not isolated from governed filesystem authority",
    );
  }
}

function boundedUtf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  let end = Math.min(bytes.length, maxBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function isUnsafeDiagnosticCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function diagnosticRedactionPaths(
  request: TypedMutationRunnerRequest,
  execPath: string,
  declaredTempRoots: readonly string[],
  privatePaths: readonly string[],
): readonly string[] {
  const filesystem = request.profile.filesystem ?? {};
  const knownPaths = [
    execPath,
    request.workspaceRoot,
    request.mutation.preparedRoot,
    request.mutation.lexicalPath,
    ...declaredTempRoots,
    ...(filesystem.allowRead ?? []),
    ...(filesystem.allowWrite ?? []),
    ...(filesystem.denyRead ?? []),
    ...(filesystem.denyWrite ?? []),
    ...privatePaths,
  ];
  return [
    ...new Set(
      knownPaths.flatMap((path) => (path.length === 0 ? [] : [path, canonicalPath(path)])),
    ),
  ];
}

function sanitizedDiagnostic(value: string, privatePaths: readonly string[]): string {
  let sanitized = value;
  for (const path of [...privatePaths].sort((left, right) => right.length - left.length)) {
    if (path.length > 0) sanitized = sanitized.replaceAll(path, "[private-path]");
  }
  const escape = String.fromCodePoint(0x1b);
  const bell = String.fromCodePoint(0x07);
  const oscSequence = new RegExp(`${escape}\\][^${bell}]*(?:${bell}|${escape}\\\\)`, "gu");
  const csiSequence = new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "gu");
  sanitized = sanitized.replace(oscSequence, " ").replace(csiSequence, " ");
  sanitized = [...sanitized]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return isUnsafeDiagnosticCodePoint(codePoint) ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return boundedUtf8Prefix(sanitized, HELPER_STDERR_LIMIT).trim();
}

function helperErrorMessage(
  tool: "write" | "edit",
  stdout: string,
  stderr: string,
  privatePaths: readonly string[] = [],
): string {
  const selected = stderr.length > 0 ? stderr : stdout;
  const raw = sanitizedDiagnostic(selected, privatePaths) || "contained mutation helper failed";
  return `${tool}: contained mutation helper failed: ${raw}`;
}

interface TypedMutationCleanupDebt {
  readonly root: TypedMutationPayloadRoot;
  readonly invocationDirectory?: string;
}

type TypedMutationRunnerState =
  | { readonly kind: "idle" }
  | { readonly kind: "executing" }
  | { readonly kind: "cleanup-debt"; readonly debt: TypedMutationCleanupDebt }
  | { readonly kind: "closing"; readonly inFlight: true }
  | { readonly kind: "closing"; readonly inFlight: false; readonly debt: TypedMutationCleanupDebt }
  | { readonly kind: "closed" };

export function createSandboxTypedMutationRunner(
  options: SandboxTypedMutationRunnerOptions,
): TypedMutationRunner | undefined {
  const status = readSandboxStatus(options.sandbox);
  if (!status.available || status.enforcementTier !== "sandbox:srt") return undefined;
  // A Bun-compiled executable does not execute an arbitrary helper module when reinvoked with a
  // path. Do not fall back to PATH lookup for `node`; that would turn executable discovery into a
  // new trust boundary. The release-eligible Node/npx carrier supplies process.execPath directly.
  if (options.execPath === undefined && process.versions["bun"] !== undefined) return undefined;
  const execPath = options.execPath ?? process.execPath;
  const createPayloadRoot = options.createPayloadRoot ?? (() => createWardenSandboxTempRoot());
  const createDirectory = options.createDirectory ?? mkdtempSync;
  const writePrivateFile = options.writePrivateFile ?? writeFileSync;
  const removeDirectory =
    options.removeDirectory ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  let state: TypedMutationRunnerState = { kind: "idle" };

  const cleanupOnce = (debt: TypedMutationCleanupDebt): TypedMutationCleanupDebt | undefined => {
    if (debt.invocationDirectory !== undefined) {
      try {
        removeDirectory(debt.invocationDirectory);
      } catch {
        return debt;
      }
    }
    try {
      debt.root.cleanup();
      return undefined;
    } catch {
      return { root: debt.root };
    }
  };

  const denied = (message: string): TypedToolDeniedError => new TypedToolDeniedError(message);
  const closeWasRequested = (): boolean => state.kind === "closing";

  const assertReady = (): void => {
    if (state.kind === "cleanup-debt") {
      const remaining = cleanupOnce(state.debt);
      if (remaining !== undefined) {
        state = { kind: "cleanup-debt", debt: remaining };
        throw denied("typed mutation temporary cleanup is pending; retry after cleanup succeeds");
      }
      state = { kind: "idle" };
    }
    if (state.kind !== "idle") {
      throw denied(
        state.kind === "closed" || state.kind === "closing"
          ? "typed mutation runner is closed"
          : "another typed mutation is already executing",
      );
    }
  };

  const runner: TypedMutationRunner = {
    assertReady,
    async execute(request): Promise<TypedMutationSettlement> {
      assertReady();
      state = { kind: "executing" };
      const payload: HelperPayload = {
        tool: request.tool,
        workspaceRoot: request.workspaceRoot,
        path: request.mutation.path,
        content: request.mutation.content,
        preparedRoot: request.mutation.preparedRoot,
        preparedParentIdentities: request.mutation.preparedParentIdentities,
        expectedLeaf: request.mutation.expectedLeaf,
        expectedInstalledHash: request.mutation.expectedInstalledHash,
        expectedInstalledMode: request.mutation.expectedInstalledMode,
      };
      const serializedPayload = JSON.stringify(payload);
      if (Buffer.byteLength(serializedPayload, "utf8") > TYPED_MUTATION_MAX_PAYLOAD_BYTES) {
        state = { kind: "idle" };
        throw new TypedToolDeniedError("typed mutation payload exceeds the bounded helper limit");
      }

      let payloadRoot: TypedMutationPayloadRoot | undefined;
      let dir: string | undefined;
      let outcome: TypedMutationOutcome = "failed";
      let primaryError: TypedToolError | undefined;
      try {
        payloadRoot = createPayloadRoot();
        payloadRoot.assertOwned();
        assertPrivatePayloadRootIsolated(payloadRoot.path, request, options.declaredTempRoots);
        dir = createDirectory(join(payloadRoot.path, "keel-typed-mutation-"));
        payloadRoot.assertOwned();
      } catch (error) {
        const remaining =
          payloadRoot === undefined
            ? undefined
            : cleanupOnce({
                root: payloadRoot,
                ...(dir === undefined ? {} : { invocationDirectory: dir }),
              });
        state =
          remaining === undefined ? { kind: "idle" } : { kind: "cleanup-debt", debt: remaining };
        return {
          mutation: "failed",
          cleanup: remaining === undefined ? "complete" : "retry-required",
          error:
            error instanceof TypedToolError
              ? error
              : new TypedToolError(
                  "TOOL_ERROR",
                  `${request.tool}: contained mutation helper failed: private payload setup failed`,
                ),
        };
      }
      const helperPath = join(dir, "helper.mjs");
      const payloadPath = join(dir, "request.json");
      let redactionPaths: readonly string[] = [];
      let dispatched = false;
      try {
        redactionPaths = diagnosticRedactionPaths(request, execPath, options.declaredTempRoots, [
          payloadRoot.path,
          dir,
          helperPath,
          payloadPath,
        ]);
        writePrivateFile(helperPath, HELPER_SOURCE, { encoding: "utf8", mode: 0o600 });
        writePrivateFile(payloadPath, serializedPayload, { encoding: "utf8", mode: 0o600 });
        dispatched = true;
        const result = await options.sandbox.execute(
          {
            command: execPath,
            argv: [execPath, helperPath, payloadPath],
            cwd: request.workspaceRoot,
          },
          helperProfile(request.profile, dir),
          request.signal === undefined ? undefined : { signal: request.signal },
        );
        if (result.exitCode === 0 && (result.signal ?? null) === null) {
          outcome = "committed";
        } else {
          const failedWithoutMutation =
            result.exitCode === HELPER_FAILED_NO_MUTATION_EXIT_CODE &&
            (result.signal ?? null) === null;
          outcome = failedWithoutMutation ? "failed" : "indeterminate";
          primaryError = new TypedToolError(
            "TOOL_ERROR",
            helperErrorMessage(request.tool, result.stdout, result.stderr, redactionPaths),
            { mutationPossible: !failedWithoutMutation },
          );
        }
      } catch (error) {
        outcome = dispatched ? "indeterminate" : "failed";
        primaryError =
          error instanceof TypedToolError
            ? error
            : new TypedToolError(
                "TOOL_ERROR",
                dispatched
                  ? helperErrorMessage(
                      request.tool,
                      "",
                      error instanceof Error ? error.message : String(error),
                      redactionPaths,
                    )
                  : `${request.tool}: contained mutation helper failed: private payload setup failed`,
                { mutationPossible: outcome === "indeterminate" },
              );
      }

      const remaining = cleanupOnce({ root: payloadRoot, invocationDirectory: dir });
      const closeRequested = closeWasRequested();
      state =
        remaining === undefined
          ? closeRequested
            ? { kind: "closed" }
            : { kind: "idle" }
          : closeRequested
            ? { kind: "closing", inFlight: false, debt: remaining }
            : { kind: "cleanup-debt", debt: remaining };
      const cleanup: TypedMutationCleanupSettlement["cleanup"] =
        remaining === undefined ? "complete" : "retry-required";
      if (outcome === "committed") {
        const observation = request.mutation.presentationObservation;
        const expectedLeaf = request.mutation.expectedLeaf;
        const editInstalledContent =
          request.capturePresentation === true && request.tool === "edit"
            ? installedPresentationContent(request.mutation.content)
            : undefined;
        const editPresentationCandidate =
          request.capturePresentation === true &&
          request.tool === "edit" &&
          observation !== undefined &&
          "observedBeforeContent" in observation &&
          editInstalledContent !== undefined &&
          expectedLeaf.state === "regular-file"
            ? {
                operation: "edit" as const,
                displayPath: request.mutation.path,
                observedBefore: {
                  content: observation.observedBeforeContent,
                  sha256: `sha256:${expectedLeaf.hash}`,
                  bytes: Buffer.byteLength(observation.observedBeforeContent, "utf8"),
                  mode: expectedLeaf.mode,
                },
                verifiedInstalledAfter: {
                  content: editInstalledContent,
                  sha256: `sha256:${request.mutation.expectedInstalledHash}`,
                  bytes: Buffer.byteLength(editInstalledContent, "utf8"),
                  mode: expectedLeaf.mode,
                },
              }
            : undefined;
        const writeObservedBefore =
          observation !== undefined && "writeObservedBefore" in observation
            ? observation.writeObservedBefore
            : undefined;
        let writePresentationCandidate: TypedMutationWritePresentationCandidate | undefined;
        if (
          request.capturePresentation === true &&
          request.tool === "write" &&
          writeObservedBefore !== undefined
        ) {
          const installedMode = request.mutation.expectedInstalledMode;
          const installedContent = installedPresentationContent(request.mutation.content);
          const verifiedInstalledAfter = {
            content: installedContent,
            sha256: `sha256:${request.mutation.expectedInstalledHash}`,
            bytes: Buffer.byteLength(installedContent, "utf8"),
            mode: installedMode,
          };
          if (writeObservedBefore.status === "absent-observed") {
            if (expectedLeaf.state === "absent") {
              writePresentationCandidate = {
                operation: "write",
                displayPath: request.mutation.path,
                observedBefore: writeObservedBefore,
                verifiedInstalledAfter,
              };
            }
          } else if (expectedLeaf.state === "regular-file") {
            writePresentationCandidate = {
              operation: "write",
              displayPath: request.mutation.path,
              observedBefore:
                writeObservedBefore.status === "file-observed"
                  ? {
                      status: "file-observed",
                      content: writeObservedBefore.content,
                      sha256: `sha256:${expectedLeaf.hash}`,
                      bytes: writeObservedBefore.content.byteLength,
                      mode: expectedLeaf.mode,
                    }
                  : writeObservedBefore,
              verifiedInstalledAfter,
            };
          }
        }
        const presentationCandidate = editPresentationCandidate ?? writePresentationCandidate;
        return {
          mutation: "committed",
          cleanup,
          ...(presentationCandidate === undefined ? {} : { presentationCandidate }),
        };
      }
      return {
        mutation: outcome,
        cleanup,
        error:
          primaryError ??
          new TypedToolError(
            "TOOL_ERROR",
            `${request.tool}: mutation settlement is indeterminate`,
            {
              mutationPossible: outcome === "indeterminate",
            },
          ),
      };
    },
    quarantine(): TypedMutationCleanupSettlement {
      return runner.close();
    },
    close(): TypedMutationCleanupSettlement {
      switch (state.kind) {
        case "closed":
          return { cleanup: "complete" };
        case "executing":
          state = { kind: "closing", inFlight: true };
          return { cleanup: "retry-required" };
        case "idle":
          state = { kind: "closed" };
          return { cleanup: "complete" };
        case "cleanup-debt":
          state = { kind: "closing", inFlight: false, debt: state.debt };
          break;
        case "closing":
          if (state.inFlight) return { cleanup: "retry-required" };
          break;
      }
      const remaining = cleanupOnce(state.debt);
      state =
        remaining === undefined
          ? { kind: "closed" }
          : { kind: "closing", inFlight: false, debt: remaining };
      return { cleanup: remaining === undefined ? "complete" : "retry-required" };
    },
  };
  return runner;
}
