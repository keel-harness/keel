import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialProxyRule } from "./credential-proxy.js";
import type { SandboxPort } from "./sandbox.js";

describe("warden credential TLS product wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function mockProductModules(rules: readonly CredentialProxyRule[] | undefined) {
    const order: string[] = [];
    const sandbox: SandboxPort = {
      status: () => ({ available: true, backend: "srt:vendored", enforcementTier: "sandbox:srt" }),
      execute: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    };
    const createVendoredSrtSandboxComponents = vi.fn(async () => {
      order.push("sandbox");
      return { sandbox };
    });
    const credentialProxyRulesFromEnvValues = vi.fn(() => {
      order.push("credentials");
      return rules;
    });
    const runStdioWardenServer = vi.fn(() => ({ close: async () => {} }));
    const discoverMcpServerWithSandbox = vi.fn(async () => ({
      protocolVersion: "test",
      capabilities: {},
    }));
    const typedMutationRunner = {
      run: vi.fn(),
      close: vi.fn(() => ({ cleanup: "complete" as const })),
    };

    vi.doMock("./srt-runtime-loader.js", () => ({ createVendoredSrtSandboxComponents }));
    vi.doMock("./egress-address-exceptions.js", () => ({
      ensureEgressAddressExceptionAuthorityHome: () => "/tmp/keel-home",
      loadEgressAddressExceptionSnapshot: () => ({
        revision: "none",
        workspaceRealpath: "/workspace",
        exceptions: [],
        allowsRestrictedAddress: () => false,
      }),
    }));
    vi.doMock("./sandbox-temp-root.js", () => ({
      createWardenSandboxTempRoot: () => ({
        path: "/private/tmp/keel-credential-tls-product-root",
        declaredTempRoots: ["/private/tmp/keel-credential-tls-product-root"],
        assertOwned: vi.fn(),
        cleanup: vi.fn(),
      }),
    }));
    vi.doMock("./credential-proxy.js", () => ({ credentialProxyRulesFromEnvValues }));
    vi.doMock("./rpc-server.js", () => ({
      DEFAULT_MAX_LINE_BYTES: 1024,
      WARDEN_TEARDOWN_BUDGET_MS: 2_000,
      runStdioWardenServer,
    }));
    vi.doMock("./audit/checkpoint-key.js", () => ({
      loadOrCreateAuditCheckpointKey: () => ({ secretKey: "checkpoint-secret" }),
    }));
    vi.doMock("./audit/session-log.js", () => ({
      SessionAuditLog: class {
        close(): void {}
      },
    }));
    vi.doMock("./capability-manifest.js", () => ({
      resolveWardenKeelHome: () => "/tmp/keel-home",
    }));
    vi.doMock("./typed-mutation-runner.js", () => ({
      createSandboxTypedMutationRunner: () => typedMutationRunner,
    }));
    vi.doMock("./mutation-presentation-constructor.js", () => ({
      constructMutationPresentationArtifact: vi.fn(),
    }));
    vi.doMock("./mutation-presentation-walking-skeleton.js", () => ({
      createMutationPresentationWalkingSkeletonTransport: () => ({
        clear: vi.fn(async () => {}),
      }),
    }));
    vi.doMock("./interactive-console/product-config.js", () => ({
      interactiveConsoleProductOptionsFromEnv: async () => ({}),
    }));
    vi.doMock("./lifecycle.js", () => ({
      LIFECYCLE_VALIDATION_POSTURE_ENV: "KEEL_LIFECYCLE_VALIDATION_POSTURE",
      lifecycleManifestFromEnv: () => undefined,
      parseValidationPostureId: () => undefined,
    }));
    vi.doMock("./mcp/local-stdio.js", () => ({
      INTERNAL_MCP_DISCOVERY_ENV: "KEEL_INTERNAL_MCP_DISCOVER",
      MCP_DISCOVERY_REQUEST_ENV: "KEEL_MCP_DISCOVERY_REQUEST",
      discoverMcpServerWithSandbox,
      mcpTrustedServersFromEnv: () => ({}),
    }));

    return {
      createVendoredSrtSandboxComponents,
      credentialProxyRulesFromEnvValues,
      discoverMcpServerWithSandbox,
      order,
      runStdioWardenServer,
    };
  }

  const secureRule: CredentialProxyRule = {
    id: "api-token",
    mode: "swap_on_access",
    host: "api.example.com",
    scheme: "Bearer",
    source: { kind: "env", name: "API_TOKEN" },
  };

  it("loads credential authority before SRT and enables TLS termination for the warden", async () => {
    const mocked = mockProductModules([secureRule]);
    vi.stubEnv("KEEL_WARDEN_SANDBOX", "srt");
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_ROOT", "/workspace");

    const { runWardenFromEnv } = await import("./bin.js");
    await runWardenFromEnv();

    expect(mocked.order).toEqual(["credentials", "sandbox"]);
    expect(mocked.credentialProxyRulesFromEnvValues).toHaveBeenCalledWith({
      workspaceRoot: "/workspace",
      env: process.env,
    });
    expect(mocked.createVendoredSrtSandboxComponents).toHaveBeenCalledWith({
      credentialTlsTermination: true,
      resolveDestination: expect.any(Function),
    });
    expect(mocked.runStdioWardenServer).toHaveBeenCalledWith(
      expect.objectContaining({ credentialProxyRules: [secureRule] }),
    );
  });

  it("loads credential authority before SRT and enables TLS termination for MCP discovery", async () => {
    const mocked = mockProductModules([secureRule]);
    const request = Buffer.from(
      JSON.stringify({
        server: { transport: "stdio", command: process.execPath, args: [], envKeys: [] },
      }),
      "utf8",
    ).toString("base64");
    vi.stubEnv("KEEL_INTERNAL_MCP_DISCOVER", "1");
    vi.stubEnv("KEEL_WARDEN_SANDBOX", "srt");
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_ROOT", "/workspace");
    vi.stubEnv("KEEL_MCP_DISCOVERY_REQUEST", request);
    vi.spyOn(process.stdout, "write").mockImplementation((_chunk: unknown, callback?: unknown) => {
      if (typeof callback === "function") Reflect.apply(callback, undefined, []);
      return true;
    });

    const { runMcpDiscoveryFromEnv } = await import("./bin.js");
    await runMcpDiscoveryFromEnv();

    expect(mocked.order).toEqual(["credentials", "sandbox"]);
    expect(mocked.createVendoredSrtSandboxComponents).toHaveBeenCalledWith({
      credentialTlsTermination: true,
    });
    expect(mocked.discoverMcpServerWithSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ credentialProxyRules: [secureRule] }),
    );
  });

  it("does not enable TLS termination when no credential rules are active", async () => {
    const mocked = mockProductModules(undefined);
    vi.stubEnv("KEEL_WARDEN_SANDBOX", "srt");

    const { runWardenFromEnv } = await import("./bin.js");
    await runWardenFromEnv();

    expect(mocked.order).toEqual(["credentials", "sandbox"]);
    expect(mocked.createVendoredSrtSandboxComponents).toHaveBeenCalledWith({
      resolveDestination: expect.any(Function),
    });
  });
});
