import { describe, expect, it, vi } from "vitest";
import type { UIPort, UserInput, ViewModel } from "@keel/shared";
import { InputQueue } from "../cli/input-queue.js";
import {
  DIFF_VIEWER_CONTROL,
  DiffViewerControlRegistry,
  requestDiffViewer,
} from "./diff-viewer-control.js";

class Ui implements UIPort {
  readonly registry = new DiffViewerControlRegistry();
  readonly [DIFF_VIEWER_CONTROL] = (): ReturnType<DiffViewerControlRegistry["open"]> =>
    this.registry.open();

  render(_view: ViewModel): void {}
  inputs(): AsyncIterable<UserInput> {
    return new InputQueue();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("diff viewer private control sidecar", () => {
  it("is unsupported on alternate renderers without widening UIPort", () => {
    const ui: UIPort = {
      render: () => undefined,
      inputs: () => new InputQueue(),
      close: () => Promise.resolve(),
    };

    expect(requestDiffViewer(ui)).toBe("unsupported");
  });

  it("uses last-connected focus ownership and restores the prior owner on disconnect", () => {
    const ui = new Ui();
    const outer = vi.fn(() => "no-diffs" as const);
    const inner = vi.fn(() => "opened" as const);
    const disconnectOuter = ui.registry.connect(outer);
    const disconnectInner = ui.registry.connect(inner);

    expect(requestDiffViewer(ui)).toBe("opened");
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();

    disconnectInner();
    expect(requestDiffViewer(ui)).toBe("no-diffs");
    disconnectOuter();
    expect(requestDiffViewer(ui)).toBe("unsupported");
  });

  it("keeps the control hook absent from enumerable keys and JSON", () => {
    const ui = new Ui();

    expect(Object.keys(ui)).not.toContain(String(DIFF_VIEWER_CONTROL));
    expect(JSON.stringify(ui)).not.toMatch(/diff.viewer|opened|no-diffs/iu);
  });
});
