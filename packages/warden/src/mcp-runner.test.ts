import { exec, spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { JsonObjectT } from "@keel/shared";
import {
  canonicalMcpToolPinForLaunch,
  mcpDiscoverySandboxCommand,
  mcpSandboxCommand,
  modelTextFromMcpSandboxResult,
} from "./mcp/local-stdio.js";

const execAsync = promisify(exec);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const hostileServersDir = join(repoRoot, "fixtures", "hostile-servers");

async function expectRunnerFailure(command: string, cwd: string, code: string): Promise<void> {
  try {
    await execAsync(command, { cwd, timeout: 7_000 });
    throw new Error(`expected MCP runner failure ${code}`);
  } catch (error) {
    const stdout =
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      typeof error.stdout === "string"
        ? error.stdout
        : "";
    expect(stdout).toContain(code);
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for process ${pid} to exit`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function trustedServer(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly envKeys?: readonly string[];
  readonly tools: readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: JsonObjectT;
    readonly annotations?: JsonObjectT;
  }[];
  readonly capabilities?: JsonObjectT;
}) {
  const server = {
    transport: "stdio" as const,
    command: input.command,
    args: input.args,
    envKeys: [...(input.envKeys ?? [])],
  };
  return {
    ...server,
    pin: canonicalMcpToolPinForLaunch({
      server,
      protocolVersion: "2025-06-18",
      capabilities: input.capabilities ?? { tools: {} },
      tools: input.tools,
    }),
    tools: input.tools,
  };
}

function payloadFile(dir: string, name = "payload.json"): { readonly payloadFilePath: string } {
  return { payloadFilePath: join(dir, name) };
}

describe("MCP local-stdio one-shot supervisor", () => {
  it("materializes exact runner bytes outside the SRT shell command", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-transport with spaces-"));
    const discoveryPayloadPath = join(dir, "discovery-payload.json");
    const callPayloadPath = join(dir, "call-payload.json");
    const hostileArg = "server-arg-$(touch must-not-run)-'quote'-!bang";
    const server = {
      transport: "stdio" as const,
      command: process.execPath,
      args: [hostileArg],
      envKeys: [],
    };

    const discoveryCommand = mcpDiscoverySandboxCommand(server, {
      payloadFilePath: discoveryPayloadPath,
    });
    const callCommand = mcpSandboxCommand(
      trustedServer({
        command: server.command,
        args: server.args,
        tools: [{ name: "echo", inputSchema: { type: "object" } }],
      }),
      "echo",
      { text: "opaque-tool-argument" },
      { payloadFilePath: callPayloadPath },
    );
    const discoveryRunnerPath = `${discoveryPayloadPath}.runner.mjs`;
    const callRunnerPath = `${callPayloadPath}.runner.mjs`;
    const discoveryRunner = readFileSync(discoveryRunnerPath, "utf8");
    const callRunner = readFileSync(callRunnerPath, "utf8");

    expect(discoveryRunner).toBe(callRunner);
    expect(discoveryRunner).toContain("tools/list");
    expect(discoveryRunner).toContain("tools/call");
    expect(discoveryRunner).toContain('process.argv[2] ?? ""');
    expect(discoveryCommand).toContain(discoveryRunnerPath);
    expect(discoveryCommand).toContain(`@${discoveryPayloadPath}`);
    expect(callCommand).toContain(callRunnerPath);
    expect(callCommand).toContain(`@${callPayloadPath}`);
    for (const command of [discoveryCommand, callCommand]) {
      expect(command).not.toContain("--input-type=module");
      expect(command).not.toContain(" -e ");
      expect(command).not.toContain("tools/list");
      expect(command).not.toContain("tools/call");
      expect(command).not.toContain(hostileArg);
      expect(command).not.toContain("opaque-tool-argument");
    }
    expect(readFileSync(discoveryPayloadPath, "utf8")).toContain(hostileArg);
    expect(readFileSync(callPayloadPath, "utf8")).toContain("opaque-tool-argument");
    execFileSync(process.execPath, ["--check", discoveryRunnerPath]);
    if (process.platform !== "win32") {
      expect(statSync(discoveryRunnerPath).mode & 0o777).toBe(0o600);
      expect(statSync(discoveryPayloadPath).mode & 0o777).toBe(0o600);
      expect(statSync(callRunnerPath).mode & 0o777).toBe(0o600);
      expect(statSync(callPayloadPath).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(existsSync(join(dir, "must-not-run"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("materializes an executable runner through the source-mode TSX loader", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-source-mode-"));
    const generatorPath = join(dir, "generate-runner.mjs");
    const serverPath = join(dir, "discovery-server.cjs");
    const payloadFilePath = join(dir, "payload.json");
    const runnerPath = `${payloadFilePath}.runner.mjs`;
    const localStdioSource = pathToFileURL(
      join(repoRoot, "packages", "warden", "src", "mcp", "local-stdio.ts"),
    ).href;
    try {
      writeFileSync(
        serverPath,
        `
          let buffer = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => {
            buffer += chunk;
            for (;;) {
              const idx = buffer.indexOf("\\n");
              if (idx === -1) break;
              const req = JSON.parse(buffer.slice(0, idx));
              buffer = buffer.slice(idx + 1);
              if (req.method === "initialize") {
                process.stdout.write(JSON.stringify({
                  jsonrpc: "2.0",
                  id: req.id,
                  result: {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "source-mode", version: "1" }
                  }
                }) + "\\n");
              }
              if (req.method === "tools/list") {
                process.stdout.write(JSON.stringify({
                  jsonrpc: "2.0",
                  id: req.id,
                  result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
                }) + "\\n");
              }
            }
          });
        `,
      );
      writeFileSync(
        generatorPath,
        `
          import { mcpDiscoverySandboxCommand } from ${JSON.stringify(localStdioSource)};
          mcpDiscoverySandboxCommand(
            {
              transport: "stdio",
              command: ${JSON.stringify(process.execPath)},
              args: [${JSON.stringify(serverPath)}],
              envKeys: []
            },
            { payloadFilePath: ${JSON.stringify(payloadFilePath)} }
          );
        `,
      );

      execFileSync(
        process.execPath,
        ["--import", "tsx/esm", "--conditions=@keel/source", generatorPath],
        { cwd: repoRoot, stdio: "pipe" },
      );
      const runner = readFileSync(runnerPath, "utf8");
      expect(runner).not.toContain("__name");
      const stdout = execFileSync(process.execPath, [runnerPath, `@${payloadFilePath}`], {
        cwd: dir,
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(JSON.parse(stdout)).toMatchObject({
        protocolVersion: "2025-06-18",
        tools: [{ name: "echo" }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the hostile local-stdio MCP fixture corpus parseable", () => {
    const scripts = readdirSync(hostileServersDir)
      .filter((entry) => entry.endsWith(".cjs"))
      .sort();

    expect(scripts).toEqual([
      "echo.cjs",
      "flood.cjs",
      "rug-pull.cjs",
      "shadow-resource.cjs",
      "unsupported-client-request.cjs",
    ]);
    for (const script of scripts) {
      execFileSync(process.execPath, ["--check", join(hostileServersDir, script)]);
    }
    const readme = readFileSync(join(hostileServersDir, "README.md"), "utf8");
    expect(readme).toContain("SEC-MCP Slice 1");
    expect(readme).toContain("local stdio");
  });

  it("refuses server-originated sampling requests and continues the tools-only call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-unsupported-client-"));
    const command = mcpSandboxCommand(
      trustedServer({
        command: process.execPath,
        args: [join(hostileServersDir, "unsupported-client-request.cjs")],
        capabilities: { tools: {}, sampling: {} },
        tools: [{ name: "echo", inputSchema: { type: "object" } }],
      }),
      "echo",
      {},
      payloadFile(dir),
    );
    const { stdout } = await execAsync(command, { cwd: dir, timeout: 5_000 });

    expect(stdout).toContain("ok");
    expect(stdout).not.toContain("exfiltrate");
  });

  it("speaks MCP JSON-RPC to a stdio server and excludes server logs from model text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-"));
    const serverPath = join(dir, "fixture-server.cjs");
    writeFileSync(
      serverPath,
      `
        process.stderr.write("fixture server log with SECRET_TOKEN\\n");
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const idx = buffer.indexOf("\\n");
            if (idx === -1) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const req = JSON.parse(line);
            if (req.method === "initialize") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "fixture", version: "1" }
                }
              }) + "\\n");
            }
            if (req.method === "tools/list") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { tools: [{ name: "echo" }] }
              }) + "\\n");
            }
            if (req.method === "tools/call") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: {
                  content: [
                    { type: "text", text: "echo:" + req.params.arguments.text },
                    { type: "resource_link", uri: "file:///etc/passwd" }
                  ]
                }
              }) + "\\n");
              setImmediate(() => process.exit(0));
            }
          }
        });
      `,
    );

    const command = mcpSandboxCommand(
      trustedServer({
        command: process.execPath,
        args: [serverPath],
        tools: [{ name: "echo" }],
      }),
      "echo",
      { text: "hello" },
      payloadFile(dir),
    );
    const { stdout, stderr } = await execAsync(command, { cwd: dir, timeout: 5_000 });

    expect(stdout).toContain("echo:hello");
    expect(stderr).not.toContain("SECRET_TOKEN");
    expect(
      modelTextFromMcpSandboxResult({ exitCode: 0, stdout, stderr: "", signal: null }),
    ).toContain("[mcp resource link omitted: file:///etc/passwd]");
    expect(
      modelTextFromMcpSandboxResult({ exitCode: 0, stdout, stderr: "", signal: null }),
    ).not.toContain("SECRET_TOKEN");
  });

  it("flushes a valid near-budget MCP result before the runner exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-large-result-"));
    const serverPath = join(dir, "large-result-server.cjs");
    const expectedText = "x".repeat(240_000);
    try {
      writeFileSync(
        serverPath,
        `
          const resultText = "x".repeat(240000);
          let buffer = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => {
            buffer += chunk;
            for (;;) {
              const idx = buffer.indexOf("\\n");
              if (idx === -1) break;
              const req = JSON.parse(buffer.slice(0, idx));
              buffer = buffer.slice(idx + 1);
              if (req.method === "initialize") {
                process.stdout.write(JSON.stringify({
                  jsonrpc: "2.0",
                  id: req.id,
                  result: {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "large-result", version: "1" }
                  }
                }) + "\\n");
              }
              if (req.method === "tools/list") {
                process.stdout.write(JSON.stringify({
                  jsonrpc: "2.0",
                  id: req.id,
                  result: { tools: [{ name: "echo" }] }
                }) + "\\n");
              }
              if (req.method === "tools/call") {
                process.stdout.write(JSON.stringify({
                  jsonrpc: "2.0",
                  id: req.id,
                  result: { content: [{ type: "text", text: resultText }] }
                }) + "\\n");
              }
            }
          });
        `,
      );
      const command = mcpSandboxCommand(
        trustedServer({
          command: process.execPath,
          args: [serverPath],
          tools: [{ name: "echo" }],
        }),
        "echo",
        {},
        payloadFile(dir),
      );

      const { stdout } = await execAsync(command, {
        cwd: dir,
        timeout: 5_000,
        maxBuffer: 1_000_000,
      });
      const result = JSON.parse(stdout) as {
        readonly content?: readonly { readonly type?: string; readonly text?: string }[];
      };
      expect(result.content).toEqual([{ type: "text", text: expectedText }]);
      expect(Buffer.byteLength(stdout, "utf8")).toBeGreaterThan(240_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not pass unlisted parent environment variables to the MCP server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-env-"));
    const serverPath = join(dir, "env-server.cjs");
    writeFileSync(
      serverPath,
      `
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const idx = buffer.indexOf("\\n");
            if (idx === -1) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const req = JSON.parse(line);
            if (req.method === "initialize") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
              }) + "\\n");
            }
            if (req.method === "tools/list") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { tools: [{ name: "env" }] }
              }) + "\\n");
            }
            if (req.method === "tools/call") {
              const leaked = process.env.LEAK_ME === undefined ? "absent" : "present";
              const explicit = process.env.EXPLICIT_TOKEN === "explicit" ? "present" : "missing";
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { content: [{ type: "text", text: "leak:" + leaked + " explicit:" + explicit }] }
              }) + "\\n");
              setImmediate(() => process.exit(0));
            }
          }
        });
      `,
    );

    const command = mcpSandboxCommand(
      trustedServer({
        command: process.execPath,
        args: [serverPath],
        envKeys: ["EXPLICIT_TOKEN"],
        tools: [{ name: "env" }],
      }),
      "env",
      {},
      payloadFile(dir),
    );
    const { stdout } = await execAsync(command, {
      cwd: dir,
      timeout: 5_000,
      env: { ...process.env, LEAK_ME: "parent-secret", EXPLICIT_TOKEN: "explicit" },
    });

    expect(stdout).toContain("leak:absent explicit:present");
    expect(stdout).not.toContain("parent-secret");
  });

  it("revalidates tools/list in the same server process immediately before tools/call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-revalidate-"));
    const serverPath = join(dir, "revalidate-server.cjs");
    const statePath = join(dir, "state.json");
    writeFileSync(
      serverPath,
      `
        const fs = require("node:fs");
        const statePath = ${JSON.stringify(statePath)};
        let sawList = false;
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const idx = buffer.indexOf("\\n");
            if (idx === -1) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const req = JSON.parse(line);
            if (req.method === "initialize") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
              }) + "\\n");
            }
            if (req.method === "tools/list") {
              sawList = true;
              fs.writeFileSync(statePath, "listed");
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { tools: [{ name: "echo" }] }
              }) + "\\n");
            }
            if (req.method === "tools/call") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { content: [{ type: "text", text: sawList ? "listed-before-call" : "missing-list" }] }
              }) + "\\n");
              setImmediate(() => process.exit(0));
            }
          }
        });
      `,
    );

    const command = mcpSandboxCommand(
      trustedServer({
        command: process.execPath,
        args: [serverPath],
        envKeys: [],
        tools: [{ name: "echo" }],
      }),
      "echo",
      {},
      payloadFile(dir),
    );

    const { stdout } = await execAsync(command, { cwd: dir, timeout: 5_000 });

    expect(stdout).toContain("listed-before-call");
  });

  it("terminates the detached MCP server when the runner receives an external signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-signal-"));
    const serverPath = join(dir, "signal-server.cjs");
    const startedPath = join(dir, "started.txt");
    const terminatedPath = join(dir, "terminated.txt");
    writeFileSync(
      serverPath,
      `
        const { writeFileSync } = require("node:fs");
        process.on("SIGTERM", () => {
          writeFileSync(${JSON.stringify(terminatedPath)}, "terminated");
          process.exit(0);
        });
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const idx = buffer.indexOf("\\n");
            if (idx === -1) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const req = JSON.parse(line);
            if (req.method === "initialize") {
              writeFileSync(${JSON.stringify(startedPath)}, String(process.pid));
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
              }) + "\\n");
            }
          }
        });
        setInterval(() => {}, 1000);
      `,
    );

    const command = mcpSandboxCommand(
      trustedServer({
        command: process.execPath,
        args: [serverPath],
        tools: [{ name: "echo" }],
      }),
      "echo",
      {},
      payloadFile(dir),
    );
    const runner = spawn(command, { cwd: dir, shell: true, detached: true, stdio: "ignore" });
    try {
      await waitForFile(startedPath);
      process.kill(-runner.pid!, "SIGTERM");
      await waitForFile(terminatedPath);
    } finally {
      try {
        process.kill(-runner.pid!, "SIGKILL");
      } catch {
        // Already exited.
      }
      if (existsSync(startedPath)) {
        const pid = Number(readFileSync(startedPath, "utf8"));
        if (Number.isInteger(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already reaped by the runner.
          }
        }
      }
    }
  });

  it("reaps a SIGTERM-resistant server descendant after external cancellation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-signal-descendant-"));
    const serverPath = join(dir, "signal-descendant-server.cjs");
    const startedPath = join(dir, "started.txt");
    const descendantPidPath = join(dir, "descendant-pid.txt");
    writeFileSync(
      serverPath,
      `
        const { spawn } = require("node:child_process");
        const { writeFileSync } = require("node:fs");
        const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(`
          const { writeFileSync } = require("node:fs");
          process.on("SIGTERM", () => {});
          writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));
          setInterval(() => {}, 1000);
        `)}], { stdio: "ignore" });
        descendant.unref();
        process.on("SIGTERM", () => process.exit(0));
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const idx = buffer.indexOf("\\n");
            if (idx === -1) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const req = JSON.parse(line);
            if (req.method === "initialize") {
              writeFileSync(${JSON.stringify(startedPath)}, String(process.pid));
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
              }) + "\\n");
            }
          }
        });
        setInterval(() => {}, 1000);
      `,
    );

    const command = mcpSandboxCommand(
      trustedServer({
        command: process.execPath,
        args: [serverPath],
        tools: [{ name: "echo" }],
      }),
      "echo",
      {},
      payloadFile(dir),
    );
    const runner = spawn(command, { cwd: dir, shell: true, detached: true, stdio: "ignore" });
    let descendantPid: number | undefined;
    try {
      await waitForFile(startedPath);
      await waitForFile(descendantPidPath);
      descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
      expect(Number.isInteger(descendantPid)).toBe(true);

      process.kill(-runner.pid!, "SIGTERM");
      await new Promise<void>((resolve) => runner.once("close", () => resolve()));
      await waitForProcessExit(descendantPid);
    } finally {
      try {
        process.kill(-runner.pid!, "SIGKILL");
      } catch {
        // Already exited.
      }
      if (descendantPid !== undefined && processExists(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });

  it("terminates same-process-group descendants after a successful server exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-descendant-"));
    const serverPath = join(dir, "descendant-server.cjs");
    const descendantPidPath = join(dir, "descendant-pid.txt");
    const descendantTerminatedPath = join(dir, "descendant-terminated.txt");
    writeFileSync(
      serverPath,
      `
        const { spawn } = require("node:child_process");
        const { existsSync } = require("node:fs");
        const child = spawn(process.execPath, ["-e", ${JSON.stringify(`
          const { writeFileSync } = require("node:fs");
          process.on("SIGTERM", () => {
            writeFileSync(${JSON.stringify(descendantTerminatedPath)}, "terminated");
            process.exit(0);
          });
          writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));
          setInterval(() => {}, 1000);
        `)}], { stdio: "ignore" });
        child.unref();
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(${JSON.stringify(descendantPidPath)})) {
          Atomics.wait(wait, 0, 0, 10);
        }
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const idx = buffer.indexOf("\\n");
            if (idx === -1) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const req = JSON.parse(line);
            if (req.method === "initialize") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
              }) + "\\n");
            }
            if (req.method === "tools/list") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { tools: [{ name: "echo" }] }
              }) + "\\n");
            }
            if (req.method === "tools/call") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { content: [{ type: "text", text: "ok" }] }
              }) + "\\n");
              setImmediate(() => process.exit(0));
            }
          }
        });
      `,
    );

    const command = mcpSandboxCommand(
      trustedServer({
        command: process.execPath,
        args: [serverPath],
        tools: [{ name: "echo" }],
      }),
      "echo",
      {},
      payloadFile(dir),
    );

    try {
      const { stdout } = await execAsync(command, { cwd: dir, timeout: 5_000 });

      expect(stdout).toContain("ok");
      await waitForFile(descendantTerminatedPath);
    } finally {
      if (existsSync(descendantPidPath)) {
        const pid = Number(readFileSync(descendantPidPath, "utf8"));
        if (Number.isInteger(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already killed by runner teardown.
          }
        }
      }
    }
  });

  it("denies call mode when tools/list changes before invocation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-pin-mismatch-"));
    const serverPath = join(dir, "pin-mismatch-server.cjs");
    writeFileSync(
      serverPath,
      `
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const idx = buffer.indexOf("\\n");
            if (idx === -1) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const req = JSON.parse(line);
            if (req.method === "initialize") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
              }) + "\\n");
            }
            if (req.method === "tools/list") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { tools: [{ name: "echo", description: "changed" }] }
              }) + "\\n");
            }
            if (req.method === "tools/call") process.exit(9);
          }
        });
      `,
    );
    const command = mcpSandboxCommand(
      {
        transport: "stdio",
        command: process.execPath,
        args: [serverPath],
        envKeys: [],
        pin: `sha256:${"9".repeat(64)}`,
        tools: [{ name: "echo" }],
      },
      "echo",
      {},
      payloadFile(dir),
    );

    await expectRunnerFailure(command, dir, "MCP_PIN_MISMATCH");
  });

  it("denies tools/list_changed notifications before model-visible results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-list-changed-"));
    const serverPath = join(dir, "list-changed-server.cjs");
    writeFileSync(
      serverPath,
      `
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const idx = buffer.indexOf("\\n");
            if (idx === -1) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const req = JSON.parse(line);
            if (req.method === "initialize") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } } }
              }) + "\\n");
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/tools/list_changed",
                params: {}
              }) + "\\n");
            }
          }
        });
      `,
    );
    const command = mcpSandboxCommand(
      {
        transport: "stdio",
        command: process.execPath,
        args: [serverPath],
        envKeys: [],
        pin: `sha256:${"7".repeat(64)}`,
        tools: [{ name: "echo" }],
      },
      "echo",
      {},
      payloadFile(dir),
    );

    await expectRunnerFailure(command, dir, "MCP_TOOLS_LIST_CHANGED");
  });

  it("denies tools/list_changed notifications emitted immediately after a call result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-list-changed-after-result-"));
    const serverPath = join(dir, "list-changed-after-result-server.cjs");
    writeFileSync(
      serverPath,
      `
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const idx = buffer.indexOf("\\n");
            if (idx === -1) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const req = JSON.parse(line);
            if (req.method === "initialize") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } } }
              }) + "\\n");
            }
            if (req.method === "tools/list") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { tools: [{ name: "echo" }] }
              }) + "\\n");
            }
            if (req.method === "tools/call") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { content: [{ type: "text", text: "must-not-reach-model" }] }
              }) + "\\n" + JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/tools/list_changed",
                params: {}
              }) + "\\n");
              setImmediate(() => process.exit(0));
            }
          }
        });
      `,
    );
    const command = mcpSandboxCommand(
      trustedServer({
        command: process.execPath,
        args: [serverPath],
        envKeys: [],
        capabilities: { tools: { listChanged: true } },
        tools: [{ name: "echo" }],
      }),
      "echo",
      {},
      payloadFile(dir),
    );

    await expectRunnerFailure(command, dir, "MCP_TOOLS_LIST_CHANGED");
  });

  it("rejects duplicate initialize responses as protocol errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-duplicate-init-"));
    const serverPath = join(dir, "duplicate-init-server.cjs");
    writeFileSync(
      serverPath,
      `
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          const idx = buffer.indexOf("\\n");
          if (idx === -1) return;
          const req = JSON.parse(buffer.slice(0, idx));
          if (req.method === "initialize") {
            const frame = JSON.stringify({
              jsonrpc: "2.0",
              id: req.id,
              result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
            }) + "\\n";
            process.stdout.write(frame + frame);
          }
        });
      `,
    );
    const command = mcpSandboxCommand(
      trustedServer({
        command: process.execPath,
        args: [serverPath],
        envKeys: [],
        tools: [{ name: "echo" }],
      }),
      "echo",
      {},
      payloadFile(dir),
    );

    await expectRunnerFailure(command, dir, "MCP_PROTOCOL_ERROR");
  });

  it("converts malformed server frames into bounded typed MCP errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-bad-"));
    const serverPath = join(dir, "malformed-server.cjs");
    writeFileSync(
      serverPath,
      `
        process.stdout.write("{not-json}\\n");
        setTimeout(() => process.exit(0), 100);
      `,
    );
    const command = mcpSandboxCommand(
      {
        transport: "stdio",
        command: process.execPath,
        args: [serverPath],
        envKeys: [],
        pin: `sha256:${"b".repeat(64)}`,
        tools: [{ name: "echo" }],
      },
      "echo",
      { text: "hello" },
      payloadFile(dir),
    );

    await expectRunnerFailure(command, dir, "MCP_PROTOCOL_ERROR");
  });

  it("discovers tools through initialize plus tools/list without making a tool call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-discover-"));
    const serverPath = join(dir, "discovery-server.cjs");
    writeFileSync(
      serverPath,
      `
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const idx = buffer.indexOf("\\n");
            if (idx === -1) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const req = JSON.parse(line);
            if (req.method === "initialize") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: { listChanged: true } },
                  serverInfo: { name: "fixture", version: "1" }
                }
              }) + "\\n");
            }
            if (req.method === "tools/list") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: {
                  tools: [{
                    name: "echo",
                    description: "Echoes input",
                    inputSchema: { type: "object" },
                    annotations: { readOnlyHint: true }
                  }]
                }
              }) + "\\n");
              setImmediate(() => process.exit(0));
            }
            if (req.method === "tools/call") process.exit(9);
          }
        });
      `,
    );

    const command = mcpDiscoverySandboxCommand(
      {
        transport: "stdio",
        command: process.execPath,
        args: [serverPath],
        envKeys: [],
      },
      payloadFile(dir),
    );
    const { stdout } = await execAsync(command, { cwd: dir, timeout: 5_000 });
    const discovered = JSON.parse(stdout) as {
      readonly protocolVersion: string;
      readonly capabilities: { readonly tools: { readonly listChanged: boolean } };
      readonly tools: readonly { readonly name: string; readonly annotations: unknown }[];
    };

    expect(discovered.protocolVersion).toBe("2025-06-18");
    expect(discovered.capabilities.tools.listChanged).toBe(true);
    expect(discovered.tools).toEqual([
      expect.objectContaining({
        name: "echo",
        annotations: { readOnlyHint: true },
      }),
    ]);
  });

  it("denies discovery when tools/list_changed arrives immediately after tools/list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-discover-changed-"));
    const serverPath = join(dir, "discovery-list-changed-server.cjs");
    writeFileSync(
      serverPath,
      `
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const idx = buffer.indexOf("\\n");
            if (idx === -1) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const req = JSON.parse(line);
            if (req.method === "initialize") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: { listChanged: true } }
                }
              }) + "\\n");
            }
            if (req.method === "tools/list") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { tools: [{ name: "echo" }] }
              }) + "\\n" + JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/tools/list_changed",
                params: {}
              }) + "\\n");
              setImmediate(() => process.exit(0));
            }
          }
        });
      `,
    );

    const command = mcpDiscoverySandboxCommand(
      {
        transport: "stdio",
        command: process.execPath,
        args: [serverPath],
        envKeys: [],
      },
      payloadFile(dir),
    );

    await expectRunnerFailure(command, dir, "MCP_TOOLS_LIST_CHANGED");
  });

  it.each([
    {
      name: "initialize error",
      code: "MCP_INITIALIZE_FAILED",
      script: `
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          const idx = buffer.indexOf("\\n");
          if (idx === -1) return;
          const req = JSON.parse(buffer.slice(0, idx));
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32000, message: "init denied" }
          }) + "\\n");
        });
      `,
    },
    {
      name: "tool error",
      code: "MCP_TOOL_ERROR",
      script: `
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const idx = buffer.indexOf("\\n");
            if (idx === -1) break;
            const req = JSON.parse(buffer.slice(0, idx));
            buffer = buffer.slice(idx + 1);
            if (req.method === "initialize") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
              }) + "\\n");
            }
            if (req.method === "tools/list") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { tools: [{ name: "echo" }] }
              }) + "\\n");
            }
            if (req.method === "tools/call") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                error: { code: -32000, message: "tool denied" }
              }) + "\\n");
            }
          }
        });
      `,
    },
    {
      name: "invalid tool result",
      code: "MCP_TOOL_ERROR",
      script: `
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const idx = buffer.indexOf("\\n");
            if (idx === -1) break;
            const req = JSON.parse(buffer.slice(0, idx));
            buffer = buffer.slice(idx + 1);
            if (req.method === "initialize") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
              }) + "\\n");
            }
            if (req.method === "tools/list") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { tools: [{ name: "echo" }] }
              }) + "\\n");
            }
            if (req.method === "tools/call") {
              process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: null }) + "\\n");
            }
          }
        });
      `,
    },
    {
      name: "early exit",
      code: "MCP_SERVER_EXIT",
      script: `process.exit(3);`,
    },
    {
      name: "stdout flood",
      code: "MCP_FRAME_LIMIT",
      script: `process.stdout.write("x".repeat(300000) + "\\n");`,
    },
    {
      name: "stderr flood",
      code: "MCP_STDERR_LIMIT",
      script: `process.stderr.write("x".repeat(300000)); setTimeout(() => {}, 1000);`,
    },
    {
      name: "timeout",
      code: "MCP_TIMEOUT",
      script: `setInterval(() => {}, 1000);`,
    },
  ])("reports $name as a typed MCP error", async ({ code, script }) => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-runner-error-"));
    const serverPath = join(dir, "error-server.cjs");
    writeFileSync(serverPath, script);
    const command = mcpSandboxCommand(
      trustedServer({
        command: process.execPath,
        args: [serverPath],
        envKeys: [],
        tools: [{ name: "echo" }],
      }),
      "echo",
      { text: "hello" },
      payloadFile(dir),
    );
    await expectRunnerFailure(command, dir, code);
  });
});
