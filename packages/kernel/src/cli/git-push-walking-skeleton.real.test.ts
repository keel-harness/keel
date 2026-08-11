/**
 * ADR-0091 Slice 1: one exact new-branch push through the complete product path.
 *
 * This suite is part of the fail-closed real-sandbox gate. It deliberately uses a spawned Warden,
 * the vendored SRT, verified HTTPS, connect-time address resolution, and Git's smart-HTTP backend.
 * The credential and non-default port are injected only by the generated non-release fixture entry.
 */
import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { createSecureContext } from "node:tls";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnyAuditRecord,
  toChainRecords,
  verifyChain,
  type UserInput,
  type ViewModel,
} from "@keel/shared";
import { ScriptedModel } from "@keel/simulator";
import { InputQueue } from "./input-queue.js";
import { runKeelCommand } from "./session-entry.js";
import { listSessions } from "../session/list.js";
import { readSession } from "../session/store.js";
import { renderFrame } from "../tui/headless.js";
import type { ProductionWardenStartOptions } from "../warden/runtime.js";

const required = ["1", "true"].includes(
  (process.env["KEEL_REQUIRE_REAL_SANDBOX"] ?? "").trim().toLowerCase(),
);
const suite = required ? describe : describe.skip;
const ROOT = process.cwd();
const requireFromWarden = createRequire(join(ROOT, "packages/warden/src/bin.ts"));
const TSX_ESM_LOADER = pathToFileURL(requireFromWarden.resolve("tsx/esm")).href;
const WARDEN_RPC_SERVER_URL = pathToFileURL(join(ROOT, "packages/warden/src/rpc-server.ts")).href;
const WARDEN_SESSION_LOG_URL = pathToFileURL(
  join(ROOT, "packages/warden/src/audit/session-log.ts"),
).href;
const WARDEN_POLICY_URL = pathToFileURL(join(ROOT, "packages/warden/src/policy.ts")).href;
const WARDEN_SRT_LOADER_URL = pathToFileURL(
  join(ROOT, "packages/warden/src/srt-runtime-loader.ts"),
).href;
const WARDEN_GIT_PUSH_URL = pathToFileURL(join(ROOT, "packages/warden/src/git-push.ts")).href;
const TLS_FIXTURE_DIR = join(ROOT, "vendor/sandbox-runtime/test/fixtures/tls-terminate");
const FIXTURE_USERNAME = "keel-fixture-user";
// Generate the canary only in test-process memory: no credential byte is retained in source or a
// release carrier, while every product/evidence assertion still scans for the exact runtime value.
const FIXTURE_SECRET = randomBytes(24).toString("base64url");
const FIXTURE_AUTHORIZATION = `Basic ${Buffer.from(
  `${FIXTURE_USERNAME}:${FIXTURE_SECRET}`,
  "utf8",
).toString("base64")}`;
const PRINCIPAL = {
  osUser: "git-push-product-test",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
} as const;

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(args: readonly string[], cwd?: string): string {
  const result = spawnSync("git", [...args], {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"],
      HOME: tempDir("keel-git-push-host-home-"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

interface GitRequestObservation {
  readonly authorization?: string;
  readonly host?: string;
  readonly method?: string;
  readonly url?: string;
}

interface SmartGitFixture {
  readonly canonicalUrl: string;
  readonly port: number;
  readonly remoteGitDir: string;
  readonly requests: GitRequestObservation[];
  readonly serverNames: string[];
  close(): Promise<void>;
}

function splitCgiResponse(output: Buffer): { readonly headers: string; readonly body: Buffer } {
  const crlf = output.indexOf("\r\n\r\n");
  const lf = output.indexOf("\n\n");
  const index = crlf >= 0 ? crlf : lf;
  if (index < 0) throw new Error("git http-backend returned no CGI header boundary");
  const width = crlf >= 0 ? 4 : 2;
  return {
    headers: output.subarray(0, index).toString("utf8"),
    body: output.subarray(index + width),
  };
}

async function serveGitRequest(
  request: IncomingMessage,
  response: ServerResponse,
  projectRoot: string,
): Promise<void> {
  const rawUrl = request.url ?? "/";
  const parsed = new URL(rawUrl, "https://localhost");
  const child = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env["PATH"],
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: parsed.pathname,
      QUERY_STRING: parsed.search.slice(1),
      REQUEST_METHOD: request.method ?? "GET",
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      CONTENT_LENGTH: request.headers["content-length"] ?? "",
      REMOTE_USER: FIXTURE_USERNAME,
      SERVER_PROTOCOL: `HTTP/${request.httpVersion}`,
      SERVER_NAME: "localhost",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  request.pipe(child.stdin);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const status = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  if (status !== 0) {
    throw new Error(`git http-backend failed: ${Buffer.concat(stderr).toString("utf8")}`);
  }
  const cgi = splitCgiResponse(Buffer.concat(stdout));
  let responseStatus = 200;
  for (const line of cgi.headers.split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name.toLowerCase() === "status") {
      responseStatus = Number.parseInt(value, 10);
    } else {
      response.setHeader(name, value);
    }
  }
  response.statusCode = responseStatus;
  response.end(cgi.body);
}

async function startSmartGitFixture(): Promise<SmartGitFixture> {
  const projectRoot = tempDir("keel-git-push-upstream-");
  const remoteGitDir = join(projectRoot, "repo.git");
  git(["init", "--bare", remoteGitDir]);
  git(["--git-dir", remoteGitDir, "config", "http.receivepack", "true"]);
  const requests: GitRequestObservation[] = [];
  const serverNames: string[] = [];
  const cert = readFileSync(join(TLS_FIXTURE_DIR, "localhost.crt"), "utf8");
  const key = readFileSync(join(TLS_FIXTURE_DIR, "server.key"), "utf8");
  const secureContext = createSecureContext({ cert, key });
  const server = createHttpsServer(
    {
      cert,
      key,
      SNICallback(serverName, callback) {
        serverNames.push(serverName);
        callback(null, secureContext);
      },
    },
    (request, response) => {
      requests.push({
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
        ...(request.headers.host === undefined ? {} : { host: request.headers.host }),
        ...(request.method === undefined ? {} : { method: request.method }),
        ...(request.url === undefined ? {} : { url: request.url }),
      });
      if (request.headers.authorization !== FIXTURE_AUTHORIZATION) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="keel-git-fixture"' });
        response.end("authentication required");
        return;
      }
      void serveGitRequest(request, response, projectRoot).catch((error: unknown) => {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : String(error));
      });
    },
  );
  const port = await new Promise<number>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected HTTPS fixture TCP address"));
        return;
      }
      resolveListen(address.port);
    });
  });
  return {
    canonicalUrl: `https://localhost:${String(port)}/repo.git`,
    port,
    remoteGitDir,
    requests,
    serverNames,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error === undefined ? resolveClose() : reject(error)));
      }),
  };
}

