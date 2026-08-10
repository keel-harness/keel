import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObjectT } from "@keel/shared";
import { AuditChainWriter, type AuditAppendInput } from "./audit/writer.js";
import { handleRpcLine } from "./rpc-server.js";
import {
  CREDENTIAL_TLS_TERMINATION_CAPABILITY,
  EGRESS_ADDRESS_GUARD_CAPABILITY,
  type SandboxExecutionResult,
  type SandboxPort,
  type SandboxStatus,
} from "./sandbox.js";
import {
  GIT_PUSH_CAPABILITY_V1,
  GitPushInvalidParamsError,
  auditGitPushInvalidParams,
  createGitPushRuntimeState,
  createGitPushWalkingSkeletonAuthority,
  gitPushCapabilityAvailable,
  isGitPushReviewId,
  requestGitPushReview,
  resolveGitPushReview,
  type GitPushRuntimeContext,
  type GitPushRuntimeState,
  type PendingGitPushReview,
} from "./git-push.js";

const tempDirs: string[] = [];
const canonicalUrl = "https://localhost:54321/repo.git";
const principal = {
  osUser: "git-push-test",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
} as const;

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(path, 0o700);
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(args: readonly string[], cwd?: string, allowFailure = false): string {
  const home = tempDir("keel-git-push-unit-home-");
  const result = spawnSync("git", [...args], {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"],
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`test Git command failed: ${args.join(" ")}`);
  }
  return result.stdout.trim();
}

function makeWorkspace(
  options: {
    readonly binary?: boolean;
    readonly dirty?: boolean;
    readonly message?: string;
    readonly emptySubject?: boolean;
    readonly secondEmptyCommit?: boolean;
    readonly objectFormat?: "sha1" | "sha256";
  } = {},
): {
  readonly path: string;
  readonly head: string;
} {
  const path = tempDir("keel-git-push-unit-workspace-");
  git(
    [
      "init",
      "--initial-branch=main",
      ...(options.objectFormat === undefined ? [] : [`--object-format=${options.objectFormat}`]),
    ],
    path,
  );
  writeFileSync(
    join(path, options.binary === true ? "binary.dat" : "file.txt"),
    options.binary === true ? Buffer.from([0, 1, 2, 3]) : "one\n",
  );
  git(["add", "."], path);
  git(
    [
      "-c",
      "user.name=Keel Test",
      "-c",
      "user.email=test@keel.invalid",
      "commit",
      ...(options.emptySubject === true ? ["--allow-empty-message"] : []),
      "-m",
      options.emptySubject === true ? "" : (options.message ?? "walking skeleton"),
    ],
    path,
  );
  if (options.secondEmptyCommit === true) {
    git(
      [
        "-c",
        "user.name=Keel Test",
        "-c",
        "user.email=test@keel.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "empty second commit",
      ],
      path,
    );
  }
  git(["remote", "add", "origin", canonicalUrl], path);
  if (options.dirty === true) writeFileSync(join(path, "file.txt"), "dirty\n");
  return { path, head: git(["rev-parse", "HEAD"], path) };
}

const activeStatus: SandboxStatus = {
  available: true,
  backend: "srt:vendored",
  enforcementTier: "sandbox:srt",
  features: [CREDENTIAL_TLS_TERMINATION_CAPABILITY, EGRESS_ADDRESS_GUARD_CAPABILITY],
};

function sandboxResult(
  stdout: string,
  options: { readonly exitCode?: number; readonly stderr?: string } = {},
): SandboxExecutionResult {
  return {
    exitCode: options.exitCode ?? 0,
    signal: null,
    stdout,
    stderr: options.stderr ?? "",
  };
}

function testState(nowMs: () => number): GitPushRuntimeState {
  return createGitPushRuntimeState({
    advertiseTestCapability: true,
    fixture: {
      canonicalUrl,
      host: "localhost",
      port: 54_321,
      address: "127.0.0.1",
      username: "fixture-user",
      secret: "fixture-secret",
      credentialSourceClass: "deterministic-test-provider",
    },
    gitExecutable: resolve(spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim()),
    tempRoot: tempDir("keel-git-push-unit-temp-"),
    nowMs,
  });
}

