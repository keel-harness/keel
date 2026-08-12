/**
 * ADR-0091 Slice 5: one exact GitHub PR through the complete product path.
 *
 * The generated Warden entry is test-only and release-withheld. It connects the real Kernel/TUI,
 * spawned Warden, production credential broker, vendored SRT, verified HTTPS, address guard, exact
 * GitHub-style API fixture, durable audit, session receipt, and bundle verifier without admitting a
 * localhost or fixture selector into production code.
 */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSecureContext } from "node:tls";
import { pathToFileURL } from "node:url";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnyAuditRecord,
  supportedGitPushVersion,
  toChainRecords,
  verifyChain,
  type UserInput,
  type ViewModel,
} from "@keel/shared";
import { ScriptedModel } from "@keel/simulator";
import { InputQueue } from "./input-queue.js";
import { closeHttpFixture } from "./http-fixture-lifetime.test-support.js";
import { runAuditExportCommand, runAuditVerifyCommand, runKeelCommand } from "./session-entry.js";
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
const WARDEN_GITHUB_PR_URL = pathToFileURL(
  join(ROOT, "packages/warden/src/github-pr-create.ts"),
).href;
const WARDEN_GIT_CREDENTIAL_BROKER_URL = pathToFileURL(
  join(ROOT, "packages/warden/src/git-credential-broker.ts"),
).href;
const TLS_FIXTURE_DIR = join(ROOT, "vendor/sandbox-runtime/test/fixtures/tls-terminate");
const repository = "keel-harness/keel";
const canonicalRemote = `https://github.com/${repository}.git`;
const principal = {
  osUser: "github-pr-product-test",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
} as const;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(path, 0o700);
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function executable(name: "git" | "curl"): string {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  if (result.status !== 0 || result.stdout.trim() === "") {
    throw new Error(`${name} executable is unavailable`);
  }
  return resolve(result.stdout.trim());
}

function gitVersion(gitExecutable: string): string {
  const result = spawnSync(gitExecutable, ["--version"], { encoding: "utf8" });
  const version = supportedGitPushVersion(result.stdout);
  if (result.status !== 0 || version === undefined) throw new Error("unsupported test Git");
  return version;
}

function curlVersion(curlExecutable: string): string {
  const result = spawnSync(curlExecutable, ["--version"], { encoding: "utf8" });
  const match = /^curl (\d+)\.(\d+)\.(\d+)(?:[ \n]|$)/u.exec(result.stdout);
  if (result.status !== 0 || match === null) throw new Error("unsupported test curl");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!((major === 7 && minor >= 61) || major === 8)) throw new Error("unsupported test curl");
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function git(args: readonly string[], cwd?: string): string {
  const result = spawnSync(executable("git"), [...args], {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"],
      HOME: tempDir("keel-github-pr-product-git-home-"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function createWorkspace(): { readonly cwd: string; readonly base: string; readonly head: string } {
  const cwd = tempDir("keel-github-pr-product-workspace-");
  git(["init", "--initial-branch=main"], cwd);
  writeFileSync(join(cwd, "file.txt"), "base\n");
  git(["add", "file.txt"], cwd);
  git(
    ["-c", "user.name=Keel Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "base"],
    cwd,
  );
  const base = git(["rev-parse", "HEAD"], cwd);
  git(["switch", "-c", "feature/pr-product"], cwd);
  writeFileSync(join(cwd, "file.txt"), "feature\n");
  git(["add", "file.txt"], cwd);
  git(
    ["-c", "user.name=Keel Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "feature"],
    cwd,
  );
  const head = git(["rev-parse", "HEAD"], cwd);
  git(["remote", "add", "origin", canonicalRemote], cwd);
  return { cwd, base, head };
}

interface RequestObservation {
  readonly authorization?: string;
  readonly body: string;
  readonly method?: string;
  readonly url?: string;
}

interface GithubApiFixture {
  readonly origin: string;
  readonly port: number;
  readonly requests: RequestObservation[];
  readonly serverNames: string[];
  acceptedAuthorization(): string | undefined;
  pauseNextAuthenticatedRequest(): { readonly entered: Promise<void>; release(): void };
  close(): Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected HTTPS fixture address"));
        return;
      }
      resolveListen(address.port);
    });
  });
}

async function bodyOf(request: IncomingMessage): Promise<string> {
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
    title: "Ship product path",
    body: "Exact body\n\n- verified",
    draft: false,
    maintainer_can_modify: true,
    head: { ref: "feature/pr-product", sha: head, repo: { full_name: repository } },
    base: { ref: "main", repo: { full_name: repository } },
  };
}

