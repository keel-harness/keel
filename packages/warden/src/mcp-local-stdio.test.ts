import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIDE_EFFECT_TAXONOMY_VERSION, isRetryEligible, type WARDEN_METHODS } from "@keel/shared";
import {
  buildMcpOpaquePolicyInput,
  buildMcpSandboxProfile,
  canonicalMcpToolPinForLaunch,
  discoverMcpServerWithSandbox,
  encodeTrustedMcpServersEnv,
  inertMcpResourceLinks,
  MCP_TRUSTED_SERVERS_ENV,
  mcpHasSecretSensitiveArgs,
  mcpSandboxCommand,
  mcpSandboxResultIsError,
  mcpTrustedServersFromEnv,
  modelTextFromMcpSandboxResult,
  parseMcpDiscoveryResult,
  refuseUnsupportedMcpClientRequest,
  sanitizeMcpText,
  withMcpSensitivityPolicy,
} from "./mcp/local-stdio.js";
import type { PolicyPort } from "./policy.js";
import type { SandboxPort, SandboxProfile } from "./sandbox.js";

type ExecuteParams = ReturnType<(typeof WARDEN_METHODS)["warden.execute"]["params"]["parse"]>;

const baseParams: ExecuteParams = {
  sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  toolCall: {
    id: "tc_mcp",
    name: "mcp__fixture__echo",
    args: { text: "hello" },
  },
  provenanceContext: { inputTags: ["workspace"] },
};

