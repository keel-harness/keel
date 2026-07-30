import { z } from "zod";
import { JsonObject } from "../common/json.js";

/** Matcher against a prior tool result, used for conditional branching. */
export const ResultMatcher = z
  .object({
    on: z.literal("toolResult"),
    kind: z.enum(["regex", "jsonpath"]),
    pattern: z.string().min(1),
  })
  .strict();
export type ResultMatcherT = z.infer<typeof ResultMatcher>;

/** A scripted tool call the simulated model emits (name + args; no id — the loop
 *  assigns ids). Args use JsonObject (JSON-safe by value) so script args survive
 *  wire transport without corruption and TypeScript aligns with ModelStreamChunk. */
const ScriptedToolCall = z.object({ name: z.string().min(1), args: JsonObject }).strict();

/** A branch: if `match` holds against the latest tool result, jump to turn `goto`. */
const Branch = z.object({ match: ResultMatcher, goto: z.number().int().nonnegative() }).strict();

/** One scripted assistant turn: optional text, optional tool calls, optional
 *  conditional branches. At least one of the three is expected in practice; the
 *  schema allows an empty turn (a no-op) for flexibility. */
export const SimulatorTurn = z
  .object({
    text: z.string().optional(),
    toolCalls: z.array(ScriptedToolCall).optional(),
    branches: z.array(Branch).optional(),
  })
  .strict();
export type SimulatorTurnT = z.infer<typeof SimulatorTurn>;

/** Optional streaming / fault-injection knobs for the stream-parser fuzz tests. */
const FaultInjection = z
  .object({
    chunkSize: z.number().int().positive().optional(),
    malformedChunkAtIndex: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * A deterministic model script (§6.3). Not frozen — Epic 0.3 may extend it.
 *
 * @design This schema is DESIGNED (not transcribed from a normative appendix) and
 * intentionally NOT frozen. It seeds Epic 0.3 (simulator package) and will be
 * refined when that package lands. The shape — turns of text/tool-calls plus
 * result-matched branches and optional fault-injection — follows the §6.3 prose.
 */
export const SimulatorScript = z
  .object({
    version: z.literal(1).optional(),
    turns: z.array(SimulatorTurn),
    faultInjection: FaultInjection.optional(),
  })
  .strict();
export type SimulatorScriptT = z.infer<typeof SimulatorScript>;
