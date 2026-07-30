import { afterEach, describe, expect, it, vi } from "vitest";

function mockProcessExit() {
  return vi
    .spyOn(process, "exit")
    .mockImplementation((_code?: string | number | null): never => undefined as never);
}

describe("warden bin entrypoint", () => {
  afterEach(() => {
    vi.doUnmock("./bin.js");
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("runs the warden from the environment without reporting startup failure", async () => {
    const runWardenFromEnv = vi.fn().mockResolvedValue(undefined);
    const runMcpDiscoveryFromEnv = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./bin.js", () => ({
      INTERNAL_MCP_DISCOVERY_ENV: "KEEL_INTERNAL_MCP_DISCOVER",
      runMcpDiscoveryFromEnv,
      runWardenFromEnv,
    }));
    const exit = mockProcessExit();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("./bin-entry.js");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(runWardenFromEnv).toHaveBeenCalledOnce();
    expect(runMcpDiscoveryFromEnv).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits the one-shot hidden MCP discovery process after successful output", async () => {
    const runWardenFromEnv = vi.fn().mockResolvedValue(undefined);
    const runMcpDiscoveryFromEnv = vi.fn().mockResolvedValue(undefined);
    vi.doMock("./bin.js", () => ({
      INTERNAL_MCP_DISCOVERY_ENV: "KEEL_INTERNAL_MCP_DISCOVER",
      runMcpDiscoveryFromEnv,
      runWardenFromEnv,
    }));
    vi.stubEnv("KEEL_INTERNAL_MCP_DISCOVER", "1");
    const exit = mockProcessExit();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("./bin-entry.js");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(runMcpDiscoveryFromEnv).toHaveBeenCalledOnce();
    expect(runWardenFromEnv).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("aborts hidden MCP discovery sandbox execution on SIGTERM", async () => {
    const request = Buffer.from(
      JSON.stringify({
        server: { transport: "stdio", command: process.execPath, args: [], envKeys: [] },
      }),
      "utf8",
    ).toString("base64");
    let capturedSignal: AbortSignal | undefined;
    const execute = vi.fn(
      async (_invocation: unknown, _profile: unknown, options?: { signal?: AbortSignal }) => {
        capturedSignal = options?.signal;
        return await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted discovery sandbox")),
            { once: true },
          );
        });
      },
    );
    vi.doMock("./srt-runtime-loader.js", () => ({
      createVendoredSrtSandboxComponents: async () => ({
        sandbox: {
          status: () => ({ available: true, backend: "fake", enforcementTier: "sandboxed" }),
          execute,
        },
      }),
    }));
    vi.stubEnv("KEEL_INTERNAL_MCP_DISCOVER", "1");
    vi.stubEnv("KEEL_WARDEN_SANDBOX", "srt");
    vi.stubEnv("KEEL_MCP_DISCOVERY_REQUEST", request);
    const { runMcpDiscoveryFromEnv } = await import("./bin.js");

    const pending = runMcpDiscoveryFromEnv();
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    process.emit("SIGTERM", "SIGTERM");

    await expect(pending).rejects.toThrow("aborted discovery sandbox");
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("reports Error startup failures and exits closed", async () => {
    const runWardenFromEnv = vi.fn().mockRejectedValue(new Error("bad checkpoint key"));
    vi.doMock("./bin.js", () => ({
      INTERNAL_MCP_DISCOVERY_ENV: "KEEL_INTERNAL_MCP_DISCOVER",
      runMcpDiscoveryFromEnv: vi.fn().mockResolvedValue(undefined),
      runWardenFromEnv,
    }));
    const exit = mockProcessExit();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("./bin-entry.js");

    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith("keel-warden failed to start: bad checkpoint key");
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("reports non-Error startup failures and exits closed", async () => {
    const runWardenFromEnv = vi.fn().mockRejectedValue("invalid inverse");
    vi.doMock("./bin.js", () => ({
      INTERNAL_MCP_DISCOVERY_ENV: "KEEL_INTERNAL_MCP_DISCOVER",
      runMcpDiscoveryFromEnv: vi.fn().mockResolvedValue(undefined),
      runWardenFromEnv,
    }));
    const exit = mockProcessExit();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await import("./bin-entry.js");

    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith("keel-warden failed to start: invalid inverse");
    });
    expect(exit).toHaveBeenCalledWith(1);
  });
});
