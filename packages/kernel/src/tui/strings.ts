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

/** Controller-derived truth for a terminal Warden review result which supplied no live review
 * handle. This is a block with recovery, not an approval prompt or a policy denial. */
export const TUI_TERMINAL_REVIEW_TRUTH = {
  summaryPrefix: "blocked (not executed): no live decision available ·",
  reason: "no live decision is available; this result was not executed",
  recovery: "no live decision · simplify the request, then rerun",
} as const;

/** Controller-derived Autopilot review boundaries. The compact reason is short enough to remain
 * visible in a 40-column receipt when the fuller summary is truncated from the `what` line. */
export const TUI_AUTOPILOT_REVIEW_BOUNDARY = {
  domain: {
    summary:
      "blocked by warden (not executed): review closed as denied · Autopilot: no matching exact-domain grant",
    reason: "Autopilot: no exact-domain grant",
  },
  commandEnvelope: {
    summary:
      "blocked by warden (not executed): review closed as denied · Autopilot: exact command envelope required",
    reason: "Autopilot: exact command required",
  },
} as const;

/** ADR-0079's fixed, non-destructive recovery boundary. Shared by the completion receipt and the
 * focused diff surface so neither renderer invents a stronger undo claim. */
export const TUI_MANUAL_RECOVERY_GUIDANCE =
  "automatic undo unavailable — review file evidence and recover deliberately from version control or a backup";
