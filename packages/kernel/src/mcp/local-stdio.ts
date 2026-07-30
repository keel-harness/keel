import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  JsonObject,
  canonicalMcpToolPinForLaunch,
  encodeTrustedMcpServersEnv,
  MCP_TRUSTED_SERVERS_ENV,
  redactText,
  type JsonObjectT,
  type ToolSpecT,
} from "@keel/shared";
import {
  providerHostileSchemaPaths,
  toProviderCompatibleJsonSchema,
} from "../providers/schema-compat.js";
import { atomicWrite } from "../tools/atomic-write.js";
import { withFileLock } from "../tools/file-lock.js";
import { keelHome } from "../session/paths.js";
import type { McpStdioServerConfigT } from "../context/mcp-config.js";

const HASH_RE = /^sha256:[0-9a-f]{64}$/u;
const MAX_PROJECTED_MCP_TOOLS = 32;
const MAX_PROJECTED_DESCRIPTION_CHARS = 1024;
const MAX_PROJECTED_SCHEMA_BYTES = 4096;

const McpToolDefinition = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    inputSchema: JsonObject.optional(),
    annotations: JsonObject.optional(),
  })
  .strict();
export type McpToolDefinitionT = z.infer<typeof McpToolDefinition>;

const TrustedServer = z
  .object({
    workspaceRoot: z.string().min(1),
    serverKey: z.string().min(1),
    serverConfig: z
      .object({
        transport: z.literal("stdio"),
        command: z.string().min(1),
        args: z.array(z.string()),
        envKeys: z.array(z.string()),
        entrypointHash: z.string().regex(HASH_RE).nullable().optional(),
      })
      .strict(),
    protocolVersion: z.string().min(1),
    capabilities: JsonObject,
    tools: z.array(McpToolDefinition),
    pin: z.string().regex(HASH_RE),
    trustedAt: z.string(),
    state: z.enum(["trusted", "quarantined", "distrusted"]).default("trusted"),
    flapCount: z.number().int().nonnegative().default(0),
  })
  .strict();
export type TrustedMcpServerT = z.infer<typeof TrustedServer>;

const TrustStore = z
  .object({
    version: z.literal(1),
    servers: z.record(z.string(), TrustedServer),
  })
  .strict();
export type McpTrustStoreT = z.infer<typeof TrustStore>;

export interface McpPinInput {
  readonly serverConfig: McpStdioServerConfigT;
  readonly protocolVersion: string;
  readonly capabilities: JsonObjectT;
  readonly tools: readonly McpToolDefinitionT[];
  readonly entrypointHash?: string | null;
}

export interface NamespaceInput {
  readonly serverKey: string;
  readonly tools: readonly McpToolDefinitionT[];
}

export interface NamespacedMcpTool {
  readonly serverKey: string;
  readonly slug: string;
  readonly originalName: string;
  readonly advertisedName: string;
  readonly definition: McpToolDefinitionT;
}

export interface McpTrustQuarantineResult {
  readonly changed: boolean;
  readonly serverKey?: string;
  readonly state?: TrustedMcpServerT["state"];
  readonly flapCount?: number;
}

export function mcpTrustStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(keelHome(env), "mcp-trust.json");
}

function sha256Bytes(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stripAnsiCsi(value: string): string {
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
    output += value.charAt(i);
  }
  return output;
}

function replaceControlCharacters(value: string): string {
  let output = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    output += code !== undefined && (code <= 0x1f || code === 0x7f) ? " " : char;
  }
  return output;
}

function metadataSecretValues(
  serverConfig: Pick<McpStdioServerConfigT, "envKeys">,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  return [
    ...new Set(
      serverConfig.envKeys
        .map((key) => env[key])
        .filter((value): value is string => value !== undefined && value !== ""),
    ),
  ].sort((a, b) => b.length - a.length);
}

function redactExactSecrets(value: string, secrets: readonly string[]): string {
  let out = value;
  for (const secret of secrets) {
    out = out.split(secret).join("[redacted:mcp-env-value]");
  }
  return out;
}

function sanitizeMcpMetadataText(value: string, secrets: readonly string[]): string {
  return replaceControlCharacters(stripAnsiCsi(redactText(redactExactSecrets(value, secrets))))
    .replace(/\s+/gu, " ")
    .trim();
}