async function startGithubApiFixture(head: string, base: string): Promise<GithubApiFixture> {
  const cert = readFileSync(join(TLS_FIXTURE_DIR, "localhost.crt"), "utf8");
  const key = readFileSync(join(TLS_FIXTURE_DIR, "server.key"), "utf8");
  const secureContext = createSecureContext({ cert, key });
  const requests: RequestObservation[] = [];
  const serverNames: string[] = [];
  let acceptedAuthorization: string | undefined;
  let created = false;
  let pause:
    | { readonly entered: () => void; readonly wait: Promise<void>; readonly release: () => void }
    | undefined;
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
      void (async () => {
        const authorization = request.headers.authorization;
        if (
          authorization === undefined ||
          !authorization.startsWith("Bearer ") ||
          authorization.length <= "Bearer ".length ||
          (acceptedAuthorization !== undefined && authorization !== acceptedAuthorization)
        ) {
          sendJson(response, 401, { message: "authentication required" });
          return;
        }
        acceptedAuthorization ??= authorization;
        const activePause = pause;
        pause = undefined;
        activePause?.entered();
        await activePause?.wait;

        const body = await bodyOf(request);
        requests.push({
          authorization,
          body,
          ...(request.method === undefined ? {} : { method: request.method }),
          ...(request.url === undefined ? {} : { url: request.url }),
        });
        const url = new URL(request.url ?? "/", "https://localhost");
        const refPrefix = `/repos/${repository}/git/ref/`;
        if (request.method === "GET" && url.pathname.startsWith(refPrefix)) {
          const ref = decodeURIComponent(url.pathname.slice(refPrefix.length));
          if (ref === "heads/feature/pr-product") {
            sendJson(response, 200, refBody("feature/pr-product", head));
          } else if (ref === "heads/main") {
            sendJson(response, 200, refBody("main", base));
          } else {
            sendJson(response, 404, { message: "not found" });
          }
          return;
        }
        if (request.method === "GET" && url.pathname === `/repos/${repository}/pulls`) {
          sendJson(response, 200, created ? [prBody(head)] : []);
          return;
        }
        if (request.method === "POST" && url.pathname === `/repos/${repository}/pulls`) {
          expect(JSON.parse(body)).toEqual({
            title: "Ship product path",
            body: "Exact body\n\n- verified",
            head: "feature/pr-product",
            base: "main",
            draft: false,
            maintainer_can_modify: true,
          });
          created = true;
          sendJson(response, 201, prBody(head));
          return;
        }
        sendJson(response, 404, { message: "unexpected request" });
      })().catch(() => response.destroy());
    },
  );
  const port = await listen(server);
  return {
    origin: `https://localhost:${String(port)}`,
    port,
    requests,
    serverNames,
    acceptedAuthorization: () => acceptedAuthorization,
    pauseNextAuthenticatedRequest: () => {
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolveEntered) => {
        entered = resolveEntered;
      });
      let release!: () => void;
      const wait = new Promise<void>((resolveRelease) => {
        release = resolveRelease;
      });
      pause = { entered, wait, release };
      return { entered: enteredPromise, release };
    },
    close: () => closeHttpFixture(server),
  };
}

class TestUI {
  latest: ViewModel | undefined;
  readonly rendered: string[] = [];
  readonly queue = new InputQueue();
  #renderWaiters: { readonly pred: (view: ViewModel) => boolean; readonly resolve: () => void }[] =
    [];

  render(view: ViewModel): void {
    this.latest = view;
    this.rendered.push(JSON.stringify(view));
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

/** Test cleanup must stop an active governed turn and close its input stream. `/exit` alone is
 * deliberately only a notice while a turn is running, so awaiting the session after an earlier
 * assertion/fixture timeout would otherwise mask that useful error until Vitest's outer timeout.
 * The bounded join returns false instead of replacing the test's original, more useful failure. */
async function interruptActiveTurnAndWait(ui: TestUI, done: Promise<unknown>): Promise<boolean> {
  ui.queue.push({ kind: "interrupt" });
  ui.queue.close();
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      done.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), 5_000);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
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
            `timed out waiting for ${label}; latest frame: ${ui.latest === undefined ? "<none>" : renderFrame(ui.latest)}`,
          ),
        );
      }, timeoutMs);
      timeout.unref();
    }),
  ]);
}

