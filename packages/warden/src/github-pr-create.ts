import { Buffer } from "node:buffer";
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
import { performance } from "node:perf_hooks";
import {
  canonicalize,
  JsonObject,
  supportedGitPushVersion,
  type JsonObjectT,
  type SideEffectT,
} from "@keel/shared";
import type { AuditAppendInput } from "./audit/writer.js";
import type {
  GitCredentialBearerAuthorization,
  GitCredentialBroker,
  GitCredentialBrokerIdentity,
  GitCredentialContext,
} from "./git-credential-broker.js";
import {
  GITHUB_PR_CREATE_CAPABILITY_V1,
  GITHUB_PR_CREATE_TOOL_NAME,
  type GithubPrCreateAuthority,
  type GithubPrCreateAuthorityContext,
  type GithubPrCreateBindingAuthority,
  type GithubPrCreateExecuteParams,
  type GithubPrCreatePendingReview,
  type GithubPrCreateResolveParams,
  type GithubPrCreateRpcResult,
} from "./github-pr-create-authority.js";
import {
  CREDENTIAL_TLS_TERMINATION_CAPABILITY,
  EGRESS_ADDRESS_GUARD_CAPABILITY,
  type SandboxCredentialProxyConfig,
  type SandboxExecutionResult,
  type SandboxProfile,
  type SandboxStatus,
} from "./sandbox.js";

export {
  GITHUB_PR_CREATE_CAPABILITY_V1,
  GITHUB_PR_CREATE_TOOL_NAME,
  type GithubPrCreateExecuteParams,
  type GithubPrCreateResolveParams,
  type GithubPrCreateRpcResult,
};
export const GITHUB_PR_CREATE_REVIEW_TTL_MS = 120_000;
export const GITHUB_PR_CREATE_REVIEW_MAX_BYTES = 2_048;
export const GITHUB_PR_CREATE_REVIEW_MAX_CELLS = 2_048;

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/u;
const BRANCH_ASCII = /^[\x21-\x7e]{1,128}$/u;
const FULL_SHA1 = /^[0-9a-f]{40}$/u;

export interface GithubPrCreateRequest {
  readonly remote: string;
  readonly repository: string;
  readonly head: string;
  readonly expectedHead: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly maintainerCanModify: boolean;
}

export class GithubPrCreateInvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubPrCreateInvalidParamsError";
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function validBranchShape(value: unknown): value is string {
  return (
    typeof value === "string" &&
    BRANCH_ASCII.test(value) &&
    value !== "HEAD" &&
    value !== "@" &&
    !value.startsWith("refs/") &&
    !value.startsWith(".") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !/[\\~^:?*[\]]/u.test(value)
  );
}

function validRepositoryShape(value: unknown): value is string {
  if (typeof value !== "string" || !REPOSITORY.test(value)) return false;
  const name = value.slice(value.indexOf("/") + 1);
  return name !== "." && name !== ".." && !name.startsWith("-") && !name.endsWith(".");
}

/** Strict independent parser; model JSON Schema is projection guidance only. */
export function parseGithubPrCreateRequest(args: JsonObjectT): GithubPrCreateRequest {
  const expectedKeys = [
    "base",
    "body",
    "draft",
    "expectedHead",
    "head",
    "maintainerCanModify",
    "remote",
    "repository",
    "title",
  ];
  if (Object.keys(args).sort().join("\u0000") !== expectedKeys.join("\u0000")) {
    throw new GithubPrCreateInvalidParamsError(
      "github.pr.create requires exactly remote, repository, head, expectedHead, base, title, body, draft, and maintainerCanModify",
    );
  }
  const remote = args["remote"];
  const repository = args["repository"];
  const head = args["head"];
  const expectedHead = args["expectedHead"];
  const base = args["base"];
  const title = args["title"];
  const body = args["body"];
  const draft = args["draft"];
  const maintainerCanModify = args["maintainerCanModify"];
  if (typeof remote !== "string" || !REMOTE_NAME.test(remote)) {
    throw new GithubPrCreateInvalidParamsError("remote is not one bounded repository-local name");
  }
  if (!validRepositoryShape(repository)) {
    throw new GithubPrCreateInvalidParamsError("repository must be one exact GitHub owner/name");
  }
  if (!validBranchShape(head) || !validBranchShape(base) || head === base) {
    throw new GithubPrCreateInvalidParamsError(
      "head and base must be distinct bounded ASCII short branch names",
    );
  }
  if (typeof expectedHead !== "string" || !FULL_SHA1.test(expectedHead)) {
    throw new GithubPrCreateInvalidParamsError(
      "expectedHead must be one full lowercase 40-hex GitHub commit OID",
    );
  }
  if (
    typeof title !== "string" ||
    title === "" ||
    Buffer.byteLength(title, "utf8") > 256 ||
    hasUnpairedSurrogate(title) ||
    typeof body !== "string" ||
    Buffer.byteLength(body, "utf8") > 1_536 ||
    hasUnpairedSurrogate(body)
  ) {
    throw new GithubPrCreateInvalidParamsError(
      "title/body must be valid bounded Unicode text for lossless approval",
    );
  }
  if (typeof draft !== "boolean" || typeof maintainerCanModify !== "boolean") {
    throw new GithubPrCreateInvalidParamsError(
      "draft and maintainerCanModify must be explicit booleans",
    );
  }
  return {
    remote,
    repository,
    head,
    expectedHead,
    base,
    title,
    body,
    draft,
    maintainerCanModify,
  };
}

function escapeCodeUnit(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

/** Deterministic JSON-string presentation that also escapes invisible format/bidi controls. */
export function escapeGithubReviewText(value: string): string {
  if (hasUnpairedSurrogate(value)) {
    throw new GithubPrCreateInvalidParamsError("review text contains an unpaired surrogate");
  }
  let escaped = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const char = value[index]!;
    if (char === '"') escaped += '\\"';
    else if (char === "\\") escaped += "\\\\";
    else if (char === "\b") escaped += "\\b";
    else if (char === "\f") escaped += "\\f";
    else if (char === "\n") escaped += "\\n";
    else if (char === "\r") escaped += "\\r";
    else if (char === "\t") escaped += "\\t";
    else if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      /\p{Cf}/u.test(char)
    ) {
      escaped += escapeCodeUnit(code);
    } else escaped += char;
  }
  return `${escaped}"`;
}