function sanitizeMcpMetadataJson(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return sanitizeMcpMetadataText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => sanitizeMcpMetadataJson(entry, secrets));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const safeKey = sanitizeMcpMetadataText(key, secrets) || "[redacted:mcp-key]";
      out[safeKey] = sanitizeMcpMetadataJson(entry, secrets);
    }
    return out;
  }
  return value;
}

function sanitizeMcpMetadataObject(value: JsonObjectT, secrets: readonly string[]): JsonObjectT {
  return JsonObject.parse(sanitizeMcpMetadataJson(value, secrets));
}

function sanitizeMcpToolForTrust(
  tool: McpToolDefinitionT,
  secrets: readonly string[],
): McpToolDefinitionT {
  const sanitizedName = sanitizeMcpMetadataText(tool.name, secrets);
  if (sanitizedName !== tool.name) {
    throw new Error("MCP discovery returned an unsafe MCP tool name");
  }
  return McpToolDefinition.parse({
    name: tool.name,
    ...(tool.description === undefined
      ? {}
      : { description: sanitizeMcpMetadataText(tool.description, secrets) }),
    ...(tool.inputSchema === undefined
      ? {}
      : { inputSchema: sanitizeMcpMetadataObject(tool.inputSchema, secrets) }),
    ...(tool.annotations === undefined
      ? {}
      : { annotations: sanitizeMcpMetadataObject(tool.annotations, secrets) }),
  });
}

export function sanitizeMcpPinInputForTrust(
  input: McpPinInput,
  env: NodeJS.ProcessEnv,
): McpPinInput {
  const secrets = metadataSecretValues(input.serverConfig, env);
  const protocolVersion = sanitizeMcpMetadataText(input.protocolVersion, secrets);
  if (protocolVersion !== input.protocolVersion) {
    throw new Error("MCP discovery returned an unsafe protocolVersion");
  }
  return {
    ...input,
    protocolVersion,
    capabilities: sanitizeMcpMetadataObject(input.capabilities, secrets),
    tools: input.tools.map((tool) => sanitizeMcpToolForTrust(tool, secrets)),
  };
}

export function resolvableMcpEntrypointHash(
  serverConfig: Pick<McpStdioServerConfigT, "command">,
  workspaceRoot: string,
): string | undefined {
  const command = serverConfig.command;
  if (!command.includes("/") && !command.startsWith(".")) return undefined;
  const path = command.startsWith("/") ? command : resolve(workspaceRoot, command);
  try {
    return sha256Bytes(readFileSync(path));
  } catch {
    return undefined;
  }
}

function mcpTrustStoreServerKey(workspaceRoot: string, serverKey: string): string {
  const workspaceHash = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return `${workspaceHash}:${serverKey}`;
}

function findMcpTrustStoreEntry(
  store: McpTrustStoreT,
  workspaceRoot: string,
  serverKey: string,
): { readonly key: string; readonly server: TrustedMcpServerT } | undefined {
  const scopedKey = mcpTrustStoreServerKey(workspaceRoot, serverKey);
  const scoped = store.servers[scopedKey];
  if (scoped !== undefined) return { key: scopedKey, server: scoped };
  for (const [key, server] of Object.entries(store.servers)) {
    if (server.workspaceRoot === workspaceRoot && server.serverKey === serverKey) {
      return { key, server };
    }
  }
  return undefined;
}

function withMcpTrustStoreEntry(
  store: McpTrustStoreT,
  oldKey: string | undefined,
  newKey: string,
  server: TrustedMcpServerT,
): McpTrustStoreT {
  const servers = { ...store.servers };
  if (oldKey !== undefined && oldKey !== newKey) delete servers[oldKey];
  servers[newKey] = server;
  return { version: 1, servers };
}

function normalizeTool(tool: McpToolDefinitionT): McpToolDefinitionT {
  return McpToolDefinition.parse(tool);
}

type NormalizedToolPin = JsonObjectT & { readonly name: string };

function normalizedToolPin(tool: McpToolDefinitionT): NormalizedToolPin {
  return JSON.parse(JSON.stringify(normalizeTool(tool))) as NormalizedToolPin;
}

