import { describe, expect, it, vi } from "vitest";
import type { UIPort, UserInput } from "@keel/shared";
import { InputQueue } from "./input-queue.js";
import {
  installInteractiveTerminalLifecycle,
  type InteractiveTerminalHooks,
} from "./terminal-lifecycle.js";
import { TERMINAL_CONTROL, TERMINAL_SUSPEND_REQUEST } from "../tui/terminal-control.js";

class HookHarness implements InteractiveTerminalHooks {
  readonly signal = new Map<NodeJS.Signals, Set<() => void>>();
  readonly outputError = new Set<(error: unknown) => void>();
  readonly outputClose = new Set<() => void>();
  readonly inputEnd = new Set<() => void>();
  readonly stopProcess = vi.fn();

  onSignal(signal: NodeJS.Signals, handler: () => void): () => void {
    const handlers = this.signal.get(signal) ?? new Set<() => void>();
    handlers.add(handler);
    this.signal.set(signal, handlers);
    return () => handlers.delete(handler);
  }

  onOutputError(handler: (error: unknown) => void): () => void {
    this.outputError.add(handler);
    return () => this.outputError.delete(handler);
  }

  onOutputClose(handler: () => void): () => void {
    this.outputClose.add(handler);
    return () => this.outputClose.delete(handler);
  }

  onInputEnd(handler: () => void): () => void {
    this.inputEnd.add(handler);
    return () => this.inputEnd.delete(handler);
  }

  emitSignal(signal: NodeJS.Signals): void {
    for (const handler of this.signal.get(signal) ?? []) handler();
  }
}

function controlledUi(
  options: {
    readonly suspend?: () => Promise<void>;
    readonly resume?: () => void;
  } = {},
): UIPort {
  return {
    render: () => undefined,
    inputs: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ value: undefined, done: true } as const),
      }),
    }),
    close: () => Promise.resolve(),
    [TERMINAL_CONTROL]: {
      suspend: options.suspend ?? (() => Promise.resolve()),
      resume: options.resume ?? (() => undefined),
    },
  } as UIPort;
}

async function drain(queue: InputQueue): Promise<IteratorResult<UserInput>[]> {
  return [await queue.next(), await queue.next()];
}

