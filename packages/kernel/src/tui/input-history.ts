import type { UIPort } from "@keel/shared";

/** Kernel-internal, presentation-only resume seam. It deliberately stays outside frozen `UIPort`:
 * prompt recall neither changes model context nor grants authority. */
export const INPUT_HISTORY_SEED: unique symbol = Symbol("keel.tui.input-history-seed");

interface InputHistorySeedHost {
  readonly [INPUT_HISTORY_SEED]: (history: readonly string[]) => void;
}

/** Seed a capable interactive renderer. Headless and test ports without the sidecar remain no-ops. */
export function seedInputHistory(ui: UIPort, history: readonly string[]): void {
  const seed = (ui as UIPort & Partial<InputHistorySeedHost>)[INPUT_HISTORY_SEED];
  seed?.(history);
}
