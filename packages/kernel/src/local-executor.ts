import type { ExecutorPort, ToolInvocationT, ToolResultT } from "@keel/shared";
import { KERNEL_STRINGS } from "./strings.js";
import { markToolPresentationOutcome } from "./tool-presentation-outcome.js";

/** A registered tool: receives the parsed args, returns the model-visible output. `opts.onOutput`
 *  (Epic 1.5c) is the optional live-output sink the executor forwards from `ExecutorPort.execute` —
 *  a streaming tool (`bash`) calls it with incremental output; others ignore it. */
export type ToolHandler = (
  args: ToolInvocationT["args"],
  opts?: { signal?: AbortSignal; onOutput?: (chunk: string) => void; toolCallId?: string },
) => string | Promise<string>;

/** Turn an unknown thrown value into a message string (no `any`). */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stoppedToolResult(): ToolResultT {
  return markToolPresentationOutcome({ ok: false, output: KERNEL_STRINGS.toolAborted }, "stopped");
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Phase-1 `ExecutorPort`: runs tools directly, in-process, with NO enforcement
 * (no sandbox, no policy, no audit) — honest-YOLO. The warden replaces this with
 * `WardenExecutor` behind the same port in Phase 2 (ADR-0016/0021). A failed or
 * unknown tool returns a structured `{ ok: false }` result — never a throw, never
 * an auto-retry (§4.3): the loop hands it back to the model as guidance.
 */
export class LocalExecutor implements ExecutorPort {
  /** Persistent honest-no-enforcement banner the TUI surfaces (Epic 1.5). */
  readonly banner = KERNEL_STRINGS.yoloBanner;
  private readonly handlers = new Map<string, ToolHandler>();

  constructor(handlers: Record<string, ToolHandler> = {}) {
    for (const [name, handler] of Object.entries(handlers)) this.handlers.set(name, handler);
  }

  register(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  async execute(
    call: ToolInvocationT,
    opts?: { signal?: AbortSignal; onOutput?: (chunk: string) => void },
  ): Promise<ToolResultT> {
    if (signalAborted(opts?.signal)) {
      return stoppedToolResult();
    }
    const handler = this.handlers.get(call.name);
    if (handler === undefined) {
      return { ok: false, output: `unknown tool: ${call.name}` };
    }
    try {
      const output = await handler(call.args, { ...opts, toolCallId: call.id });
      if (signalAborted(opts?.signal)) return stoppedToolResult();
      return { ok: true, output };
    } catch (err) {
      if (signalAborted(opts?.signal)) return stoppedToolResult();
      return { ok: false, output: messageOf(err) };
    }
  }
}
