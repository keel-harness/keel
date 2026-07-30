import { createHash } from "node:crypto";
import { type JSONSchema7, type Tool, jsonSchema, tool } from "ai";
import type { ToolSpecT } from "@keel/shared";
import { toProviderCompatibleJsonSchema } from "./schema-compat.js";

/**
 * Map keel's frozen `ToolSpecT[]` onto the Vercel AI SDK `tools` object — the ONLY tool
 * path in the provider layer (design §7/§8). Pure: no I/O, no state.
 *
 * Two properties make this the *native* tool-calling path, structurally:
 *
 * 1. **`jsonSchema(parameters)`** — `ToolSpec.parameters` is an opaque JSON Schema at this
 *    layer, so it is passed straight to the SDK's `jsonSchema()` (no Zod round-trip; the
 *    executor/warden owns real arg enforcement, not the model port). A spec with no
 *    `parameters` advertises a closed empty-object schema (a no-arg tool), never a
 *    free-form one.
 * 2. **No `execute`** — omitting `execute` makes the SDK surface the tool call as a
 *    `tool-call` part and STOP, rather than running the tool itself. keel's loop dispatches
 *    the call through the executor/warden. There is deliberately no text-parsing fallback
 *    anywhere in `providers/`; tools ALWAYS flow through this SDK `tools` param (the
 *    native-tool invariant — proven structurally by the wiring + no-execute tests in
 *    `providers/vercel-model-port.test.ts` and `providers/tools.test.ts`).
 */

/** A closed empty-object JSON Schema — the schema advertised for a tool with no parameters. */
export const EMPTY_OBJECT_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/** The SDK `tools` object: tool name → SDK `Tool` (input schema only, no `execute`). */
export type SdkToolSet = Record<string, Tool>;

export interface SdkToolsProjection {
  readonly tools: SdkToolSet;
  readonly keelNameBySdkName: ReadonlyMap<string, string>;
}

const SDK_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/u;

/** Project a keel tool name into the provider-safe SDK name subset used by Anthropic. */
export function toSdkToolName(name: string): string {
  if (SDK_TOOL_NAME_PATTERN.test(name)) return name;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/gu, "_");
  const base = sanitized.length > 0 ? sanitized : "tool";
  return `${base.slice(0, 119)}_${hash}`;
}

/**
 * Build the SDK `tools` object from keel tool specs plus a reversible SDK-name → keel-name map.
 * The reversible map is required because provider tool-name grammars are narrower than keel's
 * internal/frozen tool names (for example `interactive_console.open`).
 */
export function toSdkToolsProjection(specs: readonly ToolSpecT[]): SdkToolsProjection {
  const out: SdkToolSet = {};
  const keelNameBySdkName = new Map<string, string>();
  for (const spec of specs) {
    const sdkName = toSdkToolName(spec.name);
    const existingKeelName = keelNameBySdkName.get(sdkName);
    if (existingKeelName !== undefined) {
      throw new Error(
        existingKeelName === spec.name
          ? `duplicate SDK tool name: ${JSON.stringify(spec.name)}`
          : `SDK tool name collision: ${JSON.stringify(existingKeelName)} and ${JSON.stringify(
              spec.name,
            )} both project to ${JSON.stringify(sdkName)}`,
      );
    }
    // `parameters` is `Record<string, unknown> | undefined` (the frozen opaque JSON-Schema);
    // it is authored as valid JSON Schema by the tool modules, so the cast is a view, not a
    // change of contract. No `execute` → the SDK surfaces the call for keel to dispatch.
    const parameters = toProviderCompatibleJsonSchema(spec.parameters ?? EMPTY_OBJECT_SCHEMA);
    out[sdkName] = tool({
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      inputSchema: jsonSchema(parameters),
    });
    keelNameBySdkName.set(sdkName, spec.name);
  }
  return { tools: out, keelNameBySdkName };
}

/** Build the SDK `tools` object from keel tool specs (last spec wins on a duplicate name). */
export function toSdkTools(specs: readonly ToolSpecT[]): SdkToolSet {
  return toSdkToolsProjection(specs).tools;
}
