import { createHash } from "node:crypto";
import { z } from "zod";
import {
  IsoTimestamp,
  JsonObject,
  SessionId,
  Sha256,
  canonicalize,
  type JsonObjectT,
  type PolicyInputT,
  type WARDEN_METHODS,
} from "@keel/shared";
import type { PolicyDecision } from "../policy.js";
import type { ConsoleHandleRecord } from "./broker.js";
import { effectiveConsoleLifecycleLimits } from "./lifecycle.js";
import { ConsoleTargetId, OpenConsoleArgs, type ConsoleOperation } from "./schema.js";
import type { ConsolePolicyTargetProfile } from "./policy.js";

type ExecuteParams = ReturnType<(typeof WARDEN_METHODS)["warden.execute"]["params"]["parse"]>;

export const CONSOLE_TARGET_GRANT_REQUIRED_RULE = "CONSOLE-TARGET-GRANT-REQUIRED";
export const CONSOLE_SESSION_GRANT_RULE = "CONSOLE-GRANT-SESSION";
export const CONSOLE_HEADLESS_GRANT_RULE = "CONSOLE-HEADLESS-GRANT";
export const CONSOLE_OPENED_HANDLE_GRANT_RULE = "CONSOLE-GRANT-OPENED-HANDLE";
export const CONSOLE_HEADLESS_GRANT_MISMATCH_RULE = "CONSOLE-HEADLESS-GRANT-MISMATCH";
export const HEADLESS_CONSOLE_GRANT_VERSION = "keel-headless-console-grant/v1";

const HeadlessConsoleGrantTarget = z
  .object({
    targetId: ConsoleTargetId,
    targetDigest: Sha256,
    sandboxProfileId: z.string().min(1),
  })
  .strict();

const HeadlessConsoleOpenOperation = z
  .object({
    kind: z.literal("open"),
    rows: OpenConsoleArgs.shape.rows,
    cols: OpenConsoleArgs.shape.cols,
  })
  .strict();

const ConsolePolicyPack = z.object({ name: z.string().min(1), hash: Sha256 }).strict();

export const HeadlessConsoleGrantEnvelopePayload = z
  .object({
    version: z.literal(HEADLESS_CONSOLE_GRANT_VERSION),
    source: z.enum(["local-console-grant-file", "parent-reviewed-benchmark-env"]),
    sessionId: SessionId,
    workspaceRoot: z.string().min(1),
    target: HeadlessConsoleGrantTarget,
    operation: HeadlessConsoleOpenOperation,
    targetProfile: JsonObject,
    policyPack: ConsolePolicyPack,
    sandboxPlanDigest: Sha256,
    effectEnvelope: JsonObject,
    matchedRules: z.array(z.string()),
    grantKey: Sha256,
    principal: JsonObject,
    reviewedAt: IsoTimestamp,
    expiresAt: IsoTimestamp,
    maxUses: z.literal(1),
    reviewText: z.string().min(1).max(8192),
  })
  .strict();

export type HeadlessConsoleGrantEnvelopePayloadT = z.infer<
  typeof HeadlessConsoleGrantEnvelopePayload
>;

export const HeadlessConsoleGrantEnvelope = HeadlessConsoleGrantEnvelopePayload.extend({
  envelopeHash: Sha256,
}).strict();

export type HeadlessConsoleGrantEnvelopeT = z.infer<typeof HeadlessConsoleGrantEnvelope>;

export interface HeadlessConsoleGrantRecord {
  readonly envelope: HeadlessConsoleGrantEnvelopeT;
  readonly loadedAt: string;
}

export interface ConsoleReviewGrantContext {
  readonly workspaceRoot: string;
  readonly policyPack: {
    readonly name: string;
    readonly hash: string;
  };
  readonly sandboxPlanDigest: `sha256:${string}`;
}

export interface PendingConsoleReview {
  readonly kind: "console";
  readonly reviewId: string;
  readonly targetId: string;
  readonly targetDigest: string;
  readonly executeParams: ExecuteParams;
  readonly grantKey: `sha256:${string}`;
  readonly summary: string;
  readonly allowCommand: string;
}

