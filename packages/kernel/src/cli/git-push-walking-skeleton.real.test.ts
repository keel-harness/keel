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
const WARDEN_GIT_PUSH_URL = pathToFileURL(join(ROOT, "packages/warden/src/git-push.ts")).href;
const WARDEN_GIT_CREDENTIAL_BROKER_URL = pathToFileURL(
  join(ROOT, "packages/warden/src/git-credential-broker.ts"),
).href;
const TLS_FIXTURE_DIR = join(ROOT, "vendor/sandbox-runtime/test/fixtures/tls-terminate");
const PRINCIPAL = {
  osUser: "git-push-product-test",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
} as const;
// The spawned Warden and per-launch SRT may take longer than the former 8-second observation
// window on a loaded supported runtime. Keep this bounded below the 50-second RPC deadline and
// reuse it for the subsequent product-settlement observation.
const PRODUCT_SETTLEMENT_TIMEOUT_MS = 35_000;

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

function unrelatedRemoteRefs(remoteGitDir: string, destinationRef: string): string {
  return git([
    "--git-dir",
    remoteGitDir,
    "for-each-ref",
    "--format=%(refname)%09%(objectname)%09%(objecttype)",
    "refs",
  ])
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith(`${destinationRef}\t`))
    .join("\n");
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
  acceptedAuthorization(): string | undefined;
  pauseNextAuthenticatedRequest(): {
    readonly entered: Promise<void>;
    release(): void;
  };
  close(): Promise<void>;
}

interface ObservedCredential {
  readonly authorization: string;
  readonly encoded: string;
  readonly username: string;
  readonly password: string;
}

