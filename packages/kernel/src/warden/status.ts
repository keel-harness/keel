import {
  WARDEN_METHODS,
  type UiPolicyStatus,
  type UiPosture,
  type UiProtectionRoute,
} from "@keel/shared";
import { withAutonomyStatusView, type ResolvedAutonomyPosture } from "../autopilot/posture.js";
import type { PlanApprovalSummary } from "./approval.js";

type WardenStatus = ReturnType<(typeof WARDEN_METHODS)["warden.status"]["result"]["parse"]>;

const ZERO_HASH = `sha256:${"0".repeat(64)}`;
const SHA256_PREFIX = "sha256:";
export const EGRESS_ADDRESS_GUARD_CAPABILITY = "egress-address-guard/v1";

export interface WardenStatusViewConfig {
  /** Optional for source compatibility; `wardenStatusViewConfig` always reports `governed`. */
  readonly protectionRoute?: UiProtectionRoute;
  readonly policy: UiPolicyStatus;
  readonly posture: UiPosture;
  /** Last value returned by warden.status. Presentation-only; not a live queue subscription. */
  readonly lastWardenPendingReviews?: number;
}

export interface WardenStatusViewOptions {
  readonly autonomy?: ResolvedAutonomyPosture;
  readonly planApprovalSummary?: PlanApprovalSummary;
  readonly wardenCapabilities?: readonly string[];
}

function hashPrefix(hash: string): string {
  return hash.slice(SHA256_PREFIX.length, SHA256_PREFIX.length + 12);
}

/** Map factual warden status into the existing HUD fields. Underclaim when status is ambiguous:
 *  the frozen status shape cannot distinguish an empty writer from no writer, so `audit` turns on
 *  only after a non-sentinel audit head is visible. */
export function wardenStatusViewConfig(
  status: WardenStatus,
  options: WardenStatusViewOptions = {},
): WardenStatusViewConfig {
  const sandboxOn = status.enforcementTier !== "none";
  const addressGuardOn =
    sandboxOn && options.wardenCapabilities?.includes(EGRESS_ADDRESS_GUARD_CAPABILITY) === true;
  const policyActive = status.policyPack.name !== "none" && status.policyPack.hash !== ZERO_HASH;
  const view = {
    protectionRoute: "governed" as const,
    policy: {
      active: policyActive,
      label: `${status.policyPack.name}@${hashPrefix(status.policyPack.hash)}`,
    },
    posture: {
      sandbox: sandboxOn,
      egress: addressGuardOn,
      audit: status.auditHead.hash !== ZERO_HASH,
    },
    lastWardenPendingReviews: status.pendingReviews,
  };
  if (canRoutePlanApprovalReviews(view, options.planApprovalSummary)) {
    return withPlanApprovalStatusView(view);
  }
  return options.autonomy === undefined ? view : withAutonomyStatusView(view, options.autonomy);
}

export function canRoutePlanApprovalReviews(
  view: WardenStatusViewConfig,
  planApproval: PlanApprovalSummary | undefined,
): boolean {
  return (
    planApproval !== undefined &&
    planApproval.accepted > 0 &&
    view.policy.active === true &&
    view.posture.audit === true &&
    view.posture.egress === true &&
    view.posture.sandbox === true
  );
}

export function withPlanApprovalStatusView(view: WardenStatusViewConfig): WardenStatusViewConfig {
  return {
    ...view,
    policy: {
      ...view.policy,
      label: `Plan Autopilot · ${view.policy.label ?? "active"}`,
    },
  };
}
