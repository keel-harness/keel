import type { McpDiscoveryResult, McpStdioLaunchConfig } from "@keel/shared";
import { loadMcpConfigFromProjectReader } from "../context/mcp-config.js";
import type { McpStdioServerConfigT } from "../context/mcp-config.js";
import { ProjectReader, defaultProjectFs } from "../context/project-reader.js";
import {
  advertisedMcpToolNamesForServer,
  canonicalMcpToolPin,
  resolvableMcpEntrypointHash,
  saveMcpTrustedServer,
  sanitizeMcpPinInputForTrust,
  mcpTrustStorePath,
} from "../mcp/local-stdio.js";
import { discoverProductionMcpServer, resolveProductionWardenStart } from "../warden/runtime.js";

export interface McpReviewCommandOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly serverKey: string;
  readonly discover?: (server: McpStdioLaunchConfig) => Promise<McpDiscoveryResult>;
  readonly discoverProduction?: typeof discoverProductionMcpServer;
}

function launchConfig(server: McpStdioServerConfigT): McpStdioLaunchConfig {
  return {
    transport: "stdio",
    command: server.command,
    args: server.args,
    envKeys: [...new Set(server.envKeys)].sort(),
  };
}

function stripControls(value: string): string {
  let output = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x1b && value[i + 1] === "[") {
      i += 2;
      while (i < value.length) {
        const finalCode = value.charCodeAt(i);
        if (finalCode >= 0x40 && finalCode <= 0x7e) break;
        i += 1;
      }
      continue;
    }
    output += code <= 0x1f || code === 0x7f ? " " : value.charAt(i);
  }
  return output.replace(/\s+/gu, " ").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: string | readonly string[]): string {
  return JSON.stringify(
    typeof value === "string" ? stripControls(value) : value.map((entry) => stripControls(entry)),
  );
}

function formatReviewSuccess(input: {
  readonly serverKey: string;
  readonly server: McpStdioServerConfigT;
  readonly entrypointHash?: string;
  readonly pin: string;
  readonly advertisedToolNames: readonly string[];
  readonly trustStorePath: string;
}): string {
  const names = input.advertisedToolNames;
  return [
    `trusted local-stdio MCP server ${safeJson(input.serverKey)}`,
    `config: .keel/mcp.json`,
    `command: ${safeJson(input.server.command)}`,
    `args: ${input.server.args.length === 0 ? "(none)" : safeJson(input.server.args)}`,
    `envKeys: ${input.server.envKeys.length === 0 ? "(none)" : safeJson(input.server.envKeys)}`,
    input.entrypointHash === undefined
      ? "commandIdentity: entrypoint hash unavailable; pin covers command string, args, env key names, protocol, capabilities, and tool definitions, not executable bytes; prefer an absolute or workspace-relative command for entrypoint hashing"
      : `commandIdentity: ${input.entrypointHash}`,
    `pin: ${input.pin}`,
    `trustStore: ${safeJson(input.trustStorePath)}`,
    `tools: ${names.length === 0 ? "(none)" : safeJson(names)}`,
    "safeNextAction: restart or continue a trusted keel session; re-review if command, args, env keys, entrypoint identity, protocol, capabilities, or tool definitions change",
  ].join("\n");
}

export async function runMcpReviewCommand(options: McpReviewCommandOptions): Promise<string> {
  const env = options.env ?? process.env;
  const reader = new ProjectReader(defaultProjectFs(), { trusted: true });
  const loaded = loadMcpConfigFromProjectReader(reader, options.cwd);
  if (loaded.kind === "missing") throw new Error("no .keel/mcp.json in this workspace");
  if (loaded.kind === "invalid") throw new Error(loaded.message);
  const config = (loaded as Extract<typeof loaded, { readonly kind: "loaded" }>).config;
  const server = config.servers[options.serverKey];
  if (server === undefined) {
    throw new Error(`server ${options.serverKey} is not configured in .keel/mcp.json`);
  }

  const launch = launchConfig(server);
  let discovery: McpDiscoveryResult;
  try {
    discovery =
      options.discover === undefined
        ? await (options.discoverProduction ?? discoverProductionMcpServer)({
            cwd: options.cwd,
            env,
            server: launch,
            start: resolveProductionWardenStart(),
          })
        : await options.discover(launch);
  } catch (error) {
    throw new Error(stripControls(errorMessage(error)));
  }
  const entrypointHash = resolvableMcpEntrypointHash(server, options.cwd);
  const sanitizedDiscovery = sanitizeMcpPinInputForTrust(
    {
      serverConfig: server,
      protocolVersion: discovery.protocolVersion,
      capabilities: discovery.capabilities,
      tools: discovery.tools,
      ...(entrypointHash === undefined ? {} : { entrypointHash }),
    },
    env,
  );
  const pin = canonicalMcpToolPin(sanitizedDiscovery);
  const trustedServerConfig = entrypointHash === undefined ? server : { ...server, entrypointHash };
  saveMcpTrustedServer(
    {
      workspaceRoot: options.cwd,
      serverKey: options.serverKey,
      serverConfig: trustedServerConfig,
      protocolVersion: sanitizedDiscovery.protocolVersion,
      capabilities: sanitizedDiscovery.capabilities,
      tools: [...sanitizedDiscovery.tools],
      pin,
    },
    env,
  );
  return formatReviewSuccess({
    serverKey: options.serverKey,
    server,
    ...(entrypointHash === undefined ? {} : { entrypointHash }),
    pin,
    advertisedToolNames: advertisedMcpToolNamesForServer({
      workspaceRoot: options.cwd,
      serverKey: options.serverKey,
      env,
    }),
    trustStorePath: mcpTrustStorePath(env),
  });
}