/** Keep Warden startup outside the mutation-stage watchdogs. The interactive shell deliberately
 * paints an input-capable `starting-protections` frame before the spawned Warden is ready; queued
 * startup input is covered separately in session-entry.test.ts. These product assertions measure
 * review and credential latency only after the controller reports the governed route ready. */
async function waitForGovernedProductSession(ui: TestUI): Promise<void> {
  await waitFor(
    ui,
    "governed product session readiness",
    (view) =>
      view.awaitingInput === true &&
      view.status.startup === undefined &&
      view.status.protectionRoute === "governed",
    12_000,
  );
}

function spawnedGithubPrWarden(options: {
  readonly auditDir: string;
  readonly fixture: GithubApiFixture;
  readonly workspaceRoot: string;
}): ProductionWardenStartOptions & {
  readonly credentialFixturePaths: readonly string[];
  readonly entryPath: string;
} {
  const entryDir = tempDir("keel-github-pr-product-warden-entry-");
  const entryPath = join(entryDir, "warden.mjs");
  const tempRoot = tempDir("keel-github-pr-product-warden-temp-");
  const authorityRoot = tempDir("keel-github-pr-product-warden-authority-");
  const helperHome = tempDir("keel-github-pr-product-helper-home-");
  const helperPath = join(helperHome, "credential-helper.mjs");
  const helperConfigPath = join(helperHome, ".gitconfig");
  const gitExecutable = executable("git");
  const curlExecutable = executable("curl");
  writeFileSync(
    helperPath,
    `#!/usr/bin/env node
      import { randomBytes } from "node:crypto";
      process.stdin.resume();
      process.stdin.on("end", () => {
        const username = "u-" + randomBytes(12).toString("hex");
        const password = "p-" + randomBytes(32).toString("base64url");
        process.stdout.write("username=" + username + "\\npassword=" + password + "\\n");
      });
    `,
    { mode: 0o700 },
  );
  writeFileSync(
    helperConfigPath,
    `[credential]\n\thelper =\n\thelper = !${process.execPath} ${helperPath}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    entryPath,
    `
      import { rmSync } from "node:fs";
      import { runStdioWardenServer } from ${JSON.stringify(WARDEN_RPC_SERVER_URL)};
      import { SessionAuditLog } from ${JSON.stringify(WARDEN_SESSION_LOG_URL)};
      import { defaultPolicyPackRef } from ${JSON.stringify(WARDEN_POLICY_URL)};
      import { createVendoredSrtSandboxComponents } from ${JSON.stringify(WARDEN_SRT_LOADER_URL)};
      import { createGithubPrCreateWalkingSkeletonAuthority } from ${JSON.stringify(WARDEN_GITHUB_PR_URL)};
      import { createGitCredentialBroker } from ${JSON.stringify(WARDEN_GIT_CREDENTIAL_BROKER_URL)};

      const fixtureApi = ${JSON.stringify({
        origin: options.fixture.origin,
        host: "localhost",
        port: options.fixture.port,
        address: "127.0.0.1",
      })};
      const credentialBroker = createGitCredentialBroker({
        gitExecutable: ${JSON.stringify(gitExecutable)},
        tempRoot: ${JSON.stringify(tempRoot)},
        env: {
          HOME: ${JSON.stringify(helperHome)},
          PATH: ${JSON.stringify(process.env["PATH"] ?? "/usr/bin:/bin")},
          LANG: "C"
        }
      });
      const githubPrCreateAuthority = createGithubPrCreateWalkingSkeletonAuthority({
        advertiseTestCapability: true,
        fixtureApi,
        credentialBroker,
        gitExecutable: ${JSON.stringify(gitExecutable)},
        gitVersion: ${JSON.stringify(gitVersion(gitExecutable))},
        curlExecutable: ${JSON.stringify(curlExecutable)},
        curlVersion: ${JSON.stringify(curlVersion(curlExecutable))},
        tempRoot: ${JSON.stringify(tempRoot)}
      });
      const components = await createVendoredSrtSandboxComponents({
        credentialTlsTermination: true,
        launchAuthorityRegistryPath: ${JSON.stringify(join(authorityRoot, "endpoint-leases.json"))},
        resolveDestination: async (hostname, port) => {
          if (hostname !== fixtureApi.host || port !== fixtureApi.port) {
            throw new Error("fixture resolver refused unbound destination");
          }
          return [{ address: fixtureApi.address, family: 4 }];
        }
      });
      const status = components.sandbox.status();
      if (!status.available) throw new Error(status.reason ?? "real SRT unavailable");
      const checkpointSecretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
      const auditLog = new SessionAuditLog({
        auditDir: ${JSON.stringify(options.auditDir)},
        principal: ${JSON.stringify(principal)},
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
        githubPrCreateAuthority,
        githubPrCreateAddressGuardRevision: "real-test-loopback-address-guard-v1",
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
    credentialFixturePaths: [helperPath, helperConfigPath],
    entryPath,
  };
}

function spawnedAuditExportWarden(options: {
  readonly auditDir: string;
  readonly workspaceRoot: string;
}): ProductionWardenStartOptions {
  const entryDir = tempDir("keel-github-pr-product-export-entry-");
  const entryPath = join(entryDir, "warden.mjs");
  writeFileSync(
    entryPath,
    `
      import { runStdioWardenServer } from ${JSON.stringify(WARDEN_RPC_SERVER_URL)};
      import { SessionAuditLog } from ${JSON.stringify(WARDEN_SESSION_LOG_URL)};
      import { defaultPolicyPackRef } from ${JSON.stringify(WARDEN_POLICY_URL)};
      const checkpointSecretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
      const auditLog = new SessionAuditLog({
        auditDir: ${JSON.stringify(options.auditDir)},
        principal: ${JSON.stringify(principal)},
        policyPack: defaultPolicyPackRef(),
        checkpoint: { secretKey: checkpointSecretKey }
      });
      let closed = false;
      function close() {
        if (closed) return;
        closed = true;
        auditLog.close();
        setImmediate(() => process.exit(0));
      }
      runStdioWardenServer({
        auditWriter: auditLog,
        auditDir: ${JSON.stringify(options.auditDir)},
        workspaceRoot: ${JSON.stringify(options.workspaceRoot)},
        workspaceTrusted: false,
        onShutdown: close
      });
    `,
    { mode: 0o600 },
  );
  return {
    command: process.execPath,
    args: ["--import", TSX_ESM_LOADER, "--conditions=@keel/source", entryPath],
    env: { FORCE_COLOR: "0" },
    requestTimeoutMs: 10_000,
  };
}

function linuxProcessTreeListing(): string {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("could not determine the process owner for /proc inspection");

  const processes = new Map<number, { readonly parentPid: number; readonly uid: number }>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/u.test(name)) continue;
    let status: string;
    try {
      status = readFileSync(join("/proc", name, "status"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const parent = /^PPid:\s+(\d+)$/mu.exec(status);
    const owner = /^Uid:\s+(\d+)/mu.exec(status);
    if (parent === null || owner === null) {
      throw new Error(`could not parse /proc/${name}/status`);
    }
    processes.set(Number(name), {
      parentPid: Number(parent[1]),
      uid: Number(owner[1]),
    });
  }

  const descendantPids = new Set([process.pid]);
  let foundDescendant = true;
  while (foundDescendant) {
    foundDescendant = false;
    for (const [pid, processStatus] of processes) {
      if (descendantPids.has(pid) || !descendantPids.has(processStatus.parentPid)) continue;
      descendantPids.add(pid);
      foundDescendant = true;
    }
  }

  const chunks: Buffer[] = [];
  let byteLength = 0;
  for (const pid of [...descendantPids].sort((left, right) => left - right)) {
    const processStatus = processes.get(pid);
    if (processStatus !== undefined && processStatus.uid !== uid) {
      throw new Error(`descendant process ${String(pid)} changed owner before inspection`);
    }
    for (const field of ["cmdline", "environ"] as const) {
      let contents: Buffer;
      try {
        contents = readFileSync(join("/proc", String(pid), field));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error(
          `could not inspect /proc/${String(pid)}/${field}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      byteLength += contents.length;
      if (byteLength > 8 * 1024 * 1024) {
        throw new Error("live process tree exceeded the bounded 8 MiB inspection limit");
      }
      chunks.push(contents);
    }
  }
  return Buffer.concat(chunks).toString("latin1");
}

function processListing(): string {
  if (process.platform === "linux") return linuxProcessTreeListing();
  const result = spawnSync("/bin/ps", ["eww", "-ax", "-o", "command="], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 5_000,
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(`could not inspect live processes: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}

function expectSecretAbsent(value: string, secret: string): void {
  expect(value).not.toContain(secret);
}

function expectSecretAbsentFromTree(root: string, secret: string): void {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) expectSecretAbsentFromTree(path, secret);
    else if (stat.isFile()) expectSecretAbsent(readFileSync(path).toString("latin1"), secret);
  }
}

suite("ADR-0091 github.pr.create complete product path (real sandbox)", () => {
  it("creates one exact PR through model projection, TUI review, spawned Warden, and verified HTTPS", async () => {
    const source = createWorkspace();
    const fixture = await startGithubApiFixture(source.head, source.base);
    const home = tempDir("keel-github-pr-product-home-");
    const auditDir = tempDir("keel-github-pr-product-audit-");
    const env: NodeJS.ProcessEnv = {
      KEEL_HOME: home,
      KEEL_NO_SNAPSHOT: "1",
      USER: principal.osUser,
    };
    const ui = new TestUI();
    const warden = spawnedGithubPrWarden({ auditDir, fixture, workspaceRoot: source.cwd });
    const done = runKeelCommand(undefined, {
      model: new ScriptedModel({
        turns: [
          {
            toolCalls: [
              {
                name: "github.pr.create",
                args: {
                  remote: "origin",
                  repository,
                  head: "feature/pr-product",
                  expectedHead: source.head,
                  base: "main",
                  title: "Ship product path",
                  body: "Exact body\n\n- verified",
                  draft: false,
                  maintainerCanModify: true,
                },
              },
            ],
          },
          { text: "created PR" },
        ],
      }),
      ui,
      cwd: source.cwd,
      env,
      trustFlag: true,
      warden,
    });

    try {
      await waitForGovernedProductSession(ui);
      ui.queue.push({ kind: "line", text: "create the exact pull request" });
      await waitFor(ui, "lossless github.pr.create approval", (view) => {
        const frame = renderFrame(view);
        return (
          frame.includes("GitHub pull request creation requires approval") &&
          frame.includes(repository) &&
          frame.includes(source.head) &&
          frame.includes('Title JSON: "Ship product path"') &&
          frame.includes('Body JSON: "Exact body\\n\\n- verified"')
        );
      });
      const approvalFrame = renderFrame(ui.latest!);
      expect(approvalFrame).toContain("trigger repository notifications");
      expect(approvalFrame).toContain("this occurrence once");
      expect(fixture.requests).toEqual([]);

      const credentialWindow = fixture.pauseNextAuthenticatedRequest();
      ui.queue.push({ kind: "command", name: "/approve", args: "once" });
      try {
        await Promise.race([
          credentialWindow.entered,
          new Promise<never>((_, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("timed out waiting for credential-bearing curl")),
              8_000,
            );
            timeout.unref();
          }),
        ]);
        const authorization = fixture.acceptedAuthorization();
        if (authorization === undefined) throw new Error("fixture observed no Bearer credential");
        expectSecretAbsent(processListing(), authorization.slice("Bearer ".length));
      } finally {
        credentialWindow.release();
      }

      await waitFor(
        ui,
        "verified github.pr.create completion",
        (view) => view.awaitingInput === true && renderFrame(view).includes("created PR"),
        35_000,
      );
      ui.queue.push({ kind: "command", name: "/exit" });
      await done;

      const authorization = fixture.acceptedAuthorization();
      if (authorization === undefined) throw new Error("fixture retained no Bearer credential");
      const secret = authorization.slice("Bearer ".length);
      expect(fixture.requests).toHaveLength(5);
      expect(fixture.requests.map((request) => request.method)).toEqual([
        "GET",
        "GET",
        "GET",
        "POST",
        "GET",
      ]);
      expect(fixture.requests.every((request) => request.authorization === authorization)).toBe(
        true,
      );
      expect(fixture.serverNames).toEqual(Array(5).fill("localhost"));

      const sessionId = listSessions(env)[0]?.id;
      if (sessionId === undefined) throw new Error("product session was not persisted");
      const session = readSession(sessionId, env);
      const toolResult = session.events.find(
        (event) => event.type === "tool_result" && event.name === "github.pr.create",
      );
      if (toolResult?.type !== "tool_result") throw new Error("expected PR tool result");
      expect(toolResult.isError).not.toBe(true);
      expect(toolResult.output).toContain('"status":"created"');
      expect(toolResult.output).toContain(`https://github.com/${repository}/pull/42`);
      expectSecretAbsent(JSON.stringify(session.events), secret);
      expectSecretAbsent(ui.rendered.join("\n"), secret);

      const auditText = readFileSync(join(auditDir, `${sessionId}.jsonl`), "utf8");
      expectSecretAbsent(auditText, secret);
      const records = auditText
        .trim()
        .split("\n")
        .map((line) => AnyAuditRecord.parse(JSON.parse(line)));
      expect(verifyChain(toChainRecords(records)).ok).toBe(true);
      expect(
        records.some(
          (record) =>
            record.eventType === "tool.execute" &&
            record.payload["toolName"] === "github.pr.create" &&
            record.payload["execution"] === "requested",
        ),
      ).toBe(true);
      expect(
        records.some(
          (record) =>
            record.eventType === "tool.execute" &&
            record.payload["toolName"] === "github.pr.create" &&
            (record.payload["result"] as { readonly status?: string } | undefined)?.status ===
              "created",
        ),
      ).toBe(true);
      for (const path of [warden.entryPath, ...warden.credentialFixturePaths]) {
        expectSecretAbsent(readFileSync(path, "utf8"), secret);
      }
      expectSecretAbsentFromTree(source.cwd, secret);

      const exportDir = tempDir("keel-github-pr-product-export-");
      const exportMessage = await runAuditExportCommand({
        sessionId,
        cwd: source.cwd,
        outPath: exportDir,
        env,
        warden: spawnedAuditExportWarden({ auditDir, workspaceRoot: source.cwd }),
      });
      expect(exportMessage).toContain("exported audit bundle:");
      const bundlePath = join(exportDir, `bundle_${sessionId}`);
      expect(runAuditVerifyCommand({ bundlePath })).toContain("verified audit bundle:");
      expectSecretAbsentFromTree(bundlePath, secret);
    } finally {
      await interruptActiveTurnAndWait(ui, done);
      await fixture.close();
    }
  }, 60_000);

  it("interrupts an approved in-flight request before test cleanup waits for the session", async () => {
    const source = createWorkspace();
    const fixture = await startGithubApiFixture(source.head, source.base);
    const home = tempDir("keel-github-pr-interrupt-home-");
    const auditDir = tempDir("keel-github-pr-interrupt-audit-");
    const env: NodeJS.ProcessEnv = {
      KEEL_HOME: home,
      KEEL_NO_SNAPSHOT: "1",
      USER: principal.osUser,
    };
    const ui = new TestUI();
    const done = runKeelCommand(undefined, {
      model: new ScriptedModel({
        turns: [
          {
            toolCalls: [
              {
                name: "github.pr.create",
                args: {
                  remote: "origin",
                  repository,
                  head: "feature/pr-product",
                  expectedHead: source.head,
                  base: "main",
                  title: "Ship product path",
                  body: "Exact body\n\n- verified",
                  draft: false,
                  maintainerCanModify: true,
                },
              },
            ],
          },
        ],
      }),
      ui,
      cwd: source.cwd,
      env,
      trustFlag: true,
      warden: spawnedGithubPrWarden({ auditDir, fixture, workspaceRoot: source.cwd }),
    });
    const credentialWindow = fixture.pauseNextAuthenticatedRequest();

    try {
      await waitForGovernedProductSession(ui);
      ui.queue.push({ kind: "line", text: "create the exact pull request" });
      await waitFor(ui, "interrupt regression approval", (view) =>
        renderFrame(view).includes("GitHub pull request creation requires approval"),
      );
      ui.queue.push({ kind: "command", name: "/approve", args: "once" });
      await Promise.race([
        credentialWindow.entered,
        new Promise<never>((_, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("timed out entering interrupt regression credential window")),
            8_000,
          );
          timeout.unref();
        }),
      ]);

      expect(await interruptActiveTurnAndWait(ui, done)).toBe(true);
      await expect(done).resolves.toMatchObject({ lastStop: "aborted" });
      expect(fixture.requests).toEqual([]);
    } finally {
      credentialWindow.release();
      await interruptActiveTurnAndWait(ui, done);
      await fixture.close();
    }
  }, 20_000);
});
