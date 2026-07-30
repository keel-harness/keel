import type {
  JsonObjectT,
  ModelPort,
  ModelStreamChunkT,
  ModelTurnInput,
  SimulatorScriptT,
  SimulatorTurnT,
} from "@keel/shared";

/**
 * Record-mode stub (§6.3). Wraps a delegate `ModelPort`, yields its chunks
 * unchanged, and reconstructs an equivalent `SimulatorScript` from the observed
 * text and tool calls. Phase 0 captures the replayable shape (text + tool calls
 * per turn); full-fidelity record (real provider usage/timings, streaming
 * cadence) lands in Phase 1 with real providers. Branches are never recorded —
 * a recording is a linear transcript.
 *
 * Replaying a recording reproduces the original chunk transcript byte-for-byte
 * ONLY when the delegate emitted no streaming fault injection and no error:
 * `chunkSize` splits text into several deltas that capture concatenates back
 * into one, and an `error` terminal chunk passes through to the consumer but is
 * not re-emitted on replay (only the text accumulated before it is recorded).
 * Both are out of scope for the Phase 0 stub.
 */
export class RecordingModelPort implements ModelPort {
  private readonly turns: SimulatorTurnT[] = [];

  constructor(private readonly delegate: ModelPort) {}

  async *stream(input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
    let text = "";
    const toolCalls: { name: string; args: JsonObjectT }[] = [];
    for await (const chunk of this.delegate.stream(input)) {
      if (chunk.type === "text-delta") text += chunk.text;
      else if (chunk.type === "tool-call")
        toolCalls.push({ name: chunk.name, args: structuredClone(chunk.args) });
      yield chunk;
    }
    const turn: SimulatorTurnT = {};
    if (text.length > 0) turn.text = text;
    if (toolCalls.length > 0) turn.toolCalls = toolCalls;
    this.turns.push(turn);
  }

  /**
   * The script reconstructed from everything observed so far. Replaying it
   * through a `ScriptedModel` reproduces the recorded text + tool calls.
   * Each turn is deep-copied so the returned script is fully independent —
   * mutations to the returned value (or its nested objects) do not affect
   * this recorder's internal state or subsequent `toScript()` calls.
   */
  toScript(): SimulatorScriptT {
    return { version: 1, turns: this.turns.map((t) => structuredClone(t)) };
  }
}
