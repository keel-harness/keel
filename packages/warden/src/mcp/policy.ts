import { resolve } from "node:path";
import {
  PolicyInput,
  SIDE_EFFECT_TAXONOMY_VERSION,
  aggregateSegments,
  type PolicyInputT,
  type SideEffectSegmentT,
  type SideEffectTargetT,
  type WARDEN_METHODS,
} from "@keel/shared";
import {
  registeredBuiltinStarterPolicyIdentity,
  type PolicyDecision,
  type PolicyInputBuildOptions,
  type PolicyPort,
  type RegisteredBuiltinStarterPolicyIdentity,
} from "../policy.js";
import { isInside } from "../path-util.js";

type ExecuteParams = ReturnType<(typeof WARDEN_METHODS)["warden.execute"]["params"]["parse"]>;

const MCP_OPAQUE_EFFECTS = [
  "fs_read",
  "fs_write",
  "network_read",
  "network_write",
  "process_exec",
] as const;

function homeRoot(env: NodeJS.ProcessEnv): string {
  return env["HOME"] === undefined || env["HOME"] === "" ? "/home/unknown" : env["HOME"];
}

function normalizePathTarget(
  rawPath: string,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
): string {
  if (rawPath === "~") return homeRoot(env);
  if (rawPath.startsWith("~/")) return resolve(homeRoot(env), rawPath.slice(2));
  if (rawPath.startsWith("/")) return resolve(rawPath);
  return resolve(workspaceRoot, rawPath);
}

function pathTarget(
  rawPath: string,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
): SideEffectTargetT {
  const normalized = normalizePathTarget(rawPath, workspaceRoot, env);
  const home = homeRoot(env);
  const secret =
    rawPath.startsWith(".env") ||
    rawPath.includes("/.env") ||
    normalized.includes("/.env") ||
    normalized === "/proc/self/environ" ||
    isInside(resolve(home, ".ssh"), normalized) ||
    isInside(resolve(home, ".aws"), normalized) ||
    isInside(resolve(home, ".gnupg"), normalized) ||
    normalized === resolve(home, ".netrc") ||
    normalized === resolve(home, ".npmrc");
  return {
    kind: "path",
    value: rawPath,
    normalized,
    withinWorkspace: isInside(workspaceRoot, normalized),
    sensitivity: secret ? "secret" : "internal",
  };
}

function looksPathLike(value: string): boolean {
  return (
    value === "~" ||
    value.startsWith("~/") ||
    value.startsWith("/") ||
    value.startsWith(".env") ||
    value.includes("/.env") ||
    value.includes("/")
  );
}

function secretValue(key: string, value: string): boolean {
  return (
    /token|secret|password|api[_-]?key|authorization/iu.test(key) ||
    /^(sk|gh[pousr]|xox[baprs])-/.test(value) ||
    value.length >= 44
  );
}

function collectTargets(
  value: unknown,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
  path: readonly string[] = [],
): SideEffectTargetT[] {
  if (typeof value === "string") {
    const key = path.at(-1) ?? "value";
    const targets: SideEffectTargetT[] = [];
    if (looksPathLike(value)) targets.push(pathTarget(value, workspaceRoot, env));
    if (secretValue(key, value)) {
      targets.push({
        kind: "env_var",
        value: `mcp.arg.${key}`,
        normalized: `mcp.arg.${key}`,
        sensitivity: "secret",
      });
    }
    return targets;
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectTargets(entry, workspaceRoot, env, [...path, String(index)]),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      collectTargets(entry, workspaceRoot, env, [...path, key]),
    );
  }
  return [];
}

export function buildMcpOpaquePolicyInput(
  params: ExecuteParams,
  options: PolicyInputBuildOptions,
): PolicyInputT {
  const env = options.env ?? process.env;
  const targets = collectTargets(params.toolCall.args, options.workspaceRoot, env);
  const segments: SideEffectSegmentT[] = [
    {
      effectKinds: [...MCP_OPAQUE_EFFECTS],
      scopes: ["workspace", "home", "system", "temp", "network", "external_service", "process"],
      targets,
      modifiers: ["unknown"],
    },
  ];
  const aggregate = aggregateSegments(segments);
  return PolicyInput.parse({
    tool: { name: params.toolCall.name, args: params.toolCall.args },
    normalized: { argv: [], decodedLayers: [] },
    sideEffect: {
      taxonomyVersion: SIDE_EFFECT_TAXONOMY_VERSION,
      staticCapability: {
        toolName: params.toolCall.name,
        effectEnvelope: [...MCP_OPAQUE_EFFECTS],
        broad: true,
      },
      dynamic: {
        ...aggregate,
        composition: { kind: "atomic", segments, edges: [] },
        classifier: {
          name: "mcp-local-stdio-opaque-classifier",
          version: "1",
          confidence: "conservative",
          reasons: ["mcp_opaque", "mcp_local_stdio_slice_1"],
        },
      },
      extensions: { "keel.mcp": { opaque: true, transport: "stdio" } },
    },
    workspace: { path: options.workspaceRoot, trusted: options.workspaceTrusted ?? false },
    provenance: params.provenanceContext,
    egress: { isEgress: false, domain: null, gitRemote: null },
    session: {
      id: params.sessionId,
      mode: "enforced",
      promptCountThisSession: 0,
    },
    principal: { osUser: env["USER"] ?? "local" },
  });
}

