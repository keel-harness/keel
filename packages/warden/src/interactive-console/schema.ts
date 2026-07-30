import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolCallT } from "@keel/shared";

export const CONSOLE_TOOL_NAMES = {
  open: "interactive_console.open",
  sendKeys: "interactive_console.send_keys",
  readScreen: "interactive_console.read_screen",
  release: "interactive_console.release",
  close: "interactive_console.close",
} as const;

export type ConsoleToolName = (typeof CONSOLE_TOOL_NAMES)[keyof typeof CONSOLE_TOOL_NAMES];

export const MAX_CONSOLE_TARGET_ID_BYTES = 128;
export const MAX_CONSOLE_HANDLE_BYTES = 128;
export const MAX_CONSOLE_TEXT_TOKEN_BYTES = 1024;
export const MAX_CONSOLE_SEND_TEXT_BYTES = 4096;
export const MAX_CONSOLE_KEY_TOKENS = 128;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function containsControlBytes(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f))) {
      return true;
    }
  }
  return false;
}

function boundedId(name: string, maxBytes: number): z.ZodType<string> {
  return z
    .string()
    .min(1)
    .refine((value) => byteLength(value) <= maxBytes, {
      message: `${name} exceeds ${maxBytes} bytes`,
    })
    .refine((value) => /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value), {
      message: `${name} must contain only ASCII letters, digits, '.', '_', ':', or '-'`,
    });
}

export const ConsoleTargetId = boundedId("targetId", MAX_CONSOLE_TARGET_ID_BYTES);
export const ConsoleHandle = z
  .string()
  .min(1)
  .refine((value) => byteLength(value) <= MAX_CONSOLE_HANDLE_BYTES, {
    message: `handle exceeds ${MAX_CONSOLE_HANDLE_BYTES} bytes`,
  })
  .refine((value) => /^con_[A-Za-z0-9_-]+$/u.test(value), {
    message: "handle must be an opaque console handle",
  });

export const ConsoleSpecialKey = z.enum(["Enter", "Tab", "Backspace", "Escape", "C-c", "C-d"]);
export type ConsoleSpecialKeyT = z.infer<typeof ConsoleSpecialKey>;

const ConsoleTextInput = z
  .object({
    kind: z.literal("text"),
    text: z
      .string()
      .min(1)
      .refine((value) => byteLength(value) <= MAX_CONSOLE_TEXT_TOKEN_BYTES, {
        message: `text token exceeds ${MAX_CONSOLE_TEXT_TOKEN_BYTES} bytes`,
      })
      .refine((value) => !containsControlBytes(value), {
        message: "text token cannot contain control bytes; use explicit key tokens",
      }),
  })
  .strict();

const ConsoleKeyInput = z.object({ kind: z.literal("key"), key: ConsoleSpecialKey }).strict();

export const ConsoleInputToken = z.discriminatedUnion("kind", [ConsoleTextInput, ConsoleKeyInput]);
export type ConsoleInputTokenT = z.infer<typeof ConsoleInputToken>;

export const OpenConsoleArgs = z
  .object({
    targetId: ConsoleTargetId,
    rows: z.number().int().min(5).max(120).default(24),
    cols: z.number().int().min(20).max(240).default(80),
  })
  .strict();
export type OpenConsoleArgsT = z.output<typeof OpenConsoleArgs>;

export const SendConsoleKeysArgs = z
  .object({
    handle: ConsoleHandle,
    input: z.array(ConsoleInputToken).min(1).max(MAX_CONSOLE_KEY_TOKENS),
  })
  .strict()
  .superRefine((args, ctx) => {
    const totalTextBytes = args.input.reduce(
      (sum, token) => sum + (token.kind === "text" ? byteLength(token.text) : 0),
      0,
    );
    if (totalTextBytes > MAX_CONSOLE_SEND_TEXT_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["input"],
        message: `input text exceeds ${MAX_CONSOLE_SEND_TEXT_BYTES} bytes`,
      });
    }
  });
export type SendConsoleKeysArgsT = z.output<typeof SendConsoleKeysArgs>;

export const ReadConsoleScreenArgs = z
  .object({
    handle: ConsoleHandle,
    maxBytes: z.number().int().min(1).max(65_536).default(16_384),
  })
  .strict();
export type ReadConsoleScreenArgsT = z.output<typeof ReadConsoleScreenArgs>;

export const CloseConsoleArgs = z
  .object({
    handle: ConsoleHandle,
    reason: z.enum(["user", "cleanup", "shutdown", "budget"]).optional(),
  })
  .strict();