class TestUI {
  latest: ViewModel | undefined;
  readonly queue = new InputQueue();
  #renderWaiters: { readonly pred: (view: ViewModel) => boolean; readonly resolve: () => void }[] =
    [];

  render(view: ViewModel): void {
    this.latest = view;
    this.#renderWaiters = this.#renderWaiters.filter((waiter) => {
      if (!waiter.pred(view)) return true;
      waiter.resolve();
      return false;
    });
  }

  awaitRender(pred: (view: ViewModel) => boolean): Promise<void> {
    if (this.latest !== undefined && pred(this.latest)) return Promise.resolve();
    return new Promise((resolveWait) => this.#renderWaiters.push({ pred, resolve: resolveWait }));
  }

  inputs(): AsyncIterable<UserInput> {
    return this.queue;
  }

  close(): Promise<void> {
    this.queue.close();
    return Promise.resolve();
  }
}

async function waitFor(
  ui: TestUI,
  label: string,
  predicate: (view: ViewModel) => boolean,
  timeoutMs = 8_000,
): Promise<void> {
  await Promise.race([
    ui.awaitRender(predicate),
    new Promise<never>((_, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `timed out waiting for ${label}; latest frame: ${
              ui.latest === undefined ? "<none>" : renderFrame(ui.latest)
            }`,
          ),
        );
      }, timeoutMs);
      timeout.unref();
    }),
  ]);
}

function createWorkspace(remoteUrl: string): { readonly cwd: string; readonly head: string } {
  const cwd = tempDir("keel-git-push-workspace-");
  git(["init", "--initial-branch=main"], cwd);
  writeFileSync(join(cwd, "walking.txt"), "walking skeleton\n");
  git(["add", "walking.txt"], cwd);
  git(
    [
      "-c",
      "user.name=Keel Fixture",
      "-c",
      "user.email=fixture@keel.invalid",
      "commit",
      "-m",
      "walking skeleton commit",
    ],
    cwd,
  );
  git(["remote", "add", "origin", remoteUrl], cwd);
  return { cwd, head: git(["rev-parse", "HEAD"], cwd) };
}