describe("interactive terminal lifecycle", () => {
  it("turns SIGHUP into one graceful interrupt followed by EOF and preserves signal exit status", async () => {
    const queue = new InputQueue();
    const hooks = new HookHarness();
    const lifecycle = installInteractiveTerminalLifecycle({
      queue,
      ui: controlledUi(),
      hooks,
    });

    hooks.emitSignal("SIGHUP");
    hooks.emitSignal("SIGHUP");

    expect(await drain(queue)).toEqual([
      { value: { kind: "interrupt" }, done: false },
      { value: undefined, done: true },
    ]);
    expect(lifecycle.exitCode()).toBe(129);
    lifecycle.dispose();
  });

  it("settles stdin EOF, output close, EPIPE, and other output failures without duplicate input", async () => {
    for (const trigger of ["input", "close", "epipe", "other", "primitive"] as const) {
      const queue = new InputQueue();
      const hooks = new HookHarness();
      const lifecycle = installInteractiveTerminalLifecycle({
        queue,
        ui: controlledUi(),
        hooks,
      });

      if (trigger === "input") for (const handler of hooks.inputEnd) handler();
      if (trigger === "close") for (const handler of hooks.outputClose) handler();
      if (trigger === "epipe") {
        for (const handler of hooks.outputError)
          handler(Object.assign(new Error("closed"), { code: "EPIPE" }));
      }
      if (trigger === "other") {
        for (const handler of hooks.outputError)
          handler(Object.assign(new Error("failed"), { code: "EIO" }));
      }
      if (trigger === "primitive") {
        for (const handler of hooks.outputError) handler("closed without an Error object");
      }

      expect(await drain(queue)).toEqual([
        { value: { kind: "interrupt" }, done: false },
        { value: undefined, done: true },
      ]);
      expect(lifecycle.exitCode()).toBe(trigger === "other" || trigger === "primitive" ? 1 : 0);
      lifecycle.dispose();
    }
  });

  it("releases terminal ownership before SIGTSTP and restores it on SIGCONT", async () => {
    let releaseSuspend!: () => void;
    const suspend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSuspend = resolve;
        }),
    );
    const resume = vi.fn();
    const queue = new InputQueue();
    const hooks = new HookHarness();
    const lifecycle = installInteractiveTerminalLifecycle({
      queue,
      ui: controlledUi({ suspend, resume }),
      hooks,
    });

    hooks.emitSignal("SIGTSTP");
    hooks.emitSignal("SIGTSTP");
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(hooks.stopProcess).not.toHaveBeenCalled();
    releaseSuspend();
    await vi.waitFor(() => expect(hooks.stopProcess).toHaveBeenCalledTimes(1));
    hooks.emitSignal("SIGTSTP");
    expect(suspend).toHaveBeenCalledTimes(1);

    hooks.emitSignal("SIGCONT");
    expect(resume).toHaveBeenCalledTimes(1);
    expect(lifecycle.exitCode()).toBeUndefined();
    lifecycle.dispose();
  });

  it("does not stop after SIGCONT supersedes renderer cleanup before it settles", async () => {
    let releaseSuspend!: () => void;
    const suspend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSuspend = resolve;
        }),
    );
    const resume = vi.fn();
    const hooks = new HookHarness();
    const lifecycle = installInteractiveTerminalLifecycle({
      queue: new InputQueue(),
      ui: controlledUi({ suspend, resume }),
      hooks,
    });

    hooks.emitSignal("SIGTSTP");
    hooks.emitSignal("SIGCONT");
    releaseSuspend();
    await Promise.resolve();
    await Promise.resolve();

    expect(resume).toHaveBeenCalledTimes(1);
    expect(hooks.stopProcess).not.toHaveBeenCalled();
    lifecycle.dispose();
  });

  it("routes an Ink raw-mode suspend request through the same guarded stop lifecycle", async () => {
    const suspend = vi.fn(() => Promise.resolve());
    let requestSuspend: (() => void) | undefined;
    const disconnectRequest = vi.fn();
    const ui = Object.assign(controlledUi({ suspend }), {
      [TERMINAL_SUSPEND_REQUEST]: (handler: () => void) => {
        requestSuspend = handler;
        return disconnectRequest;
      },
    });
    const hooks = new HookHarness();
    const lifecycle = installInteractiveTerminalLifecycle({
      queue: new InputQueue(),
      ui,
      hooks,
    });

    expect(requestSuspend).toBeTypeOf("function");
    requestSuspend?.();
    await vi.waitFor(() => expect(hooks.stopProcess).toHaveBeenCalledTimes(1));
    expect(suspend).toHaveBeenCalledTimes(1);

    lifecycle.dispose();
    expect(disconnectRequest).toHaveBeenCalledTimes(1);
  });

  it("does not stop the process when renderer suspension fails", async () => {
    const hooks = new HookHarness();
    const resume = vi.fn();
    const lifecycle = installInteractiveTerminalLifecycle({
      queue: new InputQueue(),
      ui: controlledUi({
        suspend: () => Promise.reject(new Error("raw mode release failed")),
        resume,
      }),
      hooks,
    });

    hooks.emitSignal("SIGTSTP");
    await Promise.resolve();
    await Promise.resolve();

    expect(hooks.stopProcess).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(lifecycle.exitCode()).toBeUndefined();
    lifecycle.dispose();
  });

  it("reclaims terminal ownership when the host cannot stop the process", async () => {
    const resume = vi.fn();
    const hooks = new HookHarness();
    hooks.stopProcess.mockImplementation(() => {
      throw new Error("SIGSTOP unsupported");
    });
    const lifecycle = installInteractiveTerminalLifecycle({
      queue: new InputQueue(),
      ui: controlledUi({ suspend: () => Promise.resolve(), resume }),
      hooks,
    });

    hooks.emitSignal("SIGTSTP");
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));

    expect(hooks.stopProcess).toHaveBeenCalledTimes(1);
    expect(lifecycle.exitCode()).toBeUndefined();
    lifecycle.dispose();
  });

  it("does not stop after a terminal exit supersedes an in-flight suspension", async () => {
    let releaseSuspend!: () => void;
    const hooks = new HookHarness();
    const queue = new InputQueue();
    const lifecycle = installInteractiveTerminalLifecycle({
      queue,
      ui: controlledUi({
        suspend: () =>
          new Promise<void>((resolve) => {
            releaseSuspend = resolve;
          }),
      }),
      hooks,
    });

    hooks.emitSignal("SIGTSTP");
    hooks.emitSignal("SIGHUP");
    releaseSuspend();
    await Promise.resolve();
    await Promise.resolve();

    expect(hooks.stopProcess).not.toHaveBeenCalled();
    expect(lifecycle.exitCode()).toBe(129);
    expect(await drain(queue)).toEqual([
      { value: { kind: "interrupt" }, done: false },
      { value: undefined, done: true },
    ]);
    lifecycle.dispose();
  });

  it("removes every listener on dispose", () => {
    const hooks = new HookHarness();
    const lifecycle = installInteractiveTerminalLifecycle({
      queue: new InputQueue(),
      ui: controlledUi(),
      hooks,
    });
    lifecycle.dispose();
    lifecycle.dispose();

    expect([...hooks.signal.values()].flatMap((handlers) => [...handlers])).toEqual([]);
    expect(hooks.outputError.size).toBe(0);
    expect(hooks.outputClose.size).toBe(0);
    expect(hooks.inputEnd.size).toBe(0);
  });

  it("ignores resume and pending suspension settlement after disposal", async () => {
    let releaseSuspend!: () => void;
    const suspend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSuspend = resolve;
        }),
    );
    const resume = vi.fn();
    const hooks = new HookHarness();
    const lifecycle = installInteractiveTerminalLifecycle({
      queue: new InputQueue(),
      ui: controlledUi({ suspend, resume }),
      hooks,
    });

    hooks.emitSignal("SIGTSTP");
    const resumeHandlers = [...(hooks.signal.get("SIGCONT") ?? [])];
    lifecycle.dispose();
    for (const handler of resumeHandlers) handler();
    releaseSuspend();
    await Promise.resolve();
    await Promise.resolve();

    expect(resume).not.toHaveBeenCalled();
    expect(hooks.stopProcess).not.toHaveBeenCalled();
  });
});
