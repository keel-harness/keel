/**
 * ADR-0091 Slice 5: one exact pull-request creation through the real contained transport.
 *
 * This opt-in acceptance test exercises the Warden authority, real Git inspection, the
 * system/global-only credential broker, vendored SRT address guarding, verified HTTPS credential
 * injection, the GitHub REST request sequence, and exact post-create observation together. The
 * localhost API is a release-withheld fixture; production authority remains fixed to api.github.com.
 */
import { spawnSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:net";
import { createSecureContext } from "node:tls";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createGitCredentialBroker } from "./git-credential-broker.js";
import type {
  GithubPrCreateAuthorityContext,
  GithubPrCreateBindingAuthorityRequest,
  GithubPrCreateExecuteParams,
} from "./github-pr-create-authority.js";
import { resolveProductionCurlExecutable } from "./github-pr-create-product.js";
import {
  createGithubPrCreateWalkingSkeletonAuthority,
  parseGithubPrCreateRequest,
} from "./github-pr-create.js";
import { resolveProductionGitExecutable } from "./git-push-product.js";
import { isRealSandboxRequired, resolveRealSandboxGate } from "./real-sandbox-gate.js";
import { createVendoredSrtSandboxComponents } from "./srt-runtime-loader.js";
import type { VendoredSrtSandboxComponents } from "./srt-runtime-loader.js";
import type { SandboxExecutionResult, SandboxInvocation, SandboxPort } from "./sandbox.js";

const required = isRealSandboxRequired(process.env);
const suite = required ? describe : describe.skip;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureDir = join(repoRoot, "vendor", "sandbox-runtime", "test", "fixtures", "tls-terminate");
const fixtureCaCert = join(fixtureDir, "ca.crt");
const fixtureServerKey = join(fixtureDir, "server.key");
const repository = "keel-harness/keel";
const canonicalRemote = `https://github.com/${repository}.git`;
const token = "github-pr-real-srt-token-canary";
const roots: string[] = [];
let components: VendoredSrtSandboxComponents | undefined;

interface RequestObservation {
  readonly authorization?: string;
  readonly body: string;
  readonly host?: string;
  readonly method?: string;
  readonly url?: string;
}

interface ApiFixture {
  readonly origin: string;
  readonly port: number;
  readonly requests: RequestObservation[];
  readonly serverNames: string[];
  close(): Promise<void>;
}

type ObservedExecution =
  | { readonly invocation: SandboxInvocation; readonly outcome: SandboxExecutionResult }
  | {
      readonly invocation: SandboxInvocation;
      readonly error: { readonly name: string; readonly message: string } | "unknown";
    };

function isSuccessfulExecution(
  execution: ObservedExecution,
): execution is Extract<ObservedExecution, { readonly outcome: SandboxExecutionResult }> {
  return "outcome" in execution;
}

function privateRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function runGit(executable: string, args: readonly string[], cwd?: string): string {
  const result = spawnSync(executable, [...args], {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"],
      HOME: privateRoot("keel-github-pr-repo-home-"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function createWorkspace(gitExecutable: string): {
  readonly path: string;
  readonly base: string;
  readonly head: string;
} {
  const path = privateRoot("keel-github-pr-real-workspace-");
  runGit(gitExecutable, ["init", "--initial-branch=main"], path);
  writeFileSync(join(path, "file.txt"), "base\n");
  runGit(gitExecutable, ["add", "file.txt"], path);
  runGit(
    gitExecutable,
    ["-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-m", "base"],
    path,
  );
  const base = runGit(gitExecutable, ["rev-parse", "HEAD"], path);
  runGit(gitExecutable, ["switch", "-c", "feature/pr"], path);
  writeFileSync(join(path, "file.txt"), "feature\n");
  runGit(gitExecutable, ["add", "file.txt"], path);
  runGit(
    gitExecutable,
    ["-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-m", "feature"],
    path,
  );
  const head = runGit(gitExecutable, ["rev-parse", "HEAD"], path);
  runGit(gitExecutable, ["remote", "add", "origin", canonicalRemote], path);
  return { path, base, head };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected a TCP fixture address"));
        return;
      }
      resolveListen(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else reject(error);
    });
  });
}

