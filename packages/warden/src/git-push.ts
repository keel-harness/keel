import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { Buffer } from "node:buffer";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import {
  canonicalize,
  JsonObject,
  supportedGitPushVersion,
  type JsonObjectT,
  type SideEffectT,
} from "@keel/shared";
import {
  GIT_PUSH_CAPABILITY_V1,
  GIT_PUSH_TOOL_NAME,
  type GitPushAuthority,
  type GitPushBindingAuthority,
  type GitPushAuthorityContext,
  type GitPushExecuteParams,
  type GitPushPendingReview,
  type GitPushResolveParams,
  type GitPushRpcResult,
} from "./git-push-authority.js";
import {
  GitCredentialBrokerError,
  type GitCredentialAuthorization,
  type GitCredentialBroker,
  type GitCredentialBrokerIdentity,
  type GitCredentialContext,
} from "./git-credential-broker.js";
/*
 * Keep broker errors opaque outside the Warden. The class is used only to select one bounded public
 * failure kind; its message and helper output never enter result, audit, RPC, or presentation bytes.
 */
import type { AuditAppendInput } from "./audit/writer.js";
import {
  CREDENTIAL_TLS_TERMINATION_CAPABILITY,
  EGRESS_ADDRESS_GUARD_CAPABILITY,
  SRT_LAUNCH_AUTHORITY_CAPABILITY,
  type SandboxCredentialProxyConfig,
  type SandboxExecutionResult,
  type SandboxProfile,
  type SandboxStatus,
} from "./sandbox.js";

export {
  GIT_PUSH_CAPABILITY_V1,
  GIT_PUSH_TOOL_NAME,
  type GitPushExecuteParams,
  type GitPushResolveParams,
  type GitPushRpcResult,
};
export const GIT_PUSH_REVIEW_TTL_MS = 120_000;

declare const __KEEL_RELEASE_BUILD__: boolean | undefined;
// Source/test runs retain the red walking-skeleton transport. Release carriers inject `true`, which
// lets the bundler remove every fixture-provider and loopback exception branch before byte-level
// carrier inspection. No runtime input can change this compile-time boundary.

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REVIEW_ID = /^git_push_review_[1-9]\d{0,15}$/u;
const UNSAFE_CARD_VALUE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const MAX_GIT_CONFIG_BYTES = 64 * 1024;

interface GitPushFixtureTransportAuthority {
  readonly canonicalUrl: string;
  readonly host: "localhost";
  readonly port: number;
  readonly address: "127.0.0.1";
}

export type GitPushFixtureAuthority = GitPushFixtureTransportAuthority &
  (
    | {
        readonly username: string;
        readonly secret: string;
        readonly credentialSourceClass: "deterministic-test-provider";
      }
    | {
        readonly credentialBroker: GitCredentialBroker;
        readonly credentialSourceClass: "operator-git-credential-helper";
      }
  );

/**
 * Slice-1-only injected authority. No production entrypoint constructs this value, and the runtime
 * withholds `git-push/v1` unless every test-only transport fact is present and enforcing.
 */
export interface GitPushWalkingSkeletonConfig {
  readonly advertiseTestCapability: true;
  readonly fixture: GitPushFixtureAuthority;
  readonly gitExecutable: string;
  readonly tempRoot: string;
  readonly nowMs?: () => number;
  /** Deterministic fixture-only cleanup fault seam; absent from the production authority. */
  readonly cleanupAttemptRoot?: (path: string) => void;
}

/** Production default-port authority, constructed only by the trusted enforcing product path. */
export interface GitPushProductionConfig {
  readonly productionCapability: true;
  readonly credentialBroker: GitCredentialBroker;
  readonly gitExecutable: string;
  readonly gitVersion: string;
  readonly tempRoot: string;
  readonly nowMs?: () => number;
}

export type GitPushRuntimeConfig = GitPushWalkingSkeletonConfig | GitPushProductionConfig;

interface GitPushRequest {
  readonly remote: string;
  readonly branch: string;
  readonly expectedHead: string;
}

interface GitExecutableIdentity {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly modifiedNs: string;
}

interface GitConfigIdentity extends GitExecutableIdentity {
  readonly digest: string;
}

interface GitPushFacts {
  readonly workspaceRoot: string;
  readonly workspaceIdentity: GitExecutableIdentity;
  readonly gitDir: string;
  readonly gitDirIdentity: GitExecutableIdentity;
  readonly configIdentity: GitConfigIdentity;
  readonly objectStore: string;
  readonly objectStoreIdentity: GitExecutableIdentity;
  readonly objectFormat: "sha1" | "sha256";
  readonly remote: string;
  readonly canonicalUrl: string;
  readonly host: string;
  readonly port: number;
  readonly destinationRef: string;
  readonly expectedHead: string;
  readonly subject: string;
  readonly authorTimestamp: string;
  readonly parentCount: number;
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
  readonly workspaceState: "clean" | "has uncommitted changes";
  readonly gitExecutable: GitExecutableIdentity;
  readonly gitVersion: string;
  readonly envExecutable?: GitExecutableIdentity;
  readonly tempRoot: string;
  readonly tempRootIdentity: GitExecutableIdentity;
  readonly credentialSourceClass:
    | "deterministic test fixture (release capability withheld)"
    | "operator Git credential helper (system/global config)";
  readonly credentialBrokerIdentity?: GitCredentialBrokerIdentity;
}

export interface PendingGitPushReview extends GitPushPendingReview {
  readonly kind: "git-push";
  readonly reviewId: string;
  readonly summary: string;
  readonly allowCommand: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly generation: number;
  readonly bindingDigest: string;
  readonly executeParams: GitPushExecuteParams;
  readonly request: GitPushRequest;
  readonly facts: GitPushFacts;
  readonly bindingAuthority: GitPushBindingAuthority;
}

export interface GitPushRuntimeState {
  readonly config: GitPushRuntimeConfig;
  readonly pending: Map<string, PendingGitPushReview>;
  nextReviewId: number;
  reviewGeneration: number;
  cleanupHealthy: boolean;
}

export interface GitPushRuntimeContext extends GitPushAuthorityContext {
  readonly state: GitPushRuntimeState;
}

export class GitPushInvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitPushInvalidParamsError";
  }
}

export interface CanonicalGitHttpsUrl {
  readonly canonicalUrl: string;
  readonly host: string;
  readonly port: 443;
  readonly path: string;
}

/** ADR-0091's deliberately narrow production URL grammar. It rejects instead of normalizing. */
export function parseCanonicalGitHttpsUrl(input: string): CanonicalGitHttpsUrl {
  if (
    Buffer.byteLength(input, "utf8") > 512 ||
    !/^[\x20-\x7e]+$/u.test(input) ||
    !input.startsWith("https://")
  ) {
    throw new GitPushInvalidParamsError("remote URL must be canonical bounded ASCII HTTPS");
  }
  const authorityAndPath = input.slice("https://".length);
  const pathOffset = authorityAndPath.indexOf("/");
  if (pathOffset <= 0) {
    throw new GitPushInvalidParamsError("remote URL must contain one DNS host and repository path");
  }
  const host = authorityAndPath.slice(0, pathOffset);
  const path = authorityAndPath.slice(pathOffset);
  const labels = host.split(".");
  if (
    host.length > 253 ||
    host !== host.toLowerCase() ||
    isIP(host) !== 0 ||
    labels.some((label) => label === "" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  ) {
    throw new GitPushInvalidParamsError("remote URL host must be one canonical lowercase DNS name");
  }
  if (Buffer.byteLength(path, "utf8") > 384) {
    throw new GitPushInvalidParamsError("remote URL repository path exceeds 384 ASCII bytes");
  }
  const segments = path.slice(1).split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._~-]+$/u.test(segment),
    )
  ) {
    throw new GitPushInvalidParamsError("remote URL repository path is not canonical");
  }
  return { canonicalUrl: input, host, port: 443, path };
}

export function auditGitPushInvalidParams(
  context: GitPushRuntimeContext,
  executeParams: GitPushExecuteParams,
  error: GitPushInvalidParamsError,
): number {
  const canonicalUrl =
    (typeof __KEEL_RELEASE_BUILD__ === "undefined" || __KEEL_RELEASE_BUILD__ !== true) &&
    isFixtureConfig(context.state.config)
      ? context.state.config.fixture.canonicalUrl
      : "https://invalid.invalid/git-push";
  return context.appendAudit({
    eventType: "tool.deny",
    sessionId: executeParams.sessionId,
    payload: {
      toolName: GIT_PUSH_TOOL_NAME,
      args: executeParams.toolCall.args,
      reason: error.message,
      code: "INVALID_PARAMS",
      actionMayHaveExecuted: false,
    },
    sideEffect: gitPushSideEffect(canonicalUrl),
  });
}

