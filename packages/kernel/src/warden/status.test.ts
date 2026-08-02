import { describe, expect, it } from "vitest";
import { cockpitStatusLine, initialView } from "../tui/view-model.js";
import { wardenStatusViewConfig, type WardenStatusViewOptions } from "./status.js";

const HASH = `sha256:${"a".repeat(64)}`;
const ZERO_HASH = `sha256:${"0".repeat(64)}`;

describe("warden status view config", () => {
  it("derives egress truth from the address-guard capability rather than the sandbox tier", () => {
    const status = {
      enforcementTier: "sandbox:srt",
      sandboxBackend: "srt:vendored",
      policyPack: { name: "phase2a-starter-policy-pack", hash: HASH },
      auditHead: { seq: 3, hash: HASH },
      pendingReviews: 0,
    };
    const guarded = wardenStatusViewConfig(status, {
      wardenCapabilities: ["egress-address-guard/v1"],
    } as WardenStatusViewOptions);
    const nameOnly = wardenStatusViewConfig(status, {
      wardenCapabilities: [],
    } as WardenStatusViewOptions);

    expect(guarded.posture).toMatchObject({ sandbox: true, egress: true });
    expect(nameOnly.posture).toMatchObject({ sandbox: true, egress: false });
  });

  it("maps live warden status into an honest Phase-2A cockpit line", () => {
    const config = wardenStatusViewConfig({
      enforcementTier: "sandbox:srt",
      sandboxBackend: "srt:vendored",
      policyPack: { name: "phase2a-starter-policy-pack", hash: HASH },
      auditHead: { seq: 3, hash: HASH },
      pendingReviews: 2,
    });
    const view = initialView([], {
      ...config,
    });

    const line = cockpitStatusLine(view.status);
    expect(line).toContain("● sandbox");
    expect(line).toContain("● egress");
    expect(line).toContain("● audit");
    expect(line).toContain("● policy phase2a-starter-policy-pack@aaaaaaaaaaaa");
    expect(line).not.toContain("no enforcement");
    expect(config.protectionRoute).toBe("governed");
    expect(config.lastWardenPendingReviews).toBe(2);
    expect(view.lastWardenPendingReviews).toBe(2);
  });

  it("keeps no-sandbox and sentinel audit head visibly off on the governed route", () => {
    const view = initialView([], {
      ...wardenStatusViewConfig({
        enforcementTier: "none",
        sandboxBackend: "none",
        policyPack: { name: "phase2a-starter-policy-pack", hash: HASH },
        auditHead: { seq: 0, hash: ZERO_HASH },
        pendingReviews: 0,
      }),
    });

    const line = cockpitStatusLine(view.status);
    expect(line).toContain("○ sandbox");
    expect(line).toContain("○ egress");
    expect(line).toContain("○ audit");
    expect(line).toContain("● policy phase2a-starter-policy-pack@aaaaaaaaaaaa");
    expect(line).toContain("protection: governed");
    expect(line).not.toContain("no enforcement");
  });

  it("does not activate the policy HUD for the explicit none pack", () => {
    const view = initialView([], {
      ...wardenStatusViewConfig({
        enforcementTier: "none",
        sandboxBackend: "none",
        policyPack: { name: "none", hash: ZERO_HASH },
        auditHead: { seq: 0, hash: ZERO_HASH },
        pendingReviews: 0,
      }),
    });

    expect(cockpitStatusLine(view.status)).toContain("○ policy none");
  });

  it("labels a live exact-resource plan approval as Plan Autopilot only with full enforcement", () => {
    const view = initialView([], {
      ...wardenStatusViewConfig(
        {
          enforcementTier: "sandbox:srt",
          sandboxBackend: "srt:vendored",
          policyPack: { name: "phase2a-starter-policy-pack", hash: HASH },
          auditHead: { seq: 3, hash: HASH },
          pendingReviews: 0,
        },
        {
          planApprovalSummary: {
            planId: "plan_auth_fix",
            accepted: 1,
            rejected: 0,
          },
        },
      ),
    });

    const line = cockpitStatusLine(view.status);
    expect(line).toContain("● policy Plan Autopilot · phase2a-starter-policy-pack@aaaaaaaaaaaa");
  });

  it("does not claim Plan Autopilot for rejected plan envelopes or missing visible gates", () => {
    const rejected = initialView([], {
      ...wardenStatusViewConfig(
        {
          enforcementTier: "sandbox:srt",
          sandboxBackend: "srt:vendored",
          policyPack: { name: "phase2a-starter-policy-pack", hash: HASH },
          auditHead: { seq: 3, hash: HASH },
          pendingReviews: 0,
        },
        {
          planApprovalSummary: {
            planId: "plan_rejected",
            accepted: 0,
            rejected: 1,
          },
        },
      ),
    });
    expect(cockpitStatusLine(rejected.status)).not.toContain("Plan Autopilot");

    const noAudit = initialView([], {
      ...wardenStatusViewConfig(
        {
          enforcementTier: "sandbox:srt",
          sandboxBackend: "srt:vendored",
          policyPack: { name: "phase2a-starter-policy-pack", hash: HASH },
          auditHead: { seq: 0, hash: ZERO_HASH },
          pendingReviews: 0,
        },
        {
          planApprovalSummary: {
            planId: "plan_auth_fix",
            accepted: 1,
            rejected: 0,
          },
        },
      ),
    });
    expect(cockpitStatusLine(noAudit.status)).not.toContain("Plan Autopilot");

    const noSandbox = initialView([], {
      ...wardenStatusViewConfig(
        {
          enforcementTier: "none",
          sandboxBackend: "none",
          policyPack: { name: "phase2a-starter-policy-pack", hash: HASH },
          auditHead: { seq: 3, hash: HASH },
          pendingReviews: 0,
        },
        {
          planApprovalSummary: {
            planId: "plan_auth_fix",
            accepted: 1,
            rejected: 0,
          },
        },
      ),
    });
    expect(cockpitStatusLine(noSandbox.status)).not.toContain("Plan Autopilot");

    const noPolicy = initialView([], {
      ...wardenStatusViewConfig(
        {
          enforcementTier: "sandbox:srt",
          sandboxBackend: "srt:vendored",
          policyPack: { name: "none", hash: ZERO_HASH },
          auditHead: { seq: 3, hash: HASH },
          pendingReviews: 0,
        },
        {
          planApprovalSummary: {
            planId: "plan_auth_fix",
            accepted: 1,
            rejected: 0,
          },
        },
      ),
    });
    expect(cockpitStatusLine(noPolicy.status)).not.toContain("Plan Autopilot");
  });
});
