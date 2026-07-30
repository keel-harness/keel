import type { UIPort } from "@keel/shared";
import {
  connectTerminalSuspendRequest,
  resumeTerminal,
  suspendTerminal,
} from "../tui/terminal-control.js";
import type { InputQueue } from "./input-queue.js";

export interface InteractiveTerminalHooks {
  readonly onSignal: (signal: NodeJS.Signals, handler: () => void) => () => void;
  readonly onOutputError: (handler: (error: unknown) => void) => () => void;
  readonly onOutputClose: (handler: () => void) => () => void;
  readonly onInputEnd: (handler: () => void) => () => void;
  readonly stopProcess: () => void;
}

export interface InteractiveTerminalLifecycle {
  readonly dispose: () => void;
  readonly exitCode: () => number | undefined;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}

/**
 * Convert terminal shutdown events into the same controller-owned interrupt path as Ctrl-C, then
 * close the input stream behind that interrupt. This preserves FIFO settlement: an active turn sees
 * the interrupt first and the REPL observes EOF only after the turn has settled.
 */
export function installInteractiveTerminalLifecycle(options: {
  readonly queue: InputQueue;
  readonly ui: UIPort;
  readonly hooks: InteractiveTerminalHooks;
}): InteractiveTerminalLifecycle {
  const { hooks, queue, ui } = options;
  const disconnect: (() => void)[] = [];
  let disposed = false;
  let terminating = false;
  let terminalExitCode: number | undefined;
  let suspendPending = false;

  const requestExit = (code: number): void => {
    if (disposed || terminating) return;
    terminating = true;
    terminalExitCode = code;
    queue.push({ kind: "interrupt" });
    queue.close();
  };

  const requestSuspend = (): void => {
    if (disposed || terminating || suspendPending) return;
    suspendPending = true;
    void suspendTerminal(ui).then(
      () => {
        if (!suspendPending || disposed || terminating) {
          suspendPending = false;
          return;
        }
        try {
          hooks.stopProcess();
        } catch {
          // A host can accept the lifecycle listener yet reject SIGSTOP (notably non-POSIX or
          // constrained runtimes). The renderer was already released, so reclaim it immediately
          // instead of leaving the live process headless or surfacing an unhandled rejection.
          suspendPending = false;
          if (!disposed && !terminating) resumeTerminal(ui);
        }
      },
      () => {
        // Suspension is best-effort host cleanup. If it fails, retain terminal ownership and do
        // not stop the process in an unknown renderer state.
        suspendPending = false;
        if (!disposed && !terminating) resumeTerminal(ui);
      },
    );
  };

  disconnect.push(
    connectTerminalSuspendRequest(ui, requestSuspend),
    hooks.onSignal("SIGHUP", () => requestExit(129)),
    hooks.onSignal("SIGTSTP", requestSuspend),
    hooks.onSignal("SIGCONT", () => {
      if (!disposed && !terminating) {
        suspendPending = false;
        resumeTerminal(ui);
      }
    }),
    hooks.onOutputError((error) => requestExit(errorCode(error) === "EPIPE" ? 0 : 1)),
    hooks.onOutputClose(() => requestExit(0)),
    hooks.onInputEnd(() => requestExit(0)),
  );

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const remove of disconnect.splice(0).reverse()) remove();
    },
    exitCode: () => terminalExitCode,
  };
}