export function canonicalMcpToolPin(input: McpPinInput): string {
  return canonicalMcpToolPinForLaunch({
    server: {
      transport: "stdio",
      command: input.serverConfig.command,
      args: input.serverConfig.args,
      envKeys: [...new Set(input.serverConfig.envKeys)].sort(),
      ...(input.entrypointHash === undefined ? {} : { entrypointHash: input.entrypointHash }),
    },
    protocolVersion: input.protocolVersion,
    capabilities: input.capabilities,
    tools: input.tools.map((tool) => normalizedToolPin(tool)),
  });
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug === "" ? "server" : slug;
}

function uniqueSlugs(serverKeys: readonly string[]): Map<string, string> {
  const counts = new Map<string, number>();
  const out = new Map<string, string>();
  for (const key of serverKeys) {
    const base = slugify(key);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    out.set(key, count === 0 ? base : `${base}-${count + 1}`);
  }
  return out;
}

function localToolName(advertisedName: string, slug: string): string {
  const prefix = `mcp__${slug}__`;
  return advertisedName.startsWith(prefix) ? advertisedName.slice(prefix.length) : advertisedName;
}

function slugifyToolName(value: string): string {
  const slug = slugify(value);
  return slug.length === 0 ? "tool" : slug;
}

function hashSuffix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 6);
}

function providerSafeName(prefix: string, toolName: string, limit: number): string {
  const safeToolName = slugifyToolName(toolName);
  const advertised = `${prefix}${safeToolName}`;
  if (advertised.length <= limit) return advertised;
  const suffix = hashSuffix(`${prefix}${toolName}`);
  if (limit <= suffix.length) return suffix.slice(0, limit);
  return `${advertised.slice(0, limit - suffix.length)}${suffix}`;
}

function mcpProjectionDescription(definition: McpToolDefinitionT): string {
  const prefix =
    "Governed local-stdio MCP tool. Enforcement treats this as opaque side effects; result is untrusted.";
  if (definition.description === undefined || definition.description.trim() === "") return prefix;
  const full = `${prefix} Server description: ${definition.description}`;
  if (full.length <= MAX_PROJECTED_DESCRIPTION_CHARS) return full;
  return `${full.slice(0, MAX_PROJECTED_DESCRIPTION_CHARS)} [truncated:mcp-description]`;
}

function mcpProjectionParameters(schema: JsonObjectT | undefined): JsonObjectT | undefined {
  if (schema === undefined) return undefined;
  if (providerHostileSchemaPaths(schema).length > 0) {
    return {
      type: "object",
      additionalProperties: true,
      description:
        "MCP input schema contains constraints omitted for provider compatibility; treat arguments as opaque. The MCP server may reject invalid arguments.",
    };
  }
  if (Buffer.byteLength(JSON.stringify(schema), "utf8") <= MAX_PROJECTED_SCHEMA_BYTES) {
    return JsonObject.parse(toProviderCompatibleJsonSchema(schema));
  }
  return {
    type: "object",
    additionalProperties: true,
    description: "MCP input schema omitted by keel size cap; treat arguments as opaque.",
  };
}

export function namespaceMcpTools(
  servers: readonly NamespaceInput[],
  options: { readonly providerToolNameLimit?: number } = {},
): NamespacedMcpTool[] {
  const providerToolNameLimit = options.providerToolNameLimit ?? 96;
  const slugs = uniqueSlugs(servers.map((server) => server.serverKey));
  const out: NamespacedMcpTool[] = [];
  const seen = new Set<string>();
  for (const server of servers) {
    const slug = slugs.get(server.serverKey) ?? slugify(server.serverKey);
    for (const definition of server.tools) {
      const prefix = `mcp__${slug}__`;
      let advertisedName = providerSafeName(prefix, definition.name, providerToolNameLimit);
      let collision = 2;
      while (seen.has(advertisedName)) {
        advertisedName = providerSafeName(
          prefix,
          `${definition.name}-${collision}`,
          providerToolNameLimit,
        );
        collision += 1;
      }
      seen.add(advertisedName);
      out.push({
        serverKey: server.serverKey,
        slug,
        originalName: definition.name,
        advertisedName,
        definition,
      });
    }
  }
  return out;
}