function harness(
  options: {
    readonly workspace?: ReturnType<typeof makeWorkspace>;
    readonly sandboxResults?: readonly SandboxExecutionResult[];
    readonly status?: SandboxStatus;
    readonly state?: GitPushRuntimeState;
    readonly now?: number;
  } = {},
): {
  readonly workspace: ReturnType<typeof makeWorkspace>;
  readonly state: GitPushRuntimeState;
  readonly context: GitPushRuntimeContext;
  readonly audits: AuditAppendInput[];
  readonly executions: unknown[];
  setNow(value: number): void;
} {
  const workspace = options.workspace ?? makeWorkspace();
  const audits: AuditAppendInput[] = [];
  const executions: unknown[] = [];
  const queue = [...(options.sandboxResults ?? [])];
  let now = options.now ?? 1_000;
  const state = options.state ?? testState(() => now);
  const status = options.status ?? activeStatus;
  const sandbox: SandboxPort = {
    status: () => status,
    execute: async (invocation, profile, executeOptions) => {
      executions.push({ invocation, profile, executeOptions });
      const result = queue.shift();
      if (result === undefined) throw new Error("missing fake sandbox result");
      return result;
    },
  };
  return {
    workspace,
    state,
    context: {
      state,
      sandbox,
      workspaceRoot: workspace.path,
      auditDir: tempDir("keel-git-push-unit-audit-"),
      appendAudit: (input) => {
        audits.push(input);
        return audits.length;
      },
    },
    audits,
    executions,
    setNow: (value) => {
      now = value;
    },
  };
}

function executeArgs(
  head: string,
  args: JsonObjectT = {},
): {
  readonly sessionId: string;
  readonly toolCall: { readonly id: string; readonly name: string; readonly args: JsonObjectT };
  readonly provenanceContext: JsonObjectT;
} {
  return {
    sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    toolCall: {
      id: "call_git_push",
      name: "git.push",
      args: { remote: "origin", branch: "feature/unit", expectedHead: head, ...args },
    },
    provenanceContext: { inputTags: ["workspace"] },
  };
}

function request(h: ReturnType<typeof harness>): PendingGitPushReview {
  const result = requestGitPushReview(h.context, executeArgs(h.workspace.head));
  expect(result).toMatchObject({ verdict: "review", auditSeq: 1 });
  const review = h.state.pending.get(result.review!.reviewId);
  if (review === undefined) throw new Error("expected pending git.push review");
  return review;
}

