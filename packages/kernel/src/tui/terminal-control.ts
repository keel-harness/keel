import type { UIPort } from "@keel/shared";

/**
 * Kernel-internal lifecycle sidecar for releasing and reclaiming a concrete terminal renderer.
 * It deliberately stays outside the frozen `UIPort`: suspension is host plumbing, not model input
 * or control-plane authority.
 */
export const TERMINAL_CONTROL: unique symbol = Symbol("keel.tui.terminal-control");
export const TERMINAL_LIFECYCLE_ACTIVATE: unique symbol = Symbol(
  "keel.tui.terminal-lifecycle-activate",
);
export const TERMINAL_SUSPEND_REQUEST: unique symbol = Symbol("keel.tui.terminal-suspend-request");

interface TerminalControlHost {
  readonly [TERMINAL_CONTROL]: {
    readonly suspend: () => Promise<void>;
    readonly resume: () => void;
  };
}

interface TerminalLifecycleActivationHost {
  readonly [TERMINAL_LIFECYCLE_ACTIVATE]: () => void;
}

interface TerminalSuspendRequestHost {
  readonly [TERMINAL_SUSPEND_REQUEST]: (handler: () => void) => () => void;
}

const NOOP = (): void => undefined;

/** Activate terminal event ownership after workspace trust resolution, never during its prompt. */
export function activateTerminalLifecycle(ui: UIPort): void {
  (ui as UIPort & Partial<TerminalLifecycleActivationHost>)[TERMINAL_LIFECYCLE_ACTIVATE]?.();
}

/** Release terminal ownership when the concrete UI supports suspension. */
export function suspendTerminal(ui: UIPort): Promise<void> {
  return (
    (ui as UIPort & Partial<TerminalControlHost>)[TERMINAL_CONTROL]?.suspend() ?? Promise.resolve()
  );
}

/** Reclaim terminal ownership when the concrete UI supports resumption. */
export function resumeTerminal(ui: UIPort): void {
  (ui as UIPort & Partial<TerminalControlHost>)[TERMINAL_CONTROL]?.resume();
}

/** Observe a raw-renderer job-control request without widening `UIPort` or `UserInput`. */
export function connectTerminalSuspendRequest(ui: UIPort, handler: () => void): () => void {
  const connect = (ui as UIPort & Partial<TerminalSuspendRequestHost>)[TERMINAL_SUSPEND_REQUEST];
  return connect === undefined ? NOOP : connect(handler);
}

/** Last-connected terminal lifecycle owns raw-mode suspension requests. */
export class TerminalSuspendRequestRegistry {
  readonly #entries: { readonly handler: () => void }[] = [];

  connect(handler: () => void): () => void {
    const entry = { handler };
    this.#entries.push(entry);
    let connected = true;
    return () => {
      if (!connected) return;
      connected = false;
      const index = this.#entries.lastIndexOf(entry);
      if (index >= 0) this.#entries.splice(index, 1);
    };
  }

  request(): void {
    this.#entries.at(-1)?.handler();
  }
}
