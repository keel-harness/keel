import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalMcpToolPinForLaunch,
  encodeTrustedMcpServersEnv,
  INTERNAL_MCP_DISCOVERY_ENV,
  MCP_DISCOVERY_REQUEST_ENV,
  MCP_TRUSTED_SERVERS_ENV,
  parseMcpDiscoveryResult,
  type JsonObjectT,
  type McpDiscoveryResult,
  type McpPinLaunchInput,
  type McpStdioLaunchConfig,
  type McpToolDefinitionForPin,
  type TrustedMcpServerConfig,
  type TrustedMcpServers,
} from "@keel/shared";
import type { CredentialProxyRule } from "../credential-proxy.js";
import type { SandboxExecutionResult, SandboxPort } from "../sandbox.js";
import { mcpExactRedactionsForEnvKeys, modelTextFromMcpSandboxResult } from "./result.js";
import { buildMcpSandboxProfile } from "./sandbox-profile.js";

export {
  buildMcpOpaquePolicyInput,
  mcpHasSecretSensitiveArgs,
  withMcpSensitivityPolicy,
} from "./policy.js";
export {
  inertMcpResourceLinks,
  mcpExactRedactionsForEnvKeys,
  mcpSandboxResultIsError,
  modelTextFromMcpSandboxResult,
  refuseUnsupportedMcpClientRequest,
  sanitizeMcpText,
} from "./result.js";
export { buildMcpSandboxProfile } from "./sandbox-profile.js";

// The pure MCP wire/launch contracts now live in `@keel/shared` (ADR-0071 P1-10). Re-export
// them so the warden's public surface (and the in-package consumers below) are unchanged;
// the kernel imports these from `@keel/shared`, not from the warden library.
export {
  canonicalMcpToolPinForLaunch,
  encodeTrustedMcpServersEnv,
  INTERNAL_MCP_DISCOVERY_ENV,
  MCP_DISCOVERY_REQUEST_ENV,
  MCP_TRUSTED_SERVERS_ENV,
  parseMcpDiscoveryResult,
  type McpDiscoveryResult,
  type McpPinLaunchInput,
  type McpStdioLaunchConfig,
  type McpToolDefinitionForPin,
  type TrustedMcpServerConfig,
  type TrustedMcpServers,
};

const HASH_RE = /^sha256:[0-9a-f]{64}$/u;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObjectT {
  return isObject(value);
}

function parseTrustedMcpServer(value: unknown): TrustedMcpServerConfig | undefined {
  if (!isObject(value)) return undefined;
  if (value["transport"] !== "stdio") return undefined;
  if ("env" in value) return undefined;
  const command = value["command"];
  const args = value["args"];
  const envKeys = value["envKeys"];
  const entrypointHash = value["entrypointHash"];
  const serverKey = value["serverKey"];
  const pin = value["pin"];
  const tools = value["tools"];
  if (typeof command !== "string" || command.trim() === "") return undefined;
  if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string")) {
    return undefined;
  }
  if (
    envKeys !== undefined &&
    (!Array.isArray(envKeys) ||
      !envKeys.every((entry): entry is string => typeof entry === "string"))
  ) {
    return undefined;
  }
  if (
    entrypointHash !== undefined &&
    entrypointHash !== null &&
    typeof entrypointHash !== "string"
  ) {
    return undefined;
  }
  if (typeof entrypointHash === "string" && !HASH_RE.test(entrypointHash)) return undefined;
  if (serverKey !== undefined && typeof serverKey !== "string") return undefined;
  if (typeof pin !== "string" || !HASH_RE.test(pin)) return undefined;
  if (!Array.isArray(tools)) return undefined;
  const parsedTools: Array<TrustedMcpServerConfig["tools"][number]> = [];
  for (const tool of tools) {
    if (!isObject(tool)) return undefined;
    const name = tool["name"];
    const serverToolName = tool["serverToolName"];
    const description = tool["description"];
    const inputSchema = tool["inputSchema"];
    const annotations = tool["annotations"];
    if (typeof name !== "string" || name.trim() === "") return undefined;
    if (serverToolName !== undefined && typeof serverToolName !== "string") return undefined;
    if (description !== undefined && typeof description !== "string") return undefined;
    if (inputSchema !== undefined && !isJsonObject(inputSchema)) return undefined;
    if (annotations !== undefined && !isJsonObject(annotations)) return undefined;
    parsedTools.push({
      name,
      ...(serverToolName === undefined ? {} : { serverToolName }),
      ...(description === undefined ? {} : { description }),
      ...(inputSchema === undefined ? {} : { inputSchema }),
      ...(annotations === undefined ? {} : { annotations }),
    });
  }
  return {
    transport: "stdio",
    command,
    args,
    ...(envKeys === undefined ? {} : { envKeys: [...new Set(envKeys)].sort() }),
    ...(entrypointHash === undefined ? {} : { entrypointHash }),
    ...(serverKey === undefined ? {} : { serverKey }),
    pin,
    tools: parsedTools,
  };
}

