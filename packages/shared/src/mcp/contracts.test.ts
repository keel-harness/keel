import { describe, expect, it } from "vitest";
import {
  canonicalMcpToolPinForLaunch,
  encodeTrustedMcpServersEnv,
  INTERNAL_MCP_DISCOVERY_ENV,
  MCP_DISCOVERY_REQUEST_ENV,
  MCP_TRUSTED_SERVERS_ENV,
  parseMcpDiscoveryResult,
  type McpPinLaunchInput,
} from "./contracts.js";

describe("MCP kernel↔warden contracts", () => {
  it("pins the env-var-name constants (cross-process wiring contract)", () => {
    expect(MCP_TRUSTED_SERVERS_ENV).toBe("KEEL_MCP_TRUSTED_SERVERS");
    expect(INTERNAL_MCP_DISCOVERY_ENV).toBe("KEEL_INTERNAL_MCP_DISCOVER");
    expect(MCP_DISCOVERY_REQUEST_ENV).toBe("KEEL_MCP_DISCOVERY_REQUEST");
  });

  // Characterization golden: this exact digest is produced by the pre-move warden
  // implementation for this exact input. It locks the launch-pin algorithm byte-for-byte
  // across the relocation — the kernel and the warden's in-sandbox runner must agree on it.
  const goldenInput: McpPinLaunchInput = {
    server: {
      transport: "stdio",
      command: "/bin/echo",
      args: ["hi", "there"],
      envKeys: ["B", "A", "A"],
      entrypointHash: null,
    },
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    tools: [
      { name: "beta", description: "d2", inputSchema: { type: "object" } },
      { name: "alpha" },
    ],
  };
  const GOLDEN_PIN = "sha256:56bc455db30aa525401c9dfb85b6ef7f7d195568e61b23d933ebcb171b550cf8";

  it("computes the exact pre-move launch pin (characterization golden)", () => {
    expect(canonicalMcpToolPinForLaunch(goldenInput)).toBe(GOLDEN_PIN);
  });

  it("pins independently of envKeys and tool ordering (canonicalization)", () => {
    const reordered: McpPinLaunchInput = {
      ...goldenInput,
      server: { ...goldenInput.server, envKeys: ["A", "B"] },
      tools: [goldenInput.tools[1]!, goldenInput.tools[0]!],
    };
    expect(canonicalMcpToolPinForLaunch(reordered)).toBe(GOLDEN_PIN);
  });

  it("round-trips a valid discovery result and rejects malformed input", () => {
    expect(
      parseMcpDiscoveryResult({ protocolVersion: "1", capabilities: {}, tools: [{ name: "x" }] }),
    ).toEqual({ protocolVersion: "1", capabilities: {}, tools: [{ name: "x" }] });

    expect(() => parseMcpDiscoveryResult(null)).toThrow(/non-object/u);
    expect(() =>
      parseMcpDiscoveryResult({ protocolVersion: "", capabilities: {}, tools: [] }),
    ).toThrow(/protocolVersion/u);
    expect(() =>
      parseMcpDiscoveryResult({ protocolVersion: "1", capabilities: {}, tools: "nope" }),
    ).toThrow(/tools/u);
    expect(() =>
      parseMcpDiscoveryResult({ protocolVersion: "1", capabilities: {}, tools: [{ name: "" }] }),
    ).toThrow(/malformed/u);
  });

  it("encodes the trusted-servers env payload in the versioned wire shape", () => {
    expect(
      encodeTrustedMcpServersEnv({
        s1: {
          transport: "stdio",
          command: "c",
          args: [],
          pin: `sha256:${"0".repeat(64)}`,
          tools: [],
        },
      }),
    ).toBe(
      `{"version":1,"servers":{"s1":{"transport":"stdio","command":"c","args":[],"pin":"sha256:${"0".repeat(
        64,
      )}","tools":[]}}}`,
    );
  });
});
