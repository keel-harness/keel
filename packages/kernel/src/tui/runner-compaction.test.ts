import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecutorPort,
  ModelMessageT,
  ModelPort,
  ModelStreamChunkT,
  ModelTurnInput,
  SimulatorScriptT,
  ToolInvocationT,
  ToolResultT,
  UIPort,
  UserInput,
  ViewModel,
} from "@keel/shared";
import { ScriptedModel } from "@keel/simulator";
import type { AgentCompactor } from "../loop.js";
import { SessionStore, readSession } from "../session/store.js";
import { rebuild } from "../session/resume.js";
import { runSession } from "./runner.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (v: T) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A test UIPort with a manually-fed input queue (mirrors runner-steering.test.ts). */
class QueueUI implements UIPort {
  #latest: ViewModel | undefined;
  #queue: UserInput[] = [];
  #waiter: ((r: IteratorResult<UserInput>) => void) | undefined;
  #closed = false;
  #renderWaiters: { pred: (v: ViewModel) => boolean; resolve: () => void }[] = [];

  render(view: ViewModel): void {
    this.#latest = view;
    this.#renderWaiters = this.#renderWaiters.filter((w) => {
      if (w.pred(view)) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  awaitRender(pred: (v: ViewModel) => boolean): Promise<void> {
    if (this.#latest !== undefined && pred(this.#latest)) return Promise.resolve();
    return new Promise((resolve) => this.#renderWaiters.push({ pred, resolve }));
  }

  push(input: UserInput): void {
    const w = this.#waiter;
    if (w !== undefined) {
      this.#waiter = undefined;
      w({ value: input, done: false });
    } else {
      this.#queue.push(input);
    }
  }

  async *inputs(): AsyncIterable<UserInput> {
    for (;;) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      const r = await new Promise<IteratorResult<UserInput>>((resolve) => {
        this.#waiter = resolve;
      });
      if (r.done) return;
      yield r.value;
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    const w = this.#waiter;
    if (w !== undefined) {
      this.#waiter = undefined;
      w({ value: undefined, done: true });
    }
    return Promise.resolve();
  }
}

/** Wraps a ScriptedModel and records the `messages` it was handed on each stream() call, so a test
 *  can assert what context actually reached the model on the re-drive (post-compaction). */
class RecordingModel implements ModelPort {
  readonly calls: ModelMessageT[][] = [];
  constructor(private readonly inner: ScriptedModel) {}
  async *stream(input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
    this.calls.push(input.messages.map((m) => ({ ...m })));
    yield* this.inner.stream(input);
  }
}

const seed: readonly ModelMessageT[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "go" },
];

const BIG = "X".repeat(4000); // ~1000 tokens — folded away by compaction

describe("runner — §4.7 compaction at a re-drive boundary (simulator-driven e2e)", () => {
  it("re-compaction bound (4b): a steering re-drive continues from the loop's compacted set, not a rebuild-from-full", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new QueueUI();
    const read2Started = deferred();
    const release2 = deferred();
    const executor: ExecutorPort = {
      execute(call: ToolInvocationT): Promise<ToolResultT> {
        if (call.name === "read1") return Promise.resolve({ ok: true, output: BIG });
        if (call.name === "read2") {
          read2Started.resolve();
          return release2.promise.then(() => ({ ok: true, output: "small2" }));
        }
        return Promise.resolve({ ok: false, output: `unexpected ${call.name}` });
      },
    };
    // An in-loop compactor that folds to a small marker set ONCE a big tool body is present. The
    // "COMPACTED" marker is an in-memory artifact — it is never recorded to the ledger, so its presence
    // in the re-driven model context proves the runner used the loop's final set, not rebuild-from-full.
    const compactor: AgentCompactor = (messages) =>
      messages.some((m) => m.role === "tool" && m.content.length > 500)
        ? [
            { role: "system", content: "COMPACTED" },
            ...messages.filter((message) => message.role === "user"),
          ]
        : messages;

    const script: SimulatorScriptT = {
      turns: [
        { toolCalls: [{ name: "read1", args: {} }] }, // turn 1: produces BIG → next turn's start compacts
        { toolCalls: [{ name: "read2", args: {} }] }, // turn 2: steering arrives during this read
        { text: "done after steering" }, // turn 3: the re-driven turn
      ],
    };
    const model = new RecordingModel(new ScriptedModel(script));

    const done = runSession({ model, executor, ui, store, seed, env: e, compactor });

    await read2Started.promise;
    ui.push({ kind: "line", text: "also handle b" });
    await ui.awaitRender((v) => (v.pendingInputs ?? 0) >= 1);
    release2.resolve();
    await done;
    store.close();

    // the re-driven turn (last model call) drove from the COMPACTED in-memory set + the steering,
    // NOT a re-expansion of the full pre-compaction history
    const redrive = model.calls.at(-1)!;
    expect(redrive.some((m) => m.content === "COMPACTED")).toBe(true);
    expect(redrive.some((m) => m.content === BIG)).toBe(false); // the big body was NOT re-expanded
    expect(redrive.some((m) => m.content === "also handle b")).toBe(true); // steering appended

    // the ledger remains the canonical FULL record — the BIG body survives; the in-memory COMPACTED
    // marker was never persisted (SEC-023: compress the view, never the record)
    const file = readSession(store.id, e);
    expect(file.events.some((ev) => ev.type === "tool_result" && ev.output === BIG)).toBe(true);
    const r = rebuild(file);
    expect(r.messages.some((m) => m.content === "COMPACTED")).toBe(false);
    expect(r.messages).toContainEqual({ role: "user", content: "also handle b" });
    expect(r.finished).toBe(true);
  });
});
