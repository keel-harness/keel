import type { UIPort } from "@keel/shared";

/**
 * Kernel-internal presentation sidecar. It deliberately stays outside the frozen `UIPort`: closing
 * a read-only overlay is local UI ownership, not model input or control-plane authority.
 */
export const OVERLAY_DISMISS: unique symbol = Symbol("keel.tui.overlay-dismiss");

interface OverlayDismissHost {
  readonly [OVERLAY_DISMISS]: (handler: () => void) => () => void;
}

const NOOP = (): void => undefined;

/** Attach a controller-local dismiss handler when the concrete UI supports the internal sidecar. */
export function connectOverlayDismiss(ui: UIPort, handler: () => void): () => void {
  const connect = (ui as UIPort & Partial<OverlayDismissHost>)[OVERLAY_DISMISS];
  return connect === undefined ? NOOP : connect(handler);
}

/**
 * Last-connected owner wins. `runRepl` owns idle panels; a nested `runSession` temporarily owns
 * active-turn panels, then disconnects to reveal the idle owner again.
 */
export class OverlayDismissRegistry {
  readonly #entries: { readonly handler: () => void }[] = [];

  connect(handler: () => void): () => void {
    const entry = { handler };
    this.#entries.push(entry);
    let connected = true;
    return () => {
      if (!connected) return;
      connected = false;
      const index = this.#entries.lastIndexOf(entry);
      if (index >= 0) this.#entries.splice(index, 1);
    };
  }

  dismiss(): void {
    this.#entries.at(-1)?.handler();
  }
}
