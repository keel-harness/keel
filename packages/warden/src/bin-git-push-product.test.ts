import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPushAuthority } from "./git-push-authority.js";
import type { GithubPrCreateAuthority } from "./github-pr-create-authority.js";
import type { SandboxPort } from "./sandbox.js";

describe("warden git.push product wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function mockProductModules() {
    const authority = {
      capability: "git-push/v1",
      toolName: "git.push",
      transportRequirements: { credentialTlsTermination: true },
    } as GitPushAuthority;
    const githubAuthority = {
      capability: "github-pr-create/v1",
      toolName: "github.pr.create",
      transportRequirements: { credentialTlsTermination: true },
    } as GithubPrCreateAuthority;
    const broker = { sourceClass: "operator Git credential helper (system/global config)" };
    const sandbox: SandboxPort = {
      status: () => ({
        available: true,
        backend: "srt:vendored",
        enforcementTier: "sandbox:srt",
        features: [
          "credential-tls-termination/v1",
          "egress-address-guard/v1",
          "srt-launch-authority/v1",
        ],
      }),
      execute: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    };
    const createGitCredentialBroker = vi.fn(() => broker);
    const createGitPushProductionAuthority = vi.fn(() => authority);
    const createGithubPrCreateProductionAuthority = vi.fn(() => githubAuthority);
    const resolveProductionGitExecutable = vi.fn(
      (_options: Record<string, unknown>): { path: string; version: string } | undefined => ({
        path: "/usr/bin/git",
        version: "2.39.5",
      }),
    );
    const resolveProductionCurlExecutable = vi.fn(
      (_options: Record<string, unknown>): { path: string; version: string } | undefined => ({
        path: "/usr/bin/curl",
        version: "8.7.1",
      }),
    );
    const createVendoredSrtSandboxComponents = vi.fn(async () => ({ sandbox }));
    const runStdioWardenServer = vi.fn((_options: Record<string, unknown>) => ({
      close: async () => {},
    }));

    vi.doMock("./git-credential-broker.js", () => ({ createGitCredentialBroker }));
    vi.doMock("./git-push.js", () => ({ createGitPushProductionAuthority }));
    vi.doMock("./git-push-product.js", () => ({ resolveProductionGitExecutable }));
    vi.doMock("./github-pr-create.js", () => ({ createGithubPrCreateProductionAuthority }));
    vi.doMock("./github-pr-create-product.js", () => ({ resolveProductionCurlExecutable }));
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
    vi.doMock("./egress-resolver.js", () => ({
      createBoundedEgressAddressResolver: () => ({
        resolveDestination: vi.fn(async () => []),
        shutdown: vi.fn(async () => ({ drained: true, activeLookups: 0 })),
      }),
    }));
    vi.doMock("./sandbox-temp-root.js", () => ({
      createWardenSandboxTempRoot: () => ({
        path: "/private/tmp/keel-git-push-product-root",
        declaredTempRoots: ["/private/tmp/keel-git-push-product-root"],
        assertOwned: vi.fn(),
        cleanup: vi.fn(),
      }),
    }));
    vi.doMock("./credential-proxy.js", () => ({ credentialProxyRulesFromEnvValues: vi.fn() }));
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
      homeCredentialSecretRoots: () => ["/operator-secret-root"],
    }));
    vi.doMock("./typed-mutation-runner.js", () => ({
      createSandboxTypedMutationRunner: () => ({
        run: vi.fn(),
        close: vi.fn(() => ({ cleanup: "complete" as const })),
      }),
    }));
    vi.doMock("./mutation-presentation-constructor.js", () => ({
      constructMutationPresentationArtifact: vi.fn(),
    }));
    vi.doMock("./mutation-presentation-walking-skeleton.js", () => ({
      createMutationPresentationWalkingSkeletonTransport: () => ({ clear: vi.fn(async () => {}) }),
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
      discoverMcpServerWithSandbox: vi.fn(),
      mcpTrustedServersFromEnv: () => ({}),
    }));

    return {
      authority,
      githubAuthority,
      broker,
      createGitCredentialBroker,
      createGitPushProductionAuthority,
      createGithubPrCreateProductionAuthority,
      createVendoredSrtSandboxComponents,
      resolveProductionGitExecutable,
      resolveProductionCurlExecutable,
      runStdioWardenServer,
    };
  }

  it("constructs the production broker and authority before SRT for a trusted product session", async () => {
    const mocked = mockProductModules();
    vi.stubEnv("KEEL_WARDEN_SANDBOX", "srt");
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_ROOT", "/workspace");
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_TRUSTED", "1");

    const { runWardenFromEnv } = await import("./bin.js");
    await runWardenFromEnv();

    expect(mocked.resolveProductionGitExecutable).toHaveBeenCalledWith({
      workspaceRoot: "/workspace",
      env: process.env,
      platform: process.platform,
    });
    expect(mocked.createGitCredentialBroker).toHaveBeenCalledWith({
      gitExecutable: "/usr/bin/git",
      tempRoot: "/private/tmp/keel-git-push-product-root",
      workspaceRoot: "/workspace",
      denyRoots: [
        "/tmp/keel-home",
        ...(process.env["HOME"] === undefined ? [] : ["/operator-secret-root"]),
      ],
      env: process.env,
    });
    expect(mocked.createGitPushProductionAuthority).toHaveBeenCalledWith({
      productionCapability: true,
      credentialBroker: mocked.broker,
      gitExecutable: "/usr/bin/git",
      gitVersion: "2.39.5",
      tempRoot: "/private/tmp/keel-git-push-product-root",
    });
    expect(mocked.resolveProductionCurlExecutable).toHaveBeenCalledWith({
      workspaceRoot: "/workspace",
      env: process.env,
      platform: process.platform,
    });
    expect(mocked.createGithubPrCreateProductionAuthority).toHaveBeenCalledWith({
      productionCapability: true,
      credentialBroker: mocked.broker,
      gitExecutable: "/usr/bin/git",
      gitVersion: "2.39.5",
      curlExecutable: "/usr/bin/curl",
      curlVersion: "8.7.1",
      tempRoot: "/private/tmp/keel-git-push-product-root",
    });
    expect(mocked.createVendoredSrtSandboxComponents).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialTlsTermination: true,
        launchAuthorityRegistryPath: "/tmp/keel-home/srt-endpoint-leases.json",
      }),
    );
    expect(mocked.runStdioWardenServer).toHaveBeenCalledWith(
      expect.objectContaining({
        gitPushAuthority: mocked.authority,
        gitPushAddressGuardRevision: "none",
        githubPrCreateAuthority: mocked.githubAuthority,
        githubPrCreateAddressGuardRevision: "none",
      }),
    );
  });

  it.each([
    ["untrusted workspace", undefined, "srt"],
    ["non-SRT backend", "1", "none"],
  ])("withholds production authority for %s", async (_label, trusted, sandboxMode) => {
    const mocked = mockProductModules();
    vi.stubEnv("KEEL_WARDEN_SANDBOX", sandboxMode);
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_ROOT", "/workspace");
    if (trusted !== undefined) vi.stubEnv("KEEL_WARDEN_WORKSPACE_TRUSTED", trusted);

    const { runWardenFromEnv } = await import("./bin.js");
    await runWardenFromEnv();

    expect(mocked.resolveProductionGitExecutable).not.toHaveBeenCalled();
    expect(mocked.createGitCredentialBroker).not.toHaveBeenCalled();
    expect(mocked.createGitPushProductionAuthority).not.toHaveBeenCalled();
    expect(mocked.createGithubPrCreateProductionAuthority).not.toHaveBeenCalled();
    expect(mocked.runStdioWardenServer.mock.calls[0]?.[0]).not.toHaveProperty("gitPushAuthority");
    expect(mocked.runStdioWardenServer.mock.calls[0]?.[0]).not.toHaveProperty(
      "githubPrCreateAuthority",
    );
  });

  it("withholds capability when no supported Git executable is identified", async () => {
    const mocked = mockProductModules();
    mocked.resolveProductionGitExecutable.mockReturnValue(undefined);
    vi.stubEnv("KEEL_WARDEN_SANDBOX", "srt");
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_ROOT", "/workspace");
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_TRUSTED", "1");

    const { runWardenFromEnv } = await import("./bin.js");
    await runWardenFromEnv();

    expect(mocked.createGitCredentialBroker).not.toHaveBeenCalled();
    expect(mocked.createGitPushProductionAuthority).not.toHaveBeenCalled();
    expect(mocked.createGithubPrCreateProductionAuthority).not.toHaveBeenCalled();
    expect(mocked.createVendoredSrtSandboxComponents).not.toHaveBeenCalledWith(
      expect.objectContaining({ credentialTlsTermination: true }),
    );
    expect(mocked.runStdioWardenServer.mock.calls[0]?.[0]).not.toHaveProperty("gitPushAuthority");
    expect(mocked.runStdioWardenServer.mock.calls[0]?.[0]).not.toHaveProperty(
      "githubPrCreateAuthority",
    );
  });

  it("keeps git.push but withholds github.pr.create when curl is unsupported", async () => {
    const mocked = mockProductModules();
    mocked.resolveProductionCurlExecutable.mockReturnValue(undefined);
    vi.stubEnv("KEEL_WARDEN_SANDBOX", "srt");
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_ROOT", "/workspace");
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_TRUSTED", "1");

    const { runWardenFromEnv } = await import("./bin.js");
    await runWardenFromEnv();

    expect(mocked.createGitPushProductionAuthority).toHaveBeenCalledOnce();
    expect(mocked.createGithubPrCreateProductionAuthority).not.toHaveBeenCalled();
    expect(mocked.runStdioWardenServer.mock.calls[0]?.[0]).toHaveProperty("gitPushAuthority");
    expect(mocked.runStdioWardenServer.mock.calls[0]?.[0]).not.toHaveProperty(
      "githubPrCreateAuthority",
    );
  });
});