export function githubPrCreateReviewSummary(input: {
  readonly request: GithubPrCreateRequest;
  readonly canonicalRemote: string;
  readonly credentialSourceClass: "operator Git credential helper (system/global config)";
}): string {
  const request = input.request;
  const summary = [
    "GitHub pull request creation requires approval.",
    `Repository: ${request.repository}`,
    `Remote: ${input.canonicalRemote}`,
    `Head: refs/heads/${request.head} @ ${request.expectedHead}`,
    `Base: refs/heads/${request.base}`,
    `Title JSON: ${escapeGithubReviewText(request.title)}`,
    `Body JSON: ${escapeGithubReviewText(request.body)}`,
    `Draft: ${request.draft ? "yes" : "no"}`,
    `Maintainers may modify: ${request.maintainerCanModify ? "yes" : "no"}`,
    "Effect: create one GitHub pull request and trigger repository notifications",
    "Blocked: merge, auto-merge, labels, reviews, releases, deployments, and branch mutation",
    `Credential: ${input.credentialSourceClass}; token stays in the Warden/SRT path`,
    "Approval: this occurrence once; expires in 120 seconds",
  ].join("\n");
  if (
    Buffer.byteLength(summary, "utf8") > GITHUB_PR_CREATE_REVIEW_MAX_BYTES ||
    [...summary].length > GITHUB_PR_CREATE_REVIEW_MAX_CELLS
  ) {
    throw new GithubPrCreateInvalidParamsError(
      "complete pull request approval exceeds the 2,048-cell review surface",
    );
  }
  return summary;
}

export function githubPrCreateCapabilityAvailable(input: {
  readonly workspaceTrusted: boolean;
  readonly auditAvailable: boolean;
  readonly authorityHealthy: boolean;
  readonly sandbox: SandboxStatus;
}): boolean {
  return (
    input.workspaceTrusted &&
    input.auditAvailable &&
    input.authorityHealthy &&
    input.sandbox.available &&
    input.sandbox.backend === "srt:vendored" &&
    input.sandbox.enforcementTier === "sandbox:srt" &&
    input.sandbox.features?.includes(EGRESS_ADDRESS_GUARD_CAPABILITY) === true &&
    input.sandbox.features?.includes(CREDENTIAL_TLS_TERMINATION_CAPABILITY) === true
  );
}

declare const __KEEL_RELEASE_BUILD__: boolean | undefined;

const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_API_HOST = "api.github.com";
const GITHUB_API_ORIGIN = "https://api.github.com";
const REVIEW_ID = /^github_pr_create_review_[1-9]\d{0,15}$/u;
const MAX_GIT_OUTPUT_BYTES = 64 * 1_024;
const MAX_GIT_CONFIG_BYTES = 64 * 1_024;
const MAX_API_RESPONSE_BYTES = 1 * 1_024 * 1_024;

interface GithubFixtureApi {
  readonly origin: string;
  readonly host: "localhost";
  readonly port: number;
  readonly address: "127.0.0.1";
}

interface GithubPrCreateBaseConfig {
  readonly credentialBroker: GitCredentialBroker & {
    resolveBearer: NonNullable<GitCredentialBroker["resolveBearer"]>;
  };
  readonly gitExecutable: string;
  readonly gitVersion: string;
  readonly curlExecutable: string;
  readonly curlVersion: string;
  readonly tempRoot: string;
  readonly nowMs?: () => number;
}

export interface GithubPrCreateWalkingSkeletonConfig extends GithubPrCreateBaseConfig {
  readonly advertiseTestCapability: true;
  readonly fixtureApi: GithubFixtureApi;
  readonly cleanupAttemptRoot?: (path: string) => void;
}

export interface GithubPrCreateProductionConfig extends GithubPrCreateBaseConfig {
  readonly productionCapability: true;
}

export type GithubPrCreateRuntimeConfig =
  | GithubPrCreateWalkingSkeletonConfig
  | GithubPrCreateProductionConfig;

interface FileIdentity {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly modifiedNs: string;
}

interface ConfigIdentity extends FileIdentity {
  readonly digest: string;
}

interface GithubPrCreateFacts {
  readonly workspaceRoot: string;
  readonly workspaceIdentity: FileIdentity;
  readonly gitDir: string;
  readonly gitDirIdentity: FileIdentity;
  readonly configIdentity: ConfigIdentity;
  readonly gitExecutable: FileIdentity;
  readonly gitVersion: string;
  readonly curlExecutable: FileIdentity;
  readonly curlVersion: string;
  readonly tempRoot: string;
  readonly tempRootIdentity: FileIdentity;
  readonly canonicalRemote: string;
  readonly apiOrigin: string;
  readonly apiHost: string;
  readonly apiPullsUrl: string;
  readonly credentialBrokerIdentity: GitCredentialBrokerIdentity;
}

interface PendingGithubPrCreateReview extends GithubPrCreatePendingReview {
  readonly kind: "github-pr-create";
  readonly reviewId: string;
  readonly summary: string;
  readonly allowCommand: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly generation: number;
  readonly bindingDigest: string;
  readonly executeParams: GithubPrCreateExecuteParams;
  readonly request: GithubPrCreateRequest;
  readonly facts: GithubPrCreateFacts;
  readonly bindingAuthority: GithubPrCreateBindingAuthority;
}

interface GithubPrCreateRuntimeState {
  readonly config: GithubPrCreateRuntimeConfig;
  readonly pending: Map<string, PendingGithubPrCreateReview>;
  nextReviewId: number;
  reviewGeneration: number;
  cleanupHealthy: boolean;
}

interface GithubPrCreateRuntimeContext extends GithubPrCreateAuthorityContext {
  readonly state: GithubPrCreateRuntimeState;
}

function isFixtureConfig(
  config: GithubPrCreateRuntimeConfig,
): config is GithubPrCreateWalkingSkeletonConfig {
  return !("productionCapability" in config);
}

function exactFileIdentity(path: string): FileIdentity {
  const canonical = realpathSync(path);
  const entry = lstatSync(canonical);
  const stat = statSync(canonical, { bigint: true });
  if (!entry.isFile() && !entry.isDirectory()) {
    throw new GithubPrCreateInvalidParamsError(
      "authority identity is not an ordinary file or directory",
    );
  }
  return {
    path: canonical,
    device: String(stat.dev),
    inode: String(stat.ino),
    size: String(stat.size),
    modifiedNs: String(stat.mtimeNs),
  };
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function supportedCurlVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 7 && minor >= 61) || major === 8;
}

function validateRuntimeConfig(config: GithubPrCreateRuntimeConfig): void {
  if (
    config.credentialBroker.sourceClass !==
      "operator Git credential helper (system/global config)" ||
    supportedGitPushVersion(`git version ${config.gitVersion}`) !== config.gitVersion ||
    !supportedCurlVersion(config.curlVersion)
  ) {
    throw new Error("invalid github.pr.create executable or credential authority");
  }
  const git = realpathSync(config.gitExecutable);
  const curl = realpathSync(config.curlExecutable);
  if (!lstatSync(git).isFile() || !lstatSync(curl).isFile()) {
    throw new Error("github.pr.create executables must be ordinary files");
  }
  const tempRoot = realpathSync(config.tempRoot);
  const tempStat = statSync(tempRoot);
  if (!tempStat.isDirectory() || (tempStat.mode & 0o077) !== 0) {
    throw new Error("github.pr.create temporary root must be owner-only");
  }
  if (!(typeof __KEEL_RELEASE_BUILD__ === "undefined" || __KEEL_RELEASE_BUILD__ !== true)) {
    if ((config as GithubPrCreateProductionConfig).productionCapability !== true) {
      throw new Error("invalid production github.pr.create authority");
    }
    return;
  }
  const production = isFixtureConfig(config) ? undefined : config;
  if (production !== undefined) {
    if (production.productionCapability !== true) {
      throw new Error("invalid production github.pr.create authority");
    }
    return;
  }
  if (!isFixtureConfig(config) || config.advertiseTestCapability !== true) {
    throw new Error("invalid release-withheld github.pr.create fixture");
  }
  const fixture = config.fixtureApi;
  const parsed = new URL(fixture.origin);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== fixture.host ||
    parsed.port !== String(fixture.port) ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    fixture.host !== "localhost" ||
    fixture.address !== "127.0.0.1" ||
    !Number.isInteger(fixture.port) ||
    fixture.port < 1 ||
    fixture.port > 65_535
  ) {
    throw new Error("invalid release-withheld github.pr.create fixture API");
  }
}

