import {
  buildSandboxProfileFromCapabilityManifest,
  capabilityManifestWithEgressDomains,
  InvalidSandboxProfileError,
  resolveWardenKeelHome,
  type SandboxProfileProjectionOptions,
} from "./capability-manifest.js";
import type { SandboxProfile } from "./sandbox.js";

export { InvalidSandboxProfileError, resolveWardenKeelHome };

export interface DefaultSandboxProfileOptions extends Omit<
  SandboxProfileProjectionOptions,
  "toolName"
> {
  readonly allowedEgressDomains?: readonly string[];
}

export function buildDefaultSandboxProfile(options: DefaultSandboxProfileOptions): SandboxProfile {
  return buildSandboxProfileFromCapabilityManifest(
    capabilityManifestWithEgressDomains(options.allowedEgressDomains ?? []),
    {
      toolName: "bash",
      workspaceRoot: options.workspaceRoot,
      ...(options.declaredTempRoots === undefined
        ? {}
        : { declaredTempRoots: options.declaredTempRoots }),
      ...(options.auditDir === undefined ? {} : { auditDir: options.auditDir }),
      ...(options.policyDir === undefined ? {} : { policyDir: options.policyDir }),
      ...(options.env === undefined ? {} : { env: options.env }),
    },
  );
}