export function mcpTrustedServersFromEnv(env: NodeJS.ProcessEnv = process.env): TrustedMcpServers {
  const raw = env[MCP_TRUSTED_SERVERS_ENV];
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isObject(parsed) || parsed["version"] !== 1 || !isObject(parsed["servers"])) return {};
  const servers: Record<string, TrustedMcpServerConfig> = {};
  for (const [id, server] of Object.entries(parsed["servers"])) {
    if (!/^[a-z0-9-]+$/u.test(id)) return {};
    const trusted = parseTrustedMcpServer(server);
    if (trusted === undefined) return {};
    servers[id] = trusted;
  }
  return servers;
}

const MAX_MCP_STDIO_BYTES = 262_144;
const MCP_CALL_TIMEOUT_MS = 5_000;

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

/* v8 ignore start -- serialized child process source: mcp-runner.test.ts exercises the materialized module, which coverage cannot map back to this file */
async function mcpOneShotRunnerMain(payloadRef: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { readFileSync, unlinkSync } = await import("node:fs");
  const nodePath = await import("node:path");

  type RunnerJsonObject = Record<string, unknown>;
  interface RunnerPayload {
    readonly server: {
      readonly command: string;
      readonly args: readonly string[];
      readonly envKeys?: readonly string[];
      readonly entrypointHash?: string | null;
    };
    readonly timeoutMs: number;
    readonly maxBytes: number;
    readonly mode: "call" | "discover";
    readonly toolName?: string;
    readonly toolArgs?: unknown;
    readonly expectedPin?: string;
  }
  interface RunnerFrame {
    readonly id?: unknown;
    readonly method?: unknown;
    readonly error?: { readonly message?: unknown };
    readonly result?: unknown;
  }
  interface NormalizedTool {
    name: string;
    description?: string;
    inputSchema?: RunnerJsonObject;
    annotations?: RunnerJsonObject;
  }

  function isObject(value: unknown): value is RunnerJsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  if (!payloadRef.startsWith("@")) {
    throw new Error("MCP runner payload file is required");
  }
  const payload = JSON.parse(readFileSync(payloadRef.slice(1), "utf8")) as RunnerPayload;
  try {
    unlinkSync(payloadRef.slice(1));
  } catch {
    // Best-effort removal; the parent removes the declared temp root after execution.
  }

  const initId = 1;
  const listId = 2;
  const callId = 3;
  const MCP_DEFINITION_CHANGE_MARKER = "keel.mcp.definition_change.v1";
  let settled = false;
  let buffer = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let initializeResult: RunnerJsonObject = {};
  let initialized = false;
  let listRequested = false;
  let callRequested = false;
  let callCompleted = false;
  let pendingSuccess: unknown;
  let pendingSuccessTimer: NodeJS.Timeout | undefined;
  const processState: {
    child?: import("node:child_process").ChildProcessWithoutNullStreams;
    timer?: ReturnType<typeof setTimeout>;
  } = {};

  function canonicalize(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    return `{${Object.entries(value as RunnerJsonObject)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(",")}}`;
  }

  function sha256(value: string | Uint8Array): string {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
  }

  function utf8Bytes(value: string): number {
    return new TextEncoder().encode(value).length;
  }

  function currentEntrypointHash(): string | null | undefined {
    if (!Object.prototype.hasOwnProperty.call(payload.server, "entrypointHash")) return undefined;
    const command = payload.server.command;
    if (!command.includes("/") && !command.startsWith(".")) return null;
    try {
      return sha256(
        readFileSync(command.startsWith("/") ? command : nodePath.resolve(process.cwd(), command)),
      );
    } catch {
      return null;
    }
  }

  function normalizedTool(tool: unknown): NormalizedTool | undefined {
    if (!isObject(tool)) return undefined;
    if (typeof tool["name"] !== "string" || tool["name"].trim() === "") return undefined;
    const out: Partial<NormalizedTool> & { name: string } = { name: tool["name"] };
    if (tool["description"] !== undefined) {
      if (typeof tool["description"] !== "string") return undefined;
      out.description = tool["description"];
    }
    if (tool["inputSchema"] !== undefined) {
      if (!isObject(tool["inputSchema"])) return undefined;
      out.inputSchema = tool["inputSchema"];
    }
    if (tool["annotations"] !== undefined) {
      if (!isObject(tool["annotations"])) return undefined;
      out.annotations = tool["annotations"];
    }
    return JSON.parse(JSON.stringify(out)) as NormalizedTool;
  }

  function pinForListedTools(result: unknown): string | undefined {
    if (!isObject(result) || !Array.isArray(result["tools"])) return undefined;
    const tools = result["tools"].map((tool) => normalizedTool(tool));
    if (tools.some((tool) => tool === undefined)) return undefined;
    const envKeys = [...new Set(payload.server.envKeys ?? [])].sort();
    const entrypointHash = currentEntrypointHash();
    return sha256(
      canonicalize({
        server: {
          transport: "stdio",
          command: payload.server.command,
          args: payload.server.args,
          envKeys,
          ...(entrypointHash === undefined ? {} : { entrypointHash }),
        },
        protocolVersion: initializeResult["protocolVersion"] ?? "unknown",
        capabilities: initializeResult["capabilities"] ?? {},
        tools: (tools as NormalizedTool[]).sort((a, b) =>
          canonicalize(a).localeCompare(canonicalize(b)),
        ),
      }),
    );
  }

  function send(frame: RunnerJsonObject): void {
    if (processState.child === undefined) throw new Error("MCP stdio server is not running");
    processState.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  function signalChild(signal: NodeJS.Signals): void {
    const currentChild = processState.child;
    if (currentChild === undefined) return;
    try {
      if (currentChild.pid !== undefined) process.kill(-currentChild.pid, signal);
      else currentChild.kill(signal);
    } catch {
      try {
        currentChild.kill(signal);
      } catch {
        // Best effort; bounded exit timers still guard this path.
      }
    }
  }

  function stopChild(): void {
    const currentChild = processState.child;
    if (currentChild === undefined) return;
    try {
      currentChild.stdin.end();
    } catch {
      // Continue to signal the process group.
    }
    signalChild("SIGTERM");
  }

  function childProcessGroupExists(
    child: import("node:child_process").ChildProcessWithoutNullStreams,
  ): boolean {
    if (child.pid === undefined) return child.exitCode === null;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function exitAfterChild(exitCode: number): void {
    const currentChild = processState.child;
    if (currentChild === undefined) {
      setImmediate(() => process.exit(exitCode));
      return;
    }
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer);
      clearTimeout(giveUpTimer);
      clearInterval(cleanupPoll);
      process.exit(exitCode);
    };
    const finishIfGroupGone = (): void => {
      if (!childProcessGroupExists(currentChild)) finish();
    };
    const forceTimer = setTimeout(() => {
      signalChild("SIGKILL");
    }, 250);
    const giveUpTimer = setTimeout(() => {
      finish();
    }, 1000);
    const cleanupPoll = setInterval(finishIfGroupGone, 25);
    currentChild.once("close", finishIfGroupGone);
    stopChild();
    finishIfGroupGone();
  }

  function clearPendingSuccess(): void {
    if (pendingSuccessTimer !== undefined) {
      clearTimeout(pendingSuccessTimer);
      pendingSuccessTimer = undefined;
      pendingSuccess = undefined;
    }
  }

  function handleExternalSignal(): void {
    if (settled) return;
    settled = true;
    clearPendingSuccess();
    clearTimeout(processState.timer);
    exitAfterChild(143);
  }

  process.once("SIGTERM", handleExternalSignal);
  process.once("SIGINT", handleExternalSignal);
  process.once("SIGHUP", handleExternalSignal);

  const childEnv = Object.fromEntries(
    (payload.server.envKeys ?? [])
      .filter((key) => Object.prototype.hasOwnProperty.call(process.env, key))
      .map((key) => [key, process.env[key]]),
  );
  const child = spawn(payload.server.command, [...payload.server.args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
    detached: true,
  });
  processState.child = child;

  processState.timer = setTimeout(() => {
    fail("MCP_TIMEOUT", "MCP stdio server did not complete before the bounded deadline", 124);
  }, payload.timeoutMs);

  function writeResult(value: unknown, exitCode: number): void {
    if (settled) return;
    settled = true;
    clearPendingSuccess();
    clearTimeout(processState.timer);
    process.stdout.write(`${JSON.stringify(value)}\n`, () => exitAfterChild(exitCode));
  }

  function fail(code: string, message: string, exitCode = 1): void {
    writeResult(
      { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] },
      exitCode,
    );
  }

  function scheduleSuccess(value: unknown): void {
    if (settled) return;
    if (pendingSuccess !== undefined) {
      fail("MCP_PROTOCOL_ERROR", "server emitted duplicate tools/call responses");
      return;
    }
    callCompleted = true;
    pendingSuccess = value;
    pendingSuccessTimer = setTimeout(() => {
      pendingSuccessTimer = undefined;
      const result = pendingSuccess;
      pendingSuccess = undefined;
      writeResult(result, 0);
    }, 25);
  }

  function refuseClientRequest(frame: RunnerFrame): void {
    if (frame.id === undefined || frame.id === null) return;
    send({
      jsonrpc: "2.0",
      id: frame.id,
      error: {
        code: -32601,
        message: "MCP capability not supported by keel local-stdio tools-only slice",
      },
    });
  }

  function frameMessage(frame: RunnerFrame, fallback: string): string {
    const message = frame.error?.message;
    if (typeof message === "string") return message;
    if (typeof message === "number" || typeof message === "boolean") return String(message);
    return fallback;
  }

  function handleFrame(line: string): void {
    if (settled) return;
    let frame: RunnerFrame;
    try {
      frame = JSON.parse(line) as RunnerFrame;
    } catch {
      fail("MCP_PROTOCOL_ERROR", "server emitted malformed JSON-RPC");
      return;
    }
    if (frame.id === initId) {
      if (initialized || listRequested || callRequested || callCompleted) {
        fail("MCP_PROTOCOL_ERROR", "server emitted a duplicate initialize response");
        return;
      }
      if (frame.error !== undefined) {
        fail("MCP_INITIALIZE_FAILED", frameMessage(frame, "initialize failed"));
        return;
      }
      initializeResult = isObject(frame.result) ? frame.result : {};
      initialized = true;
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      listRequested = true;
      send({ jsonrpc: "2.0", id: listId, method: "tools/list", params: {} });
      return;
    }
    if (frame.id === listId) {
      if (!initialized || !listRequested || callRequested || callCompleted) {
        fail("MCP_PROTOCOL_ERROR", "server emitted an out-of-order tools/list response");
        return;
      }
      if (frame.error !== undefined) {
        fail("MCP_TOOL_ERROR", frameMessage(frame, "MCP tools/list failed"));
        return;
      }
      if (!isObject(frame.result)) {
        fail("MCP_TOOL_ERROR", "MCP tools/list returned an invalid result");
        return;
      }
      if (payload.mode === "discover") {
        scheduleSuccess({
          protocolVersion: initializeResult["protocolVersion"] ?? "unknown",
          capabilities: initializeResult["capabilities"] ?? {},
          tools: Array.isArray(frame.result["tools"]) ? frame.result["tools"] : [],
        });
        return;
      }
      const observedPin = pinForListedTools(frame.result);
      if (observedPin === undefined || observedPin !== payload.expectedPin) {
        writeResult(
          {
            isError: true,
            marker: MCP_DEFINITION_CHANGE_MARKER,
            kind: "mcp_pin_mismatch",
            expectedPin: payload.expectedPin ?? null,
            observedPin: observedPin ?? null,
            content: [
              {
                type: "text",
                text: "MCP_PIN_MISMATCH: MCP tool definition changed before invocation",
              },
            ],
          },
          70,
        );
        return;
      }
      callRequested = true;
      send({
        jsonrpc: "2.0",
        id: callId,
        method: "tools/call",
        params: { name: payload.toolName, arguments: payload.toolArgs },
      });
      return;
    }
    if (frame.id === callId) {
      if (!callRequested || callCompleted) {
        fail("MCP_PROTOCOL_ERROR", "server emitted an out-of-order tools/call response");
        return;
      }
      if (frame.error !== undefined) {
        fail("MCP_TOOL_ERROR", frameMessage(frame, "MCP request failed"));
        return;
      }
      if (!isObject(frame.result)) {
        fail("MCP_TOOL_ERROR", "MCP request returned an invalid result");
        return;
      }
      scheduleSuccess(frame.result);
      return;
    }
    if (typeof frame.method === "string") {
      if (frame.method === "notifications/tools/list_changed") {
        writeResult(
          {
            isError: true,
            marker: MCP_DEFINITION_CHANGE_MARKER,
            kind: "mcp_tools_list_changed",
            content: [
              {
                type: "text",
                text: "MCP_TOOLS_LIST_CHANGED: MCP server changed tool definitions during invocation",
              },
            ],
          },
          70,
        );
        return;
      }
      refuseClientRequest(frame);
      return;
    }
    if (frame.id !== undefined) {
      fail("MCP_PROTOCOL_ERROR", "server emitted an unexpected JSON-RPC response id");
    }
  }

  child.once("error", (error) => {
    fail("MCP_SPAWN_FAILED", error instanceof Error ? error.message : String(error));
  });

  child.once("exit", (code, signal) => {
    if (pendingSuccess !== undefined) {
      signalChild("SIGTERM");
    }
    if (!settled && pendingSuccess === undefined) {
      fail(
        "MCP_SERVER_EXIT",
        `server exited before completing the tool call: ${String(code ?? signal)}`,
      );
    }
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBytes += utf8Bytes(chunk);
    if (stdoutBytes > payload.maxBytes) {
      fail("MCP_FRAME_LIMIT", "server stdout exceeded the MCP frame budget");
      return;
    }
    buffer += chunk;
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim() !== "") handleFrame(line);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBytes += utf8Bytes(chunk);
    if (stderrBytes > payload.maxBytes) {
      fail("MCP_STDERR_LIMIT", "server stderr exceeded the MCP log budget");
    }
  });

  send({
    jsonrpc: "2.0",
    id: initId,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "keel", version: "0.0.0" },
    },
  });
}
/* v8 ignore stop */

