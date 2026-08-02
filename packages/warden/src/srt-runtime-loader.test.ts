import { describe, expect, it } from "vitest";
import {
  createVendoredSrtSandboxComponents,
  createVendoredSrtSandboxPort,
  detectVendoredSrtHostDependencyErrors,
  importVendoredSrtRuntime,
  isBundledVendoredSrtHelperImportError,
  isPlainNodeTypeScriptImportError,
  type VendoredSrtManager,
} from "./srt-runtime-loader.js";
import type { SandboxProcessRunner } from "./sandbox.js";

describe("vendored srt runtime loader", () => {
  it("recognizes plain-node TypeScript import failures without masking unrelated errors", () => {
    expect(isPlainNodeTypeScriptImportError(null)).toBe(false);
    expect(isPlainNodeTypeScriptImportError(new Error("Cannot find package 'shell-quote'"))).toBe(
      false,
    );
    expect(
      isPlainNodeTypeScriptImportError(Object.assign(new Error("load failed"), { code: "EACCES" })),
    ).toBe(false);
    expect(
      isPlainNodeTypeScriptImportError(
        Object.assign(new Error('Unknown file extension ".ts"'), {
          code: "ERR_UNKNOWN_FILE_EXTENSION",
        }),
      ),
    ).toBe(true);
    expect(isPlainNodeTypeScriptImportError(new Error('Unknown file extension ".ts"'))).toBe(true);
  });

  it("recognizes a missing bundled helper without masking unrelated missing modules", () => {
    expect(isBundledVendoredSrtHelperImportError(null)).toBe(false);
    expect(
      isBundledVendoredSrtHelperImportError(
        Object.assign(new Error("Cannot find module './other.js'"), {
          code: "ERR_MODULE_NOT_FOUND",
        }),
      ),
    ).toBe(false);
    expect(
      isBundledVendoredSrtHelperImportError(
        Object.assign(new Error("Cannot find module './bundled-srt-runtime.js'"), {
          code: "ERR_MODULE_NOT_FOUND",
        }),
      ),
    ).toBe(true);
  });

  it("falls back through a TypeScript importer when plain Node rejects the vendored .ts entry", async () => {
    const manager: VendoredSrtManager = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async () => {},
      updateConfig: () => {},
      wrapWithSandboxArgv: async () => ({ argv: ["/bin/true"], env: {} }),
    };
    const imported = await importVendoredSrtRuntime({
      directImport: async () => {
        throw Object.assign(new Error('Unknown file extension ".ts"'), {
          code: "ERR_UNKNOWN_FILE_EXTENSION",
        });
      },
      tsImport: async (_specifier, options) => {
        expect(typeof options.parentURL).toBe("string");
        expect(options.tsconfig).toBe(false);
        return { SandboxManager: manager };
      },
    });

    expect(imported.SandboxManager).toBe(manager);
  });

  it("falls back through a TypeScript importer when the bundled helper was not emitted", async () => {
    const manager: VendoredSrtManager = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async () => {},
      updateConfig: () => {},
      wrapWithSandboxArgv: async () => ({ argv: ["/bin/true"], env: {} }),
    };
    const imported = await importVendoredSrtRuntime({
      directImport: async () => {
        throw Object.assign(new Error("Cannot find module './bundled-srt-runtime.js'"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
      tsImport: async (_specifier, options) => {
        expect(typeof options.parentURL).toBe("string");
        return { SandboxManager: manager };
      },
    });

    expect(imported.SandboxManager).toBe(manager);
  });

  it("uses a bundled runtime seeded by the packaging entry before importer fallbacks", async () => {
    const key = "__keelBundledSrtRuntime";
    const previous = (globalThis as Record<string, unknown>)[key];
    const manager: VendoredSrtManager = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async () => {},
      updateConfig: () => {},
      wrapWithSandboxArgv: async () => ({ argv: ["/bin/true"], env: {} }),
    };
    try {
      (globalThis as Record<string, unknown>)[key] = { SandboxManager: manager };
      const imported = await importVendoredSrtRuntime({
        tsImport: async () => {
          throw new Error("must not fall back");
        },
      });

      expect(imported.SandboxManager).toBe(manager);
    } finally {
      if (previous === undefined) {
        delete (globalThis as Record<string, unknown>)[key];
      } else {
        (globalThis as Record<string, unknown>)[key] = previous;
      }
    }
  });

  it("can use the default tsx importer fallback for the vendored TypeScript entry", async () => {
    const imported = await importVendoredSrtRuntime({
      directImport: async () => {
        throw Object.assign(new Error('Unknown file extension ".ts"'), {
          code: "ERR_UNKNOWN_FILE_EXTENSION",
        });
      },
    });

    expect(typeof imported.SandboxManager.isSupportedPlatform).toBe("function");
  });

  it("fails closed when the TypeScript importer fallback is unavailable", async () => {
    await expect(
      importVendoredSrtRuntime({
        directImport: async () => {
          throw Object.assign(new Error('Unknown file extension ".ts"'), {
            code: "ERR_UNKNOWN_FILE_EXTENSION",
          });
        },
        tsImport: async () => {
          throw new Error("Cannot find package 'tsx'");
        },
      }),
    ).rejects.toThrow("vendored sandbox runtime TypeScript loader unavailable");
  });

  it("does not route unrelated import failures through the TypeScript fallback", async () => {
    let fallbackCalls = 0;

    await expect(
      importVendoredSrtRuntime({
        directImport: async () => {
          throw new Error("Cannot find package 'shell-quote'");
        },
        tsImport: async () => {
          fallbackCalls += 1;
          throw new Error("must not run");
        },
      }),
    ).rejects.toThrow("Cannot find package 'shell-quote'");
    expect(fallbackCalls).toBe(0);
  });

  it("detects host dependencies without assuming the current platform", () => {
    expect(detectVendoredSrtHostDependencyErrors("linux", () => false)).toEqual([]);
    expect(detectVendoredSrtHostDependencyErrors("darwin", () => true)).toEqual([]);
    expect(detectVendoredSrtHostDependencyErrors("darwin", () => false)).toEqual([
      "/usr/bin/sandbox-exec not found",
    ]);
  });

  it("loads the real vendored runtime path without throwing and reports its current status", async () => {
    const port = await createVendoredSrtSandboxPort();

    const status = port.status();
    expect(status.backend).toBe("srt:vendored");
    expect(["none", "sandbox:srt"]).toContain(status.enforcementTier);
  });

  it("fails closed on unsupported platforms before initializing srt", async () => {
    let initializeCalls = 0;
    const manager: VendoredSrtManager = {
      isSupportedPlatform: () => false,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async () => {
        initializeCalls += 1;
      },
      updateConfig: () => {},
      wrapWithSandboxArgv: async () => ({ argv: ["/bin/true"], env: {} }),
    };

    const port = await createVendoredSrtSandboxPort({
      importRuntime: async () => ({ SandboxManager: manager }),
    });

    expect(port.status()).toMatchObject({
      available: false,
      backend: "srt:vendored",
      enforcementTier: "none",
      reason: "sandbox platform is not supported",
      fixCommand: "keel doctor",
    });
    expect(initializeCalls).toBe(0);
  });

  it("returns an unavailable sandbox port when the vendored runtime cannot be imported", async () => {
    const port = await createVendoredSrtSandboxPort({
      importRuntime: async () => {
        throw new Error("Cannot find package 'shell-quote'");
      },
    });

    expect(port.status()).toEqual({
      available: false,
      backend: "srt:vendored",
      enforcementTier: "none",
      reason: "vendored sandbox runtime unavailable: Cannot find package 'shell-quote'",
      fixCommand: "pnpm install",
    });
    await expect(port.execute({ command: "true" }, {})).rejects.toThrow(
      "vendored sandbox runtime unavailable",
    );
  });

  it("normalizes non-Error import failures into an unavailable sandbox port", async () => {
    const nonErrorRejection = "missing vendored source" as unknown as Error;
    const port = await createVendoredSrtSandboxPort({
      importRuntime: () => Promise.reject(nonErrorRejection),
    });

    expect(port.status()).toMatchObject({
      available: false,
      backend: "srt:vendored",
      enforcementTier: "none",
      reason: "vendored sandbox runtime unavailable: missing vendored source",
      fixCommand: "pnpm install",
    });
  });

  it("fails closed when the platform or sandbox dependencies are unavailable", async () => {
    let initializeCalls = 0;
    const manager: VendoredSrtManager = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: ["bwrap not found"], warnings: [] }),
      initialize: async () => {
        initializeCalls += 1;
      },
      updateConfig: () => {},
      wrapWithSandboxArgv: async () => ({ argv: ["/bin/true"], env: {} }),
    };

    const port = await createVendoredSrtSandboxPort({
      importRuntime: async () => ({ SandboxManager: manager }),
    });

    expect(port.status()).toEqual({
      available: false,
      backend: "srt:vendored",
      enforcementTier: "none",
      reason: "sandbox dependencies not available: bwrap not found",
      fixCommand: "keel doctor",
    });
    await expect(port.execute({ command: "true" }, {})).rejects.toThrow("bwrap not found");
    expect(initializeCalls).toBe(0);
  });

  it("fails closed when host-specific dependency checks fail", async () => {
    let initializeCalls = 0;
    const manager: VendoredSrtManager = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async () => {
        initializeCalls += 1;
      },
      updateConfig: () => {},
      wrapWithSandboxArgv: async () => ({ argv: ["/bin/true"], env: {} }),
    };

    const port = await createVendoredSrtSandboxPort({
      importRuntime: async () => ({ SandboxManager: manager }),
      hostDependencyErrors: () => ["/usr/bin/sandbox-exec not found"],
    });

    expect(port.status()).toMatchObject({
      available: false,
      backend: "srt:vendored",
      enforcementTier: "none",
      reason: "sandbox dependencies not available: /usr/bin/sandbox-exec not found",
      fixCommand: "keel doctor",
    });
    expect(initializeCalls).toBe(0);
  });

  it("fails closed when srt initialization cannot start", async () => {
    const manager: VendoredSrtManager = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async () => {
        throw new Error("listen EPERM: operation not permitted 127.0.0.1");
      },
      updateConfig: () => {},
      wrapWithSandboxArgv: async () => ({ argv: ["/bin/true"], env: {} }),
    };

    const port = await createVendoredSrtSandboxPort({
      importRuntime: async () => ({ SandboxManager: manager }),
      hostDependencyErrors: () => [],
    });

    expect(port.status()).toMatchObject({
      available: false,
      backend: "srt:vendored",
      enforcementTier: "none",
      reason: "sandbox initialization failed: listen EPERM: operation not permitted 127.0.0.1",
      fixCommand: "keel doctor",
    });
    await expect(port.execute({ command: "true" }, {})).rejects.toThrow(
      "sandbox initialization failed",
    );
  });

  it("normalizes non-Error initialization failures into an unavailable sandbox port", async () => {
    const nonErrorRejection = "proxy bind failed" as unknown as Error;
    const manager: VendoredSrtManager = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: () => Promise.reject(nonErrorRejection),
      updateConfig: () => {},
      wrapWithSandboxArgv: async () => ({ argv: ["/bin/true"], env: {} }),
    };

    const port = await createVendoredSrtSandboxPort({
      importRuntime: async () => ({ SandboxManager: manager }),
      hostDependencyErrors: () => [],
    });

    expect(port.status()).toMatchObject({
      available: false,
      backend: "srt:vendored",
      enforcementTier: "none",
      reason: "sandbox initialization failed: proxy bind failed",
      fixCommand: "keel doctor",
    });
  });

  it("creates an available port that initializes srt once and keeps profile overrides per call", async () => {
    const initializeConfigs: unknown[] = [];
    const updateConfigs: unknown[] = [];
    const wrappedCalls: unknown[] = [];
    let cleanupCalls = 0;
    const manager: VendoredSrtManager = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async (config) => {
        initializeConfigs.push(config);
      },
      updateConfig: (config) => {
        updateConfigs.push(config);
      },
      wrapWithSandboxArgv: async (command, binShell, customConfig, abortSignal) => {
        wrappedCalls.push({ command, binShell, customConfig, abortSignal });
        return {
          argv: ["/usr/bin/env", "true"],
          env: { SANDBOX_RUNTIME: "1", ANTHROPIC_API_KEY: "secret" },
        };
      },
      cleanupAfterCommand: () => {
        cleanupCalls += 1;
      },
    };
    const runnerResults: unknown[] = [];
    const runner: SandboxProcessRunner = {
      run: async (descriptor) => {
        runnerResults.push(descriptor);
        return { exitCode: 0, signal: null, stdout: "ok", stderr: "" };
      },
    };
    const abort = new AbortController();

    const port = await createVendoredSrtSandboxPort({
      importRuntime: async () => ({ SandboxManager: manager }),
      runner,
      binShell: "/bin/zsh",
    });

    expect(port.status()).toEqual({
      available: true,
      backend: "srt:vendored",
      enforcementTier: "sandbox:srt",
    });
    await port.execute(
      { command: "true" },
      { filesystem: { allowWrite: ["/workspace/a"] } },
      { signal: abort.signal },
    );
    await port.execute({ command: "true" }, { filesystem: { allowWrite: ["/workspace/b"] } });
    await port.execute(
      { command: "true" },
      {
        network: {
          allowedDomains: ["localhost"],
          deniedDomains: [],
          strictAllowlist: true,
        },
      },
    );

    expect(initializeConfigs).toEqual([
      {
        network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      },
    ]);
    expect(updateConfigs).toEqual([
      {
        network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true },
        filesystem: { denyRead: [], allowRead: [], allowWrite: ["/workspace/a"], denyWrite: [] },
      },
      {
        network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true },
        filesystem: { denyRead: [], allowRead: [], allowWrite: ["/workspace/b"], denyWrite: [] },
      },
      {
        network: { allowedDomains: ["localhost"], deniedDomains: [], strictAllowlist: true },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      },
    ]);
    expect(wrappedCalls).toEqual([
      {
        command: "true",
        binShell: "/bin/zsh",
        customConfig: { filesystem: { allowWrite: ["/workspace/a"] } },
        abortSignal: abort.signal,
      },
      {
        command: "true",
        binShell: "/bin/zsh",
        customConfig: { filesystem: { allowWrite: ["/workspace/b"] } },
        abortSignal: undefined,
      },
      {
        command: "true",
        binShell: "/bin/zsh",
        customConfig: {
          network: {
            allowedDomains: ["localhost"],
            deniedDomains: [],
            strictAllowlist: true,
          },
        },
        abortSignal: undefined,
      },
    ]);
    expect(runnerResults).toEqual([
      { argv: ["/usr/bin/env", "true"], env: { SANDBOX_RUNTIME: "1" } },
      { argv: ["/usr/bin/env", "true"], env: { SANDBOX_RUNTIME: "1" } },
      { argv: ["/usr/bin/env", "true"], env: { SANDBOX_RUNTIME: "1" } },
    ]);
    expect(cleanupCalls).toBe(3);
  });

  it("creates internal sandbox components with a reusable long-lived launch preparer", async () => {
    const updateConfigs: unknown[] = [];
    const wrappedCalls: unknown[] = [];
    let initializeCalls = 0;
    let cleanupCalls = 0;
    const manager: VendoredSrtManager = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async () => {
        initializeCalls += 1;
      },
      updateConfig: (config) => {
        updateConfigs.push(config);
      },
      wrapWithSandboxArgv: async (command, binShell, customConfig, abortSignal) => {
        wrappedCalls.push({ command, binShell, customConfig, abortSignal });
        return {
          argv: ["/usr/bin/env", command],
          env: { SANDBOX_RUNTIME: "1", ANTHROPIC_API_KEY: "secret" },
        };
      },
      cleanupAfterCommand: () => {
        cleanupCalls += 1;
      },
    };

    const components = await createVendoredSrtSandboxComponents({
      importRuntime: async () => ({ SandboxManager: manager }),
      hostDependencyErrors: () => [],
      binShell: "/bin/zsh",
    });

    expect(components.sandbox.status()).toEqual({
      available: true,
      backend: "srt:vendored",
      enforcementTier: "sandbox:srt",
    });
    expect(components.launchPreparer?.status()).toEqual(components.sandbox.status());
    const launch = await components.launchPreparer?.prepareLaunch(
      { command: "qemu-system-x86_64", cwd: "/workspace" },
      { filesystem: { allowRead: ["/workspace"] } },
    );

    expect(launch?.descriptor).toEqual({
      argv: ["/usr/bin/env", "qemu-system-x86_64"],
      cwd: "/workspace",
      env: { SANDBOX_RUNTIME: "1" },
    });
    launch?.cleanup();
    expect(initializeCalls).toBe(1);
    expect(updateConfigs).toEqual([
      {
        network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true },
        filesystem: { denyRead: [], allowRead: ["/workspace"], allowWrite: [], denyWrite: [] },
      },
    ]);
    expect(wrappedCalls).toEqual([
      {
        command: "qemu-system-x86_64",
        binShell: "/bin/zsh",
        customConfig: { filesystem: { allowRead: ["/workspace"] } },
        abortSignal: undefined,
      },
    ]);
    expect(cleanupCalls).toBe(1);
  });

  it("preserves credential proxy config when completing vendored per-call config", async () => {
    const secret = "keel-real-token-sec027-loader";
    const placeholder = "keelcred_test_loader";
    const updateConfigs: unknown[] = [];
    const wrappedCalls: unknown[] = [];
    const manager: VendoredSrtManager = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async () => {},
      updateConfig: (config) => {
        updateConfigs.push(config);
      },
      wrapWithSandboxArgv: async (command, binShell, customConfig, abortSignal) => {
        wrappedCalls.push({ command, binShell, customConfig, abortSignal });
        return { argv: ["/usr/bin/env", "true"], env: { SANDBOX_RUNTIME: "1" } };
      },
    };
    const port = await createVendoredSrtSandboxPort({
      importRuntime: async () => ({ SandboxManager: manager }),
      hostDependencyErrors: () => [],
      runner: {
        run: async () => ({ exitCode: 0, signal: null, stdout: "ok", stderr: "" }),
      },
    });

    await port.execute(
      { command: "true" },
      { network: { allowedDomains: ["api.example.com"], deniedDomains: [] } },
      {
        credentialProxy: {
          authorizationHeaders: [{ host: "api.example.com", scheme: "Bearer", secret }],
          authorizationPlaceholders: [
            { host: "placeholder.example.com", scheme: "Bearer", placeholder, secret },
          ],
          sandboxEnv: { KEEL_PLACEHOLDER_AUTH: placeholder },
          allowPlaintextInject: true,
        },
      },
    );
    await port.execute(
      { command: "true" },
      { network: { allowedDomains: ["placeholder.example.com"], deniedDomains: [] } },
      {
        credentialProxy: {
          authorizationPlaceholders: [
            { host: "placeholder.example.com", scheme: "Bearer", placeholder, secret },
          ],
          sandboxEnv: { KEEL_PLACEHOLDER_AUTH: placeholder },
        },
      },
    );

    expect(updateConfigs).toEqual([
      {
        network: { allowedDomains: ["api.example.com"], deniedDomains: [] },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
        credentials: {
          authorizationHeaders: [{ host: "api.example.com", scheme: "Bearer", value: secret }],
          authorizationPlaceholders: [
            { host: "placeholder.example.com", scheme: "Bearer", placeholder, value: secret },
          ],
          allowPlaintextInject: true,
        },
      },
      {
        network: { allowedDomains: ["placeholder.example.com"], deniedDomains: [] },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
        credentials: {
          authorizationPlaceholders: [
            { host: "placeholder.example.com", scheme: "Bearer", placeholder, value: secret },
          ],
          allowPlaintextInject: false,
        },
      },
    ]);
    expect(wrappedCalls).toEqual([
      {
        command: "true",
        binShell: undefined,
        customConfig: {
          network: { allowedDomains: ["api.example.com"], deniedDomains: [] },
          credentials: {
            authorizationHeaders: [{ host: "api.example.com", scheme: "Bearer", value: secret }],
            authorizationPlaceholders: [
              { host: "placeholder.example.com", scheme: "Bearer", placeholder, value: secret },
            ],
            allowPlaintextInject: true,
          },
        },
        abortSignal: undefined,
      },
      {
        command: "true",
        binShell: undefined,
        customConfig: {
          network: { allowedDomains: ["placeholder.example.com"], deniedDomains: [] },
          credentials: {
            authorizationPlaceholders: [
              { host: "placeholder.example.com", scheme: "Bearer", placeholder, value: secret },
            ],
            allowPlaintextInject: false,
          },
        },
        abortSignal: undefined,
      },
    ]);
  });

  it("installs credential TLS termination at initialization and preserves it per call", async () => {
    const initializeConfigs: unknown[] = [];
    const updateConfigs: unknown[] = [];
    const manager: VendoredSrtManager = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async (config) => {
        initializeConfigs.push(config);
      },
      updateConfig: (config) => {
        updateConfigs.push(config);
      },
      wrapWithSandboxArgv: async () => ({
        argv: ["/usr/bin/env", "true"],
        env: { SANDBOX_RUNTIME: "1" },
      }),
    };
    const port = await createVendoredSrtSandboxPort({
      importRuntime: async () => ({ SandboxManager: manager }),
      hostDependencyErrors: () => [],
      credentialTlsTermination: true,
      runner: {
        run: async () => ({ exitCode: 0, signal: null, stdout: "ok", stderr: "" }),
      },
    });

    await port.execute(
      { command: "true" },
      { network: { allowedDomains: ["api.example.com"], deniedDomains: [] } },
      {
        credentialProxy: {
          authorizationHeaders: [
            { host: "api.example.com", scheme: "Bearer", secret: "real-secret" },
          ],
        },
      },
    );

    expect(initializeConfigs).toEqual([
      {
        network: {
          allowedDomains: [],
          deniedDomains: ["*"],
          strictAllowlist: true,
          tlsTerminate: {},
        },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      },
    ]);
    expect(updateConfigs).toEqual([
      {
        network: {
          allowedDomains: ["api.example.com"],
          deniedDomains: [],
          tlsTerminate: {},
        },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
        credentials: {
          authorizationHeaders: [
            { host: "api.example.com", scheme: "Bearer", value: "real-secret" },
          ],
          allowPlaintextInject: false,
        },
      },
    ]);
  });

  it("preserves partial network profile data instead of filling unset strictness", async () => {
    const updateConfigs: unknown[] = [];
    const manager: VendoredSrtManager = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async () => {},
      updateConfig: (config) => {
        updateConfigs.push(config);
      },
      wrapWithSandboxArgv: async () => ({
        argv: ["/usr/bin/env", "true"],
        env: { PATH: "/usr/bin" },
      }),
    };
    const port = await createVendoredSrtSandboxPort({
      importRuntime: async () => ({ SandboxManager: manager }),
      hostDependencyErrors: () => [],
      runner: {
        run: async () => ({ exitCode: 0, signal: null, stdout: "ok", stderr: "" }),
      },
    });

    await port.execute(
      { command: "true" },
      { network: { allowedDomains: ["example.com"], deniedDomains: [] } },
    );

    expect(updateConfigs).toEqual([
      {
        network: { allowedDomains: ["example.com"], deniedDomains: [] },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      },
    ]);
  });

  it("can create an available default-runner port without optional fields", async () => {
    const manager: VendoredSrtManager = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async () => {},
      updateConfig: () => {},
      wrapWithSandboxArgv: async () => ({ argv: ["/usr/bin/env", "true"], env: {} }),
    };

    const port = await createVendoredSrtSandboxPort({
      importRuntime: async () => ({ SandboxManager: manager }),
      hostDependencyErrors: () => [],
    });

    expect(port.status()).toEqual({
      available: true,
      backend: "srt:vendored",
      enforcementTier: "sandbox:srt",
    });
  });
});
