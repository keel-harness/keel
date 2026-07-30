import { describe, expect, it, vi } from "vitest";
import type { UIPort } from "@keel/shared";
import {
  activateTerminalLifecycle,
  connectTerminalSuspendRequest,
  resumeTerminal,
  suspendTerminal,
  TERMINAL_CONTROL,
  TERMINAL_LIFECYCLE_ACTIVATE,
  TerminalSuspendRequestRegistry,
} from "./terminal-control.js";

const plainUi: UIPort = {
  render: () => undefined,
  inputs: () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ value: undefined, done: true } as const),
    }),
  }),
  close: () => Promise.resolve(),
};

describe("terminal control sidecars", () => {
  it("is a safe no-op for renderers without private terminal lifecycle support", async () => {
    expect(() => activateTerminalLifecycle(plainUi)).not.toThrow();
    await expect(suspendTerminal(plainUi)).resolves.toBeUndefined();
    expect(() => resumeTerminal(plainUi)).not.toThrow();
    const disconnect = connectTerminalSuspendRequest(plainUi, vi.fn());
    expect(() => {
      disconnect();
      disconnect();
    }).not.toThrow();
  });

  it("delegates lifecycle activation, suspension, and resumption when supported", async () => {
    const activate = vi.fn();
    const suspend = vi.fn(() => Promise.resolve());
    const resume = vi.fn();
    const controlled = Object.assign(Object.create(plainUi) as UIPort, {
      [TERMINAL_LIFECYCLE_ACTIVATE]: activate,
      [TERMINAL_CONTROL]: { suspend, resume },
    });

    activateTerminalLifecycle(controlled);
    await suspendTerminal(controlled);
    resumeTerminal(controlled);

    expect(activate).toHaveBeenCalledTimes(1);
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("routes raw suspend requests to the newest owner with idempotent disconnect", () => {
    const registry = new TerminalSuspendRequestRegistry();
    const parent = vi.fn();
    const child = vi.fn();
    const disconnectParent = registry.connect(parent);
    const disconnectChild = registry.connect(child);

    registry.request();
    disconnectParent();
    disconnectParent();
    registry.request();
    disconnectChild();
    disconnectChild();
    registry.request();

    expect(child).toHaveBeenCalledTimes(2);
    expect(parent).not.toHaveBeenCalled();
  });
});
