import type { JsonObjectT, ModelMessageT, ModelPort, SimulatorScriptT } from "@keel/shared";
import { ScriptedModel } from "@keel/simulator";
import { Trajectory, type TrajectoryEventT, type TrajectoryT } from "./trajectory.js";

/** Bounds the in-test loop (the real kernel loop with stop conditions arrives in Phase 1). */
const MAX_TURNS = 64;

/** Run identity + provenance recorded on the trajectory. */
export interface ReplayOptions {
  readonly runId: string;
  readonly task: string;
  readonly suite: string;
  readonly model: string;
  readonly startedAt: string;
}

/**
 * Core replay driver. Accepts any `ModelPort` implementation so tests can inject mocks without
 * constructing a `SimulatorScript`. The public API surfaces are `replayToTrajectory` (script-based)
 * and `replayModelToTrajectory` (model-based, for testing).
 *
 * P0 chunk handling:
 * - `text-delta`, `tool-call`, `finish`, `error` are fully handled.
 * - `reasoning-delta` and `tool-call-delta` are explicitly skipped with `continue` — P0 replay
 *   ignores partial-streaming and reasoning chunks; a real kernel buffers tool-call-deltas to
 *   assemble complete calls before dispatching (Phase 1).
 */
async function drive(
  model: ModelPort,
  initial: readonly ModelMessageT[],
  opts: ReplayOptions,
): Promise<TrajectoryT> {
  const messages: ModelMessageT[] = [...initial];
  const events: TrajectoryEventT[] = [];
  let turns = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let faulted = false;

  for (const m of initial) events.push({ type: "message", role: m.role, content: m.content });

  for (let t = 0; t < MAX_TURNS; t++) {
    const calls: { id: string; name: string; args: JsonObjectT }[] = [];
    let text = "";
    let stop = false;
    for await (const chunk of model.stream({ messages })) {
      if (chunk.type === "text-delta") {
        text += chunk.text;
      } else if (chunk.type === "tool-call") {
        events.push({
          type: "tool-call",
          id: chunk.id,
          name: chunk.name,
          args: chunk.args,
          argsValid: true,
        });
        calls.push({ id: chunk.id, name: chunk.name, args: chunk.args });
        toolCalls += 1;
      } else if (chunk.type === "finish") {
        events.push({
          type: "turn",
          index: t,
          reason: chunk.reason,
          usage: chunk.usage,
          wallClockMs: 0,
        });
        inputTokens += chunk.usage.inputTokens;
        outputTokens += chunk.usage.outputTokens;
        stop = chunk.reason !== "tool-calls";
      } else if (chunk.type === "error") {
        // K: track that a fault occurred so the trajectory is labeled infra-error
        faulted = true;
        events.push({
          type: "turn",
          index: t,
          reason: "error",
          usage: { inputTokens: 0, outputTokens: 0 },
          wallClockMs: 0,
        });
        stop = true;
      } else if (chunk.type === "reasoning-delta" || chunk.type === "tool-call-delta") {
        // P0 replay skips partial-streaming + reasoning chunks; a real kernel buffers
        // tool-call-deltas and assembles complete calls before dispatching (Phase 1).
        continue;
      }
    }
    turns += 1;
    // F: push an assistant message whenever there is text OR tool calls (an assistant turn that
    // only makes calls has no text, but the message is still needed for the conversation history).
    if (text.length > 0 || calls.length > 0) {
      events.push({ type: "assistant-text", text });
      messages.push({
        role: "assistant",
        content: text,
        ...(calls.length > 0
          ? { toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args })) }
          : {}),
      });
    }
    // N4: when the turn faulted (an error chunk was seen), the tool calls that preceded the error
    // were NEVER dispatched — emitting fabricated ok:true results for them would be dishonest and
    // could mislead a downstream trajectory consumer.  Skip tool-result emission entirely on a
    // faulted turn; the error turn event already records that the turn ended abnormally.
    if (!faulted) {
      for (const call of calls) {
        const content = JSON.stringify(call.args);
        events.push({ type: "tool-result", id: call.id, ok: true, content });
        messages.push({ role: "tool", content, toolCallId: call.id, name: call.name });
      }
    }
    // Stop as soon as the model stopped. A `tool-calls` finish keeps `stop` false, so a turn that
    // requested tools loops on to feed their results; any other terminal reason (stop/length/error/
    // aborted) ends the run regardless of pending calls — never run past an error.
    if (stop) break;
  }

  return Trajectory.parse({
    schemaVersion: 1,
    runId: opts.runId,
    task: opts.task,
    suite: opts.suite,
    model: opts.model,
    startedAt: opts.startedAt,
    events,
    // K: label runs that ended with an error/fault chunk as infra-error, not resolved
    outcome: faulted ? "infra-error" : "resolved",
    totals: { turns, toolCalls, wallClockMs: 0, inputTokens, outputTokens },
  });
}

/**
 * Drive a `ModelPort` directly through an echo-style loop and record every step into a `Trajectory`.
 * Use this in tests to inject a mock `ModelPort` without constructing a `SimulatorScript`.
 *
 * For script-based replay (the standard path), use `replayToTrajectory` instead.
 */
export async function replayModelToTrajectory(
  model: ModelPort,
  initial: readonly ModelMessageT[],
  opts: ReplayOptions,
): Promise<TrajectoryT> {
  return drive(model, initial, opts);
}

/**
 * Drive a scripted model through an echo-style loop and record every step into a `Trajectory`. This
 * is the P0 trajectory generator (and the "recorded-session replay harness"): it uses no real model
 * and no kernel — the loop here is a minimal in-test driver. The echo tool returns each tool call's
 * args as JSON. `argsValid` is `true` (scripted args are valid by construction; a real validator
 * lands in Phase 1) and `wallClockMs` is 0 (no real clock). `outcome` defaults to `"resolved"` — P0
 * replay does not judge task success (that is the TB-2 grader's job in Phase 1).
 */
export async function replayToTrajectory(
  script: SimulatorScriptT,
  initial: readonly ModelMessageT[],
  opts: ReplayOptions,
): Promise<TrajectoryT> {
  return drive(new ScriptedModel(script), initial, opts);
}
