import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModel } from "@keel/simulator";
import type { ModelMessageT, SimulatorScriptT } from "@keel/shared";
import { runAgentLoop } from "../loop.js";
import { LocalExecutor } from "../local-executor.js";
import type { KernelEventT } from "../events.js";
import { SessionStore, readSession } from "./store.js";
import { record } from "./recorder.js";
import { rebuild } from "./resume.js";

const tmp = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });
async function* none(): AsyncIterable<KernelEventT> {
  /* an empty event stream — seed only */
}

/** Random scripts: turns with optional text + 0–2 echo tool calls, ending in a clean
 *  text turn so the loop reaches model-stop. */
const scriptArb = fc
  .array(
    fc.record({
      text: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
      calls: fc.integer({ min: 0, max: 2 }),
    }),
    { minLength: 1, maxLength: 5 },
  )
  .map((specs): SimulatorScriptT["turns"] => {
    const turns = specs.map((s, i) => ({
      ...(s.text !== undefined ? { text: s.text } : {}),
      ...(s.calls > 0
        ? {
            toolCalls: Array.from({ length: s.calls }, (_, j) => ({
              name: "echo",
              args: { i, j },
            })),
          }
        : {}),
    }));
    turns.push({ text: "final" });
    return turns;
  });

const echo = (): LocalExecutor => new LocalExecutor({ echo: (a) => JSON.stringify(a) });

async function recordRun(
  turns: SimulatorScriptT["turns"],
  e: NodeJS.ProcessEnv,
): Promise<ModelMessageT[]> {
  const seed: ModelMessageT[] = [{ role: "user", content: "go" }];
  const store = SessionStore.create({ cwd: "/w" }, e);
  for await (const ev of record(
    store,
    seed,
    runAgentLoop(new ScriptedModel({ turns }), echo(), { messages: seed }),
  )) {
    if (!ev) throw new Error("missing event");
  }
  store.close();
  return rebuild(readSession(store.id, e)).messages;
}

async function recordSeedOnly(
  messages: ModelMessageT[],
  e: NodeJS.ProcessEnv,
): Promise<ModelMessageT[]> {
  const store = SessionStore.create({ cwd: "/w" }, e);
  for await (const ev of record(store, messages, none())) if (!ev) throw new Error("missing event");
  store.close();
  return rebuild(readSession(store.id, e)).messages;
}

describe("session round-trip property (the keystone)", () => {
  it("over random scripts: resumed history is valid and rebuild∘record is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(scriptArb, async (turns) => {
        const recorded = await recordRun(turns, tmp());

        // (1) VALIDITY: every assistant tool call has exactly one matching tool result,
        //     and there are no orphan results — i.e. resumed history is provider-consumable.
        const callIds = recorded
          .flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []))
          .map((c) => c.id)
          .sort();
        const resultIds = recorded
          .filter((m) => m.role === "tool")
          .map((m) => m.toolCallId)
          .sort();
        expect(resultIds).toEqual(callIds);

        // (2) IDEMPOTENCE: re-recording the rebuilt messages as a seed and rebuilding again
        //     returns them unchanged — fold and unfold are consistent inverses.
        const again = await recordSeedOnly(recorded, tmp());
        expect(again).toEqual(recorded);
      }),
      { numRuns: 50 },
    );
  });
});
