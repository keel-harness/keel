import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ViewModel } from "@keel/shared";
import { InputQueue } from "./input-queue.js";
import {
  installNodeInteractiveTerminalLifecycle,
  nodeInteractiveTerminalHooks,
} from "./terminal-hooks.js";
import { activateTerminalLifecycle } from "../tui/terminal-control.js";

class SignalSource extends EventEmitter {
  readonly pid = 42;
  readonly kill = vi.fn((_pid: number, _signal: NodeJS.Signals | number) => true);
}

const view: ViewModel = {
  items: [],
  status: { tokens: 0, posture: { sandbox: false, egress: false, audit: false } },
  streaming: false,
};

describe("node interactive terminal hooks", () => {
  it("bridges signals, both input terminal events, output events, and SIGSTOP with exact cleanup", () => {
    const processSource = new SignalSource();
    const input = new EventEmitter();
    const output = new EventEmitter();
    const hooks = nodeInteractiveTerminalHooks({ process: processSource, input, output });
    const signal = vi.fn();
    const inputEnd = vi.fn();
    const outputClose = vi.fn();
    const outputError = vi.fn();
    const removes = [
      hooks.onSignal("SIGHUP", signal),
      hooks.onInputEnd(inputEnd),
      hooks.onOutputClose(outputClose),
      hooks.onOutputError(outputError),
    ];

    processSource.emit("SIGHUP");
    input.emit("end");
    input.emit("close");
    output.emit("close");
    const failure = Object.assign(new Error("closed"), { code: "EPIPE" });
    output.emit("error", failure);
    hooks.stopProcess();

    expect(signal).toHaveBeenCalledTimes(1);
    expect(inputEnd).toHaveBeenCalledTimes(2);
    expect(outputClose).toHaveBeenCalledTimes(1);
    expect(outputError).toHaveBeenCalledWith(failure);
    expect(processSource.kill).toHaveBeenCalledWith(0, "SIGSTOP");

    for (const remove of removes) remove();
    expect(processSource.listenerCount("SIGHUP")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
    expect(output.listenerCount("close")).toBe(0);
    expect(output.listenerCount("error")).toBe(0);
  });

  it("reports a foreground-group stop failure so the lifecycle can reclaim the renderer", () => {
    const processSource = new SignalSource();
    processSource.kill.mockImplementation((_pid, signal) => {
      if (signal === "SIGSTOP") throw new Error("SIGSTOP unsupported");
      return true;
    });
    const hooks = nodeInteractiveTerminalHooks({
      process: processSource,
      input: new EventEmitter(),
      output: new EventEmitter(),
    });

    expect(() => hooks.stopProcess()).toThrow("SIGSTOP unsupported");
    expect(processSource.kill).toHaveBeenCalledTimes(1);
    expect(processSource.kill).toHaveBeenCalledWith(0, "SIGSTOP");
  });

  it("fails closed to a no-op registration when a host does not support a signal", () => {
    const processSource = new SignalSource();
    processSource.on = vi.fn(() => {
      throw new Error("unsupported signal");
    }) as typeof processSource.on;
    const hooks = nodeInteractiveTerminalHooks({
      process: processSource,
      input: new EventEmitter(),
      output: new EventEmitter(),
    });

    expect(() => hooks.onSignal("SIGTSTP", vi.fn())()).not.toThrow();
  });

  it("uses first Ink render as an activation fallback and routes a source signal into the shared queue", async () => {
    const processSource = new SignalSource();
    const input = new EventEmitter();
    const output = new EventEmitter();
    const sources = { process: processSource, input, output };
    const ui = {
      render: vi.fn(),
      inputs: () => new InputQueue(),
      close: () => Promise.resolve(),
    };
    const headlessQueue = new InputQueue();

    expect(
      installNodeInteractiveTerminalLifecycle({
        renderer: "headless",
        queue: headlessQueue,
        ui,
        sources,
      }),
    ).toBeUndefined();
    expect(processSource.listenerCount("SIGHUP")).toBe(0);

    const queue = new InputQueue();
    const lifecycle = installNodeInteractiveTerminalLifecycle({
      renderer: "ink",
      queue,
      ui,
      sources,
    });
    expect(processSource.listenerCount("SIGHUP")).toBe(0);

    lifecycle?.ui.render(view);
    expect(ui.render).toHaveBeenCalledWith(view);
    expect(processSource.listenerCount("SIGHUP")).toBe(1);
    processSource.emit("SIGHUP");

    expect(await queue.next()).toEqual({ value: { kind: "interrupt" }, done: false });
    expect(lifecycle?.exitCode()).toBe(129);
    lifecycle?.dispose();
    expect(processSource.listenerCount("SIGHUP")).toBe(0);
  });

  it("can activate after trust resolution before the first Ink render", () => {
    const processSource = new SignalSource();
    const input = new EventEmitter();
    const output = new EventEmitter();
    const ui = {
      render: vi.fn(),
      inputs: () => new InputQueue(),
      close: () => Promise.resolve(),
    };
    const lifecycle = installNodeInteractiveTerminalLifecycle({
      renderer: "ink",
      queue: new InputQueue(),
      ui,
      sources: { process: processSource, input, output },
    });

    activateTerminalLifecycle(lifecycle?.ui ?? ui);

    expect(processSource.listenerCount("SIGHUP")).toBe(1);
    expect(ui.render).not.toHaveBeenCalled();
    lifecycle?.dispose();
  });

  it("can be disposed before activation without claiming terminal ownership or breaking UI delegates", async () => {
    const processSource = new SignalSource();
    const input = new EventEmitter();
    const output = new EventEmitter();
    const sources = { process: processSource, input, output };
    const queue = new InputQueue();
    const inputStream = new InputQueue();
    const close = vi.fn(() => Promise.resolve());
    const ui = {
      render: vi.fn(),
      inputs: vi.fn(() => inputStream),
      close,
    };
    const lifecycle = installNodeInteractiveTerminalLifecycle({
      renderer: "ink",
      queue,
      ui,
      sources,
    });

    lifecycle?.dispose();
    lifecycle?.dispose();
    activateTerminalLifecycle(lifecycle?.ui ?? ui);
    lifecycle?.ui.render(view);

    expect(processSource.listenerCount("SIGHUP")).toBe(0);
    expect(lifecycle?.ui.inputs()).toBe(inputStream);
    await lifecycle?.ui.close();
    expect(ui.inputs).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(lifecycle?.exitCode()).toBeUndefined();
  });
});
