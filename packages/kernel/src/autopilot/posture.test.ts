import { describe, expect, it } from "vitest";
import { cockpitStatusLine, initialView } from "../tui/view-model.js";
import { wardenStatusViewConfig } from "../warden/status.js";
import {
  buildModeChangeAuditEvent,
  resolveAutonomyPosture,
  withAutonomyStatusView,
  type AutonomyPostureRequest,
  type AutonomyStatusView,
} from "./posture.js";

const HASH = `sha256:${"a".repeat(64)}`;
const ZERO_HASH = `sha256:${"0".repeat(64)}`;

function trustedHuman(mode: AutonomyPostureRequest["mode"]): AutonomyPostureRequest {
  return { mode, source: "human", userConfirmed: true };
}

function status(options: { readonly audit?: boolean; readonly enforcement?: boolean } = {}) {
  const enforcement = options.enforcement ?? true;
  const audit = options.audit ?? true;
  return {
    enforcementTier: enforcement ? "sandbox:srt" : "none",
    sandboxBackend: enforcement ? "srt:vendored" : "none",
    policyPack: { name: "phase2a-starter-policy-pack", hash: HASH },
    auditHead: { seq: audit ? 3 : 0, hash: audit ? HASH : ZERO_HASH },
    pendingReviews: 0,
  };
}

function statusLine(request: AutonomyPostureRequest, options = {}): string {
  const autonomy = resolveAutonomyPosture(request, { trustedWorkspace: true });
  const view = initialView([], {
    ...wardenStatusViewConfig(status(options), { autonomy }),
  });
  return cockpitStatusLine(view.status);
}

