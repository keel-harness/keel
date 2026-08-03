import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModel } from "@keel/simulator";
import type {
  ExecutorPort,
  ModelMessageT,
  ModelPort,
  ModelStreamChunkT,
  SimulatorScriptT,
} from "@keel/shared";
import { LocalExecutor } from "../local-executor.js";
import { SessionStore, readSession } from "../session/store.js";
import { rebuild } from "../session/resume.js";
import { HeadlessUI } from "./headless.js";
import { runSession } from "./runner.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });

/**
 * Epic 1.5 walking skeleton: prove loop ↔ runner ↔ reducer ↔ UIPort(headless) ↔ session
 * end-to-end against the simulator, for a text-only session — render AND persist in one pass.
 */
describe("Epic 1.5 walking skeleton (text-only, headless)", () => {
  it("renders a scripted session to a headless frame and persists it to the ledger", async () => {
    const e = env();
    const script: SimulatorScriptT = { turns: [{ text: "done" }] };
    const seed: ModelMessageT[] = [{ role: "user", content: "go" }];
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new HeadlessUI();

    await runSession({
      model: new ScriptedModel(script),
      executor: new LocalExecutor({}),
      ui,
      store,
      seed,
    });

    // rendered (the calm transcript)
    expect(ui.frame()).toContain("you  go");
    expect(ui.frame()).toContain("done");

    // persisted (the 1.4 ledger) — resume reproduces the same conversation
    const rebuilt = rebuild(readSession(store.id, e));
    expect(rebuilt.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("threads ViewConfig into the HUD: the status line names the real model (not blank)", async () => {
    const e = env();
    const script: SimulatorScriptT = { turns: [{ text: "done" }] };
    const seed: ModelMessageT[] = [{ role: "user", content: "go" }];
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new HeadlessUI();

    await runSession({
      model: new ScriptedModel(script),
      executor: new LocalExecutor({}),
      ui,
      store,
      seed,
      view: { model: "anthropic/claude-sonnet-4-6" },
    });

    // the trust HUD now names the model instead of rendering a blank meta segment
    expect(ui.frame()).toContain("anthropic/claude-sonnet-4-6");
  });

  it("forwards the enforcement probe so a dead warden halts the run (P0-3)", async () => {
    const e = env();
    const script: SimulatorScriptT = {
      turns: [
        { toolCalls: [{ name: "bash", args: { command: "ls" } }] },
        { text: "should never run" },
      ],
    };
    const seed: ModelMessageT[] = [{ role: "user", content: "go" }];
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new HeadlessUI();
    let alive = true;
    const executor = {
      async execute() {
        alive = false; // the warden dies as the first tool returns
        return {
          ok: false as const,
          output: "warden execution failed (WARDEN_UNAVAILABLE): warden process exited",
        };
      },
    };

    const outcome = await runSession({
      model: new ScriptedModel(script),
      executor,
      ui,
      store,
      seed,
      enforcement: { available: () => alive },
    });

    // The run halted on the structured warden-death stop instead of re-driving into the 2nd turn.
    expect(outcome.lastStop).toBe("error");
    expect(ui.frame()).not.toContain("should never run");
    // The terminal is rendered honestly — enforcement stopped, NOT misattributed to the provider.
    expect(ui.frame()).toContain("warden (enforcement) stopped");
    expect(ui.frame()).not.toContain("model/provider");
    // The user gets an honest, resumable restart path with the concrete session id.
    expect(ui.frame()).toContain(`keel --resume ${store.id}`);

    // The halt is durably recorded (the record survives the agent): the ledger's run_status carries
    // the WARDEN_UNAVAILABLE stop, not a clean model-stop.
    const runStatus = readSession(store.id, e).events.filter((ev) => ev.type === "run_status");
    expect(runStatus.at(-1)).toMatchObject({ reason: "error", code: "WARDEN_UNAVAILABLE" });
  });

  it("preserves successful evidence and stops before an unfittable gross-runway provider call", async () => {
    const e = env();
    const seed: ModelMessageT[] = [{ role: "user", content: "run the focused tests" }];
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new HeadlessUI();
    let modelCalls = 0;
    const model: ModelPort = {
      async *stream(): AsyncIterable<ModelStreamChunkT> {
        modelCalls += 1;
        yield {
          type: "tool-call",
          id: "tests",
          name: "bash",
          args: { command: `printf '%s' '${"x".repeat(4000)}'` },
        };
        yield {
          type: "finish",
          reason: "tool-calls",
          usage: { inputTokens: 60, outputTokens: 0 },
        };
      },
    };
    const executor: ExecutorPort = {
      execute() {
        return Promise.resolve({ ok: true, output: "focused tests passed" });
      },
    };

    const outcome = await runSession({
      model,
      executor,
      ui,
      store,
      seed,
      stop: {
        budget: { maxGrossTokens: 100, grossWarnThresholds: [0.5] },
      },
    });

    expect(modelCalls).toBe(1);
    expect(outcome.lastStop).toBe("budget");
    expect(ui.frame()).toMatch(/gross-token runway notice/i);
    expect(ui.frame()).toMatch(/focused tests passed/i);
    expect(ui.frame()).toMatch(/run stopped/i);
    expect(ui.frame()).toMatch(/keel --continue/i);
    expect(
      readSession(store.id, e)
        .events.filter((ev) => ev.type === "run_status")
        .at(-1),
    ).toMatchObject({
      reason: "budget",
      code: "GROSS_RUNWAY_PREFLIGHT",
    });
  });
});
