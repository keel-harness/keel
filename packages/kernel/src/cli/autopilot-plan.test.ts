import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveTrustDecision } from "../trust/trust-store.js";
import {
  interpretPlanApprovalConfirmationAnswer,
  renderRunPlanApprovalConfirmation,
  runAutopilotPlanCommand,
  runAutopilotPlanCommandResult,
} from "./autopilot-plan.js";

const KEY_A = `sha256:${"a".repeat(64)}` as const;

function hasUnsafeTerminalControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined || code === 0x0a) continue;
    if (
      code <= 0x1f ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    ) {
      return true;
    }
  }
  return false;
}

describe("autopilot plan preview CLI", () => {
  it("renders a trusted exact-resource plan preview without granting authority", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-plan-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-plan-ws-"));
    const env = { KEEL_HOME: keelHome };

    try {
      saveTrustDecision(workspaceRoot, "trusted", env);

      const output = runAutopilotPlanCommand({
        cwd: workspaceRoot,
        env,
        args: [
          "preview",
          "--plan-id",
          "auth-fix",
          "--step",
          "inspect auth/session.ts",
          "--step",
          "run pnpm test auth",
          "--domain",
          "Example.COM",
          "--command-key",
          KEY_A,
        ],
      });

      expect(output).toContain(`Plan Autopilot preview for ${realpathSync(workspaceRoot)}`);
      expect(output).toContain("plan: auth-fix");
      expect(output).toContain("workspace trust: trusted");
      expect(output).toContain(
        "status: preview only; grants nothing until a live run resolves reviews",
      );
      expect(output).toContain("plan steps:");
      expect(output).toContain("  1. inspect auth/session.ts");
      expect(output).toContain("  2. run pnpm test auth");
      expect(output).toContain("accepted exact resources: 2");
      expect(output).toContain("egress domains:\n  - example.com");
      expect(output).toContain(`command envelopes:\n  - ${KEY_A}`);
      expect(output).toContain("rejected resources: 0");
      expect(output).toContain(
        "This preview grants nothing. A live Plan Autopilot run still resolves every matching review through the warden and stops when the boundary expands.",
      );
      expect(output).not.toMatch(/skip prompts|yolo|already active/i);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("keeps an untrusted workspace preview inert even for valid resources", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-plan-untrusted-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-plan-untrusted-ws-"));
    const env = { KEEL_HOME: keelHome };

    try {
      const output = runAutopilotPlanCommand({
        cwd: workspaceRoot,
        env,
        args: ["preview", "--plan-id=untrusted", "--domain=example.com", "--command-key", KEY_A],
      });

      expect(output).toContain("workspace trust: untrusted");
      expect(output).toContain("accepted exact resources: 0");
      expect(output).toContain("rejected resources: 2");
      expect(output).toContain("  - domain example.com (workspace not trusted)");
      expect(output).toContain(`  - command-key ${KEY_A} (workspace not trusted)`);
      expect(output).toContain(
        "source: plan preview; no session ledger or project grant was written",
      );
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rejects malformed plan resources fail-closed and strips control text", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-plan-bad-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-plan-bad-ws-"));
    const env = { KEEL_HOME: keelHome };

    try {
      saveTrustDecision(workspaceRoot, "trusted", env);

      const output = runAutopilotPlanCommand({
        cwd: workspaceRoot,
        env,
        args: [
          "preview",
          "--plan-id",
          "\u001b[31mship\nnow",
          "--step",
          "\u001b[2Jwrite tests\nforge row",
          "--domain",
          "*.example.com",
          "--domain",
          "example.com/path",
          "--command-key",
          "sha256:not-a-key",
          "--domain",
          "api.example.com",
        ],
      });

      expect(output).toContain("plan: ship now");
      expect(output).toContain("  1. write tests forge row");
      expect(output).toContain("accepted exact resources: 1");
      expect(output).toContain("  - api.example.com");
      expect(output).toContain("rejected resources: 3");
      expect(output).toContain("  - domain *.example.com (invalid exact domain)");
      expect(output).toContain("  - domain example.com/path (invalid exact domain)");
      expect(output).toContain("  - command-key sha256:not-a-key (invalid command key)");
      expect(output).not.toContain("\u001b");
      expect(output).not.toContain("\nforge row");
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("renders hostile workspace and preview fields on terminal-safe rows", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-autopilot-plan-hostile-"));
    const parent = mkdtempSync(join(tmpdir(), "keel-autopilot-plan-hostile-ws-"));
    const hostileName = `repo\nforged-row\u001b]8;;evil.example\u0007osc\u009b31m\u2028line\u2029para`;
    const workspaceRoot = join(parent, hostileName);
    const env = { KEEL_HOME: keelHome };

    try {
      mkdirSync(workspaceRoot);
      saveTrustDecision(workspaceRoot, "trusted", env);

      const output = runAutopilotPlanCommand({
        cwd: workspaceRoot,
        env,
        args: [
          "preview",
          "--plan-id",
          "ship\u009b31m\nnow\u2028fast",
          "--step",
          "run tests\u001b]8;;evil.example\u0007\nfake status",
          "--domain",
          "example.com",
        ],
      });

      expect(output).toContain("plan: ship31m now fast");
      expect(output).toContain("  1. run tests]8;;evil.example fake status");
      expect(output).not.toContain("\nforged-row");
      expect(output).not.toContain("\nfake status");
      expect(hasUnsafeTerminalControl(output)).toBe(false);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("fails closed on ambiguous preview flags", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "keel-autopilot-plan-usage-ws-"));
    const env = { KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-autopilot-plan-usage-")) };

    try {
      for (const args of [
        ["preview"],
        ["preview", "--domain"],
        ["preview", "--command-key"],
        ["preview", "--step"],
        ["preview", "--plan-id"],
        ["preview", "--unknown", "x"],
        ["preview", "--domain=example.com", "--command-key"],
      ]) {
        expect(
          runAutopilotPlanCommand({
            cwd: workspaceRoot,
            env,
            args,
          }),
          args.join(" "),
        ).toContain("usage: keel autopilot plan preview");
      }
    } finally {
      rmSync(env.KEEL_HOME, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("returns a non-ok result for usage so the bin can exit nonzero", () => {
    const result = runAutopilotPlanCommandResult({
      cwd: "/tmp/missing",
      args: ["preview", "--unknown"],
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("usage: keel autopilot plan preview");
  });

  it("renders the run confirmation pause as a bounded exact-resource approval", () => {
    const output = renderRunPlanApprovalConfirmation({
      workspace: "/repo\u001b[31m\nfake",
      planId: "auth\u001b[2J\nfix",
      prompt: "fix login\u001b[31m\nfake task row",
      resources: [
        { kind: "domain", value: "Example.COM" },
        { kind: "command-key", value: KEY_A },
      ],
    });

    expect(output).toContain("Plan Autopilot approval for /repo fake");
    expect(output).toContain("plan: auth fix");
    expect(output).toContain("task: fix login fake task row");
    expect(output).not.toContain("workspace trust:");
    expect(output).toContain("exact resources requested for this run:");
    expect(output).toContain("egress domains:\n  - Example.COM");
    expect(output).toContain(`command envelopes:\n  - ${KEY_A}`);
    expect(output).toContain(
      "Typing approve submits only the exact resources above to the Plan Autopilot runtime for this run. Workspace trust, policy, sandbox, egress, and audit gates still decide whether they become active; the warden stops on deny, egress outside this envelope, generic reviews, or sandbox failure.",
    );
    expect(output).toContain('Type "approve" to continue.');
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\nfake");
    expect(output).not.toContain("\nfake task row");
  });

  it("requires an explicit approve answer for plan execution", () => {
    expect(interpretPlanApprovalConfirmationAnswer("approve")).toBe(true);
    expect(interpretPlanApprovalConfirmationAnswer(" approve \n")).toBe(true);
    expect(interpretPlanApprovalConfirmationAnswer("yes")).toBe(false);
    expect(interpretPlanApprovalConfirmationAnswer("approved")).toBe(false);
    expect(interpretPlanApprovalConfirmationAnswer("")).toBe(false);
  });
});