async function requestBody(request: IncomingMessage): Promise<string> {
  return await new Promise((resolveBody, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.once("end", () => resolveBody(body));
    request.once("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(serialized),
    connection: "close",
  });
  response.end(serialized);
}

function refBody(branch: string, sha: string): Record<string, unknown> {
  return { ref: `refs/heads/${branch}`, object: { type: "commit", sha } };
}

function prBody(head: string): Record<string, unknown> {
  return {
    number: 42,
    html_url: `https://github.com/${repository}/pull/42`,
    state: "open",
    title: "Ship the contained PR path",
    body: "Exact real-SRT acceptance.",
    draft: false,
    maintainer_can_modify: true,
    head: { ref: "feature/pr", sha: head, repo: { full_name: repository } },
    base: { ref: "main", repo: { full_name: repository } },
  };
}

async function startApiFixture(head: string, base: string): Promise<ApiFixture> {
  const cert = readFileSync(join(fixtureDir, "localhost.crt"), "utf8");
  const key = readFileSync(fixtureServerKey, "utf8");
  const secureContext = createSecureContext({ cert, key });
  const requests: RequestObservation[] = [];
  const serverNames: string[] = [];
  let created = false;
  const server = createHttpsServer(
    {
      cert,
      key,
      SNICallback: (serverName, callback) => {
        serverNames.push(serverName);
        callback(null, secureContext);
      },
    },
    (request, response) => {
      void (async () => {
        const body = await requestBody(request);
        requests.push({
          ...(request.headers.authorization === undefined
            ? {}
            : { authorization: request.headers.authorization }),
          body,
          ...(request.headers.host === undefined ? {} : { host: request.headers.host }),
          ...(request.method === undefined ? {} : { method: request.method }),
          ...(request.url === undefined ? {} : { url: request.url }),
        });
        const url = new URL(request.url ?? "/", "https://localhost");
        const refPrefix = `/repos/${repository}/git/ref/`;
        if (request.method === "GET" && url.pathname.startsWith(refPrefix)) {
          const ref = decodeURIComponent(url.pathname.slice(refPrefix.length));
          if (ref === "heads/feature/pr") sendJson(response, 200, refBody("feature/pr", head));
          else if (ref === "heads/main") sendJson(response, 200, refBody("main", base));
          else sendJson(response, 404, { message: "not found" });
          return;
        }
        if (url.pathname === `/repos/${repository}/pulls` && request.method === "GET") {
          sendJson(response, 200, created ? [prBody(head)] : []);
          return;
        }
        if (url.pathname === `/repos/${repository}/pulls` && request.method === "POST") {
          expect(JSON.parse(body)).toEqual({
            title: "Ship the contained PR path",
            body: "Exact real-SRT acceptance.",
            head: "feature/pr",
            base: "main",
            draft: false,
            maintainer_can_modify: true,
          });
          created = true;
          sendJson(response, 201, prBody(head));
          return;
        }
        sendJson(response, 404, { message: "unexpected fixture request" });
      })().catch(() => {
        response.destroy();
      });
    },
  );
  const port = await listen(server);
  return {
    origin: `https://localhost:${String(port)}`,
    port,
    requests,
    serverNames,
    close: () => closeServer(server),
  };
}

function params(head: string): GithubPrCreateExecuteParams {
  return {
    sessionId: "session-github-pr-real-srt",
    toolCall: {
      id: "call-github-pr-real-srt",
      name: "github.pr.create",
      args: {
        remote: "origin",
        repository,
        head: "feature/pr",
        expectedHead: head,
        base: "main",
        title: "Ship the contained PR path",
        body: "Exact real-SRT acceptance.",
        draft: false,
        maintainerCanModify: true,
      },
    },
    provenanceContext: { inputTags: ["workspace"] },
  };
}

function bindingAuthority(request: GithubPrCreateBindingAuthorityRequest, workspaceRoot: string) {
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
      principal: { osUser: "github-pr-real-srt" },
    },
    policyDecision: { verdict: "review" as const, matchedRules: ["POL-GITHUB-PR-CREATE"] },
    policyPack: { name: "test-policy", hash: `sha256:${"9".repeat(64)}` as const },
    addressGuardRevision: "real-srt-local-fixture-v1",
    auditAuthorityId: "real-srt-test-audit-v1",
  };
}

