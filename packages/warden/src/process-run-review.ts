import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  Principal,
  SIDE_EFFECT_TAXONOMY_VERSION,
  canonicalize,
  redactText,
  type JsonObjectT,
  type PrincipalT,
  type PolicyInputT,
  type WARDEN_METHODS,
} from "@keel/shared";
import { homeCredentialSecretRoots } from "./capability-manifest.js";
import type { ExecutionMetadataGeneration } from "./execution-metadata.js";
import {
  evaluateActiveWardenPolicy,
  isActiveWardenPolicyEvaluation,
  type ActiveWardenPolicy,
  type ActiveWardenPolicyEvaluation,
} from "./mcp/policy.js";
import { canonicalExistingPath, isInside, isInsideFolded } from "./path-util.js";
import {
  buildPolicyInputForProcessRun,
  processArgvDependsOnMutableExecutionMetadata,
  registeredBuiltinStarterPolicyIdentityMatchesPack,
  sandboxProofIsContained,
  type PolicyDecision,
  type SandboxContainmentProof,
} from "./policy.js";
import { parseProcessRunArgs, renderProcessRunArgv } from "./process-run.js";

type ExecuteParams = ReturnType<(typeof WARDEN_METHODS)["warden.execute"]["params"]["parse"]>;

export const PROCESS_RUN_REVIEW_MAX_SUMMARY_BYTES = 512;
export const PROCESS_RUN_REVIEW_TTL_MS = 120_000;
export const PROCESS_RUN_MUTABLE_METADATA_REVIEW_RULE = "PROCESS-RUN-MUTABLE-METADATA-REVIEW-ONCE";

const PROCESS_RUN_REVIEW_RISK_PREFIX =
  "Workspace files changed. This exact argv may run changed repository-controlled code and may " +
  "read or write the workspace and Warden temporary roots. Network access, enumerated home " +
  "credentials, discovered `.env*` files, Warden/audit writes, and writes outside those roots " +
  "remain denied. Other unrecognized sensitive workspace files may be readable. Approving runs " +
  "it once: ";

const eligibleReviewFacts = new WeakSet<object>();
const processRunReviewPolicyOccurrences = new WeakSet<object>();
const processRunReviewRequestBindings = new WeakSet<object>();
const processRunReviewApprovalBindings = new WeakSet<object>();

function jsonSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalWorkspaceRoot(
  workspaceRoot: string,
  realpath: (path: string) => string,
): string | undefined {
  const absolute = resolve(workspaceRoot);
  try {
    return resolve(realpath(absolute));
  } catch {
    return undefined;
  }
}