function parseBasicAuthorization(value: string | undefined): ObservedCredential | undefined {
  if (value === undefined || !value.startsWith("Basic ")) return undefined;
  const encoded = value.slice("Basic ".length);
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf(":");
  if (separator <= 0 || separator === decoded.length - 1) return undefined;
  return {
    authorization: value,
    encoded,
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

function observedCredential(fixture: SmartGitFixture): ObservedCredential {
  const credential = parseBasicAuthorization(fixture.acceptedAuthorization());
  if (credential === undefined) throw new Error("fixture observed no valid Basic credential");
  return credential;
}

function expectCredentialAbsent(value: string, credential: ObservedCredential): void {
  for (const canary of [
    credential.authorization,
    credential.encoded,
    credential.username,
    credential.password,
  ]) {
    expect(value).not.toContain(canary);
  }
}

function expectCredentialAbsentFromTree(root: string, credential: ObservedCredential): void {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      expectCredentialAbsentFromTree(path, credential);
    } else if (stat.isFile()) {
      expectCredentialAbsent(readFileSync(path).toString("latin1"), credential);
    }
  }
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
    throw new Error(
      `could not inspect the live process listing: ${result.error?.message ?? result.stderr}`,
    );
  }
  return result.stdout;
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
  remoteUser: string,
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
      REMOTE_USER: remoteUser,
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
  const seed = join(projectRoot, "seed");
  git(["init", "--initial-branch=main", seed]);
  writeFileSync(join(seed, "README.md"), "# governed upstream fixture\n");
  git(["add", "README.md"], seed);
  git(
    [
      "-c",
      "user.name=Keel Fixture",
      "-c",
      "user.email=fixture@keel.invalid",
      "commit",
      "-m",
      "seed governed upstream default branch",
    ],
    seed,
  );
  git(["--git-dir", remoteGitDir, "fetch", seed, "HEAD:refs/heads/main"]);
  git(["--git-dir", remoteGitDir, "symbolic-ref", "HEAD", "refs/heads/main"]);
  git(["--git-dir", remoteGitDir, "config", "http.receivepack", "true"]);
  const requests: GitRequestObservation[] = [];
  const serverNames: string[] = [];
  let acceptedAuthorization: string | undefined;
  let pause:
    | {
        readonly entered: () => void;
        readonly wait: Promise<void>;
        readonly release: () => void;
      }
    | undefined;
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
      const credential = parseBasicAuthorization(request.headers.authorization);
      if (
        credential === undefined ||
        (acceptedAuthorization !== undefined && credential.authorization !== acceptedAuthorization)
      ) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="keel-git-fixture"' });
        response.end("authentication required");
        return;
      }
      acceptedAuthorization ??= credential.authorization;
      const activePause = pause;
      pause = undefined;
      activePause?.entered();
      void (async () => {
        await activePause?.wait;
        await serveGitRequest(request, response, projectRoot, credential.username);
      })().catch((error: unknown) => {
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

/** Keep Warden startup outside mutation-stage watchdogs. The session is ready for governed
 * publication work only after protection startup has settled and the controller is accepting
 * input on the governed route. */
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
}): ProductionWardenStartOptions & {
  readonly credentialFixturePaths: readonly string[];
  readonly entryPath: string;
} {
  const entryDir = tempDir("keel-git-push-warden-entry-");
  const entryPath = join(entryDir, "warden.mjs");
  const tempRoot = tempDir("keel-git-push-warden-temp-");
  const authorityRoot = tempDir("keel-git-push-warden-authority-");
  const helperHome = tempDir("keel-git-push-helper-home-");
  const helperPath = join(helperHome, "credential-helper");
  const helperConfigPath = join(helperHome, ".gitconfig");
  const helperCredentialPath = join(helperHome, "credential-store");
  const gitExecutable = resolve(spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim());
  writeFileSync(
    helperCredentialPath,
    `username=u-${randomBytes(12).toString("hex")}\npassword=p-${randomBytes(32).toString("base64url")}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    helperPath,
    `#!/bin/sh
while IFS= read -r line; do [ -z "$line" ] && break; done
/bin/cat "$HOME/credential-store"
`,
    { mode: 0o700 },
  );
  writeFileSync(helperConfigPath, `[credential]\n\thelper =\n\thelper = !${helperPath}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    entryPath,
    `
      import { rmSync } from "node:fs";
      import { runStdioWardenServer } from ${JSON.stringify(WARDEN_RPC_SERVER_URL)};
      import { SessionAuditLog } from ${JSON.stringify(WARDEN_SESSION_LOG_URL)};
      import { defaultPolicyPackRef } from ${JSON.stringify(WARDEN_POLICY_URL)};
      import { createVendoredSrtSandboxComponents } from ${JSON.stringify(WARDEN_SRT_LOADER_URL)};
      import { createGitPushWalkingSkeletonAuthority } from ${JSON.stringify(WARDEN_GIT_PUSH_URL)};
      import { createGitCredentialBroker } from ${JSON.stringify(WARDEN_GIT_CREDENTIAL_BROKER_URL)};

      const fixtureTransport = ${JSON.stringify({
        canonicalUrl: options.fixture.canonicalUrl,
        host: "localhost",
        port: options.fixture.port,
        address: "127.0.0.1",
      })};
      const credentialBroker = createGitCredentialBroker({
        gitExecutable: ${JSON.stringify(gitExecutable)},
        tempRoot: ${JSON.stringify(tempRoot)},
        workspaceRoot: ${JSON.stringify(options.workspaceRoot)},
        denyRoots: [${JSON.stringify(authorityRoot)}],
        env: {
          HOME: ${JSON.stringify(helperHome)},
          PATH: ${JSON.stringify(process.env["PATH"] ?? "/usr/bin:/bin")},
          LANG: "C"
        }
      });
      const fixture = {
        ...fixtureTransport,
        credentialSourceClass: "operator-git-credential-helper",
        credentialBroker
      };
      const gitPushAuthority = createGitPushWalkingSkeletonAuthority({
        advertiseTestCapability: true,
        fixture,
        gitExecutable: ${JSON.stringify(gitExecutable)},
        tempRoot: ${JSON.stringify(tempRoot)}
      });
      const components = await createVendoredSrtSandboxComponents({
        credentialTlsTermination:
          gitPushAuthority.transportRequirements.credentialTlsTermination,
        launchAuthorityRegistryPath: ${JSON.stringify(join(authorityRoot, "endpoint-leases.json"))},
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
        gitPushAuthority,
        gitPushAddressGuardRevision: "real-test-loopback-address-guard-v1",
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
  const entryDir = tempDir("keel-git-push-export-warden-entry-");
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
        principal: ${JSON.stringify(PRINCIPAL)},
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
    const destinationRef = `refs/heads/${branch}`;
    const unrelatedRefsBefore = unrelatedRemoteRefs(fixture.remoteGitDir, destinationRef);
    const env: NodeJS.ProcessEnv = {
      KEEL_HOME: home,
      KEEL_NO_SNAPSHOT: "1",
      USER: PRINCIPAL.osUser,
    };
    const ui = new TestUI();
    const warden = spawnedGitPushWarden({ auditDir, fixture, workspaceRoot: cwd });
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
      warden,
    });

    try {
      await waitForGovernedProductSession(ui);
      ui.queue.push({ kind: "line", text: "publish the exact commit" });
      await waitFor(
        ui,
        "lossless git.push approval",
        (view) => {
          const frame = renderFrame(view);
          return (
            frame.includes("approval required") &&
            frame.includes(fixture.canonicalUrl) &&
            frame.includes(branch) &&
            frame.includes(head)
          );
        },
        PRODUCT_SETTLEMENT_TIMEOUT_MS,
      );
      const approvalFrame = renderFrame(ui.latest!);
      expect(approvalFrame).toContain("create this branch or fast-forward it to this commit");
      expect(approvalFrame).toContain("this occurrence once");
      expect(approvalFrame).toContain("operator Git credential helper (system/global config)");
      expect(fixture.requests).toEqual([]);

      const liveCredentialWindow = fixture.pauseNextAuthenticatedRequest();
      ui.queue.push({ kind: "command", name: "/approve", args: "once" });
      let liveProcessListing: string;
      let credentialProcessTimeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          liveCredentialWindow.entered,
          new Promise<never>((_, reject) => {
            credentialProcessTimeout = setTimeout(
              () => reject(new Error("timed out waiting for credential-bearing Git process")),
              PRODUCT_SETTLEMENT_TIMEOUT_MS,
            );
            credentialProcessTimeout.unref();
          }),
        ]);
        liveProcessListing = processListing();
      } finally {
        if (credentialProcessTimeout !== undefined) clearTimeout(credentialProcessTimeout);
        liveCredentialWindow.release();
      }
      expect(liveProcessListing).toContain(warden.entryPath);
      expectCredentialAbsent(liveProcessListing, observedCredential(fixture));
      try {
        await Promise.race([
          waitFor(
            ui,
            "verified git.push completion",
            (view) => view.awaitingInput === true && renderFrame(view).includes("published"),
            PRODUCT_SETTLEMENT_TIMEOUT_MS,
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

      expect(git(["--git-dir", fixture.remoteGitDir, "rev-parse", destinationRef])).toBe(head);
      expect(unrelatedRemoteRefs(fixture.remoteGitDir, destinationRef)).toBe(unrelatedRefsBefore);
      expect(fixture.requests.length).toBeGreaterThanOrEqual(3);
      const credential = observedCredential(fixture);
      expect(
        fixture.requests.every((request) => request.authorization === credential.authorization),
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
      expectCredentialAbsent(JSON.stringify(session.events), credential);
      expectCredentialAbsent(ui.rendered.join("\n"), credential);

      const auditPath = join(auditDir, `${sessionId}.jsonl`);
      const auditText = readFileSync(auditPath, "utf8");
      expectCredentialAbsent(auditText, credential);
      for (const path of [warden.entryPath, ...warden.credentialFixturePaths]) {
        expectCredentialAbsent(readFileSync(path, "utf8"), credential);
      }
      expectCredentialAbsentFromTree(cwd, credential);
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

      const exportDir = tempDir("keel-git-push-export-");
      // Audit export does not need network, credential, Git, or sandbox authority. Keeping this
      // second process audit-only proves the retained bundle without adding an unrelated SRT
      // listener lifecycle to the credential-custody assertion.
      const exportWarden = spawnedAuditExportWarden({ auditDir, workspaceRoot: cwd });
      const exportMessage = await runAuditExportCommand({
        sessionId,
        cwd,
        outPath: exportDir,
        env,
        warden: exportWarden,
      });
      expect(exportMessage).toContain("exported audit bundle:");
      const bundlePath = join(exportDir, `bundle_${sessionId}`);
      expect(runAuditVerifyCommand({ bundlePath })).toContain("verified audit bundle:");
      expectCredentialAbsentFromTree(bundlePath, credential);
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
      await interruptActiveTurnAndWait(ui, done);
      await fixture.close();
    }
  }, 60_000);

  it("fast-forwards one existing feature branch to the separately approved exact commit", async () => {
    const fixture = await startSmartGitFixture();
    const { cwd, head: baseHead } = createWorkspace(fixture.canonicalUrl);
    const branch = "feature/fast-forward";
    const destinationRef = `refs/heads/${branch}`;
    git(["--git-dir", fixture.remoteGitDir, "fetch", cwd, `${baseHead}:${destinationRef}`]);
    const unrelatedRefsBefore = unrelatedRemoteRefs(fixture.remoteGitDir, destinationRef);
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
    const warden = spawnedGitPushWarden({ auditDir, fixture, workspaceRoot: cwd });
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
      warden,
    });

    try {
      await waitForGovernedProductSession(ui);
      ui.queue.push({ kind: "line", text: "publish the fast-forward commit" });
      await waitFor(
        ui,
        "fast-forward git.push approval",
        (view) => {
          const frame = renderFrame(view);
          return (
            frame.includes("approval required") &&
            frame.includes(fixture.canonicalUrl) &&
            frame.includes(branch) &&
            frame.includes(head)
          );
        },
        PRODUCT_SETTLEMENT_TIMEOUT_MS,
      );
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

      expect(git(["--git-dir", fixture.remoteGitDir, "rev-parse", destinationRef])).toBe(head);
      expect(unrelatedRemoteRefs(fixture.remoteGitDir, destinationRef)).toBe(unrelatedRefsBefore);
      expect(git(["merge-base", "--is-ancestor", baseHead, head], cwd)).toBe("");
      const credential = observedCredential(fixture);
      expect(
        fixture.requests.every((request) => request.authorization === credential.authorization),
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
      expectCredentialAbsent(JSON.stringify(session.events), credential);
      expectCredentialAbsent(
        readFileSync(join(auditDir, `${sessionId}.jsonl`), "utf8"),
        credential,
      );
    } finally {
      await interruptActiveTurnAndWait(ui, done);
      await fixture.close();
    }
  }, 60_000);

  it("reports a real concurrent non-fast-forward rejection and leaves the remote tip unchanged", async () => {
    const fixture = await startSmartGitFixture();
    const { cwd, head: baseHead } = createWorkspace(fixture.canonicalUrl);
    const branch = "feature/non-fast-forward";
    const destinationRef = `refs/heads/${branch}`;
    git(["--git-dir", fixture.remoteGitDir, "fetch", cwd, `${baseHead}:${destinationRef}`]);
    const unrelatedRefsBefore = unrelatedRemoteRefs(fixture.remoteGitDir, destinationRef);

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
    const warden = spawnedGitPushWarden({ auditDir, fixture, workspaceRoot: cwd });
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
      warden,
    });

    try {
      await waitForGovernedProductSession(ui);
      ui.queue.push({ kind: "line", text: "attempt the exact non-fast-forward commit" });
      await waitFor(
        ui,
        "non-fast-forward git.push approval",
        (view) => {
          const frame = renderFrame(view);
          return frame.includes("approval required") && frame.includes(localHead);
        },
        PRODUCT_SETTLEMENT_TIMEOUT_MS,
      );
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

      expect(git(["--git-dir", fixture.remoteGitDir, "rev-parse", destinationRef])).toBe(
        remoteHead,
      );
      expect(unrelatedRemoteRefs(fixture.remoteGitDir, destinationRef)).toBe(unrelatedRefsBefore);
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
      const credential = observedCredential(fixture);
      expectCredentialAbsent(JSON.stringify(session.events), credential);
      expect(
        fixture.requests.every((request) => request.authorization === credential.authorization),
      ).toBe(true);
    } finally {
      await interruptActiveTurnAndWait(ui, done);
      await fixture.close();
    }
  }, 60_000);

  it("reports one real protected-branch rejection without changing any remote ref", async () => {
    const fixture = await startSmartGitFixture();
    const { cwd, head } = createWorkspace(fixture.canonicalUrl);
    const branch = "feature/protected";
    const destinationRef = `refs/heads/${branch}`;
    const unrelatedRefsBefore = unrelatedRemoteRefs(fixture.remoteGitDir, destinationRef);
    const updateHook = join(fixture.remoteGitDir, "hooks", "update");
    writeFileSync(
      updateHook,
      `#!/bin/sh
if [ "$1" = ${JSON.stringify(destinationRef)} ]; then
  printf '%s\n' 'protected by server policy' >&2
  exit 1
fi
exit 0
`,
      { mode: 0o700 },
    );
    chmodSync(updateHook, 0o700);

    const home = tempDir("keel-git-push-protected-home-");
    const auditDir = tempDir("keel-git-push-protected-audit-");
    const env: NodeJS.ProcessEnv = {
      KEEL_HOME: home,
      KEEL_NO_SNAPSHOT: "1",
      USER: PRINCIPAL.osUser,
    };
    const ui = new TestUI();
    const warden = spawnedGitPushWarden({ auditDir, fixture, workspaceRoot: cwd });
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
          { text: "handled protected branch" },
        ],
      }),
      ui,
      cwd,
      env,
      trustFlag: true,
      warden,
    });

    try {
      await waitForGovernedProductSession(ui);
      ui.queue.push({ kind: "line", text: "attempt the protected branch" });
      await waitFor(
        ui,
        "protected-branch git.push approval",
        (view) => {
          const frame = renderFrame(view);
          return frame.includes("approval required") && frame.includes(head);
        },
        PRODUCT_SETTLEMENT_TIMEOUT_MS,
      );
      expect(fixture.requests).toEqual([]);
      ui.queue.push({ kind: "command", name: "/approve", args: "once" });
      await waitFor(
        ui,
        "protected-branch rejection settlement",
        (view) =>
          view.awaitingInput === true && renderFrame(view).includes("handled protected branch"),
        35_000,
      );
      ui.queue.push({ kind: "command", name: "/exit" });
      await done;

      expect(
        git([
          "--git-dir",
          fixture.remoteGitDir,
          "for-each-ref",
          "--format=%(objectname)",
          destinationRef,
        ]),
      ).toBe("");
      expect(unrelatedRemoteRefs(fixture.remoteGitDir, destinationRef)).toBe(unrelatedRefsBefore);
      expect(
        fixture.requests.filter(
          (request) =>
            request.method === "POST" && request.url?.endsWith("/git-receive-pack") === true,
        ),
      ).toHaveLength(1);

      const credential = observedCredential(fixture);
      expect(
        fixture.requests.every((request) => request.authorization === credential.authorization),
      ).toBe(true);
      const sessionId = listSessions(env)[0]!.id;
      const session = readSession(sessionId, env);
      const result = session.events.find(
        (event) => event.type === "tool_result" && event.name === "git.push",
      );
      expect(result).toMatchObject({ type: "tool_result", isError: true });
      if (result?.type !== "tool_result") {
        throw new Error("expected protected-branch git.push tool result");
      }
      expect(result.output).toContain('"status":"failed"');
      expect(result.output).toContain('"automaticRetry":false');
      expect(result.output).toContain('"actionMayHaveExecuted":false');
      expectCredentialAbsent(JSON.stringify(session.events), credential);
      expectCredentialAbsent(ui.rendered.join("\n"), credential);

      const auditText = readFileSync(join(auditDir, `${sessionId}.jsonl`), "utf8");
      expectCredentialAbsent(auditText, credential);
      const records = auditText
        .trim()
        .split("\n")
        .map((line) => AnyAuditRecord.parse(JSON.parse(line)));
      expect(verifyChain(toChainRecords(records)).ok).toBe(true);
    } finally {
      await interruptActiveTurnAndWait(ui, done);
      await fixture.close();
    }
  }, 60_000);
});
