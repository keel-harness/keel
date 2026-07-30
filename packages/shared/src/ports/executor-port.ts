import { z } from "zod";
import { JsonObject } from "../common/json.js";

/**
 * The execution-abstraction port. The kernel loop can only *request* tool
 * execution through an `ExecutorPort`; it never executes tools directly. This is
 * the structural seam of ADR-0016 ("autonomy at the reasoning layer, determinism
 * at the control layer"): Phase 1 ships `LocalExecutor` (direct, no enforcement,
 * honest-YOLO); Phase 2 swaps in `WardenExecutor` (sandbox + policy + audit over
 * the warden RPC) behind this same interface. Not frozen until that warden
 * integration — a shape change before then needs no protocol bump; freezing it
 * gets an ADR at Phase 2 (ADR-0021 records the seam).
 */

/** One tool execution request — the id/name/args of a model-issued tool call. */
export const ToolInvocation = z
  .object({ id: z.string().min(1), name: z.string().min(1), args: JsonObject })
  .strict();
export type ToolInvocationT = z.infer<typeof ToolInvocation>;

/**
 * The result of one tool execution. `ok:false` is the structured-error channel —
 * a failed tool returns a result the loop feeds back to the model as guidance,
 * never a thrown exception and never an auto-retry (§4.3 / §6.4). `output` is the
 * text the model sees; structured payloads can be added behind the port later.
 */
export const ToolResult = z.object({ ok: z.boolean(), output: z.string() }).strict();
export type ToolResultT = z.infer<typeof ToolResult>;

export interface ExecutorExecutionOptions {
  readonly signal?: AbortSignal;
  readonly onOutput?: (chunk: string) => void;
  /** Automated validators run after the interactive turn surface disconnects. `terminal` preserves
   * existing exact grants, but forbids opening a new live human-approval prompt: a review verdict is
   * returned as a terminal not-executed result so bounded control cannot hang or invent authority. */
  readonly approvalMode?: "interactive" | "terminal";
}

/** Swap seam: `LocalExecutor` (Phase 1) / `WardenExecutor` (Phase 2). */
export interface ExecutorPort {
  /**
   * `opts.onOutput` (Epic 1.5c) is an OPTIONAL live-output sink — best-effort and ephemeral, called
   * with each incremental output chunk as a long-running tool (e.g. `bash`) emits it, for the TUI's
   * purposeful-liveness display. It is NEVER the durable record (that is `ToolResult.output`); a tool
   * that produces no incremental output simply never calls it. The Phase-2 `WardenExecutor` may forward
   * sandboxed stdout through the same hook. Pre-freeze, so this is additive (no protocol bump).
   */
  execute(call: ToolInvocationT, opts?: ExecutorExecutionOptions): Promise<ToolResultT>;
}
