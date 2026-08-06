import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import {
  CAPABILITY_MANIFEST_VERSION,
  CapabilityManifest,
  type CapabilityManifestT,
  type CapabilityManifestToolT,
  type SandboxReadAllowTokenT,
  type SandboxReadDenyTokenT,
  type SandboxWriteAllowTokenT,
  type SandboxWriteDenyTokenT,
  keelHome as resolveKeelHome,
} from "@keel/shared";
import { buildEgressNetworkProfile } from "./egress-profile.js";
import {
  packageManagerExecutionMetadataPaths,
  vcsExecutionMetadataPaths,
} from "./execution-metadata.js";
import type { SandboxProfile } from "./sandbox.js";

const BASH_EFFECT_ENVELOPE = [
  "fs_read",
  "fs_write",
  "network_read",
  "network_write",
  "process_exec",
] as const;
const READ_EFFECT_ENVELOPE = ["fs_read"] as const;
const SEARCH_EFFECT_ENVELOPE = ["fs_read"] as const;
const WRITE_EFFECT_ENVELOPE = ["fs_write"] as const;
const EDIT_EFFECT_ENVELOPE = ["fs_read", "fs_write"] as const;

const DEFAULT_BASH_POLICY_RULES = ["phase2a.bash.default"] as const;
const DEFAULT_READ_POLICY_RULES = ["phase2a.read.default"] as const;
const DEFAULT_SEARCH_POLICY_RULES = ["phase2a.search.default"] as const;
const DEFAULT_WRITE_POLICY_RULES = ["phase2a.write.default"] as const;
const DEFAULT_EDIT_POLICY_RULES = ["phase2a.edit.default"] as const;

const DEFAULT_DENY_READ = [
  "home_secret_roots",
  "keel_config",
  "keel_audit",
  "keel_policy",
  "workspace_dotenv_files",
] as const;
const DEFAULT_DENY_WRITE = [
  "keel_audit",
  "keel_policy",
  "keel_config",
  "workspace_dotenv_files",
  "workspace_keel_project_config",
] as const;
const BASH_DENY_WRITE = [
  ...DEFAULT_DENY_WRITE,
  "workspace_package_manager_execution_metadata",
  "workspace_vcs_execution_metadata",
] as const;

