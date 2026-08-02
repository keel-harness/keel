import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoundedEgressAddressResolver, EgressResolverAuditRecord } from "./egress-resolver.js";
import type { SandboxPort } from "./sandbox.js";

describe("warden address-guard product wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function mockProductModules() {
    const order: string[] = [];
    const appended: unknown[] = [];
    const closeAudit = vi.fn();
    const shutdownSandbox = vi.fn(async () => {});
    const sandbox: SandboxPort = {
      status: () => ({
        available: true,
        backend: "srt:vendored",
        enforcementTier: "sandbox:srt",
        features: ["egress-address-guard/v1"],
      }),
      execute: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    };
    const exceptionSnapshot = {
      revision: `sha256:${"a".repeat(64)}`,
      workspaceRealpath: "/workspace",
      exceptions: [],
      allowsRestrictedAddress: vi.fn(() => false),
    };
    const loadEgressAddressExceptionSnapshot = vi.fn(() => {
      order.push("exceptions");
      return exceptionSnapshot;
    });
    const ensureEgressAddressExceptionAuthorityHome = vi.fn(() => {
      order.push("home");
      return "/tmp/keel-home";
    });
    const resolver = {
      resolveDestination: vi.fn(async () => []),
      snapshot: vi.fn(() => ({ state: "active", activeLookups: 0, queuedLookups: 0 })),
      shutdown: vi.fn(async () => ({ drained: true, activeLookups: 0 })),
    };
    let resolverOptions: Record<string, unknown> | undefined;
    const createBoundedEgressAddressResolver = vi.fn((options: Record<string, unknown>) => {
      order.push("resolver");
      resolverOptions = options;
      return resolver;
    });
    const createVendoredSrtSandboxComponents = vi.fn(
      async (_options?: {
        readonly resolveDestination?: BoundedEgressAddressResolver["resolveDestination"];
      }) => {
        order.push("sandbox");
        return { sandbox, shutdown: shutdownSandbox };
      },
    );
    const runStdioWardenServer = vi.fn(
      (_options: { readonly auditWriter?: unknown; readonly sandbox?: SandboxPort }) => {
        order.push("server");
        return { close: async () => {} };
      },
    );

    vi.doMock("./srt-runtime-loader.js", () => ({ createVendoredSrtSandboxComponents }));
    vi.doMock("./egress-address-exceptions.js", () => ({
      ensureEgressAddressExceptionAuthorityHome,
      loadEgressAddressExceptionSnapshot,
    }));
    vi.doMock("./egress-resolver.js", () => ({ createBoundedEgressAddressResolver }));
    vi.doMock("./sandbox-temp-root.js", () => ({
      createWardenSandboxTempRoot: () => ({
        path: "/private/tmp/keel-address-guard-product-root",
        declaredTempRoots: ["/private/tmp/keel-address-guard-product-root"],
        assertOwned: vi.fn(),
        cleanup: vi.fn(),
      }),
    }));
    vi.doMock("./credential-proxy.js", () => ({
      credentialProxyRulesFromEnvValues: vi.fn(),
    }));
    vi.doMock("./rpc-server.js", () => ({
      DEFAULT_AUDIT_SESSION_ID: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      DEFAULT_MAX_LINE_BYTES: 1024,
      WARDEN_TEARDOWN_BUDGET_MS: 2_000,
      runStdioWardenServer,
    }));
    vi.doMock("./audit/checkpoint-key.js", () => ({
      loadOrCreateAuditCheckpointKey: () => {
        order.push("checkpoint");
        return { secretKey: "checkpoint-secret" };
      },
    }));
    vi.doMock("./audit/session-log.js", () => ({
      SessionAuditLog: class {
        constructor() {
          order.push("audit");
        }
        append(value: unknown): void {
          appended.push(value);
        }
        close(): void {
          closeAudit();
        }
      },
    }));
    vi.doMock("./capability-manifest.js", () => ({
      resolveWardenKeelHome: () => "/tmp/keel-home",
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
      appended,
      closeAudit,
      createBoundedEgressAddressResolver,
      createVendoredSrtSandboxComponents,
      exceptionSnapshot,
      ensureEgressAddressExceptionAuthorityHome,
      getResolverOptions: () => resolverOptions,
      loadEgressAddressExceptionSnapshot,
      order,
      resolver,
      runStdioWardenServer,
      sandbox,
      shutdownSandbox,
    };
  }

  it("constructs audit and immutable authority before guarded SRT and RPC startup", async () => {
    const mocked = mockProductModules();
    vi.stubEnv("KEEL_WARDEN_SANDBOX", "srt");
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_ROOT", "/workspace");
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_TRUSTED", "1");

    const { runWardenFromEnv } = await import("./bin.js");
    await runWardenFromEnv();

    expect(mocked.order).toEqual([
      "home",
      "checkpoint",
      "audit",
      "exceptions",
      "resolver",
      "sandbox",
      "server",
    ]);
    expect(mocked.ensureEgressAddressExceptionAuthorityHome).toHaveBeenCalledWith(process.env);
    expect(mocked.loadEgressAddressExceptionSnapshot).toHaveBeenCalledWith(
      "/workspace",
      process.env,
    );
    const srtOptions = mocked.createVendoredSrtSandboxComponents.mock.calls[0]?.[0];
    const signal = new AbortController().signal;
    await srtOptions?.resolveDestination?.("api.example.com", 443, signal);
    expect(mocked.resolver.resolveDestination).toHaveBeenCalledWith("api.example.com", 443, signal);
    const serverOptions = mocked.runStdioWardenServer.mock.calls[0]?.[0];
    expect(serverOptions?.auditWriter).toBeDefined();
    expect(serverOptions?.sandbox).toBe(mocked.sandbox);

    const options = mocked.getResolverOptions() as {
      audit: { append(record: EgressResolverAuditRecord): void };
      onQuarantine(reason: string): void;
    };
    expect(options).toMatchObject({
      allowsRestrictedAddress: mocked.exceptionSnapshot.allowsRestrictedAddress,
      exceptionPolicyRevision: mocked.exceptionSnapshot.revision,
    });
    options.audit.append({
      kind: "denial",
      host: "api.example.com",
      port: 443,
      reason: "restricted-address-not-excepted",
      addressClass: "restricted",
      answerCount: 2,
      exceptionPolicyRevision: "none",
    });
    expect(mocked.appended).toEqual([
      {
        eventType: "egress.deny",
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        payload: {
          host: "api.example.com",
          port: 443,
          reason: "restricted-address-not-excepted",
          addressClass: "restricted",
          answerCount: 2,
          exceptionPolicyRevision: "none",
        },
      },
    ]);

    options.onQuarantine("denial-rate-quarantine");
    await Promise.resolve();
    expect(mocked.shutdownSandbox).toHaveBeenCalledOnce();
  });

  it("validates but does not activate exception authority for an untrusted workspace", async () => {
    const mocked = mockProductModules();
    vi.stubEnv("KEEL_WARDEN_SANDBOX", "srt");
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_ROOT", "/workspace");
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_TRUSTED", "0");

    const { runWardenFromEnv } = await import("./bin.js");
    await runWardenFromEnv();

    expect(mocked.loadEgressAddressExceptionSnapshot).toHaveBeenCalledOnce();
    expect(mocked.getResolverOptions()).toMatchObject({ exceptionPolicyRevision: "none" });
    expect(mocked.getResolverOptions()).not.toHaveProperty("allowsRestrictedAddress");
  });

  it("fails before SRT or RPC startup when exception authority cannot load", async () => {
    const mocked = mockProductModules();
    mocked.loadEgressAddressExceptionSnapshot.mockImplementationOnce(() => {
      throw new Error("insecure exception authority");
    });
    vi.stubEnv("KEEL_WARDEN_SANDBOX", "srt");
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_ROOT", "/workspace");
    vi.stubEnv("KEEL_WARDEN_WORKSPACE_TRUSTED", "1");

    const { runWardenFromEnv } = await import("./bin.js");
    await expect(runWardenFromEnv()).rejects.toThrow("insecure exception authority");

    expect(mocked.createVendoredSrtSandboxComponents).not.toHaveBeenCalled();
    expect(mocked.runStdioWardenServer).not.toHaveBeenCalled();
    expect(mocked.closeAudit).toHaveBeenCalledOnce();
  });
});
