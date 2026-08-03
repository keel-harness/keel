import { describe, expect, it, vi } from "vitest";
import type { UIPort, UserInput } from "@keel/shared";
import { INPUT_HISTORY_SEED, seedInputHistory } from "./input-history.js";

const noInputs: AsyncIterable<UserInput> = {
  [Symbol.asyncIterator]: () => ({
    next: async () => ({ done: true, value: undefined }),
  }),
};

const headlessUi: UIPort = {
  render: () => undefined,
  inputs: () => noInputs,
  close: async () => undefined,
};

describe("input-history sidecar", () => {
  it("is a no-op for a UIPort that does not support interactive recall", () => {
    expect(() => seedInputHistory(headlessUi, ["task"])).not.toThrow();
  });

  it("passes the exact ordered seed to a capable renderer", () => {
    const seed = vi.fn();
    const ui = { ...headlessUi, [INPUT_HISTORY_SEED]: seed };

    seedInputHistory(ui, ["first", "first", "latest"]);

    expect(seed).toHaveBeenCalledOnce();
    expect(seed).toHaveBeenCalledWith(["first", "first", "latest"]);
  });
});