function createRuntimeState(config: GithubPrCreateRuntimeConfig): GithubPrCreateRuntimeState {
  validateRuntimeConfig(config);
  return {
    config,
    pending: new Map(),
    nextReviewId: 1,
    reviewGeneration: 1,
    cleanupHealthy: true,
  };
}

function apiAuthority(config: GithubPrCreateRuntimeConfig): {
  readonly origin: string;
  readonly host: string;
} {
  if (!(typeof __KEEL_RELEASE_BUILD__ === "undefined" || __KEEL_RELEASE_BUILD__ !== true)) {
    return { origin: GITHUB_API_ORIGIN, host: GITHUB_API_HOST };
  }
  return isFixtureConfig(config)
    ? { origin: config.fixtureApi.origin, host: config.fixtureApi.host }
    : { origin: GITHUB_API_ORIGIN, host: GITHUB_API_HOST };
}

function fixedExecutablePath(executable: string): string {
  return [dirname(realpathSync(executable)), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

function containedGitEnv(config: GithubPrCreateRuntimeConfig): Readonly<Record<string, string>> {
  const home = join(realpathSync(config.tempRoot), "inspection-git-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    PATH: fixedExecutablePath(config.gitExecutable),
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
  };
}

function inspectionProfile(context: GithubPrCreateRuntimeContext): SandboxProfile {
  const workspace = realpathSync(context.workspaceRoot);
  const tempRoot = realpathSync(context.state.config.tempRoot);
  return {
    filesystem: {
      allowRead: [workspace, tempRoot, realpathSync(context.state.config.gitExecutable)],
      allowWrite: [tempRoot],
      denyRead: [],
      denyWrite: [
        workspace,
        ...(context.auditDir === undefined ? [] : [realpathSync(context.auditDir)]),
      ],
    },
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
  };
}

async function runContainedGit(
  context: GithubPrCreateRuntimeContext,
  args: readonly string[],
  allowExitOne = false,
): Promise<string> {
  const executable = realpathSync(context.state.config.gitExecutable);
  const timeout = AbortSignal.timeout(5_000);
  const signal =
    context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
  const result = await context.sandbox.execute(
    {
      command: executable,
      argv: [
        executable,
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
      cwd: context.state.config.tempRoot,
    },
    inspectionProfile(context),
    { signal, credentialProxy: { sandboxEnv: containedGitEnv(context.state.config) } },
  );
  if (
    Buffer.byteLength(result.stdout, "utf8") > MAX_GIT_OUTPUT_BYTES ||
    Buffer.byteLength(result.stderr, "utf8") > MAX_GIT_OUTPUT_BYTES
  ) {
    throw new GithubPrCreateInvalidParamsError("local Git inspection exceeded its output bound");
  }
  if (result.exitCode !== 0 && !(allowExitOne && result.exitCode === 1)) {
    throw new GithubPrCreateInvalidParamsError(
      `local Git inspection failed for ${args[0] ?? "request"}`,
    );
  }
  if (!result.stdout.endsWith("\n")) return result.stdout;
  const trimmed = result.stdout.slice(0, -1);
  return trimmed.endsWith("\r") ? trimmed.slice(0, -1) : trimmed;
}

function exactConfigIdentity(gitDir: string): ConfigIdentity {
  const path = join(gitDir, "config");
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new GithubPrCreateInvalidParamsError("repository config must be one ordinary file");
  }
  const identity = exactFileIdentity(path);
  if (!isInside(gitDir, identity.path) || Number(identity.size) > MAX_GIT_CONFIG_BYTES) {
    throw new GithubPrCreateInvalidParamsError(
      "repository config is outside its bounded authority",
    );
  }
  return {
    ...identity,
    digest: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
  };
}

function rejectRepositoryShape(gitDir: string): void {
  const unsupported = [
    join(gitDir, "shallow"),
    join(gitDir, "commondir"),
    join(gitDir, "worktrees"),
    join(gitDir, "info", "grafts"),
    join(gitDir, "objects", "info", "alternates"),
    join(gitDir, "objects", "info", "http-alternates"),
  ];
  if (unsupported.some((path) => existsSync(path))) {
    throw new GithubPrCreateInvalidParamsError(
      "shallow, linked, grafted, partial, or alternate-object repositories are unsupported",
    );
  }
}

async function rejectRepositoryConfigWidening(
  context: GithubPrCreateRuntimeContext,
  workspace: string,
): Promise<void> {
  const names = await runContainedGit(
    context,
    [
      "-C",
      workspace,
      "config",
      "--local",
      "--no-includes",
      "--name-only",
      "--get-regexp",
      "^(extensions\\.partialclone|include(if)?\\..*|remote\\..*\\.(mirror|promisor|partialclonefilter|proxy|proxyauthmethod|push|pushurl|receivepack|vcs)|http\\..*|credential\\..*|core\\.(hookspath|fsmonitor)|push\\..*|submodule\\.recurse|protocol\\..*\\.allow|url\\..*\\.(insteadof|pushinsteadof))$",
    ],
    true,
  );
  if (names !== "") {
    throw new GithubPrCreateInvalidParamsError(
      "repository-local Git configuration widens publication authority",
    );
  }
}

function canonicalGithubRemote(repository: string): string {
  return `https://github.com/${repository}.git`;
}

async function inspectFacts(
  context: GithubPrCreateRuntimeContext,
  request: GithubPrCreateRequest,
): Promise<GithubPrCreateFacts> {
  const config = context.state.config;
  const gitVersion = supportedGitPushVersion(await runContainedGit(context, ["--version"]));
  if (gitVersion !== config.gitVersion) {
    throw new GithubPrCreateInvalidParamsError("configured Git version changed or is unsupported");
  }
  const workspace = realpathSync(context.workspaceRoot);
  if (
    (await runContainedGit(context, ["-C", workspace, "rev-parse", "--is-bare-repository"])) !==
    "false"
  ) {
    throw new GithubPrCreateInvalidParamsError("github.pr.create requires an ordinary repository");
  }
  const topLevel = realpathSync(
    await runContainedGit(context, ["-C", workspace, "rev-parse", "--show-toplevel"]),
  );
  if (topLevel !== workspace) {
    throw new GithubPrCreateInvalidParamsError("workspace must be the repository top level");
  }
  const dotGit = join(workspace, ".git");
  if (!lstatSync(dotGit).isDirectory()) {
    throw new GithubPrCreateInvalidParamsError(
      "linked worktrees and non-directory .git layouts are unsupported",
    );
  }
  const gitDir = realpathSync(
    await runContainedGit(context, ["-C", workspace, "rev-parse", "--absolute-git-dir"]),
  );
  if (gitDir !== realpathSync(dotGit) || !isInside(workspace, gitDir)) {
    throw new GithubPrCreateInvalidParamsError("Git directory is outside the trusted workspace");
  }
  rejectRepositoryShape(gitDir);
  await rejectRepositoryConfigWidening(context, workspace);
  if (
    (await runContainedGit(context, ["-C", workspace, "rev-parse", "--show-object-format"])) !==
    "sha1"
  ) {
    throw new GithubPrCreateInvalidParamsError("GitHub publication requires a SHA-1 repository");
  }
  for (const branch of [request.head, request.base]) {
    if ((await runContainedGit(context, ["check-ref-format", "--branch", branch])) !== branch) {
      throw new GithubPrCreateInvalidParamsError("Git rejected the requested branch name");
    }
  }
  const symbolicHead = await runContainedGit(
    context,
    ["-C", workspace, "symbolic-ref", "--quiet", "HEAD"],
    true,
  );
  if (symbolicHead !== `refs/heads/${request.head}`) {
    throw new GithubPrCreateInvalidParamsError("head must be the current local branch");
  }
  const head = await runContainedGit(context, [
    "-C",
    workspace,
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  if (head !== request.expectedHead) {
    throw new GithubPrCreateInvalidParamsError(
      "expectedHead does not match the current local commit",
    );
  }
  if (
    (await runContainedGit(
      context,
      ["-C", workspace, "show-ref", "--verify", `refs/heads/${request.base}`],
      true,
    )) === ""
  ) {
    throw new GithubPrCreateInvalidParamsError("base must exist as one local branch");
  }
  const canonicalRemote = canonicalGithubRemote(request.repository);
  const urls = await runContainedGit(context, [
    "-C",
    workspace,
    "remote",
    "get-url",
    "--all",
    request.remote,
  ]);
  const pushUrls = await runContainedGit(context, [
    "-C",
    workspace,
    "remote",
    "get-url",
    "--push",
    "--all",
    request.remote,
  ]);
  if (
    urls !== canonicalRemote ||
    pushUrls !== canonicalRemote ||
    urls.includes("\n") ||
    pushUrls.includes("\n")
  ) {
    throw new GithubPrCreateInvalidParamsError(
      "remote must resolve exactly to the requested canonical GitHub repository",
    );
  }
  const api = apiAuthority(config);
  const apiPullsUrl = `${api.origin}/repos/${request.repository}/pulls`;
  const credentialContext: GitCredentialContext = {
    protocol: "https",
    host: "github.com",
    path: `${request.repository}.git`,
  };
  const credentialBrokerIdentity = await config.credentialBroker.inspect(credentialContext);
  return {
    workspaceRoot: workspace,
    workspaceIdentity: exactFileIdentity(workspace),
    gitDir,
    gitDirIdentity: exactFileIdentity(gitDir),
    configIdentity: exactConfigIdentity(gitDir),
    gitExecutable: exactFileIdentity(config.gitExecutable),
    gitVersion,
    curlExecutable: exactFileIdentity(config.curlExecutable),
    curlVersion: config.curlVersion,
    tempRoot: realpathSync(config.tempRoot),
    tempRootIdentity: exactFileIdentity(config.tempRoot),
    canonicalRemote,
    apiOrigin: api.origin,
    apiHost: api.host,
    apiPullsUrl,
    credentialBrokerIdentity,
  };
}

function githubPrCreateSideEffect(canonicalUrl: string): SideEffectT {
  const segment: SideEffectT["dynamic"]["composition"]["segments"][number] = {
    effectKinds: ["network_read", "network_write", "process_exec"],
    scopes: ["external_service", "network", "process"],
    targets: [
      {
        kind: "url",
        value: canonicalUrl,
        normalized: canonicalUrl,
        sensitivity: "internal",
      },
    ],
    modifiers: ["persistent"],
  };
  return {
    taxonomyVersion: "side-effect-taxonomy/v1",
    staticCapability: {
      toolName: GITHUB_PR_CREATE_TOOL_NAME,
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
        name: "github-pr-create-v1-typed-classifier",
        version: "1",
        confidence: "exact",
        reasons: ["typed_exact_pull_request_creation"],
      },
    },
  };
}

function expectedPolicyArgv(params: GithubPrCreateExecuteParams): string[] {
  const request = parseGithubPrCreateRequest(params.toolCall.args);
  return [
    GITHUB_PR_CREATE_TOOL_NAME,
    request.remote,
    request.repository,
    request.head,
    request.expectedHead,
    request.base,
    request.title,
    request.body,
    String(request.draft),
    String(request.maintainerCanModify),
  ];
}

function validateBindingAuthority(
  context: GithubPrCreateRuntimeContext,
  params: GithubPrCreateExecuteParams,
  facts: GithubPrCreateFacts,
  sideEffect: SideEffectT,
  authority: GithubPrCreateBindingAuthority,
): void {
  const input = authority.policyInput;
  const args = JsonObject.safeParse(input.tool.args);
  if (
    authority.auditAuthorityId === "" ||
    authority.addressGuardRevision === "" ||
    input.tool.name !== GITHUB_PR_CREATE_TOOL_NAME ||
    !args.success ||
    canonicalize(args.data) !== canonicalize(params.toolCall.args) ||
    canonicalize(input.sideEffect as unknown as JsonObjectT) !==
      canonicalize(sideEffect as unknown as JsonObjectT) ||
    input.workspace.path !== context.workspaceRoot ||
    input.workspace.trusted !== true ||
    input.session.id !== params.sessionId ||
    canonicalize(input.provenance) !== canonicalize(params.provenanceContext) ||
    input.egress.isEgress !== true ||
    input.egress.domain !== facts.apiHost ||
    input.egress.gitRemote !== facts.apiPullsUrl ||
    canonicalize({ argv: input.normalized.argv }) !==
      canonicalize({ argv: expectedPolicyArgv(params) })
  ) {
    throw new Error("github.pr.create binding authority did not match the exact request");
  }
}

function bindingAuthorityAuditFields(
  authority: GithubPrCreateBindingAuthority,
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

function factsIdentity(facts: GithubPrCreateFacts): JsonObjectT {
  return {
    repository: facts.canonicalRemote,
    api: facts.apiPullsUrl,
    gitExecutable: facts.gitExecutable.path,
    gitVersion: facts.gitVersion,
    curlExecutable: facts.curlExecutable.path,
    curlVersion: facts.curlVersion,
    credentialSourceClass: "operator Git credential helper (system/global config)",
    credentialBrokerIdentity: {
      version: facts.credentialBrokerIdentity.version,
      gitExecutableDigest: facts.credentialBrokerIdentity.gitExecutableDigest,
      configurationDigest: facts.credentialBrokerIdentity.configurationDigest,
      helperDigest: facts.credentialBrokerIdentity.helperDigest,
      helperCount: facts.credentialBrokerIdentity.helperCount,
    },
    transport: "srt:vendored verified HTTPS with connect-time address guard",
  };
}

function digestBinding(input: {
  readonly context: GithubPrCreateRuntimeContext;
  readonly params: GithubPrCreateExecuteParams;
  readonly request: GithubPrCreateRequest;
  readonly facts: GithubPrCreateFacts;
  readonly reviewId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly generation: number;
  readonly authority: GithubPrCreateBindingAuthority;
}): string {
  const sandbox = input.context.sandbox.status();
  const payload = {
    version: GITHUB_PR_CREATE_CAPABILITY_V1,
    request: input.request,
    args: input.params.toolCall.args,
    sessionId: input.params.sessionId,
    provenance: input.params.provenanceContext,
    reviewId: input.reviewId,
    createdAtMs: input.createdAtMs,
    expiresAtMs: input.expiresAtMs,
    generation: input.generation,
    workspaceIdentity: input.facts.workspaceIdentity,
    gitDirIdentity: input.facts.gitDirIdentity,
    configIdentity: input.facts.configIdentity,
    gitExecutable: input.facts.gitExecutable,
    curlExecutable: input.facts.curlExecutable,
    tempRootIdentity: input.facts.tempRootIdentity,
    canonicalRemote: input.facts.canonicalRemote,
    apiPullsUrl: input.facts.apiPullsUrl,
    credentialBrokerIdentity: input.facts.credentialBrokerIdentity,
    sandbox,
    auditDir: input.context.auditDir === undefined ? null : realpathSync(input.context.auditDir),
    policyPack: input.authority.policyPack,
    policyDecision: input.authority.policyDecision,
    addressGuardRevision: input.authority.addressGuardRevision,
    auditAuthorityId: input.authority.auditAuthorityId,
  };
  return `sha256:${createHash("sha256")
    .update(canonicalize(payload as unknown as JsonObjectT))
    .digest("hex")}`;
}

function auditInvalidParams(
  context: GithubPrCreateRuntimeContext,
  params: GithubPrCreateExecuteParams,
  error: GithubPrCreateInvalidParamsError,
): number {
  return context.appendAudit({
    eventType: "tool.deny",
    sessionId: params.sessionId,
    payload: {
      toolName: GITHUB_PR_CREATE_TOOL_NAME,
      args: params.toolCall.args,
      reason: error.message,
      code: "INVALID_PARAMS",
      actionMayHaveExecuted: false,
    },
    sideEffect: githubPrCreateSideEffect(`${GITHUB_API_ORIGIN}/invalid`),
  });
}

async function requestReview(
  context: GithubPrCreateRuntimeContext,
  params: GithubPrCreateExecuteParams,
): Promise<GithubPrCreateRpcResult> {
  if (params.toolCall.name !== GITHUB_PR_CREATE_TOOL_NAME) {
    throw new GithubPrCreateInvalidParamsError(
      "unexpected tool name for github.pr.create authority",
    );
  }
  if (
    !githubPrCreateCapabilityAvailable({
      workspaceTrusted: true,
      auditAvailable: true,
      authorityHealthy: context.state.cleanupHealthy,
      sandbox: context.sandbox.status(),
    })
  ) {
    throw new Error("github.pr.create enforcing transport boundary is unavailable");
  }
  const request = parseGithubPrCreateRequest(params.toolCall.args);
  const facts = await inspectFacts(context, request);
  const sideEffect = githubPrCreateSideEffect(facts.apiPullsUrl);
  const authority = await context.resolveBindingAuthority({
    executeParams: params,
    sideEffect,
    canonicalUrl: facts.apiPullsUrl,
    host: facts.apiHost,
  });
  validateBindingAuthority(context, params, facts, sideEffect, authority);
  if (
    authority.policyDecision.verdict === "deny" ||
    authority.policyDecision.modifiedArgs !== undefined
  ) {
    const auditSeq = context.appendAudit({
      eventType: "tool.deny",
      sessionId: params.sessionId,
      payload: {
        toolName: GITHUB_PR_CREATE_TOOL_NAME,
        args: params.toolCall.args,
        reason: "current Warden policy does not permit an exact github.pr.create review",
        actionMayHaveExecuted: false,
      },
      sideEffect,
      ...bindingAuthorityAuditFields(authority),
    });
    return {
      verdict: "deny",
      result: {
        kind: "github_pr_create_denied",
        reason: "current Warden policy denies this exact github.pr.create request",
      },
      auditSeq,
    };
  }
  const now = context.state.config.nowMs?.() ?? performance.now();
  const reviewId = `github_pr_create_review_${String(context.state.nextReviewId)}`;
  context.state.nextReviewId += 1;
  const createdAtMs = now;
  const expiresAtMs = now + GITHUB_PR_CREATE_REVIEW_TTL_MS;
  const generation = context.state.reviewGeneration;
  const summary = githubPrCreateReviewSummary({
    request,
    canonicalRemote: facts.canonicalRemote,
    credentialSourceClass: "operator Git credential helper (system/global config)",
  });
  const pending: PendingGithubPrCreateReview = {
    kind: "github-pr-create",
    reviewId,
    summary,
    allowCommand: `keel approve ${reviewId} --scope once`,
    createdAtMs,
    expiresAtMs,
    generation,
    bindingDigest: "",
    executeParams: params,
    request,
    facts,
    bindingAuthority: authority,
  };
  const bindingDigest = digestBinding({
    context,
    params,
    request,
    facts,
    reviewId,
    createdAtMs,
    expiresAtMs,
    generation,
    authority,
  });
  const bound: PendingGithubPrCreateReview = { ...pending, bindingDigest };
  context.state.pending.set(reviewId, bound);
  try {
    const auditSeq = context.appendAudit({
      eventType: "review.requested",
      sessionId: params.sessionId,
      payload: {
        reviewId,
        summary,
        ...factsIdentity(facts),
        bindingDigest,
        createdAtMs,
        expiresAtMs,
      },
      ...bindingAuthorityAuditFields(authority),
    });
    return {
      verdict: "review",
      review: { reviewId, summary, allowCommand: bound.allowCommand },
      auditSeq,
    };
  } catch (error) {
    context.state.pending.delete(reviewId);
    throw error;
  }
}

interface GithubApiCallResult {
  readonly transportOk: boolean;
  readonly status: number | null;
  readonly body: unknown;
}

function apiProfile(
  context: GithubPrCreateRuntimeContext,
  review: PendingGithubPrCreateReview,
  attemptRoot: string,
): SandboxProfile {
  return {
    filesystem: {
      allowRead: [attemptRoot, review.facts.curlExecutable.path],
      allowWrite: [attemptRoot],
      denyRead: [
        review.facts.workspaceRoot,
        ...(context.auditDir === undefined ? [] : [realpathSync(context.auditDir)]),
      ],
      denyWrite: [
        review.facts.workspaceRoot,
        ...(context.auditDir === undefined ? [] : [realpathSync(context.auditDir)]),
      ],
    },
    network: {
      allowedDomains: [review.facts.apiHost],
      deniedDomains: [],
      strictAllowlist: true,
    },
  };
}

function apiCredential(
  review: PendingGithubPrCreateReview,
  attemptRoot: string,
  authorization: GitCredentialBearerAuthorization,
): SandboxCredentialProxyConfig {
  const home = join(attemptRoot, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    authorizationHeaders: [
      { host: review.facts.apiHost, scheme: authorization.scheme, secret: authorization.secret },
    ],
    sandboxEnv: {
      PATH: fixedExecutablePath(review.facts.curlExecutable.path),
      HOME: home,
      CURL_HOME: home,
      XDG_CONFIG_HOME: home,
      LANG: "C",
      LC_ALL: "C",
      NO_PROXY: "",
      no_proxy: "",
    },
  };
}

function validateApiUrl(review: PendingGithubPrCreateReview, url: string): void {
  const parsed = new URL(url);
  const origin = new URL(review.facts.apiOrigin);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== origin.origin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("github.pr.create API URL escaped its fixed origin");
  }
}

async function runGithubApi(
  context: GithubPrCreateRuntimeContext,
  review: PendingGithubPrCreateReview,
  attemptRoot: string,
  authorization: GitCredentialBearerAuthorization,
  sequence: number,
  method: "GET" | "POST",
  url: string,
  requestBody?: JsonObjectT,
): Promise<GithubApiCallResult> {
  validateApiUrl(review, url);
  const responsePath = join(attemptRoot, `response-${String(sequence)}.json`);
  writeFileSync(responsePath, "", { mode: 0o600, flag: "wx" });
  let requestPath: string | undefined;
  if (requestBody !== undefined) {
    requestPath = join(attemptRoot, `request-${String(sequence)}.json`);
    writeFileSync(requestPath, JSON.stringify(requestBody), { mode: 0o600, flag: "wx" });
  }
  const argv = [
    review.facts.curlExecutable.path,
    "--disable",
    "--noproxy",
    "",
    "--silent",
    "--show-error",
    "--request",
    method,
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "--max-redirs",
    "0",
    "--retry",
    "0",
    "--connect-timeout",
    "5",
    "--max-time",
    "20",
    "--header",
    "Accept: application/vnd.github+json",
    "--header",
    `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
    "--header",
    "User-Agent: keel",
    ...(requestPath === undefined
      ? []
      : ["--header", "Content-Type: application/json", "--data-binary", `@${requestPath}`]),
    "--output",
    responsePath,
    "--write-out",
    "%{http_code}",
    url,
  ];
  const timeout = AbortSignal.timeout(25_000);
  const signal =
    context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
  let result: SandboxExecutionResult;
  try {
    result = await context.sandbox.execute(
      { command: review.facts.curlExecutable.path, argv, cwd: attemptRoot },
      apiProfile(context, review, attemptRoot),
      { signal, credentialProxy: apiCredential(review, attemptRoot, authorization) },
    );
  } catch {
    return { transportOk: false, status: null, body: null };
  }
  const responseEntry = lstatSync(responsePath);
  if (
    !responseEntry.isFile() ||
    responseEntry.isSymbolicLink() ||
    responseEntry.size > MAX_API_RESPONSE_BYTES
  ) {
    return { transportOk: false, status: null, body: null };
  }
  if (
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.stderr !== "" ||
    !/^\d{3}$/u.test(result.stdout)
  ) {
    return { transportOk: false, status: null, body: null };
  }
  let body: unknown;
  try {
    const bytes = readFileSync(responsePath);
    if (bytes.length > MAX_API_RESPONSE_BYTES) {
      return { transportOk: false, status: null, body: null };
    }
    body = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return { transportOk: false, status: Number(result.stdout), body: null };
  }
  return { transportOk: true, status: Number(result.stdout), body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRefResponse(value: unknown, branch: string, expected?: string): string | undefined {
  if (!isRecord(value) || value["ref"] !== `refs/heads/${branch}` || !isRecord(value["object"])) {
    return undefined;
  }
  const object = value["object"];
  const sha = object["sha"];
  if (object["type"] !== "commit" || typeof sha !== "string" || !FULL_SHA1.test(sha)) {
    return undefined;
  }
  return expected === undefined || sha === expected ? sha : undefined;
}

interface ExactPullRequest {
  readonly number: number;
  readonly url: string;
}

function exactPullRequest(
  value: unknown,
  request: GithubPrCreateRequest,
): ExactPullRequest | undefined {
  if (!isRecord(value) || !isRecord(value["head"]) || !isRecord(value["base"])) return undefined;
  const head = value["head"];
  const base = value["base"];
  if (!isRecord(head["repo"]) || !isRecord(base["repo"])) return undefined;
  const number = value["number"];
  const url = value["html_url"];
  const expectedUrl =
    typeof number === "number"
      ? `https://github.com/${request.repository}/pull/${String(number)}`
      : "";
  if (
    !Number.isSafeInteger(number) ||
    (number as number) < 1 ||
    typeof url !== "string" ||
    url !== expectedUrl ||
    value["state"] !== "open" ||
    value["title"] !== request.title ||
    (value["body"] ?? "") !== request.body ||
    value["draft"] !== request.draft ||
    value["maintainer_can_modify"] !== request.maintainerCanModify ||
    head["ref"] !== request.head ||
    head["sha"] !== request.expectedHead ||
    base["ref"] !== request.base ||
    head["repo"]["full_name"] !== request.repository ||
    base["repo"]["full_name"] !== request.repository
  ) {
    return undefined;
  }
  return { number: number as number, url };
}

function pullListObservation(
  value: unknown,
  request: GithubPrCreateRequest,
): { readonly exact?: ExactPullRequest; readonly conflict: boolean } | undefined {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const exact = value
    .map((entry) => exactPullRequest(entry, request))
    .filter((entry) => entry !== undefined);
  if (exact.length > 1) return undefined;
  return {
    ...(exact[0] === undefined ? {} : { exact: exact[0] }),
    conflict: value.length > exact.length,
  };
}

function encodedRefUrl(review: PendingGithubPrCreateReview, branch: string): string {
  return `${review.facts.apiOrigin}/repos/${review.request.repository}/git/ref/${encodeURIComponent(`heads/${branch}`)}`;
}

function pullListUrl(review: PendingGithubPrCreateReview): string {
  const owner = review.request.repository.split("/")[0]!;
  return `${review.facts.apiPullsUrl}?state=open&head=${encodeURIComponent(`${owner}:${review.request.head}`)}&base=${encodeURIComponent(review.request.base)}&per_page=100`;
}

function resultPayload(
  review: PendingGithubPrCreateReview,
  status: "created" | "already-exists" | "failed" | "indeterminate",
  pr: ExactPullRequest | undefined,
  actionMayHaveExecuted: boolean,
): JsonObjectT {
  return {
    kind: "github_pr_create_result",
    status,
    repository: review.request.repository,
    head: review.request.head,
    base: review.request.base,
    commit: review.request.expectedHead,
    number: pr?.number ?? null,
    url: pr?.url ?? null,
    automaticRetry: false,
    actionMayHaveExecuted,
  };
}

function auditOutcome(
  context: GithubPrCreateRuntimeContext,
  review: PendingGithubPrCreateReview,
  payload: JsonObjectT,
  actionMayHaveExecuted = false,
): number {
  return context.appendAudit(
    {
      eventType: "tool.execute",
      sessionId: review.executeParams.sessionId,
      payload: {
        toolName: GITHUB_PR_CREATE_TOOL_NAME,
        args: review.executeParams.toolCall.args,
        reviewId: review.reviewId,
        ...factsIdentity(review.facts),
        bindingDigest: review.bindingDigest,
        ...payload,
      },
      sideEffect: githubPrCreateSideEffect(review.facts.apiPullsUrl),
      ...bindingAuthorityAuditFields(review.bindingAuthority),
    },
    actionMayHaveExecuted ? { actionMayHaveExecuted: true } : undefined,
  );
}

function cleanupAttempt(context: GithubPrCreateRuntimeContext, path: string): void {
  try {
    if (
      (typeof __KEEL_RELEASE_BUILD__ === "undefined" || __KEEL_RELEASE_BUILD__ !== true) &&
      isFixtureConfig(context.state.config) &&
      context.state.config.cleanupAttemptRoot !== undefined
    ) {
      context.state.config.cleanupAttemptRoot(path);
    } else {
      rmSync(path, { recursive: true, force: true });
    }
  } catch {
    context.state.cleanupHealthy = false;
    context.state.pending.clear();
  }
}

function sameFacts(left: GithubPrCreateFacts, right: GithubPrCreateFacts): boolean {
  return (
    canonicalize(left as unknown as JsonObjectT) === canonicalize(right as unknown as JsonObjectT)
  );
}

async function resolveReview(
  context: GithubPrCreateRuntimeContext,
  review: PendingGithubPrCreateReview,
  resolution: GithubPrCreateResolveParams,
): Promise<GithubPrCreateRpcResult> {
  const now = context.state.config.nowMs?.() ?? performance.now();
  const scopeAccepted = resolution.scope === "once";
  const unexpired = now < review.expiresAtMs;
  const currentGeneration = review.generation === context.state.reviewGeneration;
  const approved = resolution.approved && scopeAccepted && unexpired && currentGeneration;
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
  if (!resolution.approved || !scopeAccepted || !unexpired || !currentGeneration) {
    const reason = !resolution.approved
      ? "human denied"
      : !scopeAccepted
        ? "github.pr.create accepts once-only approval"
        : !unexpired
          ? "github.pr.create review expired"
          : "github.pr.create review is stale; submit a fresh request";
    return {
      verdict: "deny",
      result: { kind: "github_pr_create_denied", reason },
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
        toolName: GITHUB_PR_CREATE_TOOL_NAME,
        args: review.executeParams.toolCall.args,
        reviewId: review.reviewId,
        reason: "sandbox temporary authority changed after approval",
        errorClass: error instanceof Error ? error.name : "unknown",
        actionMayHaveExecuted: false,
      },
      sideEffect: githubPrCreateSideEffect(review.facts.apiPullsUrl),
      ...bindingAuthorityAuditFields(review.bindingAuthority),
    });
    return {
      verdict: "deny",
      result: {
        kind: "github_pr_create_denied",
        reason: "sandbox temporary authority changed; submit a fresh request",
      },
      auditSeq,
    };
  }

  let refreshedFacts: GithubPrCreateFacts;
  let refreshedAuthority: GithubPrCreateBindingAuthority;
  try {
    refreshedFacts = await inspectFacts(context, review.request);
    const sideEffect = githubPrCreateSideEffect(refreshedFacts.apiPullsUrl);
    refreshedAuthority = await context.resolveBindingAuthority({
      executeParams: review.executeParams,
      sideEffect,
      canonicalUrl: refreshedFacts.apiPullsUrl,
      host: refreshedFacts.apiHost,
    });
    validateBindingAuthority(
      context,
      review.executeParams,
      refreshedFacts,
      sideEffect,
      refreshedAuthority,
    );
  } catch (error) {
    const auditSeq = context.appendAudit({
      eventType: "tool.deny",
      sessionId: review.executeParams.sessionId,
      payload: {
        toolName: GITHUB_PR_CREATE_TOOL_NAME,
        args: review.executeParams.toolCall.args,
        reviewId: review.reviewId,
        reason: "github.pr.create revalidation failed",
        errorClass: error instanceof Error ? error.name : "unknown",
        actionMayHaveExecuted: false,
      },
      sideEffect: githubPrCreateSideEffect(review.facts.apiPullsUrl),
      ...bindingAuthorityAuditFields(review.bindingAuthority),
    });
    return {
      verdict: "deny",
      result: {
        kind: "github_pr_create_denied",
        reason: "request facts changed; submit a fresh request",
      },
      auditSeq,
    };
  }
  const refreshedDigest = digestBinding({
    context,
    params: review.executeParams,
    request: review.request,
    facts: refreshedFacts,
    reviewId: review.reviewId,
    createdAtMs: review.createdAtMs,
    expiresAtMs: review.expiresAtMs,
    generation: review.generation,
    authority: refreshedAuthority,
  });
  if (!sameFacts(refreshedFacts, review.facts) || refreshedDigest !== review.bindingDigest) {
    const auditSeq = context.appendAudit({
      eventType: "tool.deny",
      sessionId: review.executeParams.sessionId,
      payload: {
        toolName: GITHUB_PR_CREATE_TOOL_NAME,
        args: review.executeParams.toolCall.args,
        reviewId: review.reviewId,
        reason: "github.pr.create binding changed after approval",
        actionMayHaveExecuted: false,
      },
      sideEffect: githubPrCreateSideEffect(review.facts.apiPullsUrl),
      ...bindingAuthorityAuditFields(refreshedAuthority),
    });
    return {
      verdict: "deny",
      result: {
        kind: "github_pr_create_denied",
        reason: "request facts changed; submit a fresh request",
      },
      auditSeq,
    };
  }

  auditOutcome(context, review, { execution: "requested", outcomeKnown: false });
  let attemptRoot: string | undefined;
  let postAttempted = false;
  try {
    const credentialContext: GitCredentialContext = {
      protocol: "https",
      host: "github.com",
      path: `${review.request.repository}.git`,
    };
    const authorization = await context.state.config.credentialBroker.resolveBearer(
      credentialContext,
      review.facts.credentialBrokerIdentity,
      context.signal,
    );
    attemptRoot = mkdtempSync(join(review.facts.tempRoot, "github-pr-attempt-"));
    chmodSync(attemptRoot, 0o700);
    let sequence = 1;
    const head = await runGithubApi(
      context,
      review,
      attemptRoot,
      authorization,
      sequence++,
      "GET",
      encodedRefUrl(review, review.request.head),
    );
    const base = await runGithubApi(
      context,
      review,
      attemptRoot,
      authorization,
      sequence++,
      "GET",
      encodedRefUrl(review, review.request.base),
    );
    if (
      !head.transportOk ||
      head.status !== 200 ||
      exactRefResponse(head.body, review.request.head, review.request.expectedHead) === undefined ||
      !base.transportOk ||
      base.status !== 200 ||
      exactRefResponse(base.body, review.request.base) === undefined
    ) {
      const result = resultPayload(review, "failed", undefined, false);
      const auditSeq = auditOutcome(context, review, {
        result,
        phase: "remote-ref-preflight",
      });
      return { verdict: "deny", result, auditSeq };
    }
    const existing = await runGithubApi(
      context,
      review,
      attemptRoot,
      authorization,
      sequence++,
      "GET",
      pullListUrl(review),
    );
    const existingObservation =
      existing.transportOk && existing.status === 200
        ? pullListObservation(existing.body, review.request)
        : undefined;
    if (existingObservation === undefined) {
      const result = resultPayload(review, "failed", undefined, false);
      const auditSeq = auditOutcome(context, review, { result, phase: "existing-pr-preflight" });
      return { verdict: "deny", result, auditSeq };
    }
    if (existingObservation.exact !== undefined && !existingObservation.conflict) {
      const result = resultPayload(review, "already-exists", existingObservation.exact, false);
      const auditSeq = auditOutcome(context, review, { result, phase: "existing-pr-preflight" });
      return { verdict: "allow", result, auditSeq };
    }
    if (existingObservation.conflict) {
      const result = resultPayload(review, "failed", undefined, false);
      const auditSeq = auditOutcome(context, review, { result, phase: "conflicting-pr-preflight" });
      return { verdict: "deny", result, auditSeq };
    }

    postAttempted = true;
    const post = await runGithubApi(
      context,
      review,
      attemptRoot,
      authorization,
      sequence++,
      "POST",
      review.facts.apiPullsUrl,
      {
        title: review.request.title,
        body: review.request.body,
        head: review.request.head,
        base: review.request.base,
        draft: review.request.draft,
        maintainer_can_modify: review.request.maintainerCanModify,
      },
    );
    const postExact = post.status === 201 ? exactPullRequest(post.body, review.request) : undefined;
    const verification = await runGithubApi(
      context,
      review,
      attemptRoot,
      authorization,
      sequence++,
      "GET",
      pullListUrl(review),
    );
    const verified =
      verification.transportOk && verification.status === 200
        ? pullListObservation(verification.body, review.request)
        : undefined;
    const verifiedExact = verified?.conflict === false ? verified.exact : undefined;
    if (
      post.transportOk &&
      post.status === 201 &&
      postExact !== undefined &&
      verifiedExact !== undefined &&
      postExact.number === verifiedExact.number &&
      postExact.url === verifiedExact.url
    ) {
      const result = resultPayload(review, "created", verifiedExact, true);
      const auditSeq = auditOutcome(context, review, { result, phase: "verified" }, true);
      return { verdict: "allow", result, auditSeq };
    }
    if (verifiedExact !== undefined) {
      const result = resultPayload(review, "created", verifiedExact, true);
      const auditSeq = auditOutcome(context, review, { result, phase: "reconciled" }, true);
      return { verdict: "allow", result, auditSeq };
    }
    const definitiveFailure = post.transportOk && (post.status === 403 || post.status === 422);
    const status = definitiveFailure && verified !== undefined ? "failed" : "indeterminate";
    const actionMayHaveExecuted = status === "indeterminate";
    const result = resultPayload(review, status, undefined, actionMayHaveExecuted);
    const auditSeq = auditOutcome(
      context,
      review,
      { result, phase: "post-reconciliation", httpStatus: post.status },
      actionMayHaveExecuted,
    );
    return { verdict: "deny", result, auditSeq };
  } catch (error) {
    if (context.isAuditFailure?.(error) === true) throw error;
    const status = postAttempted ? "indeterminate" : "failed";
    const result = resultPayload(review, status, undefined, postAttempted);
    const auditSeq = auditOutcome(
      context,
      review,
      {
        result,
        phase: "exception",
        errorClass: error instanceof Error ? error.name : "unknown",
      },
      postAttempted,
    );
    return { verdict: "deny", result, auditSeq };
  } finally {
    if (attemptRoot !== undefined) cleanupAttempt(context, attemptRoot);
  }
}

function createAuthority(config: GithubPrCreateRuntimeConfig): GithubPrCreateAuthority {
  const state = createRuntimeState(config);
  const consumed = new WeakSet<PendingGithubPrCreateReview>();
  const runtimeContext = (
    context: GithubPrCreateAuthorityContext,
  ): GithubPrCreateRuntimeContext => ({ ...context, state });
  return {
    capability: GITHUB_PR_CREATE_CAPABILITY_V1,
    toolName: GITHUB_PR_CREATE_TOOL_NAME,
    transportRequirements: { credentialTlsTermination: true },
    capabilityAvailable: (input) =>
      githubPrCreateCapabilityAvailable({
        ...input,
        authorityHealthy: state.cleanupHealthy,
      }),
    pendingReviewCount: () => state.pending.size,
    hasPendingReview: (reviewId) => state.pending.has(reviewId),
    request: (context, params) => requestReview(runtimeContext(context), params),
    consumeReview: (reviewId) => {
      const review = state.pending.get(reviewId);
      if (review === undefined) return undefined;
      state.pending.delete(reviewId);
      consumed.add(review);
      return review;
    },
    resolve: async (context, opaque, params) => {
      const review = opaque as PendingGithubPrCreateReview;
      if (!consumed.delete(review) || !REVIEW_ID.test(review.reviewId)) {
        throw new Error("github.pr.create review was not consumed by this authority");
      }
      return await resolveReview(runtimeContext(context), review, params);
    },
    isInvalidParams: (error): error is GithubPrCreateInvalidParamsError =>
      error instanceof GithubPrCreateInvalidParamsError,
    auditInvalidParams: (context, params, error) => {
      if (!(error instanceof GithubPrCreateInvalidParamsError)) {
        throw new Error("github.pr.create received a non-parameter error for denial audit");
      }
      return auditInvalidParams(runtimeContext(context), params, error);
    },
  };
}

export function createGithubPrCreateWalkingSkeletonAuthority(
  config: GithubPrCreateWalkingSkeletonConfig,
): GithubPrCreateAuthority {
  return createAuthority(config);
}

export function createGithubPrCreateProductionAuthority(
  config: GithubPrCreateProductionConfig,
): GithubPrCreateAuthority {
  return createAuthority(config);
}