describe("autonomy posture resolution", () => {
  it("defaults to Guided without a mode request", () => {
    expect(resolveAutonomyPosture(undefined, { trustedWorkspace: false })).toMatchObject({
      accepted: true,
      mode: "guided",
      source: "default",
    });
  });

  it("accepts a confirmed human Autopilot request in a trusted workspace", () => {
    expect(
      resolveAutonomyPosture(trustedHuman("autopilot"), { trustedWorkspace: true }),
    ).toMatchObject({
      accepted: true,
      explicitRequest: true,
      mode: "autopilot",
      requestedMode: "autopilot",
      requestedSource: "human",
      source: "human",
    });
  });

  it("refuses Autopilot in an untrusted workspace", () => {
    const resolved = resolveAutonomyPosture(trustedHuman("autopilot"), {
      trustedWorkspace: false,
    });

    expect(resolved).toMatchObject({
      accepted: false,
      mode: "guided",
      requestedMode: "autopilot",
      source: "human",
    });
    expect(resolved.reason).toContain("trusted workspace");
  });

  it("refuses Project Autopilot in an untrusted workspace before posture-specific routing", () => {
    const resolved = resolveAutonomyPosture(trustedHuman("project-autopilot"), {
      trustedWorkspace: false,
    });

    expect(resolved).toMatchObject({
      accepted: false,
      mode: "guided",
      requestedMode: "project-autopilot",
      source: "human",
    });
    expect(resolved.reason).toContain("trusted workspace");
  });

  it("accepts confirmed human Project Autopilot in a trusted workspace", () => {
    expect(
      resolveAutonomyPosture(
        { ...trustedHuman("project-autopilot"), reason: "persisted project Autopilot mode" },
        { trustedWorkspace: true },
      ),
    ).toEqual({
      accepted: true,
      explicitRequest: true,
      mode: "project-autopilot",
      requestedMode: "project-autopilot",
      requestedSource: "human",
      requestReason: "persisted project Autopilot mode",
      source: "human",
    });
  });

  it("accepts explicit Guided requests without raising autonomy", () => {
    expect(
      resolveAutonomyPosture(
        { mode: "guided", source: "human", reason: "stay cautious" },
        { trustedWorkspace: false },
      ),
    ).toEqual({
      accepted: true,
      explicitRequest: true,
      mode: "guided",
      requestedMode: "guided",
      requestedSource: "human",
      requestReason: "stay cautious",
      source: "human",
    });
  });

  it("refuses human elevation without explicit confirmation", () => {
    const resolved = resolveAutonomyPosture(
      { mode: "autopilot", source: "human", reason: "daily work" },
      { trustedWorkspace: true },
    );

    expect(resolved).toMatchObject({
      accepted: false,
      mode: "guided",
      requestedMode: "autopilot",
      requestedSource: "human",
      requestReason: "daily work",
      source: "human",
    });
    expect(resolved.reason).toContain("explicit human confirmation");
  });

  it("refuses non-human attempts to raise autonomy even in a trusted workspace", () => {
    for (const source of ["model", "project-file", "plan"] as const) {
      const resolved = resolveAutonomyPosture(
        { mode: "autopilot", source, userConfirmed: true },
        { trustedWorkspace: true },
      );

      expect(resolved).toMatchObject({
        accepted: false,
        explicitRequest: true,
        mode: "guided",
        requestedMode: "autopilot",
        requestedSource: source,
        source,
      });
      expect(resolved.reason).toContain("human-only");
    }
  });

  it("keeps Danger unwired in this runtime path", () => {
    const resolved = resolveAutonomyPosture(
      { ...trustedHuman("danger"), reason: "debug escape hatch" },
      {
        trustedWorkspace: true,
      },
    );

    expect(resolved).toMatchObject({
      accepted: false,
      mode: "guided",
      requestedMode: "danger",
      requestReason: "debug escape hatch",
      source: "human",
    });
    expect(resolved.reason).toContain("not wired");
  });

  it("refuses non-object autonomy requests as malformed explicit requests", () => {
    expect(resolveAutonomyPosture("autopilot", { trustedWorkspace: true })).toEqual({
      accepted: false,
      explicitRequest: true,
      mode: "guided",
      reason: "invalid autonomy mode request",
      source: "default",
    });
  });

  it("refuses malformed object requests without inventing requested fields", () => {
    expect(resolveAutonomyPosture({ mode: 7, source: false }, { trustedWorkspace: true })).toEqual({
      accepted: false,
      explicitRequest: true,
      mode: "guided",
      reason: "invalid autonomy mode request",
      source: "default",
    });
  });

  it("records a json-safe accepted Project Autopilot mode.change event", () => {
    const resolved = resolveAutonomyPosture(
      { ...trustedHuman("project-autopilot"), reason: "trusted repo daily work" },
      { trustedWorkspace: true },
    );

    expect(
      buildModeChangeAuditEvent({
        previousMode: "guided",
        resolved,
        sessionId: "ses_test",
        trustedWorkspace: true,
        workspaceRoot: "/workspace",
      }),
    ).toEqual({
      eventType: "mode.change",
      payload: {
        accepted: true,
        nextMode: "project-autopilot",
        previousMode: "guided",
        requestedMode: "project-autopilot",
        requestedSource: "human",
        reason: null,
        requestReason: "trusted repo daily work",
        sessionId: "ses_test",
        source: "human",
        persisted: false,
        trustedWorkspace: true,
        workspaceRoot: "/workspace",
      },
    });
  });

  it("records a persisted mode re-application honestly (persisted:true), not as a live human confirm (QC §7)", () => {
    // A persisted Project-Autopilot mode re-applied at session start (no live human this run) must be
    // distinguishable in the audit record from a fresh human confirmation — otherwise the ledger reads
    // `source:"human"` for an unattended re-application.
    const resolved = resolveAutonomyPosture(
      { ...trustedHuman("project-autopilot"), persisted: true },
      { trustedWorkspace: true },
    );
    expect(resolved.persisted).toBe(true);
    const event = buildModeChangeAuditEvent({
      previousMode: "guided",
      resolved,
      sessionId: "ses_test",
      trustedWorkspace: true,
      workspaceRoot: "/workspace",
    });
    expect(event?.payload).toMatchObject({ source: "human", persisted: true });
  });

  it("records a LIVE human mode change as persisted:false", () => {
    const resolved = resolveAutonomyPosture(trustedHuman("autopilot"), { trustedWorkspace: true });
    const event = buildModeChangeAuditEvent({
      previousMode: "guided",
      resolved,
      sessionId: "ses_test",
      trustedWorkspace: true,
      workspaceRoot: "/workspace",
    });
    expect(event?.payload).toMatchObject({ source: "human", persisted: false });
  });

  it("does not emit mode.change for the implicit default Guided posture", () => {
    const resolved = resolveAutonomyPosture(undefined, { trustedWorkspace: true });

    expect(
      buildModeChangeAuditEvent({
        previousMode: "guided",
        resolved,
        sessionId: "ses_test",
        trustedWorkspace: true,
        workspaceRoot: "/workspace",
      }),
    ).toBeUndefined();
  });

  it("can audit malformed explicit requests as refusals", () => {
    const resolved = resolveAutonomyPosture(
      { mode: "root-autopilot", source: "project-file" },
      { trustedWorkspace: true },
    );

    expect(
      buildModeChangeAuditEvent({
        previousMode: "guided",
        resolved,
        sessionId: "ses_test",
        trustedWorkspace: true,
        workspaceRoot: "/workspace",
      }),
    ).toEqual({
      eventType: "mode.change",
      payload: {
        accepted: false,
        nextMode: "guided",
        previousMode: "guided",
        requestedMode: "root-autopilot",
        requestedSource: "project-file",
        reason: "invalid autonomy mode request",
        requestReason: null,
        sessionId: "ses_test",
        source: "default",
        persisted: false,
        trustedWorkspace: true,
        workspaceRoot: "/workspace",
      },
    });
  });

  it("preserves valid requested modes when the source field is malformed", () => {
    const resolved = resolveAutonomyPosture(
      { mode: "autopilot", source: "default" },
      { trustedWorkspace: true },
    );

    expect(resolved).toEqual({
      accepted: false,
      explicitRequest: true,
      mode: "guided",
      reason: "invalid autonomy mode request",
      requestedMode: "autopilot",
      requestedSource: "default",
      source: "default",
    });
  });
});

