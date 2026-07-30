import { describe, expect, it, vi } from "vitest";
import type { UIPort, UserInput, ViewModel } from "@keel/shared";
import { connectOverlayDismiss, OVERLAY_DISMISS } from "../tui/overlay-dismiss.js";
import { wrapUiWithBootstrapClear } from "./bootstrap-ui.js";

const view: ViewModel = {
  items: [],
  status: {
    tokens: 0,
    posture: { sandbox: false, egress: false, audit: false },
  },
  streaming: false,
};

describe("release bootstrap UI handoff", () => {
  it("preserves the original UI identity when no bootstrap paint exists", () => {
    const base: UIPort = {
      render: vi.fn(),
      inputs: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
        }),
      }),
      close: () => Promise.resolve(),
    };

    expect(wrapUiWithBootstrapClear(base, undefined)).toBe(base);
  });

  it("clears the transient bootstrap paint exactly once before the first real render", async () => {
    const order: string[] = [];
    const inputs: AsyncIterable<UserInput> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ value: undefined, done: true }),
      }),
    };
    const close = vi.fn(() => Promise.resolve());
    const base: UIPort = {
      render: () => order.push("render"),
      inputs: () => inputs,
      close,
    };
    const clear = vi.fn(() => order.push("clear"));
    const ui = wrapUiWithBootstrapClear(base, clear);

    ui.render(view);
    ui.render(view);
    expect(order).toEqual(["clear", "render", "render"]);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(ui.inputs()).toBe(inputs);
    await ui.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("clears transient paint when startup closes before the first real render", async () => {
    const order: string[] = [];
    const base: UIPort = {
      render: () => order.push("render"),
      inputs: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true }),
        }),
      }),
      close: () => {
        order.push("close");
        return Promise.resolve();
      },
    };
    const ui = wrapUiWithBootstrapClear(base, () => order.push("clear"));

    await ui.close();

    expect(order).toEqual(["clear", "close"]);
  });

  it("preserves private UI sidecars across the production bootstrap handoff", () => {
    const dismiss = vi.fn();
    const base = {
      render: vi.fn(),
      inputs: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.resolve({ value: undefined, done: true } as const),
        }),
      }),
      close: () => Promise.resolve(),
      [OVERLAY_DISMISS]: (handler: () => void) => {
        dismiss.mockImplementation(handler);
        return () => dismiss.mockReset();
      },
    } satisfies UIPort & { readonly [OVERLAY_DISMISS]: (handler: () => void) => () => void };

    const wrapped = wrapUiWithBootstrapClear(base, vi.fn());
    const owner = vi.fn();
    const disconnect = connectOverlayDismiss(wrapped, owner);

    dismiss();
    expect(owner).toHaveBeenCalledTimes(1);
    disconnect();
  });
});
