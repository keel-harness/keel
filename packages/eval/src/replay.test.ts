import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelMessageT, ModelPort, ModelStreamChunkT, SimulatorScriptT } from "@keel/shared";
import { replayModelToTrajectory, replayToTrajectory } from "./replay.js";
import { readTrajectory, writeTrajectory } from "./store.js";

const OPTS = {
  runId: "run_0001",
  task: "tb2-task-01",
  suite: "terminal-bench-2",
  model: "<PINNED_MODEL_ID>",
  startedAt: "2026-06-12T00:00:00.000Z",
};
const INITIAL: ModelMessageT[] = [{ role: "user", content: "start" }];

let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "keel-replay-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("replay harness (simulator-driven trajectory)", () => {
  it("records a 2-turn / 1-tool-call run and the store round-trips it", async () => {
    const script: SimulatorScriptT = {
      turns: [
        { text: "listing", toolCalls: [{ name: "bash", args: { command: "ls" } }] },
        { text: "done" },
      ],
    };
    const traj = await replayToTrajectory(script, INITIAL, OPTS);

    expect(traj.totals.toolCalls).toBe(1);
    expect(traj.totals.turns).toBe(2);
    expect(traj.events.filter((e) => e.type === "tool-call")).toHaveLength(1);
    expect(traj.events.some((e) => e.type === "tool-result")).toBe(true);
    expect(traj.outcome).toBe("resolved");

    // the round-trip the spec requires: a simulated run's full trajectory persists and reloads
    const file = await writeTrajectory(base, traj);
    expect(await readTrajectory(file)).toEqual(traj);
  });

  it("records an error turn when the delegate stream faults (no crash)", async () => {
    const script: SimulatorScriptT = {
      turns: [{ text: "abcd" }],
      faultInjection: { chunkSize: 2, malformedChunkAtIndex: 1 },
    };
    const traj = await replayToTrajectory(script, INITIAL, OPTS);
    expect(traj.events.some((e) => e.type === "turn" && e.reason === "error")).toBe(true);
    expect(traj.totals.turns).toBe(1); // the single errored turn is counted, then the loop stops
    // K: a faulted run is labeled infra-error, not resolved
    expect(traj.outcome).toBe("infra-error");
  });

  it("does NOT emit ok:true tool-result events for calls in a faulted turn (N4)", async () => {
    // N4: the replay loop emitted fabricated ok:true tool-results for tool calls that preceded
    // an error chunk in the same turn — those calls were never dispatched.  When a turn faults
    // (an error chunk is seen), NO tool-result events should be recorded for that turn's calls.
    const mockChunks: ModelStreamChunkT[] = [
      { type: "tool-call", id: "call_fault_1", name: "bash", args: { command: "ls" } },
      { type: "error", message: "stream error", code: "stream_error" },
    ];
    const mockModel: ModelPort = {
      stream(): AsyncIterable<ModelStreamChunkT> {
        return (async function* () {
          for (const c of mockChunks) yield c;
        })();
      },
    };
    const traj = await replayModelToTrajectory(mockModel, INITIAL, OPTS);
    // The tool-call event IS recorded (it was emitted before the error)
    expect(traj.events.filter((e) => e.type === "tool-call")).toHaveLength(1);
    // But NO fabricated ok:true tool-result should appear — the call never executed
    expect(traj.events.filter((e) => e.type === "tool-result")).toHaveLength(0);
    // The turn is labeled error and the run is infra-error
    expect(traj.events.some((e) => e.type === "turn" && e.reason === "error")).toBe(true);
    expect(traj.outcome).toBe("infra-error");
  });

  it("handles reasoning-delta and tool-call-delta chunks without throwing or recording events", async () => {
    // L/O: P0 replay must not crash or record spurious events for the new non-terminal streaming
    // variants — it simply skips them (a real kernel buffers tool-call-deltas for assembly).
    const mockChunks: ModelStreamChunkT[] = [
      { type: "reasoning-delta", text: "think" },
      { type: "tool-call-delta", id: "call_0_0", name: "bash", argsTextDelta: "{}" },
      { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    const mockModel: ModelPort = {
      stream(): AsyncIterable<ModelStreamChunkT> {
        return (async function* () {
          for (const c of mockChunks) yield c;
        })();
      },
    };
    const traj = await replayModelToTrajectory(mockModel, INITIAL, OPTS);
    // no tool-call or tool-result events should have been recorded (deltas are not atomic calls)
    expect(traj.events.filter((e) => e.type === "tool-call")).toHaveLength(0);
    expect(traj.events.filter((e) => e.type === "tool-result")).toHaveLength(0);
    // trajectory must parse (schema valid) and outcome must be resolved
    expect(traj.outcome).toBe("resolved");
    expect(traj.totals.turns).toBe(1);
  });
});
