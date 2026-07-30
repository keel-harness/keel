import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advertisedMcpToolSpecs,
  loadMcpTrustStore,
  mcpTrustedServersChildEnv,
  mcpTrustStorePath,
} from "../mcp/local-stdio.js";
import * as runtime from "../warden/runtime.js";
import { runMcpReviewCommand } from "./mcp.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-mcp-cli-")) });

function storedServer(env: NodeJS.ProcessEnv, workspaceRoot: string, serverKey: string) {
  return Object.values(loadMcpTrustStore(env).servers).find(
    (server) => server.workspaceRoot === workspaceRoot && server.serverKey === serverKey,
  );
}

describe("keel mcp review", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads trusted project config, performs one bounded discovery, and stores a user-scope pin", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-mcp-review-ws-"));
    const e = env();
    mkdirSync(join(cwd, ".keel"), { recursive: true });
    writeFileSync(
      join(cwd, ".keel", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: {
          fixture: {
            transport: "stdio",
            command: process.execPath,
            args: ["fixture-server.js"],
            envKeys: ["FIXTURE_TOKEN"],
          },
        },
      }),
    );

    const output = await runMcpReviewCommand({
      cwd,
      env: e,
      serverKey: "fixture",
      discover: async (server) => {
        expect(server).toEqual({
          transport: "stdio",
          command: process.execPath,
          args: ["fixture-server.js"],
          envKeys: ["FIXTURE_TOKEN"],
        });
        return {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          tools: [
            {
              name: "echo",
              description: "Echoes input",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
          ],
        };
      },
    });

    expect(output).toContain('trusted local-stdio MCP server "fixture"');
    expect(output).toContain(`trustStore: ${JSON.stringify(mcpTrustStorePath(e))}`);
    expect(output).toContain("mcp__fixture__echo");
    expect(output).toContain("safeNextAction: restart or continue a trusted keel session");
    expect(output).toContain(
      "re-review if command, args, env keys, entrypoint identity, protocol, capabilities, or tool definitions change",
    );
    expect(existsSync(mcpTrustStorePath(e))).toBe(true);
    expect(existsSync(join(cwd, "mcp-trust.json"))).toBe(false);
    expect(readFileSync(mcpTrustStorePath(e), "utf8")).not.toContain(
      "project-value-must-not-be-persisted",
    );
    expect(storedServer(e, cwd, "fixture")?.state).toBe("trusted");
    expect(advertisedMcpToolSpecs({ workspaceRoot: cwd, env: e }).map((tool) => tool.name)).toEqual(
      ["mcp__fixture__echo"],
    );
  });

  it("fails inertly for missing or unsupported project MCP config", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-mcp-review-missing-"));
    let discoveries = 0;

    await expect(
      runMcpReviewCommand({
        cwd,
        env: env(),
        serverKey: "fixture",
        discover: async () => {
          discoveries++;
          throw new Error("must not discover");
        },
      }),
    ).rejects.toThrow("no .keel/mcp.json");
    expect(discoveries).toBe(0);
  });

  it("reports invalid config and unknown servers without spawning discovery", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-mcp-review-invalid-"));
    mkdirSync(join(cwd, ".keel"), { recursive: true });
    writeFileSync(join(cwd, ".keel", "mcp.json"), JSON.stringify({ version: 1, servers: {} }));
    let discoveries = 0;

    await expect(
      runMcpReviewCommand({
        cwd,
        env: env(),
        serverKey: "missing",
        discover: async () => {
          discoveries++;
          throw new Error("must not discover");
        },
      }),
    ).rejects.toThrow("server missing is not configured");
    writeFileSync(join(cwd, ".keel", "mcp.json"), JSON.stringify({ version: 1, servers: [] }));
    await expect(
      runMcpReviewCommand({
        cwd,
        env: env(),
        serverKey: "fixture",
        discover: async () => {
          discoveries++;
          throw new Error("must not discover");
        },
      }),
    ).rejects.toThrow("MCP config supports local stdio servers only");

    expect(discoveries).toBe(0);
  });

  it("uses the production discovery path when no test hook is supplied", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-mcp-review-prod-"));
    const e = env();
    mkdirSync(join(cwd, ".keel"), { recursive: true });
    writeFileSync(
      join(cwd, ".keel", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: {
          fixture: { transport: "stdio", command: "/usr/bin/node", args: ["server.js"] },
        },
      }),
    );

    const output = await runMcpReviewCommand({
      cwd,
      env: e,
      serverKey: "fixture",
      discoverProduction: async ({ server }) => {
        expect(server.command).toBe("/usr/bin/node");
        return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, tools: [] };
      },
    });

    expect(output).toContain("tools: (none)");
    expect(storedServer(e, cwd, "fixture")?.state).toBe("trusted");
  });

  it("warns when a pathless command cannot be entrypoint-hashed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-mcp-review-pathless-"));
    const e = env();
    mkdirSync(join(cwd, ".keel"), { recursive: true });
    writeFileSync(
      join(cwd, ".keel", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: {
          fixture: { transport: "stdio", command: "node", args: ["server.js"] },
        },
      }),
    );

    const output = await runMcpReviewCommand({
      cwd,
      env: e,
      serverKey: "fixture",
      discover: async () => ({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: [{ name: "echo", inputSchema: { type: "object" } }],
      }),
    });

    expect(output).toContain(
      "commandIdentity: entrypoint hash unavailable; pin covers command string, args, env key names, protocol, capabilities, and tool definitions, not executable bytes",
    );
    expect(output).toContain("prefer an absolute or workspace-relative command");
    expect(storedServer(e, cwd, "fixture")?.serverConfig.entrypointHash).toBeUndefined();
  });

  it("defaults to the production discovery runner when no discovery hooks are supplied", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-mcp-review-default-"));
    const e = env();
    mkdirSync(join(cwd, ".keel"), { recursive: true });
    writeFileSync(
      join(cwd, ".keel", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: {
          fixture: { transport: "stdio", command: "/usr/bin/node", args: ["server.js"] },
        },
      }),
    );
    vi.spyOn(runtime, "discoverProductionMcpServer").mockResolvedValue({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      tools: [{ name: "echo", inputSchema: { type: "object" } }],
    });

    const output = await runMcpReviewCommand({ cwd, env: e, serverKey: "fixture" });

    expect(output).toContain("mcp__fixture__echo");
    expect(runtime.discoverProductionMcpServer).toHaveBeenCalledOnce();
  });

  it("uses process env by default and renders empty args/env keys explicitly", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-mcp-review-default-env-"));
    const previousHome = process.env["KEEL_HOME"];
    const keelHome = mkdtempSync(join(tmpdir(), "keel-mcp-cli-default-env-"));
    process.env["KEEL_HOME"] = keelHome;
    mkdirSync(join(cwd, ".keel"), { recursive: true });
    writeFileSync(
      join(cwd, ".keel", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: {
          fixture: { transport: "stdio", command: "/usr/bin/node", args: [], envKeys: [] },
        },
      }),
    );
    try {
      const output = await runMcpReviewCommand({
        cwd,
        serverKey: "fixture",
        discover: async () => ({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          tools: [],
        }),
      });

      expect(output).toContain("args: (none)");
      expect(output).toContain("envKeys: (none)");
      expect(output).toContain(`trustStore: ${JSON.stringify(mcpTrustStorePath(process.env))}`);
      expect(storedServer(process.env, cwd, "fixture")?.state).toBe("trusted");
    } finally {
      if (previousHome === undefined) {
        delete process.env["KEEL_HOME"];
      } else {
        process.env["KEEL_HOME"] = previousHome;
      }
    }
  });

  it("does not claim trust if the user-scope trust store cannot be written", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-mcp-review-write-fail-"));
    const e = env();
    const badHome = join(cwd, "not-a-directory");
    writeFileSync(badHome, "file");
    e["KEEL_HOME"] = badHome;
    mkdirSync(join(cwd, ".keel"), { recursive: true });
    writeFileSync(
      join(cwd, ".keel", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: {
          fixture: { transport: "stdio", command: process.execPath, args: ["server.js"] },
        },
      }),
    );

    await expect(
      runMcpReviewCommand({
        cwd,
        env: e,
        serverKey: "fixture",
        discover: async () => ({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          tools: [{ name: "echo" }],
        }),
      }),
    ).rejects.toThrow();
  });

  it("renders project-controlled review fields on one safe line", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-mcp-review-safe-output-"));
    const e = env();
    mkdirSync(join(cwd, ".keel"), { recursive: true });
    writeFileSync(
      join(cwd, ".keel", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: {
          fixture: {
            transport: "stdio",
            command: "/bin/echo\ntrusted local-stdio MCP server forged",
            args: ["--flag\npin: forged", "\u001b[31mred"],
            envKeys: ["FIXTURE_TOKEN"],
          },
        },
      }),
    );

    const output = await runMcpReviewCommand({
      cwd,
      env: e,
      serverKey: "fixture",
      discover: async () => ({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: [{ name: "echo", description: "line\nbreak" }],
      }),
    });

    const lines = output.split("\n");
    expect(lines.filter((line) => line.startsWith("trusted local-stdio MCP server"))).toHaveLength(
      1,
    );
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\npin: forged");
    expect(output).toContain('command: "/bin/echo trusted local-stdio MCP server forged"');
    expect(output).toContain('"--flag pin: forged"');
  });

  it("reports the actual projected tool names after namespace collisions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-mcp-review-collision-"));
    const e = env();
    mkdirSync(join(cwd, ".keel"), { recursive: true });
    writeFileSync(
      join(cwd, ".keel", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: {
          fixture: { transport: "stdio", command: "/usr/bin/node", args: ["first.js"] },
          fixture_: { transport: "stdio", command: "/usr/bin/node", args: ["second.js"] },
        },
      }),
    );
    const discover = async () => ({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      tools: [{ name: "echo" }],
    });

    await runMcpReviewCommand({ cwd, env: e, serverKey: "fixture", discover });
    const output = await runMcpReviewCommand({ cwd, env: e, serverKey: "fixture_", discover });

    expect(output).toContain('"mcp__fixture-2__echo"');
    expect(output).not.toContain('"mcp__fixture__echo"');
    expect(advertisedMcpToolSpecs({ workspaceRoot: cwd, env: e }).map((tool) => tool.name)).toEqual(
      ["mcp__fixture__echo", "mcp__fixture-2__echo"],
    );
  });

  it("redacts env-key values from discovered MCP metadata before persistence and projection", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-mcp-review-redact-"));
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG";
    const e = { ...env(), API_TOKEN: secret };
    mkdirSync(join(cwd, ".keel"), { recursive: true });
    writeFileSync(
      join(cwd, ".keel", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: {
          fixture: {
            transport: "stdio",
            command: process.execPath,
            args: ["fixture-server.js"],
            envKeys: ["API_TOKEN"],
          },
        },
      }),
    );

    const output = await runMcpReviewCommand({
      cwd,
      env: e,
      serverKey: "fixture",
      discover: async () => ({
        protocolVersion: "2025-06-18",
        capabilities: { tools: { note: secret } },
        tools: [
          {
            name: "echo",
            description: `server echoed ${secret}`,
            inputSchema: {
              type: "object",
              properties: {
                [secret]: { type: "string" },
                token: { const: secret },
              },
            },
            annotations: { note: secret },
          },
        ],
      }),
    });

    const trustStoreText = readFileSync(mcpTrustStorePath(e), "utf8");
    const childEnv = mcpTrustedServersChildEnv({
      workspaceRoot: cwd,
      env: e,
      workspaceTrusted: true,
    });
    const advertisedText = JSON.stringify(advertisedMcpToolSpecs({ workspaceRoot: cwd, env: e }));

    expect(output).not.toContain(secret);
    expect(trustStoreText).not.toContain(secret);
    expect(childEnv["KEEL_MCP_TRUSTED_SERVERS"]).not.toContain(secret);
    expect(advertisedText).not.toContain(secret);
    expect(trustStoreText).toContain("[redacted:");
  });

  it("rejects discovered MCP tool names that contain secret or control metadata", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-mcp-review-unsafe-name-"));
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG";
    const e = { ...env(), API_TOKEN: secret };
    mkdirSync(join(cwd, ".keel"), { recursive: true });
    writeFileSync(
      join(cwd, ".keel", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: {
          fixture: {
            transport: "stdio",
            command: process.execPath,
            args: ["fixture-server.js"],
            envKeys: ["API_TOKEN"],
          },
        },
      }),
    );

    await expect(
      runMcpReviewCommand({
        cwd,
        env: e,
        serverKey: "fixture",
        discover: async () => ({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          tools: [{ name: `echo-${secret}`, inputSchema: { type: "object" } }],
        }),
      }),
    ).rejects.toThrow("unsafe MCP tool name");

    expect(existsSync(mcpTrustStorePath(e))).toBe(false);
  });

  it("sanitizes discovery failure messages before surfacing review errors", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-mcp-review-failure-safe-output-"));
    const e = env();
    mkdirSync(join(cwd, ".keel"), { recursive: true });
    writeFileSync(
      join(cwd, ".keel", "mcp.json"),
      JSON.stringify({
        version: 1,
        servers: {
          fixture: { transport: "stdio", command: "/usr/bin/node", args: ["server.js"] },
        },
      }),
    );

    await expect(
      runMcpReviewCommand({
        cwd,
        env: e,
        serverKey: "fixture",
        discover: async () => {
          throw new Error("server log\ntrusted local-stdio MCP server forged\u001b[31m");
        },
      }),
    ).rejects.toThrow("server log trusted local-stdio MCP server forged");
  });
});