function spawnedGitPushWarden(options: {
  readonly auditDir: string;
  readonly fixture: SmartGitFixture;
  readonly workspaceRoot: string;
}): ProductionWardenStartOptions {
  const entryDir = tempDir("keel-git-push-warden-entry-");
  const entryPath = join(entryDir, "warden.mjs");
  const tempRoot = tempDir("keel-git-push-warden-temp-");
  const gitExecutable = resolve(spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim());
  writeFileSync(
    entryPath,
    `
      import { rmSync } from "node:fs";
      import { runStdioWardenServer } from ${JSON.stringify(WARDEN_RPC_SERVER_URL)};
      import { SessionAuditLog } from ${JSON.stringify(WARDEN_SESSION_LOG_URL)};
      import { defaultPolicyPackRef } from ${JSON.stringify(WARDEN_POLICY_URL)};
      import { createVendoredSrtSandboxComponents } from ${JSON.stringify(WARDEN_SRT_LOADER_URL)};
      import { createGitPushWalkingSkeletonAuthority } from ${JSON.stringify(WARDEN_GIT_PUSH_URL)};

      const fixture = ${JSON.stringify({
        canonicalUrl: options.fixture.canonicalUrl,
        host: "localhost",
        port: options.fixture.port,
        address: "127.0.0.1",
        username: FIXTURE_USERNAME,
        secret: FIXTURE_SECRET,
        credentialSourceClass: "deterministic-test-provider",
      })};
      const components = await createVendoredSrtSandboxComponents({
        credentialTlsTermination: true,
        resolveDestination: async (hostname, port) => {
          if (hostname !== fixture.host || port !== fixture.port) {
            throw new Error("fixture resolver refused unbound destination");
          }
          return [{ address: fixture.address, family: 4 }];
        }
      });
      const status = components.sandbox.status();
      if (!status.available) throw new Error(status.reason ?? "real SRT unavailable");
      const checkpointSecretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
      const auditLog = new SessionAuditLog({
        auditDir: ${JSON.stringify(options.auditDir)},
        principal: ${JSON.stringify(PRINCIPAL)},
        policyPack: defaultPolicyPackRef(),
        checkpoint: { secretKey: checkpointSecretKey }
      });
      let closed = false;
      function close() {
        if (closed) return;
        closed = true;
        auditLog.close();
        rmSync(${JSON.stringify(tempRoot)}, { recursive: true, force: true });
        setImmediate(() => process.exit(0));
      }
      runStdioWardenServer({
        auditWriter: auditLog,
        auditDir: ${JSON.stringify(options.auditDir)},
        workspaceRoot: ${JSON.stringify(options.workspaceRoot)},
        workspaceTrusted: true,
        sandbox: components.sandbox,
        declaredTempRoots: [${JSON.stringify(tempRoot)}],
        shutdownRuntime: components.shutdown,
        gitPushAuthority: createGitPushWalkingSkeletonAuthority({
          advertiseTestCapability: true,
          fixture,
          gitExecutable: ${JSON.stringify(gitExecutable)},
          tempRoot: ${JSON.stringify(tempRoot)}
        }),
        onShutdown: close
      });
    `,
    { mode: 0o600 },
  );
  return {
    command: process.execPath,
    args: ["--import", TSX_ESM_LOADER, "--conditions=@keel/source", entryPath],
    env: {
      FORCE_COLOR: "0",
      NODE_EXTRA_CA_CERTS: join(TLS_FIXTURE_DIR, "ca.crt"),
    },
    requestTimeoutMs: 50_000,
  };
}

