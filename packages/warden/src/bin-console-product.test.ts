import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxPort } from "./sandbox.js";
import type { InteractiveConsoleProductOptionsDependencies } from "./interactive-console/product-config.js";

describe("warden bin interactive console product wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("passes parent-env interactive console targets and broker into the stdio server", async () => {
    const sandbox: SandboxPort = {
      status: () => ({ available: true, backend: "srt:vendored", enforcementTier: "sandbox:srt" }),
      execute: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    };
    const launchPreparer = {
      status: () => ({ available: true, backend: "srt:vendored", enforcementTier: "sandbox:srt" }),
      prepareLaunch: vi.fn(),
    };
    const interactiveConsoleBroker = { status: () => ({ available: true, backend: "fake" }) };
    const interactiveConsoleTargets = {
      "qemu-alpine": {
        targetId: "qemu-alpine",
        targetDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sandboxProfileId: "srt-qemu-local-vm-deny-default-egress",
        command: "qemu-system-x86_64",
        cwd: "/workspace",
      },
    };
    const interactiveConsoleHeadlessGrants = [{ sentinel: "headless-grant" }] as const;
    const runStdioWardenServer = vi.fn(() => ({
      close: async () => {},
    }));
    const interactiveConsoleProductOptionsFromEnv = vi.fn(
      async (
        _env: NodeJS.ProcessEnv,
        dependencies: InteractiveConsoleProductOptionsDependencies,
      ) => {
        expect(dependencies.launchPreparer).toBe(launchPreparer);
        return {
          interactiveConsoleTargets,
          interactiveConsoleBroker,
          interactiveConsoleHeadlessGrants,
        };
      },
    );

    vi.stubEnv("KEEL_WARDEN_SANDBOX", "srt");
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_TRUSTED", "1");
    vi.stubEnv(
      "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG",
      '{"backend":{"kind":"system-tmux"},"targets":[]}',
    );
    vi.doMock("./srt-runtime-loader.js", () => ({
      createVendoredSrtSandboxComponents: async () => ({ sandbox, launchPreparer }),
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
    vi.doMock("./interactive-console/product-config.js", () => ({
      interactiveConsoleProductOptionsFromEnv,
    }));
    vi.doMock("./rpc-server.js", () => ({
      DEFAULT_MAX_LINE_BYTES: 1024,
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
      homeCredentialSecretRoots: () => [],
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

    const { runWardenFromEnv } = await import("./bin.js");
    await runWardenFromEnv();

    expect(interactiveConsoleProductOptionsFromEnv).toHaveBeenCalledOnce();
    expect(runStdioWardenServer).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox,
        interactiveConsoleTargets,
        interactiveConsoleBroker,
        interactiveConsoleHeadlessGrants,
      }),
    );
  });

  it("does NOT load the interactive console in an UNTRUSTED workspace (QC §8, mirrors MCP)", async () => {
    const sandbox: SandboxPort = {
      status: () => ({ available: true, backend: "srt:vendored", enforcementTier: "sandbox:srt" }),
      execute: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    };
    const launchPreparer = {
      status: () => ({ available: true, backend: "srt:vendored", enforcementTier: "sandbox:srt" }),
      prepareLaunch: vi.fn(),
    };
    const runStdioWardenServer = vi.fn((_options: Record<string, unknown>) => ({
      close: async () => {},
    }));
    const interactiveConsoleProductOptionsFromEnv = vi.fn(async () => ({
      interactiveConsoleTargets: { x: {} },
      interactiveConsoleBroker: { status: () => ({ available: true, backend: "fake" }) },
    }));

    vi.stubEnv("KEEL_WARDEN_SANDBOX", "srt");
    // No KEEL_WARDEN_WORKSPACE_TRUSTED — an untrusted workspace.
    vi.stubEnv(
      "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG",
      '{"backend":{"kind":"system-tmux"},"targets":[]}',
    );
    vi.doMock("./srt-runtime-loader.js", () => ({
      createVendoredSrtSandboxComponents: async () => ({ sandbox, launchPreparer }),
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
    vi.doMock("./interactive-console/product-config.js", () => ({
      interactiveConsoleProductOptionsFromEnv,
    }));
    vi.doMock("./rpc-server.js", () => ({ DEFAULT_MAX_LINE_BYTES: 1024, runStdioWardenServer }));
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
      homeCredentialSecretRoots: () => [],
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

    const { runWardenFromEnv } = await import("./bin.js");
    await runWardenFromEnv();

    // The console product config is never even read, and no broker/targets reach the server.
    expect(interactiveConsoleProductOptionsFromEnv).not.toHaveBeenCalled();
    const options = runStdioWardenServer.mock.calls[0]?.[0];
    expect(options).toBeDefined();
    expect(options).not.toHaveProperty("interactiveConsoleBroker");
    expect(options).not.toHaveProperty("interactiveConsoleTargets");
  });
});
