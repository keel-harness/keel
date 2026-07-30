import type { KernelAuditEventT, UiPolicyStatus, UiPosture } from "@keel/shared";

export const AUTONOMY_MODES = ["guided", "autopilot", "project-autopilot", "danger"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

export const AUTONOMY_MODE_SOURCES = ["default", "human", "model", "project-file", "plan"] as const;
export type AutonomyModeSource = (typeof AUTONOMY_MODE_SOURCES)[number];

export interface AutonomyPostureRequest {
  readonly mode: AutonomyMode;
  readonly source: Exclude<AutonomyModeSource, "default">;
  readonly userConfirmed?: boolean;
  readonly reason?: string;
  /**
   * True when this request re-applies a mode a human set in a PRIOR session (loaded from persisted
   * user/project-scope config), not a live human action this session. The elevation is still a real
   * human decision (persisted, deny-write to the model), but the audit record must say so honestly
   * rather than reading like a fresh confirmation (QC §7).
   */
  readonly persisted?: boolean;
}

export interface AutonomyPostureContext {
  readonly trustedWorkspace: boolean;
}

export interface ResolvedAutonomyPosture {
  readonly accepted: boolean;
  readonly explicitRequest: boolean;
  readonly mode: AutonomyMode;
  readonly source: AutonomyModeSource;
  readonly requestedMode?: string;
  readonly requestedSource?: string;
  readonly requestReason?: string;
  readonly reason?: string;
  /** Carried through from the request: a persisted (prior-session) human decision, not a live one. */
  readonly persisted?: boolean;
}

export interface ModeChangeAuditOptions {
  readonly previousMode: AutonomyMode;
  readonly resolved: ResolvedAutonomyPosture;
  readonly sessionId: string;
  readonly trustedWorkspace: boolean;
  readonly workspaceRoot: string;
}

export interface AutonomyStatusView {
  readonly policy: UiPolicyStatus;
  readonly posture: UiPosture;
}

const MODE_SET = new Set<string>(AUTONOMY_MODES);
const SOURCE_SET = new Set<string>(AUTONOMY_MODE_SOURCES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modeFrom(value: unknown): AutonomyMode | undefined {
  if (typeof value !== "string" || !MODE_SET.has(value)) return undefined;
  return value as AutonomyMode;
}

function sourceFrom(value: unknown): AutonomyPostureRequest["source"] | undefined {
  if (typeof value !== "string" || !SOURCE_SET.has(value) || value === "default") return undefined;
  return value as AutonomyPostureRequest["source"];
}

function isAcceptedHumanModePosture(
  value: unknown,
  modes: readonly AutonomyMode[],
): value is ResolvedAutonomyPosture {
  if (!isRecord(value)) return false;
  const requestReason = value["requestReason"];
  const mode = value["mode"];
  return (
    value["accepted"] === true &&
    value["explicitRequest"] === true &&
    typeof mode === "string" &&
    modes.includes(mode as AutonomyMode) &&
    value["source"] === "human" &&
    value["requestedMode"] === mode &&
    value["requestedSource"] === "human" &&
    value["reason"] === undefined &&
    (requestReason === undefined || typeof requestReason === "string")
  );
}

export function isAcceptedHumanAutopilotPosture(value: unknown): value is ResolvedAutonomyPosture {
  return isAcceptedHumanModePosture(value, ["autopilot"]);
}

export function isAcceptedHumanAutopilotRoutingPosture(
  value: unknown,
): value is ResolvedAutonomyPosture {
  return isAcceptedHumanModePosture(value, ["autopilot", "project-autopilot"]);
}

export function canRouteAutopilotReviews(
  view: AutonomyStatusView,
  autonomy: ResolvedAutonomyPosture,
): boolean {
  return (
    isAcceptedHumanAutopilotRoutingPosture(autonomy) &&
    view.policy.active === true &&
    view.posture.audit === true &&
    view.posture.egress === true &&
    view.posture.sandbox === true
  );
}

function guidedRefusal(
  request: {
    readonly mode?: string;
    readonly source?: string;
    readonly normalizedSource?: AutonomyModeSource;
    readonly reason?: string | undefined;
  },
  reason: string,
): ResolvedAutonomyPosture {
  return {
    accepted: false,
    explicitRequest: true,
    mode: "guided",
    source: request.normalizedSource ?? "default",
    ...(request.mode === undefined ? {} : { requestedMode: request.mode }),
    ...(request.source === undefined ? {} : { requestedSource: request.source }),
    ...(request.reason === undefined ? {} : { requestReason: request.reason }),
    reason,
  };
}

export function resolveAutonomyPosture(
  request: unknown,
  context: AutonomyPostureContext,
): ResolvedAutonomyPosture {
  if (request === undefined) {
    return { accepted: true, explicitRequest: false, mode: "guided", source: "default" };
  }
  if (!isRecord(request)) {
    return guidedRefusal({}, "invalid autonomy mode request");
  }

  const requestedMode = modeFrom(request["mode"]);
  const source = sourceFrom(request["source"]);
  if (requestedMode === undefined || source === undefined) {
    return guidedRefusal(
      {
        ...(typeof request["mode"] === "string" ? { mode: request["mode"] } : {}),
        ...(typeof request["source"] === "string" ? { source: request["source"] } : {}),
      },
      "invalid autonomy mode request",
    );
  }

  const parsed: AutonomyPostureRequest = {
    mode: requestedMode,
    source,
    ...(request["userConfirmed"] === true ? { userConfirmed: true } : {}),
    ...(typeof request["reason"] === "string" ? { reason: request["reason"] } : {}),
    ...(request["persisted"] === true ? { persisted: true } : {}),
  };

  if (parsed.mode === "guided") {
    return {
      accepted: true,
      explicitRequest: true,
      mode: "guided",
      source: parsed.source,
      requestedMode: "guided",
      requestedSource: parsed.source,
      ...(parsed.reason === undefined ? {} : { requestReason: parsed.reason }),
    };
  }
  if (parsed.source !== "human") {
    return guidedRefusal(
      { mode: parsed.mode, source: parsed.source, normalizedSource: parsed.source },
      "autonomy mode elevation is human-only",
    );
  }
  if (parsed.userConfirmed !== true) {
    return guidedRefusal(
      {
        mode: parsed.mode,
        source: parsed.source,
        normalizedSource: parsed.source,
        reason: parsed.reason,
      },
      "autonomy mode elevation requires explicit human confirmation",
    );
  }
  if (
    (parsed.mode === "autopilot" || parsed.mode === "project-autopilot") &&
    !context.trustedWorkspace
  ) {
    return guidedRefusal(
      {
        mode: parsed.mode,
        source: parsed.source,
        normalizedSource: parsed.source,
        reason: parsed.reason,
      },
      "Autopilot requires a trusted workspace",
    );
  }
  if (parsed.mode === "autopilot") {
    return {
      accepted: true,
      explicitRequest: true,
      mode: "autopilot",
      source: parsed.source,
      requestedMode: "autopilot",
      requestedSource: parsed.source,
      ...(parsed.reason === undefined ? {} : { requestReason: parsed.reason }),
      ...(parsed.persisted === true ? { persisted: true } : {}),
    };
  }
  if (parsed.mode === "project-autopilot") {
    return {
      accepted: true,
      explicitRequest: true,
      mode: "project-autopilot",
      source: parsed.source,
      requestedMode: "project-autopilot",
      requestedSource: parsed.source,
      ...(parsed.reason === undefined ? {} : { requestReason: parsed.reason }),
      ...(parsed.persisted === true ? { persisted: true } : {}),
    };
  }
  if (parsed.mode === "danger") {
    return guidedRefusal(
      {
        mode: parsed.mode,
        source: parsed.source,
        normalizedSource: parsed.source,
        reason: parsed.reason,
      },
      "Danger mode is not wired in this runtime",
    );
  }

  return guidedRefusal(
    {
      mode: parsed.mode,
      source: parsed.source,
      normalizedSource: parsed.source,
      reason: parsed.reason,
    },
    "autonomy mode is not wired in this runtime",
  );
}

function statusModeLabel(
  view: AutonomyStatusView,
  autonomy: ResolvedAutonomyPosture,
): string | undefined {
  const policy = view.policy;
  if (policy.active !== true) return undefined;
  if (autonomy.accepted !== true || autonomy.mode === "guided") return "Guided";
  if (canRouteAutopilotReviews(view, autonomy)) {
    return autonomy.mode === "project-autopilot" ? "Project Autopilot" : "Autopilot";
  }
  return undefined;
}

export function withAutonomyStatusView<T extends AutonomyStatusView>(
  view: T,
  autonomy: ResolvedAutonomyPosture,
): T {
  const modeLabel = statusModeLabel(view, autonomy);
  if (modeLabel === undefined) return view;

  const policyLabel = view.policy.label ?? "active";
  return {
    ...view,
    policy: {
      ...view.policy,
      label: `${modeLabel} · ${policyLabel}`,
    },
  };
}

export function buildModeChangeAuditEvent(
  options: ModeChangeAuditOptions,
): KernelAuditEventT | undefined {
  if (!options.resolved.explicitRequest) return undefined;
  return {
    eventType: "mode.change",
    payload: {
      accepted: options.resolved.accepted,
      nextMode: options.resolved.mode,
      previousMode: options.previousMode,
      requestedMode: options.resolved.requestedMode ?? null,
      requestedSource: options.resolved.requestedSource ?? null,
      reason: options.resolved.reason ?? null,
      requestReason: options.resolved.requestReason ?? null,
      sessionId: options.sessionId,
      source: options.resolved.source,
      // Honest attribution (QC §7): a persisted (prior-session) human decision re-applied this
      // session vs a live human confirmation. The elevation is real either way; the record says which.
      persisted: options.resolved.persisted === true,
      trustedWorkspace: options.trustedWorkspace,
      workspaceRoot: options.workspaceRoot,
    },
  };
}