function mcpOneShotRunnerSource(): string {
  const runner = mcpOneShotRunnerMain
    .toString()
    .replace(/\b__vite_ssr_dynamic_import__\(/gu, "import(")
    .replace(/\b__name\b/gu, "keelRunnerIdentity");
  return `const keelRunnerIdentity = (value) => value;
void (${runner})(process.argv[2] ?? "").catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({
    isError: true,
    content: [{ type: "text", text: "MCP_RUNNER_FAILED: " + message }]
  }) + "\\n");
  process.exit(1);
});`;
}

function mcpOneShotCommand(
  payload: JsonObjectT,
  options: { readonly payloadFilePath: string },
): string {
  mkdirSync(dirname(options.payloadFilePath), { recursive: true, mode: 0o700 });
  const runnerFilePath = `${options.payloadFilePath}.runner.mjs`;
  writeFileSync(runnerFilePath, mcpOneShotRunnerSource(), { mode: 0o600 });
  writeFileSync(options.payloadFilePath, JSON.stringify(payload), { mode: 0o600 });
  return `${shellQuote(process.execPath)} ${shellQuote(runnerFilePath)} ${shellQuote(
    `@${options.payloadFilePath}`,
  )}`;
}

function launchPayload(server: McpStdioLaunchConfig, extra: JsonObjectT): JsonObjectT {
  return {
    server: {
      command: server.command,
      args: [...server.args],
      ...(server.envKeys === undefined ? {} : { envKeys: [...server.envKeys] }),
      ...(server.entrypointHash === undefined ? {} : { entrypointHash: server.entrypointHash }),
    },
    timeoutMs: MCP_CALL_TIMEOUT_MS,
    maxBytes: MAX_MCP_STDIO_BYTES,
    ...extra,
  };
}

export function mcpSandboxCommand(
  server: TrustedMcpServerConfig,
  toolName: string,
  toolArgs: JsonObjectT = {},
  options: { readonly payloadFilePath: string },
): string {
  return mcpOneShotCommand(
    launchPayload(server, {
      mode: "call",
      toolName,
      toolArgs,
      expectedPin: server.pin,
    }),
    options,
  );
}

export function mcpDiscoverySandboxCommand(
  server: McpStdioLaunchConfig,
  options: { readonly payloadFilePath: string },
): string {
  return mcpOneShotCommand(launchPayload(server, { mode: "discover" }), options);
}

export async function discoverMcpServerWithSandbox(options: {
  readonly sandbox: SandboxPort;
  readonly workspaceRoot: string;
  readonly server: McpStdioLaunchConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly declaredTempRoots?: readonly string[];
  readonly auditDir?: string;
  readonly credentialProxyRules?: readonly CredentialProxyRule[];
  readonly signal?: AbortSignal;
}): Promise<McpDiscoveryResult> {
  const payloadParent = options.declaredTempRoots?.[0] ?? tmpdir();
  const payloadTempDir = mkdtempSync(join(payloadParent, "keel-mcp-discovery-payload-"));
  let result: SandboxExecutionResult;
  try {
    const profile = buildMcpSandboxProfile({
      workspaceRoot: options.workspaceRoot,
      env: options.env ?? process.env,
      ...(options.auditDir === undefined ? {} : { auditDir: options.auditDir }),
      ...(options.credentialProxyRules === undefined
        ? {}
        : { credentialProxyRules: options.credentialProxyRules }),
      declaredTempRoots: [...(options.declaredTempRoots ?? []), payloadTempDir],
    });
    result = await options.sandbox.execute(
      {
        command: mcpDiscoverySandboxCommand(options.server, {
          payloadFilePath: join(payloadTempDir, "payload.json"),
        }),
        cwd: options.workspaceRoot,
      },
      profile,
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  } finally {
    rmSync(payloadTempDir, { recursive: true, force: true });
  }
  if (result.exitCode !== 0) {
    const exactRedactions = mcpExactRedactionsForEnvKeys(
      options.server.envKeys ?? [],
      options.env ?? process.env,
    );
    throw new Error(
      `MCP discovery failed: ${
        modelTextFromMcpSandboxResult(result, { exactRedactions }) || "server exited nonzero"
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("MCP discovery returned malformed JSON");
  }
  return parseMcpDiscoveryResult(parsed);
}
