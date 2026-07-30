import { describe, expect, it } from "vitest";
import { WARDEN_METHODS } from "@keel/shared";
import type { PolicyDecision } from "../policy.js";
import {
  buildConsoleOpenGrantPolicyInput,
  mintHeadlessConsoleOpenGrantEnvelope,
} from "./headless-grant.js";
import { buildConsoleSandboxPlanForTarget, consoleSandboxPlanDigest } from "./sandbox.js";
import { CONSOLE_TOOL_NAMES } from "./schema.js";
import { consoleTargetGrantReviewDecision, consoleReviewGrantKey } from "./grants.js";
import { createQemuConsoleTargetProfile } from "./qemu-target.js";
import { prepareSystemTmuxConsoleSandboxPlan } from "./tmux-broker.js";
import {
  createConsoleRuntimeState,
  createHeadlessConsoleGrantEnvelope,
  installHeadlessConsoleGrants,
  parseHeadlessConsoleGrantEnvelope,
  type HeadlessConsoleGrantEnvelopePayloadT,
} from "./grants.js";

const PAYLOAD: HeadlessConsoleGrantEnvelopePayloadT = {
  version: "keel-headless-console-grant/v1",
  source: "local-console-grant-file",
  sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  workspaceRoot: "/repo",
  target: {
    targetId: "qemu-alpine",
    targetDigest: `sha256:${"a".repeat(64)}`,
    sandboxProfileId: "srt-workspace-deny-egress",
  },
  operation: { kind: "open", rows: 24, cols: 80 },
  targetProfile: {
    command: "/usr/bin/qemu-system-x86_64",
    argv: ["/usr/bin/qemu-system-x86_64", "-nographic"],
    cwd: "/repo",
  },
  policyPack: { name: "test-policy", hash: `sha256:${"1".repeat(64)}` },
  sandboxPlanDigest: `sha256:${"2".repeat(64)}`,
  effectEnvelope: {
    effectKinds: ["process_exec"],
    scopes: ["workspace"],
  },
  matchedRules: ["CONSOLE-TARGET-GRANT-REQUIRED"],
  grantKey: `sha256:${"3".repeat(64)}`,
  principal: {
    osUser: "alice",
    configuredId: null,
    authProvider: "local",
    assurance: "local-os-user",
  },
  reviewedAt: "2026-07-10T18:00:00.000Z",
  expiresAt: "2026-07-10T19:00:00.000Z",
  maxUses: 1,
  reviewText: "console target qemu-alpine requires approval",
};

