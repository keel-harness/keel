/** The controller-bound runtime states rendered across every current TUI truth surface (ADR-0080). */
export type UiRuntimeProtectionState =
  | "starting"
  | "governed"
  | "deliberately-unenforced"
  | "unavailable"
  | "not-reported";

export interface UiRuntimeTruthCopy {
  /** Text after `protection:`. Uppercase is intentional only for the reduced-enforcement warning. */
  readonly label: string;
  /** Optional status-line qualifier placed immediately after the state label. */
  readonly qualifier?: string;
  /** Shared panel sentence. It names the state and the immediate operational consequence. */
  readonly panel: string;
}

/** One reviewed vocabulary catalog for security-relevant, cross-surface TUI copy. One-off product
 * labels remain beside their covered planners; render-only components do not invent these words. */
export const TUI_RUNTIME_TRUTH: Readonly<Record<UiRuntimeProtectionState, UiRuntimeTruthCopy>> = {
  starting: {
    label: "starting",
    qualifier: "input waits · no tool actions can run",
    panel: "starting — input waits; no tool actions can run",
  },
  governed: {
    label: "governed",
    panel: "governed — see the protection facts below",
  },
  "deliberately-unenforced": {
    label: "UNENFORCED",
    qualifier: "deliberately direct",
    panel: "UNENFORCED — deliberately direct; do not infer enforcement",
  },
  unavailable: {
    label: "unavailable",
    qualifier: "tools halted",
    panel: "unavailable — tools halted",
  },
  "not-reported": {
    label: "status not reported",
    qualifier: "do not infer enforcement",
    panel: "status not reported — do not infer enforcement",
  },
};
