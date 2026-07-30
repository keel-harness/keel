export type ToolPresentationOutcome =
  | "limited"
  | "partial"
  | "review"
  | "blocked"
  | "skipped"
  | "stopped"
  | "failed";

const TOOL_PRESENTATION_OUTCOME = Symbol("keel.tool-presentation-outcome");
const TOOL_CONTROL_FAILURE = Symbol("keel.tool-control-failure");

type OutcomeTagged = {
  readonly [TOOL_PRESENTATION_OUTCOME]?: ToolPresentationOutcome;
};

type ControlFailureTagged = {
  readonly [TOOL_CONTROL_FAILURE]?: string;
};

/**
 * Attaches kernel-local presentation metadata without changing frozen ports, events, or ledger JSON.
 * The non-enumerable symbol cannot be supplied by model/tool text and disappears at every wire boundary.
 */
export function markToolPresentationOutcome<T extends object>(
  value: T,
  outcome: ToolPresentationOutcome,
): T {
  Object.defineProperty(value, TOOL_PRESENTATION_OUTCOME, { value: outcome });
  return value;
}

export function toolPresentationOutcome(value: object): ToolPresentationOutcome | undefined {
  return (value as OutcomeTagged)[TOOL_PRESENTATION_OUTCOME];
}

export function copyToolPresentationOutcome<T extends object>(source: object, target: T): T {
  const outcome = toolPresentationOutcome(source);
  return outcome === undefined ? target : markToolPresentationOutcome(target, outcome);
}

/** Marks an in-process control-plane failure without changing the frozen tool-result/event shape. */
export function markToolControlFailure<T extends object>(value: T, code: string): T {
  Object.defineProperty(value, TOOL_CONTROL_FAILURE, { value: code });
  return value;
}

export function toolControlFailureCode(value: object): string | undefined {
  return (value as ControlFailureTagged)[TOOL_CONTROL_FAILURE];
}
