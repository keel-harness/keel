import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { JsonObject, canonicalize } from "@keel/shared";
import { isInside } from "../path-util.js";
import { buildDefaultSandboxProfile } from "../sandbox-profile.js";
import type { SandboxInvocation, SandboxProfile } from "../sandbox.js";
import type { ConsolePolicyTargetProfile } from "./policy.js";

type ConsoleFilesystemScope = NonNullable<ConsolePolicyTargetProfile["filesystemScopes"]>[number];

export interface ConsoleSandboxProfileOptions {
  readonly workspaceRoot: string;
  readonly declaredTempRoots?: readonly string[];
  readonly auditDir?: string;
  readonly policyDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export class ConsoleSandboxProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsoleSandboxProfileError";
  }
}

function declaredTempRootsFor(
  profile: ConsolePolicyTargetProfile,
  options: ConsoleSandboxProfileOptions,
): readonly string[] {
  return options.declaredTempRoots ?? profile.declaredTempRoots ?? [];
}

function normalizedTempRoots(
  profile: ConsolePolicyTargetProfile,
  options: ConsoleSandboxProfileOptions,
): readonly string[] {
  return declaredTempRootsFor(profile, options).map((root) => resolve(root));
}

function consoleFilesystemScopes(profile: ConsolePolicyTargetProfile): Set<ConsoleFilesystemScope> {
  const scopes = new Set<ConsoleFilesystemScope>(
    profile.filesystemScopes ?? (["workspace", "temp"] as const),
  );
  for (const scope of scopes) {
    if (scope !== "workspace" && scope !== "temp") {
      throw new ConsoleSandboxProfileError(
        "console sandbox profile only supports workspace/temp filesystem scopes",
      );
    }
  }
  return scopes;
}

function assertContainedCwd(
  profile: ConsolePolicyTargetProfile,
  options: ConsoleSandboxProfileOptions,
  scopes: ReadonlySet<ConsoleFilesystemScope>,
): void {
  if (!isAbsolute(profile.cwd)) {
    throw new ConsoleSandboxProfileError("console target cwd must be absolute");
  }
  const cwd = resolve(profile.cwd);
  const workspaceRoot = resolve(options.workspaceRoot);
  const tempRoots = normalizedTempRoots(profile, options);
  const inWorkspace = scopes.has("workspace") && isInside(workspaceRoot, cwd);
  const inTemp = scopes.has("temp") && tempRoots.some((root) => isInside(root, cwd));
  if (!inWorkspace && !inTemp) {
    throw new ConsoleSandboxProfileError(
      "console target cwd must be inside workspace or declared temp roots",
    );
  }
}

function assertContainedVmDiskImages(
  profile: ConsolePolicyTargetProfile,
  options: ConsoleSandboxProfileOptions,
  scopes: ReadonlySet<ConsoleFilesystemScope>,
): void {
  const workspaceRoot = resolve(options.workspaceRoot);
  const tempRoots = normalizedTempRoots(profile, options);
  for (const disk of profile.vm?.diskImages ?? []) {
    if (!isAbsolute(disk.path)) {
      throw new ConsoleSandboxProfileError("QEMU VM disk image path must be absolute");
    }
    const diskPath = resolve(disk.path);
    const inWorkspace = scopes.has("workspace") && isInside(workspaceRoot, diskPath);
    const inTemp = scopes.has("temp") && tempRoots.some((root) => isInside(root, diskPath));
    if (!inWorkspace && !inTemp) {
      throw new ConsoleSandboxProfileError(
        `QEMU VM disk image ${disk.path} must be inside workspace or declared temp roots`,
      );
    }
  }
}

function allowedRootMatches(
  root: string,
  profile: ConsolePolicyTargetProfile,
  options: ConsoleSandboxProfileOptions,
  scopes: ReadonlySet<ConsoleFilesystemScope>,
): boolean {
  const normalizedRoot = resolve(root);
  if (scopes.has("workspace") && normalizedRoot === resolve(options.workspaceRoot)) return true;
  if (scopes.has("temp") && normalizedTempRoots(profile, options).includes(normalizedRoot)) {
    return true;
  }
  return false;
}

function restrictAllowedRoots(
  roots: readonly string[] | undefined,
  profile: ConsolePolicyTargetProfile,
  options: ConsoleSandboxProfileOptions,
  scopes: ReadonlySet<ConsoleFilesystemScope>,
): readonly string[] {
  return (roots ?? []).filter((root) => allowedRootMatches(root, profile, options, scopes));
}

export function buildConsoleSandboxProfile(
  profile: ConsolePolicyTargetProfile,
  options: ConsoleSandboxProfileOptions,
): SandboxProfile {
  const scopes = consoleFilesystemScopes(profile);
  assertContainedCwd(profile, options, scopes);
  assertContainedVmDiskImages(profile, options, scopes);

  try {
    const sandboxProfile = buildDefaultSandboxProfile({
      workspaceRoot: options.workspaceRoot,
      declaredTempRoots: declaredTempRootsFor(profile, options),
      allowedEgressDomains: profile.egressDomains ?? [],
      ...(options.auditDir === undefined ? {} : { auditDir: options.auditDir }),
      ...(options.policyDir === undefined ? {} : { policyDir: options.policyDir }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    return {
      ...sandboxProfile,
      filesystem: {
        ...sandboxProfile.filesystem,
        allowRead: restrictAllowedRoots(
          sandboxProfile.filesystem?.allowRead,
          profile,
          options,
          scopes,
        ),
        allowWrite: restrictAllowedRoots(
          sandboxProfile.filesystem?.allowWrite,
          profile,
          options,
          scopes,
        ),
      },
    };
  } catch (error) {
    if (error instanceof ConsoleSandboxProfileError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ConsoleSandboxProfileError(`invalid console sandbox profile: ${message}`);
  }
}

export interface ConsoleSandboxPlan {
  readonly invocation: SandboxInvocation;
  readonly profile: SandboxProfile;
}

export function buildConsoleSandboxPlanForTarget(
  profile: ConsolePolicyTargetProfile,
  options: ConsoleSandboxProfileOptions,
): ConsoleSandboxPlan {
  return {
    invocation: {
      command: profile.command,
      ...(profile.argv === undefined ? {} : { argv: profile.argv }),
      cwd: profile.cwd,
    },
    profile: buildConsoleSandboxProfile(profile, options),
  };
}

export function consoleSandboxPlanDigest(plan: ConsoleSandboxPlan): `sha256:${string}` {
  const payload = JsonObject.parse({
    invocation: plan.invocation,
    profile: plan.profile,
  });
  return `sha256:${createHash("sha256").update(canonicalize(payload)).digest("hex")}`;
}
