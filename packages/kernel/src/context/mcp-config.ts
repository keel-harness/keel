import { join } from "node:path";
import { z } from "zod";
import type { ProjectReader } from "./project-reader.js";

export const MCP_PROJECT_CONFIG_PATH = ".keel/mcp.json";

const McpServerKey = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_.-]+$/u, "server keys must be simple local identifiers");
const McpEnvKey = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "envKeys entries must be environment variable names");

const McpStdioServerConfig = z
  .object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).max(64).default([]),
    envKeys: z.array(McpEnvKey).max(64).default([]),
  })
  .strict();
export type McpStdioServerConfigT = z.infer<typeof McpStdioServerConfig>;

const McpProjectConfig = z
  .object({
    version: z.literal(1),
    servers: z.record(McpServerKey, McpStdioServerConfig).default({}),
  })
  .strict();
export type McpProjectConfigT = z.infer<typeof McpProjectConfig>;

export type McpConfigLoadResult =
  | { readonly kind: "untrusted" }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "loaded"; readonly config: McpProjectConfigT };

function invalidMessage(error: z.ZodError): string {
  const joined = error.issues.map((issue) => issue.message).join("; ");
  return `MCP config supports local stdio servers only: ${joined}`;
}

export function parseMcpProjectConfig(raw: string): McpProjectConfigT {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`MCP config is not valid JSON: ${String(error)}`);
  }
  const config = McpProjectConfig.safeParse(parsed);
  if (!config.success) throw new Error(invalidMessage(config.error));
  return config.data;
}

export function loadMcpConfigFromProjectReader(
  reader: ProjectReader,
  workspaceRoot: string,
): McpConfigLoadResult {
  const raw = reader.readFile(join(workspaceRoot, MCP_PROJECT_CONFIG_PATH));
  if (!reader.trusted) return { kind: "untrusted" };
  if (raw === undefined) return { kind: "missing" };
  try {
    return { kind: "loaded", config: parseMcpProjectConfig(raw) };
  } catch (error) {
    return { kind: "invalid", message: String(error) };
  }
}