function sha256Canonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalize(JSON.parse(JSON.stringify(value)) as JsonObjectT))
    .digest("hex")}`;
}

function exactStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((entry, index) => entry === expected[index])
  );
}

function exactJson(left: unknown, right: unknown): boolean {
  return (
    canonicalize(JSON.parse(JSON.stringify(left)) as JsonObjectT) ===
    canonicalize(JSON.parse(JSON.stringify(right)) as JsonObjectT)
  );
}

function exactCommandTarget(target: unknown, renderedArgv: string): boolean {
  return exactJson(target, {
    kind: "command",
    value: renderedArgv,
    normalized: renderedArgv,
  });
}

function uniqueResolved(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function rootsContainAll(roots: readonly string[] | undefined, required: readonly string[]) {
  const normalized = uniqueResolved(roots ?? []);
  return required.every((entry) =>
    normalized.some((denyRoot) => isInside(denyRoot, resolve(entry))),
  );
}

function rootsStayWithinDeclaredAuthority(
  roots: readonly string[] | undefined,
  workspaceRoot: string,
  declaredTempRoots: readonly string[],
): boolean {
  const normalized = uniqueResolved(roots ?? []);
  const allowedRoots = [workspaceRoot, ...declaredTempRoots];
  return (
    normalized.length > 0 &&
    normalized.every((root) => allowedRoots.some((allowedRoot) => isInside(allowedRoot, root)))
  );
}

function credentialWritesStayDenied(
  allowWrite: readonly string[] | undefined,
  canonicalAllowWrite: readonly string[] | undefined,
  denyWrite: readonly string[] | undefined,
  credentialRoots: readonly string[],
): boolean {
  const allowed = uniqueResolved([...(allowWrite ?? []), ...(canonicalAllowWrite ?? [])]);
  const denied = uniqueResolved(denyWrite ?? []);
  return credentialRoots.every((credentialRoot) => {
    const normalizedCredential = resolve(credentialRoot);
    const overlapsAllowedWrite = allowed.some(
      (root) =>
        isInsideFolded(root, normalizedCredential) || isInsideFolded(normalizedCredential, root),
    );
    return (
      !overlapsAllowedWrite || denied.some((denyRoot) => isInside(denyRoot, normalizedCredential))
    );
  });
}

interface ProcessRunReviewPathAuthority {
  readonly lexicalWorkspaceRoot: string;
  readonly lexicalHomeRoot: string;
  readonly canonicalHomeRoot: string;
  readonly credentialRoots: readonly string[];
  readonly canonicalDeclaredTempRoots: readonly string[];
  readonly canonicalFilesystem:
    | {
        readonly allowRead: readonly string[];
        readonly allowWrite: readonly string[];
        readonly denyRead: readonly string[];
        readonly denyWrite: readonly string[];
      }
    | undefined;
}

function completeProcessReviewContainment(
  proof: SandboxContainmentProof,
  options: {
    readonly workspaceRoot: string;
    readonly declaredTempRoots: readonly string[];
    readonly pathAuthority: ProcessRunReviewPathAuthority;
  },
): boolean {
  const filesystem = proof.profile.filesystem;
  if (filesystem === undefined) return false;
  const canonicalFilesystem = options.pathAuthority.canonicalFilesystem;
  if (canonicalFilesystem === undefined) return false;
  const credentialRoots = options.pathAuthority.credentialRoots;
  return (
    rootsStayWithinDeclaredAuthority(
      filesystem.allowRead,
      options.pathAuthority.lexicalWorkspaceRoot,
      options.declaredTempRoots,
    ) &&
    rootsStayWithinDeclaredAuthority(
      filesystem.allowWrite,
      options.pathAuthority.lexicalWorkspaceRoot,
      options.declaredTempRoots,
    ) &&
    rootsStayWithinDeclaredAuthority(
      canonicalFilesystem.allowRead,
      options.workspaceRoot,
      options.pathAuthority.canonicalDeclaredTempRoots,
    ) &&
    rootsStayWithinDeclaredAuthority(
      canonicalFilesystem.allowWrite,
      options.workspaceRoot,
      options.pathAuthority.canonicalDeclaredTempRoots,
    ) &&
    rootsContainAll(filesystem.denyRead, credentialRoots) &&
    credentialWritesStayDenied(
      filesystem.allowWrite,
      canonicalFilesystem.allowWrite,
      filesystem.denyWrite,
      credentialRoots,
    )
  );
}

export function processRunReviewEffectIsExact(
  policyInput: PolicyInputT,
  renderedArgv: string,
): boolean {
  const dynamic = policyInput.sideEffect.dynamic;
  if (
    dynamic.composition.kind !== "atomic" ||
    dynamic.composition.edges.length !== 0 ||
    dynamic.composition.segments.length !== 1 ||
    !exactStrings(dynamic.effectKinds, ["process_exec"]) ||
    !exactStrings(dynamic.scopes, ["process"]) ||
    !exactStrings(dynamic.modifiers, ["unknown"]) ||
    dynamic.targets.length !== 1 ||
    !exactCommandTarget(dynamic.targets[0], renderedArgv)
  ) {
    return false;
  }
  const segment = dynamic.composition.segments[0]!;
  if (
    !exactStrings(segment.effectKinds, ["process_exec"]) ||
    !exactStrings(segment.scopes, ["process"]) ||
    !exactStrings(segment.modifiers, ["unknown"]) ||
    segment.targets.length !== 1
  ) {
    return false;
  }
  const target = segment.targets[0]!;
  return exactCommandTarget(target, renderedArgv);
}

/** Pure sole-cause predicate; authority minting remains exclusively in the active-policy evaluator. */
export function processRunReviewDecisionIsExact(decision: PolicyDecision): boolean {
  return (
    decision.verdict === "review" &&
    decision.modifiedArgs === undefined &&
    exactStrings(decision.matchedRules, ["POL-003"])
  );
}

export function processRunReviewSummary(argv: readonly string[]): string | undefined {
  let parsed: readonly string[];
  try {
    parsed = parseProcessRunArgs({ argv: [...argv] }).argv;
  } catch {
    return undefined;
  }
  const summary = `${PROCESS_RUN_REVIEW_RISK_PREFIX}${renderProcessRunArgv(parsed)}.`;
  return redactText(summary) === summary &&
    Buffer.byteLength(summary, "utf8") <= PROCESS_RUN_REVIEW_MAX_SUMMARY_BYTES
    ? summary
    : undefined;
}

export interface ProcessRunReviewPolicyOccurrence {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly declaredTempRoots: readonly string[];
  readonly workspaceTrusted: boolean;
  readonly executeParams: ExecuteParams;
  readonly argv: readonly string[];
  readonly sandboxContainment: SandboxContainmentProof;
  readonly pathAuthority: ProcessRunReviewPathAuthority;
  readonly policyEvaluation: ActiveWardenPolicyEvaluation;
}

function authorityEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return deepFreeze({
    ...(env["HOME"] === undefined ? {} : { HOME: env["HOME"] }),
    ...(env["USER"] === undefined ? {} : { USER: env["USER"] }),
    ...(env["KEEL_HOME"] === undefined ? {} : { KEEL_HOME: env["KEEL_HOME"] }),
    ...(env["XDG_CONFIG_HOME"] === undefined ? {} : { XDG_CONFIG_HOME: env["XDG_CONFIG_HOME"] }),
  });
}

/** Builds and evaluates one coherent process-review occurrence from Warden-owned facts. */
export async function createProcessRunReviewPolicyOccurrence(options: {
  readonly activePolicy: ActiveWardenPolicy;
  readonly workspaceRoot: string;
  readonly workspaceRealpath?: (path: string) => string;
  readonly env: NodeJS.ProcessEnv;
  readonly declaredTempRoots: readonly string[];
  readonly workspaceTrusted: boolean;
  readonly executeParams: ExecuteParams;
  readonly argv: readonly string[];
  readonly sandboxContainment: SandboxContainmentProof;
}): Promise<ProcessRunReviewPolicyOccurrence | undefined> {
  const realpath = options.workspaceRealpath ?? realpathSync;
  const workspaceRoot = canonicalWorkspaceRoot(options.workspaceRoot, realpath);
  if (workspaceRoot === undefined) return undefined;
  const env = authorityEnvironment(options.env);
  const lexicalHomeRoot = env["HOME"];
  if (lexicalHomeRoot === undefined || lexicalHomeRoot === "") return undefined;
  const canonicalHomeRoot = canonicalWorkspaceRoot(lexicalHomeRoot, realpath);
  if (canonicalHomeRoot === undefined || canonicalHomeRoot === workspaceRoot) return undefined;
  const credentialSpellings = uniqueResolved([
    ...homeCredentialSecretRoots(lexicalHomeRoot),
    ...homeCredentialSecretRoots(canonicalHomeRoot),
  ]);
  const credentialRoots = uniqueResolved([
    ...credentialSpellings,
    ...credentialSpellings.map((path) => canonicalExistingPath(path, realpath)),
  ]);
  const executeParams = deepFreeze(jsonSnapshot(options.executeParams));
  const declaredTempRoots = deepFreeze(uniqueResolved([...options.declaredTempRoots]));
  const tempAuthorityRoot = canonicalWorkspaceRoot("/tmp", realpath);
  if (tempAuthorityRoot === undefined) return undefined;
  const canonicalDeclaredTempRoots: string[] = [];
  for (const path of declaredTempRoots) {
    const canonical = canonicalWorkspaceRoot(path, realpath);
    if (
      canonical === undefined ||
      canonical !== path ||
      canonical === tempAuthorityRoot ||
      !isInside(tempAuthorityRoot, canonical)
    ) {
      return undefined;
    }
    canonicalDeclaredTempRoots.push(canonical);
  }
  const sandboxContainment = deepFreeze(jsonSnapshot(options.sandboxContainment));
  const filesystem = sandboxContainment.profile.filesystem;
  const pathAuthority = deepFreeze({
    lexicalWorkspaceRoot: resolve(options.workspaceRoot),
    lexicalHomeRoot: resolve(lexicalHomeRoot),
    canonicalHomeRoot: resolve(canonicalHomeRoot),
    credentialRoots,
    canonicalDeclaredTempRoots,
    canonicalFilesystem:
      filesystem === undefined
        ? undefined
        : {
            allowRead: (filesystem.allowRead ?? []).map((path) =>
              canonicalExistingPath(path, realpath),
            ),
            allowWrite: (filesystem.allowWrite ?? []).map((path) =>
              canonicalExistingPath(path, realpath),
            ),
            denyRead: (filesystem.denyRead ?? []).map((path) =>
              canonicalExistingPath(path, realpath),
            ),
            denyWrite: (filesystem.denyWrite ?? []).map((path) =>
              canonicalExistingPath(path, realpath),
            ),
          },
  });
  const argvInput = [...options.argv];
  let argv: readonly string[];
  try {
    argv = parseProcessRunArgs({ argv: argvInput }).argv;
  } catch {
    return undefined;
  }
  const policyInput = buildPolicyInputForProcessRun(executeParams, argv, {
    workspaceRoot,
    env,
    workspaceTrusted: options.workspaceTrusted,
    safeCommandMetadataTrusted: false,
    sandboxContainment,
    realpath,
  });
  const policyEvaluation = await evaluateActiveWardenPolicy(options.activePolicy, policyInput);
  const occurrence = deepFreeze({
    workspaceRoot,
    env,
    declaredTempRoots,
    workspaceTrusted: options.workspaceTrusted,
    executeParams,
    argv: [...argv],
    sandboxContainment,
    pathAuthority,
    policyEvaluation,
  });
  processRunReviewPolicyOccurrences.add(occurrence);
  return occurrence;
}

export interface ProcessRunReviewEligibilityOptions {
  readonly processRunCapabilityAvailable: boolean;
  readonly durableAuditAvailable: boolean;
  readonly policyOccurrence: ProcessRunReviewPolicyOccurrence;
  readonly policySandboxMismatch: boolean;
  readonly mutationGeneration: ExecutionMetadataGeneration;
}

export interface EligibleProcessRunReview {
  readonly workspaceRoot: string;
  readonly declaredTempRoots: readonly string[];
  readonly executeParams: ExecuteParams;
  readonly argv: readonly string[];
  readonly renderedArgv: string;
  readonly summary: string;
  readonly policyPack: ActiveWardenPolicyEvaluation["policyPack"];
  readonly policyInput: PolicyInputT;
  readonly decision: PolicyDecision;
  readonly sandboxContainment: SandboxContainmentProof;
  readonly pathAuthority: ProcessRunReviewPathAuthority;
  readonly mutationGeneration: number;
  readonly capability: "process-run/v1";
  readonly builtinPolicyIdentity: "registered-built-in-starter-policy/v1";
}

export function processRunReviewEligibility(
  options: ProcessRunReviewEligibilityOptions,
): EligibleProcessRunReview | undefined {
  if (!processRunReviewPolicyOccurrences.has(options.policyOccurrence)) return undefined;
  const {
    workspaceRoot,
    env,
    declaredTempRoots,
    workspaceTrusted,
    executeParams,
    argv: occurrenceArgv,
    sandboxContainment,
    pathAuthority,
    policyEvaluation,
  } = options.policyOccurrence;
  if (!isActiveWardenPolicyEvaluation(policyEvaluation)) return undefined;
  const { policyInput, policyPack, decision, builtinPolicyIdentity } = policyEvaluation;
  if (
    !workspaceTrusted ||
    policyInput.workspace.trusted !== true ||
    !options.processRunCapabilityAvailable ||
    !options.durableAuditAvailable ||
    !registeredBuiltinStarterPolicyIdentityMatchesPack(builtinPolicyIdentity, policyPack) ||
    options.policySandboxMismatch ||
    options.mutationGeneration.poisoned ||
    !Number.isSafeInteger(options.mutationGeneration.generation) ||
    options.mutationGeneration.generation < 0 ||
    options.mutationGeneration.generation >= Number.MAX_SAFE_INTEGER ||
    !sandboxProofIsContained(sandboxContainment, {
      workspaceRoot: pathAuthority.lexicalWorkspaceRoot,
      env,
      declaredTempRoots,
    }) ||
    !completeProcessReviewContainment(sandboxContainment, {
      workspaceRoot,
      declaredTempRoots,
      pathAuthority,
    })
  ) {
    return undefined;
  }
  let argv: readonly string[];
  try {
    argv = parseProcessRunArgs({ argv: [...occurrenceArgv] }).argv;
  } catch {
    return undefined;
  }
  const renderedArgv = renderProcessRunArgv(argv);
  const summary = processRunReviewSummary(argv);
  if (summary === undefined) return undefined;
  if (
    executeParams.toolCall.name !== "process.run" ||
    !exactJson(executeParams.toolCall.args, { argv: [...argv] }) ||
    policyInput.tool.name !== "process.run" ||
    !exactJson(policyInput.tool.args, { argv: [...argv] }) ||
    !exactStrings(policyInput.normalized.argv, argv) ||
    policyInput.normalized.decodedLayers.length !== 0 ||
    policyInput.session.id !== executeParams.sessionId ||
    policyInput.session.mode !== "enforced" ||
    policyInput.workspace.path !== workspaceRoot ||
    policyInput.workspace.trusted !== workspaceTrusted ||
    !exactJson(policyInput.provenance, executeParams.provenanceContext) ||
    policyInput.principal.osUser !== (env["USER"] ?? "local") ||
    policyInput.sideEffect.taxonomyVersion !== SIDE_EFFECT_TAXONOMY_VERSION ||
    policyInput.sideEffect.staticCapability.toolName !== "process.run" ||
    policyInput.sideEffect.staticCapability.broad !== true ||
    !exactStrings(policyInput.sideEffect.staticCapability.effectEnvelope, [
      "fs_read",
      "fs_write",
      "network_read",
      "network_write",
      "process_exec",
    ]) ||
    policyInput.egress.isEgress !== false ||
    policyInput.egress.domain !== null ||
    policyInput.egress.gitRemote !== null ||
    !processArgvDependsOnMutableExecutionMetadata(argv) ||
    !processRunReviewDecisionIsExact(decision) ||
    policyInput.sideEffect.dynamic.classifier.name !== "warden-structured-argv-classifier" ||
    policyInput.sideEffect.dynamic.classifier.version !== "1" ||
    policyInput.sideEffect.dynamic.classifier.confidence !== "unknown" ||
    !exactStrings(policyInput.sideEffect.dynamic.classifier.reasons, [
      "mutable_execution_metadata",
    ]) ||
    !processRunReviewEffectIsExact(policyInput, renderedArgv)
  ) {
    return undefined;
  }

  const eligible = deepFreeze({
    workspaceRoot,
    declaredTempRoots,
    executeParams: jsonSnapshot(executeParams),
    argv: [...argv],
    renderedArgv,
    summary,
    policyPack: jsonSnapshot(policyPack),
    policyInput: jsonSnapshot(policyInput),
    decision: jsonSnapshot(decision),
    sandboxContainment: jsonSnapshot(sandboxContainment),
    pathAuthority: jsonSnapshot(pathAuthority),
    mutationGeneration: options.mutationGeneration.generation,
    capability: "process-run/v1" as const,
    builtinPolicyIdentity: "registered-built-in-starter-policy/v1" as const,
  });
  eligibleReviewFacts.add(eligible);
  return eligible;
}

export interface ProcessRunReviewRequestBinding {
  readonly key: `sha256:${string}`;
  readonly reviewId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

function validReviewId(reviewId: string): boolean {
  const matched = /^process_review_([1-9]\d{0,15})$/u.exec(reviewId);
  return matched !== null && Number.isSafeInteger(Number(matched[1]));
}

function safeMonotonicTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

export function createProcessRunReviewRequestBinding(options: {
  readonly eligible: EligibleProcessRunReview;
  readonly reviewId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}): ProcessRunReviewRequestBinding | undefined {
  if (
    !eligibleReviewFacts.has(options.eligible) ||
    !validReviewId(options.reviewId) ||
    !safeMonotonicTime(options.createdAtMs) ||
    !safeMonotonicTime(options.expiresAtMs) ||
    options.expiresAtMs !== options.createdAtMs + PROCESS_RUN_REVIEW_TTL_MS
  ) {
    return undefined;
  }
  const key = sha256Canonical({
    version: 1,
    kind: "exact-once-process-run-mutable-metadata-review",
    reviewId: options.reviewId,
    createdAtMs: options.createdAtMs,
    expiresAtMs: options.expiresAtMs,
    workspaceRoot: options.eligible.workspaceRoot,
    declaredTempRoots: [...options.eligible.declaredTempRoots],
    executeParams: options.eligible.executeParams,
    argv: [...options.eligible.argv],
    renderedArgv: options.eligible.renderedArgv,
    summary: options.eligible.summary,
    policyPack: options.eligible.policyPack,
    policyInput: options.eligible.policyInput,
    decision: options.eligible.decision as unknown as JsonObjectT,
    sandboxContainment: options.eligible.sandboxContainment as unknown as JsonObjectT,
    pathAuthority: options.eligible.pathAuthority,
    mutationGeneration: options.eligible.mutationGeneration,
    capability: options.eligible.capability,
    builtinPolicyIdentity: options.eligible.builtinPolicyIdentity,
  });
  const binding = Object.freeze({
    key,
    reviewId: options.reviewId,
    createdAtMs: options.createdAtMs,
    expiresAtMs: options.expiresAtMs,
  });
  processRunReviewRequestBindings.add(binding);
  return binding;
}

export interface ProcessRunReviewApprovalBinding {
  readonly key: `sha256:${string}`;
  readonly requestKey: `sha256:${string}`;
  readonly reviewId: string;
  readonly principal: PrincipalT;
  readonly scope: "once";
}

export function createProcessRunReviewApprovalBinding(options: {
  readonly requestBinding: ProcessRunReviewRequestBinding | undefined;
  readonly principal: unknown;
  readonly scope: unknown;
  readonly nowMs: number;
}): ProcessRunReviewApprovalBinding | undefined {
  const principal = Principal.safeParse(options.principal);
  if (
    options.requestBinding === undefined ||
    !processRunReviewRequestBindings.has(options.requestBinding) ||
    !principal.success ||
    options.scope !== "once" ||
    !safeMonotonicTime(options.nowMs) ||
    options.nowMs < options.requestBinding.createdAtMs ||
    options.nowMs >= options.requestBinding.expiresAtMs
  ) {
    return undefined;
  }
  const key = sha256Canonical({
    version: 1,
    kind: "exact-once-process-run-approval",
    requestKey: options.requestBinding.key,
    reviewId: options.requestBinding.reviewId,
    principal: jsonSnapshot(principal.data),
    scope: options.scope,
  });
  const binding = deepFreeze({
    key,
    requestKey: options.requestBinding.key,
    reviewId: options.requestBinding.reviewId,
    principal: jsonSnapshot(principal.data),
    scope: "once" as const,
  });
  processRunReviewApprovalBindings.add(binding);
  return binding;
}

export function isProcessRunReviewApprovalBinding(
  binding: ProcessRunReviewApprovalBinding,
): boolean {
  return processRunReviewApprovalBindings.has(binding);
}
