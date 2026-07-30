import { z } from "zod";
import {
  LIFECYCLE_MANIFEST_CONFIG_ENV,
  LifecycleManifest,
  Sha256,
  ValidationPostureId,
  canonicalLifecycleManifestHash,
  type LifecycleActionIdT,
  type LifecycleManifestT,
  type LifecycleValidationTierT,
  type ValidationPostureIdT,
} from "@keel/shared";

// `LIFECYCLE_MANIFEST_CONFIG_ENV` now lives in `@keel/shared` (ADR-0071 P1-10); re-export to
// keep the warden's public surface unchanged (it is also consumed internally below).
export { LIFECYCLE_MANIFEST_CONFIG_ENV };
export const LIFECYCLE_VALIDATION_POSTURE_ENV = "KEEL_WARDEN_VALIDATION_POSTURE";
export const DEFAULT_VALIDATION_POSTURE_ID: ValidationPostureIdT = "guided";

const LifecycleManifestEnvConfig = z
  .object({
    manifest: LifecycleManifest,
    hash: Sha256,
  })
  .strict();

export interface LoadedLifecycleManifest {
  readonly manifest: LifecycleManifestT;
  readonly hash: string;
}

export interface LifecycleEnvAuditSummary {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly missingRequired: readonly string[];
}

export interface LifecycleAuditPayload {
  readonly actionId: string;
  readonly manifestHash: string;
  readonly requestedManifestHash?: string;
  readonly resolvedCommand?: { readonly argv: readonly string[] };
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly validationTier: LifecycleValidationTierT | null;
  readonly activePostureId: ValidationPostureIdT;
  readonly env: LifecycleEnvAuditSummary;
}

export interface ResolvedLifecycleAction {
  readonly actionId: LifecycleActionIdT;
  readonly command: string;
  readonly argv: readonly string[];
  readonly auditPayload: LifecycleAuditPayload;
}

export class LifecycleResolutionError extends Error {
  readonly auditPayload: LifecycleAuditPayload;
  readonly commandForAudit: string;

  constructor(message: string, auditPayload: LifecycleAuditPayload, commandForAudit: string) {
    super(message);
    this.name = "LifecycleResolutionError";
    this.auditPayload = auditPayload;
    this.commandForAudit = commandForAudit;
  }
}