export interface ConsoleSessionGrant {
  readonly key: `sha256:${string}`;
  readonly targetId: string;
  readonly targetDigest: string;
  readonly sessionId: string;
  readonly principal: JsonObjectT;
  readonly createdAt: string;
}

export interface ConsoleRuntimeState {
  readonly pendingReviews: Map<string, PendingConsoleReview>;
  readonly sessionGrants: Map<string, ConsoleSessionGrant>;
  readonly headlessGrants: Map<string, HeadlessConsoleGrantRecord>;
  readonly loadedHeadlessGrantEnvelopeHashes: Set<string>;
  readonly handles: Map<string, ConsoleHandleRecord>;
  nextReviewSeq: number;
}

export function createConsoleRuntimeState(): ConsoleRuntimeState {
  return {
    pendingReviews: new Map(),
    sessionGrants: new Map(),
    headlessGrants: new Map(),
    loadedHeadlessGrantEnvelopeHashes: new Set(),
    handles: new Map(),
    nextReviewSeq: 1,
  };
}

function sha256Json(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function sha256CanonicalJson(value: JsonObjectT): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

export function headlessConsoleGrantEnvelopeHash(
  payload: HeadlessConsoleGrantEnvelopePayloadT,
): `sha256:${string}` {
  return sha256CanonicalJson(JsonObject.parse(payload));
}

export function createHeadlessConsoleGrantEnvelope(
  payload: HeadlessConsoleGrantEnvelopePayloadT,
): HeadlessConsoleGrantEnvelopeT {
  const parsed = HeadlessConsoleGrantEnvelopePayload.parse(payload);
  return {
    ...parsed,
    envelopeHash: headlessConsoleGrantEnvelopeHash(parsed),
  };
}

export function parseHeadlessConsoleGrantEnvelope(value: unknown): HeadlessConsoleGrantEnvelopeT {
  const envelope = HeadlessConsoleGrantEnvelope.parse(value);
  const { envelopeHash: expectedHash, ...payload } = envelope;
  const actualHash = headlessConsoleGrantEnvelopeHash(payload);
  if (actualHash !== expectedHash) {
    throw new Error("headless console grant envelope hash mismatch");
  }
  return envelope;
}

export function installHeadlessConsoleGrants(
  state: ConsoleRuntimeState,
  grants: readonly HeadlessConsoleGrantEnvelopeT[],
  now: () => string = () => new Date().toISOString(),
): void {
  for (const grant of grants) {
    const envelope = parseHeadlessConsoleGrantEnvelope(grant);
    if (state.loadedHeadlessGrantEnvelopeHashes.has(envelope.envelopeHash)) continue;
    const index = consoleGrantIndexKey(envelope.sessionId, envelope.target.targetId);
    const existing = state.headlessGrants.get(index);
    if (existing !== undefined && existing.envelope.envelopeHash !== envelope.envelopeHash) {
      throw new Error(
        `duplicate headless console grant for session ${envelope.sessionId} target ${envelope.target.targetId}`,
      );
    }
    state.headlessGrants.set(index, { envelope, loadedAt: now() });
    state.loadedHeadlessGrantEnvelopeHashes.add(envelope.envelopeHash);
  }
}

function stableStringArray(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function stableEgressDomains(values: readonly string[] | undefined): string[] {
  return stableStringArray((values ?? []).map((domain) => domain.trim().toLowerCase()));
}

function argvDigest(values: readonly string[] | undefined): JsonObjectT | null {
  if (values === undefined) return null;
  return {
    count: values.length,
    digest: sha256Json([...values]),
  };
}

function stableTargets(policyInput: PolicyInputT): JsonObjectT[] {
  const targets: JsonObjectT[] = policyInput.sideEffect.dynamic.targets.map((target) => ({
    kind: target.kind,
    value: target.value,
    normalized: target.normalized ?? null,
    withinWorkspace: target.withinWorkspace ?? null,
    sensitivity: target.sensitivity ?? null,
  }));
  return targets.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function oneLineConsoleText(value: string): string {
  let withoutControls = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    withoutControls += code !== undefined && (code <= 0x1f || code === 0x7f) ? " " : char;
  }
  const clean = withoutControls.replace(/\s+/gu, " ").trim();
  return clean.length <= 160 ? clean : `${clean.slice(0, 157)}...`;
}

export function consoleGrantIndexKey(sessionId: string, targetId: string): string {
  return `${sessionId}\u0000${targetId}`;
}

export function consoleGrantTargetProfileSummary(profile: ConsolePolicyTargetProfile): JsonObjectT {
  return JsonObject.parse({
    command: profile.command,
    argv: argvDigest(profile.argv),
    cwd: profile.cwd,
    declaredTempRoots: stableStringArray(profile.declaredTempRoots ?? []),
    filesystemScopes: stableStringArray(profile.filesystemScopes ?? []),
    egressDomains: stableEgressDomains(profile.egressDomains),
    lifecycleLimits: effectiveConsoleLifecycleLimits(profile),
  });
}

export function consoleGrantEffectEnvelope(policyInput: PolicyInputT): JsonObjectT {
  return JsonObject.parse({
    effectKinds: stableStringArray(policyInput.sideEffect.dynamic.effectKinds),
    scopes: stableStringArray(policyInput.sideEffect.dynamic.scopes),
    modifiers: stableStringArray(policyInput.sideEffect.dynamic.modifiers),
    targets: stableTargets(policyInput),
  });
}

export function consoleTargetGrantReviewDecision(
  policyDecision: PolicyDecision,
  targetId: string,
): PolicyDecision {
  return {
    verdict: "review",
    matchedRules: stableStringArray([
      ...policyDecision.matchedRules,
      CONSOLE_TARGET_GRANT_REQUIRED_RULE,
    ]),
    guidance: `interactive console target ${targetId} requires exact human approval before open`,
  };
}

export function consoleReviewGrantKey(
  context: ConsoleReviewGrantContext,
  operation: ConsoleOperation,
  profile: ConsolePolicyTargetProfile,
  policyInput: PolicyInputT,
  decision: PolicyDecision,
): `sha256:${string}` {
  if (operation.kind !== "open") {
    throw new Error("console target grants can only be minted for open operations");
  }
  return sha256Json({
    version: 1,
    kind: "session-console",
    workspaceRoot: context.workspaceRoot,
    sessionId: policyInput.session.id,
    toolName: policyInput.tool.name,
    target: {
      targetId: profile.targetId,
      targetDigest: profile.targetDigest,
      sandboxProfileId: profile.sandboxProfileId,
    },
    operation: {
      kind: operation.kind,
      args: {
        targetId: operation.args.targetId,
        rows: operation.args.rows,
        cols: operation.args.cols,
      },
    },
    targetProfile: consoleGrantTargetProfileSummary(profile),
    effectEnvelope: consoleGrantEffectEnvelope(policyInput),
    policyPack: context.policyPack,
    sandboxPlanDigest: context.sandboxPlanDigest,
    matchedRules: stableStringArray(decision.matchedRules),
  });
}

export function createPendingConsoleReview(
  state: ConsoleRuntimeState,
  options: {
    readonly targetId: string;
    readonly targetDigest: string;
    readonly grantKey: `sha256:${string}`;
    readonly executeParams: ExecuteParams;
  },
): PendingConsoleReview {
  const reviewId = `console_review_${state.nextReviewSeq}`;
  state.nextReviewSeq += 1;
  const target = oneLineConsoleText(options.targetId);
  const summary = `console target ${target} requires approval`;
  const review: PendingConsoleReview = {
    kind: "console",
    reviewId,
    targetId: options.targetId,
    targetDigest: options.targetDigest,
    executeParams: options.executeParams,
    grantKey: options.grantKey,
    summary,
    allowCommand: `keel approve ${reviewId} --scope once --console-target ${target} --console-key ${options.grantKey}`,
  };
  state.pendingReviews.set(reviewId, review);
  return review;
}
