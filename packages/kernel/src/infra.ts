/**
 * Raised when an external operation (a tool execution, or — in Epic 1.3 — a model
 * transport call) exceeds its deadline. Kept distinct from model/tool *errors* so
 * infra hangs are recorded separately in the trajectory (§8.2, borrowed-technique D).
 */
export class InfraError extends Error {
  constructor(message: string) {
    super(`infra: ${message}`);
    this.name = "InfraError";
  }
}

const TOOL_DEADLINE_ABORT_REASON = Object.freeze({ code: "KEEL_TOOL_INFRA_DEADLINE" });

/** Abort only the currently executing tool occurrence when the Kernel's infrastructure deadline
 * expires. The private identity marker lets an interactive review distinguish this revocation from
 * a user interrupt without exposing a serializable authority token. */
export function abortForToolDeadline(controller: AbortController): void {
  if (!controller.signal.aborted) controller.abort(TOOL_DEADLINE_ABORT_REASON);
}

export function isToolDeadlineAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === TOOL_DEADLINE_ABORT_REASON;
}

/**
 * Run `op()` with a deadline. Resolves with its value if it settles within `ms`;
 * propagates the op's own error if it rejects first; rejects with an `InfraError`
 * if the deadline passes. On a timeout the op is *abandoned* (its promise is left
 * pending) — actually cancelling the underlying work (e.g. killing a bash process)
 * is the tool's job and lands with the real tools in Epic 1.2.
 */
export function withDeadline<T>(
  op: () => Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(new InfraError(`${label} exceeded ${String(ms)}ms`));
      }
    }, ms);
  });
  return Promise.race([op(), timeout]).finally(() => {
    clearTimeout(timer);
  });
}
