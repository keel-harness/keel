import { describe, expect, it, vi } from "vitest";
import type { UIPort } from "@keel/shared";
import { connectLocalInputActivity, LocalInputActivityRegistry } from "./input-activity.js";

const plainUi: UIPort = {
  render: () => undefined,
  inputs: () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ value: undefined, done: true } as const),
    }),
  }),
  close: () => Promise.resolve(),
};

describe("local input activity", () => {
  it("is a safe no-op for renderers without the private activity sidecar", () => {
    const handler = vi.fn();
    const disconnect = connectLocalInputActivity(plainUi, handler);

    expect(() => {
      disconnect();
      disconnect();
    }).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps newest-owner routing stable across duplicate and out-of-order disconnects", () => {
    const registry = new LocalInputActivityRegistry();
    const parent = vi.fn();
    const child = vi.fn();
    const disconnectParent = registry.connect(parent);
    const disconnectChild = registry.connect(child);

    registry.notify();
    disconnectParent();
    disconnectParent();
    registry.notify();
    disconnectChild();
    disconnectChild();
    registry.notify();

    expect(child).toHaveBeenCalledTimes(2);
    expect(parent).not.toHaveBeenCalled();
  });
});
