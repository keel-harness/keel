import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_MANIFEST_VERSION,
  type CapabilityManifestT,
  type SandboxReadDenyTokenT,
} from "@keel/shared";
import { InvalidEgressConfigError } from "./egress-profile.js";
import {
  DEFAULT_CAPABILITY_MANIFEST,
  InvalidCapabilityManifestError,
  buildSandboxProfileFromCapabilityManifest,
  capabilityManifestWithEgressDomains,
} from "./capability-manifest.js";

const baseOptions = {
  toolName: "bash",
  workspaceRoot: "/repo",
  declaredTempRoots: ["/tmp/keel-task"],
  env: { HOME: "/home/alice", XDG_CONFIG_HOME: "/xdg" },
} as const;
const defaultBashTool = DEFAULT_CAPABILITY_MANIFEST.tools[0]!;

describe("warden capability manifest projection", () => {
  it("generates the current default bash sandbox profile from the manifest source of truth", () => {
    const profile = buildSandboxProfileFromCapabilityManifest(
      DEFAULT_CAPABILITY_MANIFEST,
      baseOptions,
    );

    expect(profile).toEqual({
      filesystem: {
        allowRead: ["/repo", "/tmp/keel-task"],
        allowWrite: ["/repo", "/tmp/keel-task"],
        denyRead: [
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
          join("/repo", ".env"),
          join("/repo", ".env.local"),
          join("/repo", ".env.development"),
          join("/repo", ".env.production"),
          join("/repo", ".env.test"),
        ],
        denyWrite: [
          "/xdg/keel/audit",
          "/xdg/keel/policy",
          "/xdg/keel",
          "/repo/.env",
          "/repo/.env.local",
          "/repo/.env.development",
          "/repo/.env.production",
          "/repo/.env.test",
        ],
      },
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
        strictAllowlist: true,
      },
    });
  });

  // QC-2026-07-10 §1 (must-fix): the sandbox read-deny set must cover the credential stores a
  // coding harness touches most, in lockstep with the policy classifier's secret namespace, so a
  // sandboxed read of these files is denied even though the whole root is ro-bound readable.
  it("denies reading common developer credential stores (lockstep with the policy secret namespace)", () => {
    const denyRead = buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
      ...baseOptions,
    }).filesystem?.denyRead;
    for (const path of [
      "/home/alice/.git-credentials",
      "/home/alice/.docker",
      "/home/alice/.dockercfg",
      "/home/alice/.kube",
      "/home/alice/.config/gh",
      "/home/alice/.config/gcloud",
      "/home/alice/.pypirc",
    ]) {
      expect(denyRead).toContain(path);
    }
  });

  // QC-2026-07-10 §4 (should-fix): secret confidentiality was guarded (denyRead) but secret
  // INTEGRITY was not — `printf x > .env` was allowed by the sandbox because denyWrite covered only
  // keel-owned paths, and `.env` is inside the workspace allow-write root. denyWrite must cover the
  // workspace dotenv files. (Home secret roots need no write-deny: they are outside allowWrite.)
  it("denies WRITES to workspace dotenv files (secret integrity), and home secrets stay unwritable via the allow-list", () => {
    const profile = buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
      ...baseOptions,
    }).filesystem;
    for (const path of [
      "/repo/.env",
      "/repo/.env.local",
      "/repo/.env.development",
      "/repo/.env.production",
      "/repo/.env.test",
    ]) {
      expect(profile?.denyWrite).toContain(path);
    }
    // Home credential stores are not in the workspace/temp allow-write roots, so they are already
    // unwritable without an explicit deny-write token.
    expect(profile?.allowWrite).toEqual(["/repo", "/tmp/keel-task"]);
    expect(profile?.allowWrite).not.toContain("/home/alice/.ssh");
  });

  it("keeps egress authority as manifest data and validates it through the existing egress profile", () => {
    const manifest = capabilityManifestWithEgressDomains([
      "Example.COM",
      "*.GitHub.com",
      "example.com",
    ]);

    expect(buildSandboxProfileFromCapabilityManifest(manifest, baseOptions).network).toEqual({
      allowedDomains: ["example.com", "*.github.com"],
      deniedDomains: [],
      strictAllowlist: true,
    });

    expect(() => capabilityManifestWithEgressDomains(["127.0.0.1"])).not.toThrow();
    expect(() =>
      buildSandboxProfileFromCapabilityManifest(
        capabilityManifestWithEgressDomains(["127.0.0.1"]),
        baseOptions,
      ),
    ).toThrow(InvalidEgressConfigError);
  });

  it("declares default typed file tools with least-privilege filesystem envelopes", () => {
    expect(DEFAULT_CAPABILITY_MANIFEST.tools.map((tool) => tool.toolName)).toEqual([
      "bash",
      "read",
      "search",
      "write",
      "edit",
    ]);

    expect(
      DEFAULT_CAPABILITY_MANIFEST.tools.find((tool) => tool.toolName === "search")
        ?.staticCapability,
    ).toMatchObject({ effectEnvelope: ["fs_read"], broad: false });
    expect(
      DEFAULT_CAPABILITY_MANIFEST.tools.find((tool) => tool.toolName === "write")?.staticCapability,
    ).toMatchObject({ effectEnvelope: ["fs_write"], broad: false });
    expect(
      DEFAULT_CAPABILITY_MANIFEST.tools.find((tool) => tool.toolName === "edit")?.staticCapability,
    ).toMatchObject({ effectEnvelope: ["fs_read", "fs_write"], broad: false });

    expect(
      buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
        ...baseOptions,
        toolName: "search",
      }).filesystem?.allowWrite,
    ).toEqual([]);
    expect(
      buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
        ...baseOptions,
        toolName: "write",
      }).filesystem?.allowWrite,
    ).toEqual(["/repo", "/tmp/keel-task"]);
    expect(
      buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
        ...baseOptions,
        toolName: "edit",
      }).filesystem?.allowRead,
    ).toEqual(["/repo", "/tmp/keel-task"]);
  });

  it("fails closed when the manifest has no matching tool or omits required sandbox tokens", () => {
    expect(() =>
      buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
        ...baseOptions,
        toolName: "unknown-tool",
      }),
    ).toThrow(InvalidCapabilityManifestError);

    const manifest = {
      ...DEFAULT_CAPABILITY_MANIFEST,
      tools: [
        {
          ...defaultBashTool,
          sandbox: {
            ...defaultBashTool.sandbox,
            filesystem: {
              ...defaultBashTool.sandbox.filesystem,
              denyRead: ["keel_config"] satisfies readonly SandboxReadDenyTokenT[],
            },
          },
        },
      ],
    } satisfies CapabilityManifestT;

    expect(() => buildSandboxProfileFromCapabilityManifest(manifest, baseOptions)).toThrow(
      /missing required denyRead token/i,
    );
  });

  it("rejects a malformed manifest before any profile is produced", () => {
    expect(() =>
      buildSandboxProfileFromCapabilityManifest(
        {
          manifestVersion: CAPABILITY_MANIFEST_VERSION,
          tools: [
            {
              ...defaultBashTool,
              staticCapability: {
                ...defaultBashTool.staticCapability,
                toolName: "other",
              },
            },
          ],
        },
        baseOptions,
      ),
    ).toThrow(InvalidCapabilityManifestError);
  });
});
