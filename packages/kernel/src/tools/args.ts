import type { z } from "zod";
import type { JsonObjectT } from "@keel/shared";
import { ToolError } from "./errors.js";
import { badArgsMessage } from "./strings.js";

/**
 * Parse a tool's raw `JsonObject` args against its zod schema. Returns the typed value, or throws a
 * `ToolError` carrying clean, model-facing guidance (the loop feeds `err.message` back as the tool
 * result so the model self-corrects — §4.3 / no auto-retry).
 */
export function parseArgs<T>(toolName: string, schema: z.ZodType<T>, args: JsonObjectT): T {
  const result = schema.safeParse(args);
  if (!result.success) throw new ToolError(badArgsMessage(toolName, result.error));
  return result.data;
}
