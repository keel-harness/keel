import { resolve } from "node:path";
import {
  credentialProxyProtectedFilePaths,
  type CredentialProxyRule,
} from "../credential-proxy.js";
import type { SandboxProfile } from "../sandbox.js";
import { buildDefaultSandboxProfile } from "../sandbox-profile.js";

export function buildMcpSandboxProfile(options: {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly auditDir?: string;
  readonly credentialProxyRules?: readonly CredentialProxyRule[];
  readonly declaredTempRoots?: readonly string[];
}): SandboxProfile {
  const env = options.env ?? process.env;
  const profile = buildDefaultSandboxProfile({
    workspaceRoot: options.workspaceRoot,
    env,
    allowedEgressDomains: [],
    ...(options.auditDir === undefined ? {} : { auditDir: options.auditDir }),
    ...(options.declaredTempRoots === undefined
      ? {}
      : { declaredTempRoots: options.declaredTempRoots }),
  });
  const protectedFiles = credentialProxyProtectedFilePaths(options.credentialProxyRules ?? [], {
    workspaceRoot: options.workspaceRoot,
    env,
  });
  const projectKeelDir = resolve(options.workspaceRoot, ".keel");
  const filesystem = profile.filesystem as NonNullable<SandboxProfile["filesystem"]>;
  const denyRead = filesystem.denyRead as readonly string[];
  const denyWrite = filesystem.denyWrite as readonly string[];
  return {
    ...profile,
    filesystem: {
      ...filesystem,
      denyRead: [...new Set([...denyRead, projectKeelDir, ...protectedFiles])],
      denyWrite: [...new Set([...denyWrite, projectKeelDir])],
    },
  };
}