export function loadMcpTrustStore(env: NodeJS.ProcessEnv = process.env): McpTrustStoreT {
  try {
    const parsed = TrustStore.safeParse(JSON.parse(readFileSync(mcpTrustStorePath(env), "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    /* absent or invalid store: fail closed to no trusted MCP tools */
  }
  return { version: 1, servers: {} };
}

export function saveMcpTrustedServer(
  input: Omit<TrustedMcpServerT, "state" | "trustedAt" | "flapCount">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const sanitizedServerConfig = {
    ...input.serverConfig,
    envKeys: [...new Set(input.serverConfig.envKeys)].sort(),
  };
  const sanitizedMetadata = sanitizeMcpPinInputForTrust(
    {
      serverConfig: sanitizedServerConfig,
      protocolVersion: input.protocolVersion,
      capabilities: input.capabilities,
      tools: input.tools,
      ...(input.serverConfig.entrypointHash === undefined
        ? {}
        : { entrypointHash: input.serverConfig.entrypointHash }),
    },
    env,
  );
  const pin = canonicalMcpToolPin(sanitizedMetadata);
  // Lock the read-modify-write so concurrent sessions cannot lose a trust update; the write is atomic.
  withFileLock(mcpTrustStorePath(env), () => {
    const store = loadMcpTrustStore(env);
    const existing = findMcpTrustStoreEntry(store, input.workspaceRoot, input.serverKey);
    const next = withMcpTrustStoreEntry(
      store,
      existing?.key,
      mcpTrustStoreServerKey(input.workspaceRoot, input.serverKey),
      TrustedServer.parse({
        ...input,
        serverConfig: sanitizedServerConfig,
        protocolVersion: sanitizedMetadata.protocolVersion,
        capabilities: sanitizedMetadata.capabilities,
        tools: sanitizedMetadata.tools,
        pin,
        state: "trusted",
        trustedAt: new Date().toISOString(),
        flapCount: 0,
      }),
    );
    persistMcpTrustStore(next, env);
  });
}

export function recordMcpDiscoveryCheck(
  input: McpPinInput & {
    readonly workspaceRoot: string;
    readonly serverKey: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): {
  readonly state: TrustedMcpServerT["state"];
  readonly changed: boolean;
  readonly pin: string;
  readonly flapCount: number;
} {
  // Lock the read-modify-write so a concurrent flap/quarantine update cannot be lost; writes atomic.
  return withFileLock(mcpTrustStorePath(env), () => {
    const store = loadMcpTrustStore(env);
    const entry = findMcpTrustStoreEntry(store, input.workspaceRoot, input.serverKey);
    const existing = entry?.server;
    const storeKey = mcpTrustStoreServerKey(input.workspaceRoot, input.serverKey);
    const sanitizedMetadata = sanitizeMcpPinInputForTrust(input, env);
    const pin = canonicalMcpToolPin(sanitizedMetadata);
    if (existing === undefined) {
      return { state: "quarantined" as const, changed: true, pin, flapCount: 1 };
    }
    if (existing.pin === pin) {
      const nextExisting = TrustedServer.parse(existing);
      persistMcpTrustStore(withMcpTrustStoreEntry(store, entry?.key, storeKey, nextExisting), env);
      return {
        state: nextExisting.state,
        changed: false,
        pin,
        flapCount: nextExisting.flapCount,
      };
    }

    const flapCount = existing.flapCount + 1;
    const state: TrustedMcpServerT["state"] = flapCount >= 3 ? "distrusted" : "quarantined";
    const changed = TrustedServer.parse({
      ...existing,
      serverConfig: sanitizedMetadata.serverConfig,
      protocolVersion: sanitizedMetadata.protocolVersion,
      capabilities: sanitizedMetadata.capabilities,
      tools: sanitizedMetadata.tools,
      pin,
      state,
      flapCount,
    });
    persistMcpTrustStore(withMcpTrustStoreEntry(store, entry?.key, storeKey, changed), env);
    return { state, changed: true, pin, flapCount };
  });
}

function persistMcpTrustStore(store: McpTrustStoreT, env: NodeJS.ProcessEnv): void {
  atomicWrite(mcpTrustStorePath(env), JSON.stringify(store, null, 2), {}, 0o600);
}

function trustedServerSafeForUse(
  server: TrustedMcpServerT,
  env: NodeJS.ProcessEnv,
): TrustedMcpServerT | undefined {
  try {
    const sanitizedMetadata = sanitizeMcpPinInputForTrust(
      {
        serverConfig: server.serverConfig,
        protocolVersion: server.protocolVersion,
        capabilities: server.capabilities,
        tools: server.tools,
        ...(server.serverConfig.entrypointHash === undefined
          ? {}
          : { entrypointHash: server.serverConfig.entrypointHash }),
      },
      env,
    );
    return TrustedServer.parse({
      ...server,
      protocolVersion: sanitizedMetadata.protocolVersion,
      capabilities: sanitizedMetadata.capabilities,
      tools: sanitizedMetadata.tools,
      pin: canonicalMcpToolPin(sanitizedMetadata),
    });
  } catch {
    return undefined;
  }
}

function trustedServersForWorkspace(options: {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly providerToolNameLimit?: number;
}): {
  readonly server: TrustedMcpServerT;
  readonly slug: string;
  readonly tools: readonly NamespacedMcpTool[];
}[] {
  const env = options.env ?? process.env;
  const store = loadMcpTrustStore(env);
  const workspaceServers = Object.values(store.servers)
    .filter((server) => server.workspaceRoot === options.workspaceRoot)
    .map((server) => trustedServerSafeForUse(server, env))
    .filter((server): server is TrustedMcpServerT => server !== undefined)
    .sort((a, b) => a.serverKey.localeCompare(b.serverKey));
  const trusted = workspaceServers.filter((server) => server.state === "trusted");
  const namespaceOptions =
    options.providerToolNameLimit === undefined
      ? {}
      : { providerToolNameLimit: options.providerToolNameLimit };
  const namespaced = namespaceMcpTools(
    workspaceServers.map((server) => ({ serverKey: server.serverKey, tools: server.tools })),
    namespaceOptions,
  );
  return trusted.map((server) => {
    const tools = namespaced.filter((tool) => tool.serverKey === server.serverKey);
    return {
      server,
      slug: tools[0]?.slug ?? slugify(server.serverKey),
      tools,
    };
  });
}

function serversForWorkspace(options: {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly state?: TrustedMcpServerT["state"];
}): TrustedMcpServerT[] {
  const store = loadMcpTrustStore(options.env ?? process.env);
  return Object.values(store.servers)
    .filter(
      (server) =>
        server.workspaceRoot === options.workspaceRoot &&
        (options.state === undefined || server.state === options.state),
    )
    .sort((a, b) => a.serverKey.localeCompare(b.serverKey));
}

function slugForServerAmong(
  server: TrustedMcpServerT,
  servers: readonly TrustedMcpServerT[],
): string {
  const slugs = uniqueSlugs(
    [...servers]
      .sort((a, b) => a.serverKey.localeCompare(b.serverKey))
      .map((candidate) => candidate.serverKey),
  );
  return slugs.get(server.serverKey) ?? slugify(server.serverKey);
}

function findServerBySlug(options: {
  readonly workspaceRoot: string;
  readonly serverSlug: string;
  readonly expectedPin?: string;
  readonly env?: NodeJS.ProcessEnv;
}): TrustedMcpServerT | undefined {
  const trusted = serversForWorkspace({
    workspaceRoot: options.workspaceRoot,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const matchingTrusted = trusted.find(
    (server) =>
      server.state === "trusted" &&
      slugForServerAmong(server, trusted) === options.serverSlug &&
      (options.expectedPin === undefined || server.pin === options.expectedPin),
  );
  if (matchingTrusted !== undefined) return matchingTrusted;

  const allWorkspaceServers = serversForWorkspace({
    workspaceRoot: options.workspaceRoot,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  return allWorkspaceServers.find(
    (server) =>
      slugForServerAmong(server, allWorkspaceServers) === options.serverSlug &&
      (options.expectedPin === undefined || server.pin === options.expectedPin),
  );
}

export function quarantineMcpTrustedServerBySlug(
  options: {
    readonly workspaceRoot: string;
    readonly serverSlug: string;
    readonly expectedPin?: string;
    readonly observedPin?: string | null;
    readonly reason: "pin-mismatch" | "list-changed";
  },
  env: NodeJS.ProcessEnv = process.env,
): McpTrustQuarantineResult {
  const server = findServerBySlug({
    workspaceRoot: options.workspaceRoot,
    serverSlug: options.serverSlug,
    ...(options.expectedPin === undefined ? {} : { expectedPin: options.expectedPin }),
    env,
  });
  if (server === undefined) return { changed: false };
  // Lock the read-modify-write so a concurrent quarantine/flap update cannot be lost; writes atomic.
  return withFileLock(mcpTrustStorePath(env), () => {
    const store = loadMcpTrustStore(env);
    const entry = findMcpTrustStoreEntry(store, server.workspaceRoot, server.serverKey);
    const existing = entry?.server;
    if (existing === undefined) return { changed: false };
    const flapCount = existing.flapCount + 1;
    const state: TrustedMcpServerT["state"] = flapCount >= 3 ? "distrusted" : "quarantined";
    const nextServer = TrustedServer.parse({ ...existing, state, flapCount });
    persistMcpTrustStore(
      withMcpTrustStoreEntry(
        store,
        entry?.key,
        mcpTrustStoreServerKey(server.workspaceRoot, server.serverKey),
        nextServer,
      ),
      env,
    );
    return { changed: true, serverKey: server.serverKey, state, flapCount };
  });
}

export function advertisedMcpToolSpecs(options: {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly providerToolNameLimit?: number;
}): readonly ToolSpecT[] {
  return trustedServersForWorkspace(options).flatMap(({ tools }) =>
    tools.slice(0, MAX_PROJECTED_MCP_TOOLS).map((tool) => ({
      name: tool.advertisedName,
      description: mcpProjectionDescription(tool.definition),
      ...(mcpProjectionParameters(tool.definition.inputSchema) === undefined
        ? {}
        : { parameters: mcpProjectionParameters(tool.definition.inputSchema) }),
    })),
  );
}

export function advertisedMcpToolNamesForServer(options: {
  readonly workspaceRoot: string;
  readonly serverKey: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly providerToolNameLimit?: number;
}): readonly string[] {
  return (
    trustedServersForWorkspace(options)
      .find(({ server }) => server.serverKey === options.serverKey)
      ?.tools.map((tool) => tool.advertisedName) ?? []
  );
}

export function trustedMcpServersEnvValue(options: {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly providerToolNameLimit?: number;
}): string | undefined {
  const servers = trustedServersForWorkspace(options);
  if (servers.length === 0) return undefined;
  return encodeTrustedMcpServersEnv(
    Object.fromEntries(
      servers.map(({ server, slug, tools }) => [
        slug,
        {
          transport: "stdio",
          command: server.serverConfig.command,
          args: server.serverConfig.args,
          envKeys: [...server.serverConfig.envKeys].sort(),
          ...(server.serverConfig.entrypointHash === undefined
            ? {}
            : { entrypointHash: server.serverConfig.entrypointHash }),
          serverKey: server.serverKey,
          pin: server.pin,
          tools: tools.map((tool) => ({
            name: localToolName(tool.advertisedName, slug),
            serverToolName: tool.originalName,
            ...(tool.definition.description === undefined
              ? {}
              : { description: tool.definition.description }),
            ...(tool.definition.inputSchema === undefined
              ? {}
              : { inputSchema: tool.definition.inputSchema }),
            ...(tool.definition.annotations === undefined
              ? {}
              : { annotations: tool.definition.annotations }),
          })),
        },
      ]),
    ),
  );
}

export function mcpTrustedServersChildEnv(options: {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly workspaceTrusted?: boolean;
}): NodeJS.ProcessEnv {
  const env = options.env ?? process.env;
  if (options.workspaceTrusted !== true) return { [MCP_TRUSTED_SERVERS_ENV]: "" };
  const value = trustedMcpServersEnvValue({ workspaceRoot: options.workspaceRoot, env });
  return { [MCP_TRUSTED_SERVERS_ENV]: value ?? "" };
}
