import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxPort } from "./sandbox.js";

describe("warden bin mutation-presentation product wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function mockProductModules(sandbox: SandboxPort | undefined) {
    const typedMutationRunner = {
      run: vi.fn(),
      close: vi.fn(() => ({ cleanup: "complete" as const })),
    };
    const transport = {
      advertiseTestCapability: true as const,
      clear: vi.fn(async () => {}),
    };
    const constructMutationPresentationArtifact = vi.fn();
    const createMutationPresentationWalkingSkeletonTransport = vi.fn(() => transport);
    const createSandboxTypedMutationRunner = vi.fn(() => typedMutationRunner);
    const runStdioWardenServer = vi.fn((_options: Record<string, unknown>) => ({
      close: async () => {},
    }));

    vi.doMock("./srt-runtime-loader.js", () => ({
      createVendoredSrtSandboxComponents: async () => (sandbox === undefined ? {} : { sandbox }),
    }));
    // This suite isolates mutation-presentation wiring. A trusted SRT fixture must not accidentally
    // acquire the real host Git authority through PATH and then consume its synthetic temp root.
    vi.doMock("./git-push-product.js", () => ({
      resolveProductionGitExecutable: () => undefined,
    }));
    vi.doMock("./egress-address-exceptions.js", () => ({
      ensureEgressAddressExceptionAuthorityHome: () => "/tmp/keel-home",
      loadEgressAddressExceptionSnapshot: () => ({
        revision: "none",
        workspaceRealpath: process.cwd(),
        exceptions: [],
        allowsRestrictedAddress: () => false,
      }),
    }));
    vi.doMock("./sandbox-temp-root.js", () => ({
      createWardenSandboxTempRoot: () => ({
        path: "/private/tmp/keel-presentation-product-root",
        declaredTempRoots: ["/private/tmp/keel-presentation-product-root"],
        assertOwned: vi.fn(),
        cleanup: vi.fn(),
      }),
    }));
    vi.doMock("./typed-mutation-runner.js", () => ({ createSandboxTypedMutationRunner }));
    vi.doMock("./mutation-presentation-constructor.js", () => ({
      constructMutationPresentationArtifact,
    }));
    vi.doMock("./mutation-presentation-walking-skeleton.js", () => ({
      createMutationPresentationWalkingSkeletonTransport,
    }));
    vi.doMock("./interactive-console/product-config.js", () => ({
      interactiveConsoleProductOptionsFromEnv: async () => ({}),
    }));
    vi.doMock("./rpc-server.js", () => ({
      DEFAULT_MAX_LINE_BYTES: 1024,
      WARDEN_TEARDOWN_BUDGET_MS: 24_000,
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
    vi.doMock("./credential-proxy.js", () => ({
      credentialProxyRulesFromEnvValues: vi.fn(),
      CREDENTIAL_PROXY_CONFIG_ENV: "KEEL_CREDENTIAL_PROXY_CONFIG",
      parseCredentialProxyConfig: vi.fn(),
    }));
    vi.doMock("./lifecycle.js", () => ({
      LIFECYCLE_VALIDATION_POSTURE_ENV: "KEEL_LIFECYCLE_VALIDATION_POSTURE",
      lifecycleManifestFromEnv: () => undefined,
      parseValidationPostureId: () => undefined,
    }));
    vi.doMock("./mcp/local-stdio.js", () => ({
      INTERNAL_MCP_DISCOVERY_ENV: "KEEL_INTERNAL_MCP_DISCOVER",
      MCP_DISCOVERY_REQUEST_ENV: "KEEL_MCP_DISCOVERY_REQUEST",
      discoverMcpServerWithSandbox: vi.fn(),
      mcpTrustedServersFromEnv: () => ({}),
    }));

    return {
      constructMutationPresentationArtifact,
      createMutationPresentationWalkingSkeletonTransport,
      createSandboxTypedMutationRunner,
      runStdioWardenServer,
      transport,
      typedMutationRunner,
    };
  }

  it("constructs the bounded transport with the real edit/write constructor and passes it to the production server", async () => {
    const sandbox: SandboxPort = {
      status: () => ({ available: true, backend: "srt:vendored", enforcementTier: "sandbox:srt" }),
      execute: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    };
    const mocked = mockProductModules(sandbox);
    vi.stubEnv("KEEL_WARDEN_SANDBOX", "srt");
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_TRUSTED", "1");

    const { runWardenFromEnv } = await import("./bin.js");
    await runWardenFromEnv();

    expect(mocked.createSandboxTypedMutationRunner).toHaveBeenCalledWith({
      sandbox,
      declaredTempRoots: ["/private/tmp/keel-presentation-product-root"],
    });
    expect(mocked.createMutationPresentationWalkingSkeletonTransport).toHaveBeenCalledWith({
      construct: mocked.constructMutationPresentationArtifact,
      constructWrite: mocked.constructMutationPresentationArtifact,
    });
    expect(mocked.runStdioWardenServer).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox,
        typedMutationRunner: mocked.typedMutationRunner,
        mutationPresentation: mocked.transport,
      }),
    );
  });

  it("does not allocate or advertise presentation state when typed mutation enforcement is absent", async () => {
    const mocked = mockProductModules(undefined);
    vi.stubEnv("KEEL_WARDEN_SANDBOX", "none");

    const { runWardenFromEnv } = await import("./bin.js");
    await runWardenFromEnv();

    expect(mocked.createSandboxTypedMutationRunner).not.toHaveBeenCalled();
    expect(mocked.createMutationPresentationWalkingSkeletonTransport).not.toHaveBeenCalled();
    const options = mocked.runStdioWardenServer.mock.calls[0]?.[0];
    expect(options).toBeDefined();
    expect(options).not.toHaveProperty("mutationPresentation");
  });

  it("clears production presentation state if server startup fails after transport construction", async () => {
    const sandbox: SandboxPort = {
      status: () => ({ available: true, backend: "srt:vendored", enforcementTier: "sandbox:srt" }),
      execute: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    };
    const mocked = mockProductModules(sandbox);
    mocked.runStdioWardenServer.mockImplementation(() => {
      throw new Error("injected server startup failure");
    });
    vi.stubEnv("KEEL_WARDEN_SANDBOX", "srt");

    const { runWardenFromEnv } = await import("./bin.js");
    await expect(runWardenFromEnv()).rejects.toThrow("injected server startup failure");

    expect(mocked.createMutationPresentationWalkingSkeletonTransport).toHaveBeenCalledOnce();
    expect(mocked.transport.clear).toHaveBeenCalledOnce();
    expect(mocked.typedMutationRunner.close).toHaveBeenCalledOnce();
  });

  it("preserves the original startup error and still closes mutation enforcement when presentation cleanup rejects", async () => {
    const sandbox: SandboxPort = {
      status: () => ({ available: true, backend: "srt:vendored", enforcementTier: "sandbox:srt" }),
      execute: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    };
    const mocked = mockProductModules(sandbox);
    mocked.transport.clear.mockRejectedValueOnce(new Error("producer-only cleanup detail"));
    mocked.runStdioWardenServer.mockImplementation(() => {
      throw new Error("authoritative startup failure");
    });
    vi.stubEnv("KEEL_WARDEN_SANDBOX", "srt");

    const { runWardenFromEnv } = await import("./bin.js");
    await expect(runWardenFromEnv()).rejects.toThrow("authoritative startup failure");

    expect(mocked.transport.clear).toHaveBeenCalledOnce();
    expect(mocked.typedMutationRunner.close).toHaveBeenCalledOnce();
  });
});
