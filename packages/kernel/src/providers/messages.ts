import type {
  ModelMessage,
  AssistantModelMessage,
  ToolModelMessage,
  ToolCallPart,
  TextPart,
  ToolResultPart,
} from "ai";
import type { ModelMessageT } from "@keel/shared";

type ToolNameMapper = (name: string) => string;

const identityToolName: ToolNameMapper = (name) => name;

/**
 * Map keel `ModelMessageT[]` → AI SDK `ModelMessage[]`.
 *
 * This is the message-assembly half of the provider adapter (ADR-0019 / F). It is
 * PURE: no I/O, no state. It lives in its own module so it can be unit-tested and
 * reasoned about independently of the `VercelModelPort` orchestration.
 *
 * ## Mapping rules (design §7, verified against @ai-sdk/provider-utils@4.0.27 types)
 *
 * - `system`  → `{ role:"system", content: string }`.
 * - `user`    → `{ role:"user", content: string }`.
 * - `assistant` WITHOUT `toolCalls` (or with an empty array)
 *             → `{ role:"assistant", content: string }`.
 * - `assistant` WITH non-empty `toolCalls`
 *             → `{ role:"assistant", content: Array<TextPart?, ToolCallPart[]> }` where:
 *               - a `TextPart` (`{ type:"text", text }`) is prepended IFF `content` is
 *                 non-empty (omitting an empty text part keeps the message clean).
 *               - each keel `{ id, name, args }` maps to an SDK `ToolCallPart`:
 *                 `{ type:"tool-call", toolCallId: id, toolName: mapToolName(name), input: args }`.
 * - `tool`    → `{ role:"tool", content: [ToolResultPart] }` where:
 *               `ToolResultPart = { type:"tool-result", toolCallId, toolName: mapToolName(name),
 *               output: {type:"text",value} }`.
 *               keel tool results are always strings, so the output is always `{type:"text"}`.
 *               GUARD: a `tool` message missing `toolCallId` or `name` is SKIPPED rather
 *               than emitting an invalid SDK shape — the loop never produces these, but the
 *               guard is honest about the optional fields in the frozen schema.
 *
 * ## SDK type reference (@ai-sdk/provider-utils ToolCallPart / ToolResultPart)
 *
 *   ToolCallPart  = { type:"tool-call", toolCallId: string, toolName: string, input: unknown }
 *   ToolResultPart= { type:"tool-result", toolCallId: string, toolName: string, output: ToolResultOutput }
 *   ToolResultOutput (text) = { type:"text", value: string }
 */
export function toSdkMessages(
  messages: readonly ModelMessageT[],
  mapToolName: ToolNameMapper = identityToolName,
): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system":
        out.push({ role: "system", content: m.content });
        break;

      case "user":
        out.push({ role: "user", content: m.content });
        break;

      case "assistant": {
        // Non-empty toolCalls → multi-part content; empty/absent → plain string.
        const calls = m.toolCalls;
        if (calls !== undefined && calls.length > 0) {
          // Build the parts array: optional text part (only when content non-empty) then all
          // tool-call parts. `noUncheckedIndexedAccess` is on, so each call is accessed via
          // `for...of` to avoid `calls[i]!` assertions.
          const parts: Array<TextPart | ToolCallPart> = [];
          if (m.content.length > 0) {
            parts.push({ type: "text", text: m.content });
          }
          for (const tc of calls) {
            parts.push({
              type: "tool-call",
              toolCallId: tc.id,
              toolName: mapToolName(tc.name),
              input: tc.args,
            });
          }
          const assistantMsg: AssistantModelMessage = { role: "assistant", content: parts };
          out.push(assistantMsg);
        } else {
          out.push({ role: "assistant", content: m.content });
        }
        break;
      }

      case "tool": {
        // Guard: skip if either linking field is absent (the frozen schema allows this;
        // the loop never produces it, but the mapping must not emit an invalid SDK message).
        if (m.toolCallId === undefined || m.name === undefined) break;
        const resultPart: ToolResultPart = {
          type: "tool-result",
          toolCallId: m.toolCallId,
          toolName: mapToolName(m.name),
          output: { type: "text", value: m.content },
        };
        const toolMsg: ToolModelMessage = { role: "tool", content: [resultPart] };
        out.push(toolMsg);
        break;
      }
    }
  }
  return out;
}
