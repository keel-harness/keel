import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import assert from "node:assert/strict";

const keelArg = process.argv[2];
assert.ok(keelArg, "usage: node smoke-npx-mcp-review.mjs <absolute-keel-bin>");
const keelBin = resolve(keelArg);
assert.ok(isAbsolute(keelBin), "installed keel bin must resolve to an absolute path");
assert.ok(existsSync(keelBin), `installed keel bin is missing: ${keelBin}`);

const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-npx-mcp-review-")));
const workspace = join(root, "workspace");
const keelHome = join(root, "keel-home");
const fixturePath = join(workspace, "fixture-server.mjs");
const markerPath = join(workspace, "fixture-spawned.marker");

function fail(label, result) {
  const details = [
    `${label} failed`,
    `status: ${String(result.status)}`,
    `signal: ${String(result.signal)}`,
    `error: ${String(result.error ?? "(none)")}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ].join("\n");
  throw new Error(details);
}

function runKeel(args, label) {
  const env = {
    ...process.env,
    KEEL_HOME: keelHome,
    KEEL_WARDEN_SANDBOX: "srt",
    NO_COLOR: "1",
  };
  delete env.KEEL_INTERNAL_WARDEN_STDIO;
  delete env.KEEL_INTERNAL_MCP_DISCOVERY;
  delete env.KEEL_MCP_DISCOVERY_REQUEST;
  const result = spawnSync(keelBin, args, {
    cwd: workspace,
    env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1_048_576,
  });
  if (result.error !== undefined && result.error.code !== "ETIMEDOUT") fail(label, result);
  return result;
}

try {
  mkdirSync(join(workspace, ".keel"), { recursive: true });
  mkdirSync(keelHome, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(keelHome, "trust.json"),
    `${JSON.stringify(
      {
        version: 1,
        workspaces: {
          [workspace]: {
            decision: "trusted",
            decidedAt: "1970-01-01T00:00:00.000Z",
            principal: "package-smoke",
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    fixturePath,
    `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(markerPath)}, "spawned\\n", { mode: 0o600 });
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\\n");
          if (newline === -1) break;
          const request = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (request.method === "initialize") {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "installed-npx-fixture", version: "1" }
              }
            }) + "\\n");
          }
          if (request.method === "tools/list") {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                tools: [{
                  name: "echo",
                  description: "Echoes exact input",
                  inputSchema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                    required: ["text"]
                  },
                  annotations: { readOnlyHint: true }
                }]
              }
            }) + "\\n");
            setImmediate(() => process.exit(0));
          }
        }
      });
    `,
    { mode: 0o600 },
  );
  writeFileSync(
    join(workspace, ".keel", "mcp.json"),
    `${JSON.stringify(
      {
        version: 1,
        servers: {
          fixture: {
            transport: "stdio",
            command: process.execPath,
            args: [fixturePath],
            envKeys: [],
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const missingReview = runKeel(["mcp", "review", "missing"], "mcp review missing");
  assert.equal(missingReview.status, 1, "mcp review missing must fail");
  assert.match(missingReview.stdout, /server missing is not configured/u);
  assert.equal(existsSync(markerPath), false, "an invalid server key must not spawn the fixture");

  const fixtureReview = runKeel(["mcp", "review", "fixture"], "mcp review fixture");
  if (fixtureReview.status !== 0) fail("mcp review fixture", fixtureReview);
  assert.match(fixtureReview.stdout, /trusted local-stdio MCP server "fixture"/u);
  assert.match(fixtureReview.stdout, /mcp__fixture__echo/u);
  assert.equal(existsSync(markerPath), true, "the reviewed fixture must run through discovery");

  const trustStorePath = join(keelHome, "mcp-trust.json");
  const trustStore = JSON.parse(readFileSync(trustStorePath, "utf8"));
  assert.equal(trustStore.version, 1);
  const trustedServers = Object.values(trustStore.servers);
  assert.equal(trustedServers.length, 1);
  const trusted = trustedServers[0];
  assert.equal(trusted.workspaceRoot, workspace);
  assert.equal(trusted.serverKey, "fixture");
  assert.equal(trusted.state, "trusted");
  assert.match(trusted.pin, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(
    trusted.tools.map((tool) => tool.name),
    ["echo"],
  );
  assert.equal(
    existsSync(join(workspace, "mcp-trust.json")),
    false,
    "MCP trust must remain in the user-scoped KEEL_HOME",
  );

  process.stdout.write("installed npx MCP review smoke passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
