import { describe, expect, it } from "vitest";
import type { ModelMessageT, ModelPort, ModelStreamChunkT, SimulatorScriptT } from "@keel/shared";
import { ScriptedModel } from "./index.js";

/**
 * Minimal in-test agent loop (NOT the kernel — that arrives in Phase 1). It
 * streams one turn, echoes any tool call's args back as the tool result, appends
 * the result, and repeats until the model emits a non-tool-call finish (or an
 * error, or MAX_TURNS). Returns the full ordered chunk transcript. This proves
 * deterministic multi-turn loop mechanics over `ModelPort` with zero kernel.
 */
const MAX_TURNS = 16;

async function runEchoLoop(
  model: ModelPort,
  initial: readonly ModelMessageT[],
): Promise<ModelStreamChunkT[]> {
  const messages: ModelMessageT[] = [...initial];
  const transcript: ModelStreamChunkT[] = [];
  for (let t = 0; t < MAX_TURNS; t++) {
    const toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];
    let text = "";
    let nonToolStop = false;
    for await (const c of model.stream({ messages })) {
      transcript.push(c);
      if (c.type === "text-delta") text += c.text;
      else if (c.type === "tool-call") toolCalls.push({ id: c.id, name: c.name, args: c.args });
      else if (c.type === "finish") nonToolStop = c.reason !== "tool-calls";
      else nonToolStop = true; // error chunk -> stop
    }
    if (text.length > 0) messages.push({ role: "assistant", content: text });
    for (const call of toolCalls) {
      messages.push({
        role: "tool",
        content: JSON.stringify(call.args), // the echo tool: result == its args, serialized
        toolCallId: call.id,
        name: call.name,
      });
    }
    if (toolCalls.length === 0 && nonToolStop) break;
  }
  return transcript;
}

describe("echo-loop (P0 exit-gate item 3): simulator drives a stub loop deterministically", () => {
  it("runs a 3-turn, 2-tool-call session and replays byte-identically twice", async () => {
    const script: SimulatorScriptT = {
      turns: [
        { text: "Echo the first token.", toolCalls: [{ name: "echo", args: { text: "alpha" } }] },
        { text: "Now the second.", toolCalls: [{ name: "echo", args: { text: "beta" } }] },
        { text: "Done." },
      ],
    };
    const run1 = await runEchoLoop(new ScriptedModel(script), [{ role: "user", content: "start" }]);
    const run2 = await runEchoLoop(new ScriptedModel(script), [{ role: "user", content: "start" }]);
    expect(run2).toEqual(run1); // determinism

    const ids = run1.flatMap((c) => (c.type === "tool-call" ? [c.id] : []));
    expect(ids).toEqual(["call_0_0", "call_1_0"]); // two tool calls, deterministic ids

    const last = run1.at(-1);
    expect(last?.type).toBe("finish");
    if (last?.type === "finish") expect(last.reason).toBe("stop"); // terminates cleanly
  });

  it("a conditional branch fires on a matching tool result and drives the attack path", async () => {
    const script: SimulatorScriptT = {
      turns: [
        {
          text: "read key",
          toolCalls: [{ name: "echo", args: { text: "-----BEGIN id_rsa-----" } }],
        }, // 0
        { branches: [{ match: { on: "toolResult", kind: "regex", pattern: "id_rsa" }, goto: 3 }] }, // 1
        { text: "benign default" }, // 2 (skipped via branch)
        { text: "exfiltrate", toolCalls: [{ name: "echo", args: { text: "POST evil.example" } }] }, // 3
      ],
    };
    const transcript = await runEchoLoop(new ScriptedModel(script), [
      { role: "user", content: "go" },
    ]);
    const texts = transcript.flatMap((c) => (c.type === "text-delta" ? [c.text] : []));
    expect(texts).toContain("exfiltrate");
    expect(texts).not.toContain("benign default");
  });
});