function rpcFrame(id: string, method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

describe("ADR-0091 git.push Warden walking skeleton", () => {
  it("gates the capability on the complete trusted audited SRT/TLS/address boundary", () => {
    const state = testState(() => 1_000);
    expect(GIT_PUSH_CAPABILITY_V1).toBe("git-push/v1");
    expect(
      gitPushCapabilityAvailable(state, {
        workspaceTrusted: true,
        auditAvailable: true,
        sandbox: activeStatus,
      }),
    ).toBe(true);
    expect(
      gitPushCapabilityAvailable(undefined, {
        workspaceTrusted: true,
        auditAvailable: true,
        sandbox: activeStatus,
      }),
    ).toBe(false);
    for (const input of [
      { workspaceTrusted: false, auditAvailable: true, sandbox: activeStatus },
      { workspaceTrusted: true, auditAvailable: false, sandbox: activeStatus },
      {
        workspaceTrusted: true,
        auditAvailable: true,
        sandbox: { ...activeStatus, backend: "fake" },
      },
      {
        workspaceTrusted: true,
        auditAvailable: true,
        sandbox: { ...activeStatus, features: [EGRESS_ADDRESS_GUARD_CAPABILITY] },
      },
      {
        workspaceTrusted: true,
        auditAvailable: true,
        sandbox: {
          available: true,
          backend: "srt:vendored",
          enforcementTier: "sandbox:srt",
        },
      },
      {
        workspaceTrusted: true,
        auditAvailable: true,
        sandbox: { ...activeStatus, available: false },
      },
    ]) {
      expect(gitPushCapabilityAvailable(state, input)).toBe(false);
    }
  });

  it("creates a bounded Warden-owned review from local facts without touching the sandbox", () => {
    const h = harness({ workspace: makeWorkspace({ dirty: true }) });
    const review = request(h);

    expect(review.reviewId).toBe("git_push_review_1");
    expect(isGitPushReviewId(review.reviewId)).toBe(true);
    expect(isGitPushReviewId("git_push_review_0")).toBe(false);
    expect(review.summary.split("\n")).toHaveLength(11);
    expect(review.summary).toContain("Workspace: has uncommitted changes");
    expect(review.summary).toContain(`Commit: ${h.workspace.head}`);
    expect(review.allowCommand).toBe("keel approve git_push_review_1 --scope once");
    expect(h.executions).toEqual([]);
    expect(h.audits).toHaveLength(1);
    expect(JSON.stringify(h.audits)).not.toContain("fixture-secret");
  });

  it("routes capability, invalid params, and exact-once settlement through the RPC authority", async () => {
    const h = harness();
    const gitPushAuthority = createGitPushWalkingSkeletonAuthority(h.state.config);
    const auditDir = tempDir("keel-git-push-rpc-audit-");
    const writer = AuditChainWriter.open({
      path: join(auditDir, "audit.jsonl"),
      principal,
      now: () => "2026-08-10T21:00:00.000Z",
    });
    const signal = new AbortController().signal;
    const options = {
      workspaceTrusted: true,
      workspaceRoot: h.workspace.path,
      sandbox: h.context.sandbox,
      auditWriter: writer,
      auditDir,
      signal,
      gitPushAuthority,
    };
    const minimalOptions = {
      workspaceTrusted: true,
      workspaceRoot: h.workspace.path,
      sandbox: h.context.sandbox,
      auditWriter: writer,
      gitPushAuthority,
    };
    try {
      const hello = await handleRpcLine(
        rpcFrame("hello", "warden.hello", {
          kernelVersion: "0.1.1",
          protocolVersion: "1.1.0",
        }),
        options,
      );
      expect(hello).not.toHaveProperty("error");
      expect(JSON.stringify(hello)).toContain('"git-push/v1"');

      const invalid = await handleRpcLine(
        rpcFrame("invalid", "warden.execute", executeArgs(h.workspace.head, { extra: true })),
        options,
      );
      expect(invalid).toMatchObject({ error: { code: -32602, data: { code: "INVALID_PARAMS" } } });

      const requested = await handleRpcLine(
        rpcFrame("request", "warden.execute", executeArgs(h.workspace.head)),
        minimalOptions,
      );
      expect(requested).toMatchObject({
        result: { verdict: "review", review: { reviewId: "git_push_review_1" } },
      });
      const pending = await handleRpcLine(rpcFrame("status", "warden.status"), options);
      expect(pending).toMatchObject({ result: { pendingReviews: 1 } });

      const denied = await handleRpcLine(
        rpcFrame("deny", "warden.resolveReview", {
          reviewId: "git_push_review_1",
          approved: false,
          scope: "once",
          principal,
        }),
        minimalOptions,
      );
      expect(denied).toMatchObject({
        result: { verdict: "deny", result: { reason: "human denied" } },
      });
      expect(gitPushAuthority.pendingReviewCount()).toBe(0);

      await handleRpcLine(
        rpcFrame("request-2", "warden.execute", executeArgs(h.workspace.head)),
        options,
      );
      const auditUnavailable = await handleRpcLine(
        rpcFrame("approve-without-audit", "warden.resolveReview", {
          reviewId: "git_push_review_2",
          approved: true,
          scope: "once",
          principal,
        }),
        {
          workspaceTrusted: true,
          workspaceRoot: h.workspace.path,
          sandbox: h.context.sandbox,
          gitPushAuthority,
        },
      );
      expect(auditUnavailable).toMatchObject({
        error: { code: -32000, data: { code: "AUDIT_UNAVAILABLE" } },
      });
      expect(gitPushAuthority.pendingReviewCount()).toBe(0);

      await handleRpcLine(
        rpcFrame("request-3", "warden.execute", executeArgs(h.workspace.head)),
        options,
      );
      const deniedWithFullContext = await handleRpcLine(
        rpcFrame("deny-with-full-context", "warden.resolveReview", {
          reviewId: "git_push_review_3",
          approved: false,
          principal,
        }),
        options,
      );
      expect(deniedWithFullContext).toMatchObject({
        result: { verdict: "deny", result: { reason: "human denied" } },
      });
      expect(gitPushAuthority.pendingReviewCount()).toBe(0);

      await handleRpcLine(
        rpcFrame("request-4", "warden.execute", executeArgs(h.workspace.head)),
        options,
      );
      const containmentDrift = await handleRpcLine(
        rpcFrame("containment-drift", "warden.resolveReview", {
          reviewId: "git_push_review_4",
          approved: true,
          scope: "once",
          principal,
        }),
        {
          ...options,
          gitPushReviewPreExecutionCheck: () => {
            throw new Error("test temporary authority changed");
          },
        },
      );
      expect(containmentDrift).toMatchObject({
        result: {
          verdict: "deny",
          result: { reason: "sandbox temporary authority changed; submit a fresh request" },
        },
      });
      expect(gitPushAuthority.pendingReviewCount()).toBe(0);
      expect(h.executions).toEqual([]);

      const unavailable = await handleRpcLine(
        rpcFrame("unavailable", "warden.execute", executeArgs(h.workspace.head)),
        { workspaceTrusted: true, workspaceRoot: h.workspace.path, sandbox: h.context.sandbox },
      );
      expect(unavailable).toMatchObject({
        error: { code: -32000, data: { code: "WARDEN_NOT_READY" } },
      });
    } finally {
      writer.close();
    }
  });

  it("pushes once through the exact secretless child and independently verifies the ref", async () => {
    const destination = "refs/heads/feature/unit";
    const workspace = makeWorkspace();
    const h = harness({
      workspace,
      sandboxResults: [
        sandboxResult("ref: refs/heads/main\tHEAD\n"),
        sandboxResult("To fixture\n*\t[created]\n"),
        sandboxResult(`${workspace.head}\t${destination}\n`),
      ],
    });
    const review = request(h);

    const result = await resolveGitPushReview(h.context, review, {
      reviewId: review.reviewId,
      approved: true,
      scope: "once",
      principal,
    });

    expect(result).toMatchObject({
      verdict: "allow",
      result: { kind: "git_push_result", status: "pushed", observedRef: h.workspace.head },
    });
    expect(h.executions).toHaveLength(3);
    const serialized = JSON.stringify(h.executions);
    expect(serialized).toContain('"NO_PROXY="');
    expect(serialized).toContain('"no_proxy="');
    expect(serialized).toContain(`${h.workspace.head}:${destination}`);
    expect(serialized).not.toContain("fixture-secret");
    const credential = (
      h.executions[0] as {
        executeOptions: {
          credentialProxy: { authorizationHeaders: readonly { secret: string }[] };
        };
      }
    ).executeOptions.credentialProxy.authorizationHeaders[0];
    expect(credential?.secret).toBe(
      Buffer.from("fixture-user:fixture-secret", "utf8").toString("base64"),
    );
    expect(JSON.stringify(h.audits)).not.toContain("fixture-secret");
    expect(h.audits.map((entry) => entry.eventType)).toEqual([
      "review.requested",
      "review.resolved",
      "tool.execute",
      "tool.execute",
    ]);
  });

  it("returns already-at-commit after preflight without launching a push child", async () => {
    const workspace = makeWorkspace();
    const h = harness({
      workspace,
      sandboxResults: [
        sandboxResult(`ref: refs/heads/main\tHEAD\n${workspace.head}\trefs/heads/feature/unit\n`),
      ],
    });
    const review = request(h);
    const result = await resolveGitPushReview(h.context, review, {
      reviewId: review.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    expect(result).toMatchObject({
      verdict: "allow",
      result: { status: "already-at-commit", observedRef: h.workspace.head },
    });
    expect(h.executions).toHaveLength(1);
  });

  it.each([
    {
      label: "preflight failure",
      results: [sandboxResult("", { exitCode: 128, stderr: "fatal: Operation not permitted" })],
      status: "failed",
      may: false,
    },
    {
      label: "verification failure",
      results: [
        sandboxResult("ref: refs/heads/main\tHEAD\n"),
        sandboxResult("push attempted"),
        sandboxResult("", { exitCode: 1 }),
      ],
      status: "indeterminate",
      may: true,
    },
    {
      label: "verification mismatch after successful child",
      results: [
        sandboxResult("ref: refs/heads/main\tHEAD\n"),
        sandboxResult("push attempted"),
        sandboxResult(`${"a".repeat(40)}\trefs/heads/feature/unit\n`),
      ],
      status: "indeterminate",
      may: true,
    },
    {
      label: "definitive child failure with observed mismatch",
      results: [
        sandboxResult("ref: refs/heads/main\tHEAD\n"),
        sandboxResult("", { exitCode: 1 }),
        sandboxResult(`${"a".repeat(40)}\trefs/heads/feature/unit\n`),
      ],
      status: "failed",
      may: true,
    },
  ])("reports $label without retry", async ({ results, status, may }) => {
    const h = harness({ sandboxResults: results });
    const review = request(h);
    const result = await resolveGitPushReview(h.context, review, {
      reviewId: review.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    expect(result).toMatchObject({
      verdict: "deny",
      result: { status, automaticRetry: false, actionMayHaveExecuted: may },
    });
  });

  it("blocks the observed remote default branch without launching push", async () => {
    const h = harness({
      sandboxResults: [sandboxResult("ref: refs/heads/feature/unit\tHEAD\n")],
    });
    const review = request(h);
    const result = await resolveGitPushReview(h.context, review, {
      reviewId: review.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    expect(result).toMatchObject({
      verdict: "deny",
      result: { status: "failed", actionMayHaveExecuted: false },
    });
    expect(h.executions).toHaveLength(1);
  });

  it.each([
    {
      label: "human denial",
      approved: false,
      scope: undefined,
      now: 1_000,
      reason: "human denied",
    },
    {
      label: "missing once scope",
      approved: true,
      scope: undefined,
      now: 1_000,
      reason: "git.push accepts once-only approval",
    },
    {
      label: "project scope",
      approved: true,
      scope: "project" as const,
      now: 1_000,
      reason: "git.push accepts once-only approval",
    },
    {
      label: "expired review",
      approved: true,
      scope: "once" as const,
      now: 121_001,
      reason: "git.push review expired",
    },
  ])("settles $label before network", async ({ approved, scope, now, reason }) => {
    const h = harness();
    const review = request(h);
    h.setNow(now);
    const result = await resolveGitPushReview(h.context, review, {
      reviewId: review.reviewId,
      approved,
      ...(scope === undefined ? {} : { scope }),
      principal,
    });
    expect(result).toMatchObject({ verdict: "deny", result: { reason } });
    expect(h.executions).toEqual([]);
    expect(result.auditSeq).toBe(2);
  });

  it("denies binding drift after approval and before network", async () => {
    const h = harness();
    const review = request(h);
    writeFileSync(join(h.workspace.path, "file.txt"), "changed after approval\n");
    const result = await resolveGitPushReview(h.context, review, {
      reviewId: review.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    expect(result).toMatchObject({
      verdict: "deny",
      result: { reason: "request facts changed; submit a fresh request" },
    });
    expect(h.executions).toEqual([]);
  });

  it("fails closed when the review-request audit cannot be made durable", () => {
    const h = harness();
    const context: GitPushRuntimeContext = {
      ...h.context,
      appendAudit: () => {
        throw new Error("audit unavailable");
      },
    };
    expect(() => requestGitPushReview(context, executeArgs(h.workspace.head))).toThrow(
      /audit unavailable/,
    );
    expect(h.state.pending.size).toBe(0);
    expect(h.executions).toEqual([]);
  });

  it("uses the system clock only when no injected clock is configured", async () => {
    const configured = testState(() => 1_000).config;
    const state = createGitPushRuntimeState({
      advertiseTestCapability: configured.advertiseTestCapability,
      fixture: configured.fixture,
      gitExecutable: configured.gitExecutable,
      tempRoot: configured.tempRoot,
    });
    const h = harness({ state });
    const review = request(h);
    expect(review.createdAtMs).toBeGreaterThan(0);
    const result = await resolveGitPushReview(h.context, review, {
      reviewId: review.reviewId,
      approved: false,
      principal,
    });
    expect(result).toMatchObject({ verdict: "deny", result: { reason: "human denied" } });
  });

  it("binds an explicit caller signal and omits an absent audit directory", async () => {
    const workspace = makeWorkspace();
    const h = harness({
      workspace,
      sandboxResults: [sandboxResult(""), sandboxResult("push attempted"), sandboxResult("")],
    });
    const review = request(h);
    const controller = new AbortController();
    const context: GitPushRuntimeContext = {
      state: h.context.state,
      sandbox: h.context.sandbox,
      workspaceRoot: h.context.workspaceRoot,
      appendAudit: h.context.appendAudit,
      signal: controller.signal,
    };
    const result = await resolveGitPushReview(context, review, {
      reviewId: review.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    expect(result).toMatchObject({
      verdict: "deny",
      result: { status: "indeterminate", observedRef: null },
    });
    expect(h.executions).toHaveLength(3);
    expect(
      (h.executions[0] as { profile: { filesystem: { denyWrite: readonly string[] } } }).profile
        .filesystem.denyWrite,
    ).toEqual([realpathSync(workspace.path)]);
  });

  it("ignores malformed remote-ref rows instead of treating them as authority", async () => {
    const h = harness({
      sandboxResults: [
        sandboxResult("malformed-without-tab\n"),
        sandboxResult("push attempted"),
        sandboxResult("malformed-without-tab\n"),
      ],
    });
    const review = request(h);
    const result = await resolveGitPushReview(h.context, review, {
      reviewId: review.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    expect(result).toMatchObject({
      verdict: "deny",
      result: { status: "indeterminate", observedRef: null },
    });
  });

  it("records an unclassified bounded diagnostic without retaining raw stderr", async () => {
    const h = harness({ sandboxResults: [sandboxResult("", { exitCode: 1 })] });
    const review = request(h);
    const result = await resolveGitPushReview(h.context, review, {
      reviewId: review.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    expect(result).toMatchObject({ verdict: "deny", result: { status: "failed" } });
    expect(h.audits.at(-1)?.payload).toMatchObject({
      failureDiagnostic: { kind: "unclassified", indicators: [], bytes: 0 },
    });
  });

  it("reports non-Error sandbox failures conservatively and cleans its attempt", async () => {
    const h = harness({ sandboxResults: [] });
    const review = request(h);
    const context: GitPushRuntimeContext = {
      ...h.context,
      sandbox: {
        status: () => h.context.sandbox.status(),
        execute: vi.fn().mockRejectedValue("fixture rejection"),
      },
    };
    const result = await resolveGitPushReview(context, review, {
      reviewId: review.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    expect(result).toMatchObject({ verdict: "deny", result: { status: "indeterminate" } });
    expect(h.audits.at(-1)?.payload).toMatchObject({ errorClass: "unknown" });
    expect(
      spawnSync("find", [h.state.config.tempRoot, "-maxdepth", "1", "-name", "attempt-*"], {
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("");
  });

  it("fails before network when the temporary-root identity changes after review", async () => {
    const h = harness();
    const review = request(h);
    const replacement = tempDir("keel-git-push-replacement-temp-");
    (h.state.config as { tempRoot: string }).tempRoot = replacement;
    const result = await resolveGitPushReview(h.context, review, {
      reviewId: review.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    expect(result).toMatchObject({
      verdict: "deny",
      result: { reason: "request facts changed; submit a fresh request" },
    });
    expect(h.executions).toEqual([]);
  });

  it("conservatively reports an exception after intent as indeterminate", async () => {
    const h = harness({ sandboxResults: [] });
    const review = request(h);
    const result = await resolveGitPushReview(h.context, review, {
      reviewId: review.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    expect(result).toMatchObject({
      verdict: "deny",
      result: { status: "indeterminate", actionMayHaveExecuted: true },
    });
  });

  it.each([
    ["wrong tool", { tool: "bash" }, "unexpected tool name"],
    ["additional arg", { extra: true }, "requires exactly"],
    ["invalid remote", { remote: "-origin" }, "remote must"],
    ["unicode branch", { branch: "feature/é" }, "branch must"],
    ["reserved branch", { branch: "refs/heads/x" }, "branch must"],
    ["abbreviated oid", { expectedHead: "abc" }, "expectedHead must"],
  ])("audits and rejects $label before review", (_label, mutation, expected) => {
    const h = harness();
    const isWrongTool = typeof mutation === "object" && mutation !== null && "tool" in mutation;
    const params = isWrongTool
      ? {
          ...executeArgs(h.workspace.head),
          toolCall: { ...executeArgs(h.workspace.head).toolCall, name: String(mutation.tool) },
        }
      : executeArgs(h.workspace.head, mutation);
    let thrown: GitPushInvalidParamsError | undefined;
    try {
      requestGitPushReview(h.context, params);
    } catch (error) {
      if (error instanceof GitPushInvalidParamsError) thrown = error;
      else throw error;
    }
    expect(thrown?.message).toContain(expected);
    const auditSeq = auditGitPushInvalidParams(h.context, params, thrown!);
    expect(auditSeq).toBe(1);
    expect(h.state.pending.size).toBe(0);
    expect(h.executions).toEqual([]);
  });

  it("rejects binary commit summaries and alternate object stores", () => {
    const binary = harness({ workspace: makeWorkspace({ binary: true }) });
    expect(() => request(binary)).toThrow(GitPushInvalidParamsError);

    const alternate = harness();
    const info = join(alternate.workspace.path, ".git", "objects", "info");
    mkdirSync(info, { recursive: true });
    writeFileSync(join(info, "alternates"), `${tempDir("keel-git-push-alt-")}\n`);
    expect(() => request(alternate)).toThrow(/alternate object databases/);
  });

  it("supports parented and empty commits while preserving exact bounded facts", () => {
    const h = harness({ workspace: makeWorkspace({ secondEmptyCommit: true }) });
    const review = request(h);
    expect(review.summary).toContain("; 1; 0 files; +0 -0");
  });

  it("rejects approval subjects that are empty or exceed their byte bound", () => {
    expect(() => request(harness({ workspace: makeWorkspace({ emptySubject: true }) }))).toThrow(
      /commit subject cannot be shown losslessly/,
    );
    expect(() =>
      request(harness({ workspace: makeWorkspace({ message: "x".repeat(161) }) })),
    ).toThrow(/commit subject cannot be shown losslessly/);
  });

  it("rejects nested, bare, and linked-worktree repository shapes", () => {
    const nested = harness();
    const nestedRoot = join(nested.workspace.path, "nested");
    mkdirSync(nestedRoot);
    expect(() =>
      requestGitPushReview(
        { ...nested.context, workspaceRoot: nestedRoot },
        executeArgs(nested.workspace.head),
      ),
    ).toThrow(/ordinary repository top level/);

    const bareRoot = tempDir("keel-git-push-bare-");
    git(["init", "--bare"], bareRoot);
    const bare = harness({ workspace: { path: bareRoot, head: "a".repeat(40) } });
    expect(() => request(bare)).toThrow(/ordinary non-bare repository/);

    const source = makeWorkspace();
    const linkedRoot = tempDir("keel-git-push-linked-");
    rmSync(linkedRoot, { recursive: true, force: true });
    git(["worktree", "add", "--detach", linkedRoot, source.head], source.path);
    const linked = harness({ workspace: { path: linkedRoot, head: source.head } });
    expect(() => request(linked)).toThrow(/non-directory .git layouts/);
  });

  it("rejects changed HEAD and remote URL multiplicity", () => {
    const changedHead = harness();
    expect(() => requestGitPushReview(changedHead.context, executeArgs("a".repeat(40)))).toThrow(
      /current HEAD does not equal expectedHead/,
    );

    const missingRemote = harness();
    git(["remote", "remove", "origin"], missingRemote.workspace.path);
    expect(() => request(missingRemote)).toThrow(/exactly one repository-local URL/);

    const multiple = harness();
    git(["config", "--local", "--add", "remote.origin.url", canonicalUrl], multiple.workspace.path);
    expect(() => request(multiple)).toThrow(/exactly one repository-local URL/);
  });

  it("accepts Git's sha256 object format when the installed Git supports it", () => {
    const probeRoot = tempDir("keel-git-push-sha256-probe-");
    const probe = spawnSync("git", ["init", "--bare", "--object-format=sha256", probeRoot], {
      encoding: "utf8",
    });
    if (probe.status !== 0) return;
    const h = harness({ workspace: makeWorkspace({ objectFormat: "sha256" }) });
    expect(request(h).facts.objectFormat).toBe("sha256");
  });

  it("rejects unsafe remote config variants and unavailable fixture authority", () => {
    const mismatch = harness();
    git(
      ["remote", "set-url", "origin", "https://localhost:54321/other.git"],
      mismatch.workspace.path,
    );
    expect(() => request(mismatch)).toThrow(/injected canonical HTTPS/);

    const pushUrl = harness();
    git(["remote", "set-url", "--push", "origin", canonicalUrl], pushUrl.workspace.path);
    expect(() => request(pushUrl)).toThrow(/pushurl is unsupported/);

    const unavailable = harness({
      status: { ...activeStatus, features: [EGRESS_ADDRESS_GUARD_CAPABILITY] },
    });
    expect(() => request(unavailable)).toThrow(/fixture boundary is unavailable/);
  });

  it("rejects invalid injected fixture configuration before capability state exists", () => {
    const tempRoot = tempDir("keel-git-push-invalid-config-");
    const gitExecutable = resolve(spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim());
    expect(() =>
      createGitPushRuntimeState({
        ...testState(() => 1_000).config,
        advertiseTestCapability: false,
      } as unknown as Parameters<typeof createGitPushRuntimeState>[0]),
    ).toThrow(/fixture is not enabled/);
    expect(() =>
      createGitPushRuntimeState({
        advertiseTestCapability: true,
        fixture: {
          canonicalUrl: "http://localhost:54321/repo.git",
          host: "localhost",
          port: 54_321,
          address: "127.0.0.1",
          username: "fixture-user",
          secret: "fixture-secret",
          credentialSourceClass: "deterministic-test-provider",
        },
        gitExecutable,
        tempRoot,
      }),
    ).toThrow(/invalid non-release/);
    chmodSync(tempRoot, 0o755);
    expect(() =>
      createGitPushRuntimeState({
        advertiseTestCapability: true,
        fixture: {
          canonicalUrl,
          host: "localhost",
          port: 54_321,
          address: "127.0.0.1",
          username: "fixture-user",
          secret: "fixture-secret",
          credentialSourceClass: "deterministic-test-provider",
        },
        gitExecutable,
        tempRoot,
      }),
    ).toThrow(/owner-only directory/);
  });
});
