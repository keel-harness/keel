#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const modeOrCarrier = process.argv[2];
const compiledCarrier = modeOrCarrier === "--compiled";
const keelArg = compiledCarrier ? process.argv[3] : modeOrCarrier;
assert.ok(
  keelArg,
  "usage: node smoke-egress-address-guard-carrier.mjs [--compiled] <absolute-keel-bin>",
);
const keelBin = resolve(keelArg);
assert.ok(isAbsolute(keelBin), "installed keel bin must resolve to an absolute path");
assert.ok(existsSync(keelBin), `installed keel bin is missing: ${keelBin}`);

const HARD_DENY_HOST = "carrier-hard-deny.example";
const PUBLIC_HOST = "carrier-public.example";
const EXCEPTION_HOST = "carrier-exception.example";
const PUBLIC_ADDRESS = process.env.KEEL_EGRESS_CARRIER_PUBLIC_ADDRESS ?? "93.184.216.34";
const RESTRICTED_ADDRESS = process.env.KEEL_EGRESS_CARRIER_RESTRICTED_ADDRESS ?? "192.0.2.10";
const RPC_TIMEOUT_MS = 20_000;
const PRINCIPAL = {
  osUser: "carrier-product-matrix",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
};

function installedPackageRoot(bin) {
  const entry = realpathSync(bin);
  assert.equal(dirname(entry).split("/").at(-1), "bin", `unexpected installed bin path: ${entry}`);
  return dirname(dirname(entry));
}

function listen(address, marker) {
  let hits = 0;
  const hosts = [];
  const server = createServer((request, response) => {
    hits += 1;
    hosts.push(request.headers.host ?? "");
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(marker);
  });
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, address, () => {
      server.removeListener("error", reject);
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        reject(new Error(`expected TCP address for ${marker}`));
        return;
      }
      resolveListen({
        server,
        port: bound.port,
        hits: () => hits,
        hosts: () => [...hosts],
      });
    });
  });
}

function closeServer(fixture) {
  return new Promise((resolveClose, reject) => {
    fixture.server.close((error) => {
      if (error === undefined) resolveClose();
      else reject(error);
    });
  });
}

