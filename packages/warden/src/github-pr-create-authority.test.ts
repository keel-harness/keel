import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supportedGitPushVersion, WARDEN_METHODS } from "@keel/shared";
import { AuditChainWriter } from "./audit/writer.js";
import {
  GitCredentialBrokerError,
  type GitCredentialBroker,
  type GitCredentialBrokerIdentity,
} from "./git-credential-broker.js";
import type {
  GithubPrCreateAuthorityContext,
  GithubPrCreateBindingAuthority,
  GithubPrCreateBindingAuthorityRequest,
  GithubPrCreateExecuteParams,
  GithubPrCreatePendingReview,
} from "./github-pr-create-authority.js";
import {
  createGithubPrCreateWalkingSkeletonAuthority,
  createGithubPrCreateProductionAuthority,
  GithubPrCreateInvalidParamsError,
  parseGithubPrCreateRequest,
  type GithubPrCreateWalkingSkeletonConfig,
} from "./github-pr-create.js";
import {
  CREDENTIAL_TLS_TERMINATION_CAPABILITY,
  EGRESS_ADDRESS_GUARD_CAPABILITY,
  type SandboxExecuteOptions,
  type SandboxExecutionResult,
  type SandboxInvocation,
  type SandboxPort,
  type SandboxProfile,
  type SandboxStatus,
} from "./sandbox.js";
import { handleRpcLine } from "./rpc-server.js";

const roots: string[] = [];
const repository = "keel-harness/keel";
const canonicalRemote = `https://github.com/${repository}.git`;
const brokerIdentity: GitCredentialBrokerIdentity = {
  version: "git-credential-broker/v1",
  gitExecutableDigest: `sha256:${"1".repeat(64)}`,
  configurationDigest: `sha256:${"2".repeat(64)}`,
  helperDigest: `sha256:${"3".repeat(64)}`,
  helperCount: 1,
};
const principal = {
  osUser: "github-pr-test",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
} as const;

function privateRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function git(args: readonly string[], cwd?: string): string {
  const result = spawnSync("git", [...args], {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"],
      HOME: privateRoot("keel-github-pr-git-home-"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.status !== 0) throw new Error(`test Git failed: ${args.join(" ")}`);
  return result.stdout.trim();
}

function workspace(): { readonly path: string; readonly head: string } {
  const path = privateRoot("keel-github-pr-workspace-");
  git(["init", "--initial-branch=main"], path);
  writeFileSync(join(path, "file.txt"), "base\n");
  git(["add", "."], path);
  git(["-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-m", "base"], path);
  git(["switch", "-c", "feature/pr"], path);
  writeFileSync(join(path, "file.txt"), "feature\n");
  git(["add", "."], path);
  git(["-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-m", "feature"], path);
  const head = git(["rev-parse", "HEAD"], path);
  git(["remote", "add", "origin", canonicalRemote], path);
  return { path, head };
}

function fakeBroker(token: string) {
  return {
    sourceClass: "operator Git credential helper (system/global config)",
    inspect: vi.fn(async () => brokerIdentity),
    resolve: vi.fn(async () => ({ scheme: "Basic" as const, secret: "unused" })),
    resolveBearer: vi.fn(async () => ({ scheme: "Bearer" as const, secret: token })),
  } satisfies GitCredentialBroker & {
    resolveBearer: NonNullable<GitCredentialBroker["resolveBearer"]>;
  };
}

function bindingAuthority(
  request: GithubPrCreateBindingAuthorityRequest,
  workspaceRoot: string,
): GithubPrCreateBindingAuthority {
  const args = request.executeParams.toolCall.args;
  const parsed = parseGithubPrCreateRequest(args);
  return {
    policyInput: {
      tool: { name: request.executeParams.toolCall.name, args },
      normalized: {
        argv: [
          "github.pr.create",
          parsed.remote,
          parsed.repository,
          parsed.head,
          parsed.expectedHead,
          parsed.base,
          parsed.title,
          parsed.body,
          String(parsed.draft),
          String(parsed.maintainerCanModify),
        ],
        decodedLayers: [],
      },
      sideEffect: request.sideEffect,
      workspace: { path: workspaceRoot, trusted: true },
      provenance: { inputTags: ["workspace" as const] },
      egress: {
        isEgress: true,
        domain: request.host,
        gitRemote: request.canonicalUrl,
      },
      session: {
        id: request.executeParams.sessionId,
        mode: "enforced" as const,
        promptCountThisSession: 0,
      },
      principal: { osUser: "github-pr-test" },
    },
    policyDecision: { verdict: "review" as const, matchedRules: ["POL-GITHUB-PR-CREATE"] },
    policyPack: { name: "test-policy", hash: `sha256:${"9".repeat(64)}` as const },
    addressGuardRevision: "test-address-guard-v1",
    auditAuthorityId: "test-audit-authority-v1",
  };
}

const activeStatus: SandboxStatus = {
  available: true,
  backend: "srt:vendored",
  enforcementTier: "sandbox:srt",
  features: [
    CREDENTIAL_TLS_TERMINATION_CAPABILITY,
    EGRESS_ADDRESS_GUARD_CAPABILITY,
    "srt-launch-authority/v1",
  ],
};

function request(head: string): GithubPrCreateExecuteParams {
  return {
    sessionId: "session-github-pr",
    toolCall: {
      id: "call-github-pr",
      name: "github.pr.create",
      args: {
        remote: "origin",
        repository,
        head: "feature/pr",
        expectedHead: head,
        base: "main",
        title: "Ship the feature",
        body: "Summary\n\n- exact behavior",
        draft: false,
        maintainerCanModify: true,
      },
    },
    provenanceContext: { inputTags: ["workspace"] },
  };
}

function requestWithMaintainer(
  head: string,
  maintainerCanModify: boolean,
): GithubPrCreateExecuteParams {
  const execute = request(head);
  return {
    ...execute,
    toolCall: {
      ...execute.toolCall,
      args: { ...execute.toolCall.args, maintainerCanModify },
    },
  };
}

function refBody(ref: string, sha: string): Record<string, unknown> {
  return { ref, object: { type: "commit", sha } };
}

function prBody(head: string): Record<string, unknown> {
  return {
    number: 42,
    html_url: "https://github.com/keel-harness/keel/pull/42",
    state: "open",
    title: "Ship the feature",
    body: "Summary\n\n- exact behavior",
    draft: false,
    maintainer_can_modify: true,
    head: { ref: "feature/pr", sha: head, repo: { full_name: repository } },
    base: { ref: "main", repo: { full_name: repository } },
  };
}

function prListBody(head: string): Record<string, unknown> {
  return { ...prBody(head), maintainer_can_modify: null };
}

function prListBodyWithoutMaintainer(head: string): Record<string, unknown> {
  const body = prBody(head);
  delete body["maintainer_can_modify"];
  return body;
}

function prBodyWithNumber(head: string, number: number): Record<string, unknown> {
  return {
    ...prBody(head),
    number,
    html_url: `https://github.com/keel-harness/keel/pull/${String(number)}`,
  };
}

interface FakeApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly rawBody?: string;
  readonly transport?: "throw" | "exit" | "signal" | "stderr" | "invalid-status" | "remove";
}

interface HarnessOptions {
  readonly sandboxStatus?: SandboxStatus;
  readonly cleanupAttemptRoot?: (path: string) => void;
  readonly authorityTransform?: (
    authority: GithubPrCreateBindingAuthority,
  ) => GithubPrCreateBindingAuthority;
  readonly localResultTransform?: (result: SandboxExecutionResult) => SandboxExecutionResult;
  readonly preExecutionCheck?: () => void;
  readonly isAuditFailure?: (error: unknown) => boolean;
  readonly failAuditEvent?: string;
  readonly omitAuditDir?: boolean;
  readonly signal?: AbortSignal;
}

function harness(apiResponses: readonly FakeApiResponse[] = [], options: HarnessOptions = {}) {
  const source = workspace();
  const token = "github_pat_secret-canary";
  const broker = fakeBroker(token);
  const gitExecutable = resolve(spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim());
  const gitVersion = supportedGitPushVersion(
    spawnSync(gitExecutable, ["--version"], { encoding: "utf8" }).stdout,
  );
  if (gitVersion === undefined) throw new Error("unsupported test Git");
  const curlExecutable = join(privateRoot("keel-github-pr-curl-"), "curl");
  writeFileSync(curlExecutable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  let now = 1_000;
  const config: GithubPrCreateWalkingSkeletonConfig = {
    advertiseTestCapability: true,
    fixtureApi: {
      origin: "https://localhost:54321",
      host: "localhost",
      port: 54_321,
      address: "127.0.0.1",
    },
    credentialBroker: broker,
    gitExecutable,
    gitVersion,
    curlExecutable,
    curlVersion: "8.7.1",
    tempRoot: privateRoot("keel-github-pr-attempts-"),
    nowMs: () => now,
    ...(options.cleanupAttemptRoot === undefined
      ? {}
      : { cleanupAttemptRoot: options.cleanupAttemptRoot }),
  };
  const authority = createGithubPrCreateWalkingSkeletonAuthority(config);
  const audits: unknown[] = [];
  const executions: {
    readonly invocation: SandboxInvocation;
    readonly profile: SandboxProfile;
    readonly options: SandboxExecuteOptions | undefined;
  }[] = [];
  const queue = [...apiResponses];
  const sandbox: SandboxPort = {
    status: () => options.sandboxStatus ?? activeStatus,
    execute: async (invocation, profile, executeOptions): Promise<SandboxExecutionResult> => {
      executions.push({ invocation, profile, options: executeOptions });
      if (profile.network?.allowedDomains?.length === 0) {
        const local = spawnSync(invocation.command, invocation.argv?.slice(1) ?? [], {
          cwd: invocation.cwd,
          encoding: "utf8",
          env: executeOptions?.credentialProxy?.sandboxEnv,
        });
        const result = {
          exitCode: local.status,
          signal: local.signal,
          stdout: local.stdout,
          stderr: local.stderr,
        };
        return options.localResultTransform?.(result) ?? result;
      }
      const response = queue.shift();
      if (response === undefined) throw new Error("missing fake API response");
      if (response.transport === "throw") throw new Error("fake transport failure");
      const outputIndex = invocation.argv?.indexOf("--output") ?? -1;
      if (outputIndex < 0 || invocation.argv?.[outputIndex + 1] === undefined) {
        throw new Error("curl output file is not explicit");
      }
      const outputPath = invocation.argv[outputIndex + 1]!;
      if (response.transport === "remove") {
        unlinkSync(outputPath);
        mkdirSync(outputPath);
      } else {
        writeFileSync(outputPath, response.rawBody ?? JSON.stringify(response.body), {
          mode: 0o600,
        });
      }
      return {
        exitCode: response.transport === "exit" ? 17 : 0,
        signal: response.transport === "signal" ? "SIGTERM" : null,
        stdout: response.transport === "invalid-status" ? "200\n" : String(response.status),
        stderr: response.transport === "stderr" ? "bounded fake diagnostic" : "",
      };
    },
  };
  const context: GithubPrCreateAuthorityContext = {
    sandbox,
    workspaceRoot: source.path,
    ...(options.omitAuditDir ? {} : { auditDir: privateRoot("keel-github-pr-audit-") }),
    resolveBindingAuthority: async (binding) => {
      const authority = bindingAuthority(binding, source.path);
      return options.authorityTransform?.(authority) ?? authority;
    },
    appendAudit: (input) => {
      if (input.eventType === options.failAuditEvent) throw new Error("fake audit failure");
      audits.push(input);
      return audits.length;
    },
    ...(options.preExecutionCheck === undefined
      ? {}
      : { preExecutionCheck: options.preExecutionCheck }),
    ...(options.isAuditFailure === undefined ? {} : { isAuditFailure: options.isAuditFailure }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  return {
    source,
    token,
    broker,
    authority,
    context,
    audits,
    executions,
    queue,
    config,
    setNow: (value: number) => {
      now = value;
    },
  };
}

async function approveOnce(
  h: ReturnType<typeof harness>,
  execute: GithubPrCreateExecuteParams = request(h.source.head),
) {
  const requested = await h.authority.request(h.context, execute);
  const review = h.authority.consumeReview(requested.review!.reviewId)!;
  return await h.authority.resolve(h.context, review, {
    reviewId: requested.review!.reviewId,
    approved: true,
    scope: "once",
    principal,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ADR-0091 governed github.pr.create authority", () => {
  it("binds one exact request into a separate once-only review without API activity", async () => {
    const h = harness();
    const outcome = await h.authority.request(h.context, request(h.source.head));

    expect(outcome.verdict).toBe("review");
    expect(outcome.review?.reviewId).toBe("github_pr_create_review_1");
    expect(outcome.review?.allowCommand).toBe(
      "keel approve github_pr_create_review_1 --scope once",
    );
    expect(outcome.review?.summary.split("\n")).toHaveLength(13);
    expect(outcome.review?.summary).toContain(`Remote: ${canonicalRemote}`);
    expect(outcome.review?.summary).toContain(`Head: refs/heads/feature/pr @ ${h.source.head}`);
    expect(outcome.review?.summary).toContain('Title JSON: "Ship the feature"');
    expect(
      h.executions.every((entry) => (entry.profile.network?.allowedDomains?.length ?? 0) === 0),
    ).toBe(true);
    expect(h.broker.resolveBearer).not.toHaveBeenCalled();
    expect(JSON.stringify(h.audits)).not.toContain(h.token);
  });

  it("returns an audited credential-unavailable result when helper inspection fails before review", async () => {
    const brokerCanary = "raw-pr-helper-output-DO-NOT-RETAIN";
    const h = harness();
    h.broker.inspect.mockRejectedValueOnce(new GitCredentialBrokerError(brokerCanary));

    const outcome = await h.authority.request(h.context, request(h.source.head));

    expect(outcome).toMatchObject({
      verdict: "deny",
      result: {
        kind: "github_pr_create_result",
        status: "failed",
        repository,
        head: "feature/pr",
        base: "main",
        commit: h.source.head,
        number: null,
        url: null,
        failureKind: "credential-unavailable",
        automaticRetry: false,
        actionMayHaveExecuted: false,
      },
    });
    expect(h.authority.pendingReviewCount()).toBe(0);
    expect(h.broker.inspect).toHaveBeenCalledTimes(1);
    expect(h.broker.resolveBearer).not.toHaveBeenCalled();
    expect(
      h.executions.filter((entry) => (entry.profile.network?.allowedDomains?.length ?? 0) > 0),
    ).toEqual([]);
    expect(JSON.stringify(outcome)).not.toContain(brokerCanary);
    expect(JSON.stringify(h.audits)).not.toContain(brokerCanary);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      eventType: "tool.deny",
      payload: {
        code: "CREDENTIAL_UNAVAILABLE",
        result: {
          failureKind: "credential-unavailable",
          actionMayHaveExecuted: false,
        },
      },
    });
  });

  it("creates one PR after approval and verifies the exact resulting object", async () => {
    const h = harness();
    h.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", h.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [] },
      { status: 201, body: prBody(h.source.head) },
      { status: 200, body: [prBody(h.source.head)] },
      { status: 200, body: prBody(h.source.head) },
    );
    const execute = request(h.source.head);
    const requested = await h.authority.request(h.context, execute);
    const opaque = h.authority.consumeReview(requested.review!.reviewId)!;

    const outcome = await h.authority.resolve(h.context, opaque, {
      reviewId: requested.review!.reviewId,
      approved: true,
      scope: "once",
      principal,
    });

    expect(outcome).toMatchObject({
      verdict: "allow",
      result: {
        kind: "github_pr_create_result",
        status: "created",
        repository,
        head: "feature/pr",
        base: "main",
        commit: h.source.head,
        number: 42,
        url: "https://github.com/keel-harness/keel/pull/42",
        automaticRetry: false,
        actionMayHaveExecuted: true,
      },
    });
    expect(h.queue).toHaveLength(0);
    expect(h.broker.resolveBearer).toHaveBeenCalledOnce();
    const network = h.executions.filter(
      (entry) => (entry.profile.network?.allowedDomains?.length ?? 0) > 0,
    );
    expect(network).toHaveLength(6);
    expect(
      network.filter((entry) => entry.invocation.argv?.includes("POST") === true),
    ).toHaveLength(1);
    expect(
      network.every((entry) => entry.profile.network?.allowedDomains?.join() === "localhost"),
    ).toBe(true);
    expect(
      network.every((entry) => {
        const noProxy = entry.invocation.argv?.indexOf("--noproxy") ?? -1;
        return noProxy >= 0 && entry.invocation.argv?.[noProxy + 1] === "";
      }),
    ).toBe(true);
    expect(JSON.stringify(network.map((entry) => entry.invocation))).not.toContain(h.token);
    expect(
      JSON.stringify(network.map((entry) => entry.options?.credentialProxy?.sandboxEnv)),
    ).not.toContain(h.token);
    expect(network[3]?.options?.credentialProxy?.authorizationHeaders).toEqual([
      { host: "localhost", scheme: "Bearer", secret: h.token },
    ]);
    expect(JSON.stringify(h.audits)).not.toContain(h.token);
  });

  it("confirms a provider-null list candidate only through its exact PR detail resource", async () => {
    const h = harness();
    const detail = { ...prBody(h.source.head), maintainer_can_modify: false };
    const execute = requestWithMaintainer(h.source.head, false);
    h.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", h.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [] },
      { status: 201, body: { message: "lost success body" }, rawBody: "{" },
      { status: 200, body: [prListBody(h.source.head)] },
      { status: 200, body: detail },
    );

    await expect(approveOnce(h, execute)).resolves.toMatchObject({
      verdict: "allow",
      result: {
        status: "created",
        number: 42,
        url: "https://github.com/keel-harness/keel/pull/42",
        actionMayHaveExecuted: true,
      },
    });
    expect(h.queue).toHaveLength(0);
    const network = h.executions.filter(
      (entry) => (entry.profile.network?.allowedDomains?.length ?? 0) > 0,
    );
    expect(network).toHaveLength(6);
    expect(network.at(-1)?.invocation.argv?.at(-1)).toBe(
      "https://localhost:54321/repos/keel-harness/keel/pulls/42",
    );
  });

  it("recovers an existing provider-null list candidate only after exact detail verification", async () => {
    const h = harness();
    const detail = { ...prBody(h.source.head), maintainer_can_modify: false };
    const execute = requestWithMaintainer(h.source.head, false);
    h.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", h.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [prListBody(h.source.head)] },
      { status: 200, body: detail },
    );

    await expect(approveOnce(h, execute)).resolves.toMatchObject({
      verdict: "allow",
      result: {
        status: "already-exists",
        number: 42,
        actionMayHaveExecuted: false,
      },
    });
    expect(h.queue).toHaveLength(0);
    expect(h.executions.some((entry) => entry.invocation.argv?.includes("POST") === true)).toBe(
      false,
    );
  });

  it("recovers an existing provider-omitted list candidate only after exact detail verification", async () => {
    const h = harness();
    const detail = { ...prBody(h.source.head), maintainer_can_modify: false };
    const execute = requestWithMaintainer(h.source.head, false);
    h.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", h.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [prListBodyWithoutMaintainer(h.source.head)] },
      { status: 200, body: detail },
    );

    await expect(approveOnce(h, execute)).resolves.toMatchObject({
      verdict: "allow",
      result: {
        status: "already-exists",
        number: 42,
        actionMayHaveExecuted: false,
      },
    });
    expect(h.queue).toHaveLength(0);
    expect(h.executions.some((entry) => entry.invocation.argv?.includes("POST") === true)).toBe(
      false,
    );
  });

  it("fails closed when a provider-null candidate detail does not prove the approved posture", async () => {
    const existing = harness();
    const existingExecute = requestWithMaintainer(existing.source.head, false);
    existing.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", existing.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [prListBody(existing.source.head)] },
      { status: 200, body: prBody(existing.source.head) },
    );
    await expect(approveOnce(existing, existingExecute)).resolves.toMatchObject({
      verdict: "deny",
      result: { status: "failed", actionMayHaveExecuted: false },
    });
    expect(
      existing.executions.some((entry) => entry.invocation.argv?.includes("POST") === true),
    ).toBe(false);

    const omitted = harness();
    const omittedExecute = requestWithMaintainer(omitted.source.head, false);
    omitted.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", omitted.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [prListBodyWithoutMaintainer(omitted.source.head)] },
      { status: 200, body: prListBodyWithoutMaintainer(omitted.source.head) },
    );
    await expect(approveOnce(omitted, omittedExecute)).resolves.toMatchObject({
      verdict: "deny",
      result: { status: "failed", actionMayHaveExecuted: false },
    });
    expect(
      omitted.executions.some((entry) => entry.invocation.argv?.includes("POST") === true),
    ).toBe(false);

    const afterPost = harness();
    const afterPostExecute = requestWithMaintainer(afterPost.source.head, false);
    afterPost.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", afterPost.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [] },
      { status: 201, body: { message: "lost success body" }, rawBody: "{" },
      { status: 200, body: [prListBody(afterPost.source.head)] },
      { status: 200, body: prBody(afterPost.source.head) },
    );
    await expect(approveOnce(afterPost, afterPostExecute)).resolves.toMatchObject({
      verdict: "deny",
      result: { status: "indeterminate", actionMayHaveExecuted: true },
    });
    expect(
      afterPost.executions.filter((entry) => entry.invocation.argv?.includes("POST") === true),
    ).toHaveLength(1);
  });

  it("requires every candidate detail field and transport outcome before confirmed success", async () => {
    const detailCases: Array<(head: string) => FakeApiResponse> = [
      () => ({ status: 404, body: { message: "not found" } }),
      () => ({ status: 200, body: null }),
      () => ({ status: 200, body: {}, rawBody: "{" }),
      () => ({ status: 200, body: {}, transport: "throw" }),
      (head) => ({ status: 200, body: prBodyWithNumber(head, 43) }),
      (head) => ({
        status: 200,
        body: { ...prBody(head), html_url: "https://github.com/attacker/repo/pull/42" },
      }),
      (head) => ({ status: 200, body: { ...prBody(head), title: "drifted" } }),
      (head) => ({ status: 200, body: { ...prBody(head), body: "drifted" } }),
      (head) => ({ status: 200, body: { ...prBody(head), draft: true } }),
      (head) => ({
        status: 200,
        body: { ...prBody(head), head: { ...(prBody(head)["head"] as object), ref: "other" } },
      }),
      (head) => ({
        status: 200,
        body: {
          ...prBody(head),
          head: { ...(prBody(head)["head"] as object), sha: "f".repeat(40) },
        },
      }),
      (head) => ({
        status: 200,
        body: {
          ...prBody(head),
          head: { ...(prBody(head)["head"] as object), repo: { full_name: "attacker/repo" } },
        },
      }),
      (head) => ({
        status: 200,
        body: { ...prBody(head), base: { ...(prBody(head)["base"] as object), ref: "other" } },
      }),
    ];
    for (const detailCase of detailCases) {
      const h = harness();
      h.queue.push(
        { status: 200, body: refBody("refs/heads/feature/pr", h.source.head) },
        { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
        { status: 200, body: [prBody(h.source.head)] },
        detailCase(h.source.head),
      );
      await expect(approveOnce(h)).resolves.toMatchObject({
        verdict: "deny",
        result: { status: "failed", actionMayHaveExecuted: false },
      });
      expect(h.executions.some((entry) => entry.invocation.argv?.includes("POST") === true)).toBe(
        false,
      );
    }
  });

  it("keeps a valid 201 with a different verified PR identity indeterminate", async () => {
    const h = harness();
    h.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", h.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [] },
      { status: 201, body: prBody(h.source.head) },
      { status: 200, body: [prBodyWithNumber(h.source.head, 43)] },
      { status: 200, body: prBodyWithNumber(h.source.head, 43) },
    );

    await expect(approveOnce(h)).resolves.toMatchObject({
      verdict: "deny",
      result: {
        status: "indeterminate",
        number: null,
        url: null,
        actionMayHaveExecuted: true,
      },
    });
    expect(
      h.executions.filter((entry) => entry.invocation.argv?.includes("POST") === true),
    ).toHaveLength(1);
  });

  it("keeps a 422 with an unresolved list candidate indeterminate", async () => {
    const h = harness();
    h.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", h.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [] },
      { status: 422, body: { message: "validation failed" } },
      { status: 200, body: [prListBody(h.source.head)] },
      { status: 200, body: {}, rawBody: "{" },
    );

    await expect(approveOnce(h)).resolves.toMatchObject({
      verdict: "deny",
      result: { status: "indeterminate", actionMayHaveExecuted: true },
    });
    expect(
      h.executions.filter((entry) => entry.invocation.argv?.includes("POST") === true),
    ).toHaveLength(1);
  });

  it("returns an exact existing PR without POSTing or claiming a new mutation", async () => {
    const h = harness();
    h.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", h.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [prBody(h.source.head)] },
      { status: 200, body: prBody(h.source.head) },
    );
    const requested = await h.authority.request(h.context, request(h.source.head));
    const review = h.authority.consumeReview(requested.review!.reviewId)!;

    const outcome = await h.authority.resolve(h.context, review, {
      reviewId: requested.review!.reviewId,
      approved: true,
      scope: "once",
      principal,
    });

    expect(outcome).toMatchObject({
      verdict: "allow",
      result: {
        status: "already-exists",
        number: 42,
        automaticRetry: false,
        actionMayHaveExecuted: false,
      },
    });
    const network = h.executions.filter(
      (entry) => (entry.profile.network?.allowedDomains?.length ?? 0) > 0,
    );
    expect(network).toHaveLength(4);
    expect(network.some((entry) => entry.invocation.argv?.includes("POST") === true)).toBe(false);
  });

  it("uses one read-only reconciliation and returns indeterminate after an ambiguous POST", async () => {
    const h = harness();
    h.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", h.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [] },
      { status: 500, body: { message: "ambiguous upstream response" } },
      { status: 200, body: [] },
    );
    const requested = await h.authority.request(h.context, request(h.source.head));
    const review = h.authority.consumeReview(requested.review!.reviewId)!;

    const outcome = await h.authority.resolve(h.context, review, {
      reviewId: requested.review!.reviewId,
      approved: true,
      scope: "once",
      principal,
    });

    expect(outcome).toMatchObject({
      verdict: "deny",
      result: {
        status: "indeterminate",
        number: null,
        automaticRetry: false,
        actionMayHaveExecuted: true,
      },
    });
    const network = h.executions.filter(
      (entry) => (entry.profile.network?.allowedDomains?.length ?? 0) > 0,
    );
    expect(network).toHaveLength(5);
    expect(
      network.filter((entry) => entry.invocation.argv?.includes("POST") === true),
    ).toHaveLength(1);
  });

  it("treats a verified 422 rejection as failed without retrying", async () => {
    const h = harness();
    h.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", h.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [] },
      { status: 422, body: { message: "validation failed" } },
      { status: 200, body: [] },
    );
    const requested = await h.authority.request(h.context, request(h.source.head));
    const review = h.authority.consumeReview(requested.review!.reviewId)!;

    const outcome = await h.authority.resolve(h.context, review, {
      reviewId: requested.review!.reviewId,
      approved: true,
      scope: "once",
      principal,
    });

    expect(outcome).toMatchObject({
      verdict: "deny",
      result: { status: "failed", automaticRetry: false, actionMayHaveExecuted: false },
    });
    const network = h.executions.filter(
      (entry) => (entry.profile.network?.allowedDomains?.length ?? 0) > 0,
    );
    expect(
      network.filter((entry) => entry.invocation.argv?.includes("POST") === true),
    ).toHaveLength(1);
  });

  it("fails closed on expiry, non-once scope, and local binding drift before credential resolution", async () => {
    const expired = harness();
    const expiredRequest = await expired.authority.request(
      expired.context,
      request(expired.source.head),
    );
    const expiredReview = expired.authority.consumeReview(expiredRequest.review!.reviewId)!;
    expired.setNow(121_000);
    const expiredOutcome = await expired.authority.resolve(expired.context, expiredReview, {
      reviewId: expiredRequest.review!.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    expect(expiredOutcome.verdict).toBe("deny");
    expect(expiredOutcome.result?.["reason"]).toMatch(/expired/u);
    expect(expired.broker.resolveBearer).not.toHaveBeenCalled();

    const project = harness();
    const projectRequest = await project.authority.request(
      project.context,
      request(project.source.head),
    );
    const projectReview = project.authority.consumeReview(projectRequest.review!.reviewId)!;
    const projectOutcome = await project.authority.resolve(project.context, projectReview, {
      reviewId: projectRequest.review!.reviewId,
      approved: true,
      scope: "project",
      principal,
    });
    expect(projectOutcome.verdict).toBe("deny");
    expect(projectOutcome.result?.["reason"]).toMatch(/once-only/u);
    expect(project.broker.resolveBearer).not.toHaveBeenCalled();

    const drift = harness();
    const driftRequest = await drift.authority.request(drift.context, request(drift.source.head));
    const driftReview = drift.authority.consumeReview(driftRequest.review!.reviewId)!;
    git(
      ["config", "remote.origin.pushurl", "https://github.com/attacker/repo.git"],
      drift.source.path,
    );
    const driftOutcome = await drift.authority.resolve(drift.context, driftReview, {
      reviewId: driftRequest.review!.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    expect(driftOutcome.verdict).toBe("deny");
    expect(driftOutcome.result?.["reason"]).toMatch(/changed/u);
    expect(drift.broker.resolveBearer).not.toHaveBeenCalled();
  });

  it("rejects unavailable transport, wrong tools, invalid runtime authority, and unconsumed reviews", async () => {
    const unavailable = harness([], {
      sandboxStatus: { ...activeStatus, features: [EGRESS_ADDRESS_GUARD_CAPABILITY] },
    });
    await expect(
      unavailable.authority.request(unavailable.context, request(unavailable.source.head)),
    ).rejects.toThrow(/transport boundary is unavailable/u);

    const processScopedProxy = harness([], {
      sandboxStatus: {
        ...activeStatus,
        features: [CREDENTIAL_TLS_TERMINATION_CAPABILITY, EGRESS_ADDRESS_GUARD_CAPABILITY],
      },
    });
    await expect(
      processScopedProxy.authority.request(
        processScopedProxy.context,
        request(processScopedProxy.source.head),
      ),
    ).rejects.toThrow(/transport boundary is unavailable/u);

    const wrongTool = harness();
    await expect(
      wrongTool.authority.request(wrongTool.context, {
        ...request(wrongTool.source.head),
        toolCall: { ...request(wrongTool.source.head).toolCall, name: "git.push" },
      }),
    ).rejects.toThrow(/unexpected tool name/u);
    expect(wrongTool.authority.consumeReview("github_pr_create_review_999")).toBeUndefined();
    await expect(
      wrongTool.authority.resolve(wrongTool.context, {} as GithubPrCreatePendingReview, {
        reviewId: "github_pr_create_review_999",
        approved: true,
        scope: "once",
        principal,
      }),
    ).rejects.toThrow(/not consumed/u);
    expect(() =>
      wrongTool.authority.auditInvalidParams(
        wrongTool.context,
        request(wrongTool.source.head),
        new Error("wrong class"),
      ),
    ).toThrow(/non-parameter error/u);

    const base = wrongTool.config;
    expect(() =>
      createGithubPrCreateWalkingSkeletonAuthority({ ...base, curlVersion: "9.0.0" }),
    ).toThrow(/executable or credential authority/u);
    expect(() =>
      createGithubPrCreateWalkingSkeletonAuthority({
        ...base,
        gitExecutable: base.tempRoot,
      }),
    ).toThrow(/ordinary files/u);
    chmodSync(base.tempRoot, 0o755);
    expect(() => createGithubPrCreateWalkingSkeletonAuthority(base)).toThrow(/owner-only/u);
    chmodSync(base.tempRoot, 0o700);
    expect(() =>
      createGithubPrCreateWalkingSkeletonAuthority({
        ...base,
        fixtureApi: { ...base.fixtureApi, origin: "http://localhost:54321" },
      }),
    ).toThrow(/fixture API/u);
  });

  it("denies hostile repository shapes and exact binding mismatches before approval", async () => {
    const cases: Array<readonly [string, (h: ReturnType<typeof harness>) => void]> = [
      [
        "shallow",
        (h) => writeFileSync(join(h.source.path, ".git", "shallow"), `${h.source.head}\n`),
      ],
      [
        "widening config",
        (h) => git(["config", "http.https://github.com/.extraheader", "secret"], h.source.path),
      ],
      [
        "included config outside the bound repository config",
        (h) => {
          const includePath = join(privateRoot("keel-github-pr-include-"), "included-config");
          writeFileSync(includePath, "[color]\n\tui = false\n");
          git(["config", "include.path", includePath], h.source.path);
        },
      ],
      [
        "conditional included config outside the bound repository config",
        (h) => {
          const includePath = join(privateRoot("keel-github-pr-include-if-"), "included-config");
          writeFileSync(includePath, "[color]\n\tui = false\n");
          git(["config", "includeIf.gitdir:/tmp/.path", includePath], h.source.path);
        },
      ],
      ["missing base", (h) => git(["branch", "-D", "main"], h.source.path)],
      [
        "remote mismatch",
        (h) =>
          git(
            ["remote", "set-url", "origin", "https://github.com/attacker/repo.git"],
            h.source.path,
          ),
      ],
    ];
    for (const [label, mutate] of cases) {
      const h = harness();
      mutate(h);
      const rejected = await h.authority.request(h.context, request(h.source.head)).then(
        () => new Error(`accepted hostile repository case: ${label}`),
        (error: unknown) => error,
      );
      if (!(rejected instanceof GithubPrCreateInvalidParamsError)) throw rejected;
      expect(h.broker.resolveBearer).not.toHaveBeenCalled();
    }

    const wrongBranch = harness();
    await expect(
      wrongBranch.authority.request(wrongBranch.context, {
        ...request(wrongBranch.source.head),
        toolCall: {
          ...request(wrongBranch.source.head).toolCall,
          args: { ...request(wrongBranch.source.head).toolCall.args, head: "feature/other" },
        },
      }),
    ).rejects.toThrow(/current local branch/u);

    const wrongOid = harness();
    await expect(
      wrongOid.authority.request(wrongOid.context, request("f".repeat(40))),
    ).rejects.toThrow(/current local commit/u);

    const configLink = harness();
    const configPath = join(configLink.source.path, ".git", "config");
    const outsideConfig = join(privateRoot("keel-github-pr-config-"), "config");
    writeFileSync(outsideConfig, readFileSync(configPath));
    unlinkSync(configPath);
    symlinkSync(outsideConfig, configPath);
    await expect(
      configLink.authority.request(configLink.context, request(configLink.source.head)),
    ).rejects.toThrow(/config must be one ordinary file/u);

    const mismatched = harness([], {
      authorityTransform: (authority) => ({ ...authority, auditAuthorityId: "" }),
    });
    await expect(
      mismatched.authority.request(mismatched.context, request(mismatched.source.head)),
    ).rejects.toThrow(/did not match/u);

    const denied = harness([], {
      authorityTransform: (authority) => ({
        ...authority,
        policyDecision: { verdict: "deny", matchedRules: ["POL-DENY"] },
      }),
    });
    const deniedOutcome = await denied.authority.request(
      denied.context,
      request(denied.source.head),
    );
    expect(deniedOutcome.verdict).toBe("deny");
    expect(deniedOutcome.result?.["reason"]).toMatch(/denies/u);
  });

  it("removes pending authority when the durable review audit fails", async () => {
    const h = harness([], { failAuditEvent: "review.requested" });
    await expect(h.authority.request(h.context, request(h.source.head))).rejects.toThrow(
      /fake audit failure/u,
    );
    expect(h.authority.pendingReviewCount()).toBe(0);
  });

  it("bounds contained Git failures and accepts only one normalized CRLF terminator", async () => {
    const oversized = harness([], {
      localResultTransform: (result) => ({ ...result, stdout: "x".repeat(65_537) }),
    });
    await expect(
      oversized.authority.request(oversized.context, request(oversized.source.head)),
    ).rejects.toThrow(/output bound/u);

    const failed = harness([], {
      localResultTransform: (result) => ({ ...result, exitCode: 17 }),
    });
    await expect(
      failed.authority.request(failed.context, request(failed.source.head)),
    ).rejects.toThrow(/local Git inspection failed/u);

    const controller = new AbortController();
    const crlf = harness([], {
      omitAuditDir: true,
      signal: controller.signal,
      localResultTransform: (result) => ({
        ...result,
        stdout: result.stdout.endsWith("\n") ? `${result.stdout.slice(0, -1)}\r\n` : result.stdout,
      }),
    });
    await expect(
      crlf.authority.request(crlf.context, request(crlf.source.head)),
    ).resolves.toMatchObject({ verdict: "review" });
  });

  it("fails closed on pre-execution drift and stale sibling generations", async () => {
    const precheck = harness([], {
      preExecutionCheck: () => {
        throw new TypeError("temporary root changed");
      },
    });
    const precheckRequest = await precheck.authority.request(
      precheck.context,
      request(precheck.source.head),
    );
    const precheckReview = precheck.authority.consumeReview(precheckRequest.review!.reviewId)!;
    const precheckOutcome = await precheck.authority.resolve(precheck.context, precheckReview, {
      reviewId: precheckRequest.review!.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    expect(precheckOutcome.verdict).toBe("deny");
    expect(precheckOutcome.result?.["reason"]).toMatch(/temporary/u);
    expect(precheck.broker.resolveBearer).not.toHaveBeenCalled();

    const sibling = harness();
    sibling.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", sibling.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [prBody(sibling.source.head)] },
    );
    const first = await sibling.authority.request(sibling.context, request(sibling.source.head));
    const second = await sibling.authority.request(sibling.context, {
      ...request(sibling.source.head),
      toolCall: { ...request(sibling.source.head).toolCall, id: "call-github-pr-sibling" },
    });
    const firstReview = sibling.authority.consumeReview(first.review!.reviewId)!;
    const secondReview = sibling.authority.consumeReview(second.review!.reviewId)!;
    await sibling.authority.resolve(sibling.context, firstReview, {
      reviewId: first.review!.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    sibling.setNow(1_001);
    await expect(
      sibling.authority.resolve(sibling.context, secondReview, {
        reviewId: second.review!.reviewId,
        approved: true,
        scope: "once",
        principal,
      }),
    ).resolves.toMatchObject({ verdict: "deny" });
  });

  it("classifies malformed and failed remote-ref observations without POSTing", async () => {
    const firstResponseCases: readonly FakeApiResponse[] = [
      { status: 500, body: {} },
      { status: 200, body: null },
      {
        status: 200,
        body: { ref: "refs/heads/other", object: { type: "commit", sha: "f".repeat(40) } },
      },
      { status: 200, body: { ref: "refs/heads/feature/pr", object: null } },
      {
        status: 200,
        body: { ref: "refs/heads/feature/pr", object: { type: "tag", sha: "f".repeat(40) } },
      },
      {
        status: 200,
        body: { ref: "refs/heads/feature/pr", object: { type: "commit", sha: "bad" } },
      },
      { status: 200, body: refBody("refs/heads/feature/pr", "f".repeat(40)) },
      { status: 200, body: {}, transport: "throw" },
      { status: 200, body: {}, transport: "exit" },
      { status: 200, body: {}, transport: "signal" },
      { status: 200, body: {}, transport: "stderr" },
      { status: 200, body: {}, transport: "invalid-status" },
      { status: 200, body: {}, transport: "remove" },
      { status: 200, body: {}, rawBody: "{" },
      { status: 200, body: {}, rawBody: "x".repeat(1_048_577) },
    ];
    for (const first of firstResponseCases) {
      const h = harness([first]);
      await expect(approveOnce(h)).resolves.toMatchObject({
        verdict: "deny",
        result: { status: "failed", actionMayHaveExecuted: false },
      });
      expect(h.executions.some((entry) => entry.invocation.argv?.includes("POST") === true)).toBe(
        false,
      );
    }

    const badBase = harness();
    badBase.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", badBase.source.head) },
      { status: 200, body: refBody("refs/heads/other", "b".repeat(40)) },
    );
    await expect(approveOnce(badBase)).resolves.toMatchObject({
      verdict: "deny",
      result: { status: "failed" },
    });
  });

  it("rejects malformed, duplicate, and conflicting existing-PR observations", async () => {
    const malformedPrs: Array<(head: string) => unknown> = [
      () => null,
      () => ({}),
      (head) => ({ ...prBody(head), number: 0 }),
      (head) => ({ ...prBody(head), number: 1.5 }),
      (head) => ({ ...prBody(head), html_url: "https://github.com/attacker/repo/pull/42" }),
      (head) => ({ ...prBody(head), state: "closed" }),
      (head) => ({ ...prBody(head), title: "other" }),
      (head) => ({ ...prBody(head), body: "other" }),
      (head) => ({ ...prBody(head), draft: true }),
      (head) => ({ ...prBody(head), maintainer_can_modify: false }),
      (head) => ({ ...prBody(head), head: { ...(prBody(head)["head"] as object), ref: "other" } }),
      (head) => ({
        ...prBody(head),
        head: { ...(prBody(head)["head"] as object), sha: "f".repeat(40) },
      }),
      (head) => ({ ...prBody(head), base: { ...(prBody(head)["base"] as object), ref: "other" } }),
      (head) => ({
        ...prBody(head),
        head: { ...(prBody(head)["head"] as object), repo: { full_name: "attacker/repo" } },
      }),
      (head) => ({
        ...prBody(head),
        base: { ...(prBody(head)["base"] as object), repo: { full_name: "attacker/repo" } },
      }),
    ];
    for (const malformed of malformedPrs) {
      const h = harness();
      h.queue.push(
        { status: 200, body: refBody("refs/heads/feature/pr", h.source.head) },
        { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
        { status: 200, body: [malformed(h.source.head)] },
      );
      await expect(approveOnce(h)).resolves.toMatchObject({
        verdict: "deny",
        result: { status: "failed" },
      });
    }

    for (const observation of [
      "object",
      "oversized",
      "duplicate",
      "provider-null-duplicate",
    ] as const) {
      const h = harness();
      const exact = prBody(h.source.head);
      const body =
        observation === "object"
          ? { message: "not an array" }
          : observation === "oversized"
            ? Array.from({ length: 101 }, () => ({}))
            : observation === "duplicate"
              ? [exact, exact]
              : [prListBody(h.source.head), prListBody(h.source.head)];
      h.queue.push(
        { status: 200, body: refBody("refs/heads/feature/pr", h.source.head) },
        { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
        { status: 200, body },
      );
      await expect(approveOnce(h)).resolves.toMatchObject({
        verdict: "deny",
        result: { status: "failed" },
      });
    }

    const exactPlusConflict = harness();
    exactPlusConflict.queue.push(
      {
        status: 200,
        body: refBody("refs/heads/feature/pr", exactPlusConflict.source.head),
      },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      {
        status: 200,
        body: [
          prBody(exactPlusConflict.source.head),
          { ...prBody(exactPlusConflict.source.head), title: "conflicting title" },
        ],
      },
    );
    await expect(approveOnce(exactPlusConflict)).resolves.toMatchObject({
      verdict: "deny",
      result: { status: "failed", actionMayHaveExecuted: false },
    });
    expect(
      exactPlusConflict.executions.some(
        (entry) => entry.invocation.argv?.includes("POST") === true,
      ),
    ).toBe(false);
  });

  it("reconciles one exact result and distinguishes definitive from ambiguous failures", async () => {
    const reconciled = harness();
    reconciled.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", reconciled.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [] },
      { status: 201, body: { message: "malformed success" } },
      { status: 200, body: [prBody(reconciled.source.head)] },
      { status: 200, body: prBody(reconciled.source.head) },
    );
    await expect(approveOnce(reconciled)).resolves.toMatchObject({
      verdict: "allow",
      result: { status: "created", actionMayHaveExecuted: true },
    });

    const forbidden = harness();
    forbidden.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", forbidden.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [] },
      { status: 403, body: { message: "forbidden" } },
      { status: 200, body: [] },
    );
    await expect(approveOnce(forbidden)).resolves.toMatchObject({
      verdict: "deny",
      result: { status: "failed", actionMayHaveExecuted: false },
    });

    const badVerification = harness();
    badVerification.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", badVerification.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [] },
      { status: 201, body: prBody(badVerification.source.head) },
      { status: 200, body: [] },
    );
    await expect(approveOnce(badVerification)).resolves.toMatchObject({
      verdict: "deny",
      result: { status: "indeterminate", actionMayHaveExecuted: true },
    });

    const ambiguousVerification = harness();
    ambiguousVerification.queue.push(
      {
        status: 200,
        body: refBody("refs/heads/feature/pr", ambiguousVerification.source.head),
      },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [] },
      { status: 201, body: prBody(ambiguousVerification.source.head) },
      {
        status: 200,
        body: [
          prBody(ambiguousVerification.source.head),
          { ...prBody(ambiguousVerification.source.head), title: "conflicting title" },
        ],
      },
    );
    await expect(approveOnce(ambiguousVerification)).resolves.toMatchObject({
      verdict: "deny",
      result: { status: "indeterminate", actionMayHaveExecuted: true },
    });
  });

  it("contains pre- and post-attempt exceptions, propagates audit faults, and quarantines cleanup failure", async () => {
    const credentialFailure = harness();
    credentialFailure.broker.resolveBearer.mockRejectedValueOnce(new TypeError("broker failed"));
    await expect(approveOnce(credentialFailure)).resolves.toMatchObject({
      verdict: "deny",
      result: { status: "failed", actionMayHaveExecuted: false },
    });

    const auditFault = new Error("audit unavailable");
    const classified = harness([], { isAuditFailure: (error) => error === auditFault });
    classified.broker.resolveBearer.mockRejectedValueOnce(auditFault);
    await expect(approveOnce(classified)).rejects.toBe(auditFault);

    const cleanup = harness([], {
      cleanupAttemptRoot: () => {
        throw new Error("cleanup failed");
      },
    });
    cleanup.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", cleanup.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [prBody(cleanup.source.head)] },
      { status: 200, body: prBody(cleanup.source.head) },
    );
    await expect(approveOnce(cleanup)).resolves.toMatchObject({
      verdict: "allow",
      result: { status: "already-exists" },
    });
    expect(
      cleanup.authority.capabilityAvailable({
        workspaceTrusted: true,
        auditAvailable: true,
        sandbox: activeStatus,
      }),
    ).toBe(false);
  });

  it("uses the production api.github.com authority without fixture transport escape", async () => {
    const h = harness();
    h.queue.push(
      { status: 200, body: refBody("refs/heads/feature/pr", h.source.head) },
      { status: 200, body: refBody("refs/heads/main", "b".repeat(40)) },
      { status: 200, body: [prBody(h.source.head)] },
      { status: 200, body: prBody(h.source.head) },
    );
    const production = createGithubPrCreateProductionAuthority({
      credentialBroker: h.config.credentialBroker,
      gitExecutable: h.config.gitExecutable,
      gitVersion: h.config.gitVersion,
      curlExecutable: h.config.curlExecutable,
      curlVersion: h.config.curlVersion,
      tempRoot: h.config.tempRoot,
      nowMs: h.config.nowMs!,
      productionCapability: true,
    });
    const requested = await production.request(h.context, request(h.source.head));
    const review = production.consumeReview(requested.review!.reviewId)!;
    await expect(
      production.resolve(h.context, review, {
        reviewId: requested.review!.reviewId,
        approved: true,
        scope: "once",
        principal,
      }),
    ).resolves.toMatchObject({ verdict: "allow", result: { status: "already-exists" } });
    expect(
      h.executions
        .filter((entry) => (entry.profile.network?.allowedDomains?.length ?? 0) > 0)
        .every((entry) => entry.profile.network?.allowedDomains?.join() === "api.github.com"),
    ).toBe(true);
  });

  it("routes capability, audited INVALID_PARAMS, pending truth, and once-only denial through RPC", async () => {
    const h = harness();
    const auditDir = privateRoot("keel-github-pr-rpc-audit-");
    const writer = AuditChainWriter.open({
      path: join(auditDir, "audit.jsonl"),
      principal,
      now: () => "2026-08-11T12:00:00.000Z",
    });
    const params = {
      ...request(h.source.head),
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    };
    const frame = (id: string, method: string, input: unknown = {}) =>
      JSON.stringify({ jsonrpc: "2.0", id, method, params: input });
    const options = {
      workspaceTrusted: true,
      workspaceRoot: h.source.path,
      sandbox: h.context.sandbox,
      auditWriter: writer,
      auditDir,
      signal: new AbortController().signal,
      githubPrCreateAuthority: h.authority,
      githubPrCreateAddressGuardRevision: "test-address-guard-v1",
    };
    try {
      const hello = await handleRpcLine(
        frame("hello", "warden.hello", {
          kernelVersion: "0.1.1",
          protocolVersion: "1.1.0",
        }),
        options,
      );
      if (!("result" in hello)) throw new Error("warden.hello returned an RPC error");
      const helloResult = WARDEN_METHODS["warden.hello"].result.parse(hello.result);
      expect(helloResult.capabilities).toContain("github-pr-create/v1");

      const helloWithoutRevision = await handleRpcLine(
        frame("hello-no-revision", "warden.hello", {
          kernelVersion: "0.1.1",
          protocolVersion: "1.1.0",
        }),
        {
          workspaceTrusted: true,
          workspaceRoot: h.source.path,
          sandbox: h.context.sandbox,
          auditWriter: writer,
          githubPrCreateAuthority: h.authority,
        },
      );
      if (!("result" in helloWithoutRevision)) {
        throw new Error("warden.hello without revision returned an RPC error");
      }
      expect(
        WARDEN_METHODS["warden.hello"].result.parse(helloWithoutRevision.result).capabilities,
      ).not.toContain("github-pr-create/v1");

      await expect(
        handleRpcLine(frame("unavailable", "warden.execute", params), {
          workspaceTrusted: true,
          workspaceRoot: h.source.path,
          sandbox: h.context.sandbox,
          githubPrCreateAuthority: h.authority,
          githubPrCreateAddressGuardRevision: "test-address-guard-v1",
        }),
      ).resolves.toMatchObject({ error: { data: { code: "WARDEN_NOT_READY" } } });

      const invalid = {
        ...params,
        toolCall: { ...params.toolCall, args: { ...params.toolCall.args, extra: true } },
      };
      await expect(
        handleRpcLine(frame("invalid", "warden.execute", invalid), options),
      ).resolves.toMatchObject({ error: { code: -32602, data: { code: "INVALID_PARAMS" } } });

      await expect(
        handleRpcLine(frame("request", "warden.execute", params), options),
      ).resolves.toMatchObject({
        result: {
          verdict: "review",
          review: { reviewId: "github_pr_create_review_1" },
        },
      });
      await expect(handleRpcLine(frame("status", "warden.status"), options)).resolves.toMatchObject(
        {
          result: { pendingReviews: 1 },
        },
      );
      await expect(
        handleRpcLine(
          frame("deny", "warden.resolveReview", {
            reviewId: "github_pr_create_review_1",
            approved: false,
            scope: "once",
            principal,
          }),
          options,
        ),
      ).resolves.toMatchObject({
        result: { verdict: "deny", result: { reason: "human denied" } },
      });
      expect(h.authority.pendingReviewCount()).toBe(0);
      expect(h.broker.resolveBearer).not.toHaveBeenCalled();

      await expect(
        handleRpcLine(frame("request-no-scope", "warden.execute", params), options),
      ).resolves.toMatchObject({
        result: { verdict: "review", review: { reviewId: "github_pr_create_review_2" } },
      });
      await expect(
        handleRpcLine(
          frame("deny-no-scope", "warden.resolveReview", {
            reviewId: "github_pr_create_review_2",
            approved: true,
            principal,
          }),
          options,
        ),
      ).resolves.toMatchObject({
        result: {
          verdict: "deny",
          result: { reason: "github.pr.create accepts once-only approval" },
        },
      });

      await expect(
        handleRpcLine(frame("request-precheck", "warden.execute", params), options),
      ).resolves.toMatchObject({
        result: { verdict: "review", review: { reviewId: "github_pr_create_review_3" } },
      });
      await expect(
        handleRpcLine(
          frame("deny-precheck", "warden.resolveReview", {
            reviewId: "github_pr_create_review_3",
            approved: true,
            scope: "once",
            principal,
          }),
          {
            ...options,
            githubPrCreateReviewPreExecutionCheck: () => {
              throw new Error("temporary authority changed");
            },
          },
        ),
      ).resolves.toMatchObject({
        result: {
          verdict: "deny",
          result: { reason: "sandbox temporary authority changed; submit a fresh request" },
        },
      });

      await expect(
        handleRpcLine(
          frame("missing-review", "warden.resolveReview", {
            reviewId: "github_pr_create_review_999",
            approved: false,
            scope: "once",
            principal,
          }),
          options,
        ),
      ).resolves.toMatchObject({ error: { data: { code: "REVIEW_NOT_FOUND" } } });

      const noOptionalAuthority = {
        workspaceTrusted: true,
        workspaceRoot: h.source.path,
        sandbox: h.context.sandbox,
        auditWriter: writer,
        githubPrCreateAuthority: h.authority,
        githubPrCreateAddressGuardRevision: "test-address-guard-v1",
      };
      await expect(
        handleRpcLine(frame("request-no-optionals", "warden.execute", params), noOptionalAuthority),
      ).resolves.toMatchObject({
        result: { verdict: "review", review: { reviewId: "github_pr_create_review_4" } },
      });
      await expect(
        handleRpcLine(
          frame("deny-no-optionals", "warden.resolveReview", {
            reviewId: "github_pr_create_review_4",
            approved: false,
            scope: "once",
            principal,
          }),
          noOptionalAuthority,
        ),
      ).resolves.toMatchObject({ result: { verdict: "deny" } });

      await expect(
        handleRpcLine(frame("request-audit-loss", "warden.execute", params), options),
      ).resolves.toMatchObject({
        result: { verdict: "review", review: { reviewId: "github_pr_create_review_5" } },
      });
      await expect(
        handleRpcLine(
          frame("resolve-audit-loss", "warden.resolveReview", {
            reviewId: "github_pr_create_review_5",
            approved: true,
            scope: "once",
            principal,
          }),
          {
            workspaceTrusted: true,
            workspaceRoot: h.source.path,
            sandbox: h.context.sandbox,
            githubPrCreateAuthority: h.authority,
            githubPrCreateAddressGuardRevision: "test-address-guard-v1",
          },
        ),
      ).resolves.toMatchObject({ error: { data: { code: "AUDIT_UNAVAILABLE" } } });
    } finally {
      writer.close();
    }
  });
});