function quoteShellArg(arg: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/u.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

export function renderLifecycleArgv(argv: readonly string[]): string {
  return argv.map(quoteShellArg).join(" ");
}

function validationTierForAction(
  manifest: LifecycleManifestT,
  actionId: string,
): LifecycleValidationTierT | null {
  for (const tier of ["minimal", "standard", "strict"] as const) {
    if (
      manifest.validationTiers?.[tier]?.required.includes(actionId as LifecycleActionIdT) === true
    ) {
      return tier;
    }
  }
  return null;
}

function actionEnvSummary(
  manifest: LifecycleManifestT,
  actionId: string,
  requiresEnv: readonly string[],
  env: NodeJS.ProcessEnv,
): LifecycleEnvAuditSummary {
  const explicit = new Set(requiresEnv);
  const required: string[] = [];
  const optional: string[] = [];
  for (const entry of manifest.env?.required ?? []) {
    const applies =
      entry.requiredFor === undefined ||
      entry.requiredFor.includes(actionId as LifecycleActionIdT) ||
      explicit.has(entry.name);
    if (applies) required.push(entry.name);
  }
  for (const entry of manifest.env?.optional ?? []) {
    if (explicit.has(entry.name)) optional.push(entry.name);
  }
  const missingRequired = required.filter((name) => {
    const value = env[name];
    return value === undefined || value === "";
  });
  return { required, optional, missingRequired };
}

function basePayload(options: {
  readonly actionId: string;
  readonly manifestHash: string;
  readonly requestedManifestHash?: string;
  readonly validationTier: LifecycleValidationTierT | null;
  readonly activePostureId: ValidationPostureIdT;
  readonly env: LifecycleEnvAuditSummary;
}): LifecycleAuditPayload {
  return {
    actionId: options.actionId,
    manifestHash: options.manifestHash,
    ...(options.requestedManifestHash === undefined
      ? {}
      : { requestedManifestHash: options.requestedManifestHash }),
    validationTier: options.validationTier,
    activePostureId: options.activePostureId,
    env: options.env,
  };
}

function commandForAudit(actionId: string): string {
  return `lifecycle.run ${quoteShellArg(actionId)}`;
}

export function parseValidationPostureId(raw: string | undefined): ValidationPostureIdT {
  const parsed = ValidationPostureId.safeParse(raw ?? DEFAULT_VALIDATION_POSTURE_ID);
  return parsed.success ? parsed.data : DEFAULT_VALIDATION_POSTURE_ID;
}

export function parseLifecycleManifestConfig(raw: string): LoadedLifecycleManifest {
  const decoded = LifecycleManifestEnvConfig.parse(JSON.parse(raw));
  const actualHash = canonicalLifecycleManifestHash(decoded.manifest);
  if (actualHash !== decoded.hash) {
    throw new Error("lifecycle manifest hash mismatch");
  }
  return decoded;
}

export function lifecycleManifestFromEnv(
  env: NodeJS.ProcessEnv,
): LoadedLifecycleManifest | undefined {
  const raw = env[LIFECYCLE_MANIFEST_CONFIG_ENV];
  if (raw === undefined || raw.trim() === "") return undefined;
  return parseLifecycleManifestConfig(raw);
}

export function resolveLifecycleAction(
  toolArgs: Readonly<Record<string, unknown>>,
  loaded: LoadedLifecycleManifest | undefined,
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly postureId?: ValidationPostureIdT;
  },
): ResolvedLifecycleAction {
  const actionCandidate = toolArgs["action"];
  const actionId = typeof actionCandidate === "string" ? actionCandidate : "";
  const activePostureId = options.postureId ?? DEFAULT_VALIDATION_POSTURE_ID;
  const requestedManifestHash =
    typeof toolArgs["manifestHash"] === "string" ? toolArgs["manifestHash"] : undefined;
  const fallbackEnv: LifecycleEnvAuditSummary = {
    required: [],
    optional: [],
    missingRequired: [],
  };
  if (loaded === undefined) {
    throw new LifecycleResolutionError(
      "lifecycle manifest is not loaded for this trusted workspace",
      basePayload({
        actionId,
        manifestHash: `sha256:${"0".repeat(64)}`,
        ...(requestedManifestHash === undefined ? {} : { requestedManifestHash }),
        validationTier: null,
        activePostureId,
        env: fallbackEnv,
      }),
      commandForAudit(actionId || "unknown"),
    );
  }
  const action = loaded.manifest.actions[actionId as LifecycleActionIdT];
  const tier = validationTierForAction(loaded.manifest, actionId);
  if (requestedManifestHash !== undefined && requestedManifestHash !== loaded.hash) {
    throw new LifecycleResolutionError(
      "lifecycle manifest hash mismatch",
      basePayload({
        actionId,
        manifestHash: loaded.hash,
        requestedManifestHash,
        validationTier: tier,
        activePostureId,
        env: fallbackEnv,
      }),
      commandForAudit(actionId || "unknown"),
    );
  }
  if (action === undefined) {
    throw new LifecycleResolutionError(
      `unknown lifecycle action: ${actionId || "(missing)"}`,
      basePayload({
        actionId,
        manifestHash: loaded.hash,
        ...(requestedManifestHash === undefined ? {} : { requestedManifestHash }),
        validationTier: tier,
        activePostureId,
        env: fallbackEnv,
      }),
      commandForAudit(actionId || "unknown"),
    );
  }
  if (action.argv === undefined) {
    throw new LifecycleResolutionError(
      `lifecycle action ${actionId} is discovery-only and cannot execute yet`,
      basePayload({
        actionId,
        manifestHash: loaded.hash,
        ...(requestedManifestHash === undefined ? {} : { requestedManifestHash }),
        validationTier: tier,
        activePostureId,
        env: fallbackEnv,
      }),
      commandForAudit(actionId),
    );
  }
  const envSummary = actionEnvSummary(
    loaded.manifest,
    actionId,
    action.requiresEnv ?? [],
    options.env,
  );
  const payload: LifecycleAuditPayload = {
    actionId,
    manifestHash: loaded.hash,
    ...(requestedManifestHash === undefined ? {} : { requestedManifestHash }),
    resolvedCommand: { argv: action.argv },
    cwd: loaded.manifest.root,
    ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }),
    validationTier: tier,
    activePostureId,
    env: envSummary,
  };
  if (envSummary.missingRequired.length > 0) {
    throw new LifecycleResolutionError(
      `lifecycle action ${actionId} is missing required env vars: ${envSummary.missingRequired.join(
        ", ",
      )}`,
      payload,
      commandForAudit(actionId),
    );
  }
  return {
    actionId: actionId as LifecycleActionIdT,
    command: renderLifecycleArgv(action.argv),
    argv: action.argv,
    auditPayload: payload,
  };
}
