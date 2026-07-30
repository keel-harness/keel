import type { UserInput } from "@keel/shared";

/**
 * The bridge from the interactive `InputBar` (which emits `UserInput`s synchronously via `onAction`)
 * to the runner's `UIPort.inputs()` (an async pull stream). The InputBar `push`es; the runner pulls.
 *
 * It is a SINGLE shared async iterator (`[Symbol.asyncIterator]()` returns itself) so the entrypoint
 * (which pulls the first line as the seed) and the runner (which pulls mid-run steering after) draw
 * from one FIFO — no two-iterator demux race that could drop or duplicate an input.
 */
export class InputQueue implements AsyncIterable<UserInput>, AsyncIterator<UserInput> {
  #buffer: UserInput[] = [];
  #waiter: ((r: IteratorResult<UserInput>) => void) | undefined;
  #delivered: UserInput | undefined;
  #closed = false;

  /** Enqueue an input (or hand it straight to a waiting consumer). No-op after close. */
  push(input: UserInput): void {
    if (this.#closed) return;
    const w = this.#waiter;
    if (w !== undefined) {
      this.#waiter = undefined;
      this.#delivered = input;
      w({ value: input, done: false });
    } else {
      this.#buffer.push(input);
    }
  }

  /** Mark a directly delivered input as accepted by the active consumer. */
  acknowledge(input: UserInput): void {
    if (this.#delivered === input) this.#delivered = undefined;
  }

  /**
   * Detach the current consumer at a turn-handoff boundary (Epic 1.23 — multi-turn REPL): resolve
   * any pending `next()` as `done` so a NEW consumer can attach without tripping the single-consumer
   * guard. The stream stays OPEN (unlike `close()`). Use only when the prior consumer has already
   * stopped reading — i.e. it abandoned its pull (a per-turn steering consumer that the run's `stop`
   * raced out at a turn boundary). The resolved value is `done` and is never observed (the abandoned
   * consumer is gone); this only frees the waiter slot. No-op when no pull is outstanding.
   */
  detachConsumer(): void {
    if (this.#delivered !== undefined) {
      this.#buffer.unshift(this.#delivered);
      this.#delivered = undefined;
    }
    const w = this.#waiter;
    if (w !== undefined) {
      this.#waiter = undefined;
      w({ value: undefined, done: true });
    }
  }

  /** Close the stream: a pending consumer and all future pulls resolve `done`. */
  close(): void {
    this.#closed = true;
    this.#delivered = undefined;
    const w = this.#waiter;
    if (w !== undefined) {
      this.#waiter = undefined;
      w({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<UserInput>> {
    const buffered = this.#buffer.shift();
    if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    // Single-consumer by contract (one shared iterator). Fail closed on a concurrent pull rather
    // than silently overwriting the waiter and leaking the first promise — a loud guard for a forker
    // who wires a second consumer.
    if (this.#waiter !== undefined) {
      throw new Error("InputQueue: concurrent next() — this is a single-consumer stream");
    }
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<UserInput> {
    return this;
  }
}
