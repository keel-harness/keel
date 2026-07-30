import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidEgressConfigError } from "./egress-profile.js";
import {
  buildDefaultSandboxProfile,
  InvalidSandboxProfileError,
  resolveWardenKeelHome,
} from "./sandbox-profile.js";

describe("default warden sandbox profile", () => {
  it("mirrors the existing keelHome resolution order for config-deny roots", () => {
    expect(resolveWardenKeelHome({ KEEL_HOME: "/keel-home", HOME: "/home/alice" })).toBe(
      "/keel-home",
    );
    expect(resolveWardenKeelHome({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/alice" })).toBe(
      "/xdg/keel",
    );
    expect(resolveWardenKeelHome({ HOME: "/home/alice" })).toBe("/home/alice/.config/keel");
    expect(resolveWardenKeelHome({ KEEL_HOME: "", XDG_CONFIG_HOME: "", HOME: "/home/alice" })).toBe(
      "/home/alice/.config/keel",
    );
    expect(resolveWardenKeelHome({})).toBe(join(homedir(), ".config", "keel"));
  });

  it("treats an empty HOME as absent instead of resolving secret denies under the cwd", () => {
    const profile = buildDefaultSandboxProfile({
      workspaceRoot: "/repo",
      env: { HOME: "", KEEL_HOME: "/keel-home" },
    });

    expect(profile.filesystem?.denyRead).toEqual(
      expect.arrayContaining([join(homedir(), ".ssh"), join(homedir(), ".aws")]),
    );
    expect(profile.filesystem?.denyRead).not.toContain(resolve(".ssh"));
  });

  it("allows workspace and declared temp writes while denying secrets and keel-owned paths", () => {
    const workspace = resolve("/repo");
    const tempRoot = resolve("/tmp/keel-task");
    const profile = buildDefaultSandboxProfile({
      workspaceRoot: workspace,
      declaredTempRoots: [tempRoot],
      env: { HOME: "/home/alice", XDG_CONFIG_HOME: "/xdg" },
    });

    expect(profile.filesystem?.allowRead).toEqual([workspace, tempRoot]);
    expect(profile.filesystem?.allowWrite).toEqual([workspace, tempRoot]);
    expect(profile.filesystem?.denyRead).toEqual([
      "/home/alice/.ssh",
      "/home/alice/.aws",
      "/home/alice/.gnupg",
      "/home/alice/.netrc",
      "/home/alice/.npmrc",
      "/home/alice/.git-credentials",
      "/home/alice/.pypirc",
      "/home/alice/.dockercfg",
      "/home/alice/.docker",
      "/home/alice/.kube",
      "/home/alice/.config/gh",
      "/home/alice/.config/gcloud",
      "/xdg/keel",
      "/xdg/keel/audit",
      "/xdg/keel/policy",
      join(workspace, ".env"),
      join(workspace, ".env.local"),
      join(workspace, ".env.development"),
      join(workspace, ".env.production"),
      join(workspace, ".env.test"),
    ]);
    expect(profile.filesystem?.denyWrite).toEqual([
      "/xdg/keel/audit",
      "/xdg/keel/policy",
      "/xdg/keel",
      "/repo/.env",
      "/repo/.env.local",
      "/repo/.env.development",
      "/repo/.env.production",
      "/repo/.env.test",
    ]);
    expect(profile.network).toEqual({
      allowedDomains: [],
      deniedDomains: ["*"],
      strictAllowlist: true,
    });
  });

  it("uses explicit audit and policy roots without binding the profile globally", () => {
    const profile = buildDefaultSandboxProfile({
      workspaceRoot: "/repo",
      auditDir: "/var/keel-audit",
      policyDir: "/var/keel-policy",
      env: { KEEL_HOME: "/keel-home", HOME: "/home/alice" },
    });

    expect(profile.filesystem?.denyRead).toEqual(
      expect.arrayContaining(["/keel-home", "/var/keel-audit", "/var/keel-policy"]),
    );
    expect(profile.filesystem?.denyWrite).toEqual([
      "/var/keel-audit",
      "/var/keel-policy",
      "/keel-home",
      "/repo/.env",
      "/repo/.env.local",
      "/repo/.env.development",
      "/repo/.env.production",
      "/repo/.env.test",
    ]);
  });

  it("deduplicates and normalizes profile roots", () => {
    const profile = buildDefaultSandboxProfile({
      workspaceRoot: "/repo/../repo",
      declaredTempRoots: ["/tmp/a", "/tmp/a/../a"],
      auditDir: "/keel/audit",
      policyDir: "/keel/audit",
      env: { KEEL_HOME: "/keel", HOME: "/home/alice" },
    });

    expect(profile.filesystem?.allowRead).toEqual(["/repo", "/tmp/a"]);
    expect(profile.filesystem?.allowWrite).toEqual(["/repo", "/tmp/a"]);
    expect(profile.filesystem?.denyRead?.filter((path) => path === "/keel/audit")).toHaveLength(1);
    expect(profile.filesystem?.denyWrite).toEqual([
      "/keel/audit",
      "/keel",
      "/repo/.env",
      "/repo/.env.local",
      "/repo/.env.development",
      "/repo/.env.production",
      "/repo/.env.test",
    ]);
  });

  it("defaults optional inputs without widening filesystem access", () => {
    const profile = buildDefaultSandboxProfile({
      workspaceRoot: "/repo",
      env: { KEEL_HOME: "/keel-home" },
    });

    expect(profile.filesystem?.allowRead).toEqual(["/repo"]);
    expect(profile.filesystem?.allowWrite).toEqual(["/repo"]);
    expect(profile.filesystem?.denyRead).toEqual(
      expect.arrayContaining([
        join(homedir(), ".ssh"),
        "/keel-home",
        "/keel-home/audit",
        "/keel-home/policy",
      ]),
    );
    expect(profile.filesystem?.denyWrite).toEqual([
      "/keel-home/audit",
      "/keel-home/policy",
      "/keel-home",
      "/repo/.env",
      "/repo/.env.local",
      "/repo/.env.development",
      "/repo/.env.production",
      "/repo/.env.test",
    ]);
  });

  it("can build from the process environment default for the production server path", () => {
    const profile = buildDefaultSandboxProfile({ workspaceRoot: "/repo" });
    const keelHome = resolve(resolveWardenKeelHome(process.env));

    expect(profile.filesystem?.allowRead).toEqual(["/repo"]);
    expect(profile.filesystem?.allowWrite).toEqual(["/repo"]);
    expect(profile.filesystem?.denyWrite).toEqual([
      join(keelHome, "audit"),
      join(keelHome, "policy"),
      keelHome,
      "/repo/.env",
      "/repo/.env.local",
      "/repo/.env.development",
      "/repo/.env.production",
      "/repo/.env.test",
    ]);
  });

  it("adds explicit egress domains without ambient presets or environment authority", () => {
    const profile = buildDefaultSandboxProfile({
      workspaceRoot: "/repo",
      allowedEgressDomains: ["Example.COM", "*.GitHub.com", "example.com"],
      env: {
        KEEL_HOME: "/keel-home",
        HOME: "/home/alice",
        KEEL_WARDEN_EGRESS_ALLOW_DOMAINS: "npmjs.org",
        KEEL_WARDEN_EGRESS_PRESETS: "npm",
      },
    });

    expect(profile.network).toEqual({
      allowedDomains: ["example.com", "*.github.com"],
      deniedDomains: [],
      strictAllowlist: true,
    });
  });

  it("rejects malformed explicit egress domains fail-closed", () => {
    for (const domain of [
      "*",
      "exa*mple.com",
      "*.com",
      "bad_domain.com",
      "-bad.example.com",
      "bad-.example.com",
      "example..com",
      "127.0.0.1",
      "127.1",
      "2130706433",
      "[::1]",
      "",
    ]) {
      expect(() =>
        buildDefaultSandboxProfile({
          workspaceRoot: "/repo",
          allowedEgressDomains: [domain],
          env: { KEEL_HOME: "/keel-home", HOME: "/home/alice" },
        }),
      ).toThrow(InvalidEgressConfigError);
    }
  });

  it("rejects dangerous workspace roots before constructing write authority", () => {
    expect(() =>
      buildDefaultSandboxProfile({
        workspaceRoot: "/",
        env: { KEEL_HOME: "/keel-home", HOME: "/home/alice" },
      }),
    ).toThrow(InvalidSandboxProfileError);

    expect(() =>
      buildDefaultSandboxProfile({
        workspaceRoot: "/home/alice",
        env: { KEEL_HOME: "/keel-home", HOME: "/home/alice" },
      }),
    ).toThrow(InvalidSandboxProfileError);
  });
});
