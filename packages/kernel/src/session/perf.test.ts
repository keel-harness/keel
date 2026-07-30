import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModel } from "@keel/simulator";
import type { ModelMessageT, SimulatorScriptT } from "@keel/shared";
import { runAgentLoop } from "../loop.js";
import { LocalExecutor } from "../local-executor.js";
import { SessionStore, readSession } from "./store.js";
import { record } from "./recorder.js";
import { rebuild } from "./resume.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });
const ts = "2026-06-14T00:00:00.000Z";

describe("session perf + concurrency (P1 stress)", () => {
  it("a 200-turn session resumes (read + rebuild) in under 2s", async () => {
    const e = env();
    const turns: SimulatorScriptT["turns"] = [];
    for (let i = 0; i < 199; i++) turns.push({ toolCalls: [{ name: "echo", args: { i } }] });
    turns.push({ text: "done" });
    const seed: ModelMessageT[] = [{ role: "user", content: "go" }];
    const exec = new LocalExecutor({ echo: (a) => JSON.stringify(a) });

    const store = SessionStore.create({ cwd: "/w" }, e);
    let n = 0;
    for await (const ev of record(
      store,
      seed,
      runAgentLoop(new ScriptedModel({ turns }), exec, {
        messages: seed,
        stop: { maxTurns: 1000 },
      }),
    )) {
      if (ev) n++;
    }
    store.close();
    expect(n).toBeGreaterThan(200);

    // The spec budget is on resume (read + rebuild), not recording.
    const t0 = performance.now();
    const rebuilt = rebuild(readSession(store.id, e));
    const elapsed = performance.now() - t0;
    expect(rebuilt.messages.length).toBeGreaterThan(200);
    expect(elapsed).toBeLessThan(2000);
  });

  it("two sessions in one workspace write independent, uncorrupted ledgers", () => {
    const e = env(); // same KEEL_HOME (one workspace)
    const a = SessionStore.create({ cwd: "/w" }, e);
    const b = SessionStore.create({ cwd: "/w" }, e);
    expect(a.id).not.toBe(b.id);
    for (let i = 0; i < 10; i++) {
      a.append({ type: "user", v: 1, ts, content: `a${i}` });
      b.append({ type: "user", v: 1, ts, content: `b${i}` });
    }
    a.close();
    b.close();

    const ra = readSession(a.id, e);
    const rb = readSession(b.id, e);
    expect(ra.events).toHaveLength(10);
    expect(rb.events).toHaveLength(10);
    expect(ra.events[0]).toMatchObject({ content: "a0" });
    expect(ra.events[9]).toMatchObject({ content: "a9" });
    expect(rb.events[0]).toMatchObject({ content: "b0" });
    expect(rb.events[9]).toMatchObject({ content: "b9" });
  });
});