suite("ADR-0091 git.push walking skeleton (real sandbox)", () => {
  it("pushes one exact new branch through model projection, review, SRT TLS, verification, audit, and TUI", async () => {
    const fixture = await startSmartGitFixture();
    const { cwd, head } = createWorkspace(fixture.canonicalUrl);
    const hostilePrePushHook = join(cwd, ".git", "hooks", "pre-push");
    writeFileSync(hostilePrePushHook, "#!/bin/sh\nexit 73\n", { mode: 0o700 });
    chmodSync(hostilePrePushHook, 0o700);
    const home = tempDir("keel-git-push-home-");
    const auditDir = tempDir("keel-git-push-audit-");
    const branch = "feature/walking-skeleton";
    const env: NodeJS.ProcessEnv = {
      KEEL_HOME: home,
      KEEL_NO_SNAPSHOT: "1",
      USER: PRINCIPAL.osUser,
    };
    const ui = new TestUI();
    const done = runKeelCommand(undefined, {
      model: new ScriptedModel({
        turns: [
          {
            toolCalls: [
              {
                name: "git.push",
                args: { remote: "origin", branch, expectedHead: head },
              },
            ],
          },
          { text: "published" },
        ],
      }),
      ui,
      cwd,
      env,
      trustFlag: true,
      warden: spawnedGitPushWarden({ auditDir, fixture, workspaceRoot: cwd }),
    });

    try {
      ui.queue.push({ kind: "line", text: "publish the exact commit" });
      await waitFor(ui, "lossless git.push approval", (view) => {
        const frame = renderFrame(view);
        return (
          frame.includes("approval required") &&
          frame.includes(fixture.canonicalUrl) &&
          frame.includes(branch) &&
          frame.includes(head)
        );
      });
      const approvalFrame = renderFrame(ui.latest!);
      expect(approvalFrame).toContain("create this branch or fast-forward it to this commit");
      expect(approvalFrame).toContain("this occurrence once");
      expect(approvalFrame).not.toContain(FIXTURE_SECRET);

      ui.queue.push({ kind: "command", name: "/approve", args: "once" });
      try {
        await Promise.race([
          waitFor(
            ui,
            "verified git.push completion",
            (view) => view.awaitingInput === true && renderFrame(view).includes("published"),
            35_000,
          ),
          ui
            .awaitRender(
              (view) =>
                view.awaitingInput === true && renderFrame(view).includes("git.push failed"),
            )
            .then(() => {
              const diagnosticSessionId = listSessions(env)[0]?.id;
              const diagnostic =
                diagnosticSessionId === undefined
                  ? undefined
                  : readFileSync(join(auditDir, `${diagnosticSessionId}.jsonl`), "utf8")
                      .trim()
                      .split("\n")
                      .map(
                        (line) =>
                          JSON.parse(line) as {
                            readonly payload?: Record<string, unknown>;
                          },
                      )
                      .at(-1)?.payload?.["failureDiagnostic"];
              throw new Error(
                `git.push returned a governed failure; HTTPS request count: ${String(fixture.requests.length)}; bounded preflight diagnostic: ${JSON.stringify(diagnostic)}`,
              );
            }),
        ]);
      } catch (error) {
        const diagnosticSessionId = listSessions(env)[0]?.id;
        const diagnostic =
          diagnosticSessionId === undefined
            ? undefined
            : readFileSync(join(auditDir, `${diagnosticSessionId}.jsonl`), "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as { readonly payload?: Record<string, unknown> })
                .at(-1)?.payload?.["failureDiagnostic"];
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; HTTPS request count: ${String(fixture.requests.length)}; bounded preflight diagnostic: ${JSON.stringify(diagnostic)}`,
        );
      }
      ui.queue.push({ kind: "command", name: "/exit" });
      await done;

      expect(git(["--git-dir", fixture.remoteGitDir, "rev-parse", `refs/heads/${branch}`])).toBe(
        head,
      );
      expect(fixture.requests.length).toBeGreaterThanOrEqual(3);
      expect(
        fixture.requests.every((request) => request.authorization === FIXTURE_AUTHORIZATION),
      ).toBe(true);
      expect(fixture.serverNames.length).toBeGreaterThan(0);
      expect(fixture.serverNames.every((serverName) => serverName === "localhost")).toBe(true);

      const sessionId = listSessions(env)[0]!.id;
      const session = readSession(sessionId, env);
      const result = session.events.find(
        (event) => event.type === "tool_result" && event.name === "git.push",
      );
      expect(result).toMatchObject({ type: "tool_result" });
      if (result?.type !== "tool_result") throw new Error("expected git.push tool result");
      expect(result.isError).not.toBe(true);
      expect(result.output).toContain('"status":"pushed"');
      expect(result.output).toContain(head);
      expect(JSON.stringify(session.events)).not.toContain(FIXTURE_SECRET);

      const auditPath = join(auditDir, `${sessionId}.jsonl`);
      const auditText = readFileSync(auditPath, "utf8");
      expect(auditText).not.toContain(FIXTURE_SECRET);
      const records = auditText
        .trim()
        .split("\n")
        .map((line) => AnyAuditRecord.parse(JSON.parse(line)));
      expect(verifyChain(toChainRecords(records)).ok).toBe(true);
      expect(
        records.some(
          (record) =>
            record.eventType === "tool.execute" &&
            record.payload["toolName"] === "git.push" &&
            record.payload["execution"] === "requested",
        ),
      ).toBe(true);
      expect(
        records.some(
          (record) =>
            record.eventType === "tool.execute" &&
            record.payload["toolName"] === "git.push" &&
            (record.payload["result"] as { readonly status?: string } | undefined)?.status ===
              "pushed",
        ),
      ).toBe(true);
    } finally {
      ui.queue.push({ kind: "command", name: "/exit" });
      await done.catch(() => undefined);
      await fixture.close();
    }
  }, 60_000);

  it("fast-forwards one existing feature branch to the separately approved exact commit", async () => {
    const fixture = await startSmartGitFixture();
    const { cwd, head: baseHead } = createWorkspace(fixture.canonicalUrl);
    const branch = "feature/fast-forward";
    git(["--git-dir", fixture.remoteGitDir, "fetch", cwd, `${baseHead}:refs/heads/${branch}`]);
    writeFileSync(join(cwd, "second.txt"), "fast-forward commit\n");
    git(["add", "second.txt"], cwd);
    git(
      [
        "-c",
        "user.name=Keel Fixture",
        "-c",
        "user.email=fixture@keel.invalid",
        "commit",
        "-m",
        "fast-forward commit",
      ],
      cwd,
    );
    const head = git(["rev-parse", "HEAD"], cwd);
    const home = tempDir("keel-git-push-ff-home-");
    const auditDir = tempDir("keel-git-push-ff-audit-");
    const env: NodeJS.ProcessEnv = {
      KEEL_HOME: home,
      KEEL_NO_SNAPSHOT: "1",
      USER: PRINCIPAL.osUser,
    };
    const ui = new TestUI();
    const done = runKeelCommand(undefined, {
      model: new ScriptedModel({
        turns: [
          {
            toolCalls: [
              {
                name: "git.push",
                args: { remote: "origin", branch, expectedHead: head },
              },
            ],
          },
          { text: "fast-forwarded" },
        ],
      }),
      ui,
      cwd,
      env,
      trustFlag: true,
      warden: spawnedGitPushWarden({ auditDir, fixture, workspaceRoot: cwd }),
    });

    try {
      ui.queue.push({ kind: "line", text: "publish the fast-forward commit" });
      await waitFor(ui, "fast-forward git.push approval", (view) => {
        const frame = renderFrame(view);
        return (
          frame.includes("approval required") &&
          frame.includes(fixture.canonicalUrl) &&
          frame.includes(branch) &&
          frame.includes(head)
        );
      });
      expect(fixture.requests).toEqual([]);
      ui.queue.push({ kind: "command", name: "/approve", args: "once" });
      await waitFor(
        ui,
        "verified fast-forward completion",
        (view) => view.awaitingInput === true && renderFrame(view).includes("fast-forwarded"),
        35_000,
      );
      ui.queue.push({ kind: "command", name: "/exit" });
      await done;

      expect(git(["--git-dir", fixture.remoteGitDir, "rev-parse", `refs/heads/${branch}`])).toBe(
        head,
      );
      expect(git(["merge-base", "--is-ancestor", baseHead, head], cwd)).toBe("");
      expect(
        fixture.requests.every((request) => request.authorization === FIXTURE_AUTHORIZATION),
      ).toBe(true);
      const sessionId = listSessions(env)[0]!.id;
      const session = readSession(sessionId, env);
      const result = session.events.find(
        (event) => event.type === "tool_result" && event.name === "git.push",
      );
      expect(result).toMatchObject({ type: "tool_result" });
      if (result?.type !== "tool_result") throw new Error("expected fast-forward tool result");
      expect(result.isError).not.toBe(true);
      expect(result.output).toContain('"status":"pushed"');
      expect(result.output).toContain(head);
      expect(JSON.stringify(session.events)).not.toContain(FIXTURE_SECRET);
      expect(readFileSync(join(auditDir, `${sessionId}.jsonl`), "utf8")).not.toContain(
        FIXTURE_SECRET,
      );
    } finally {
      ui.queue.push({ kind: "command", name: "/exit" });
      await done.catch(() => undefined);
      await fixture.close();
    }
  }, 60_000);

  it("reports a real concurrent non-fast-forward rejection and leaves the remote tip unchanged", async () => {
    const fixture = await startSmartGitFixture();
    const { cwd, head: baseHead } = createWorkspace(fixture.canonicalUrl);
    const branch = "feature/non-fast-forward";
    git(["--git-dir", fixture.remoteGitDir, "fetch", cwd, `${baseHead}:refs/heads/${branch}`]);

    writeFileSync(join(cwd, "local.txt"), "local child\n");
    git(["add", "local.txt"], cwd);
    git(
      [
        "-c",
        "user.name=Keel Fixture",
        "-c",
        "user.email=fixture@keel.invalid",
        "commit",
        "-m",
        "local child",
      ],
      cwd,
    );
    const localHead = git(["rev-parse", "HEAD"], cwd);

    const actor = tempDir("keel-git-push-concurrent-actor-");
    rmSync(actor, { recursive: true, force: true });
    git(["clone", "--branch", branch, fixture.remoteGitDir, actor]);
    writeFileSync(join(actor, "remote.txt"), "concurrent remote child\n");
    git(["add", "remote.txt"], actor);
    git(
      [
        "-c",
        "user.name=Concurrent Actor",
        "-c",
        "user.email=actor@keel.invalid",
        "commit",
        "-m",
        "concurrent remote child",
      ],
      actor,
    );
    git(["push", "origin", `${branch}:refs/heads/${branch}`], actor);
    const remoteHead = git(["rev-parse", "HEAD"], actor);
    expect(remoteHead).not.toBe(localHead);

    const home = tempDir("keel-git-push-nff-home-");
    const auditDir = tempDir("keel-git-push-nff-audit-");
    const env: NodeJS.ProcessEnv = {
      KEEL_HOME: home,
      KEEL_NO_SNAPSHOT: "1",
      USER: PRINCIPAL.osUser,
    };
    const ui = new TestUI();
    const done = runKeelCommand(undefined, {
      model: new ScriptedModel({
        turns: [
          {
            toolCalls: [
              {
                name: "git.push",
                args: { remote: "origin", branch, expectedHead: localHead },
              },
            ],
          },
          { text: "handled rejection" },
        ],
      }),
      ui,
      cwd,
      env,
      trustFlag: true,
      warden: spawnedGitPushWarden({ auditDir, fixture, workspaceRoot: cwd }),
    });

    try {
      ui.queue.push({ kind: "line", text: "attempt the exact non-fast-forward commit" });
      await waitFor(ui, "non-fast-forward git.push approval", (view) => {
        const frame = renderFrame(view);
        return frame.includes("approval required") && frame.includes(localHead);
      });
      expect(fixture.requests).toEqual([]);
      ui.queue.push({ kind: "command", name: "/approve", args: "once" });
      await waitFor(
        ui,
        "non-fast-forward rejection settlement",
        (view) => view.awaitingInput === true && renderFrame(view).includes("handled rejection"),
        35_000,
      );
      ui.queue.push({ kind: "command", name: "/exit" });
      await done;

      expect(git(["--git-dir", fixture.remoteGitDir, "rev-parse", `refs/heads/${branch}`])).toBe(
        remoteHead,
      );
      const sessionId = listSessions(env)[0]!.id;
      const session = readSession(sessionId, env);
      const result = session.events.find(
        (event) => event.type === "tool_result" && event.name === "git.push",
      );
      expect(result).toMatchObject({ type: "tool_result", isError: true });
      if (result?.type !== "tool_result") throw new Error("expected rejected push tool result");
      expect(result.output).toContain('"status":"failed"');
      expect(result.output).toContain('"automaticRetry":false');
      expect(result.output).toContain(remoteHead);
      expect(JSON.stringify(session.events)).not.toContain(FIXTURE_SECRET);
      expect(
        fixture.requests.every((request) => request.authorization === FIXTURE_AUTHORIZATION),
      ).toBe(true);
    } finally {
      ui.queue.push({ kind: "command", name: "/exit" });
      await done.catch(() => undefined);
      await fixture.close();
    }
  }, 60_000);
});