export function createGitPushRuntimeState<Config extends GitPushRuntimeConfig>(
  config: Config,
): GitPushRuntimeState & { readonly config: Config } {
  validateRuntimeAuthority(config);
  return {
    config,
    pending: new Map(),
    nextReviewId: 1,
    reviewGeneration: 1,
    cleanupHealthy: true,
  };
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function isFixtureConfig(config: GitPushRuntimeConfig): config is GitPushWalkingSkeletonConfig {
  return !("productionCapability" in config);
}

function productionConfig(config: GitPushRuntimeConfig): GitPushProductionConfig | undefined {
  if (!(typeof __KEEL_RELEASE_BUILD__ === "undefined" || __KEEL_RELEASE_BUILD__ !== true)) {
    return config as GitPushProductionConfig;
  }
  return isFixtureConfig(config) ? undefined : config;
}

function cleanupAttemptRoot(state: GitPushRuntimeState, attemptRoot: string): void {
  try {
    if (
      (typeof __KEEL_RELEASE_BUILD__ === "undefined" || __KEEL_RELEASE_BUILD__ !== true) &&
      isFixtureConfig(state.config) &&
      state.config.cleanupAttemptRoot !== undefined
    ) {
      state.config.cleanupAttemptRoot(attemptRoot);
    } else {
      rmSync(attemptRoot, { recursive: true, force: true });
    }
  } catch {
    // Never overwrite a confirmed result or an authoritative audit failure. A cleanup fault is not
    // ignored: it permanently quarantines this authority. The attempt contains no credential bytes
    // (credentials stay in host-side SRT injection) and remains under the owner-only Warden temp root,
    // whose process lifecycle is the outer cleanup boundary.
    state.cleanupHealthy = false;
    state.pending.clear();
  }
}

function validateBaseAuthority(config: GitPushRuntimeConfig): void {
  const gitExecutable = realpathSync(config.gitExecutable);
  // realpathSync returns a canonical absolute path or throws before capability state exists.
  void gitExecutable;
  const tempRoot = realpathSync(config.tempRoot);
  const tempStat = statSync(tempRoot);
  if (!tempStat.isDirectory() || (tempStat.mode & 0o077) !== 0) {
    throw new Error("git.push temporary root must be an owner-only directory");
  }
}

function validateRuntimeAuthority(config: GitPushRuntimeConfig): void {
  const production = productionConfig(config);
  if (production !== undefined) {
    if (
      production.productionCapability !== true ||
      supportedGitPushVersion(`git version ${production.gitVersion}`) !== production.gitVersion ||
      production.credentialBroker.sourceClass !==
        "operator Git credential helper (system/global config)"
    ) {
      throw new Error("invalid production git.push credential authority");
    }
    validateBaseAuthority(config);
    return;
  }
  if (
    !(typeof __KEEL_RELEASE_BUILD__ === "undefined" || __KEEL_RELEASE_BUILD__ !== true) ||
    !isFixtureConfig(config)
  ) {
    throw new Error("invalid production git.push credential authority");
  }
  if (config.advertiseTestCapability !== true) throw new Error("git.push fixture is not enabled");
  const fixture = config.fixture;
  const parsed = new URL(fixture.canonicalUrl);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "localhost" ||
    parsed.port !== String(fixture.port) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    fixture.host !== "localhost" ||
    fixture.address !== "127.0.0.1" ||
    !Number.isInteger(fixture.port) ||
    fixture.port < 1 ||
    fixture.port > 65_535 ||
    (fixture.credentialSourceClass === "deterministic-test-provider"
      ? fixture.username === "" || fixture.secret === ""
      : fixture.credentialSourceClass === "operator-git-credential-helper"
        ? fixture.credentialBroker.sourceClass !==
          "operator Git credential helper (system/global config)"
        : true)
  ) {
    throw new Error("invalid non-release git.push fixture authority");
  }
  validateBaseAuthority(config);
}

export function gitPushCapabilityAvailable(
  state: GitPushRuntimeState | undefined,
  input: {
    readonly workspaceTrusted: boolean;
    readonly auditAvailable: boolean;
    readonly sandbox: SandboxStatus;
  },
): boolean {
  if (
    state === undefined ||
    !state.cleanupHealthy ||
    !input.workspaceTrusted ||
    !input.auditAvailable
  )
    return false;
  const sandbox = input.sandbox;
  return (
    sandbox.available &&
    sandbox.backend === "srt:vendored" &&
    sandbox.enforcementTier === "sandbox:srt" &&
    sandbox.features?.includes(EGRESS_ADDRESS_GUARD_CAPABILITY) === true &&
    sandbox.features?.includes(CREDENTIAL_TLS_TERMINATION_CAPABILITY) === true &&
    sandbox.features?.includes(SRT_LAUNCH_AUTHORITY_CAPABILITY) === true
  );
}

function parseRequest(args: JsonObjectT): GitPushRequest {
  const keys = Object.keys(args).sort();
  if (keys.length !== 3 || keys.join("\u0000") !== "branch\u0000expectedHead\u0000remote") {
    throw new GitPushInvalidParamsError(
      "git.push requires exactly remote, branch, and expectedHead",
    );
  }
  const remote = args["remote"];
  const branch = args["branch"];
  const expectedHead = args["expectedHead"];
  if (typeof remote !== "string" || !REMOTE_NAME.test(remote)) {
    throw new GitPushInvalidParamsError(
      "remote must be 1-64 ASCII letters, digits, dot, underscore, or hyphen and start alphanumeric",
    );
  }
  if (
    typeof branch !== "string" ||
    !/^[\x21-\x7e]{1,128}$/u.test(branch) ||
    branch === "HEAD" ||
    branch === "@" ||
    branch.startsWith("refs/")
  ) {
    throw new GitPushInvalidParamsError(
      "branch must be a 1-128 byte ASCII short branch name, not HEAD, @, or refs/*",
    );
  }
  if (typeof expectedHead !== "string" || !FULL_OID.test(expectedHead)) {
    throw new GitPushInvalidParamsError(
      "expectedHead must be one full lowercase 40- or 64-hex commit object ID",
    );
  }
  return { remote, branch, expectedHead };
}