export function mcpHasSecretSensitiveArgs(input: PolicyInputT): boolean {
  return input.sideEffect.dynamic.targets.some(
    (target) => target.sensitivity === "secret" || target.sensitivity === "unknown",
  );
}

function applyMcpSensitivityDecision(
  input: PolicyInputT,
  decision: PolicyDecision,
): PolicyDecision {
  if (!input.tool.name.startsWith("mcp__")) return decision;
  if (!mcpHasSecretSensitiveArgs(input)) return decision;
  const guidance =
    "POL-012-MCP review: secret-sensitive data is entering an opaque MCP tool call; " +
    "remove the secret argument. No approval is available for this request; do not retry automatically.";
  const matchedRules = decision.matchedRules.includes("POL-012-MCP")
    ? decision.matchedRules
    : [...decision.matchedRules, "POL-012-MCP"];
  const combinedGuidance =
    decision.guidance === undefined || decision.guidance.trim() === ""
      ? guidance
      : decision.guidance.includes(guidance)
        ? decision.guidance
        : `${decision.guidance}; ${guidance}`;
  if (decision.verdict === "deny" || decision.verdict === "review") {
    return {
      ...decision,
      matchedRules,
      guidance: combinedGuidance,
    };
  }
  return {
    verdict: "review",
    matchedRules,
    guidance,
  };
}

export function withMcpSensitivityPolicy(policy: PolicyPort): PolicyPort {
  const evaluate = policy.evaluate.bind(policy);
  return Object.freeze({
    packRef: Object.freeze({ ...policy.packRef }),
    evaluate: async (input: PolicyInputT) =>
      applyMcpSensitivityDecision(input, await evaluate(input)),
  });
}

interface ActiveWardenPolicyState {
  readonly evaluate: (input: PolicyInputT) => Promise<PolicyDecision>;
  readonly policyPack: PolicyPort["packRef"];
  readonly builtinPolicyIdentity: RegisteredBuiltinStarterPolicyIdentity | undefined;
}

const activeWardenPolicies = new WeakMap<object, ActiveWardenPolicyState>();
const activeWardenPolicyEvaluations = new WeakSet<object>();

/** The exact base-policy identity and Warden-owned wrapper that jointly make policy decisions. */
export interface ActiveWardenPolicy {
  readonly policy: PolicyPort;
  readonly builtinPolicyIdentity: RegisteredBuiltinStarterPolicyIdentity | undefined;
}

/** Immutable evidence that the active Warden policy produced this exact decision for this input. */
export interface ActiveWardenPolicyEvaluation {
  readonly policyPack: PolicyPort["packRef"];
  readonly policyInput: PolicyInputT;
  readonly decision: PolicyDecision;
  readonly builtinPolicyIdentity: RegisteredBuiltinStarterPolicyIdentity | undefined;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function jsonSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createActiveWardenPolicy(basePolicy: PolicyPort): ActiveWardenPolicy {
  // Capture the compiled-policy identity from the exact base before applying the Warden-owned MCP
  // wrapper. The wrapper is intentionally not itself a registered compiled starter policy.
  const wrappedPolicy = Object.freeze(withMcpSensitivityPolicy(basePolicy));
  const builtinPolicyIdentity = registeredBuiltinStarterPolicyIdentity(basePolicy);
  const active = Object.freeze({
    policy: wrappedPolicy,
    builtinPolicyIdentity,
  });
  activeWardenPolicies.set(
    active,
    Object.freeze({
      evaluate: wrappedPolicy.evaluate.bind(wrappedPolicy),
      policyPack: deepFreeze(jsonSnapshot(wrappedPolicy.packRef)),
      builtinPolicyIdentity,
    }),
  );
  return active;
}

export async function evaluateActiveWardenPolicy(
  active: ActiveWardenPolicy,
  input: PolicyInputT,
): Promise<ActiveWardenPolicyEvaluation> {
  const state = activeWardenPolicies.get(active);
  if (state === undefined) {
    throw new Error("active Warden policy authority was not minted by createActiveWardenPolicy");
  }
  const decision = await state.evaluate(input);
  const evaluation = deepFreeze({
    policyPack: jsonSnapshot(state.policyPack),
    policyInput: jsonSnapshot(input),
    decision: jsonSnapshot(decision),
    builtinPolicyIdentity: state.builtinPolicyIdentity,
  });
  activeWardenPolicyEvaluations.add(evaluation);
  return evaluation;
}

export function isActiveWardenPolicyEvaluation(evaluation: ActiveWardenPolicyEvaluation): boolean {
  return activeWardenPolicyEvaluations.has(evaluation);
}
