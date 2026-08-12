export interface SandboxStatus {
  available: boolean;
  backend: string;
  enforcementTier: string;
  reason?: string;
  fixCommand?: string;
  /** Process-local implementation facts. These are not projected into frozen `warden.status`. */
  features?: readonly string[];
}

export const EGRESS_ADDRESS_GUARD_CAPABILITY = "egress-address-guard/v1";
/** Process-local proof that the vendored SRT was initialized with verified HTTPS termination. */
export const CREDENTIAL_TLS_TERMINATION_CAPABILITY = "credential-tls-termination/v1";
/** Process-local proof that each governed launch owns immutable, revocable proxy authority. */
export const SRT_LAUNCH_AUTHORITY_CAPABILITY = "srt-launch-authority/v1";

export interface SandboxProfile {
  readonly filesystem?: {
    readonly allowRead?: readonly string[];
    readonly allowWrite?: readonly string[];
    readonly denyRead?: readonly string[];
    readonly denyWrite?: readonly string[];
  };
  readonly network?: {
    readonly allowedDomains?: readonly string[];
    readonly deniedDomains?: readonly string[];
    readonly strictAllowlist?: boolean;
  };
}

export interface SandboxInvocation {
  readonly command: string;
  readonly argv?: readonly string[];
  readonly cwd?: string;
}

export interface SandboxSpawnDescriptor {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface SandboxAuthorizationHeaderCredential {
  readonly host: string;
  readonly scheme: string;
  readonly secret: string;
}

export interface SandboxAuthorizationPlaceholderCredential {
  readonly host: string;
  readonly scheme: string;
  readonly placeholder: string;
  readonly secret: string;
}

export interface SandboxCredentialProxyConfig {
  readonly authorizationHeaders?: readonly SandboxAuthorizationHeaderCredential[];
  readonly authorizationPlaceholders?: readonly SandboxAuthorizationPlaceholderCredential[];
  readonly sandboxEnv?: Readonly<Record<string, string>>;
  readonly allowPlaintextInject?: boolean;
}

export interface SandboxProcessRunnerOptions {
  readonly signal?: AbortSignal;
  /** Revoke launch-local network authority before terminal process/group signaling begins. */
  readonly beforeProcessGroupSettlement?: () => void | Promise<void>;
  /** Called only after the runner has positively established process/group absence. */
  readonly onProcessGroupSettled?: () => void | Promise<void>;
}

export interface SandboxExecuteOptions extends SandboxProcessRunnerOptions {
  readonly credentialProxy?: SandboxCredentialProxyConfig;
}

export interface SandboxExecutionResult {
  readonly exitCode: number | null;
  readonly signal?: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxProcessRunner {
  run(
    descriptor: SandboxSpawnDescriptor,
    options?: SandboxProcessRunnerOptions,
  ): Promise<SandboxExecutionResult>;
}

export interface SandboxPort {
  status(): SandboxStatus;
  execute(
    invocation: SandboxInvocation,
    profile: SandboxProfile,
    options?: SandboxExecuteOptions,
  ): Promise<SandboxExecutionResult>;
}

export const missingSandboxStatus: SandboxStatus = {
  available: false,
  backend: "none",
  enforcementTier: "none",
  reason: "no sandbox backend configured",
};

export const missingSandboxPort: SandboxPort = {
  status: () => missingSandboxStatus,
  execute: async () => {
    throw new Error(missingSandboxStatus.reason);
  },
};

export function readSandboxStatus(sandbox: SandboxPort): SandboxStatus {
  try {
    return sandbox.status();
  } catch {
    return {
      available: false,
      backend: "unknown",
      enforcementTier: "none",
      reason: "sandbox status probe failed",
    };
  }
}
