import type { UIPort } from "@keel/shared";

export type DiffViewerOpenResult = "opened" | "no-diffs" | "not-settled" | "unsupported";

/**
 * Kernel-internal focus sidecar. Opening a process-local review surface is renderer behavior, not a
 * model input, approval, or frozen `UIPort` method.
 */
export const DIFF_VIEWER_CONTROL: unique symbol = Symbol("keel.tui.diff-viewer-control");

interface DiffViewerControlHost {
  readonly [DIFF_VIEWER_CONTROL]: () => DiffViewerOpenResult;
}

export function requestDiffViewer(ui: UIPort): DiffViewerOpenResult {
  const open = (ui as UIPort & Partial<DiffViewerControlHost>)[DIFF_VIEWER_CONTROL];
  return open?.() ?? "unsupported";
}

/** Last-connected focus owner wins, matching the nested REPL/session overlay ownership contract. */
export class DiffViewerControlRegistry {
  readonly #entries: { readonly open: () => Exclude<DiffViewerOpenResult, "unsupported"> }[] = [];

  connect(open: () => Exclude<DiffViewerOpenResult, "unsupported">): () => void {
    const entry = { open };
    this.#entries.push(entry);
    let connected = true;
    return () => {
      if (!connected) return;
      connected = false;
      const index = this.#entries.lastIndexOf(entry);
      if (index >= 0) this.#entries.splice(index, 1);
    };
  }

  open(): DiffViewerOpenResult {
    return this.#entries.at(-1)?.open() ?? "unsupported";
  }
}