class WardenHarness {
  constructor(command, args, options) {
    this.stderr = "";
    this.lines = [];
    this.waiters = [];
    this.child = spawn(command, args, {
      cwd: options.workspace,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        HOME: options.home,
        KEEL_HOME: options.keelHome,
        KEEL_WARDEN_AUDIT_DIR: options.auditDir,
        KEEL_WARDEN_SANDBOX: "srt",
        KEEL_WARDEN_WORKSPACE_ROOT: options.workspace,
        KEEL_WARDEN_WORKSPACE_TRUSTED: "1",
        ...(options.compiled ? { KEEL_INTERNAL_WARDEN_STDIO: "1" } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    let pending = "";
    this.child.stdout.on("data", (chunk) => {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const waiter = this.waiters.shift();
        if (waiter === undefined) this.lines.push(line);
        else waiter(line);
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_192);
    });
  }

  send(method, id, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  }

  readLine() {
    const available = this.lines.shift();
    if (available !== undefined) return Promise.resolve(available);
    return new Promise((resolveLine, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for installed warden; stderr=${this.stderr}`));
      }, RPC_TIMEOUT_MS);
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolveLine(line);
      });
    });
  }

  async result(method, id, params = {}) {
    this.send(method, id, params);
    const frame = JSON.parse(await this.readLine());
    assert.equal(frame.jsonrpc, "2.0");
    assert.equal(frame.id, id);
    if (frame.error !== undefined) {
      throw new Error(`installed warden ${method} failed: ${JSON.stringify(frame.error)}`);
    }
    return frame.result;
  }

  async stop() {
    if (this.child.exitCode !== null) return;
    try {
      await this.result("warden.shutdown", "carrier-shutdown");
    } finally {
      this.child.stdin.end();
      if (this.child.exitCode === null) {
        const closed = new Promise((resolveClose) => this.child.once("close", resolveClose));
        this.child.kill();
        await closed;
      }
    }
  }
}

function curlCommand(host, port, path) {
  return [
    "curl",
    "-sS",
    "--noproxy",
    "''",
    "--max-time",
    "10",
    "--output",
    "/dev/null",
    "--write-out",
    "%{http_code}",
    `http://${host}:${String(port)}/${path}`,
  ].join(" ");
}

async function executeWithOneShotReview(warden, id, host, port, path) {
  const requested = await warden.result("warden.execute", `${id}-request`, {
    sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    toolCall: {
      id: `tc_${id}`,
      name: "bash",
      args: { command: curlCommand(host, port, path) },
    },
    provenanceContext: { inputTags: ["workspace"] },
  });
  assert.equal(requested.verdict, "review", `${id} must require an explicit egress review`);
  const allowCommand = requested.review?.allowCommand;
  assert.equal(typeof allowCommand, "string", `${id} review approval command is missing`);
  assert.ok(
    allowCommand.endsWith(`--scope once --domain ${host}`),
    `${id} did not return the exact public egress-review contract: ${JSON.stringify(requested)}`,
  );
  assert.ok(
    requested.review?.summary?.includes(host),
    `${id} review summary omitted the exact requested host`,
  );
  assert.ok(requested.review?.reviewId, `${id} review id is missing`);

  const approved = await warden.result("warden.resolveReview", `${id}-approve`, {
    reviewId: requested.review.reviewId,
    approved: true,
    scope: "once",
    principal: PRINCIPAL,
  });
  assert.equal(approved.verdict, "allow", `${id} policy approval did not reach the sandbox`);
  assert.equal(approved.result?.exitCode, 0, `${id} curl failed: ${JSON.stringify(approved)}`);
  return approved.result;
}

function loadAuditRecords(auditDir) {
  return readdirSync(auditDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) =>
      readFileSync(join(auditDir, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
}

const wardenEntry = compiledCarrier
  ? keelBin
  : join(installedPackageRoot(keelBin), "bin", "keel-warden.mjs");
assert.ok(existsSync(wardenEntry), `carrier warden entry is missing: ${wardenEntry}`);

const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-egress-carrier-")));
const workspace = join(root, "workspace");
const home = join(root, "home");
const keelHome = join(root, "keel-home");
const auditDir = join(keelHome, "audit");
mkdirSync(workspace, { mode: 0o700 });
mkdirSync(home, { mode: 0o700 });
mkdirSync(keelHome, { mode: 0o700 });
chmodSync(keelHome, 0o700);
const workspaceRealpath = realpathSync(workspace);

const fixtures = [];
let warden;
try {
  const hardDenied = await listen("127.0.0.1", "hard-deny-should-not-arrive");
  fixtures.push(hardDenied);
  const publicAllowed = await listen(PUBLIC_ADDRESS, "public-carrier-ok");
  fixtures.push(publicAllowed);
  const exceptionAllowed = await listen(RESTRICTED_ADDRESS, "exception-carrier-ok");
  fixtures.push(exceptionAllowed);
  const exceptionWrongPort = await listen(RESTRICTED_ADDRESS, "wrong-port-should-not-arrive");
  fixtures.push(exceptionWrongPort);

  writeFileSync(
    join(keelHome, "egress-address-exceptions.v1.json"),
    `${JSON.stringify(
      {
        version: 1,
        workspaces: [
          {
            realpath: workspaceRealpath,
            exceptions: [
              {
                host: EXCEPTION_HOST,
                cidr: `${RESTRICTED_ADDRESS}/32`,
                ports: [exceptionAllowed.port],
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  warden = new WardenHarness(
    compiledCarrier ? wardenEntry : process.execPath,
    compiledCarrier ? [] : [wardenEntry],
    {
      workspace: workspaceRealpath,
      home,
      keelHome,
      auditDir,
      compiled: compiledCarrier,
    },
  );

  const hello = await warden.result("warden.hello", "carrier-hello", {
    kernelVersion: "0.0.0",
    protocolVersion: "1.0.0",
  });
  assert.equal(hello.enforcementTier, "sandbox:srt");
  assert.ok(
    hello.capabilities.includes("egress-address-guard/v1"),
    `installed carrier omitted address-guard capability: ${JSON.stringify(hello.capabilities)}`,
  );

  const publicResult = await executeWithOneShotReview(
    warden,
    "carrier-public",
    PUBLIC_HOST,
    publicAllowed.port,
    "allowed",
  );
  assert.equal(publicResult.stdout, "200");
  assert.equal(publicAllowed.hits(), 1);
  assert.deepEqual(publicAllowed.hosts(), [`${PUBLIC_HOST}:${String(publicAllowed.port)}`]);

  const exceptionResult = await executeWithOneShotReview(
    warden,
    "carrier-exception",
    EXCEPTION_HOST,
    exceptionAllowed.port,
    "allowed",
  );
  assert.equal(exceptionResult.stdout, "200");
  assert.equal(exceptionAllowed.hits(), 1);
  assert.deepEqual(exceptionAllowed.hosts(), [
    `${EXCEPTION_HOST}:${String(exceptionAllowed.port)}`,
  ]);

  const wrongPortResult = await executeWithOneShotReview(
    warden,
    "carrier-exception-wrong-port",
    EXCEPTION_HOST,
    exceptionWrongPort.port,
    "denied",
  );
  assert.equal(wrongPortResult.stdout, "403");
  assert.equal(exceptionWrongPort.hits(), 0);

  const hardDenyResult = await executeWithOneShotReview(
    warden,
    "carrier-hard-deny",
    HARD_DENY_HOST,
    hardDenied.port,
    "denied",
  );
  assert.equal(hardDenyResult.stdout, "403");
  assert.equal(hardDenied.hits(), 0);

  const records = loadAuditRecords(auditDir);
  const denials = records.filter((record) => record.eventType === "egress.deny");
  assert.ok(
    denials.some(
      (record) =>
        record.payload?.host === EXCEPTION_HOST &&
        record.payload?.reason === "restricted-address-not-excepted",
    ),
    "installed carrier did not audit the exception port mismatch",
  );
  assert.ok(
    denials.some(
      (record) => record.payload?.host === HARD_DENY_HOST && record.payload?.reason === "hard-deny",
    ),
    "installed carrier did not audit the hard-denied address",
  );
  const auditJson = JSON.stringify(records);
  assert.ok(!auditJson.includes("127.0.0.1"), "audit leaked the exact hard-denied address");
  assert.ok(
    !auditJson.includes(RESTRICTED_ADDRESS),
    "audit leaked the exact restricted exception address",
  );

  console.log(`carrier egress address guard smoke passed with Node ${process.version}`);
} finally {
  try {
    if (warden !== undefined) await warden.stop();
  } finally {
    await Promise.all(fixtures.map((fixture) => closeServer(fixture)));
    rmSync(root, { recursive: true, force: true });
  }
}
