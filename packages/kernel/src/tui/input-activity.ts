import type { UIPort } from "@keel/shared";

/**
 * Kernel-internal presentation sidecar for keypresses that remain entirely inside the Ink composer.
 * It stays outside the frozen `UIPort`: local editing changes neither model input nor authority.
 */
export const LOCAL_INPUT_ACTIVITY: unique symbol = Symbol("keel.tui.local-input-activity");

interface LocalInputActivityHost {
  readonly [LOCAL_INPUT_ACTIVITY]: (handler: () => void) => () => void;
}

const NOOP = (): void => undefined;

/** Attach the current controller's local-input observer when the concrete UI supports it. */
export function connectLocalInputActivity(ui: UIPort, handler: () => void): () => void {
  const connect = (ui as UIPort & Partial<LocalInputActivityHost>)[LOCAL_INPUT_ACTIVITY];
  return connect === undefined ? NOOP : connect(handler);
}

/** Last-connected controller owns local-input lifecycle updates; disconnect restores its parent. */
export class LocalInputActivityRegistry {
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

  notify(): void {
    this.#entries.at(-1)?.handler();
  }
}
