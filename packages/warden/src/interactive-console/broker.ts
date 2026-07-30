import type { JsonObjectT } from "@keel/shared";
import type { ConsoleLifecycleState } from "./lifecycle.js";
import type { ConsoleOperation } from "./schema.js";
import type { ConsolePolicyTargetProfile } from "./policy.js";
import type { ConsoleScreenFrameT } from "./result.js";
import type { ConsoleSandboxPlan } from "./sandbox.js";

export interface ConsoleHandleRecord {
  readonly handle: string;
  readonly targetId: string;
  readonly targetDigest: string;
  readonly sessionId: string;
  readonly profile: ConsolePolicyTargetProfile;
  readonly openedAt: string;
  readonly processIdentity: JsonObjectT;
  readonly continuationGrant?: ConsoleHandleContinuationGrant;
  readonly lifecycle: ConsoleLifecycleState;
  nextSeq: number;
}

export interface ConsoleHandleContinuationGrant {
  readonly key: `sha256:${string}`;
  readonly targetId: string;
  readonly targetDigest: string;
  readonly kind?: string;
  readonly source?: string;
  readonly envelopeHash?: string;
}

export interface ConsoleBrokerOpenRequest {
  readonly handle: string;
  readonly operation: Extract<ConsoleOperation, { readonly kind: "open" }>;
  readonly profile: ConsolePolicyTargetProfile;
  readonly sandbox: ConsoleSandboxPlan;
  readonly signal?: AbortSignal;
}

export interface ConsoleBrokerOpenResult {
  readonly processIdentity: JsonObjectT;
}

export interface ConsoleBrokerHandleRequest<T extends ConsoleOperation> {
  readonly handle: ConsoleHandleRecord;
  readonly operation: T;
  readonly profile: ConsolePolicyTargetProfile;
  readonly signal?: AbortSignal;
}

export interface ConsoleBrokerProcessIdentityCheckResult {
  readonly live: boolean;
  readonly observedProcessIdentity: JsonObjectT;
}

export interface ConsoleBrokerSendKeysResult {
  readonly acceptedTokens: number;
}

export interface ConsoleBrokerCloseResult {
  readonly closed: boolean;
}

export interface ConsoleBrokerReleaseResult {
  readonly released: boolean;
}

export interface ConsoleBrokerStatus {
  readonly available: boolean;
  readonly backend: string;
  readonly reason?: string;
  readonly fixCommand?: string;
}

export interface ConsoleBrokerPort {
  status?(): ConsoleBrokerStatus;
  prepareSandboxPlan?(plan: ConsoleSandboxPlan): ConsoleSandboxPlan;
  open(request: ConsoleBrokerOpenRequest): Promise<ConsoleBrokerOpenResult>;
  checkProcessIdentity(
    request: ConsoleBrokerHandleRequest<Exclude<ConsoleOperation, { readonly kind: "open" }>>,
  ): Promise<ConsoleBrokerProcessIdentityCheckResult>;
  sendKeys(
    request: ConsoleBrokerHandleRequest<Extract<ConsoleOperation, { readonly kind: "send_keys" }>>,
  ): Promise<ConsoleBrokerSendKeysResult>;
  readScreen(
    request: ConsoleBrokerHandleRequest<
      Extract<ConsoleOperation, { readonly kind: "read_screen" }>
    >,
  ): Promise<ConsoleScreenFrameT>;
  release(
    request: ConsoleBrokerHandleRequest<Extract<ConsoleOperation, { readonly kind: "release" }>>,
  ): Promise<ConsoleBrokerReleaseResult>;
  close(
    request: ConsoleBrokerHandleRequest<Extract<ConsoleOperation, { readonly kind: "close" }>>,
  ): Promise<ConsoleBrokerCloseResult>;
  dispose?(): Promise<void> | void;
}
