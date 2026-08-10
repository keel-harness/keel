import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { Buffer } from "node:buffer";
import { canonicalize, type JsonObjectT, type SideEffectT } from "@keel/shared";
import {
  GIT_PUSH_CAPABILITY_V1,
  GIT_PUSH_TOOL_NAME,
  type GitPushAuthority,
  type GitPushAuthorityContext,
  type GitPushExecuteParams,
  type GitPushPendingReview,
  type GitPushResolveParams,
  type GitPushRpcResult,
} from "./git-push-authority.js";
import {
  CREDENTIAL_TLS_TERMINATION_CAPABILITY,
  EGRESS_ADDRESS_GUARD_CAPABILITY,
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

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REVIEW_ID = /^git_push_review_[1-9]\d{0,15}$/u;
const UNSAFE_CARD_VALUE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;

export interface GitPushFixtureAuthority {
  readonly canonicalUrl: string;
  readonly host: "localhost";
  readonly port: number;
  readonly address: "127.0.0.1";
  readonly username: string;
  readonly secret: string;
  readonly credentialSourceClass: "deterministic-test-provider";
}

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
}

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

interface GitPushFacts {
  readonly workspaceRoot: string;
  readonly gitDir: string;
  readonly objectStore: string;
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
  readonly envExecutable: GitExecutableIdentity;
  readonly tempRoot: string;
}

export interface PendingGitPushReview extends GitPushPendingReview {
  readonly kind: "git-push";
  readonly reviewId: string;
  readonly summary: string;
  readonly allowCommand: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly bindingDigest: string;
  readonly executeParams: GitPushExecuteParams;
  readonly request: GitPushRequest;
  readonly facts: GitPushFacts;
}

