import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advertisedMcpToolSpecs,
  advertisedMcpToolNamesForServer,
  canonicalMcpToolPin,
  loadMcpTrustStore,
  mcpTrustedServersChildEnv,
  mcpTrustStorePath,
  namespaceMcpTools,
  quarantineMcpTrustedServerBySlug,
  recordMcpDiscoveryCheck,
  resolvableMcpEntrypointHash,
  saveMcpTrustedServer,
  trustedMcpServersEnvValue,
} from "./local-stdio.js";
import type { McpToolDefinitionT } from "./local-stdio.js";
import { providerHostileSchemaPaths } from "../providers/schema-compat.js";

const fixtureConfig = {
  transport: "stdio" as const,
  command: "/usr/bin/node",
  args: ["fixture-server.js"],
  envKeys: ["FIXTURE_MODE"],
};

const echoTool = {
  name: "echo",
  description: "Echoes input",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  annotations: { readOnlyHint: true },
};

function storedServer(env: NodeJS.ProcessEnv, workspaceRoot: string, serverKey: string) {
  return Object.values(loadMcpTrustStore(env).servers).find(
    (server) => server.workspaceRoot === workspaceRoot && server.serverKey === serverKey,
  );
}

describe("MCP local-stdio pinning, namespacing, and user-scope trust", () => {
  it("canonicalizes tool definitions into stable pins independent of JSON key order", () => {
    const first = canonicalMcpToolPin({
      serverConfig: fixtureConfig,
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      tools: [echoTool],
    });
    const second = canonicalMcpToolPin({
      capabilities: { tools: {} },
      tools: [
        {
          annotations: { readOnlyHint: true },
          inputSchema: {
            required: ["text"],
            properties: { text: { type: "string" } },
            type: "object",
          },
          description: "Echoes input",
          name: "echo",
        },
      ],
      protocolVersion: "2025-06-18",
      serverConfig: {
        args: ["fixture-server.js"],
        command: "/usr/bin/node",
        envKeys: ["FIXTURE_MODE"],
        transport: "stdio",
      },
    });

    expect(second).toBe(first);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects malformed discovered tool definitions before pinning", () => {
    const invalidTool = { name: "echo", inputSchema: [] } as unknown as McpToolDefinitionT;

    expect(() =>
      canonicalMcpToolPin({
        serverConfig: fixtureConfig,
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: [invalidTool],
      }),
    ).toThrow();
  });

  it("includes resolvable stdio entrypoint hashes in canonical pins", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-mcp-entrypoint-hash-"));
    const command = join(workspaceRoot, "server.cjs");
    const serverConfig = { ...fixtureConfig, command: "./server.cjs" };
    writeFileSync(command, "console.log('first');\n");
    const firstHash = resolvableMcpEntrypointHash(serverConfig, workspaceRoot);
    if (firstHash === undefined) throw new Error("expected resolvable first entrypoint hash");
    const firstPin = canonicalMcpToolPin({
      serverConfig,
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      tools: [echoTool],
      entrypointHash: firstHash,
    });

    writeFileSync(command, "console.log('second');\n");
    const secondHash = resolvableMcpEntrypointHash(serverConfig, workspaceRoot);
    if (secondHash === undefined) throw new Error("expected resolvable second entrypoint hash");
    const secondPin = canonicalMcpToolPin({
      serverConfig,
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      tools: [echoTool],
      entrypointHash: secondHash,
    });

    expect(firstHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(secondHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(secondHash).not.toBe(firstHash);
    expect(secondPin).not.toBe(firstPin);
  });

  it("namespaces hostile, duplicate, and overlong tool names without shadowing built-ins", () => {
    const namespaced = namespaceMcpTools(
      [
        { serverKey: "Fixture", tools: [{ ...echoTool, name: "bash" }] },
        { serverKey: "fixture", tools: [{ ...echoTool, name: "bash" }] },
        { serverKey: "Long Server", tools: [{ ...echoTool, name: "x".repeat(90) }] },
      ],
      { providerToolNameLimit: 64 },
    );

    expect(namespaced.map((tool) => tool.advertisedName)).toEqual([
      "mcp__fixture__bash",
      "mcp__fixture-2__bash",
      expect.stringMatching(/^mcp__long-server__x+[0-9a-f]{6}$/),
    ]);
    expect(namespaced[2]?.advertisedName).toHaveLength(64);
    expect(namespaced.some((tool) => tool.advertisedName === "bash")).toBe(false);
    expect(
      namespaceMcpTools(
        [
          {
            serverKey: "!!!",
            tools: [
              { ...echoTool, name: "same" },
              { ...echoTool, name: "same" },
            ],
          },
        ],
        { providerToolNameLimit: 32 },
      ).map((tool) => tool.advertisedName),
    ).toEqual(["mcp__server__same", "mcp__server__same-2"]);
  });

  it("sanitizes model-facing tool names while preserving original server tool names", () => {
    const namespaced = namespaceMcpTools([
      {
        serverKey: "Fixture",
        tools: [
          { ...echoTool, name: "Read File / ./weird\nname" },
          { ...echoTool, name: "read file weird name" },
        ],
      },
    ]);

    expect(namespaced.map((tool) => tool.advertisedName)).toEqual([
      "mcp__fixture__read-file-weird-name",
      "mcp__fixture__read-file-weird-name-2",
    ]);
    expect(namespaced.map((tool) => tool.originalName)).toEqual([
      "Read File / ./weird\nname",
      "read file weird name",
    ]);
  });

  it("persists trusted pins under keelHome and advertises only trusted pinned tools", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-mcp-home-"));
    const env = { KEEL_HOME: keelHome };
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-mcp-ws-"));
    const pin = canonicalMcpToolPin({
      serverConfig: fixtureConfig,
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      tools: [echoTool],
    });

    saveMcpTrustedServer(
      {
        workspaceRoot,
        serverKey: "fixture",
        serverConfig: fixtureConfig,
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: [echoTool],
        pin,
      },
      env,
    );

    expect(existsSync(mcpTrustStorePath(env))).toBe(true);
    expect(existsSync(join(workspaceRoot, "mcp-trust.json"))).toBe(false);
    expect(readFileSync(mcpTrustStorePath(env), "utf8")).toContain(pin);
    expect(storedServer(env, workspaceRoot, "fixture")?.pin).toBe(pin);
    const advertised = advertisedMcpToolSpecs({ workspaceRoot, env });
    expect(advertised.map((tool) => tool.name)).toEqual(["mcp__fixture__echo"]);
    expect(advertised[0]?.description).toContain("Governed local-stdio MCP tool");
    expect(advertised[0]?.description).toContain("opaque side effects");
    expect(
      advertisedMcpToolSpecs({ workspaceRoot, env, providerToolNameLimit: 16 }).map(
        (tool) => tool.name,
      ),
    ).toEqual([expect.stringMatching(/^mcp__fixtu[0-9a-f]{6}$/)]);
  });

  it("sanitizes projected MCP input schemas for provider compatibility", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-mcp-home-provider-schema-"));
    const env = { KEEL_HOME: keelHome };
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-mcp-ws-provider-schema-"));
    const tool = {
      name: "echo",
      description: "Echoes input",
      inputSchema: {
        type: "object",
        dependencies: { text: ["mode"] },
        allOf: [{ required: ["text"] }],
        properties: {
          text: { type: "string", const: "hello" },
          mode: { anyOf: [{ type: "string" }, { type: "number" }] },
          nested: { items: { oneOf: [{ type: "string" }] } },
        },
      },
    };
    const pin = canonicalMcpToolPin({
      serverConfig: fixtureConfig,
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      tools: [tool],
    });
    saveMcpTrustedServer(
      {
        workspaceRoot,
        serverKey: "fixture",
        serverConfig: fixtureConfig,
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: [tool],
        pin,
      },
      env,
    );

    const advertised = advertisedMcpToolSpecs({ workspaceRoot, env });
    expect(providerHostileSchemaPaths(advertised[0]?.parameters)).toEqual([]);
    expect(advertised[0]?.parameters?.["type"]).toBe("object");
    expect(advertised[0]?.parameters?.["additionalProperties"]).toBe(true);
    expect(advertised[0]?.parameters?.["description"]).toContain(
      "constraints omitted for provider compatibility",
    );
    expect(Object.hasOwn(advertised[0]?.parameters ?? {}, "properties")).toBe(false);
  });

  it("caps projected MCP tool definitions before model advertisement", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-mcp-home-caps-"));
    const env = { KEEL_HOME: keelHome };
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-mcp-ws-caps-"));
    const tools = Array.from({ length: 40 }, (_, index) => ({
      name: `tool-${index}`,
      description: index === 0 ? "x".repeat(2_000) : "small",
      inputSchema:
        index === 0
          ? { type: "object", properties: { huge: { enum: Array(2_000).fill("value") } } }
          : { type: "object" },
    }));
    const pin = canonicalMcpToolPin({
      serverConfig: fixtureConfig,
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      tools,
    });
    saveMcpTrustedServer(
      {
        workspaceRoot,
        serverKey: "fixture",
        serverConfig: fixtureConfig,
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools,
        pin,
      },
      env,
    );

    const advertised = advertisedMcpToolSpecs({ workspaceRoot, env });
    expect(advertised).toHaveLength(32);
    expect(advertised[0]?.description).toContain("[truncated:mcp-description]");
    const cappedParameters = advertised[0]?.parameters as { readonly description?: string };
    expect(cappedParameters.description).toContain("schema omitted");
  });

  it("re-quarantines changed definitions and distrusts repeated pin flaps", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-mcp-home-flap-"));
    const env = { KEEL_HOME: keelHome };
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-mcp-ws-flap-"));
    const firstPin = canonicalMcpToolPin({
      serverConfig: fixtureConfig,
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      tools: [echoTool],
    });
    saveMcpTrustedServer(
      {
        workspaceRoot,
        serverKey: "fixture",
        serverConfig: fixtureConfig,
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: [echoTool],
        pin: firstPin,
      },
      env,
    );

    const changedTool = { ...echoTool, description: "Different definition" };
    const firstChange = recordMcpDiscoveryCheck(
      {
        workspaceRoot,
        serverKey: "fixture",
        serverConfig: fixtureConfig,
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: [changedTool],
      },
      env,
    );
    expect(firstChange).toMatchObject({ state: "quarantined", changed: true, flapCount: 1 });
    expect(storedServer(env, workspaceRoot, "fixture")?.state).toBe("quarantined");
    expect(advertisedMcpToolSpecs({ workspaceRoot, env })).toEqual([]);

    const sameChangedAgain = recordMcpDiscoveryCheck(
      {
        workspaceRoot,
        serverKey: "fixture",
        serverConfig: fixtureConfig,
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: [changedTool],
      },
      env,
    );
    expect(sameChangedAgain).toMatchObject({
      state: "quarantined",
      changed: false,
      flapCount: 1,
    });
    expect(advertisedMcpToolSpecs({ workspaceRoot, env })).toEqual([]);

    recordMcpDiscoveryCheck(
      {
        workspaceRoot,
        serverKey: "fixture",
        serverConfig: fixtureConfig,
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: [{ ...echoTool, description: "Second definition" }],
      },
      env,
    );
    const thirdChange = recordMcpDiscoveryCheck(
      {
        workspaceRoot,
        serverKey: "fixture",
        serverConfig: fixtureConfig,
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: [{ ...echoTool, description: "Third definition" }],
      },
      env,
    );
    expect(thirdChange).toMatchObject({ state: "distrusted", changed: true, flapCount: 3 });
    expect(storedServer(env, workspaceRoot, "fixture")?.state).toBe("distrusted");
  });

  it("scopes trusted pins by workspace root when server keys collide", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-mcp-home-workspace-scope-"));
    const env = { KEEL_HOME: keelHome };
    const firstWorkspace = mkdtempSync(join(tmpdir(), "keel-mcp-ws-scope-a-"));
    const secondWorkspace = mkdtempSync(join(tmpdir(), "keel-mcp-ws-scope-b-"));
    const firstPin = canonicalMcpToolPin({
      serverConfig: { ...fixtureConfig, args: ["first.js"] },
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      tools: [{ ...echoTool, description: "first" }],
    });
    const secondPin = canonicalMcpToolPin({
      serverConfig: { ...fixtureConfig, args: ["second.js"] },
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      tools: [{ ...echoTool, description: "second" }],
    });

    saveMcpTrustedServer(
      {
        workspaceRoot: firstWorkspace,
        serverKey: "fixture",
        serverConfig: { ...fixtureConfig, args: ["first.js"] },
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: [{ ...echoTool, description: "first" }],
        pin: firstPin,
      },
      env,
    );
    saveMcpTrustedServer(
      {
        workspaceRoot: secondWorkspace,
        serverKey: "fixture",
        serverConfig: { ...fixtureConfig, args: ["second.js"] },
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: [{ ...echoTool, description: "second" }],
        pin: secondPin,
      },
      env,
    );

    expect(storedServer(env, firstWorkspace, "fixture")?.pin).toBe(firstPin);
    expect(storedServer(env, secondWorkspace, "fixture")?.pin).toBe(secondPin);
    expect(Object.values(loadMcpTrustStore(env).servers)).toHaveLength(2);
    expect(
      advertisedMcpToolSpecs({ workspaceRoot: firstWorkspace, env })[0]?.description,
    ).toContain("first");
    expect(
      advertisedMcpToolSpecs({ workspaceRoot: secondWorkspace, env })[0]?.description,
    ).toContain("second");
  });

  it("migrates legacy server-key trust records to workspace-scoped records", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-mcp-home-legacy-key-"));
    const env = { KEEL_HOME: keelHome };
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-mcp-ws-legacy-key-"));
    const pin = canonicalMcpToolPin({
      serverConfig: fixtureConfig,
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      tools: [echoTool],
    });
    writeFileSync(
      mcpTrustStorePath(env),
      JSON.stringify({
        version: 1,
        servers: {
          fixture: {
            workspaceRoot,
            serverKey: "fixture",
            serverConfig: fixtureConfig,
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            tools: [echoTool],
            pin,
            trustedAt: new Date().toISOString(),
            state: "trusted",
            flapCount: 0,
          },
        },
      }),
    );

    expect(
      recordMcpDiscoveryCheck(
        {
          workspaceRoot,
          serverKey: "fixture",
          serverConfig: fixtureConfig,
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          tools: [echoTool],
        },
        env,
      ),
    ).toMatchObject({ state: "trusted", changed: false });
    expect(loadMcpTrustStore(env).servers["fixture"]).toBeUndefined();
    expect(storedServer(env, workspaceRoot, "fixture")?.pin).toBe(pin);
  });

  it("quarantines a trusted server by projected slug after invocation-time pin mismatch", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-mcp-home-quarantine-slug-"));
    const env = { KEEL_HOME: keelHome };
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-mcp-ws-quarantine-slug-"));
    const pin = canonicalMcpToolPin({
      serverConfig: fixtureConfig,
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      tools: [echoTool],
    });
    saveMcpTrustedServer(
      {
        workspaceRoot,
        serverKey: "Fixture",
        serverConfig: fixtureConfig,
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: [echoTool],
        pin,
      },
      env,
    );

    const result = quarantineMcpTrustedServerBySlug(
      {
        workspaceRoot,
        serverSlug: "fixture",
        expectedPin: pin,
        observedPin: `sha256:${"2".repeat(64)}`,
        reason: "pin-mismatch",
      },
      env,
    );

    expect(result).toMatchObject({ changed: true, serverKey: "Fixture", state: "quarantined" });
    expect(storedServer(env, workspaceRoot, "Fixture")?.state).toBe("quarantined");
    expect(advertisedMcpToolSpecs({ workspaceRoot, env })).toEqual([]);

    expect(
      quarantineMcpTrustedServerBySlug(
        {
          workspaceRoot,
          serverSlug: "fixture",
          expectedPin: pin,
          observedPin: `sha256:${"3".repeat(64)}`,
          reason: "pin-mismatch",
        },
        env,
      ),
    ).toMatchObject({ changed: true, serverKey: "Fixture", state: "quarantined", flapCount: 2 });
    expect(
      quarantineMcpTrustedServerBySlug(
        {
          workspaceRoot,
          serverSlug: "fixture",
          expectedPin: `sha256:${"4".repeat(64)}`,
          observedPin: `sha256:${"5".repeat(64)}`,
          reason: "pin-mismatch",
        },
        env,
      ),
    ).toEqual({ changed: false });
    expect(
      quarantineMcpTrustedServerBySlug(
        {
          workspaceRoot,
          serverSlug: "fixture",
          observedPin: `sha256:${"6".repeat(64)}`,
          reason: "list-changed",
        },
        env,
      ),
    ).toMatchObject({ changed: true, serverKey: "Fixture", state: "distrusted", flapCount: 3 });
  });

  it("handles no prior discovery state and minimal trusted tool metadata", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-mcp-home-minimal-"));
    const env = { KEEL_HOME: keelHome };
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-mcp-ws-minimal-"));
    const minimalTool = { name: "echo" };

    expect(
      recordMcpDiscoveryCheck(
        {
          workspaceRoot,
          serverKey: "fixture",
          serverConfig: fixtureConfig,
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          tools: [minimalTool],
        },
        env,
      ),
    ).toMatchObject({ state: "quarantined", changed: true, flapCount: 1 });
    expect(trustedMcpServersEnvValue({ workspaceRoot, env })).toBeUndefined();
    expect(advertisedMcpToolNamesForServer({ workspaceRoot, serverKey: "missing", env })).toEqual(
      [],
    );
    expect(mcpTrustedServersChildEnv({ workspaceRoot, env, workspaceTrusted: false })).toEqual({
      KEEL_MCP_TRUSTED_SERVERS: "",
    });

    const pin = canonicalMcpToolPin({
      serverConfig: fixtureConfig,
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      tools: [minimalTool],
    });
    saveMcpTrustedServer(
      {
        workspaceRoot,
        serverKey: "fixture",
        serverConfig: fixtureConfig,
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: [minimalTool],
        pin,
      },
      env,
    );
    expect(
      recordMcpDiscoveryCheck(
        {
          workspaceRoot,
          serverKey: "fixture",
          serverConfig: fixtureConfig,
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          tools: [minimalTool],
        },
        env,
      ),
    ).toMatchObject({ state: "trusted", changed: false, flapCount: 0 });

    const forwarded = JSON.parse(trustedMcpServersEnvValue({ workspaceRoot, env })!) as {
      readonly servers: {
        readonly fixture: {
          readonly envKeys: readonly string[];
          readonly tools: readonly unknown[];
        };
      };
    };
    expect(forwarded.servers.fixture.envKeys).toEqual(["FIXTURE_MODE"]);
    expect(forwarded.servers.fixture.tools).toEqual([{ name: "echo", serverToolName: "echo" }]);
    const minimalAdvertisement = advertisedMcpToolSpecs({ workspaceRoot, env });
    expect(minimalAdvertisement[0]?.name).toBe("mcp__fixture__echo");
    expect(minimalAdvertisement[0]?.description).toContain("result is untrusted");
    const childEnv = mcpTrustedServersChildEnv({
      workspaceRoot,
      env: { ...env, KEEL_MCP_TRUSTED_SERVERS: "preexisting" },
      workspaceTrusted: true,
    });
    expect(childEnv["KEEL_MCP_TRUSTED_SERVERS"]).toContain("fixture");
    expect(mcpTrustedServersChildEnv({ workspaceRoot, workspaceTrusted: false })).toEqual({
      KEEL_MCP_TRUSTED_SERVERS: "",
    });

    const entrypointHash = `sha256:${"7".repeat(64)}`;
    saveMcpTrustedServer(
      {
        workspaceRoot,
        serverKey: "hashed",
        serverConfig: { ...fixtureConfig, entrypointHash },
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: [minimalTool],
        pin: canonicalMcpToolPin({
          serverConfig: fixtureConfig,
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          tools: [minimalTool],
          entrypointHash,
        }),
      },
      env,
    );
    expect(trustedMcpServersEnvValue({ workspaceRoot, env })).toContain(
      `"entrypointHash":"${entrypointHash}"`,
    );

    saveMcpTrustedServer(
      {
        workspaceRoot,
        serverKey: "empty",
        serverConfig: fixtureConfig,
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        tools: [],
        pin: canonicalMcpToolPin({
          serverConfig: fixtureConfig,
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          tools: [],
        }),
      },
      env,
    );
    expect(trustedMcpServersEnvValue({ workspaceRoot, env })).toContain('"empty"');
  });
});
