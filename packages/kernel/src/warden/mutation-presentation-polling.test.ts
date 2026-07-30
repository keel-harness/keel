import { describe, expect, it, vi } from "vitest";
import type { MutationPresentationTakeParamsV1T } from "@keel/shared";
import {
  createMutationPresentationPollingResolver,
  type MutationPresentationPollingRuntime,
} from "./mutation-presentation-polling.js";

const PARAMS: MutationPresentationTakeParamsV1T = {
  sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  toolCallId: "edit-1",
  auditSeq: 7,
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fakeRuntime(start = 0): {
  readonly runtime: MutationPresentationPollingRuntime;
  readonly waits: number[];
  readonly now: () => number;
  readonly advance: (ms: number) => void;
} {
  let current = start;
  const waits: number[] = [];
  return {
    runtime: {
      now: () => current,
      wait: async (ms, signal) => {
        if (signal?.aborted === true) return "occurrence-ended";
        waits.push(ms);
        current += ms;
        return "elapsed";
      },
    },
    waits,
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe("mutation presentation polling", () => {
  it("returns an immediate terminal result with the exact key and a 100 ms first-call timeout", async () => {
    const clock = fakeRuntime();
    const calls: unknown[] = [];
    const resolver = createMutationPresentationPollingResolver(
      PARAMS,
      async (params, options) => {
        calls.push({ params, options });
        return { status: "unavailable", reason: "capture-unavailable" };
      },
      clock.runtime,
    );

    await expect(resolver()).resolves.toEqual({
      status: "unavailable",
      reason: "capture-unavailable",
    });
    expect(calls).toEqual([{ params: PARAMS, options: { timeoutMs: 100 } }]);
    expect(clock.waits).toEqual([]);
  });

  it("polls pending results at their bounded retry delay and consumes the terminal result once", async () => {
    const clock = fakeRuntime();
    const timeouts: number[] = [];
    const responses: unknown[] = [
      { status: "pending", retryAfterMs: 25 },
      { status: "pending", retryAfterMs: 10 },
      { status: "unavailable", reason: "redaction-failed" },
    ];
    const resolver = createMutationPresentationPollingResolver(
      PARAMS,
      async (_params, options) => {
        timeouts.push(options?.timeoutMs ?? -1);
        return responses.shift();
      },
      clock.runtime,
    );

    await expect(resolver()).resolves.toEqual({
      status: "unavailable",
      reason: "redaction-failed",
    });
    expect(timeouts).toEqual([100, 100, 100]);
    expect(clock.waits).toEqual([25, 10]);
    expect(clock.now()).toBe(35);
  });

  it("uses one absolute 250 ms deadline and starts no call with less than 25 ms remaining", async () => {
    const clock = fakeRuntime();
    let calls = 0;
    const resolver = createMutationPresentationPollingResolver(
      PARAMS,
      async () => {
        calls += 1;
        return { status: "pending", retryAfterMs: 25 };
      },
      clock.runtime,
    );

    await expect(resolver()).resolves.toEqual({
      status: "unavailable",
      reason: "presentation-timeout",
    });
    expect(calls).toBe(10);
    expect(clock.waits).toEqual(Array.from({ length: 10 }, () => 25));
    expect(clock.now()).toBe(250);
  });

  it("caps polling at 11 calls and observes the rest of the 250 ms barrier without another call", async () => {
    const clock = fakeRuntime();
    let calls = 0;
    const resolver = createMutationPresentationPollingResolver(
      PARAMS,
      async () => {
        calls += 1;
        return { status: "pending", retryAfterMs: 1 };
      },
      clock.runtime,
    );

    await expect(resolver()).resolves.toEqual({
      status: "unavailable",
      reason: "presentation-timeout",
    });
    expect(calls).toBe(11);
    expect(clock.waits).toEqual([...Array.from({ length: 10 }, () => 1), 240]);
    expect(clock.now()).toBe(250);
  });

  it("uses the remaining absolute budget and issues no second call below the minimum window", async () => {
    const clock = fakeRuntime();
    const timeouts: number[] = [];
    const resolver = createMutationPresentationPollingResolver(
      PARAMS,
      async (_params, options) => {
        timeouts.push(options?.timeoutMs ?? -1);
        clock.advance(226);
        return { status: "pending", retryAfterMs: 25 };
      },
      clock.runtime,
    );

    await expect(resolver()).resolves.toEqual({
      status: "unavailable",
      reason: "presentation-timeout",
    });
    expect(timeouts).toEqual([100]);
    expect(clock.waits).toEqual([24]);
    expect(clock.now()).toBe(250);
  });

  it("maps a malformed wire response locally without changing execution", async () => {
    const resolver = createMutationPresentationPollingResolver(
      PARAMS,
      async () => ({ status: "available", artifact: { producerBytes: "not-a-schema" } }),
      fakeRuntime().runtime,
    );

    await expect(resolver()).resolves.toEqual({
      status: "unavailable",
      reason: "invalid-response",
    });
  });

  it("does not start presentation RPC after the exact occurrence has already ended", async () => {
    const take = vi.fn(async () => ({ status: "pending", retryAfterMs: 25 }));
    const resolver = createMutationPresentationPollingResolver(PARAMS, take, fakeRuntime().runtime);
    const occurrence = new AbortController();
    occurrence.abort();

    await expect(resolver(occurrence.signal)).resolves.toEqual({
      status: "unavailable",
      reason: "occurrence-ended",
    });
    expect(take).not.toHaveBeenCalled();
  });

  it("rechecks occurrence identity before the first call when deadline setup ends it", async () => {
    const occurrence = new AbortController();
    const take = vi.fn(async () => ({ status: "pending", retryAfterMs: 25 }));
    const runtime: MutationPresentationPollingRuntime = {
      now: () => {
        occurrence.abort();
        return 0;
      },
      wait: async () => "elapsed",
    };
    const resolver = createMutationPresentationPollingResolver(PARAMS, take, runtime);

    await expect(resolver(occurrence.signal)).resolves.toEqual({
      status: "unavailable",
      reason: "occurrence-ended",
    });
    expect(take).not.toHaveBeenCalled();
  });

  it("starts no call when the occurrence ends while computing its remaining window", async () => {
    const occurrence = new AbortController();
    const take = vi.fn(async () => ({ status: "pending", retryAfterMs: 25 }));
    let clockReads = 0;
    const runtime: MutationPresentationPollingRuntime = {
      now: () => {
        clockReads += 1;
        if (clockReads === 2) occurrence.abort();
        return 0;
      },
      wait: async () => "elapsed",
    };
    const resolver = createMutationPresentationPollingResolver(PARAMS, take, runtime);

    await expect(resolver(occurrence.signal)).resolves.toEqual({
      status: "unavailable",
      reason: "occurrence-ended",
    });
    expect(take).not.toHaveBeenCalled();
  });

  it("ends promptly during an in-flight call while keeping its eventual rejection observed", async () => {
    const inFlight = deferred<unknown>();
    const started = deferred<void>();
    const resolver = createMutationPresentationPollingResolver(
      PARAMS,
      async () => {
        started.resolve();
        return await inFlight.promise;
      },
      fakeRuntime().runtime,
    );
    const occurrence = new AbortController();
    const resolving = resolver(occurrence.signal);
    await started.promise;

    occurrence.abort();
    await expect(resolving).resolves.toEqual({
      status: "unavailable",
      reason: "occurrence-ended",
    });

    // The late rejection is attached to the observed call promise and cannot become unhandled or
    // resurrect the ended occurrence.
    inFlight.reject(new Error("late transport failure"));
    await Promise.resolve();
  });

  it("cancels an inter-poll delay and starts no later call after the occurrence ends", async () => {
    const waitStarted = deferred<void>();
    const take = vi.fn(async () => ({ status: "pending", retryAfterMs: 25 }));
    const runtime: MutationPresentationPollingRuntime = {
      now: () => 0,
      wait: async (_ms, signal) => {
        waitStarted.resolve();
        return await new Promise<"elapsed" | "occurrence-ended">((resolve) => {
          const finish = (): void => resolve("occurrence-ended");
          if (signal?.aborted === true) finish();
          else signal?.addEventListener("abort", finish, { once: true });
        });
      },
    };
    const resolver = createMutationPresentationPollingResolver(PARAMS, take, runtime);
    const occurrence = new AbortController();
    const resolving = resolver(occurrence.signal);
    await waitStarted.promise;

    occurrence.abort();
    await expect(resolving).resolves.toEqual({
      status: "unavailable",
      reason: "occurrence-ended",
    });
    expect(take).toHaveBeenCalledTimes(1);
  });

  it("cancels the default timer through its occurrence listener", async () => {
    const occurrence = new AbortController();
    const take = vi.fn(async () => {
      setTimeout(() => occurrence.abort(), 5);
      return { status: "pending", retryAfterMs: 25 };
    });
    const resolver = createMutationPresentationPollingResolver(PARAMS, take);

    await expect(resolver(occurrence.signal)).resolves.toEqual({
      status: "unavailable",
      reason: "occurrence-ended",
    });
    expect(take).toHaveBeenCalledTimes(1);
  });

  it("stops immediately when one pending call consumes the exact absolute deadline", async () => {
    const clock = fakeRuntime();
    const resolver = createMutationPresentationPollingResolver(
      PARAMS,
      async () => {
        clock.advance(250);
        return { status: "pending", retryAfterMs: 25 };
      },
      clock.runtime,
    );

    await expect(resolver()).resolves.toEqual({
      status: "unavailable",
      reason: "presentation-timeout",
    });
    expect(clock.waits).toEqual([]);
  });

  it("uses the default monotonic timer to poll pending into one terminal result", async () => {
    const responses: unknown[] = [
      { status: "pending", retryAfterMs: 1 },
      { status: "unavailable", reason: "capture-budget" },
    ];
    const timeouts: number[] = [];
    const take = vi.fn(
      async (
        _params: MutationPresentationTakeParamsV1T,
        options?: { readonly timeoutMs?: number },
      ) => {
        timeouts.push(options?.timeoutMs ?? -1);
        return responses.shift();
      },
    );
    const resolver = createMutationPresentationPollingResolver(PARAMS, take);

    await expect(resolver()).resolves.toEqual({
      status: "unavailable",
      reason: "capture-budget",
    });
    expect(take).toHaveBeenCalledTimes(2);
    expect(timeouts[0]).toBe(100);
    expect(timeouts[1]).toBeGreaterThan(0);
    expect(timeouts[1]).toBeLessThanOrEqual(100);
  });

  it("propagates a live transport failure for the runner to classify", async () => {
    const resolver = createMutationPresentationPollingResolver(
      PARAMS,
      async () => {
        throw new Error("warden transport closed");
      },
      fakeRuntime().runtime,
    );

    await expect(resolver()).rejects.toThrow("warden transport closed");
  });
});
