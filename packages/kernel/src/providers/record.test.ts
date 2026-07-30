import {
  Recording,
  type ModelPort,
  type ModelStreamChunkT,
  type ModelTurnInput,
  type RecordingT,
} from "@keel/shared";
import { describe, expect, it } from "vitest";
import { RecordedModelPort, RecordingModelPort } from "./record.js";

/** Drain an async chunk stream into an array. */
async function collect(stream: AsyncIterable<ModelStreamChunkT>): Promise<ModelStreamChunkT[]> {
  const out: ModelStreamChunkT[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

/**
 * A fixture delegate `ModelPort` that emits a fixed, per-turn sequence of chunks —
 * one array per `stream()` call, in order. Covers chunk types `ScriptedModel`
 * does not (`reasoning-delta`, streaming `tool-call-delta`), so the byte-for-byte
 * proof exercises the full vocabulary, not just text + atomic tool-call.
 */
class FixtureModel implements ModelPort {
  private call = 0;
  constructor(private readonly turns: readonly (readonly ModelStreamChunkT[])[]) {}
  async *stream(_input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
    const turn = this.turns[this.call] ?? [];
    this.call += 1;
    for (const chunk of turn) yield chunk;
  }
}

/**
 * A rich single turn covering several chunk types, ending in a real usage finish.
 * Built fresh per call so a test that mutates a chunk (to prove defensive copying)
 * cannot pollute another test through shared module-scoped state.
 */
function richTurn(): ModelStreamChunkT[] {
  return [
    { type: "text-delta", text: "Let me " },
    { type: "text-delta", text: "check." },
    { type: "reasoning-delta", text: "I should list the files" },
    { type: "tool-call-delta", id: "call_0", name: "bash", argsTextDelta: '{"comm' },
    { type: "tool-call-delta", id: "call_0", argsTextDelta: 'and":"ls"}' },
    { type: "tool-call", id: "call_0", name: "bash", args: { command: "ls" } },
    { type: "finish", reason: "tool-calls", usage: { inputTokens: 42, outputTokens: 13 } },
  ];
}

/** A deterministic clock that advances by a fixed step on each read, starting at `start`. */
function steppingClock(step: number, start = 0): () => number {
  let t = start;
  return (): number => {
    const v = t;
    t += step;
    return v;
  };
}

describe("RecordingModelPort (capture, ADR-0031)", () => {
  it("records → replays the rich turn byte-for-byte", async () => {
    const turn = richTurn();
    const delegate = new FixtureModel([turn]);
    const recorder = new RecordingModelPort({
      delegate,
      provider: "anthropic",
      model: "claude-opus-4-8",
      now: steppingClock(5),
    });

    const captured = await collect(recorder.stream({ messages: [] }));
    const recording = recorder.toRecording();

    // The recording is a valid wire artifact.
    expect(Recording.safeParse(recording).success).toBe(true);
    expect(recording.provider).toBe("anthropic");
    expect(recording.model).toBe("claude-opus-4-8");

    // The recorded turn's chunks deep-equal what the delegate emitted.
    expect(recording.turns).toHaveLength(1);
    expect(recording.turns[0]?.chunks).toEqual(turn);
    expect(captured).toEqual(turn);

    // Replay reproduces the captured sequence byte-for-byte.
    const replayer = new RecordedModelPort(recording);
    const replayed = await collect(replayer.stream({ messages: [] }));
    expect(replayed).toEqual(captured);
    expect(replayed).toEqual(recording.turns[0]?.chunks);
  });

  it("capture is transparent — the consumer sees exactly the delegate's stream", async () => {
    const baseline = await collect(new FixtureModel([richTurn()]).stream({ messages: [] }));

    const recorder = new RecordingModelPort({
      delegate: new FixtureModel([richTurn()]),
      provider: "p",
      model: "m",
      now: steppingClock(1),
    });
    const throughRecorder = await collect(recorder.stream({ messages: [] }));

    expect(throughRecorder).toEqual(baseline);
  });

  it("deep-copies chunks so later consumer mutation cannot corrupt the recording", async () => {
    const delegate = new FixtureModel([richTurn()]);
    const recorder = new RecordingModelPort({ delegate, provider: "p", model: "m" });
    const captured = await collect(recorder.stream({ messages: [] }));

    // Mutate the tool-call args the consumer received.
    const toolCall = captured.find((c) => c.type === "tool-call");
    if (toolCall?.type === "tool-call") toolCall.args["command"] = "rm -rf /";

    // The recording is unaffected — it holds an independent deep copy.
    const recorded = recorder.toRecording().turns[0]?.chunks.find((c) => c.type === "tool-call");
    expect(recorded?.type === "tool-call" ? recorded.args["command"] : undefined).toBe("ls");
  });

  it("toRecording() returns an independent deep copy (mutation does not leak back)", async () => {
    const delegate = new FixtureModel([richTurn()]);
    const recorder = new RecordingModelPort({ delegate, provider: "p", model: "m" });
    await collect(recorder.stream({ messages: [] }));

    const first = recorder.toRecording();
    // Mutate the returned recording.
    first.turns[0]?.chunks.pop();
    first.provider = "tampered";

    // A fresh snapshot is pristine.
    const second = recorder.toRecording();
    expect(second.provider).toBe("p");
    expect(second.turns[0]?.chunks).toEqual(richTurn());
  });

  it("usage lives in the terminal finish chunk (no denormalized field)", async () => {
    const delegate = new FixtureModel([richTurn()]);
    const recorder = new RecordingModelPort({ delegate, provider: "p", model: "m" });
    await collect(recorder.stream({ messages: [] }));

    const turn = recorder.toRecording().turns[0];
    const last = turn?.chunks.at(-1);
    expect(last).toEqual({
      type: "finish",
      reason: "tool-calls",
      usage: { inputTokens: 42, outputTokens: 13 },
    });
    // The RecordedTurn schema has no top-level `usage` field — consumers read chunks.at(-1).
    expect(turn && "usage" in turn).toBe(false);
  });

  it("timings are deterministic via the injected clock: one per chunk, monotonic", async () => {
    const delegate = new FixtureModel([richTurn()]);
    const recorder = new RecordingModelPort({
      delegate,
      provider: "p",
      model: "m",
      now: steppingClock(10),
    });
    await collect(recorder.stream({ messages: [] }));

    const turn = recorder.toRecording().turns[0];
    expect(turn?.timings).toHaveLength(turn?.chunks.length ?? -1);
    // turnStart reads the clock once (0); each chunk reads it after: 10,20,30,...
    expect(turn?.timings).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it("timings are RELATIVE to turnStart (not absolute): nonzero clock start kills the absolute-timing mutant", async () => {
    // Clock starts at 1000 and steps by 7. turnStart consumes the first tick (1000).
    // Each of the 7 chunks then reads: 1007, 1014, 1021, 1028, 1035, 1042, 1049.
    // Relative timings (now() - turnStart): [7, 14, 21, 28, 35, 42, 49].
    // A mutant that drops `- turnStart` would produce absolute values [1007, 1014, ...],
    // which would FAIL this assertion — confirming the real code is correct.
    const delegate = new FixtureModel([richTurn()]);
    const recorder = new RecordingModelPort({
      delegate,
      provider: "p",
      model: "m",
      now: steppingClock(7, 1000),
    });
    await collect(recorder.stream({ messages: [] }));

    const turn = recorder.toRecording().turns[0];
    expect(turn?.timings).toHaveLength(turn?.chunks.length ?? -1);
    // Relative offsets from turnStart=1000: each chunk is +7ms later.
    expect(turn?.timings).toEqual([7, 14, 21, 28, 35, 42, 49]);
  });

  it("captures multiple turns in order; replay reproduces all; reset() replays from the top", async () => {
    const turnA: readonly ModelStreamChunkT[] = [
      { type: "text-delta", text: "a" },
      { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const turnB: readonly ModelStreamChunkT[] = [
      { type: "tool-call", id: "c", name: "read", args: { path: "x" } },
      { type: "finish", reason: "tool-calls", usage: { inputTokens: 2, outputTokens: 2 } },
    ];
    const turnC: readonly ModelStreamChunkT[] = [
      { type: "text-delta", text: "done" },
      { type: "finish", reason: "stop", usage: { inputTokens: 3, outputTokens: 3 } },
    ];
    const delegate = new FixtureModel([turnA, turnB, turnC]);
    const recorder = new RecordingModelPort({
      delegate,
      provider: "p",
      model: "m",
      now: steppingClock(1),
    });
    const c1 = await collect(recorder.stream({ messages: [] }));
    const c2 = await collect(recorder.stream({ messages: [] }));
    const c3 = await collect(recorder.stream({ messages: [] }));

    const recording = recorder.toRecording();
    expect(recording.turns).toHaveLength(3);
    expect(recording.turns[0]?.chunks).toEqual(c1);
    expect(recording.turns[1]?.chunks).toEqual(c2);
    expect(recording.turns[2]?.chunks).toEqual(c3);

    const replayer = new RecordedModelPort(recording);
    expect(await collect(replayer.stream({ messages: [] }))).toEqual(turnA);
    expect(await collect(replayer.stream({ messages: [] }))).toEqual(turnB);
    expect(await collect(replayer.stream({ messages: [] }))).toEqual(turnC);
    // Exhausted: terminal stop.
    expect(await collect(replayer.stream({ messages: [] }))).toEqual([
      { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);

    // reset() replays from the top.
    replayer.reset();
    expect(await collect(replayer.stream({ messages: [] }))).toEqual(turnA);
  });

  it("is provider-agnostic: wraps any ModelPort (the fixture is not the Vercel adapter)", async () => {
    const delegate: ModelPort = new FixtureModel([richTurn()]);
    const recorder = new RecordingModelPort({ delegate, provider: "openai", model: "gpt-x" });
    await collect(recorder.stream({ messages: [] }));
    expect(recorder.toRecording().provider).toBe("openai");
  });
});

describe("RecordedModelPort (replay, ADR-0031)", () => {
  function richRecording(): RecordingT {
    return {
      version: 1,
      provider: "anthropic",
      model: "claude-opus-4-8",
      turns: [{ chunks: richTurn() }],
    };
  }

  it("yields finish(aborted) and no recorded chunks when the signal is already aborted", async () => {
    const replayer = new RecordedModelPort(richRecording());
    const controller = new AbortController();
    controller.abort();
    const out = await collect(replayer.stream({ messages: [], signal: controller.signal }));
    expect(out).toEqual([
      { type: "finish", reason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    // No recorded chunk was emitted, and the cursor did not advance (next replay
    // still serves turn 0).
    const out2 = await collect(replayer.stream({ messages: [] }));
    expect(out2).toEqual(richTurn());
  });

  it("aborts mid-replay: emits finish(aborted) once the signal fires between yields", async () => {
    const replayer = new RecordedModelPort(richRecording());
    const controller = new AbortController();
    const out: ModelStreamChunkT[] = [];
    for await (const chunk of replayer.stream({ messages: [], signal: controller.signal })) {
      out.push(chunk);
      // Abort after the first real chunk; the next iteration sees the signal.
      if (out.length === 1) controller.abort();
    }
    expect(out[0]).toEqual(richTurn()[0]);
    expect(out.at(-1)).toEqual({
      type: "finish",
      reason: "aborted",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    // It stopped early — fewer chunks than the full turn.
    expect(out.length).toBeLessThan(richTurn().length);
  });

  it("replay deep-copies so consumer mutation cannot corrupt a later reset()+replay", async () => {
    const replayer = new RecordedModelPort(richRecording());
    const first = await collect(replayer.stream({ messages: [] }));
    const toolCall = first.find((c) => c.type === "tool-call");
    if (toolCall?.type === "tool-call") toolCall.args["command"] = "rm -rf /";

    replayer.reset();
    const second = await collect(replayer.stream({ messages: [] }));
    const recalled = second.find((c) => c.type === "tool-call");
    expect(recalled?.type === "tool-call" ? recalled.args["command"] : undefined).toBe("ls");
  });

  it("yields finish(stop) immediately for an empty recording (no turns)", async () => {
    const empty: RecordingT = { version: 1, provider: "p", model: "m", turns: [] };
    const replayer = new RecordedModelPort(empty);
    expect(await collect(replayer.stream({ messages: [] }))).toEqual([
      { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  it("appends a defensive terminal when a recorded turn lacks one (corrupted/hand-built recording)", async () => {
    // RecordedModelPort replays a turn's chunks verbatim. A corrupted or hand-built recording
    // whose turn lacks a terminal (no finish/error) would otherwise leave the loop with a turn
    // that never terminates. Mirroring VercelModelPort's no-terminal guard, replay appends a
    // defensive terminal error (same code+message) so the loop never hangs.
    const noTerminal: RecordingT = {
      version: 1,
      provider: "p",
      model: "m",
      turns: [
        {
          chunks: [
            { type: "text-delta", text: "partial" },
            { type: "reasoning-delta", text: "thinking" },
          ],
        },
      ],
    };
    const replayer = new RecordedModelPort(noTerminal);
    const out = await collect(replayer.stream({ messages: [] }));
    expect(out).toEqual([
      { type: "text-delta", text: "partial" },
      { type: "reasoning-delta", text: "thinking" },
      {
        type: "error",
        code: "no-terminal",
        message: "provider stream ended without a terminal chunk",
      },
    ]);
  });

  it("does NOT append a defensive terminal when the recorded turn already ends in a terminal", async () => {
    // The guard fires only on a missing terminal; a well-formed turn is replayed byte-for-byte.
    const wellFormed: RecordingT = {
      version: 1,
      provider: "p",
      model: "m",
      turns: [
        {
          chunks: [
            { type: "text-delta", text: "hi" },
            { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
          ],
        },
      ],
    };
    const replayer = new RecordedModelPort(wellFormed);
    const out = await collect(replayer.stream({ messages: [] }));
    expect(out).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
  });
});
