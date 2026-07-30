import { describe, expect, it } from "vitest";
import type { UserInput } from "@keel/shared";
import { InputQueue } from "./input-queue.js";

describe("InputQueue (InputBar → runner bridge)", () => {
  it("delivers a pushed input to a pending consumer (push after next)", async () => {
    const q = new InputQueue();
    const pending = q.next();
    q.push({ kind: "line", text: "hello" });
    expect(await pending).toEqual({ value: { kind: "line", text: "hello" }, done: false });
  });

  it("buffers inputs pushed before they are consumed (FIFO)", async () => {
    const q = new InputQueue();
    q.push({ kind: "line", text: "a" });
    q.push({ kind: "interrupt" });
    expect(await q.next()).toEqual({ value: { kind: "line", text: "a" }, done: false });
    expect(await q.next()).toEqual({ value: { kind: "interrupt" }, done: false });
  });

  it("is a single shared iterator (asyncIterator returns itself — no demux race)", () => {
    const q = new InputQueue();
    expect(q[Symbol.asyncIterator]()).toBe(q);
  });

  it("close() completes a pending consumer and all future pulls", async () => {
    const q = new InputQueue();
    const pending = q.next();
    q.close();
    expect((await pending).done).toBe(true);
    expect((await q.next()).done).toBe(true);
  });

  it("ignores pushes after close (no late delivery)", async () => {
    const q = new InputQueue();
    q.close();
    q.push({ kind: "line", text: "late" } satisfies UserInput);
    expect((await q.next()).done).toBe(true);
  });

  it("drains buffered items FIFO before reporting done on close (teardown ordering)", async () => {
    const q = new InputQueue();
    q.push({ kind: "line", text: "1" });
    q.push({ kind: "line", text: "2" });
    q.close(); // close with a non-empty buffer — both must drain before done
    expect(await q.next()).toEqual({ value: { kind: "line", text: "1" }, done: false });
    expect(await q.next()).toEqual({ value: { kind: "line", text: "2" }, done: false });
    expect((await q.next()).done).toBe(true);
  });

  it("fails closed on a concurrent second consumer rather than leaking the first pull", () => {
    const q = new InputQueue();
    void q.next(); // first consumer waiting
    expect(() => q.next()).toThrow(/single-consumer/i);
  });

  // Epic 1.23: the per-turn steering consumer abandons a pending next() at a turn boundary; the
  // multi-turn driver detaches it so the NEXT turn/pull can attach. (F8 — lock the handoff seam.)
  it("detachConsumer frees a pending next() so a new consumer can pull (no concurrent-next throw)", async () => {
    const q = new InputQueue();
    const abandoned = q.next(); // the prior turn's consumer pull, never awaited to completion
    q.detachConsumer(); // turn boundary: release it
    expect((await abandoned).done).toBe(true); // resolved done (harmless; the consumer is gone)
    // a NEW consumer attaches without tripping the single-consumer guard, and gets the next input
    const next = q.next();
    q.push({ kind: "line", text: "next turn" });
    expect(await next).toEqual({ value: { kind: "line", text: "next turn" }, done: false });
  });

  it("detachConsumer is a no-op when no pull is outstanding, and keeps the stream OPEN (not closed)", async () => {
    const q = new InputQueue();
    expect(() => q.detachConsumer()).not.toThrow();
    q.push({ kind: "line", text: "still open" });
    expect(await q.next()).toEqual({ value: { kind: "line", text: "still open" }, done: false });
  });

  it("requeues a directly delivered input when the prior consumer detaches before acknowledging it", async () => {
    const q = new InputQueue();
    const abandoned = q.next();
    const input = { kind: "line", text: "next turn" } satisfies UserInput;

    q.push(input);
    q.detachConsumer();

    expect(await abandoned).toEqual({ value: input, done: false });
    expect(await q.next()).toEqual({ value: input, done: false });
  });

  it("does not replay a directly delivered input after its consumer acknowledges it", async () => {
    const q = new InputQueue();
    const pending = q.next();
    const consumed = { kind: "line", text: "steer this turn" } satisfies UserInput;

    q.push(consumed);
    expect(await pending).toEqual({ value: consumed, done: false });
    q.acknowledge(consumed);
    q.detachConsumer();

    const next = q.next();
    const later = { kind: "line", text: "new turn" } satisfies UserInput;
    q.push(later);
    expect(await next).toEqual({ value: later, done: false });
  });
});
