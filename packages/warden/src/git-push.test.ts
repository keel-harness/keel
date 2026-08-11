import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObjectT } from "@keel/shared";
import { AuditChainWriter, type AuditAppendInput } from "./audit/writer.js";
import { handleRpcLine } from "./rpc-server.js";
import {
  CREDENTIAL_TLS_TERMINATION_CAPABILITY,
  EGRESS_ADDRESS_GUARD_CAPABILITY,
  type SandboxExecutionResult,
  type SandboxPort,
  type SandboxProfile,
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
  parseCanonicalGitHttpsUrl,
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
      if (
        profile.network?.strictAllowlist === true &&
        profile.network.allowedDomains?.length === 0
      ) {
        const local = spawnSync(
          invocation.command,
          invocation.argv === undefined ? [] : invocation.argv.slice(1),
          {
            ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
            encoding: "utf8",
            env: executeOptions?.credentialProxy?.sandboxEnv,
            maxBuffer: 128 * 1024,
          },
        );
        if (local.error !== undefined) throw local.error;
        return {
          exitCode: local.status,
          signal: local.signal,
          stdout: local.stdout,
          stderr: local.stderr,
        };
      }
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

function externalNetworkExecutions(h: ReturnType<typeof harness>): readonly unknown[] {
  return h.executions.filter(
    (execution) =>
      ((execution as { profile: SandboxProfile }).profile.network?.allowedDomains?.length ?? 0) > 0,
  );
}

async function request(h: ReturnType<typeof harness>): Promise<PendingGitPushReview> {
  const result = await requestGitPushReview(h.context, executeArgs(h.workspace.head));
  expect(result).toMatchObject({ verdict: "review", auditSeq: 1 });
  const review = h.state.pending.get(result.review!.reviewId);
  if (review === undefined) throw new Error("expected pending git.push review");
  return review;
}

function rpcFrame(id: string, method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

describe("ADR-0091 git.push Warden walking skeleton", () => {
  it.each([
    ["https://github.com/keel-harness/keel.git", "github.com", "/keel-harness/keel.git"],
    ["https://git.example.test/team/repo~one", "git.example.test", "/team/repo~one"],
  ])("accepts the exact production HTTPS URL grammar: %s", (url, host, path) => {
    expect(parseCanonicalGitHttpsUrl(url)).toEqual({
      canonicalUrl: url,
      host,
      port: 443,
      path,
    });
  });

  it.each([
    "http://github.com/owner/repo.git",
    "ssh://git@github.com/owner/repo.git",
    "https://user@github.com/owner/repo.git",
    "https://user:secret@github.com/owner/repo.git",
    "https://github.com:444/owner/repo.git",
    "https://github.com/owner/repo.git?write=elsewhere",
    "https://github.com/owner/repo.git#fragment",
    "https://GITHUB.com/owner/repo.git",
    "https://github.com./owner/repo.git",
    "https://127.0.0.1/owner/repo.git",
    "https://[::1]/owner/repo.git",
    "https://github.com/owner//repo.git",
    "https://github.com/owner/../repo.git",
    "https://github.com/owner/%2e%2e/repo.git",
    "https://github.com/owner\\repo.git",
    "https://github.com/owner/repo%20name.git",
    "https://github.com/owner/repo.git/",
    "https://github.com",
    `https://github.com/${"a".repeat(385)}`,
    `https://${["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(63)].join(".")}/repo.git`,
    `https://a.test/${"a".repeat(500)}`,
  ])("rejects non-canonical or authority-widening production URL %s", (url) => {
    expect(() => parseCanonicalGitHttpsUrl(url)).toThrow(GitPushInvalidParamsError);
  });

  it("preserves every generated canonical URL byte and rejects authority-widening mutations", () => {
    const alphaNumeric = [..."abcdefghijklmnopqrstuvwxyz0123456789"];
    const pathBytes = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-"];
    const label = fc
      .array(fc.constantFrom(...alphaNumeric), { minLength: 0, maxLength: 15 })
      .map((bytes) => `a${bytes.join("")}`);
    const segment = fc
      .array(fc.constantFrom(...pathBytes), { minLength: 0, maxLength: 23 })
      .map((bytes) => `a${bytes.join("")}`);
    const canonicalUrl = fc
      .tuple(
        fc.array(label, { minLength: 1, maxLength: 4 }),
        fc.array(segment, { minLength: 1, maxLength: 5 }),
      )
      .map(([labels, segments]) => `https://${labels.join(".")}/${segments.join("/")}`);

    fc.assert(
      fc.property(canonicalUrl, (url) => {
        expect(parseCanonicalGitHttpsUrl(url).canonicalUrl).toBe(url);
      }),
      { numRuns: 128 },
    );
    fc.assert(
      fc.property(
        canonicalUrl,
        fc.constantFrom("query", "fragment", "userinfo", "port", "trailing-slash", "percent"),
        (url, mutation) => {
          const authority = url.slice("https://".length).split("/", 1)[0]!;
          const path = url.slice(`https://${authority}`.length);
          const mutated =
            mutation === "query"
              ? `${url}?write=elsewhere`
              : mutation === "fragment"
                ? `${url}#elsewhere`
                : mutation === "userinfo"
                  ? `https://user@${authority}${path}`
                  : mutation === "port"
                    ? `https://${authority}:444${path}`
                    : mutation === "trailing-slash"
                      ? `${url}/`
                      : `${url}%2felsewhere`;
          expect(() => parseCanonicalGitHttpsUrl(mutated)).toThrow(GitPushInvalidParamsError);
        },
      ),
      { numRuns: 128 },
    );
  });

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

  it("creates a bounded Warden-owned review through contained network-denied local probes", async () => {
    const h = harness({ workspace: makeWorkspace({ dirty: true }) });
    const review = await request(h);

    expect(review.reviewId).toBe("git_push_review_1");
    expect(isGitPushReviewId(review.reviewId)).toBe(true);
    expect(isGitPushReviewId("git_push_review_0")).toBe(false);
    expect(review.summary.split("\n")).toHaveLength(11);
    expect(review.summary).toContain("Workspace: has uncommitted changes");
    expect(review.summary).toContain(`Commit: ${h.workspace.head}`);
    expect(review.allowCommand).toBe("keel approve git_push_review_1 --scope once");
    expect(h.executions.length).toBeGreaterThan(0);
    expect(
      h.executions.every(
        (execution) =>
          (execution as { profile: SandboxProfile }).profile.network?.strictAllowlist === true &&
          (execution as { profile: SandboxProfile }).profile.network?.allowedDomains?.length === 0,
      ),
    ).toBe(true);
    expect(h.audits).toHaveLength(1);
    expect(JSON.stringify(h.audits)).not.toContain("fixture-secret");
  });

  it("reports untracked work as excluded uncommitted state", async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace.path, "untracked.txt"), "not in the approved commit\n");
    const review = await request(harness({ workspace }));
    expect(review.summary).toContain(
      "Workspace: has uncommitted changes; uncommitted changes are excluded",
    );
  });

  it.each([
    [
      "shallow repository",
      (workspace: ReturnType<typeof makeWorkspace>) => {
        writeFileSync(join(workspace.path, ".git", "shallow"), `${workspace.head}\n`);
      },
      /shallow repositories are unsupported/u,
    ],
    [
      "partial clone",
      (workspace: ReturnType<typeof makeWorkspace>) => {
        git(["config", "--local", "extensions.partialClone", "origin"], workspace.path);
        git(["config", "--local", "remote.origin.promisor", "true"], workspace.path);
      },
      /partial clones are unsupported/u,
    ],
    [
      "grafts",
      (workspace: ReturnType<typeof makeWorkspace>) => {
        const info = join(workspace.path, ".git", "info");
        mkdirSync(info, { recursive: true });
        writeFileSync(join(info, "grafts"), "");
      },
      /grafts are unsupported/u,
    ],
    [
      "HTTP alternates",
      (workspace: ReturnType<typeof makeWorkspace>) => {
        const info = join(workspace.path, ".git", "objects", "info");
        mkdirSync(info, { recursive: true });
        writeFileSync(join(info, "http-alternates"), "https://objects.invalid/\n");
      },
      /HTTP alternate object databases are unsupported/u,
    ],
    [
      "replacement refs",
      (workspace: ReturnType<typeof makeWorkspace>) => {
        git(
          [
            "-c",
            "user.name=Keel Test",
            "-c",
            "user.email=test@keel.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "replacement target",
          ],
          workspace.path,
        );
        const replacement = git(["rev-parse", "HEAD"], workspace.path);
        git(["reset", "--hard", workspace.head], workspace.path);
        git(["replace", workspace.head, replacement], workspace.path);
      },
      /replacement refs are unsupported/u,
    ],
    [
      "common directory indirection",
      (workspace: ReturnType<typeof makeWorkspace>) => {
        writeFileSync(join(workspace.path, ".git", "commondir"), ".\n");
      },
      /common Git directories are unsupported/u,
    ],
  ] as const)("rejects %s before review", async (_label, mutate, expected) => {
    const workspace = makeWorkspace();
    mutate(workspace);
    const h = harness({ workspace });
    await expect(request(h)).rejects.toThrow(expected);
    expect(h.state.pending.size).toBe(0);
    expect(externalNetworkExecutions(h)).toEqual([]);
  });

  it("rejects an object store that resolves outside the trusted workspace", async () => {
    const workspace = makeWorkspace();
    const original = join(workspace.path, ".git", "objects");
    const external = join(tempDir("keel-git-push-external-objects-"), "objects");
    renameSync(original, external);
    symlinkSync(external, original);
    const h = harness({ workspace });
    await expect(request(h)).rejects.toThrow(
      /object store must stay inside the trusted workspace/u,
    );
    expect(h.state.pending.size).toBe(0);
  });

  it("rejects symlinked and oversized repository config authority", async () => {
    const symlinked = makeWorkspace();
    const symlinkConfig = join(symlinked.path, ".git", "config");
    const realConfig = join(symlinked.path, ".git", "config.real");
    renameSync(symlinkConfig, realConfig);
    symlinkSync("config.real", symlinkConfig);
    await expect(request(harness({ workspace: symlinked }))).rejects.toThrow(
      /repository config must be one ordinary in-repository file/u,
    );

    const oversized = makeWorkspace();
    const oversizedConfig = join(oversized.path, ".git", "config");
    writeFileSync(
      oversizedConfig,
      `${readFileSync(oversizedConfig, "utf8")}\n# ${"x".repeat(65 * 1024)}\n`,
    );
    await expect(request(harness({ workspace: oversized }))).rejects.toThrow(
      /repository config is outside its bounded authority/u,
    );
  });

  it("rejects ambient alternate-object authority before review", async () => {
    const previous = process.env["GIT_ALTERNATE_OBJECT_DIRECTORIES"];
    process.env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = tempDir("keel-git-push-ambient-alt-");
    try {
      await expect(request(harness())).rejects.toThrow(
        /alternate object databases are unsupported/u,
      );
    } finally {
      if (previous === undefined) delete process.env["GIT_ALTERNATE_OBJECT_DIRECTORIES"];
      else process.env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = previous;
    }
  });

  it.each([
    ["remote.origin.mirror", "true"],
    ["remote.origin.proxy", "http://proxy.invalid:8080"],
    ["remote.origin.receivepack", "/tmp/hostile-receive-pack"],
    ["remote.origin.vcs", "hostile-helper"],
    ["http.followRedirects", "true"],
    ["http.sslVerify", "false"],
    ["core.hooksPath", "/tmp/hostile-hooks"],
    ["push.recurseSubmodules", "on-demand"],
    ["url.https://evil.invalid/.pushInsteadOf", "https://localhost:54321/"],
  ])("rejects repository-local execution or target widening config %s", async (key, value) => {
    const workspace = makeWorkspace();
    git(["config", "--local", key, value], workspace.path);
    const h = harness({ workspace });
    await expect(request(h)).rejects.toThrow(/repository-local Git config is unsupported/u);
    expect(h.state.pending.size).toBe(0);
    expect(externalNetworkExecutions(h)).toEqual([]);
  });

  it("binds the exact repository config bytes even when the derived URL is unchanged", async () => {
    const h = harness();
    const review = await request(h);
    const configPath = join(h.workspace.path, ".git", "config");
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}\n# post-review drift\n`);
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
    expect(externalNetworkExecutions(h)).toEqual([]);
  });

  it("binds excluded untracked state and denies post-review drift before network", async () => {
    const h = harness();
    const review = await request(h);
    writeFileSync(join(h.workspace.path, "new-untracked.txt"), "post-review drift\n");
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
    expect(externalNetworkExecutions(h)).toEqual([]);
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
      expect(externalNetworkExecutions(h)).toEqual([]);

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
    const review = await request(h);

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
    const externalExecutions = externalNetworkExecutions(h);
    expect(externalExecutions).toHaveLength(3);
    const serialized = JSON.stringify(externalExecutions);
    expect(serialized).toContain('"NO_PROXY="');
    expect(serialized).toContain('"no_proxy="');
    expect(serialized).toContain(`${h.workspace.head}:${destination}`);
    for (const neutralization of [
      "push.followTags=false",
      "push.gpgSign=false",
      "push.pushOption=",
      "push.useForceIfIncludes=false",
      "submodule.recurse=false",
      "protocol.allow=never",
      "protocol.https.allow=always",
      "http.extraHeader=",
    ]) {
      expect(serialized).toContain(neutralization);
    }
    expect(serialized).not.toContain("fixture-secret");
    const initExecution = h.executions.find((execution) =>
      (execution as { invocation: { argv?: readonly string[] } }).invocation.argv?.includes("init"),
    ) as { invocation: { cwd?: string }; profile: SandboxProfile } | undefined;
    expect(initExecution).toBeDefined();
    expect(initExecution?.invocation.cwd).toMatch(/attempt-/u);
    expect(initExecution?.profile.filesystem?.allowRead).not.toContain(
      realpathSync(h.workspace.path),
    );
    const diffTreeExecution = h.executions.find((execution) =>
      (execution as { invocation: { argv?: readonly string[] } }).invocation.argv?.includes(
        "diff-tree",
      ),
    ) as { invocation: { argv?: readonly string[] } } | undefined;
    expect(diffTreeExecution?.invocation.argv).toEqual(
      expect.arrayContaining(["--no-ext-diff", "--no-textconv"]),
    );
    const credential = (
      externalExecutions[0] as {
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
    const review = await request(h);
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
    expect(externalNetworkExecutions(h)).toHaveLength(1);
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
    const review = await request(h);
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
    const workspace = makeWorkspace();
    const h = harness({
      workspace,
      sandboxResults: [
        sandboxResult(
          `ref: refs/heads/feature/unit\tHEAD\n${workspace.head}\tHEAD\n${workspace.head}\trefs/heads/feature/unit\n`,
        ),
      ],
    });
    const review = await request(h);
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
    expect(externalNetworkExecutions(h)).toHaveLength(1);
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
    const review = await request(h);
    h.setNow(now);
    const result = await resolveGitPushReview(h.context, review, {
      reviewId: review.reviewId,
      approved,
      ...(scope === undefined ? {} : { scope }),
      principal,
    });
    expect(result).toMatchObject({ verdict: "deny", result: { reason } });
    expect(externalNetworkExecutions(h)).toEqual([]);
    expect(result.auditSeq).toBe(2);
  });

  it("denies binding drift after approval and before network", async () => {
    const h = harness();
    const review = await request(h);
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
    expect(externalNetworkExecutions(h)).toEqual([]);
  });

  it("turns post-approval local inspection failure into an audited zero-network denial", async () => {
    const h = harness();
    const review = await request(h);
    rmSync(join(h.workspace.path, ".git", "config"));
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
    expect(h.audits.at(-1)).toMatchObject({
      eventType: "tool.deny",
      payload: { actionMayHaveExecuted: false, reason: "git.push revalidation failed" },
    });
    expect(externalNetworkExecutions(h)).toEqual([]);
  });

  it("fails closed when the review-request audit cannot be made durable", async () => {
    const h = harness();
    const context: GitPushRuntimeContext = {
      ...h.context,
      appendAudit: () => {
        throw new Error("audit unavailable");
      },
    };
    await expect(requestGitPushReview(context, executeArgs(h.workspace.head))).rejects.toThrow(
      /audit unavailable/u,
    );
    expect(h.state.pending.size).toBe(0);
    expect(externalNetworkExecutions(h)).toEqual([]);
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
    const review = await request(h);
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
    const review = await request(h);
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
    const externalExecutions = externalNetworkExecutions(h);
    expect(externalExecutions).toHaveLength(3);
    expect(
      (externalExecutions[0] as { profile: { filesystem: { denyWrite: readonly string[] } } })
        .profile.filesystem.denyWrite,
    ).toEqual([realpathSync(workspace.path)]);
  });

  it("fails before mutation on malformed remote-ref authority rows", async () => {
    const h = harness({
      sandboxResults: [sandboxResult("malformed-without-tab\n")],
    });
    const review = await request(h);
    const result = await resolveGitPushReview(h.context, review, {
      reviewId: review.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    expect(result).toMatchObject({
      verdict: "deny",
      result: { status: "failed", observedRef: null, actionMayHaveExecuted: false },
    });
    expect(externalNetworkExecutions(h)).toHaveLength(1);
  });

  it("fails before mutation when preflight returns duplicate authority rows", async () => {
    const h = harness({
      sandboxResults: [
        sandboxResult(
          `ref: refs/heads/main\tHEAD\n${"a".repeat(40)}\trefs/heads/feature/unit\n${"b".repeat(40)}\trefs/heads/feature/unit\n`,
        ),
      ],
    });
    const review = await request(h);
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
    expect(externalNetworkExecutions(h)).toHaveLength(1);
  });

  it("does not trim hostile remote-ref bytes into valid authority", async () => {
    const h = harness({
      sandboxResults: [sandboxResult(` ${"a".repeat(40)}\trefs/heads/feature/unit\n`)],
    });
    const review = await request(h);
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
    expect(externalNetworkExecutions(h)).toHaveLength(1);
  });

  it("records an unclassified bounded diagnostic without retaining raw stderr", async () => {
    const h = harness({ sandboxResults: [sandboxResult("", { exitCode: 1 })] });
    const review = await request(h);
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
    const review = await request(h);
    const externalFailure: SandboxPort["execute"] = vi
      .fn<SandboxPort["execute"]>()
      .mockRejectedValue("fixture rejection");
    const context: GitPushRuntimeContext = {
      ...h.context,
      sandbox: {
        status: () => h.context.sandbox.status(),
        execute: async (invocation, profile, options) => {
          if (profile.network?.allowedDomains?.length === 0) {
            return await h.context.sandbox.execute(invocation, profile, options);
          }
          return await externalFailure(invocation, profile, options);
        },
      },
    };
    const result = await resolveGitPushReview(context, review, {
      reviewId: review.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    expect(result).toMatchObject({
      verdict: "deny",
      result: { status: "failed", actionMayHaveExecuted: false },
    });
    expect(h.audits.at(-1)?.payload).toMatchObject({ errorClass: "unknown" });
    expect(
      spawnSync("find", [h.state.config.tempRoot, "-maxdepth", "1", "-name", "attempt-*"], {
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("");
  });

  it("fails before network when the temporary-root identity changes after review", async () => {
    const h = harness();
    const review = await request(h);
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
    expect(externalNetworkExecutions(h)).toEqual([]);
  });

  it("reports a preflight exception after intent as failed with no mutation", async () => {
    const h = harness({ sandboxResults: [] });
    const review = await request(h);
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
  });

  it("reports an exception after the push starts as indeterminate without retry", async () => {
    const h = harness({
      sandboxResults: [sandboxResult("ref: refs/heads/main\tHEAD\n")],
    });
    const review = await request(h);
    const result = await resolveGitPushReview(h.context, review, {
      reviewId: review.reviewId,
      approved: true,
      scope: "once",
      principal,
    });
    expect(result).toMatchObject({
      verdict: "deny",
      result: {
        status: "indeterminate",
        actionMayHaveExecuted: true,
        automaticRetry: false,
      },
    });
    expect(externalNetworkExecutions(h)).toHaveLength(2);
  });

  it.each([
    ["wrong tool", { tool: "bash" }, "unexpected tool name"],
    ["additional arg", { extra: true }, "requires exactly"],
    ["missing arg", { omit: "expectedHead" }, "requires exactly"],
    ["invalid remote", { remote: "-origin" }, "remote must"],
    ["empty branch", { branch: "" }, "branch must"],
    ["symbolic HEAD branch", { branch: "HEAD" }, "branch must"],
    ["at branch", { branch: "@" }, "branch must"],
    ["oversized branch", { branch: "a".repeat(129) }, "branch must"],
    ["unicode branch", { branch: "feature/é" }, "branch must"],
    ["reserved branch", { branch: "refs/heads/x" }, "branch must"],
    ["abbreviated oid", { expectedHead: "abc" }, "expectedHead must"],
    ["uppercase oid", { expectedHead: "A".repeat(40) }, "expectedHead must"],
    ["non-string oid", { expectedHead: 42 }, "expectedHead must"],
  ])("audits and rejects $label before review", async (_label, mutation, expected) => {
    const h = harness();
    const isWrongTool = typeof mutation === "object" && mutation !== null && "tool" in mutation;
    const isOmittedArg = typeof mutation === "object" && mutation !== null && "omit" in mutation;
    const params = isWrongTool
      ? {
          ...executeArgs(h.workspace.head),
          toolCall: { ...executeArgs(h.workspace.head).toolCall, name: String(mutation.tool) },
        }
      : isOmittedArg
        ? (() => {
            const base = executeArgs(h.workspace.head);
            const args = { ...base.toolCall.args };
            delete (args as Record<string, unknown>)[String(mutation.omit)];
            return { ...base, toolCall: { ...base.toolCall, args } };
          })()
        : executeArgs(h.workspace.head, mutation);
    let thrown: GitPushInvalidParamsError | undefined;
    try {
      await requestGitPushReview(h.context, params);
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

  it("rejects binary commit summaries and alternate object stores", async () => {
    const binary = harness({ workspace: makeWorkspace({ binary: true }) });
    await expect(request(binary)).rejects.toThrow(GitPushInvalidParamsError);

    const alternate = harness();
    const info = join(alternate.workspace.path, ".git", "objects", "info");
    mkdirSync(info, { recursive: true });
    writeFileSync(join(info, "alternates"), `${tempDir("keel-git-push-alt-")}\n`);
    await expect(request(alternate)).rejects.toThrow(/alternate object databases/u);
  });

  it("supports parented and empty commits while preserving exact bounded facts", async () => {
    const h = harness({ workspace: makeWorkspace({ secondEmptyCommit: true }) });
    const review = await request(h);
    expect(review.summary).toContain("; 1; 0 files; +0 -0");
  });

  it("rejects approval subjects that are empty or exceed their byte bound", async () => {
    await expect(
      request(harness({ workspace: makeWorkspace({ emptySubject: true }) })),
    ).rejects.toThrow(/commit subject cannot be shown losslessly/u);
    await expect(
      request(harness({ workspace: makeWorkspace({ message: "x".repeat(161) }) })),
    ).rejects.toThrow(/commit subject cannot be shown losslessly/u);
  });

  it("rejects nested, bare, and linked-worktree repository shapes", async () => {
    const nested = harness();
    const nestedRoot = join(nested.workspace.path, "nested");
    mkdirSync(nestedRoot);
    await expect(
      requestGitPushReview(
        { ...nested.context, workspaceRoot: nestedRoot },
        executeArgs(nested.workspace.head),
      ),
    ).rejects.toThrow(/ordinary repository top level/u);

    const bareRoot = tempDir("keel-git-push-bare-");
    git(["init", "--bare"], bareRoot);
    const bare = harness({ workspace: { path: bareRoot, head: "a".repeat(40) } });
    await expect(request(bare)).rejects.toThrow(/ordinary non-bare repository/u);

    const source = makeWorkspace();
    const linkedRoot = tempDir("keel-git-push-linked-");
    rmSync(linkedRoot, { recursive: true, force: true });
    git(["worktree", "add", "--detach", linkedRoot, source.head], source.path);
    const linked = harness({ workspace: { path: linkedRoot, head: source.head } });
    await expect(request(linked)).rejects.toThrow(/non-directory .git layouts/u);
  });

  it("rejects changed HEAD and remote URL multiplicity", async () => {
    const changedHead = harness();
    await expect(
      requestGitPushReview(changedHead.context, executeArgs("a".repeat(40))),
    ).rejects.toThrow(/current HEAD does not equal expectedHead/u);

    const detachedHead = harness();
    git(["checkout", "--detach", detachedHead.workspace.head], detachedHead.workspace.path);
    await expect(request(detachedHead)).rejects.toThrow(/detached HEAD is unsupported/u);

    const missingRemote = harness();
    git(["remote", "remove", "origin"], missingRemote.workspace.path);
    await expect(request(missingRemote)).rejects.toThrow(/exactly one repository-local URL/u);

    const multiple = harness();
    git(["config", "--local", "--add", "remote.origin.url", canonicalUrl], multiple.workspace.path);
    await expect(request(multiple)).rejects.toThrow(/exactly one repository-local URL/u);
  });

  it("accepts Git's sha256 object format when the installed Git supports it", async () => {
    const probeRoot = tempDir("keel-git-push-sha256-probe-");
    const probe = spawnSync("git", ["init", "--bare", "--object-format=sha256", probeRoot], {
      encoding: "utf8",
    });
    if (probe.status !== 0) return;
    const h = harness({ workspace: makeWorkspace({ objectFormat: "sha256" }) });
    expect((await request(h)).facts.objectFormat).toBe("sha256");
  });

  it("rejects unsafe remote config variants and unavailable fixture authority", async () => {
    const mismatch = harness();
    git(
      ["remote", "set-url", "origin", "https://localhost:54321/other.git"],
      mismatch.workspace.path,
    );
    await expect(request(mismatch)).rejects.toThrow(/injected canonical HTTPS/u);

    const normalizedWhitespace = harness();
    git(
      ["config", "--local", "remote.origin.url", `${canonicalUrl} `],
      normalizedWhitespace.workspace.path,
    );
    await expect(request(normalizedWhitespace)).rejects.toThrow(/injected canonical HTTPS/u);

    const pushUrl = harness();
    git(["remote", "set-url", "--push", "origin", canonicalUrl], pushUrl.workspace.path);
    await expect(request(pushUrl)).rejects.toThrow(/pushurl is unsupported/u);

    const unavailable = harness({
      status: { ...activeStatus, features: [EGRESS_ADDRESS_GUARD_CAPABILITY] },
    });
    await expect(request(unavailable)).rejects.toThrow(/fixture boundary is unavailable/u);
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