describe("MCP local-stdio policy and result boundaries", () => {
  it("builds a broad opaque conservative side effect that is never retry eligible", () => {
    const input = buildMcpOpaquePolicyInput(baseParams, {
      workspaceRoot: "/workspace",
      workspaceTrusted: true,
      env: { USER: "tester" },
    });

    expect(input.sideEffect.taxonomyVersion).toBe(SIDE_EFFECT_TAXONOMY_VERSION);
    expect(input.sideEffect.staticCapability).toEqual({
      toolName: "mcp__fixture__echo",
      effectEnvelope: ["fs_read", "fs_write", "network_read", "network_write", "process_exec"],
      broad: true,
    });
    expect(input.sideEffect.dynamic.classifier).toMatchObject({
      confidence: "conservative",
    });
    expect(input.sideEffect.dynamic.classifier.reasons).toContain("mcp_opaque");
    expect(isRetryEligible(input.sideEffect)).toBe(false);
  });

  it("marks secret-looking arguments for POL-012-MCP review independent of provenance", () => {
    const input = buildMcpOpaquePolicyInput(
      {
        ...baseParams,
        toolCall: {
          ...baseParams.toolCall,
          args: { path: ".env", token: "sk-test-1234567890abcdef" },
        },
      },
      { workspaceRoot: "/workspace", workspaceTrusted: true, env: { USER: "tester" } },
    );

    expect(input.sideEffect.dynamic.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "path",
          normalized: "/workspace/.env",
          sensitivity: "secret",
        }),
        expect.objectContaining({ kind: "env_var", sensitivity: "secret" }),
      ]),
    );
  });

  it("applies POL-012-MCP through a policy-port wrapper", async () => {
    const basePolicy: PolicyPort = {
      packRef: { name: "test", hash: `sha256:${"1".repeat(64)}` },
      evaluate: async () => ({ verdict: "allow", matchedRules: [] }),
    };
    const decision = await withMcpSensitivityPolicy(basePolicy).evaluate(
      buildMcpOpaquePolicyInput(
        {
          ...baseParams,
          toolCall: { ...baseParams.toolCall, args: { token: "sk-test-secret" } },
        },
        { workspaceRoot: "/workspace", env: {} },
      ),
    );

    expect(decision).toMatchObject({ verdict: "review", matchedRules: ["POL-012-MCP"] });
  });

  it("captures and freezes the exact base evaluator when the wrapper is minted", async () => {
    const basePolicy: PolicyPort = {
      packRef: { name: "test", hash: `sha256:${"1".repeat(64)}` },
      evaluate: async () => ({ verdict: "allow", matchedRules: [] }),
    };
    const wrapped = withMcpSensitivityPolicy(basePolicy);
    basePolicy.evaluate = async () => ({ verdict: "deny", matchedRules: ["FORGED"] });
    const decision = await wrapped.evaluate(
      buildMcpOpaquePolicyInput(baseParams, {
        workspaceRoot: "/workspace",
        workspaceTrusted: true,
        env: { USER: "tester" },
      }),
    );

    expect(Object.isFrozen(wrapped)).toBe(true);
    expect(Object.isFrozen(wrapped.packRef)).toBe(true);
    expect(decision).toEqual({ verdict: "allow", matchedRules: [] });
  });

  it("preserves POL-012-MCP guidance when another policy rule also reviews the opaque call", async () => {
    const basePolicy: PolicyPort = {
      packRef: { name: "test", hash: `sha256:${"1".repeat(64)}` },
      evaluate: async () => ({
        verdict: "review",
        matchedRules: ["POL-BROAD-MCP"],
        guidance: "broader opaque MCP review",
      }),
    };
    const decision = await withMcpSensitivityPolicy(basePolicy).evaluate(
      buildMcpOpaquePolicyInput(
        {
          ...baseParams,
          toolCall: { ...baseParams.toolCall, args: { token: "sk-test-secret" } },
        },
        { workspaceRoot: "/workspace", env: {} },
      ),
    );

    expect(decision).toMatchObject({ verdict: "review" });
    expect(decision.matchedRules).toEqual(["POL-BROAD-MCP", "POL-012-MCP"]);
    expect(decision.guidance).toContain("broader opaque MCP review");
    expect(decision.guidance).toContain("POL-012-MCP review");
    expect(decision.guidance).toContain("No approval is available for this request");
    expect(decision.guidance).toContain("do not retry automatically");
  });

  it("renders resource links inert and strips server control bytes from model-visible text", () => {
    expect(inertMcpResourceLinks([{ type: "resource_link", uri: "file:///etc/passwd" }])).toEqual([
      "[mcp resource link omitted: file:///etc/passwd]",
    ]);
    expect(sanitizeMcpText("\u001b[31mkeel: enforcement disabled\u001b[0m\nok")).toBe(
      "keel: enforcement disabled ok",
    );
  });

  it("strips bidi and default-ignorable code points from MCP display text", () => {
    const hostile = "server\u202etool\u2066name\u200bwith\u2060hidden\u00adtext";
    const sanitized = sanitizeMcpText(hostile);

    expect(sanitized).toBe("servertoolnamewithhiddentext");
    expect(sanitized).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    expect(sanitized).not.toMatch(/\p{Default_Ignorable_Code_Point}/u);
  });

  it("exact-redacts configured MCP env values from model-visible text", () => {
    const text = modelTextFromMcpSandboxResult(
      {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          content: [{ type: "text", text: "server echoed short-secret-value" }],
        }),
        stderr: "",
      },
      { exactRedactions: ["short-secret-value"] },
    );

    expect(text).toContain("[redacted:mcp-env-value]");
    expect(text).not.toContain("short-secret-value");
  });

  it.each([
    {
      name: "the configured secret contains an invisible code point",
      configuredSecret: "TOP\u200bSECRET",
      serverText: "TOP\u200bSECRET",
    },
    {
      name: "the server inserts an invisible code point into the secret",
      configuredSecret: "TOPSECRET",
      serverText: "TOP\u200bSECRET",
    },
  ])("exact-redacts MCP env values when $name", ({ configuredSecret, serverText }) => {
    const text = sanitizeMcpText(`server echoed ${serverText}`, {
      exactRedactions: [configuredSecret],
    });

    expect(text).toContain("[redacted:mcp-env-value]");
    expect(text).not.toContain("TOPSECRET");
    expect(text).not.toContain("TOP\u200bSECRET");
  });

  it("refuses non-tools MCP protocol surfaces", () => {
    expect(refuseUnsupportedMcpClientRequest("resources/read")).toMatchObject({
      ok: false,
      code: "MCP_CAPABILITY_NOT_SUPPORTED",
    });
    expect(refuseUnsupportedMcpClientRequest("prompts/get")).toMatchObject({
      ok: false,
      code: "MCP_CAPABILITY_NOT_SUPPORTED",
    });
    expect(refuseUnsupportedMcpClientRequest("sampling/createMessage")).toMatchObject({
      ok: false,
      code: "MCP_CAPABILITY_NOT_SUPPORTED",
    });
  });

  it("parses trusted MCP server pins from the internal warden env and fails closed on malformed input", () => {
    const good = mcpTrustedServersFromEnv({
      [MCP_TRUSTED_SERVERS_ENV]: JSON.stringify({
        version: 1,
        servers: {
          fixture: {
            transport: "stdio",
            command: "/usr/bin/node",
            args: ["fixture-server.js"],
            envKeys: [],
            pin: `sha256:${"a".repeat(64)}`,
            tools: [{ name: "echo", inputSchema: { type: "object" } }],
          },
        },
      }),
    });
    expect(good["fixture"]?.pin).toBe(`sha256:${"a".repeat(64)}`);
    const encoded = encodeTrustedMcpServersEnv({
      fixture: {
        transport: "stdio",
        command: "/usr/bin/node",
        args: ["fixture-server.js"],
        envKeys: ["API_TOKEN"],
        entrypointHash: null,
        pin: `sha256:${"a".repeat(64)}`,
        tools: [{ name: "echo", inputSchema: { type: "object" } }],
      },
    });
    expect(encoded).toContain("envKeys");
    expect(encoded).not.toContain("secret-value");
    expect(mcpTrustedServersFromEnv({ [MCP_TRUSTED_SERVERS_ENV]: encoded })).toMatchObject({
      fixture: { envKeys: ["API_TOKEN"], entrypointHash: null },
    });

    expect(mcpTrustedServersFromEnv({ [MCP_TRUSTED_SERVERS_ENV]: "not json" })).toEqual({});
    expect(
      mcpTrustedServersFromEnv({
        [MCP_TRUSTED_SERVERS_ENV]: JSON.stringify({
          version: 1,
          servers: {
            remote: {
              transport: "http",
              command: "/usr/bin/node",
              args: [],
              envKeys: [],
              pin: `sha256:${"b".repeat(64)}`,
              tools: [{ name: "echo" }],
            },
          },
        }),
      }),
    ).toEqual({});
  });

  it("fails closed for malformed trusted MCP env shapes", () => {
    const pin = `sha256:${"c".repeat(64)}`;
    const baseServer = {
      transport: "stdio",
      command: "/usr/bin/node",
      args: ["server.js"],
      envKeys: [],
      pin,
      tools: [{ name: "echo" }],
    };
    const cases: readonly unknown[] = [
      "",
      JSON.stringify({ version: 2, servers: {} }),
      JSON.stringify({ version: 1, servers: [] }),
      JSON.stringify({ version: 1, servers: { Bad_ID: baseServer } }),
      JSON.stringify({ version: 1, servers: { fixture: null } }),
      JSON.stringify({ version: 1, servers: { fixture: { ...baseServer, command: "" } } }),
      JSON.stringify({ version: 1, servers: { fixture: { ...baseServer, args: ["ok", 1] } } }),
      JSON.stringify({ version: 1, servers: { fixture: { ...baseServer, envKeys: [1] } } }),
      JSON.stringify({
        version: 1,
        servers: { fixture: { ...baseServer, entrypointHash: 1 } },
      }),
      JSON.stringify({
        version: 1,
        servers: { fixture: { ...baseServer, entrypointHash: "bad" } },
      }),
      JSON.stringify({ version: 1, servers: { fixture: { ...baseServer, env: { A: 1 } } } }),
      JSON.stringify({ version: 1, servers: { fixture: { ...baseServer, pin: "bad" } } }),
      JSON.stringify({ version: 1, servers: { fixture: { ...baseServer, tools: "nope" } } }),
      JSON.stringify({
        version: 1,
        servers: { fixture: { ...baseServer, tools: [{ name: "" }] } },
      }),
      JSON.stringify({
        version: 1,
        servers: { fixture: { ...baseServer, tools: [{ name: "echo", serverToolName: 1 }] } },
      }),
      JSON.stringify({
        version: 1,
        servers: { fixture: { ...baseServer, tools: [{ name: "echo", inputSchema: [] }] } },
      }),
      JSON.stringify({
        version: 1,
        servers: { fixture: { ...baseServer, tools: [{ name: "echo", annotations: [] }] } },
      }),
    ];

    for (const raw of cases) {
      expect(mcpTrustedServersFromEnv({ [MCP_TRUSTED_SERVERS_ENV]: raw as string })).toEqual({});
    }
    expect(mcpTrustedServersFromEnv({})).toEqual({});
  });

  it("classifies home secret paths and long secret-looking values", () => {
    const input = buildMcpOpaquePolicyInput(
      {
        ...baseParams,
        toolCall: {
          ...baseParams.toolCall,
          args: {
            home: "~",
            ssh: "~/.ssh/id_rsa",
            aws: "~/.aws/credentials",
            gnupg: "~/.gnupg/private",
            netrc: "~/.netrc",
            npmrc: "~/.npmrc",
            environ: "/proc/self/environ",
            nested: [{ password: "x".repeat(44) }],
          },
        },
      },
      {
        workspaceRoot: "/workspace",
        workspaceTrusted: true,
        env: { USER: "tester", HOME: "/home/tester" },
      },
    );

    expect(input.sideEffect.dynamic.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ normalized: "/home/tester", sensitivity: "internal" }),
        expect.objectContaining({ normalized: "/home/tester/.ssh/id_rsa", sensitivity: "secret" }),
        expect.objectContaining({
          normalized: "/home/tester/.aws/credentials",
          sensitivity: "secret",
        }),
        expect.objectContaining({
          normalized: "/home/tester/.gnupg/private",
          sensitivity: "secret",
        }),
        expect.objectContaining({ normalized: "/home/tester/.netrc", sensitivity: "secret" }),
        expect.objectContaining({ normalized: "/home/tester/.npmrc", sensitivity: "secret" }),
        expect.objectContaining({ normalized: "/proc/self/environ", sensitivity: "secret" }),
        expect.objectContaining({ kind: "env_var", value: "mcp.arg.password" }),
      ]),
    );
  });

  it("falls back to raw stdout for non-MCP result JSON and caps oversized model text", () => {
    expect(
      modelTextFromMcpSandboxResult({
        exitCode: 0,
        signal: null,
        stdout: "plain text",
        stderr: "",
      }),
    ).toBe("plain text");
    const capped = modelTextFromMcpSandboxResult({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({ content: [{ type: "text", text: "x".repeat(20_000) }] }),
      stderr: "",
    });
    expect(capped).toContain("[truncated:mcp-result:");
    expect(inertMcpResourceLinks([{ type: "resource" }, null, "x"])).toEqual([
      "[mcp resource link omitted: unknown]",
    ]);
    expect(
      modelTextFromMcpSandboxResult({
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({ content: [null, { type: "text", text: "ok" }] }),
        stderr: "",
      }),
    ).toBe("ok");
  });

  it("uses conservative defaults for primitive args and omitted env/home/user inputs", () => {
    const input = buildMcpOpaquePolicyInput(
      {
        ...baseParams,
        toolCall: {
          ...baseParams.toolCall,
          args: { count: 1, enabled: true, none: null },
        },
      },
      { workspaceRoot: "/workspace", env: {} },
    );

    expect(input.workspace.trusted).toBe(false);
    expect(input.principal.osUser).toBe("local");
    expect(input.sideEffect.dynamic.targets).toEqual([]);
    expect(mcpHasSecretSensitiveArgs(input)).toBe(false);
    expect(
      mcpSandboxCommand(
        {
          transport: "stdio",
          command: "/usr/bin/node",
          args: ["server.js"],
          pin: `sha256:${"d".repeat(64)}`,
          tools: [{ name: "echo" }],
        },
        "echo",
        {},
        { payloadFilePath: join(mkdtempSync(join(tmpdir(), "keel-mcp-command-")), "payload.json") },
      ),
    ).not.toContain('"env"');
    expect(
      mcpSandboxResultIsError({ exitCode: 0, signal: null, stdout: "not json", stderr: "" }),
    ).toBe(true);
  });

  it("parses trusted server optional metadata and includes env/hash data in runner payloads", () => {
    const pin = `sha256:${"d".repeat(64)}`;
    const entrypointHash = `sha256:${"e".repeat(64)}`;
    const env = {
      [MCP_TRUSTED_SERVERS_ENV]: encodeTrustedMcpServersEnv({
        fixture: {
          transport: "stdio",
          command: "/usr/bin/node",
          args: ["server.js"],
          envKeys: ["TOKEN", "API_KEY", "TOKEN"],
          entrypointHash,
          serverKey: "fixture",
          pin,
          tools: [
            {
              name: "mcp__fixture__echo",
              serverToolName: "echo",
              description: "Echoes input",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      }),
    };

    expect(mcpTrustedServersFromEnv(env)["fixture"]).toEqual({
      transport: "stdio",
      command: "/usr/bin/node",
      args: ["server.js"],
      envKeys: ["API_KEY", "TOKEN"],
      entrypointHash,
      serverKey: "fixture",
      pin,
      tools: [
        {
          name: "mcp__fixture__echo",
          serverToolName: "echo",
          description: "Echoes input",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
      ],
    });

    const dir = mkdtempSync(join(tmpdir(), "keel-mcp-command-with-env-"));
    const payloadPath = join(dir, "payload.json");
    expect(
      mcpSandboxCommand(
        {
          transport: "stdio",
          command: "/usr/bin/node",
          args: ["server.js"],
          envKeys: ["API_KEY"],
          entrypointHash,
          pin,
          tools: [{ name: "mcp__fixture__echo", serverToolName: "echo" }],
        },
        "mcp__fixture__echo",
        {},
        { payloadFilePath: payloadPath },
      ),
    ).toContain(`@${payloadPath}`);
    expect(JSON.parse(readFileSync(payloadPath, "utf8"))).toMatchObject({
      server: { envKeys: ["API_KEY"], entrypointHash },
      toolName: "mcp__fixture__echo",
    });
  });

  it("adds per-call declared temp roots to the local-stdio MCP sandbox profile", () => {
    const base = buildMcpSandboxProfile({
      workspaceRoot: "/workspace",
      env: { HOME: "/home/tester" },
    });
    const profile = buildMcpSandboxProfile({
      workspaceRoot: "/workspace",
      env: { HOME: "/home/tester" },
      declaredTempRoots: ["/tmp/keel-mcp-payload"],
    });

    expect(base.filesystem?.allowRead).not.toContain("/tmp/keel-mcp-payload");
    expect(profile.filesystem?.allowRead).toContain("/tmp/keel-mcp-payload");
    expect(profile.filesystem?.allowWrite).toContain("/tmp/keel-mcp-payload");
    expect(profile.network?.allowedDomains).toEqual([]);
  });

  it("does not grant undeclared MCP server temp roots", () => {
    const profile = buildMcpSandboxProfile({
      workspaceRoot: "/workspace",
      env: { HOME: "/home/tester" },
      declaredTempRoots: ["/tmp/keel-mcp-server-a"],
    });

    expect(profile.filesystem?.allowRead).toContain("/tmp/keel-mcp-server-a");
    expect(profile.filesystem?.allowWrite).toContain("/tmp/keel-mcp-server-a");
    expect(profile.filesystem?.allowRead).not.toContain("/tmp/keel-mcp-server-b");
    expect(profile.filesystem?.allowWrite).not.toContain("/tmp/keel-mcp-server-b");
  });

  it("uses process environment defaults for MCP sandbox profiles without widening egress", () => {
    const profile = buildMcpSandboxProfile({ workspaceRoot: "/workspace" });

    expect(profile.filesystem?.allowRead).toContain("/workspace");
    expect(profile.filesystem?.denyRead).toContain("/workspace/.keel");
    expect(profile.network?.allowedDomains).toEqual([]);
  });

  it("denies project keel config and audit paths inside the MCP sandbox profile", () => {
    const profile = buildMcpSandboxProfile({
      workspaceRoot: "/workspace",
      env: { HOME: "/home/tester", KEEL_HOME: "/keel-home" },
      auditDir: "/workspace/.keel/audit",
    });

    expect(profile.filesystem?.allowRead).toContain("/workspace");
    expect(profile.filesystem?.denyRead).toEqual(
      expect.arrayContaining(["/workspace/.keel", "/workspace/.keel/audit", "/keel-home"]),
    );
    expect(profile.filesystem?.denyWrite).toEqual(
      expect.arrayContaining(["/workspace/.keel", "/workspace/.keel/audit", "/keel-home"]),
    );
  });

  it("threads audit and declared temp options into MCP sandbox profiles", () => {
    const profile = buildMcpSandboxProfile({
      workspaceRoot: "/workspace",
      env: { HOME: "/home/tester", KEEL_HOME: "/keel-home" },
      auditDir: "/audit",
      declaredTempRoots: ["/tmp/keel-mcp-payload"],
    });

    expect(profile.filesystem?.allowRead).toEqual(
      expect.arrayContaining(["/workspace", "/tmp/keel-mcp-payload"]),
    );
    expect(profile.filesystem?.allowWrite).toContain("/tmp/keel-mcp-payload");
    expect(profile.filesystem?.denyRead).toEqual(
      expect.arrayContaining(["/workspace/.keel", "/audit"]),
    );
    expect(profile.filesystem?.denyWrite).toEqual(
      expect.arrayContaining(["/workspace/.keel", "/audit"]),
    );
  });

  it("discovers MCP tools through the sandbox helper using an empty-egress profile", async () => {
    const profiles: SandboxProfile[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    let runnerPath = "";
    let payloadPath = "";
    const controller = new AbortController();
    const sandbox: SandboxPort = {
      status: () => ({ available: true, backend: "fake", enforcementTier: "sandboxed" }),
      execute: async (invocation, profile, options) => {
        profiles.push(profile);
        signals.push(options?.signal);
        const runnerMatch = /'([^']+\.runner\.mjs)'/u.exec(invocation.command);
        if (runnerMatch?.[1] === undefined) throw new Error("missing materialized MCP runner");
        runnerPath = runnerMatch[1];
        payloadPath = runnerPath.slice(0, -".runner.mjs".length);
        expect(existsSync(runnerPath)).toBe(true);
        expect(existsSync(payloadPath)).toBe(true);
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            tools: [{ name: "echo", inputSchema: { type: "object" } }],
          }),
          stderr: "",
        };
      },
    };

    const discovery = await discoverMcpServerWithSandbox({
      sandbox,
      workspaceRoot: "/workspace",
      server: { transport: "stdio", command: "/usr/bin/node", args: ["server.js"], envKeys: [] },
      env: { HOME: "/home/tester" },
      auditDir: "/workspace/.keel/audit",
      signal: controller.signal,
      credentialProxyRules: [
        {
          id: "api",
          mode: "placeholder",
          host: "api.example.com",
          scheme: "Bearer",
          source: { kind: "file", path: "secrets/api-token" },
          placeholderEnv: "API_TOKEN",
        },
      ],
    });

    expect(discovery.tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(signals).toEqual([controller.signal]);
    expect(profiles[0]?.network?.allowedDomains).toEqual([]);
    expect(profiles[0]?.filesystem?.denyRead).toContain("/workspace/secrets/api-token");
    expect(existsSync(runnerPath)).toBe(false);
    expect(existsSync(payloadPath)).toBe(false);
  });

  it("fails closed for sandbox discovery nonzero, malformed JSON, and malformed result shapes", async () => {
    const base = {
      workspaceRoot: "/workspace",
      server: { transport: "stdio" as const, command: "/usr/bin/node", args: ["server.js"] },
      env: { HOME: "/home/tester" },
    };
    const sandboxFor = (stdout: string, exitCode = 0): SandboxPort => ({
      status: () => ({ available: true, backend: "fake", enforcementTier: "sandboxed" }),
      execute: async () => ({ exitCode, signal: null, stdout, stderr: "" }),
    });

    await expect(
      discoverMcpServerWithSandbox({
        ...base,
        sandbox: sandboxFor(
          JSON.stringify({ isError: true, content: [{ type: "text", text: "bad" }] }),
          1,
        ),
      }),
    ).rejects.toThrow("MCP discovery failed");
    await expect(
      discoverMcpServerWithSandbox({
        workspaceRoot: "/workspace",
        server: { transport: "stdio", command: "/usr/bin/node", args: ["server.js"] },
        sandbox: sandboxFor("", 1),
      }),
    ).rejects.toThrow("server exited nonzero");
    await expect(
      discoverMcpServerWithSandbox({ ...base, sandbox: sandboxFor("not json") }),
    ).rejects.toThrow("malformed JSON");
    await expect(
      discoverMcpServerWithSandbox({
        ...base,
        sandbox: sandboxFor(JSON.stringify({ protocolVersion: "", capabilities: {}, tools: [] })),
      }),
    ).rejects.toThrow("invalid protocolVersion");
    expect(() =>
      parseMcpDiscoveryResult({ protocolVersion: "2025-06-18", capabilities: [] }),
    ).toThrow("invalid capabilities");
    expect(() =>
      parseMcpDiscoveryResult({
        protocolVersion: "2025-06-18",
        capabilities: {},
        tools: [{ name: "" }],
      }),
    ).toThrow("malformed tool definitions");
  });

  it("exact-redacts configured MCP env values from sandbox discovery failures", async () => {
    const secret = "short-secret-value";
    const sandbox: SandboxPort = {
      status: () => ({ available: true, backend: "fake", enforcementTier: "sandboxed" }),
      execute: async () => ({
        exitCode: 1,
        signal: null,
        stdout: JSON.stringify({
          isError: true,
          content: [{ type: "text", text: `server echoed ${secret}` }],
        }),
        stderr: "",
      }),
    };

    try {
      await discoverMcpServerWithSandbox({
        workspaceRoot: "/workspace",
        server: {
          transport: "stdio",
          command: "/usr/bin/node",
          args: ["server.js"],
          envKeys: ["MCP_TOKEN"],
        },
        env: { MCP_TOKEN: secret },
        sandbox,
      });
      throw new Error("expected MCP discovery failure");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("[redacted:mcp-env-value]");
      expect(message).not.toContain(secret);
    }
  });

  it("canonical pinning fails closed for malformed tool definitions", () => {
    expect(() =>
      canonicalMcpToolPinForLaunch({
        server: { transport: "stdio", command: "/usr/bin/node", args: [], envKeys: [] },
        protocolVersion: "2025-06-18",
        capabilities: {},
        tools: [{ name: "ok", inputSchema: [] as unknown as Record<string, never> }],
      }),
    ).toThrow("malformed tool definition");
  });
});
