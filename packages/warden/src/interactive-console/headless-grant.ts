import {
  JsonObject,
  WARDEN_METHODS,
  type JsonObjectT,
  type PolicyInputT,
  type PolicyPackRefT,
  type ProvenanceContextT,
  type SessionIdT,
} from "@keel/shared";
import type { PolicyDecision } from "../policy.js";
import type { ConsolePolicyTargetProfile } from "./policy.js";
import { buildConsoleOpaquePolicyInput } from "./policy.js";
import {
  consoleGrantEffectEnvelope,
  consoleGrantTargetProfileSummary,
  consoleReviewGrantKey,
  consoleTargetGrantReviewDecision,
  createHeadlessConsoleGrantEnvelope,
  HEADLESS_CONSOLE_GRANT_VERSION,
  type HeadlessConsoleGrantEnvelopeT,
  type HeadlessConsoleGrantEnvelopePayloadT,
} from "./grants.js";
import type { ConsoleSandboxPlan } from "./sandbox.js";
import { consoleSandboxPlanDigest } from "./sandbox.js";
import { CONSOLE_TOOL_NAMES, type ConsoleOperation } from "./schema.js";

type ConsoleGrantSource = HeadlessConsoleGrantEnvelopePayloadT["source"];
type OpenConsoleOperation = Extract<ConsoleOperation, { readonly kind: "open" }>;

export interface ConsoleOpenGrantPolicyInputOptions {
  readonly sessionId: SessionIdT;
  readonly workspaceRoot: string;
  readonly profile: ConsolePolicyTargetProfile;
  readonly rows: number;
  readonly cols: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly workspaceTrusted?: boolean;
  readonly provenanceContext?: ProvenanceContextT;
  readonly toolCallId?: string;
}

export interface HeadlessConsoleOpenGrantOptions extends ConsoleOpenGrantPolicyInputOptions {
  readonly source: ConsoleGrantSource;
  readonly policyPack: PolicyPackRefT;
  readonly policyDecision: PolicyDecision;
  readonly sandboxPlan: ConsoleSandboxPlan;
  readonly principal: JsonObjectT;
  readonly reviewedAt: string;
  readonly expiresAt: string;
  readonly reviewText?: string;
}

function consoleOpenGrantOperation(options: {
  readonly profile: ConsolePolicyTargetProfile;
  readonly rows: number;
  readonly cols: number;
}): OpenConsoleOperation {
  return {
    kind: "open",
    toolName: CONSOLE_TOOL_NAMES.open,
    args: {
      targetId: options.profile.targetId,
      rows: options.rows,
      cols: options.cols,
    },
  };
}

function consoleOpenGrantExecuteParams(options: ConsoleOpenGrantPolicyInputOptions) {
  const operation = consoleOpenGrantOperation(options);
  return WARDEN_METHODS["warden.execute"].params.parse({
    sessionId: options.sessionId,
    toolCall: {
      id: options.toolCallId ?? "console-open-grant",
      name: CONSOLE_TOOL_NAMES.open,
      args: operation.args,
    },
    provenanceContext: options.provenanceContext ?? { inputTags: ["workspace"] },
  });
}

export function buildConsoleOpenGrantPolicyInput(
  options: ConsoleOpenGrantPolicyInputOptions,
): PolicyInputT {
  const operation = consoleOpenGrantOperation(options);
  const params = consoleOpenGrantExecuteParams(options);
  return buildConsoleOpaquePolicyInput(params, operation, options.profile, {
    workspaceRoot: options.workspaceRoot,
    ...(options.env === undefined ? {} : { env: options.env }),
    workspaceTrusted: options.workspaceTrusted ?? true,
  });
}

function assertGrantablePolicyDecision(decision: PolicyDecision): void {
  if (decision.verdict === "deny") {
    throw new Error("cannot mint a headless console grant from a deny policy decision");
  }
  if (decision.verdict === "modify") {
    throw new Error("cannot mint a headless console grant from a modify policy decision");
  }
}

export function mintHeadlessConsoleOpenGrantEnvelope(
  options: HeadlessConsoleOpenGrantOptions,
): HeadlessConsoleGrantEnvelopeT {
  if (options.workspaceTrusted === false) {
    throw new Error("headless console grants require trusted workspace policy material");
  }
  assertGrantablePolicyDecision(options.policyDecision);
  const operation = consoleOpenGrantOperation(options);
  const policyInput = buildConsoleOpenGrantPolicyInput({
    sessionId: options.sessionId,
    workspaceRoot: options.workspaceRoot,
    profile: options.profile,
    rows: options.rows,
    cols: options.cols,
    ...(options.env === undefined ? {} : { env: options.env }),
    workspaceTrusted: options.workspaceTrusted ?? true,
    ...(options.provenanceContext === undefined
      ? {}
      : { provenanceContext: options.provenanceContext }),
    ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
  });
  const grantDecision = consoleTargetGrantReviewDecision(
    options.policyDecision,
    options.profile.targetId,
  );
  const sandboxPlanDigest = consoleSandboxPlanDigest(options.sandboxPlan);
  const grantKey = consoleReviewGrantKey(
    {
      workspaceRoot: options.workspaceRoot,
      policyPack: options.policyPack,
      sandboxPlanDigest,
    },
    operation,
    options.profile,
    policyInput,
    grantDecision,
  );
  return createHeadlessConsoleGrantEnvelope({
    version: HEADLESS_CONSOLE_GRANT_VERSION,
    source: options.source,
    sessionId: options.sessionId,
    workspaceRoot: options.workspaceRoot,
    target: {
      targetId: options.profile.targetId,
      targetDigest: options.profile.targetDigest,
      sandboxProfileId: options.profile.sandboxProfileId,
    },
    operation: { kind: "open", rows: options.rows, cols: options.cols },
    targetProfile: consoleGrantTargetProfileSummary(options.profile),
    policyPack: options.policyPack,
    sandboxPlanDigest,
    effectEnvelope: consoleGrantEffectEnvelope(policyInput),
    matchedRules: [...grantDecision.matchedRules],
    grantKey,
    principal: JsonObject.parse(options.principal),
    reviewedAt: options.reviewedAt,
    expiresAt: options.expiresAt,
    maxUses: 1,
    reviewText:
      options.reviewText ?? `console target ${options.profile.targetId} requires approval`,
  });
}
