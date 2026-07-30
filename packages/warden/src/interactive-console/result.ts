import { Buffer } from "node:buffer";
import { z } from "zod";
import { redactText } from "@keel/shared";
import { ConsoleHandle, ConsoleTargetId } from "./schema.js";

export const DEFAULT_MAX_CONSOLE_SCREEN_BYTES = 16_384;

export interface ConsoleScreenSanitizationOptions {
  readonly exactRedactions?: readonly string[];
  readonly maxBytes?: number;
}

export const ConsoleScreenFrame = z
  .object({
    handle: ConsoleHandle,
    targetId: ConsoleTargetId,
    seq: z.number().int().nonnegative(),
    screen: z.string(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ConsoleScreenFrameT = z.infer<typeof ConsoleScreenFrame>;

export interface ConsoleScreenModelResult {
  readonly handle: string;
  readonly targetId: string;
  readonly seq: number;
  readonly screen: string;
  readonly truncated: boolean;
}

function redactExactValues(value: string, redactions: readonly string[]): string {
  let output = value;
  for (const redaction of redactions) {
    if (redaction !== "") {
      output = output.split(redaction).join("[redacted:interactive-console-exact]");
    }
  }
  return output;
}

function stripEscapedControlSequence(value: string, start: number): number {
  const introducer = value[start + 1];
  if (introducer === "[") {
    let index = start + 2;
    while (index < value.length) {
      const finalCode = value.charCodeAt(index);
      if (finalCode >= 0x40 && finalCode <= 0x7e) return index;
      index += 1;
    }
    return value.length - 1;
  }
  if (introducer === "]") {
    let index = start + 2;
    while (index < value.length) {
      if (value.charCodeAt(index) === 0x07) return index;
      if (value.charCodeAt(index) === 0x1b && value[index + 1] === "\\") return index + 1;
      index += 1;
    }
    return value.length - 1;
  }
  if (introducer === "P" || introducer === "^" || introducer === "_" || introducer === "X") {
    let index = start + 2;
    while (index < value.length) {
      if (value.charCodeAt(index) === 0x1b && value[index + 1] === "\\") return index + 1;
      index += 1;
    }
    return value.length - 1;
  }
  return Math.min(start + 1, value.length - 1);
}

function stripTerminalControls(value: string): string {
  let output = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x1b) {
      i = stripEscapedControlSequence(value, i);
      continue;
    }
    if (code === 0x9b) {
      while (i < value.length) {
        const finalCode = value.charCodeAt(i);
        if (finalCode >= 0x40 && finalCode <= 0x7e) break;
        i += 1;
      }
      continue;
    }
    if (code === 0x0a) {
      output += "\n";
      continue;
    }
    output += code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f) ? " " : value[i];
  }
  return output
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{5,}/gu, "\n\n\n\n")
    .trim();
}

function capBytes(
  value: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return { text: value, truncated: false };
  const marker = `\n[truncated:interactive-console-screen:${bytes}]`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes > maxBytes) {
    return { text: utf8Prefix(marker, maxBytes), truncated: true };
  }
  return {
    text: `${utf8Prefix(value, maxBytes - markerBytes)}${marker}`,
    truncated: true,
  };
}

function utf8Prefix(value: string, maxBytes: number): string {
  let used = 0;
  let output = "";
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (used + charBytes > maxBytes) break;
    output += char;
    used += charBytes;
  }
  return output;
}

function sanitizeConsoleScreen(
  value: string,
  options: ConsoleScreenSanitizationOptions = {},
): { readonly text: string; readonly truncated: boolean } {
  const stripped = stripTerminalControls(value);
  const exactRedacted = redactExactValues(stripped, options.exactRedactions ?? []);
  const redacted = redactText(exactRedacted);
  return capBytes(redacted, options.maxBytes ?? DEFAULT_MAX_CONSOLE_SCREEN_BYTES);
}

export function sanitizeConsoleScreenText(
  value: string,
  options: ConsoleScreenSanitizationOptions = {},
): string {
  return sanitizeConsoleScreen(value, options).text;
}

export function modelResultFromConsoleScreenFrame(
  frame: ConsoleScreenFrameT,
  options: ConsoleScreenSanitizationOptions = {},
): ConsoleScreenModelResult {
  const parsed = ConsoleScreenFrame.parse(frame);
  const sanitized = sanitizeConsoleScreen(parsed.screen, options);
  return {
    handle: parsed.handle,
    targetId: parsed.targetId,
    seq: parsed.seq,
    screen: sanitized.text,
    truncated: parsed.truncated === true || sanitized.truncated,
  };
}
