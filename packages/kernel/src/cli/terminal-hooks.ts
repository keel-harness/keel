import type { EventEmitter } from "node:events";
import type { UIPort } from "@keel/shared";
import { TERMINAL_LIFECYCLE_ACTIVATE } from "../tui/terminal-control.js";
import {
  installInteractiveTerminalLifecycle,
  type InteractiveTerminalHooks,
  type InteractiveTerminalLifecycle,
} from "./terminal-lifecycle.js";
import type { InputQueue } from "./input-queue.js";

type EventSource = Pick<EventEmitter, "on" | "off">;

interface ProcessSignalSource extends EventSource {
  readonly kill: (pid: number, signal: NodeJS.Signals | number) => boolean;
}

const NOOP = (): void => undefined;

/** Thin, testable adapter from Node process/stream events to the renderer-neutral lifecycle seam. */
export function nodeInteractiveTerminalHooks(sources: {
  readonly process: ProcessSignalSource;
  readonly input: EventSource;
  readonly output: EventSource;
}): InteractiveTerminalHooks {
  return {
    onSignal: (signal, handler) => {
      try {
        sources.process.on(signal, handler);
      } catch {
        // Node hosts differ in signal support (notably Windows). Unsupported signal registration
        // must not prevent startup or weaken the hooks the host does support.
        return NOOP;
      }
      return () => sources.process.off(signal, handler);
    },
    onOutputError: (handler) => {
      const listener = (error: unknown): void => handler(error);
      sources.output.on("error", listener);
      return () => sources.output.off("error", listener);
    },
    onOutputClose: (handler) => {
      sources.output.on("close", handler);
      return () => sources.output.off("close", handler);
    },
    onInputEnd: (handler) => {
      sources.input.on("end", handler);
      sources.input.on("close", handler);
      return () => {
        sources.input.off("end", handler);
        sources.input.off("close", handler);
      };
    },
    stopProcess: () => {
      // Raw-mode Ctrl-Z is delivered to Keel as a byte, not by the terminal driver to the whole
      // foreground job. Stop process-group 0 so spawned warden/tool children cannot continue while
      // their controller is suspended. SIGSTOP is uncatchable and avoids recursive SIGTSTP hooks.
      sources.process.kill(0, "SIGSTOP");
    },
  };
}

/** Install Node terminal ownership only for the interactive Ink renderer. */
export function installNodeInteractiveTerminalLifecycle(options: {
  readonly renderer: "ink" | "headless";
  readonly queue: InputQueue;
  readonly ui: UIPort;
  readonly sources: {
    readonly process: ProcessSignalSource;
    readonly input: EventSource;
    readonly output: EventSource;
  };
}): (InteractiveTerminalLifecycle & { readonly ui: UIPort }) | undefined {
  if (options.renderer !== "ink") return undefined;
  let lifecycle: InteractiveTerminalLifecycle | undefined;
  let disposed = false;
  const activate = (): void => {
    if (disposed || lifecycle !== undefined) return;
    lifecycle = installInteractiveTerminalLifecycle({
      queue: options.queue,
      ui: wrapped,
      hooks: nodeInteractiveTerminalHooks(options.sources),
    });
  };
  // Do not intercept SIGHUP/EOF during the trust prompt. The first real render is the exact point
  // where Ink takes terminal ownership, so lifecycle hooks become active immediately before it.
  // Prototype inheritance preserves kernel-private symbol sidecars without widening `UIPort`.
  const wrapped = Object.assign(Object.create(options.ui) as UIPort, {
    [TERMINAL_LIFECYCLE_ACTIVATE]: activate,
    render: (view) => {
      activate();
      options.ui.render(view);
    },
    inputs: () => options.ui.inputs(),
    close: () => options.ui.close(),
  } satisfies UIPort & { readonly [TERMINAL_LIFECYCLE_ACTIVATE]: () => void });
  return {
    ui: wrapped,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      lifecycle?.dispose();
    },
    exitCode: () => lifecycle?.exitCode(),
  };
}
