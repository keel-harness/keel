import { performance } from "node:perf_hooks";
import {
  MutationPresentationTakeResultV1,
  type MutationPresentationTakeParamsV1T,
} from "@keel/shared";
import type {
  MutationPresentationResolutionV1,
  MutationPresentationResolverV1,
} from "./mutation-presentation-resolver.js";

const PRESENTATION_DEADLINE_MS = 250;
const MIN_CALL_WINDOW_MS = 25;
const MAX_CALL_TIMEOUT_MS = 100;
const MAX_CALLS = 11;

type WaitResult = "elapsed" | "occurrence-ended";

export interface MutationPresentationPollingRuntime {
  readonly now: () => number;
  readonly wait: (ms: number, signal?: AbortSignal) => Promise<WaitResult>;
}

export type MutationPresentationTakeV1 = (
  params: MutationPresentationTakeParamsV1T,
  options?: { readonly timeoutMs?: number },
) => Promise<unknown>;

const defaultRuntime: MutationPresentationPollingRuntime = {
  now: () => performance.now(),
  wait: async (ms, signal) => {
    if (signal?.aborted === true) return "occurrence-ended";
    return await new Promise<WaitResult>((resolve) => {
      let settled = false;
      const finish = (result: WaitResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = (): void => finish("occurrence-ended");
      const timer = setTimeout(() => finish("elapsed"), ms);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) finish("occurrence-ended");
    });
  },
};

type ObservedTake =
  | { readonly kind: "result"; readonly value: unknown }
  | { readonly kind: "error"; readonly error: unknown };

async function takeUntilOccurrenceEnds(
  take: MutationPresentationTakeV1,
  params: MutationPresentationTakeParamsV1T,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ObservedTake | { readonly kind: "occurrence-ended" }> {
  if (signal?.aborted === true) return { kind: "occurrence-ended" };

  // Convert both fulfillment and rejection into an observed value before racing the process-local
  // occurrence. Ending an occurrence may release the UI barrier promptly, but it never leaves a
  // started Warden RPC with an unobserved rejection.
  const observed: Promise<ObservedTake> = Promise.resolve()
    .then(() => take(params, { timeoutMs }))
    .then(
      (value) => ({ kind: "result" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
  if (signal === undefined) return await observed;

  let onAbort: (() => void) | undefined;
  const ended = new Promise<{ readonly kind: "occurrence-ended" }>((resolve) => {
    onAbort = () => resolve({ kind: "occurrence-ended" });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  const winner = await Promise.race([observed, ended]);
  if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  if (winner.kind === "occurrence-ended") {
    // `observed` cannot reject; retain an explicit continuation to document the late-result sink.
    void observed.then(() => undefined);
  }
  return winner;
}

function unavailable(
  reason: "presentation-timeout" | "occurrence-ended" | "invalid-response",
): MutationPresentationResolutionV1 {
  return { status: "unavailable", reason };
}

function occurrenceEnded(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Build the memoizable process-local resolver specified by ADR-0078. The absolute deadline belongs
 * only to optional presentation settlement. Every started RPC receives its own real client timeout;
 * the deadline never abandons a call with `Promise.race`.
 */
export function createMutationPresentationPollingResolver(
  params: MutationPresentationTakeParamsV1T,
  take: MutationPresentationTakeV1,
  runtime: MutationPresentationPollingRuntime = defaultRuntime,
): MutationPresentationResolverV1 {
  return async (occurrenceSignal) => {
    if (occurrenceEnded(occurrenceSignal)) return unavailable("occurrence-ended");
    const deadline = runtime.now() + PRESENTATION_DEADLINE_MS;
    let calls = 0;

    for (;;) {
      if (occurrenceEnded(occurrenceSignal)) return unavailable("occurrence-ended");
      const remaining = deadline - runtime.now();
      if (remaining < MIN_CALL_WINDOW_MS) return unavailable("presentation-timeout");

      const observed = await takeUntilOccurrenceEnds(
        take,
        params,
        Math.min(MAX_CALL_TIMEOUT_MS, remaining),
        occurrenceSignal,
      );
      if (observed.kind === "occurrence-ended") return unavailable("occurrence-ended");
      if (observed.kind === "error") throw observed.error;

      const parsed = MutationPresentationTakeResultV1.safeParse(observed.value);
      if (!parsed.success) return unavailable("invalid-response");
      const result = parsed.data;
      if (result.status === "available" || result.status === "unavailable") return result;

      calls += 1;
      const afterCallRemaining = Math.max(0, deadline - runtime.now());
      if (afterCallRemaining === 0) return unavailable("presentation-timeout");
      const waitMs =
        calls >= MAX_CALLS ? afterCallRemaining : Math.min(result.retryAfterMs, afterCallRemaining);
      const waitResult = await runtime.wait(waitMs, occurrenceSignal);
      if (waitResult === "occurrence-ended") return unavailable("occurrence-ended");
      if (calls >= MAX_CALLS) return unavailable("presentation-timeout");
    }
  };
}