afterEach(async () => {
  await components?.shutdown();
  components = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

suite("governed github.pr.create real SRT acceptance (opt-in)", () => {
  it("creates exactly one PR through verified TLS and observes its exact final state", async () => {
    if (realpathSync(process.env["NODE_EXTRA_CA_CERTS"] ?? "") !== realpathSync(fixtureCaCert)) {
      throw new Error(
        `real github.pr.create test requires NODE_EXTRA_CA_CERTS=${fixtureCaCert} before Node starts`,
      );
    }
    const workspaceRoot = privateRoot("keel-github-pr-resolve-root-");
    const resolvedGit = resolveProductionGitExecutable({ workspaceRoot, env: process.env });
    const resolvedCurl = resolveProductionCurlExecutable({ workspaceRoot, env: process.env });
    if (resolvedGit === undefined || resolvedCurl === undefined) {
      throw new Error("real github.pr.create test requires supported host Git and curl");
    }
    const source = createWorkspace(resolvedGit.path);
    const fixture = await startApiFixture(source.head, source.base);
    const operatorHome = privateRoot("keel-github-pr-operator-home-");
    const helperPath = join(operatorHome, "helper.mjs");
    writeFileSync(
      helperPath,
      `process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(${JSON.stringify(
        `username=x-access-token\npassword=${token}\n`,
      )}));\n`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(operatorHome, ".gitconfig"),
      `[credential]\n\thelper =\n\thelper = !${process.execPath} ${helperPath}\n`,
      { mode: 0o600 },
    );
    const tempRoot = privateRoot("keel-github-pr-real-attempts-");
    const authorityRoot = privateRoot("keel-github-pr-real-authority-");
    const broker = createGitCredentialBroker({
      gitExecutable: resolvedGit.path,
      tempRoot,
      env: { HOME: operatorHome, PATH: process.env["PATH"] ?? "/usr/bin:/bin", LANG: "C" },
    });
    components = await createVendoredSrtSandboxComponents({
      credentialTlsTermination: true,
      launchAuthorityRegistryPath: join(authorityRoot, "endpoint-leases.json"),
      resolveDestination: async (hostname, port) => {
        if (hostname !== "localhost" || port !== fixture.port) {
          throw new Error("fixture destination escaped its exact authority");
        }
        return [{ address: "127.0.0.1", family: 4 }];
      },
    });
    const status = components.sandbox.status();
    const gate = resolveRealSandboxGate({
      required,
      available: status.available,
      ...(status.reason === undefined ? {} : { unavailableReason: status.reason }),
    });
    if (gate.action === "fail") throw new Error(gate.reason);
    if (gate.action !== "run") throw new Error(gate.reason);

    const authority = createGithubPrCreateWalkingSkeletonAuthority({
      advertiseTestCapability: true,
      fixtureApi: {
        origin: fixture.origin,
        host: "localhost",
        port: fixture.port,
        address: "127.0.0.1",
      },
      credentialBroker: broker,
      gitExecutable: resolvedGit.path,
      gitVersion: resolvedGit.version,
      curlExecutable: resolvedCurl.path,
      curlVersion: resolvedCurl.version,
      tempRoot,
    });
    const audits: unknown[] = [];
    const executions: ObservedExecution[] = [];
    const observedSandbox: SandboxPort = {
      status: () => components!.sandbox.status(),
      execute: async (invocation, profile, options): Promise<SandboxExecutionResult> => {
        try {
          const outcome = await components!.sandbox.execute(invocation, profile, options);
          executions.push({ invocation, outcome });
          return outcome;
        } catch (error) {
          executions.push({
            invocation,
            error:
              error instanceof Error ? { name: error.name, message: error.message } : "unknown",
          });
          throw error;
        }
      },
    };
    const context: GithubPrCreateAuthorityContext = {
      sandbox: observedSandbox,
      workspaceRoot: source.path,
      auditDir: privateRoot("keel-github-pr-real-audit-"),
      resolveBindingAuthority: async (request) => bindingAuthority(request, source.path),
      appendAudit: (input, failureContext) => {
        audits.push({ input, failureContext });
        return audits.length;
      },
    };

    try {
      expect(
        authority.capabilityAvailable({
          workspaceTrusted: true,
          auditAvailable: true,
          sandbox: components.sandbox.status(),
        }),
      ).toBe(true);
      const requested = await authority.request(context, params(source.head));
      expect(requested.verdict).toBe("review");
      const reviewId = requested.review?.reviewId;
      if (reviewId === undefined) throw new Error("real request produced no review");
      const pending = authority.consumeReview(reviewId);
      if (pending === undefined) throw new Error("real review was not consumable");
      const result = await authority.resolve(context, pending, {
        reviewId,
        approved: true,
        scope: "once",
        principal: {
          osUser: "github-pr-real-srt",
          configuredId: null,
          authProvider: "local",
          assurance: "local-os-user",
        },
      });

      const apiExecutions = executions
        .filter(isSuccessfulExecution)
        .filter((entry) => entry.invocation.command === resolvedCurl.path);
      expect(apiExecutions).toHaveLength(5);
      expect(
        apiExecutions.every(
          (entry) =>
            entry.outcome.exitCode === 0 &&
            entry.outcome.signal === null &&
            entry.outcome.stderr === "",
        ),
      ).toBe(true);
      expect(fixture.requests).toHaveLength(5);
      expect(result).toMatchObject({
        verdict: "allow",
        result: {
          kind: "github_pr_create_result",
          status: "created",
          number: 42,
          url: `https://github.com/${repository}/pull/42`,
          commit: source.head,
          automaticRetry: false,
          actionMayHaveExecuted: true,
        },
      });
      expect(fixture.requests.map((request) => request.method)).toEqual([
        "GET",
        "GET",
        "GET",
        "POST",
        "GET",
      ]);
      expect(fixture.requests.filter((request) => request.method === "POST")).toHaveLength(1);
      expect(fixture.requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(
        true,
      );
      expect(fixture.serverNames).toEqual(Array(5).fill("localhost"));
      expect(JSON.stringify({ result, audits })).not.toContain(token);
      expect(readdirSync(tempRoot).filter((name) => name.startsWith("github-pr-attempt-"))).toEqual(
        [],
      );
    } finally {
      await fixture.close();
    }
  }, 60_000);
});
