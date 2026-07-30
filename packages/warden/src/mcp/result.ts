import { Buffer } from "node:buffer";
import { redactText } from "@keel/shared";
import type { SandboxExecutionResult } from "../sandbox.js";

const MAX_MCP_MODEL_RESULT_BYTES = 16_384;
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

export interface McpTextSanitizationOptions {
  readonly exactRedactions?: readonly string[];
}

export function mcpExactRedactionsForEnvKeys(
  envKeys: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return [
    ...new Set(
      envKeys
        .map((key) => env[key])
        .filter((value): value is string => value !== undefined && value !== ""),
    ),
  ].sort((a, b) => b.length - a.length);
}

function redactExactValues(value: string, redactions: readonly string[]): string {
  let output = value;
  for (const redaction of redactions) {
    if (redaction === "") continue;
    output = output.split(redaction).join("[redacted:mcp-env-value]");
  }
  return output;
}

function capBytes(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= MAX_MCP_MODEL_RESULT_BYTES) return value;
  let used = 0;
  let output = "";
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (used + charBytes > MAX_MCP_MODEL_RESULT_BYTES) break;
    output += char;
    used += charBytes;
  }
  return `${output}\n[truncated:mcp-result:${bytes}]`;
}

function neutralizeMcpDisplayControls(value: string): string {
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
  return output.replace(BIDI_CONTROL, "").replace(DEFAULT_IGNORABLE, "");
}

export function sanitizeMcpText(value: string, options: McpTextSanitizationOptions = {}): string {
  const redactions = options.exactRedactions ?? [];
  const rawRedacted = redactExactValues(value, redactions);
  const displaySafe = neutralizeMcpDisplayControls(rawRedacted);
  const normalizedRedactions = redactions
    .map((redaction) => neutralizeMcpDisplayControls(redaction))
    .filter((redaction) => redaction !== "");
  const exactRedacted = redactExactValues(displaySafe, normalizedRedactions);
  return redactText(exactRedacted.replace(/\s+/gu, " ").trim());
}

export function inertMcpResourceLinks(blocks: readonly unknown[]): string[] {
  return blocks.flatMap((block) => {
    if (typeof block !== "object" || block === null) return [];
    const record = block as Record<string, unknown>;
    const type = record["type"];
    if (type !== "resource_link" && type !== "resource") return [];
    const uri = record["uri"];
    return [`[mcp resource link omitted: ${typeof uri === "string" ? uri : "unknown"}]`];
  });
}

export function refuseUnsupportedMcpClientRequest(method: string): {
  readonly ok: false;
  readonly code: "MCP_CAPABILITY_NOT_SUPPORTED";
  readonly message: string;
} {
  return {
    ok: false,
    code: "MCP_CAPABILITY_NOT_SUPPORTED",
    message: `MCP ${method} is not supported in the local-stdio tools-only slice`,
  };
}

export function modelTextFromMcpSandboxResult(
  result: SandboxExecutionResult,
  options: McpTextSanitizationOptions = {},
): string {
  let text = "";
  try {
    const parsed = JSON.parse(result.stdout) as { content?: unknown };
    if (Array.isArray(parsed.content)) {
      const lines: string[] = [];
      for (const block of parsed.content) {
        if (typeof block !== "object" || block === null) continue;
        const record = block as Record<string, unknown>;
        if (record["type"] === "text" && typeof record["text"] === "string") {
          lines.push(record["text"]);
        }
      }
      lines.push(...inertMcpResourceLinks(parsed.content));
      text = lines.join("\n");
    }
  } catch {
    text = result.stdout;
  }
  return capBytes(sanitizeMcpText(text, options));
}

export function mcpSandboxResultIsError(result: SandboxExecutionResult): boolean {
  if (result.exitCode !== 0) return true;
  try {
    const parsed = JSON.parse(result.stdout) as { content?: unknown; isError?: unknown };
    if (parsed.isError === true) return true;
    return !Array.isArray(parsed.content);
  } catch {
    return true;
  }
}