describe("autonomy posture status labeling", () => {
  it("labels active audited policy status as Autopilot when prompt routing is wired", () => {
    const line = statusLine(trustedHuman("autopilot"));

    expect(line).toContain("● sandbox");
    expect(line).toContain("● egress");
    expect(line).toContain("● audit");
    expect(line).toContain("● policy Autopilot · phase2a-starter-policy-pack@aaaaaaaaaaaa");
    expect(line).not.toContain("Guided ·");
    expect(line).not.toContain("no enforcement");
  });

  it("labels active audited policy status as Project Autopilot when persisted mode is active", () => {
    const line = statusLine({ mode: "project-autopilot", source: "human", userConfirmed: true });

    expect(line).toContain("● policy Project Autopilot · phase2a-starter-policy-pack@aaaaaaaaaaaa");
    expect(line).not.toContain("● policy Autopilot ·");
    expect(line).not.toContain("Guided ·");
  });

  it("does not claim Autopilot when audit is not yet visible", () => {
    const line = statusLine(trustedHuman("autopilot"), { audit: false });

    expect(line).toContain("○ audit");
    expect(line).toContain("● policy phase2a-starter-policy-pack@aaaaaaaaaaaa");
    expect(line).not.toContain("Autopilot");
    expect(line).not.toContain("Guided ·");
  });

  it("does not claim Autopilot when enforcement is not active", () => {
    const line = statusLine(trustedHuman("autopilot"), { enforcement: false });

    expect(line).toContain("○ sandbox");
    expect(line).toContain("○ egress");
    expect(line).toContain("● audit");
    expect(line).toContain("● policy phase2a-starter-policy-pack@aaaaaaaaaaaa");
    expect(line).not.toContain("Autopilot");
    expect(line).not.toContain("Guided ·");
  });

  it("does not claim Autopilot when the request did not come from a human", () => {
    const line = statusLine({ mode: "autopilot", source: "model", userConfirmed: true });

    expect(line).toContain("● policy Guided · phase2a-starter-policy-pack@aaaaaaaaaaaa");
    expect(line).not.toContain("Autopilot");
  });

  it("leaves inactive policy status unchanged", () => {
    const view = {
      policy: { active: false, label: "none" },
      posture: { audit: true, egress: true, sandbox: true },
    };

    expect(
      withAutonomyStatusView(
        view,
        resolveAutonomyPosture(trustedHuman("autopilot"), {
          trustedWorkspace: true,
        }),
      ),
    ).toBe(view);
  });

  it("uses a conservative fallback label for active unlabeled policy status", () => {
    const view: AutonomyStatusView = {
      policy: { active: true },
      posture: { audit: true, egress: true, sandbox: true },
    };

    expect(
      withAutonomyStatusView(
        view,
        resolveAutonomyPosture(trustedHuman("autopilot"), {
          trustedWorkspace: true,
        }),
      ).policy.label,
    ).toBe("Autopilot · active");
  });
});
