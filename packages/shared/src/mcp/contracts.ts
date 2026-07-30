import { createHash } from "node:crypto";
import { canonicalize } from "../audit/canonicalize.js";
import type { JsonObjectT } from "../common/json.js";

/**
 * Pure kernel↔warden MCP data contracts (ADR-0071 P1-10). These are the wire/launch
 * contracts both processes must agree on byte-for-byte — env-var names, the trusted-server
 * and discovery shapes, the launch-pin algorithm, and the trusted-servers env encoder. They
 * carry no `node:fs`, sandbox, or policy dependency, so they live in `@keel/shared` and the
 * warden re-exports them (single source of truth). The warden keeps the enforcement-side
 * readers (`mcpTrustedServersFromEnv`, the sandbox launch commands) that consume these types.
 */

export interface McpStdioLaunchConfig {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly envKeys?: readonly string[];
  readonly entrypointHash?: string | null;
}

export interface TrustedMcpServerConfig extends McpStdioLaunchConfig {
  readonly serverKey?: string;
  readonly pin: string;
  readonly tools: readonly {
    readonly name: string;
    readonly serverToolName?: string;
    readonly description?: string;
    readonly inputSchema?: JsonObjectT;
    readonly annotations?: JsonObjectT;
  }[];
}

export type TrustedMcpServers = Readonly<Record<string, TrustedMcpServerConfig>>;
export const MCP_TRUSTED_SERVERS_ENV = "KEEL_MCP_TRUSTED_SERVERS";
export const INTERNAL_MCP_DISCOVERY_ENV = "KEEL_INTERNAL_MCP_DISCOVER";
export const MCP_DISCOVERY_REQUEST_ENV = "KEEL_MCP_DISCOVERY_REQUEST";

export interface McpToolDefinitionForPin {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: JsonObjectT;
  readonly annotations?: JsonObjectT;
}

export interface McpDiscoveryResult {
  readonly protocolVersion: string;
  readonly capabilities: JsonObjectT;
  readonly tools: readonly McpToolDefinitionForPin[];
}

export interface McpPinLaunchInput extends McpDiscoveryResult {
  readonly server: McpStdioLaunchConfig;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObjectT {
  return isObject(value);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseToolDefinitionForPin(value: unknown): McpToolDefinitionForPin | undefined {
  if (!isObject(value)) return undefined;
  const name = value["name"];
  const description = value["description"];
  const inputSchema = value["inputSchema"];
  const annotations = value["annotations"];
  if (typeof name !== "string" || name.trim() === "") return undefined;
  if (description !== undefined && typeof description !== "string") return undefined;
  if (inputSchema !== undefined && !isJsonObject(inputSchema)) return undefined;
  if (annotations !== undefined && !isJsonObject(annotations)) return undefined;
  return {
    name,
    ...(description === undefined ? {} : { description }),
    ...(inputSchema === undefined ? {} : { inputSchema }),
    ...(annotations === undefined ? {} : { annotations }),
  };
}

export function parseMcpDiscoveryResult(raw: unknown): McpDiscoveryResult {
  if (!isObject(raw)) throw new Error("MCP discovery returned a non-object result");
  const protocolVersion = raw["protocolVersion"];
  const capabilities = raw["capabilities"];
  const tools = raw["tools"];
  if (typeof protocolVersion !== "string" || protocolVersion.trim() === "") {
    throw new Error("MCP discovery returned an invalid protocolVersion");
  }
  if (!isJsonObject(capabilities)) throw new Error("MCP discovery returned invalid capabilities");
  if (!Array.isArray(tools)) throw new Error("MCP discovery returned invalid tools");
  const parsedTools = tools.map((tool) => parseToolDefinitionForPin(tool));
  if (parsedTools.some((tool) => tool === undefined)) {
    throw new Error("MCP discovery returned malformed tool definitions");
  }
  return {
    protocolVersion,
    capabilities,
    tools: parsedTools as McpToolDefinitionForPin[],
  };
}

function normalizedToolPin(tool: McpToolDefinitionForPin): JsonObjectT & { readonly name: string } {
  const parsed = parseToolDefinitionForPin(tool);
  if (parsed === undefined) throw new Error("MCP pin input contains a malformed tool definition");
  return JSON.parse(JSON.stringify(parsed)) as JsonObjectT & {
    readonly name: string;
  };
}

export function canonicalMcpToolPinForLaunch(input: McpPinLaunchInput): string {
  const envKeys = [...new Set(input.server.envKeys ?? [])].sort();
  const tools = input.tools.map((tool) => normalizedToolPin(tool));
  return sha256(
    canonicalize({
      server: {
        transport: "stdio",
        command: input.server.command,
        args: [...input.server.args],
        envKeys,
        ...(input.server.entrypointHash === undefined
          ? {}
          : { entrypointHash: input.server.entrypointHash }),
      },
      protocolVersion: input.protocolVersion,
      capabilities: input.capabilities,
      tools: tools.sort((a, b) => canonicalize(a).localeCompare(canonicalize(b))),
    }),
  );
}

export function encodeTrustedMcpServersEnv(servers: TrustedMcpServers): string {
  return JSON.stringify({ version: 1, servers });
}