export const DEFAULT_CAPABILITY_MANIFEST: CapabilityManifestT = CapabilityManifest.parse({
  manifestVersion: CAPABILITY_MANIFEST_VERSION,
  tools: [
    {
      toolName: "bash",
      staticCapability: {
        toolName: "bash",
        effectEnvelope: [...BASH_EFFECT_ENVELOPE],
        broad: true,
      },
      sandbox: {
        filesystem: {
          allowRead: ["workspace", "declared_temp"],
          allowWrite: ["workspace", "declared_temp"],
          denyRead: [...DEFAULT_DENY_READ],
          denyWrite: [...BASH_DENY_WRITE],
        },
        network: { allowedDomains: [] },
      },
      policyRules: [...DEFAULT_BASH_POLICY_RULES],
    },
    {
      toolName: "process.run",
      staticCapability: {
        toolName: "process.run",
        effectEnvelope: [...BASH_EFFECT_ENVELOPE],
        broad: true,
      },
      sandbox: {
        filesystem: {
          allowRead: ["workspace", "declared_temp"],
          allowWrite: ["workspace", "declared_temp"],
          denyRead: [...DEFAULT_DENY_READ],
          denyWrite: [...BASH_DENY_WRITE],
        },
        network: { allowedDomains: [] },
      },
      policyRules: [...DEFAULT_BASH_POLICY_RULES],
    },
    {
      toolName: "read",
      staticCapability: {
        toolName: "read",
        effectEnvelope: [...READ_EFFECT_ENVELOPE],
        broad: false,
      },
      sandbox: {
        filesystem: {
          allowRead: ["workspace", "declared_temp"],
          allowWrite: [],
          denyRead: [...DEFAULT_DENY_READ],
          denyWrite: [...DEFAULT_DENY_WRITE],
        },
        network: { allowedDomains: [] },
      },
      policyRules: [...DEFAULT_READ_POLICY_RULES],
    },
    {
      toolName: "search",
      staticCapability: {
        toolName: "search",
        effectEnvelope: [...SEARCH_EFFECT_ENVELOPE],
        broad: false,
      },
      sandbox: {
        filesystem: {
          allowRead: ["workspace", "declared_temp"],
          allowWrite: [],
          denyRead: [...DEFAULT_DENY_READ],
          denyWrite: [...DEFAULT_DENY_WRITE],
        },
        network: { allowedDomains: [] },
      },
      policyRules: [...DEFAULT_SEARCH_POLICY_RULES],
    },
    {
      toolName: "write",
      staticCapability: {
        toolName: "write",
        effectEnvelope: [...WRITE_EFFECT_ENVELOPE],
        broad: false,
      },
      sandbox: {
        filesystem: {
          allowRead: ["workspace", "declared_temp"],
          allowWrite: ["workspace", "declared_temp"],
          denyRead: [...DEFAULT_DENY_READ],
          denyWrite: [...DEFAULT_DENY_WRITE],
        },
        network: { allowedDomains: [] },
      },
      policyRules: [...DEFAULT_WRITE_POLICY_RULES],
    },
    {
      toolName: "edit",
      staticCapability: {
        toolName: "edit",
        effectEnvelope: [...EDIT_EFFECT_ENVELOPE],
        broad: false,
      },
      sandbox: {
        filesystem: {
          allowRead: ["workspace", "declared_temp"],
          allowWrite: ["workspace", "declared_temp"],
          denyRead: [...DEFAULT_DENY_READ],
          denyWrite: [...DEFAULT_DENY_WRITE],
        },
        network: { allowedDomains: [] },
      },
      policyRules: [...DEFAULT_EDIT_POLICY_RULES],
    },
  ],
});

export interface SandboxProfileProjectionOptions {
  readonly toolName: string;
  readonly workspaceRoot: string;
  readonly declaredTempRoots?: readonly string[];
  readonly auditDir?: string;
  readonly policyDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export class InvalidSandboxProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSandboxProfileError";
  }
}

export class InvalidCapabilityManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCapabilityManifestError";
  }
}

function normalizePath(path: string): string {
  return resolve(path);
}

