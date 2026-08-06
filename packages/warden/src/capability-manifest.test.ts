import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
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
  InvalidSandboxProfileError,
  buildSandboxProfileFromCapabilityManifest,
  capabilityManifestWithEgressDomains,
} from "./capability-manifest.js";

const baseOptions = {
  toolName: "bash",
  workspaceRoot: "/repo",
  declaredTempRoots: ["/tmp/keel-task"],
  env: { HOME: "/home/alice", XDG_CONFIG_HOME: "/xdg" },
  realpath: (path: string) => path,
} as const;
const defaultBashTool = DEFAULT_CAPABILITY_MANIFEST.tools[0]!;

describe("warden capability manifest projection", () => {
  it("rejects a workspace that aliases the user home through a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-capability-home-alias-"));
    try {
      const home = join(root, "home");
      const workspaceAlias = join(root, "workspace-link");
      mkdirSync(home);
      symlinkSync(home, workspaceAlias);

      expect(() =>
        buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
          ...baseOptions,
          workspaceRoot: workspaceAlias,
          env: { ...baseOptions.env, HOME: home },
          realpath: realpathSync,
        }),
      ).toThrow(InvalidSandboxProfileError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies both HOME spellings when workspace or declared-temp writes overlap an aliased home", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-capability-home-overlap-"));
    try {
      const home = join(root, "home");
      const homeAlias = join(root, "home-link");
      const workspace = join(root, "workspace");
      mkdirSync(home);
      mkdirSync(workspace);
      symlinkSync(home, homeAlias);

      for (const options of [
        { workspaceRoot: root, declaredTempRoots: [join(root, "temp")] },
        { workspaceRoot: workspace, declaredTempRoots: [homeAlias] },
      ]) {
        const filesystem = buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
          ...baseOptions,
          ...options,
          env: { ...baseOptions.env, HOME: homeAlias },
          realpath: realpathSync,
        }).filesystem;
        for (const credentialRoot of [join(homeAlias, ".ssh"), join(realpathSync(home), ".ssh")]) {
          expect(filesystem?.denyRead).toContain(credentialRoot);
          expect(filesystem?.denyWrite).toContain(credentialRoot);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["case", "/USERS", "/Users/alice"],
    ["Unicode normalization", "/users/confé", "/users/confé/alice"],
  ])(
    "denies HOME writes across %s aliases after one-time canonicalization",
    (_name, workspace, home) => {
      const filesystem = buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
        ...baseOptions,
        workspaceRoot: workspace,
        env: { ...baseOptions.env, HOME: home },
      }).filesystem;

      expect(filesystem?.denyWrite).toContain(join(home, ".ssh"));
    },
  );

  it("denies lexical and canonical credential-child spellings when credential roots are symlinks", () => {
    const root = mkdtempSync(join(realpathSync("/tmp"), "keel-capability-secret-alias-"));
    try {
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      mkdirSync(join(home, ".config"), { recursive: true });
      mkdirSync(workspace);
      symlinkSync(workspace, join(home, ".ssh"));
      symlinkSync(workspace, join(home, ".config", "gh"));

      const filesystem = buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
        ...baseOptions,
        workspaceRoot: workspace,
        env: { ...baseOptions.env, HOME: home },
        realpath: realpathSync,
      }).filesystem;
      for (const credentialRoot of [join(home, ".ssh"), join(home, ".config", "gh"), workspace]) {
        expect(filesystem?.denyRead).toContain(credentialRoot);
        expect(filesystem?.denyWrite).toContain(credentialRoot);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
          "/repo/.keel",
          "/repo/package.json",
          "/repo/pnpm-lock.yaml",
          "/repo/package-lock.json",
          "/repo/yarn.lock",
          "/repo/bun.lock",
          "/repo/bun.lockb",
          "/repo/.npmrc",
          "/repo/.pnpmfile.cjs",
          "/repo/pnpm-workspace.yaml",
          "/repo/.yarnrc",
          "/repo/.yarnrc.yml",
          "/repo/bunfig.toml",
          "/repo/.git/config",
          "/repo/.git/config.worktree",
          "/repo/.git/hooks",
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

  // SECURITY: the workspace .keel/ directory holds project config the warden trusts post-trust
  // (credential-proxy.json, lifecycle.yaml, mcp.json). A governed tool that can write there can grant
  // itself authority — the credential-proxy RCE. No governed tool may write <workspace>/.keel.
  it("denies every governed tool from writing the workspace .keel project-config directory", () => {
    for (const toolName of ["bash", "process.run", "write", "edit", "read", "search"] as const) {
      const profile = buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
        ...baseOptions,
        toolName,
      }).filesystem;
      expect(profile?.denyWrite).toContain("/repo/.keel");
    }
  });

  it("denies broad process tools from writing package-manager and VCS execution metadata", () => {
    for (const toolName of ["bash", "process.run"] as const) {
      const filesystem = buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
        ...baseOptions,
        toolName,
      }).filesystem;

      expect(filesystem?.denyWrite).toEqual(
        expect.arrayContaining([
          "/repo/package.json",
          "/repo/pnpm-lock.yaml",
          "/repo/package-lock.json",
          "/repo/yarn.lock",
          "/repo/bun.lock",
          "/repo/bun.lockb",
          "/repo/.npmrc",
          "/repo/.pnpmfile.cjs",
          "/repo/pnpm-workspace.yaml",
          "/repo/.git/config",
          "/repo/.git/hooks",
        ]),
      );
    }
  });

  it("keeps typed package-manifest edits available while the Warden tracks their session impact", () => {
    const filesystem = buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
      ...baseOptions,
      toolName: "write",
    }).filesystem;

    expect(filesystem?.allowWrite).toContain("/repo");
    expect(filesystem?.denyWrite).not.toContain("/repo/package.json");
    expect(filesystem?.denyWrite).not.toContain("/repo/.git/config");
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
    expect(
      buildSandboxProfileFromCapabilityManifest(manifest, {
        ...baseOptions,
        toolName: "process.run",
      }).network,
    ).toEqual({
      allowedDomains: ["example.com", "*.github.com"],
      deniedDomains: [],
      strictAllowlist: true,
    });

    for (const domain of ["localhost", "api.localhost", "*.localhost", "127.0.0.1"]) {
      expect(() => capabilityManifestWithEgressDomains([domain]), domain).not.toThrow();
      expect(
        () =>
          buildSandboxProfileFromCapabilityManifest(
            capabilityManifestWithEgressDomains([domain]),
            baseOptions,
          ),
        domain,
      ).toThrow(InvalidEgressConfigError);
    }
  });

  it("declares default typed file tools with least-privilege filesystem envelopes", () => {
    expect(DEFAULT_CAPABILITY_MANIFEST.tools.map((tool) => tool.toolName)).toEqual([
      "bash",
      "process.run",
      "read",
      "search",
      "write",
      "edit",
    ]);

    expect(
      DEFAULT_CAPABILITY_MANIFEST.tools.find((tool) => tool.toolName === "process.run")
        ?.staticCapability,
    ).toMatchObject({
      toolName: "process.run",
      effectEnvelope: ["fs_read", "fs_write", "network_read", "network_write", "process_exec"],
      broad: true,
    });

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