export interface GitPushRuntimeState {
  readonly config: GitPushWalkingSkeletonConfig;
  readonly pending: Map<string, PendingGitPushReview>;
  nextReviewId: number;
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

export function auditGitPushInvalidParams(
  context: GitPushRuntimeContext,
  executeParams: GitPushExecuteParams,
  error: GitPushInvalidParamsError,
): number {
  const canonicalUrl = context.state.config.fixture.canonicalUrl;
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

export function createGitPushRuntimeState(
  config: GitPushWalkingSkeletonConfig,
): GitPushRuntimeState {
  validateFixtureAuthority(config);
  return { config, pending: new Map(), nextReviewId: 1 };
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function validateFixtureAuthority(config: GitPushWalkingSkeletonConfig): void {
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
    fixture.username === "" ||
    fixture.secret === "" ||
    fixture.credentialSourceClass !== "deterministic-test-provider"
  ) {
    throw new Error("invalid non-release git.push fixture authority");
  }
  const gitExecutable = realpathSync(config.gitExecutable);
  // realpathSync returns a canonical absolute path or throws before capability state exists.
  void gitExecutable;
  const tempRoot = realpathSync(config.tempRoot);
  const tempStat = statSync(tempRoot);
  if (!tempStat.isDirectory() || (tempStat.mode & 0o077) !== 0) {
    throw new Error("git.push temporary root must be an owner-only directory");
  }
}

export function gitPushCapabilityAvailable(
  state: GitPushRuntimeState | undefined,
  input: {
    readonly workspaceTrusted: boolean;
    readonly auditAvailable: boolean;
    readonly sandbox: SandboxStatus;
  },
): boolean {
  if (state === undefined || !input.workspaceTrusted || !input.auditAvailable) return false;
  const sandbox = input.sandbox;
  return (
    sandbox.available &&
    sandbox.backend === "srt:vendored" &&
    sandbox.enforcementTier === "sandbox:srt" &&
    sandbox.features?.includes(EGRESS_ADDRESS_GUARD_CAPABILITY) === true &&
    sandbox.features?.includes(CREDENTIAL_TLS_TERMINATION_CAPABILITY) === true
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

function hostGitEnv(tempRoot: string): NodeJS.ProcessEnv {
  const home = join(tempRoot, "host-git-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    PATH: process.env["PATH"],
    HOME: home,
    XDG_CONFIG_HOME: home,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function runHostGit(
  state: GitPushRuntimeState,
  args: readonly string[],
  options: { readonly cwd?: string; readonly allowExitOne?: boolean } = {},
): string {
  const result = spawnSync(realpathSync(state.config.gitExecutable), [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    encoding: "utf8",
    env: hostGitEnv(state.config.tempRoot),
    timeout: 5_000,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && !(options.allowExitOne === true && result.status === 1)) {
    throw new GitPushInvalidParamsError(`local Git inspection failed for ${args[0] ?? "request"}`);
  }
  return result.stdout.trimEnd();
}

function exactGitExecutable(path: string): GitExecutableIdentity {
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

function inspectGitPushFacts(
  state: GitPushRuntimeState,
  workspaceRootInput: string,
  request: GitPushRequest,
): GitPushFacts {
  const workspaceRoot = realpathSync(workspaceRootInput);
  if (runHostGit(state, ["-C", workspaceRoot, "rev-parse", "--is-bare-repository"]) !== "false") {
    throw new GitPushInvalidParamsError("git.push requires an ordinary non-bare repository");
  }
  const topLevel = realpathSync(
    runHostGit(state, ["-C", workspaceRoot, "rev-parse", "--show-toplevel"]),
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
    runHostGit(state, ["-C", workspaceRoot, "rev-parse", "--absolute-git-dir"]),
  );
  if (gitDir !== realpathSync(dotGit) || !isInside(workspaceRoot, gitDir)) {
    throw new GitPushInvalidParamsError("Git directory identity is outside the trusted workspace");
  }
  const objectFormatRaw = runHostGit(state, [
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
  const head = runHostGit(state, ["-C", workspaceRoot, "rev-parse", "--verify", "HEAD"]);
  if (head !== request.expectedHead) {
    throw new GitPushInvalidParamsError(
      "current HEAD does not equal expectedHead; refresh and submit a new request",
    );
  }
  if (
    runHostGit(state, ["-C", workspaceRoot, "cat-file", "-t", request.expectedHead]) !== "commit"
  ) {
    throw new GitPushInvalidParamsError("expectedHead does not identify a commit");
  }
  runHostGit(state, ["check-ref-format", "--branch", request.branch]);
  const destinationRef = `refs/heads/${request.branch}`;
  const urls = runHostGit(
    state,
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
    .split("\n")
    .filter((value) => value !== "");
  if (urls.length !== 1) {
    throw new GitPushInvalidParamsError("remote must resolve to exactly one repository-local URL");
  }
  const canonicalUrl = urls[0]!;
  if (canonicalUrl !== state.config.fixture.canonicalUrl) {
    throw new GitPushInvalidParamsError(
      "Slice 1 release-withheld fixture accepts only its injected canonical HTTPS repository URL",
    );
  }
  const pushUrls = runHostGit(
    state,
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
  const metadata = runHostGit(state, [
    "-C",
    workspaceRoot,
    "show",
    "-s",
    "--format=%H%x00%aI%x00%P%x00%s",
    request.expectedHead,
  ]).split("\u0000");
  if (metadata.length !== 4 || metadata[0] !== request.expectedHead) {
    throw new GitPushInvalidParamsError("commit metadata could not be resolved exactly");
  }
  const authorTimestamp = safeCardValue("author timestamp", metadata[1]!, 64);
  const parents = metadata[2] === "" ? [] : metadata[2]!.split(" ");
  const subject = safeCardValue("commit subject", metadata[3]!, 160);
  const numstat = runHostGit(state, [
    "-C",
    workspaceRoot,
    "diff-tree",
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
  }
  const objectStore = realpathSync(join(gitDir, "objects"));
  if (
    existsSync(join(objectStore, "info", "alternates")) ||
    process.env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] !== undefined
  ) {
    throw new GitPushInvalidParamsError("alternate object databases are unsupported");
  }
  const workspaceState =
    runHostGit(state, ["-C", workspaceRoot, "status", "--porcelain=v1", "-uno"]) === ""
      ? "clean"
      : "has uncommitted changes";
  return {
    workspaceRoot,
    gitDir,
    objectStore,
    objectFormat,
    remote: request.remote,
    canonicalUrl,
    host: state.config.fixture.host,
    port: state.config.fixture.port,
    destinationRef,
    expectedHead: request.expectedHead,
    subject,
    authorTimestamp,
    parentCount: parents.length,
    fileCount,
    additions,
    deletions,
    workspaceState,
    gitExecutable: exactGitExecutable(state.config.gitExecutable),
    envExecutable: exactGitExecutable("/usr/bin/env"),
    tempRoot: realpathSync(state.config.tempRoot),
  };
}

function reviewSummary(facts: GitPushFacts): string {
  const sourceClass = "deterministic test fixture (release capability withheld)";
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
    `Credential: ${sourceClass}; secret stays in the Warden/SRT path`,
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
  readonly sandbox: SandboxStatus;
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
    sandbox: {
      backend: input.sandbox.backend,
      enforcementTier: input.sandbox.enforcementTier,
      features: [...(input.sandbox.features ?? [])].sort(),
    },
  } as unknown as JsonObjectT);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
    fixtureEnvExecutable: review.facts.envExecutable.path,
    bindingDigest: review.bindingDigest,
    credentialSourceClass: "deterministic test fixture (release capability withheld)",
    transport: "srt:vendored verified HTTPS with connect-time address guard",
  };
}

export function requestGitPushReview(
  context: GitPushRuntimeContext,
  executeParams: GitPushExecuteParams,
): GitPushRpcResult {
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
    throw new Error("git.push release-withheld fixture boundary is unavailable");
  }
  const request = parseRequest(executeParams.toolCall.args);
  const facts = inspectGitPushFacts(context.state, context.workspaceRoot, request);
  const now = context.state.config.nowMs?.() ?? Date.now();
  const reviewId = `git_push_review_${String(context.state.nextReviewId)}`;
  context.state.nextReviewId += 1;
  const createdAtMs = now;
  const expiresAtMs = now + GIT_PUSH_REVIEW_TTL_MS;
  const summary = reviewSummary(facts);
  const pending: PendingGitPushReview = {
    kind: "git-push",
    reviewId,
    summary,
    allowCommand: `keel approve ${reviewId} --scope once`,
    createdAtMs,
    expiresAtMs,
    bindingDigest: bindingDigest({
      executeParams,
      request,
      facts,
      reviewId,
      createdAtMs,
      expiresAtMs,
      sandbox,
    }),
    executeParams,
    request,
    facts,
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
  };
}

function parseRemoteRefs(output: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of output.trim().split("\n")) {
    if (line === "") continue;
    const [left, right] = line.split("\t");
    if (left === undefined || right === undefined) continue;
    refs.set(right, left);
  }
  return refs;
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

function sandboxCredential(
  state: GitPushRuntimeState,
  attemptRoot: string,
): SandboxCredentialProxyConfig {
  const home = join(attemptRoot, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    authorizationHeaders: [
      {
        host: state.config.fixture.host,
        scheme: "Basic",
        secret: Buffer.from(
          `${state.config.fixture.username}:${state.config.fixture.secret}`,
          "utf8",
        ).toString("base64"),
      },
    ],
    sandboxEnv: {
      HOME: home,
      XDG_CONFIG_HOME: home,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
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
    "http.followRedirects=false",
    "-c",
    "http.sslVerify=true",
    "-c",
    "http.maxRequests=1",
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
        review.facts.envExecutable.path,
      ],
      allowWrite: [attemptRoot],
      denyRead: [],
      denyWrite: [review.facts.workspaceRoot, ...(auditDir === undefined ? [] : [auditDir])],
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
): Promise<SandboxExecutionResult> {
  const timeout = AbortSignal.timeout(30_000);
  const signal =
    context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
  return await context.sandbox.execute(
    {
      // SRT intentionally bypasses its proxy for localhost by default. Slice 1's injected local
      // fixture must traverse that proxy so verified TLS, credential injection, and the address
      // guard remain real; clear only the child bypass variables for this exact non-release call.
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
    },
    gitProfile(review, attemptRoot, context.auditDir),
    { signal, credentialProxy: sandboxCredential(context.state, attemptRoot) },
  );
}

function initializeAttemptRepo(
  state: GitPushRuntimeState,
  review: PendingGitPushReview,
): { readonly attemptRoot: string; readonly gitDir: string } {
  const tempRoot = realpathSync(state.config.tempRoot);
  if (tempRoot !== review.facts.tempRoot)
    throw new Error("git.push temporary root identity changed");
  const attemptRoot = mkdtempSync(join(tempRoot, "attempt-"));
  chmodSync(attemptRoot, 0o700);
  const gitDir = join(attemptRoot, "repo.git");
  runHostGit(state, [
    "init",
    "--quiet",
    "--bare",
    `--object-format=${review.facts.objectFormat}`,
    gitDir,
  ]);
  const alternatesDir = join(gitDir, "objects", "info");
  mkdirSync(alternatesDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(alternatesDir, "alternates"), `${review.facts.objectStore}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { attemptRoot, gitDir };
}

function auditOutcome(
  context: GitPushRuntimeContext,
  review: PendingGitPushReview,
  payload: JsonObjectT,
): number {
  return context.appendAudit({
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
  });
}

export async function resolveGitPushReview(
  context: GitPushRuntimeContext,
  review: PendingGitPushReview,
  resolution: GitPushResolveParams,
): Promise<GitPushRpcResult> {
  const now = context.state.config.nowMs?.() ?? Date.now();
  const approved = resolution.approved === true && resolution.scope === "once";
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
      terminal: true,
    },
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
  if (now > review.expiresAtMs) {
    return {
      verdict: "deny",
      result: { kind: "git_push_denied", reason: "git.push review expired" },
      auditSeq: resolutionAuditSeq,
    };
  }
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
  const refreshedFacts = inspectGitPushFacts(context.state, context.workspaceRoot, review.request);
  const refreshedDigest = bindingDigest({
    executeParams: review.executeParams,
    request: review.request,
    facts: refreshedFacts,
    reviewId: review.reviewId,
    createdAtMs: review.createdAtMs,
    expiresAtMs: review.expiresAtMs,
    sandbox,
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
  try {
    const initialized = initializeAttemptRepo(context.state, review);
    attemptRoot = initialized.attemptRoot;
    const preflight = await runSandboxGit(context, review, attemptRoot, initialized.gitDir, [
      "ls-remote",
      "--symref",
      review.facts.canonicalUrl,
      "HEAD",
      review.facts.destinationRef,
    ]);
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
    const preflightRefs = parseRemoteRefs(preflight.stdout);
    const defaultBranch = preflightRefs.get("HEAD")?.startsWith("ref: ")
      ? preflightRefs.get("HEAD")!.slice("ref: ".length)
      : undefined;
    if (defaultBranch === review.facts.destinationRef) {
      const result = resultPayload(
        review,
        "failed",
        preflightRefs.get(review.facts.destinationRef) ?? null,
        false,
      );
      const auditSeq = context.appendAudit({
        eventType: "tool.deny",
        sessionId: review.executeParams.sessionId,
        payload: {
          toolName: GIT_PUSH_TOOL_NAME,
          args: review.executeParams.toolCall.args,
          reviewId: review.reviewId,
          reason: "remote default branch writes are blocked",
          result,
        },
        sideEffect: gitPushSideEffect(review.facts),
      });
      return {
        verdict: "deny",
        result,
        auditSeq,
      };
    }
    const before = preflightRefs.get(review.facts.destinationRef) ?? null;
    if (before === review.request.expectedHead) {
      const result = resultPayload(review, "already-at-commit", before, false);
      const auditSeq = auditOutcome(context, review, { result, phase: "preflight" });
      return { verdict: "allow", result, auditSeq };
    }
    const push = await runSandboxGit(context, review, attemptRoot, initialized.gitDir, [
      "push",
      "--porcelain",
      "--no-verify",
      "--recurse-submodules=no",
      review.facts.canonicalUrl,
      `${review.request.expectedHead}:${review.facts.destinationRef}`,
    ]);
    const verification = await runSandboxGit(context, review, attemptRoot, initialized.gitDir, [
      "ls-remote",
      review.facts.canonicalUrl,
      review.facts.destinationRef,
    ]);
    if (verification.exitCode !== 0) {
      const result = resultPayload(review, "indeterminate", null, true);
      const auditSeq = auditOutcome(context, review, {
        result,
        phase: "verification",
        pushExitCode: push.exitCode,
        verificationExitCode: verification.exitCode,
        actionMayHaveExecuted: true,
      });
      return {
        verdict: "deny",
        result,
        auditSeq,
      };
    }
    const observed = parseRemoteRefs(verification.stdout).get(review.facts.destinationRef) ?? null;
    const status =
      observed === review.request.expectedHead
        ? "pushed"
        : push.exitCode === 0
          ? "indeterminate"
          : "failed";
    const result = resultPayload(review, status, observed, true);
    const auditSeq = auditOutcome(context, review, {
      result,
      phase: "verified",
      pushExitCode: push.exitCode,
      verificationExitCode: verification.exitCode,
    });
    return status === "pushed"
      ? { verdict: "allow", result, auditSeq }
      : {
          verdict: "deny",
          result,
          auditSeq,
        };
  } catch (error) {
    const result = resultPayload(review, "indeterminate", null, true);
    const auditSeq = auditOutcome(context, review, {
      result,
      phase: "exception",
      actionMayHaveExecuted: true,
      errorClass: error instanceof Error ? error.name : "unknown",
    });
    return {
      verdict: "deny",
      result,
      auditSeq,
    };
  } finally {
    if (attemptRoot !== undefined) rmSync(attemptRoot, { recursive: true, force: true });
  }
}

export function isGitPushReviewId(value: string): boolean {
  return REVIEW_ID.test(value);
}

/** Construct the non-release Slice-1 authority from fixture-owned process state. */
export function createGitPushWalkingSkeletonAuthority(
  config: GitPushWalkingSkeletonConfig,
): GitPushAuthority {
  const state = createGitPushRuntimeState(config);
  const consumedReviews = new WeakSet<PendingGitPushReview>();
  const runtimeContext = (context: GitPushAuthorityContext): GitPushRuntimeContext => ({
    ...context,
    state,
  });
  return {
    capability: GIT_PUSH_CAPABILITY_V1,
    toolName: GIT_PUSH_TOOL_NAME,
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