function fixedGitPath(gitExecutable: string): string {
  return [dirname(realpathSync(gitExecutable)), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

function containedGitEnv(
  tempRoot: string,
  gitExecutable: string,
): Readonly<Record<string, string>> {
  const home = join(tempRoot, "inspection-git-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    PATH: fixedGitPath(gitExecutable),
    HOME: home,
    XDG_CONFIG_HOME: home,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_ATTR_NOSYSTEM: "1",
  };
}

function inspectionProfile(
  context: GitPushRuntimeContext,
  writeRoot: string,
  allowWorkspaceRead: boolean,
): SandboxProfile {
  const workspaceRoot = realpathSync(context.workspaceRoot);
  const tempRoot = realpathSync(context.state.config.tempRoot);
  return {
    filesystem: {
      allowRead: [
        ...(allowWorkspaceRead ? [workspaceRoot] : []),
        tempRoot,
        realpathSync(context.state.config.gitExecutable),
      ],
      allowWrite: [realpathSync(writeRoot)],
      denyRead: [],
      denyWrite: [
        workspaceRoot,
        ...(context.auditDir === undefined ? [] : [realpathSync(context.auditDir)]),
      ],
    },
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
  };
}

async function runContainedGit(
  context: GitPushRuntimeContext,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly allowExitOne?: boolean;
    readonly allowWorkspaceRead?: boolean;
    readonly writeRoot?: string;
  } = {},
): Promise<string> {
  const gitExecutable = realpathSync(context.state.config.gitExecutable);
  const timeout = AbortSignal.timeout(5_000);
  const signal =
    context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
  const result = await context.sandbox.execute(
    {
      command: gitExecutable,
      argv: [
        gitExecutable,
        "--no-pager",
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        ...args,
      ],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    },
    inspectionProfile(
      context,
      options.writeRoot ?? context.state.config.tempRoot,
      options.allowWorkspaceRead !== false,
    ),
    {
      signal,
      credentialProxy: {
        sandboxEnv: containedGitEnv(
          context.state.config.tempRoot,
          context.state.config.gitExecutable,
        ),
      },
    },
  );
  if (
    Buffer.byteLength(result.stdout, "utf8") > MAX_GIT_OUTPUT_BYTES ||
    Buffer.byteLength(result.stderr, "utf8") > MAX_GIT_OUTPUT_BYTES
  ) {
    throw new GitPushInvalidParamsError("local Git inspection exceeded its output bound");
  }
  if (result.exitCode !== 0 && !(options.allowExitOne === true && result.exitCode === 1)) {
    throw new GitPushInvalidParamsError(`local Git inspection failed for ${args[0] ?? "request"}`);
  }
  if (!result.stdout.endsWith("\n")) return result.stdout;
  const withoutLineFeed = result.stdout.slice(0, -1);
  return withoutLineFeed.endsWith("\r") ? withoutLineFeed.slice(0, -1) : withoutLineFeed;
}

function rejectRepositoryShape(gitDir: string): void {
  const unsupported: readonly [path: string, reason: string][] = [
    [join(gitDir, "shallow"), "shallow repositories are unsupported"],
    [join(gitDir, "commondir"), "common Git directories are unsupported"],
    [join(gitDir, "worktrees"), "repositories with linked worktrees are unsupported"],
    [join(gitDir, "info", "grafts"), "repository grafts are unsupported"],
    [join(gitDir, "objects", "info", "alternates"), "alternate object databases are unsupported"],
    [
      join(gitDir, "objects", "info", "http-alternates"),
      "HTTP alternate object databases are unsupported",
    ],
  ];
  for (const [path, reason] of unsupported) {
    if (existsSync(path)) throw new GitPushInvalidParamsError(reason);
  }
}

async function rejectRepositoryConfigWidening(
  context: GitPushRuntimeContext,
  workspaceRoot: string,
): Promise<void> {
  const partialClone = await runContainedGit(
    context,
    [
      "-C",
      workspaceRoot,
      "config",
      "--local",
      "--no-includes",
      "--name-only",
      "--get-regexp",
      "^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$",
    ],
    { allowExitOne: true },
  );
  if (partialClone !== "") {
    throw new GitPushInvalidParamsError("partial clones are unsupported");
  }
  const widening = await runContainedGit(
    context,
    [
      "-C",
      workspaceRoot,
      "config",
      "--local",
      "--no-includes",
      "--name-only",
      "--get-regexp",
      "^(remote\\..*\\.(mirror|proxy|proxyauthmethod|push|receivepack|vcs)|http\\.(followredirects|proxy|proxyauthmethod|sslbackend|sslcert|sslcertpasswordprotected|sslkey|sslcainfo|sslcapath|sslverify|extraheader|curloptresolve)|core\\.(hookspath|fsmonitor)|credential(\\..*)?\\..*|push\\.(followtags|gpgsign|pushoption|recursesubmodules|useforceifincludes)|submodule\\.recurse|protocol\\..*\\.allow|url\\..*\\.(insteadof|pushinsteadof))$",
    ],
    { allowExitOne: true },
  );
  if (widening !== "") {
    throw new GitPushInvalidParamsError("repository-local Git config is unsupported for git.push");
  }
}

function exactFileIdentity(path: string): GitExecutableIdentity {
  const canonical = realpathSync(path);
  const stat = statSync(canonical, { bigint: true });
  return {
    path: canonical,
    device: String(stat.dev),
    inode: String(stat.ino),
    size: String(stat.size),
    modifiedNs: String(stat.mtimeNs),
  };
}

function exactGitConfigIdentity(gitDir: string): GitConfigIdentity {
  const configPath = join(gitDir, "config");
  const entry = lstatSync(configPath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new GitPushInvalidParamsError(
      "repository config must be one ordinary in-repository file",
    );
  }
  const identity = exactFileIdentity(configPath);
  if (!isInside(gitDir, identity.path) || Number(identity.size) > MAX_GIT_CONFIG_BYTES) {
    throw new GitPushInvalidParamsError("repository config is outside its bounded authority");
  }
  const bytes = readFileSync(identity.path);
  return {
    ...identity,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function safeCardValue(name: string, value: string, maxBytes: number): string {
  if (
    value === "" ||
    UNSAFE_CARD_VALUE.test(value) ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new GitPushInvalidParamsError(`${name} cannot be shown losslessly in a bounded approval`);
  }
  return value;
}

function integerFromGit(name: string, value: string): number {
  if (!/^\d{1,20}$/u.test(value)) {
    throw new GitPushInvalidParamsError(`Git returned an invalid ${name}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new GitPushInvalidParamsError(`${name} is too large`);
  return number;
}

async function inspectGitPushFacts(
  context: GitPushRuntimeContext,
  workspaceRootInput: string,
  request: GitPushRequest,
): Promise<GitPushFacts> {
  const state = context.state;
  const production = productionConfig(state.config);
  const gitVersion = supportedGitPushVersion(await runContainedGit(context, ["--version"]));
  if (
    gitVersion === undefined ||
    (production !== undefined && gitVersion !== production.gitVersion)
  ) {
    throw new GitPushInvalidParamsError("configured Git version is no longer supported");
  }
  const workspaceRoot = realpathSync(workspaceRootInput);
  if (
    (await runContainedGit(context, ["-C", workspaceRoot, "rev-parse", "--is-bare-repository"])) !==
    "false"
  ) {
    throw new GitPushInvalidParamsError("git.push requires an ordinary non-bare repository");
  }
  const topLevel = realpathSync(
    await runContainedGit(context, ["-C", workspaceRoot, "rev-parse", "--show-toplevel"]),
  );
  if (topLevel !== workspaceRoot) {
    throw new GitPushInvalidParamsError("workspace root must be the ordinary repository top level");
  }
  const dotGit = join(workspaceRoot, ".git");
  if (!lstatSync(dotGit).isDirectory()) {
    throw new GitPushInvalidParamsError(
      "linked worktrees and non-directory .git layouts are unsupported",
    );
  }
  const gitDir = realpathSync(
    await runContainedGit(context, ["-C", workspaceRoot, "rev-parse", "--absolute-git-dir"]),
  );
  if (gitDir !== realpathSync(dotGit) || !isInside(workspaceRoot, gitDir)) {
    throw new GitPushInvalidParamsError("Git directory identity is outside the trusted workspace");
  }
  rejectRepositoryShape(gitDir);
  await rejectRepositoryConfigWidening(context, workspaceRoot);
  const configIdentity = exactGitConfigIdentity(gitDir);
  const objectStoreEntry = lstatSync(join(gitDir, "objects"));
  const objectStore = realpathSync(join(gitDir, "objects"));
  if (
    !objectStoreEntry.isDirectory() ||
    objectStoreEntry.isSymbolicLink() ||
    !isInside(gitDir, objectStore) ||
    !isInside(workspaceRoot, objectStore)
  ) {
    throw new GitPushInvalidParamsError("object store must stay inside the trusted workspace");
  }
  if (process.env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] !== undefined) {
    throw new GitPushInvalidParamsError("alternate object databases are unsupported");
  }
  const replacementRefs = await runContainedGit(context, [
    "-C",
    workspaceRoot,
    "for-each-ref",
    "--format=%(refname)",
    "refs/replace",
  ]);
  if (replacementRefs !== "") {
    throw new GitPushInvalidParamsError("replacement refs are unsupported");
  }
  const objectFormatRaw = await runContainedGit(context, [
    "-C",
    workspaceRoot,
    "rev-parse",
    "--show-object-format",
  ]);
  if (objectFormatRaw !== "sha1" && objectFormatRaw !== "sha256") {
    throw new GitPushInvalidParamsError("repository object format is unsupported");
  }
  const objectFormat = objectFormatRaw;
  if (request.expectedHead.length !== (objectFormat === "sha1" ? 40 : 64)) {
    throw new GitPushInvalidParamsError(
      "expectedHead length does not match the repository object format",
    );
  }
  const symbolicHead = await runContainedGit(
    context,
    ["-C", workspaceRoot, "symbolic-ref", "--quiet", "HEAD"],
    { allowExitOne: true },
  );
  if (symbolicHead === "") {
    throw new GitPushInvalidParamsError("detached HEAD is unsupported for git.push");
  }
  const head = await runContainedGit(context, [
    "-C",
    workspaceRoot,
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  if (head !== request.expectedHead) {
    throw new GitPushInvalidParamsError(
      "current HEAD does not equal expectedHead; refresh and submit a new request",
    );
  }
  if (
    (await runContainedGit(context, [
      "-C",
      workspaceRoot,
      "cat-file",
      "-t",
      request.expectedHead,
    ])) !== "commit"
  ) {
    throw new GitPushInvalidParamsError("expectedHead does not identify a commit");
  }
  await runContainedGit(context, ["check-ref-format", "--branch", request.branch]);
  const destinationRef = `refs/heads/${request.branch}`;
  const urls = (
    await runContainedGit(
      context,
      [
        "-C",
        workspaceRoot,
        "config",
        "--local",
        "--no-includes",
        "--get-all",
        `remote.${request.remote}.url`,
      ],
      { allowExitOne: true },
    )
  )
    .split("\n")
    .filter((value) => value !== "");
  if (urls.length !== 1) {
    throw new GitPushInvalidParamsError("remote must resolve to exactly one repository-local URL");
  }
  const canonicalUrl = urls[0]!;
  let host: string;
  let port: number;
  let repositoryPath: string;
  if (
    (typeof __KEEL_RELEASE_BUILD__ === "undefined" || __KEEL_RELEASE_BUILD__ !== true) &&
    isFixtureConfig(state.config)
  ) {
    if (canonicalUrl !== state.config.fixture.canonicalUrl) {
      throw new GitPushInvalidParamsError(
        "Slice 1 release-withheld fixture accepts only its injected canonical HTTPS repository URL",
      );
    }
    const parsedFixtureUrl = new URL(canonicalUrl);
    host = state.config.fixture.host;
    port = state.config.fixture.port;
    repositoryPath = parsedFixtureUrl.pathname.slice(1);
  } else {
    const parsedProductionUrl = parseCanonicalGitHttpsUrl(canonicalUrl);
    host = parsedProductionUrl.host;
    port = parsedProductionUrl.port;
    repositoryPath = parsedProductionUrl.path.slice(1);
  }
  const pushUrls = await runContainedGit(
    context,
    [
      "-C",
      workspaceRoot,
      "config",
      "--local",
      "--no-includes",
      "--get-all",
      `remote.${request.remote}.pushurl`,
    ],
    { allowExitOne: true },
  );
  if (pushUrls !== "") throw new GitPushInvalidParamsError("remote pushurl is unsupported");
  const metadata = (
    await runContainedGit(context, [
      "-C",
      workspaceRoot,
      "show",
      "-s",
      "--format=%H%x00%aI%x00%P%x00%s",
      request.expectedHead,
    ])
  ).split("\u0000");
  if (metadata.length !== 4 || metadata[0] !== request.expectedHead) {
    throw new GitPushInvalidParamsError("commit metadata could not be resolved exactly");
  }
  const authorTimestamp = safeCardValue("author timestamp", metadata[1]!, 64);
  const parents = metadata[2] === "" ? [] : metadata[2]!.split(" ");
  const oidLength = objectFormat === "sha1" ? 40 : 64;
  if (parents.some((parent) => parent.length !== oidLength || !FULL_OID.test(parent))) {
    throw new GitPushInvalidParamsError("commit parent metadata is malformed");
  }
  const subject = safeCardValue("commit subject", metadata[3]!, 160);
  const numstat = await runContainedGit(context, [
    "-C",
    workspaceRoot,
    "diff-tree",
    "--no-ext-diff",
    "--no-textconv",
    "--no-commit-id",
    "--numstat",
    "--root",
    "-r",
    request.expectedHead,
  ]);
  let additions = 0;
  let deletions = 0;
  let fileCount = 0;
  for (const line of numstat === "" ? [] : numstat.split("\n")) {
    const columns = line.split("\t");
    if (columns.length < 3 || columns[0] === "-" || columns[1] === "-") {
      throw new GitPushInvalidParamsError(
        "binary or malformed commit summary is unsupported in Slice 1",
      );
    }
    additions += integerFromGit("addition count", columns[0]!);
    deletions += integerFromGit("deletion count", columns[1]!);
    fileCount += 1;
    if (
      !Number.isSafeInteger(additions) ||
      !Number.isSafeInteger(deletions) ||
      !Number.isSafeInteger(fileCount)
    ) {
      throw new GitPushInvalidParamsError("commit summary counts are too large");
    }
  }
  const workspaceState =
    (await runContainedGit(context, [
      "-C",
      workspaceRoot,
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
    ])) === ""
      ? "clean"
      : "has uncommitted changes";
  const credentialContext: GitCredentialContext = {
    protocol: "https",
    host,
    path: repositoryPath,
  };
  const credentialBroker = credentialBrokerForConfig(state.config);
  const credentialBrokerIdentity = await credentialBroker?.inspect(credentialContext);
  return {
    workspaceRoot,
    workspaceIdentity: exactFileIdentity(workspaceRoot),
    gitDir,
    gitDirIdentity: exactFileIdentity(gitDir),
    configIdentity,
    objectStore,
    objectStoreIdentity: exactFileIdentity(objectStore),
    objectFormat,
    remote: request.remote,
    canonicalUrl,
    host,
    port,
    destinationRef,
    expectedHead: request.expectedHead,
    subject,
    authorTimestamp,
    parentCount: parents.length,
    fileCount,
    additions,
    deletions,
    workspaceState,
    gitExecutable: exactFileIdentity(state.config.gitExecutable),
    gitVersion,
    ...((typeof __KEEL_RELEASE_BUILD__ === "undefined" || __KEEL_RELEASE_BUILD__ !== true) &&
    isFixtureConfig(state.config)
      ? { envExecutable: exactFileIdentity("/usr/bin/env") }
      : {}),
    tempRoot: realpathSync(state.config.tempRoot),
    tempRootIdentity: exactFileIdentity(state.config.tempRoot),
    credentialSourceClass:
      (typeof __KEEL_RELEASE_BUILD__ === "undefined" || __KEEL_RELEASE_BUILD__ !== true) &&
      credentialBroker === undefined
        ? "deterministic test fixture (release capability withheld)"
        : "operator Git credential helper (system/global config)",
    ...(credentialBrokerIdentity === undefined ? {} : { credentialBrokerIdentity }),
  };
}

function reviewSummary(facts: GitPushFacts): string {
  const summary = [
    "Git push requires approval.",
    `Repository: ${facts.canonicalUrl}`,
    `Destination: ${facts.destinationRef}`,
    `Commit: ${facts.expectedHead}`,
    `Subject: ${facts.subject}`,
    `Commit facts: ${facts.authorTimestamp}; ${String(facts.parentCount)}; ${String(facts.fileCount)} files; +${String(facts.additions)} -${String(facts.deletions)}`,
    `Workspace: ${facts.workspaceState}; uncommitted changes are excluded`,
    "Effect: create this branch or fast-forward it to this commit; the remote may receive every missing object reachable from the commit",
    "Blocked: force, deletion, tags, hooks, submodule recursion, redirects, and remote-default-branch writes",
    `Credential: ${facts.credentialSourceClass}; secret stays in the Warden/SRT path`,
    "Approval: this occurrence once; expires in 120 seconds",
  ].join("\n");
  if (Buffer.byteLength(summary, "utf8") > 2_048) {
    throw new GitPushInvalidParamsError("git.push approval summary exceeds 2,048 bytes");
  }
  return summary;
}

function bindingDigest(input: {
  readonly executeParams: GitPushExecuteParams;
  readonly request: GitPushRequest;
  readonly facts: GitPushFacts;
  readonly reviewId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly generation: number;
  readonly sandbox: SandboxStatus;
  readonly auditDir: string | undefined;
  readonly bindingAuthority: GitPushBindingAuthority;
}): string {
  const bytes = canonicalize({
    version: "git-push-binding/v1",
    toolCall: input.executeParams.toolCall,
    sessionId: input.executeParams.sessionId,
    provenanceContext: input.executeParams.provenanceContext,
    request: input.request,
    facts: input.facts,
    reviewId: input.reviewId,
    createdAtMs: input.createdAtMs,
    expiresAtMs: input.expiresAtMs,
    generation: input.generation,
    auditDir: input.auditDir ?? null,
    bindingAuthority: {
      policyInput: input.bindingAuthority.policyInput,
      policyDecision: {
        verdict: input.bindingAuthority.policyDecision.verdict,
        matchedRules: [...input.bindingAuthority.policyDecision.matchedRules],
        guidance: input.bindingAuthority.policyDecision.guidance ?? null,
        modifiedArgs: input.bindingAuthority.policyDecision.modifiedArgs ?? null,
      },
      policyPack: input.bindingAuthority.policyPack,
      addressGuardRevision: input.bindingAuthority.addressGuardRevision,
      auditAuthorityId: input.bindingAuthority.auditAuthorityId,
    },
    sandbox: {
      backend: input.sandbox.backend,
      enforcementTier: input.sandbox.enforcementTier,
      features: [...(input.sandbox.features ?? [])].sort(),
    },
  } as unknown as JsonObjectT);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function bindingAuthorityAuditFields(
  authority: GitPushBindingAuthority,
): Pick<AuditAppendInput, "policyPack" | "policy" | "provenance"> {
  return {
    policyPack: authority.policyPack,
    policy: {
      packName: authority.policyPack.name,
      packHash: authority.policyPack.hash,
      ruleIds: [...authority.policyDecision.matchedRules],
      verdict: authority.policyDecision.verdict,
    },
    provenance: {
      inputTags: [...authority.policyInput.provenance.inputTags],
      resultTag: null,
    },
  };
}

function expectedPolicyArgv(executeParams: GitPushExecuteParams): string[] {
  const args = executeParams.toolCall.args;
  const exactStringArg = (name: "remote" | "branch" | "expectedHead"): string => {
    const value = args[name];
    if (typeof value !== "string") {
      throw new GitPushInvalidParamsError(`git.push ${name} must be a string`);
    }
    return value;
  };
  return [
    GIT_PUSH_TOOL_NAME,
    exactStringArg("remote"),
    exactStringArg("branch"),
    exactStringArg("expectedHead"),
  ];
}

function validateBindingAuthority(
  context: GitPushRuntimeContext,
  executeParams: GitPushExecuteParams,
  facts: GitPushFacts,
  sideEffect: SideEffectT,
  authority: GitPushBindingAuthority,
): void {
  const input = authority.policyInput;
  const policyArgs = JsonObject.safeParse(input.tool.args);
  if (
    authority.auditAuthorityId === "" ||
    authority.addressGuardRevision === "" ||
    input.tool.name !== GIT_PUSH_TOOL_NAME ||
    !policyArgs.success ||
    canonicalize(policyArgs.data) !== canonicalize(executeParams.toolCall.args) ||
    canonicalize(input.sideEffect as unknown as JsonObjectT) !==
      canonicalize(sideEffect as unknown as JsonObjectT) ||
    input.workspace.path !== context.workspaceRoot ||
    input.workspace.trusted !== true ||
    input.session.id !== executeParams.sessionId ||
    canonicalize(input.provenance) !== canonicalize(executeParams.provenanceContext) ||
    input.egress.isEgress !== true ||
    input.egress.domain !== facts.host ||
    input.egress.gitRemote !== facts.canonicalUrl ||
    canonicalize({ argv: input.normalized.argv }) !==
      canonicalize({ argv: expectedPolicyArgv(executeParams) })
  ) {
    throw new Error("git.push binding authority did not match the exact request");
  }
}

function gitPushSideEffect(factsOrCanonicalUrl: GitPushFacts | string): SideEffectT {
  const canonicalUrl =
    typeof factsOrCanonicalUrl === "string"
      ? factsOrCanonicalUrl
      : factsOrCanonicalUrl.canonicalUrl;
  const segment: SideEffectT["dynamic"]["composition"]["segments"][number] = {
    effectKinds: ["network_read", "network_write", "process_exec"],
    scopes: ["external_service", "network", "process"],
    targets: [
      {
        kind: "url" as const,
        value: canonicalUrl,
        normalized: canonicalUrl,
        sensitivity: "internal" as const,
      },
    ],
    modifiers: ["persistent"],
  };
  return {
    taxonomyVersion: "side-effect-taxonomy/v1",
    staticCapability: {
      toolName: GIT_PUSH_TOOL_NAME,
      effectEnvelope: ["network_read", "network_write", "process_exec"],
      broad: false,
    },
    dynamic: {
      effectKinds: [...segment.effectKinds],
      scopes: [...segment.scopes],
      targets: [...segment.targets],
      modifiers: [...segment.modifiers],
      composition: { kind: "sequence", segments: [segment], edges: [] },
      classifier: {
        name: "git-push-v1-typed-classifier",
        version: "1",
        confidence: "exact",
        reasons: ["typed_exact_ref_update"],
      },
    },
  };
}

function auditIdentity(review: PendingGitPushReview): JsonObjectT {
  return {
    remote: review.request.remote,
    repository: review.facts.canonicalUrl,
    destinationRef: review.facts.destinationRef,
    expectedHead: review.facts.expectedHead,
    objectFormat: review.facts.objectFormat,
    gitExecutable: review.facts.gitExecutable.path,
    ...((typeof __KEEL_RELEASE_BUILD__ === "undefined" || __KEEL_RELEASE_BUILD__ !== true) &&
    review.facts.envExecutable !== undefined
      ? { fixtureEnvExecutable: review.facts.envExecutable.path }
      : {}),
    bindingDigest: review.bindingDigest,
    credentialSourceClass: review.facts.credentialSourceClass,
    credentialBrokerIdentity:
      review.facts.credentialBrokerIdentity === undefined
        ? null
        : {
            version: review.facts.credentialBrokerIdentity.version,
            gitExecutableDigest: review.facts.credentialBrokerIdentity.gitExecutableDigest,
            configurationDigest: review.facts.credentialBrokerIdentity.configurationDigest,
            helperDigest: review.facts.credentialBrokerIdentity.helperDigest,
            helperCount: review.facts.credentialBrokerIdentity.helperCount,
          },
    transport: "srt:vendored verified HTTPS with connect-time address guard",
  };
}

export async function requestGitPushReview(
  context: GitPushRuntimeContext,
  executeParams: GitPushExecuteParams,
): Promise<GitPushRpcResult> {
  if (executeParams.toolCall.name !== GIT_PUSH_TOOL_NAME) {
    throw new GitPushInvalidParamsError("unexpected tool name for git.push authority");
  }
  const sandbox = context.sandbox.status();
  if (
    !gitPushCapabilityAvailable(context.state, {
      workspaceTrusted: true,
      auditAvailable: true,
      sandbox,
    })
  ) {
    throw new Error(
      (typeof __KEEL_RELEASE_BUILD__ === "undefined" || __KEEL_RELEASE_BUILD__ !== true) &&
        isFixtureConfig(context.state.config)
        ? "git.push release-withheld fixture boundary is unavailable"
        : "git.push enforcing transport boundary is unavailable",
    );
  }
  const request = parseRequest(executeParams.toolCall.args);
  const facts = await inspectGitPushFacts(context, context.workspaceRoot, request);
  const sideEffect = gitPushSideEffect(facts);
  const bindingAuthority = await context.resolveBindingAuthority({
    executeParams,
    sideEffect,
    canonicalUrl: facts.canonicalUrl,
    host: facts.host,
  });
  validateBindingAuthority(context, executeParams, facts, sideEffect, bindingAuthority);
  if (
    bindingAuthority.policyDecision.verdict === "deny" ||
    bindingAuthority.policyDecision.modifiedArgs !== undefined
  ) {
    const auditSeq = context.appendAudit({
      eventType: "tool.deny",
      sessionId: executeParams.sessionId,
      payload: {
        toolName: GIT_PUSH_TOOL_NAME,
        args: executeParams.toolCall.args,
        reason: "current Warden policy does not permit an exact git.push review",
        actionMayHaveExecuted: false,
      },
      sideEffect,
      ...bindingAuthorityAuditFields(bindingAuthority),
    });
    return {
      verdict: "deny",
      result: {
        kind: "git_push_denied",
        reason: "current Warden policy denies this exact git.push request",
      },
      auditSeq,
    };
  }
  const now = context.state.config.nowMs?.() ?? performance.now();
  const reviewId = `git_push_review_${String(context.state.nextReviewId)}`;
  context.state.nextReviewId += 1;
  const createdAtMs = now;
  const expiresAtMs = now + GIT_PUSH_REVIEW_TTL_MS;
  const generation = context.state.reviewGeneration;
  const summary = reviewSummary(facts);
  const pending: PendingGitPushReview = {
    kind: "git-push",
    reviewId,
    summary,
    allowCommand: `keel approve ${reviewId} --scope once`,
    createdAtMs,
    expiresAtMs,
    generation,
    bindingDigest: bindingDigest({
      executeParams,
      request,
      facts,
      reviewId,
      createdAtMs,
      expiresAtMs,
      generation,
      sandbox,
      auditDir: context.auditDir === undefined ? undefined : realpathSync(context.auditDir),
      bindingAuthority,
    }),
    executeParams,
    request,
    facts,
    bindingAuthority,
  };
  context.state.pending.set(reviewId, pending);
  let auditSeq: number;
  try {
    auditSeq = context.appendAudit({
      eventType: "review.requested",
      sessionId: executeParams.sessionId,
      payload: {
        reviewId,
        summary,
        ...auditIdentity(pending),
        createdAtMs,
        expiresAtMs,
      },
      ...bindingAuthorityAuditFields(bindingAuthority),
    });
  } catch (error) {
    context.state.pending.delete(reviewId);
    throw error;
  }
  return {
    verdict: "review",
    review: { reviewId, summary, allowCommand: pending.allowCommand },
    auditSeq,
  };
}

function resultPayload(
  review: PendingGitPushReview,
  status: "pushed" | "already-at-commit" | "failed" | "indeterminate",
  observedRef: string | null,
  actionMayHaveExecuted: boolean,
  failureKind?: "credential-unavailable",
): JsonObjectT {
  return {
    kind: "git_push_result",
    status,
    repository: review.facts.canonicalUrl,
    branch: review.request.branch,
    destinationRef: review.facts.destinationRef,
    commit: review.request.expectedHead,
    observedRef,
    transport: "srt:vendored verified HTTPS with address guard",
    automaticRetry: false,
    actionMayHaveExecuted,
    ...(failureKind === undefined ? {} : { failureKind }),
  };
}

interface ParsedRemoteRefs {
  readonly refs: Map<string, string>;
  readonly symrefs: Map<string, string>;
  readonly valid: boolean;
}

function isDefinitivePushRejection(
  push: SandboxExecutionResult,
  review: PendingGitPushReview,
): boolean {
  if (push.exitCode === null || push.exitCode === 0 || push.signal !== null) return false;
  const statusLines = push.stdout.split("\n").filter((line) => /^[- !+*=]\t/u.test(line));
  if (statusLines.length !== 1) return false;
  const columns = statusLines[0]!.split("\t");
  if (columns.length !== 3 || columns[0] !== "!") return false;
  if (columns[1] !== `${review.request.expectedHead}:${review.facts.destinationRef}`) return false;
  return /^\[(?:rejected|remote rejected)\] \([\x20-\x7e]{1,512}\)$/u.test(columns[2]!);
}

function parseRemoteRefs(
  output: string,
  objectFormat: "sha1" | "sha256",
  allowedRefs: ReadonlySet<string>,
): ParsedRemoteRefs {
  const refs = new Map<string, string>();
  const symrefs = new Map<string, string>();
  let valid = true;
  const oidLength = objectFormat === "sha1" ? 40 : 64;
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const columns = line.split("\t");
    if (columns.length !== 2) {
      valid = false;
      continue;
    }
    const [left, right] = columns as [string, string];
    if (!allowedRefs.has(right)) {
      valid = false;
      continue;
    }
    if (left.startsWith("ref: ")) {
      const target = left.slice("ref: ".length);
      if (right !== "HEAD" || !/^refs\/heads\/[\x21-\x7e]+$/u.test(target) || symrefs.has(right)) {
        valid = false;
        continue;
      }
      symrefs.set(right, target);
      continue;
    }
    if (left.length !== oidLength || !FULL_OID.test(left) || refs.has(right)) {
      valid = false;
      continue;
    }
    refs.set(right, left);
  }
  return { refs, symrefs, valid };
}

function boundedGitFailureDiagnostic(stderr: string): JsonObjectT {
  const lower = stderr.toLowerCase();
  const kind =
    [
      ["operation not permitted", "operation-not-permitted"],
      ["could not resolve host", "host-resolution"],
      ["failed to connect", "connect-failed"],
      ["ssl certificate problem", "tls-verification"],
      ["proxy", "proxy-failed"],
      ["not found", "not-found"],
      ["unable to access", "remote-access"],
      ["bad config", "git-config"],
    ].find(([needle]) => lower.includes(needle!))?.[1] ?? "unclassified";
  return {
    kind,
    indicators: [
      ["unable to fork", "unable-to-fork"],
      ["cannot spawn", "cannot-spawn"],
      ["cannot exec", "cannot-exec"],
      ["git-remote-https", "remote-helper"],
      ["getaddrinfo() thread failed to start", "resolver-thread"],
      ["could not resolve proxy", "proxy-resolution"],
      ["couldn't connect", "connect"],
      ["cannot open", "cannot-open"],
      ["permission denied", "permission-denied"],
      ["failed to start", "failed-to-start"],
      ["library not loaded", "library-load"],
      ["certificate", "certificate"],
      ["/dev/null", "dev-null"],
      ["index.lock", "index-lock"],
      ["config.lock", "config-lock"],
      [".gitconfig", "gitconfig"],
      ["alternates", "alternates"],
      ["proxy", "proxy"],
    ]
      .filter(([needle]) => lower.includes(needle!))
      .map(([, indicator]) => indicator!),
    digest: `sha256:${createHash("sha256").update(stderr).digest("hex")}`,
    bytes: Buffer.byteLength(stderr, "utf8"),
  };
}

function credentialBrokerForConfig(config: GitPushRuntimeConfig): GitCredentialBroker | undefined {
  const production = productionConfig(config);
  if (production !== undefined) return production.credentialBroker;
  if (
    !(typeof __KEEL_RELEASE_BUILD__ === "undefined" || __KEEL_RELEASE_BUILD__ !== true) ||
    !isFixtureConfig(config)
  )
    return undefined;
  return config.fixture.credentialSourceClass === "operator-git-credential-helper"
    ? config.fixture.credentialBroker
    : undefined;
}

function credentialContextForReview(review: PendingGitPushReview): GitCredentialContext {
  return {
    protocol: "https",
    host: review.facts.host,
    path: new URL(review.facts.canonicalUrl).pathname.slice(1),
  };
}

async function resolveCredentialAuthorization(
  context: GitPushRuntimeContext,
  review: PendingGitPushReview,
): Promise<GitCredentialAuthorization> {
  const config = context.state.config;
  if (
    (typeof __KEEL_RELEASE_BUILD__ === "undefined" || __KEEL_RELEASE_BUILD__ !== true) &&
    isFixtureConfig(config) &&
    config.fixture.credentialSourceClass === "deterministic-test-provider"
  ) {
    return {
      scheme: "Basic",
      secret: Buffer.from(`${config.fixture.username}:${config.fixture.secret}`, "utf8").toString(
        "base64",
      ),
    };
  }
  const broker = credentialBrokerForConfig(config);
  const identity = review.facts.credentialBrokerIdentity;
  if (broker === undefined || identity === undefined) {
    throw new Error("git.push credential broker identity is unavailable");
  }
  return await broker.resolve(credentialContextForReview(review), identity, context.signal);
}

function sandboxCredential(
  config: GitPushRuntimeConfig,
  review: PendingGitPushReview,
  attemptRoot: string,
  authorization: GitCredentialAuthorization,
): SandboxCredentialProxyConfig {
  const home = join(attemptRoot, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    authorizationHeaders: [
      {
        host: review.facts.host,
        scheme: authorization.scheme,
        secret: authorization.secret,
      },
    ],
    sandboxEnv: {
      PATH: fixedGitPath(config.gitExecutable),
      HOME: home,
      XDG_CONFIG_HOME: home,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_COUNT: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TRACE: "0",
      GIT_TRACE_PACKET: "0",
      GIT_TRACE_CURL: "0",
      GIT_CURL_VERBOSE: "0",
    },
  };
}

function baseGitArgs(gitDir: string): string[] {
  return [
    "--no-pager",
    `--git-dir=${gitDir}`,
    "-c",
    "credential.helper=",
    "-c",
    "credential.interactive=never",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "http.followRedirects=false",
    "-c",
    "http.sslVerify=true",
    "-c",
    "http.maxRequests=1",
    "-c",
    "http.extraHeader=",
    "-c",
    "push.followTags=false",
    "-c",
    "push.gpgSign=false",
    "-c",
    "push.pushOption=",
    "-c",
    "push.useForceIfIncludes=false",
    "-c",
    "push.negotiate=false",
    "-c",
    "push.autoSetupRemote=false",
    "-c",
    "submodule.recurse=false",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
  ];
}

function gitProfile(
  review: PendingGitPushReview,
  attemptRoot: string,
  auditDir: string | undefined,
): SandboxProfile {
  return {
    filesystem: {
      allowRead: [
        review.facts.objectStore,
        attemptRoot,
        review.facts.gitExecutable.path,
        ...((typeof __KEEL_RELEASE_BUILD__ === "undefined" || __KEEL_RELEASE_BUILD__ !== true) &&
        review.facts.envExecutable !== undefined
          ? [review.facts.envExecutable.path]
          : []),
      ],
      allowWrite: [attemptRoot],
      denyRead: [],
      denyWrite: [
        review.facts.workspaceRoot,
        ...(auditDir === undefined ? [] : [realpathSync(auditDir)]),
      ],
    },
    network: {
      allowedDomains: [review.facts.host],
      deniedDomains: [],
      strictAllowlist: true,
    },
  };
}

async function runSandboxGit(
  context: GitPushRuntimeContext,
  review: PendingGitPushReview,
  attemptRoot: string,
  gitDir: string,
  args: readonly string[],
  authorization: GitCredentialAuthorization,
): Promise<SandboxExecutionResult> {
  const timeout = AbortSignal.timeout(30_000);
  const signal =
    context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
  const invocation =
    !(typeof __KEEL_RELEASE_BUILD__ === "undefined" || __KEEL_RELEASE_BUILD__ !== true) ||
    review.facts.envExecutable === undefined
      ? {
          command: review.facts.gitExecutable.path,
          argv: [review.facts.gitExecutable.path, ...baseGitArgs(gitDir), ...args],
          cwd: attemptRoot,
        }
      : {
          // SRT intentionally bypasses its proxy for localhost by default. The injected fixture
          // must traverse that proxy so verified TLS, credential injection, and the address guard
          // remain real; clear only the child bypass variables for this exact non-release call.
          command: review.facts.envExecutable.path,
          argv: [
            review.facts.envExecutable.path,
            "NO_PROXY=",
            "no_proxy=",
            review.facts.gitExecutable.path,
            ...baseGitArgs(gitDir),
            ...args,
          ],
          cwd: attemptRoot,
        };
  return await context.sandbox.execute(
    invocation,
    gitProfile(review, attemptRoot, context.auditDir),
    {
      signal,
      credentialProxy: sandboxCredential(context.state.config, review, attemptRoot, authorization),
    },
  );
}

async function initializeAttemptRepo(
  context: GitPushRuntimeContext,
  review: PendingGitPushReview,
): Promise<{ readonly attemptRoot: string; readonly gitDir: string }> {
  const tempRoot = realpathSync(context.state.config.tempRoot);
  if (tempRoot !== review.facts.tempRoot)
    throw new Error("git.push temporary root identity changed");
  const attemptRoot = mkdtempSync(join(tempRoot, "attempt-"));
  try {
    chmodSync(attemptRoot, 0o700);
    const gitDir = join(attemptRoot, "repo.git");
    const emptyTemplate = join(attemptRoot, "empty-template");
    mkdirSync(emptyTemplate, { mode: 0o700 });
    await runContainedGit(
      context,
      [
        "init",
        "--quiet",
        "--bare",
        `--template=${emptyTemplate}`,
        `--object-format=${review.facts.objectFormat}`,
        gitDir,
      ],
      { cwd: attemptRoot, allowWorkspaceRead: false, writeRoot: attemptRoot },
    );
    const alternatesDir = join(gitDir, "objects", "info");
    mkdirSync(alternatesDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(alternatesDir, "alternates"), `${review.facts.objectStore}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { attemptRoot, gitDir };
  } catch (error) {
    // The caller cannot own this path until initialization returns. Close that gap locally so every
    // post-mkdtemp failure either removes the attempt or quarantines the authority through the same
    // non-overriding cleanup owner used after network execution.
    cleanupAttemptRoot(context.state, attemptRoot);
    throw error;
  }
}

function auditOutcome(
  context: GitPushRuntimeContext,
  review: PendingGitPushReview,
  payload: JsonObjectT,
  actionMayHaveExecuted = false,
): number {
  return context.appendAudit(
    {
      eventType: "tool.execute",
      sessionId: review.executeParams.sessionId,
      payload: {
        toolName: GIT_PUSH_TOOL_NAME,
        args: review.executeParams.toolCall.args,
        reviewId: review.reviewId,
        ...auditIdentity(review),
        ...payload,
      },
      sideEffect: gitPushSideEffect(review.facts),
      ...bindingAuthorityAuditFields(review.bindingAuthority),
    },
    actionMayHaveExecuted ? { actionMayHaveExecuted: true } : undefined,
  );
}

export async function resolveGitPushReview(
  context: GitPushRuntimeContext,
  review: PendingGitPushReview,
  resolution: GitPushResolveParams,
): Promise<GitPushRpcResult> {
  const now = context.state.config.nowMs?.() ?? performance.now();
  const scopeAccepted = resolution.scope === "once";
  const unexpired = now < review.expiresAtMs;
  const currentGeneration = review.generation === context.state.reviewGeneration;
  const approved = resolution.approved === true && scopeAccepted && unexpired && currentGeneration;
  const resolutionReason = !resolution.approved
    ? "human-denied"
    : !scopeAccepted
      ? "once-scope-required"
      : !unexpired
        ? "expired"
        : !currentGeneration
          ? "stale-generation"
          : "approved-once";
  const resolutionAuditSeq = context.appendAudit({
    eventType: "review.resolved",
    sessionId: review.executeParams.sessionId,
    payload: {
      reviewId: review.reviewId,
      approved,
      requestedApproval: resolution.approved,
      requestedScope: resolution.scope ?? null,
      principal: resolution.principal.osUser,
      bindingDigest: review.bindingDigest,
      resolvedAtMs: now,
      resolutionReason,
      terminal: true,
    },
    ...bindingAuthorityAuditFields(review.bindingAuthority),
  });
  if (!resolution.approved) {
    return {
      verdict: "deny",
      result: { kind: "git_push_denied", reason: "human denied" },
      auditSeq: resolutionAuditSeq,
    };
  }
  if (resolution.scope !== "once") {
    return {
      verdict: "deny",
      result: { kind: "git_push_denied", reason: "git.push accepts once-only approval" },
      auditSeq: resolutionAuditSeq,
    };
  }
  if (now >= review.expiresAtMs) {
    return {
      verdict: "deny",
      result: { kind: "git_push_denied", reason: "git.push review expired" },
      auditSeq: resolutionAuditSeq,
    };
  }
  if (!currentGeneration) {
    return {
      verdict: "deny",
      result: {
        kind: "git_push_denied",
        reason: "git.push review is stale; submit a fresh request",
      },
      auditSeq: resolutionAuditSeq,
    };
  }
  context.state.reviewGeneration += 1;
  context.state.pending.clear();
  try {
    context.preExecutionCheck?.();
  } catch (error) {
    const auditSeq = context.appendAudit({
      eventType: "tool.deny",
      sessionId: review.executeParams.sessionId,
      payload: {
        toolName: GIT_PUSH_TOOL_NAME,
        args: review.executeParams.toolCall.args,
        reviewId: review.reviewId,
        reason: "sandbox temporary authority changed after approval",
        bindingDigest: review.bindingDigest,
        errorClass: error instanceof Error ? error.name : "unknown",
        actionMayHaveExecuted: false,
      },
      sideEffect: gitPushSideEffect(review.facts),
      ...bindingAuthorityAuditFields(review.bindingAuthority),
    });
    return {
      verdict: "deny",
      result: {
        kind: "git_push_denied",
        reason: "sandbox temporary authority changed; submit a fresh request",
      },
      auditSeq,
    };
  }
  const sandbox = context.sandbox.status();
  let refreshedFacts: GitPushFacts;
  let refreshedBindingAuthority: GitPushBindingAuthority;
  try {
    refreshedFacts = await inspectGitPushFacts(context, context.workspaceRoot, review.request);
    const refreshedSideEffect = gitPushSideEffect(refreshedFacts);
    refreshedBindingAuthority = await context.resolveBindingAuthority({
      executeParams: review.executeParams,
      sideEffect: refreshedSideEffect,
      canonicalUrl: refreshedFacts.canonicalUrl,
      host: refreshedFacts.host,
    });
    validateBindingAuthority(
      context,
      review.executeParams,
      refreshedFacts,
      refreshedSideEffect,
      refreshedBindingAuthority,
    );
  } catch (error) {
    const auditSeq = context.appendAudit({
      eventType: "tool.deny",
      sessionId: review.executeParams.sessionId,
      payload: {
        toolName: GIT_PUSH_TOOL_NAME,
        args: review.executeParams.toolCall.args,
        reviewId: review.reviewId,
        reason: "git.push revalidation failed",
        bindingDigest: review.bindingDigest,
        errorClass: error instanceof Error ? error.name : "unknown",
        actionMayHaveExecuted: false,
      },
      sideEffect: gitPushSideEffect(review.facts),
      ...bindingAuthorityAuditFields(review.bindingAuthority),
    });
    return {
      verdict: "deny",
      result: { kind: "git_push_denied", reason: "request facts changed; submit a fresh request" },
      auditSeq,
    };
  }
  const refreshedDigest = bindingDigest({
    executeParams: review.executeParams,
    request: review.request,
    facts: refreshedFacts,
    reviewId: review.reviewId,
    createdAtMs: review.createdAtMs,
    expiresAtMs: review.expiresAtMs,
    generation: review.generation,
    sandbox,
    auditDir: context.auditDir === undefined ? undefined : realpathSync(context.auditDir),
    bindingAuthority: refreshedBindingAuthority,
  });
  if (refreshedDigest !== review.bindingDigest) {
    const auditSeq = context.appendAudit({
      eventType: "tool.deny",
      sessionId: review.executeParams.sessionId,
      payload: {
        toolName: GIT_PUSH_TOOL_NAME,
        args: review.executeParams.toolCall.args,
        reviewId: review.reviewId,
        reason: "git.push binding changed after approval",
        bindingDigest: review.bindingDigest,
      },
      sideEffect: gitPushSideEffect(review.facts),
      ...bindingAuthorityAuditFields(refreshedBindingAuthority),
    });
    return {
      verdict: "deny",
      result: { kind: "git_push_denied", reason: "request facts changed; submit a fresh request" },
      auditSeq,
    };
  }
  // Durable intent precedes credential materialization and the first network operation.
  auditOutcome(context, review, { execution: "requested", outcomeKnown: false });

  let attemptRoot: string | undefined;
  let mutationAttempted = false;
  try {
    const authorization = await resolveCredentialAuthorization(context, review);
    const initialized = await initializeAttemptRepo(context, review);
    attemptRoot = initialized.attemptRoot;
    const preflight = await runSandboxGit(
      context,
      review,
      attemptRoot,
      initialized.gitDir,
      ["ls-remote", "--symref", review.facts.canonicalUrl, "HEAD", review.facts.destinationRef],
      authorization,
    );
    if (preflight.exitCode !== 0) {
      const result = resultPayload(review, "failed", null, false);
      const auditSeq = auditOutcome(context, review, {
        result,
        phase: "remote-preflight",
        childExitCode: preflight.exitCode,
        failureDiagnostic: boundedGitFailureDiagnostic(preflight.stderr),
      });
      return {
        verdict: "deny",
        result,
        auditSeq,
      };
    }
    const preflightRefs = parseRemoteRefs(
      preflight.stdout,
      review.facts.objectFormat,
      new Set(["HEAD", review.facts.destinationRef]),
    );
    if (!preflightRefs.valid) {
      const result = resultPayload(review, "failed", null, false);
      const auditSeq = auditOutcome(context, review, {
        result,
        phase: "remote-preflight",
        childExitCode: preflight.exitCode,
        invalidRemoteObservation: true,
      });
      return { verdict: "deny", result, auditSeq };
    }
    const defaultBranch = preflightRefs.symrefs.get("HEAD");
    if (defaultBranch === undefined || defaultBranch === review.facts.destinationRef) {
      const result = resultPayload(
        review,
        "failed",
        preflightRefs.refs.get(review.facts.destinationRef) ?? null,
        false,
      );
      const auditSeq = context.appendAudit({
        eventType: "tool.deny",
        sessionId: review.executeParams.sessionId,
        payload: {
          toolName: GIT_PUSH_TOOL_NAME,
          args: review.executeParams.toolCall.args,
          reviewId: review.reviewId,
          reason:
            defaultBranch === undefined
              ? "remote default branch identity is unavailable"
              : "remote default branch writes are blocked",
          result,
        },
        sideEffect: gitPushSideEffect(review.facts),
        ...bindingAuthorityAuditFields(review.bindingAuthority),
      });
      return {
        verdict: "deny",
        result,
        auditSeq,
      };
    }
    const before = preflightRefs.refs.get(review.facts.destinationRef) ?? null;
    if (before === review.request.expectedHead) {
      const result = resultPayload(review, "already-at-commit", before, false);
      const auditSeq = auditOutcome(context, review, { result, phase: "preflight" });
      return { verdict: "allow", result, auditSeq };
    }
    mutationAttempted = true;
    const push = await runSandboxGit(
      context,
      review,
      attemptRoot,
      initialized.gitDir,
      [
        "push",
        "--porcelain",
        "--no-verify",
        "--recurse-submodules=no",
        review.facts.canonicalUrl,
        `${review.request.expectedHead}:${review.facts.destinationRef}`,
      ],
      authorization,
    );
    const verification = await runSandboxGit(
      context,
      review,
      attemptRoot,
      initialized.gitDir,
      ["ls-remote", review.facts.canonicalUrl, review.facts.destinationRef],
      authorization,
    );
    if (verification.exitCode !== 0) {
      const result = resultPayload(review, "indeterminate", null, true);
      const auditSeq = auditOutcome(
        context,
        review,
        {
          result,
          phase: "verification",
          pushExitCode: push.exitCode,
          verificationExitCode: verification.exitCode,
          actionMayHaveExecuted: true,
        },
        true,
      );
      return {
        verdict: "deny",
        result,
        auditSeq,
      };
    }
    const verificationRefs = parseRemoteRefs(
      verification.stdout,
      review.facts.objectFormat,
      new Set([review.facts.destinationRef]),
    );
    const observed = verificationRefs.valid
      ? (verificationRefs.refs.get(review.facts.destinationRef) ?? null)
      : null;
    // Exact observation proves success. A strict porcelain rejection for this one exact ref plus a
    // valid different/absent observation proves failure. Exit status or free-form diagnostics alone
    // cannot exclude a lost response followed by a concurrent ref move, so all other states remain
    // indeterminate.
    const definitiveRejection =
      verificationRefs.valid &&
      observed !== review.request.expectedHead &&
      isDefinitivePushRejection(push, review);
    const status =
      verificationRefs.valid && observed === review.request.expectedHead
        ? "pushed"
        : definitiveRejection
          ? "failed"
          : "indeterminate";
    const actionMayHaveExecuted = status === "indeterminate";
    const result = resultPayload(review, status, observed, actionMayHaveExecuted);
    const auditSeq = auditOutcome(
      context,
      review,
      {
        result,
        phase: "verified",
        pushExitCode: push.exitCode,
        verificationExitCode: verification.exitCode,
      },
      status !== "failed",
    );
    return status === "pushed"
      ? { verdict: "allow", result, auditSeq }
      : {
          verdict: "deny",
          result,
          auditSeq,
        };
  } catch (error) {
    if (context.isAuditFailure?.(error) === true) throw error;
    const status = mutationAttempted ? "indeterminate" : "failed";
    const failureKind =
      !mutationAttempted && error instanceof GitCredentialBrokerError
        ? "credential-unavailable"
        : undefined;
    const result = resultPayload(review, status, null, mutationAttempted, failureKind);
    const auditSeq = auditOutcome(
      context,
      review,
      {
        result,
        phase: "exception",
        actionMayHaveExecuted: mutationAttempted,
        errorClass: error instanceof Error ? error.name : "unknown",
      },
      mutationAttempted,
    );
    return {
      verdict: "deny",
      result,
      auditSeq,
    };
  } finally {
    if (attemptRoot !== undefined) cleanupAttemptRoot(context.state, attemptRoot);
  }
}

export function isGitPushReviewId(value: string): boolean {
  return REVIEW_ID.test(value);
}

function createGitPushAuthority(config: GitPushRuntimeConfig): GitPushAuthority {
  const state = createGitPushRuntimeState(config);
  const consumedReviews = new WeakSet<PendingGitPushReview>();
  const runtimeContext = (context: GitPushAuthorityContext): GitPushRuntimeContext => ({
    ...context,
    state,
  });
  return {
    capability: GIT_PUSH_CAPABILITY_V1,
    toolName: GIT_PUSH_TOOL_NAME,
    transportRequirements: { credentialTlsTermination: true },
    capabilityAvailable: (input) => gitPushCapabilityAvailable(state, input),
    pendingReviewCount: () => state.pending.size,
    hasPendingReview: (reviewId) => state.pending.has(reviewId),
    request: (context, params) => requestGitPushReview(runtimeContext(context), params),
    consumeReview: (reviewId) => {
      const review = state.pending.get(reviewId);
      if (review === undefined) return undefined;
      state.pending.delete(reviewId);
      consumedReviews.add(review);
      return review;
    },
    resolve: async (context, opaqueReview, params) => {
      const review = opaqueReview as PendingGitPushReview;
      if (!consumedReviews.delete(review)) {
        throw new Error("git.push review was not consumed by this authority");
      }
      return await resolveGitPushReview(runtimeContext(context), review, params);
    },
    isInvalidParams: (error): error is GitPushInvalidParamsError =>
      error instanceof GitPushInvalidParamsError,
    auditInvalidParams: (context, params, error) => {
      if (!(error instanceof GitPushInvalidParamsError)) {
        throw new Error("git.push authority received a non-parameter error for denial audit");
      }
      return auditGitPushInvalidParams(runtimeContext(context), params, error);
    },
  };
}

/** Construct the non-release Slice-1 authority from fixture-owned process state. */
export function createGitPushWalkingSkeletonAuthority(
  config: GitPushWalkingSkeletonConfig,
): GitPushAuthority {
  return createGitPushAuthority(config);
}

/** Construct the strict default-port production authority for the trusted enforcing product path. */
export function createGitPushProductionAuthority(
  config: GitPushProductionConfig,
): GitPushAuthority {
  return createGitPushAuthority(config);
}
