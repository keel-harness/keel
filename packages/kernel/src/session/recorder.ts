import type { ModelMessageT, SessionEventT, ToolCallT } from "@keel/shared";
import type { KernelEventT } from "../events.js";
import { KERNEL_STRINGS, budgetWarningMessage } from "../strings.js";
import type { SessionStore } from "./store.js";

type StopStatus = Extract<KernelEventT, { type: "stop" }>;

/** Recorder configuration.
 *
 *  `loopGuidance` is a legacy fallback for hand-authored/internal `loop-detected` fixture events that
 *  predate `event.guidance`. Real loop events carry the exact injected guidance, and the recorder uses
 *  that event field first so the durable ledger mirrors the model context without parallel config. */
export interface RecordConfig {
  readonly loopGuidance?: string;
}

const now = (): string => new Date().toISOString();
const MCP_ARGS_OMITTED = { omitted: "opaque-mcp-args" } as const;

function recordableToolCall(call: ToolCallT): ToolCallT {
  return call.name.startsWith("mcp__") ? { ...call, args: MCP_ARGS_OMITTED } : call;
}

/** Map a seed conversation message to its durable ledger event (the inverse of
 *  resume.rebuild), so a resumed-then-continued session re-records faithfully. */
function messageToEvent(m: ModelMessageT): SessionEventT {
  const ts = now();
  switch (m.role) {
    case "user":
      return { type: "user", v: 1, ts, content: m.content };
    case "system":
      return { type: "system", v: 1, ts, content: m.content };
    case "assistant":
      return {
        type: "assistant",
        v: 1,
        ts,
        content: m.content,
        ...(m.toolCalls !== undefined ? { toolCalls: m.toolCalls.map(recordableToolCall) } : {}),
      };
    case "tool":
      return {
        type: "tool_result",
        v: 1,
        ts,
        toolCallId: m.toolCallId ?? "",
        name: m.name ?? "",
        output: m.content,
      };
  }
}

/**
 * Fold the loop's public `KernelEventT` stream into the durable session ledger while
 * teeing every event through (so the TUI — Epic 1.5 — consumes the same stream). Seed
 * messages are recorded first. Per design §7: accumulate the assistant turn (text +
 * tool calls) and flush it as ONE `assistant` event at the turn/run boundary or when
 * its first tool result arrives; each `tool-result` becomes a `tool_result` event whose
 * `name` is recovered by id from the turn's tool calls. Injected nudges + `run_status`
 * join in slices 3/5.
 */
export async function* record(
  store: SessionStore,
  seed: readonly ModelMessageT[],
  events: AsyncIterable<KernelEventT>,
  cfg: RecordConfig = {},
): AsyncIterable<KernelEventT> {
  for (const m of seed) store.append(messageToEvent(m));

  const loopGuidance = cfg.loopGuidance ?? KERNEL_STRINGS.loopGuidance;
  let pending: { text: string; toolCalls: ToolCallT[] } | null = null;
  let lastStop: StopStatus | undefined;
  const nameById = new Map<string, string[]>();

  const flush = (): void => {
    if (pending !== null) {
      store.append({
        type: "assistant",
        v: 1,
        ts: now(),
        content: pending.text,
        ...(pending.toolCalls.length > 0 ? { toolCalls: pending.toolCalls } : {}),
      });
      pending = null;
    }
  };

  // An injected nudge becomes a user message — flush the assistant turn that preceded it first.
  const recordUser = (content: string): void => {
    flush();
    store.append({ type: "user", v: 1, ts: now(), content });
  };
  const pushToolName = (id: string, name: string): void => {
    const names = nameById.get(id);
    if (names === undefined) {
      nameById.set(id, [name]);
      return;
    }
    names.push(name);
  };
  const shiftToolName = (id: string): string => {
    const names = nameById.get(id);
    if (names === undefined || names.length === 0) return "unknown";
    const [name] = names;
    names.splice(0, 1);
    if (names.length === 0) nameById.delete(id);
    return name ?? "unknown";
  };

  for await (const ev of events) {
    switch (ev.type) {
      case "text-delta":
        pending ??= { text: "", toolCalls: [] };
        pending.text += ev.text;
        break;
      case "tool-call":
        pending ??= { text: "", toolCalls: [] };
        pending.toolCalls.push(recordableToolCall({ id: ev.id, name: ev.name, args: ev.args }));
        pushToolName(ev.id, ev.name);
        break;
      case "tool-result":
        flush(); // the assistant turn is complete before its results are recorded
        store.append({
          type: "tool_result",
          v: 1,
          ts: now(),
          toolCallId: ev.id,
          name: shiftToolName(ev.id),
          output: ev.output,
          ...(ev.ok ? {} : { isError: true }),
        });
        break;
      case "verification-requested":
        recordUser(ev.prompt);
        break;
      case "budget-warning":
        recordUser(budgetWarningMessage(ev.usedTokens, ev.maxTokens));
        break;
      case "loop-detected":
        recordUser(ev.guidance ?? loopGuidance);
        break;
      case "turn-started":
        flush();
        break;
      case "stop":
        flush();
        lastStop = ev; // remembered for the run_status recorded at run-finished
        break;
      case "run-finished":
        flush();
        if (lastStop !== undefined) {
          store.append({
            type: "run_status",
            v: 1,
            ts: now(),
            reason: lastStop.reason,
            ...(lastStop.code !== undefined ? { code: lastStop.code } : {}),
            ...(lastStop.message !== undefined ? { message: lastStop.message } : {}),
            usage: ev.usage,
          });
        }
        break;
      default:
        break; // run-started / infra-error / tool-output-delta carry no durable message (ephemeral)
    }
    yield ev;
  }
  flush(); // defensive: flush a trailing assistant turn on an early-ended stream
}