export type CloseConsoleArgsT = z.output<typeof CloseConsoleArgs>;

export const ReleaseConsoleArgs = z
  .object({
    handle: ConsoleHandle,
    reason: z.enum(["external-grader"]),
  })
  .strict();
export type ReleaseConsoleArgsT = z.output<typeof ReleaseConsoleArgs>;

export type ConsoleOperation =
  | {
      readonly kind: "open";
      readonly toolName: typeof CONSOLE_TOOL_NAMES.open;
      readonly args: OpenConsoleArgsT;
    }
  | {
      readonly kind: "send_keys";
      readonly toolName: typeof CONSOLE_TOOL_NAMES.sendKeys;
      readonly args: SendConsoleKeysArgsT;
    }
  | {
      readonly kind: "read_screen";
      readonly toolName: typeof CONSOLE_TOOL_NAMES.readScreen;
      readonly args: ReadConsoleScreenArgsT;
    }
  | {
      readonly kind: "release";
      readonly toolName: typeof CONSOLE_TOOL_NAMES.release;
      readonly args: ReleaseConsoleArgsT;
    }
  | {
      readonly kind: "close";
      readonly toolName: typeof CONSOLE_TOOL_NAMES.close;
      readonly args: CloseConsoleArgsT;
    };

export class ConsoleOperationError extends Error {
  readonly code: "INVALID_PARAMS" | "UNSUPPORTED_OPERATION";

  constructor(code: "INVALID_PARAMS" | "UNSUPPORTED_OPERATION", message: string) {
    super(message);
    this.name = "ConsoleOperationError";
    this.code = code;
  }
}

function issueMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "arguments" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function parseArgs<T>(
  toolName: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  args: unknown,
): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new ConsoleOperationError(
      "INVALID_PARAMS",
      `invalid interactive console ${toolName} arguments: ${issueMessage(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function parseConsoleToolCall(
  toolCall: Pick<ToolCallT, "name" | "args"> & Partial<Pick<ToolCallT, "id">>,
): ConsoleOperation {
  switch (toolCall.name) {
    case CONSOLE_TOOL_NAMES.open:
      return {
        kind: "open",
        toolName: CONSOLE_TOOL_NAMES.open,
        args: parseArgs(toolCall.name, OpenConsoleArgs, toolCall.args),
      };
    case CONSOLE_TOOL_NAMES.sendKeys:
      return {
        kind: "send_keys",
        toolName: CONSOLE_TOOL_NAMES.sendKeys,
        args: parseArgs(toolCall.name, SendConsoleKeysArgs, toolCall.args),
      };
    case CONSOLE_TOOL_NAMES.readScreen:
      return {
        kind: "read_screen",
        toolName: CONSOLE_TOOL_NAMES.readScreen,
        args: parseArgs(toolCall.name, ReadConsoleScreenArgs, toolCall.args),
      };
    case CONSOLE_TOOL_NAMES.release:
      return {
        kind: "release",
        toolName: CONSOLE_TOOL_NAMES.release,
        args: parseArgs(toolCall.name, ReleaseConsoleArgs, toolCall.args),
      };
    case CONSOLE_TOOL_NAMES.close:
      return {
        kind: "close",
        toolName: CONSOLE_TOOL_NAMES.close,
        args: parseArgs(toolCall.name, CloseConsoleArgs, toolCall.args),
      };
    default:
      throw new ConsoleOperationError(
        "UNSUPPORTED_OPERATION",
        `unsupported interactive console operation: ${toolCall.name}`,
      );
  }
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export interface ConsoleInputSummary {
  readonly tokenCount: number;
  readonly textBytes: number;
  readonly controlKeys: readonly ConsoleSpecialKeyT[];
  /**
   * Hashes the token shape, not text content. Short passwords are dictionary-guessable
   * from raw hashes, so policy/audit surfaces get only byte counts and control names.
   */
  readonly shapeHash: string;
}

export function summarizeConsoleInputForAudit(
  input: readonly ConsoleInputTokenT[],
): ConsoleInputSummary {
  const shape = input.map((token) =>
    token.kind === "text"
      ? { kind: "text", bytes: byteLength(token.text) }
      : { kind: "key", key: token.key },
  );
  return {
    tokenCount: input.length,
    textBytes: input.reduce(
      (sum, token) => sum + (token.kind === "text" ? byteLength(token.text) : 0),
      0,
    ),
    controlKeys: input.flatMap((token) => (token.kind === "key" ? [token.key] : [])),
    shapeHash: sha256(JSON.stringify(shape)),
  };
}