function uniqueNormalized(paths: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = normalizePath(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function homeRootFromEnv(env: NodeJS.ProcessEnv): string {
  const home = env["HOME"];
  return home === undefined || home === "" ? homedir() : home;
}

function isFilesystemRoot(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === parse(normalized).root;
}

function assertSafeWorkspaceRoot(workspaceRoot: string, homeRoot: string): void {
  if (isFilesystemRoot(workspaceRoot)) {
    throw new InvalidSandboxProfileError("workspace root must not be the filesystem root");
  }
  if (workspaceRoot === homeRoot) {
    throw new InvalidSandboxProfileError("workspace root must not be the user home directory");
  }
}

// Delegates to the canonical, cross-process resolution (P1-11). The warden's config denyRead dir and
// (via bin.ts) audit dir fallback must match where the kernel keeps state.
export function resolveWardenKeelHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolveKeelHome(env);
}

function parseManifest(manifest: CapabilityManifestT): CapabilityManifestT {
  const parsed = CapabilityManifest.safeParse(manifest);
  if (!parsed.success) {
    throw new InvalidCapabilityManifestError(
      `capability manifest failed schema validation: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

function findTool(manifest: CapabilityManifestT, toolName: string): CapabilityManifestToolT {
  const tool = manifest.tools.find((entry) => entry.toolName === toolName);
  if (tool === undefined) {
    throw new InvalidCapabilityManifestError(
      `capability manifest has no entry for tool: ${toolName}`,
    );
  }
  return tool;
}

function assertRequiredTokens<T extends string>(
  label: string,
  actual: readonly T[],
  required: readonly T[],
): void {
  const actualSet = new Set(actual);
  for (const token of required) {
    if (!actualSet.has(token)) {
      throw new InvalidCapabilityManifestError(`missing required ${label} token: ${token}`);
    }
  }
}

function assertDefaultBroadProcessConformance(tool: CapabilityManifestToolT): void {
  if (tool.toolName !== "bash" && tool.toolName !== "process.run") return;
  const label = tool.toolName;
  const effectEnvelope = new Set(tool.staticCapability.effectEnvelope);
  for (const effect of BASH_EFFECT_ENVELOPE) {
    if (!effectEnvelope.has(effect)) {
      throw new InvalidCapabilityManifestError(
        `${label} static capability missing effect: ${effect}`,
      );
    }
  }
  if (!tool.staticCapability.broad) {
    throw new InvalidCapabilityManifestError(`${label} static capability must be broad`);
  }
  assertRequiredTokens("allowRead", tool.sandbox.filesystem.allowRead, [
    "workspace",
    "declared_temp",
  ]);
  assertRequiredTokens("allowWrite", tool.sandbox.filesystem.allowWrite, [
    "workspace",
    "declared_temp",
  ]);
  assertRequiredTokens("denyRead", tool.sandbox.filesystem.denyRead, [
    "home_secret_roots",
    "keel_config",
    "keel_audit",
    "keel_policy",
    "workspace_dotenv_files",
  ]);
  assertRequiredTokens("denyWrite", tool.sandbox.filesystem.denyWrite, [
    "keel_audit",
    "keel_policy",
    "keel_config",
    "workspace_dotenv_files",
    "workspace_package_manager_execution_metadata",
    "workspace_vcs_execution_metadata",
    // Workspace-integrity floor: bash must deny writes to the project-config directory, so no
    // conformant manifest can ship a governed bash tool able to plant `.keel/credential-proxy.json`.
    "workspace_keel_project_config",
  ]);
}

interface ProjectionContext {
  readonly workspaceRoot: string;
  readonly declaredTempRoots: readonly string[];
  readonly homeRoot: string;
  readonly keelConfigDir: string;
  readonly auditDir: string;
  readonly policyDir: string;
}

function expandReadAllowToken(token: SandboxReadAllowTokenT, ctx: ProjectionContext) {
  switch (token) {
    case "workspace":
      return [ctx.workspaceRoot];
    case "declared_temp":
      return ctx.declaredTempRoots;
  }
}

function expandWriteAllowToken(token: SandboxWriteAllowTokenT, ctx: ProjectionContext) {
  switch (token) {
    case "workspace":
      return [ctx.workspaceRoot];
    case "declared_temp":
      return ctx.declaredTempRoots;
  }
}

// Kept in lockstep with `secretPath()` in policy.ts (QC §1): the whole root is ro-bound readable
// in the sandbox, so every credential store must be an explicit deny. Shared by deny-read and (QC
// §4) deny-write so a secret file's confidentiality AND integrity are both protected.
function homeSecretRoots(ctx: ProjectionContext): string[] {
  return [
    join(ctx.homeRoot, ".ssh"),
    join(ctx.homeRoot, ".aws"),
    join(ctx.homeRoot, ".gnupg"),
    join(ctx.homeRoot, ".netrc"),
    join(ctx.homeRoot, ".npmrc"),
    join(ctx.homeRoot, ".git-credentials"),
    join(ctx.homeRoot, ".pypirc"),
    join(ctx.homeRoot, ".dockercfg"),
    join(ctx.homeRoot, ".docker"),
    join(ctx.homeRoot, ".kube"),
    join(ctx.homeRoot, ".config", "gh"),
    join(ctx.homeRoot, ".config", "gcloud"),
  ];
}

function workspaceDotenvFiles(ctx: ProjectionContext): string[] {
  return [
    join(ctx.workspaceRoot, ".env"),
    join(ctx.workspaceRoot, ".env.local"),
    join(ctx.workspaceRoot, ".env.development"),
    join(ctx.workspaceRoot, ".env.production"),
    join(ctx.workspaceRoot, ".env.test"),
  ];
}

function expandReadDenyToken(token: SandboxReadDenyTokenT, ctx: ProjectionContext) {
  switch (token) {
    case "home_secret_roots":
      return homeSecretRoots(ctx);
    case "keel_config":
      return [ctx.keelConfigDir];
    case "keel_audit":
      return [ctx.auditDir];
    case "keel_policy":
      return [ctx.policyDir];
    case "workspace_dotenv_files":
      return workspaceDotenvFiles(ctx);
  }
}

function expandWriteDenyToken(token: SandboxWriteDenyTokenT, ctx: ProjectionContext) {
  switch (token) {
    case "keel_audit":
      return [ctx.auditDir];
    case "keel_policy":
      return [ctx.policyDir];
    case "keel_config":
      return [ctx.keelConfigDir];
    case "workspace_dotenv_files":
      return workspaceDotenvFiles(ctx);
    case "workspace_package_manager_execution_metadata":
      return packageManagerExecutionMetadataPaths(ctx.workspaceRoot);
    case "workspace_vcs_execution_metadata":
      return vcsExecutionMetadataPaths(ctx.workspaceRoot);
    case "workspace_keel_project_config":
      return [resolve(ctx.workspaceRoot, ".keel")];
  }
}

function projectTokens<T extends string>(
  tokens: readonly T[],
  expand: (token: T) => readonly string[],
): string[] {
  return tokens.flatMap((token) => [...expand(token)]);
}

export function capabilityManifestWithEgressDomains(
  allowedDomains: readonly string[],
): CapabilityManifestT {
  return CapabilityManifest.parse({
    ...DEFAULT_CAPABILITY_MANIFEST,
    tools: DEFAULT_CAPABILITY_MANIFEST.tools.map((tool) =>
      tool.toolName === "bash" || tool.toolName === "process.run"
        ? {
            ...tool,
            sandbox: {
              ...tool.sandbox,
              network: { allowedDomains: [...allowedDomains] },
            },
          }
        : tool,
    ),
  });
}

export function buildSandboxProfileFromCapabilityManifest(
  manifest: CapabilityManifestT,
  options: SandboxProfileProjectionOptions,
): SandboxProfile {
  const parsed = parseManifest(manifest);
  const tool = findTool(parsed, options.toolName);
  assertDefaultBroadProcessConformance(tool);

  const env = options.env ?? process.env;
  const workspaceRoot = normalizePath(options.workspaceRoot);
  const declaredTempRoots = uniqueNormalized(options.declaredTempRoots ?? []);
  const homeRoot = normalizePath(homeRootFromEnv(env));
  assertSafeWorkspaceRoot(workspaceRoot, homeRoot);
  const keelConfigDir = normalizePath(resolveWardenKeelHome(env));
  const auditDir = normalizePath(options.auditDir ?? join(keelConfigDir, "audit"));
  const policyDir = normalizePath(options.policyDir ?? join(keelConfigDir, "policy"));
  const ctx: ProjectionContext = {
    workspaceRoot,
    declaredTempRoots,
    homeRoot,
    keelConfigDir,
    auditDir,
    policyDir,
  };

  return {
    filesystem: {
      allowRead: uniqueNormalized(
        projectTokens(tool.sandbox.filesystem.allowRead, (token) =>
          expandReadAllowToken(token, ctx),
        ),
      ),
      allowWrite: uniqueNormalized(
        projectTokens(tool.sandbox.filesystem.allowWrite, (token) =>
          expandWriteAllowToken(token, ctx),
        ),
      ),
      denyRead: uniqueNormalized(
        projectTokens(tool.sandbox.filesystem.denyRead, (token) => expandReadDenyToken(token, ctx)),
      ),
      denyWrite: uniqueNormalized(
        projectTokens(tool.sandbox.filesystem.denyWrite, (token) =>
          expandWriteDenyToken(token, ctx),
        ),
      ),
    },
    network: buildEgressNetworkProfile({
      allowedDomains: tool.sandbox.network.allowedDomains,
    }),
  };
}