describe("headless interactive console grants", () => {
  it("canonicalizes the envelope hash independent of object insertion order", () => {
    const reordered = {
      reviewText: PAYLOAD.reviewText,
      maxUses: PAYLOAD.maxUses,
      expiresAt: PAYLOAD.expiresAt,
      reviewedAt: PAYLOAD.reviewedAt,
      principal: PAYLOAD.principal,
      grantKey: PAYLOAD.grantKey,
      matchedRules: PAYLOAD.matchedRules,
      effectEnvelope: PAYLOAD.effectEnvelope,
      sandboxPlanDigest: PAYLOAD.sandboxPlanDigest,
      policyPack: PAYLOAD.policyPack,
      targetProfile: PAYLOAD.targetProfile,
      operation: PAYLOAD.operation,
      target: PAYLOAD.target,
      workspaceRoot: PAYLOAD.workspaceRoot,
      sessionId: PAYLOAD.sessionId,
      source: PAYLOAD.source,
      version: PAYLOAD.version,
    };

    expect(createHeadlessConsoleGrantEnvelope(reordered).envelopeHash).toBe(
      createHeadlessConsoleGrantEnvelope(PAYLOAD).envelopeHash,
    );
  });

  it("rejects tampered envelope hashes and does not reload consumed grants", () => {
    const grant = createHeadlessConsoleGrantEnvelope(PAYLOAD);
    expect(() =>
      parseHeadlessConsoleGrantEnvelope({ ...grant, envelopeHash: `sha256:${"f".repeat(64)}` }),
    ).toThrow(/hash mismatch/u);

    const state = createConsoleRuntimeState();
    installHeadlessConsoleGrants(state, [grant], () => "2026-07-10T18:00:00.000Z");
    expect(state.headlessGrants.size).toBe(1);
    state.headlessGrants.clear();
    installHeadlessConsoleGrants(state, [grant], () => "2026-07-10T18:01:00.000Z");
    expect(state.headlessGrants.size).toBe(0);
  });

  it("mints a parent-reviewed envelope from the same policy/sandbox material the warden enforces", () => {
    const sessionId = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const workspaceRoot = "/workspace";
    const profile = createQemuConsoleTargetProfile({
      targetId: "qemu-startup",
      qemuBinary: "/usr/bin/qemu-system-x86_64",
      memoryMiB: 512,
      boot: { order: "cdrom" },
      display: { kind: "none" },
      nographic: true,
      serial: { kind: "telnet", bindHost: "127.0.0.1", port: 6665 },
      cwd: workspaceRoot,
      diskImages: [{ path: "/workspace/alpine.iso", access: "read-only", role: "cdrom" }],
      allowRelease: true,
    });
    const sandboxPlan = prepareSystemTmuxConsoleSandboxPlan(
      buildConsoleSandboxPlanForTarget(profile, {
        workspaceRoot,
        env: { USER: "reviewer" },
      }),
      "/tmp/keel-console-tmux-qemu-startup-fixed",
    );
    const policyPack = { name: "phase2a-starter-policy-pack", hash: `sha256:${"4".repeat(64)}` };
    const policyDecision: PolicyDecision = {
      verdict: "warn",
      matchedRules: ["BASE-WARN"],
      guidance: "base policy warning",
    };
    const policyInput = buildConsoleOpenGrantPolicyInput({
      sessionId,
      workspaceRoot,
      profile,
      rows: 24,
      cols: 80,
      env: { USER: "reviewer" },
      workspaceTrusted: true,
    });
    const operation = {
      kind: "open" as const,
      toolName: CONSOLE_TOOL_NAMES.open,
      args: { targetId: "qemu-startup", rows: 24, cols: 80 },
    };
    const parsedParams = WARDEN_METHODS["warden.execute"].params.parse({
      sessionId,
      toolCall: { id: "console-open-grant", name: CONSOLE_TOOL_NAMES.open, args: operation.args },
      provenanceContext: { inputTags: ["workspace"] },
    });
    expect(policyInput).toEqual(
      buildConsoleOpenGrantPolicyInput({
        sessionId: parsedParams.sessionId,
        workspaceRoot,
        profile,
        rows: 24,
        cols: 80,
        env: { USER: "reviewer" },
        workspaceTrusted: true,
      }),
    );
    const grantDecision = consoleTargetGrantReviewDecision(policyDecision, profile.targetId);

    const envelope = mintHeadlessConsoleOpenGrantEnvelope({
      source: "parent-reviewed-benchmark-env",
      sessionId,
      workspaceRoot,
      profile,
      rows: 24,
      cols: 80,
      env: { USER: "reviewer" },
      workspaceTrusted: true,
      policyPack,
      policyDecision,
      sandboxPlan,
      principal: {
        osUser: "alice",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
      reviewedAt: "2026-07-10T18:00:00.000Z",
      expiresAt: "2026-07-10T19:00:00.000Z",
    });

    expect(envelope.source).toBe("parent-reviewed-benchmark-env");
    expect(envelope.sessionId).toBe(sessionId);
    expect(envelope.workspaceRoot).toBe(workspaceRoot);
    expect(envelope.target).toEqual({
      targetId: "qemu-startup",
      targetDigest: profile.targetDigest,
      sandboxProfileId: profile.sandboxProfileId,
    });
    expect(envelope.sandboxPlanDigest).toBe(consoleSandboxPlanDigest(sandboxPlan));
    expect(envelope.grantKey).toBe(
      consoleReviewGrantKey(
        {
          workspaceRoot,
          policyPack,
          sandboxPlanDigest: consoleSandboxPlanDigest(sandboxPlan),
        },
        operation,
        profile,
        policyInput,
        grantDecision,
      ),
    );
    expect(envelope.matchedRules).toEqual(["BASE-WARN", "CONSOLE-TARGET-GRANT-REQUIRED"]);
    expect(envelope.effectEnvelope["effectKinds"]).toEqual(
      expect.arrayContaining(["process_exec"]),
    );
    expect(envelope.effectEnvelope["scopes"]).toEqual(
      expect.arrayContaining(["process", "unknown"]),
    );
    expect(Array.isArray(envelope.effectEnvelope["modifiers"])).toBe(true);
    expect(Array.isArray(envelope.effectEnvelope["targets"])).toBe(true);
    expect(envelope.reviewText).toBe("console target qemu-startup requires approval");
    expect(parseHeadlessConsoleGrantEnvelope(envelope)).toEqual(envelope);
  });

  it("refuses to mint headless grants from deny or modify policy decisions", () => {
    const profile = createQemuConsoleTargetProfile({
      targetId: "qemu-startup",
      qemuBinary: "/usr/bin/qemu-system-x86_64",
      cwd: "/workspace",
      diskImages: [{ path: "/workspace/alpine.iso", access: "read-only", role: "cdrom" }],
    });
    const common = {
      source: "parent-reviewed-benchmark-env" as const,
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      workspaceRoot: "/workspace",
      profile,
      rows: 24,
      cols: 80,
      policyPack: { name: "phase2a-starter-policy-pack", hash: `sha256:${"4".repeat(64)}` },
      sandboxPlan: buildConsoleSandboxPlanForTarget(profile, { workspaceRoot: "/workspace" }),
      principal: {
        osUser: "alice",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
      reviewedAt: "2026-07-10T18:00:00.000Z",
      expiresAt: "2026-07-10T19:00:00.000Z",
    };

    expect(() =>
      mintHeadlessConsoleOpenGrantEnvelope({
        ...common,
        policyDecision: { verdict: "deny", matchedRules: ["DENY"] },
      }),
    ).toThrow("cannot mint a headless console grant from a deny policy decision");
    expect(() =>
      mintHeadlessConsoleOpenGrantEnvelope({
        ...common,
        policyDecision: { verdict: "modify", matchedRules: ["MODIFY"], modifiedArgs: {} },
      }),
    ).toThrow("cannot mint a headless console grant from a modify policy decision");
  });

  it("threads custom provenance/tool ids and review text while refusing untrusted workspace material", () => {
    const profile = createQemuConsoleTargetProfile({
      targetId: "qemu-startup",
      qemuBinary: "/usr/bin/qemu-system-x86_64",
      cwd: "/workspace",
      diskImages: [{ path: "/workspace/alpine.iso", access: "read-only", role: "cdrom" }],
    });
    const untrustedProvenance = { inputTags: ["untrusted" as const] };
    const policyInput = buildConsoleOpenGrantPolicyInput({
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      workspaceRoot: "/workspace",
      profile,
      rows: 30,
      cols: 100,
      workspaceTrusted: false,
      provenanceContext: untrustedProvenance,
      toolCallId: "custom-console-open",
    });
    expect(policyInput.workspace.trusted).toBe(false);
    expect(policyInput.provenance.inputTags).toEqual(["untrusted"]);

    const common = {
      source: "parent-reviewed-benchmark-env" as const,
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      workspaceRoot: "/workspace",
      profile,
      rows: 30,
      cols: 100,
      policyPack: { name: "phase2a-starter-policy-pack", hash: `sha256:${"4".repeat(64)}` },
      policyDecision: { verdict: "allow" as const, matchedRules: [] },
      sandboxPlan: buildConsoleSandboxPlanForTarget(profile, { workspaceRoot: "/workspace" }),
      principal: {
        osUser: "alice",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
      reviewedAt: "2026-07-10T18:00:00.000Z",
      expiresAt: "2026-07-10T19:00:00.000Z",
      provenanceContext: untrustedProvenance,
      toolCallId: "custom-console-open",
    };

    const envelope = mintHeadlessConsoleOpenGrantEnvelope({
      ...common,
      reviewText: "reviewed qemu-startup console open",
    });
    expect(envelope.reviewText).toBe("reviewed qemu-startup console open");

    expect(() =>
      mintHeadlessConsoleOpenGrantEnvelope({
        ...common,
        workspaceTrusted: false,
      }),
    ).toThrow("headless console grants require trusted workspace policy material");
  });
});
