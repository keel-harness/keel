import type { UIPort } from "@keel/shared";

/** Hand a transient release-bootstrap paint to the real UI without changing UIPort semantics. */
export function wrapUiWithBootstrapClear(ui: UIPort, clear: (() => void) | undefined): UIPort {
  if (clear === undefined) return ui;
  let pending = true;
  const handoff = (): void => {
    if (!pending) return;
    pending = false;
    clear();
  };
  // Preserve kernel-internal symbol sidecars (overlay/input/terminal ownership) through the
  // bootstrap decorator without naming them here or widening the frozen UIPort. Instance-owned
  // arrow functions remain bound to the concrete UI when resolved through this prototype.
  return Object.assign(Object.create(ui) as UIPort, {
    render(view) {
      handoff();
      ui.render(view);
    },
    inputs: () => ui.inputs(),
    close: () => {
      handoff();
      return ui.close();
    },
  } satisfies UIPort);
}
