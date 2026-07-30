import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelPort,
  ModelStreamChunkT,
  ModelTurnInput,
  SimulatorScriptT,
  ToolSpecT,
} from "@keel/shared";
import { ScriptedModel } from "@keel/simulator";
import { SessionStore, readSession } from "../session/store.js";
import { rebuild } from "../session/resume.js";
import { HeadlessUI } from "../tui/headless.js";
import { createToolRuntime } from "./runtime.js";
import { runKeelSession } from "./session-entry.js";

const env = (cwd: string): NodeJS.ProcessEnv => ({ KEEL_HOME: cwd });
const tmp = (): string => mkdtempSync(join(tmpdir(), "keel-prod-"));

/** A ModelPort that records the tool specs it was handed, then stops. */
class SpyModel implements ModelPort {
  capturedTools: readonly ToolSpecT[] | undefined;
  async *stream(input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
    this.capturedTools = input.tools;
    yield { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

describe("production entrypoint walking skeleton (real tool stack, simulator-driven)", () => {
  it("runs a real write→bash→stop session end-to-end: a file lands on disk, bash reads it back", async () => {
    const cwd = tmp();
    const rt = createToolRuntime({ cwd });
    const store = SessionStore.create({ cwd }, env(cwd));
    const ui = new HeadlessUI();
    // the scripted model drives the REAL tools: write a file, then cat it, then finish
    const script: SimulatorScriptT = {
      turns: [
        { toolCalls: [{ name: "write", args: { path: "out.txt", content: "from keel" } }] },
        { toolCalls: [{ name: "bash", args: { command: "cat out.txt" } }] },
        { text: "done — wrote and read out.txt" },
      ],
    };

    try {
      await runKeelSession({
        model: new ScriptedModel(script),
        executor: rt.executor,
        tools: rt.tools,
        ui,
        store,
        env: env(cwd),
        prompt: "create out.txt and read it back",
      });
    } finally {
      await rt.dispose();
    }
    store.close();

    // the REAL write tool actually created the file on disk
    expect(readFileSync(join(cwd, "out.txt"), "utf8")).toBe("from keel");

    // the run is persisted + the real bash output ("from keel") came back through the loop
    const r = rebuild(readSession(store.id, env(cwd)));
    const toolMsgs = r.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.name).sort()).toEqual(["bash", "write"]);
    expect(toolMsgs.find((m) => m.name === "bash")?.content).toContain("from keel");
    expect(r.finished).toBe(true); // model-stop

    // the headless frame shows the activity + the final answer
    const frame = ui.frame();
    expect(frame).toContain("write");
    expect(frame).toContain("done — wrote and read out.txt");
  });

  it("forwards the HUD ViewConfig: the run's status line names the real model", async () => {
    const cwd = tmp();
    const rt = createToolRuntime({ cwd });
    const store = SessionStore.create({ cwd }, env(cwd));
    const ui = new HeadlessUI();
    try {
      await runKeelSession({
        model: new ScriptedModel({ turns: [{ text: "ok" }] }),
        executor: rt.executor,
        tools: rt.tools,
        ui,
        store,
        env: env(cwd),
        prompt: "noop",
        view: { model: "anthropic/claude-sonnet-4-6", cwd },
      });
    } finally {
      await rt.dispose();
    }
    store.close();
    expect(ui.frame()).toContain("anthropic/claude-sonnet-4-6"); // HUD names the model, not blank
  });

  it("advertises the runtime's tool specs to the model each turn", async () => {
    const cwd = tmp();
    const rt = createToolRuntime({ cwd });
    const store = SessionStore.create({ cwd }, env(cwd));
    const spy = new SpyModel();

    try {
      await runKeelSession({
        model: spy,
        executor: rt.executor,
        tools: rt.tools,
        ui: new HeadlessUI(),
        store,
        env: env(cwd),
        prompt: "do nothing",
      });
    } finally {
      await rt.dispose();
    }
    store.close();

    expect(spy.capturedTools?.map((t) => t.name).sort()).toEqual([
      "bash",
      "edit",
      "plan",
      "read",
      "search",
      "write",
    ]);
  });
});
