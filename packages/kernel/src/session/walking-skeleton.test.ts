import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModel } from "@keel/simulator";
import type { ModelMessageT, SimulatorScriptT } from "@keel/shared";
import { runAgentLoop } from "../loop.js";
import { LocalExecutor } from "../local-executor.js";
import { KERNEL_STRINGS } from "../strings.js";
import type { KernelEventT } from "../events.js";
import { SessionStore, readSession } from "./store.js";
import { sessionPath } from "./paths.js";
import { record } from "./recorder.js";
import { rebuild } from "./resume.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });
const noTools = () => new LocalExecutor({});

/**
 * The walking skeleton: prove loop ↔ recorder ↔ store ↔ resume ↔ loop end-to-end
 * across @keel/shared + @keel/kernel + @keel/simulator, for a text-only session.
 */
describe("Epic 1.4 walking skeleton (text-only)", () => {
  it("records a real loop run; resume reproduces the conversation", async () => {
    const e = env();
    const script: SimulatorScriptT = { turns: [{ text: "done" }] };
    const store = SessionStore.create({ cwd: "/w" }, e);
    const seed: ModelMessageT[] = [{ role: "user", content: "go" }];

    for await (const ev of record(
      store,
      seed,
      runAgentLoop(new ScriptedModel(script), noTools(), { messages: seed }),
    )) {
      expect(ev).toBeDefined();
    }
    store.close();

    const rebuilt = rebuild(readSession(store.id, e));
    expect(rebuilt.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("round-trips a multi-turn tool session through the real loop", async () => {
    const e = env();
    const script: SimulatorScriptT = {
      turns: [
        { text: "plan", toolCalls: [{ name: "echo", args: { text: "a" } }] },
        { text: "done" },
      ],
    };
    const store = SessionStore.create({ cwd: "/w" }, e);
    const seed: ModelMessageT[] = [{ role: "user", content: "go" }];
    const exec = new LocalExecutor({ echo: (args) => JSON.stringify(args) });

    for await (const ev of record(
      store,
      seed,
      runAgentLoop(new ScriptedModel(script), exec, { messages: seed }),
    )) {
      expect(ev).toBeDefined();
    }
    store.close();

    const rebuilt = rebuild(readSession(store.id, e));
    expect(rebuilt.messages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "plan",
        toolCalls: [{ id: "call_0_0", name: "echo", args: { text: "a" } }],
      },
      { role: "tool", content: '{"text":"a"}', toolCallId: "call_0_0", name: "echo" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("round-trips a verification-intercepted session through the real loop", async () => {
    const e = env();
    const script: SimulatorScriptT = { turns: [{ text: "attempt" }, { text: "verified" }] };
    const store = SessionStore.create({ cwd: "/w" }, e);
    const seed: ModelMessageT[] = [{ role: "user", content: "go" }];

    for await (const ev of record(
      store,
      seed,
      runAgentLoop(new ScriptedModel(script), noTools(), { messages: seed, verification: {} }),
    )) {
      expect(ev).toBeDefined();
    }
    store.close();

    const rebuilt = rebuild(readSession(store.id, e));
    expect(rebuilt.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "attempt" },
      // No execution happened this session → the execution-grounded gate injects the sharper rubric (1.19).
      { role: "user", content: KERNEL_STRINGS.verificationPromptUnverified },
      { role: "assistant", content: "verified" },
    ]);
  });

  it("round-trips loop-detection guidance from the real loop event", async () => {
    const e = env();
    const guidance = "RECONSIDER YOUR APPROACH";
    const script: SimulatorScriptT = {
      turns: [
        { toolCalls: [{ name: "echo", args: { x: 1 } }] },
        { toolCalls: [{ name: "echo", args: { x: 1 } }] },
        { toolCalls: [{ name: "echo", args: { x: 1 } }] },
        { text: "reconsidered" },
      ],
    };
    const store = SessionStore.create({ cwd: "/w" }, e);
    const seed: ModelMessageT[] = [{ role: "user", content: "go" }];
    const exec = new LocalExecutor({ echo: (a) => JSON.stringify(a) });

    for await (const ev of record(
      store,
      seed,
      runAgentLoop(new ScriptedModel(script), exec, {
        messages: seed,
        loopDetection: { maxToolRepeats: 3, guidance },
      }),
      { loopGuidance: "STALE FALLBACK" }, // event.guidance wins; config is legacy fallback only
    )) {
      expect(ev).toBeDefined();
    }
    store.close();

    // the guidance the loop actually injected is recorded verbatim (coupling holds end-to-end)
    const rebuilt = rebuild(readSession(store.id, e));
    expect(rebuilt.messages.some((m) => m.role === "user" && m.content === guidance)).toBe(true);
  });

  it("a kill (torn final line) still resumes; resumed messages re-drive a fresh loop", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const seed: ModelMessageT[] = [{ role: "user", content: "go" }];

    for await (const ev of record(
      store,
      seed,
      runAgentLoop(new ScriptedModel({ turns: [{ text: "first answer" }] }), noTools(), {
        messages: seed,
      }),
    )) {
      expect(ev).toBeDefined();
    }
    store.close();

    // simulate a crash mid-append: a torn, newline-less final line
    const path = sessionPath(store.id, e);
    writeFileSync(path, readFileSync(path, "utf8") + '{"type":"user","v":1,"ts":"2026');

    const rebuilt = rebuild(readSession(store.id, e)); // tolerant read drops the torn tail
    expect(rebuilt.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "first answer" },
    ]);

    // continue: a fresh loop driven from the resumed messages runs to a clean stop
    const events: KernelEventT[] = [];
    for await (const ev of runAgentLoop(
      new ScriptedModel({ turns: [{ text: "continued" }] }),
      noTools(),
      { messages: rebuilt.messages },
    )) {
      events.push(ev);
    }
    expect(events.find((x) => x.type === "stop")).toEqual({ type: "stop", reason: "model-stop" });
    expect(events.some((x) => x.type === "text-delta" && x.text === "continued")).toBe(true);
  });
});
